import { AppError, conflict } from "../lib/errors";
import { assertStmt } from "./guard";
import { allocate, costFloors, evaluatePromotions, type AppliedDiscount, type EngineLine, type PromoChannel } from "./promotions";
import { earnFor, planRedeem, pointsStmts } from "./loyalty-points";

/** Ghép engine khuyến mãi + voucher + đổi điểm vào luồng thanh toán (POS, website). Đọc ở bước plan, ghi cùng batch với đơn. */

export async function groupIdsOf(db: D1Database, productIds: number[]) {
  const m = new Map<number, number | null>();
  for (const id of new Set(productIds)) {
    const r = await db.prepare(`SELECT group_id FROM products WHERE id = ?`).bind(id).first<{ group_id: number | null }>();
    m.set(id, r?.group_id ?? null);
  }
  return m;
}

export interface PromoPlan {
  discounts: AppliedDiscount[];
  rejected: { code: string; reason: string }[];
  voucher: { id: number; code: string } | null;
  points: number;
  pointsAmount: number;
  /** Phần giảm của khuyến mãi/voucher theo dòng. */
  promoLineDiscounts: number[];
  /** Phần giảm do đổi điểm theo dòng. */
  pointsLineDiscounts: number[];
  /** Tổng giảm (khuyến mãi + điểm) theo dòng. */
  lineDiscounts: number[];
  promoTotal: number;
}

const FATAL_VOUCHER = new Set(["voucher_not_found", "voucher_inactive", "voucher_exhausted", "voucher_wrong_customer", "voucher_customer_limit", "promotion_inactive", "channel_not_allowed", "min_order", "not_applicable", "combo_incomplete", "no_discount"]);

export async function planPromotions(
  db: D1Database,
  o: {
    channel: PromoChannel;
    customerId?: number | null;
    receiverPhone?: string | null;
    lines: EngineLine[];
    subtotal: number;
    voucherCode?: string | null;
    redeemPoints?: number;
    at?: string;
    /** true: voucher sai/hết lượt → ném lỗi (checkout); false: chỉ trả `rejected` (báo giá/xem trước). */
    strict: boolean;
  },
): Promise<PromoPlan> {
  const res = await evaluatePromotions(db, { channel: o.channel, customerId: o.customerId, receiverPhone: o.receiverPhone, lines: o.lines, subtotal: o.subtotal, voucherCode: o.voucherCode, at: o.at });
  if (o.strict && o.voucherCode) {
    const bad = res.rejected.find((r) => FATAL_VOUCHER.has(r.reason));
    if (bad) {
      if (bad.reason === "voucher_exhausted") throw conflict("voucher_exhausted", "Voucher đã hết lượt sử dụng");
      throw new AppError(422, "voucher_invalid", "Voucher không áp dụng được", { reason: bad.reason });
    }
  }
  const voucherD = res.discounts.find((d) => d.voucherId != null);
  const voucher = voucherD ? { id: voucherD.voucherId!, code: o.voucherCode!.trim().toUpperCase() } : null;
  const rem = o.lines.map((l, i) => l.lineTotal - res.lineDiscounts[i]);
  let points = 0;
  let pointsAmount = 0;
  let pointsLine = o.lines.map(() => 0);
  if (o.redeemPoints && o.redeemPoints > 0) {
    const floors = await costFloors(db, o.lines);
    const capByCost = rem.reduce((s, r, i) => s + Math.max(0, r - floors[i]), 0);
    const plan = await planRedeem(db, { customerId: o.customerId, points: o.redeemPoints, payable: rem.reduce((s, x) => s + x, 0), capByCost });
    points = plan.points;
    pointsAmount = plan.amount;
    pointsLine = allocate(pointsAmount, rem);
  }
  return {
    discounts: res.discounts, rejected: res.rejected, voucher, points, pointsAmount,
    promoLineDiscounts: res.lineDiscounts, pointsLineDiscounts: pointsLine,
    lineDiscounts: res.lineDiscounts.map((x, i) => x + pointsLine[i]), promoTotal: res.total,
  };
}

/**
 * Statement ghi nhận khuyến mãi / voucher / điểm cho một đơn (cùng batch với đơn).
 * `ord` = {sql:'?', bind:orderId} hoặc {sql:'(SELECT id FROM orders WHERE code = ?)', bind: code}.
 * CHECK trên vouchers chặn dùng quá lượt khi đồng thời; trigger chặn điểm âm.
 */
export async function promoStatements(
  db: D1Database,
  ord: { sql: string; bind: unknown },
  o: { plan: PromoPlan; customerId: number | null | undefined; payableTotal: number; userId: number | null; customerSql?: { sql: string; bind: unknown }; skipEarn?: boolean; receiverPhone?: string | null },
): Promise<D1PreparedStatement[]> {
  const s: D1PreparedStatement[] = [];
  const { plan } = o;
  for (const d of plan.discounts) {
    s.push(
      db
        .prepare(`INSERT INTO order_discounts(order_id, promotion_id, voucher_id, amount, description) VALUES (${ord.sql}, ?, ?, ?, ?)`)
        .bind(ord.bind, d.promotionId, d.voucherId ?? null, d.amount, d.description),
    );
    if (d.voucherId) {
      // Chốt chặn đồng thời: hai checkout cùng lúc không vượt per_customer_limit (theo khách và/hoặc theo SĐT người nhận)
      if (o.customerId)
        s.push(assertStmt(db, "voucher.per_customer", `SELECT (SELECT COUNT(*) FROM voucher_redemptions WHERE voucher_id = ? AND customer_id = ? AND status = 'used') < (SELECT per_customer_limit FROM vouchers WHERE id = ?)`, [d.voucherId, o.customerId, d.voucherId]));
      if (o.receiverPhone)
        s.push(assertStmt(db, "voucher.per_phone", `SELECT (SELECT COUNT(*) FROM voucher_redemptions r JOIN orders x ON x.id = r.order_id WHERE r.voucher_id = ? AND r.status = 'used' AND x.receiver_phone = ?) < (SELECT per_customer_limit FROM vouchers WHERE id = ?)`, [d.voucherId, o.receiverPhone, d.voucherId]));
      s.push(
        db
          .prepare(`INSERT INTO voucher_redemptions(voucher_id, order_id, customer_id, amount) VALUES (?, ${ord.sql}, ${o.customerSql ? `COALESCE(?, ${o.customerSql.sql})` : "?"}, ?)`)
          .bind(...[d.voucherId, ord.bind, o.customerId ?? null, ...(o.customerSql ? [o.customerSql.bind] : []), d.amount]),
        db.prepare(`UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?`).bind(d.voucherId),
      );
    }
  }
  if (plan.points > 0 && o.customerId) {
    s.push(
      db
        .prepare(`INSERT INTO order_discounts(order_id, points_redeemed, amount, description) VALUES (${ord.sql}, ?, ?, ?)`)
        .bind(ord.bind, plan.points, plan.pointsAmount, `Đổi ${plan.points} điểm`),
      ...pointsStmts(db, ord, o.customerId, "redeem", -plan.points, "Đổi điểm khi thanh toán", o.userId),
    );
  }
  const earn = o.skipEarn ? 0 : await earnFor(db, o.payableTotal, o.customerId);
  if (earn > 0 && o.customerId) s.push(...pointsStmts(db, ord, o.customerId, "earn", earn, "Tích điểm đơn hàng", o.userId));
  return s;
}
