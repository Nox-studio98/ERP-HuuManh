import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { shiftWindow } from "../src/worker/services/hr-common";

/** Phạt/thưởng theo ca → phiếu lương (penalties/bonus, diễn giải, inputs_hash) và bậc công (hr.workday_tiers) → paidDaysX10. */
const V = "/api/v1";
const db = () => testEnv.DB;
const vn = (date: string, hhmm: string) => shiftWindow(date, hhmm, "23:59").startAt;
let sang = 0;
async function shiftWithPunches(id: number, emp: number, date: string, start = "06:00", end = "14:00") {
  const w = shiftWindow(date, start, end);
  await db().batch([
    db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (?,?,?,?,?,?,30)`).bind(id, emp, date, sang, w.startAt, w.endAt),
    db().prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, effective_at, method, status, assignment_id) VALUES (?, 'in', ?, ?, 'gps', 'accepted', ?), (?, 'out', ?, ?, 'gps', 'accepted', ?)`)
      .bind(emp, w.startAt, w.startAt, id, emp, w.endAt, w.endAt, id),
  ]);
}

beforeAll(async () => {
  await seedBase();
  sang = (await db().prepare(`SELECT id FROM shift_templates WHERE code='SANG'`).first<{ id: number }>())!.id;
  await db().prepare(`INSERT OR IGNORE INTO cash_categories(code, name, direction, pnl_line) VALUES ('LUONG','Lương','out','payroll')`).run();
  for (const [i, n] of ["a", "b"].entries()) await seedStaff({ userId: 970 + i, username: `hp_${n}`, employeeId: 970 + i });
  await db().batch([
    db().prepare(`UPDATE employees SET pay_type='monthly', base_salary=2600000, insurance_salary=0, hire_date='2025-01-01' WHERE id IN (970, 971)`),
  ]);
  await shiftWithPunches(97001, 970, "2025-03-03");
  await shiftWithPunches(97002, 970, "2025-03-04");
  await shiftWithPunches(97101, 971, "2025-04-01");
  await shiftWithPunches(97102, 971, "2025-04-02");
});

describe("phạt/thưởng → lương", () => {
  it("cộng vào penalties/bonus, diễn giải từng dòng, inputs_hash đổi khi thêm/huỷ, kỳ đã duyệt → khoá", async () => {
    const pen = await call("manager", "POST", `${V}/attendance/incidents`, { employeeId: 970, workDate: "2025-03-03", assignmentId: 97001, typeId: 900, times: 2 });
    expect(pen.status).toBe(201);
    expect((await call("manager", "POST", `${V}/attendance/incidents`, { employeeId: 970, workDate: "2025-03-04", typeId: 903, times: 1 })).status).toBe(201);
    expect((await call("accountant", "POST", `${V}/timesheets/2025-03/close`, {})).status).toBe(200);
    expect((await call("accountant", "POST", `${V}/payroll/periods/2025-03/calculate`)).status).toBe(200);
    const item = (await call("accountant", "GET", `${V}/payroll/periods/2025-03`)).body.items.find((i: any) => i.employeeId === 970);
    expect(item.basePay).toBe(200000);
    expect(item.penalties).toBe(40000);
    expect(item.bonus).toBe(20000);
    expect(item.net).toBe(200000 + 20000 - 40000);
    const labels = item.lines.map((l: any) => l.label);
    expect(labels).toContain("Phạt: Đi muộn không lý do × 2 = 40.000 (03/03)");
    expect(labels).toContain("Thưởng: Chuyên cần × 1 = 20.000 (04/03)");

    // thêm một phạt sau khi tính → dữ liệu đầu vào đổi → duyệt bị chặn; huỷ nó → hash về như cũ → duyệt được
    const extra = await call("manager", "POST", `${V}/attendance/incidents`, { employeeId: 970, workDate: "2025-03-05", typeId: 901, times: 1 });
    expect((await call("owner", "POST", `${V}/payroll/periods/2025-03/approve`)).body.error.code).toBe("payroll_stale");
    expect((await call("manager", "POST", `${V}/attendance/incidents/${extra.body.id}/void`, { reason: "Nhập nhầm" })).status).toBe(200);
    expect((await call("owner", "POST", `${V}/payroll/periods/2025-03/approve`)).status).toBe(200);

    // kỳ đã duyệt: không ghi / huỷ thêm
    const late = await call("manager", "POST", `${V}/attendance/incidents`, { employeeId: 970, workDate: "2025-03-06", typeId: 901, times: 1 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("payroll_locked");
    expect((await call("manager", "POST", `${V}/attendance/incidents/${pen.body.id}/void`, { reason: "Muốn huỷ" })).body.error.code).toBe("payroll_locked");
    // trigger DB cũng chặn khi đi vòng qua API
    await expect(db().prepare(`INSERT INTO attendance_incidents(employee_id, work_date, type_id, kind, times, amount_each, amount, created_by) VALUES (970,'2025-03-07',900,'penalty',1,1,1,1)`).run()).rejects.toThrow(/payroll_locked/);
  });

  it("kỳ công đã chốt: chấm công thủ công bị chặn (timesheet_closed)", async () => {
    const r = await call("manager", "POST", `${V}/attendance/manual`, { targets: [{ assignmentId: 97001 }], type: "work", inTime: "06:00", outTime: "14:00", note: "Sửa giờ" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("timesheet_closed");
    const b = await call("manager", "GET", `${V}/attendance/board?from=2025-03-03&to=2025-03-04`);
    expect(b.body.periodsClosed).toEqual(["2025-03"]);
  });
});

describe("hr.workday_tiers → paidDaysX10", () => {
  it("bật bậc công: ngày 450 phút = 0,5 công; bảng công có workUnitsX10; phiếu lương diễn giải", async () => {
    await db().prepare(`INSERT INTO settings(key, value) VALUES ('hr.workday_tiers','240:5,480:10') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    const ts = await call("accountant", "GET", `${V}/timesheets/2025-04?employeeId=971`);
    const emp = ts.body.employees.find((e: any) => e.employeeId === 971);
    expect(emp.days.map((d: any) => d.workUnitsX10)).toEqual([5, 5]);
    expect(emp.totals.workUnitsX10).toBe(10);
    expect((await call("accountant", "POST", `${V}/timesheets/2025-04/close`, {})).status).toBe(200);
    expect((await call("accountant", "POST", `${V}/payroll/periods/2025-04/calculate`)).status).toBe(200);
    const item = (await call("accountant", "GET", `${V}/payroll/periods/2025-04`)).body.items.find((i: any) => i.employeeId === 971);
    expect(item.paidDaysX10).toBe(10);
    expect(item.basePay).toBe(100000);
    expect(JSON.stringify(item.lines)).toContain("công theo bậc giờ làm");
    await db().prepare(`UPDATE settings SET value='' WHERE key='hr.workday_tiers'`).run();
  });
});
