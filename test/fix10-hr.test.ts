import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { computeEmployeeTimesheet, type TsAssignment, type TsData, type TsSettings } from "../src/worker/services/hr-timesheet";
import { calculatePayslip, DEFAULT_PAYROLL_SETTINGS } from "../src/worker/services/payroll-calc";
import { shiftWindow } from "../src/worker/lib/../services/hr-common";
import { hashPassword } from "../src/worker/lib/crypto";
import { PASSWORD } from "./helpers";

const V = "/api/v1";
const db = () => testEnv.DB;
const MGR_USER = 1701, MGR_EMP = 1701, STAFF_EMP = 1702, OWN_EMP = 1703;

beforeAll(async () => {
  await seedBase();
  // quản lý có hồ sơ nhân viên gắn với CHÍNH tài khoản "manager" của seed
  const mgr = await db().prepare(`SELECT id FROM users WHERE username = 'manager'`).first<{ id: number }>();
  await db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date) VALUES (?,?,?,?,?,1,'2026-01-01')`).bind(MGR_EMP, "NV-T1701", mgr!.id, "Quản lý", "quản lý").run();
  await seedStaff({ userId: STAFF_EMP, username: "f10_staff", employeeId: STAFF_EMP });
  // chủ có hồ sơ nhân viên
  const own = await db().prepare(`SELECT id FROM users WHERE username = 'owner'`).first<{ id: number }>();
  await db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date) VALUES (?,?,?,?,?,1,'2026-01-01')`).bind(OWN_EMP, "NV-T1703", own!.id, "Chủ", "chủ").run();
  void MGR_USER; void hashPassword; void PASSWORD;
});

describe("K-HR1: không tự chấm công / tự ghi phép cho chính mình", () => {
  const manual = (role: string, employeeId: number, type = "work") =>
    call(role, "POST", `${V}/attendance/manual`, { targets: [{ employeeId, workDate: "2026-11-02" }], type, inTime: "06:00", outTime: "14:00", note: "kiểm thử" });

  it("quản lý tự chấm công / tự ghi phép có lương cho mình → 403 self_approval", async () => {
    const w = await manual("manager", MGR_EMP);
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe("self_approval");
    const l = await manual("manager", MGR_EMP, "paid_leave");
    expect(l.status).toBe(403);
    expect((await db().prepare(`SELECT COUNT(*) n FROM attendance_punches WHERE employee_id = ?`).bind(MGR_EMP).first<any>()).n).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM leave_requests WHERE employee_id = ?`).bind(MGR_EMP).first<any>()).n).toBe(0);
  });

  it("quản lý chấm cho nhân viên khác vẫn được; người làm thay là chính mình cũng bị chặn", async () => {
    expect((await manual("manager", STAFF_EMP)).status).toBe(200);
    const sub = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ employeeId: STAFF_EMP, workDate: "2026-11-03" }], type: "unpaid_leave", note: "kiểm thử", substituteEmployeeId: MGR_EMP });
    expect(sub.status).toBe(403);
  });

  it("chủ cũng bị chặn với chính mình khi còn người khác có quyền (quản lý đang hoạt động)", async () => {
    const r = await manual("owner", OWN_EMP);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("self_approval");
  });

  it("chủ được tự làm khi không còn ai khác có quyền xếp ca", async () => {
    await db().prepare(`UPDATE users SET active = 0 WHERE role = 'manager'`).run();
    try {
      expect((await manual("owner", OWN_EMP)).status).toBe(200);
    } finally {
      await db().prepare(`UPDATE users SET active = 1 WHERE role = 'manager'`).run();
    }
  });
});

describe("K-HR2: phạt/thưởng", () => {
  const inc = (role: string, body: Record<string, unknown>) => call(role, "POST", `${V}/attendance/incidents`, { workDate: "2026-11-02", times: 1, ...body });
  let penType = 0, bonusType = 0;
  beforeAll(async () => {
    penType = (await db().prepare(`SELECT id FROM attendance_incident_types WHERE kind='penalty' AND active=1 ORDER BY id LIMIT 1`).first<any>()).id;
    bonusType = (await db().prepare(`SELECT id FROM attendance_incident_types WHERE kind='bonus' AND active=1 ORDER BY id LIMIT 1`).first<any>()).id;
  });

  it("không tự ghi thưởng/phạt cho chính mình", async () => {
    const r = await inc("manager", { employeeId: MGR_EMP, typeId: bonusType });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("self_approval");
    expect((await inc("manager", { employeeId: MGR_EMP, typeId: penType })).status).toBe(403);
  });

  it("quản lý (chỉ hr.schedule) không ghi thưởng tiền, không sửa mức phạt", async () => {
    const b = await inc("manager", { employeeId: STAFF_EMP, typeId: bonusType });
    expect(b.status).toBe(403);
    expect(b.body.error.code).toBe("bonus_forbidden");
    const o = await inc("manager", { employeeId: STAFF_EMP, typeId: penType, amountEach: 1 });
    expect(o.body.error.code).toBe("amount_override_forbidden");
    expect((await inc("manager", { employeeId: STAFF_EMP, typeId: penType })).status).toBe(201);
  });

  it("số lần tối đa 20; tổng vượt hr.bonus_max_vnd (mặc định 2.000.000) chỉ chủ ghi được", async () => {
    expect((await inc("owner", { employeeId: STAFF_EMP, typeId: bonusType, times: 21, amountEach: 1000 })).status).toBe(422);
    // chủ ghi cho NV khác: vượt trần vẫn được (chủ), trong trần được
    expect((await inc("owner", { employeeId: STAFF_EMP, typeId: bonusType, amountEach: 1_500_000 })).status).toBe(201);
    expect((await inc("owner", { employeeId: STAFF_EMP, typeId: bonusType, amountEach: 5_000_000 })).status).toBe(201);
    // phạt mức lớn do quản lý (mức sẵn có) bị trần
    await db().prepare(`UPDATE attendance_incident_types SET default_amount = 3000000 WHERE id = ?`).bind(penType).run();
    const r = await inc("manager", { employeeId: STAFF_EMP, typeId: penType });
    expect(r.body.error.code).toBe("incident_over_limit");
    await db().prepare(`UPDATE attendance_incident_types SET default_amount = 20000 WHERE id = ?`).bind(penType).run();
  });
});

describe("K-HR3: bậc công chỉ tính giờ thường", () => {
  const S: TsSettings = { lateGraceMinutes: 5, roundingMinutes: 15, otWeekdayBp: 15000, otWeekendBp: 20000, otHolidayBp: 30000, workdayTiers: [[240, 5], [480, 10], [600, 15]] };
  const D = "2026-11-04";
  const w = shiftWindow(D, "08:00", "16:00");
  const asg: TsAssignment = { id: 1, workDate: D, startAt: w.startAt, endAt: w.endAt, breakMinutes: 0, status: "scheduled" };
  const at = (hhmm: string) => shiftWindow(D, hhmm, "23:59").startAt;
  const data = (): TsData => ({
    punches: [{ id: 1, kind: "in", serverAt: at("08:00"), status: "accepted", assignmentId: null }, { id: 2, kind: "out", serverAt: at("18:00"), status: "accepted", assignmentId: null }],
    assignments: [asg], overtime: [{ workDate: D, minutes: 120, multiplierBp: null, status: "approved" }], leaves: [], holidays: [],
  });
  const EMP = { id: 1, name: "A", hireDate: "2026-01-01", terminationDate: null as string | null };

  it("10 giờ chấm, 2 giờ tăng ca đã duyệt → bậc theo 8 giờ thường = 1 công (không phải 1,5)", () => {
    const r = computeEmployeeTimesheet("2026-11", EMP, data(), S);
    expect(r.days[0].overtimeMinutes).toBe(120);
    expect(r.days[0].workUnitsX10).toBe(10);
  });

  it("không có tăng ca duyệt thì 10 giờ vẫn 1,5 công", () => {
    const d = data();
    d.overtime = [];
    expect(computeEmployeeTimesheet("2026-11", EMP, d, S).days[0].workUnitsX10).toBe(15);
  });

  it("phiếu lương: công bậc + phép cùng ngày không vượt 1 ngày", () => {
    const base = { workedMinutes: 600, shiftsWorked: 1, scheduledMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, overtimeMultiplierBp: 15000, holiday: false, holidayPaid: false };
    const slip = (days: any[]) => calculatePayslip(
      { employee: { payType: "monthly", baseSalary: 2_600_000, hourlyRate: 0, shiftRate: 0, insuranceSalary: 0, dependents: 0, pitEnabled: false }, days, adjustMinutes: { work: 0, overtime: 0 }, advances: [], allowances: [], entries: [], salesRevenue: 0 } as any,
      { ...DEFAULT_PAYROLL_SETTINGS, workdayTiersOn: true, standardWorkdays: 26 },
    );
    const a = slip([{ ...base, workDate: "2026-11-02", leavePaidX10: 10, workUnitsX10: 15 }]);
    expect(a.lines.find((l: any) => l.label === "Lương cơ bản")!.amount).toBe(100_000); // 1 ngày, không phải 2,5
  });
});
