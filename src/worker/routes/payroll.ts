import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { audit, auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDayRangeUtc, vnPeriod } from "../lib/time";
import { parseBody } from "../services/http";
import { buildXlsx, XLSX_MIME } from "../services/xlsx";
import { calculatePayslip, loadPayrollSettings, type PayslipInput, type TimesheetDayInput } from "../services/payroll-calc";

/** Lương (M9): tính, duyệt, chi, phiếu lương, tạm ứng, báo cáo chi phí. Công thức ở services/payroll-calc.ts. */
export const payrollRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function periodParam(p: string | undefined) {
  if (!p || !PERIOD_RE.test(p)) throw new AppError(422, "validation_error", "Kỳ phải có dạng YYYY-MM");
  return p;
}
const addMonth = (p: string, n: number) => {
  const [y, m] = p.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
function periodDates(p: string) {
  const first = `${p}-01`;
  const next = `${addMonth(p, 1)}-01`;
  const last = new Date(Date.parse(next + "T00:00:00Z") - 86400_000).toISOString().slice(0, 10);
  return { first, last, fromIso: vnDayRangeUtc(first).from, toIso: vnDayRangeUtc(next).from };
}
const mapLocked = (e: unknown) => {
  if (String((e as Error)?.message ?? "").includes("payroll_locked")) return conflict("payroll_locked", "Kỳ lương đã duyệt/đã chi, không được sửa");
  return e;
};

async function getPeriodRow(db: D1Database, period: string) {
  return db.prepare(`SELECT * FROM payroll_periods WHERE period = ?`).bind(period).first<any>();
}
const viewAudit = (c: Ctx, what: string, extra?: unknown) => audit(c, { action: "payroll.view", entity: "payroll", entityId: what, after: extra });

// ---------------------------------------------------------------- danh sách kỳ
payrollRoutes.get("/payroll/periods", requirePerm("hr.sensitive"), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM payroll_items i WHERE i.payroll_period_id = p.id) AS employee_count FROM payroll_periods p ORDER BY p.period DESC`,
    )
    .all<any>();
  await viewAudit(c, "periods");
  return c.json({
    items: results.map((p) => ({
      period: p.period, status: p.status, employeeCount: p.employee_count, totalNet: p.total_net, totalCost: p.total_cost,
      calculatedAt: p.calculated_at, approvedAt: p.approved_at, paidAt: p.paid_at,
    })),
    nextCursor: null,
  });
});

// ---------------------------------------------------------------- tính lương
async function calculatePeriod(c: Ctx, period: string) {
  const db = c.env.DB;
  const user = c.get("user");
  const ts = await db.prepare(`SELECT status FROM timesheets WHERE period = ?`).bind(period).first<{ status: string }>();
  if (!ts || ts.status !== "closed") throw conflict("timesheet_open", "Bảng công kỳ này chưa chốt");
  let pp = await getPeriodRow(db, period);
  if (pp && (pp.status === "approved" || pp.status === "paid")) throw conflict("payroll_locked", "Kỳ lương đã duyệt/đã chi, không được tính lại");
  if (!pp) {
    await db.prepare(`INSERT OR IGNORE INTO payroll_periods(period, status) VALUES (?, 'draft')`).bind(period).run();
    pp = await getPeriodRow(db, period);
  }
  const { first, last, fromIso, toIso } = periodDates(period);
  const settings = await loadPayrollSettings(db);

  const emps = (
    await db
      .prepare(`SELECT * FROM employees WHERE hire_date <= ? AND (termination_date IS NULL OR termination_date >= ?) ORDER BY id`)
      .bind(last, first)
      .all<any>()
  ).results;

  const days = (await db.prepare(`SELECT * FROM timesheet_days WHERE period = ?`).bind(period).all<any>()).results;
  const adjs = (await db.prepare(`SELECT employee_id, kind, SUM(minutes) AS m FROM timesheet_adjustments WHERE target_period = ? GROUP BY employee_id, kind`).bind(period).all<any>()).results;
  const allw = (await db.prepare(`SELECT * FROM employee_allowances WHERE active = 1`).all<any>()).results;
  const entries = (await db.prepare(`SELECT * FROM payroll_entries WHERE period = ? ORDER BY id`).bind(period).all<any>()).results;
  const advs = (await db.prepare(`SELECT * FROM salary_advances WHERE deduct_period = ? AND status = 'paid' ORDER BY id`).bind(period).all<any>()).results;
  const sales = (
    await db
      .prepare(
        `SELECT created_by AS uid, SUM(total) AS t FROM orders WHERE kind='sale' AND status='completed' AND channel='pos' AND created_by IS NOT NULL
            AND completed_at >= ? AND completed_at < ? GROUP BY created_by`,
      )
      .bind(fromIso, toIso)
      .all<any>()
  ).results;
  const returns = (
    await db
      .prepare(
        `SELECT so.created_by AS uid, SUM(ABS(r.total)) AS t FROM orders r JOIN orders so ON so.id = r.original_order_id
          WHERE r.kind='return' AND r.status='completed' AND so.created_by IS NOT NULL AND r.completed_at >= ? AND r.completed_at < ? GROUP BY so.created_by`,
      )
      .bind(fromIso, toIso)
      .all<any>()
  ).results;
  const salesBy = new Map<number, number>();
  for (const s of sales) salesBy.set(s.uid, (salesBy.get(s.uid) ?? 0) + s.t);
  for (const r of returns) salesBy.set(r.uid, (salesBy.get(r.uid) ?? 0) - r.t);

  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM payroll_items WHERE payroll_period_id = ?`).bind(pp.id),
  ];
  let totalNet = 0;
  let totalCost = 0;
  for (const e of emps) {
    const myDays: TimesheetDayInput[] = days
      .filter((d) => d.employee_id === e.id)
      .map((d) => ({
        workDate: d.work_date, workedMinutes: d.worked_minutes, overtimeMinutes: d.overtime_minutes, overtimeMultiplierBp: d.overtime_multiplier_bp,
        shiftsWorked: d.shifts_worked, leavePaidX10: d.leave_paid_x10, holiday: !!d.holiday,
      }));
    const adj = (k: string) => adjs.find((a) => a.employee_id === e.id && a.kind === k)?.m ?? 0;
    const input: PayslipInput = {
      employee: {
        payType: e.pay_type, baseSalary: e.base_salary, hourlyRate: e.hourly_rate, shiftRate: e.shift_rate,
        insuranceSalary: e.insurance_salary, dependents: e.dependents, pitEnabled: !!e.pit_enabled,
      },
      days: myDays,
      adjustMinutes: { work: adj("work"), overtime: adj("overtime") },
      allowances: allw.filter((a) => a.employee_id === e.id).map((a) => ({ name: a.name, amount: a.amount, taxable: !!a.taxable })),
      entries: entries.filter((x) => x.employee_id === e.id).map((x) => ({ kind: x.kind, amount: x.amount, taxable: !!x.taxable, reason: x.reason, sourcePeriod: x.source_period })),
      advances: advs.filter((a) => a.employee_id === e.id).map((a) => ({ amount: a.amount, date: a.advance_date })),
      salesRevenue: e.user_id ? Math.max(0, salesBy.get(e.user_id) ?? 0) : 0,
    };
    const p = calculatePayslip(input, settings);
    totalNet += p.net;
    totalCost += p.gross + p.insuranceEmployer;
    stmts.push(
      db
        .prepare(
          `INSERT INTO payroll_items(payroll_period_id, employee_id, pay_type, worked_minutes, paid_days_x10, shifts, base_pay, allowances, overtime_pay, bonus, sales_bonus,
             penalties, adjustments, gross, insurance_employee, insurance_employer, taxable_income, pit, advances, net, detail_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(pp.id, e.id, p.payType, p.workedMinutes, p.paidDaysX10, p.shifts, p.basePay, p.allowances, p.overtimePay, p.bonus, p.salesBonus, p.penalties, p.adjustments,
          p.gross, p.insuranceEmployee, p.insuranceEmployer, p.taxableIncome, p.pit, p.advances, p.net, JSON.stringify(p.lines)),
    );
  }
  stmts.push(
    db
      .prepare(`UPDATE payroll_periods SET status='calculated', calculated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), total_net=?, total_cost=? WHERE id=? AND status IN ('draft','calculated')`)
      .bind(totalNet, totalCost, pp.id),
    auditStmt(c, { action: "payroll.calculate", entity: "payroll_period", entityId: period, after: { employees: emps.length, totalNet, totalCost } }, user.id),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    throw mapLocked(e);
  }
  return { period, status: "calculated", employees: emps.length, totalNet, totalCost };
}

payrollRoutes.post("/payroll/periods/:period/calculate", requirePerm("payroll.write"), async (c) => {
  return c.json(await calculatePeriod(c, periodParam(c.req.param("period"))));
});

// ---------------------------------------------------------------- chi tiết kỳ
async function loadPeriodDetail(db: D1Database, period: string) {
  const pp = await getPeriodRow(db, period);
  if (!pp) throw notFound("payroll_period_not_found", "Chưa có bảng lương kỳ này");
  const { results } = await db
    .prepare(`SELECT i.*, e.code, e.full_name, e.position FROM payroll_items i JOIN employees e ON e.id = i.employee_id WHERE i.payroll_period_id = ? ORDER BY e.code`)
    .bind(pp.id)
    .all<any>();
  const items = results.map((i) => ({
    employeeId: i.employee_id, code: i.code, name: i.full_name, position: i.position, payType: i.pay_type, workedMinutes: i.worked_minutes, paidDaysX10: i.paid_days_x10,
    shifts: i.shifts, basePay: i.base_pay, allowances: i.allowances, overtimePay: i.overtime_pay, bonus: i.bonus, salesBonus: i.sales_bonus, penalties: i.penalties,
    adjustments: i.adjustments, gross: i.gross, insuranceEmployee: i.insurance_employee, insuranceEmployer: i.insurance_employer, taxableIncome: i.taxable_income,
    pit: i.pit, advances: i.advances, net: i.net, lines: i.detail_json ? JSON.parse(i.detail_json) : [],
  }));
  const s = (f: (x: (typeof items)[number]) => number) => items.reduce((a, x) => a + f(x), 0);
  const gross = s((x) => x.gross);
  const insuranceEmployer = s((x) => x.insuranceEmployer);
  return {
    pp,
    body: {
      period, status: pp.status, calculatedAt: pp.calculated_at, approvedAt: pp.approved_at, paidAt: pp.paid_at,
      totals: { gross, net: s((x) => x.net), insuranceEmployee: s((x) => x.insuranceEmployee), insuranceEmployer, pit: s((x) => x.pit), cost: gross + insuranceEmployer },
      items,
    },
  };
}

payrollRoutes.get("/payroll/periods/:period", requirePerm("hr.sensitive"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const { body } = await loadPeriodDetail(c.env.DB, period);
  await viewAudit(c, period, { employees: body.items.length });
  return c.json(body);
});

// ---------------------------------------------------------------- duyệt
payrollRoutes.post("/payroll/periods/:period/approve", requirePerm("payroll.approve"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const db = c.env.DB;
  const user = c.get("user");
  const pp = await getPeriodRow(db, period);
  if (!pp) throw notFound("payroll_period_not_found", "Chưa có bảng lương kỳ này");
  if (pp.status !== "calculated") throw conflict("invalid_state", pp.status === "draft" ? "Chưa tính lương kỳ này" : "Kỳ lương đã được duyệt");
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM payroll_items WHERE payroll_period_id = ?`).bind(pp.id).first<{ n: number }>();
  try {
    await db.batch([
      db.prepare(`UPDATE payroll_periods SET status='approved', approved_by=?, approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='calculated'`).bind(user.id, pp.id),
      auditStmt(c, { action: "payroll.approve", entity: "payroll_period", entityId: period, before: { status: pp.status }, after: { status: "approved", totalNet: pp.total_net, employees: n?.n } }),
    ]);
  } catch (e) {
    throw mapLocked(e);
  }
  return c.json({ period, status: "approved" });
});

// ---------------------------------------------------------------- chi lương
const paySchema = z.object({ fundId: z.number().int().positive() });
payrollRoutes.post("/payroll/periods/:period/pay", requirePerm("payroll.write"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const { fundId } = await parseBody(c, paySchema);
  const db = c.env.DB;
  const user = c.get("user");
  const pp = await getPeriodRow(db, period);
  if (!pp) throw notFound("payroll_period_not_found", "Chưa có bảng lương kỳ này");
  if (pp.status !== "approved") throw conflict("invalid_state", pp.status === "paid" ? "Kỳ lương đã chi" : "Kỳ lương chưa được duyệt");
  const fund = await db.prepare(`SELECT id FROM funds WHERE id = ? AND active = 1`).bind(fundId).first();
  if (!fund) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại hoặc đã ngừng");
  const cat = await db.prepare(`SELECT id FROM cash_categories WHERE code = 'LUONG'`).first<{ id: number }>();
  if (!cat) throw new AppError(422, "category_not_found", "Chưa có khoản mục chi LUONG");
  const { results: items } = await db
    .prepare(`SELECT i.id, i.employee_id, i.net, i.advances, e.code FROM payroll_items i JOIN employees e ON e.id = i.employee_id WHERE i.payroll_period_id = ? ORDER BY e.code`)
    .bind(pp.id)
    .all<any>();
  const curPeriod = vnPeriod();
  const stmts: D1PreparedStatement[] = [];
  const vouchers: { employee: string; amount: number; code: string }[] = [];
  for (const it of items) {
    if (it.net <= 0) continue;
    const code = await nextCode(db, PREFIX.cashOut);
    vouchers.push({ employee: it.code, amount: it.net, code });
    stmts.push(
      db
        .prepare(
          `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by)
           VALUES (?, 'out', ?, ?, ?, ?, 'payroll_item', ?, 'posted', ?, ?, ?, ?)`,
        )
        .bind(code, fundId, cat.id, it.net, it.code, it.id, curPeriod, `Lương kỳ ${period}`, user.id, user.id),
    );
  }
  stmts.push(
    db
      .prepare(
        `UPDATE salary_advances SET status='deducted' WHERE deduct_period = ? AND status='paid' AND created_at <= ?
            AND employee_id IN (SELECT employee_id FROM payroll_items WHERE payroll_period_id = ? AND advances > 0)`,
      )
      .bind(period, pp.calculated_at, pp.id),
    db.prepare(`UPDATE payroll_periods SET status='paid', paid_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), paid_fund_id=? WHERE id=? AND status='approved'`).bind(fundId, pp.id),
    auditStmt(c, { action: "payroll.pay", entity: "payroll_period", entityId: period, after: { fundId, vouchers: vouchers.length, total: vouchers.reduce((a, v) => a + v.amount, 0) } }),
  );
  await db.batch(stmts);
  return c.json({ period, status: "paid", vouchers });
});

// ---------------------------------------------------------------- entries
payrollRoutes.get("/payroll/entries", requirePerm("payroll.write"), async (c) => {
  const period = c.req.query("period");
  if (period) periodParam(period);
  const { results } = await c.env.DB
    .prepare(
      `SELECT x.*, e.code, e.full_name FROM payroll_entries x JOIN employees e ON e.id = x.employee_id ${period ? "WHERE x.period = ?" : ""} ORDER BY x.id DESC LIMIT 500`,
    )
    .bind(...(period ? [period] : []))
    .all<any>();
  await viewAudit(c, "entries", { period });
  return c.json({
    items: results.map((x) => ({ id: x.id, employeeId: x.employee_id, employeeCode: x.code, employeeName: x.full_name, period: x.period, kind: x.kind, amount: x.amount, taxable: !!x.taxable, reason: x.reason, sourcePeriod: x.source_period, createdAt: x.created_at })),
    nextCursor: null,
  });
});

const entrySchema = z.object({
  employeeId: z.number().int().positive(),
  period: z.string().regex(PERIOD_RE),
  kind: z.enum(["bonus", "penalty", "allowance", "adjustment"]),
  amount: z.number().int(),
  taxable: z.boolean().optional(),
  reason: z.string().min(1).max(300),
  sourcePeriod: z.string().regex(PERIOD_RE).optional(),
});
payrollRoutes.post("/payroll/entries", requirePerm("payroll.write"), async (c) => {
  const b = await parseBody(c, entrySchema);
  const db = c.env.DB;
  const user = c.get("user");
  if (b.kind === "adjustment" ? b.amount === 0 : b.amount <= 0) throw new AppError(422, "validation_error", "Số tiền không hợp lệ");
  const emp = await db.prepare(`SELECT id FROM employees WHERE id = ?`).bind(b.employeeId).first();
  if (!emp) throw new AppError(422, "employee_not_found", "Nhân viên không tồn tại");
  const pp = await getPeriodRow(db, b.period);
  if (pp && (pp.status === "approved" || pp.status === "paid")) throw conflict("payroll_locked", "Kỳ lương đã duyệt/đã chi: ghi điều chỉnh vào kỳ sau");
  const r = await db
    .prepare(`INSERT INTO payroll_entries(employee_id, period, kind, amount, taxable, reason, source_period, created_by) VALUES (?,?,?,?,?,?,?,?) RETURNING id`)
    .bind(b.employeeId, b.period, b.kind, b.amount, b.taxable === false ? 0 : 1, b.reason, b.sourcePeriod ?? null, user.id)
    .first<{ id: number }>();
  await audit(c, { action: "payroll.entry.create", entity: "payroll_entry", entityId: r!.id, after: b });
  return c.json({ id: r!.id, ...b, taxable: b.taxable !== false }, 201);
});

// ---------------------------------------------------------------- tạm ứng
payrollRoutes.get("/payroll/advances", requirePerm("payroll.write"), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT a.*, e.code, e.full_name, v.code AS voucher_code FROM salary_advances a JOIN employees e ON e.id = a.employee_id
         LEFT JOIN cash_vouchers v ON v.id = a.cash_voucher_id ORDER BY a.id DESC LIMIT 500`,
    )
    .all<any>();
  await viewAudit(c, "advances");
  return c.json({
    items: results.map((a) => ({
      id: a.id, employeeId: a.employee_id, employeeCode: a.code, employeeName: a.full_name, amount: a.amount, advanceDate: a.advance_date, deductPeriod: a.deduct_period,
      fundId: a.fund_id, cashVoucherId: a.cash_voucher_id, voucherCode: a.voucher_code, status: a.status, reason: a.reason,
    })),
    nextCursor: null,
  });
});

const advanceSchema = z.object({
  employeeId: z.number().int().positive(),
  amount: z.number().int().positive(),
  fundId: z.number().int().positive(),
  reason: z.string().max(300).optional(),
  deductPeriod: z.string().regex(PERIOD_RE).optional(),
});
payrollRoutes.post("/payroll/advances", requirePerm("payroll.write"), async (c) => {
  const b = await parseBody(c, advanceSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const emp = await db.prepare(`SELECT id, code, status FROM employees WHERE id = ?`).bind(b.employeeId).first<any>();
  if (!emp) throw new AppError(422, "employee_not_found", "Nhân viên không tồn tại");
  if (emp.status !== "active") throw new AppError(422, "employee_terminated", "Nhân viên đã nghỉ việc");
  const fund = await db.prepare(`SELECT id FROM funds WHERE id = ? AND active = 1`).bind(b.fundId).first();
  if (!fund) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại hoặc đã ngừng");
  const cat = await db.prepare(`SELECT id FROM cash_categories WHERE code = 'LUONG'`).first<{ id: number }>();
  if (!cat) throw new AppError(422, "category_not_found", "Chưa có khoản mục chi LUONG");
  // kỳ khấu trừ: mặc định kỳ sớm nhất từ tháng hiện tại mà bảng lương chưa tính
  let deduct = b.deductPeriod ?? vnPeriod();
  for (let i = 0; i < 24; i++) {
    const pp = await getPeriodRow(db, deduct);
    if (!pp || pp.status === "draft") break;
    if (b.deductPeriod) throw conflict("payroll_locked", "Kỳ khấu trừ đã tính/duyệt, chọn kỳ sau");
    deduct = addMonth(deduct, 1);
  }
  const code = await nextCode(db, PREFIX.cashOut);
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const note = `Tạm ứng lương ${emp.code}${b.reason ? ": " + b.reason : ""}`.slice(0, 500);
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, status, period, note, created_by, approved_by)
         VALUES (?, 'out', ?, ?, ?, ?, 'salary_advance', 'posted', ?, ?, ?, ?)`,
      )
      .bind(code, b.fundId, cat.id, b.amount, emp.code, vnPeriod(), note, user.id, user.id),
    db
      .prepare(
        `INSERT INTO salary_advances(employee_id, amount, advance_date, deduct_period, fund_id, cash_voucher_id, reason, created_by)
         VALUES (?,?,?,?,?,(SELECT id FROM cash_vouchers WHERE code = ?),?,?) RETURNING id`,
      )
      .bind(b.employeeId, b.amount, today, deduct, b.fundId, code, b.reason ?? null, user.id),
    auditStmt(c, { action: "payroll.advance", entity: "employee", entityId: b.employeeId, after: { amount: b.amount, deductPeriod: deduct, voucher: code } }),
  ]);
  const id = (res[1].results as any[])[0]?.id;
  return c.json({ id, employeeId: b.employeeId, amount: b.amount, deductPeriod: deduct, voucherCode: code, status: "paid" }, 201);
});

// ---------------------------------------------------------------- phiếu lương cá nhân
async function myEmployee(c: Ctx) {
  const e = await c.env.DB.prepare(`SELECT id, code, full_name, position FROM employees WHERE user_id = ?`).bind(c.get("user").id).first<any>();
  if (!e) throw notFound("employee_not_found", "Tài khoản chưa gắn với hồ sơ nhân viên");
  return e;
}
payrollRoutes.get("/me/payslips", requirePerm("hr.self"), async (c) => {
  const e = await myEmployee(c);
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.period, p.status, i.gross, i.net FROM payroll_items i JOIN payroll_periods p ON p.id = i.payroll_period_id
        WHERE i.employee_id = ? AND p.status IN ('approved','paid') ORDER BY p.period DESC`,
    )
    .bind(e.id)
    .all<any>();
  return c.json({ items: results.map((r) => ({ period: r.period, status: r.status, gross: r.gross, net: r.net })), nextCursor: null });
});
payrollRoutes.get("/me/payslips/:period", requirePerm("hr.self"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const e = await myEmployee(c);
  const i = await c.env.DB
    .prepare(
      `SELECT i.*, p.status FROM payroll_items i JOIN payroll_periods p ON p.id = i.payroll_period_id WHERE i.employee_id = ? AND p.period = ? AND p.status IN ('approved','paid')`,
    )
    .bind(e.id, period)
    .first<any>();
  if (!i) throw notFound("payslip_not_found", "Chưa có phiếu lương kỳ này");
  return c.json({
    period, status: i.status, employee: { id: e.id, code: e.code, name: e.full_name, position: e.position }, payType: i.pay_type, workedMinutes: i.worked_minutes,
    paidDaysX10: i.paid_days_x10, shifts: i.shifts, basePay: i.base_pay, allowances: i.allowances, overtimePay: i.overtime_pay, bonus: i.bonus, salesBonus: i.sales_bonus,
    penalties: i.penalties, adjustments: i.adjustments, gross: i.gross, insuranceEmployee: i.insurance_employee, taxableIncome: i.taxable_income, pit: i.pit,
    advances: i.advances, net: i.net, lines: i.detail_json ? JSON.parse(i.detail_json) : [],
  });
});

// ---------------------------------------------------------------- báo cáo chi phí
payrollRoutes.get("/payroll/reports/cost", requirePerm("hr.sensitive"), async (c) => {
  const to = c.req.query("to") ?? vnPeriod();
  const from = c.req.query("from") ?? addMonth(to, -11);
  periodParam(from);
  periodParam(to);
  if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
  const db = c.env.DB;
  const base = `FROM payroll_items i JOIN payroll_periods p ON p.id = i.payroll_period_id JOIN employees e ON e.id = i.employee_id
                 WHERE p.status IN ('approved','paid') AND p.period >= ? AND p.period <= ?`;
  const byMonth = (await db.prepare(`SELECT p.period, COUNT(*) AS n, SUM(i.gross) AS gross, SUM(i.insurance_employer) AS ins ${base} GROUP BY p.period ORDER BY p.period`).bind(from, to).all<any>()).results;
  const byPos = (await db.prepare(`SELECT e.position, COUNT(DISTINCT e.id) AS n, SUM(i.gross) AS gross, SUM(i.insurance_employer) AS ins ${base} GROUP BY e.position ORDER BY gross DESC`).bind(from, to).all<any>()).results;
  const m = (r: any) => ({ employees: r.n, gross: r.gross, insuranceEmployer: r.ins, cost: r.gross + r.ins });
  const byMonthItems = byMonth.map((r) => ({ period: r.period, ...m(r) }));
  await viewAudit(c, "reports.cost", { from, to });
  return c.json({
    from, to, byMonth: byMonthItems, byPosition: byPos.map((r) => ({ position: r.position, ...m(r) })),
    totals: { gross: byMonthItems.reduce((a, r) => a + r.gross, 0), insuranceEmployer: byMonthItems.reduce((a, r) => a + r.insuranceEmployer, 0), cost: byMonthItems.reduce((a, r) => a + r.cost, 0) },
  });
});

// ---------------------------------------------------------------- xuất Excel
const PAY_TYPE: Record<string, string> = { monthly: "Theo tháng", hourly: "Theo giờ", shift: "Theo ca" };
async function exportPayroll(c: Ctx) {
  const period = periodParam(c.req.query("period") ?? c.req.param("period"));
  const { body } = await loadPeriodDetail(c.env.DB, period);
  const money = (h: string) => ({ header: h, type: "money" as const });
  const bytes = buildXlsx([
    {
      name: `Bảng lương ${period}`,
      columns: [
        { header: "Mã NV" }, { header: "Họ tên", width: 26 }, { header: "Vị trí" }, { header: "Hình thức" }, { header: "Giờ công", type: "qty" }, { header: "Ngày công hưởng lương", type: "qty" },
        { header: "Số ca", type: "int" }, money("Lương cơ bản"), money("Phụ cấp"), money("Tăng ca"), money("Thưởng"), money("Thưởng doanh số"), money("Phạt"), money("Điều chỉnh"),
        money("Tổng thu nhập"), money("BH người lao động"), money("Thu nhập tính thuế"), money("Thuế TNCN"), money("Tạm ứng"), money("Thực lĩnh"), money("BH doanh nghiệp"),
      ],
      rows: body.items.map((i) => [
        i.code, i.name, i.position, PAY_TYPE[i.payType] ?? i.payType, Math.round((i.workedMinutes / 60) * 100) / 100, i.paidDaysX10 / 10, i.shifts, i.basePay, i.allowances,
        i.overtimePay, i.bonus, i.salesBonus, i.penalties, i.adjustments, i.gross, i.insuranceEmployee, i.taxableIncome, i.pit, i.advances, i.net, i.insuranceEmployer,
      ]),
      totalCols: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    },
  ]);
  await viewAudit(c, "export", { period });
  return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": XLSX_MIME, "content-disposition": `attachment; filename="bang-luong_${period}.xlsx"` } });
}
// Lưu ý: /exports/:file trong exports.ts khớp trước nếu mount trước payrollRoutes; luôn có đường dẫn thay thế dưới /payroll.
payrollRoutes.get("/exports/bang-luong.xlsx", requirePerm("payroll.write"), exportPayroll);
payrollRoutes.get("/payroll/periods/:period/export.xlsx", requirePerm("payroll.write"), exportPayroll);

