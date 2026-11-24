import { AppError, conflict } from "../lib/errors";
import { vnDate, vnDayRangeUtc } from "../lib/time";

const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 86400_000;

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
export const isPeriod = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const periodOf = (date: string) => date.slice(0, 7);

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}
/** 0 = Chủ nhật … 6 = Thứ bảy (theo ngày VN đã cho). */
export const dayOfWeek = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();
export const isWeekend = (date: string) => [0, 6].includes(dayOfWeek(date));

export function monthBounds(period: string) {
  const first = period + "-01";
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { first, last };
}
export const eachDate = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Giờ VN "HH:MM" của một ngày VN → ISO UTC. */
export const vnLocalToUtc = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00Z`) - VN_OFFSET_MS).toISOString();

/** Ca làm: start/end UTC tính từ giờ VN; end <= start nghĩa là ca qua đêm, kết thúc ngày hôm sau. */
export function shiftWindow(workDate: string, startTime: string, endTime: string) {
  const startAt = vnLocalToUtc(workDate, startTime);
  let endAt = vnLocalToUtc(workDate, endTime);
  if (endTime <= startTime) endAt = vnLocalToUtc(addDays(workDate, 1), endTime);
  return { startAt, endAt };
}

export const minutesBetween = (a: string, b: string) => Math.floor((Date.parse(b) - Date.parse(a)) / 60000);

/** Khoảng UTC [from, to) của các ngày VN from..to (gồm cả ngày to). */
export const vnRangeUtc = (from: string, to: string) => ({ from: vnDayRangeUtc(from).from, to: vnDayRangeUtc(to).to });

export interface HrSettings {
  lateGraceMinutes: number;
  roundingMinutes: number;
  otWeekdayBp: number;
  otWeekendBp: number;
  otHolidayBp: number;
  methods: string[];
  gpsMaxAccuracyM: number;
  qrWindowSeconds: number;
  /** C-15: ngày nghỉ hằng tuần (1 = Thứ Hai … 7 = Chủ nhật) — không tính vào số ngày phép. */
  weeklyOffDays: number[];
}

/** "6,7" → [6,7]; bỏ giá trị ngoài 1..7. */
export const parseWeeklyOff = (v: string | undefined | null): number[] =>
  [...new Set((v ?? "").split(/[,\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))];

/** Thứ trong tuần kiểu ISO: 1 = Thứ Hai … 7 = Chủ nhật. */
export const isoWeekday = (date: string) => ((dayOfWeek(date) + 6) % 7) + 1;
/** Ngày Thứ Hai của tuần chứa `date`. */
export const weekStart = (date: string) => addDays(date, -(isoWeekday(date) - 1));

/**
 * C-15: các ngày của đơn nghỉ phép được tính là ngày nghỉ — bỏ ngày lễ, ngày nghỉ hằng tuần,
 * và ngày không có ca khi nhân viên CÓ lịch ca trong tuần đó (không có lịch cả tuần → coi như chưa xếp lịch, tính ngày thường).
 */
export function leaveCountableDates(dates: string[], holidays: Set<string>, weeklyOff: number[], assignmentDates: Set<string>): string[] {
  const scheduledWeeks = new Set([...assignmentDates].map(weekStart));
  return dates.filter((d) => {
    if (holidays.has(d) || weeklyOff.includes(isoWeekday(d))) return false;
    if (scheduledWeeks.has(weekStart(d)) && !assignmentDates.has(d)) return false;
    return true;
  });
}

export async function hrSettings(db: D1Database): Promise<HrSettings> {
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'hr.%'`).all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  const num = (k: string, d: number) => {
    const n = Number(m.get(k));
    return m.has(k) && Number.isFinite(n) ? n : d;
  };
  return {
    lateGraceMinutes: num("hr.late_grace_minutes", 5),
    roundingMinutes: Math.max(1, num("hr.rounding_minutes", 15)),
    otWeekdayBp: num("hr.ot_weekday_bp", 15000),
    otWeekendBp: num("hr.ot_weekend_bp", 20000),
    otHolidayBp: num("hr.ot_holiday_bp", 30000),
    methods: (m.get("hr.attendance_methods") ?? "gps,qr").split(",").map((s) => s.trim()).filter(Boolean),
    gpsMaxAccuracyM: num("hr.gps_max_accuracy_m", 100),
    qrWindowSeconds: Math.max(5, num("hr.qr_window_seconds", 30)),
    weeklyOffDays: parseWeeklyOff(m.get("hr.weekly_off_days")),
  };
}

/** Kỳ công đã chốt → mọi thay đổi ảnh hưởng kỳ đó bị chặn (409 timesheet_closed). */
export async function assertPeriodsOpen(db: D1Database, dates: string[]) {
  const periods = [...new Set(dates.map(periodOf))];
  if (!periods.length) return;
  const { results } = await db
    .prepare(`SELECT period FROM timesheets WHERE status='closed' AND period IN (${periods.map(() => "?").join(",")})`)
    .bind(...periods)
    .all<{ period: string }>();
  if (results.length) throw conflict("timesheet_closed", `Kỳ công ${results[0].period} đã chốt, không thể thay đổi. Dùng điều chỉnh ở kỳ sau.`);
}

export interface EmployeeRow {
  id: number;
  code: string;
  user_id: number | null;
  full_name: string;
  store_id: number;
  status: string;
  hire_date: string;
  termination_date: string | null;
  location_exempt: number;
  annual_leave_days: number;
}

export async function employeeOfUser(db: D1Database, userId: number): Promise<EmployeeRow> {
  const e = await db
    .prepare(`SELECT id, code, user_id, full_name, store_id, status, hire_date, termination_date, location_exempt, annual_leave_days FROM employees WHERE user_id = ?`)
    .bind(userId)
    .first<EmployeeRow>();
  if (!e) throw new AppError(404, "employee_not_linked", "Tài khoản chưa gắn với hồ sơ nhân viên");
  return e;
}

/** Số dư phép năm (đơn vị ×10): entitled = annual_leave_days×10; used = phép đã duyệt (loại có uses_balance) bắt đầu trong năm. */
export async function leaveBalance(db: D1Database, employeeId: number, year: number) {
  const e = await db.prepare(`SELECT annual_leave_days FROM employees WHERE id=?`).bind(employeeId).first<{ annual_leave_days: number }>();
  const used = await db
    .prepare(
      `SELECT COALESCE(SUM(lr.days_x10),0) n FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.employee_id=? AND lr.status='approved' AND lt.uses_balance=1 AND substr(lr.from_date,1,4)=?`,
    )
    .bind(employeeId, String(year))
    .first<{ n: number }>();
  const entitledX10 = (e?.annual_leave_days ?? 0) * 10;
  const usedX10 = used?.n ?? 0;
  return { year, entitledX10, usedX10, remainingX10: entitledX10 - usedX10 };
}

export const todayVn = () => vnDate();
