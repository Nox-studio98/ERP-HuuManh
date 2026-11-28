import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { shiftWindow } from "../src/worker/services/hr-common";
import { vnDate } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
const LAT = 10.7769, LNG = 106.7009;
const vn = (date: string, hhmm: string) => shiftWindow(date, hhmm, "23:59").startAt;
let sang = 0;
let nextAsg = 96000;
/** Ca sáng 06:00–14:00 (nghỉ 30') của NV vào ngày (giờ VN). */
async function addShift(emp: number, date: string, start = "06:00", end = "14:00") {
  const w = shiftWindow(date, start, end);
  const id = ++nextAsg;
  await db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (?,?,?,?,?,?,30)`).bind(id, emp, date, sang, w.startAt, w.endAt).run();
  return id;
}
const addPunch = (emp: number, kind: "in" | "out", at: string, asg: number | null, status = "accepted") =>
  db().prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, effective_at, method, status, assignment_id) VALUES (?,?,?,?,'gps',?,?)`).bind(emp, kind, at, at, status, asg).run();
const setting = (k: string, v: string) => db().prepare(`INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(k, v).run();
const board = async (from: string, to: string, role = "manager") => (await call(role, "GET", `${V}/attendance/board?from=${from}&to=${to}`)).body;
const cellOf = (b: any, asg: number) => b.cells.find((c: any) => c.assignmentId === asg);

const A = 960, B = 961, C = 962;
let a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0, a8 = 0;

beforeAll(async () => {
  await seedBase();
  sang = (await db().prepare(`SELECT id FROM shift_templates WHERE code='SANG'`).first<{ id: number }>())!.id;
  await db().prepare(`UPDATE stores SET lat=?, lng=?, geofence_m=100 WHERE id=1`).bind(LAT, LNG).run();
  for (const [i, n] of ["a", "b", "c", "d", "e", "f", "g", "h"].entries()) await seedStaff({ userId: 960 + i, username: `hb_${n}`, employeeId: 960 + i });
  // A: các trạng thái ô (tuần 02–06/11/2026)
  a1 = await addShift(A, "2026-11-02"); await addPunch(A, "in", vn("2026-11-02", "06:00"), a1); await addPunch(A, "out", vn("2026-11-02", "14:00"), a1);
  a2 = await addShift(A, "2026-11-03"); await addPunch(A, "in", vn("2026-11-03", "06:30"), a2); await addPunch(A, "out", vn("2026-11-03", "13:30"), a2);
  a3 = await addShift(A, "2026-11-04"); await addPunch(A, "in", vn("2026-11-04", "06:00"), a3);
  a4 = await addShift(A, "2026-11-05");
  a5 = await addShift(A, "2026-11-06");
  await db().prepare(`INSERT INTO leave_requests(employee_id, leave_type_id, from_date, to_date, days_x10, status, requested_by) SELECT ?, id, '2026-11-06', '2026-11-06', 10, 'approved', 1 FROM leave_types WHERE code='annual'`).bind(A).run();
  a6 = await addShift(A, "2026-11-09"); await addPunch(A, "in", vn("2026-11-09", "06:00"), a6, "pending");
});

describe("GET /attendance/board: trạng thái ô", () => {
  it("on_time, late_early, incomplete, not_yet, leave, pending → incomplete", async () => {
    const b = await board("2026-11-02", "2026-11-12");
    expect(b).toMatchObject({ from: "2026-11-02", mode: "shift" });
    expect(b.employees.some((e: any) => e.id === A)).toBe(true);
    expect(cellOf(b, a1)).toMatchObject({ key: `a:${a1}`, status: "on_time", workedMinutes: 450, lateMinutes: 0, shiftId: sang });
    expect(cellOf(b, a2)).toMatchObject({ status: "late_early", lateMinutes: 25, earlyMinutes: 30 });
    expect(cellOf(b, a3).status).toBe("incomplete");
    expect(cellOf(b, a3).inAt).toBe(vn("2026-11-04", "06:00"));
    expect(cellOf(b, a4).status).toBe("not_yet");
    expect(cellOf(b, a5)).toMatchObject({ status: "leave", leaveCode: "annual", leavePaid: true });
    expect(cellOf(b, a6)).toMatchObject({ status: "incomplete", pending: 1 });
    expect(b.pendingTotal).toBeGreaterThanOrEqual(1);
  });

  it("upcoming, working", async () => {
    const today = vnDate();
    const future = await addShift(D_(), "2026-12-20");
    const now = Date.now();
    const id = ++nextAsg;
    await db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (?,?,?,?,?,?,0)`)
      .bind(id, B, today, sang, new Date(now - 3600_000).toISOString(), new Date(now + 3 * 3600_000).toISOString()).run();
    await addPunch(B, "in", new Date(now - 3000_000).toISOString(), id);
    const b = await board(today, today);
    expect(cellOf(b, id).status).toBe("working");
    const f = await board("2026-12-20", "2026-12-20");
    expect(cellOf(f, future).status).toBe("upcoming");
  });

  it("auto khi hr.auto_attendance=1 và ca đã qua không có chấm", async () => {
    expect(cellOf(await board("2026-11-05", "2026-11-05"), a4).status).toBe("not_yet");
    await setting("hr.auto_attendance", "1");
    const b = await board("2026-11-05", "2026-11-05");
    expect(cellOf(b, a4)).toMatchObject({ status: "auto", workedMinutes: 450 });
    await setting("hr.auto_attendance", "0");
  });

  it("khoảng quá 42 ngày → 422; không quyền → 403", async () => {
    expect((await call("manager", "GET", `${V}/attendance/board?from=2026-01-01&to=2026-03-01`)).status).toBe(422);
    expect((await call("hb_a", "GET", `${V}/attendance/board`)).status).toBe(403);
  });

  it("chế độ window: ô u:, shifts là dòng ảo", async () => {
    await setting("hr.attendance_mode", "window");
    await addPunch(C, "in", vn("2026-11-10", "08:00"), null);
    await addPunch(C, "out", vn("2026-11-10", "17:30"), null);
    const b = await board("2026-11-10", "2026-11-10");
    await setting("hr.attendance_mode", "shift");
    expect(b.mode).toBe("window");
    expect(b.shifts).toEqual([{ id: 0, name: "Khung giờ làm việc", startTime: "08:00", endTime: "17:30", active: true }]);
    expect(b.cells.find((c: any) => c.key === `u:${C}:2026-11-10`)).toMatchObject({ assignmentId: null, status: "on_time", shiftId: 0 });
  });
});
function D_() { return 962; }

describe("POST /attendance/manual: work", () => {
  it("thay lần chấm cũ (rejected replaced_by_manual), chấm thủ công accepted, idempotent, có audit", async () => {
    const r = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: a3 }], type: "work", inTime: "06:00", outTime: "14:00", note: "Quên chấm ra" });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(1);
    expect(r.body.cells[0]).toMatchObject({ assignmentId: a3, status: "on_time", manual: true });
    const ps = (await db().prepare(`SELECT kind, status, method, note FROM attendance_punches WHERE employee_id=? AND assignment_id=? ORDER BY id`).bind(A, a3).all<any>()).results;
    expect(ps.map((p) => `${p.kind}:${p.status}:${p.method}`)).toEqual(["in:rejected:gps", "in:accepted:manual", "out:accepted:manual"]);
    expect(ps[0].note).toBe("replaced_by_manual");
    const again = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: a3 }], type: "work", inTime: "06:00", outTime: "14:00", note: "Quên chấm ra" });
    expect(again.body.updated).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM attendance_punches WHERE employee_id=?`).bind(A).first<any>()).n).toBe(8);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='attendance.manual' AND entity_id=?`).bind(`a:${a3}`).first<any>()).n).toBe(1);
    // cell detail có lịch sử, gồm lần bị thay
    const d = await call("manager", "GET", `${V}/attendance/cell?assignmentId=${a3}`);
    expect(d.body.punches.map((p: any) => p.status)).toEqual(["rejected", "accepted", "accepted"]);
    expect(d.body.history.some((h: any) => h.action === "attendance.manual")).toBe(true);
    expect(d.body.cell.key).toBe(`a:${a3}`);
  });

  it("cờ áp dụng: tắt đi muộn/về sớm → không tính; hàng loạt nhiều ô cùng ca; validate", async () => {
    a7 = await addShift(B, "2026-11-03");
    a8 = await addShift(C, "2026-11-03");
    const r = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: a7 }, { assignmentId: a8 }], type: "work", inTime: "06:40", outTime: "13:00", applyLate: false, applyEarly: false, note: "Việc đột xuất" });
    expect(r.body.updated).toBe(2);
    for (const c of r.body.cells) expect(c).toMatchObject({ status: "on_time", lateMinutes: 0, earlyMinutes: 0 });
    // khác ca → 422
    const tpl = (await db().prepare(`INSERT INTO shift_templates(code,name,start_time,end_time) VALUES ('T960','Ca tối','18:00','22:00') RETURNING id`).first<any>()).id;
    const w = shiftWindow("2026-11-07", "18:00", "22:00");
    await db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at) VALUES (96900,?,?,?,?,?)`).bind(B, "2026-11-07", tpl, w.startAt, w.endAt).run();
    const mixed = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: a7 }, { assignmentId: 96900 }], type: "work", inTime: "06:00", note: "xxx" });
    expect(mixed.body.error.code).toBe("mixed_shifts");
    expect((await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: a7 }], type: "work", note: "xxx" })).body.error.code).toBe("time_required");
    expect((await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: a7 }], type: "work", inTime: "06:00", note: "x" })).status).toBe(422);
    expect((await call("accountant", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: a7 }], type: "work", inTime: "06:00", note: "xxx" })).status).toBe(403);
  });

  it("ô ngoài lịch (employeeId + workDate) và giờ ra qua đêm", async () => {
    const r = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ employeeId: C, workDate: "2026-11-11" }], type: "work", inTime: "09:00", outTime: "17:00", note: "Làm ngoài lịch" });
    expect(r.body.updated).toBe(1);
    expect(r.body.cells[0]).toMatchObject({ key: `u:${C}:2026-11-11`, assignmentId: null, workedMinutes: 480 });
    const fut = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ employeeId: C, workDate: "2099-01-01" }], type: "work", inTime: "09:00", note: "tương lai" });
    expect(fut.body.error.code).toBe("future_time");
  });
});

describe("POST /attendance/manual: nghỉ + người làm thay", () => {
  it("paid_leave tạo đơn approved, ca thành leave; người làm thay có ca substitute_for_id; idempotent", async () => {
    const shift = await addShift(A, "2026-11-10");
    const r = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: shift }], type: "paid_leave", substituteEmployeeId: 963, note: "Con ốm" });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(1);
    const lv = await db().prepare(`SELECT status, days_x10, lt.paid FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE employee_id=? AND from_date='2026-11-10'`).bind(A).first<any>();
    expect(lv).toMatchObject({ status: "approved", days_x10: 10, paid: 1 });
    const sub = await db().prepare(`SELECT id, employee_id, substitute_for_id, status FROM shift_assignments WHERE substitute_for_id=?`).bind(shift).first<any>();
    expect(sub).toMatchObject({ employee_id: 963, status: "scheduled" });
    expect(r.body.cells.find((c: any) => c.assignmentId === shift)).toMatchObject({ status: "leave", leavePaid: true });
    expect(r.body.cells.find((c: any) => c.assignmentId === sub.id)).toMatchObject({ substituteForId: shift, substituteForEmployeeId: A });
    const again = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: shift }], type: "paid_leave", substituteEmployeeId: 963, note: "Con ốm" });
    expect(again.body.updated).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM leave_requests WHERE employee_id=? AND from_date='2026-11-10'`).bind(A).first<any>()).n).toBe(1);
    // đổi loại sang không lương khi đã có đơn có lương → 409
    expect((await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: shift }], type: "unpaid_leave", note: "đổi" })).body.error.code).toBe("leave_overlap");
  });

  it("unpaid_leave; người làm thay trùng giờ → 409; thay nhiều ô → 422", async () => {
    const s1 = await addShift(B, "2026-11-12");
    const busy = await addShift(964, "2026-11-12");
    const x = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: s1 }], type: "unpaid_leave", substituteEmployeeId: 964, note: "Việc riêng" });
    expect(x.body.error.code).toBe("substitute_busy");
    expect(busy).toBeGreaterThan(0);
    const ok = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: s1 }], type: "unpaid_leave", note: "Việc riêng" });
    expect(ok.body.cells[0]).toMatchObject({ status: "leave", leavePaid: false });
    const s2 = await addShift(B, "2026-11-13");
    expect((await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: s1 }, { assignmentId: s2 }], type: "paid_leave", substituteEmployeeId: 963, note: "xxx" })).status).toBe(422);
  });
});

describe("POST /schedule/:id/reassign", () => {
  it("đổi người khi chưa chấm; chặn khi đã có chấm / trùng ca / không quyền", async () => {
    const s = await addShift(A, "2026-11-16");
    const r = await call("manager", "POST", `${V}/schedule/${s}/reassign`, { employeeId: 965, reason: "Đổi người" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s, employeeId: 965 });
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='hr.schedule.reassign' AND entity_id=?`).bind(String(s)).first<any>()).n).toBe(1);
    expect((await call("manager", "POST", `${V}/schedule/${a1}/reassign`, { employeeId: 965, reason: "Đổi người" })).body.error.code).toBe("has_punches");
    const busy = await addShift(966, "2026-11-16");
    expect((await call("manager", "POST", `${V}/schedule/${s}/reassign`, { employeeId: 966, reason: "Đổi người" })).body.error.code).toBe("employee_busy");
    expect(busy).toBeGreaterThan(0);
    expect((await call("hb_a", "POST", `${V}/schedule/${s}/reassign`, { employeeId: 966, reason: "Đổi người" })).status).toBe(403);
    expect((await call("manager", "POST", `${V}/schedule/${s}/reassign`, { employeeId: 965, reason: "Đổi người" })).status).toBe(422);
  });
});

describe("Phạt / thưởng", () => {
  it("loại: chỉ hr.manage tạo/sửa; trùng tên 409; xem danh sách", async () => {
    const list = await call("manager", "GET", `${V}/attendance/incident-types?kind=penalty`);
    expect(list.body.items.map((t: any) => t.id)).toEqual(expect.arrayContaining([900, 901, 902]));
    expect(list.body.items.every((t: any) => t.kind === "penalty")).toBe(true);
    expect((await call("manager", "POST", `${V}/attendance/incident-types`, { kind: "penalty", name: "Mới", defaultAmount: 1000 })).status).toBe(403);
    const c = await call("owner", "POST", `${V}/attendance/incident-types`, { kind: "penalty", name: "Làm hỏng hàng", defaultAmount: 30000 });
    expect(c.status).toBe(201);
    expect((await call("owner", "POST", `${V}/attendance/incident-types`, { kind: "penalty", name: "Làm hỏng hàng", defaultAmount: 1 })).status).toBe(409);
    const u = await call("owner", "PUT", `${V}/attendance/incident-types/${c.body.id}`, { active: false });
    expect(u.body.active).toBe(false);
    expect((await call("manager", "POST", `${V}/attendance/incidents`, { employeeId: A, workDate: "2026-11-02", typeId: c.body.id, times: 1 })).body.error.code).toBe("incident_type_inactive");
  });

  it("tạo, ghi đè mức, huỷ, huỷ hai lần, bất biến, hiển thị tiền theo quyền, tổng", async () => {
    const r = await call("manager", "POST", `${V}/attendance/incidents`, { employeeId: A, workDate: "2026-11-02", assignmentId: a1, typeId: 900, times: 2, note: "muộn" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "penalty", times: 2, amountEach: 20000, amount: 40000 });
    const b2 = await call("owner", "POST", `${V}/attendance/incidents`, { employeeId: A, workDate: "2026-11-02", assignmentId: a1, typeId: 903, times: 1, amountEach: 30000 });
    expect(b2.body.amount).toBe(30000);
    const mismatch = await call("manager", "POST", `${V}/attendance/incidents`, { employeeId: B, workDate: "2026-11-02", assignmentId: a1, typeId: 900, times: 1 });
    expect(mismatch.body.error.code).toBe("assignment_mismatch");
    const cell = cellOf(await board("2026-11-02", "2026-11-02"), a1);
    expect(cell.incidents).toEqual({ penalty: 2, bonus: 1, amountPenalty: 40000, amountBonus: 30000 });
    const list = await call("accountant", "GET", `${V}/attendance/incidents?from=2026-11-01&to=2026-11-30&employeeId=${A}`);
    expect(list.body.totals).toEqual({ penalty: 40000, bonus: 30000 });
    expect(list.body.items[0]).toMatchObject({ employeeName: expect.any(String), shiftName: "Ca sáng", amount: expect.any(Number) });
    expect((await call("hb_a", "GET", `${V}/attendance/incidents`)).status).toBe(403);
    // bất biến
    await expect(db().prepare(`UPDATE attendance_incidents SET amount=1 WHERE id=?`).bind(r.body.id).run()).rejects.toThrow(/incident_immutable/);
    await expect(db().prepare(`DELETE FROM attendance_incidents WHERE id=?`).bind(r.body.id).run()).rejects.toThrow(/incident_immutable/);
    // huỷ
    expect((await call("manager", "POST", `${V}/attendance/incidents/${r.body.id}/void`, { reason: "x" })).status).toBe(422);
    expect((await call("manager", "POST", `${V}/attendance/incidents/${r.body.id}/void`, { reason: "Nhập nhầm" })).status).toBe(200);
    expect((await call("manager", "POST", `${V}/attendance/incidents/${r.body.id}/void`, { reason: "Nhập nhầm" })).body.error.code).toBe("already_voided");
    const after = await call("manager", "GET", `${V}/attendance/incidents?from=2026-11-01&to=2026-11-30&employeeId=${A}`);
    expect(after.body.totals.penalty).toBe(0);
    expect(after.body.items.find((i: any) => i.id === r.body.id).voided).toBe(true);
    expect(cellOf(await board("2026-11-02", "2026-11-02"), a1).incidents.penalty).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE entity='attendance_incident' AND entity_id=?`).bind(String(r.body.id)).first<any>()).n).toBe(2);
  });
});

describe("Cài đặt Chấm công", () => {
  it("nhóm 'Chấm công' có đủ khoá; kiểm tra giờ / bậc công / enum", async () => {
    const g = await call("owner", "GET", `${V}/settings`);
    const grp = g.body.groups.find((x: any) => x.group === "Chấm công");
    expect(grp.items.map((i: any) => i.key)).toEqual(expect.arrayContaining(["hr.attendance_mode", "hr.window_start", "hr.workday_tiers", "hr.unscheduled_punch", "hr.ot_auto", "hr.auto_attendance"]));
    const put = (k: string, v: string) => call("owner", "PUT", `${V}/settings`, { settings: { [k]: v } });
    expect((await put("hr.window_start", "25:00")).status).toBe(422);
    expect((await put("hr.window_start", "07:30")).status).toBe(200);
    expect((await put("hr.window_break_start", "")).status).toBe(200);
    expect((await put("hr.workday_tiers", "480:10,240:5")).status).toBe(422);
    expect((await put("hr.workday_tiers", "abc")).status).toBe(422);
    expect((await put("hr.workday_tiers", "240:5, 480:10")).status).toBe(200);
    expect((await db().prepare(`SELECT value FROM settings WHERE key='hr.workday_tiers'`).first<any>()).value).toBe("240:5,480:10");
    expect((await put("hr.workday_tiers", "")).status).toBe(200);
    expect((await put("hr.unscheduled_punch", "maybe")).status).toBe(422);
    expect((await put("hr.attendance_mode", "window")).status).toBe(200);
    await setting("hr.attendance_mode", "shift");
    await setting("hr.window_start", "08:00");
  });
});

describe("hr.unscheduled_punch", () => {
  const punch = (u: string) => call(u, "POST", `${V}/me/attendance/punch`, { kind: "in", method: "gps", lat: LAT, lng: LNG, accuracyM: 10 }, { headers: { "x-device-id": `dev-${u}` } });
  it("off → 422 no_shift; approve → pending; allow → accepted (mặc định)", async () => {
    expect((await db().prepare(`SELECT value FROM settings WHERE key='hr.unscheduled_punch'`).first<any>()).value).toBe("allow");
    await setting("hr.unscheduled_punch", "off");
    const off = await punch("hb_f");
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe("no_shift");
    await setting("hr.unscheduled_punch", "approve");
    const ap = await punch("hb_g");
    expect(ap.status).toBe(201);
    expect(ap.body.punch.status).toBe("pending");
    await setting("hr.unscheduled_punch", "allow");
    const al = await punch("hb_h");
    expect(al.body.punch.status).toBe("accepted");
    // có ca → luôn ghi nhận ngay dù cài đặt là off
    await setting("hr.unscheduled_punch", "off");
    const now = Date.now();
    const id = ++nextAsg;
    await db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (?,?,?,?,?,?,0)`)
      .bind(id, 965, vnDate(), sang, new Date(now - 600_000).toISOString(), new Date(now + 4 * 3600_000).toISOString()).run();
    await db().prepare(`DELETE FROM devices WHERE user_id=965`).run();
    const last = await punch("hb_f");
    expect(last.body.punch?.status, JSON.stringify(last.body)).toBe("accepted");
    await setting("hr.unscheduled_punch", "allow");
  });
});
