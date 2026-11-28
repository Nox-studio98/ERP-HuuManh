import { allocate, evaluatePromotions } from "./promotions";
import { groupIdsOf } from "./promo-checkout";

/**
 * A-19: sau khi cân/đóng gói đơn online, tiền hàng thật đã đổi → tính lại phần phụ thuộc tiền hàng bằng cùng engine khuyến mãi lúc đặt:
 *  - khuyến mãi % / voucher (điều kiện min_order, giới hạn giảm...) tính lại trên tiền hàng thực; voucher không còn đủ điều kiện → bỏ giảm
 *    và hoàn lượt dùng; không xét lại lượt dùng của khách (lượt đã tính cho chính đơn này);
 *  - ngưỡng miễn phí giao của khu vực xét lại trên tiền hàng thực (tuỳ chọn);
 *  - điểm đã đổi giữ nguyên số tiền (kẹp không vượt tiền hàng còn lại), phân bổ lại theo dòng.
 * Kết quả gồm giảm giá theo dòng (để ghi order_lines.discount, A-08) và các câu lệnh cập nhật order_discounts / voucher cho batch của pack.
 * Tắt bằng settings `online.pack_recalc_promo` / `online.pack_recalc_shipping` = 0 (giữ giảm giá & phí giao cố định như trước).
 */
export interface RepriceLine { id: number; productId: number; qtyMilli: number; unitPrice: number; gross: number }
export interface RepriceResult {
  /** Tổng giảm cấp đơn (khuyến mãi + điểm) sau tính lại. */
  discount: number;
  shippingFee: number;
  /** Giảm giá phân bổ theo dòng (id dòng → số tiền). */
  lineDiscounts: Map<number, number>;
  stmts: D1PreparedStatement[];
  info: { promoRecalc: boolean; voucherDropped: boolean; shippingChanged: boolean; before: { discount: number; shippingFee: number } };
}

async function flag(db: D1Database, key: string) {
  return ((await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>())?.value ?? "1") !== "0";
}

export async function repriceAfterPack(db: D1Database, o: any, lines: RepriceLine[], subtotal: number): Promise<RepriceResult> {
  const keep = (): RepriceResult => ({
    discount: o.discount, shippingFee: o.shipping_fee, lineDiscounts: new Map(), stmts: [],
    info: { promoRecalc: false, voucherDropped: false, shippingChanged: false, before: { discount: o.discount, shippingFee: o.shipping_fee } },
  });
  const res = keep();
  const recalcPromo = o.channel === "online" && (await flag(db, "online.pack_recalc_promo"));
  const recalcShip = o.channel === "online" && o.zone_id != null && (await flag(db, "online.pack_recalc_shipping"));

  // Ngưỡng miễn phí giao tính SAU giảm giá / voucher / điểm (chủ đã chốt): gọi sau khi biết giảm giá mới của đơn.
  const reshipping = async () => {
    if (!recalcShip) return;
    const z = await db.prepare(`SELECT fee, free_over FROM delivery_zones WHERE id = ?`).bind(o.zone_id).first<{ fee: number; free_over: number | null }>();
    if (!z) return;
    const feeFor = (sub: number, disc: number) => (z.free_over != null && Math.max(0, sub - disc) >= z.free_over ? 0 : z.fee);
    // chỉ xét lại khi phí giao hiện tại đúng là phí theo quy tắc khu vực lúc đặt (phí đặt tay/khác quy tắc thì giữ nguyên);
    // đơn đặt trước khi đổi quy tắc (ngưỡng tính trên tiền hàng trước giảm) vẫn được coi là đúng quy tắc
    const atOrder = feeFor(o.subtotal, o.discount ?? 0) === o.shipping_fee || feeFor(o.subtotal, 0) === o.shipping_fee;
    if (!atOrder) return;
    res.shippingFee = feeFor(subtotal, res.discount);
    res.info.shippingChanged = res.shippingFee !== o.shipping_fee;
  };
  if (!recalcPromo) {
    // giữ nguyên giảm giá cấp đơn; dòng giữ phần giảm đã ghi
    res.lineDiscounts = new Map();
    await reshipping();
    return res;
  }

  const old = (await db.prepare(`SELECT promotion_id, voucher_id, points_redeemed, amount FROM order_discounts WHERE order_id = ? ORDER BY id`).bind(o.id).all<any>()).results;
  const oldPromo = old.filter((r) => r.points_redeemed == null);
  const pointsAmount = old.filter((r) => r.points_redeemed != null).reduce((s, r) => s + r.amount, 0);
  const oldVoucherId: number | null = oldPromo.find((r) => r.voucher_id != null)?.voucher_id ?? null;
  const code = oldVoucherId ? (await db.prepare(`SELECT code FROM vouchers WHERE id = ?`).bind(oldVoucherId).first<{ code: string }>())?.code ?? null : null;
  const groups = await groupIdsOf(db, lines.map((l) => l.productId));
  const ev = await evaluatePromotions(db, {
    channel: "online",
    customerId: o.shop_account_id ? o.customer_id : null,
    receiverPhone: o.receiver_phone,
    lines: lines.map((l) => ({ productId: l.productId, groupId: groups.get(l.productId) ?? null, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice, lineTotal: l.gross })),
    subtotal,
    voucherCode: code,
    at: o.created_at,
    reprice: true,
  });
  const rem = lines.map((l, i) => Math.max(0, l.gross - ev.lineDiscounts[i]));
  const pts = Math.min(pointsAmount, rem.reduce((s, x) => s + x, 0));
  const ptsLine = allocate(pts, rem);
  lines.forEach((l, i) => res.lineDiscounts.set(l.id, ev.lineDiscounts[i] + ptsLine[i]));
  res.discount = ev.total + pts;
  res.info.promoRecalc = true;
  await reshipping();

  const sig = (rows: { promotion_id?: number | null; promotionId?: number; voucher_id?: number | null; voucherId?: number; amount: number }[]) =>
    rows.map((r) => `${r.promotion_id ?? r.promotionId}:${r.voucher_id ?? r.voucherId ?? 0}:${r.amount}`).sort().join("|");
  if (sig(oldPromo) !== sig(ev.discounts)) {
    res.stmts.push(db.prepare(`DELETE FROM order_discounts WHERE order_id = ? AND points_redeemed IS NULL`).bind(o.id));
    for (const d of ev.discounts)
      res.stmts.push(
        db
          .prepare(`INSERT INTO order_discounts(order_id, promotion_id, voucher_id, amount, description) VALUES (?, ?, ?, ?, ?)`)
          .bind(o.id, d.promotionId, d.voucherId ?? null, d.amount, `${d.description} (tính lại sau cân)`),
      );
  }
  const newVoucherId = ev.discounts.find((d) => d.voucherId != null)?.voucherId ?? null;
  if (oldVoucherId && !newVoucherId) {
    res.info.voucherDropped = true;
    // hoàn lượt dùng (giảm used_count trước khi đánh dấu đã hoàn — cùng thứ tự reversalStatements)
    res.stmts.push(
      db.prepare(`UPDATE vouchers SET used_count = used_count - 1 WHERE id IN (SELECT voucher_id FROM voucher_redemptions WHERE order_id = ? AND voucher_id = ? AND status = 'used')`).bind(o.id, oldVoucherId),
      db.prepare(`UPDATE voucher_redemptions SET status = 'reversed' WHERE order_id = ? AND voucher_id = ? AND status = 'used'`).bind(o.id, oldVoucherId),
    );
  } else if (oldVoucherId && newVoucherId) {
    const amt = ev.discounts.find((d) => d.voucherId === newVoucherId)!.amount;
    res.stmts.push(db.prepare(`UPDATE voucher_redemptions SET amount = ? WHERE order_id = ? AND voucher_id = ? AND status = 'used'`).bind(amt, o.id, newVoucherId));
  }
  if (pts !== pointsAmount) res.stmts.push(db.prepare(`UPDATE order_discounts SET amount = ? WHERE order_id = ? AND points_redeemed IS NOT NULL`).bind(pts, o.id));
  return res;
}
