import { matchName, nameScore, unitsCompatible } from "./competitor-parse";

export const MATCH_MIN_SCORE = 45;
const PER_PRODUCT = 5;

/**
 * M7-03 sinh gợi ý ghép SP cửa hàng ↔ SP đối thủ theo độ giống tên (trigram Jaccard trên normalizeVi) + đơn vị tương thích.
 * Chỉ ghi status 'suggested' — KHÔNG BAO GIỜ tự duyệt (EC-37). Bỏ qua cặp đã có (duyệt/từ chối/gợi ý).
 */
export async function suggestMatches(db: D1Database, productId?: number): Promise<number> {
  const { results: prods } = await db
    .prepare(`SELECT id, name, base_unit FROM products WHERE active = 1 AND merged_into IS NULL ${productId ? "AND id = ?" : ""}`)
    .bind(...(productId ? [productId] : []))
    .all<{ id: number; name: string; base_unit: string }>();
  const { results: cps } = await db
    .prepare(`SELECT cp.id, cp.name, cp.pack_unit FROM competitor_products cp JOIN competitor_sources s ON s.id = cp.source_id JOIN competitors c ON c.id = s.competitor_id WHERE c.active = 1 ORDER BY cp.id LIMIT 5000`)
    .all<{ id: number; name: string; pack_unit: string | null }>();
  const { results: have } = await db.prepare(`SELECT product_id, competitor_product_id FROM product_matches`).all<{ product_id: number; competitor_product_id: number }>();
  const existing = new Set(have.map((h) => `${h.product_id}:${h.competitor_product_id}`));
  const approvedProducts = new Set(
    (await db.prepare(`SELECT DISTINCT product_id FROM product_matches WHERE status = 'approved'`).all<{ product_id: number }>()).results.map((r) => r.product_id),
  );
  const stmts: D1PreparedStatement[] = [];
  for (const p of prods) {
    if (!productId && approvedProducts.has(p.id)) continue; // chỉ SP chưa ghép
    if (!matchName(p.name)) continue;
    const cands: { id: number; score: number }[] = [];
    for (const cp of cps) {
      if (existing.has(`${p.id}:${cp.id}`)) continue;
      if (cp.pack_unit && !unitsCompatible(p.base_unit, cp.pack_unit)) continue; // quy cách chưa rõ vẫn gợi ý để người dùng sửa
      const score = nameScore(p.name, cp.name);
      if (score >= MATCH_MIN_SCORE) cands.push({ id: cp.id, score });
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, PER_PRODUCT)) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO product_matches(product_id, competitor_product_id, score, status) VALUES (?,?,?, 'suggested')`).bind(p.id, c.id, c.score));
    }
  }
  let created = 0;
  for (let i = 0; i < stmts.length; i += 90) {
    const res = await db.batch(stmts.slice(i, i + 90));
    created += res.reduce((s, r) => s + (r.meta.changes ?? 0), 0);
  }
  return created;
}
