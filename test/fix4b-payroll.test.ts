import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { calculatePayslip, DEFAULT_PAYROLL_SETTINGS, loadPayrollSettings, type PayslipInput, type TimesheetDayInput } from "../src/worker/services/payroll-calc";
import { computeEmployeeTimesheet, type TsAssignment, type TsData } from "../src/worker/services/hr-timesheet";
import { shiftWindow } from "../src/worker/services/hr-common";

// Fix 4b: C-09 (lễ không hưởng lương), C-14 (lương theo giờ làm), C-15 (phép chỉ tính ngày làm việc theo lịch)
const V = "/api/v1";
const db = () => testEnv.DB;

const emp = (over: Partial<PayslipInput["employee"]> = {}): PayslipInput["employee"] => ({ payType: "monthly", baseSalary: 2_600_000, hourlyRate: 0, shiftRate: 0, insuranceSalary: 0, dependents: 0, pitEnabled: false, ...over });
const input = (days: TimesheetDayInput[]): PayslipInput => ({ employee: emp(), days, adjustMinutes: { work: 0, overtime: 0 }, allowances: [], entries: [], advances: [], salesRevenue: 0 });
let n = 0;
const day = (o: Partial<TimesheetDayInput> = {}): TimesheetDayInput => ({ workDate: `2026-09-${String(++n % 28 + 1).padStart(2, "0")}`, workedMinutes: 480, overtimeMinutes: 0, overtimeMultiplierBp: 15000, shiftsWorked: 1, leavePaidX10: 0, holiday: false, ...o });
const DAY_PRESENT = { ...DEFAULT_PAYROLL_SETTINGS, monthlyPayMode: "day_present" as const };

describe("C-09: lễ không hưởng lương (paid_off=0)", () => {
  it("ngày lễ paid_off=0 không đi làm → không được công; paid_off=1 → được 1 ngày", () => {
    const unpaid = calculatePayslip(input([day({ workedMinutes: 0, shiftsWorked: 0, holiday: true, holidayPaid: false })]));
    expect(unpaid.basePay).toBe(0);
    const paid = calculatePayslip(input([day({ workedMinutes: 0, shiftsWorked: 0, holiday: true, holidayPaid: true })]));
    expect(paid.basePay).toBe(100_000);
  });
  it("làm vào ngày lễ không hưởng lương vẫn được công theo giờ làm", () => {
    expect(calculatePayslip(input([day({ holiday: true, holidayPaid: false })])).basePay).toBe(100_000);
  });
});

describe("C-14: lương tháng theo giờ làm thực tế", () => {
  it("ca 30 phút / 480 = 0,1 ngày (không phải 1 ngày); muộn/sớm trừ theo giờ", () => {
    expect(calculatePayslip(input([day({ workedMinutes: 30 })])).paidDaysX10).toBe(1);
    expect(calculatePayslip(input([day({ workedMinutes: 360, scheduledMinutes: 480 })])).paidDaysX10).toBe(8); // 0,75 → làm tròn 0,8
    expect(calculatePayslip(input([day({ workedMinutes: 600 })])).paidDaysX10).toBe(10); // tối đa 1 ngày
    expect(calculatePayslip(input([day({ workedMinutes: 240, scheduledMinutes: 240 })])).paidDaysX10).toBe(10); // ca ngắn làm đủ = 1 ngày
  });
  it("giờ tăng ca không được tính thành ngày công; phép và lễ có lương vẫn cộng", () => {
    expect(calculatePayslip(input([day({ workedMinutes: 480, overtimeMinutes: 120 })])).paidDaysX10).toBe(8);
    const p = calculatePayslip(input([day({ workedMinutes: 0, shiftsWorked: 0, leavePaidX10: 10 }), day({ workedMinutes: 0, shiftsWorked: 0, holiday: true, holidayPaid: true })]));
    expect(p.paidDaysX10).toBe(20);
  });
  it("chế độ day_present (cũ): có phút công là đủ 1 ngày; phiếu lương ghi chú cách tính", () => {
    expect(calculatePayslip(input([day({ workedMinutes: 30 })]), DAY_PRESENT).paidDaysX10).toBe(10);
    const prop = calculatePayslip(input([day({ workedMinutes: 30 })]));
    expect(prop.lines.find((l) => l.label === "Lương cơ bản")!.note).toContain("phút làm / phút ca");
  });
  it("setting hr.monthly_pay_mode mặc định proportional, đọc được day_present; migration có ghi chú [Cần xác nhận]", async () => {
    expect((await loadPayrollSettings(db())).monthlyPayMode).toBe("proportional");
    const row = await db().prepare(`SELECT note FROM settings WHERE key='hr.monthly_pay_mode'`).first<any>();
    expect(row.note).toContain("[Cần xác nhận]");
    await db().prepare(`UPDATE settings SET value='day_present' WHERE key='hr.monthly_pay_mode'`).run();
    expect((await loadPayrollSettings(db())).monthlyPayMode).toBe("day_present");
    await db().prepare(`UPDATE settings SET value='proportional' WHERE key='hr.monthly_pay_mode'`).run();
  });
  it("giữ nguyên TNCN 2026 và miễn thuế OT", () => {
    const p = calculatePayslip({ ...input(Array.from({ length: 26 }, () => day({ workedMinutes: 600, overtimeMinutes: 120 }))), employee: emp({ baseSalary: 20_800_000, pitEnabled: true }) });
    expect(p.overtimePay).toBe(26 * 300_000);
    expect(p.taxableIncome).toBe(p.gross - 26 * 100_000 - 15_500_000);
  });
});

const S = { lateGraceMinutes: 5, roundingMinutes: 15, otWeekdayBp: 15000, otWeekendBp: 20000, otHolidayBp: 30000 };
const E = { id: 1, name: "A", hireDate: "2026-01-01", terminationDate: null as string | null };
let aid = 0;
const A = (date: string): TsAssignment => ({ id: ++aid, workDate: date, ...shiftWindow(date, "08:00", "16:00"), breakMinutes: 0, status: "scheduled" });
const ts = (d: Partial<TsData>, s: any = S) => computeEmployeeTimesheet("2026-12", E, { punches: [], assignments: [], overtime: [], leaves: [], holidays: [], ...d }, s);
const leave = { fromDate: "2026-12-07", toDate: "2026-12-13", halfDay: false, code: "annual", paid: true, status: "approved" };

describe("C-15: phép chỉ tính ngày làm việc theo lịch", () => {
  it("tuần có lịch Thứ Hai–Thứ Sáu: nghỉ T2–CN chỉ cộng 5 ngày (thứ Bảy/Chủ nhật không có ca)", () => {
    const r = ts({ leaves: [leave], assignments: ["07", "08", "09", "10", "11"].map((d) => A(`2026-12-${d}`)) });
    expect(r.totals.paidLeaveX10).toBe(50);
  });
  it("tuần chưa xếp lịch: tính ngày thường, trừ ngày nghỉ hằng tuần cấu hình (7 = Chủ nhật) và ngày lễ", () => {
    expect(ts({ leaves: [leave] }).totals.paidLeaveX10).toBe(70);
    expect(ts({ leaves: [leave] }, { ...S, weeklyOffDays: [7] }).totals.paidLeaveX10).toBe(60);
    expect(ts({ leaves: [leave], holidays: [{ day: "2026-12-09", multiplierBp: 30000, paidOff: true }] }, { ...S, weeklyOffDays: [7] }).totals.paidLeaveX10).toBe(50);
  });
});

describe("C-15: đơn xin nghỉ trừ đúng số ngày làm việc", () => {
  beforeAll(async () => {
    await seedBase();
    await seedStaff({ userId: 4701, username: "nv4b", employeeId: 4701 });
    await db().batch([
      ...["07", "08", "09", "10", "11"].map((d) =>
        db().prepare(`INSERT INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (4701,?,(SELECT id FROM shift_templates WHERE code='SANG'),?,?,0)`)
          .bind(`2026-12-${d}`, shiftWindow(`2026-12-${d}`, "06:00", "14:00").startAt, shiftWindow(`2026-12-${d}`, "06:00", "14:00").endAt)),
      db().prepare(`INSERT OR REPLACE INTO settings(key, value, note) VALUES ('hr.weekly_off_days','7','test')`),
    ]);
  });
  it("tuần có lịch T2–T6 + Chủ nhật nghỉ tuần: xin T2–CN = 5 ngày; tuần không lịch T2–CN = 6 ngày", async () => {
    const r1 = await call("nv4b", "POST", `${V}/me/leave-requests`, { leaveTypeCode: "annual", fromDate: "2026-12-07", toDate: "2026-12-13" });
    expect(r1.status).toBe(201);
    expect(r1.body.daysX10).toBe(50);
    const r2 = await call("nv4b", "POST", `${V}/me/leave-requests`, { leaveTypeCode: "annual", fromDate: "2026-12-14", toDate: "2026-12-20" });
    expect(r2.status).toBe(201);
    expect(r2.body.daysX10).toBe(60);
    const r3 = await call("nv4b", "POST", `${V}/me/leave-requests`, { leaveTypeCode: "annual", fromDate: "2026-12-27", toDate: "2026-12-27" });
    expect(r3.status).toBe(422);
    expect(r3.body.error?.code ?? r3.body.code).toBe("no_working_days");
  });
});
