import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can, maskPhone } from "../lib/rbac";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { lineAmount } from "../lib/money";
import { vnDate, vnDayRangeUtc, vnPeriod } from "../lib/time";
import { allocateFefo, allocationCost, moveStatements, type LotAllocation } from "../services/stock";
import { resolvePrice } from "../services/pricing";
import { getSettingInt } from "../services/settings";
import { salesSummary } from "../services/salesreport";
import { groupIdsOf, planPromotions, promoStatements } from "../services/promo-checkout";
import { assertStmt } from "../services/guard";
import { retireStaleDraft } from "../services/online-ops";
import { isPointsInsufficient, isVoucherExhausted, reversalStatements } from "../services/loyalty-points";

export const posRoutes = new Hono<AppBindings>();

type Ctx = Context<AppBindings>;

async function parseBody<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => ({}));
  return schema.parse(raw);
}

const MAX_VND = 10_000_000_000;
const MAX_QTY = 1_000_000;
const METHODS = ["cash", "transfer", "qr", "card", "ewallet"] as const;
const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));

async function storeIdOf(c: Ctx) {
  const u = c.get("user");
  if (u.storeId) return u.storeId;
  const s = await c.env.DB.prepare(`SELECT id FROM stores WHERE active=1 ORDER BY id LIMIT 1`).first<{ id: number }>();
  return s?.id ?? 1;
}

async function openShiftOf(db: D1Database, userId: number) {
  return db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(userId).first<any>();
}

/** Quỹ theo hình thức thanh toán: tiền mặt → quỹ của ca; còn lại → quỹ ngân hàng/ví đầu tiên đang hoạt động. */
async function fundFor(db: D1Database, storeId: number, method: string, shift: { fund_id: number } | null) {
  if (method === "cash") {
    if (shift) return shift.fund_id;
    const f = await db.prepare(`SELECT id FROM funds WHERE type='cash' AND active=1 ORDER BY (store_id IS ?) DESC, id LIMIT 1`).bind(storeId).first<{ id: number }>();
    if (!f) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ tiền mặt");
    return f.id;
  }
  const types = method === "ewallet" ? ["ewallet", "bank"] : ["bank"];
  for (const t of types) {
    const f = await db.prepare(`SELECT id FROM funds WHERE type = ? AND active=1 ORDER BY (store_id IS ?) DESC, id LIMIT 1`).bind(t, storeId).first<{ id: number }>();
    if (f) return f.id;
  }
  throw new AppError(422, "no_fund", "Chưa cấu hình quỹ ngân hàng cho hình thức thanh toán này");
}

async function unitFactor(db: D1Database, productId: number, unit: string) {
  const p = await db.prepare(`SELECT id, base_unit, active, name FROM products WHERE id = ?`).bind(productId).first<any>();
  if (!p || !p.active) throw new AppError(422, "product_not_found", "Mặt hàng không tồn tại hoặc đã ngừng bán", { productId });
  if (unit === p.base_unit) return { factor: 1000, product: p };
  const u = await db.prepare(`SELECT factor_milli FROM product_units WHERE product_id = ? AND unit = ?`).bind(productId, unit).first<{ factor_milli: number }>();
  if (!u) throw new AppError(422, "unit_not_found", `Đơn vị "${unit}" không hợp lệ cho mặt hàng`, { productId, unit });
  return { factor: u.factor_milli, product: p };
}

/** Chia một phân bổ lô cho nhiều dòng cùng mặt hàng theo thứ tự. */
function splitAlloc(alloc: LotAllocation[], qtys: number[]): LotAllocation[][] {
  const pool = alloc.map((a) => ({ ...a }));
  let i = 0;
  return qtys.map((q) => {
    const out: LotAllocation[] = [];
    let need = q;
    while (need > 0 && i < pool.length) {
      const take = Math.min(pool[i].qtyMilli, need);
      out.push({ lotId: pool[i].lotId, unitCost: pool[i].unitCost, qtyMilli: take });
      pool[i].qtyMilli -= take;
      need -= take;
      if (pool[i].qtyMilli === 0) i++;
    }
    return out;
  });
}

// ===================== Ca làm việc =====================

posRoutes.get("/shifts/current", requirePerm("pos.shift"), async (c) => {
  const shift = await openShiftOf(c.env.DB, c.get("user").id);
  return c.json({ shift: shift ?? null });
});

/** Ca đã chốt gần nhất của chính người dùng (hiện ở màn "Mở ca"). */
posRoutes.get("/shifts/last", requirePerm("pos.shift"), async (c) => {
  const db = c.env.DB;
  const s = await db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'closed' ORDER BY id DESC LIMIT 1`).bind(c.get("user").id).first<any>();
  if (!s) return c.json({ shift: null });
  const t = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS rev FROM orders WHERE shift_id = ? AND kind='sale' AND status = 'completed'`)
    .bind(s.id)
    .first<{ n: number; rev: number }>();
  return c.json({ shift: { id: s.id, openedAt: s.opened_at, closedAt: s.closed_at, openingCash: s.opening_cash, expectedCash: s.expected_cash, countedCash: s.counted_cash, diffCash: s.diff_cash, orderCount: t?.n ?? 0, revenue: t?.rev ?? 0 } });
});

posRoutes.post("/shifts/open", requirePerm("pos.shift"), async (c) => {
  const body = await parseBody(c, z.object({ openingCash: z.number().int().min(0).max(MAX_VND) }));
  const db = c.env.DB;
  const user = c.get("user");
  if (await openShiftOf(db, user.id)) throw conflict("shift_already_open", "Bạn đang có ca đang mở");
  const storeId = await storeIdOf(c);
  const fund = await db
    .prepare(`SELECT id FROM funds WHERE type='cash' AND active=1 ORDER BY (store_id IS ?) DESC, id LIMIT 1`)
    .bind(storeId)
    .first<{ id: number }>();
  if (!fund) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ tiền mặt");
  let id: number;
  try {
    const r = await db.prepare(`INSERT INTO shifts(store_id, user_id, fund_id, opening_cash) VALUES (?,?,?,?)`).bind(storeId, user.id, fund.id, body.openingCash).run();
    id = r.meta.last_row_id as number;
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message))) throw conflict("shift_already_open", "Bạn đang có ca đang mở");
    throw e;
  }
  await auditStmt(c, { action: "shift.open", entity: "shift", entityId: id, after: { openingCash: body.openingCash } }).run();
  const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).bind(id).first();
  return c.json({ shift }, 201);
});

async function expectedCash(db: D1Database, shift: { id: number; opening_cash: number; fund_id?: number; user_id?: number; opened_at?: string; closed_at?: string | null }) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.shift_id = ? AND o.status = 'completed' AND p.method = 'cash' AND p.status = 'confirmed'`,
    )
    .bind(shift.id)
    .first<{ s: number }>();
  // Đặt cọc đơn đặt trước (M1-12): phiếu thu/chi tiền mặt trên quỹ của ca, do người mở ca lập từ lúc mở ca
  const dep = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS s FROM cash_vouchers
        WHERE status='posted' AND ref_type='order_deposit' AND fund_id = ? AND created_by = ? AND created_at >= ?
          AND (? IS NULL OR created_at <= ?)`,
    )
    .bind((shift as any).fund_id, (shift as any).user_id, (shift as any).opened_at, (shift as any).closed_at ?? null, (shift as any).closed_at ?? null)
    .first<{ s: number }>();
  // A-06: tiền mặt hoàn khi huỷ đơn của CA ĐÃ CHỐT được lấy từ két ca này → trừ khỏi dự kiến (số liệu ca cũ giữ nguyên)
  const voidRef = await db
    .prepare(
      `SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.refund_shift_id = ? AND p.method = 'cash' AND p.status = 'refunded'`,
    )
    .bind(shift.id)
    .first<{ s: number }>();
  return shift.opening_cash + (r?.s ?? 0) + (dep?.s ?? 0) - (voidRef?.s ?? 0);
}

posRoutes.post("/shifts/:id/close", requirePerm("pos.shift"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ countedCash: z.number().int().min(0).max(MAX_VND), diffReason: z.string().trim().min(3).max(500).optional() }));
  const db = c.env.DB;
  const user = c.get("user");
  const shift = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).bind(id).first<any>();
  if (!shift) throw notFound("shift_not_found", "Không tìm thấy ca");
  if (shift.status !== "open") throw conflict("shift_closed", "Ca đã được chốt");
  if (shift.user_id !== user.id && !can(user.role, "approvals.decide")) throw forbidden("forbidden", "Chỉ người mở ca hoặc quản lý mới được chốt ca");
  const expected = await expectedCash(db, shift);
  const diff = body.countedCash - expected;
  if (diff !== 0 && !body.diffReason) {
    throw new AppError(422, "diff_reason_required", "Tiền kiểm đếm chênh lệch so với dự kiến, vui lòng nhập lý do", { expectedCash: expected, diff });
  }
  await db.batch([
    db
      .prepare(
        `UPDATE shifts SET status='closed', closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), expected_cash=?, counted_cash=?, diff_cash=?, diff_reason=?
          WHERE id=? AND status='open'`,
      )
      .bind(expected, body.countedCash, diff, body.diffReason ?? null, id),
    auditStmt(c, {
      action: "shift.close",
      entity: "shift",
      entityId: id,
      before: { status: "open", openingCash: shift.opening_cash },
      after: { expectedCash: expected, countedCash: body.countedCash, diff },
      reason: body.diffReason,
    }),
  ]);
  const closed = await db.prepare(`SELECT * FROM shifts WHERE id = ?`).bind(id).first();
  const report = await salesSummary(db, `o.shift_id = ?`, [id]);
  return c.json({ shift: closed, report });
});

// ===================== Checkout =====================

const checkoutSchema = z.object({
  clientUuid: z.string().min(8).max(64),
  customerId: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        unit: z.string().min(1).max(20),
        qty: z.number().positive().max(MAX_QTY),
        unitPriceOverride: z.number().int().min(0).max(MAX_VND).optional(), // VND / đơn vị chính
        discount: z.number().int().min(0).max(MAX_VND).optional(), // VND, giảm trực tiếp trên dòng
      }),
    )
    .min(1)
    .max(200),
  discount: z.number().int().min(0).max(MAX_VND).optional(), // VND, giảm cả đơn
  payments: z.array(z.object({ method: z.enum(METHODS), amount: z.number().int().positive().max(MAX_VND), ref: z.string().max(100).optional() })).max(10),
  note: z.string().max(500).optional(),
  approvalId: z.number().int().positive().optional(),
  voucherCode: z.string().trim().min(1).max(40).optional(), // Đợt 4: voucher khuyến mãi
  redeemPoints: z.number().int().positive().max(1_000_000_000).optional(), // Đợt 4: đổi điểm tích luỹ
});

async function getOrderFull(c: Ctx, orderId: number) {
  const db = c.env.DB;
  const role = c.get("user").role;
  const o = await db
    .prepare(
      `SELECT o.*, cu.name AS customer_name, cu.phone AS customer_phone, u.full_name AS cashier_name
         FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`,
    )
    .bind(orderId)
    .first<any>();
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  const lines = (
    await db
      .prepare(
        `SELECT ol.*, p.name AS product_name, p.sku FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`,
      )
      .bind(orderId)
      .all<any>()
  ).results;
  const lots = (
    await db
      .prepare(
        `SELECT oll.order_line_id, oll.lot_id, l.lot_code, oll.qty_milli, oll.unit_cost
           FROM order_line_lots oll JOIN lots l ON l.id = oll.lot_id
          WHERE oll.order_line_id IN (SELECT id FROM order_lines WHERE order_id = ?) ORDER BY oll.id`,
      )
      .bind(orderId)
      .all<any>()
  ).results;
  const payments = (await db.prepare(`SELECT * FROM payments WHERE order_id = ? ORDER BY id`).bind(orderId).all()).results;
  const discounts = (
    await db.prepare(`SELECT id, promotion_id, voucher_id, points_redeemed, amount, description FROM order_discounts WHERE order_id = ? ORDER BY id`).bind(orderId).all()
  ).results;
  const canCost = can(role, "prices.view_cost");
  const { customer_phone, cost_total, ...rest } = o;
  return {
    ...rest,
    ...(canCost ? { cost_total } : {}),
    customer: o.customer_id ? { id: o.customer_id, name: o.customer_name, phone: maskPhone(customer_phone, role) } : null,
    lines: lines.map((l) => {
      const { cost_amount, ...r } = l;
      return { ...(canCost ? { cost_amount } : {}), ...r, lots: lots.filter((x) => x.order_line_id === l.id).map((x) => (canCost ? x : { ...x, unit_cost: undefined })) };
    }),
    payments,
    discounts,
  };
}

posRoutes.post("/pos/orders", requirePerm("pos.sell"), async (c) => {
  const body = await parseBody(c, checkoutSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const orderDone = async (id: number, status: 200 | 201, change = 0, extra: object = {}) =>
    c.json({ ...(await getOrderFull(c, id)), change, ...extra }, status);

  // EC-04: idempotent theo clientUuid
  let existing = await db.prepare(`SELECT id, status, created_at FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number; status: string; created_at: string }>();
  // Đơn nháp mồ côi (crash giữa lúc tạo nháp và batch): quá 2 phút thì giải phóng clientUuid để client thử lại
  if (existing && existing.status === "draft" && Date.parse(existing.created_at) < Date.now() - 120_000) {
    await retireStaleDraft(db, existing.id);
    existing = null;
  }
  if (existing && existing.status !== "cancelled" && existing.status !== "draft") return orderDone(existing.id, 200);
  if (existing) throw conflict("order_in_progress", "Đơn đang xử lý hoặc đã huỷ, vui lòng tạo đơn mới với clientUuid khác");

  const shift = await openShiftOf(db, user.id);
  if (!shift) throw conflict("no_open_shift", "Chưa mở ca bán hàng");
  const storeId = shift.store_id as number;

  // khách hàng → nhóm giá
  let customer: { id: number; customer_group_id: number | null } | null = null;
  if (body.customerId) {
    customer = await db.prepare(`SELECT id, customer_group_id FROM customers WHERE id = ? AND active = 1`).bind(body.customerId).first<any>();
    if (!customer) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
  }

  // Bước A: quy đổi đơn vị, giá, số tiền (không phụ thuộc phân bổ lô)
  const items = [] as {
    productId: number; unit: string; qtyMilli: number; unitPrice: number; listPrice: number; priceListId: number;
    gross: number; lineDiscount: number; discount: number; lineTotal: number; listGross: number; promoDiscount: number;
  }[];
  for (const l of body.lines) {
    const { factor } = await unitFactor(db, l.productId, l.unit);
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    const resolved = await resolvePrice(db, l.productId, { channel: "pos", customerGroupId: customer?.customer_group_id });
    const unitPrice = l.unitPriceOverride ?? resolved.unitPrice;
    const gross = lineAmount(unitPrice, qtyMilli);
    const lineDiscount = Math.min(l.discount ?? 0, gross);
    items.push({
      productId: l.productId, unit: l.unit, qtyMilli, unitPrice, listPrice: resolved.unitPrice, priceListId: resolved.priceListId,
      gross, lineDiscount, discount: lineDiscount, lineTotal: gross - lineDiscount, listGross: lineAmount(resolved.unitPrice, qtyMilli), promoDiscount: 0,
    });
  }
  const baseSum = items.reduce((s, i) => s + i.gross - i.lineDiscount, 0);
  const orderDiscount = body.discount ?? 0;
  if (orderDiscount > baseSum) throw new AppError(422, "discount_too_large", "Giảm giá lớn hơn giá trị đơn");
  let given = 0;
  items.forEach((it, idx) => {
    const share = idx === items.length - 1 ? orderDiscount - given : baseSum > 0 ? Math.floor((orderDiscount * (it.gross - it.lineDiscount)) / baseSum) : 0;
    given += share;
    it.discount = it.lineDiscount + share;
    it.lineTotal = it.gross - it.discount;
  });
  // Đợt 4: khuyến mãi / voucher / đổi điểm (engine dùng chung) — ghi trong cùng batch với đơn
  const groups = await groupIdsOf(db, items.map((i) => i.productId));
  const promoPlan = await planPromotions(db, {
    channel: "pos",
    customerId: customer?.id ?? null,
    lines: items.map((i) => ({ productId: i.productId, groupId: groups.get(i.productId) ?? null, qtyMilli: i.qtyMilli, unitPrice: i.unitPrice, lineTotal: i.lineTotal })),
    subtotal: items.reduce((s, i) => s + i.lineTotal, 0),
    voucherCode: body.voucherCode,
    redeemPoints: body.redeemPoints,
    strict: true,
  });
  items.forEach((it, i) => {
    it.promoDiscount = promoPlan.lineDiscounts[i];
    it.discount += it.promoDiscount;
    it.lineTotal -= it.promoDiscount;
  });
  const subtotal = items.reduce((s, i) => s + i.gross, 0);
  const totalDiscount = items.reduce((s, i) => s + i.discount, 0);
  const total = subtotal - totalDiscount;

  // Thanh toán
  const paid = body.payments.reduce((s, p) => s + p.amount, 0);
  if (paid < total) throw new AppError(422, "payment_mismatch", "Tổng thanh toán chưa đủ tổng tiền đơn", { total, paid });
  const cashTotal = body.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const change = paid - total;
  if (change > cashTotal) throw new AppError(422, "payment_mismatch", "Tổng thanh toán vượt tổng tiền đơn (chỉ tiền mặt được thối lại)", { total, paid });
  const recorded = body.payments.map((p) => ({ ...p }));
  let toCut = change;
  for (let i = recorded.length - 1; i >= 0 && toCut > 0; i--) {
    if (recorded[i].method !== "cash") continue;
    const cut = Math.min(recorded[i].amount, toCut);
    recorded[i].amount -= cut;
    toCut -= cut;
  }
  const payFunds = new Map<string, number>();
  for (const p of recorded) if (!payFunds.has(p.method)) payFunds.set(p.method, await fundFor(db, storeId, p.method, shift));

  // Bước B: phân bổ FEFO + kiểm tra duyệt (có thể chạy lại 1 lần khi tồn đổi — EC-02)
  const discountBp = await getSettingInt(db, "approval.discount_pct_bp", 1000);
  let approvalUsed: number | null = null;
  const plan = async () => {
    const byProduct = new Map<number, number[]>();
    items.forEach((it, i) => byProduct.set(it.productId, [...(byProduct.get(it.productId) ?? []), i]));
    const lineAllocs: LotAllocation[][] = new Array(items.length);
    const productAllocs = new Map<number, LotAllocation[]>();
    for (const [pid, idxs] of byProduct) {
      const alloc = await allocateFefo(db, pid, idxs.reduce((s, i) => s + items[i].qtyMilli, 0), storeId);
      productAllocs.set(pid, alloc);
      splitAlloc(alloc, idxs.map((i) => items[i].qtyMilli)).forEach((a, k) => (lineAllocs[idxs[k]] = a));
    }
    const costs = lineAllocs.map((a) => allocationCost(a));
    const reasons: string[] = [];
    const listSum = items.reduce((s, i) => s + i.listGross, 0);
    const discValue = items.reduce((s, i) => s + Math.max(0, i.listGross - i.lineTotal - i.promoDiscount), 0);
    if (listSum > 0 && (discValue * 10000) / listSum > discountBp) reasons.push("discount");
    if (items.some((it, i) => it.lineTotal + it.promoDiscount < costs[i])) reasons.push("below_cost");
    approvalUsed = null;
    if (reasons.length && !can(user.role, "approvals.decide")) {
      approvalUsed = await requireApproval(c, body.clientUuid, body.approvalId, reasons, { total, discountValue: discValue }, await cartHash(body));
    }
    return { lineAllocs, productAllocs, costs, belowCost: reasons.includes("below_cost") };
  };

  let p = await plan();

  // Tạo đơn nháp trước, sau đó batch hoàn tất
  const code = await nextCode(db, PREFIX.order);
  let orderId: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, shift_id, customer_id, status, note, created_by)
         VALUES (?,?,?,?,?,?,?,'draft',?,?)`,
      )
      .bind(code, body.clientUuid, "pos", "sale", storeId, shift.id, body.customerId ?? null, body.note ?? null, user.id)
      .run();
    orderId = r.meta.last_row_id as number;
  } catch (e) {
    const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number }>();
    if (again) return orderDone(again.id, 200);
    throw e;
  }

  const cancelDraft = () => db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(orderId).run();

  const promoStmts = await promoStatements(db, { sql: "?", bind: orderId }, { plan: promoPlan, customerId: customer?.id ?? null, payableTotal: total, userId: user.id });

  const commit = async () => {
    await db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).bind(orderId).run();
    const lineIds: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = await db
        .prepare(
          `INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, cost_amount, below_cost_approval_id)
           VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .bind(orderId, it.productId, it.unit, it.qtyMilli, it.unitPrice, it.priceListId, it.discount, it.lineTotal, p.costs[i], p.belowCost ? approvalUsed : null)
        .first<{ id: number }>();
      lineIds.push(r!.id);
    }
    const costTotal = p.costs.reduce((s, x) => s + x, 0);
    const stmts: D1PreparedStatement[] = [];
    items.forEach((_, i) => {
      for (const a of p.lineAllocs[i]) {
        stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(lineIds[i], a.lotId, a.qtyMilli, a.unitCost));
      }
    });
    for (const [pid, alloc] of p.productAllocs) stmts.push(...moveStatements(db, pid, alloc, -1, "sale", "order", orderId, user.id));
    stmts.push(...promoStmts);
    for (const pay of recorded) {
      if (pay.amount <= 0) continue;
      stmts.push(
        db
          .prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`)
          .bind(orderId, pay.method, pay.amount, payFunds.get(pay.method)!, pay.ref ?? null),
      );
    }
    stmts.push(
      db
        .prepare(
          `UPDATE orders SET status='completed', subtotal=?, discount=?, total=?, cost_total=?, paid_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id=? AND status='draft'`,
        )
        .bind(subtotal, totalDiscount, total, costTotal, total, orderId),
    );
    if (approvalUsed) stmts.push(db.prepare(`UPDATE approvals SET ref_type='order', ref_id=? WHERE id=?`).bind(String(orderId), approvalUsed));
    stmts.push(
      auditStmt(c, {
        action: "order.checkout",
        entity: "order",
        entityId: orderId,
        after: { code, total, discount: totalDiscount, change, lines: items.length, approvalId: approvalUsed, voucher: promoPlan.voucher?.code ?? null, pointsRedeemed: promoPlan.points },
      }),
    );
    await db.batch(stmts);
  };

  try {
    try {
      await commit();
    } catch (e) {
      if (!isCheckFail(e) || isVoucherExhausted(e)) throw e;
      p = await plan(); // tồn vừa đổi: phân bổ lại 1 lần
      await commit();
    }
  } catch (e) {
    await cancelDraft();
    if (isVoucherExhausted(e)) throw conflict("voucher_exhausted", "Voucher đã hết lượt sử dụng");
    if (isPointsInsufficient(e)) throw conflict("points_insufficient", "Khách không đủ điểm để đổi");
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  return orderDone(orderId, 201, change, { promotions: { rejected: promoPlan.rejected } });
});

/** Yêu cầu duyệt (giá dưới vốn / giảm giá vượt ngưỡng): trả approvalId đã duyệt, hoặc 409 approval_required. */
async function cartHash(body: z.infer<typeof checkoutSchema>) {
  const canon = JSON.stringify({
    l: body.lines.map((l) => [l.productId, l.unit, l.qty, l.unitPriceOverride ?? null, l.discount ?? 0]),
    d: body.discount ?? 0,
    v: body.voucherCode ?? null,
    r: body.redeemPoints ?? 0,
  });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireApproval(c: Ctx, clientUuid: string, approvalId: number | undefined, reasons: string[], payload: object, hash: string): Promise<number> {
  const db = c.env.DB;
  const user = c.get("user");
  const type = reasons.includes("below_cost") ? "order.below_cost" : "order.discount";
  if (approvalId) {
    const a = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(approvalId).first<any>();
    // Duyệt gắn với đúng giỏ hàng (hash dòng + giảm giá) và đúng loại lý do, không chỉ clientUuid
    const okUuid = a && (() => { try { const j = JSON.parse(a.payload_json ?? "{}"); return j.clientUuid === clientUuid && j.hash === hash; } catch { return false; } })();
    if (a && okUuid && a.requested_by === user.id && a.type === type) {
      if (a.status === "approved" && !a.ref_id) return a.id;
      if (a.status === "rejected") throw new AppError(403, "approval_rejected", "Yêu cầu duyệt đã bị từ chối", { approvalId: a.id });
      if (a.status === "pending") throw conflict("approval_required", "Đang chờ quản lý duyệt", { approvalId: a.id, reasons });
    }
    throw conflict("approval_invalid", "Mã duyệt không hợp lệ hoặc đã được sử dụng", { approvalId });
  }
  const pending = await db
    .prepare(`SELECT id FROM approvals WHERE type LIKE 'order.%' AND status='pending' AND requested_by=? AND json_extract(payload_json,'$.clientUuid')=? AND json_extract(payload_json,'$.hash')=? AND type=?`)
    .bind(user.id, clientUuid, hash, type)
    .first<{ id: number }>();
  let id = pending?.id;
  if (!id) {
    const r = await db
      .prepare(`INSERT INTO approvals(type, ref_type, payload_json, reason, requested_by) VALUES (?,?,?,?,?)`)
      .bind(type, "order_draft", JSON.stringify({ clientUuid, reasons, hash, ...payload }), reasons.join(","), user.id)
      .run();
    id = r.meta.last_row_id as number;
    await auditStmt(c, { action: "approval.request", entity: "approval", entityId: id, after: { type, reasons } }).run();
  }
  throw conflict(
    "approval_required",
    reasons.includes("below_cost") ? "Giá bán thấp hơn giá vốn, cần quản lý duyệt" : "Giảm giá vượt ngưỡng, cần quản lý duyệt",
    { approvalId: id, reasons },
  );
}

// ===================== Danh sách / chi tiết / hoá đơn =====================

const DAY_RE_ORD = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string, name: string) => {
  if (!DAY_RE_ORD.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) throw new AppError(422, "validation_error", `${name} phải có dạng YYYY-MM-DD`);
  return v;
};

posRoutes.get("/orders", requirePerm("orders.view"), async (c) => {
  const q = c.req.query();
  const role = c.get("user").role;
  const pii = can(role, "customers.view_pii");
  const conds: string[] = [];
  const params: unknown[] = [];
  // Lọc theo ngày VN: `day` (một ngày, giữ tương thích) hoặc khoảng from..to (gồm cả hai đầu)
  if (q.day) {
    const r = vnDayRangeUtc(validDay(q.day, "day"));
    conds.push(`o.created_at >= ? AND o.created_at < ?`);
    params.push(r.from, r.to);
  } else if (q.from || q.to) {
    const from = validDay(q.from ?? q.to!, "from"), to = validDay(q.to ?? q.from!, "to");
    if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
    if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 366) throw new AppError(422, "validation_error", "Khoảng ngày tối đa 366 ngày");
    conds.push(`o.created_at >= ? AND o.created_at < ?`);
    params.push(vnDayRangeUtc(from).from, vnDayRangeUtc(to).to);
  }
  if (q.channel) { conds.push(`o.channel = ?`); params.push(q.channel); }
  if (q.status) { conds.push(`o.status = ?`); params.push(q.status); } else conds.push(`o.status <> 'draft'`);
  if (q.shiftId) { conds.push(`o.shift_id = ?`); params.push(Number(q.shiftId)); }
  if (q.kind) { conds.push(`o.kind = ?`); params.push(q.kind); }
  if (q.cashierId) { conds.push(`o.created_by = ?`); params.push(Number(q.cashierId)); }
  if (q.method) { conds.push(`EXISTS (SELECT 1 FROM payments pm WHERE pm.order_id = o.id AND pm.method = ? AND pm.status = 'confirmed')`); params.push(q.method); }
  const term = q.q?.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    // SĐT chỉ được tìm khi người dùng có quyền xem PII (tránh dò số điện thoại qua kết quả tìm kiếm)
    const parts = [`o.code LIKE ? ESCAPE '\\'`, `cu.name LIKE ? ESCAPE '\\'`, `o.receiver_name LIKE ? ESCAPE '\\'`];
    const ps: unknown[] = [like, like, like];
    if (pii) { parts.push(`cu.phone LIKE ? ESCAPE '\\'`, `o.receiver_phone LIKE ? ESCAPE '\\'`); ps.push(like, like); }
    conds.push(`(${parts.join(" OR ")})`);
    params.push(...ps);
  }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const join = `FROM orders o LEFT JOIN users u ON u.id = o.created_by LEFT JOIN customers cu ON cu.id = o.customer_id`;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const cursorCond = q.cursor ? `${where ? where + " AND" : "WHERE"} o.id < ?` : where;
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT o.id, o.code, o.channel, o.kind, o.status, o.total, o.discount, o.paid_total, o.shift_id, o.customer_id, o.original_order_id,
                o.created_at, o.completed_at, o.created_by AS cashier_id, u.full_name AS cashier_name,
                COALESCE(cu.name, o.receiver_name) AS customer_name, COALESCE(cu.phone, o.receiver_phone) AS customer_phone,
                (SELECT GROUP_CONCAT(DISTINCT pm.method) FROM payments pm WHERE pm.order_id = o.id AND pm.status = 'confirmed') AS methods
           ${join} ${cursorCond} ORDER BY o.id DESC LIMIT ?`,
      )
      .bind(...params, ...(q.cursor ? [Number(q.cursor)] : []), limit + 1)
      .all<any>()
  ).results;
  const items = rows.slice(0, limit).map((r) => ({
    ...r,
    customer_phone: maskPhone(r.customer_phone, role),
    methods: r.methods ? String(r.methods).split(",") : [],
  }));
  // Tổng hợp toàn bộ kết quả khớp bộ lọc (không phụ thuộc phân trang)
  const s = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS rows_total,
              COALESCE(SUM(CASE WHEN o.kind='sale' AND o.status <> 'cancelled' THEN 1 ELSE 0 END),0) AS order_count,
              COALESCE(SUM(CASE WHEN o.kind='sale' AND o.status = 'completed' THEN 1 ELSE 0 END),0) AS sale_count,
              COALESCE(SUM(CASE WHEN o.kind='sale' AND o.status = 'completed' THEN o.total ELSE 0 END),0) AS sale_total,
              COALESCE(SUM(CASE WHEN o.kind='return' AND o.status = 'completed' THEN 1 ELSE 0 END),0) AS return_count,
              COALESCE(SUM(CASE WHEN o.kind='return' AND o.status = 'completed' THEN o.total ELSE 0 END),0) AS return_total,
              COALESCE(SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END),0) AS cancelled_count
         ${join} ${where}`,
    )
    .bind(...params)
    .first<any>();
  const summary = {
    rowsTotal: s.rows_total, orderCount: s.order_count, saleCount: s.sale_count, saleTotal: s.sale_total,
    returnCount: s.return_count, returnTotal: s.return_total, cancelledCount: s.cancelled_count,
    revenue: s.sale_total - s.return_total, avgOrder: s.sale_count ? Math.round(s.sale_total / s.sale_count) : 0,
  };
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null, summary });
});

/** Danh sách người đã tạo đơn (cho bộ lọc "Thu ngân") */
posRoutes.get("/orders/cashiers", requirePerm("orders.view"), async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT u.id, u.full_name AS name FROM users u WHERE u.id IN (SELECT DISTINCT created_by FROM orders WHERE created_by IS NOT NULL) ORDER BY u.full_name`)
    .all<any>();
  return c.json({ items: results });
});

posRoutes.get("/orders/:id", requirePerm("orders.view"), async (c) => c.json(await getOrderFull(c, Number(c.req.param("id")))));

posRoutes.get("/pos/receipt/:id", requirePerm("orders.view"), async (c) => {
  const o = await getOrderFull(c, Number(c.req.param("id")));
  const store = await c.env.DB.prepare(`SELECT name, address FROM stores WHERE id = ?`).bind(o.store_id).first<any>();
  return c.json({
    store: store ?? null,
    code: o.code,
    kind: o.kind,
    status: o.status,
    createdAt: o.created_at,
    cashier: o.cashier_name,
    customer: o.customer,
    lines: o.lines.map((l: any) => ({
      name: l.product_name, unit: l.unit, qtyMilli: l.qty_milli, unitPrice: l.unit_price, discount: l.discount, lineTotal: l.line_total,
    })),
    subtotal: o.subtotal,
    discount: o.discount,
    discounts: (await c.env.DB.prepare(`SELECT description, amount FROM order_discounts WHERE order_id = ? ORDER BY id`).bind(o.id).all<{ description: string; amount: number }>()).results,
    total: o.total,
    payments: o.payments.map((p: any) => ({ method: p.method, amount: p.amount, ref: p.ref })),
    note: o.note,
  });
});

// ===================== Trả hàng (EC-01) =====================

const returnSchema = z.object({
  lines: z
    .array(
      z.object({
        orderLineId: z.number().int().positive(),
        qty: z.number().positive().max(MAX_QTY),
        unit: z.string().min(1),
        restock: z.boolean(),
        reason: z.string().trim().min(2).max(300),
      }),
    )
    .min(1)
    .max(200),
  refundMethod: z.enum(METHODS),
  approvalId: z.number().int().positive().optional(), // A-16: mã duyệt của quản lý (trả hàng cần duyệt)
});

posRoutes.post("/orders/:id/return", requirePerm("pos.return"), async (c) => {
  const origId = Number(c.req.param("id"));
  const body = await parseBody(c, returnSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const orig = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(origId).first<any>();
  if (!orig) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (orig.kind !== "sale" || orig.status !== "completed") throw conflict("not_returnable", "Chỉ trả hàng cho đơn bán đã hoàn tất");
  const shift = await openShiftOf(db, user.id);
  if (body.refundMethod === "cash" && !shift) throw conflict("no_open_shift", "Cần mở ca để hoàn tiền mặt");

  const prepared: { orig: any; qtyMilli: number; lineTotal: number; cost: number; alloc: LotAllocation[]; restock: boolean; reason: string }[] = [];
  const claimed = new Map<number, number>();
  for (const l of body.lines) {
    const ol = await db.prepare(`SELECT * FROM order_lines WHERE id = ? AND order_id = ?`).bind(l.orderLineId, origId).first<any>();
    if (!ol) throw new AppError(422, "line_not_found", "Dòng hàng không thuộc đơn này", { orderLineId: l.orderLineId });
    const { factor } = await unitFactor(db, ol.product_id, l.unit);
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    const prev = await db
      .prepare(
        `SELECT COALESCE(SUM(r.qty_milli),0) AS q, COALESCE(SUM(r.line_total),0) AS amt
           FROM order_lines r JOIN orders ro ON ro.id = r.order_id
          WHERE r.original_line_id = ? AND ro.kind='return' AND ro.status='completed'`,
      )
      .bind(ol.id)
      .first<{ q: number; amt: number }>();
    const inReq = claimed.get(ol.id) ?? 0;
    const already = prev!.q + inReq;
    if (already + qtyMilli > ol.qty_milli) {
      throw conflict("return_exceeds_sold", "Số lượng trả vượt số đã mua trừ số đã trả", { orderLineId: ol.id, soldMilli: ol.qty_milli, returnedMilli: already });
    }
    claimed.set(ol.id, inReq + qtyMilli);
    // Đi qua các lô gốc theo thứ tự, bỏ qua phần đã trả trước đó
    const lots = (await db.prepare(`SELECT lot_id, qty_milli, unit_cost FROM order_line_lots WHERE order_line_id = ? ORDER BY id`).bind(ol.id).all<any>()).results;
    let skip = already;
    let need = qtyMilli;
    const alloc: LotAllocation[] = [];
    for (const lot of lots) {
      let avail = lot.qty_milli;
      if (skip > 0) { const s = Math.min(skip, avail); skip -= s; avail -= s; }
      if (avail <= 0 || need <= 0) continue;
      const take = Math.min(avail, need);
      alloc.push({ lotId: lot.lot_id, qtyMilli: take, unitCost: lot.unit_cost });
      need -= take;
    }
    const isLast = already + qtyMilli === ol.qty_milli;
    const lineTotal = isLast ? ol.line_total - prev!.amt : Math.round((ol.line_total * qtyMilli) / ol.qty_milli);
    prepared.push({ orig: ol, qtyMilli, lineTotal, cost: allocationCost(alloc), alloc, restock: l.restock, reason: l.reason });
  }

  const total = prepared.reduce((s, x) => s + x.lineTotal, 0);
  const costTotal = prepared.reduce((s, x) => s + x.cost, 0);

  // A-16 (M1-09): thu ngân chỉ tự trả hàng đơn của CA ĐANG MỞ (hoặc cùng ngày VN của ca còn mở), dưới ngưỡng giá trị, có nhập lại kho.
  // Còn lại cần quản lý (approvals.decide) tự làm hoặc duyệt qua approvals (gắn băm yêu cầu trả như duyệt giảm giá POS).
  let approvalUsed: number | null = null;
  if (!can(user.role, "approvals.decide")) {
    const reasons: string[] = [];
    if (!(shift && orig.shift_id === shift.id)) {
      const osh = orig.shift_id ? await db.prepare(`SELECT status FROM shifts WHERE id = ?`).bind(orig.shift_id).first<{ status: string }>() : null;
      const sameDay = vnDate(new Date(orig.completed_at ?? orig.created_at)) === vnDate();
      if (!(sameDay && osh?.status === "open")) reasons.push("other_shift");
    }
    const threshold = await getSettingInt(db, "approval.pos_return_vnd", 500000);
    if (total >= threshold) reasons.push("high_value");
    if (prepared.some((x) => !x.restock)) reasons.push("no_restock");
    if (reasons.length) approvalUsed = await requireReturnApproval(c, origId, body, reasons, total);
  }
  const fundId = total > 0 ? await fundFor(db, orig.store_id, body.refundMethod, shift) : null;
  const code = await nextCode(db, PREFIX.return);
  const note = prepared.map((x) => `${x.orig.id}: ${x.reason}${x.restock ? "" : " (không nhập lại kho)"}`).join("; ").slice(0, 500);
  const r = await db
    .prepare(
      `INSERT INTO orders(code, channel, kind, original_order_id, store_id, shift_id, customer_id, status, note, created_by)
       VALUES (?,?,'return',?,?,?,?,'draft',?,?)`,
    )
    .bind(code, orig.channel, origId, orig.store_id, shift?.id ?? null, orig.customer_id, note, user.id)
    .run();
  const retId = r.meta.last_row_id as number;
  try {
    const lineIds: number[] = [];
    for (const x of prepared) {
      const row = await db
        .prepare(
          `INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, cost_amount, original_line_id)
           VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .bind(retId, x.orig.product_id, x.orig.unit, x.qtyMilli, x.orig.unit_price, x.orig.price_list_id, Math.max(0, lineAmount(x.orig.unit_price, x.qtyMilli) - x.lineTotal), x.lineTotal, x.cost, x.orig.id)
        .first<{ id: number }>();
      lineIds.push(row!.id);
    }
    // Chốt chặn trong batch (audit #2): trả đồng thời không được vượt số đã bán / số đã thu
    const stmts: D1PreparedStatement[] = [
      assertStmt(db, "order.return.status", `SELECT status = 'completed' AND kind = 'sale' FROM orders WHERE id = ?`, [origId]),
      ...(approvalUsed ? [assertStmt(db, "order.return.approval", `SELECT status = 'approved' AND ref_id IS NULL FROM approvals WHERE id = ?`, [approvalUsed])] : []),
      ...[...claimed].map(([olId, q]) =>
        assertStmt(
          db,
          "order.return.qty",
          `SELECT (SELECT qty_milli FROM order_lines WHERE id = ?)
                  - COALESCE((SELECT SUM(r.qty_milli) FROM order_lines r WHERE r.original_line_id = ? AND r.order_id IN (SELECT id FROM orders WHERE kind = 'return' AND status = 'completed')), 0) >= ?`,
          [olId, olId, q],
        ),
      ),
      assertStmt(
        db,
        "order.return.amount",
        `SELECT (SELECT total FROM orders WHERE id = ?) - COALESCE((SELECT SUM(total) FROM orders WHERE original_order_id = ? AND kind = 'return' AND status = 'completed'), 0) >= ?`,
        [origId, origId, total],
      ),
    ];
    // Đợt 4: thu hồi điểm tích / hoàn điểm đã đổi / hoàn lượt voucher
    const priorRet = (
      await db.prepare(`SELECT COALESCE(SUM(total),0) AS t FROM orders WHERE original_order_id = ? AND kind='return' AND status='completed'`).bind(origId).first<{ t: number }>()
    )?.t ?? 0;
    stmts.push(...(await reversalStatements(db, orig, priorRet + total, user.id, `trả hàng ${code}`)));
    prepared.forEach((x, i) => {
      if (!x.restock) return;
      for (const a of x.alloc) stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(lineIds[i], a.lotId, a.qtyMilli, a.unitCost));
      stmts.push(...moveStatements(db, x.orig.product_id, x.alloc, 1, "return", "order", retId, user.id));
    });
    if (total > 0) {
      stmts.push(db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?,?,?,?, 'confirmed')`).bind(retId, body.refundMethod, -total, fundId));
    }
    stmts.push(
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, total=?, cost_total=?, paid_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(total, total, costTotal, total, retId),
      ...(approvalUsed ? [db.prepare(`UPDATE approvals SET ref_type='order', ref_id=? WHERE id=? AND ref_id IS NULL`).bind(String(retId), approvalUsed)] : []),
      auditStmt(c, {
        action: "order.return",
        entity: "order",
        entityId: retId,
        after: { code, originalOrderId: origId, total, approvalId: approvalUsed, lines: prepared.map((x) => ({ orderLineId: x.orig.id, qtyMilli: x.qtyMilli, restock: x.restock, reason: x.reason })) },
        reason: note,
      }),
    );
    await db.batch(stmts);
  } catch (e) {
    await db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(retId).run();
    throw e;
  }
  return c.json(await getOrderFull(c, retId), 201);
});

/** A-16: duyệt trả hàng gắn đúng đơn gốc + dòng/số lượng/phương thức hoàn (băm), dùng một lần, không tự duyệt. */
async function requireReturnApproval(c: Ctx, origId: number, body: z.infer<typeof returnSchema>, reasons: string[], total: number): Promise<number> {
  const db = c.env.DB;
  const user = c.get("user");
  const canon = JSON.stringify({ o: origId, m: body.refundMethod, l: body.lines.map((l) => [l.orderLineId, l.qty, l.unit, l.restock]).sort((a, b) => Number(a[0]) - Number(b[0])) });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const type = "order.return";
  if (body.approvalId) {
    const a = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(body.approvalId).first<any>();
    const match = a && a.type === type && a.requested_by === user.id && (() => { try { return JSON.parse(a.payload_json ?? "{}").hash === hash; } catch { return false; } })();
    if (match) {
      if (a.status === "approved" && !a.ref_id) return a.id;
      if (a.status === "rejected") throw new AppError(403, "approval_rejected", "Yêu cầu duyệt trả hàng đã bị từ chối", { approvalId: a.id });
      if (a.status === "pending") throw conflict("approval_required", "Đang chờ quản lý duyệt trả hàng", { approvalId: a.id, reasons });
    }
    throw conflict("approval_invalid", "Mã duyệt không hợp lệ hoặc đã được sử dụng", { approvalId: body.approvalId });
  }
  const pending = await db
    .prepare(`SELECT id FROM approvals WHERE type=? AND status='pending' AND requested_by=? AND json_extract(payload_json,'$.hash')=?`)
    .bind(type, user.id, hash)
    .first<{ id: number }>();
  let id = pending?.id;
  if (!id) {
    const r = await db
      .prepare(`INSERT INTO approvals(type, ref_type, payload_json, reason, requested_by) VALUES (?,?,?,?,?)`)
      .bind(type, "order_return_draft", JSON.stringify({ originalOrderId: origId, hash, reasons, total }), reasons.join(","), user.id)
      .run();
    id = r.meta.last_row_id as number;
    await auditStmt(c, { action: "approval.request", entity: "approval", entityId: id, after: { type, reasons, originalOrderId: origId, total } }).run();
  }
  throw conflict("approval_required", "Trả hàng này cần quản lý duyệt (đơn ca khác / giá trị lớn / không nhập lại kho)", { approvalId: id, reasons });
}

// ===================== Huỷ đơn =====================

posRoutes.post("/orders/:id/void", requirePerm("pos.void"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }));
  const db = c.env.DB;
  const user = c.get("user");
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first<any>();
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (o.kind !== "sale" || o.status !== "completed") throw conflict("not_voidable", "Chỉ huỷ được đơn bán đã hoàn tất");
  // Đơn online/B2B/fresco có luồng huỷ riêng (giữ tồn, công nợ, COD…) — POS void sẽ làm sai kho/tiền
  if (o.channel !== "pos") throw conflict("wrong_channel", "Đơn kênh này có luồng huỷ riêng, không huỷ bằng POS");
  // A-07: đơn đặt trước đã giao (cọc đã trừ vào đơn) — huỷ bằng void không hoàn cọc → chặn, dùng Trả hàng (hoàn đủ tổng gồm cả cọc)
  const dep = await db.prepare(`SELECT id FROM order_deposits WHERE order_id = ? AND status IN ('applied','refunded','forfeited') LIMIT 1`).bind(id).first();
  if (dep) throw conflict("preorder_void_blocked", "Đơn đặt trước đã giao (đã trừ cọc) không huỷ bằng POS — dùng chức năng Trả hàng để hoàn đủ tiền cả phần cọc");
  const period = vnPeriod(new Date(o.completed_at ?? o.created_at));
  if (await db.prepare(`SELECT 1 AS x FROM periods WHERE period = ? AND locked_at IS NOT NULL`).bind(period).first()) {
    throw new AppError(423, "period_locked", "Kỳ đã khoá sổ, không huỷ được đơn của kỳ này");
  }
  // A-06 (EC-32): đơn của ca đã chốt chỉ quản lý huỷ; tiền mặt hoàn lấy từ két CA ĐANG MỞ của người huỷ → gắn vào ca đó,
  // số liệu ca đã chốt giữ nguyên. Không có ca mở mà đơn có tiền mặt → 409 no_open_shift.
  let refundShiftId: number | null = null;
  if (o.shift_id) {
    const sh = await db.prepare(`SELECT status FROM shifts WHERE id = ?`).bind(o.shift_id).first<{ status: string }>();
    if (sh?.status === "closed") {
      if (user.role !== "manager" && user.role !== "owner") throw forbidden("forbidden", "Đơn thuộc ca đã chốt, chỉ quản lý/chủ mới được huỷ");
      const cash = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE order_id = ? AND method='cash' AND status='confirmed'`).bind(id).first<{ s: number }>();
      if ((cash?.s ?? 0) > 0) {
        const cur = await openShiftOf(db, user.id);
        if (!cur) throw conflict("no_open_shift", "Đơn của ca đã chốt có tiền mặt: cần mở ca để hoàn tiền từ két hiện tại");
        refundShiftId = cur.id;
      }
    }
  }
  const hasReturn = await db.prepare(`SELECT 1 AS x FROM orders WHERE original_order_id = ? AND kind='return' AND status='completed' LIMIT 1`).bind(id).first();
  if (hasReturn) throw conflict("has_returns", "Đơn đã có phiếu trả hàng, không thể huỷ");
  const rows = (
    await db
      .prepare(
        `SELECT ol.product_id, oll.lot_id, oll.qty_milli, oll.unit_cost
           FROM order_line_lots oll JOIN order_lines ol ON ol.id = oll.order_line_id WHERE ol.order_id = ? ORDER BY oll.id`,
      )
      .bind(id)
      .all<any>()
  ).results;
  const byProduct = new Map<number, LotAllocation[]>();
  for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), { lotId: r.lot_id, qtyMilli: r.qty_milli, unitCost: r.unit_cost }]);
  const stmts: D1PreparedStatement[] = [
    // Chốt chặn (audit #1): hai lần huỷ đồng thời không được cùng nhập kho / thu hồi điểm
    assertStmt(
      db,
      "order.void",
      `SELECT o.status = 'completed' AND NOT EXISTS (SELECT 1 FROM orders r WHERE r.original_order_id = o.id AND r.kind = 'return' AND r.status = 'completed')
         AND NOT EXISTS (SELECT 1 FROM periods p WHERE p.period = ? AND p.locked_at IS NOT NULL)
         FROM orders o WHERE o.id = ?`,
      [period, id],
    ),
  ];
  if (refundShiftId) stmts.push(assertStmt(db, "order.void.refund_shift", `SELECT status = 'open' FROM shifts WHERE id = ?`, [refundShiftId]));
  for (const [pid, alloc] of byProduct) stmts.push(...moveStatements(db, pid, alloc, 1, "return", "order_void", id, user.id));
  stmts.push(...(await reversalStatements(db, o, o.total, user.id, "huỷ đơn")));
  stmts.push(
    db.prepare(`UPDATE orders SET status='cancelled', voided_by=?, void_reason=?, refund_shift_id=? WHERE id=? AND status='completed'`).bind(user.id, body.reason, refundShiftId, id),
    db.prepare(`UPDATE payments SET status='refunded' WHERE order_id=?`).bind(id),
    auditStmt(c, {
      action: "order.void",
      entity: "order",
      entityId: id,
      before: { status: o.status, total: o.total, shiftId: o.shift_id },
      after: { status: "cancelled", refundShiftId },
      reason: body.reason,
    }),
  );
  await db.batch(stmts);
  return c.json(await getOrderFull(c, id));
});
