import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";

/**
 * Tích hợp Agent A (chấm công → chốt bảng công) với Agent B (tính lương đọc snapshot timesheet_days).
 * Kỳ 2025-03, NV lương tháng 2.600.000 / 26 công = 100.000/ngày, làm đủ 2 ca sáng (06:00–14:00 VN, nghỉ 30').
 */
const PERIOD = "2025-03";

beforeAll(async () => {
  await seedBase();
  const db = testEnv.DB;
  await seedStaff({ userId: 9301, username: "nv_integ", employeeId: 9301 });
  await db.batch([
    db.prepare(`UPDATE employees SET pay_type='monthly', base_salary=2600000, insurance_salary=0, hire_date='2025-01-01' WHERE id=9301`),
    db.prepare(`INSERT OR IGNORE INTO cash_categories(code, name, direction, pnl_line) VALUES ('LUONG','Lương','out','payroll')`),
    // 2 ca sáng: 03/03 và 04/03 (giờ VN 06:00–14:00 = 23:00Z hôm trước → 07:00Z)
    db.prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes)
                SELECT 93011, 9301, '2025-03-03', id, '2025-03-02T23:00:00.000Z', '2025-03-03T07:00:00.000Z', 30 FROM shift_templates WHERE code='SANG'`),
    db.prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes)
                SELECT 93012, 9301, '2025-03-04', id, '2025-03-03T23:00:00.000Z', '2025-03-04T07:00:00.000Z', 30 FROM shift_templates WHERE code='SANG'`),
    db.prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, method, status, assignment_id) VALUES
                (9301,'in','2025-03-02T23:00:00.000Z','gps','accepted',93011),(9301,'out','2025-03-03T07:00:00.000Z','gps','accepted',93011),
                (9301,'in','2025-03-03T23:00:00.000Z','gps','accepted',93012),(9301,'out','2025-03-04T07:00:00.000Z','gps','accepted',93012)`),
  ]);
});

describe("chấm công → chốt công → tính lương → phiếu lương", () => {
  it("runs end to end with consistent numbers", async () => {
    // payroll bị chặn khi bảng công chưa chốt
    const early = await call("accountant", "POST", `/api/v1/payroll/periods/${PERIOD}/calculate`);
    expect(early.status).toBe(409);

    const ts = await call("accountant", "GET", `/api/v1/timesheets/${PERIOD}?employeeId=9301`);
    expect(ts.status).toBe(200);
    const emp = ts.body.employees.find((e: any) => e.employeeId === 9301);
    if (!emp) throw new Error("timesheet: " + JSON.stringify(ts.body).slice(0, 600));
    expect(emp.totals.workedMinutes).toBe(2 * (480 - 30));
    expect(emp.totals.lateMinutes).toBe(0);

    const close = await call("accountant", "POST", `/api/v1/timesheets/${PERIOD}/close`, {});
    expect(close.status).toBe(200);

    const calc = await call("accountant", "POST", `/api/v1/payroll/periods/${PERIOD}/calculate`);
    expect(calc.status).toBe(200);
    const detail = await call("accountant", "GET", `/api/v1/payroll/periods/${PERIOD}`);
    const item = detail.body.items.find((i: any) => i.employeeId === 9301);
    expect(item.basePay).toBe(200000); // 2 công × 100.000
    expect(item.net).toBe(200000);

    // NV chưa thấy phiếu lương khi kỳ chưa duyệt; chủ duyệt xong thì thấy
    expect((await call("nv_integ", "GET", `/api/v1/me/payslips/${PERIOD}`)).status).toBe(404);
    expect((await call("accountant", "POST", `/api/v1/payroll/periods/${PERIOD}/approve`)).status).toBe(403);
    expect((await call("owner", "POST", `/api/v1/payroll/periods/${PERIOD}/approve`)).status).toBe(200);
    const slip = await call("nv_integ", "GET", `/api/v1/me/payslips/${PERIOD}`);
    expect(slip.status).toBe(200);
    expect(JSON.stringify(slip.body)).toContain("200000");
  });
});
