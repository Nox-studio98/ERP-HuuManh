import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";

beforeAll(async () => {
  await seedBase();
  await seedStaff({ userId: 9501, username: "nv_self_a", employeeId: 9501 });
  await seedStaff({ userId: 9502, username: "nv_self_b", employeeId: 9502 });
  const db = testEnv.DB;
  await db.batch([
    db.prepare(`UPDATE employees SET base_salary = 9000000, id_number = '079000000001' WHERE id IN (9501, 9502)`),
    db.prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at)
                SELECT 95011, 9501, '2099-01-05', id, '2099-01-04T23:00:00.000Z', '2099-01-05T07:00:00.000Z' FROM shift_templates WHERE code='SANG'`),
    db.prepare(`INSERT INTO overtime_requests(employee_id, work_date, minutes, status, requested_by) VALUES (9501,'2099-01-05',60,'pending',9501),(9502,'2099-01-05',30,'pending',9502)`),
    db.prepare(`INSERT INTO attendance_corrections(employee_id, work_date, type, kind, reason, requested_by) VALUES (9501,'2099-01-05','missing_out','out','quên',9501)`),
  ]);
});

describe("HR — endpoint cho chính NV", () => {
  it("lists only my overtime requests and corrections", async () => {
    const ot = await call("nv_self_a", "GET", "/api/v1/me/overtime-requests");
    expect(ot.status).toBe(200);
    expect(ot.body.items.map((x: any) => x.minutes)).toEqual([60]);
    const cr = await call("nv_self_a", "GET", "/api/v1/me/attendance/corrections");
    expect(cr.body.items).toHaveLength(1);
    expect((await call("nv_self_b", "GET", "/api/v1/me/attendance/corrections")).body.items).toHaveLength(0);
  });

  it("colleagues list exposes no sensitive fields; swaps visible to both parties with names", async () => {
    const col = await call("nv_self_a", "GET", "/api/v1/me/colleagues");
    expect(col.status).toBe(200);
    const b = col.body.items.find((x: any) => x.id === 9502);
    expect(b).toEqual({ id: 9502, fullName: "NV nv_self_b", position: "bán hàng" });
    expect(JSON.stringify(col.body)).not.toMatch(/9000000|079000000001/);
    expect(col.body.items.some((x: any) => x.id === 9501)).toBe(false);

    const req = await call("nv_self_a", "POST", "/api/v1/schedule/swaps", { fromAssignmentId: 95011, toEmployeeId: 9502, reason: "việc gia đình" });
    expect(req.status).toBeLessThan(300);
    const mineA = await call("nv_self_a", "GET", "/api/v1/me/schedule/swaps");
    const mineB = await call("nv_self_b", "GET", "/api/v1/me/schedule/swaps");
    expect(mineA.body.items[0]).toMatchObject({ fromEmployeeName: "NV nv_self_a", toEmployeeName: "NV nv_self_b", fromWorkDate: "2099-01-05" });
    expect(mineB.body.items).toHaveLength(1);
    // staff không xem được danh sách đổi ca của toàn cửa hàng
    expect((await call("nv_self_a", "GET", "/api/v1/schedule/swaps")).status).toBe(403);
  });
});
