import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { vnDate, vnDayRangeUtc, vnPeriod } from "../lib/time";
import { parseBody, guarded } from "../services/http";
import { cashFlow, pnlAdjustments, pnlByChannel, revenueByChannel, shrinkage, voucherCosts } from "../services/finance-reports";

export const financeExtraRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CHANNELS = ["pos", "online", "b2b", "fresco", "social"];

function range(c: Ctx) {
  const today = vnDate();
  const from = c.req.query("from") ?? today;
  const to = c.req.query("to") ?? from;
  const valid = (d: string) => DAY_RE.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z"));
  if (!valid(from) || !valid(to)) throw new AppError(422, "validation_error", "from/to phải có dạng YYYY-MM-DD");
  if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
  return { from, to, fromIso: vnDayRangeUtc(from).from, toIso: vnDayRangeUtc(to).to };
}

function periodParam(v: string | undefined) {
  const p = v ?? vnPeriod();
  if (!PERIOD_RE.test(p)) throw new AppError(422, "validation_error", "period phải có dạng YYYY-MM");
  return p;
}

/** [from, to) UTC của một tháng giờ Việt Nam. */
function monthRange(period: string) {
  const [y, m] = period.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { fromIso: vnDayRangeUtc(`${period}-01`).from, toIso: vnDayRangeUtc(`${next}-01`).from };
}

// ===================== M6-07 Dòng tiền =====================

financeExtraRoutes.get("/reports/cash-flow", requirePerm("reports.view"), async (c) => {
  const { from, to, fromIso, toIso } = range(c);
  const fundQ = c.req.query("fundId");
  const fundId = fundQ ? Number(fundQ) : null;
  if (fundQ && !Number.isInteger(fundId)) throw new AppError(422, "validation_error", "fundId không hợp lệ");
  return c.json({ from, to, ...(await cashFlow(c.env.DB, fromIso, toIso, fundId)) });
});

// ===================== M6-06 Lãi lỗ theo kênh =====================

financeExtraRoutes.get("/reports/pnl-by-channel", requirePerm("reports.view"), async (c) => {
  const { from, to, fromIso, toIso } = range(c);
  return c.json(await pnlByChannel(c.env.DB, from, to, fromIso, toIso));
});

financeExtraRoutes.get("/cost-allocation-rules", requirePerm("finance.write"), async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT r.*, cc.name AS category_name, cc.code AS category_code FROM cost_allocation_rules r JOIN cash_categories cc ON cc.id = r.category_id ORDER BY r.id`)
    .all<any>();
  return c.json({
    items: results.map((r) => ({
      id: r.id, categoryId: r.category_id, categoryCode: r.category_code, categoryName: r.category_name, method: r.method,
      weights: r.weights_json ? JSON.parse(r.weights_json) : null, active: !!r.active,
    })),
  });
});

financeExtraRoutes.put("/cost-allocation-rules", requirePerm("finance.write"), async (c) => {
  const b = await parseBody(c, z.object({
    rules: z.array(z.object({
      categoryId: z.number().int().positive(),
      method: z.enum(["revenue_share", "fixed_bp"]),
      weights: z.record(z.string(), z.number().int().min(0).max(10000)).optional(),
      active: z.boolean().default(true),
    })).max(100),
  }));
  const db = c.env.DB;
  for (const r of b.rules) {
    if (r.method === "fixed_bp") {
      const w = r.weights ?? {};
      if (Object.keys(w).some((k) => !CHANNELS.includes(k))) throw new AppError(422, "validation_error", "weights chỉ nhận các kênh pos/online/b2b/fresco/social");
      if (Object.values(w).reduce((s, x) => s + x, 0) !== 10000) throw new AppError(422, "weights_not_100", "Tổng tỉ lệ phân bổ phải bằng 10000 (100%)", { categoryId: r.categoryId });
    }
  }
  await guarded(() =>
    db.batch([
      db.prepare(`DELETE FROM cost_allocation_rules`),
      ...b.rules.map((r) =>
        db
          .prepare(`INSERT INTO cost_allocation_rules(category_id, method, weights_json, active) VALUES (?,?,?,?)`)
          .bind(r.categoryId, r.method, r.method === "fixed_bp" ? JSON.stringify(r.weights ?? {}) : null, r.active ? 1 : 0),
      ),
      auditStmt(c, { action: "finance.allocation_rules", entity: "cost_allocation_rules", after: { count: b.rules.length } }),
    ]),
  );
  return c.json({ count: b.rules.length });
});

// ===================== M6-08 Thuế GTGT =====================

financeExtraRoutes.get("/reports/vat", requirePerm("reports.view"), async (c) => {
  const period = periodParam(c.req.query("period"));
  const db = c.env.DB;
  const byRate = (
    await db
      .prepare(
        `SELECT vat_rate_bp AS rateBp, COUNT(*) AS count, SUM(subtotal) AS base, SUM(vat_amount) AS vat
           FROM invoices WHERE status <> 'cancelled' AND is_opening = 0 AND substr(issue_date,1,7) = ?
            AND NOT EXISTS (SELECT 1 FROM orders po WHERE po.id = invoices.order_id AND po.channel = 'pos')
          GROUP BY vat_rate_bp ORDER BY vat_rate_bp`,
      )
      .bind(period)
      .all<{ rateBp: number; count: number; base: number; vat: number }>()
  ).results;
  const inp = await db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(vat_amount),0) AS vat FROM supplier_bills WHERE status <> 'cancelled' AND is_opening = 0 AND substr(issue_date,1,7) = ?`)
    .bind(period)
    .first<{ count: number; total: number; vat: number }>();
  const outVat = byRate.reduce((s, r) => s + r.vat, 0);
  return c.json({
    period,
    output: { count: byRate.reduce((s, r) => s + r.count, 0), base: byRate.reduce((s, r) => s + r.base, 0), vat: outVat, byRate },
    input: { count: inp!.count, total: inp!.total, vat: inp!.vat },
    payable: outVat - inp!.vat,
    notice: "[Cần xác nhận hình thức kinh doanh] Số liệu tham khảo từ hoá đơn bán B2B và hoá đơn mua đã ghi nhận (không gồm số dư đầu kỳ, doanh thu bán lẻ POS/online và hoá đơn phải thu nội bộ sinh từ ghi nợ POS, kể cả hoá đơn điều chỉnh khi huỷ/trả); thuế phải nộp thực tế theo hình thức kê khai của cửa hàng.",
  });
});

// ===================== M6-10 Ngân sách =====================

const BUDGET_LINES = ["revenue", "cogs", "opex", "payroll", "shrinkage", "other"] as const;

async function budgetRows(db: D1Database, period: string) {
  return (
    await db
      .prepare(
        `SELECT b.id, b.period, b.category_id, b.line, b.amount, b.note, cc.code AS category_code, cc.name AS category_name, cc.direction
           FROM budgets b LEFT JOIN cash_categories cc ON cc.id = b.category_id WHERE b.period = ? ORDER BY b.id`,
      )
      .bind(period)
      .all<any>()
  ).results;
}

financeExtraRoutes.get("/budgets", requirePerm("finance.view"), async (c) => {
  const period = periodParam(c.req.query("period"));
  const rows = await budgetRows(c.env.DB, period);
  return c.json({
    period,
    items: rows.map((r) => ({ id: r.id, categoryId: r.category_id, categoryCode: r.category_code, categoryName: r.category_name, line: r.line, amount: r.amount, note: r.note })),
  });
});

financeExtraRoutes.put("/budgets", requirePerm("finance.write"), async (c) => {
  const b = await parseBody(c, z.object({
    period: z.string().regex(PERIOD_RE),
    items: z.array(z.object({
      categoryId: z.number().int().positive().optional(),
      line: z.enum(BUDGET_LINES).optional(),
      amount: z.number().int().min(0),
      note: z.string().max(200).optional(),
    }).refine((x) => (x.categoryId == null) !== (x.line == null), { message: "Mỗi dòng ngân sách cần đúng một trong categoryId / line" })).max(200),
  }));
  const db = c.env.DB;
  const seen = new Set<string>();
  for (const i of b.items) {
    const k = i.categoryId != null ? `c${i.categoryId}` : `l${i.line}`;
    if (seen.has(k)) throw new AppError(422, "duplicate_budget_line", "Ngân sách bị trùng dòng", { key: k });
    seen.add(k);
  }
  const user = c.get("user");
  await guarded(() =>
    db.batch([
      db.prepare(`DELETE FROM budgets WHERE period = ?`).bind(b.period),
      ...b.items.map((i) =>
        db.prepare(`INSERT INTO budgets(period, category_id, line, amount, note, created_by) VALUES (?,?,?,?,?,?)`).bind(b.period, i.categoryId ?? null, i.line ?? null, i.amount, i.note ?? null, user.id),
      ),
      auditStmt(c, { action: "finance.budget_set", entity: "budgets", entityId: b.period, after: { count: b.items.length } }),
    ]),
  );
  const rows = await budgetRows(db, b.period);
  return c.json({
    period: b.period,
    items: rows.map((r) => ({ id: r.id, categoryId: r.category_id, categoryCode: r.category_code, categoryName: r.category_name, line: r.line, amount: r.amount, note: r.note })),
  });
});

financeExtraRoutes.get("/reports/budget-vs-actual", requirePerm("reports.view"), async (c) => {
  const period = periodParam(c.req.query("period"));
  const db = c.env.DB;
  const { fromIso, toIso } = monthRange(period);
  const rows = await budgetRows(db, period);
  const { rev, cogs } = await revenueByChannel(db, fromIso, toIso);
  const costs = await voucherCosts(db, fromIso, toIso);
  const shrink = await shrinkage(db, fromIso, toIso);
  const lineActual: Record<string, number> = {
    revenue: rev.reduce((s, r) => s + (r.revenue ?? 0), 0),
    cogs: cogs.reduce((s, r) => s + (r.cogs ?? 0), 0),
  };
  for (const r of costs) lineActual[r.line] = (lineActual[r.line] ?? 0) + r.amount;
  if (shrink) lineActual.shrinkage = (lineActual.shrinkage ?? 0) + shrink;
  // Chênh lệch kiểm kê/điều chỉnh tồn tính vào dòng hao hụt như /reports/pnl (giảm = chi phí, tăng = giảm chi phí)
  const adj = await pnlAdjustments(db, fromIso, toIso);
  const { stockCount, internalUse } = adj;
  // PA-8: khớp /reports/pnl cùng kỳ — chiết khấu thanh toán giảm doanh thu; xoá nợ khó đòi và chênh lệch giá mua là chi phí khác
  if (adj.paymentDiscount) lineActual.revenue -= adj.paymentDiscount;
  if (adj.badDebt) lineActual.other = (lineActual.other ?? 0) + adj.badDebt;
  if (adj.purchaseVariance) lineActual.other = (lineActual.other ?? 0) + adj.purchaseVariance;
  if (stockCount) lineActual.shrinkage = (lineActual.shrinkage ?? 0) + stockCount;
  // Xuất dùng nội bộ là chi phí vận hành (giá vốn lô) như trên /reports/pnl
  if (internalUse) lineActual.opex = (lineActual.opex ?? 0) + internalUse;
  lineActual.stockCount = stockCount;
  lineActual.badDebt = adj.badDebt;
  lineActual.purchaseVariance = adj.purchaseVariance;
  lineActual.paymentDiscount = adj.paymentDiscount;

  const catAct = (
    await db
      .prepare(
        `SELECT v.category_id AS id, cc.direction,
                SUM(CASE WHEN v.direction = cc.direction THEN v.amount ELSE 0 END) - SUM(CASE WHEN v.direction <> cc.direction AND v.reverses_id IS NOT NULL THEN v.amount ELSE 0 END) AS amount
           FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id
          WHERE v.status='posted' AND v.created_at >= ? AND v.created_at < ? GROUP BY v.category_id`,
      )
      .bind(fromIso, toIso)
      .all<{ id: number; amount: number }>()
  ).results;
  const items = rows.map((r) => {
    const actual = r.category_id != null ? catAct.find((x) => x.id === r.category_id)?.amount ?? 0 : lineActual[r.line] ?? 0;
    const variance = actual - r.amount;
    return {
      id: r.id, categoryId: r.category_id, categoryName: r.category_name, line: r.line, budget: r.amount, actual, variance,
      variancePct: r.amount > 0 ? Math.round((variance * 10000) / r.amount) / 100 : null,
    };
  });
  return c.json({ period, items, lineActuals: lineActual });
});
