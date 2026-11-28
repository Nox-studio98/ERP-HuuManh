import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, maskPhone } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { addVnRange, guarded, parseBody } from "../services/http";
import { registerApprovalHandler } from "../services/approval-registry";
import { CUSTOMER_LABEL, type OnlineStatus } from "../services/online-orders";
import { bankFundId, markOrderPaid } from "../services/online-payments";
import { sepayCandidates } from "../services/sepay-ledger";
import {
  cancelOrder, canCost, confirmOrder, createSocialOrder, deliverOrder, failOrder, loadOpsOrder, packOrder, prepareOrder,
  overrideWeight, redeliverOrder, refundDiff, refundOrder, returnToStock, shipOrder, waiveDiff,
} from "../services/online-ops";
import { b64uDecode, pushConfigured } from "../services/webpush";
import { openShortLinesFor, shortageView } from "../services/shortages";

export const onlineOrderRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;
const id = (c: Ctx, name = "id") => Number(c.req.param(name));
const ALL_CHANNELS = ["online", "social", "fresco"];
const STATUSES: OnlineStatus[] = ["awaiting_payment", "new", "confirmed", "preparing", "shipping", "completed", "cancelled", "delivery_failed", "returned"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ====================================================================== danh sách + chi tiết

function districtOf(addr: string | null) {
  if (!addr) return null;
  const p = addr.split(",").map((x) => x.trim()).filter(Boolean);
  return p.length >= 2 ? p[p.length - 2] : null;
}

onlineOrderRoutes.get("/online-orders", requirePerm("orders.online.manage"), async (c) => {
  const q = c.req.query();
  const role = c.get("user").role;
  const channel = q.channel ?? "all";
  if (!["online", "fresco", "social", "all"].includes(channel)) throw new AppError(422, "validation_error", "channel không hợp lệ");
  const channels = channel === "all" ? ALL_CHANNELS : [channel];
  const base: string[] = [`o.kind='sale'`, `o.channel IN (${channels.map(() => "?").join(",")})`, `o.status <> 'draft'`];
  const bp: unknown[] = [...channels];
  if (q.slotDate) {
    if (!DATE.test(q.slotDate)) throw new AppError(422, "validation_error", "slotDate phải dạng YYYY-MM-DD");
    base.push(`o.slot_date = ?`);
    bp.push(q.slotDate);
  }
  if (q.source) {
    if (q.source !== "pos") throw new AppError(422, "validation_error", "source chỉ nhận 'pos'");
    base.push(`o.source = 'pos'`);
  }
  addVnRange(q, "o.created_at", base, bp);
  if (q.q?.trim()) {
    const like = `%${q.q.trim().replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    base.push(`(o.code LIKE ? ESCAPE '\\' OR o.receiver_name LIKE ? ESCAPE '\\' OR o.receiver_phone LIKE ? ESCAPE '\\')`);
    bp.push(like, like, like);
  }
  const conds = [...base];
  const params = [...bp];
  if (q.status) {
    if (!STATUSES.includes(q.status as OnlineStatus)) throw new AppError(422, "validation_error", "status không hợp lệ");
    conds.push(`o.status = ?`);
    params.push(q.status);
  }
  if (q.cursor) {
    conds.push(`o.id < ?`);
    params.push(Number(q.cursor));
  }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT o.id, o.code, o.channel, o.source, o.carrier, o.carrier_tracking_no, o.status, o.payment_method, o.payment_status, o.paid_total, o.slot_date, s.label AS slot_label, o.receiver_name, o.receiver_phone,
                o.ship_address, z.name AS zone_name, o.total, o.estimated_total, o.weight_adjust_status, o.created_at, o.is_preorder, o.diff_amount, o.diff_status, o.refund_due,
                EXISTS (SELECT 1 FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = o.id AND p.sell_by_weight = 1) AS has_weight,
                (SELECT COALESCE(SUM(s.qty_milli), 0) FROM so_shortages s WHERE s.order_id = o.id AND s.status = 'open') AS short_milli
           FROM orders o LEFT JOIN delivery_slots s ON s.id = o.slot_id LEFT JOIN delivery_zones z ON z.id = o.zone_id
          WHERE ${conds.join(" AND ")} ORDER BY o.id DESC LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<any>()
  ).results;
  const page = rows.slice(0, limit);
  const shorts = await openShortLinesFor(c.env.DB, page.map((r) => r.id));
  const items = page.map((r) => ({
    id: r.id,
    code: r.code,
    channel: r.channel,
    source: r.source,
    carrier: r.carrier,
    carrierTrackingNo: r.carrier_tracking_no,
    status: r.status,
    statusLabel: CUSTOMER_LABEL[r.status as OnlineStatus] ?? r.status,
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    paidTotal: r.paid_total,
    slotDate: r.slot_date,
    slotLabel: r.slot_label,
    receiverName: r.receiver_name,
    receiverPhone: maskPhone(r.receiver_phone, role),
    district: districtOf(r.ship_address),
    zoneName: r.zone_name,
    total: r.total,
    estimated: !!r.has_weight && r.weight_adjust_status === "none" && ["awaiting_payment", "new", "confirmed", "preparing"].includes(r.status),
    estimatedTotal: r.estimated_total,
    weightAdjustStatus: r.weight_adjust_status,
    createdAt: r.created_at,
    isPreorder: !!r.is_preorder,
    awaitingStock: r.short_milli > 0,
    shortMilli: r.short_milli,
    shortLines: shorts.get(r.id) ?? [],
    needsRefund: r.refund_due > 0,
    refundDue: r.refund_due,
    diffAmount: r.diff_status === "pending" ? r.diff_amount : 0,
    diffStatus: r.diff_status,
  }));
  const cnt = (
    await c.env.DB
      .prepare(`SELECT o.status, COUNT(*) AS n, COALESCE(SUM(o.total),0) AS s FROM orders o WHERE ${base.join(" AND ")} GROUP BY o.status`)
      .bind(...bp)
      .all<{ status: string; n: number; s: number }>()
  ).results;
  const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let all = 0;
  for (const r of cnt) {
    counts[r.status] = r.n;
    all += r.n;
  }
  counts.all = all;
  // Tổng hợp theo bộ lọc (ngày/kênh/tìm kiếm), không phụ thuộc trạng thái đang chọn và phân trang
  const live = cnt.filter((r) => !["cancelled", "returned", "delivery_failed"].includes(r.status));
  const summary = { count: all, revenue: cnt.filter((r) => r.status === "completed").reduce((a, r) => a + r.s, 0), pipelineTotal: live.filter((r) => r.status !== "completed").reduce((a, r) => a + r.s, 0), cancelled: (counts.cancelled ?? 0) + (counts.returned ?? 0) + (counts.delivery_failed ?? 0) };
  return c.json({ items, nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null, counts, summary });
});

async function orderDetail(c: Ctx, oid: number) {
  const db = c.env.DB;
  const role = c.get("user").role;
  const o = await loadOpsOrder(db, oid, ALL_CHANNELS);
  const costVisible = canCost(c);
  const lines = (
    await db
      .prepare(`SELECT ol.*, p.name, p.sku, p.sell_by_weight, p.base_unit FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`)
      .bind(oid)
      .all<any>()
  ).results;
  const shipped = (
    await db
      .prepare(`SELECT oll.order_line_id, oll.lot_id, l.lot_code, oll.qty_milli, oll.unit_cost FROM order_line_lots oll JOIN lots l ON l.id = oll.lot_id JOIN order_lines ol ON ol.id = oll.order_line_id WHERE ol.order_id = ? ORDER BY oll.id`)
      .bind(oid)
      .all<any>()
  ).results;
  const reserved = (
    await db
      .prepare(`SELECT r.order_line_id, r.lot_id, l.lot_code, r.qty_milli, l.unit_cost, l.expires_at FROM reservations r JOIN lots l ON l.id = r.lot_id WHERE r.order_id = ? AND r.status = 'active' ORDER BY r.id`)
      .bind(oid)
      .all<any>()
  ).results;
  const lotView = (r: any, kind: string) => ({ lotId: r.lot_id, lotCode: r.lot_code, qtyMilli: r.qty_milli, kind, ...(costVisible ? { unitCost: r.unit_cost } : {}) });
  const events = (await db.prepare(`SELECT * FROM order_events WHERE order_id = ? ORDER BY id`).bind(oid).all<any>()).results;
  const intents = (await db.prepare(`SELECT id, provider, amount, status, transfer_content, provider_ref, expires_at, created_at, completed_at FROM payment_intents WHERE order_id = ? ORDER BY id`).bind(oid).all<any>()).results;
  const payments = (await db.prepare(`SELECT id, method, amount, fund_id, ref, status, created_at FROM payments WHERE order_id = ? ORDER BY id`).bind(oid).all<any>()).results;
  const returns = (await db.prepare(`SELECT id, code, total, cost_total, created_at FROM orders WHERE original_order_id = ? AND kind = 'return' AND status = 'completed' ORDER BY id`).bind(oid).all<any>()).results;
  const returnedTotal = returns.reduce((s, r) => s + r.total, 0);
  const slot = o.slot_id ? await db.prepare(`SELECT id, label, start_time, end_time FROM delivery_slots WHERE id = ?`).bind(o.slot_id).first<any>() : null;
  const zone = o.zone_id ? await db.prepare(`SELECT id, name FROM delivery_zones WHERE id = ?`).bind(o.zone_id).first<any>() : null;
  const shorts = await shortageView(db, oid);
  const shortOf = (lineId: number) => shorts.find((x) => x.orderLineId === lineId && x.status === "open");
  const awaiting = shorts.filter((x) => x.status === "open" && x.qtyMilli > 0);
  return {
    id: o.id,
    code: o.code,
    channel: o.channel,
    status: o.status,
    statusLabel: CUSTOMER_LABEL[o.status as OnlineStatus] ?? o.status,
    paymentMethod: o.payment_method,
    paymentStatus: o.payment_status,
    slotDate: o.slot_date,
    slot: slot ? { id: slot.id, label: slot.label, startTime: slot.start_time, endTime: slot.end_time } : null,
    zone,
    receiverName: o.receiver_name,
    receiverPhone: maskPhone(o.receiver_phone, role),
    shipAddress: o.ship_address,
    customerId: o.customer_id,
    shopAccountId: o.shop_account_id,
    subtotal: o.subtotal,
    discount: o.discount,
    shippingFee: o.shipping_fee,
    total: o.total,
    paidTotal: o.paid_total,
    // A-14: nghĩa vụ hoàn tiền chờ kế toán (finance.write) hoàn thực tế
    refundDue: o.refund_due,
    estimatedTotal: o.estimated_total,
    weightAdjustStatus: o.weight_adjust_status,
    weightOverrideBy: o.weight_override_by,
    weightOverrideReason: o.weight_override_reason,
    // A-02: chênh lệch cân đơn trả trước — dương "Thu thêm" (thu khi giao), âm "Hoàn lại" (phải hoàn / miễn mới hoàn tất được)
    diffAmount: o.diff_amount,
    diffStatus: o.diff_status,
    diffNote: o.diff_note,
    diffKind: o.diff_status === "none" || !o.diff_amount ? null : o.diff_amount > 0 ? "collect" : "refund",
    // A-05: phiếu trả hàng sau giao (đơn gốc vẫn 'completed')
    returns: returns.map((r) => ({ id: r.id, code: r.code, total: r.total, createdAt: r.created_at })),
    returnedTotal,
    fullyReturned: o.status === "completed" && returnedTotal > 0 && returnedTotal >= o.total,
    isPreorder: !!o.is_preorder,
    awaitingStock: awaiting.length > 0,
    shortMilli: awaiting.reduce((a, x) => a + x.qtyMilli, 0),
    carrier: o.carrier,
    carrierTrackingNo: o.carrier_tracking_no,
    source: o.source,
    delivererUserId: o.deliverer_user_id,
    posShiftId: o.pos_shift_id,
    cancelReason: o.cancel_reason,
    shippingFeePolicy: o.shipping_fee_policy,
    note: o.note,
    trackingToken: o.tracking_token,
    weightToleranceBp: Number((await db.prepare(`SELECT value FROM settings WHERE key = 'online.weight_tolerance_bp'`).first<{ value: string }>())?.value ?? 1000),
    createdAt: o.created_at,
    completedAt: o.completed_at,
    ...(costVisible ? { costTotal: o.cost_total } : {}),
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.product_id,
      name: l.name,
      sku: l.sku,
      sellByWeight: !!l.sell_by_weight,
      unit: l.unit,
      baseUnit: l.base_unit,
      orderedQtyMilli: l.ordered_qty_milli ?? l.qty_milli,
      qtyMilli: l.qty_milli,
      preorderMilli: l.preorder_milli,
      shortMilli: shortOf(l.id)?.qtyMilli ?? 0,
      poCode: shortOf(l.id)?.poCode ?? null,
      poStatus: shortOf(l.id)?.poStatus ?? null,
      poExpectedDate: shortOf(l.id)?.poExpectedDate ?? null,
      unitPrice: l.unit_price,
      discount: l.discount,
      lineTotal: l.line_total,
      ...(costVisible ? { costAmount: l.cost_amount } : {}),
      lots: [...shipped.filter((x) => x.order_line_id === l.id).map((x) => lotView(x, "shipped")), ...reserved.filter((x) => x.order_line_id === l.id).map((x) => lotView(x, "reserved"))],
    })),
    events: events.map((e) => ({ id: e.id, at: e.at, status: e.status, statusLabel: CUSTOMER_LABEL[e.status as OnlineStatus] ?? e.status, note: e.note, internalNote: e.internal_note, actorType: e.actor_type, actorId: e.actor_id })),
    paymentIntents: intents.map((i) => ({ id: i.id, provider: i.provider, amount: i.amount, status: i.status, transferContent: i.transfer_content, providerRef: i.provider_ref, expiresAt: i.expires_at, createdAt: i.created_at, completedAt: i.completed_at })),
    payments: payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount, fundId: p.fund_id, ref: p.ref, status: p.status, createdAt: p.created_at })),
  };
}

onlineOrderRoutes.get("/online-orders/:id", requirePerm("orders.online.manage"), async (c) => c.json(await orderDetail(c, id(c))));

// ====================================================================== tạo đơn mạng xã hội

const phone = z.string().trim().regex(/^[0-9+ ().-]{8,16}$/, "Số điện thoại không hợp lệ");
const socialSchema = z.object({
  clientUuid: z.string().uuid().optional(),
  customerId: z.number().int().positive().nullish(),
  receiverName: z.string().trim().min(1).max(120),
  receiverPhone: phone,
  addressLine: z.string().trim().min(3).max(300),
  ward: z.string().trim().max(100).nullish(),
  district: z.string().trim().min(1).max(100),
  province: z.string().trim().max(100).nullish(),
  items: z.array(z.object({ productId: z.number().int().positive(), unit: z.string().min(1).max(20), qty: z.number().positive().max(100000) })).min(1).max(100),
  slotDate: z.string().regex(DATE).nullish(),
  slotId: z.number().int().positive().nullish(),
  paymentMethod: z.enum(["cod", "transfer"]),
  note: z.string().trim().max(500).nullish(),
  shippingFee: z.number().int().min(0).max(10_000_000).optional(),
  acceptPreorder: z.boolean().optional(),
}).refine((b) => !!b.slotDate === !!b.slotId, { message: "slotDate và slotId phải đi cùng nhau" });

onlineOrderRoutes.post("/online-orders", requirePerm("orders.online.manage"), async (c) => {
  const body = await parseBody(c, socialSchema);
  const r = await createSocialOrder(c, body);
  return c.json(await orderDetail(c, r.id), r.created ? 201 : 200);
});

// ====================================================================== chuyển trạng thái

const act = (path: string, perm: "orders.online.manage" | "finance.write" | "finance.approve", fn: (c: Ctx, oid: number) => Promise<unknown>) =>
  onlineOrderRoutes.post(`/online-orders/:id/${path}`, requirePerm(perm), async (c) => {
    const oid = id(c);
    const extra = await fn(c, oid);
    return c.json({ ...(await orderDetail(c, oid)), ...(extra && typeof extra === "object" ? { result: extra } : {}) });
  });

const body0 = async <S extends z.ZodTypeAny>(c: Ctx, s: S): Promise<z.infer<S>> => s.parse(await c.req.json().catch(() => ({})));

act("confirm", "orders.online.manage", (c, oid) => confirmOrder(c, oid));
act("prepare", "orders.online.manage", (c, oid) => prepareOrder(c, oid));
act("pack", "orders.online.manage", async (c, oid) =>
  packOrder(c, oid, await parseBody(c, z.object({
    lines: z.array(z.object({ orderLineId: z.number().int().positive(), actualQty: z.number().min(0).max(100000), unit: z.string().min(1).max(20).optional() })).min(1).max(200),
    note: z.string().trim().max(300).optional(),
  }))));
act("weight-override", "orders.online.manage", async (c, oid) => overrideWeight(c, oid, (await parseBody(c, z.object({ reason: z.string().trim().min(5).max(300) }))).reason));
act("ship", "orders.online.manage", async (c, oid) =>
  shipOrder(c, oid, await body0(c, z.object({ carrier: z.string().trim().max(60).optional(), trackingNo: z.string().trim().max(60).optional() }))));
act("deliver", "orders.online.manage", (c, oid) => deliverOrder(c, oid));
act("fail", "orders.online.manage", async (c, oid) => failOrder(c, oid, (await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }))).reason));
act("redeliver", "orders.online.manage", async (c, oid) =>
  redeliverOrder(c, oid, await parseBody(c, z.object({ slotDate: z.string().regex(DATE), slotId: z.number().int().positive() }))));
act("return-to-stock", "orders.online.manage", async (c, oid) =>
  returnToStock(c, oid, await parseBody(c, z.object({
    lines: z.array(z.object({
      orderLineId: z.number().int().positive(),
      qty: z.number().min(0).max(100000),
      unit: z.string().min(1).max(20).optional(),
      restock: z.boolean(),
      reason: z.string().trim().min(2).max(300),
    })).max(200).default([]),
  }))));
act("cancel", "orders.online.manage", async (c, oid) => cancelOrder(c, oid, (await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }))).reason));
act("refund", "finance.write", (c, oid) => refundOrder(c, oid));
// A-02: chênh lệch cân của đơn trả trước — hoàn phần dư (finance.write) hoặc miễn (finance.approve, bắt buộc lý do, ghi audit)
act("refund-diff", "finance.write", (c, oid) => refundDiff(c, oid));
act("waive-diff", "finance.approve", async (c, oid) => waiveDiff(c, oid, (await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }))).reason));

act("mark-paid", "finance.write", async (c, oid) => {
  const b = await parseBody(c, z.object({
    bankTxnId: z.number().int().positive().optional(),
    ref: z.string().trim().min(3).max(100).optional(),
    fundId: z.number().int().positive().optional(),
  }).refine((x) => x.bankTxnId || x.ref, { message: "Cần bankTxnId hoặc ref (mã giao dịch) để đối chiếu" }));
  const db = c.env.DB;
  const o = await loadOpsOrder(db, oid);
  let amount = o.total;
  let ref = b.ref ?? null;
  let fundId = b.fundId;
  if (b.bankTxnId) {
    const t = await db.prepare(`SELECT * FROM bank_transactions WHERE id=?`).bind(b.bankTxnId).first<any>();
    if (!t) throw new AppError(422, "bank_txn_not_found", "Không tìm thấy giao dịch ngân hàng");
    if (t.status !== "unmatched") throw conflict("not_unmatched", "Giao dịch ngân hàng đã được xử lý");
    if (t.amount !== o.total) throw new AppError(422, "amount_mismatch", "Số tiền giao dịch không bằng tổng đơn", { txnAmount: t.amount, total: o.total });
    const sc = await sepayCandidates(db, { fund_id: t.fund_id, amount: t.amount, txn_date: t.txn_date, bank_ref: t.bank_ref });
    if (sc.length) throw conflict("already_recorded_by_sepay", "Khoản tiền này đã được SePay ghi vào quỹ — gán giao dịch SePay vào đơn ở màn Giao dịch SePay", { candidates: sc });
    amount = t.amount;
    ref ??= t.bank_ref;
    fundId ??= t.fund_id;
  }
  if (fundId && !(await db.prepare(`SELECT 1 AS x FROM funds WHERE id=? AND active=1`).bind(fundId).first())) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại");
  await markOrderPaid(c.env, o, {
    userId: c.get("user").id,
    fundId: fundId ?? (await bankFundId(db, o.store_id)),
    amount,
    ref,
    bankTxnId: b.bankTxnId,
    audit: auditStmt(c, { action: "online_order.mark_paid", entity: "order", entityId: oid, after: { amount, ref, bankTxnId: b.bankTxnId ?? null } }),
  });
});

// ====================================================================== khu vực & khung giờ giao (M1-07)

const zoneSchema = z.object({
  name: z.string().trim().min(1).max(100),
  districts: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
  fee: z.number().int().min(0).max(10_000_000),
  freeOver: z.number().int().min(0).max(10_000_000_000).nullish(),
  minOrder: z.number().int().min(0).max(10_000_000_000).default(0),
  active: z.boolean().default(true),
});
const zoneView = (z: any) => ({ id: z.id, name: z.name, districts: JSON.parse(z.districts_json), fee: z.fee, freeOver: z.free_over, minOrder: z.min_order, active: !!z.active });

onlineOrderRoutes.get("/delivery-zones", requirePerm("orders.online.manage"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM delivery_zones ORDER BY id`).all<any>();
  return c.json({ items: results.map(zoneView) });
});
onlineOrderRoutes.post("/delivery-zones", requirePerm("approvals.decide"), async (c) => {
  const b = await parseBody(c, zoneSchema);
  const r = await c.env.DB.prepare(`INSERT INTO delivery_zones(name, districts_json, fee, free_over, min_order, active) VALUES (?,?,?,?,?,?) RETURNING *`)
    .bind(b.name, JSON.stringify(b.districts), b.fee, b.freeOver ?? null, b.minOrder, b.active ? 1 : 0).first<any>();
  await auditStmt(c, { action: "delivery_zone.create", entity: "delivery_zone", entityId: r.id, after: b }).run();
  return c.json(zoneView(r), 201);
});
onlineOrderRoutes.put("/delivery-zones/:id", requirePerm("approvals.decide"), async (c) => {
  const zid = id(c);
  const b = await parseBody(c, zoneSchema);
  const before = await c.env.DB.prepare(`SELECT * FROM delivery_zones WHERE id=?`).bind(zid).first<any>();
  if (!before) throw notFound("zone_not_found", "Không tìm thấy khu vực");
  const r = await c.env.DB.prepare(`UPDATE delivery_zones SET name=?, districts_json=?, fee=?, free_over=?, min_order=?, active=? WHERE id=? RETURNING *`)
    .bind(b.name, JSON.stringify(b.districts), b.fee, b.freeOver ?? null, b.minOrder, b.active ? 1 : 0, zid).first<any>();
  await auditStmt(c, { action: "delivery_zone.update", entity: "delivery_zone", entityId: zid, before: zoneView(before), after: b }).run();
  return c.json(zoneView(r));
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const slotSchema = z.object({
  label: z.string().trim().min(1).max(40),
  startTime: z.string().regex(HHMM),
  endTime: z.string().regex(HHMM),
  cutoffMinutes: z.number().int().min(0).max(24 * 60).default(90),
  capacity: z.number().int().min(1).max(1000).default(20),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
  active: z.boolean().default(true),
}).refine((s) => s.endTime > s.startTime, { message: "Giờ kết thúc phải sau giờ bắt đầu" });
const slotView = (s: any) => ({ id: s.id, label: s.label, startTime: s.start_time, endTime: s.end_time, cutoffMinutes: s.cutoff_minutes, capacity: s.capacity, weekdays: String(s.weekdays).split(",").map(Number), active: !!s.active });

onlineOrderRoutes.get("/delivery-slots", requirePerm("orders.online.manage"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM delivery_slots ORDER BY start_time, id`).all<any>();
  return c.json({ items: results.map(slotView) });
});
onlineOrderRoutes.post("/delivery-slots", requirePerm("approvals.decide"), async (c) => {
  const b = await parseBody(c, slotSchema);
  const r = await c.env.DB.prepare(`INSERT INTO delivery_slots(label, start_time, end_time, cutoff_minutes, capacity, weekdays, active) VALUES (?,?,?,?,?,?,?) RETURNING *`)
    .bind(b.label, b.startTime, b.endTime, b.cutoffMinutes, b.capacity, [...new Set(b.weekdays)].sort().join(","), b.active ? 1 : 0).first<any>();
  await auditStmt(c, { action: "delivery_slot.create", entity: "delivery_slot", entityId: r.id, after: b }).run();
  return c.json(slotView(r), 201);
});
onlineOrderRoutes.put("/delivery-slots/:id", requirePerm("approvals.decide"), async (c) => {
  const sid = id(c);
  const b = await parseBody(c, slotSchema);
  const before = await c.env.DB.prepare(`SELECT * FROM delivery_slots WHERE id=?`).bind(sid).first<any>();
  if (!before) throw notFound("slot_not_found", "Không tìm thấy khung giờ");
  const r = await c.env.DB.prepare(`UPDATE delivery_slots SET label=?, start_time=?, end_time=?, cutoff_minutes=?, capacity=?, weekdays=?, active=? WHERE id=? RETURNING *`)
    .bind(b.label, b.startTime, b.endTime, b.cutoffMinutes, b.capacity, [...new Set(b.weekdays)].sort().join(","), b.active ? 1 : 0, sid).first<any>();
  await auditStmt(c, { action: "delivery_slot.update", entity: "delivery_slot", entityId: sid, before: slotView(before), after: b }).run();
  return c.json(slotView(r));
});

// ====================================================================== tài khoản khách website + liên kết sỉ (M8-09)

onlineOrderRoutes.get("/shop-accounts", requirePerm("customers.view_pii"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [`a.deleted_at IS NULL`];
  const params: unknown[] = [];
  if (q.b2bStatus) {
    if (!["pending", "approved", "rejected"].includes(q.b2bStatus)) throw new AppError(422, "validation_error", "b2bStatus không hợp lệ");
    conds.push(`a.b2b_status = ?`);
    params.push(q.b2bStatus);
  }
  if (q.q?.trim()) {
    const like = `%${q.q.trim().replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    conds.push(`(a.email LIKE ? ESCAPE '\\' OR a.full_name LIKE ? ESCAPE '\\' OR a.phone LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  if (q.cursor) {
    conds.push(`a.id < ?`);
    params.push(Number(q.cursor));
  }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT a.id, a.customer_id, a.email, a.phone, a.full_name, a.kind, a.b2b_status, a.email_verified_at, a.active, a.created_at,
                (SELECT ap.id FROM approvals ap WHERE ap.type='shop.b2b_link' AND ap.status='pending' AND ap.ref_id = CAST(a.id AS TEXT) ORDER BY ap.id DESC LIMIT 1) AS approval_id,
                (SELECT ap.payload_json FROM approvals ap WHERE ap.type='shop.b2b_link' AND ap.status='pending' AND ap.ref_id = CAST(a.id AS TEXT) ORDER BY ap.id DESC LIMIT 1) AS request_json
           FROM shop_accounts a WHERE ${conds.join(" AND ")} ORDER BY a.id DESC LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<any>()
  ).results;
  const page = rows.slice(0, limit);
  return c.json({
    items: page.map((a) => {
      let request: unknown = null;
      try { request = a.request_json ? JSON.parse(a.request_json) : null; } catch { /* bỏ qua */ }
      return { id: a.id, customerId: a.customer_id, email: a.email, phone: a.phone, fullName: a.full_name, kind: a.kind, b2bStatus: a.b2b_status, emailVerified: !!a.email_verified_at, active: !!a.active, createdAt: a.created_at, approvalId: a.approval_id, b2bRequest: request };
    }),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  });
});

/** Gắn tài khoản shop với khách sỉ có sẵn: kind b2b + b2b_status approved. */
async function linkStmts(db: D1Database, accountId: number, customerId: number) {
  const acc = await db.prepare(`SELECT id FROM shop_accounts WHERE id=? AND deleted_at IS NULL`).bind(accountId).first();
  if (!acc) throw notFound("account_not_found", "Không tìm thấy tài khoản");
  const cu = await db.prepare(`SELECT id, type FROM customers WHERE id=? AND active=1`).bind(customerId).first<{ id: number; type: string }>();
  if (!cu) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
  if (cu.type !== "b2b") throw new AppError(422, "not_b2b_customer", "Chỉ gắn với khách sỉ (type b2b)");
  return [db.prepare(`UPDATE shop_accounts SET retail_customer_id = COALESCE(retail_customer_id, CASE WHEN kind = 'retail' THEN customer_id END), customer_id=?, kind='b2b', b2b_status='approved' WHERE id=?`).bind(customerId, accountId)];
}

onlineOrderRoutes.post("/shop-accounts/:id/b2b-link", requirePerm("b2b.approve"), async (c) => {
  const aid = id(c);
  const { customerId } = await parseBody(c, z.object({ customerId: z.number().int().positive() }));
  const db = c.env.DB;
  const user = c.get("user");
  const stmts = await linkStmts(db, aid, customerId);
  await db.batch([
    ...stmts,
    db.prepare(`UPDATE approvals SET status='approved', decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note='Gắn trực tiếp' WHERE type='shop.b2b_link' AND ref_id=? AND status='pending'`).bind(user.id, String(aid)),
    auditStmt(c, { action: "shop_account.b2b_link", entity: "shop_account", entityId: aid, after: { customerId } }),
  ]);
  const a = await db.prepare(`SELECT id, customer_id, kind, b2b_status FROM shop_accounts WHERE id=?`).bind(aid).first<any>();
  return c.json({ id: a.id, customerId: a.customer_id, kind: a.kind, b2bStatus: a.b2b_status });
});

// Yêu cầu liên kết sỉ do shop tạo: cần chọn khách sỉ → dùng POST /shop-accounts/:id/b2b-link (đồng thời đóng yêu cầu duyệt).
registerApprovalHandler("shop.b2b_link", {
  perm: "b2b.approve",
  onApprove: async () => {
    throw new AppError(422, "use_b2b_link_endpoint", "Hãy gắn tài khoản với khách sỉ qua chức năng Liên kết khách sỉ (POST /shop-accounts/:id/b2b-link); yêu cầu duyệt sẽ tự đóng");
  },
  onReject: async (c, a) => [c.env.DB.prepare(`UPDATE shop_accounts SET b2b_status='rejected' WHERE id=? AND kind <> 'b2b'`).bind(Number(a.ref_id))],
});

// ====================================================================== push cho nhân viên ERP

onlineOrderRoutes.get("/push/vapid-public-key", async (c) => c.json({ publicKey: pushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY : null }));

const subSchema = z.object({
  endpoint: z.string().url().max(500).refine((u) => u.startsWith("https://"), "endpoint phải là https"),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(30) }),
});

onlineOrderRoutes.post("/me/push-subscriptions", async (c) => {
  const b = await parseBody(c, subSchema);
  try {
    const pk = b64uDecode(b.keys.p256dh);
    if (pk.length !== 65 || pk[0] !== 4 || b64uDecode(b.keys.auth).length !== 16) throw new Error();
  } catch {
    throw new AppError(422, "validation_error", "Khoá push không hợp lệ");
  }
  const u = c.get("user");
  await guarded(() =>
    c.env.DB
      .prepare(
        `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, account_id=NULL, p256dh=excluded.p256dh, auth=excluded.auth, last_error=NULL`,
      )
      .bind(u.id, b.endpoint, b.keys.p256dh, b.keys.auth)
      .run(),
  );
  return c.json({ ok: true }, 201);
});

onlineOrderRoutes.delete("/me/push-subscriptions", async (c) => {
  const b = await parseBody(c, z.object({ endpoint: z.string().url().max(500) }));
  await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?`).bind(b.endpoint, c.get("user").id).run();
  return c.json({ ok: true });
});
