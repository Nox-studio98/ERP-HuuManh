import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { computeEmployeeTimesheet } from "../src/worker/services/hr-timesheet";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const LAT = 10.7769, LNG = 106.7009;
const punch = (role: string, body: unknown) => call(role, "POST", "/api/v1/me/attendance/punch", body, { headers: { "x-device-id": `dev-${role}` } });
const off = (kind: "in" | "out", clientAt: string) => ({ kind, method: "gps", lat: LAT, lng: LNG, accuracyM: 20, offline: { clientAt } });
const mins = (ts: any) => ts.employees.flatMap((e: any) => e.days).reduce((n: number, d: any) => n + d.workedMinutes, 0);

beforeAll(async () => {
  await seedBase();
  await db().prepare(`UPDATE stores SET lat=?, lng=?, geofence_m=100 WHERE id=1`).bind(LAT, LNG).run();
  for (const [i, n] of ["a", "b", "c", "d"].entries()) await seedStaff({ userId: 300 + i, username: `f3_${n}`, employeeId: 300 + i });
});

describe("C-01 chấm công offline dùng giờ máy nhân viên", () => {
  it("vào 9h trước, ra 1 phút trước, gửi lên cùng lúc → công ≈ 540 phút (không phải 0); quản lý từ chối thì bỏ khỏi bảng công", async () => {
    const now = Date.now();
    const inAt = new Date(now - 9 * 3600_000).toISOString();
    const outAt = new Date(now - 60_000).toISOString();
    const i = await punch("f3_a", off("in", inAt));
    const o = await punch("f3_a", off("out", outAt));
    expect(i.status).toBe(201);
    expect(i.body.punch).toMatchObject({ method: "offline", status: "accepted", reviewFlag: true, effectiveAt: inAt });
    expect(o.status).toBe(201);
    // server_at thật vẫn là giờ gửi (bất biến); effective_at là giờ máy
    const row = await db().prepare(`SELECT server_at, client_at, effective_at, review_flag FROM attendance_punches WHERE id=?`).bind(i.body.punch.id).first<any>();
    expect(row.client_at).toBe(inAt);
    expect(row.effective_at).toBe(inAt);
    expect(Date.parse(row.server_at)).toBeGreaterThan(now - 5000);
    const periods = [...new Set([vnDate(new Date(inAt)).slice(0, 7), vnDate(new Date(outAt)).slice(0, 7)])];
    let total = 0;
    for (const p of periods) total += mins((await call("manager", "GET", `/api/v1/timesheets/${p}?employeeId=300`)).body);
    expect(total).toBe(539);
    // cờ xem lại hiện trong danh sách; quản lý từ chối → không tính công
    const flagged = await call("manager", "GET", "/api/v1/attendance/punches?reviewFlag=1&employeeId=300");
    expect(flagged.body.items.map((x: any) => x.id).sort()).toEqual([i.body.punch.id, o.body.punch.id].sort());
    expect((await call("manager", "POST", `/api/v1/attendance/punches/${i.body.punch.id}/decide`, { decision: "rejected", note: "không đúng" })).body.status).toBe("rejected");
    total = 0;
    for (const p of periods) total += mins((await call("manager", "GET", `/api/v1/timesheets/${p}?employeeId=300`)).body);
    expect(total).toBe(0);
    // effective_at bất biến
    await expect(db().prepare(`UPDATE attendance_punches SET effective_at='2020-01-01T00:00:00.000Z' WHERE id=?`).bind(i.body.punch.id).run()).rejects.toThrow(/attendance_immutable/);
  });

  it("giờ máy ở tương lai hoặc cũ hơn 48h → không tin: chờ duyệt, tính theo giờ máy chủ", async () => {
    const future = await punch("f3_b", off("in", new Date(Date.now() + 3600_000).toISOString()));
    expect(future.body.punch).toMatchObject({ status: "pending", reviewFlag: false });
    expect(future.body.punch.effectiveAt).toBe(future.body.punch.serverAt);
    const old = await punch("f3_c", off("in", new Date(Date.now() - 72 * 3600_000).toISOString()));
    expect(old.body.punch).toMatchObject({ status: "pending" });
    expect(old.body.punch.effectiveAt).toBe(old.body.punch.serverAt);
    // đổi cài đặt: cho phép 100 giờ
    await db().prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('hr.offline_max_hours','100')`).run();
    const ok = await punch("f3_d", off("in", new Date(Date.now() - 72 * 3600_000).toISOString()));
    expect(ok.body.punch).toMatchObject({ status: "accepted", reviewFlag: true });
    await db().prepare(`DELETE FROM settings WHERE key='hr.offline_max_hours'`).run();
  });

  it("ca đêm qua nửa đêm tính vào work_date của ca (giờ hiệu lực dùng để ghép cặp)", () => {
    const emp = { id: 1, name: "x", hireDate: "2026-01-01", terminationDate: null };
    const ts = computeEmployeeTimesheet("2026-10", emp, {
      punches: [
        { id: 1, kind: "in", serverAt: "2026-10-10T15:00:00.000Z", status: "accepted", assignmentId: 1 }, // 22:00 VN 10/10
        { id: 2, kind: "out", serverAt: "2026-10-10T23:00:00.000Z", status: "accepted", assignmentId: 1 }, // 06:00 VN 11/10
      ],
      assignments: [{ id: 1, workDate: "2026-10-10", startAt: "2026-10-10T15:00:00.000Z", endAt: "2026-10-10T23:00:00.000Z", breakMinutes: 0, status: "scheduled" }],
      overtime: [], leaves: [], holidays: [],
    }, { lateGraceMinutes: 5, roundingMinutes: 15, otWeekdayBp: 15000, otWeekendBp: 20000, otHolidayBp: 30000 });
    const d = ts.days.find((x) => x.workDate === "2026-10-10")!;
    expect(d.workedMinutes).toBe(480);
    expect(ts.days.find((x) => x.workDate === "2026-10-11")?.workedMinutes ?? 0).toBe(0);
  });
});

describe("C-07 cấu hình cửa hàng", () => {
  it("quyền, validate toạ độ, ghi nhật ký; chấm GPS chạy sau khi đặt toạ độ", async () => {
    expect((await call("cashier", "GET", "/api/v1/stores")).status).toBe(403);
    expect((await call("manager", "PUT", "/api/v1/stores/1", { lat: 1, lng: 1 })).status).toBe(403);
    expect((await call("owner", "PUT", "/api/v1/stores/1", { lat: 100, lng: 1 })).status).toBe(422);
    expect((await call("owner", "PUT", "/api/v1/stores/1", { lat: 10, lng: null })).status).toBe(422); // thiếu kinh độ
    expect((await call("owner", "PUT", "/api/v1/stores/1", { lat: 10, lng: 106, geofenceM: 5 })).status).toBe(422);
    expect((await call("owner", "PUT", "/api/v1/stores/999", { lat: 10, lng: 106 })).status).toBe(404);
    const r = await call("accountant", "PUT", "/api/v1/stores/1", { lat: 10.78, lng: 106.7, geofenceM: 150 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 1, lat: 10.78, lng: 106.7, geofenceM: 150 });
    const g = await call("owner", "GET", "/api/v1/stores/1");
    expect(g.body).toMatchObject({ lat: 10.78, lng: 106.7, geofenceM: 150 });
    expect((await call("owner", "GET", "/api/v1/stores")).body.items.length).toBeGreaterThan(0);
    const a = await db().prepare(`SELECT before_json, after_json FROM audit_log WHERE action='store.update' ORDER BY id DESC LIMIT 1`).first<any>();
    expect(a.after_json).toContain("10.78");
    await db().prepare(`UPDATE stores SET lat=?, lng=?, geofence_m=100 WHERE id=1`).bind(LAT, LNG).run();
  });
});

describe("C-08 duyệt phép kiểm lại số dư lúc duyệt", () => {
  it("hai đơn pending đều 'đủ phép' lúc tạo, duyệt đơn thứ hai khi hết phép → 409 over_balance; ngoại lệ cần lý do", async () => {
    await seedStaff({ userId: 320, username: "f3_leave", employeeId: 320 });
    await db().prepare(`UPDATE employees SET annual_leave_days=12 WHERE id=320`).run();
    const a = await call("f3_leave", "POST", "/api/v1/me/leave-requests", { leaveTypeCode: "annual", fromDate: "2027-02-01", toDate: "2027-02-10" });
    const b = await call("f3_leave", "POST", "/api/v1/me/leave-requests", { leaveTypeCode: "annual", fromDate: "2027-02-15", toDate: "2027-02-24" });
    expect(a.body).toMatchObject({ daysX10: 100, overBalance: false });
    expect(b.body.overBalance).toBe(true); // đơn đang chờ cũng được tính khi tạo
    // ép cờ về false để mô phỏng dữ liệu cũ chốt lúc tạo
    await db().prepare(`UPDATE leave_requests SET over_balance=0 WHERE id=?`).bind(b.body.id).run();
    expect((await call("manager", "POST", `/api/v1/leave-requests/${a.body.id}/decide`, { decision: "approved" })).status).toBe(200);
    const d2 = await call("manager", "POST", `/api/v1/leave-requests/${b.body.id}/decide`, { decision: "approved" });
    expect(d2.status).toBe(409);
    expect(d2.body.error.code).toBe("over_balance");
    expect((await call("manager", "POST", `/api/v1/leave-requests/${b.body.id}/decide`, { decision: "approved", allowOverBalance: true })).body.error.code).toBe("exception_reason_required");
    const ok = await call("manager", "POST", `/api/v1/leave-requests/${b.body.id}/decide`, { decision: "approved", allowOverBalance: true, exceptionReason: "Cưới em gái" });
    expect(ok.status).toBe(200);
    expect(await db().prepare(`SELECT status, over_balance, exception_reason FROM leave_requests WHERE id=?`).bind(b.body.id).first()).toEqual({ status: "approved", over_balance: 1, exception_reason: "Cưới em gái" });
  });
});
