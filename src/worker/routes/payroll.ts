import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { audit, auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDayRangeUtc, vnPeriod } from "../lib/time";
import { parseBody } from "../services/http";
import { assertStmt, onceStmt } from "../services/guard";
import { assertPeriodOpen } from "../services/period";
import { getSettingInt } from "../services/settings";
import { buildXlsx, XLSX_MIME } from "../services/xlsx";
import { renderPayrollPdf, renderPayslipPdf } from "../services/report-pdf";
import { periodValue, pick, type HistRow } from "../services/salary-history";
import { calculatePayslip, loadPayrollSettings, type PayslipInput, type TimesheetDayInput } from "../services/payroll-calc";

/** Lương (M9): tính, duyệt, chi, phiếu lương, tạm ứng, báo cáo chi phí. Công thức ở services/payroll-calc.ts. */
export const payrollRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const MAX_VND = 10_000_000_000;
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

/** Toàn bộ dữ liệu đầu vào của một kỳ lương (dùng cho cả tính lương lẫn dấu vân tay kiểm tra "dữ liệu đã đổi sau khi tính"). */
async function loadPayrollInputs(db: D1Database, period: string) {
  const { first, last, fromIso, toIso } = periodDates(period);
  const settings = await loadPayrollSettings(db);

  const emps = (
    await db
      .prepare(`SELECT * FROM employees WHERE hire_date <= ? AND (termination_date IS NULL OR termination_date >= ?) ORDER BY id`)
      .bind(last, first)
      .all<any>()
  ).results;

  const days = (await db.prepare(`SELECT * FROM timesheet_days WHERE period = ? ORDER BY employee_id, work_date`).bind(period).all<any>()).results;
  const adjs = (await db.prepare(`SELECT employee_id, kind, SUM(minutes) AS m FROM timesheet_adjustments WHERE target_period = ? GROUP BY employee_id, kind ORDER BY employee_id, kind`).bind(period).all<any>()).results;
  const allw = (await db.prepare(`SELECT * FROM employee_allowances ORDER BY id`).all<any>()).results;
  const hist = (await db.prepare(`SELECT id, employee_id, field, ref_id, old_value, new_value, effective_date FROM employee_salary_history ORDER BY id`).all<HistRow>()).results;
  const entries = (await db.prepare(`SELECT * FROM payroll_entries WHERE period = ? ORDER BY id`).bind(period).all<any>()).results;
  const advs = (await db.prepare(`SELECT * FROM salary_advances WHERE deduct_period = ? AND status = 'paid' AND (cash_voucher_id IS NULL OR cash_voucher_id IN (SELECT id FROM cash_vouchers WHERE status = 'posted')) ORDER BY id`).bind(period).all<any>()).results;
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
  const hrSettingRows = (await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'hr.%' ORDER BY key`).all<any>()).results;
  // Phạt/thưởng theo ca (bảng chấm công) chưa huỷ, theo work_date của kỳ
  const incidents = (
    await db
      .prepare(
        `SELECT i.id, i.employee_id, i.work_date, i.kind, i.times, i.amount_each, i.amount, t.name AS type_name FROM attendance_incidents i JOIN attendance_incident_types t ON t.id = i.type_id
          WHERE i.voided_at IS NULL AND i.work_date >= ? AND i.work_date <= ? ORDER BY i.id`,
      )
      .bind(first, last)
      .all<any>()
  ).results;
  return { period, first, last, settings, emps, days, adjs, allw, hist, entries, advs, salesBy, hrSettingRows, incidents };
}
type PayrollInputs = Awaited<ReturnType<typeof loadPayrollInputs>>;

/** SHA-256 của mọi đầu vào ảnh hưởng phiếu lương (hồ sơ NV, bảng công, điều chỉnh, phụ cấp, thưởng/phạt, tạm ứng, tham số hr.*, doanh số nếu có thưởng doanh số). */
async function inputsHash(inp: PayrollInputs): Promise<string> {
  const parts: unknown[] = [inp.emps, inp.days, inp.adjs, inp.allw, inp.hist, inp.entries, inp.advs, inp.hrSettingRows, inp.settings.salesBonusBp > 0 ? [...inp.salesBy.entries()] : null];
  if (inp.incidents.length) parts.push(inp.incidents); // chỉ thêm khi có → hash các kỳ cũ không đổi
  const payload = JSON.stringify(parts);
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const inp = await loadPayrollInputs(db, period);
  const { first, last, settings, emps, days, adjs, allw, hist, entries, advs, salesBy, incidents } = inp;
  const hash = await inputsHash(inp);

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
        holidayPaid: !!d.holiday && d.note === "holiday_paid_off", scheduledMinutes: d.scheduled_minutes, workUnitsX10: d.work_units_x10 ?? null,
      }));
    const adj = (k: string) => adjs.find((a) => a.employee_id === e.id && a.kind === k)?.m ?? 0;
    const input: PayslipInput = {
      period,
      employee: {
        payType: e.pay_type,
        // C-18: mức lương đúng theo ngày hiệu lực trong kỳ
        baseSalary: periodValue(pick(hist, e.id, "baseSalary"), e.base_salary, period),
        hourlyRate: periodValue(pick(hist, e.id, "hourlyRate"), e.hourly_rate, period),
        shiftRate: periodValue(pick(hist, e.id, "shiftRate"), e.shift_rate, period),
        insuranceSalary: periodValue(pick(hist, e.id, "insuranceSalary"), e.insurance_salary, period),
        dependents: e.dependents, pitEnabled: !!e.pit_enabled, hireDate: e.hire_date, terminationDate: e.termination_date,
      },
      days: myDays,
      adjustMinutes: { work: adj("work"), overtime: adj("overtime") },
      allowances: allw.filter((a) => a.employee_id === e.id)
        .map((a) => ({ name: a.name, amount: periodValue(pick(hist, e.id, "allowance", a.id), a.active ? a.amount : 0, period), taxable: !!a.taxable }))
        .filter((a) => a.amount > 0),
      entries: [
        ...entries.filter((x) => x.employee_id === e.id).map((x) => ({ kind: x.kind, amount: x.amount, taxable: !!x.taxable, reason: x.reason, sourcePeriod: x.source_period })),
        ...incidents.filter((i) => i.employee_id === e.id && i.amount > 0).map((i) => ({
          kind: i.kind as "bonus" | "penalty", amount: i.amount as number, taxable: true,
          reason: `${i.type_name} × ${i.times} = ${(i.amount as number).toLocaleString("en-US").replaceAll(",", ".")} (${i.work_date.slice(8, 10)}/${i.work_date.slice(5, 7)})`,
        })),
      ],
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
             penalties, adjustments, gross, insurance_employee, insurance_employer, taxable_income, pit, advances, advances_carried, net, detail_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(pp.id, e.id, p.payType, p.workedMinutes, p.paidDaysX10, p.shifts, p.basePay, p.allowances, p.overtimePay, p.bonus, p.salesBonus, p.penalties, p.adjustments,
          p.gross, p.insuranceEmployee, p.insuranceEmployer, p.taxableIncome, p.pit, p.advances, p.advancesCarried, p.net, JSON.stringify(p.lines)),
    );
  }
  stmts.push(
    db
      .prepare(`UPDATE payroll_periods SET status='calculated', calculated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), total_net=?, total_cost=?, inputs_hash=? WHERE id=? AND status IN ('draft','calculated')`)
      .bind(totalNet, totalCost, hash, pp.id),
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
/** Kỳ đã tính nhưng đầu vào đã đổi (hoặc chưa có dấu vân tay) → phải tính lại trước khi duyệt. */
async function isStale(db: D1Database, pp: any): Promise<boolean> {
  if (!pp.inputs_hash) return true;
  return (await inputsHash(await loadPayrollInputs(db, pp.period))) !== pp.inputs_hash;
}

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
    pit: i.pit, advances: i.advances, advancesCarried: i.advances_carried ?? 0, net: i.net, lines: i.detail_json ? JSON.parse(i.detail_json) : [],
  }));
  const s = (f: (x: (typeof items)[number]) => number) => items.reduce((a, x) => a + f(x), 0);
  const gross = s((x) => x.gross);
  const insuranceEmployer = s((x) => x.insuranceEmployer);
  return {
    pp,
    body: {
      period, status: pp.status, stale: pp.status === "calculated" ? await isStale(db, pp) : false, calculatedAt: pp.calculated_at, approvedAt: pp.approved_at, paidAt: pp.paid_at,
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
  // C-04: đầu vào (hồ sơ, bảng công, thưởng/phạt, tạm ứng, phụ cấp, tham số) đã đổi kể từ lần tính cuối → bắt tính lại
  const curHash = await inputsHash(await loadPayrollInputs(db, period));
  if (!pp.inputs_hash || curHash !== pp.inputs_hash) throw conflict("payroll_stale", "Dữ liệu đầu vào đã thay đổi sau lần tính lương cuối, hãy tính lại trước khi duyệt");
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM payroll_items WHERE payroll_period_id = ?`).bind(pp.id).first<{ n: number }>();
  try {
    await db.batch([
      assertStmt(db, "payroll.approve", `SELECT status = 'calculated' AND inputs_hash = ? FROM payroll_periods WHERE id = ?`, [curHash, pp.id]),
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
  // Chốt chặn (audit #3): chi lương một lần cho mỗi kỳ; kỳ phải còn 'approved' tại lúc ghi
  const stmts: D1PreparedStatement[] = [
    onceStmt(db, "payroll.pay", pp.id),
    assertStmt(db, "payroll.pay", `SELECT status = 'approved' FROM payroll_periods WHERE id = ?`, [pp.id]),
  ];
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
  // C-05: phân bổ khấu trừ tạm ứng theo thứ tự id, mỗi khoản chỉ bị trừ đúng một lần; phần chưa trừ hết chuyển sang kỳ sau (tách dòng nếu trừ một phần)
  let nextPeriod = addMonth(period, 1);
  for (let i = 0; i < 24; i++) {
    const np = await getPeriodRow(db, nextPeriod);
    if (!np || np.status === "draft") break;
    nextPeriod = addMonth(nextPeriod, 1);
  }
  const advRows = (
    await db
      .prepare(
        `SELECT * FROM salary_advances WHERE deduct_period = ? AND status = 'paid' AND created_at <= ?
            AND (cash_voucher_id IS NULL OR cash_voucher_id IN (SELECT id FROM cash_vouchers WHERE status = 'posted')) ORDER BY id`,
      )
      .bind(period, pp.calculated_at)
      .all<any>()
  ).results;
  let carriedTotal = 0;
  for (const it of items) {
    let remaining: number = it.advances;
    for (const a of advRows.filter((x) => x.employee_id === it.employee_id)) {
      if (remaining >= a.amount) {
        stmts.push(db.prepare(`UPDATE salary_advances SET status='deducted' WHERE id=? AND status='paid'`).bind(a.id));
        remaining -= a.amount;
      } else if (remaining > 0) {
        const rest = a.amount - remaining;
        stmts.push(
          db.prepare(`UPDATE salary_advances SET amount=?, status='deducted' WHERE id=? AND status='paid'`).bind(remaining, a.id),
          db
            .prepare(
              `INSERT INTO salary_advances(employee_id, amount, advance_date, deduct_period, fund_id, cash_voucher_id, status, reason, created_by, carried_from_id)
               VALUES (?,?,?,?,?,?,'paid',?,?,?)`,
            )
            .bind(a.employee_id, rest, a.advance_date, nextPeriod, a.fund_id, a.cash_voucher_id, `Chuyển từ kỳ ${period}${a.reason ? ": " + a.reason : ""}`.slice(0, 300), a.created_by, a.id),
        );
        carriedTotal += rest;
        remaining = 0;
      } else {
        stmts.push(db.prepare(`UPDATE salary_advances SET deduct_period=?, moved_from_period=? WHERE id=? AND status='paid'`).bind(nextPeriod, period, a.id));
        carriedTotal += a.amount;
      }
    }
  }
  const itemEmps = new Set(items.map((i) => i.employee_id));
  for (const a of advRows) {
    if (itemEmps.has(a.employee_id)) continue; // NV không có phiếu lương kỳ này → khoản tạm ứng sang kỳ sau, không bị bỏ sót
    stmts.push(db.prepare(`UPDATE salary_advances SET deduct_period=?, moved_from_period=? WHERE id=? AND status='paid'`).bind(nextPeriod, period, a.id));
    carriedTotal += a.amount;
  }
  stmts.push(
    db.prepare(`UPDATE payroll_periods SET status='paid', paid_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), paid_fund_id=? WHERE id=? AND status='approved'`).bind(fundId, pp.id),
    auditStmt(c, { action: "payroll.pay", entity: "payroll_period", entityId: period, after: { fundId, vouchers: vouchers.length, total: vouchers.reduce((a, v) => a + v.amount, 0), advancesCarried: carriedTotal, carriedTo: carriedTotal > 0 ? nextPeriod : null } }),
  );
  await db.batch(stmts);
  return c.json({ period, status: "paid", vouchers, advancesCarried: carriedTotal, carriedTo: carriedTotal > 0 ? nextPeriod : null });
});

// ---------------------------------------------------------------- đảo chi lương (C-23)
const reverseSchema = z.object({ reason: z.string().trim().min(5).max(300) });
/**
 * Đảo toàn bộ chi lương của kỳ (chọn nhầm quỹ...): lập phiếu thu đảo cho từng phiếu chi lương (kỳ hiện tại, kiểm khoá sổ),
 * đưa kỳ lương về 'approved' (chưa chi, chi lại được với quỹ khác), trả các khoản tạm ứng về trạng thái trước khi chi.
 * Chỉ người duyệt lương (payroll.approve). Không sửa phiếu lương (payroll_items vẫn khoá).
 */
payrollRoutes.post("/payroll/periods/:period/reverse-pay", requirePerm("payroll.approve"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const { reason } = await parseBody(c, reverseSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const pp = await getPeriodRow(db, period);
  if (!pp) throw notFound("payroll_period_not_found", "Chưa có bảng lương kỳ này");
  if (pp.status !== "paid") throw conflict("invalid_state", "Kỳ lương chưa chi, không có gì để đảo");
  await assertPeriodOpen(db, new Date(), "phiếu đảo chi lương");
  const { results: vs } = await db
    .prepare(
      `SELECT v.* FROM cash_vouchers v WHERE v.ref_type = 'payroll_item' AND v.status = 'posted' AND v.reverses_id IS NULL
          AND v.ref_id IN (SELECT id FROM payroll_items WHERE payroll_period_id = ?)
          AND NOT EXISTS (SELECT 1 FROM cash_vouchers r WHERE r.reverses_id = v.id) ORDER BY v.id`,
    )
    .bind(pp.id)
    .all<any>();
  if (!vs.length) throw conflict("nothing_to_reverse", "Không còn phiếu chi lương nào chưa đảo");
  const curPeriod = vnPeriod();
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, "payroll.reverse_pay", `SELECT status = 'paid' FROM payroll_periods WHERE id = ?`, [pp.id]),
  ];
  const reversals: { code: string; amount: number; of: string }[] = [];
  for (const v of vs) {
    const code = await nextCode(db, PREFIX.cashIn);
    reversals.push({ code, amount: v.amount, of: v.code });
    stmts.push(
      db
        .prepare(
          `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, reverses_id)
           VALUES (?, 'in', ?, ?, ?, ?, 'payroll_item', ?, 'posted', ?, ?, ?, ?, ?)`,
        )
        .bind(code, v.fund_id, v.category_id, v.amount, v.counterparty, v.ref_id, curPeriod, `Đảo chi lương kỳ ${period} (${v.code}): ${reason}`.slice(0, 500), user.id, user.id, v.id),
    );
  }
  // Tạm ứng: khoản đã trừ → trả về 'paid'; khoản tách dở → gộp lại; khoản bị dời kỳ khi chi lương → về kỳ gốc
  const { results: deducted } = await db.prepare(`SELECT * FROM salary_advances WHERE deduct_period = ? AND status = 'deducted'`).bind(period).all<any>();
  for (const a of deducted) {
    const carry = await db.prepare(`SELECT * FROM salary_advances WHERE carried_from_id = ?`).bind(a.id).first<any>();
    if (carry) {
      if (carry.status !== "paid") throw conflict("advance_carried_used", "Khoản tạm ứng chuyển kỳ sau đã bị khấu trừ/huỷ, không đảo được chi lương");
      stmts.push(
        assertStmt(db, "payroll.reverse_carry", `SELECT status = 'paid' FROM salary_advances WHERE id = ?`, [carry.id]),
        db.prepare(`UPDATE salary_advances SET status='cancelled' WHERE id=? AND status='paid'`).bind(carry.id),
        db.prepare(`UPDATE salary_advances SET amount = amount + ?, status='paid' WHERE id=? AND status='deducted'`).bind(carry.amount, a.id),
      );
    } else stmts.push(db.prepare(`UPDATE salary_advances SET status='paid' WHERE id=? AND status='deducted'`).bind(a.id));
  }
  stmts.push(
    db.prepare(`UPDATE salary_advances SET deduct_period = moved_from_period, moved_from_period = NULL WHERE moved_from_period = ? AND status = 'paid'`).bind(period),
    db.prepare(`DELETE FROM once_keys WHERE scope = 'payroll.pay' AND key = ?`).bind(String(pp.id)),
    db.prepare(`UPDATE payroll_periods SET status='approved', paid_at=NULL, paid_fund_id=NULL WHERE id=? AND status='paid'`).bind(pp.id),
    auditStmt(c, { action: "payroll.reverse_pay", entity: "payroll_period", entityId: period, before: { status: "paid", fundId: pp.paid_fund_id }, after: { status: "approved", reversals }, reason }),
  );
  await db.batch(stmts);
  return c.json({ period, status: "approved", reversals });
});

// Huỷ tạm ứng chưa khấu trừ (chọn nhầm quỹ/nhân viên): đảo phiếu chi (hoặc huỷ phiếu chờ duyệt) + đánh dấu cancelled
payrollRoutes.post("/payroll/advances/:id/cancel", requirePerm("payroll.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const { reason } = await parseBody(c, reverseSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const a = await db.prepare(`SELECT * FROM salary_advances WHERE id = ?`).bind(id).first<any>();
  if (!a) throw notFound("advance_not_found", "Không tìm thấy khoản tạm ứng");
  if (a.status !== "paid") throw conflict("advance_not_cancellable", a.status === "deducted" ? "Tạm ứng đã khấu trừ vào lương, không huỷ được" : "Tạm ứng đã huỷ");
  const pp = await getPeriodRow(db, a.deduct_period);
  if (pp && (pp.status === "approved" || pp.status === "paid")) throw conflict("payroll_locked", "Kỳ khấu trừ đã duyệt/đã chi: đảo chi lương của kỳ đó trước");
  const v = a.cash_voucher_id ? await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(a.cash_voucher_id).first<any>() : null;
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, "payroll.advance_cancel", `SELECT status = 'paid' FROM salary_advances WHERE id = ?`, [id]),
    db.prepare(`UPDATE salary_advances SET status='cancelled' WHERE id=? AND status='paid'`).bind(id),
  ];
  let reversal: string | null = null;
  if (v?.status === "pending_approval") {
    stmts.push(
      db.prepare(`UPDATE cash_vouchers SET status='cancelled' WHERE id=? AND status='pending_approval'`).bind(v.id),
      db.prepare(`UPDATE approvals SET status='rejected', decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note=? WHERE type='cash_voucher.post' AND ref_id=? AND status='pending'`).bind(user.id, reason, String(v.id)),
    );
  } else if (v?.status === "posted") {
    await assertPeriodOpen(db, new Date(), "phiếu đảo tạm ứng");
    if (await db.prepare(`SELECT 1 FROM cash_vouchers WHERE reverses_id = ?`).bind(v.id).first()) throw conflict("already_reversed", "Phiếu chi tạm ứng đã được đảo");
    reversal = await nextCode(db, PREFIX.cashIn);
    stmts.push(
      db
        .prepare(
          `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, reverses_id)
           VALUES (?, 'in', ?, ?, ?, ?, 'salary_advance', ?, 'posted', ?, ?, ?, ?, ?)`,
        )
        .bind(reversal, v.fund_id, v.category_id, v.amount, v.counterparty, v.ref_id, vnPeriod(), `Đảo tạm ứng lương (${v.code}): ${reason}`.slice(0, 500), user.id, user.id, v.id),
    );
  }
  stmts.push(auditStmt(c, { action: "payroll.advance_cancel", entity: "salary_advance", entityId: id, before: { status: a.status, voucher: v?.code ?? null }, after: { status: "cancelled", reversal }, reason }));
  await db.batch(stmts);
  return c.json({ id, status: "cancelled", reversalCode: reversal });
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
  amount: z.number().int().min(-MAX_VND).max(MAX_VND),
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
  return c.json({ id: r!.id, ...b, taxable: b.taxable !== false, requiresRecalculation: pp?.status === "calculated" }, 201);
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
  amount: z.number().int().positive().max(MAX_VND),
  fundId: z.number().int().positive(),
  reason: z.string().max(300).optional(),
  deductPeriod: z.string().regex(PERIOD_RE).optional(),
});
payrollRoutes.post("/payroll/advances", requirePerm("payroll.write"), async (c) => {
  const b = await parseBody(c, advanceSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const emp = await db.prepare(`SELECT id, code, status, user_id, pay_type, base_salary, hourly_rate, shift_rate FROM employees WHERE id = ?`).bind(b.employeeId).first<any>();
  if (!emp) throw new AppError(422, "employee_not_found", "Nhân viên không tồn tại");
  if (emp.status !== "active") throw new AppError(422, "employee_terminated", "Nhân viên đã nghỉ việc");
  // C-12: không tự tạm ứng cho chính mình (chỉ chủ mới được lập cho người khác/chính mình qua kênh duyệt của chủ)
  if (emp.user_id != null && emp.user_id === user.id && user.role !== "owner") throw forbidden("self_advance", "Không được tự tạm ứng cho chính mình — nhờ chủ cửa hàng lập phiếu");
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
  // C-12: giới hạn luỹ kế theo nhân viên + kỳ khấu trừ (tham số hr.advance_max_bp, % lương tháng; 0 = tắt)
  const maxBp = await getSettingInt(db, "hr.advance_max_bp", 5000);
  if (maxBp > 0) {
    const std = Math.max(1, await getSettingInt(db, "hr.standard_workdays", 26));
    const monthly = emp.pay_type === "monthly" ? emp.base_salary : emp.pay_type === "hourly" ? emp.hourly_rate * 8 * std : emp.shift_rate * std;
    const cap = Math.floor((monthly * maxBp) / 10000);
    const used = (
      await db
        .prepare(
          `SELECT COALESCE(SUM(a.amount),0) n FROM salary_advances a LEFT JOIN cash_vouchers v ON v.id = a.cash_voucher_id
            WHERE a.employee_id = ? AND a.deduct_period = ? AND a.status != 'cancelled' AND (v.id IS NULL OR v.status != 'cancelled')`,
        )
        .bind(b.employeeId, deduct)
        .first<{ n: number }>()
    )!.n;
    if (used + b.amount > cap) {
      throw new AppError(
        422, "advance_limit_exceeded",
        `Tạm ứng vượt giới hạn: tối đa ${cap.toLocaleString("vi-VN")} đ/kỳ ${deduct} (${maxBp / 100}% lương tháng), đã ứng ${used.toLocaleString("vi-VN")} đ, còn được ứng ${Math.max(0, cap - used).toLocaleString("vi-VN")} đ`,
        { cap, used, requested: b.amount, remaining: Math.max(0, cap - used), deductPeriod: deduct },
      );
    }
  }
  const code = await nextCode(db, PREFIX.cashOut);
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const note = `Tạm ứng lương ${emp.code}${b.reason ? ": " + b.reason : ""}`.slice(0, 500);
  // Ngưỡng duyệt chi tiền (như POST /vouchers): vượt approval.cash_out_vnd mà không có finance.approve → phiếu chờ duyệt + approval
  const threshold = await getSettingInt(db, "approval.cash_out_vnd", 5_000_000);
  const needApproval = b.amount > threshold && !can(user.role, "finance.approve");
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, status, period, note, created_by, approved_by)
         VALUES (?, 'out', ?, ?, ?, ?, 'salary_advance', ?, ?, ?, ?, ?)`,
      )
      .bind(code, b.fundId, cat.id, b.amount, emp.code, needApproval ? "pending_approval" : "posted", vnPeriod(), note, user.id, needApproval ? null : user.id),
    ...(needApproval
      ? [
          db
            .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('cash_voucher.post','cash_voucher',CAST((SELECT id FROM cash_vouchers WHERE code = ?) AS TEXT),?,?,?)`)
            .bind(code, JSON.stringify({ amount: b.amount, code }), `Tạm ứng lương ${b.amount} vượt ngưỡng ${threshold}`, user.id),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO salary_advances(employee_id, amount, advance_date, deduct_period, fund_id, cash_voucher_id, reason, created_by)
         VALUES (?,?,?,?,?,(SELECT id FROM cash_vouchers WHERE code = ?),?,?) RETURNING id`,
      )
      .bind(b.employeeId, b.amount, today, deduct, b.fundId, code, b.reason ?? null, user.id),
    auditStmt(c, { action: "payroll.advance", entity: "employee", entityId: b.employeeId, after: { amount: b.amount, deductPeriod: deduct, voucher: code } }),
  ]);
  const id = (res[needApproval ? 2 : 1].results as any[])[0]?.id;
  return c.json({ id, employeeId: b.employeeId, amount: b.amount, deductPeriod: deduct, voucherCode: code, status: needApproval ? "pending_approval" : "paid" }, 201);
});

// ---------------------------------------------------------------- phiếu lương cá nhân
async function myEmployee(c: Ctx) {
  const e = await c.env.DB.prepare(`SELECT id, code, full_name, position FROM employees WHERE user_id = ?`).bind(c.get("user").id).first<any>();
  if (!e) throw notFound("employee_not_linked", "Tài khoản chưa gắn với hồ sơ nhân viên");
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
async function myPayslip(c: Ctx, period: string) {
  const e = await myEmployee(c);
  const i = await c.env.DB
    .prepare(
      `SELECT i.*, p.status FROM payroll_items i JOIN payroll_periods p ON p.id = i.payroll_period_id WHERE i.employee_id = ? AND p.period = ? AND p.status IN ('approved','paid')`,
    )
    .bind(e.id, period)
    .first<any>();
  if (!i) throw notFound("payslip_not_found", "Chưa có phiếu lương kỳ này");
  return {
    period, status: i.status, employee: { id: e.id, code: e.code, name: e.full_name, position: e.position }, payType: i.pay_type, workedMinutes: i.worked_minutes,
    paidDaysX10: i.paid_days_x10, shifts: i.shifts, basePay: i.base_pay, allowances: i.allowances, overtimePay: i.overtime_pay, bonus: i.bonus, salesBonus: i.sales_bonus,
    penalties: i.penalties, adjustments: i.adjustments, gross: i.gross, insuranceEmployee: i.insurance_employee, taxableIncome: i.taxable_income, pit: i.pit,
    advances: i.advances, advancesCarried: i.advances_carried ?? 0, net: i.net, lines: i.detail_json ? JSON.parse(i.detail_json) : [],
  };
}
payrollRoutes.get("/me/payslips/:period", requirePerm("hr.self"), async (c) => c.json(await myPayslip(c, periodParam(c.req.param("period")))));

// C-28: PDF phiếu lương — nhân viên chỉ tải phiếu CỦA MÌNH (kỳ đã duyệt/đã chi); chủ/kế toán (hr.sensitive) tải cho từng nhân viên
const pdfResponse = (bytes: Uint8Array, name: string) =>
  new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
payrollRoutes.get("/me/payslips/:period/pdf", requirePerm("hr.self"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const p = await myPayslip(c, period);
  const bytes = await renderPayslipPdf(c.env, { period, status: p.status, employee: { code: p.employee.code, name: p.employee.name, position: p.employee.position }, item: p });
  await audit(c, { action: "payslip.pdf", entity: "employee", entityId: p.employee.id, after: { period, self: true } });
  return pdfResponse(bytes, `phieu-luong_${p.employee.code}_${period}.pdf`);
});
payrollRoutes.get("/payroll/periods/:period/payslips/:employeeId/pdf", requirePerm("hr.sensitive"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const empId = Number(c.req.param("employeeId"));
  const { body } = await loadPeriodDetail(c.env.DB, period);
  const item = body.items.find((x) => x.employeeId === empId);
  if (!item) throw notFound("payslip_not_found", "Không có phiếu lương của nhân viên này trong kỳ");
  const bytes = await renderPayslipPdf(c.env, { period, status: body.status, employee: { code: item.code, name: item.name, position: item.position }, item });
  await audit(c, { action: "payslip.pdf", entity: "employee", entityId: empId, after: { period } });
  return pdfResponse(bytes, `phieu-luong_${item.code}_${period}.pdf`);
});
payrollRoutes.get("/payroll/periods/:period/export.pdf", requirePerm("hr.sensitive"), async (c) => {
  const period = periodParam(c.req.param("period"));
  const { body } = await loadPeriodDetail(c.env.DB, period);
  const bytes = await renderPayrollPdf(c.env, body);
  await viewAudit(c, "export.pdf", { period });
  return pdfResponse(bytes, `bang-luong_${period}.pdf`);
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

