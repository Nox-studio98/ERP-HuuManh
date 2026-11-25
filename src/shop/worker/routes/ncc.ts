import { Hono } from "hono";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../../../worker/lib/crypto";
import { AppError, notFound } from "../../../worker/lib/errors";
import { vnDate } from "../../../worker/lib/time";
import { BILL_OUTSTANDING_SQL, addDays, supplierDebtStatus } from "../../../worker/services/debt";
import { applySupplierResponse, loadPo, poLines } from "../../../worker/services/po";
import { renderPoPdf } from "../../../worker/services/po-pdf";
import { supplierStatement } from "../../../worker/services/supplier-statement";
import type { ShopBindings, SupplierAccount } from "../env";
import { nccAuditStmt } from "../lib/ncc-audit";
import { requireSupplier } from "../lib/ncc-session";
import { clientIp, escapeLike, parseBody, type SCtx } from "../lib/util";
import { nccMeShape } from "./ncc-auth";

/**
 * Cổng nhà cung cấp /api/ncc/* (docs/PO-NCC.md mục 5). Mọi truy vấn lọc theo `supplier_id` CỦA PHIÊN (không bao giờ nhận supplier_id từ client).
 * PO chỉ hiện khi đã gửi cho NCC (sent_at có giá trị, không còn draft/pending_approval). Không lộ: giá bán, khách/SO nguồn, tồn kho,
 * giá của NCC khác, nhân viên cửa hàng, quỹ nội bộ, ghi chú/lý do nội bộ.
 */
export const nccRoutes = new Hono<ShopBindings>();
nccRoutes.use("/*", async (c, next) => {
  // /api/ncc/auth/* do nccAuthRoutes xử lý (đăng ký route trước); mọi đường dẫn còn lại bắt buộc phiên NCC
  if (c.req.path.startsWith("/api/ncc/auth/")) return next();
  return requireSupplier(c, next);
});

const me = (c: SCtx): SupplierAccount => c.get("supplier")!;
const lim = (c: SCtx, def = 50) => Math.min(Math.max(Number(c.req.query("limit")) || def, 1), 100);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOrNull = (v: string | undefined) => (v && DAY.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

/** Điều kiện hiển thị PO cho NCC: đã gửi (không còn nháp / chờ duyệt) + đúng NCC của phiên. */
const VISIBLE = `po.supplier_id = ?1 AND po.sent_at IS NOT NULL AND po.status NOT IN ('draft','pending_approval')`;
const LIVE = ["sent", "supplier_proposed", "confirmed", "partially_received"];

nccRoutes.get("/me", async (c) => {
  const a = me(c);
  return c.json({ account: nccMeShape(a) });
});

nccRoutes.post("/me/password", async (c) => {
  const a = me(c);
  const b = await parseBody(c, z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(10, "Mật khẩu tối thiểu 10 ký tự").max(128) }));
  const db = c.env.DB;
  const row = await db.prepare(`SELECT pass_hash FROM supplier_accounts WHERE id = ?`).bind(a.id).first<{ pass_hash: string | null }>();
  if (!row?.pass_hash || !(await verifyPassword(b.currentPassword, row.pass_hash))) throw new AppError(403, "invalid_password", "Mật khẩu hiện tại không đúng");
  if (b.currentPassword === b.newPassword) throw new AppError(422, "same_password", "Mật khẩu mới phải khác mật khẩu hiện tại");
  const hash = await hashPassword(b.newPassword);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE supplier_accounts SET pass_hash = ?, failed_logins = 0 WHERE id = ?`).bind(hash, a.id),
    // đổi mật khẩu thu hồi MỌI phiên khác (giữ phiên hiện tại)
    db.prepare(`UPDATE supplier_sessions SET revoked_at = ? WHERE account_id = ? AND id <> ? AND revoked_at IS NULL`).bind(now, a.id, a.sessionId),
    nccAuditStmt(c, a.id, { action: "ncc.password_change", entity: "supplier_account", entityId: a.id }),
  ]);
  return c.json({ ok: true });
});

nccRoutes.get("/users", async (c) => {
  const a = me(c);
  const { results } = await c.env.DB
    .prepare(`SELECT id, full_name, email, phone, status, last_login_at FROM supplier_accounts WHERE supplier_id = ? ORDER BY id`)
    .bind(a.supplierId)
    .all<any>();
  return c.json({
    items: results.map((u) => ({ id: u.id, fullName: u.full_name, email: u.email, phone: u.phone, status: u.status, lastLoginAt: u.last_login_at, isMe: u.id === a.id })),
    nextCursor: null,
  });
});

// ---------------------------------------------------------------- đơn đặt hàng (PO)

const shapeOrder = (po: any) => {
  const today = vnDate();
  return {
    id: po.id, code: po.code, status: po.status, sentAt: po.sent_at, expectedDate: po.expected_date, proposedExpectedDate: po.proposed_expected_date,
    overdue: LIVE.includes(po.status) && !!po.expected_date && po.expected_date < today,
    total: po.total, version: po.version, confirmedAt: po.confirmed_at,
    awaitingYou: po.status === "sent",
  };
};

nccRoutes.get("/orders", async (c) => {
  const a = me(c);
  const db = c.env.DB;
  const q = c.req.query();
  const where: string[] = [VISIBLE];
  const binds: unknown[] = [a.supplierId];
  const st = (q.status ?? "").split(",").map((s) => s.trim()).filter((s) => ["sent", "supplier_proposed", "confirmed", "partially_received", "received", "rejected", "cancelled", "closed"].includes(s));
  if (st.length) where.push(`po.status IN (${st.map(() => "?").join(",")})`), binds.push(...st);
  const from = dayOrNull(q.from), to = dayOrNull(q.to);
  if (from) where.push(`date(po.sent_at, '+7 hours') >= ?`), binds.push(from);
  if (to) where.push(`date(po.sent_at, '+7 hours') <= ?`), binds.push(to);
  if (q.q?.trim()) where.push(`po.code LIKE ? ESCAPE '\\'`), binds.push(`%${escapeLike(q.q.trim().slice(0, 40))}%`);
  const cursor = Number(q.cursor) || 0;
  if (cursor) where.push(`po.id < ?`), binds.push(cursor);
  const limit = lim(c);
  const rows = (
    await db
      .prepare(
        `SELECT po.id, po.code, po.status, po.sent_at, po.expected_date, po.proposed_expected_date, po.total, po.version, po.confirmed_at,
                (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count
           FROM purchase_orders po WHERE ${where.join(" AND ")} ORDER BY po.id DESC LIMIT ${limit + 1}`,
      )
      .bind(...binds)
      .all<any>()
  ).results;
  const items = rows.slice(0, limit).map((r) => ({ ...shapeOrder(r), lineCount: r.line_count }));
  const all = (
    await db.prepare(`SELECT po.status, COUNT(*) AS n, COALESCE(SUM(po.total),0) AS v, SUM(CASE WHEN po.expected_date < ?2 AND po.status IN ('sent','supplier_proposed','confirmed','partially_received') THEN 1 ELSE 0 END) AS late FROM purchase_orders po WHERE ${VISIBLE} GROUP BY po.status`)
      .bind(a.supplierId, vnDate())
      .all<any>()
  ).results;
  const counts: Record<string, number> = {};
  let openValue = 0, overdue = 0;
  for (const r of all) {
    counts[r.status] = r.n;
    if (LIVE.includes(r.status)) { openValue += r.v; overdue += r.late ?? 0; }
  }
  return c.json({
    items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null, counts,
    summary: { awaitingYou: counts.sent ?? 0, proposed: counts.supplier_proposed ?? 0, confirmed: (counts.confirmed ?? 0) + (counts.partially_received ?? 0), overdue, openValue },
  });
});

/** Nạp PO theo id CHỈ khi thuộc NCC của phiên và đã gửi. Mọi trường hợp khác (id không có, của NCC khác, còn nháp) → cùng một 404, không phân biệt. */
async function ownPo(c: SCtx, id: number) {
  const a = me(c);
  if (!Number.isInteger(id) || id <= 0) throw notFound("po_not_found", "Không tìm thấy đơn đặt hàng");
  const ok = await c.env.DB.prepare(`SELECT po.id FROM purchase_orders po WHERE po.id = ?2 AND ${VISIBLE}`).bind(a.supplierId, id).first();
  if (!ok) throw notFound("po_not_found", "Không tìm thấy đơn đặt hàng");
  return loadPo(c.env.DB, id);
}

const HISTORY: Record<string, string> = {
  "po.approve": "Cửa hàng gửi đơn đặt hàng", "po.supplier_confirm": "Bạn xác nhận đơn", "po.supplier_propose": "Bạn đề xuất sửa đơn", "po.supplier_reject": "Bạn từ chối đơn",
  "po.proposal_accept": "Cửa hàng chấp nhận đề xuất của bạn", "po.proposal_reject": "Cửa hàng không chấp nhận đề xuất", "po.cancel": "Cửa hàng huỷ đơn", "po.close": "Cửa hàng đóng đơn", "po.receive": "Cửa hàng nhận hàng",
};
/** Lý do chỉ hiện với những hành động có đối tượng là NCC (ghi chú của chính NCC, hoặc lời đáp của cửa hàng cho đề xuất). */
const HISTORY_REASON = new Set(["po.supplier_confirm", "po.supplier_propose", "po.supplier_reject", "po.proposal_reject"]);

async function orderDetail(c: SCtx, id: number) {
  const db = c.env.DB;
  const po = await ownPo(c, id);
  const lines = await poLines(db, id);
  const hist = (
    await db
      .prepare(`SELECT a.at, a.action, a.reason FROM audit_log a WHERE a.entity = 'purchase_order' AND a.entity_id IN (?, ?) AND a.action IN (${Object.keys(HISTORY).map(() => "?").join(",")}) ORDER BY a.id`)
      .bind(String(id), po.code, ...Object.keys(HISTORY))
      .all<any>()
  ).results;
  const bills = (
    await db
      .prepare(`SELECT b.code, b.issue_date, b.total, b.is_provisional FROM supplier_bills b WHERE b.supplier_id = ?1 AND b.status = 'open' AND b.stock_doc_id IN (SELECT id FROM stock_docs WHERE po_id = ?2) ORDER BY b.id`)
      .bind(po.supplier_id, id)
      .all<any>()
  ).results;
  return {
    ...shapeOrder(po),
    supplierName: po.supplier_name,
    note: po.note, // ghi chú in trên PDF gửi NCC (cửa hàng soạn cho NCC)
    supplierNote: po.supplier_note,
    // trạng thái sent mà reject_reason có giá trị = cửa hàng không chấp nhận đề xuất trước đó; rejected = chính ghi chú từ chối của NCC
    storeReply: po.status === "sent" ? po.reject_reason : null,
    canRespond: po.status === "sent",
    lines: lines.map((l) => {
      const target = l.confirmed_qty_milli ?? l.qty_milli;
      const price = l.confirmed_unit_cost ?? l.unit_cost;
      return {
        id: l.id, productName: l.product_name, baseUnit: l.base_unit, orderUnit: l.order_unit, factor: l.factor,
        qtyMilli: l.qty_milli, orderQty: l.qty_milli / l.factor, unitCost: l.unit_cost,
        proposedQtyMilli: l.proposed_qty_milli, proposedUnitCost: l.proposed_unit_cost,
        confirmedQtyMilli: l.confirmed_qty_milli, confirmedUnitCost: l.confirmed_unit_cost,
        receivedMilli: l.received_milli, remainingMilli: Math.max(0, target - l.received_milli),
        supplierNote: l.supplier_line_note, lineTotal: price == null ? null : Math.round((target * price) / 1000),
      };
    }),
    bills: bills.map((b) => ({ code: b.code, issueDate: b.issue_date, total: b.total, provisional: !!b.is_provisional })),
    history: hist.map((h) => ({ at: h.at, label: HISTORY[h.action], ...(HISTORY_REASON.has(h.action) && h.reason ? { note: h.reason } : {}) })),
  };
}

nccRoutes.get("/orders/:id", async (c) => c.json(await orderDetail(c, Number(c.req.param("id")))));

const RespondBody = z.object({
  action: z.enum(["confirm", "propose", "reject"]),
  version: z.number().int().positive(),
  expectedDate: z.string().regex(DAY, "Ngày giao dạng YYYY-MM-DD").nullish(),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(z.object({ lineId: z.number().int().positive(), qtyMilli: z.number().int().min(0).max(1_000_000_000).optional(), unitCost: z.number().int().min(0).max(1_000_000_000).nullish(), note: z.string().trim().max(200).nullish() }))
    .max(200)
    .optional(),
});

nccRoutes.post("/orders/:id/respond", async (c) => {
  const a = me(c);
  const id = Number(c.req.param("id"));
  await ownPo(c, id); // IDOR: PO phải thuộc NCC của phiên và đã gửi
  const b = await parseBody(c, RespondBody);
  if (b.expectedDate) {
    const today = vnDate();
    if (Number.isNaN(Date.parse(b.expectedDate)) || b.expectedDate < today || b.expectedDate > addDays(today, 120)) throw new AppError(422, "invalid_date", "Ngày giao không hợp lệ (từ hôm nay đến 120 ngày tới)");
  }
  await applySupplierResponse(c.env.DB, id, { action: b.action, version: b.version, expectedDate: b.expectedDate ?? null, note: b.note ?? null, lines: b.lines }, { type: "supplier", userId: null, id: a.id, ip: clientIp(c) });
  await kickNotify(c, id);
  return c.json(await orderDetail(c, id));
});

/** Đẩy job thông báo vừa ghi (cùng batch với phản hồi) lên Queue; cron vẫn quét lại nếu Queue lỗi. */
async function kickNotify(c: SCtx, poId: number) {
  const q = c.env.JOBS;
  if (!q) return;
  try {
    const { results } = await c.env.DB.prepare(`SELECT id FROM integration_jobs WHERE ref_type = 'purchase_order' AND ref_id = ? AND status = 'queued'`).bind(poId).all<{ id: number }>();
    if (results.length) await q.sendBatch(results.map((r) => ({ body: { jobId: r.id } })));
  } catch { /* best effort */ }
}

nccRoutes.get("/orders/:id/pdf", async (c) => {
  const a = me(c);
  const id = Number(c.req.param("id"));
  const po = await ownPo(c, id);
  const lines = await poLines(c.env.DB, id);
  const bytes = await renderPoPdf(c.env as any, po, lines, true);
  await nccAuditStmt(c, a.id, { action: "ncc.po_pdf", entity: "purchase_order", entityId: id }).run();
  return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${po.code}.pdf"`, "cache-control": "no-store" } });
});

// ---------------------------------------------------------------- công nợ, sao kê, thanh toán

nccRoutes.get("/debt", async (c) => {
  const a = me(c);
  const db = c.env.DB;
  const today = vnDate();
  const s = await supplierDebtStatus(db, a.supplierId, today);
  const state = c.req.query("state") === "all" ? "all" : "open";
  const rows = (
    await db
      .prepare(
        `SELECT * FROM (
           SELECT b.id, b.code, b.supplier_ref, b.is_provisional, b.issue_date, b.due_date, b.total, ${BILL_OUTSTANDING_SQL} AS outstanding,
                  (SELECT po.code FROM stock_docs d JOIN purchase_orders po ON po.id = d.po_id WHERE d.id = b.stock_doc_id AND po.supplier_id = b.supplier_id) AS po_code
             FROM supplier_bills b WHERE b.supplier_id = ?1 AND b.status = 'open')
          ${state === "open" ? "WHERE outstanding > 0" : ""} ORDER BY due_date, id LIMIT 200`,
      )
      .bind(a.supplierId)
      .all<any>()
  ).results;
  const day = (d: string) => Math.round((Date.parse(today) - Date.parse(d)) / 86400_000);
  return c.json({
    asOf: today,
    summary: { balance: s.balance, outstanding: s.outstanding, overdueAmount: s.overdueAmount, overdueCount: s.overdueCount, prepaid: s.unapplied },
    bills: rows.map((r) => ({
      code: r.code, supplierRef: r.supplier_ref, provisional: !!r.is_provisional, issueDate: r.issue_date, dueDate: r.due_date, total: r.total, outstanding: r.outstanding, poCode: r.po_code,
      overdueDays: r.outstanding > 0 ? Math.max(0, day(r.due_date)) : 0,
    })),
  });
});

nccRoutes.get("/statement", async (c) => {
  const a = me(c);
  const today = vnDate();
  const to = dayOrNull(c.req.query("to")) ?? today;
  const from = dayOrNull(c.req.query("from")) ?? addDays(to, -30);
  if (to < from) throw new AppError(422, "validation_error", "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu");
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 366) throw new AppError(422, "validation_error", "Khoảng ngày tối đa 366 ngày");
  return c.json(await supplierStatement(c.env.DB, a.supplierId, from, to));
});

nccRoutes.get("/payments", async (c) => {
  const a = me(c);
  const db = c.env.DB;
  const where = [`p.partner_type = 'supplier'`, `p.partner_id = ?1`, `p.direction = 'out'`, `p.status = 'posted'`];
  const binds: unknown[] = [a.supplierId];
  const from = dayOrNull(c.req.query("from")), to = dayOrNull(c.req.query("to"));
  if (from) where.push(`date(p.paid_at, '+7 hours') >= ?${binds.push(from)}`);
  if (to) where.push(`date(p.paid_at, '+7 hours') <= ?${binds.push(to)}`);
  const total = (await db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS t, COUNT(*) AS n FROM debt_payments p WHERE ${where.join(" AND ")}`).bind(...binds).first<{ t: number; n: number }>())!;
  const cursor = Number(c.req.query("cursor")) || 0;
  if (cursor) where.push(`p.id < ?${binds.push(cursor)}`);
  const limit = lim(c);
  const rows = (await db.prepare(`SELECT p.id, p.code, p.paid_at, p.amount, p.method FROM debt_payments p WHERE ${where.join(" AND ")} ORDER BY p.id DESC LIMIT ${limit + 1}`).bind(...binds).all<any>()).results;
  const page = rows.slice(0, limit);
  const allocs = page.length
    ? (
        await db
          .prepare(`SELECT x.payment_id, b.code AS bill_code, x.amount FROM debt_allocations x JOIN supplier_bills b ON b.id = x.bill_id WHERE b.supplier_id = ?1 AND x.payment_id IN (${page.map((_, i) => `?${i + 2}`).join(",")}) ORDER BY x.id`)
          .bind(a.supplierId, ...page.map((p) => p.id))
          .all<any>()
      ).results
    : [];
  return c.json({
    items: page.map((p) => ({
      code: p.code, paidAt: p.paid_at, paidDate: vnDate(new Date(p.paid_at)), amount: p.amount, method: p.method,
      allocations: allocs.filter((x) => x.payment_id === p.id).map((x) => ({ billCode: x.bill_code, amount: x.amount })),
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
    summary: { count: total.n, amount: total.t },
  });
});
