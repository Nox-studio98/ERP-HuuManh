import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, notFound } from "../lib/errors";
import { currentAvgCost, resolvePrice } from "../services/pricing";
import { guarded, parseBody } from "../services/http";

export const priceRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const listSel = `SELECT id, name, channel, customer_group_id AS customerGroupId, kind, priority, active FROM price_lists`;

priceRoutes.get("/price-lists", requirePerm("prices.view_sell"), async (c) => {
  const { results } = await c.env.DB.prepare(`${listSel} ORDER BY priority DESC, id`).all<any>();
  return c.json({ items: results.map((r) => ({ ...r, active: !!r.active })), nextCursor: null });
});

priceRoutes.post("/price-lists", requirePerm("prices.write"), async (c) => {
  const db = c.env.DB;
  const b = await parseBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(100),
      channel: z.enum(["pos", "online", "b2b", "all"]),
      customerGroupId: z.number().int().positive().nullish(),
      kind: z.enum(["base", "group", "promo", "customer"]),
      priority: z.number().int().min(0).max(1000),
    }),
  );
  const stmt = db
    .prepare(`INSERT INTO price_lists(name, channel, customer_group_id, kind, priority) VALUES (?,?,?,?,?)`)
    .bind(b.name, b.channel, b.customerGroupId ?? null, b.kind, b.priority);
  const [res] = await guarded(() => db.batch([stmt, auditStmt(c, { action: "price_list.create", entity: "price_list", entityId: b.name, after: b })]));
  const row = await db.prepare(`${listSel} WHERE id = ?`).bind(res.meta.last_row_id).first<any>();
  return c.json({ ...row, active: !!row.active }, 201);
});

priceRoutes.put("/price-lists/:id", requirePerm("prices.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw notFound("price_list_not_found", "Không tìm thấy bảng giá");
  const b = await parseBody(
    c,
    z.object({
      name: z.string().trim().min(1).max(100),
      channel: z.enum(["pos", "online", "b2b", "all"]),
      customerGroupId: z.number().int().positive().nullish(),
      kind: z.enum(["base", "group", "promo", "customer"]),
      priority: z.number().int().min(0).max(1000),
      active: z.boolean(),
    }),
  );
  const cur = await db.prepare(`${listSel} WHERE id = ?`).bind(id).first<any>();
  if (!cur) throw notFound("price_list_not_found", "Không tìm thấy bảng giá");
  if (cur.kind === "base" && cur.active && (!b.active || b.kind !== "base")) {
    const other = await db.prepare(`SELECT COUNT(*) n FROM price_lists WHERE kind='base' AND active=1 AND id<>?`).bind(id).first<{ n: number }>();
    if (!other?.n) throw conflict("last_base_price_list", "Phải còn ít nhất một bảng giá nền đang dùng");
  }
  await guarded(() =>
    db.batch([
      db.prepare(`UPDATE price_lists SET name=?, channel=?, customer_group_id=?, kind=?, priority=?, active=? WHERE id=?`)
        .bind(b.name, b.channel, b.customerGroupId ?? null, b.kind, b.priority, b.active ? 1 : 0, id),
      auditStmt(c, { action: "price_list.update", entity: "price_list", entityId: id, before: { ...cur, active: !!cur.active }, after: b }),
    ]),
  );
  const row = await db.prepare(`${listSel} WHERE id = ?`).bind(id).first<any>();
  return c.json({ ...row, active: !!row.active });
});

const priceSel = `SELECT p.id, p.price_list_id AS priceListId, pl.name AS priceListName, pl.kind, pl.priority, p.product_id AS productId,
                         pr.name AS productName, p.unit_price AS unitPrice, p.effective_from AS effectiveFrom, p.effective_to AS effectiveTo,
                         p.status, p.created_by AS createdBy, p.approved_by AS approvedBy, p.created_at AS createdAt, p.note
                    FROM prices p JOIN price_lists pl ON pl.id = p.price_list_id JOIN products pr ON pr.id = p.product_id`;

priceRoutes.get("/prices", requirePerm("prices.view_sell"), async (c) => {
  const { priceListId, productId, status } = c.req.query();
  const now = new Date().toISOString();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status === "pending") where.push("p.status = 'pending'");
  else (where.push("p.status = 'active' AND p.effective_from <= ? AND (p.effective_to IS NULL OR p.effective_to > ?)"), binds.push(now, now));
  if (priceListId) (where.push("p.price_list_id = ?"), binds.push(Number(priceListId)));
  if (productId) (where.push("p.product_id = ?"), binds.push(Number(productId)));
  const { results } = await c.env.DB.prepare(`${priceSel} WHERE ${where.join(" AND ")} ORDER BY pr.name, pl.priority DESC LIMIT 500`).bind(...binds).all();
  return c.json({ items: results, nextCursor: null });
});

priceRoutes.get("/prices/history", requirePerm("prices.view_sell"), async (c) => {
  const db = c.env.DB;
  const productId = Number(c.req.query("productId"));
  if (!productId) throw new AppError(422, "validation_error", "Thiếu productId");
  const { results } = await db.prepare(`${priceSel} WHERE p.product_id = ? ORDER BY p.effective_from DESC, p.id DESC`).bind(productId).all();
  const out: any = { productId, sell: results };
  if (can(c.get("user").role, "prices.view_cost")) {
    const { results: buys } = await db
      .prepare(
        `SELECT l.id AS lotId, l.lot_code AS lotCode, l.received_at AS receivedAt, l.unit_cost AS unitCost, l.qty_in_milli AS qtyInMilli,
                s.id AS supplierId, s.name AS supplierName
           FROM lots l LEFT JOIN suppliers s ON s.id = l.supplier_id WHERE l.product_id = ? ORDER BY l.received_at DESC, l.id DESC`,
      )
      .bind(productId)
      .all();
    out.purchases = buys;
  }
  return c.json(out);
});

priceRoutes.get("/prices/quote", requirePerm("prices.view_sell"), async (c) => {
  const q = z
    .object({
      productId: z.coerce.number().int().positive(),
      channel: z.enum(["pos", "online", "b2b"]).default("pos"),
      customerGroupId: z.coerce.number().int().positive().optional(),
      customerId: z.coerce.number().int().positive().optional(), // bảng giá riêng theo khách (EC-13)
    })
    .parse(c.req.query());
  const r = await resolvePrice(c.env.DB, q.productId, { channel: q.channel, customerGroupId: q.customerGroupId, customerId: q.customerId });
  return c.json(r);
});

priceRoutes.get("/prices/suggested", requirePerm("prices.view_cost"), async (c) => {
  const db = c.env.DB;
  const groupId = Number(c.req.query("groupId")) || null;
  const { results } = await db
    .prepare(
      `SELECT p.id, p.sku, p.name, g.id AS groupId, g.target_margin_bp AS bp FROM products p
         LEFT JOIN product_groups g ON g.id = p.group_id
        WHERE p.active = 1 ${groupId ? "AND p.group_id = ?" : ""} ORDER BY p.name`,
    )
    .bind(...(groupId ? [groupId] : []))
    .all<any>();
  const items = [];
  for (const p of results) {
    const avgCost = await currentAvgCost(db, p.id);
    if (avgCost == null) continue;
    const bp = p.bp ?? 3000;
    items.push({
      productId: p.id, sku: p.sku, name: p.name, groupId: p.groupId, avgCost, targetMarginBp: bp,
      suggestedPrice: Math.round(avgCost * (1 + bp / 10000)),
      currentPrice: await resolvePrice(db, p.id, { channel: "pos" }).then((r) => r.unitPrice, () => null),
    });
  }
  return c.json({ items, nextCursor: null });
});

// ---------------------------------------------------------------- cập nhật giá hàng loạt
const bulkBody = z.object({
  priceListId: z.number().int().positive(),
  effectiveFrom: z.string().optional(),
  items: z.array(z.object({ productId: z.number().int().positive(), unitPrice: z.number().int().min(0) })).min(1).max(500),
  note: z.string().trim().max(300).optional(),
});

priceRoutes.post("/prices/bulk", requirePerm("prices.write"), async (c) => {
  const r = await applyBulkPrices(c, await parseBody(c, bulkBody));
  return c.json(r, r.status === "active" ? 201 : 202);
});

/**
 * Đổi giá hàng loạt theo quy tắc M3 (giữ lịch sử, thời điểm hiệu lực không lùi về quá khứ,
 * người thiếu prices.approve → giá pending + approval 'price.activate'). Dùng lại cho M7 (chấp nhận gợi ý giá).
 */
export async function applyBulkPrices(c: Ctx, b: z.infer<typeof bulkBody>) {
  const db = c.env.DB;
  const u = c.get("user");
  const now = new Date().toISOString();
  let from = now;
  if (b.effectiveFrom) {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(b.effectiveFrom) ? `${b.effectiveFrom}T00:00:00+07:00` : b.effectiveFrom;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new AppError(422, "validation_error", "effectiveFrom không hợp lệ");
    from = new Date(t).toISOString() > now ? new Date(t).toISOString() : now; // không ghi đè lịch sử quá khứ
  }
  const list = await db.prepare(`SELECT id, active FROM price_lists WHERE id = ?`).bind(b.priceListId).first<any>();
  if (!list || !list.active) throw new AppError(422, "invalid_price_list", "Bảng giá không tồn tại hoặc đã ngừng");
  const ids = b.items.map((i) => i.productId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, "validation_error", "Mặt hàng bị lặp trong danh sách");
  const found = await db.prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number }>();
  if (found.results.length !== ids.length) throw new AppError(422, "invalid_product", "Có mặt hàng không tồn tại");

  const autoApprove = can(u.role, "prices.approve");
  const belowCost: number[] = [];
  for (const i of b.items) {
    const avg = await currentAvgCost(db, i.productId);
    if (avg != null && i.unitPrice < avg) belowCost.push(i.productId);
  }

  const stmts: D1PreparedStatement[] = [];
  for (const i of b.items) {
    if (autoApprove) {
      stmts.push(
        // giữ lịch sử: chỉ đóng hiệu lực dòng cũ, không sửa giá
        db
          .prepare(`UPDATE prices SET effective_to = ? WHERE price_list_id = ? AND product_id = ? AND status = 'active' AND effective_to IS NULL AND effective_from < ?`)
          .bind(from, b.priceListId, i.productId, from),
        db
          .prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by, approved_by, note) VALUES (?,?,?,?,'active',?,?,?)`)
          .bind(b.priceListId, i.productId, i.unitPrice, from, u.id, u.id, b.note ?? null),
      );
    } else {
      stmts.push(
        db
          .prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by, note) VALUES (?,?,?,?,'pending',?,?)`)
          .bind(b.priceListId, i.productId, i.unitPrice, from, u.id, b.note ?? null),
        db
          .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('price.activate','price',CAST(last_insert_rowid() AS TEXT),?,?,?)`)
          .bind(JSON.stringify({ priceListId: b.priceListId, productId: i.productId, unitPrice: i.unitPrice, effectiveFrom: from, belowCost: belowCost.includes(i.productId) }), b.note ?? "Đổi giá bán", u.id),
      );
    }
  }
  stmts.push(auditStmt(c, { action: autoApprove ? "price.bulk_update" : "price.bulk_request", entity: "price_list", entityId: b.priceListId, after: { items: b.items, effectiveFrom: from, belowCost }, reason: b.note }));
  const res = await guarded(() => db.batch(stmts));
  const priceIds = res.filter((r, idx) => idx < stmts.length - 1 && r.meta.last_row_id && (autoApprove ? idx % 2 === 1 : idx % 2 === 0)).map((r) => r.meta.last_row_id as number);
  return { status: autoApprove ? ("active" as const) : ("pending_approval" as const), effectiveFrom: from, priceIds, belowCost };
}

// ---------------------------------------------------------------- duyệt giá
function activateStmts(c: Ctx, price: any, approverId: number, effectiveFrom: string) {
  const db = c.env.DB;
  return [
    db
      .prepare(`UPDATE prices SET effective_to = ? WHERE price_list_id = ? AND product_id = ? AND status = 'active' AND effective_to IS NULL AND effective_from < ? AND id <> ?`)
      .bind(effectiveFrom, price.price_list_id, price.product_id, effectiveFrom, price.id),
    db
      .prepare(`UPDATE prices SET status = 'active', approved_by = ?, effective_from = ? WHERE id = ? AND status = 'pending'`)
      .bind(approverId, effectiveFrom, price.id),
    auditStmt(c, { action: "price.activate", entity: "price", entityId: price.id, before: { status: "pending" }, after: { status: "active", unitPrice: price.unit_price, effectiveFrom } }, approverId),
  ];
}

async function pendingPrice(db: D1Database, id: number) {
  const p = await db.prepare(`SELECT * FROM prices WHERE id = ?`).bind(id).first<any>();
  if (!p) throw notFound("not_found", "Không tìm thấy dòng giá");
  if (p.status !== "pending") throw conflict("price_not_pending", "Dòng giá không ở trạng thái chờ duyệt");
  return p;
}

/** Kích hoạt giá đã được duyệt (gọi từ /approvals/:id/decide). Không đụng bảng approvals. */
export async function activatePrice(c: Ctx, priceId: number, approverId: number) {
  const db = c.env.DB;
  const p = await pendingPrice(db, priceId);
  const now = new Date().toISOString();
  const from = p.effective_from > now ? p.effective_from : now;
  await db.batch(activateStmts(c, p, approverId, from));
  return db.prepare(`${priceSel} WHERE p.id = ?`).bind(priceId).first();
}

/** Từ chối dòng giá chờ duyệt (gọi từ /approvals/:id/decide khi rejected). */
export async function rejectPrice(c: Ctx, priceId: number, approverId: number, note?: string) {
  const db = c.env.DB;
  const p = await pendingPrice(db, priceId);
  await db.batch([
    db.prepare(`UPDATE prices SET status = 'rejected', approved_by = ? WHERE id = ? AND status = 'pending'`).bind(approverId, priceId),
    auditStmt(c, { action: "price.reject", entity: "price", entityId: priceId, before: { status: "pending" }, after: { status: "rejected" }, reason: note }, approverId),
  ]);
  return db.prepare(`${priceSel} WHERE p.id = ?`).bind(p.id).first();
}

const decideNote = z.object({ note: z.string().trim().max(300).optional() }).default({});

priceRoutes.post("/prices/:id/approve", requirePerm("prices.approve"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  const p = await pendingPrice(db, id);
  const body = await c.req.json().catch(() => ({}));
  const { note } = decideNote.parse(body);
  const now = new Date().toISOString();
  const from = p.effective_from > now ? p.effective_from : now;
  await db.batch([
    ...activateStmts(c, p, u.id, from),
    db
      .prepare(`UPDATE approvals SET status='approved', decided_by=?, decided_at=?, decision_note=? WHERE type='price.activate' AND ref_id=? AND status='pending'`)
      .bind(u.id, now, note ?? null, String(id)),
  ]);
  return c.json(await db.prepare(`${priceSel} WHERE p.id = ?`).bind(id).first());
});

priceRoutes.post("/prices/:id/reject", requirePerm("prices.approve"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  await pendingPrice(db, id);
  const { note } = decideNote.parse(await c.req.json().catch(() => ({})));
  await db.batch([
    db.prepare(`UPDATE prices SET status = 'rejected', approved_by = ? WHERE id = ? AND status = 'pending'`).bind(u.id, id),
    db
      .prepare(`UPDATE approvals SET status='rejected', decided_by=?, decided_at=?, decision_note=? WHERE type='price.activate' AND ref_id=? AND status='pending'`)
      .bind(u.id, new Date().toISOString(), note ?? null, String(id)),
    auditStmt(c, { action: "price.reject", entity: "price", entityId: id, before: { status: "pending" }, after: { status: "rejected" }, reason: note }),
  ]);
  return c.json(await db.prepare(`${priceSel} WHERE p.id = ?`).bind(id).first());
});
