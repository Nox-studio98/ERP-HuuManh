import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode } from "../lib/codes";
import { lineAmount } from "../lib/money";
import { vnDate } from "../lib/time";
import { addDays } from "../services/debt";
import { currentAvgCost, resolvePrice } from "../services/pricing";
import { getSettingInt } from "../services/settings";
import { pageParams, unitFactor } from "../services/http";
import { registerApprovalHandler } from "../services/approval-registry";
import { confirmOrderFlow, createB2bOrder, loadOrderDetail, DATE_RE, type Ctx as C2 } from "../services/b2b-orders";

export const quoteRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const parse = async <T extends z.ZodTypeAny>(c: Ctx, s: T): Promise<z.infer<T>> => s.parse(await c.req.json().catch(() => ({})));

// Duyệt báo giá giảm sâu / dưới vốn: duyệt → draft (rồi gửi khách), từ chối → huỷ.
registerApprovalHandler("quote.approve", {
  perm: "b2b.approve",
  onApprove: async (c, a) => [
    c.env.DB.prepare(`UPDATE quotes SET status='draft', approved_by=? WHERE id=? AND status='pending_approval'`).bind(c.get("user").id, Number(a.ref_id)),
  ],
  onReject: async (c, a) => [c.env.DB.prepare(`UPDATE quotes SET status='cancelled' WHERE id=? AND status='pending_approval'`).bind(Number(a.ref_id))],
});

const effStatus = (status: string, validUntil: string) => (status === "sent" && validUntil < vnDate() ? "expired" : status);

const lineSchema = z.object({
  productId: z.number().int().positive(),
  unit: z.string().min(1).max(20),
  qty: z.number().positive().max(1_000_000).optional(),
  unitPrice: z.number().int().min(0).optional(),
  note: z.string().max(200).optional(),
});
const createSchema = z.object({
  customerId: z.number().int().positive(),
  validDays: z.number().int().min(1).max(365).optional(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

interface BuiltLine {
  productId: number; unit: string; qtyMilli: number | null; listPrice: number; unitPrice: number; cost: number | null; note: string | null;
}

async function buildLines(db: D1Database, cu: { id: number; customer_group_id: number | null }, lines: z.infer<typeof lineSchema>[]) {
  const out: BuiltLine[] = [];
  for (const l of lines) {
    const p = await db.prepare(`SELECT id, active FROM products WHERE id = ?`).bind(l.productId).first<any>();
    if (!p || !p.active) throw new AppError(422, "product_not_found", "Mặt hàng không tồn tại hoặc đã ngừng bán", { productId: l.productId });
    const factor = await unitFactor(db, l.productId, l.unit);
    const r = await resolvePrice(db, l.productId, { channel: "b2b", customerGroupId: cu.customer_group_id, customerId: cu.id });
    out.push({
      productId: l.productId, unit: l.unit, qtyMilli: l.qty != null ? Math.round(l.qty * factor) : null,
      listPrice: r.unitPrice, unitPrice: l.unitPrice ?? r.unitPrice, cost: await currentAvgCost(db, l.productId), note: l.note ?? null,
    });
  }
  return out;
}

/** Giảm > approval.quote_discount_bp so với bảng giá, hoặc thấp hơn giá vốn → cần duyệt. */
async function needsApproval(db: D1Database, lines: BuiltLine[]) {
  const th = await getSettingInt(db, "approval.quote_discount_bp", 500);
  const reasons = new Set<string>();
  for (const l of lines) {
    if (l.listPrice > 0 && ((l.listPrice - l.unitPrice) * 10000) / l.listPrice > th) reasons.add("discount");
    if (l.cost != null && l.unitPrice < l.cost) reasons.add("below_cost");
  }
  return [...reasons];
}

const subtotalOf = (lines: BuiltLine[]) => lines.reduce((s, l) => s + (l.qtyMilli != null ? lineAmount(l.unitPrice, l.qtyMilli) : 0), 0);

const lineInsert = (db: D1Database, code: string, l: BuiltLine) =>
  db
    .prepare(`INSERT INTO quote_lines(quote_id, product_id, unit, qty_milli, list_price, unit_price, cost_at_quote, note) VALUES ((SELECT id FROM quotes WHERE code = ?),?,?,?,?,?,?,?)`)
    .bind(code, l.productId, l.unit, l.qtyMilli, l.listPrice, l.unitPrice, l.cost, l.note);

async function loadQuote(db: D1Database, id: number) {
  const q = await db
    .prepare(`SELECT q.*, cu.name AS customer_name FROM quotes q JOIN customers cu ON cu.id = q.customer_id WHERE q.id = ?`)
    .bind(id)
    .first<any>();
  if (!q) throw notFound("quote_not_found", "Không tìm thấy báo giá");
  return q;
}

const head = (q: any) => ({
  id: q.id, code: q.code, customerId: q.customer_id, customerName: q.customer_name, status: effStatus(q.status, q.valid_until),
  validFrom: q.valid_from, validUntil: q.valid_until, subtotal: q.subtotal, createdAt: q.created_at,
});

async function quoteDetail(c: Ctx, id: number) {
  const db = c.env.DB;
  const q = await loadQuote(db, id);
  const cost = can(c.get("user").role, "prices.view_cost");
  const lines = (
    await db
      .prepare(
        `SELECT l.*, p.name AS product_name, COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = l.product_id AND pu.unit = l.unit), 1000) AS factor
           FROM quote_lines l JOIN products p ON p.id = l.product_id WHERE l.quote_id = ? ORDER BY l.id`,
      )
      .bind(id)
      .all<any>()
  ).results;
  const ap = await db.prepare(`SELECT id, status FROM approvals WHERE type='quote.approve' AND ref_type='quote' AND ref_id = ? ORDER BY id DESC LIMIT 1`).bind(String(id)).first<any>();
  return {
    ...head(q), note: q.note, pdfKey: q.pdf_key, version: q.version, extendedReason: q.extended_reason,
    approvalId: ap?.id ?? null,
    lines: lines.map((l) => ({
      id: l.id, productId: l.product_id, productName: l.product_name, unit: l.unit,
      qty: l.qty_milli != null ? l.qty_milli / l.factor : null, qtyMilli: l.qty_milli,
      listPrice: l.list_price, unitPrice: l.unit_price,
      ...(cost ? { costAtQuote: l.cost_at_quote, marginBp: l.cost_at_quote != null && l.unit_price > 0 ? Math.round(((l.unit_price - l.cost_at_quote) * 10000) / l.unit_price) : null } : {}),
    })),
  };
}

// ---------------------------------------------------------------- danh sách / chi tiết
quoteRoutes.get("/quotes", requirePerm("b2b.view"), async (c) => {
  const db = c.env.DB;
  const { limit, cursor } = pageParams(c);
  const q = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.customerId) (where.push("q.customer_id = ?"), binds.push(Number(q.customerId)));
  if (q.status === "expired") where.push(`(q.status = 'expired' OR (q.status = 'sent' AND q.valid_until < '${vnDate()}'))`);
  else if (q.status === "sent") (where.push(`q.status = 'sent' AND q.valid_until >= '${vnDate()}'`));
  else if (q.status) (where.push("q.status = ?"), binds.push(q.status));
  if (cursor) (where.push("q.id < ?"), binds.push(cursor));
  const rows = (
    await db
      .prepare(`SELECT q.*, cu.name AS customer_name FROM quotes q JOIN customers cu ON cu.id = q.customer_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY q.id DESC LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<any>()
  ).results;
  const page = rows.slice(0, limit);
  return c.json({ items: page.map(head), nextCursor: rows.length > limit ? page[page.length - 1].id : null });
});

quoteRoutes.get("/quotes/:id", requirePerm("b2b.view"), async (c) => c.json(await quoteDetail(c, Number(c.req.param("id")))));

// ---------------------------------------------------------------- tạo / sửa
async function loadB2bCustomer(db: D1Database, id: number) {
  const cu = await db.prepare(`SELECT id, type, active, customer_group_id FROM customers WHERE id = ?`).bind(id).first<any>();
  if (!cu || cu.type !== "b2b" || !cu.active) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng sỉ");
  return cu;
}

quoteRoutes.post("/quotes", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const b = await parse(c, createSchema);
  const cu = await loadB2bCustomer(db, b.customerId);
  const lines = await buildLines(db, cu, b.lines);
  const reasons = await needsApproval(db, lines);
  const pending = reasons.length > 0 && !can(user.role, "b2b.approve");
  const validDays = b.validDays ?? (await getSettingInt(db, "quote.valid_days", 7));
  const from = vnDate();
  const code = await nextCode(db, "BG");
  const subtotal = subtotalOf(lines);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO quotes(code, customer_id, status, valid_from, valid_until, subtotal, note, created_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(code, b.customerId, pending ? "pending_approval" : "draft", from, addDays(from, validDays), subtotal, b.note ?? null, user.id, reasons.length && !pending ? user.id : null),
    ...lines.map((l) => lineInsert(db, code, l)),
  ];
  if (pending)
    stmts.push(
      db
        .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('quote.approve','quote',(SELECT CAST(id AS TEXT) FROM quotes WHERE code = ?),?,?,?)`)
        .bind(code, JSON.stringify({ quoteCode: code, reasons, customerId: b.customerId, subtotal }), reasons.join(","), user.id),
    );
  stmts.push(auditStmt(c, { action: "quote.create", entity: "quote", entityId: code, after: { customerId: b.customerId, subtotal, status: pending ? "pending_approval" : "draft", reasons } }));
  await db.batch(stmts);
  const row = await db.prepare(`SELECT id FROM quotes WHERE code = ?`).bind(code).first<{ id: number }>();
  return c.json(await quoteDetail(c, row!.id), 201);
});

quoteRoutes.put("/quotes/:id", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const q = await loadQuote(db, id);
  if (q.status !== "draft") throw conflict("quote_not_draft", "Chỉ sửa được báo giá nháp");
  const b = await parse(c, z.object({ version: z.number().int().positive().optional(), validDays: z.number().int().min(1).max(365).optional(), note: z.string().trim().max(500).optional(), lines: z.array(lineSchema).min(1).max(200).optional() }));
  if (b.version != null && b.version !== q.version) throw conflict("version_conflict", "Báo giá đã được cập nhật", { currentVersion: q.version });
  const stmts: D1PreparedStatement[] = [];
  let status = "draft";
  let subtotal = q.subtotal;
  if (b.lines) {
    const cu = await loadB2bCustomer(db, q.customer_id);
    const lines = await buildLines(db, cu, b.lines);
    const reasons = await needsApproval(db, lines);
    subtotal = subtotalOf(lines);
    if (reasons.length && !can(user.role, "b2b.approve")) {
      status = "pending_approval";
      stmts.push(
        db.prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('quote.approve','quote',?,?,?,?)`)
          .bind(String(id), JSON.stringify({ quoteCode: q.code, reasons, customerId: q.customer_id, subtotal }), reasons.join(","), user.id),
      );
    }
    stmts.unshift(db.prepare(`DELETE FROM quote_lines WHERE quote_id = ?`).bind(id), ...lines.map((l) => lineInsert(db, q.code, l)));
  }
  const until = b.validDays ? addDays(q.valid_from, b.validDays) : q.valid_until;
  stmts.push(
    db.prepare(`UPDATE quotes SET status=?, subtotal=?, note=COALESCE(?, note), valid_until=?, version=version+1, pdf_key=NULL WHERE id=? AND status='draft'`).bind(status, subtotal, b.note ?? null, until, id),
    auditStmt(c, { action: "quote.update", entity: "quote", entityId: q.code, before: { subtotal: q.subtotal, validUntil: q.valid_until }, after: { subtotal, validUntil: until, status } }),
  );
  await db.batch(stmts);
  return c.json(await quoteDetail(c, id));
});

// ---------------------------------------------------------------- PDF
async function ensurePdf(c: Ctx, q: any): Promise<R2ObjectBody | null> {
  const key = q.pdf_key ?? `quotes/${q.code}.pdf`;
  if (q.pdf_key) {
    const o = await c.env.FILES.get(q.pdf_key);
    if (o) return o;
  }
  // @ts-ignore — services/pdf do Agent C cung cấp
  const mod: any = await import("../services/pdf").catch(() => null);
  if (!mod?.renderQuotePdf) throw new AppError(501 as any, "pdf_unavailable", "Chức năng xuất PDF chưa sẵn sàng");
  const bytes: Uint8Array = await mod.renderQuotePdf(c.env, q.id);
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  await c.env.DB.prepare(`UPDATE quotes SET pdf_key = ? WHERE id = ?`).bind(key, q.id).run();
  return c.env.FILES.get(key);
}

quoteRoutes.get("/quotes/:id/pdf", requirePerm("b2b.view"), async (c) => {
  const q = await loadQuote(c.env.DB, Number(c.req.param("id")));
  const o = await ensurePdf(c, q);
  if (!o) throw new AppError(501 as any, "pdf_unavailable", "Không đọc được tệp PDF");
  return new Response(o.body, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${q.code}.pdf"` } });
});

// ---------------------------------------------------------------- vòng đời
quoteRoutes.post("/quotes/:id/send", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const q = await loadQuote(db, id);
  if (q.status !== "draft") throw conflict("quote_not_draft", q.status === "pending_approval" ? "Báo giá đang chờ duyệt" : "Chỉ gửi được báo giá nháp", { status: q.status });
  if (q.valid_until < vnDate()) throw conflict("quote_expired", "Báo giá đã hết hiệu lực, hãy gia hạn hoặc tạo mới");
  await db.batch([
    db.prepare(`UPDATE quotes SET status='sent', version=version+1 WHERE id=? AND status='draft'`).bind(id),
    auditStmt(c, { action: "quote.send", entity: "quote", entityId: q.code, before: { status: "draft" }, after: { status: "sent" } }),
  ]);
  let pdf = false;
  try {
    pdf = !!(await ensurePdf(c, { ...q, pdf_key: null }));
  } catch {
    pdf = false; // PDF chưa sẵn sàng: vẫn gửi được, tải lại sau qua GET /quotes/:id/pdf
  }
  return c.json({ ...(await quoteDetail(c, id)), pdf });
});

quoteRoutes.post("/quotes/:id/extend", requirePerm("b2b.approve"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const b = await parse(c, z.object({ days: z.number().int().min(1).max(90), reason: z.string().trim().min(3).max(300) }));
  const q = await loadQuote(db, id);
  if (!["draft", "sent", "expired"].includes(q.status)) throw conflict("quote_not_extendable", `Không gia hạn được báo giá ${q.status}`);
  const base = q.valid_until > vnDate() ? q.valid_until : vnDate();
  const until = addDays(base, b.days);
  await db.batch([
    db.prepare(`UPDATE quotes SET valid_until=?, status = CASE WHEN status='expired' THEN 'sent' ELSE status END, extended_by=?, extended_reason=?, version=version+1 WHERE id=?`).bind(until, c.get("user").id, b.reason, id),
    auditStmt(c, { action: "quote.extend", entity: "quote", entityId: q.code, before: { validUntil: q.valid_until }, after: { validUntil: until }, reason: b.reason }),
  ]);
  return c.json(await quoteDetail(c, id));
});

quoteRoutes.post("/quotes/:id/cancel", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const q = await loadQuote(db, id);
  if (!["draft", "pending_approval", "sent"].includes(q.status)) throw conflict("quote_not_cancellable", `Không huỷ được báo giá ${q.status}`);
  const b = await parse(c, z.object({ reason: z.string().trim().max(300).optional() }));
  await db.batch([
    db.prepare(`UPDATE quotes SET status='cancelled', version=version+1 WHERE id=?`).bind(id),
    db.prepare(`UPDATE approvals SET status='rejected', decision_note='Báo giá bị huỷ' WHERE type='quote.approve' AND ref_id=? AND status='pending'`).bind(String(id)),
    auditStmt(c, { action: "quote.cancel", entity: "quote", entityId: q.code, before: { status: q.status }, after: { status: "cancelled" }, reason: b.reason }),
  ]);
  return c.json(await quoteDetail(c, id));
});

// ---------------------------------------------------------------- chuyển thành đơn sỉ
const convertSchema = z.object({
  addressId: z.number().int().positive(),
  deliveryDate: z.string().regex(DATE_RE),
  note: z.string().trim().max(500).optional(),
  clientUuid: z.string().min(8).max(64).optional(),
  lines: z.array(z.object({ productId: z.number().int().positive(), qty: z.number().positive() })).optional(), // số lượng cho dòng báo giá chưa có qty
});

quoteRoutes.post("/quotes/:id/convert", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const q = await loadQuote(db, id);
  const b = await parse(c, convertSchema);
  const qlines = (
    await db
      .prepare(
        `SELECT l.*, COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = l.product_id AND pu.unit = l.unit), 1000) AS factor FROM quote_lines l WHERE l.quote_id = ? ORDER BY l.id`,
      )
      .bind(id)
      .all<any>()
  ).results;
  const lines = qlines.map((l) => {
    const override = b.lines?.find((x) => x.productId === l.product_id)?.qty;
    const qty = override ?? (l.qty_milli != null ? l.qty_milli / l.factor : undefined);
    if (qty == null) throw new AppError(422, "qty_required", "Dòng báo giá chưa có số lượng, cần nhập khi chuyển đơn", { productId: l.product_id });
    return { productId: l.product_id, unit: l.unit, qty };
  });
  const cc = c as unknown as C2;
  const res = await createB2bOrder(cc, {
    customerId: q.customer_id, quoteId: id, addressId: b.addressId, deliveryDate: b.deliveryDate, note: b.note,
    lines, clientUuid: b.clientUuid ?? `quote:${id}`,
  });
  // Trình tự bắt buộc: kiểm hạn mức rồi mới giữ tồn (ném 409 credit_blocked / insufficient_stock, đơn vẫn `new`)
  try {
    if (!res.replay || (await db.prepare(`SELECT status FROM orders WHERE id = ?`).bind(res.orderId).first<{ status: string }>())?.status === "new")
      await confirmOrderFlow(cc, res.orderId);
  } catch (e) {
    if (e instanceof AppError && e.details && typeof e.details === "object") (e.details as any).warnings = res.warnings;
    throw e;
  }
  return c.json({ ...(await loadOrderDetail(db, res.orderId)), warnings: res.warnings }, res.replay ? 200 : 201);
});
