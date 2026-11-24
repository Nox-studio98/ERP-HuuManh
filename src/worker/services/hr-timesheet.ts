import { vnDate } from "../lib/time";
import {
  addDays, eachDate, hrSettings, isWeekend, leaveCountableDates, minutesBetween, monthBounds, vnRangeUtc,
  type HrSettings,
} from "./hr-common";

/** Một ca/ngày không có giờ ra sau quá số phút này thì coi là quên chấm ra (không đoán giờ ra). */
export const MAX_SHIFT_MINUTES = 16 * 60;

/** serverAt = giờ HIỆU LỰC (effective_at; chấm offline = giờ máy NV đã kiểm tra). */
export interface TsPunch { id: number; kind: "in" | "out"; serverAt: string; status: string; assignmentId: number | null }
export interface TsAssignment { id: number; workDate: string; startAt: string; endAt: string; breakMinutes: number; status: string }
export interface TsOvertime { workDate: string; minutes: number; multiplierBp: number | null; status: string }
export interface TsLeave { fromDate: string; toDate: string; halfDay: boolean; code: string; paid: boolean; status: string }
export interface TsHoliday { day: string; name?: string; multiplierBp: number; paidOff: boolean }
export interface TsEmployee { id: number; name: string; hireDate: string; terminationDate: string | null }
export interface TsData {
  punches: TsPunch[];
  assignments: TsAssignment[];
  overtime: TsOvertime[];
  leaves: TsLeave[];
  holidays: TsHoliday[];
}
export type TsSettings = Pick<HrSettings, "lateGraceMinutes" | "roundingMinutes" | "otWeekdayBp" | "otWeekendBp" | "otHolidayBp"> & { weeklyOffDays?: number[] };

export interface TimesheetDay {
  workDate: string;
  scheduledMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  overtimeMultiplierBp: number;
  shiftsWorked: number;
  missingPunch: boolean;
  leaveCode: string | null;
  leavePaidX10: number;
  holiday: boolean;
  /** 'holiday_paid_off' khi ngày lễ nghỉ hưởng lương */
  note: string | null;
}
export interface TimesheetTotals {
  workedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number;
  missingDays: number; shiftsWorked: number; paidLeaveX10: number;
  /** số ngày có làm (workedMinutes > 0) */
  workDays: number;
  /** số ngày lễ nghỉ hưởng lương không đi làm */
  paidHolidayDays: number;
}
export interface EmployeeTimesheet { employeeId: number; name: string; days: TimesheetDay[]; totals: TimesheetTotals }
export interface Timesheet { period: string; status: "open" | "closed"; employees: EmployeeTimesheet[] }

const blankDay = (workDate: string): TimesheetDay => ({
  workDate, scheduledMinutes: 0, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0,
  overtimeMultiplierBp: 0, shiftsWorked: 0, missingPunch: false, leaveCode: null, leavePaidX10: 0, holiday: false, note: null,
});

export function totalsOf(days: TimesheetDay[]): TimesheetTotals {
  const t: TimesheetTotals = { workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, missingDays: 0, shiftsWorked: 0, paidLeaveX10: 0, workDays: 0, paidHolidayDays: 0 };
  for (const d of days) {
    t.workedMinutes += d.workedMinutes;
    t.lateMinutes += d.lateMinutes;
    t.earlyLeaveMinutes += d.earlyLeaveMinutes;
    t.overtimeMinutes += d.overtimeMinutes;
    t.shiftsWorked += d.shiftsWorked;
    t.paidLeaveX10 += d.leavePaidX10;
    if (d.missingPunch) t.missingDays++;
    if (d.workedMinutes > 0) t.workDays++;
    if (d.holiday && d.note === "holiday_paid_off" && d.workedMinutes === 0) t.paidHolidayDays++;
  }
  return t;
}

/**
 * HÀM THUẦN tính bảng công một nhân viên cho một kỳ (quy tắc trong docs/API-dot4.md, "Quy tắc tính công").
 *  - chỉ punch `accepted`; ghép cặp in→out theo thời gian; in không có out → missingPunch (không đoán giờ ra);
 *  - ca qua đêm thuộc ngày bắt đầu (ngày của punch 'in', hoặc work_date của ca được gán);
 *  - worked = Σ(out−in) − nghỉ giữa ca; late = max(0, in−start−grace); early = max(0, end−out);
 *  - tăng ca chỉ tính yêu cầu đã duyệt, cộng theo ngày rồi làm tròn xuống bội số `roundingMinutes`;
 *    hệ số: ngày lễ (holidays.multiplierBp) > cuối tuần > ngày thường; yêu cầu có multiplierBp riêng thì dùng riêng;
 *  - chỉ tính trong [hire_date, termination_date].
 */
export function computeEmployeeTimesheet(period: string, emp: TsEmployee, data: TsData, s: TsSettings): EmployeeTimesheet {
  const { first, last } = monthBounds(period);
  const lo = emp.hireDate > first ? emp.hireDate : first;
  const hi = emp.terminationDate && emp.terminationDate < last ? emp.terminationDate : last;
  const inRange = (d: string) => d >= lo && d <= hi;
  const days = new Map<string, TimesheetDay>();
  const day = (d: string) => {
    let r = days.get(d);
    if (!r) days.set(d, (r = blankDay(d)));
    return r;
  };
  const holidays = new Map(data.holidays.map((h) => [h.day, h]));
  const assignments = data.assignments.filter((a) => a.status !== "cancelled");
  const byId = new Map(assignments.map((a) => [a.id, a]));

  // 1) ghép cặp
  const punches = data.punches.filter((p) => p.status === "accepted").sort((a, b) => (a.serverAt < b.serverAt ? -1 : a.serverAt > b.serverAt ? 1 : a.id - b.id));
  const pairs: { inP: TsPunch; outP: TsPunch }[] = [];
  const unpairedIns: TsPunch[] = [];
  const orphanOuts: TsPunch[] = [];
  let open: TsPunch | null = null;
  for (const p of punches) {
    if (p.kind === "in") {
      if (open) unpairedIns.push(open);
      open = p;
    } else if (open && minutesBetween(open.serverAt, p.serverAt) <= MAX_SHIFT_MINUTES) {
      pairs.push({ inP: open, outP: p });
      open = null;
    } else {
      if (open) unpairedIns.push(open);
      open = null;
      orphanOuts.push(p);
    }
  }
  if (open) unpairedIns.push(open);

  const vnOf = (iso: string) => vnDate(new Date(iso));
  const dateOfIn = (p: TsPunch) => (p.assignmentId != null && byId.get(p.assignmentId)?.workDate) || vnOf(p.serverAt);

  // 2) gán ca cho mỗi cặp (assignment_id của punch vào; nếu thiếu thì ca gần nhất cùng ngày chưa dùng)
  const used = new Set<number>();
  const pairAssign = new Map<number, TsAssignment | undefined>();
  for (const pr of pairs) {
    const id = pr.inP.assignmentId;
    if (id != null && byId.has(id)) {
      pairAssign.set(pr.inP.id, byId.get(id));
      used.add(id);
    }
  }
  for (const pr of pairs) {
    if (pairAssign.has(pr.inP.id)) continue;
    const d = vnOf(pr.inP.serverAt);
    let best: TsAssignment | undefined;
    let bestGap = Infinity;
    for (const a of assignments) {
      if (used.has(a.id) || a.workDate !== d) continue;
      const gap = Math.abs(minutesBetween(a.startAt, pr.inP.serverAt));
      if (gap <= 6 * 60 && gap < bestGap) { best = a; bestGap = gap; }
    }
    if (best) used.add(best.id);
    pairAssign.set(pr.inP.id, best);
  }

  for (const pr of pairs) {
    const date = dateOfIn(pr.inP);
    if (!inRange(date)) continue;
    const a = pairAssign.get(pr.inP.id);
    const r = day(date);
    const gross = minutesBetween(pr.inP.serverAt, pr.outP.serverAt);
    r.workedMinutes += Math.max(0, gross - (a?.breakMinutes ?? 0));
    r.shiftsWorked += 1;
    if (a) {
      r.lateMinutes += Math.max(0, minutesBetween(a.startAt, pr.inP.serverAt) - s.lateGraceMinutes);
      r.earlyLeaveMinutes += Math.max(0, minutesBetween(pr.outP.serverAt, a.endAt));
    }
  }
  for (const p of unpairedIns) {
    const d = dateOfIn(p);
    if (inRange(d)) day(d).missingPunch = true;
  }
  for (const p of orphanOuts) {
    const d = vnOf(p.serverAt);
    if (inRange(d)) day(d).missingPunch = true;
  }

  // 3) giờ ca theo lịch
  for (const a of assignments) {
    if (!inRange(a.workDate)) continue;
    day(a.workDate).scheduledMinutes += Math.max(0, minutesBetween(a.startAt, a.endAt) - a.breakMinutes);
  }

  // 4) nghỉ phép đã duyệt: chỉ tính ngày làm việc theo lịch (C-15) — bỏ ngày lễ, ngày nghỉ hằng tuần,
  //    và ngày không có ca khi tuần đó nhân viên có lịch ca
  const assignDates = new Set(assignments.map((a) => a.workDate));
  for (const l of data.leaves) {
    if (l.status !== "approved") continue;
    const from = l.fromDate > lo ? l.fromDate : lo;
    const to = l.toDate < hi ? l.toDate : hi;
    if (from > to) continue;
    for (const d of leaveCountableDates(eachDate(from, to), new Set(holidays.keys()), s.weeklyOffDays ?? [], assignDates)) {
      const r = day(d);
      r.leaveCode = l.code;
      if (l.paid) r.leavePaidX10 += l.halfDay ? 5 : 10;
    }
  }

  // 5) ngày lễ
  for (const h of data.holidays) {
    if (!inRange(h.day)) continue;
    const r = day(h.day);
    r.holiday = true;
    if (h.paidOff) r.note = "holiday_paid_off";
  }

  // 6) tăng ca đã duyệt
  const otByDay = new Map<string, TsOvertime[]>();
  for (const o of data.overtime) {
    if (o.status !== "approved" || !inRange(o.workDate)) continue;
    (otByDay.get(o.workDate) ?? otByDay.set(o.workDate, []).get(o.workDate)!).push(o);
  }
  const step = Math.max(1, s.roundingMinutes);
  for (const [d, list] of otByDay) {
    const r = day(d);
    const raw = list.reduce((n, o) => n + o.minutes, 0);
    r.overtimeMinutes = Math.floor(raw / step) * step;
    const h = holidays.get(d);
    const override = list.find((o) => o.multiplierBp != null)?.multiplierBp;
    r.overtimeMultiplierBp = override ?? (h ? h.multiplierBp : isWeekend(d) ? s.otWeekendBp : s.otWeekdayBp);
  }
  for (const r of days.values()) {
    if (!r.overtimeMultiplierBp) {
      const h = holidays.get(r.workDate);
      r.overtimeMultiplierBp = h ? h.multiplierBp : isWeekend(r.workDate) ? s.otWeekendBp : s.otWeekdayBp;
    }
  }

  const list = [...days.values()].sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
  return { employeeId: emp.id, name: emp.name, days: list, totals: totalsOf(list) };
}

// ---------------------------------------------------------------------------------------------
// Tải dữ liệu + tính bảng công
// ---------------------------------------------------------------------------------------------

async function activeEmployees(db: D1Database, period: string, employeeId?: number) {
  const { first, last } = monthBounds(period);
  const { results } = await db
    .prepare(
      `SELECT id, full_name, hire_date, termination_date FROM employees
        WHERE hire_date <= ?1 AND (termination_date IS NULL OR termination_date >= ?2) ${employeeId ? "AND id = ?3" : ""} ORDER BY id`,
    )
    .bind(...(employeeId ? [last, first, employeeId] : [last, first]))
    .all<{ id: number; full_name: string; hire_date: string; termination_date: string | null }>();
  return results.map<TsEmployee>((e) => ({ id: e.id, name: e.full_name, hireDate: e.hire_date, terminationDate: e.termination_date }));
}

/** Tính "sống" từ punch/ca/tăng ca/phép/ngày lễ (bỏ qua snapshot). */
export async function computeTimesheetLive(db: D1Database, period: string, employeeId?: number): Promise<Timesheet> {
  const { first, last } = monthBounds(period);
  const emps = await activeEmployees(db, period, employeeId);
  const settings = await hrSettings(db);
  // mở rộng khoảng punch để cặp qua đêm không bị cắt ở biên kỳ
  const range = vnRangeUtc(addDays(first, -1), addDays(last, 2));
  const eq = employeeId ? " AND employee_id = ?" : "";
  const ebind = employeeId ? [employeeId] : [];
  const [pu, as, ot, lv, ho] = await Promise.all([
    // C-01: giờ hiệu lực = effective_at (chấm offline dùng giờ máy NV đã kiểm tra), bản ghi cũ chưa có thì server_at
    db.prepare(`SELECT id, employee_id, kind, COALESCE(effective_at, server_at) AS server_at, status, assignment_id FROM attendance_punches WHERE COALESCE(effective_at, server_at) >= ? AND COALESCE(effective_at, server_at) < ? AND status = 'accepted'${eq}`).bind(range.from, range.to, ...ebind).all<any>(),
    db.prepare(`SELECT id, employee_id, work_date, start_at, end_at, break_minutes, status FROM shift_assignments WHERE work_date >= ? AND work_date <= ? AND status != 'cancelled'${eq}`).bind(addDays(first, -7), addDays(last, 7), ...ebind).all<any>(),
    db.prepare(`SELECT employee_id, work_date, minutes, multiplier_bp, status FROM overtime_requests WHERE work_date >= ? AND work_date <= ? AND status = 'approved'${eq}`).bind(first, last, ...ebind).all<any>(),
    db.prepare(`SELECT lr.employee_id, lr.from_date, lr.to_date, lr.half_day, lr.status, lt.code, lt.paid FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.status = 'approved' AND lr.from_date <= ? AND lr.to_date >= ?${eq.replace("employee_id", "lr.employee_id")}`).bind(last, first, ...ebind).all<any>(),
    db.prepare(`SELECT day, name, multiplier_bp, paid_off FROM holidays WHERE day >= ? AND day <= ?`).bind(first, last).all<any>(),
  ]);
  const group = <T extends { employee_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) (m.get(r.employee_id) ?? m.set(r.employee_id, []).get(r.employee_id)!).push(r);
    return m;
  };
  const gp = group(pu.results as any[]), ga = group(as.results as any[]), go = group(ot.results as any[]), gl = group(lv.results as any[]);
  const holidays = ho.results.map<TsHoliday>((h) => ({ day: h.day, name: h.name, multiplierBp: h.multiplier_bp, paidOff: !!h.paid_off }));
  const employees = emps.map((e) =>
    computeEmployeeTimesheet(period, e, {
      punches: (gp.get(e.id) ?? []).map((p) => ({ id: p.id, kind: p.kind, serverAt: p.server_at, status: p.status, assignmentId: p.assignment_id })),
      assignments: (ga.get(e.id) ?? []).map((a) => ({ id: a.id, workDate: a.work_date, startAt: a.start_at, endAt: a.end_at, breakMinutes: a.break_minutes, status: a.status })),
      overtime: (go.get(e.id) ?? []).map((o) => ({ workDate: o.work_date, minutes: o.minutes, multiplierBp: o.multiplier_bp, status: o.status })),
      leaves: (gl.get(e.id) ?? []).map((l) => ({ fromDate: l.from_date, toDate: l.to_date, halfDay: !!l.half_day, code: l.code, paid: !!l.paid, status: l.status })),
      holidays,
    }, settings),
  );
  return { period, status: "open", employees };
}

async function readSnapshot(db: D1Database, period: string, employeeId?: number): Promise<Timesheet> {
  const emps = await activeEmployees(db, period, employeeId);
  const { results } = await db
    .prepare(`SELECT * FROM timesheet_days WHERE period = ?${employeeId ? " AND employee_id = ?" : ""} ORDER BY employee_id, work_date`)
    .bind(...(employeeId ? [period, employeeId] : [period]))
    .all<any>();
  const m = new Map<number, TimesheetDay[]>();
  for (const r of results) {
    (m.get(r.employee_id) ?? m.set(r.employee_id, []).get(r.employee_id)!).push({
      workDate: r.work_date, scheduledMinutes: r.scheduled_minutes, workedMinutes: r.worked_minutes, lateMinutes: r.late_minutes,
      earlyLeaveMinutes: r.early_leave_minutes, overtimeMinutes: r.overtime_minutes, overtimeMultiplierBp: r.overtime_multiplier_bp,
      shiftsWorked: r.shifts_worked, missingPunch: !!r.missing_punch, leaveCode: r.leave_code, leavePaidX10: r.leave_paid_x10,
      holiday: !!r.holiday, note: r.note,
    });
  }
  return {
    period,
    status: "closed",
    employees: emps.map((e) => {
      const days = m.get(e.id) ?? [];
      return { employeeId: e.id, name: e.name, days, totals: totalsOf(days) };
    }),
  };
}

/**
 * Điểm vào chung cho bảng công (route + payroll): kỳ đã chốt → đọc snapshot `timesheet_days`, kỳ mở → tính sống.
 * `period` = 'YYYY-MM'; `employeeId` tuỳ chọn. Mỗi ngày có: workDate, scheduledMinutes, workedMinutes, lateMinutes,
 * earlyLeaveMinutes, overtimeMinutes, overtimeMultiplierBp, shiftsWorked, missingPunch, leaveCode, leavePaidX10, holiday, note.
 */
export async function computeTimesheet(db: D1Database, period: string, employeeId?: number): Promise<Timesheet> {
  const t = await db.prepare(`SELECT status FROM timesheets WHERE period = ?`).bind(period).first<{ status: string }>();
  if (t?.status === "closed") return readSnapshot(db, period, employeeId);
  return computeTimesheetLive(db, period, employeeId);
}

export interface UnresolvedItems {
  pendingPunches: number;
  pendingCorrections: number;
  pendingLeaves: number;
  pendingOvertime: number;
  missingPunchDays: { employeeId: number; name: string; workDate: string }[];
}
export const hasUnresolved = (u: UnresolvedItems) =>
  u.pendingPunches + u.pendingCorrections + u.pendingLeaves + u.pendingOvertime + u.missingPunchDays.length > 0;

export async function collectUnresolved(db: D1Database, period: string, ts: Timesheet): Promise<UnresolvedItems> {
  const { first, last } = monthBounds(period);
  const r = vnRangeUtc(first, last);
  const one = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;
  return {
    pendingPunches: await one(`SELECT COUNT(*) n FROM attendance_punches WHERE status='pending' AND COALESCE(effective_at, server_at) >= ? AND COALESCE(effective_at, server_at) < ?`, r.from, r.to),
    pendingCorrections: await one(`SELECT COUNT(*) n FROM attendance_corrections WHERE status='pending' AND work_date >= ? AND work_date <= ?`, first, last),
    pendingLeaves: await one(`SELECT COUNT(*) n FROM leave_requests WHERE status='pending' AND from_date <= ? AND to_date >= ?`, last, first),
    pendingOvertime: await one(`SELECT COUNT(*) n FROM overtime_requests WHERE status='pending' AND work_date >= ? AND work_date <= ?`, first, last),
    missingPunchDays: ts.employees.flatMap((e) => e.days.filter((d) => d.missingPunch).map((d) => ({ employeeId: e.employeeId, name: e.name, workDate: d.workDate }))),
  };
}

export function snapshotStatements(db: D1Database, ts: Timesheet): D1PreparedStatement[] {
  return ts.employees.flatMap((e) =>
    e.days.map((d) =>
      db
        .prepare(
          `INSERT INTO timesheet_days(period, employee_id, work_date, scheduled_minutes, worked_minutes, late_minutes, early_leave_minutes,
             overtime_minutes, overtime_multiplier_bp, shifts_worked, missing_punch, leave_code, leave_paid_x10, holiday, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(ts.period, e.employeeId, d.workDate, d.scheduledMinutes, d.workedMinutes, d.lateMinutes, d.earlyLeaveMinutes, d.overtimeMinutes,
          d.overtimeMultiplierBp || 15000, d.shiftsWorked, d.missingPunch ? 1 : 0, d.leaveCode, d.leavePaidX10, d.holiday ? 1 : 0, d.note),
    ),
  );
}
