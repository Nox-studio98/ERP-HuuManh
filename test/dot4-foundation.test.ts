import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

const db = () => testEnv.DB;

beforeAll(async () => {
  await seedBase();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date) VALUES (1,'NV-T1','NV Test','thu ngân',1,'2026-01-01')`),
    d.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (7700,'D4','Dot4 product','kg')`),
    d.prepare(`INSERT INTO customers(id, code, name, points) VALUES (7700,'KH-D4','Khách D4',10)`),
  ]);
});

describe("Đợt 4 nền tảng", () => {
  it("users table rebuilt: foreign keys intact and new 'staff' role allowed", async () => {
    const fk = await db().prepare(`PRAGMA foreign_key_check`).all();
    expect(fk.results).toEqual([]);
    await db().prepare(`INSERT INTO users(username, full_name, pass_hash, role, store_id) VALUES ('nv_staff','NV','x','staff',1)`).run();
    await expect(db().prepare(`INSERT INTO users(username, full_name, pass_hash, role) VALUES ('bad','B','x','hacker')`).run()).rejects.toThrow();
    // khoá ngoại vẫn hoạt động sau khi đổi tên bảng
    await expect(db().prepare(`INSERT INTO sessions(id, user_id, expires_at) VALUES ('s-x', 999999, '2099-01-01')`).run()).rejects.toThrow();
  });

  it("staff role only has hr.self", async () => {
    const { ROLE_PERMS } = await import("../src/worker/lib/rbac");
    expect([...ROLE_PERMS.staff]).toEqual(["hr.self"]);
    expect(ROLE_PERMS.manager.has("hr.sensitive")).toBe(false);
    expect(ROLE_PERMS.accountant.has("payroll.approve")).toBe(false);
    expect(ROLE_PERMS.owner.has("payroll.approve")).toBe(true);
    const r = await api("cashier", "GET", "/api/auth/me");
    expect(r.body.permissions).toContain("hr.self");
  });

  it("attendance punches are immutable except approval status", async () => {
    const d = db();
    await d.prepare(`INSERT INTO attendance_punches(id, employee_id, kind, server_at, method, status) VALUES (1,1,'in','2026-11-24T01:00:00Z','offline','pending')`).run();
    await d.prepare(`UPDATE attendance_punches SET status='accepted' WHERE id=1`).run();
    await expect(d.prepare(`UPDATE attendance_punches SET server_at='2026-11-24T00:00:00Z' WHERE id=1`).run()).rejects.toThrow(/attendance_immutable/);
    await expect(d.prepare(`DELETE FROM attendance_punches WHERE id=1`).run()).rejects.toThrow(/attendance_immutable/);
  });

  it("closed timesheet days cannot be edited", async () => {
    const d = db();
    await d.batch([
      d.prepare(`INSERT INTO timesheets(period, status) VALUES ('2026-10','open')`),
      d.prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes) VALUES ('2026-10',1,'2026-10-01',480)`),
      d.prepare(`UPDATE timesheets SET status='closed' WHERE period='2026-10'`),
    ]);
    await expect(d.prepare(`UPDATE timesheet_days SET worked_minutes=600 WHERE period='2026-10'`).run()).rejects.toThrow(/timesheet_closed/);
  });

  it("loyalty points cannot go negative and voucher cannot exceed max uses", async () => {
    const d = db();
    await expect(d.prepare(`UPDATE customers SET points = points - 11 WHERE id=7700`).run()).rejects.toThrow(/points_insufficient/);
    await d.batch([
      d.prepare(`INSERT INTO promotions(id, code, name, kind, value_bp, starts_at, ends_at, created_by) VALUES (1,'KM-T','Test','percent',1000,'2026-01-01','2027-01-01',1)`),
      d.prepare(`INSERT INTO vouchers(id, code, promotion_id, max_uses, used_count) VALUES (1,'ABC',1,1,1)`),
    ]);
    await expect(d.prepare(`UPDATE vouchers SET used_count = used_count + 1 WHERE id=1`).run()).rejects.toThrow(/CHECK/);
  });
});
