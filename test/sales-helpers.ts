import { testEnv } from "./helpers";

export interface TOrder {
  id: number; code?: string; channel?: string; kind?: "sale" | "return"; orig?: number; createdBy?: number | null; sellerId?: number | null; customer?: number | null;
  shipping?: number; at: string; status?: string;
  /** [productId, qtyMilli, lineTotal, cost, originalLineId?] */
  lines: [number, number, number, number, number?][];
}

/** Chèn thẳng đơn đã hoàn tất + dòng hàng (id dòng = id đơn × 10 + chỉ số) để test báo cáo/hoa hồng. */
export async function insertOrders(list: TOrder[]) {
  const db = testEnv.DB;
  const stmts: D1PreparedStatement[] = [];
  for (const o of list) {
    const subtotal = o.lines.reduce((s, l) => s + l[2], 0);
    const cost = o.lines.reduce((s, l) => s + l[3], 0);
    stmts.push(
      db
        .prepare(
          `INSERT INTO orders(id, code, channel, kind, original_order_id, store_id, customer_id, status, subtotal, shipping_fee, total, cost_total, created_by, seller_id, created_at, completed_at)
           VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(o.id, o.code ?? `T-${o.id}`, o.channel ?? "pos", o.kind ?? "sale", o.orig ?? null, o.customer ?? null, o.status ?? "completed", subtotal, o.shipping ?? 0, subtotal + (o.shipping ?? 0),
          cost, o.createdBy ?? null, o.sellerId ?? null, o.at, o.status && o.status !== "completed" ? null : o.at),
    );
    o.lines.forEach((l, i) =>
      stmts.push(
        db
          .prepare(`INSERT INTO order_lines(id, order_id, product_id, unit, qty_milli, unit_price, line_total, cost_amount, original_line_id) VALUES (?,?,?,'kg',?,?,?,?,?)`)
          .bind(o.id * 10 + i, o.id, l[0], l[1], l[1] ? Math.round((l[2] * 1000) / l[1]) : 0, l[2], l[3], l[4] ?? null),
      ),
    );
  }
  await db.batch(stmts);
}
