import { valueSql } from "../lib/sqlmoney";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings } from "../env";
import { requirePerm, can } from "../lib/rbac";
import { AppError, notFound } from "../lib/errors";
import { vnDate, vnDayRangeUtc } from "../lib/time";
import { salesSummary } from "../services/salesreport";
import { pnlAdjustments } from "../services/finance-reports";
import { renderPnlPdf } from "../services/report-pdf";
import { audit } from "../lib/audit";

export const reportRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayParam(v: string | undefined, def: string, name: string) {
  const d = v ?? def;
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!DAY_RE.test(d) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d) {
    throw new AppError(422, "validation_error", `${name} phải là ngày hợp lệ dạng YYYY-MM-DD`);
  }
  return d;
}
function range(c: Ctx) {
  const today = vnDate();
  const from = dayParam(c.req.query("from"), today, "from");
  const to = dayParam(c.req.query("to"), from, "to");
  if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
  return { from, to, fromIso: vnDayRangeUtc(from).from, toIso: vnDayRangeUtc(to).to };
}

/** Phát biểu P&L; tiền hoàn trả hàng không nhập kho (restock=false) tính vào hao hụt, không vào giá vốn. */
async function pnl(c: Ctx) {
  const db = c.env.DB;
  const { from, to, fromIso, toIso } = range(c);
  const groupBy = c.req.query("groupBy");
  const W = `o.status='completed' AND o.completed_at >= ? AND o.completed_at < ?`;
  const p = [fromIso, toIso];

  const rev = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN o.kind='sale' THEN o.total ELSE 0 END),0) AS sales,
              COALESCE(SUM(CASE WHEN o.kind='return' THEN o.total ELSE 0 END),0) AS returns
         FROM orders o WHERE ${W}`,
    )
    .bind(...p)
    .first<{ sales: number; returns: number }>();
  const cost = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN o.kind='sale' THEN ol.cost_amount ELSE -ol.cost_amount END),0) AS cogs,
              COALESCE(SUM(CASE WHEN o.kind='return' AND NOT EXISTS (SELECT 1 FROM order_line_lots x WHERE x.order_line_id = ol.id)
                                THEN ol.cost_amount ELSE 0 END),0) AS discarded
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ${W}`,
    )
    .bind(...p)
    .first<{ cogs: number; discarded: number }>();
  const exp = (
    await db
      .prepare(
        `SELECT COALESCE(cc.pnl_line,'other') AS line,
                SUM(CASE WHEN v.direction='out' THEN v.amount WHEN v.reverses_id IS NOT NULL THEN -v.amount ELSE 0 END) AS amount
           FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id
          WHERE v.status='posted' AND v.created_at >= ? AND v.created_at < ?
            AND cc.direction = 'out' AND COALESCE(cc.pnl_line,'other') NOT IN ('cogs','revenue','transfer','other_income')
          GROUP BY line`,
      )
      .bind(...p)
      .all<{ line: string; amount: number }>()
  ).results;
  const waste = await db
    .prepare(
      `SELECT COALESCE(SUM(-${valueSql('qty_delta_milli','unit_cost')}),0) AS v FROM stock_moves WHERE move_type='waste' AND at >= ? AND at < ?`,
    )
    .bind(...p)
    .first<{ v: number }>();

  const expenses: Record<string, number> = {};
  for (const e of exp) expenses[e.line] = (expenses[e.line] ?? 0) + (e.amount ?? 0);
  const shrink = Math.round(waste!.v) + cost!.discarded;
  if (shrink) expenses.shrinkage = (expenses.shrinkage ?? 0) + shrink;
  // A-04/B-06/B-13: xoá nợ, chiết khấu thanh toán, cọc không hoàn, chênh lệch kiểm kê, chênh lệch đối soát thừa
  const adj = await pnlAdjustments(db, fromIso, toIso);
  if (adj.badDebt) expenses.badDebt = (expenses.badDebt ?? 0) + adj.badDebt;
  if (adj.stockCount) expenses.stockCount = (expenses.stockCount ?? 0) + adj.stockCount;
  if (adj.purchaseVariance) expenses.purchaseVariance = (expenses.purchaseVariance ?? 0) + adj.purchaseVariance; // B-09
  const otherIncome = {
    forfeitedDeposits: adj.forfeitedDeposits,
    payableDiscounts: adj.payableIncome,
    settlementSurplus: adj.voucherIncome,
    otherReceipts: adj.otherReceipts,
    total: adj.forfeitedDeposits + adj.payableIncome + adj.voucherIncome + adj.otherReceipts,
  };
  const revenueDeductions = { paymentDiscount: adj.paymentDiscount };
  const revenue = rev!.sales - rev!.returns;
  const cogs = cost!.cogs;
  const grossProfit = revenue - cogs;
  const totalExpenses = Object.values(expenses).reduce((s, x) => s + x, 0);

  let breakdown: unknown[] | undefined;
  if (groupBy) {
    const keyExpr =
      groupBy === "day" ? `date(datetime(o.completed_at,'+7 hours'))`
      : groupBy === "channel" ? `o.channel`
      : groupBy === "group" ? `COALESCE(pg.name,'Khác')`
      : null;
    if (!keyExpr) throw new AppError(422, "validation_error", "groupBy phải là day, channel hoặc group");
    const rows = (
      await db
        .prepare(
          `SELECT ${keyExpr} AS key,
                  SUM(CASE WHEN o.kind='sale' THEN ol.line_total ELSE -ol.line_total END) AS revenue,
                  SUM(CASE WHEN o.kind='sale' THEN ol.cost_amount ELSE -ol.cost_amount END) AS cogs
             FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products pr ON pr.id = ol.product_id
             LEFT JOIN product_groups pg ON pg.id = pr.group_id
            WHERE ${W} GROUP BY key ORDER BY key`,
        )
        .bind(...p)
        .all<{ key: string; revenue: number; cogs: number }>()
    ).results.map((r) => ({ ...r, shipping: 0 }));
    // A-08: dòng đơn online mang giảm giá đã phân bổ; phí giao hàng (doanh thu cấp đơn) báo riêng để tổng breakdown = doanh thu tổng
    const SHIP = `CASE WHEN o.kind='sale' THEN o.shipping_fee WHEN o.channel IN ('online','social') THEN o.total - o.subtotal ELSE 0 END`;
    if (groupBy === "group") {
      const sh = (await db.prepare(`SELECT COALESCE(SUM(${SHIP}),0) AS s FROM orders o WHERE ${W}`).bind(...p).first<{ s: number }>())!.s;
      if (sh) rows.push({ key: "Phí giao hàng", revenue: sh, cogs: 0, shipping: sh });
    } else {
      const ship = (await db.prepare(`SELECT ${keyExpr} AS key, COALESCE(SUM(${SHIP}),0) AS s FROM orders o WHERE ${W} GROUP BY key`).bind(...p).all<{ key: string; s: number }>()).results;
      for (const x of ship) {
        const r = rows.find((y) => y.key === x.key);
        if (!r || !x.s) continue;
        r.shipping = x.s;
        r.revenue += x.s;
      }
    }
    breakdown = rows.map((r) => ({ ...r, grossProfit: r.revenue - r.cogs }));
  }
  return {
    from, to,
    salesTotal: rev!.sales,
    returnsTotal: rev!.returns,
    revenue,
    cogs,
    grossProfit,
    expenses,
    totalExpenses,
    revenueDeductions,
    otherIncome,
    netProfit: grossProfit - revenueDeductions.paymentDiscount - totalExpenses + otherIncome.total,
    ...(breakdown ? { groupBy, breakdown } : {}),
  };
}

const EXP_NAMES: Record<string, string> = { opex: "Chi phí vận hành", payroll: "Lương", shrinkage: "Hao hụt", other: "Khác", badDebt: "Xoá nợ khó đòi", stockCount: "Chênh lệch kiểm kê", purchaseVariance: "Chênh lệch giá mua" };
reportRoutes.get("/reports/pnl", requirePerm("reports.view"), async (c) => c.json(await pnl(c)));
// C-28: PDF lãi lỗ — cùng quyền và cùng số liệu với màn xem
reportRoutes.get("/reports/pnl.pdf", requirePerm("reports.view"), async (c) => {
  const p = await pnl(c);
  const bytes = await renderPnlPdf(c.env, p);
  await audit(c, { action: "export.pnl.pdf", entity: "export", entityId: "pnl", after: { from: p.from, to: p.to } });
  return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="lai-lo_${p.from}_${p.to}.pdf"`, "cache-control": "no-store" } });
});

async function inventoryReport(c: Ctx) {
  const db = c.env.DB;
  const asOf = dayParam(c.req.query("asOf"), vnDate(), "asOf");
  const from = c.req.query("from") ? dayParam(c.req.query("from"), "", "from") : null;
  const end = vnDayRangeUtc(asOf).to;
  const start = from ? vnDayRangeUtc(from).from : "0000";
  const { results } = await db
    .prepare(
      `SELECT p.id AS productId, p.sku, p.name, p.base_unit AS baseUnit,
         COALESCE(SUM(CASE WHEN m.at < ?1 THEN m.qty_delta_milli END),0) AS openingMilli,
         COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type IN ('receipt','transfer_in') THEN m.qty_delta_milli END),0) AS inMilli,
         COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type='sale' THEN -m.qty_delta_milli END),0) AS soldMilli,
         COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type='return' THEN m.qty_delta_milli END),0) AS returnedMilli,
         COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type='waste' THEN -m.qty_delta_milli END),0) AS wasteMilli,
         COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type IN ('assemble_in','assemble_out') THEN m.qty_delta_milli END),0) AS assembleMilli,
         -- B-14: mọi loại biến động còn lại (điều chỉnh, kiểm kê, xuất chuyển...) để Tồn đầu + Nhập − Bán + Trả − Hao hụt + Lắp ráp + Điều chỉnh = Tồn cuối
         COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type NOT IN ('receipt','transfer_in','sale','return','waste','assemble_in','assemble_out') THEN m.qty_delta_milli END),0) AS adjustMilli,
         COALESCE(SUM(m.qty_delta_milli),0) AS onHandMilli,
         COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type='waste' THEN -${valueSql('m.qty_delta_milli','m.unit_cost')} END),0) AS wasteValue,
         COALESCE(SUM(${valueSql('m.qty_delta_milli','m.unit_cost')}),0) AS stockValue
         FROM products p JOIN stock_moves m ON (m.product_id = p.id OR m.product_id IN (SELECT id FROM products WHERE merged_into = p.id)) AND m.at < ?2
        WHERE p.merged_into IS NULL
        GROUP BY p.id ORDER BY p.name`,
    )
    .bind(start, end)
    .all<any>();
  return { asOf, from, items: results };
}
reportRoutes.get("/reports/inventory", requirePerm("reports.view"), async (c) => c.json(await inventoryReport(c)));

async function dailyReport(c: Ctx) {
  const db = c.env.DB;
  const day = dayParam(c.req.query("day"), vnDate(), "day");
  const r = vnDayRangeUtc(day);
  const summary = await salesSummary(db, `o.completed_at >= ? AND o.completed_at < ?`, [r.from, r.to]);
  const vouchers = (
    await db
      .prepare(
        `SELECT direction, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM cash_vouchers
          WHERE status='posted' AND created_at >= ? AND created_at < ? GROUP BY direction`,
      )
      .bind(r.from, r.to)
      .all()
  ).results;
  const shifts = (
    await db
      .prepare(
        `SELECT s.id, s.user_id, u.full_name AS cashier_name, s.status, s.opening_cash, s.expected_cash, s.counted_cash, s.diff_cash, s.diff_reason
           FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.opened_at >= ? AND s.opened_at < ?`,
      )
      .bind(r.from, r.to)
      .all()
  ).results;
  const voided = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM orders WHERE kind='sale' AND status='cancelled' AND voided_by IS NOT NULL AND created_at >= ? AND created_at < ?`)
    .bind(r.from, r.to)
    .first();
  return { day, ...summary, vouchers, shifts, voided };
}
reportRoutes.get("/reports/daily", requirePerm("reports.view"), async (c) => c.json(await dailyReport(c)));

// ===== CSV (UTF-8 BOM cho Excel) =====
const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // chống CSV injection
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
const toCsv = (header: string[], rows: unknown[][]) => "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

reportRoutes.get("/reports/export/:file", requirePerm("reports.view"), async (c) => {
  const file = c.req.param("file");
  if (!file.endsWith(".csv")) throw notFound();
  const name = file.slice(0, -4);
  let csv: string;
  if (name === "pnl") {
    const r = await pnl(c);
    csv = toCsv(["Chỉ tiêu", "Số tiền (VND)"], [
      ["Doanh thu bán", r.salesTotal], ["Trả hàng", r.returnsTotal], ["Doanh thu thuần", r.revenue], ["Giá vốn", r.cogs], ["Lãi gộp", r.grossProfit],
      ["Chiết khấu thanh toán", r.revenueDeductions.paymentDiscount],
      ...Object.entries(r.expenses).map(([k, v]) => [`Chi phí - ${EXP_NAMES[k] ?? k}`, v]), ["Tổng chi phí", r.totalExpenses],
      ["Cọc không hoàn", r.otherIncome.forfeitedDeposits], ["Chiết khấu/xoá nợ nhà cung cấp", r.otherIncome.payableDiscounts], ["Chênh lệch đối soát thừa", r.otherIncome.settlementSurplus], ["Thu khác (phiếu thu)", r.otherIncome.otherReceipts], ["Lợi nhuận", r.netProfit],
    ]);
  } else if (name === "inventory") {
    const r = await inventoryReport(c);
    csv = toCsv(["Mã", "Tên", "ĐVT", "Tồn đầu (milli)", "Nhập", "Bán", "Trả", "Hao hụt", "Điều chỉnh", "Tồn cuối (milli)", "Giá trị tồn"],
      r.items.map((i: any) => [i.sku, i.name, i.baseUnit, i.openingMilli, i.inMilli, i.soldMilli, i.returnedMilli, i.wasteMilli, i.adjustMilli, i.onHandMilli, i.stockValue]));
  } else if (name === "daily") {
    const r = await dailyReport(c);
    csv = toCsv(["Ngày", "Số đơn", "Doanh thu bán", "Trả hàng", "Doanh thu thuần"], [[r.day, r.saleCount, r.saleTotal, r.returnTotal, r.revenue]]);
  } else if (name === "orders") {
    const { from, toIso, fromIso } = range(c);
    const { results } = await c.env.DB
      .prepare(`SELECT code, kind, channel, status, total, discount, completed_at FROM orders WHERE status='completed' AND completed_at >= ? AND completed_at < ? ORDER BY id`)
      .bind(fromIso, toIso)
      .all<any>();
    void from;
    csv = toCsv(["Mã", "Loại", "Kênh", "Trạng thái", "Tổng", "Giảm giá", "Hoàn tất lúc"], results.map((o) => [o.code, o.kind, o.channel, o.status, o.total, o.discount, o.completed_at]));
  } else throw notFound("report_not_found", "Không có báo cáo này");
  void can;
  return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` });
});
