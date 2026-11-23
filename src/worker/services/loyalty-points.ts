import { AppError, conflict } from "../lib/errors";
import { getSettingInt } from "./settings";

/** Tích điểm / đổi điểm (M1-13). customers.points = số dư; loyalty_ledger bất biến; cả hai ghi cùng batch với đơn. */

export async function loyaltyConfig(db: D1Database) {
  return {
    enabled: (await getSettingInt(db, "loyalty.enabled", 0)) === 1,
    earnPerVnd: Math.max(1, await getSettingInt(db, "loyalty.earn_per_vnd", 10000)),
    pointValueVnd: Math.max(1, await getSettingInt(db, "loyalty.point_value_vnd", 100)),
    maxRedeemBp: await getSettingInt(db, "loyalty.max_redeem_bp", 5000),
  };
}

/** Điểm tích được cho phần khách thực trả (đã trừ khuyến mãi và điểm đổi). */
export async function earnFor(db: D1Database, payableTotal: number, customerId: number | null | undefined) {
  if (!customerId) return 0;
  const cfg = await loyaltyConfig(db);
  if (!cfg.enabled) return 0;
  return Math.max(0, Math.floor(payableTotal / cfg.earnPerVnd));
}

export interface RedeemPlan {
  points: number;
  amount: number;
}

/**
 * Kiểm tra đổi điểm: bật tích điểm, có khách, đủ số dư, ≤ loyalty.max_redeem_bp × tổng, và không đẩy giá dòng dưới giá vốn (capByCost).
 */
export async function planRedeem(
  db: D1Database,
  o: { customerId: number | null | undefined; points: number; payable: number; capByCost: number },
): Promise<RedeemPlan> {
  if (!o.points) return { points: 0, amount: 0 };
  const cfg = await loyaltyConfig(db);
  if (!cfg.enabled) throw new AppError(422, "loyalty_disabled", "Chưa bật chương trình tích điểm");
  if (!o.customerId) throw new AppError(422, "customer_required", "Cần chọn khách hàng để đổi điểm");
  const cu = await db.prepare(`SELECT points FROM customers WHERE id = ?`).bind(o.customerId).first<{ points: number }>();
  if (!cu) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
  const maxAmount = Math.min(Math.floor((o.payable * cfg.maxRedeemBp) / 10000), o.capByCost);
  const maxPoints = Math.floor(maxAmount / cfg.pointValueVnd);
  if (o.points > maxPoints) throw new AppError(422, "redeem_too_high", "Số điểm đổi vượt mức cho phép của đơn", { maxPoints, requested: o.points });
  if (o.points > cu.points) throw conflict("points_insufficient", "Khách không đủ điểm", { balance: cu.points, requested: o.points });
  return { points: o.points, amount: o.points * cfg.pointValueVnd };
}

/** Một dòng sổ điểm + cập nhật số dư (trigger customers_points_nonneg chặn âm → 'points_insufficient'). */
export function pointsStmts(
  db: D1Database,
  ord: { sql: string; bind: unknown } | null,
  customerId: number,
  kind: "earn" | "redeem" | "reverse" | "adjust" | "expire",
  points: number,
  note: string,
  userId: number | null,
  clampAtZero = false,
): D1PreparedStatement[] {
  if (!points) return [];
  return [
    db
      .prepare(`INSERT INTO loyalty_ledger(customer_id, order_id, kind, points, note, created_by) VALUES (?, ${ord ? ord.sql : "NULL"}, ?, ?, ?, ?)`)
      .bind(...(ord ? [customerId, ord.bind] : [customerId]), kind, points, note, userId),
    clampAtZero
      ? db.prepare(`UPDATE customers SET points = MAX(0, points + ?) WHERE id = ?`).bind(points, customerId)
      : db.prepare(`UPDATE customers SET points = points + ? WHERE id = ?`).bind(points, customerId),
  ];
}

export const isPointsInsufficient = (e: unknown) => /points_insufficient/.test(String((e as Error)?.message ?? ""));
export const isVoucherExhausted = (e: unknown) => /used_count/.test(String((e as Error)?.message ?? ""));

/**
 * Hoàn điểm/voucher khi trả hàng hoặc huỷ đơn (reverse):
 *  - điểm tích: thu hồi theo tỉ lệ tiền đã trả (đủ số dư hiện có, không âm);
 *  - khi trả toàn bộ: hoàn điểm đã đổi và hoàn lượt voucher (voucher_redemptions → reversed, used_count − 1).
 * `cumulativeReturned` = tổng tiền đã trả (kể cả lần này) so với `order.total`.
 */
export async function reversalStatements(
  db: D1Database,
  order: { id: number; customer_id: number | null; total: number },
  cumulativeReturned: number,
  userId: number | null,
  why: string,
): Promise<D1PreparedStatement[]> {
  const full = order.total <= 0 || cumulativeReturned >= order.total;
  const stmts: D1PreparedStatement[] = [];
  const ord = { sql: "?", bind: order.id };
  if (order.customer_id) {
    const led = (await db.prepare(`SELECT kind, points FROM loyalty_ledger WHERE order_id = ? AND customer_id = ?`).bind(order.id, order.customer_id).all<{ kind: string; points: number }>()).results;
    const earned = led.filter((x) => x.kind === "earn").reduce((s, x) => s + x.points, 0);
    const earnReversed = -led.filter((x) => x.kind === "reverse" && x.points < 0).reduce((s, x) => s + x.points, 0);
    const redeemed = -led.filter((x) => x.kind === "redeem").reduce((s, x) => s + x.points, 0);
    const restored = led.filter((x) => x.kind === "reverse" && x.points > 0).reduce((s, x) => s + x.points, 0);
    const target = full ? earned : Math.floor((earned * cumulativeReturned) / Math.max(order.total, 1));
    let delta = Math.max(0, target - earnReversed);
    if (delta > 0) {
      const bal = (await db.prepare(`SELECT points FROM customers WHERE id = ?`).bind(order.customer_id).first<{ points: number }>())?.points ?? 0;
      delta = Math.min(delta, bal);
      stmts.push(...pointsStmts(db, ord, order.customer_id, "reverse", -delta, `Thu hồi điểm: ${why}`, userId, true));
    }
    if (full && redeemed - restored > 0) stmts.push(...pointsStmts(db, ord, order.customer_id, "reverse", redeemed - restored, `Hoàn điểm đã đổi: ${why}`, userId));
  }
  if (full) {
    // phải giảm used_count trước khi đánh dấu redemption đã hoàn
    stmts.push(
      db
        .prepare(`UPDATE vouchers SET used_count = used_count - 1 WHERE id IN (SELECT voucher_id FROM voucher_redemptions WHERE order_id = ? AND status = 'used')`)
        .bind(order.id),
      db.prepare(`UPDATE voucher_redemptions SET status = 'reversed' WHERE order_id = ? AND status = 'used'`).bind(order.id),
    );
  }
  return stmts;
}
