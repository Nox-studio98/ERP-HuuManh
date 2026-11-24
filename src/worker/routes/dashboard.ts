import { Hono } from "hono";
import type { AppBindings } from "../env";
import { can } from "../lib/rbac";
import { vnDate, vnDayRangeUtc } from "../lib/time";
import { INVOICE_OUTSTANDING_SQL } from "../services/debt";

/**
 * GET /dashboard — tổng hợp "Tổng quan" trong MỘT lần gọi. Mỗi phần chỉ có mặt khi vai trò có quyền tương ứng
 * (không có quyền → khoá không xuất hiện trong JSON), tuyệt đối không trả giá vốn/lãi gộp/lương cho vai trò không được xem.
 */
export const dashboardRoutes = new Hono<AppBindings>();

const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

async function salesFor(db: D1Database, day: string, withCost: boolean) {
  const r = vnDayRangeUtc(day);
  const W = `o.status='completed' AND o.completed_at >= ? AND o.completed_at < ?`;
  const byChannel = (
    await db
      .prepare(
        `SELECT o.channel, SUM(CASE WHEN o.kind='sale' THEN 1 ELSE 0 END) AS orders,
                SUM(CASE WHEN o.kind='sale' THEN o.total ELSE -o.total END) AS revenue
           FROM orders o WHERE ${W} GROUP BY o.channel`,
      )
      .bind(r.from, r.to)
      .all<{ channel: string; orders: number; revenue: number }>()
  ).results;
  const t = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN o.kind='sale' THEN 1 ELSE 0 END),0) AS orders,
              COALESCE(SUM(CASE WHEN o.kind='sale' THEN o.total ELSE -o.total END),0) AS revenue,
              COALESCE(SUM(CASE WHEN o.kind='return' THEN o.total ELSE 0 END),0) AS returns
         FROM orders o WHERE ${W}`,
    )
    .bind(r.from, r.to)
    .first<{ orders: number; revenue: number; returns: number }>();
  let grossProfit: number | undefined;
  if (withCost) {
    const cg = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN o.kind='sale' THEN ol.cost_amount ELSE -ol.cost_amount END),0) AS cogs
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ${W}`,
      )
      .bind(r.from, r.to)
      .first<{ cogs: number }>();
    grossProfit = t!.revenue - cg!.cogs;
  }
  return { day, orders: t!.orders, revenue: t!.revenue, returns: t!.returns, byChannel, ...(withCost ? { grossProfit } : {}) };
}

dashboardRoutes.get("/dashboard", async (c) => {
  const db = c.env.DB;
  const role = c.get("user").role;
  const today = vnDate();
  const yesterday = addDays(today, -1);
  const out: Record<string, unknown> = { today, generatedAt: new Date().toISOString() };

  if (can(role, "orders.view")) {
    const withCost = can(role, "prices.view_cost") && can(role, "reports.view");
    const [t, y] = await Promise.all([salesFor(db, today, withCost), salesFor(db, yesterday, withCost)]);
    out.sales = { today: t, yesterday: y, canSeeCost: withCost };
    const from = addDays(today, -6);
    const { results } = await db
      .prepare(
        `SELECT substr(datetime(substr(o.completed_at,1,19), '+7 hours'),1,10) AS day,
                SUM(CASE WHEN o.kind='sale' THEN o.total ELSE -o.total END) AS revenue, SUM(CASE WHEN o.kind='sale' THEN 1 ELSE 0 END) AS orders
           FROM orders o WHERE o.status='completed' AND o.completed_at >= ? AND o.completed_at < ? GROUP BY day`,
      )
      .bind(vnDayRangeUtc(from).from, vnDayRangeUtc(today).to)
      .all<{ day: string; revenue: number; orders: number }>();
    const m = new Map(results.map((r) => [r.day, r]));
    out.series7d = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(from, i);
      return { day: d, revenue: m.get(d)?.revenue ?? 0, orders: m.get(d)?.orders ?? 0 };
    });
  }

  const todo: Record<string, unknown> = {};
  if (can(role, "approvals.decide")) {
    todo.approvalsPending = (await db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status='pending'`).first<{ n: number }>())!.n;
  }
  if (can(role, "orders.online.manage")) {
    todo.onlinePending = (await db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE channel='online' AND kind='sale' AND status='new'`).first<{ n: number }>())!.n;
  }
  if (can(role, "b2b.view")) {
    const r = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN delivery_date = ?1 THEN 1 ELSE 0 END),0) AS due_today, COALESCE(SUM(CASE WHEN delivery_date < ?1 THEN 1 ELSE 0 END),0) AS late
           FROM orders WHERE channel='b2b' AND kind='sale' AND status IN ('confirmed','preparing') AND delivery_date IS NOT NULL AND delivery_date <= ?1`,
      )
      .bind(today)
      .first<{ due_today: number; late: number }>();
    todo.b2bDeliveries = { dueToday: r!.due_today, late: r!.late };
  }
  if (can(role, "inventory.view")) {
    const nowIso = new Date().toISOString();
    const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
    const low = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT p.id, p.min_stock_milli AS mn,
            COALESCE((SELECT SUM(l.qty_on_hand_milli) FROM lots l WHERE l.product_id = p.id AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at > ?1)), 0) AS onhand
           FROM products p WHERE p.active = 1 AND p.min_stock_milli > 0 AND p.merged_into IS NULL) WHERE onhand < mn`,
      )
      .bind(nowIso)
      .first<{ n: number }>();
    const exp = await db
      .prepare(`SELECT COUNT(*) AS n FROM lots WHERE qty_on_hand_milli > 0 AND status='active' AND expires_at IS NOT NULL AND expires_at > ?1 AND expires_at <= ?2`)
      .bind(nowIso, soon)
      .first<{ n: number }>();
    todo.stock = { lowStock: low!.n, expiringSoon: exp!.n };
  }
  if (can(role, "debt.view")) {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(os),0) AS amount FROM (
           SELECT ${INVOICE_OUTSTANDING_SQL} AS os, i.due_date AS due FROM invoices i WHERE i.kind <> 'adjustment' AND i.status = 'open'
         ) WHERE os > 0 AND due < ?`,
      )
      .bind(today)
      .first<{ n: number; amount: number }>();
    todo.overdueDebt = { invoices: r!.n, amount: r!.amount };
  }
  if (can(role, "hr.schedule")) {
    const a = await db.prepare(`SELECT COUNT(*) AS n FROM attendance_corrections WHERE status='pending'`).first<{ n: number }>();
    const b = await db.prepare(`SELECT COUNT(*) AS n FROM attendance_punches WHERE status='pending' OR review_flag = 1`).first<{ n: number }>();
    todo.attendanceReview = { corrections: a!.n, punches: b!.n };
  }
  out.todo = todo;
  return c.json(out);
});
