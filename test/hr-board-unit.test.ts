import { describe, expect, it } from "vitest";
import { computeEmployeeTimesheet, tierUnitsX10, type TsAssignment, type TsData, type TsPunch, type TsSettings } from "../src/worker/services/hr-timesheet";
import { parseWorkdayTiers, shiftWindow } from "../src/worker/services/hr-common";

const S: TsSettings = { lateGraceMinutes: 5, roundingMinutes: 15, otWeekdayBp: 15000, otWeekendBp: 20000, otHolidayBp: 30000 };
const EMP = { id: 1, name: "A", hireDate: "2026-01-01", terminationDate: null as string | null };
const vn = (date: string, hhmm: string) => shiftWindow(date, hhmm, "23:59").startAt;
let pid = 0;
const P = (kind: "in" | "out", date: string, hhmm: string, extra: Partial<TsPunch> = {}): TsPunch => ({ id: ++pid, kind, serverAt: vn(date, hhmm), status: "accepted", assignmentId: null, ...extra });
let aid = 0;
const A = (date: string, start: string, end: string, brk = 30): TsAssignment => {
  const w = shiftWindow(date, start, end);
  return { id: ++aid, workDate: date, startAt: w.startAt, endAt: w.endAt, breakMinutes: brk, status: "scheduled" };
};
const run = (d: Partial<TsData>, s: Partial<TsSettings> = {}) =>
  computeEmployeeTimesheet("2026-11", EMP, { punches: [], assignments: [], overtime: [], leaves: [], holidays: [], ...d }, { ...S, ...s });
const D = "2026-11-04"; // thứ Tư

describe("hr-board: quy tắc tính công mở rộng", () => {
  it("mặc định giữ nguyên cách tính cũ (không muộn/sớm thêm, không OT tự động, không bậc công)", () => {
    const a = A(D, "06:00", "14:00");
    const r = run({ assignments: [a], punches: [P("in", D, "05:30"), P("out", D, "14:40")] });
    expect(r.days[0]).toMatchObject({ lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, workUnitsX10: null });
  });

  it("hr.early_grace_minutes: về sớm trong ân hạn không tính, vượt thì trừ ân hạn", () => {
    const a = A(D, "06:00", "14:00");
    const punches = [P("in", D, "06:00"), P("out", D, "13:50")];
    expect(run({ assignments: [a], punches }).days[0].earlyLeaveMinutes).toBe(10);
    expect(run({ assignments: [a], punches }, { earlyGraceMinutes: 15 }).days[0].earlyLeaveMinutes).toBe(0);
    expect(run({ assignments: [a], punches }, { earlyGraceMinutes: 4 }).days[0].earlyLeaveMinutes).toBe(6);
  });

  it("hr.ot_auto: OT trước/sau ca đạt ngưỡng, làm tròn xuống, không cần đơn", () => {
    const a = A(D, "06:00", "14:00");
    const punches = [P("in", D, "05:30"), P("out", D, "14:40")];
    const r = run({ assignments: [a], punches }, { otAuto: true, otMinBeforeMinutes: 15, otMinAfterMinutes: 30 });
    expect(r.days[0].overtimeMinutes).toBe(60); // 30 + 40 = 70 → 60
    expect(r.cells![0].otMinutes).toBe(60);
    // ngưỡng sau 60 phút: bỏ phần sau ca
    expect(run({ assignments: [a], punches }, { otAuto: true, otMinAfterMinutes: 60 }).days[0].overtimeMinutes).toBe(30);
    // tắt → 0
    expect(run({ assignments: [a], punches }, { otAuto: false }).days[0].overtimeMinutes).toBe(0);
  });

  it("hr.ot_auto cùng đơn tăng ca đã duyệt: lấy số lớn hơn, không cộng dồn", () => {
    const a = A(D, "06:00", "14:00");
    const punches = [P("in", D, "06:00"), P("out", D, "15:00")];
    const r = run({ assignments: [a], punches, overtime: [{ workDate: D, minutes: 60, multiplierBp: null, status: "approved" }] }, { otAuto: true });
    expect(r.days[0].overtimeMinutes).toBe(60);
  });

  it("cờ noLate / noEarly / noOt trên lần chấm", () => {
    const a = A(D, "06:00", "14:00");
    const note = "quên máy [flags:noLate,noEarly,noOt]";
    const punches = [P("in", D, "06:30", { note }), P("out", D, "13:30", { note })];
    expect(run({ assignments: [a], punches }).days[0]).toMatchObject({ lateMinutes: 0, earlyLeaveMinutes: 0 });
    const plain = [P("in", D, "06:30"), P("out", D, "13:30")];
    expect(run({ assignments: [a], punches: plain }).days[0]).toMatchObject({ lateMinutes: 25, earlyLeaveMinutes: 30 });
    const ot = [P("in", D, "05:00", { note }), P("out", D, "15:00", { note })];
    expect(run({ assignments: [a], punches: ot }, { otAuto: true }).days[0].overtimeMinutes).toBe(0);
  });

  it("hr.auto_attendance: ca đã qua không có lần chấm → đủ giờ theo lịch; có chấm bị từ chối / nghỉ phép / hôm nay thì không", () => {
    const a = A(D, "06:00", "14:00");
    const now = "2026-11-10T03:00:00.000Z";
    const r = run({ assignments: [a] }, { autoAttendance: true, nowIso: now });
    expect(r.days[0]).toMatchObject({ workedMinutes: 450, shiftsWorked: 1, autoShifts: 1 });
    expect(r.cells![0].auto).toBe(true);
    expect(run({ assignments: [a] }, { autoAttendance: false, nowIso: now }).days[0].workedMinutes).toBe(0);
    // có một lần chấm bị từ chối → không tự động
    const rej = run({ assignments: [a], punches: [P("in", D, "06:00", { status: "rejected" })] }, { autoAttendance: true, nowIso: now });
    expect(rej.days[0].workedMinutes).toBe(0);
    // nghỉ phép
    const lv = run({ assignments: [a], leaves: [{ fromDate: D, toDate: D, halfDay: false, code: "annual", paid: true, status: "approved" }] }, { autoAttendance: true, nowIso: now });
    expect(lv.days[0].workedMinutes).toBe(0);
    // ngày hôm nay chưa tự tính
    const today = run({ assignments: [a] }, { autoAttendance: true, nowIso: "2026-11-04T09:00:00.000Z" });
    expect(today.days[0].workedMinutes).toBe(0);
  });

  it("hr.workday_tiers: quy đổi giờ làm ra công×10, tổng trong totals", () => {
    expect(parseWorkdayTiers("240:5,480:10,600:15")).toEqual([[240, 5], [480, 10], [600, 15]]);
    expect(parseWorkdayTiers("480:10,240:5")).toBeNull();
    expect(parseWorkdayTiers("abc")).toBeNull();
    expect(parseWorkdayTiers("")).toEqual([]);
    const tiers: [number, number][] = [[240, 5], [480, 10], [600, 15]];
    expect([100, 240, 479, 480, 599, 700].map((m) => tierUnitsX10(m, tiers))).toEqual([0, 5, 5, 10, 10, 15]);
    const a1 = A(D, "06:00", "14:00", 0);
    const a2 = A("2026-11-05", "06:00", "14:00", 0);
    const r = run({ assignments: [a1, a2], punches: [P("in", D, "06:00"), P("out", D, "14:00"), P("in", "2026-11-05", "06:00"), P("out", "2026-11-05", "10:30")] }, { workdayTiers: tiers });
    expect(r.days.map((d) => d.workUnitsX10)).toEqual([10, 5]);
    expect(r.totals.workUnitsX10).toBe(15);
  });

  it("chế độ window: ca ảo, trừ nghỉ giữa giờ, muộn/sớm không tính trong giờ nghỉ", () => {
    const w: Partial<TsSettings> = { attendanceMode: "window", windowStart: "08:00", windowEnd: "17:30", windowBreakStart: "12:00", windowBreakEnd: "13:00" };
    const r = run({ punches: [P("in", D, "08:20"), P("out", D, "17:00")] }, w);
    expect(r.days[0]).toMatchObject({ workedMinutes: 520 - 60, lateMinutes: 15, earlyLeaveMinutes: 30, scheduledMinutes: 570 - 60 });
    expect(r.cells![0].key).toBe("u:1:" + D);
    // vào lúc 12:30 (trong giờ nghỉ): muộn tính 08:00→12:30 trừ phần nghỉ đã qua (30 phút)
    const late = run({ punches: [P("in", D, "12:30"), P("out", D, "17:30")] }, w);
    expect(late.days[0].lateMinutes).toBe(270 - 30 - 5);
    // lịch ca bị bỏ qua
    const a = A(D, "06:00", "14:00");
    expect(run({ assignments: [a], punches: [P("in", D, "08:00"), P("out", D, "17:30")] }, w).days[0].lateMinutes).toBe(0);
  });

  it("cells theo ca: giờ vào/ra, late/early, ô không có chấm vẫn có mặt", () => {
    const a1 = A(D, "06:00", "14:00");
    const a2 = A("2026-11-05", "06:00", "14:00");
    const r = run({ assignments: [a1, a2], punches: [P("in", D, "06:10", { assignmentId: a1.id }), P("out", D, "14:00", { assignmentId: a1.id })] });
    expect(r.cells!.map((c) => c.key)).toEqual([`a:${a1.id}`, `a:${a2.id}`]);
    expect(r.cells![0]).toMatchObject({ lateMinutes: 5, shiftsWorked: 1 });
    expect(r.cells![0].inAt).toBe(vn(D, "06:10"));
    expect(r.cells![1]).toMatchObject({ shiftsWorked: 0, inAt: null });
  });
});
