import { AppError } from "../../../worker/lib/errors";
import { lineAmount } from "../../../worker/lib/money";
import { resolvePrice } from "../../../worker/services/pricing";
import { availableQty } from "../../../worker/services/stock";
import { unitFactor } from "../../../worker/services/http";
import { publicAvail, stepOf } from "./catalog";
import { findZone, shippingFee, type Zone } from "./delivery";
import { groupIdsOf, planPromotions } from "../../../worker/services/promo-checkout";

export interface CartItemIn {
  productId: number;
  unit: string;
  qty: number;
  expectedUnitPrice?: number;
}

export interface CartIssue {
  productId: number | null;
  code: "out_of_stock" | "insufficient" | "unpublished" | "min_order" | "zone_unsupported" | "slot_unavailable";
  message: string;
}

export interface CartLine {
  index: number; // vị trí trong đầu vào
  productId: number;
  name: string;
  imageKey: string | null;
  unit: string;
  qty: number;
  qtyMilli: number;
  factorMilli: number;
  unitPrice: number; // VND / đơn vị chính
  lineTotal: number;
  sellByWeight: boolean;
  allowPreorder: boolean;
  stepMilli: number;
  expectedUnitPrice?: number;
  // điền bởi applyStock
  coveredMilli: number;
  preorderMilli: number;
}

export const MAX_LINES = 50;
const MAX_LINE_MILLI = 1_000_000;

/** Định giá server-side. Mặt hàng chưa công bố / chưa có giá online → issue 'unpublished' và bị loại khỏi dòng. */
export async function priceCart(db: D1Database, items: CartItemIn[]) {
  if (items.length === 0) throw new AppError(422, "empty_cart", "Giỏ hàng trống");
  if (items.length > MAX_LINES) throw new AppError(422, "too_many_lines", `Tối đa ${MAX_LINES} mặt hàng`);
  const issues: CartIssue[] = [];
  const lines: CartLine[] = [];
  for (const [index, it] of items.entries()) {
    const p = await db
      .prepare(
        `SELECT id, name, base_unit, sell_by_weight, allow_preorder, online_step_milli, images_json, published_online, slug
           FROM products WHERE id = ? AND active = 1 AND merged_into IS NULL`,
      )
      .bind(it.productId)
      .first<any>();
    let price: number | null = null;
    if (p?.published_online && p.slug) {
      try {
        price = (await resolvePrice(db, p.id, { channel: "online" })).unitPrice;
      } catch (e) {
        if (!(e instanceof AppError && e.code === "no_price")) throw e;
      }
    }
    if (!p || price == null) {
      issues.push({ productId: it.productId, code: "unpublished", message: "Sản phẩm hiện không còn bán online" });
      continue;
    }
    const factor = await unitFactor(db, p.id, it.unit);
    const qtyMilli = Math.round(it.qty * factor);
    const step = stepOf(p.base_unit, p.online_step_milli);
    if (!(qtyMilli > 0) || qtyMilli > MAX_LINE_MILLI) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ", { productId: p.id });
    if (qtyMilli % step !== 0) throw new AppError(422, "invalid_qty_step", `Số lượng phải là bội của bước đặt hàng`, { productId: p.id, stepMilli: step });
    let imageKey: string | null = null;
    try {
      const imgs = JSON.parse(p.images_json ?? "[]");
      imageKey = Array.isArray(imgs) && typeof imgs[0] === "string" ? imgs[0] : null;
    } catch {
      /* bỏ qua */
    }
    lines.push({
      index, productId: p.id, name: p.name, imageKey, unit: it.unit, qty: it.qty, qtyMilli, factorMilli: factor,
      unitPrice: price, lineTotal: lineAmount(price, qtyMilli), sellByWeight: !!p.sell_by_weight, allowPreorder: !!p.allow_preorder,
      stepMilli: step, expectedUnitPrice: it.expectedUnitPrice, coveredMilli: qtyMilli, preorderMilli: 0,
    });
  }
  return { lines, issues };
}

/**
 * Chia từng dòng thành phần có hàng (coveredMilli) và phần thiếu. Cùng sản phẩm nhiều dòng dùng chung một quỹ tồn.
 * Thiếu: nếu sản phẩm cho đặt trước → preorderMilli = phần thiếu; ngược lại giữ preorderMilli = 0 và đánh dấu short.
 * Trả `realAvail` theo sản phẩm để dùng trong thông báo lỗi (chỉ phát ra dạng đã che).
 */
export async function applyStock(db: D1Database, storeId: number, lines: CartLine[]) {
  const remaining = new Map<number, number>();
  const short: { line: CartLine; shortMilli: number; remainingBefore: number }[] = [];
  for (const l of lines) {
    if (!remaining.has(l.productId)) remaining.set(l.productId, await availableQty(db, l.productId, storeId));
    const have = remaining.get(l.productId)!;
    const covered = Math.min(have, l.qtyMilli);
    remaining.set(l.productId, have - covered);
    l.coveredMilli = covered;
    const miss = l.qtyMilli - covered;
    l.preorderMilli = l.allowPreorder ? miss : 0;
    if (miss > 0) short.push({ line: l, shortMilli: miss, remainingBefore: have });
  }
  return short;
}

export const publicRemaining = (l: CartLine, remainingBefore: number) => publicAvail(remainingBefore, l.stepMilli);

export interface Pricing {
  subtotal: number;
  shippingFee: number;
  total: number;
  zone: Zone | null;
  estimated: boolean;
}

export async function computeTotals(db: D1Database, lines: CartLine[], district: string | null) {
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const zone = await findZone(db, district);
  const fee = zone ? shippingFee(zone, subtotal) : 0;
  return { subtotal, shippingFee: fee, total: subtotal + fee, zone, estimated: lines.some((l) => l.sellByWeight) } as Pricing;
}

/** Khuyến mãi / voucher cho giỏ online (engine dùng chung với POS). strict=true (checkout): voucher sai → lỗi; false (báo giá): chỉ trả `rejected`. */
export async function promoForCart(db: D1Database, lines: CartLine[], subtotal: number, customerId: number | null, voucherCode: string | undefined, strict: boolean) {
  const groups = await groupIdsOf(db, lines.map((l) => l.productId));
  return planPromotions(db, {
    channel: "online",
    customerId,
    lines: lines.map((l) => ({ productId: l.productId, groupId: groups.get(l.productId) ?? null, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    subtotal,
    voucherCode,
    strict,
  });
}
