import { vnDate } from "../lib/time";
import {
  addDays, eachDate, hrSettings, isWeekend, leaveCountableDates, minutesBetween, monthBounds, shiftWindow, vnRangeUtc,
  type HrSettings,
} from "./hr-common";

/** Một ca/ngày không có giờ ra sau quá số phút này thì coi là quên chấm ra (không đoán giờ ra). */
export const MAX_SHIFT_MINUTES = 16 * 60;

/** serverAt = giờ HIỆU LỰC (effective_at; chấm offline = giờ máy NV đã kiểm tra). */
export interface TsPunch { id: number; kind: "in" | "out"; serverAt: string; status: string; assignmentId: number | null; note?: string | null }

/** Cờ của lần chấm thủ công: note chứa `flags:noLate,noEarly,noOt` → bỏ phần tương ứng khi tính công. */
export function punchFlags(note: string | null | undefined) {
  const m = /flags:([A-Za-z,]+)/.exec(note ?? "");
  const f = new Set((m?.[1] ?? "").split(",").filter(Boolean));
  return { noLate: f.has("noLate"), noEarly: f.has("noEarly"), noOt: f.has("noOt") };
}
/** Số công×10 của một ngày theo bậc (phút:công×10, tăng dần): bậc cao nhất mà số phút làm đạt tới; dưới bậc đầu = 0. */
export function tierUnitsX10(minutes: number, tiers: [number, number][]): number {
  let u = 0;
  for (const [m, x] of tiers) if (minutes >= m) u = x;
  return u;
}
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
export type TsSettings = Pick<HrSettings, "lateGraceMinutes" | "roundingMinutes" | "otWeekdayBp" | "otWeekendBp" | "otHolidayBp"> & {
  weeklyOffDays?: number[];
  /** Bảng chấm công — mọi khoá đều tuỳ chọn, thiếu = cách tính cũ. */
  attendanceMode?: "shift" | "window";
  windowStart?: string;
  windowEnd?: string;
  windowBreakStart?: string;
  windowBreakEnd?: string;
  earlyGraceMinutes?: number;
  otAuto?: boolean;
  otMinBeforeMinutes?: number;
  otMinAfterMinutes?: number;
  workdayTiers?: [number, number][];
  autoAttendance?: boolean;
  /** "Bây giờ" (ISO) để xét ca đã qua của auto_attendance; thiếu = giờ hệ thống. */
  nowIso?: string;
};

/** Kết quả theo từng ô (ca đã xếp, hoặc ô ngoài lịch / khung giờ) — nguồn cho bảng chấm công. */
export interface TsCell {
  /** `a:<assignmentId>` hoặc `u:<employeeId>:<workDate>` */
  key: string;
  employeeId: number;
  assignmentId: number | null;
  workDate: string;
  startAt: string | null;
  endAt: string | null;
  /** giờ vào đầu / ra cuối của các cặp được chấp nhận (hoặc giờ vào chưa có ra) */
  inAt: string | null;
  outAt: string | null;
  /** có lần vào chưa có ra / lần ra không có vào (đã được chấp nhận) */
  openInAt: string | null;
  orphanOutAt: string | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  otMinutes: number;
  shiftsWorked: number;
  /** ô tính tự động theo lịch (hr.auto_attendance) */
  auto: boolean;
}

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
  /** Số công×10 theo bậc `hr.workday_tiers`; null = chưa bật bậc công. */
  workUnitsX10: number | null;
  /** Số ca tính tự động theo lịch (hr.auto_attendance). */
  autoShifts: number;
}
export interface TimesheetTotals {
  workedMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number;
  missingDays: number; shiftsWorked: number; paidLeaveX10: number;
  /** số ngày có làm (workedMinutes > 0) */
  workDays: number;
  /** số ngày lễ nghỉ hưởng lương không đi làm */
  paidHolidayDays: number;
  /** Σ công×10 theo bậc (ngày null tính 0). */
  workUnitsX10: number;
}
export interface EmployeeTimesheet { employeeId: number; name: string; days: TimesheetDay[]; totals: TimesheetTotals; cells?: TsCell[] }
export interface Timesheet { period: string; status: "open" | "closed"; employees: EmployeeTimesheet[] }

const blankDay = (workDate: string): TimesheetDay => ({
  workDate, scheduledMinutes: 0, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0,
  overtimeMultiplierBp: 0, shiftsWorked: 0, missingPunch: false, leaveCode: null, leavePaidX10: 0, holiday: false, note: null, workUnitsX10: null, autoShifts: 0,
});

export function totalsOf(days: TimesheetDay[]): TimesheetTotals {
  const t: TimesheetTotals = { workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, missingDays: 0, shiftsWorked: 0, paidLeaveX10: 0, workDays: 0, paidHolidayDays: 0, workUnitsX10: 0 };
  for (const d of days) {
    t.workedMinutes += d.workedMinutes;
    t.lateMinutes += d.lateMinutes;
    t.earlyLeaveMinutes += d.earlyLeaveMinutes;
    t.overtimeMinutes += d.overtimeMinutes;
    t.shiftsWorked += d.shiftsWorked;
    t.paidLeaveX10 += d.leavePaidX10;
    t.workUnitsX10 += d.workUnitsX10 ?? 0;
    if (d.missingPunch) t.missingDays++;
    if (d.workedMinutes > 0) t.workDays++;
    if (d.holiday && d.note === "holiday_paid_off" && d.workedMinutes === 0) t.paidHolidayDays++;
  }
  return t;
}

/**
 * HÀM THUẦN tính bảng công một nhân viên cho một kỳ (quy tắc trong docs/API-dot4.md, "Quy tắc tính công" +
 * docs/API-attendance-board.md mục 3). Đây là CÔNG THỨC DUY NHẤT: bảng chấm công dạng lưới đọc `cells` từ đây.
 *  - chỉ punch `accepted`; ghép cặp in→out theo thời gian; in không có out → missingPunch (không đoán giờ ra);
 *  - ca qua đêm thuộc ngày bắt đầu (ngày của punch 'in', hoặc work_date của ca được gán);
 *  - worked = Σ(out−in) − nghỉ giữa ca; late = max(0, in−start−grace); early = max(0, end−out−earlyGrace);
 *  - cờ `flags:noLate,noEarly,noOt` trên lần chấm (chấm thủ công) bỏ phần tương ứng;
 *  - tăng ca = yêu cầu đã duyệt (hoặc, khi `otAuto`, phần chấm trước/sau ca đạt ngưỡng — lấy số lớn hơn, không cộng dồn),
 *    cộng theo ngày rồi làm tròn xuống bội số `roundingMinutes`;
 *    hệ số: ngày lễ (holidays.multiplierBp) > cuối tuần > ngày thường; yêu cầu có multiplierBp riêng thì dùng riêng;
 *  - `autoAttendance`: ca đã qua (≤ hôm qua), không có lần chấm nào (kể cả bị từ chối/chờ duyệt) và không nghỉ phép → đủ giờ theo lịch;
 *  - `workdayTiers`: mỗi ngày quy đổi giờ làm ra công×10;
 *  - chế độ `window`: mỗi ngày là một ca ảo [windowStart, windowEnd] trừ nghỉ giữa giờ, bỏ qua lịch ca;
 *  - chỉ tính trong [hire_date, termination_date].
 */
export function computeEmployeeTimesheet(period: string, emp: TsEmployee, data: TsData, s: TsSettings): EmployeeTimesheet {
  const { first, last } = monthBounds(period);
  const lo = emp.hireDate > first ? emp.hireDate : first;
  const hi = emp.terminationDate && emp.terminationDate < last ? emp.terminationDate : last;
  const inRange = (d: string) => d >= lo && d <= hi;
  const windowMode = s.attendanceMode === "window";
  const earlyGrace = Math.max(0, s.earlyGraceMinutes ?? 0);
  const otAuto = !!s.otAuto;
  const otBefore = Math.max(0, s.otMinBeforeMinutes ?? 0);
  const otAfter = Math.max(0, s.otMinAfterMinutes ?? 0);
  const days = new Map<string, TimesheetDay>();
  const day = (d: string) => {
    let r = days.get(d);
    if (!r) days.set(d, (r = blankDay(d)));
    return r;
  };
  const holidays = new Map(data.holidays.map((h) => [h.day, h]));
  // chế độ khung giờ: bỏ qua lịch ca (mỗi ngày là một ca ảo)
  const assignments = windowMode ? [] : data.assignments.filter((a) => a.status !== "cancelled");
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const step = Math.max(1, s.roundingMinutes);

  // ---- ô (cell) ----
  const cells = new Map<string, TsCell>();
  const otRawOf = new Map<string, number>();
  const newCell = (key: string, assignmentId: number | null, workDate: string, startAt: string | null, endAt: string | null): TsCell => ({
    key, employeeId: emp.id, assignmentId, workDate, startAt, endAt, inAt: null, outAt: null, openInAt: null, orphanOutAt: null,
    workedMinutes: 0, lateMinutes: 0, earlyMinutes: 0, otMinutes: 0, shiftsWorked: 0, auto: false,
  });
  /** Ca ảo của chế độ khung giờ cho một ngày. */
  const virtual = (date: string) => {
    const w = shiftWindow(date, s.windowStart ?? "08:00", s.windowEnd ?? "17:30");
    let brk: { startAt: string; endAt: string } | null = null;
    if (s.windowBreakStart && s.windowBreakEnd && s.windowBreakEnd > s.windowBreakStart) {
      brk = shiftWindow(date, s.windowBreakStart, s.windowBreakEnd);
    }
    return { ...w, brk };
  };
  const overlapMin = (aS: string, aE: string, b: { startAt: string; endAt: string } | null) => {
    if (!b) return 0;
    const ms = Math.min(Date.parse(aE), Date.parse(b.endAt)) - Math.max(Date.parse(aS), Date.parse(b.startAt));
    return ms > 0 ? Math.floor(ms / 60000) : 0;
  };
  const cellFor = (a: TsAssignment | undefined, date: string): TsCell => {
    const key = a ? `a:${a.id}` : `u:${emp.id}:${date}`;
    let c = cells.get(key);
    if (!c) {
      if (a) c = newCell(key, a.id, a.workDate, a.startAt, a.endAt);
      else if (windowMode) {
        const v = virtual(date);
        c = newCell(key, null, date, v.startAt, v.endAt);
        day(date).scheduledMinutes = Math.max(0, minutesBetween(v.startAt, v.endAt) - (v.brk ? minutesBetween(v.brk.startAt, v.brk.endAt) : 0));
      } else c = newCell(key, null, date, null, null);
      cells.set(key, c);
    }
    return c;
  };
  for (const a of assignments) if (inRange(a.workDate)) cellFor(a, a.workDate);

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

  // chế độ khung giờ: nhóm cặp theo ngày — muộn tính ở cặp đầu, sớm tính ở cặp cuối
  const winGroups = new Map<string, typeof pairs>();
  if (windowMode) for (const pr of pairs) (winGroups.get(vnOf(pr.inP.serverAt)) ?? winGroups.set(vnOf(pr.inP.serverAt), []).get(vnOf(pr.inP.serverAt))!).push(pr);

  for (const pr of pairs) {
    const date = dateOfIn(pr.inP);
    if (!inRange(date)) continue;
    const a = pairAssign.get(pr.inP.id);
    const r = day(date);
    const cell = cellFor(a, date);
    const gross = minutesBetween(pr.inP.serverAt, pr.outP.serverAt);
    const fi = punchFlags(pr.inP.note);
    const fo = punchFlags(pr.outP.note);
    const noLate = fi.noLate || fo.noLate;
    const noEarly = fi.noEarly || fo.noEarly;
    const noOt = fi.noOt || fo.noOt;
    let worked: number;
    let late = 0;
    let early = 0;
    let otRaw = 0;
    if (windowMode) {
      const v = virtual(date);
      const g = winGroups.get(date)!;
      const firstOfDay = g[0] === pr;
      const lastOfDay = g[g.length - 1] === pr;
      worked = Math.max(0, gross - overlapMin(pr.inP.serverAt, pr.outP.serverAt, v.brk));
      if (firstOfDay) {
        const lateRaw = minutesBetween(v.startAt, pr.inP.serverAt);
        if (lateRaw > 0) late = Math.max(0, lateRaw - overlapMin(v.startAt, pr.inP.serverAt, v.brk) - s.lateGraceMinutes);
        const before = minutesBetween(pr.inP.serverAt, v.startAt);
        if (otAuto && before > 0 && before >= otBefore) otRaw += before;
      }
      if (lastOfDay) {
        const earlyRaw = minutesBetween(pr.outP.serverAt, v.endAt);
        if (earlyRaw > 0) early = Math.max(0, earlyRaw - overlapMin(pr.outP.serverAt, v.endAt, v.brk) - earlyGrace);
        const after = minutesBetween(v.endAt, pr.outP.serverAt);
        if (otAuto && after > 0 && after >= otAfter) otRaw += after;
      }
    } else {
      worked = Math.max(0, gross - (a?.breakMinutes ?? 0));
      if (a) {
        late = Math.max(0, minutesBetween(a.startAt, pr.inP.serverAt) - s.lateGraceMinutes);
        early = Math.max(0, minutesBetween(pr.outP.serverAt, a.endAt) - earlyGrace);
        const before = minutesBetween(pr.inP.serverAt, a.startAt);
        const after = minutesBetween(a.endAt, pr.outP.serverAt);
        if (otAuto && before > 0 && before >= otBefore) otRaw += before;
        if (otAuto && after > 0 && after >= otAfter) otRaw += after;
      }
    }
    if (noLate) late = 0;
    if (noEarly) early = 0;
    if (noOt) otRaw = 0;
    r.workedMinutes += worked;
    r.shiftsWorked += 1;
    r.lateMinutes += late;
    r.earlyLeaveMinutes += early;
    cell.workedMinutes += worked;
    cell.shiftsWorked += 1;
    cell.lateMinutes += late;
    cell.earlyMinutes += early;
    otRawOf.set(cell.key, (otRawOf.get(cell.key) ?? 0) + otRaw);
    if (!cell.inAt || pr.inP.serverAt < cell.inAt) cell.inAt = pr.inP.serverAt;
    if (!cell.outAt || pr.outP.serverAt > cell.outAt) cell.outAt = pr.outP.serverAt;
  }
  /** Ca của lần chấm lẻ: assignment_id, không có thì ca gần nhất cùng ngày (chỉ để hiển thị, không đánh dấu "đã dùng"). */
  const looseAssignment = (p: TsPunch, by: "start" | "end") => {
    if (p.assignmentId != null && byId.has(p.assignmentId)) return byId.get(p.assignmentId);
    const d = vnOf(p.serverAt);
    let best: TsAssignment | undefined;
    let bestGap = 8 * 60;
    for (const a of assignments) {
      if (a.workDate !== d && a.workDate !== addDays(d, -1)) continue;
      const gap = Math.abs(minutesBetween(by === "start" ? a.startAt : a.endAt, p.serverAt));
      if (gap <= bestGap) { best = a; bestGap = gap; }
    }
    return best;
  };
  for (const p of unpairedIns) {
    const d = dateOfIn(p);
    if (!inRange(d)) continue;
    day(d).missingPunch = true;
    const c = cellFor(looseAssignment(p, "start"), d);
    if (!c.openInAt || p.serverAt < c.openInAt) c.openInAt = p.serverAt;
  }
  for (const p of orphanOuts) {
    const d = vnOf(p.serverAt);
    if (!inRange(d)) continue;
    day(d).missingPunch = true;
    const c = cellFor(looseAssignment(p, "end"), d);
    c.orphanOutAt = p.serverAt;
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

  // 5b) tự chấm công theo lịch: ca đã qua, không có lần chấm nào, không nghỉ phép → đủ giờ theo lịch
  if (s.autoAttendance && !windowMode) {
    const nowIso = s.nowIso ?? new Date().toISOString();
    const yesterday = addDays(vnOf(nowIso), -1);
    const nowMs = Date.parse(nowIso);
    for (const a of assignments) {
      if (!inRange(a.workDate) || a.workDate > yesterday || Date.parse(a.endAt) > nowMs) continue;
      const r = day(a.workDate);
      if (r.leaveCode) continue;
      const lowMs = Date.parse(a.startAt) - 60 * 60000;
      const highMs = Date.parse(a.endAt) + 60 * 60000;
      const touched = data.punches.some((p) => p.assignmentId === a.id || (p.assignmentId == null && Date.parse(p.serverAt) >= lowMs && Date.parse(p.serverAt) <= highMs));
      if (touched) continue;
      const mins = Math.max(0, minutesBetween(a.startAt, a.endAt) - a.breakMinutes);
      r.workedMinutes += mins;
      r.shiftsWorked += 1;
      r.autoShifts += 1;
      const c = cellFor(a, a.workDate);
      c.workedMinutes = mins;
      c.shiftsWorked = 1;
      c.auto = true;
    }
  }

  // 6) tăng ca: đã duyệt, và (khi otAuto) tự tính từ giờ chấm ngoài ca — lấy số lớn hơn mỗi ngày
  const otByDay = new Map<string, TsOvertime[]>();
  for (const o of data.overtime) {
    if (o.status !== "approved" || !inRange(o.workDate)) continue;
    (otByDay.get(o.workDate) ?? otByDay.set(o.workDate, []).get(o.workDate)!).push(o);
  }
  const autoOtByDay = new Map<string, number>();
  if (otAuto) for (const c of cells.values()) if (inRange(c.workDate)) autoOtByDay.set(c.workDate, (autoOtByDay.get(c.workDate) ?? 0) + (otRawOf.get(c.key) ?? 0));
  for (const d of new Set([...otByDay.keys(), ...[...autoOtByDay].filter(([, v]) => v > 0).map(([k]) => k)])) {
    const list = otByDay.get(d) ?? [];
    const r = day(d);
    const raw = Math.max(list.reduce((n, o) => n + o.minutes, 0), autoOtByDay.get(d) ?? 0);
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
  // OT theo ô: tự tính → phần của chính ô; không → tăng ca đã duyệt của ngày gắn vào ô cuối có công
  const lastWorkedCell = new Map<string, TsCell>();
  for (const c of cells.values()) {
    if (otAuto) c.otMinutes = Math.floor((otRawOf.get(c.key) ?? 0) / step) * step;
    if (c.shiftsWorked > 0 && (!lastWorkedCell.has(c.workDate) || (c.outAt ?? "") >= (lastWorkedCell.get(c.workDate)!.outAt ?? ""))) lastWorkedCell.set(c.workDate, c);
  }
  if (!otAuto) for (const [d, c] of lastWorkedCell) c.otMinutes = days.get(d)?.overtimeMinutes ?? 0;

  // 7) quy đổi ra công theo bậc giờ THƯỜNG (đã trừ tăng ca; K-HR3)
  const tiers = s.workdayTiers ?? [];
  if (tiers.length) for (const r of days.values()) r.workUnitsX10 = tierUnitsX10(Math.max(0, r.workedMinutes - r.overtimeMinutes), tiers); // K-HR3: bậc công chỉ tính giờ thường, tăng ca trả riêng

  const list = [...days.values()].sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
  const cellList = [...cells.values()].filter((c) => inRange(c.workDate)).sort((a, b) => (a.workDate === b.workDate ? ((a.startAt ?? "") < (b.startAt ?? "") ? -1 : 1) : a.workDate < b.workDate ? -1 : 1));
  return { employeeId: emp.id, name: emp.name, days: list, totals: totalsOf(list), cells: cellList };
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

/** Cấu hình tính công từ settings hr.* (kèm "bây giờ" để xét ca đã qua). */
export const tsSettingsOf = (hs: HrSettings): TsSettings => ({
  lateGraceMinutes: hs.lateGraceMinutes, roundingMinutes: hs.roundingMinutes, otWeekdayBp: hs.otWeekdayBp, otWeekendBp: hs.otWeekendBp, otHolidayBp: hs.otHolidayBp,
  weeklyOffDays: hs.weeklyOffDays,
  attendanceMode: hs.attendanceMode, windowStart: hs.windowStart, windowEnd: hs.windowEnd, windowBreakStart: hs.windowBreakStart, windowBreakEnd: hs.windowBreakEnd,
  earlyGraceMinutes: hs.earlyGraceMinutes, otAuto: hs.otAuto, otMinBeforeMinutes: hs.otMinBeforeMinutes, otMinAfterMinutes: hs.otMinAfterMinutes,
  workdayTiers: hs.workdayTiers, autoAttendance: hs.autoAttendance, nowIso: new Date().toISOString(),
});

/** Tính "sống" từ punch/ca/tăng ca/phép/ngày lễ (bỏ qua snapshot). `employeeIds` (tuỳ chọn) chỉ để lọc kết quả — dữ liệu vẫn tải theo khoảng ngày. */
export async function computeTimesheetLive(db: D1Database, period: string, employeeId?: number, employeeIds?: Set<number>): Promise<Timesheet> {
  const { first, last } = monthBounds(period);
  const emps = (await activeEmployees(db, period, employeeId)).filter((e) => !employeeIds || employeeIds.has(e.id));
  const settings = tsSettingsOf(await hrSettings(db));
  // mở rộng khoảng punch để cặp qua đêm không bị cắt ở biên kỳ
  const range = vnRangeUtc(addDays(first, -1), addDays(last, 2));
  const eq = employeeId ? " AND employee_id = ?" : "";
  const ebind = employeeId ? [employeeId] : [];
  const [pu, as, ot, lv, ho] = await Promise.all([
    // C-01: giờ hiệu lực = effective_at (chấm offline dùng giờ máy NV đã kiểm tra), bản ghi cũ chưa có thì server_at.
    // Lấy mọi trạng thái (hàm tính tự lọc 'accepted'; tự chấm công cần biết có lần chấm bị từ chối / chờ duyệt hay không).
    db.prepare(`SELECT id, employee_id, kind, COALESCE(effective_at, server_at) AS server_at, status, assignment_id, note FROM attendance_punches WHERE COALESCE(effective_at, server_at) >= ? AND COALESCE(effective_at, server_at) < ?${eq}`).bind(range.from, range.to, ...ebind).all<any>(),
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
      punches: (gp.get(e.id) ?? []).map((p) => ({ id: p.id, kind: p.kind, serverAt: p.server_at, status: p.status, assignmentId: p.assignment_id, note: p.note })),
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
      holiday: !!r.holiday, note: r.note, workUnitsX10: r.work_units_x10 ?? null, autoShifts: 0,
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
             overtime_minutes, overtime_multiplier_bp, shifts_worked, missing_punch, leave_code, leave_paid_x10, holiday, note, work_units_x10)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(ts.period, e.employeeId, d.workDate, d.scheduledMinutes, d.workedMinutes, d.lateMinutes, d.earlyLeaveMinutes, d.overtimeMinutes,
          d.overtimeMultiplierBp || 15000, d.shiftsWorked, d.missingPunch ? 1 : 0, d.leaveCode, d.leavePaidX10, d.holiday ? 1 : 0, d.note, d.workUnitsX10 ?? null),
    ),
  );
}
