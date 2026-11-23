import { onlineStoreId, imageUrl, parseImages, unitLabel } from "./util";

export type Channel = "online" | "b2b";
export interface PriceCtx {
  channel: Channel;
  groupId?: number | null;
  customerId?: number | null;
}

/** Số đơn vị tối đa hiển thị cho khách — không lộ tồn thật. */
export const MAX_PUBLIC_UNITS = 99;

export const stepOf = (baseUnit: string, onlineStep: number | null) => onlineStep ?? (baseUnit === "kg" ? 500 : 1000);

/** Tồn hiển thị: chặn trên 99 đơn vị, làm tròn xuống theo bước đặt hàng. */
export function publicAvail(realMilli: number, stepMilli: number) {
  const capped = Math.min(Math.max(realMilli, 0), MAX_PUBLIC_UNITS * 1000);
  return Math.floor(capped / stepMilli) * stepMilli;
}

export interface ProductCard {
  id: number;
  slug: string;
  name: string;
  origin: string | null;
  baseUnit: string;
  unitLabel: string;
  price: number;
  imageUrl: string | null;
  inStock: boolean;
  availableMilli: number;
  allowPreorder: boolean;
  stepMilli: number;
  sellByWeight: boolean;
  units: { unit: string; factorMilli: number }[];
}

export interface CatalogOpts extends PriceCtx {
  where?: string[]; // điều kiện trên bảng ngoài (cột: id, slug, name, group_id, price, ...)
  binds?: unknown[];
  order?: string;
  limit?: number;
  offset?: number;
  onlyPublished?: boolean;
}

/** Biểu thức SQL chọn giá hiệu lực (cùng quy tắc ưu tiên với services/pricing.resolvePrice). ?1=now ?2=group ?3=customer */
const PRICE_SQL = (chan: Channel) => `(SELECT p2.unit_price FROM prices p2 JOIN price_lists pl ON pl.id = p2.price_list_id
   WHERE p2.product_id = p.id AND p2.status = 'active' AND pl.active = 1 AND pl.channel IN ('${chan}', 'all')
     AND (pl.customer_group_id IS NULL OR pl.customer_group_id = ?2)
     AND (pl.customer_id IS NULL OR pl.customer_id = ?3)
     AND p2.effective_from <= ?1 AND (p2.effective_to IS NULL OR p2.effective_to > ?1)
   ORDER BY pl.priority DESC, p2.effective_from DESC, p2.id DESC LIMIT 1)`;

const AVAIL_SQL = `(SELECT COALESCE(SUM(l.qty_on_hand_milli - l.qty_reserved_milli), 0) FROM lots l JOIN locations loc ON loc.id = l.location_id
   WHERE l.product_id = p.id AND loc.store_id = ?4 AND loc.sellable = 1 AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?1))`;

export async function queryCards(db: D1Database, o: CatalogOpts) {
  const now = new Date().toISOString();
  const store = await onlineStoreId(db);
  const binds: unknown[] = [now, o.groupId ?? null, o.customerId ?? null, store, ...(o.binds ?? [])];
  const published = o.onlyPublished === false ? "" : "AND p.published_online = 1 AND p.slug IS NOT NULL";
  const sql = `SELECT * FROM (
      SELECT p.id, p.slug, p.name, p.origin, p.base_unit, p.sell_by_weight, p.allow_preorder, p.online_step_milli, p.images_json,
             p.description, p.group_id, p.featured, p.online_sort, g.name AS group_name,
             ${PRICE_SQL(o.channel)} AS price, ${AVAIL_SQL} AS avail
        FROM products p LEFT JOIN product_groups g ON g.id = p.group_id
       WHERE p.active = 1 AND p.merged_into IS NULL ${published}
    ) p WHERE p.price IS NOT NULL ${o.where?.length ? "AND " + o.where.join(" AND ") : ""}
    ORDER BY ${o.order ?? "p.featured DESC, p.online_sort ASC, p.id ASC"}
    ${o.limit ? `LIMIT ${Math.floor(o.limit)} OFFSET ${Math.floor(o.offset ?? 0)}` : ""}`;
  const { results } = await db.prepare(sql).bind(...binds).all<any>();
  const ids = results.map((r) => r.id);
  const units = new Map<number, { unit: string; factorMilli: number }[]>();
  if (ids.length) {
    const u = await db
      .prepare(`SELECT product_id, unit, factor_milli FROM product_units WHERE product_id IN (${ids.map(() => "?").join(",")}) ORDER BY factor_milli`)
      .bind(...ids)
      .all<{ product_id: number; unit: string; factor_milli: number }>();
    for (const x of u.results) units.set(x.product_id, [...(units.get(x.product_id) ?? []), { unit: x.unit, factorMilli: x.factor_milli }]);
  }
  return results.map((r) => ({
    row: r,
    card: {
      id: r.id,
      slug: r.slug ?? String(r.id),
      name: r.name,
      origin: r.origin,
      baseUnit: r.base_unit,
      unitLabel: unitLabel(r.base_unit),
      price: r.price,
      imageUrl: imageUrl(parseImages(r.images_json)[0]),
      inStock: publicAvail(r.avail, stepOf(r.base_unit, r.online_step_milli)) >= stepOf(r.base_unit, r.online_step_milli),
      availableMilli: publicAvail(r.avail, stepOf(r.base_unit, r.online_step_milli)),
      allowPreorder: !!r.allow_preorder,
      stepMilli: stepOf(r.base_unit, r.online_step_milli),
      sellByWeight: !!r.sell_by_weight,
      units: [{ unit: r.base_unit, factorMilli: 1000 }, ...(units.get(r.id) ?? []).filter((x) => x.unit !== r.base_unit)],
    } as ProductCard,
  }));
}

export const cards = async (db: D1Database, o: CatalogOpts) => (await queryCards(db, o)).map((x) => x.card);
