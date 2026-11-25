import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { call, seedStaff } from "./hr-helpers";
import { can, ROLE_PERMS } from "../src/worker/lib/rbac";
import { purgeFormerEmployeePii, runRetention, scrubOldGps } from "../src/worker/services/retention";
import { vnDate } from "../src/worker/lib/time";

// Fix 6b: C-21 (thu hẹp quyền kế toán), C-26 (chứng từ nháp khi nghỉ việc), C-29 (chính sách lưu giữ)
const V = "/api/v1";
const db = () => testEnv.DB;
const iso = (monthsAgo: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - monthsAgo); return d.toISOString(); };
const dateOf = (monthsAgo: number) => iso(monthsAgo).slice(0, 10);

beforeAll(async () => {
  await seedBase();
  for (const [i, n] of ["a", "b", "c"].entries()) await seedStaff({ userId: 800 + i, username: `f6_${n}`, employeeId: 800 + i, role: "cashier" });
});

describe("C-21 kế toán chỉ xem hồ sơ + làm lương", () => {
  it("ma trận quyền: kế toán mất hr.manage, giữ hr.view/hr.sensitive/payroll.write/timesheet.close", () => {
    expect(can("accountant", "hr.manage")).toBe(false);
    for (const p of ["hr.self", "hr.view", "hr.sensitive", "payroll.write", "timesheet.close"] as const) expect(can("accountant", p), p).toBe(true);
    expect(can("accountant", "payroll.approve")).toBe(false);
    expect(can("accountant", "users.manage")).toBe(false);
    expect(can("owner", "hr.manage")).toBe(true);
    for (const r of ["manager", "cashier", "warehouse", "online_staff", "staff"] as const) {
      expect(ROLE_PERMS[r].has("hr.manage"), r).toBe(false);
      expect(ROLE_PERMS[r].has("timesheet.close"), r).toBe(false);
    }
  });

  it("kế toán KHÔNG tạo/sửa hồ sơ, hợp đồng, phụ cấp, nghỉ việc, loại phép, ngày lễ, cửa hàng (403)", async () => {
    const emp = { fullName: "Không được", position: "kho", storeId: 1, hireDate: "2026-02-01", payType: "monthly", baseSalary: 7_000_000 };
    expect((await call("accountant", "POST", `${V}/employees`, emp)).status).toBe(403);
    expect((await call("accountant", "PUT", `${V}/employees/800`, { baseSalary: 99_000_000, version: 1 })).status).toBe(403);
    expect((await call("accountant", "POST", `${V}/employees/800/terminate`, { terminationDate: vnDate(), reason: "x" })).status).toBe(403);
    expect((await call("accountant", "POST", `${V}/employees/800/contracts`, { type: "TV", startDate: "2026-01-01" })).status).toBe(403);
    expect((await call("accountant", "POST", `${V}/employees/800/allowances`, { name: "Ăn", amount: 1000 })).status).toBe(403);
    expect((await call("accountant", "POST", `${V}/leave-types`, { code: "X1", name: "X", paid: true, usesBalance: false })).status).toBe(403);
    expect((await call("accountant", "POST", `${V}/holidays`, { day: "2027-09-02", name: "QK" })).status).toBe(403);
    expect((await call("accountant", "PUT", `${V}/stores/1`, { name: "Đổi tên" })).status).toBe(403);
    expect((await call("accountant", "POST", `/api/v1/users`, { username: "kt_tao", fullName: "x", role: "staff" })).status).toBe(403);
    const row = await db().prepare(`SELECT version FROM employees WHERE id = 800`).first<any>();
    expect(row.version).toBe(1);
  });

  it("kế toán vẫn xem hồ sơ kèm dữ liệu nhạy cảm; làm lương (thưởng/phạt, tạm ứng), chốt công", async () => {
    const d = await call("accountant", "GET", `${V}/employees/800`);
    expect(d.status).toBe(200);
    expect(d.body).toHaveProperty("baseSalary");
    expect((await call("accountant", "GET", `${V}/employees`)).status).toBe(200);
    const bonus = await call("accountant", "POST", `${V}/payroll/entries`, { employeeId: 800, period: "2026-10", kind: "bonus", amount: 100_000, reason: "Thưởng" });
    expect([200, 201]).toContain(bonus.status);
    expect((await call("accountant", "GET", `${V}/payroll/advances`)).status).toBe(200);
    const close = await call("accountant", "POST", `${V}/timesheets/2099-01/close`, {});
    expect(close.status).toBe(409); // qua được phân quyền, bị chặn bởi quy tắc kỳ tương lai
    expect((await call("manager", "POST", `${V}/timesheets/2099-01/close`, {})).status).toBe(403);
  });

  it("chủ vẫn làm được các thao tác hồ sơ", async () => {
    const c = await call("owner", "POST", `${V}/employees`, { fullName: "Chủ tạo", position: "kho", storeId: 1, hireDate: "2026-02-01", payType: "monthly", baseSalary: 7_000_000 });
    expect(c.status).toBe(201);
    expect((await call("owner", "POST", `${V}/holidays`, { day: "2027-09-02", name: "QK" })).status).toBeLessThan(300);
  });
});

describe("C-26 chứng từ nháp của người nghỉ việc / bị khoá", () => {
  it("nghỉ việc: còn báo giá/phiếu kho nháp → 409 pending_requests (kèm chi tiết); force mới đi tiếp", async () => {
    await db().batch([
      db().prepare(`INSERT INTO stock_docs(code, type, status, store_id, created_by) VALUES ('F6-PN-1','receipt','draft',1,801)`),
      db().prepare(`INSERT INTO stock_docs(code, type, status, store_id, created_by) VALUES ('F6-PN-2','waste','pending_approval',1,801)`),
    ]);
    const t = { terminationDate: vnDate(), reason: "Xin nghỉ" };
    const a = await call("owner", "POST", `${V}/employees/801/terminate`, t);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe("pending_requests");
    expect(a.body.error.details.draftStockDocs).toBe(2);
    const b = await call("owner", "POST", `${V}/employees/801/terminate`, { ...t, force: true });
    expect(b.status).toBe(200);
    const au = await db().prepare(`SELECT after_json FROM audit_log WHERE action='hr.employee.terminate' AND entity_id='801'`).first<any>();
    expect(au.after_json).toContain("draftStockDocs");
  });

  it("khoá tài khoản (admin): còn đơn nháp → 409; force + khoá được", async () => {
    await db().prepare(`INSERT INTO orders(code, channel, store_id, status, created_by) VALUES ('F6-DH-1','pos',1,'draft',802)`).run();
    const a = await call("owner", "PUT", `/api/v1/users/802`, { active: false });
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe("pending_requests");
    expect(a.body.error.details.draftOrders).toBe(1);
    const b = await call("owner", "PUT", `/api/v1/users/802`, { active: false, force: true });
    expect(b.status).toBe(200);
  });
});

describe("C-29 chính sách lưu giữ", () => {
  const punch = (emp: number, at: string, lat: number | null) =>
    db().prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, method, lat, lng, accuracy_m, distance_m, effective_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(emp, "in", at, "gps", lat, lat == null ? null : 106.7, lat == null ? null : 12, 30, at);

  it("tham số mới có trong Cài đặt: GPS 12 tháng, PII 24 tháng, audit 10 năm, sao lưu 90 ngày", async () => {
    const get = async (k: string) => (await db().prepare(`SELECT value FROM settings WHERE key=?`).bind(k).first<any>())?.value;
    expect(await get("retention.gps_months")).toBe("12");
    expect(await get("retention.employee_pii_months")).toBe("24");
    expect(await get("retention.audit_years")).toBe("10");
    expect(await get("backup.retention_days")).toBe("90");
  });

  it("xoá GPS bản ghi > 12 tháng: chỉ lat/lng/accuracy_m, cột khác giữ nguyên, bản ghi mới không đụng; audit tổng hợp; chạy lại = 0", async () => {
    const oldAt = iso(13), midAt = iso(8), newAt = iso(1);
    await db().batch([punch(800, oldAt, 10.77), punch(800, midAt, 10.78), punch(800, newAt, 10.79)]);
    const n = await scrubOldGps(testEnv);
    expect(n).toBe(1);
    const rows = (await db().prepare(`SELECT server_at, lat, lng, accuracy_m, distance_m, method, kind, status FROM attendance_punches WHERE employee_id=800 ORDER BY server_at`).all<any>()).results;
    expect(rows[0]).toMatchObject({ server_at: oldAt, lat: null, lng: null, accuracy_m: null, distance_m: 30, method: "gps", kind: "in", status: "accepted" });
    expect(rows[1].lat).toBe(10.78); // 8 tháng: còn trong hạn
    expect(rows[2].lat).toBe(10.79);
    const au = await db().prepare(`SELECT after_json, user_id FROM audit_log WHERE action='retention.gps_scrub'`).first<any>();
    expect(JSON.parse(au.after_json)).toMatchObject({ rows: 1, olderThanMonths: 12 });
    expect(await scrubOldGps(testEnv)).toBe(0);
  });

  it("trigger vẫn bất biến: không sửa toạ độ bản ghi mới, không đổi giá trị khác NULL, không đổi giờ/loại, không xoá", async () => {
    const mid = await db().prepare(`SELECT id FROM attendance_punches WHERE employee_id=800 AND lat IS NOT NULL ORDER BY server_at LIMIT 1`).first<any>();
    // bản ghi 8 tháng (< 6 tháng chưa tới? 8 > 6): vẫn không được đổi sang giá trị khác NULL
    await expect(db().prepare(`UPDATE attendance_punches SET lat = 1 WHERE id=?`).bind(mid.id).run()).rejects.toThrow(/attendance_immutable/);
    await expect(db().prepare(`UPDATE attendance_punches SET lat = NULL WHERE id=?`).bind(mid.id).run()).rejects.toThrow(/attendance_immutable/); // thiếu lng/accuracy
    await expect(db().prepare(`UPDATE attendance_punches SET server_at = '2020-01-01T00:00:00.000Z' WHERE id=?`).bind(mid.id).run()).rejects.toThrow(/attendance_immutable/);
    await expect(db().prepare(`UPDATE attendance_punches SET kind='out' WHERE id=?`).bind(mid.id).run()).rejects.toThrow(/attendance_immutable/);
    await expect(db().prepare(`DELETE FROM attendance_punches WHERE id=?`).bind(mid.id).run()).rejects.toThrow(/attendance_immutable/);
    // bản ghi gần đây (< 6 tháng): không xoá được toạ độ dù đặt NULL cả ba
    const recent = await db().prepare(`SELECT id FROM attendance_punches WHERE employee_id=800 AND server_at > ? LIMIT 1`).bind(iso(2)).first<any>();
    await expect(db().prepare(`UPDATE attendance_punches SET lat=NULL, lng=NULL, accuracy_m=NULL WHERE id=?`).bind(recent.id).run()).rejects.toThrow(/attendance_immutable/);
    // duyệt/từ chối vẫn được
    await db().prepare(`UPDATE attendance_punches SET status='rejected', decided_at=? WHERE id=?`).bind(new Date().toISOString(), recent.id).run();
  });

  it("ép tham số GPS nhỏ hơn 6 tháng vẫn không vượt sàn của trigger", async () => {
    await db().prepare(`UPDATE settings SET value='1' WHERE key='retention.gps_months'`).run();
    await db().prepare(`INSERT INTO attendance_punches(employee_id, kind, server_at, method, lat, lng, accuracy_m, effective_at) VALUES (801,'in',?,'gps',10.1,106.1,9,?)`).bind(iso(3), iso(3)).run();
    expect(await scrubOldGps(testEnv)).toBe(1); // chỉ bản ghi 8 tháng (mid), không phải bản 3 tháng
    expect((await db().prepare(`SELECT lat FROM attendance_punches WHERE employee_id=801`).first<any>()).lat).toBe(10.1);
    await db().prepare(`UPDATE settings SET value='12' WHERE key='retention.gps_months'`).run();
  });

  it("nhân viên nghỉ > 24 tháng: che CCCD/ngân hàng/địa chỉ…, giữ họ tên/mã/lương; nghỉ chưa tới hạn và đang làm không bị che", async () => {
    await db().batch([
      db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, status, termination_date, base_salary, id_number, bank_name, bank_account, address, phone, email, dob) VALUES (850,'NV-F6A','Cũ Lâu','kho',1,'2020-01-01','terminated',?,9000000,'079123','VCB','0011','Q1','0901','a@b.vn','1990-01-01')`).bind(dateOf(25)),
      db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, status, termination_date, base_salary, id_number, bank_account) VALUES (851,'NV-F6B','Mới Nghỉ','kho',1,'2020-01-01','terminated',?,9000000,'079124','0022')`).bind(dateOf(10)),
      db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, status, id_number) VALUES (852,'NV-F6C','Đang Làm','kho',1,'2020-01-01','active','079125')`),
    ]);
    expect(await purgeFormerEmployeePii(testEnv)).toBe(1);
    const get = (id: number) => db().prepare(`SELECT * FROM employees WHERE id=?`).bind(id).first<any>();
    const a = await get(850);
    expect(a).toMatchObject({ full_name: "Cũ Lâu", code: "NV-F6A", base_salary: 9_000_000, id_number: null, bank_name: null, bank_account: null, address: null, phone: null, email: null, dob: null });
    expect(a.pii_purged_at).toBeTruthy();
    expect((await get(851)).id_number).toBe("079124");
    expect((await get(852)).id_number).toBe("079125");
    const au = await db().prepare(`SELECT after_json FROM audit_log WHERE action='retention.employee_pii_purge'`).first<any>();
    expect(JSON.parse(au.after_json)).toMatchObject({ rows: 1, terminatedOverMonths: 24 });
    expect(await purgeFormerEmployeePii(testEnv)).toBe(0);
  });

  it("runRetention gộp hai bước và cron hằng ngày không lỗi", async () => {
    const r = await runRetention(testEnv);
    expect(r).toEqual({ gpsScrubbed: 0, employeesPurged: 0 });
  });
});
