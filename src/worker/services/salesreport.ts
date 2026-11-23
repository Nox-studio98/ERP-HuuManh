/**
 * Tổng hợp bán hàng dùng chung cho báo cáo cuối ca (M1-10) và báo cáo ngày.
 * `where` là điều kiện SQL trên bảng orders (alias o); luôn chỉ tính đơn status='completed'
 * (đơn bán trừ đơn trả). Đơn nháp/huỷ không bao giờ được tính.
 */
export async function salesSummary(db: D1Database, where: string, params: unknown[]) {
  const base = `o.status = 'completed' AND (${where})`;
  const totals = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN o.kind='sale' THEN 1 ELSE 0 END),0) AS saleCount,
         COALESCE(SUM(CASE WHEN o.kind='sale' THEN o.total ELSE 0 END),0) AS saleTotal,
         COALESCE(SUM(CASE WHEN o.kind='return' THEN 1 ELSE 0 END),0) AS returnCount,
         COALESCE(SUM(CASE WHEN o.kind='return' THEN o.total ELSE 0 END),0) AS returnTotal
       FROM orders o WHERE ${base}`,
    )
    .bind(...params)
    .first<{ saleCount: number; saleTotal: number; returnCount: number; returnTotal: number }>();
  const byChannel = await db
    .prepare(
      `SELECT o.channel, COUNT(*) AS orders, SUM(CASE WHEN o.kind='sale' THEN o.total ELSE -o.total END) AS revenue
         FROM orders o WHERE ${base} GROUP BY o.channel ORDER BY revenue DESC`,
    )
    .bind(...params)
    .all();
  const byMethod = await db
    .prepare(
      `SELECT p.method, SUM(p.amount) AS amount
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.status = 'confirmed' AND ${base} GROUP BY p.method ORDER BY amount DESC`,
    )
    .bind(...params)
    .all();
  const top = await db
    .prepare(
      `SELECT ol.product_id AS productId, pr.name,
              SUM(CASE WHEN o.kind='sale' THEN ol.qty_milli ELSE -ol.qty_milli END) AS qtyMilli,
              SUM(CASE WHEN o.kind='sale' THEN ol.line_total ELSE -ol.line_total END) AS revenue
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products pr ON pr.id = ol.product_id
        WHERE ${base} GROUP BY ol.product_id ORDER BY revenue DESC LIMIT 10`,
    )
    .bind(...params)
    .all();
  return {
    saleCount: totals!.saleCount,
    saleTotal: totals!.saleTotal,
    returnCount: totals!.returnCount,
    returnTotal: totals!.returnTotal,
    revenue: totals!.saleTotal - totals!.returnTotal,
    byChannel: byChannel.results,
    byMethod: byMethod.results,
    topProducts: top.results,
  };
}
