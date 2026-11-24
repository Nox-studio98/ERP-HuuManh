import { describe, expect, it } from "vitest";
import { calculatePayslip, progressiveTax, DEFAULT_PAYROLL_SETTINGS as S, type PayslipInput, type TimesheetDayInput } from "../src/worker/services/payroll-calc";

const day = (o: Partial<TimesheetDayInput> = {}): TimesheetDayInput => ({
  workDate: "2026-09-01", workedMinutes: 480, overtimeMinutes: 0, overtimeMultiplierBp: 15000, shiftsWorked: 1, leavePaidX10: 0, holiday: false, ...o,
});
const work = (n: number) => Array.from({ length: n }, (_, i) => day({ workDate: `2026-09-${String(i + 1).padStart(2, "0")}` }));
const base = (o: Partial<PayslipInput> & { emp?: Partial<PayslipInput["employee"]> } = {}): PayslipInput => ({
  employee: { payType: "monthly", baseSalary: 10_400_000, hourlyRate: 0, shiftRate: 0, insuranceSalary: 0, dependents: 0, pitEnabled: true, ...o.emp },
  days: o.days ?? work(26),
  adjustMinutes: o.adjustMinutes ?? { work: 0, overtime: 0 },
  allowances: o.allowances ?? [],
  entries: o.entries ?? [],
  advances: o.advances ?? [],
  salesRevenue: o.salesRevenue ?? 0,
});

describe("calculatePayslip", () => {
  it("monthly: partial days + paid leave + paid holiday", () => {
    // 20 ngày có công + phép 2 ngày (20 x10) + 1 lễ nghỉ hưởng lương = 23 ngày
    // 10.400.000 × 23 / 26 = 9.200.000
    const days = [...work(20), day({ workedMinutes: 0, shiftsWorked: 0, leavePaidX10: 10 }), day({ workedMinutes: 0, shiftsWorked: 0, leavePaidX10: 10 }), day({ workedMinutes: 0, shiftsWorked: 0, holiday: true })];
    const p = calculatePayslip(base({ days }));
    expect(p.paidDaysX10).toBe(230);
    expect(p.basePay).toBe(9_200_000);
    expect(p.pit).toBe(0); // 9,2tr < giảm trừ 15,5tr
    expect(p.net).toBe(9_200_000);
  });

  it("monthly: paid days capped at standard workdays; rounds to dong", () => {
    expect(calculatePayslip(base({ days: work(28) })).basePay).toBe(10_400_000);
    // 10.000.000 × 7 / 26 = 2.692.307,69 → 2.692.308
    expect(calculatePayslip(base({ emp: { baseSalary: 10_000_000 }, days: work(7) })).basePay).toBe(2_692_308);
  });

  it("hourly: rate × minutes/60, plus work-minute adjustment from a previous period", () => {
    // 5000 phút = 83,333 giờ × 30.000 = 2.500.000
    const h = base({ emp: { payType: "hourly", hourlyRate: 30_000 }, days: [day({ workedMinutes: 5000 })] });
    expect(calculatePayslip(h).basePay).toBe(2_500_000);
    // +60 phút điều chỉnh → 5060/60 × 30.000 = 2.530.000
    expect(calculatePayslip({ ...h, adjustMinutes: { work: 60, overtime: 0 } }).basePay).toBe(2_530_000);
  });

  it("shift: rate × shifts", () => {
    const p = calculatePayslip(base({ emp: { payType: "shift", shiftRate: 150_000 }, days: work(20) }));
    expect(p.shifts).toBe(20);
    expect(p.basePay).toBe(3_000_000);
  });

  it("overtime weekday / weekend / holiday multipliers", () => {
    // đơn giá giờ = 10.400.000/26/8 = 50.000
    // thường 120' ×1,5 = 50.000×2×1,5 = 150.000; cuối tuần 60' ×2 = 100.000; lễ 180' ×3 = 450.000 → 700.000
    const days = work(26);
    days[0] = day({ overtimeMinutes: 120, overtimeMultiplierBp: S.otWeekdayBp });
    days[1] = day({ overtimeMinutes: 60, overtimeMultiplierBp: S.otWeekendBp });
    days[2] = day({ overtimeMinutes: 180, overtimeMultiplierBp: S.otHolidayBp });
    const p = calculatePayslip(base({ days }));
    expect(p.overtimePay).toBe(700_000);
    expect(p.gross).toBe(11_100_000);
    // điều chỉnh tăng ca kỳ trước 60' tính hệ số ngày thường: 50.000 × 1,5 = 75.000
    expect(calculatePayslip(base({ days, adjustMinutes: { work: 0, overtime: 60 } })).overtimePay).toBe(775_000);
  });

  it("allowances taxable vs non-taxable affect taxable income only", () => {
    // lương 20tr (26 ngày), BH lương 20tr → NLĐ 2.100.000, DN 4.300.000
    // phụ cấp: 500k chịu thuế + 800k không chịu thuế + entry phụ cấp 200k chịu thuế → gross 21.500.000
    // taxable = 21.5 − 0,8 − 2,1 − 15,5 = 3.100.000 → 5% = 155.000; net = 21.5 − 2,1 − 0,155 = 19.245.000
    const p = calculatePayslip(
      base({
        emp: { baseSalary: 20_000_000, insuranceSalary: 20_000_000 },
        allowances: [{ name: "Ăn trưa", amount: 800_000, taxable: false }, { name: "Trách nhiệm", amount: 500_000, taxable: true }],
        entries: [{ kind: "allowance", amount: 200_000, taxable: true, reason: "Xăng xe" }],
      }),
    );
    expect(p.allowances).toBe(1_500_000);
    expect(p.gross).toBe(21_500_000);
    expect(p.insuranceEmployee).toBe(2_100_000);
    expect(p.insuranceEmployer).toBe(4_300_000);
    expect(p.taxableIncome).toBe(3_100_000);
    expect(p.pit).toBe(155_000);
    expect(p.net).toBe(19_245_000);
  });

  it("insurance respects the salary cap and zero means none", () => {
    // trần 46.800.000: NLĐ 46,8tr × 10,5% = 4.914.000; DN × 21,5% = 10.062.000
    const p = calculatePayslip(base({ emp: { insuranceSalary: 60_000_000 } }));
    expect(p.insuranceEmployee).toBe(4_914_000);
    expect(p.insuranceEmployer).toBe(10_062_000);
    expect(calculatePayslip(base()).insuranceEmployee).toBe(0);
  });

  it("PIT progressive with dependents (Luật 109/2025/QH15 — 5 bậc)", () => {
    // lương 50tr, không BH, 2 người phụ thuộc: taxable = 50 − 15,5 − 2×6,2 = 22.100.000
    // 10tr×5% = 500k; 12,1tr×10% = 1.210k → 1.710.000
    const p = calculatePayslip(base({ emp: { baseSalary: 50_000_000, dependents: 2 }, days: work(26) }));
    expect(p.taxableIncome).toBe(22_100_000);
    expect(p.pit).toBe(1_710_000);
    expect(p.net).toBe(48_290_000);
    // đủ các bậc: 100tr = 500k + 2.000k + 6.000k + 12.000k = 20.500.000; 120tr thêm 20tr × 35% = 7.000k
    expect(progressiveTax(100_000_000, S.pitBrackets)).toBe(20_500_000);
    expect(progressiveTax(120_000_000, S.pitBrackets)).toBe(27_500_000);
    expect(progressiveTax(10_000_000, S.pitBrackets)).toBe(500_000);
    expect(progressiveTax(0, S.pitBrackets)).toBe(0);
    // NV tắt TNCN
    expect(calculatePayslip(base({ emp: { baseSalary: 50_000_000, pitEnabled: false } })).pit).toBe(0);
  });

  it("advances deducted from net; bonus/penalty/adjustment entries", () => {
    // gross = 10.400.000 + thưởng 400.000 − phạt 100.000 + điều chỉnh kỳ trước (+200.000 −50.000) = 10.850.000
    const p = calculatePayslip(
      base({
        entries: [
          { kind: "bonus", amount: 400_000, taxable: true, reason: "Chuyên cần" },
          { kind: "penalty", amount: 100_000, taxable: true, reason: "Đi muộn" },
          { kind: "adjustment", amount: 200_000, taxable: true, reason: "Bù công kỳ 2026-08", sourcePeriod: "2026-08" },
          { kind: "adjustment", amount: -50_000, taxable: true, reason: "Trừ nhầm" },
        ],
        advances: [{ amount: 1_000_000 }, { amount: 500_000 }],
      }),
    );
    expect(p.bonus).toBe(400_000);
    expect(p.penalties).toBe(100_000);
    expect(p.adjustments).toBe(150_000);
    expect(p.gross).toBe(10_850_000);
    expect(p.advances).toBe(1_500_000);
    expect(p.net).toBe(9_350_000);
    expect(p.lines.some((l) => l.label.includes("kỳ 2026-08"))).toBe(true);
    expect(p.lines.find((l) => l.label === "Thực lĩnh")?.amount).toBe(9_350_000);
  });

  it("sales bonus = revenue × bp (off when 0)", () => {
    // 25.000.000 × 2% = 500.000
    const input = base({ salesRevenue: 25_000_000 });
    expect(calculatePayslip(input, { ...S, salesBonusBp: 200 }).salesBonus).toBe(500_000);
    expect(calculatePayslip(input, S).salesBonus).toBe(0);
  });

  it("overtime premium above normal pay is exempt from PIT", () => {
    // lương 20,8tr → đơn giá giờ 100.000; tăng ca ngày thường 120' ×1,5 = 300.000, phần chênh 100.000 miễn thuế
    // gross 21.100.000; taxable = 21,1 − 0,1 − 15,5 = 5.500.000 → 275.000
    const days = work(26);
    days[0] = day({ overtimeMinutes: 120, overtimeMultiplierBp: S.otWeekdayBp });
    const p = calculatePayslip(base({ emp: { baseSalary: 20_800_000 }, days }));
    expect(p.overtimePay).toBe(300_000);
    expect(p.gross).toBe(21_100_000);
    expect(p.taxableIncome).toBe(5_500_000);
    expect(p.pit).toBe(275_000);
  });
});
