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
  /** Bảng chấm công (migrations/0031): chế độ ca / khung giờ, ân hạn về sớm, làm thêm tự động, bậc công, tự chấm, chấm ngoài lịch. */
  attendanceMode: "shift" | "window";
  windowStart: string;
  windowEnd: string;
  windowBreakStart: string;
  windowBreakEnd: string;
  earlyGraceMinutes: number;
  otAuto: boolean;
  otMinBeforeMinutes: number;
  otMinAfterMinutes: number;
  /** [[phút, công×10]] tăng dần; rỗng = tắt. */
  workdayTiers: [number, number][];
  autoAttendance: boolean;
  unscheduledPunch: "off" | "approve" | "allow";
}

/**
 * "240:5,480:10,600:15" → [[240,5],[480,10],[600,15]]. Phút 1..1440 tăng dần, công×10 0..100 không giảm. Rỗng → []; sai → null.
 */
export function parseWorkdayTiers(v: string | undefined | null): [number, number][] | null {
  const s = (v ?? "").trim();
  if (!s) return [];
  const out: [number, number][] = [];
  for (const part of s.split(",")) {
    const m = /^\s*(\d{1,4})\s*:\s*(\d{1,3})\s*$/.exec(part);
    if (!m) return null;
    const minutes = Number(m[1]);
    const units = Number(m[2]);
    if (minutes < 1 || minutes > 1440 || units > 100) return null;
    const prev = out[out.length - 1];
    if (prev && (minutes <= prev[0] || units < prev[1])) return null;
    out.push([minutes, units]);
  }
  return out;
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
  const hhmm = (v: string | undefined, d: string) => (v != null && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : d);
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
    attendanceMode: m.get("hr.attendance_mode")?.trim() === "window" ? "window" : "shift",
    windowStart: hhmm(m.get("hr.window_start"), "08:00"),
    windowEnd: hhmm(m.get("hr.window_end"), "17:30"),
    windowBreakStart: hhmm(m.get("hr.window_break_start"), ""),
    windowBreakEnd: hhmm(m.get("hr.window_break_end"), ""),
    earlyGraceMinutes: Math.max(0, num("hr.early_grace_minutes", 0)),
    otAuto: m.get("hr.ot_auto")?.trim() === "1",
    otMinBeforeMinutes: Math.max(0, num("hr.ot_min_before_minutes", 0)),
    otMinAfterMinutes: Math.max(0, num("hr.ot_min_after_minutes", 0)),
    workdayTiers: parseWorkdayTiers(m.get("hr.workday_tiers")) ?? [],
    autoAttendance: m.get("hr.auto_attendance")?.trim() === "1",
    unscheduledPunch: ((v) => (v === "off" || v === "approve" ? v : "allow"))(m.get("hr.unscheduled_punch")?.trim()),
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

/** Kỳ liền trước của 'YYYY-MM'. */
export const prevPeriod = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  const t = y * 12 + (m - 1) - 1;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
export const isPeriodClosed = async (db: D1Database, period: string) =>
  !!(await db.prepare(`SELECT 1 x FROM timesheets WHERE period = ? AND status = 'closed'`).bind(period).first());

/**
 * C-26: những việc còn dang dở của một nhân viên/tài khoản trước khi cho nghỉ việc hoặc khoá tài khoản.
 *  - openShifts: ca POS đang mở của tài khoản (tiền mặt chưa đối soát) → luôn chặn;
 *  - pending: yêu cầu duyệt/đơn từ đang chờ do người đó gửi (hoặc đang chờ người đó nhận) và chứng từ nháp/chờ duyệt do người đó lập → cảnh báo, cần xác nhận bằng force + lý do.
 */
export async function offboardingBlockers(db: D1Database, userId: number | null, employeeId: number | null) {
  const n = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;
  const openShifts = userId ? await n(`SELECT COUNT(*) n FROM shifts WHERE user_id = ? AND status = 'open'`, userId) : 0;
  const pending = {
    approvals: userId ? await n(`SELECT COUNT(*) n FROM approvals WHERE requested_by = ? AND status = 'pending'`, userId) : 0,
    leave: employeeId ? await n(`SELECT COUNT(*) n FROM leave_requests WHERE employee_id = ? AND status = 'pending'`, employeeId) : 0,
    overtime: employeeId ? await n(`SELECT COUNT(*) n FROM overtime_requests WHERE employee_id = ? AND status = 'pending'`, employeeId) : 0,
    corrections: employeeId ? await n(`SELECT COUNT(*) n FROM attendance_corrections WHERE employee_id = ? AND status = 'pending'`, employeeId) : 0,
    swaps: userId || employeeId ? await n(`SELECT COUNT(*) n FROM shift_swap_requests WHERE status IN ('pending','accepted') AND (requested_by = ?1 OR to_employee_id = ?2)`, userId ?? -1, employeeId ?? -1) : 0,
    devices: userId ? await n(`SELECT COUNT(*) n FROM devices_registry_requests WHERE user_id = ? AND status = 'pending'`, userId) : 0,
    // C-26: chứng từ nháp / chờ duyệt do chính người này lập (đơn nháp, phiếu kho, báo giá, khuyến mãi, trả hàng NCC, đối soát)
    draftOrders: userId ? await n(`SELECT COUNT(*) n FROM orders WHERE created_by = ? AND status = 'draft'`, userId) : 0,
    draftStockDocs: userId ? await n(`SELECT COUNT(*) n FROM stock_docs WHERE created_by = ? AND status IN ('draft','pending_approval')`, userId) : 0,
    draftQuotes: userId ? await n(`SELECT COUNT(*) n FROM quotes WHERE created_by = ? AND status IN ('draft','pending_approval')`, userId) : 0,
    draftPromotions: userId ? await n(`SELECT COUNT(*) n FROM promotions WHERE created_by = ? AND status IN ('draft','pending_approval')`, userId) : 0,
    draftPurchaseReturns: userId ? await n(`SELECT COUNT(*) n FROM purchase_returns WHERE created_by = ? AND status IN ('draft','pending_approval')`, userId) : 0,
    // EC-39: việc chuyển được qua màn "Chuyển việc" (hr-handover.ts)
    draftPurchaseOrders: userId ? await n(`SELECT COUNT(*) n FROM purchase_orders WHERE created_by = ? AND status IN ('draft','pending_approval')`, userId) : 0,
    ownedCustomers: userId ? await n(`SELECT COUNT(*) n FROM customers WHERE owner_user_id = ? AND active = 1`, userId) : 0,
    recurringOrders: userId ? await n(`SELECT COUNT(*) n FROM recurring_orders WHERE created_by = ? AND active = 1`, userId) : 0,
    b2bNewOrders: userId ? await n(`SELECT COUNT(*) n FROM orders WHERE created_by = ? AND channel = 'b2b' AND status = 'new'`, userId) : 0,
    deliveringOrders: userId ? await n(`SELECT COUNT(*) n FROM orders WHERE deliverer_user_id = ? AND status IN ('confirmed','preparing','shipping')`, userId) : 0,
    draftSettlements: userId ? await n(`SELECT COUNT(*) n FROM settlements WHERE created_by = ? AND status = 'draft'`, userId) : 0,
  };
  const pendingTotal = Object.values(pending).reduce((a, b) => a + b, 0);
  return { openShifts, pending, pendingTotal };
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
