import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../../../worker/lib/errors";
import { vnDate } from "../../../worker/lib/time";
import type { ShopBindings } from "../env";
import { applyStock, computeTotals, priceCart, priceCtxOf, promoForCart, redeemCustomerId, type CartIssue } from "../lib/cart";
import { DATE_RE, activeSlots, addDaysStr, feeAfterDiscount, findZone, getSlot, slotProblem } from "../lib/delivery";
import { optionalAuth } from "../lib/session";
import { onlineStoreId, parseBody } from "../lib/util";

export const cartRoutes = new Hono<ShopBindings>();

export const ItemSchema = z.object({
  productId: z.number().int().positive(),
  unit: z.string().min(1).max(20),
  qty: z.number().positive().max(100000),
});

const QuoteSchema = z.object({
  items: z.array(ItemSchema).min(1).max(50),
  addressId: z.number().int().positive().optional(),
  district: z.string().max(100).optional(),
  slotDate: z.string().regex(DATE_RE).optional(),
  slotId: z.number().int().positive().optional(),
  voucherCode: z.string().trim().min(1).max(40).optional(),
  redeemPoints: z.number().int().positive().max(100_000_000).optional(),
});

const SLOT_MSG: Record<string, string> = {
  closed: "Khung giờ không giao vào ngày này",
  past: "Ngày giao đã qua",
  cutoff: "Đã quá giờ chốt đặt cho khung giờ này",
  full: "Khung giờ đã đầy",
};

cartRoutes.post("/cart/quote", optionalAuth, async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, QuoteSchema);
  let district = b.district ?? null;
  if (b.addressId) {
    const a = c.get("account");
    if (!a) throw new AppError(401, "unauthenticated", "Vui lòng đăng nhập để dùng sổ địa chỉ");
    const ad = await db.prepare(`SELECT district FROM shop_addresses WHERE id = ? AND account_id = ? AND active = 1`).bind(b.addressId, a.id).first<{ district: string }>();
    if (!ad) throw new AppError(404, "address_not_found", "Không tìm thấy địa chỉ");
    district = ad.district;
  }
  const { lines, issues } = await priceCart(db, b.items, priceCtxOf(c.get("account")));
  const short = await applyStock(db, await onlineStoreId(db), lines);
  for (const s of short)
    issues.push({
      productId: s.line.productId,
      code: s.remainingBefore <= 0 ? "out_of_stock" : "insufficient",
      message: s.line.allowPreorder ? "Không đủ hàng, phần thiếu sẽ giao khi hàng về (đặt trước)" : s.remainingBefore <= 0 ? "Sản phẩm tạm hết hàng" : "Không đủ số lượng yêu cầu",
    } as CartIssue);
  const t = await computeTotals(db, lines, district);
  if (district && !t.zone) issues.push({ productId: null, code: "zone_unsupported", message: "Chưa hỗ trợ giao hàng tới khu vực này" });
  if (t.zone && t.subtotal < t.zone.minOrder)
    issues.push({ productId: null, code: "min_order", message: `Đơn tối thiểu ${t.zone.minOrder.toLocaleString("vi-VN")}đ cho khu vực này` });
  if (b.slotDate && b.slotId) {
    const slot = await getSlot(db, b.slotId);
    const why = slot ? await slotProblem(db, slot, b.slotDate) : "closed";
    if (why) issues.push({ productId: null, code: "slot_unavailable", message: SLOT_MSG[why] ?? "Khung giờ không khả dụng" });
  }
  // Đợt 4: khuyến mãi tự động + voucher (cùng engine với POS)
  const promo = await promoForCart(db, lines, t.subtotal, redeemCustomerId(c.get("account"), b.redeemPoints), b.voucherCode, false, null, b.redeemPoints ?? 0);
  // Ngưỡng miễn phí giao tính sau giảm giá / voucher / điểm
  const orderDiscount = promo.promoTotal + promo.pointsAmount;
  const shippingFee = t.zone ? feeAfterDiscount(t.zone, t.subtotal, orderDiscount) : 0;
  const voucherRejected = b.voucherCode ? promo.rejected.find((r) => r.reason !== "not_best_promotion") ?? promo.rejected[0] : undefined;
  return c.json({
    lines: lines.map((l, i) => ({
      productId: l.productId, name: l.name, unit: l.unit, qty: l.qty, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice, lineTotal: l.lineTotal,
      available: l.coveredMilli >= l.qtyMilli, preorderMilli: l.preorderMilli, sellByWeight: l.sellByWeight, discount: promo.lineDiscounts[i],
    })),
    subtotal: t.subtotal,
    discount: promo.promoTotal,
    pointsRedeemed: promo.points,
    pointsAmount: promo.pointsAmount,
    ...(promo.maxRedeemPoints != null && c.get("account")?.kind === "retail" ? { pointsMax: promo.maxRedeemPoints, pointsBalance: promo.pointsBalance } : {}),
    discounts: promo.discounts.map((d) => ({ promotionId: d.promotionId, amount: d.amount, description: d.description })),
    ...(b.voucherCode ? { voucher: voucherRejected ? { code: b.voucherCode, applied: false, reason: voucherRejected.reason } : { code: b.voucherCode, applied: !!promo.voucher } } : {}),
    shippingFee,
    zone: t.zone ? { id: t.zone.id, name: t.zone.name } : null,
    total: t.subtotal - orderDiscount + shippingFee,
    estimated: t.estimated,
    issues,
  });
});

/** Khu vực giao đang hoạt động + danh sách quận/huyện (cho ô chọn địa chỉ). Server vẫn là nơi quyết định khi quote/checkout. */
cartRoutes.get("/delivery/zones", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, districts_json, fee, free_over, min_order FROM delivery_zones WHERE active = 1 ORDER BY fee, id`,
  ).all<{ id: number; name: string; districts_json: string; fee: number; free_over: number | null; min_order: number }>();
  const zones = results.map((z) => {
    let districts: string[] = [];
    try { districts = (JSON.parse(z.districts_json) as unknown[]).filter((d): d is string => typeof d === "string"); } catch { /* bỏ qua dữ liệu hỏng */ }
    return { id: z.id, name: z.name, fee: z.fee, freeOver: z.free_over, minOrder: z.min_order, districts };
  });
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ zones });
});

cartRoutes.get("/delivery/slots", async (c) => {
  const db = c.env.DB;
  const date = c.req.query("date");
  if (date && !DATE_RE.test(date)) throw new AppError(422, "invalid_date", "Ngày không hợp lệ (YYYY-MM-DD)");
  const zone = await findZone(db, c.req.query("district"));
  const days = date ? [date] : Array.from({ length: 7 }, (_, i) => addDaysStr(vnDate(), i));
  const slots = await activeSlots(db);
  const out: unknown[] = [];
  for (const d of days)
    for (const s of slots) {
      const why = await slotProblem(db, s, d);
      if (why === "closed") continue; // khung không hoạt động hôm đó: không hiển thị
      out.push({ date: d, id: s.id, label: s.label, startTime: s.start_time, endTime: s.end_time, available: !why, ...(why ? { reason: why } : {}) });
    }
  return c.json({ zone: zone ? { id: zone.id, name: zone.name, fee: zone.fee, freeOver: zone.freeOver, minOrder: zone.minOrder } : null, slots: out });
});

