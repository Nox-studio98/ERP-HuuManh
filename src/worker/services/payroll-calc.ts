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
};

export interface TimesheetDayInput {
  workDate: string;
  workedMinutes: number;
  overtimeMinutes: number;
  overtimeMultiplierBp: number;
  shiftsWorked: number;
  leavePaidX10: number;
  holiday: boolean;
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
  };
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
  // Lễ nghỉ hưởng lương: ngày lễ không đi làm và không có phép đã tính
  const holidayOff = input.days.filter((d) => d.holiday && d.workedMinutes === 0 && d.shiftsWorked === 0 && d.leavePaidX10 === 0).length;
  const workedMinutes = sum(input.days.map((d) => d.workedMinutes)) + input.adjustMinutes.work;
  const shifts = sum(input.days.map((d) => d.shiftsWorked));

  let paidDaysX10 = Math.min(std * 10, workedDays * 10 + leaveX10 + holidayOff * 10);
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
      note: `${fmt(e.baseSalary)} × ${paidDaysX10 / 10} ngày công / ${std} ngày chuẩn (ngày có công ${workedDays}, phép có lương ${leaveX10 / 10}, lễ nghỉ hưởng lương ${holidayOff})`,
    });
  } else if (e.payType === "hourly") {
    // C-03: giờ tăng ca đã duyệt nằm trong workedMinutes (out − in) nhưng được trả riêng × hệ số → lương giờ chỉ tính giờ thường.
    const regularMinutes = Math.max(0, sum(input.days.map((d) => Math.max(0, d.workedMinutes - d.overtimeMinutes))) + input.adjustMinutes.work);
    basePay = Math.round((e.hourlyRate * regularMinutes) / 60);
    lines.push({ label: "Lương theo giờ", amount: basePay, group: "income", note: `${fmt(e.hourlyRate)} × ${(regularMinutes / 60).toFixed(2)} giờ thường (đã trừ giờ tăng ca, trả riêng)` });
  } else {
    basePay = Math.round(e.shiftRate * shifts);
    lines.push({ label: "Lương theo ca", amount: basePay, group: "income", note: `${fmt(e.shiftRate)} × ${shifts} ca` });
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

  // ---- Phụ cấp, thưởng, phạt, điều chỉnh ----
  let allowances = 0;
  let nonTaxable = Math.max(0, overtimeExempt);
  for (const a of input.allowances) {
    allowances += a.amount;
    if (!a.taxable) nonTaxable += a.amount;
    lines.push({ label: `Phụ cấp ${a.name}`, amount: a.amount, group: "income", note: a.taxable ? undefined : "không chịu thuế" });
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
  const insBase = e.insuranceSalary > 0 ? Math.min(e.insuranceSalary, s.insuranceCapVnd) : 0;
  const insuranceEmployee = Math.round((insBase * s.insuranceEmployeeBp) / 10000);
  const insuranceEmployer = Math.round((insBase * s.insuranceEmployerBp) / 10000);
  if (insuranceEmployee > 0) lines.push({ label: "Bảo hiểm (người lao động)", amount: -insuranceEmployee, group: "deduction", note: `${fmt(insBase)} × ${s.insuranceEmployeeBp / 100}%` });
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
  };
}
