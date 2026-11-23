import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { vnDayRangeUtc } from "../lib/time";
import { lineAmount } from "../lib/money";
import { parseBody, unitFactor } from "../services/http";
import { registerApprovalHandler } from "../services/approval-registry";
import { resolvePrice } from "../services/pricing";
import { groupIdsOf, planPromotions } from "../services/promo-checkout";
import { loyaltyConfig, pointsStmts } from "../services/loyalty-points";
import { bundleRoutes } from "./promo-bundles";
import { preorderRoutes } from "./promo-preorders";

export const promotionRoutes = new Hono<AppBindings>();
promotionRoutes.route("/", bundleRoutes);
promotionRoutes.route("/", preorderRoutes);

const CHANNELS = ["pos", "online", "b2b"] as const;
const KINDS = ["percent", "amount", "fixed_price", "combo", "end_of_day"] as const;
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

// ===================== Khuyến mãi =====================

const itemSchema = z
  .object({ productId: z.number().int().positive().optional(), groupId: z.number().int().positive().optional(), qtyMilli: z.number().int().positive().optional() })
  .refine((x) => (x.productId == null) !== (x.groupId == null), { message: "Mỗi dòng phạm vi phải có đúng một trong productId / groupId" });

const promoSchema = z.object({
  name: z.string().trim().min(2).max(200),
  kind: z.enum(KINDS),
  channels: z.array(z.enum(CHANNELS)).min(1).default(["pos", "online"]),
  valueBp: z.number().int().min(1).max(10000).nullish(),
  valueAmount: z.number().int().min(0).nullish(),
  minOrder: z.number().int().min(0).default(0),
  maxDiscount: z.number().int().min(0).nullish(),
  startsAt: z.string().min(8).max(40),
  endsAt: z.string().min(8).max(40),
  dailyStart: z.string().regex(HHMM).nullish(),
  dailyEnd: z.string().regex(HHMM).nullish(),
  requiresVoucher: z.boolean().default(false),
  stackable: z.boolean().default(false),
  priority: z.number().int().min(0).max(1000).default(0),
  items: z.array(itemSchema).max(50).default([]),
});
type PromoBody = z.infer<typeof promoSchema>;

/** 'YYYY-MM-DD' = cả ngày giờ VN (bắt đầu 00:00, kết thúc hết ngày); dạng khác phải là ISO hợp lệ. */
function parseWhen(v: string, edge: "start" | "end"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const r = vnDayRangeUtc(v);
    return edge === "start" ? r.from : r.to;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new AppError(422, "validation_error", "Thời gian không hợp lệ (ISO hoặc YYYY-MM-DD)");
  return new Date(t).toISOString();
}

function validatePromo(b: PromoBody) {
  const startsAt = parseWhen(b.startsAt, "start");
  const endsAt = parseWhen(b.endsAt, "end");
  if (endsAt <= startsAt) throw new AppError(422, "invalid_period", "Thời gian kết thúc phải sau thời gian bắt đầu");
  const bad = (m: string) => new AppError(422, "validation_error", m);
  if ((b.dailyStart == null) !== (b.dailyEnd == null)) throw bad("Khung giờ cần cả dailyStart và dailyEnd");
  if (b.kind === "percent" || b.kind === "end_of_day") if (!b.valueBp) throw bad("Cần valueBp (1000 = 10%)");
  if (b.kind === "end_of_day" && !b.dailyStart) throw bad("Giá xả cuối ngày cần khung giờ dailyStart–dailyEnd");
  if (b.kind === "amount" && !b.valueAmount) throw bad("Cần valueAmount (số tiền giảm)");
  if (b.kind === "fixed_price") {
    if (b.valueAmount == null) throw bad("Cần valueAmount (đơn giá cố định / đơn vị chính)");
    if (!b.items.length) throw bad("Giá cố định cần chọn sản phẩm/nhóm áp dụng");
  }
  if (b.kind === "combo") {
    if (b.valueAmount == null) throw bad("Cần valueAmount (giá combo)");
    if (!b.items.length || b.items.some((i) => !i.qtyMilli)) throw bad("Combo cần danh sách thành phần, mỗi thành phần có qtyMilli");
  }
  return { startsAt, endsAt };
}

async function nextPromoCode(db: D1Database) {
  const r = await db
    .prepare(`INSERT INTO doc_sequences(prefix, day, seq) VALUES ('KM','-',1) ON CONFLICT(prefix, day) DO UPDATE SET seq = seq + 1 RETURNING seq`)
    .first<{ seq: number }>();
  return `KM-${String(r!.seq).padStart(4, "0")}`;
}

const view = (p: any, items?: any[]) => ({
  id: p.id, code: p.code, name: p.name, kind: p.kind, channels: String(p.channels).split(",").filter(Boolean),
  valueBp: p.value_bp, valueAmount: p.value_amount, minOrder: p.min_order, maxDiscount: p.max_discount,
  startsAt: p.starts_at, endsAt: p.ends_at, dailyStart: p.daily_start, dailyEnd: p.daily_end,
  requiresVoucher: !!p.requires_voucher, stackable: !!p.stackable, priority: p.priority, status: p.status,
  createdBy: p.created_by, approvedBy: p.approved_by, createdAt: p.created_at,
  ...(items ? { items: items.map((i) => ({ productId: i.product_id, groupId: i.product_group_id, qtyMilli: i.qty_milli })) } : {}),
});

async function loadPromo(db: D1Database, id: number) {
  const p = await db.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(id).first<any>();
  if (!p) throw notFound("promotion_not_found", "Không tìm thấy khuyến mãi");
  const items = (await db.prepare(`SELECT * FROM promotion_items WHERE promotion_id = ? ORDER BY id`).bind(id).all<any>()).results;
  return { p, items };
}

const itemStmts = (db: D1Database, promotionId: number | null, code: string | null, items: PromoBody["items"]) =>
  items.map((i) =>
    db
      .prepare(`INSERT INTO promotion_items(promotion_id, product_id, product_group_id, qty_milli) VALUES (${promotionId != null ? "?" : "(SELECT id FROM promotions WHERE code = ?)"}, ?, ?, ?)`)
      .bind(promotionId ?? code, i.productId ?? null, i.groupId ?? null, i.qtyMilli ?? null),
  );

promotionRoutes.get("/promotions", requirePerm("prices.view_sell"), async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) { where.push(`p.status = ?`); params.push(q.status); }
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM vouchers v WHERE v.promotion_id = p.id) AS voucher_count,
              (SELECT COUNT(*) FROM promotion_items i WHERE i.promotion_id = p.id) AS item_count
         FROM promotions p ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.id DESC LIMIT 200`,
    )
    .bind(...params)
    .all<any>();
  return c.json({ items: results.map((p) => ({ ...view(p), voucherCount: p.voucher_count, itemCount: p.item_count })) });
});

promotionRoutes.get("/promotions/:id", requirePerm("prices.view_sell"), async (c) => {
  const { p, items } = await loadPromo(c.env.DB, Number(c.req.param("id")));
  return c.json(view(p, items));
});

promotionRoutes.post("/promotions", requirePerm("promotions.write"), async (c) => {
  const b = await parseBody(c, promoSchema);
  const { startsAt, endsAt } = validatePromo(b);
  const db = c.env.DB;
  const code = await nextPromoCode(db);
  await db.batch([
    db
      .prepare(
        `INSERT INTO promotions(code, name, kind, channels, value_bp, value_amount, min_order, max_discount, starts_at, ends_at, daily_start, daily_end,
                                requires_voucher, stackable, priority, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      )
      .bind(code, b.name, b.kind, b.channels.join(","), b.valueBp ?? null, b.valueAmount ?? null, b.minOrder, b.maxDiscount ?? null, startsAt, endsAt,
        b.dailyStart ?? null, b.dailyEnd ?? null, b.requiresVoucher ? 1 : 0, b.stackable ? 1 : 0, b.priority, c.get("user").id),
    ...itemStmts(db, null, code, b.items),
    auditStmt(c, { action: "promotion.create", entity: "promotion", entityId: code, after: { name: b.name, kind: b.kind } }),
  ]);
  const row = await db.prepare(`SELECT id FROM promotions WHERE code = ?`).bind(code).first<{ id: number }>();
  const { p, items } = await loadPromo(db, row!.id);
  return c.json(view(p, items), 201);
});

promotionRoutes.put("/promotions/:id", requirePerm("promotions.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const cur = await loadPromo(db, id);
  if (cur.p.status !== "draft") throw conflict("not_editable", "Chỉ sửa được khuyến mãi ở trạng thái nháp", { status: cur.p.status });
  const b = await parseBody(c, promoSchema);
  const { startsAt, endsAt } = validatePromo(b);
  await db.batch([
    db
      .prepare(
        `UPDATE promotions SET name=?, kind=?, channels=?, value_bp=?, value_amount=?, min_order=?, max_discount=?, starts_at=?, ends_at=?, daily_start=?, daily_end=?,
                requires_voucher=?, stackable=?, priority=? WHERE id=? AND status='draft'`,
      )
      .bind(b.name, b.kind, b.channels.join(","), b.valueBp ?? null, b.valueAmount ?? null, b.minOrder, b.maxDiscount ?? null, startsAt, endsAt,
        b.dailyStart ?? null, b.dailyEnd ?? null, b.requiresVoucher ? 1 : 0, b.stackable ? 1 : 0, b.priority, id),
    db.prepare(`DELETE FROM promotion_items WHERE promotion_id = ?`).bind(id),
    ...itemStmts(db, id, null, b.items),
    auditStmt(c, { action: "promotion.update", entity: "promotion", entityId: id, before: view(cur.p), after: { name: b.name, kind: b.kind } }),
  ]);
  const { p, items } = await loadPromo(db, id);
  return c.json(view(p, items));
});

promotionRoutes.post("/promotions/:id/submit", requirePerm("promotions.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const user = c.get("user");
  const { p } = await loadPromo(db, id);
  if (p.status !== "draft") throw conflict("invalid_status", "Chỉ gửi duyệt khuyến mãi ở trạng thái nháp", { status: p.status });
  if (Date.parse(p.ends_at) <= Date.now()) throw new AppError(422, "invalid_period", "Khuyến mãi đã quá thời gian kết thúc");
  if (can(user.role, "promotions.approve")) {
    await db.batch([
      db.prepare(`UPDATE promotions SET status='active', approved_by=? WHERE id=? AND status='draft'`).bind(user.id, id),
      auditStmt(c, { action: "promotion.activate", entity: "promotion", entityId: id, before: { status: "draft" }, after: { status: "active" } }),
    ]);
  } else {
    await db.batch([
      db.prepare(`UPDATE promotions SET status='pending_approval' WHERE id=? AND status='draft'`).bind(id),
      db
        .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('promotion.activate','promotion',?,?,?,?)`)
        .bind(String(id), JSON.stringify({ code: p.code, name: p.name, kind: p.kind }), `Kích hoạt khuyến mãi ${p.code} - ${p.name}`, user.id),
      auditStmt(c, { action: "promotion.submit", entity: "promotion", entityId: id, before: { status: "draft" }, after: { status: "pending_approval" } }),
    ]);
  }
  const { p: np, items } = await loadPromo(db, id);
  const approval = np.status === "pending_approval"
    ? await db.prepare(`SELECT id FROM approvals WHERE type='promotion.activate' AND ref_id=? AND status='pending' ORDER BY id DESC`).bind(String(id)).first<{ id: number }>()
    : null;
  return c.json({ ...view(np, items), approvalId: approval?.id ?? null });
});

registerApprovalHandler("promotion.activate", {
  perm: "promotions.approve",
  onApprove: async (c, a) => [
    c.env.DB.prepare(`UPDATE promotions SET status='active', approved_by=? WHERE id=? AND status='pending_approval'`).bind(c.get("user").id, Number(a.ref_id)),
  ],
  onReject: async (c, a) => [c.env.DB.prepare(`UPDATE promotions SET status='draft' WHERE id=? AND status='pending_approval'`).bind(Number(a.ref_id))],
});

promotionRoutes.post("/promotions/:id/end", requirePerm("promotions.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const { p } = await loadPromo(db, id);
  if (!["active", "draft", "pending_approval"].includes(p.status)) throw conflict("invalid_status", "Khuyến mãi đã kết thúc hoặc đã huỷ", { status: p.status });
  const next = p.status === "active" ? "ended" : "cancelled";
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE promotions SET status=?, ends_at = CASE WHEN ends_at > ? THEN ? ELSE ends_at END WHERE id=?`).bind(next, now, now, id),
    db.prepare(`UPDATE approvals SET status='rejected', decision_note='Khuyến mãi đã dừng' WHERE type='promotion.activate' AND ref_id=? AND status='pending'`).bind(String(id)),
    auditStmt(c, { action: "promotion.end", entity: "promotion", entityId: id, before: { status: p.status }, after: { status: next } }),
  ]);
  const r = await loadPromo(db, id);
  return c.json(view(r.p, r.items));
});

// ===================== Voucher =====================

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** 10 ký tự base32 từ crypto.getRandomValues (50 bit) — không đoán được. */
export function randomVoucherCode(len = 10) {
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b, (x) => B32[x & 31]).join("");
}

promotionRoutes.get("/promotions/:id/vouchers", requirePerm("promotions.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  await loadPromo(db, id);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
  const { results } = await db
    .prepare(`SELECT id, code, max_uses, per_customer_limit, used_count, customer_id, active FROM vouchers WHERE promotion_id = ? ORDER BY id DESC LIMIT ?`)
    .bind(id, limit)
    .all<any>();
  return c.json({
    items: results.map((v) => ({ id: v.id, code: v.code, maxUses: v.max_uses, perCustomerLimit: v.per_customer_limit, usedCount: v.used_count, customerId: v.customer_id, active: !!v.active })),
  });
});

promotionRoutes.post("/promotions/:id/vouchers", requirePerm("promotions.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const b = await parseBody(c, z.object({
    count: z.number().int().min(1).max(500),
    prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{0,8}$/).default(""),
    maxUses: z.number().int().min(1).nullish(),
    perCustomerLimit: z.number().int().min(1).max(1000).default(1),
    customerId: z.number().int().positive().nullish(),
  }));
  const { p } = await loadPromo(db, id);
  if (p.status === "ended" || p.status === "cancelled") throw conflict("invalid_status", "Khuyến mãi đã kết thúc", { status: p.status });
  if (b.customerId && !(await db.prepare(`SELECT id FROM customers WHERE id = ?`).bind(b.customerId).first())) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
  if (b.customerId && b.count > 1) throw new AppError(422, "validation_error", "Voucher cá nhân chỉ tạo từng mã một");
  const codes = new Set<string>();
  while (codes.size < b.count) codes.add(b.prefix + randomVoucherCode());
  const list = [...codes];
  for (let i = 0; i < list.length; i += 50) {
    await db.batch(
      list.slice(i, i + 50).map((code) =>
        db
          .prepare(`INSERT INTO vouchers(code, promotion_id, max_uses, per_customer_limit, customer_id) VALUES (?,?,?,?,?)`)
          .bind(code, id, b.maxUses ?? null, b.perCustomerLimit, b.customerId ?? null),
      ),
    );
  }
  await auditStmt(c, { action: "voucher.generate", entity: "promotion", entityId: id, after: { count: b.count, maxUses: b.maxUses ?? null } }).run();
  return c.json({ promotionId: id, count: list.length, codes: list }, 201);
});

// ===================== Xem trước giảm giá =====================

promotionRoutes.post("/promotions/preview", requirePerm("pos.sell"), async (c) => {
  const b = await parseBody(c, z.object({
    channel: z.enum(CHANNELS).default("pos"),
    customerId: z.number().int().positive().optional(),
    lines: z.array(z.object({ productId: z.number().int().positive(), unit: z.string().min(1).max(20), qty: z.number().positive().max(1_000_000), unitPrice: z.number().int().min(0).optional() })).min(1).max(200),
    voucherCode: z.string().trim().max(40).optional(),
    redeemPoints: z.number().int().positive().optional(),
  }));
  const db = c.env.DB;
  const cu = b.customerId
    ? await db.prepare(`SELECT id, customer_group_id FROM customers WHERE id = ? AND active = 1`).bind(b.customerId).first<{ id: number; customer_group_id: number | null }>()
    : null;
  if (b.customerId && !cu) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
  const groups = await groupIdsOf(db, b.lines.map((l) => l.productId));
  const lines = [];
  for (const l of b.lines) {
    const factor = await unitFactor(db, l.productId, l.unit);
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    const unitPrice = l.unitPrice ?? (await resolvePrice(db, l.productId, { channel: b.channel, customerGroupId: cu?.customer_group_id, customerId: cu?.id })).unitPrice;
    lines.push({ productId: l.productId, groupId: groups.get(l.productId) ?? null, qtyMilli, unitPrice, lineTotal: lineAmount(unitPrice, qtyMilli) });
  }
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const plan = await planPromotions(db, { channel: b.channel, customerId: cu?.id ?? null, lines, subtotal, voucherCode: b.voucherCode, redeemPoints: b.redeemPoints, strict: false });
  const discount = plan.lineDiscounts.reduce((s, x) => s + x, 0);
  return c.json({
    subtotal,
    discounts: plan.discounts.map((d) => ({ promotionId: d.promotionId, voucherId: d.voucherId ?? null, amount: d.amount, description: d.description })),
    promoDiscount: plan.promoTotal,
    pointsRedeemed: plan.points,
    pointsAmount: plan.pointsAmount,
    discount,
    total: subtotal - discount,
    rejected: plan.rejected,
    lines: lines.map((l, i) => ({ productId: l.productId, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice, lineTotal: l.lineTotal, discount: plan.lineDiscounts[i], net: l.lineTotal - plan.lineDiscounts[i] })),
  });
});

// ===================== Tích điểm =====================

const canSeeLoyalty = (role: Parameters<typeof can>[0]) => can(role, "b2b.view") || can(role, "pos.sell");

promotionRoutes.get("/customers/:id/loyalty", async (c) => {
  if (!canSeeLoyalty(c.get("user").role)) throw forbidden();
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const cu = await db.prepare(`SELECT id, points FROM customers WHERE id = ?`).bind(id).first<{ id: number; points: number }>();
  if (!cu) throw notFound("customer_not_found", "Không tìm thấy khách hàng");
  const ledger = (
    await db
      .prepare(`SELECT id, order_id, kind, points, note, created_by, created_at FROM loyalty_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 200`)
      .bind(id)
      .all<any>()
  ).results;
  const cfg = await loyaltyConfig(db);
  return c.json({
    points: cu.points,
    enabled: cfg.enabled,
    pointValueVnd: cfg.pointValueVnd,
    ledger: ledger.map((l) => ({ id: l.id, orderId: l.order_id, kind: l.kind, points: l.points, note: l.note, createdBy: l.created_by, createdAt: l.created_at })),
  });
});

promotionRoutes.post("/customers/:id/loyalty/adjust", requirePerm("loyalty.adjust"), async (c) => {
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, z.object({ points: z.number().int().refine((x) => x !== 0, "points phải khác 0"), note: z.string().trim().min(3).max(300) }));
  const db = c.env.DB;
  const user = c.get("user");
  const cu = await db.prepare(`SELECT id, points FROM customers WHERE id = ?`).bind(id).first<{ id: number; points: number }>();
  if (!cu) throw notFound("customer_not_found", "Không tìm thấy khách hàng");
  if (cu.points + b.points < 0) throw conflict("points_insufficient", "Điều chỉnh làm số dư điểm âm", { balance: cu.points });
  try {
    await db.batch([
      ...pointsStmts(db, null, id, "adjust", b.points, b.note, user.id),
      auditStmt(c, { action: "loyalty.adjust", entity: "customer", entityId: id, before: { points: cu.points }, after: { points: cu.points + b.points }, reason: b.note }),
    ]);
  } catch (e) {
    if (/points_insufficient/.test(String((e as Error)?.message))) throw conflict("points_insufficient", "Điều chỉnh làm số dư điểm âm");
    throw e;
  }
  const after = await db.prepare(`SELECT points FROM customers WHERE id = ?`).bind(id).first<{ points: number }>();
  return c.json({ points: after!.points });
});

