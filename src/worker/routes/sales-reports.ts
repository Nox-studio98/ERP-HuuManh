import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings } from "../env";
import { can, maskPhone, requirePerm } from "../lib/rbac";
import { AppError } from "../lib/errors";
import { parseDayRange, vnDate, vnDayRangeUtc } from "../lib/time";
import { supplierDebtStatus } from "../services/debt";

/**
 * Báo cáo bán hàng (docs/API-dot4.md, "Báo cáo bán hàng & hoa hồng"): theo người bán, hàng hoá, khách, nhà cung cấp.
 * Cùng điều kiện với /reports/pnl: đơn completed trong khoảng ngày VN, đơn trả trừ ra. Giá vốn/lãi gộp chỉ trả khi có prices.view_cost.
 * Người bán của đơn = COALESCE(orders.seller_id, orders.created_by); trả hàng tính về người bán/khách của ĐƠN GỐC.
 */
export const salesReportRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const CHANNELS = ["pos", "online", "b2b", "fresco", "social"];

function scope(c: Ctx) {
  const today = vnDate();
  const r = parseDayRange(c.req.query("from") ?? today, c.req.query("to") ?? c.req.query("from") ?? today)!;
  const channel = c.req.query("channel") || null;
  if (channel && !CHANNELS.includes(channel)) throw new AppError(422, "validation_error", "channel không hợp lệ");
  const gRaw = c.req.query("groupId");
  const groupId = gRaw ? Number(gRaw) : null;
  if (gRaw && (!Number.isInteger(groupId) || groupId! <= 0)) throw new AppError(422, "validation_error", "groupId không hợp lệ");
  const fromIso = vnDayRangeUtc(r.from).from, toIso = vnDayRangeUtc(r.to).to;
  const conds = [`o.status = 'completed'`, `o.completed_at >= ?`, `o.completed_at < ?`];
  const params: unknown[] = [fromIso, toIso];
  if (channel) { conds.push(`o.channel = ?`); params.push(channel); }
  return { from: r.from, to: r.to, channel, groupId, where: conds.join(" AND "), params, fromIso, toIso };
}
const costOk = (c: Ctx) => can(c.get("user").role, "prices.view_cost");
const LIMIT = 500;

// ---------------------------------------------------------------- theo người bán
salesReportRoutes.get("/reports/sales/sellers", requirePerm("reports.view"), async (c) => {
  const db = c.env.DB, s = scope(c), withCost = costOk(c);
  const SELLER = `COALESCE(so.seller_id, so.created_by, o.seller_id, o.created_by)`;
  const rows = new Map<number | null, { sales: number; returns: number; saleCount: number; returnCount: number; cogs: number }>();
  const row = (k: number | null) => rows.get(k) ?? (rows.set(k, { sales: 0, returns: 0, saleCount: 0, returnCount: 0, cogs: 0 }), rows.get(k)!);
  if (s.groupId == null) {
    const orders = (
      await db
        .prepare(
          `SELECT ${SELLER} AS uid,
                  SUM(CASE WHEN o.kind='sale' THEN 1 ELSE 0 END) AS saleCount, SUM(CASE WHEN o.kind='sale' THEN o.total ELSE 0 END) AS sales,
                  SUM(CASE WHEN o.kind='return' THEN 1 ELSE 0 END) AS returnCount, SUM(CASE WHEN o.kind='return' THEN o.total ELSE 0 END) AS returns
             FROM orders o LEFT JOIN orders so ON so.id = o.original_order_id WHERE ${s.where} GROUP BY uid`,
        )
        .bind(...s.params)
        .all<any>()
    ).results;
    for (const r of orders) Object.assign(row(r.uid), { sales: r.sales, returns: r.returns, saleCount: r.saleCount, returnCount: r.returnCount });
  }
  const lineRows = (
    await db
      .prepare(
        `SELECT ${SELLER} AS uid, COUNT(DISTINCT CASE WHEN o.kind='sale' THEN o.id END) AS saleCount, COUNT(DISTINCT CASE WHEN o.kind='return' THEN o.id END) AS returnCount,
                SUM(CASE WHEN o.kind='sale' THEN ol.line_total ELSE 0 END) AS sales, SUM(CASE WHEN o.kind='return' THEN ol.line_total ELSE 0 END) AS returns,
                SUM(CASE WHEN o.kind='sale' THEN ol.cost_amount ELSE -ol.cost_amount END) AS cogs
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id LEFT JOIN orders so ON so.id = o.original_order_id JOIN products pr ON pr.id = ol.product_id
          WHERE ${s.where} ${s.groupId != null ? `AND pr.group_id = ?` : ``} GROUP BY uid`,
      )
      .bind(...s.params, ...(s.groupId != null ? [s.groupId] : []))
      .all<any>()
  ).results;
  for (const r of lineRows) {
    const t = row(r.uid);
    t.cogs = r.cogs;
    if (s.groupId != null) Object.assign(t, { sales: r.sales, returns: r.returns, saleCount: r.saleCount, returnCount: r.returnCount });
  }
  const names = new Map((await db.prepare(`SELECT id, full_name FROM users`).all<any>()).results.map((u) => [u.id as number, u.full_name as string]));
  const items = [...rows.entries()]
    .map(([uid, t]) => {
      const revenue = t.sales - t.returns;
      return {
        sellerId: uid, sellerName: uid == null ? "Không rõ người bán" : names.get(uid) ?? `#${uid}`,
        saleCount: t.saleCount, sales: t.sales, returnCount: t.returnCount, returns: t.returns, revenue,
        avgOrder: t.saleCount ? Math.round(t.sales / t.saleCount) : 0,
        ...(withCost ? { cogs: t.cogs, grossProfit: revenue - t.cogs } : {}),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
  const sum = (k: "saleCount" | "sales" | "returnCount" | "returns" | "revenue") => items.reduce((t, i) => t + i[k], 0);
  const totals = { saleCount: sum("saleCount"), sales: sum("sales"), returnCount: sum("returnCount"), returns: sum("returns"), revenue: sum("revenue"),
    ...(withCost ? { cogs: items.reduce((t, i) => t + (i as any).cogs, 0), grossProfit: items.reduce((t, i) => t + (i as any).grossProfit, 0) } : {}) };
  return c.json({ from: s.from, to: s.to, channel: s.channel, groupId: s.groupId, basis: s.groupId != null ? "lines" : "orders", items, totals });
});

// ---------------------------------------------------------------- theo hàng hoá
salesReportRoutes.get("/reports/sales/products", requirePerm("reports.view"), async (c) => {
  const db = c.env.DB, s = scope(c), withCost = costOk(c);
  const lines = (
    await db
      .prepare(
        `SELECT ol.product_id AS productId, pr.sku, pr.name, pr.base_unit AS baseUnit, pg.name AS groupName,
                SUM(CASE WHEN o.kind='sale' THEN ol.qty_milli ELSE -ol.qty_milli END) AS qtyMilli,
                SUM(CASE WHEN o.kind='sale' THEN ol.line_total ELSE -ol.line_total END) AS revenue,
                SUM(CASE WHEN o.kind='sale' THEN ol.cost_amount ELSE -ol.cost_amount END) AS cogs
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products pr ON pr.id = ol.product_id LEFT JOIN product_groups pg ON pg.id = pr.group_id
          WHERE ${s.where} ${s.groupId != null ? `AND pr.group_id = ?` : ``} GROUP BY ol.product_id ORDER BY revenue DESC LIMIT ${LIMIT}`,
      )
      .bind(...s.params, ...(s.groupId != null ? [s.groupId] : []))
      .all<any>()
  ).results;
  const items = lines.map((r) => ({
    productId: r.productId, sku: r.sku, name: r.name, baseUnit: r.baseUnit, groupName: r.groupName, qtyMilli: r.qtyMilli, revenue: r.revenue,
    ...(withCost ? { cogs: r.cogs, grossProfit: r.revenue - r.cogs } : {}),
  }));
  // hàng còn bán nhưng không phát sinh đơn bán nào trong kỳ (kèm tồn kho để biết hàng nằm kho)
  const unsold = (
    await db
      .prepare(
        `SELECT p.id AS productId, p.sku, p.name, p.base_unit AS baseUnit, pg.name AS groupName,
                COALESCE((SELECT SUM(m.qty_delta_milli) FROM stock_moves m WHERE m.product_id = p.id), 0) AS onHandMilli
           FROM products p LEFT JOIN product_groups pg ON pg.id = p.group_id
          WHERE p.active = 1 AND p.merged_into IS NULL ${s.groupId != null ? `AND p.group_id = ?` : ``}
            AND NOT EXISTS (SELECT 1 FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.product_id = p.id AND o.kind = 'sale' AND ${s.where})
          ORDER BY onHandMilli DESC, p.name LIMIT ${LIMIT}`,
      )
      .bind(...(s.groupId != null ? [s.groupId] : []), ...s.params)
      .all<any>()
  ).results;
  return c.json({ from: s.from, to: s.to, channel: s.channel, groupId: s.groupId, items, unsold, totals: {
    qtyMilli: items.reduce((t, i) => t + i.qtyMilli, 0), revenue: items.reduce((t, i) => t + i.revenue, 0),
    ...(withCost ? { cogs: items.reduce((t, i) => t + (i as any).cogs, 0), grossProfit: items.reduce((t, i) => t + (i as any).grossProfit, 0) } : {}),
  } });
});

// ---------------------------------------------------------------- theo khách
salesReportRoutes.get("/reports/sales/customers", requirePerm("reports.view"), async (c) => {
  const db = c.env.DB, s = scope(c), role = c.get("user").role;
  const CUST = `COALESCE(so.customer_id, o.customer_id)`;
  const gjoin = s.groupId != null ? `JOIN order_lines ol ON ol.order_id = o.id JOIN products pr ON pr.id = ol.product_id AND pr.group_id = ?` : ``;
  const rev = s.groupId != null ? `ol.line_total` : `o.total`;
  const cnt = s.groupId != null ? `DISTINCT` : ``;
  const rows = (
    await db
      .prepare(
        `SELECT ${CUST} AS customerId, COUNT(${cnt} CASE WHEN o.kind='sale' THEN o.id END) AS orders, SUM(CASE WHEN o.kind='sale' THEN ${rev} ELSE 0 END) AS sales,
                COUNT(${cnt} CASE WHEN o.kind='return' THEN o.id END) AS returnCount, SUM(CASE WHEN o.kind='return' THEN ${rev} ELSE 0 END) AS returns,
                MAX(CASE WHEN o.kind='sale' THEN o.completed_at END) AS lastAt
           FROM orders o LEFT JOIN orders so ON so.id = o.original_order_id ${gjoin} WHERE ${s.where} GROUP BY customerId`,
      )
      .bind(...(s.groupId != null ? [s.groupId] : []), ...s.params)
      .all<any>()
  ).results;
  const info = new Map((await db.prepare(`SELECT id, code, name, phone, type FROM customers`).all<any>()).results.map((x) => [x.id as number, x]));
  const all = rows.map((r) => {
    const cu = r.customerId == null ? null : info.get(r.customerId);
    return { customerId: r.customerId as number | null, code: cu?.code ?? null, name: r.customerId == null ? "Khách lẻ (không lưu thông tin)" : cu?.name ?? `#${r.customerId}`,
      type: cu?.type ?? null, phone: cu ? maskPhone(cu.phone, role) : null, orders: r.orders, sales: r.sales, returns: r.returns, revenue: r.sales - r.returns, avgOrder: r.orders ? Math.round(r.sales / r.orders) : 0, lastAt: r.lastAt };
  });
  const walkIn = all.find((x) => x.customerId == null) ?? null;
  const items = all.filter((x) => x.customerId != null).sort((a, b) => b.revenue - a.revenue).slice(0, LIMIT);
  return c.json({ from: s.from, to: s.to, channel: s.channel, groupId: s.groupId, items, walkIn, totals: { revenue: all.reduce((t, i) => t + i.revenue, 0), customers: items.length } });
});

// ---------------------------------------------------------------- theo nhà cung cấp
salesReportRoutes.get("/reports/sales/suppliers", requirePerm("reports.view", "prices.view_cost"), async (c) => {
  const db = c.env.DB, s = scope(c), withDebt = can(c.get("user").role, "debt.view");
  const receipts = (
    await db
      .prepare(`SELECT supplier_id AS sid, COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS amount FROM stock_docs WHERE type='receipt' AND status='posted' AND supplier_id IS NOT NULL AND posted_at >= ? AND posted_at < ? GROUP BY supplier_id`)
      .bind(s.fromIso, s.toIso)
      .all<any>()
  ).results;
  const rets = (
    await db
      .prepare(`SELECT supplier_id AS sid, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM purchase_returns WHERE status='posted' AND posted_at >= ? AND posted_at < ? GROUP BY supplier_id`)
      .bind(s.fromIso, s.toIso)
      .all<any>()
  ).results;
  const sup = (await db.prepare(`SELECT id, code, name FROM suppliers ORDER BY name`).all<any>()).results;
  const rb = new Map(receipts.map((r) => [r.sid as number, r])), tb = new Map(rets.map((r) => [r.sid as number, r]));
  const debts = new Map<number, number>();
  if (withDebt) await Promise.all(sup.map(async (x) => debts.set(x.id, (await supplierDebtStatus(db, x.id)).balance)));
  const items = sup
    .map((x) => {
      const r = rb.get(x.id), t = tb.get(x.id);
      return { supplierId: x.id, code: x.code, name: x.name, receiptCount: r?.n ?? 0, purchased: r?.amount ?? 0, returnCount: t?.n ?? 0, returned: t?.amount ?? 0,
        netPurchased: (r?.amount ?? 0) - (t?.amount ?? 0), ...(withDebt ? { debt: debts.get(x.id) ?? 0 } : {}) };
    })
    .filter((x) => x.receiptCount || x.returnCount || ((x as any).debt ?? 0) !== 0)
    .sort((a, b) => b.netPurchased - a.netPurchased);
  return c.json({ from: s.from, to: s.to, items, totals: { receiptCount: items.reduce((t, i) => t + i.receiptCount, 0), purchased: items.reduce((t, i) => t + i.purchased, 0),
    returned: items.reduce((t, i) => t + i.returned, 0), netPurchased: items.reduce((t, i) => t + i.netPurchased, 0), ...(withDebt ? { debt: items.reduce((t, i) => t + ((i as any).debt ?? 0), 0) } : {}) } });
});
