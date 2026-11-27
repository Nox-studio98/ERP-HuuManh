import { beforeAll, describe, expect, it } from "vitest";
import { hrAttendanceAlerts } from "../src/worker/services/hr-cron";
import { makeQrCode, qrWindowOf } from "../src/worker/services/hr-qr";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";

const db = () => testEnv.DB;
const LAT = 10.7769, LNG = 106.7009;
const SECRET = "test-qr-secret";
const withSecret = { env: { ATTENDANCE_QR_SECRET: SECRET } };
const dev = (id: string) => ({ headers: { "x-device-id": id } });
const punch = (role: string, body: unknown, device = `dev-${role}`, opts: any = {}) => call(role, "POST", "/api/v1/me/attendance/punch", body, { headers: { "x-device-id": device }, ...opts });
const gps = (kind: "in" | "out", o: Record<string, unknown> = {}) => ({ kind, method: "gps", lat: LAT, lng: LNG, accuracyM: 20, ...o });

beforeAll(async () => {
  await seedBase();
  await db().prepare(`UPDATE stores SET lat=?, lng=?, geofence_m=100 WHERE id=1`).bind(LAT, LNG).run();
  for (const [i, n] of ["a", "b", "c", "d", "e", "f", "g", "h"].entries()) await seedStaff({ userId: 70 + i, username: `s_${n}`, employeeId: 70 + i, exempt: n === "c" });
});

describe("Chấm công GPS", () => {
  it("trong vùng → accepted, thiết bị đầu tiên tự đăng ký; vào hai lần → 409; ra được; today phản ánh", async () => {
    const r = await punch("s_a", gps("in"));
    expect(r.status).toBe(201);
    expect(r.body.punch).toMatchObject({ kind: "in", method: "gps", status: "accepted" });
    expect(r.body.punch.distanceM).toBeLessThanOrEqual(1);
    expect(new Date(r.body.punch.serverAt).getTime()).toBeGreaterThan(Date.now() - 5000);
    const d = await db().prepare(`SELECT approved_by FROM devices WHERE id='dev-s_a'`).first<any>();
    expect(d.approved_by).toBe(70);
    expect((await punch("s_a", gps("in"))).body.error.code).toBe("already_in");
    const today = await call("s_a", "GET", "/api/v1/me/attendance/today");
    expect(today.body.canPunch).toMatchObject({ in: false, out: true });
    expect(today.body.methods).toEqual(["gps"]); // chưa cấu hình QR
    expect(today.body.store).toEqual({ lat: LAT, lng: LNG, geofenceM: 100 });
    expect((await punch("s_a", gps("out"))).status).toBe(201);
    expect((await punch("s_a", gps("out"))).body.error.code).toBe("not_in");
  });

  it("ngoài vùng → 422 out_of_area; sai số lớn → 422 low_accuracy; thiếu device → 422", async () => {
    const far = await punch("s_b", gps("in", { lat: LAT + 0.01 }));
    expect(far.status).toBe(422);
    expect(far.body.error.code).toBe("out_of_area");
    expect(far.body.error.details.distanceM).toBeGreaterThan(1000);
    const bad = await punch("s_b", gps("in", { accuracyM: 500 }));
    expect(bad.body.error.code).toBe("low_accuracy");
    expect((await call("s_b", "POST", "/api/v1/me/attendance/punch", gps("in"))).body.error.code).toBe("device_required");
    expect((await db().prepare(`SELECT COUNT(*) n FROM attendance_punches WHERE employee_id=71`).first<any>()).n).toBe(0);
  });

  it("NV location_exempt → method exempt, không lưu vị trí", async () => {
    const r = await punch("s_c", gps("in", { lat: 1, lng: 1, accuracyM: 5000 }));
    expect(r.status).toBe(201);
    expect(r.body.punch.method).toBe("exempt");
    expect(await db().prepare(`SELECT lat, lng FROM attendance_punches WHERE id=?`).bind(r.body.punch.id).first()).toEqual({ lat: null, lng: null });
  });

  it("offline hợp lý → tính công ngay (accepted + review_flag), ghi client_at/effective_at; quản lý xác nhận bỏ cờ", async () => {
    const clientAt = new Date(Date.now() - 3600_000).toISOString();
    const r = await punch("s_g", gps("in", { offline: { clientAt } }));
    expect(r.status).toBe(201);
    // C-01: giờ máy hợp lý (trong 48h, không ở tương lai) → tính công ngay theo client_at, gắn cờ xem lại
    expect(r.body.punch).toMatchObject({ method: "offline", status: "accepted", reviewFlag: true, effectiveAt: clientAt });
    expect(await db().prepare(`SELECT client_at FROM attendance_punches WHERE id=?`).bind(r.body.punch.id).first()).toEqual({ client_at: clientAt });
    const dec = await call("manager", "POST", `/api/v1/attendance/punches/${r.body.punch.id}/decide`, { decision: "approved" });
    expect(dec.body.status).toBe("accepted");
    expect((await call("manager", "POST", `/api/v1/attendance/punches/${r.body.punch.id}/decide`, { decision: "approved" })).status).toBe(409);
    // nhật ký bất biến
    await expect(db().prepare(`DELETE FROM attendance_punches WHERE id=?`).bind(r.body.punch.id).run()).rejects.toThrow(/attendance_immutable/);
    const log = await call("manager", "GET", "/api/v1/attendance/punches?employeeId=76");
    expect(log.body.items[0]).toMatchObject({ status: "accepted", method: "offline" });
    expect(log.body.items[0]).not.toHaveProperty("lat");
  });
});

describe("Chấm công QR", () => {
  it("không có secret → 503 qr_not_configured nhưng GPS vẫn chạy", async () => {
    const r = await punch("s_d", { kind: "in", method: "qr", qrCode: "1.1.x" }, "dev-s_d", { env: { ATTENDANCE_QR_SECRET: undefined } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("qr_not_configured");
    expect((await call("manager", "GET", "/api/v1/attendance/qr?storeId=1", undefined, { env: { ATTENDANCE_QR_SECRET: undefined } })).status).toBe(503);
  });

  it("mã hợp lệ (hiện tại / liền trước) → accepted; hết hạn / giả → 422; dùng lại cùng cửa sổ → 409", async () => {
    const qr = await call("manager", "GET", "/api/v1/attendance/qr?storeId=1", undefined, withSecret);
    expect(qr.status).toBe(200);
    expect(qr.body.windowSeconds).toBe(30);
    expect(new Date(qr.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await call("cashier", "GET", "/api/v1/attendance/qr", undefined, withSecret)).status).toBe(403);

    const ok = await punch("s_d", { kind: "in", method: "qr", qrCode: qr.body.code }, "dev-s_d", withSecret);
    expect(ok.status).toBe(201);
    expect(ok.body.punch).toMatchObject({ method: "qr", status: "accepted", distanceM: null });
    expect(await db().prepare(`SELECT lat FROM attendance_punches WHERE id=?`).bind(ok.body.punch.id).first()).toEqual({ lat: null });

    const cur = qrWindowOf(Date.now(), 30);
    const prev = await punch("s_e", { kind: "in", method: "qr", qrCode: await makeQrCode(SECRET, 1, cur - 1) }, "dev-s_e", withSecret);
    expect(prev.status).toBe(201); // cửa sổ liền trước vẫn nhận

    const old = await punch("s_f", { kind: "in", method: "qr", qrCode: await makeQrCode(SECRET, 1, cur - 2) }, "dev-s_f", withSecret);
    expect(old.status).toBe(422);
    expect(old.body.error.code).toBe("invalid_qr");
    expect((await punch("s_f", { kind: "in", method: "qr", qrCode: await makeQrCode("khac", 1, cur) }, "dev-s_f", withSecret)).body.error.code).toBe("invalid_qr");
    expect((await punch("s_f", { kind: "in", method: "qr", qrCode: await makeQrCode(SECRET, 2, cur) }, "dev-s_f", withSecret)).body.error.code).toBe("invalid_qr");

    // dùng lại: vào(QR) → ra(GPS) → vào(cùng mã) → 409
    await punch("s_e", gps("out"), "dev-s_e");
    const again = await punch("s_e", { kind: "in", method: "qr", qrCode: await makeQrCode(SECRET, 1, cur - 1) }, "dev-s_e", withSecret);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("qr_already_used");
  });
});

describe("Thiết bị chấm công", () => {
  it("thiết bị thứ hai → 403 + tạo yêu cầu; quản lý duyệt thì chấm được và máy cũ bị thu hồi", async () => {
    expect((await punch("s_h", gps("in"), "phone-1")).status).toBe(201);
    await punch("s_h", gps("out"), "phone-1");
    const r = await punch("s_h", gps("in"), "phone-2");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("device_not_registered");
    await punch("s_h", gps("in"), "phone-2"); // gửi lại không tạo trùng
    const list = await call("manager", "GET", "/api/v1/devices/requests");
    const mine = list.body.items.filter((x: any) => x.deviceId === "phone-2");
    expect(mine).toHaveLength(1);
    expect((await call("cashier", "GET", "/api/v1/devices/requests")).status).toBe(403);
    expect((await call("manager", "POST", `/api/v1/devices/requests/${mine[0].id}/decide`, { decision: "approved" })).status).toBe(200);
    expect((await punch("s_h", gps("in"), "phone-2")).status).toBe(201);
    expect((await punch("s_h", gps("out"), "phone-1")).status).toBe(403); // máy cũ đã bị thu hồi
    const d = await db().prepare(`SELECT approved_by, revoked_at FROM devices WHERE id='phone-2'`).first<any>();
    expect(d.approved_by).toBe(2);
    // thiết bị của người khác
    expect((await punch("s_a", gps("in"), "phone-2")).body.error.code).toBe("device_not_registered");
  });
});

describe("Bổ sung công", () => {
  it("duyệt tạo punch manual accepted (created_by = người duyệt); từ chối thì không", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const at = new Date(Date.now() - 1800_000).toISOString();
    const c1 = await call("s_f", "POST", "/api/v1/me/attendance/corrections", { workDate: new Date(Date.parse(at) + 7 * 3600_000).toISOString().slice(0, 10), type: "missing_in", requestedAt: at, reason: "Quên chấm vào" });
    expect(c1.status).toBe(201);
    expect((await call("s_f", "POST", `/api/v1/attendance/corrections/${c1.body.id}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await call("manager", "GET", "/api/v1/attendance/corrections?status=pending")).body.items.some((x: any) => x.id === c1.body.id)).toBe(true);
    const d = await call("manager", "POST", `/api/v1/attendance/corrections/${c1.body.id}/decide`, { decision: "approved", note: "OK" });
    expect(d.status).toBe(200);
    const p = await db().prepare(`SELECT kind, server_at, method, status, created_by, correction_id FROM attendance_punches WHERE correction_id=?`).bind(c1.body.id).first<any>();
    expect(p).toMatchObject({ kind: "in", server_at: at, method: "manual", status: "accepted", created_by: 2 });
    expect((await call("manager", "POST", `/api/v1/attendance/corrections/${c1.body.id}/decide`, { decision: "rejected" })).status).toBe(409);
    const c2 = await call("s_f", "POST", "/api/v1/me/attendance/corrections", { workDate: new Date(Date.parse(at) + 7 * 3600_000).toISOString().slice(0, 10), type: "missing_out", requestedAt: at, reason: "x" });
    await call("manager", "POST", `/api/v1/attendance/corrections/${c2.body.id}/decide`, { decision: "rejected" });
    expect((await db().prepare(`SELECT COUNT(*) n FROM attendance_punches WHERE correction_id=?`).bind(c2.body.id).first<any>()).n).toBe(0);
    expect(day).toBeTruthy();
  });
});

describe("Cảnh báo chấm công", () => {
  it("quá 15' chưa vào ca → hr.alert, chạy lại không báo trùng", async () => {
    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    const end = new Date(Date.now() + 7 * 3600_000).toISOString();
    await db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (9001, 71, '2026-11-23', 1, ?, ?, 0)`).bind(start, end).run();
    await hrAttendanceAlerts(testEnv);
    const n = async () => (await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='hr.alert' AND entity='shift_assignment' AND entity_id='9001'`).first<any>()).n;
    expect(await n()).toBe(1);
    await hrAttendanceAlerts(testEnv);
    expect(await n()).toBe(1);
    const row = await db().prepare(`SELECT after_json FROM audit_log WHERE action='hr.alert' AND entity_id='9001'`).first<any>();
    expect(JSON.parse(row.after_json).kind).toBe("late_no_checkin");
  });

  it("đã chấm vào thì không báo; 23:00 còn vào chưa ra → open_in_2300; nhiều thiết bị → multi_device", async () => {
    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    const end = new Date(Date.now() + 3600_000).toISOString();
    await db().prepare(`INSERT INTO shift_assignments(id, employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (9002, 70, '2026-11-23', 2, ?, ?, 0)`).bind(start, end).run();
    await db().prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, method, status, device_id) VALUES (70,'in',?,'gps','accepted','dev-x')`).bind(new Date(Date.now() - 20 * 60_000).toISOString()).run();
    await hrAttendanceAlerts(testEnv);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='hr.alert' AND entity_id='9002'`).first<any>()).n).toBe(0);
    // multi_device: s_a đã chấm bằng dev-s_a và dev-x trong ngày
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='hr.alert' AND json_extract(after_json,'$.kind')='multi_device'`).first<any>()).n).toBeGreaterThanOrEqual(1);
    // 23:30 VN = 16:30 UTC
    const late = new Date(Date.now()); late.setUTCHours(16, 30, 0, 0);
    await db().prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, method, status, device_id) VALUES (73,'in',?,'gps','accepted','dev-y')`).bind(new Date(late.getTime() - 3600_000).toISOString()).run();
    await hrAttendanceAlerts(testEnv, late);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='hr.alert' AND json_extract(after_json,'$.kind')='open_in_2300'`).first<any>()).n).toBeGreaterThanOrEqual(1);
  });
});
