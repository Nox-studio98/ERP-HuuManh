import { parseWorkdayTiers } from "./hr-common";
/**
 * Tính phiếu lương — HÀM THUẦN (không đụng DB) để test được. Công thức: docs/API-dot4.md mục B.
 * Làm tròn từng khoản tới đồng (Math.round). Mọi tham số lấy từ settings hr.*.
 */
export interface PayrollSettings {
  standardWorkdays: number;
  otWeekdayBp: number;
  otWeekendBp: number;
  otHolidayBp: number;
  insuranceEmployeeBp: number;
  insuranceEmployerBp: number;
  insuranceCapVnd: number;
  pitFamilyDeduction: number;
  pitDependentDeduction: number;
  /** [[trần thu nhập tính thuế, bp]], trần null = không giới hạn. */
  pitBrackets: [number | null, number][];
  salesBonusBp: number;
  /** C-14: 'proportional' = theo giờ làm thực tế (mặc định) | 'day_present' = kiểu cũ (≥1 phút công = 1 ngày). */
  monthlyPayMode: "proportional" | "day_present";
  /** C-19: phụ trội (bp cộng thêm trên lương giờ thường) cho giờ làm TRONG CA vào ngày lễ / cuối tuần. 0 = tắt. */
  holidayPremiumBp: number;
  weekendPremiumBp: number;
  /** C-24: phụ cấp cố định + lương đóng BH tính theo tỉ lệ ngày làm khi vào/nghỉ giữa tháng hoặc cả tháng không có công. */
  prorateFixedPay: boolean;
  /** Bảng chấm công: bật khi hr.workday_tiers hợp lệ → lương tháng dùng Σ công theo bậc giờ làm của từng ngày. */
  workdayTiersOn?: boolean;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  standardWorkdays: 26,
  otWeekdayBp: 15000,
  otWeekendBp: 20000,
  otHolidayBp: 30000,
  insuranceEmployeeBp: 1050,
  insuranceEmployerBp: 2150,
  insuranceCapVnd: 46_800_000,
  pitFamilyDeduction: 15_500_000,
  pitDependentDeduction: 6_200_000,
  // Luật Thuế TNCN 109/2025/QH15 — áp dụng cho thu nhập tiền lương từ kỳ tính thuế 2026: 5 bậc 5/10/20/30/35%.
  // Giảm trừ 15,5tr/6,2tr theo NQ 110/2025/UBTVQH15 (từ 01/01/2026).
  pitBrackets: [[10_000_000, 500], [30_000_000, 1000], [60_000_000, 2000], [100_000_000, 3000], [null, 3500]],
  salesBonusBp: 0,
  monthlyPayMode: "proportional",
  holidayPremiumBp: 0,
  weekendPremiumBp: 0,
  prorateFixedPay: true,
};

export interface TimesheetDayInput {
  workDate: string;
  workedMinutes: number;
  overtimeMinutes: number;
  overtimeMultiplierBp: number;
  shiftsWorked: number;
  leavePaidX10: number;
  holiday: boolean;
  /** C-09: ngày lễ nghỉ hưởng lương (holidays.paid_off=1). Thiếu → coi theo `holiday`. */
  holidayPaid?: boolean;
  /** C-14: số phút ca theo lịch của ngày (0/thiếu → 480). */
  scheduledMinutes?: number;
  /** Công×10 theo bậc giờ làm (hr.workday_tiers); null/thiếu = lúc chốt công chưa bật bậc. */
  workUnitsX10?: number | null;
}

export interface PayslipInput {
  employee: {
    payType: "monthly" | "hourly" | "shift";
    baseSalary: number;
    hourlyRate: number;
    shiftRate: number;
    insuranceSalary: number;
    dependents: number;
    pitEnabled: boolean;
    /** C-24: ngày vào làm / nghỉ việc (YYYY-MM-DD) để tính tỉ lệ ngày làm; chỉ dùng khi có `period`. */
    hireDate?: string;
    terminationDate?: string | null;
  };
  /** C-24: kỳ lương 'YYYY-MM'. Thiếu → không prorate phụ cấp/bảo hiểm. */
  period?: string;
  days: TimesheetDayInput[];
  /** timesheet_adjustments có target_period = kỳ này (phút, có thể âm). */
  adjustMinutes: { work: number; overtime: number };
  allowances: { name: string; amount: number; taxable: boolean }[]; // phụ cấp cố định đang hoạt động
  entries: { kind: "bonus" | "penalty" | "allowance" | "adjustment"; amount: number; taxable: boolean; reason: string; sourcePeriod?: string | null }[];
  advances: { amount: number; date?: string }[];
  salesRevenue: number; // doanh thu POS hoàn tất trừ trả hàng
}

export interface PayslipLine {
  label: string;
  amount: number; // dương = cộng vào, âm = trừ đi
  group: "income" | "deduction" | "info";
  note?: string;
}

export interface Payslip {
  payType: string;
  workedMinutes: number;
  paidDaysX10: number;
  shifts: number;
  basePay: number;
  allowances: number;
  overtimePay: number;
  bonus: number;
  salesBonus: number;
  penalties: number;
  adjustments: number;
  gross: number;
  insuranceEmployee: number;
  insuranceEmployer: number;
  taxableIncome: number;
  pit: number;
  advances: number;
  /** Tạm ứng chưa khấu trừ hết (do thực lĩnh không đủ) — chuyển sang kỳ sau, không mất. */
  advancesCarried: number;
  net: number;
  lines: PayslipLine[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fmt = (n: number) => n.toLocaleString("en-US").replaceAll(",", ".");

/** Thuế luỹ tiến từng phần: Σ (min(thu nhập, trần) − trần trước) × bp/10000, làm tròn một lần ở cuối. */
export function progressiveTax(taxable: number, brackets: [number | null, number][]): number {
  let tax = 0;
  let prev = 0;
  for (const [cap, bp] of brackets) {
    if (taxable <= prev) break;
    const upper = cap == null ? taxable : Math.min(taxable, cap);
    tax += ((upper - prev) * bp) / 10000;
    if (cap == null) break;
    prev = cap;
  }
  return Math.round(tax);
}

export function calculatePayslip(input: PayslipInput, s: PayrollSettings = DEFAULT_PAYROLL_SETTINGS): Payslip {
  const e = input.employee;
  const lines: PayslipLine[] = [];
  const std = s.standardWorkdays;

  // ---- Công ----
  const workedDays = input.days.filter((d) => d.workedMinutes > 0 || d.shiftsWorked > 0).length;
  const leaveX10 = sum(input.days.map((d) => d.leavePaidX10));
  // Lễ nghỉ hưởng lương: chỉ ngày lễ có paid_off (C-09), không đi làm và không có phép đã tính
  const holidayOff = input.days.filter((d) => (d.holidayPaid ?? d.holiday) && d.workedMinutes === 0 && d.shiftsWorked === 0 && d.leavePaidX10 === 0).length;
  const workedMinutes = sum(input.days.map((d) => d.workedMinutes)) + input.adjustMinutes.work;
  const shifts = sum(input.days.map((d) => d.shiftsWorked));
  // C-14: ngày công theo giờ làm = min(1, phút làm thường / phút ca) làm tròn 0,1 ngày; tối đa 1 ngày công+phép mỗi ngày
  const proportional = s.monthlyPayMode === "proportional";
  const dayWorkX10 = (d: TimesheetDayInput) => {
    const sched = d.scheduledMinutes && d.scheduledMinutes > 0 ? d.scheduledMinutes : 480;
    const regular = Math.max(0, d.workedMinutes - d.overtimeMinutes);
    return Math.round(Math.min(1, regular / sched) * 10);
  };
  const propDaysX10 = sum(input.days.map((d) => Math.min(10, dayWorkX10(d) + d.leavePaidX10)));
  const propWorkX10 = sum(input.days.map((d) => Math.min(10, dayWorkX10(d) + d.leavePaidX10) - Math.min(10, d.leavePaidX10)));

  // Bậc công: chỉ khi bật và mọi ngày đã chốt kèm số công theo bậc (kỳ chốt trước khi bật thì giữ cách cũ)
  const tiersOn = e.payType === "monthly" && !!s.workdayTiersOn && input.days.length > 0 && input.days.every((d) => d.workUnitsX10 != null);
  const tierWorkX10 = sum(input.days.map((d) => d.workUnitsX10 ?? 0));
  let paidDaysX10 = Math.min(std * 10, (tiersOn ? tierWorkX10 + leaveX10 : e.payType === "monthly" && proportional ? propDaysX10 : workedDays * 10 + leaveX10) + holidayOff * 10);
  let basePay = 0;
  if (e.payType === "monthly") {
    // phút điều chỉnh công quy đổi 480 phút = 1 ngày
    const adjX10 = Math.round((input.adjustMinutes.work / 480) * 10);
    paidDaysX10 = Math.max(0, Math.min(std * 10, paidDaysX10 + adjX10));
    basePay = Math.round((e.baseSalary * paidDaysX10) / (std * 10));
    lines.push({
      label: "Lương cơ bản",
      amount: basePay,
      group: "income",
      note: tiersOn
        ? `${fmt(e.baseSalary)} × ${paidDaysX10 / 10} ngày công / ${std} ngày chuẩn (công theo bậc giờ làm trong ngày: ${tierWorkX10 / 10} công trên ${workedDays} ngày có công; phép có lương ${leaveX10 / 10}, lễ nghỉ hưởng lương ${holidayOff}; tối đa ${std} ngày công chuẩn)`
        : proportional
        ? `${fmt(e.baseSalary)} × ${paidDaysX10 / 10} ngày công / ${std} ngày chuẩn (công theo giờ làm thực tế: mỗi ngày = phút làm / phút ca, tối đa 1, làm tròn 0,1 → ${propWorkX10 / 10} ngày trên ${workedDays} ngày có công, đi muộn/về sớm bị trừ theo giờ; phép có lương ${leaveX10 / 10}, lễ nghỉ hưởng lương ${holidayOff})`
        : `${fmt(e.baseSalary)} × ${paidDaysX10 / 10} ngày công / ${std} ngày chuẩn (ngày có công ${workedDays}, phép có lương ${leaveX10 / 10}, lễ nghỉ hưởng lương ${holidayOff})`,
    });
  } else if (e.payType === "hourly") {
    // C-03: giờ tăng ca đã duyệt nằm trong workedMinutes (out − in) nhưng được trả riêng × hệ số → lương giờ chỉ tính giờ thường.
    const regularMinutes = Math.max(0, sum(input.days.map((d) => Math.max(0, d.workedMinutes - d.overtimeMinutes))) + input.adjustMinutes.work);
    basePay = Math.round((e.hourlyRate * regularMinutes) / 60);
    lines.push({ label: "Lương theo giờ", amount: basePay, group: "income", note: `${fmt(e.hourlyRate)} × ${(regularMinutes / 60).toFixed(2)} giờ thường (đã trừ giờ tăng ca, trả riêng)` });
    // C-24: phép có lương của NV lương giờ = số giờ ca đã xếp ngày đó (không có ca → 8 giờ) × phần ngày phép
    const leaveMinutes = sum(input.days.map((d) => (d.leavePaidX10 > 0 ? Math.round(((d.scheduledMinutes || 480) * Math.min(10, d.leavePaidX10)) / 10) : 0)));
    if (leaveMinutes > 0) {
      const leavePay = Math.round((e.hourlyRate * leaveMinutes) / 60);
      basePay += leavePay;
      lines.push({ label: "Phép có lương", amount: leavePay, group: "income", note: `${fmt(e.hourlyRate)} × ${(leaveMinutes / 60).toFixed(2)} giờ (giờ ca đã xếp của ngày phép, không có ca tính 8 giờ; phép ${leaveX10 / 10} ngày)` });
    }
  } else {
    // C-24: phút điều chỉnh công quy đổi 480 phút = 1 ca (trước đây lương theo ca bỏ qua điều chỉnh)
    const adjShifts = input.adjustMinutes.work / 480;
    basePay = Math.round(e.shiftRate * (shifts + adjShifts));
    lines.push({ label: "Lương theo ca", amount: basePay, group: "income", note: `${fmt(e.shiftRate)} × ${shifts} ca${input.adjustMinutes.work ? ` ${adjShifts >= 0 ? "+" : "−"} ${Math.abs(Math.round(adjShifts * 100) / 100)} ca điều chỉnh công (${input.adjustMinutes.work} phút / 480)` : ""}` });
    // C-24: phép có lương của NV lương ca = 1 ca mỗi ngày phép (nửa ngày = 0,5 ca); đơn giá ca không phụ thuộc độ dài ca
    const leaveShifts = sum(input.days.map((d) => Math.min(10, d.leavePaidX10))) / 10;
    if (leaveShifts > 0) {
      const leavePay = Math.round(e.shiftRate * leaveShifts);
      basePay += leavePay;
      lines.push({ label: "Phép có lương", amount: leavePay, group: "income", note: `${fmt(e.shiftRate)} × ${Math.round(leaveShifts * 100) / 100} ca (1 ca mỗi ngày phép có lương)` });
    }
  }

  // ---- Tăng ca ----
  // đơn giá giờ: tháng = lương/ngày chuẩn/8; giờ = đơn giá giờ; ca = đơn giá ca/8 (giả định 1 ca = 8 giờ)
  const hourRate = e.payType === "monthly" ? e.baseSalary / std / 8 : e.payType === "hourly" ? e.hourlyRate : e.shiftRate / 8;
  const otGroups = new Map<number, number>();
  for (const d of input.days) if (d.overtimeMinutes > 0) otGroups.set(d.overtimeMultiplierBp, (otGroups.get(d.overtimeMultiplierBp) ?? 0) + d.overtimeMinutes);
  if (input.adjustMinutes.overtime !== 0) otGroups.set(s.otWeekdayBp, (otGroups.get(s.otWeekdayBp) ?? 0) + input.adjustMinutes.overtime);
  let overtimePay = 0;
  // Phần tiền tăng ca trả cao hơn giờ làm việc bình thường được miễn thuế TNCN (chỉ phần chênh lệch, hệ số > 1).
  let overtimeExempt = 0;
  for (const [bp, mins] of [...otGroups.entries()].sort((a, b) => a[0] - b[0])) {
    if (mins === 0) continue;
    const amt = Math.round(((hourRate * mins) / 60) * (bp / 10000));
    overtimePay += amt;
    if (bp > 10000 && amt > 0) overtimeExempt += amt - Math.round((hourRate * mins) / 60);
    lines.push({ label: `Tăng ca ×${bp / 10000}`, amount: amt, group: "income", note: `${(mins / 60).toFixed(2)} giờ × ${fmt(Math.round(hourRate))} đ/giờ × ${bp / 10000}` });
  }

  // ---- Phụ trội giờ làm TRONG CA vào ngày lễ / cuối tuần (C-19) ----
  // Giờ tăng ca đã duyệt trả riêng ở trên; ở đây chỉ phần giờ thường (làm − tăng ca) của ngày lễ/cuối tuần được cộng thêm hệ số phụ trội.
  const premium = { holiday: 0, weekend: 0 };
  for (const d of input.days) {
    const regular = Math.max(0, d.workedMinutes - d.overtimeMinutes);
    if (regular <= 0) continue;
    if (d.holiday) premium.holiday += regular;
    else if ([0, 6].includes(new Date(d.workDate + "T00:00:00Z").getUTCDay())) premium.weekend += regular;
  }
  for (const [label, mins, bp] of [["Phụ trội ngày lễ (giờ làm trong ca)", premium.holiday, s.holidayPremiumBp], ["Phụ trội cuối tuần (giờ làm trong ca)", premium.weekend, s.weekendPremiumBp]] as const) {
    if (mins <= 0 || bp <= 0) continue;
    const amt = Math.round(((hourRate * mins) / 60) * (bp / 10000));
    if (amt <= 0) continue;
    overtimePay += amt;
    overtimeExempt += amt; // phần trả cao hơn giờ làm việc bình thường được miễn thuế TNCN như tăng ca
    lines.push({ label, amount: amt, group: "income", note: `${(mins / 60).toFixed(2)} giờ × ${fmt(Math.round(hourRate))} đ/giờ × +${bp / 100}%` });
  }

  // ---- C-24: tỉ lệ ngày làm cho phụ cấp cố định / bảo hiểm ----
  let fixedNum = 1;
  let fixedDen = 1;
  let fixedNote = "";
  if (s.prorateFixedPay && input.period && /^\d{4}-\d{2}$/.test(input.period)) {
    const [y, m] = input.period.split("-").map(Number);
    const first = `${input.period}-01`;
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = `${input.period}-${String(dim).padStart(2, "0")}`;
    const lo = e.hireDate && e.hireDate > first ? e.hireDate : first;
    const hi = e.terminationDate && e.terminationDate < last ? e.terminationDate : last;
    const empDays = hi >= lo ? Math.round((Date.parse(hi + "T00:00:00Z") - Date.parse(lo + "T00:00:00Z")) / 86400_000) + 1 : 0;
    const active = workedDays > 0 || leaveX10 > 0 || holidayOff > 0 || input.adjustMinutes.work > 0;
    fixedNum = active ? empDays : 0;
    fixedDen = dim;
    if (fixedNum !== fixedDen) fixedNote = active ? `theo ${empDays}/${dim} ngày trong kỳ (vào/nghỉ giữa tháng)` : "không có công trong kỳ";
  }
  const prorate = (n: number) => (fixedNum === fixedDen ? n : Math.round((n * fixedNum) / fixedDen));

  // ---- Phụ cấp, thưởng, phạt, điều chỉnh ----
  let allowances = 0;
  let nonTaxable = Math.max(0, overtimeExempt);
  for (const a of input.allowances) {
    const amount = prorate(a.amount);
    allowances += amount;
    if (!a.taxable) nonTaxable += amount;
    const notes = [a.taxable ? "" : "không chịu thuế", fixedNote ? `${fixedNote} (đủ tháng ${fmt(a.amount)})` : ""].filter(Boolean).join("; ");
    lines.push({ label: `Phụ cấp ${a.name}`, amount, group: "income", note: notes || undefined });
  }
  let bonus = 0;
  let penalties = 0;
  let adjustments = 0;
  for (const en of input.entries) {
    if (en.kind === "allowance") {
      allowances += en.amount;
      if (!en.taxable) nonTaxable += en.amount;
      lines.push({ label: `Phụ cấp: ${en.reason}`, amount: en.amount, group: "income", note: en.taxable ? undefined : "không chịu thuế" });
    } else if (en.kind === "bonus") {
      bonus += en.amount;
      if (!en.taxable) nonTaxable += en.amount;
      lines.push({ label: `Thưởng: ${en.reason}`, amount: en.amount, group: "income", note: en.taxable ? undefined : "không chịu thuế" });
    } else if (en.kind === "penalty") {
      penalties += en.amount;
      lines.push({ label: `Phạt: ${en.reason}`, amount: -en.amount, group: "deduction" });
    } else {
      adjustments += en.amount;
      lines.push({ label: `Điều chỉnh${en.sourcePeriod ? ` kỳ ${en.sourcePeriod}` : ""}: ${en.reason}`, amount: en.amount, group: en.amount >= 0 ? "income" : "deduction" });
    }
  }
  const salesBonus = s.salesBonusBp > 0 ? Math.round((input.salesRevenue * s.salesBonusBp) / 10000) : 0;
  if (salesBonus !== 0) lines.push({ label: "Thưởng doanh số", amount: salesBonus, group: "income", note: `${fmt(input.salesRevenue)} × ${s.salesBonusBp / 100}%` });

  const gross = basePay + allowances + overtimePay + bonus + salesBonus - penalties + adjustments;
  lines.push({ label: "Tổng thu nhập (gross)", amount: gross, group: "info" });

  // ---- Bảo hiểm ----
  const insBase = e.insuranceSalary > 0 ? prorate(Math.min(e.insuranceSalary, s.insuranceCapVnd)) : 0;
  const insuranceEmployee = Math.round((insBase * s.insuranceEmployeeBp) / 10000);
  const insuranceEmployer = Math.round((insBase * s.insuranceEmployerBp) / 10000);
  if (insuranceEmployee > 0) lines.push({ label: "Bảo hiểm (người lao động)", amount: -insuranceEmployee, group: "deduction", note: `${fmt(insBase)} × ${s.insuranceEmployeeBp / 100}%${fixedNote ? ` (lương đóng BH ${fixedNote})` : ""}` });
  if (insuranceEmployer > 0) lines.push({ label: "Bảo hiểm (doanh nghiệp đóng, không trừ lương)", amount: insuranceEmployer, group: "info", note: `${fmt(insBase)} × ${s.insuranceEmployerBp / 100}%` });

  // ---- TNCN ----
  let taxableIncome = 0;
  let pit = 0;
  if (e.pitEnabled) {
    taxableIncome = Math.max(0, gross - nonTaxable - insuranceEmployee - s.pitFamilyDeduction - e.dependents * s.pitDependentDeduction);
    pit = progressiveTax(taxableIncome, s.pitBrackets);
    lines.push({
      label: "Thu nhập tính thuế",
      amount: taxableIncome,
      group: "info",
      note: `gross − khoản không chịu thuế (phụ cấp, phần chênh tăng ca) ${fmt(nonTaxable)} − BH ${fmt(insuranceEmployee)} − giảm trừ bản thân ${fmt(s.pitFamilyDeduction)} − ${e.dependents} người phụ thuộc × ${fmt(s.pitDependentDeduction)}`,
    });
    if (pit > 0) lines.push({ label: "Thuế TNCN", amount: -pit, group: "deduction", note: "biểu thuế luỹ tiến từng phần" });
  }

  // ---- Tạm ứng & thực lĩnh ----
  // C-05: khấu trừ tạm ứng không vượt thực lĩnh trước tạm ứng (net ≥ 0); phần dư chuyển kỳ sau.
  const advancesDue = sum(input.advances.map((a) => a.amount));
  const preNet = gross - insuranceEmployee - pit;
  const advances = Math.min(advancesDue, Math.max(0, preNet));
  const advancesCarried = advancesDue - advances;
  if (advances > 0) lines.push({ label: "Khấu trừ tạm ứng", amount: -advances, group: "deduction" });
  if (advancesCarried > 0) lines.push({ label: "Tạm ứng chuyển kỳ sau", amount: advancesCarried, group: "info", note: "thực lĩnh không đủ trừ, phần còn lại khấu trừ ở kỳ lương kế tiếp" });
  const net = preNet - advances;
  lines.push({ label: "Thực lĩnh", amount: net, group: "info" });

  return {
    payType: e.payType, workedMinutes, paidDaysX10, shifts, basePay, allowances, overtimePay, bonus, salesBonus, penalties, adjustments,
    gross, insuranceEmployee, insuranceEmployer, taxableIncome, pit, advances, advancesCarried, net, lines,
  };
}

/** Đọc settings hr.* thành PayrollSettings (thiếu → mặc định). */
export async function loadPayrollSettings(db: D1Database): Promise<PayrollSettings> {
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'hr.%'`).all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  const num = (k: string, d: number) => {
    const v = m.get(k);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const d = DEFAULT_PAYROLL_SETTINGS;
  let brackets = d.pitBrackets;
  try {
    const p = JSON.parse(m.get("hr.pit_brackets_json") ?? "null");
    if (Array.isArray(p) && p.length) brackets = p;
  } catch { /* giữ mặc định */ }
  return {
    standardWorkdays: Math.max(1, num("hr.standard_workdays", d.standardWorkdays)),
    otWeekdayBp: num("hr.ot_weekday_bp", d.otWeekdayBp),
    otWeekendBp: num("hr.ot_weekend_bp", d.otWeekendBp),
    otHolidayBp: num("hr.ot_holiday_bp", d.otHolidayBp),
    insuranceEmployeeBp: num("hr.insurance_employee_bp", d.insuranceEmployeeBp),
    insuranceEmployerBp: num("hr.insurance_employer_bp", d.insuranceEmployerBp),
    insuranceCapVnd: num("hr.insurance_cap_vnd", d.insuranceCapVnd),
    pitFamilyDeduction: num("hr.pit_family_deduction", d.pitFamilyDeduction),
    pitDependentDeduction: num("hr.pit_dependent_deduction", d.pitDependentDeduction),
    pitBrackets: brackets,
    salesBonusBp: num("hr.sales_bonus_bp", d.salesBonusBp),
    monthlyPayMode: m.get("hr.monthly_pay_mode")?.trim() === "day_present" ? "day_present" : "proportional",
    holidayPremiumBp: Math.max(0, num("hr.holiday_premium_bp", d.holidayPremiumBp)),
    weekendPremiumBp: Math.max(0, num("hr.weekend_premium_bp", d.weekendPremiumBp)),
    workdayTiersOn: (parseWorkdayTiers(m.get("hr.workday_tiers")) ?? []).length > 0,
    prorateFixedPay: m.has("hr.prorate_fixed_pay") ? m.get("hr.prorate_fixed_pay")!.trim() !== "0" : d.prorateFixedPay,
  };
}
