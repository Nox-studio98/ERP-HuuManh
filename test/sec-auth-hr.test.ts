import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";

const db = () => testEnv.DB;
const EMP = { fullName: "Người Mới", position: "bán hàng", storeId: 1, hireDate: "2026-03-01", payType: "monthly" };

beforeAll(async () => {
  await seedBase();
  await seedStaff({ userId: 710, username: "mgr2", role: "manager", employeeId: 710 });
  await seedStaff({ userId: 711, username: "stf711", employeeId: 711 });
  // nhân viên gắn với tài khoản chủ (user 1) và kế toán (user 5)
  await db().batch([
    db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date) VALUES (720,'NV-T720',1,'Chủ','chủ',1,'2026-01-01')`),
    db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date) VALUES (721,'NV-T721',5,'Kế toán','kế toán',1,'2026-01-01')`),
  ]);
});

describe("HR: phân quyền vai trò khi tạo/khoá tài khoản", () => {
  it("C-21: kế toán không tạo được hồ sơ/tài khoản nào qua POST /employees; chủ tạo staff được", async () => {
    for (const role of ["owner", "manager", "accountant"]) {
      const r = await call("accountant", "POST", "/api/v1/employees", { ...EMP, createUser: { username: `x_${role}`, role } });
      expect(r.status).toBe(403);
    }
    expect(await db().prepare(`SELECT id FROM users WHERE username LIKE 'x\\_%' ESCAPE '\\'`).first()).toBeNull();
    expect((await call("accountant", "POST", "/api/v1/employees", { ...EMP, createUser: { username: "new_staff1" } })).status).toBe(403);
    expect((await call("owner", "POST", "/api/v1/employees", { ...EMP, createUser: { username: "new_staff1" } })).status).toBe(201);
  });

  it("chủ tạo được manager nhưng không tạo thêm owner", async () => {
    expect((await call("owner", "POST", "/api/v1/employees", { ...EMP, createUser: { username: "new_mgr1", role: "manager" } })).status).toBe(201);
    expect((await call("owner", "POST", "/api/v1/employees", { ...EMP, createUser: { username: "new_own1", role: "owner" } })).status).toBe(403);
  });

  it("C-21: kế toán không cho nghỉ việc/khoá ai; chủ không tự khoá mình, cho nghỉ NV thường được", async () => {
    const t = { terminationDate: "2026-11-01", reason: "test" };
    expect((await call("accountant", "POST", "/api/v1/employees/720/terminate", t)).status).toBe(403);
    expect((await call("accountant", "POST", "/api/v1/employees/721/terminate", t)).status).toBe(403);
    expect((await db().prepare(`SELECT active FROM users WHERE id=1`).first<{ active: number }>())!.active).toBe(1);
    expect((await call("accountant", "POST", "/api/v1/employees/711/terminate", t)).status).toBe(403);
    expect((await call("owner", "POST", "/api/v1/employees/720/terminate", t)).status).toBe(403); // chủ không tự khoá chính mình
    expect((await call("owner", "POST", "/api/v1/employees/711/terminate", t)).status).toBe(200);
  });
});

describe("Audit: không lộ dữ liệu nhạy cảm", () => {
  it("nhật ký cập nhật hồ sơ/hợp đồng/phụ cấp không chứa giá trị lương; GET /audit che với người không có hr.sensitive", async () => {
    const e = await call("owner", "POST", "/api/v1/employees", { ...EMP, baseSalary: 7_654_321, idNumber: "079999888777", bankAccount: "9988776655" });
    expect(e.status).toBe(201);
    const id = e.body.id;
    expect((await call("owner", "PUT", `/api/v1/employees/${id}`, { baseSalary: 8_765_432, bankAccount: "1122334455", version: e.body.version })).status).toBe(200);
    expect((await call("owner", "POST", `/api/v1/employees/${id}/contracts`, { type: "hd", startDate: "2026-03-01", salary: 6_543_219 })).status).toBe(201);
    expect((await call("owner", "POST", `/api/v1/employees/${id}/allowances`, { name: "xăng", amount: 432_109 })).status).toBe(201);
    const raw = (await db().prepare(`SELECT group_concat(COALESCE(before_json,'') || COALESCE(after_json,''), ' ') s FROM audit_log WHERE entity='employee' AND entity_id=?`).bind(String(id)).first<{ s: string }>())!.s;
    for (const v of ["8765432", "7654321", "1122334455", "6543219", "432109", "079999888777"]) expect(raw).not.toContain(v);
    expect(raw).toContain("baseSalary"); // vẫn biết trường nào đổi

    // dòng cũ ghi sẵn giá trị thật (vd payroll) → manager không thấy
    await db().prepare(`INSERT INTO audit_log(user_id, action, entity, entity_id, after_json) VALUES (5,'payroll.update','payroll_run','1','{"net":99887766}')`).run();
    const m = await call("manager", "GET", "/api/v1/audit?limit=200");
    expect(m.status).toBe(200);
    expect(JSON.stringify(m.body)).not.toContain("99887766");
    const o = await call("owner", "GET", "/api/v1/audit?limit=200");
    expect(JSON.stringify(o.body)).toContain("99887766");
  });
});

describe("Tự duyệt (segregation of duties)", () => {
  it("manager không tự duyệt approval do mình tạo; chủ thì được", async () => {
    await db().batch([
      db().prepare(`INSERT INTO approvals(id, type, ref_type, ref_id, requested_by) VALUES (7001,'order.discount','order','1',2),(7002,'order.discount','order','1',2)`),
    ]);
    const r = await call("manager", "POST", "/api/v1/approvals/7001/decide", { decision: "approved" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("self_approval");
    expect((await call("owner", "POST", "/api/v1/approvals/7002/decide", { decision: "approved" })).status).toBe(200);
  });

  it("manager không duyệt phép / bổ sung công / tăng ca của chính mình, không ghi tăng ca đã duyệt cho mình", async () => {
    const lt = (await db().prepare(`SELECT id FROM leave_types LIMIT 1`).first<{ id: number }>())!.id;
    await db().batch([
      db().prepare(`INSERT INTO leave_requests(id, employee_id, leave_type_id, from_date, to_date, days_x10, requested_by) VALUES (7101,710,?,'2026-12-01','2026-12-01',10,710)`).bind(lt),
      db().prepare(`INSERT INTO attendance_corrections(id, employee_id, work_date, type, requested_at, kind, reason, requested_by) VALUES (7102,710,'2026-12-01','missing_in','2026-12-01T01:00:00Z','in','quên',710)`),
      db().prepare(`INSERT INTO overtime_requests(id, employee_id, work_date, minutes, requested_by) VALUES (7103,710,'2026-12-01',60,710)`),
    ]);
    const body = { decision: "approved" };
    for (const path of ["/leave-requests/7101", "/attendance/corrections/7102", "/overtime-requests/7103"]) {
      const r = await call("mgr2", "POST", `/api/v1${path}/decide`, body);
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe("self_approval");
    }
    const ot = await call("mgr2", "POST", "/api/v1/overtime-requests", { employeeId: 710, workDate: "2026-12-02", minutes: 60 });
    expect(ot.status).toBe(403);
    // người khác (owner) vẫn duyệt được
    expect((await call("owner", "POST", "/api/v1/leave-requests/7101/decide", body)).status).toBe(200);
  });
});

describe("Duyệt đồng thời / duyệt lại", () => {
  it("hai lần duyệt bổ sung công song song chỉ sinh một lần chấm; duyệt sau khi từ chối bị chặn", async () => {
    await db().batch([
      db().prepare(`INSERT INTO attendance_corrections(id, employee_id, work_date, type, requested_at, kind, reason, requested_by) VALUES (7201,711,'2026-11-10','missing_in','2026-11-10T01:00:00Z','in','quên',711)`),
      db().prepare(`INSERT INTO attendance_corrections(id, employee_id, work_date, type, requested_at, kind, reason, requested_by) VALUES (7202,711,'2026-11-11','missing_in','2026-11-11T01:00:00Z','in','quên',711)`),
    ]);
    const rs = await Promise.all([
      call("owner", "POST", "/api/v1/attendance/corrections/7201/decide", { decision: "approved" }),
      call("manager", "POST", "/api/v1/attendance/corrections/7201/decide", { decision: "approved" }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db().prepare(`SELECT COUNT(*) n FROM attendance_punches WHERE correction_id=7201`).first<{ n: number }>())!.n).toBe(1);

    expect((await call("owner", "POST", "/api/v1/attendance/corrections/7202/decide", { decision: "rejected" })).status).toBe(200);
    expect((await call("owner", "POST", "/api/v1/attendance/corrections/7202/decide", { decision: "approved" })).status).toBe(409);
    expect((await db().prepare(`SELECT COUNT(*) n FROM attendance_punches WHERE correction_id=7202`).first<{ n: number }>())!.n).toBe(0);
  });
});
