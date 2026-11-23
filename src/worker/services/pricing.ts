import { AppError } from "../lib/errors";

export type Channel = "pos" | "online" | "b2b";

export interface ResolvedPrice {
  unitPrice: number;
  priceListId: number;
  priceId: number;
  kind: string;
}

/**
 * Chọn giá áp dụng tại thời điểm `at` (EC-13): ưu tiên theo price_lists.priority giảm dần
 * (mặc định: customer > promo > group > base), cùng ưu tiên thì bản hiệu lực mới nhất.
 * Đơn đã chốt lưu unit_price vào order_lines nên không bị ảnh hưởng khi bảng giá đổi (M3 quy tắc).
 */
export async function resolvePrice(
  db: D1Database,
  productId: number,
  opts: { channel: Channel; customerGroupId?: number | null; at?: string },
): Promise<ResolvedPrice> {
  const at = opts.at ?? new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT p.id, p.unit_price, p.price_list_id, pl.kind
         FROM prices p JOIN price_lists pl ON pl.id = p.price_list_id
        WHERE p.product_id = ?1 AND p.status = 'active' AND pl.active = 1
          AND pl.channel IN (?2, 'all')
          AND (pl.customer_group_id IS NULL OR pl.customer_group_id = ?3)
          AND p.effective_from <= ?4 AND (p.effective_to IS NULL OR p.effective_to > ?4)
        ORDER BY pl.priority DESC, p.effective_from DESC, p.id DESC
        LIMIT 1`,
    )
    .bind(productId, opts.channel, opts.customerGroupId ?? null, at)
    .first<{ id: number; unit_price: number; price_list_id: number; kind: string }>();
  if (!row) throw new AppError(422, "no_price", "Mặt hàng chưa có giá bán hiệu lực", { productId });
  return { unitPrice: row.unit_price, priceListId: row.price_list_id, priceId: row.id, kind: row.kind };
}

/** Giá vốn tham chiếu hiện tại (bình quân gia quyền các lô còn tồn) — dùng cảnh báo bán dưới vốn (M3-06). */
export async function currentAvgCost(db: D1Database, productId: number) {
  const r = await db
    .prepare(
      `SELECT CASE WHEN SUM(qty_on_hand_milli) > 0
                   THEN CAST(ROUND(1.0 * SUM(unit_cost * qty_on_hand_milli) / SUM(qty_on_hand_milli)) AS INTEGER)
                   ELSE NULL END AS c
         FROM lots WHERE product_id = ? AND status = 'active' AND qty_on_hand_milli > 0`,
    )
    .bind(productId)
    .first<{ c: number | null }>();
  return r?.c ?? null;
}
