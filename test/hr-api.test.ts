import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import { PASSWORD, seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";

const db = () => testEnv.DB;
const auditCount = async (action: string, entityId?: string) =>
  (await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action=? ${entityId ? "AND entity_id=?" : ""}`).bind(...(entityId ? [action, entityId] : [action])).first<{ n: number }>())!.n;

beforeAll(async () => {
  await seedBase();
  await seedStaff({ userId: 50, username: "staff1", employeeId: 50 });
});

describe("Phân quyền & dữ liệu nhạy cảm", () => {
  it("staff chấm công / xem lịch của mình nhưng 403 với /employees", async () => {
    expect((await call("staff1", "GET", "/api/v1/me/attendance/today")).status).toBe(200);
    expect((await call("staff1", "GET", "/api/v1/me/schedule")).status).toBe(200);
    expect((await call("staff1", "GET", "/api/v1/employees")).status).toBe(403);
    expect((await call("staff1", "GET", "/api/v1/timesheets/2026-11")).status).toBe(403);
    expect((await call("cashier", "POST", "/api/v1/schedule/bulk", { assignments: [] })).status).toBe(403);
  });

  it("kế toán tạo NV có lương; quản lý xem được nhưng không thấy trường lương/CCCD; xem nhạy cảm ghi audit", async () => {
    const created = await call("owner", "POST", "/api/v1/employees", {
      fullName: "Nguyễn Văn Lương", position: "thu ngân", storeId: 1, hireDate: "2026-03-01", payType: "monthly",
      baseSalary: 9_000_000, insuranceSalary: 5_000_000, idNumber: "079123456789", bankName: "VCB", bankAccount: "0011223344", phone: "0901234567",
    });
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^NV-\d{4}$/);
    expect(created.body.baseSalary).toBe(9_000_000);
    const id = created.body.id;

    const mgr = await call("manager", "GET", `/api/v1/employees/${id}`);
    expect(mgr.status).toBe(200);
    for (const k of ["baseSalary", "hourlyRate", "shiftRate", "insuranceSalary", "phone", "email", "idNumber", "address", "dob", "bankName", "bankAccount", "dependents"]) expect(mgr.body).not.toHaveProperty(k);
    expect(mgr.body.fullName).toBe("Nguyễn Văn Lương");
    const list = await call("manager", "GET", "/api/v1/employees?q=Lương");
    expect(list.body.items[0]).not.toHaveProperty("baseSalary");

    const before = await auditCount("hr.view_sensitive", String(id));
    const acc = await call("accountant", "GET", `/api/v1/employees/${id}`);
    expect(acc.body).toMatchObject({ baseSalary: 9_000_000, idNumber: "079123456789", bankAccount: "0011223344" });
    expect(acc.body.leaveBalance).toMatchObject({ entitledX10: 120, usedX10: 0, remainingX10: 120 });
    expect(await auditCount("hr.view_sensitive", String(id))).toBe(before + 1);
    // quản lý xem không ghi audit nhạy cảm
    await call("manager", "GET", `/api/v1/employees/${id}`);
    expect(await auditCount("hr.view_sensitive", String(id))).toBe(before + 1);
  });

  it("quản lý không có quyền tạo/sửa hồ sơ (hr.manage)", async () => {
    expect((await call("manager", "POST", "/api/v1/employees", { fullName: "X", position: "p", storeId: 1, hireDate: "2026-01-01", payType: "monthly" })).status).toBe(403);
    expect((await call("manager", "PUT", "/api/v1/employees/50", { fullName: "Y", version: 1 })).status).toBe(403);
  });

  it("sửa hồ sơ: version, audit before/after", async () => {
    const e = await call("owner", "POST", "/api/v1/employees", { fullName: "Sửa Lương", position: "kho", storeId: 1, hireDate: "2026-02-01", payType: "monthly", baseSalary: 7_000_000 });
    const id = e.body.id;
    const up = await call("owner", "PUT", `/api/v1/employees/${id}`, { baseSalary: 8_000_000, version: e.body.version });
    expect(up.status).toBe(200);
    expect(up.body.baseSalary).toBe(8_000_000);
    expect(up.body.version).toBe(e.body.version + 1);
    const stale = await call("owner", "PUT", `/api/v1/employees/${id}`, { baseSalary: 9_000_000, version: e.body.version });
    expect(stale.status).toBe(409);
    const row = await db().prepare(`SELECT before_json, after_json FROM audit_log WHERE action='hr.employee.update' AND entity_id=?`).bind(String(id)).first<any>();
    // giá trị lương không được ghi vào nhật ký, chỉ tên trường đã đổi
    expect(JSON.parse(row.before_json)).toEqual({ changed: ["baseSalary"] });
    expect(JSON.parse(row.after_json)).toEqual({ changed: ["baseSalary"] });
  });
});

describe("Tạo tài khoản & nghỉ việc", () => {
  it("tạo NV kèm tài khoản, mật khẩu tạm một lần, nghỉ việc thu hồi phiên + huỷ ca tương lai", async () => {
    const c = await call("owner", "POST", "/api/v1/employees", {
      fullName: "Trần Nghỉ Việc", position: "bán hàng", storeId: 1, hireDate: "2026-05-01", payType: "shift", shiftRate: 200_000,
      createUser: { username: "nghiviec", role: "staff" },
    });
    expect(c.status).toBe(201);
    expect(c.body.tempPassword).toBeTruthy();
    expect(c.body.username).toBe("nghiviec");
    const u = await db().prepare(`SELECT active, must_change_password, role FROM users WHERE username='nghiviec'`).first<any>();
    expect(u).toMatchObject({ active: 1, must_change_password: 1, role: "staff" });
    expect(JSON.stringify((await call("accountant", "GET", `/api/v1/employees/${c.body.id}`)).body)).not.toContain(c.body.tempPassword);
    expect((await call("owner", "POST", "/api/v1/employees", { fullName: "Trùng", position: "p", storeId: 1, hireDate: "2026-05-01", payType: "monthly", createUser: { username: "nghiviec" } })).status).toBe(409);

    const login = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "nghiviec", password: c.body.tempPassword }) }, testEnv);
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const me = () => app.request("/api/v1/me/schedule", { headers: { authorization: `Bearer ${token}` } }, testEnv);
    expect((await me()).status).toBe(403); // must_change_password được chặn ở server
    const chg = await app.request("/api/auth/change-password", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ current: c.body.tempPassword, next: "Mat-Khau-Moi-123" }) }, testEnv);
    expect(chg.status).toBe(200);
    expect((await me()).status).toBe(200);

    const sched = await call("manager", "POST", "/api/v1/schedule/bulk", { assignments: [
      { employeeId: c.body.id, workDate: "2026-12-01", shiftTemplateId: 1 },
      { employeeId: c.body.id, workDate: "2026-12-20", shiftTemplateId: 1 },
    ] });
    expect(sched.status).toBe(201);
    expect(sched.body.created).toBe(2);

    const t = await call("owner", "POST", `/api/v1/employees/${c.body.id}/terminate`, { terminationDate: "2026-12-10", reason: "Xin nghỉ" });
    expect(t.status).toBe(200);
    expect(t.body.status).toBe("terminated");
    expect((await me()).status).toBe(401); // phiên đã bị thu hồi
    expect(await db().prepare(`SELECT active FROM users WHERE username='nghiviec'`).first()).toEqual({ active: 0 });
    const st = await db().prepare(`SELECT work_date, status FROM shift_assignments WHERE employee_id=? ORDER BY work_date`).bind(c.body.id).all<any>();
    expect(st.results.map((r) => r.status)).toEqual(["scheduled", "cancelled"]);
    // xếp ca sau ngày nghỉ → 422
    const after = await call("manager", "POST", "/api/v1/schedule/bulk", { assignments: [{ employeeId: c.body.id, workDate: "2026-12-15", shiftTemplateId: 1 }] });
    expect(after.status).toBe(422);
    expect((await call("owner", "POST", `/api/v1/employees/${c.body.id}/terminate`, { terminationDate: "2026-12-10", reason: "x" })).status).toBe(409);
  });
});

describe("Lịch ca", () => {
  it("tính start/end UTC từ giờ VN, ca qua đêm kết thúc ngày sau, trùng thì bỏ qua, huỷ không xoá", async () => {
    const tpl = await call("manager", "POST", "/api/v1/shift-templates", { code: "dem", name: "Ca đêm", startTime: "22:00", endTime: "06:00", breakMinutes: 0 });
    expect(tpl.status).toBe(201);
    expect(tpl.body).toMatchObject({ code: "DEM", overnight: true });
    const r1 = await call("manager", "POST", "/api/v1/schedule/bulk", { assignments: [
      { employeeId: 50, workDate: "2026-12-05", shiftTemplateId: tpl.body.id }, { employeeId: 50, workDate: "2026-12-06", shiftTemplateId: 1 },
    ] });
    expect(r1.body).toEqual({ created: 2, skipped: 0 });
    const r2 = await call("manager", "POST", "/api/v1/schedule/bulk", { assignments: [{ employeeId: 50, workDate: "2026-12-05", shiftTemplateId: tpl.body.id }] });
    expect(r2.body).toEqual({ created: 0, skipped: 1 });
    const rows = await db().prepare(`SELECT work_date, start_at, end_at FROM shift_assignments WHERE employee_id=50 ORDER BY work_date`).all<any>();
    expect(rows.results[0]).toMatchObject({ start_at: "2026-12-05T15:00:00.000Z", end_at: "2026-12-05T23:00:00.000Z" });
    expect(rows.results[1]).toMatchObject({ start_at: "2026-12-05T23:00:00.000Z", end_at: "2026-12-06T07:00:00.000Z" });
    const sch = await call("manager", "GET", "/api/v1/schedule?from=2026-12-05&to=2026-12-06&employeeId=50");
    expect(sch.body.items).toHaveLength(2);
    expect(sch.body.items[0]).toMatchObject({ employeeName: "NV staff1", shiftName: "Ca đêm", status: "scheduled" });
    const id = sch.body.items[0].id;
    expect((await call("manager", "DELETE", `/api/v1/schedule/${id}`)).body.status).toBe("cancelled");
    expect(await db().prepare(`SELECT status FROM shift_assignments WHERE id=?`).bind(id).first()).toEqual({ status: "cancelled" });
    // staff xem lịch của mình (ca bị huỷ không hiện)
    const mine = await call("staff1", "GET", "/api/v1/me/schedule?from=2026-12-05&to=2026-12-06");
    expect(mine.body.items).toHaveLength(1);
  });

  it("đổi ca: nhận → quản lý duyệt đổi employee_id", async () => {
    await seedStaff({ userId: 150, username: "staff2", employeeId: 150 });
    await call("manager", "POST", "/api/v1/schedule/bulk", { assignments: [{ employeeId: 50, workDate: "2030-01-10", shiftTemplateId: 2 }] });
    const a = await db().prepare(`SELECT id FROM shift_assignments WHERE employee_id=50 AND work_date='2030-01-10'`).first<{ id: number }>();
    const sw = await call("staff1", "POST", "/api/v1/schedule/swaps", { fromAssignmentId: a!.id, toEmployeeId: 150, reason: "Việc nhà" });
    expect(sw.status).toBe(201);
    expect((await call("manager", "POST", `/api/v1/schedule/swaps/${sw.body.id}/decide`, { decision: "approved" })).status).toBe(409); // chưa chấp nhận
    expect((await call("staff1", "POST", `/api/v1/schedule/swaps/${sw.body.id}/accept`)).status).toBe(404); // không phải người nhận
    expect((await call("staff2", "POST", `/api/v1/schedule/swaps/${sw.body.id}/accept`)).status).toBe(200);
    expect((await call("manager", "POST", `/api/v1/schedule/swaps/${sw.body.id}/decide`, { decision: "approved" })).status).toBe(200);
    expect(await db().prepare(`SELECT employee_id FROM shift_assignments WHERE id=?`).bind(a!.id).first()).toEqual({ employee_id: 150 });
  });
});

describe("Nghỉ phép", () => {
  it("days_x10 bỏ ngày lễ (không bỏ Chủ nhật), vượt số dư → over_balance, duyệt cần ngoại lệ", async () => {
    await call("owner", "POST", "/api/v1/holidays", { day: "2027-09-02", name: "Quốc khánh" });
    expect((await call("owner", "POST", "/api/v1/holidays", { day: "2027-09-02", name: "dup" })).status).toBe(409);
    expect((await call("manager", "POST", "/api/v1/holidays", { day: "2027-09-03", name: "x" })).status).toBe(403);
    // 2027-08-30 (Th2) → 2027-09-05 (CN): 7 ngày trừ lễ 02/09 = 6 ngày
    const l1 = await call("staff1", "POST", "/api/v1/me/leave-requests", { leaveTypeCode: "annual", fromDate: "2027-08-30", toDate: "2027-09-05", reason: "Du lịch" });
    expect(l1.status).toBe(201);
    expect(l1.body).toMatchObject({ daysX10: 60, overBalance: false, status: "pending" });
    expect((await call("staff1", "POST", "/api/v1/me/leave-requests", { leaveTypeCode: "annual", fromDate: "2027-09-01", toDate: "2027-09-01" })).status).toBe(409); // trùng
    expect((await call("manager", "POST", `/api/v1/leave-requests/${l1.body.id}/decide`, { decision: "approved" })).status).toBe(200);
    // còn 120 − 60 = 60; xin 7 ngày nữa → vượt
    const l2 = await call("staff1", "POST", "/api/v1/me/leave-requests", { leaveTypeCode: "annual", fromDate: "2027-10-04", toDate: "2027-10-10" });
    expect(l2.body).toMatchObject({ daysX10: 70, overBalance: true });
    const d1 = await call("manager", "POST", `/api/v1/leave-requests/${l2.body.id}/decide`, { decision: "approved" });
    expect(d1.status).toBe(409);
    expect(d1.body.error.code).toBe("over_balance");
    // C-08: duyệt ngoại lệ bắt buộc có lý do
    expect((await call("manager", "POST", `/api/v1/leave-requests/${l2.body.id}/decide`, { decision: "approved", allowOverBalance: true })).status).toBe(422);
    expect((await call("manager", "POST", `/api/v1/leave-requests/${l2.body.id}/decide`, { decision: "approved", allowOverBalance: true, exceptionReason: "Việc gia đình đột xuất" })).status).toBe(200);
    // nửa ngày, nghỉ ốm không dùng số dư
    const l3 = await call("staff1", "POST", "/api/v1/me/leave-requests", { leaveTypeCode: "sick", fromDate: "2027-11-02", toDate: "2027-11-02", halfDay: true });
    expect(l3.body).toMatchObject({ daysX10: 5, overBalance: false });
    // số dư theo năm trên hồ sơ
    const me = await call("staff1", "GET", "/api/v1/me/leave-requests");
    expect(me.body.items).toHaveLength(3);
    const emp = await call("accountant", "GET", "/api/v1/employees/50");
    expect(emp.body.leaveBalance.year).toBe(Number(new Date().toISOString().slice(0, 4)));
    expect((await call("staff1", "POST", "/api/v1/me/leave-requests", { leaveTypeCode: "annual", fromDate: "2027-12-05", toDate: "2027-12-01" })).status).toBe(422);
  });
});

describe("Chốt bảng công", () => {
  const P = "2026-09";
  it("chặn khi còn mục chưa xử lý, force cần lý do, ghi snapshot, kỳ đã chốt không sửa được", async () => {
    await seedStaff({ userId: 55, username: "staff5", employeeId: 55 });
    const d = db();
    await d.batch([
      d.prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, method, status) VALUES (55,'in','2026-09-02T00:00:00.000Z','manual','accepted'),(55,'out','2026-09-02T08:00:00.000Z','manual','accepted'),(55,'in','2026-09-03T00:00:00.000Z','offline','pending')`),
      d.prepare(`INSERT INTO overtime_requests(employee_id, work_date, minutes, status, requested_by) VALUES (55,'2026-09-02',50,'approved',1)`),
    ]);
    // sửa chấm công khi kỳ đang mở thì còn được
    const live = await call("manager", "GET", `/api/v1/timesheets/${P}?employeeId=55`);
    expect(live.body.status).toBe("open");
    expect(live.body.employees[0].days[0]).toMatchObject({ workDate: "2026-09-02", workedMinutes: 480, overtimeMinutes: 45 });
    expect(live.body.employees[0].days).toHaveLength(1); // punch pending (09-03) bị bỏ qua
    // yêu cầu bổ sung đang chờ
    const corr = await call("staff5", "POST", "/api/v1/me/attendance/corrections", { workDate: "2026-09-03", type: "missing_out", requestedAt: "2026-09-03T08:00:00.000Z", reason: "Quên chấm ra" });
    expect(corr.status).toBe(201);

    expect((await call("manager", "POST", `/api/v1/timesheets/${P}/close`, {})).status).toBe(403);
    const blocked = await call("accountant", "POST", `/api/v1/timesheets/${P}/close`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("unresolved_items");
    expect(blocked.body.error.details).toMatchObject({ pendingPunches: 1, pendingCorrections: 1 });
    expect((await call("accountant", "POST", `/api/v1/timesheets/${P}/close`, { force: true })).status).toBe(422); // thiếu lý do
    expect(await d.prepare(`SELECT COUNT(*) n FROM timesheet_days WHERE period=?`).bind(P).first()).toEqual({ n: 0 });

    const ok = await call("accountant", "POST", `/api/v1/timesheets/${P}/close`, { force: true, reason: "Chốt trước hạn trả lương" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "closed", forced: true });
    expect(await d.prepare(`SELECT status FROM timesheets WHERE period=?`).bind(P).first()).toEqual({ status: "closed" });
    expect((await d.prepare(`SELECT COUNT(*) n FROM timesheet_days WHERE period=? AND employee_id=55`).bind(P).first<any>()).n).toBe(1);
    expect(await auditCount("hr.timesheet.close", P)).toBe(1);
    expect((await call("accountant", "POST", `/api/v1/timesheets/${P}/close`, {})).status).toBe(409);

    // đọc từ snapshot
    const snap = await call("manager", "GET", `/api/v1/timesheets/${P}?employeeId=55`);
    expect(snap.body.status).toBe("closed");
    expect(snap.body.employees[0].totals).toMatchObject({ workedMinutes: 480, overtimeMinutes: 45, workDays: 1, shiftsWorked: 1 });
    // sửa sau khi chốt → 409
    expect(await call("manager", "POST", `/api/v1/attendance/corrections/${corr.body.id}/decide`, { decision: "approved" }).then((r) => r.status)).toBe(409);
    const pend = await d.prepare(`SELECT id FROM attendance_punches WHERE status='pending' AND employee_id=55`).first<{ id: number }>();
    const r = await call("manager", "POST", `/api/v1/attendance/punches/${pend!.id}/decide`, { decision: "approved" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("timesheet_closed");
    expect((await call("staff5", "POST", "/api/v1/me/overtime-requests", { workDate: "2026-09-10", minutes: 60 })).status).toBe(409);
    expect((await call("manager", "POST", "/api/v1/schedule/bulk", { assignments: [{ employeeId: 55, workDate: "2026-09-20", shiftTemplateId: 1 }] })).status).toBe(409);
    await expect(d.prepare(`UPDATE timesheet_days SET worked_minutes=1 WHERE period=?`).bind(P).run()).rejects.toThrow(/timesheet_closed/);

    // điều chỉnh vào kỳ sau
    const adj = await call("accountant", "POST", "/api/v1/timesheets/adjustments", { employeeId: 55, sourcePeriod: P, minutes: 30, kind: "work", reason: "Bổ sung công bị sót" });
    expect(adj.status).toBe(201);
    expect(adj.body.targetPeriod).toBe("2026-10");
    expect((await call("accountant", "POST", "/api/v1/timesheets/adjustments", { employeeId: 55, sourcePeriod: "2026-08", minutes: 30, kind: "work", reason: "x" })).status).toBe(409);
  });
});
