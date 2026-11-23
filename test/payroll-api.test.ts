import { beforeAll, describe, expect, it } from "vitest";
import { api, login, PASSWORD, seedBase, testEnv } from "./helpers";
import { app } from "../src/worker/index";
import { hashPassword } from "../src/worker/lib/crypto";
import { vnPeriod } from "../src/worker/lib/time";

const db = () => testEnv.DB;

async function closeTimesheet(period: string, rows: [number, string, number, number][]) {
  // rows: [employeeId, workDate, workedMinutes, shifts]
  await db().batch([
    db().prepare(`INSERT INTO timesheets(period, status) VALUES (?, 'open')`).bind(period),
    ...rows.map(([e, d, m, s]) =>
      db().prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes, shifts_worked) VALUES (?,?,?,?,?)`).bind(period, e, d, m, s),
    ),
    db().prepare(`UPDATE timesheets SET status='closed' WHERE period = ?`).bind(period),
  ]);
}
const dayRows = (emp: number, period: string, n: number, minutes = 480): [number, string, number, number][] =>
  Array.from({ length: n }, (_, i) => [emp, `${period}-${String(i + 1).padStart(2, "0")}`, minutes, 1]);

beforeAll(async () => {
  await seedBase();
  const hash = await hashPassword(PASSWORD);
  await db().batch([
    db().prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id) VALUES (8801,'nv_a','NV A',?,'staff',1),(8802,'nv_b','NV B',?,'staff',1)`).bind(hash, hash),
    db().prepare(
      `INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date, pay_type, base_salary, hourly_rate, shift_rate, insurance_salary) VALUES
        (8801,'NV-A',8801,'NV A','thu ngân',1,'2026-01-01','monthly',10400000,0,0,10000000),
        (8802,'NV-H',NULL,'NV H','giao hàng',1,'2026-01-01','hourly',0,30000,0,0),
        (8803,'NV-S',8802,'NV S','thu ngân',1,'2026-01-01','shift',0,0,200000,0),
        (8804,'NV-LATE',NULL,'NV Late','thu ngân',1,'2026-10-05','monthly',9000000,0,0,0)`),
    db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, termination_date, status, pay_type, base_salary) VALUES (8805,'NV-OLD','NV Old','kho',1,'2025-01-01','2026-08-15','terminated','monthly',9000000)`),
    db().prepare(`INSERT INTO employee_allowances(employee_id, name, amount, taxable) VALUES (8801,'Ăn trưa',500000,0)`),
    db().prepare(`INSERT INTO timesheets(period, status) VALUES ('2026-08','open')`),
  ]);
});

describe("payroll API", () => {
  it("calculate blocked while timesheet is open or missing", async () => {
    const r = await api("accountant", "POST", "/api/v1/payroll/periods/2026-08/calculate");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("timesheet_open");
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/2026-07/calculate")).status).toBe(409);
    expect((await api("manager", "POST", "/api/v1/payroll/periods/2026-09/calculate")).status).toBe(403);
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/9999/calculate")).status).toBe(422);
  });

  it("calculates a closed period with entries, advance and previous-period adjustment", async () => {
    await closeTimesheet("2026-09", [...dayRows(8801, "2026-09", 26), ...dayRows(8802, "2026-09", 10), ...dayRows(8803, "2026-09", 5, 300)]);
    await db().prepare(`INSERT INTO timesheet_adjustments(employee_id, source_period, target_period, minutes, kind, reason, created_by) VALUES (8802,'2026-08','2026-09',60,'work','Bù công',1)`).run();
    const bonus = await api("accountant", "POST", "/api/v1/payroll/entries", { employeeId: 8801, period: "2026-09", kind: "bonus", amount: 400000, reason: "Chuyên cần" });
    expect(bonus.status).toBe(201);
    expect((await api("cashier", "POST", "/api/v1/payroll/entries", { employeeId: 8801, period: "2026-09", kind: "bonus", amount: 1, reason: "x" })).status).toBe(403);
    const adv = await api("accountant", "POST", "/api/v1/payroll/advances", { employeeId: 8801, amount: 1000000, fundId: 1, reason: "Việc gia đình", deductPeriod: "2026-09" });
    expect(adv.status).toBe(201);
    expect(adv.body.deductPeriod).toBe("2026-09");
    const v = await db().prepare(`SELECT * FROM cash_vouchers WHERE code = ?`).bind(adv.body.voucherCode).first<any>();
    expect(v).toMatchObject({ direction: "out", amount: 1000000, counterparty: "NV-A", status: "posted" });

    const calc = await api("accountant", "POST", "/api/v1/payroll/periods/2026-09/calculate");
    expect(calc.status).toBe(200);
    expect(calc.body.employees).toBe(3); // loại NV vào sau kỳ và NV đã nghỉ trước kỳ

    const d = await api("accountant", "GET", "/api/v1/payroll/periods/2026-09");
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("calculated");
    const by = Object.fromEntries(d.body.items.map((i: any) => [i.code, i]));
    // NV-A: 10.400.000 + PC 500.000 (không chịu thuế) + thưởng 400.000 = 11.300.000; BH 10tr×10,5% = 1.050.000; PIT 0; tạm ứng 1.000.000
    expect(by["NV-A"]).toMatchObject({ basePay: 10_400_000, allowances: 500_000, bonus: 400_000, gross: 11_300_000, insuranceEmployee: 1_050_000, insuranceEmployer: 2_150_000, pit: 0, advances: 1_000_000, net: 9_250_000 });
    // NV-H: (10×480 + 60 phút điều chỉnh)/60 × 30.000 = 81 giờ × 30.000 = 2.430.000
    expect(by["NV-H"]).toMatchObject({ basePay: 2_430_000, net: 2_430_000 });
    // NV-S: 5 ca × 200.000
    expect(by["NV-S"]).toMatchObject({ basePay: 1_000_000, shifts: 5, net: 1_000_000 });
    expect(by["NV-A"].lines.length).toBeGreaterThan(3);
    expect(d.body.totals).toMatchObject({ gross: 11_300_000 + 2_430_000 + 1_000_000, net: 9_250_000 + 2_430_000 + 1_000_000, insuranceEmployer: 2_150_000 });
    expect(d.body.totals.cost).toBe(d.body.totals.gross + 2_150_000);

    // tính lại (draft/calculated) được và không nhân đôi dòng
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/2026-09/calculate")).status).toBe(200);
    expect((await api("accountant", "GET", "/api/v1/payroll/periods/2026-09")).body.items).toHaveLength(3);
  });

  it("access control: only hr.sensitive reads; payslip hidden until approved", async () => {
    expect((await api("cashier", "GET", "/api/v1/payroll/periods")).status).toBe(403);
    expect((await api("nv_b", "GET", "/api/v1/payroll/periods")).status).toBe(403);
    expect((await api("manager", "GET", "/api/v1/payroll/periods/2026-09")).status).toBe(403);
    expect((await api("nv_a", "GET", "/api/v1/payroll/periods")).status).toBe(403);
    const list = await api("nv_a", "GET", "/api/v1/me/payslips");
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
    expect((await api("nv_a", "GET", "/api/v1/me/payslips/2026-09")).status).toBe(404);
    const p = await api("accountant", "GET", "/api/v1/payroll/periods");
    expect(p.body.items[0]).toMatchObject({ period: "2026-09", status: "calculated", employeeCount: 3 });
  });

  it("approve is owner only; locked afterwards", async () => {
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/2026-09/approve")).status).toBe(403);
    expect((await api("owner", "POST", "/api/v1/payroll/periods/2026-09/approve")).status).toBe(200);
    expect((await api("owner", "POST", "/api/v1/payroll/periods/2026-09/approve")).status).toBe(409);
    const re = await api("accountant", "POST", "/api/v1/payroll/periods/2026-09/calculate");
    expect(re.status).toBe(409);
    expect(re.body.error.code).toBe("payroll_locked");
    const en = await api("accountant", "POST", "/api/v1/payroll/entries", { employeeId: 8801, period: "2026-09", kind: "bonus", amount: 1, reason: "x" });
    expect(en.status).toBe(409);
    // DB trigger cũng chặn sửa trực tiếp
    await expect(db().prepare(`UPDATE payroll_items SET net = 1`).run()).rejects.toThrow(/payroll_locked/);
  });

  it("employees see only their own approved payslip", async () => {
    const a = await api("nv_a", "GET", "/api/v1/me/payslips/2026-09");
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ period: "2026-09", net: 9_250_000, employee: { code: "NV-A" } });
    expect(a.body.lines.some((l: any) => l.label === "Khấu trừ tạm ứng")).toBe(true);
    const b = await api("nv_b", "GET", "/api/v1/me/payslips/2026-09");
    expect(b.body.net).toBe(1_000_000);
    expect(b.body.employee.code).toBe("NV-S");
    expect((await api("nv_b", "GET", "/api/v1/me/payslips")).body.items).toHaveLength(1);
    expect((await api("nv_b", "GET", "/api/v1/me/payslips/2026-08")).status).toBe(404);
    expect((await api("cashier", "GET", "/api/v1/me/payslips/2026-09")).status).toBe(404); // không có hồ sơ NV
  });

  it("pay creates one voucher per employee (net>0) and marks advances deducted", async () => {
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/2026-09/pay", { fundId: 999 })).status).toBe(422);
    const r = await api("accountant", "POST", "/api/v1/payroll/periods/2026-09/pay", { fundId: 1 });
    expect(r.status).toBe(200);
    expect(r.body.vouchers).toHaveLength(3);
    const { results } = await db().prepare(`SELECT v.*, c.code AS cat FROM cash_vouchers v JOIN cash_categories c ON c.id = v.category_id WHERE v.ref_type='payroll_item' ORDER BY v.counterparty`).all<any>();
    expect(results.map((x) => [x.counterparty, x.amount, x.cat, x.direction, x.fund_id])).toEqual([
      ["NV-A", 9_250_000, "LUONG", "out", 1], ["NV-H", 2_430_000, "LUONG", "out", 1], ["NV-S", 1_000_000, "LUONG", "out", 1],
    ]);
    expect((await db().prepare(`SELECT status FROM salary_advances WHERE employee_id = 8801`).first<any>()).status).toBe("deducted");
    expect((await db().prepare(`SELECT status FROM payroll_periods WHERE period='2026-09'`).first<any>()).status).toBe("paid");
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/2026-09/pay", { fundId: 1 })).status).toBe(409);
    expect((await api("nv_a", "GET", "/api/v1/me/payslips/2026-09")).body.status).toBe("paid");
  });

  it("advances list/create validation and default deduct period", async () => {
    expect((await api("cashier", "POST", "/api/v1/payroll/advances", { employeeId: 8801, amount: 1, fundId: 1 })).status).toBe(403);
    expect((await api("accountant", "POST", "/api/v1/payroll/advances", { employeeId: 8805, amount: 100000, fundId: 1 })).status).toBe(422);
    expect((await api("accountant", "POST", "/api/v1/payroll/advances", { employeeId: 8801, amount: 100000, fundId: 1, deductPeriod: "2026-09" })).status).toBe(409);
    const r = await api("accountant", "POST", "/api/v1/payroll/advances", { employeeId: 8803, amount: 300000, fundId: 1 });
    expect(r.status).toBe(201);
    expect(r.body.deductPeriod >= vnPeriod()).toBe(true);
    const l = await api("accountant", "GET", "/api/v1/payroll/advances");
    expect(l.body.items.length).toBe(2);
  });

  it("sales bonus (sales minus returns) and locked M6 period → 423 on pay", async () => {
    await closeTimesheet("2026-10", dayRows(8801, "2026-10", 26));
    await db().batch([
      db().prepare(`UPDATE settings SET value='1000' WHERE key='hr.sales_bonus_bp'`),
      db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, created_by, completed_at) VALUES (88001,'HD-S1','pos','sale',1,'completed',5000000,8801,'2026-10-10T03:00:00Z')`),
      db().prepare(`INSERT INTO orders(id, code, channel, kind, original_order_id, store_id, status, total, created_by, completed_at) VALUES (88002,'TH-S1','pos','return',88001,1,'completed',1000000,1,'2026-10-12T03:00:00Z')`),
      db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, created_by, completed_at) VALUES (88003,'HD-OUT','pos','sale',1,'completed',9000000,8801,'2026-11-01T03:00:00Z')`),
      db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, created_by, completed_at) VALUES (88004,'HD-CANCEL','pos','sale',1,'cancelled',9000000,8801,'2026-10-11T03:00:00Z')`),
    ]);
    expect((await api("accountant", "POST", "/api/v1/payroll/periods/2026-10/calculate")).status).toBe(200);
    const d = await api("accountant", "GET", "/api/v1/payroll/periods/2026-10");
    const a = d.body.items.find((i: any) => i.code === "NV-A");
    expect(a.salesBonus).toBe(400_000); // (5.000.000 − 1.000.000) × 10%
    expect(d.body.items).toHaveLength(4); // NV-LATE vào ngày 05/10 → có trong kỳ
    await db().prepare(`UPDATE settings SET value='0' WHERE key='hr.sales_bonus_bp'`).run();
    expect((await api("owner", "POST", "/api/v1/payroll/periods/2026-10/approve")).status).toBe(200);
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, '2026-11-30T00:00:00Z', 1)`).bind(vnPeriod()).run();
    const pay = await api("accountant", "POST", "/api/v1/payroll/periods/2026-10/pay", { fundId: 1 });
    expect(pay.status).toBe(423);
    expect((await db().prepare(`SELECT status FROM payroll_periods WHERE period='2026-10'`).first<any>()).status).toBe("approved");
    expect((await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers WHERE note='Lương kỳ 2026-10'`).first<any>()).n).toBe(0);
  });

  it("cost report by month and position, XLSX export, audit trail", async () => {
    const r = await api("accountant", "GET", "/api/v1/payroll/reports/cost?from=2026-09&to=2026-10");
    expect(r.status).toBe(200);
    expect(r.body.byMonth.map((m: any) => m.period)).toEqual(["2026-09", "2026-10"]);
    const sep = r.body.byMonth[0];
    expect(sep).toMatchObject({ gross: 14_730_000, insuranceEmployer: 2_150_000, cost: 16_880_000 });
    const pos = Object.fromEntries(r.body.byPosition.map((p: any) => [p.position, p]));
    expect(pos["giao hàng"].gross).toBe(2_430_000);
    expect((await api("manager", "GET", "/api/v1/payroll/reports/cost")).status).toBe(403);

    const token = await login("accountant");
    const x = await app.request("/api/v1/payroll/periods/2026-09/export.xlsx", { headers: { authorization: `Bearer ${token}` } }, testEnv);
    expect(x.status).toBe(200);
    expect(x.headers.get("content-type")).toContain("spreadsheetml");
    const bytes = new Uint8Array(await x.arrayBuffer());
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");
    const cashier = await login("cashier");
    expect((await app.request("/api/v1/payroll/periods/2026-09/export.xlsx", { headers: { authorization: `Bearer ${cashier}` } }, testEnv)).status).toBe(403);

    const views = await db().prepare(`SELECT action, user_id FROM audit_log WHERE action='payroll.view'`).all<any>();
    expect(views.results.length).toBeGreaterThanOrEqual(5);
    expect(views.results.every((v) => v.user_id !== 8801 && v.user_id !== 8802)).toBe(true); // xem của chính mình không ghi
    for (const a of ["payroll.calculate", "payroll.approve", "payroll.pay", "payroll.advance"]) {
      expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = ?`).bind(a).first<any>()).n).toBeGreaterThan(0);
    }
  });
});

describe("route order", () => {
  it("/exports/bang-luong.xlsx is reachable (not swallowed by /exports/:file)", async () => {
    const { api } = await import("./helpers");
    const r = await api("owner", "GET", "/api/v1/exports/bang-luong.xlsx?period=2020-01");
    // 404 hợp lệ chỉ khi do payroll trả về (kỳ không tồn tại), không phải "Không tìm thấy" của exports
    expect(r.body?.error?.code).not.toBe("export_not_found");
    expect(r.body?.error?.code ?? "ok").not.toBe("not_found");
  });
});
