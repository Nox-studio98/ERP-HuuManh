/**
 * Bảng chấm công dạng lưới (docs/API-attendance-board.md): dựng "ô" từ computeEmployeeTimesheet — KHÔNG có công thức thứ hai.
 * Mọi số muộn/sớm/giờ làm/làm thêm của ô lấy từ `EmployeeTimesheet.cells`; ở đây chỉ gắn thêm trạng thái hiển thị,
 * số việc chờ duyệt, phạt/thưởng, người làm thay.
 */
import { vnDate } from "../lib/time";
import { addDays, eachDate, hrSettings, minutesBetween, periodOf, vnRangeUtc } from "./hr-common";
import { MAX_SHIFT_MINUTES, computeTimesheetLive, type TsCell, type Timesheet } from "./hr-timesheet";

export type CellStatus = "on_time" | "late_early" | "incomplete" | "not_yet" | "leave" | "auto" | "upcoming" | "working";

export interface BoardCell {
  key: string;
  assignmentId: number | null;
  employeeId: number;
  workDate: string;
  shiftId: number;
  startAt: string | null;
  endAt: string | null;
  inAt: string | null;
  outAt: string | null;
  status: CellStatus;
  lateMinutes: number;
  earlyMinutes: number;
  otMinutes: number;
  workedMinutes: number;
  pending: number;
  leaveCode: string | null;
  leavePaid: boolean | null;
  substituteForId: number | null;
  substituteForEmployeeId: number | null;
  incidents: { penalty: number; bonus: number; amountPenalty?: number; amountBonus?: number };
  manual: boolean;
}

export interface BoardResult {
  from: string;
  to: string;
  today: string;
  mode: "shift" | "window";
  shifts: { id: number; name: string; startTime: string; endTime: string; active: boolean }[];
  employees: { id: number; code: string; name: string; position: string | null }[];
  cells: BoardCell[];
  pendingTotal: number;
  periodsClosed: string[];
}

const periodsOfRange = (from: string, to: string) => [...new Set(eachDate(from, to).map(periodOf))];

/** Tổng việc chờ duyệt toàn hệ thống (nút "Duyệt chấm công (n)"). */
export async function pendingTotal(db: D1Database): Promise<number> {
  const one = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const [a, b, c, d, e, f] = await Promise.all([
    one(`SELECT COUNT(*) n FROM attendance_punches WHERE status = 'pending' OR (status = 'accepted' AND review_flag = 1)`),
    one(`SELECT COUNT(*) n FROM attendance_corrections WHERE status = 'pending'`),
    one(`SELECT COUNT(*) n FROM leave_requests WHERE status = 'pending'`),
    one(`SELECT COUNT(*) n FROM overtime_requests WHERE status = 'pending'`),
    one(`SELECT COUNT(*) n FROM devices_registry_requests WHERE status = 'pending'`),
    one(`SELECT COUNT(*) n FROM shift_swap_requests WHERE status = 'accepted'`),
  ]);
  return a + b + c + d + e + f;
}

export interface BoardOpts {
  from: string;
  to: string;
  q?: string;
  storeId?: number;
  /** chỉ các nhân viên này (bỏ qua q/storeId) */
  employeeIds?: number[];
  /** người xem có quyền thấy số tiền phạt/thưởng (hr.sensitive hoặc hr.schedule) */
  money: boolean;
  /** bỏ danh sách ca/pendingTotal (dùng khi chỉ cần các ô) */
  light?: boolean;
}

const escLike = (s: string) => `%${s.trim().replace(/[\\%_]/g, (m) => "\\" + m)}%`;

export async function loadBoard(db: D1Database, o: BoardOpts): Promise<BoardResult> {
  const { from, to } = o;
  const hs = await hrSettings(db);
  const windowMode = hs.attendanceMode === "window";
  const today = vnDate();
  const nowMs = Date.now();

  // 1) nhân viên
  const conds = [`e.hire_date <= ?`, `(e.termination_date IS NULL OR e.termination_date >= ?)`];
  const params: unknown[] = [to, from];
  if (o.employeeIds) {
    if (!o.employeeIds.length) conds.push("0");
    else { conds.push(`e.id IN (${o.employeeIds.map(() => "?").join(",")})`); params.push(...o.employeeIds); }
  } else {
    if (o.storeId) { conds.push(`e.store_id = ?`); params.push(o.storeId); }
    if (o.q?.trim()) { conds.push(`(e.full_name LIKE ? ESCAPE '\\' OR e.code LIKE ? ESCAPE '\\')`); params.push(escLike(o.q), escLike(o.q)); }
  }
  const emps = (await db.prepare(`SELECT e.id, e.code, e.full_name, e.position FROM employees e WHERE ${conds.join(" AND ")} ORDER BY e.full_name, e.id`).bind(...params).all<any>()).results;
  const empSet = new Set<number>(emps.map((e) => e.id));

  // 2) bảng công sống theo từng kỳ trong khoảng → ô + ngày nghỉ phép
  const cellsByKey = new Map<string, TsCell>();
  const dayInfo = new Map<string, { leaveCode: string | null; leavePaid: boolean }>();
  for (const period of periodsOfRange(from, to)) {
    const ts: Timesheet = await computeTimesheetLive(db, period, undefined, empSet);
    for (const e of ts.employees) {
      for (const c of e.cells ?? []) if (c.workDate >= from && c.workDate <= to) cellsByKey.set(c.key, c);
      for (const d of e.days) if (d.workDate >= from && d.workDate <= to && d.leaveCode) dayInfo.set(`${e.employeeId}:${d.workDate}`, { leaveCode: d.leaveCode, leavePaid: d.leavePaidX10 > 0 });
    }
  }

  // 3) dữ liệu phụ: ca (mẫu ca, người làm thay), lần chấm, bổ sung công, phạt/thưởng
  const asg = new Map<number, { shiftId: number; subFor: number | null; subForEmp: number | null }>();
  {
    const { results } = await db
      .prepare(
        `SELECT sa.id, sa.shift_template_id, sa.substitute_for_id, o.employee_id AS sub_emp FROM shift_assignments sa LEFT JOIN shift_assignments o ON o.id = sa.substitute_for_id
          WHERE sa.work_date >= ? AND sa.work_date <= ? AND sa.status = 'scheduled'`,
      )
      .bind(from, to)
      .all<any>();
    for (const r of results) asg.set(r.id, { shiftId: r.shift_template_id, subFor: r.substitute_for_id, subForEmp: r.sub_emp });
  }
  const r = vnRangeUtc(addDays(from, -1), addDays(to, 1));
  const punchRows = (
    await db
      .prepare(
        `SELECT id, employee_id, kind, COALESCE(effective_at, server_at) AS at, status, assignment_id, method, review_flag FROM attendance_punches
          WHERE status != 'rejected' AND COALESCE(effective_at, server_at) >= ? AND COALESCE(effective_at, server_at) < ?`,
      )
      .bind(r.from, r.to)
      .all<any>()
  ).results.filter((p) => empSet.has(p.employee_id));
  const corrRows = (
    await db.prepare(`SELECT employee_id, work_date FROM attendance_corrections WHERE status = 'pending' AND work_date >= ? AND work_date <= ?`).bind(from, to).all<any>()
  ).results.filter((p) => empSet.has(p.employee_id));
  const incRows = (
    await db
      .prepare(`SELECT employee_id, work_date, assignment_id, kind, times, amount FROM attendance_incidents WHERE voided_at IS NULL AND work_date >= ? AND work_date <= ?`)
      .bind(from, to)
      .all<any>()
  ).results.filter((p) => empSet.has(p.employee_id));

  // 4) gắn dữ liệu phụ vào ô; ô "ngoài lịch" được tạo thêm khi có lần chấm chờ duyệt / bổ sung công mà chưa có ô nào của ngày đó
  const cells = new Map<string, BoardCell>();
  const mk = (c: TsCell): BoardCell => {
    const a = c.assignmentId != null ? asg.get(c.assignmentId) : undefined;
    return {
      key: c.key, assignmentId: c.assignmentId, employeeId: c.employeeId, workDate: c.workDate, shiftId: windowMode ? 0 : a?.shiftId ?? 0,
      startAt: c.startAt, endAt: c.endAt, inAt: c.inAt ?? c.openInAt, outAt: c.outAt ?? c.orphanOutAt, status: "upcoming",
      lateMinutes: c.lateMinutes, earlyMinutes: c.earlyMinutes, otMinutes: c.otMinutes, workedMinutes: c.workedMinutes, pending: 0,
      leaveCode: null, leavePaid: null, substituteForId: a?.subFor ?? null, substituteForEmployeeId: a?.subForEmp ?? null,
      incidents: o.money ? { penalty: 0, bonus: 0, amountPenalty: 0, amountBonus: 0 } : { penalty: 0, bonus: 0 }, manual: false,
    };
  };
  const tsOf = new Map<string, TsCell>();
  for (const c of cellsByKey.values()) { cells.set(c.key, mk(c)); tsOf.set(c.key, c); }

  const byEmpDate = new Map<string, BoardCell[]>();
  const index = () => {
    byEmpDate.clear();
    for (const c of cells.values()) (byEmpDate.get(`${c.employeeId}:${c.workDate}`) ?? byEmpDate.set(`${c.employeeId}:${c.workDate}`, []).get(`${c.employeeId}:${c.workDate}`)!).push(c);
  };
  index();
  /** Ô nhận một lần chấm / phạt / bổ sung: theo ca, hoặc ô ngoài lịch của ngày, hoặc ca gần giờ nhất; không có → tạo ô ngoài lịch. */
  const target = (empId: number, date: string, assignmentId: number | null, atIso: string | null, create: boolean): BoardCell | null => {
    if (!windowMode && assignmentId != null && cells.has(`a:${assignmentId}`)) return cells.get(`a:${assignmentId}`)!;
    const list = byEmpDate.get(`${empId}:${date}`) ?? [];
    const u = list.find((c) => c.assignmentId == null);
    if (u) return u;
    if (!windowMode && list.length) {
      if (!atIso) return list[0];
      let best = list[0];
      let gap = Infinity;
      for (const c of list) {
        const g = c.startAt ? Math.abs(minutesBetween(c.startAt, atIso)) : Infinity;
        if (g < gap) { gap = g; best = c; }
      }
      return best;
    }
    if (!create) return null;
    const virt: TsCell = {
      key: `u:${empId}:${date}`, employeeId: empId, assignmentId: null, workDate: date, startAt: null, endAt: null, inAt: null, outAt: null, openInAt: null, orphanOutAt: null,
      workedMinutes: 0, lateMinutes: 0, earlyMinutes: 0, otMinutes: 0, shiftsWorked: 0, auto: false,
    };
    const b = mk(virt);
    cells.set(b.key, b);
    tsOf.set(b.key, virt);
    index();
    return b;
  };
  for (const p of punchRows) {
    const date = vnDate(new Date(p.at));
    if (date < from || date > to) continue;
    const isPending = p.status === "pending";
    const c = target(p.employee_id, date, p.assignment_id, p.at, isPending);
    if (!c) continue;
    if (isPending) c.pending++;
    if (p.method === "manual") c.manual = true;
  }
  for (const p of corrRows) {
    const c = target(p.employee_id, p.work_date, null, null, true);
    if (c) c.pending++;
  }
  for (const i of incRows) {
    const c = target(i.employee_id, i.work_date, i.assignment_id, null, false);
    if (!c) continue;
    if (i.kind === "penalty") { c.incidents.penalty += i.times; if (c.incidents.amountPenalty !== undefined) c.incidents.amountPenalty += i.amount; }
    else { c.incidents.bonus += i.times; if (c.incidents.amountBonus !== undefined) c.incidents.amountBonus += i.amount; }
  }

  // 5) trạng thái
  for (const c of cells.values()) {
    const ts = tsOf.get(c.key)!;
    const leave = dayInfo.get(`${c.employeeId}:${c.workDate}`);
    if (leave) { c.leaveCode = leave.leaveCode; c.leavePaid = leave.leavePaid; }
    c.status = statusOf(c, ts, !!leave, nowMs);
  }

  const list = [...cells.values()].sort((a, b) => (a.workDate === b.workDate ? ((a.startAt ?? "~") < (b.startAt ?? "~") ? -1 : (a.startAt ?? "~") > (b.startAt ?? "~") ? 1 : a.employeeId - b.employeeId) : a.workDate < b.workDate ? -1 : 1));

  let shifts: BoardResult["shifts"] = [];
  let pt = 0;
  if (!o.light) {
    if (windowMode) shifts = [{ id: 0, name: "Khung giờ làm việc", startTime: hs.windowStart, endTime: hs.windowEnd, active: true }];
    else {
      const { results } = await db.prepare(`SELECT id, name, start_time, end_time, active FROM shift_templates ORDER BY start_time, id`).all<any>();
      shifts = results.map((t) => ({ id: t.id, name: t.name, startTime: t.start_time, endTime: t.end_time, active: !!t.active }));
    }
    pt = await pendingTotal(db);
  }
  const periods = periodsOfRange(from, to);
  const closed = (await db.prepare(`SELECT period FROM timesheets WHERE status = 'closed' AND period IN (${periods.map(() => "?").join(",")}) ORDER BY period`).bind(...periods).all<{ period: string }>()).results.map((x) => x.period);
  return {
    from, to, today, mode: hs.attendanceMode, shifts,
    employees: emps.map((e) => ({ id: e.id, code: e.code, name: e.full_name, position: e.position ?? null })),
    cells: list, pendingTotal: pt, periodsClosed: closed,
  };
}

/** Trạng thái hiển thị của ô (bảng ở docs/API-attendance-board.md mục 1). */
function statusOf(c: BoardCell, ts: TsCell, onLeave: boolean, nowMs: number): CellStatus {
  const worked = ts.shiftsWorked > 0 && !ts.auto;
  if (onLeave && !worked) return "leave";
  if (c.pending > 0) return "incomplete";
  if (worked) return c.lateMinutes > 0 || c.earlyMinutes > 0 ? "late_early" : "on_time";
  if (ts.auto) return "auto";
  if (ts.openInAt) {
    const ended = c.endAt ? nowMs > Date.parse(c.endAt) : nowMs - Date.parse(ts.openInAt) > MAX_SHIFT_MINUTES * 60000;
    return ended ? "incomplete" : "working";
  }
  if (ts.orphanOutAt) return "incomplete";
  if (!c.startAt || nowMs >= Date.parse(c.startAt)) return "not_yet";
  return "upcoming";
}

/** Các lần chấm thuộc một ô (kể cả đã từ chối): theo ca (assignment_id hoặc lần chấm không gắn ca trong khung giờ ca ±3 giờ) hoặc theo ngày VN cho ô ngoài lịch. */
export async function selectCellPunches(
  db: D1Database,
  o: { employeeId: number; workDate: string; assignment: { id: number; startAt: string; endAt: string } | null; windowMode: boolean; statuses?: string[] },
) {
  const st = o.statuses ? ` AND p.status IN (${o.statuses.map(() => "?").join(",")})` : "";
  const stb = o.statuses ?? [];
  const sel = `SELECT p.*, COALESCE(p.effective_at, p.server_at) AS at, cu.full_name AS created_name, du.full_name AS decided_name
                 FROM attendance_punches p LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users du ON du.id = p.decided_by`;
  if (o.assignment) {
    const lo = new Date(Date.parse(o.assignment.startAt) - 3 * 3600_000).toISOString();
    const hi = new Date(Date.parse(o.assignment.endAt) + 3 * 3600_000).toISOString();
    return (
      await db
        .prepare(`${sel} WHERE p.employee_id = ? AND (p.assignment_id = ? OR (p.assignment_id IS NULL AND COALESCE(p.effective_at, p.server_at) >= ? AND COALESCE(p.effective_at, p.server_at) <= ?))${st} ORDER BY COALESCE(p.effective_at, p.server_at), p.id`)
        .bind(o.employeeId, o.assignment.id, lo, hi, ...stb)
        .all<any>()
    ).results;
  }
  const day = vnRangeUtc(o.workDate, o.workDate);
  return (
    await db
      .prepare(`${sel} WHERE p.employee_id = ? AND COALESCE(p.effective_at, p.server_at) >= ? AND COALESCE(p.effective_at, p.server_at) < ? ${o.windowMode ? "" : "AND p.assignment_id IS NULL"}${st} ORDER BY COALESCE(p.effective_at, p.server_at), p.id`)
      .bind(o.employeeId, day.from, day.to, ...stb)
      .all<any>()
  ).results;
}
