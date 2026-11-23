import { describe, expect, it } from "vitest";
import { computeEmployeeTimesheet, type TsAssignment, type TsData, type TsPunch } from "../src/worker/services/hr-timesheet";
import { shiftWindow } from "../src/worker/services/hr-common";

const S = { lateGraceMinutes: 5, roundingMinutes: 15, otWeekdayBp: 15000, otWeekendBp: 20000, otHolidayBp: 30000 };
const EMP = { id: 1, name: "A", hireDate: "2026-01-01", terminationDate: null as string | null };
const vn = (date: string, hhmm: string) => shiftWindow(date, hhmm, "23:59").startAt; // giờ VN → UTC ISO
let pid = 0;
const P = (kind: "in" | "out", date: string, hhmm: string, extra: Partial<TsPunch> = {}): TsPunch => ({ id: ++pid, kind, serverAt: vn(date, hhmm), status: "accepted", assignmentId: null, ...extra });
let aid = 0;
const A = (date: string, start: string, end: string, brk = 30, extra: Partial<TsAssignment> = {}): TsAssignment => {
  const w = shiftWindow(date, start, end);
  return { id: ++aid, workDate: date, startAt: w.startAt, endAt: w.endAt, breakMinutes: brk, status: "scheduled", ...extra };
};
const data = (o: Partial<TsData>): TsData => ({ punches: [], assignments: [], overtime: [], leaves: [], holidays: [], ...o });
const run = (d: Partial<TsData>, emp = EMP) => computeEmployeeTimesheet("2026-11", emp, data(d), S);

describe("computeEmployeeTimesheet", () => {
  it("ca đủ: worked trừ nghỉ giữa ca, không muộn/sớm", () => {
    const a = A("2026-11-04", "06:00", "14:00");
    const r = run({ assignments: [a], punches: [P("in", "2026-11-04", "05:58", { assignmentId: a.id }), P("out", "2026-11-04", "14:00", { assignmentId: a.id })] });
    const d = r.days[0];
    expect(d).toMatchObject({ workDate: "2026-11-04", scheduledMinutes: 450, workedMinutes: 482 - 30 + 0, lateMinutes: 0, earlyLeaveMinutes: 0, missingPunch: false, shiftsWorked: 1 });
    expect(r.totals.workDays).toBe(1);
  });

  it("đi muộn: late = in − start − grace", () => {
    const a = A("2026-11-04", "06:00", "14:00");
    const r = run({ assignments: [a], punches: [P("in", "2026-11-04", "06:15"), P("out", "2026-11-04", "14:00")] });
    expect(r.days[0].lateMinutes).toBe(10);
    // trong thời gian ân hạn → 0
    const r2 = run({ assignments: [A("2026-11-05", "06:00", "14:00")], punches: [P("in", "2026-11-05", "06:04"), P("out", "2026-11-05", "14:00")] });
    expect(r2.days[0].lateMinutes).toBe(0);
  });

  it("về sớm: early = end − out", () => {
    const r = run({ assignments: [A("2026-11-04", "06:00", "14:00")], punches: [P("in", "2026-11-04", "06:00"), P("out", "2026-11-04", "13:20")] });
    expect(r.days[0].earlyLeaveMinutes).toBe(40);
    expect(r.days[0].workedMinutes).toBe(440 - 30 + 0);
  });

  it("vào không có ra: missingPunch, không đoán giờ ra", () => {
    const r = run({ assignments: [A("2026-11-04", "06:00", "14:00")], punches: [P("in", "2026-11-04", "06:00")] });
    expect(r.days[0]).toMatchObject({ missingPunch: true, workedMinutes: 0, shiftsWorked: 0 });
    expect(r.totals.missingDays).toBe(1);
    // vào, ra ở ngày hôm sau (> 16h) cũng không ghép
    const r2 = run({ punches: [P("in", "2026-11-04", "06:00"), P("out", "2026-11-05", "06:00")] });
    expect(r2.days.find((d) => d.workDate === "2026-11-04")!.missingPunch).toBe(true);
    expect(r2.days.find((d) => d.workDate === "2026-11-04")!.workedMinutes).toBe(0);
  });

  it("ca gãy: cộng tổng hai ca trong ngày", () => {
    const a1 = A("2026-11-04", "06:00", "10:00", 0);
    const a2 = A("2026-11-04", "14:00", "18:00", 0);
    const r = run({
      assignments: [a1, a2],
      punches: [P("in", "2026-11-04", "06:00"), P("out", "2026-11-04", "10:00"), P("in", "2026-11-04", "14:10"), P("out", "2026-11-04", "18:00")],
    });
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({ scheduledMinutes: 480, workedMinutes: 240 + 230, shiftsWorked: 2, lateMinutes: 5 });
  });

  it("ca qua đêm thuộc ngày bắt đầu", () => {
    const a = A("2026-11-04", "22:00", "06:00", 0);
    expect(a.endAt > a.startAt).toBe(true);
    const r = run({ assignments: [a], punches: [P("in", "2026-11-04", "22:00", { assignmentId: a.id }), P("out", "2026-11-05", "06:00", { assignmentId: a.id })] });
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({ workDate: "2026-11-04", workedMinutes: 480, scheduledMinutes: 480 });
  });

  it("tăng ca: chỉ phần đã duyệt, làm tròn xuống, hệ số theo ngày thường / cuối tuần / lễ", () => {
    const r = run({
      overtime: [
        { workDate: "2026-11-04", minutes: 50, multiplierBp: null, status: "approved" }, // thường → 45
        { workDate: "2026-11-04", minutes: 600, multiplierBp: null, status: "pending" },
        { workDate: "2026-11-05", minutes: 120, multiplierBp: null, status: "rejected" },
        { workDate: "2026-11-07", minutes: 100, multiplierBp: null, status: "approved" }, // thứ bảy → 90, 200%
        { workDate: "2026-11-09", minutes: 60, multiplierBp: null, status: "approved" }, // lễ → 300%
      ],
      holidays: [{ day: "2026-11-09", name: "Lễ", multiplierBp: 30000, paidOff: true }],
    });
    const by = (d: string) => r.days.find((x) => x.workDate === d)!;
    expect(by("2026-11-04")).toMatchObject({ overtimeMinutes: 45, overtimeMultiplierBp: 15000 });
    expect(by("2026-11-05")).toBeUndefined();
    expect(by("2026-11-07")).toMatchObject({ overtimeMinutes: 90, overtimeMultiplierBp: 20000 });
    expect(by("2026-11-09")).toMatchObject({ overtimeMinutes: 60, overtimeMultiplierBp: 30000, holiday: true });
    expect(r.totals.overtimeMinutes).toBe(45 + 90 + 60);
  });

  it("ngày lễ nghỉ hưởng lương và nghỉ phép bỏ ngày lễ", () => {
    const r = run({
      holidays: [{ day: "2026-11-09", name: "Lễ", multiplierBp: 30000, paidOff: true }],
      leaves: [{ fromDate: "2026-11-08", toDate: "2026-11-10", halfDay: false, code: "annual", paid: true, status: "approved" }],
    });
    expect(r.days.map((d) => d.workDate)).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
    expect(r.days.find((d) => d.workDate === "2026-11-09")!.leaveCode).toBeNull(); // ngày lễ không trừ phép
    expect(r.totals.paidLeaveX10).toBe(20); // 08 (Chủ nhật vẫn tính) + 10
    expect(r.totals.paidHolidayDays).toBe(1);
  });

  it("nghỉ việc giữa tháng: chỉ tính đến termination_date", () => {
    const emp = { ...EMP, terminationDate: "2026-11-10" };
    const r = run({
      assignments: [A("2026-11-10", "06:00", "14:00", 0), A("2026-11-12", "06:00", "14:00", 0)],
      punches: [P("in", "2026-11-10", "06:00"), P("out", "2026-11-10", "14:00"), P("in", "2026-11-12", "06:00"), P("out", "2026-11-12", "14:00")],
      overtime: [{ workDate: "2026-11-12", minutes: 60, multiplierBp: null, status: "approved" }],
    }, emp);
    expect(r.days.map((d) => d.workDate)).toEqual(["2026-11-10"]);
    expect(r.totals.workedMinutes).toBe(480);
  });

  it("chỉ tính punch accepted; pending/rejected bị bỏ qua", () => {
    const r = run({
      punches: [
        P("in", "2026-11-04", "06:00"), P("out", "2026-11-04", "10:00"),
        P("in", "2026-11-05", "06:00", { status: "pending" }), P("out", "2026-11-05", "14:00", { status: "pending" }),
        P("in", "2026-11-06", "06:00", { status: "rejected" }),
      ],
    });
    expect(r.days.map((d) => d.workDate)).toEqual(["2026-11-04"]);
    expect(r.days[0].workedMinutes).toBe(240);
  });

  it("ca bị huỷ không tính vào giờ theo lịch", () => {
    const r = run({ assignments: [A("2026-11-04", "06:00", "14:00", 0, { status: "cancelled" })] });
    expect(r.days).toHaveLength(0);
  });
});
