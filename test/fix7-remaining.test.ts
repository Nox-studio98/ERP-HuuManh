import { describe, expect, it } from "vitest";
import { calculatePayslip, type PayslipInput, type TimesheetDayInput } from "../src/worker/services/payroll-calc";

// Đợt 7 — lỗi nhỏ còn lại sau audit.
const day = (o: Partial<TimesheetDayInput> = {}): TimesheetDayInput => ({
  workDate: "2026-09-01", workedMinutes: 480, overtimeMinutes: 0, overtimeMultiplierBp: 15000, shiftsWorked: 1, leavePaidX10: 0, holiday: false, ...o,
});
const leave = (x10: number, scheduledMinutes = 0) => day({ workedMinutes: 0, shiftsWorked: 0, leavePaidX10: x10, scheduledMinutes });
const input = (emp: Partial<PayslipInput["employee"]>, days: TimesheetDayInput[]): PayslipInput => ({
  employee: { payType: "monthly", baseSalary: 0, hourlyRate: 0, shiftRate: 0, insuranceSalary: 0, dependents: 0, pitEnabled: false, ...emp },
  days, adjustMinutes: { work: 0, overtime: 0 }, allowances: [], entries: [], advances: [], salesRevenue: 0,
});

describe("C-24: phép có lương cho NV lương giờ / lương ca", () => {
  it("lương giờ: trả theo giờ ca đã xếp của ngày phép; không có ca → 8 giờ; nửa ngày = nửa số giờ", () => {
    // làm 600' = 10 giờ; phép ca 6 giờ (360'); phép không có ca (480'); nửa ngày phép ca 8 giờ (240')
    const p = calculatePayslip(input({ payType: "hourly", hourlyRate: 30_000 }, [day({ workedMinutes: 600 }), leave(10, 360), leave(10), leave(5, 480)]));
    // (600 + 360 + 480 + 240) / 60 × 30.000 = 28 giờ × 30.000 = 840.000
    expect(p.basePay).toBe(840_000);
    const line = p.lines.find((l) => l.label === "Phép có lương");
    expect(line?.amount).toBe(540_000);
    expect(p.gross).toBe(840_000);
  });

  it("lương ca: 1 ca mỗi ngày phép có lương, nửa ngày = 0,5 ca", () => {
    const p = calculatePayslip(input({ payType: "shift", shiftRate: 200_000 }, [day(), day(), leave(10, 360), leave(5, 480)]));
    // 2 ca làm + 1,5 ca phép = 3,5 × 200.000
    expect(p.basePay).toBe(700_000);
    expect(p.lines.find((l) => l.label === "Phép có lương")?.amount).toBe(300_000);
  });

  it("không có phép → không có dòng phép (hành vi cũ giữ nguyên)", () => {
    const p = calculatePayslip(input({ payType: "hourly", hourlyRate: 30_000 }, [day({ workedMinutes: 5000 })]));
    expect(p.basePay).toBe(2_500_000);
    expect(p.lines.some((l) => l.label === "Phép có lương")).toBe(false);
  });
});
