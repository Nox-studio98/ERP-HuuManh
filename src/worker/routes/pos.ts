import { buildOrderFilter } from "../services/order-filter";
import { cartHashOf, requireDiscountApproval } from "../services/discount-approval";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can, maskPhone, ROLE_PERMS } from "../lib/rbac";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { lineAmount } from "../lib/money";
import { vnDate, vnPeriod } from "../lib/time";
import { allocateFefo, allocationCost, moveStatements, type LotAllocation } from "../services/stock";
import { resolvePrice } from "../services/pricing";
import { getSettingInt } from "../services/settings";
import { salesSummary } from "../services/salesreport";
import { groupIdsOf, planPromotions, promoStatements } from "../services/promo-checkout";
import { assertStmt, onceStmt } from "../services/guard";
import { assertPeriodOpen } from "../services/period";
import { retireStaleDraft } from "../services/online-ops";
import { sepayConfig } from "../services/sepay";
import { holdOutStmts } from "../services/sepay-ledger";
import { isPointsInsufficient, isVoucherExhausted, reversalStatements } from "../services/loyalty-points";
import { cashFormula } from "../services/shift-report";
import { chargeInputSchema, chargeStmts, MAX_CHARGES, resolveCharges } from "../services/order-charges";
import { creditAdjustmentStmt, creditInvoiceOf, creditInvoiceStmt, creditLimitGuard, creditReceiptInfo, creditSettings, creditTermsDays, openDebtOf } from "../services/pos-credit";
import { INVOICE_OUTSTANDING_SQL } from "../services/debt";

export const posRoutes = new Hono<AppBindings>();

export type Ctx = Context<AppBindings>;

async function parseBody<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => ({}));
  return schema.parse(raw);
}

export const MAX_VND = 10_000_000_000;
export const MAX_QTY = 1_000_000;
export const METHODS = ["cash", "transfer", "qr", "card", "ewallet"] as const;
export const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));

async function storeIdOf(c: Ctx) {
  const u = c.get("user");
  if (u.storeId) return u.storeId;
  const s = await c.env.DB.prepare(`SELECT id FROM stores WHERE active=1 ORDER BY id LIMIT 1`).first<{ id: number }>();
  return s?.id ?? 1;
}

export async function openShiftOf(db: D1Database, userId: number) {
  return db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(userId).first<any>();
}

/** Quỹ theo hình thức thanh toán: tiền mặt → quỹ của ca; còn lại → quỹ ngân hàng/ví đầu tiên đang hoạt động. */
export async function fundFor(db: D1Database, storeId: number, method: string, shift: { fund_id: number } | null) {
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

export async function unitFactor(db: D1Database, productId: number, unit: string) {
  const p = await db.prepare(`SELECT id, base_unit, active, name FROM products WHERE id = ?`).bind(productId).first<any>();
  if (!p || !p.active) throw new AppError(422, "product_not_found", "Mặt hàng không tồn tại hoặc đã ngừng bán", { productId });
  if (unit === p.base_unit) return { factor: 1000, product: p };
  const u = await db.prepare(`SELECT factor_milli FROM product_units WHERE product_id = ? AND unit = ?`).bind(productId, unit).first<{ factor_milli: number }>();
  if (!u) throw new AppError(422, "unit_not_found", `Đơn vị "${unit}" không hợp lệ cho mặt hàng`, { productId, unit });
  return { factor: u.factor_milli, product: p };
}

/** Chia một phân bổ lô cho nhiều dòng cùng mặt hàng theo thứ tự. */
export function splitAlloc(alloc: LotAllocation[], qtys: number[]): LotAllocation[][] {
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

/** Tiền mặt dự kiến của ca — một công thức duy nhất ở services/shift-report.ts (dùng chung với phiếu bàn giao ca). */
async function expectedCash(db: D1Database, shift: any) {
  return (await cashFormula(db, shift)).expected;
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
  try {
  await db.batch([
    // Chốt ca bấm 2 lần / hai người cùng chốt: chỉ một lần chạy (lần sau 409), không ghi 2 audit
    assertStmt(db, "shift.close", `SELECT status = 'open' FROM shifts WHERE id = ?`, [id]),
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
  } catch (e) {
    if (/state_changed/.test(String((e as Error)?.message))) throw conflict("shift_closed", "Ca đã được chốt");
    throw e;
  }
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
  payments: z.array(z.object({ method: z.enum(METHODS), amount: z.number().int().positive().max(MAX_VND), ref: z.string().max(100).optional(), qrRequestId: z.number().int().positive().optional() })).max(10),
  note: z.string().max(500).optional(),
  sellerId: z.number().int().positive().optional(), // người bán khác thu ngân (A4)
  approvalId: z.number().int().positive().optional(),
  voucherCode: z.string().trim().min(1).max(40).optional(), // Đợt 4: voucher khuyến mãi
  redeemPoints: z.number().int().positive().max(1_000_000_000).optional(), // Đợt 4: đổi điểm tích luỹ
  // A-09: đơn lập offline gửi kèm thời điểm bán gốc, ca và giá đã hiển thị cho khách
  soldAt: z.string().datetime({ offset: true }).optional(),
  shiftId: z.number().int().positive().optional(),
  priceSnapshot: z.array(z.object({ productId: z.number().int().positive(), unitPrice: z.number().int().min(0).max(MAX_VND) })).max(200).optional(), // VND / đơn vị chính
  // A-29: người tự duyệt (quản lý/chủ) bán dưới vốn hoặc giảm sâu phải ghi lý do
  overrideReason: z.string().trim().min(3).max(300).optional(),
  // POS-KV B2: thu khác (phí đóng gói, giỏ quà...) cộng vào tổng đơn
  charges: z.array(chargeInputSchema).max(MAX_CHARGES).optional(),
  // POS-KV B1: phần ghi nợ khách lẻ — phải bằng đúng tổng đơn − Σ payments
  credit: z.object({ amount: z.number().int().positive().max(MAX_VND) }).optional(),
});

/** Người có thể là "người bán": tài khoản đang hoạt động có quyền pos.sell hoặc có hồ sơ nhân viên đang làm. */
const SELLER_ROLES = (Object.keys(ROLE_PERMS) as (keyof typeof ROLE_PERMS)[]).filter((r) => ROLE_PERMS[r].has("pos.sell"));
async function listSellers(db: D1Database) {
  const marks = SELLER_ROLES.map(() => "?").join(",");
  return (
    await db
      .prepare(
        `SELECT u.id, u.full_name AS name FROM users u
          WHERE u.active = 1 AND (u.role IN (${marks}) OR EXISTS (SELECT 1 FROM employees e WHERE e.user_id = u.id AND e.status = 'active'))
          ORDER BY u.full_name, u.id`,
      )
      .bind(...SELLER_ROLES)
      .all<{ id: number; name: string }>()
  ).results;
}
async function assertSeller(db: D1Database, sellerId: number) {
  if (!(await listSellers(db)).some((s) => s.id === sellerId)) throw new AppError(422, "invalid_seller", "Người bán không hợp lệ");
}

/** Số lần sửa thông tin (người bán/ghi chú) của đơn — dùng làm `version` chống sửa đồng thời, không cần cột riêng. */
const metaVersionSql = `(SELECT COUNT(*) FROM audit_log WHERE action = 'order.meta' AND entity = 'order' AND entity_id = ?)`  /* bind chuỗi: D1 có thể bind số nguyên thành REAL */;

export async function getOrderFull(c: Ctx, orderId: number) {
  const db = c.env.DB;
  const role = c.get("user").role;
  const o = await db
    .prepare(
      `SELECT o.*, cu.name AS customer_name, cu.phone AS customer_phone, u.full_name AS cashier_name, sl.full_name AS seller_name
         FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN users u ON u.id = o.created_by LEFT JOIN users sl ON sl.id = o.seller_id WHERE o.id = ?`,
    )
    .bind(orderId)
    .first<any>();
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  const metaVersion = (await db.prepare(`SELECT ${metaVersionSql} AS v`).bind(String(orderId)).first<{ v: number }>())?.v ?? 0;
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
  const charges = (await db.prepare(`SELECT id, charge_type_id, name, amount, refunded_amount FROM order_charges WHERE order_id = ? ORDER BY id`).bind(orderId).all()).results;
  const credit = o.kind === "sale" && o.channel === "pos" ? await creditReceiptInfo(db, orderId) : null;
  const canCost = can(role, "prices.view_cost");
  const { customer_phone, cost_total, receiver_phone, ship_address, ...rest } = o;
  const pii = can(role, "customers.view_pii");
  // A-13: liên kết đơn đổi hàng (đơn bán mới ↔ đơn gốc ↔ phiếu trả cùng lần đổi)
  const exchange = o.exchange_of_order_id
    ? await db.prepare(`SELECT id, code FROM orders WHERE id = ?`).bind(o.exchange_of_order_id).first<{ id: number; code: string }>()
    : o.kind === "return"
      ? await db.prepare(`SELECT id, code FROM orders WHERE exchange_return_order_id = ?`).bind(orderId).first<{ id: number; code: string }>()
      : null;
  // Sửa hoá đơn: đơn mới ↔ đơn cũ đã được thay thế
  const corrOf = o.corrected_from_order_id
    ? await db.prepare(`SELECT id, code FROM orders WHERE id = ?`).bind(o.corrected_from_order_id).first<{ id: number; code: string }>()
    : o.kind === "sale"
      ? await db.prepare(`SELECT id, code FROM orders WHERE corrected_from_order_id = ? AND status <> 'cancelled'`).bind(orderId).first<{ id: number; code: string }>()
      : null;
  return {
    ...rest,
    correction: corrOf ? { role: o.corrected_from_order_id ? "replacement" : "replaced", linkedId: corrOf.id, linkedCode: corrOf.code } : null,
    // C2-01: SĐT / địa chỉ người nhận che như danh sách khi thiếu customers.view_pii
    receiver_phone: maskPhone(receiver_phone, role),
    ship_address: pii || !ship_address ? ship_address : "***",
    metaVersion,
    exchange: exchange ? { role: o.exchange_of_order_id ? "new_sale" : "return", linkedId: exchange.id, linkedCode: exchange.code } : null,
    ...(canCost ? { cost_total } : {}),
    customer: o.customer_id ? { id: o.customer_id, name: o.customer_name, phone: maskPhone(customer_phone, role) } : null,
    lines: lines.map((l) => {
      const { cost_amount, ...r } = l;
      return { ...(canCost ? { cost_amount } : {}), ...r, lots: lots.filter((x) => x.order_line_id === l.id).map((x) => (canCost ? x : { ...x, unit_cost: undefined })) };
    }),
    payments,
    discounts,
    charges,
    credit,
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
  if (body.sellerId && body.sellerId !== user.id) await assertSeller(db, body.sellerId);
  const sellerId = body.sellerId && body.sellerId !== user.id ? body.sellerId : null;

  // A-09: đơn offline — dùng thời điểm bán gốc (trong giới hạn), kiểm kỳ khoá sổ; ca gốc đã chốt thì ghi vào ca đang mở và lưu vết
  let soldAt: string | null = null;
  if (body.soldAt) {
    const t = Date.parse(body.soldAt);
    const nowMs = Date.now();
    const maxHours = await getSettingInt(db, "pos.offline_max_age_hours", 48);
    if (t < nowMs - maxHours * 3600_000) throw new AppError(422, "offline_too_old", `Đơn bán offline quá ${maxHours} giờ, không đồng bộ tự động được — báo quản lý xử lý`, { soldAt: body.soldAt, maxHours });
    soldAt = new Date(Math.min(t, nowMs)).toISOString(); // không ghi giờ bán ở tương lai
    if (vnDate(new Date(soldAt)) !== vnDate()) await assertPeriodOpen(db, soldAt, "đơn bán offline");
  }
  const priceSnap = soldAt ? new Map((body.priceSnapshot ?? []).map((x) => [x.productId, x.unitPrice])) : new Map<number, number>();
  const tolBp = soldAt ? await getSettingInt(db, "pos.offline_price_tolerance_bp", 1000) : 0;
  const snapUsed: number[] = [];

  // khách hàng → nhóm giá
  let customer: { id: number; customer_group_id: number | null; type: string; name: string; phone: string | null; credit_limit: number; payment_terms_days: number } | null = null;
  if (body.customerId) {
    customer = await db.prepare(`SELECT id, customer_group_id, type, name, phone, credit_limit, payment_terms_days FROM customers WHERE id = ? AND active = 1`).bind(body.customerId).first<any>();
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
    // A-22: truyền customerId để áp bảng giá riêng của khách; A-09: giá tại thời điểm bán gốc
    const resolved = await resolvePrice(db, l.productId, { channel: "pos", customerGroupId: customer?.customer_group_id, customerId: customer?.id, at: soldAt ?? undefined });
    let unitPrice = l.unitPriceOverride ?? resolved.unitPrice;
    let listUnit = resolved.unitPrice;
    const snap = priceSnap.get(l.productId);
    if (snap != null && l.unitPriceOverride == null && snap !== resolved.unitPrice) {
      // A-09: khách đã trả theo giá hiển thị lúc offline; chấp nhận nếu lệch bảng giá lúc bán trong ngưỡng
      if (Math.abs(snap - resolved.unitPrice) * 10000 > resolved.unitPrice * tolBp)
        throw conflict("offline_price_changed", "Giá đã hiển thị khi offline lệch bảng giá quá ngưỡng cho phép — báo quản lý xử lý", { productId: l.productId, snapshot: snap, current: resolved.unitPrice });
      unitPrice = snap;
      listUnit = snap;
      snapUsed.push(l.productId);
    }
    const gross = lineAmount(unitPrice, qtyMilli);
    const lineDiscount = Math.min(l.discount ?? 0, gross);
    items.push({
      productId: l.productId, unit: l.unit, qtyMilli, unitPrice, listPrice: listUnit, priceListId: resolved.priceListId,
      gross, lineDiscount, discount: lineDiscount, lineTotal: gross - lineDiscount, listGross: lineAmount(listUnit, qtyMilli), promoDiscount: 0,
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
    at: soldAt ?? undefined,
    strict: true,
  });
  items.forEach((it, i) => {
    it.promoDiscount = promoPlan.lineDiscounts[i];
    it.discount += it.promoDiscount;
    it.lineTotal -= it.promoDiscount;
  });
  const subtotal = items.reduce((s, i) => s + i.gross, 0);
  const totalDiscount = items.reduce((s, i) => s + i.discount, 0);
  // B2: thu khác cộng sau khi đã tính khuyến mãi — không bị giảm giá / voucher / điểm, không tích điểm
  const charges = await resolveCharges(db, user.role, body.charges);
  const chargesTotal = charges.reduce((s, ch) => s + ch.amount, 0);
  const goodsTotal = subtotal - totalDiscount;
  const total = goodsTotal + chargesTotal;

  // Thanh toán
  const paid = body.payments.reduce((s, p) => s + p.amount, 0);
  // B1: bán nợ khách lẻ
  const creditAmount = body.credit?.amount ?? 0;
  const creditCfg = await creditSettings(db);
  let overLimit = false;
  let outstandingNow = 0; // dư nợ lúc xin duyệt — ghi vào phiếu duyệt để phiếu không còn hiệu lực khi dư nợ tăng thêm (PA-2)
  if (body.credit) {
    if (soldAt) throw new AppError(422, "credit_offline_not_allowed", "Đơn lập khi offline không được ghi nợ (không kiểm được hạn mức)");
    if (!creditCfg.enabled) throw conflict("credit_disabled", "Chưa bật bán nợ khách lẻ (Cài đặt → Công nợ)");
    if (!customer || customer.type !== "retail" || !customer.phone) throw new AppError(422, "credit_needs_customer", "Ghi nợ cần gắn khách lẻ có số điện thoại");
    if (creditAmount + paid !== total) throw new AppError(422, "credit_mismatch", "Số ghi nợ phải bằng đúng tổng đơn trừ các khoản đã thu", { total, paid, credit: creditAmount });
    const outstanding = await openDebtOf(db, customer.id);
    outstandingNow = outstanding;
    // Hạn mức 0 = khách chưa được bán nợ (chặn cứng). Vượt hạn mức > 0 → cần approval order.credit đã duyệt (kiểm ở plan(), guard trong batch cho vượt khi có duyệt)
    if (!(customer.credit_limit > 0))
      throw conflict("credit_limit_exceeded", "Khách chưa được đặt hạn mức nợ", { creditLimit: 0, outstanding, available: 0 });
    overLimit = outstanding + creditAmount > customer.credit_limit;
    await assertPeriodOpen(db, new Date(), "bán nợ");
  } else if (paid < total) throw new AppError(422, "payment_mismatch", "Tổng thanh toán chưa đủ tổng tiền đơn", { total, paid });
  const cashTotal = body.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const change = body.credit ? 0 : paid - total;
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

  // SePay: khi bật xác nhận QR tự động, thanh toán "QR" phải gắn với mã QR đã nhận đủ tiền (webhook), mỗi mã chỉ dùng một lần
  const qrUsed: { id: number; code: string; amount: number; eventId: number | null; hold: { i: number | null; o: number | null } }[] = [];
  const sepayCfg = await sepayConfig(db);
  if (sepayCfg.enabled && sepayCfg.flow.pos) {
    for (const p of recorded) {
      if (p.method !== "qr") continue;
      const q = p.qrRequestId
        ? await db
            .prepare(
              `SELECT r.id, r.amount, r.status, r.user_id, r.order_id, r.event_id, pc.code, e.hold_in_voucher_id AS hold_i, e.hold_out_voucher_id AS hold_o
                 FROM pos_qr_requests r JOIN pay_codes pc ON pc.kind = 'pos' AND pc.ref_id = r.id LEFT JOIN sepay_events e ON e.id = r.event_id WHERE r.id = ?`,
            )
            .bind(p.qrRequestId)
            .first<any>()
        : null;
      if (!q || q.status !== "paid" || q.user_id !== user.id || q.order_id || q.amount !== p.amount || qrUsed.some((x) => x.id === q.id))
        throw new AppError(422, "qr_not_confirmed", "Mã QR chưa nhận được tiền (hoặc đã dùng / sai số tiền). Hiện mã QR và chờ báo đã nhận tiền.", { qrRequestId: p.qrRequestId ?? null });
      qrUsed.push({ id: q.id, code: q.code, amount: q.amount, eventId: q.event_id ?? null, hold: { i: q.hold_i ?? null, o: q.hold_o ?? null } });
      p.ref = q.code;
    }
  }

  // Bước B: phân bổ FEFO + kiểm tra duyệt (có thể chạy lại 1 lần khi tồn đổi — EC-02)
  const discountBp = await getSettingInt(db, "approval.discount_pct_bp", 1000);
  let approvalUsed: number | null = null;
  let overrideReasons: string[] = [];
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
    overrideReasons = [];
    // B1: ghi nợ vượt ngưỡng approval.pos_credit_vnd mà người bán không có pos.credit → cần quản lý duyệt (cùng luồng duyệt POS)
    const needCreditApproval = creditAmount > creditCfg.approvalVnd && !can(user.role, "pos.credit") && !can(user.role, "approvals.decide");
    const allReasons = needCreditApproval || overLimit ? [...reasons, ...(overLimit ? ["credit_limit"] : ["credit"])] : reasons;
    // vượt hạn mức luôn cần phiếu duyệt (kể cả quản lý/chủ — không tự bỏ qua)
    if (allReasons.length && (overLimit || !can(user.role, "approvals.decide"))) {
      approvalUsed = await requireDiscountApproval(c, body.clientUuid, body.approvalId, allReasons, { total, discountValue: discValue, ...(creditAmount ? { creditAmount, outstanding: outstandingNow, creditLimit: customer?.credit_limit ?? 0 } : {}) }, await cartHash(body));
    } else if (reasons.length) {
      // A-29: người có quyền tự duyệt không cần phiếu, nhưng phải ghi lý do (audit)
      if (!body.overrideReason) throw new AppError(422, "override_reason_required", "Bán dưới giá vốn hoặc giảm giá vượt ngưỡng cần nhập lý do", { reasons });
      overrideReasons = reasons;
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
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, shift_id, customer_id, status, note, created_by, seller_id)
         VALUES (?,?,?,?,?,?,?,'draft',?,?,?)`,
      )
      .bind(code, body.clientUuid, "pos", "sale", storeId, shift.id, body.customerId ?? null, body.note ?? null, user.id, sellerId)
      .run();
    orderId = r.meta.last_row_id as number;
  } catch (e) {
    const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number }>();
    if (again) return orderDone(again.id, 200);
    throw e;
  }

  const cancelDraft = () => db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(orderId).run();

  const promoStmts = await promoStatements(db, { sql: "?", bind: orderId }, { plan: promoPlan, customerId: customer?.id ?? null, payableTotal: goodsTotal, userId: user.id });
  const creditInvCode = body.credit ? await nextCode(db, "HDB") : null;

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
    const stmts: D1PreparedStatement[] = [
      // Ca phải CÒN MỞ lúc ghi (chốt ca chạy song song → đơn không rơi ra ngoài mọi ca / ngoài tiền mặt dự kiến)
      assertStmt(db, "pos.shift_open", `SELECT status = 'open' FROM shifts WHERE id = ?`, [shift.id]),
    ];
    // B1: chốt chặn hạn mức đặt ĐẦU batch — hai quầy ghi nợ đồng thời chỉ một quầy qua (quầy kia 409)
    if (body.credit && customer) {
      const g = creditLimitGuard(customer.id, creditAmount, overLimit && approvalUsed != null ? approvalUsed : null);
      stmts.push(assertStmt(db, "pos.credit_limit", g.sql, g.binds));
      if (overLimit && approvalUsed) stmts.push(onceStmt(db, "pos.credit_limit_approval", approvalUsed)); // phiếu duyệt vượt hạn mức dùng một lần
    }
    items.forEach((_, i) => {
      for (const a of p.lineAllocs[i]) {
        stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(lineIds[i], a.lotId, a.qtyMilli, a.unitCost));
      }
    });
    for (const [pid, alloc] of p.productAllocs) stmts.push(...moveStatements(db, pid, alloc, -1, "sale", "order", orderId, user.id));
    stmts.push(...promoStmts);
    for (const u of qrUsed) {
      stmts.push(
        assertStmt(db, "pos.qr_use", `SELECT status = 'paid' AND order_id IS NULL FROM pos_qr_requests WHERE id = ?`, [u.id]),
        db.prepare(`UPDATE pos_qr_requests SET status = 'used', order_id = ? WHERE id = ? AND status = 'paid'`).bind(orderId, u.id),
      );
      // Tiền QR đang ở khoản chờ xử lý → chuyển ra cùng batch với payments của đơn (không cộng quỹ hai lần)
      if (u.eventId)
        stmts.push(...(await holdOutStmts(db, { id: u.eventId, amount: u.amount, txn_at: null, code: u.code, reference_code: null }, { userId: user.id, state: u.hold, note: `Dùng QR ${u.code} hoàn tất đơn ${code}` })).stmts);
    }
    for (const pay of recorded) {
      if (pay.amount <= 0) continue;
      stmts.push(
        db
          .prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`)
          .bind(orderId, pay.method, pay.amount, payFunds.get(pay.method)!, pay.ref ?? null),
      );
    }
    stmts.push(...chargeStmts(db, orderId, charges));
    if (body.credit && customer && creditInvCode) {
      stmts.push(
        db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'credit', ?, NULL, 'confirmed')`).bind(orderId, creditAmount),
        creditInvoiceStmt(db, {
          code: creditInvCode, orderId, customerId: customer.id, customerName: customer.name, amount: creditAmount,
          termsDays: creditTermsDays(customer.payment_terms_days, creditCfg.defaultTermsDays), userId: user.id,
        }),
      );
    }
    stmts.push(
      db
        .prepare(
          `UPDATE orders SET status='completed', subtotal=?, discount=?, total=?, cost_total=?, paid_total=?, charges_total=?, completed_at=COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            WHERE id=? AND status='draft'`,
        )
        .bind(subtotal, totalDiscount, total, costTotal, total - creditAmount, chargesTotal, soldAt, orderId),
    );
    if (approvalUsed) stmts.push(db.prepare(`UPDATE approvals SET ref_type='order', ref_id=? WHERE id=?`).bind(String(orderId), approvalUsed));
    if (overrideReasons.length)
      stmts.push(auditStmt(c, { action: "order.self_approve", entity: "order", entityId: orderId, after: { reasons: overrideReasons, total }, reason: body.overrideReason }));
    stmts.push(
      auditStmt(c, {
        action: "order.checkout",
        entity: "order",
        entityId: orderId,
        after: { code, total, discount: totalDiscount, change, lines: items.length, approvalId: approvalUsed, voucher: promoPlan.voucher?.code ?? null, pointsRedeemed: promoPlan.points,
          ...(chargesTotal ? { charges: charges.map((x) => ({ name: x.name, amount: x.amount })) } : {}),
          ...(body.credit ? { credit: { amount: creditAmount, customerId: customer!.id, invoice: creditInvCode } } : {}),
          ...(soldAt ? { offline: { soldAt, requestedShiftId: body.shiftId ?? null, shiftId: shift.id, snapshotProducts: snapUsed } } : {}) },
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
    if (/state_changed/.test(String((e as Error)?.message)) && !(await db.prepare(`SELECT 1 AS x FROM shifts WHERE id = ? AND status = 'open'`).bind(shift.id).first()))
      throw conflict("shift_closed", "Ca bán hàng vừa được chốt — mở ca mới để bán");
    if (body.credit && customer && /state_changed/.test(String((e as Error)?.message))) {
      const outstanding = await openDebtOf(db, customer.id);
      if (outstanding + creditAmount > customer.credit_limit) throw conflict("credit_limit_exceeded", "Vượt hạn mức nợ của khách (vừa có đơn nợ khác)", { creditLimit: customer.credit_limit, outstanding, available: Math.max(0, customer.credit_limit - outstanding) });
    }
    if (isVoucherExhausted(e)) throw conflict("voucher_exhausted", "Voucher đã hết lượt sử dụng");
    if (isPointsInsufficient(e)) throw conflict("points_insufficient", "Khách không đủ điểm để đổi");
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  return orderDone(orderId, 201, change, { promotions: { rejected: promoPlan.rejected } });
});

/** Băm giỏ hàng checkout (phiếu duyệt gắn với đúng giỏ); logic duyệt dùng chung ở services/discount-approval.ts. */
function cartHash(body: z.infer<typeof checkoutSchema>) {
  return cartHashOf({
    l: body.lines.map((l) => [l.productId, l.unit, l.qty, l.unitPriceOverride ?? null, l.discount ?? 0]),
    d: body.discount ?? 0,
    v: body.voucherCode ?? null,
    r: body.redeemPoints ?? 0,
    // B1/B2: chỉ đưa vào băm khi có — yêu cầu duyệt cũ (chưa có tính năng này) vẫn khớp
    ...(body.credit ? { cr: body.credit.amount, cu: body.customerId ?? null } : {}),
    ...(body.charges?.length ? { ch: body.charges.map((x) => [x.chargeTypeId ?? null, x.name ?? null, x.amount]) } : {}),
  });
}

// ===================== Danh sách / chi tiết / hoá đơn =====================

posRoutes.get("/orders", requirePerm("orders.view"), async (c) => {
  const q = c.req.query();
  const role = c.get("user").role;
  const pii = can(role, "customers.view_pii");
  // Bộ lọc dùng chung với xuất file chi tiết dòng hàng (services/order-filter.ts)
  const { where, params } = buildOrderFilter(q, pii);
  const join = `FROM orders o LEFT JOIN users u ON u.id = o.created_by LEFT JOIN users sl ON sl.id = o.seller_id LEFT JOIN customers cu ON cu.id = o.customer_id`;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const cursorCond = q.cursor ? `${where ? where + " AND" : "WHERE"} o.id < ?` : where;
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT o.id, o.code, o.channel, o.kind, o.status, o.total, o.discount, o.paid_total, o.shift_id, o.customer_id, o.original_order_id, o.exchange_of_order_id, o.exchange_return_order_id, o.corrected_from_order_id,
                o.created_at, o.completed_at, o.created_by AS cashier_id, u.full_name AS cashier_name,
                COALESCE(o.seller_id, o.created_by) AS seller_id, COALESCE(sl.full_name, u.full_name) AS seller_name, o.note,
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

/** Danh sách người bán chọn được ở POS và màn Đơn hàng — chỉ id và tên. */
posRoutes.get("/pos/sellers", requirePerm("pos.sell"), async (c) => c.json({ items: await listSellers(c.env.DB) }));

// ===================== Sửa thông tin đơn (người bán, ghi chú) — A4 =====================

const metaFields = {
  sellerId: z.number().int().positive().nullable().optional(), // null = trả về người lập đơn
  note: z.string().trim().max(500).nullable().optional(),
};
const metaPatchSchema = z.object({ ...metaFields, version: z.number().int().min(0).optional() }).refine((b) => b.sellerId !== undefined || b.note !== undefined, { message: "Cần sellerId hoặc note" });
const metaBulkSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100), ...metaFields }).refine((b) => b.sellerId !== undefined || b.note !== undefined, { message: "Cần sellerId hoặc note" });

/** Kỳ lương (theo giờ VN) chứa ngày hoàn tất đơn — cơ sở hoa hồng / thưởng doanh số của người bán. */
const payrollPeriodOf = (o: { completed_at?: string | null; created_at: string }) => vnPeriod(new Date(o.completed_at ?? o.created_at));

/** C2-06: đổi người bán làm dịch doanh số/hoa hồng giữa các người → không cho khi kỳ lương chứa ngày hoàn tất đã duyệt/đã chi (kỳ mới tính chưa duyệt vẫn cho; hash đầu vào báo payroll_stale). */
async function assertPayrollOpenForSeller(db: D1Database, o: any, patch: { sellerId?: number | null }) {
  if (patch.sellerId === undefined) return;
  const next = patch.sellerId === o.created_by ? null : patch.sellerId;
  if (next === (o.seller_id ?? null)) return;
  const locked = await db.prepare(`SELECT 1 AS x FROM payroll_periods WHERE period = ? AND status IN ('approved','paid')`).bind(payrollPeriodOf(o)).first();
  if (locked) throw conflict("payroll_locked", `Kỳ lương của đơn ${o.code} đã duyệt/đã chi — không đổi người bán được (dùng điều chỉnh lương kỳ sau)`, { orderId: o.id });
}

/** Câu lệnh sửa một đơn: kiểm tra còn là đơn bán, (tuỳ chọn) đúng version, cập nhật, ghi audit. Không đụng tiền/hàng. */
function metaStatements(c: Ctx, o: any, patch: { sellerId?: number | null; note?: string | null }, version?: number) {
  const db = c.env.DB;
  const nextSeller = patch.sellerId === undefined ? o.seller_id : patch.sellerId === o.created_by ? null : patch.sellerId;
  const nextNote = patch.note === undefined ? o.note : patch.note ? patch.note : null;
  const sellerChanged = nextSeller !== (o.seller_id ?? null);
  const stmts = [
    ...(sellerChanged ? [assertStmt(db, "order.meta.payroll", `SELECT NOT EXISTS (SELECT 1 FROM payroll_periods WHERE period = ? AND status IN ('approved','paid'))`, [payrollPeriodOf(o)])] : []),
    assertStmt(db, "order.meta", `SELECT kind = 'sale' AND status <> 'draft' AND ${version === undefined ? "1" : `${metaVersionSql} = ?`} FROM orders WHERE id = ?`, version === undefined ? [o.id] : [String(o.id), version, o.id]),
    db.prepare(`UPDATE orders SET seller_id = ?, note = ? WHERE id = ?`).bind(nextSeller, nextNote, o.id),
    auditStmt(c, { action: "order.meta", entity: "order", entityId: o.id, before: { sellerId: o.seller_id, note: o.note }, after: { sellerId: nextSeller, note: nextNote } }),
  ];
  return stmts;
}

async function loadMetaOrder(db: D1Database, id: number) {
  const o = await db.prepare(`SELECT id, code, kind, status, seller_id, created_by, note, created_at, completed_at FROM orders WHERE id = ?`).bind(id).first<any>();
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (o.kind !== "sale" || o.status === "draft") throw new AppError(422, "not_editable", `Chỉ sửa thông tin được với đơn bán (${o.code})`, { orderId: id });
  await assertPeriodOpen(db, o.created_at, "thay đổi đơn hàng");
  return o;
}

posRoutes.patch("/orders/:id/meta", requirePerm("orders.edit"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, metaPatchSchema);
  const db = c.env.DB;
  if (!Number.isInteger(id) || id <= 0) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  const o = await loadMetaOrder(db, id);
  if (body.sellerId) await assertSeller(db, body.sellerId);
  await assertPayrollOpenForSeller(db, o, body);
  await db.batch(metaStatements(c, o, body, body.version));
  return c.json(await getOrderFull(c, id));
});

posRoutes.post("/orders/meta/bulk", requirePerm("orders.edit"), async (c) => {
  const body = await parseBody(c, metaBulkSchema);
  const db = c.env.DB;
  const ids = [...new Set(body.ids)];
  if (body.sellerId) await assertSeller(db, body.sellerId);
  const orders = [];
  for (const id of ids) orders.push(await loadMetaOrder(db, id));
  for (const o of orders) await assertPayrollOpenForSeller(db, o, body);
  await db.batch(orders.flatMap((o) => metaStatements(c, o, body)));
  return c.json({ updated: ids.length, ids });
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
    charges: o.charges.map((x: any) => ({ name: x.name, amount: x.amount })),
    credit: o.credit,
    payments: o.payments.map((p: any) => ({ method: p.method, amount: p.amount, ref: p.ref })),
    note: o.note,
  });
});

// ===================== Trả hàng (EC-01) =====================

export const returnLineSchema = z.object({
  orderLineId: z.number().int().positive(),
  qty: z.number().positive().max(MAX_QTY),
  unit: z.string().min(1),
  restock: z.boolean(),
  reason: z.string().trim().min(2).max(300),
});

const returnSchema = z.object({
  lines: z.array(returnLineSchema).min(1).max(200),
  refundMethod: z.enum(METHODS),
  approvalId: z.number().int().positive().optional(), // A-16: mã duyệt của quản lý (trả hàng cần duyệt)
  // B2: trả TOÀN BỘ đơn thì được chọn hoàn cả thu khác (bắt buộc lý do); mặc định không hoàn
  refundCharges: z.boolean().optional(),
  chargesReason: z.string().trim().min(3).max(300).optional(),
});

/** B2: số thu khác hoàn lại khi trả hàng. Mặc định 0; chỉ hoàn khi người dùng chọn VÀ lần trả này làm đơn được trả hết, kèm lý do. */
async function chargesRefundOf(db: D1Database, origId: number, claimed: Map<number, number>, body: { refundCharges?: boolean; chargesReason?: string }) {
  if (!body.refundCharges) return 0;
  if (!body.chargesReason) throw new AppError(422, "charges_reason_required", "Hoàn thu khác cần nhập lý do");
  const lines = (await db.prepare(`SELECT id, qty_milli FROM order_lines WHERE order_id = ?`).bind(origId).all<{ id: number; qty_milli: number }>()).results;
  for (const l of lines) {
    const prev = (
      await db
        .prepare(`SELECT COALESCE(SUM(r.qty_milli),0) AS q FROM order_lines r JOIN orders ro ON ro.id = r.order_id WHERE r.original_line_id = ? AND ro.kind='return' AND ro.status='completed'`)
        .bind(l.id)
        .first<{ q: number }>()
    )?.q ?? 0;
    if (prev + (claimed.get(l.id) ?? 0) < l.qty_milli) throw new AppError(422, "charges_refund_partial", "Chỉ hoàn thu khác khi trả toàn bộ đơn");
  }
  const left = (await db.prepare(`SELECT COALESCE(SUM(amount - refunded_amount),0) AS s FROM order_charges WHERE order_id = ?`).bind(origId).first<{ s: number }>())?.s ?? 0;
  return left;
}

export type PreparedReturn = { orig: any; qtyMilli: number; lineTotal: number; cost: number; alloc: LotAllocation[]; restock: boolean; reason: string };

/** Tính các dòng trả: quy đổi đơn vị, kiểm số đã trả, đi qua lô gốc, chia tiền theo dòng gốc. Dùng chung cho Trả hàng và Đổi hàng (A-13). */
export async function prepareReturnLines(db: D1Database, origId: number, lines: z.infer<typeof returnLineSchema>[]) {
  const prepared: PreparedReturn[] = [];
  const claimed = new Map<number, number>();
  for (const l of lines) {
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
  return {
    prepared,
    claimed,
    total: prepared.reduce((s, x) => s + x.lineTotal, 0),
    costTotal: prepared.reduce((s, x) => s + x.cost, 0),
  };
}

/** A-16 (M1-09): lý do cần quản lý duyệt khi thu ngân trả/đổi hàng. Rỗng = thu ngân tự làm được. */
export async function returnApprovalReasons(db: D1Database, orig: any, shift: any, prepared: PreparedReturn[], total: number): Promise<string[]> {
  const reasons: string[] = [];
  if (!(shift && orig.shift_id === shift.id)) {
    const osh = orig.shift_id ? await db.prepare(`SELECT status FROM shifts WHERE id = ?`).bind(orig.shift_id).first<{ status: string }>() : null;
    const sameDay = vnDate(new Date(orig.completed_at ?? orig.created_at)) === vnDate();
    if (!(sameDay && osh?.status === "open")) reasons.push("other_shift");
  }
  const threshold = await getSettingInt(db, "approval.pos_return_vnd", 500000);
  if (total >= threshold) reasons.push("high_value");
  if (prepared.some((x) => !x.restock)) reasons.push("no_restock");
  return reasons;
}

/** Chốt chặn trong batch (audit #2): trả đồng thời không được vượt số đã bán / số đã thu. */
export function returnGuardStmts(db: D1Database, origId: number, approvalUsed: number | null, claimed: Map<number, number>, total: number): D1PreparedStatement[] {
  return [
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
}

export async function insertReturnLines(db: D1Database, retId: number, prepared: PreparedReturn[]) {
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
  return lineIds;
}

/** Thu hồi điểm + nhập lại đúng lô cho các dòng được chọn "nhập lại kho". */
export async function returnEffectStmts(db: D1Database, orig: any, origId: number, retId: number, code: string, prepared: PreparedReturn[], lineIds: number[], total: number, userId: number) {
  const stmts: D1PreparedStatement[] = [];
  // Đợt 4: thu hồi điểm tích / hoàn điểm đã đổi / hoàn lượt voucher
  const priorRet = (
    await db.prepare(`SELECT COALESCE(SUM(total - charges_total),0) AS t FROM orders WHERE original_order_id = ? AND kind='return' AND status='completed'`).bind(origId).first<{ t: number }>()
  )?.t ?? 0;
  // B2: so sánh theo giá trị HÀNG (thu khác không tích điểm/không áp voucher) → trả hết hàng vẫn hoàn điểm đã đổi / lượt voucher
  stmts.push(...(await reversalStatements(db, { ...orig, total: orig.total - (orig.charges_total ?? 0) }, priorRet + total, userId, `trả hàng ${code}`)));
  prepared.forEach((x, i) => {
    if (!x.restock) return;
    for (const a of x.alloc) stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(lineIds[i], a.lotId, a.qtyMilli, a.unitCost));
    stmts.push(...moveStatements(db, x.orig.product_id, x.alloc, 1, "return", "order", retId, userId));
  });
  return stmts;
}

posRoutes.post("/orders/:id/return", requirePerm("pos.return"), async (c) => {
  const origId = Number(c.req.param("id"));
  const body = await parseBody(c, returnSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const orig = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(origId).first<any>();
  if (!orig) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (orig.kind !== "sale" || orig.status !== "completed") throw conflict("not_returnable", "Chỉ trả hàng cho đơn bán đã hoàn tất");
  const shift = await openShiftOf(db, user.id);

  const { prepared, claimed, total: linesTotal, costTotal } = await prepareReturnLines(db, origId, body.lines);
  const chargesRefund = await chargesRefundOf(db, origId, claimed, body);
  const total = linesTotal + chargesRefund; // tổng giá trị phiếu trả (hàng + thu khác được hoàn) — cũng là cơ sở của ngưỡng duyệt (PA-6)
  // B1: đơn có ghi nợ → giá trị trả trừ vào nợ còn lại của hoá đơn trước, phần vượt mới hoàn tiền
  const credInv = orig.channel === "pos" ? await creditInvoiceOf(db, origId) : null;
  const debtReduction = credInv && credInv.os > 0 ? Math.min(total, credInv.os) : 0;
  const cashRefund = total - debtReduction;
  if (cashRefund > 0 && body.refundMethod === "cash" && !shift) throw conflict("no_open_shift", "Cần mở ca để hoàn tiền mặt");
  if (debtReduction > 0) await assertPeriodOpen(db, new Date(), "trả hàng đơn ghi nợ");

  // A-16 (M1-09): thu ngân chỉ tự trả hàng đơn của CA ĐANG MỞ (hoặc cùng ngày VN của ca còn mở), dưới ngưỡng giá trị, có nhập lại kho.
  // Còn lại cần quản lý (approvals.decide) tự làm hoặc duyệt qua approvals (gắn băm yêu cầu trả như duyệt giảm giá POS).
  let approvalUsed: number | null = null;
  if (!can(user.role, "approvals.decide")) {
    const reasons = await returnApprovalReasons(db, orig, shift, prepared, total);
    if (reasons.length) approvalUsed = await requireReturnApproval(c, origId, body, reasons, total);
  }
  const fundId = cashRefund > 0 ? await fundFor(db, orig.store_id, body.refundMethod, shift) : null;
  const code = await nextCode(db, PREFIX.return);
  const adjCode = debtReduction > 0 ? await nextCode(db, "HDB") : null;
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
    const lineIds = await insertReturnLines(db, retId, prepared);
    const stmts: D1PreparedStatement[] = [
      ...returnGuardStmts(db, origId, approvalUsed, claimed, total),
      ...(await returnEffectStmts(db, orig, origId, retId, code, prepared, lineIds, linesTotal, user.id)),
    ];
    if (chargesRefund > 0)
      stmts.push(
        assertStmt(db, "order.return.charges", `SELECT COALESCE(SUM(amount - refunded_amount),0) = ? FROM order_charges WHERE order_id = ?`, [chargesRefund, origId]),
        db.prepare(`UPDATE order_charges SET refunded_amount = amount WHERE order_id = ?`).bind(origId),
      );
    if (cashRefund > 0) {
      stmts.push(db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?,?,?,?, 'confirmed')`).bind(retId, body.refundMethod, -cashRefund, fundId));
    }
    if (debtReduction > 0 && credInv && adjCode) {
      const g = `SELECT ${INVOICE_OUTSTANDING_SQL} >= ? FROM invoices i WHERE i.id = ?`;
      stmts.push(
        assertStmt(db, "order.return.debt", g, [debtReduction, credInv.id]),
        db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'credit', ?, NULL, 'confirmed')`).bind(retId, -debtReduction),
        creditAdjustmentStmt(db, { code: adjCode, original: { id: credInv.id, due_date: credInv.due_date }, orderId: retId, customerId: credInv.customer_id, customerName: null, amount: debtReduction, userId: user.id, note: `Trả hàng ${code} trừ vào nợ` }),
      );
    }
    stmts.push(
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, total=?, cost_total=?, paid_total=?, charges_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(linesTotal, total, costTotal, cashRefund, chargesRefund, retId),
      ...(approvalUsed ? [db.prepare(`UPDATE approvals SET ref_type='order', ref_id=? WHERE id=? AND ref_id IS NULL`).bind(String(retId), approvalUsed)] : []),
      auditStmt(c, {
        action: "order.return",
        entity: "order",
        entityId: retId,
        after: { code, originalOrderId: origId, total, ...(chargesRefund ? { chargesRefund } : {}), ...(debtReduction ? { debtReduction, cashRefund } : {}), approvalId: approvalUsed, lines: prepared.map((x) => ({ orderLineId: x.orig.id, qtyMilli: x.qtyMilli, restock: x.restock, reason: x.reason })) },
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

// ===================== Đổi hàng (A-13, EC-10) =====================
// Một thao tác: trả một phần đơn cũ (phiếu kind='return', nhập lại đúng lô như Trả hàng) + bán hàng mới (đơn kind='sale' liên kết
// exchange_of_order_id) trong MỘT db.batch. Tiền bù trừ nội bộ bằng cặp dòng payments (-trả / +bán theo `refundMethod`), phần chênh thực thu/chi
// đi qua quỹ của CA ĐANG MỞ. Cùng quy tắc quyền/ngưỡng duyệt của Trả hàng (A-16). Ngoài phạm vi: tách đơn con; khuyến mãi/voucher/đổi điểm cho dòng mới.

const exchangeSchema = z.object({
  clientUuid: z.string().min(8).max(64),
  returnLines: z.array(returnLineSchema).min(1).max(200),
  newLines: z.array(z.object({ productId: z.number().int().positive(), unit: z.string().min(1).max(20), qty: z.number().positive().max(MAX_QTY) })).min(1).max(200),
  refundMethod: z.enum(METHODS).default("cash"), // phương thức bù trừ + hoàn phần chênh khi khách được nhận lại tiền
  payments: z.array(z.object({ method: z.enum(METHODS), amount: z.number().int().positive().max(MAX_VND), ref: z.string().max(100).optional() })).max(10).default([]), // khách trả thêm khi chênh > 0
  note: z.string().max(500).optional(),
  approvalId: z.number().int().positive().optional(),
});

posRoutes.post("/orders/:id/exchange", requirePerm("pos.return", "pos.sell"), async (c) => {
  const origId = Number(c.req.param("id"));
  const body = await parseBody(c, exchangeSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const done = async (saleId: number, status: 200 | 201, extra: object = {}) => {
    const sale = await getOrderFull(c, saleId);
    return c.json({ sale, return: sale.exchange_return_order_id ? await getOrderFull(c, sale.exchange_return_order_id) : null, ...extra }, status);
  };

  // Idempotent theo clientUuid (đặt trên đơn bán mới)
  let existing = await db.prepare(`SELECT id, status, created_at FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number; status: string; created_at: string }>();
  if (existing && existing.status === "draft" && Date.parse(existing.created_at) < Date.now() - 120_000) {
    await retireStaleDraft(db, existing.id);
    existing = null;
  }
  if (existing && existing.status !== "cancelled" && existing.status !== "draft") return done(existing.id, 200);
  if (existing) throw conflict("order_in_progress", "Đơn đang xử lý hoặc đã huỷ, vui lòng tạo đơn mới với clientUuid khác");

  const orig = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(origId).first<any>();
  if (!orig) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (orig.kind !== "sale" || orig.status !== "completed") throw conflict("not_returnable", "Chỉ đổi hàng cho đơn bán đã hoàn tất");
  if (orig.channel !== "pos") throw conflict("wrong_channel", "Đổi hàng tại quầy chỉ áp dụng cho đơn POS");
  if (await creditInvoiceOf(db, origId)) throw conflict("credit_order_no_exchange", "Đơn có ghi nợ không đổi hàng được — dùng Trả hàng (trừ vào nợ) rồi bán đơn mới");
  const shift = await openShiftOf(db, user.id);
  if (!shift) throw conflict("no_open_shift", "Cần mở ca để đổi hàng (tiền chênh lệch đi qua két của ca)");
  const storeId = shift.store_id as number;
  await assertPeriodOpen(db, new Date(), "đổi hàng");

  // 1) Phần trả
  const { prepared, claimed, total: returnTotal, costTotal: returnCost } = await prepareReturnLines(db, origId, body.returnLines);

  // 2) Phần bán mới (giá theo bảng giá hiện hành, nhóm giá của khách đơn gốc)
  const customer = orig.customer_id ? await db.prepare(`SELECT id, customer_group_id FROM customers WHERE id = ?`).bind(orig.customer_id).first<any>() : null;
  const items: { productId: number; unit: string; qtyMilli: number; unitPrice: number; priceListId: number; lineTotal: number }[] = [];
  for (const l of body.newLines) {
    const { factor } = await unitFactor(db, l.productId, l.unit);
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    const r = await resolvePrice(db, l.productId, { channel: "pos", customerGroupId: customer?.customer_group_id, customerId: customer?.id });
    items.push({ productId: l.productId, unit: l.unit, qtyMilli, unitPrice: r.unitPrice, priceListId: r.priceListId, lineTotal: lineAmount(r.unitPrice, qtyMilli) });
  }
  const newTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const net = newTotal - returnTotal; // > 0: khách trả thêm; < 0: hoàn lại khách

  // 3) Thanh toán phần chênh
  let recorded: { method: (typeof METHODS)[number]; amount: number; ref?: string }[] = [];
  let change = 0;
  if (net > 0) {
    const paid = body.payments.reduce((s, p) => s + p.amount, 0);
    if (paid < net) throw new AppError(422, "payment_mismatch", "Khách chưa trả đủ phần chênh lệch", { net, paid });
    const cashTotal = body.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
    change = paid - net;
    if (change > cashTotal) throw new AppError(422, "payment_mismatch", "Thanh toán vượt phần chênh lệch (chỉ tiền mặt được thối lại)", { net, paid });
    recorded = body.payments.map((p) => ({ ...p }));
    let toCut = change;
    for (let i = recorded.length - 1; i >= 0 && toCut > 0; i--) {
      if (recorded[i].method !== "cash") continue;
      const cut = Math.min(recorded[i].amount, toCut);
      recorded[i].amount -= cut;
      toCut -= cut;
    }
  } else if (body.payments.length) {
    throw new AppError(422, "payment_not_needed", "Không có phần chênh lệch khách phải trả, không nhập thanh toán", { net });
  }
  const payFunds = new Map<string, number>();
  for (const p of recorded) if (!payFunds.has(p.method)) payFunds.set(p.method, await fundFor(db, storeId, p.method, shift));
  const offsetFund = returnTotal > 0 || newTotal > 0 ? await fundFor(db, storeId, body.refundMethod, shift) : null;

  // 4) Quyền / ngưỡng duyệt như Trả hàng (A-16): đơn ca khác (đã chốt), giá trị trả ≥ ngưỡng, không nhập lại kho → cần quản lý
  let approvalUsed: number | null = null;
  if (!can(user.role, "approvals.decide")) {
    const reasons = await returnApprovalReasons(db, orig, shift, prepared, returnTotal);
    if (reasons.length) {
      const sig = [...body.newLines].map((l) => [l.productId, l.unit, l.qty]).sort((a, b) => Number(a[0]) - Number(b[0]) || String(a[1]).localeCompare(String(b[1])));
      approvalUsed = await requireReturnApproval(c, origId, { lines: body.returnLines, refundMethod: body.refundMethod, approvalId: body.approvalId }, reasons, returnTotal, sig);
    }
  }

  // 5) Phân bổ FEFO cho hàng mới (chạy lại 1 lần nếu tồn vừa đổi)
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
    if (items.some((it, i) => it.lineTotal < costs[i]) && !can(user.role, "approvals.decide"))
      throw new AppError(422, "exchange_below_cost", "Giá hàng mới thấp hơn giá vốn — nhờ quản lý thực hiện đổi hàng này");
    return { lineAllocs, productAllocs, costs };
  };
  let p = await plan();

  // 6) Hai chứng từ nháp (trả + bán mới), rồi MỘT batch hoàn tất
  const retCode = await nextCode(db, PREFIX.return);
  const saleCode = await nextCode(db, PREFIX.order);
  const note = (body.note ? body.note + " | " : "") + prepared.map((x) => `${x.orig.id}: ${x.reason}${x.restock ? "" : " (không nhập lại kho)"}`).join("; ");
  const retRes = await db
    .prepare(`INSERT INTO orders(code, channel, kind, original_order_id, store_id, shift_id, customer_id, status, note, created_by) VALUES (?,?,'return',?,?,?,?,'draft',?,?)`)
    .bind(retCode, orig.channel, origId, orig.store_id, shift.id, orig.customer_id, `Đổi hàng: ${note}`.slice(0, 500), user.id)
    .run();
  const retId = retRes.meta.last_row_id as number;
  let saleId: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, shift_id, customer_id, status, note, created_by, exchange_of_order_id, exchange_return_order_id)
         VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?)`,
      )
      .bind(saleCode, body.clientUuid, "pos", "sale", storeId, shift.id, orig.customer_id, `Đổi hàng từ đơn ${orig.code}`, user.id, origId, retId)
      .run();
    saleId = r.meta.last_row_id as number;
  } catch (e) {
    await db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(retId).run();
    const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number }>();
    if (again) return done(again.id, 200);
    throw e;
  }
  const cancelDrafts = () => db.prepare(`UPDATE orders SET status='cancelled' WHERE id IN (?,?) AND status='draft'`).bind(retId, saleId).run();

  const commit = async () => {
    await db.prepare(`DELETE FROM order_lines WHERE order_id IN (?,?)`).bind(retId, saleId).run();
    const retLineIds = await insertReturnLines(db, retId, prepared);
    const saleLineIds: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const row = await db
        .prepare(
          `INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, cost_amount) VALUES (?,?,?,?,?,?,0,?,?) RETURNING id`,
        )
        .bind(saleId, it.productId, it.unit, it.qtyMilli, it.unitPrice, it.priceListId, it.lineTotal, p.costs[i])
        .first<{ id: number }>();
      saleLineIds.push(row!.id);
    }
    const saleCost = p.costs.reduce((s, x) => s + x, 0);
    const stmts: D1PreparedStatement[] = [
      assertStmt(db, "order.exchange.shift", `SELECT status = 'open' FROM shifts WHERE id = ?`, [shift.id]),
      ...returnGuardStmts(db, origId, approvalUsed, claimed, returnTotal),
      ...(await returnEffectStmts(db, orig, origId, retId, retCode, prepared, retLineIds, returnTotal, user.id)),
    ];
    items.forEach((_, i) => {
      for (const a of p.lineAllocs[i]) stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(saleLineIds[i], a.lotId, a.qtyMilli, a.unitCost));
    });
    for (const [pid, alloc] of p.productAllocs) stmts.push(...moveStatements(db, pid, alloc, -1, "sale", "order", saleId, user.id));
    // Tiền: phiếu trả -returnTotal; đơn bán = phần bù trừ (min) theo refundMethod + phần khách trả thêm
    if (returnTotal > 0) stmts.push(db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(retId, body.refundMethod, -returnTotal, offsetFund, `exchange:${saleCode}`));
    const offset = Math.min(returnTotal, newTotal);
    if (offset > 0) stmts.push(db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(saleId, body.refundMethod, offset, offsetFund, `exchange:${retCode}`));
    for (const pay of recorded) {
      if (pay.amount <= 0) continue;
      stmts.push(db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(saleId, pay.method, pay.amount, payFunds.get(pay.method)!, pay.ref ?? null));
    }
    stmts.push(
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, total=?, cost_total=?, paid_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(returnTotal, returnTotal, returnCost, returnTotal, retId),
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, discount=0, total=?, cost_total=?, paid_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(newTotal, newTotal, saleCost, newTotal, saleId),
      ...(approvalUsed ? [db.prepare(`UPDATE approvals SET ref_type='order', ref_id=? WHERE id=? AND ref_id IS NULL`).bind(String(retId), approvalUsed)] : []),
      auditStmt(c, {
        action: "order.return",
        entity: "order",
        entityId: retId,
        after: { code: retCode, originalOrderId: origId, total: returnTotal, exchangeOrderId: saleId, approvalId: approvalUsed, lines: prepared.map((x) => ({ orderLineId: x.orig.id, qtyMilli: x.qtyMilli, restock: x.restock, reason: x.reason })) },
        reason: note.slice(0, 500),
      }),
      auditStmt(c, {
        action: "order.exchange",
        entity: "order",
        entityId: saleId,
        after: { code: saleCode, originalOrderId: origId, returnOrderId: retId, returnTotal, newTotal, net, change, refundMethod: body.refundMethod, approvalId: approvalUsed, shiftId: shift.id },
        reason: body.note,
      }),
    );
    await db.batch(stmts);
  };

  try {
    try {
      await commit();
    } catch (e) {
      if (!isCheckFail(e)) throw e;
      p = await plan(); // tồn vừa đổi: phân bổ lại 1 lần
      await commit();
    }
  } catch (e) {
    await cancelDrafts();
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  return done(saleId, 201, { net, change, returnTotal, newTotal });
});

/** A-16: duyệt trả hàng gắn đúng đơn gốc + dòng/số lượng/phương thức hoàn (băm), dùng một lần, không tự duyệt. */
async function requireReturnApproval(c: Ctx, origId: number, body: z.infer<typeof returnSchema>, reasons: string[], total: number, exchange?: unknown): Promise<number> {
  const db = c.env.DB;
  const user = c.get("user");
  const canon = JSON.stringify({ o: origId, m: body.refundMethod, l: body.lines.map((l) => [l.orderLineId, l.qty, l.unit, l.restock]).sort((a, b) => Number(a[0]) - Number(b[0])), ...(exchange ? { x: exchange } : {}) });
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
      .bind(type, "order_return_draft", JSON.stringify({ originalOrderId: origId, hash, reasons, total, ...(exchange ? { exchange: true } : {}) }), reasons.join(","), user.id)
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
  // B1: đơn có ghi nợ chỉ huỷ được khi hoá đơn nợ chưa được thu đồng nào; đã thu một phần → dùng Trả hàng
  const credInv = await creditInvoiceOf(db, id);
  if (credInv) {
    const paidOn = await db.prepare(`SELECT 1 AS x FROM debt_allocations x LEFT JOIN debt_payments p ON p.id = x.payment_id LEFT JOIN debt_adjustments d ON d.id = x.adjustment_id WHERE x.invoice_id = ? AND (p.status = 'posted' OR d.status = 'posted') LIMIT 1`).bind(credInv.id).first();
    if (paidOn) throw conflict("credit_already_paid", "Hoá đơn nợ của đơn này đã được thu một phần — dùng Trả hàng thay vì huỷ đơn", { invoiceId: credInv.id });
    await assertPeriodOpen(db, new Date(), "huỷ đơn ghi nợ");
  }
  const voidAdjCode = credInv ? await nextCode(db, "HDB") : null;
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
  if (credInv && voidAdjCode)
    stmts.push(
      assertStmt(db, "order.void.debt", `SELECT NOT EXISTS (SELECT 1 FROM debt_allocations x LEFT JOIN debt_payments p ON p.id = x.payment_id LEFT JOIN debt_adjustments d ON d.id = x.adjustment_id WHERE x.invoice_id = ? AND (p.status = 'posted' OR d.status = 'posted'))`, [credInv.id]),
      creditAdjustmentStmt(db, { code: voidAdjCode, original: { id: credInv.id, due_date: credInv.due_date }, orderId: id, customerId: credInv.customer_id, customerName: null, amount: credInv.total, userId: user.id, note: `Huỷ đơn ${o.code}` }),
    );
  stmts.push(...(await reversalStatements(db, { ...o, total: o.total - (o.charges_total ?? 0) }, o.total - (o.charges_total ?? 0), user.id, "huỷ đơn")));
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
