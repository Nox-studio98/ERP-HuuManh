import { beforeAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { app } from "../src/worker/index";
import { api, login, seedBase, testEnv } from "./helpers";
import { calculatePayslip, DEFAULT_PAYROLL_SETTINGS, type PayslipInput } from "../src/worker/services/payroll-calc";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const V = "/api/v1";

async function closeTimesheet(period: string, rows: [number, string, number, number][]) {
  await db().batch([
    db().prepare(`INSERT INTO timesheets(period, status) VALUES (?, 'open')`).bind(period),
    ...rows.map(([e, d, m, s]) => db().prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes, shifts_worked) VALUES (?,?,?,?,?)`).bind(period, e, d, m, s)),
    db().prepare(`UPDATE timesheets SET status='closed' WHERE period = ?`).bind(period),
  ]);
}
const dayRows = (emp: number, period: string, n: number): [number, string, number, number][] => Array.from({ length: n }, (_, i) => [emp, `${period}-${String(i + 1).padStart(2, "0")}`, 480, 1]);

const base = (over: Partial<PayslipInput["employee"]>, days: PayslipInput["days"], more: Partial<PayslipInput> = {}): PayslipInput => ({
  employee: { payType: "hourly", baseSalary: 0, hourlyRate: 30000, shiftRate: 0, insuranceSalary: 0, dependents: 0, pitEnabled: false, ...over },
  days, adjustMinutes: { work: 0, overtime: 0 }, allowances: [], entries: [], advances: [], salesRevenue: 0, ...more,
});
const day = (workedMinutes: number, overtimeMinutes = 0, bp = 15000) => ({ workDate: "2026-10-01", workedMinutes, overtimeMinutes, overtimeMultiplierBp: bp, shiftsWorked: 1, leavePaidX10: 0, holiday: false });

describe("C-03 lương giờ không trả hai lần giờ tăng ca", () => {
  it("ở 10h, OT duyệt 2h ×1,5, 30.000/giờ → 8×30k + 2×30k×1,5 = 330.000", () => {
    const p = calculatePayslip(base({}, [day(600, 120)]), DEFAULT_PAYROLL_SETTINGS);
    expect(p.basePay).toBe(240_000);
    expect(p.overtimePay).toBe(90_000);
    expect(p.gross).toBe(330_000);
  });
  it("OT lớn hơn giờ làm thì lương giờ thường không âm; ca và tháng không đổi", () => {
    expect(calculatePayslip(base({}, [day(60, 120)]), DEFAULT_PAYROLL_SETTINGS).basePay).toBe(0);
    expect(calculatePayslip(base({ payType: "shift", shiftRate: 200_000 }, [day(600, 120)]), DEFAULT_PAYROLL_SETTINGS).basePay).toBe(200_000);
  });
  it("giờ không OT vẫn trả đủ; phút điều chỉnh công cộng vào giờ thường", () => {
    const p = calculatePayslip(base({}, [day(480)], { adjustMinutes: { work: 60, overtime: 0 } }), DEFAULT_PAYROLL_SETTINGS);
    expect(p.basePay).toBe(9 * 30_000);
  });
  it("miễn thuế phần OT chỉ là phần chênh (hệ số − 1) vẫn đúng", () => {
    const p = calculatePayslip(base({ pitEnabled: true }, [day(600, 120)]), DEFAULT_PAYROLL_SETTINGS);
    expect(p.overtimePay).toBe(90_000);
    expect(p.taxableIncome).toBe(0);
  });
});

describe("C-05 khấu trừ tạm ứng không làm thực lĩnh âm", () => {
  it("net ≥ 0, phần dư chuyển kỳ sau (hàm thuần)", () => {
    const p = calculatePayslip(base({ payType: "monthly", baseSalary: 2_600_000 }, Array.from({ length: 26 }, (_, i) => ({ ...day(480), workDate: `2026-10-${String(i + 1).padStart(2, "0")}` })), { advances: [{ amount: 3_000_000 }] }), DEFAULT_PAYROLL_SETTINGS);
    expect(p.gross).toBe(2_600_000);
    expect(p.advances).toBe(2_600_000);
    expect(p.advancesCarried).toBe(400_000);
    expect(p.net).toBe(0);
    expect(p.lines.some((l) => l.label === "Tạm ứng chuyển kỳ sau" && l.amount === 400_000)).toBe(true);
  });
});

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, pay_type, base_salary, insurance_salary) VALUES
      (9501,'NV-F1','F Một','bán hàng',1,'2026-01-01','monthly',2600000,0),
      (9502,'NV-F2','F Hai','bán hàng',1,'2026-01-01','monthly',5200000,0)`),
  ]);
});

describe("C-04 duyệt lương phải kiểm đầu vào không đổi", () => {
  it("thêm phạt khi kỳ đang 'calculated' → duyệt 409 payroll_stale; tính lại rồi duyệt, phiếu lương có khoản phạt", async () => {
    await closeTimesheet("2026-08", [...dayRows(9501, "2026-08", 26), ...dayRows(9502, "2026-08", 26)]);
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-08/calculate`)).status).toBe(200);
    let d = await api("accountant", "GET", `${V}/payroll/periods/2026-08`);
    expect(d.body.stale).toBe(false);
    const en = await api("accountant", "POST", `${V}/payroll/entries`, { employeeId: 9501, period: "2026-08", kind: "penalty", amount: 50_000, reason: "đi trễ" });
    expect(en.status).toBe(201);
    expect(en.body.requiresRecalculation).toBe(true);
    d = await api("accountant", "GET", `${V}/payroll/periods/2026-08`);
    expect(d.body.stale).toBe(true);
    const ap = await api("owner", "POST", `${V}/payroll/periods/2026-08/approve`);
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe("payroll_stale");
    expect((await db().prepare(`SELECT status FROM payroll_periods WHERE period='2026-08'`).first<any>()).status).toBe("calculated");
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-08/calculate`)).status).toBe(200);
    // đổi lương NV sau khi tính cũng làm kỳ cũ
    await db().prepare(`UPDATE employees SET base_salary = 5300000 WHERE id = 9502`).run();
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-08/approve`)).body.error.code).toBe("payroll_stale");
    await db().prepare(`UPDATE employees SET base_salary = 5200000 WHERE id = 9502`).run();
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-08/approve`)).status).toBe(200);
    const slip = (await api("accountant", "GET", `${V}/payroll/periods/2026-08`)).body.items.find((i: any) => i.code === "NV-F1");
    expect(slip.penalties).toBe(50_000);
    // sau khi duyệt: khoản mới phải ghi vào kỳ sau
    expect((await api("accountant", "POST", `${V}/payroll/entries`, { employeeId: 9501, period: "2026-08", kind: "bonus", amount: 1, reason: "x" })).body.error.code).toBe("payroll_locked");
    expect((await api("accountant", "POST", `${V}/payroll/entries`, { employeeId: 9501, period: "2026-09", kind: "adjustment", amount: -50_000, reason: "bù", sourcePeriod: "2026-08" })).status).toBe(201);
  });
});

describe("C-05 tạm ứng vượt lương → chuyển kỳ sau, không mất", () => {
  it("chi lương: net = 0, khoản tạm ứng tách dòng, phần dư thu ở kỳ kế tiếp; mỗi khoản chỉ trừ một lần", async () => {
    await db().prepare(`UPDATE employees SET status='terminated', termination_date='2026-08-31' WHERE id IN (9501, 9502)`).run();
    await db().batch([
      db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, pay_type, base_salary, insurance_salary) VALUES (9511,'NV-C1','C Một','kho',1,'2026-01-01','monthly',2600000,0)`),
    ]);
    await db().prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('hr.advance_max_bp','0')`).run(); // C-12 có test riêng ở fix5d-hr
    const adv = await api("accountant", "POST", `${V}/payroll/advances`, { employeeId: 9511, amount: 4_000_000, fundId: 1, deductPeriod: "2026-10", reason: "việc nhà" });
    expect(adv.status).toBe(201);
    await closeTimesheet("2026-10", dayRows(9511, "2026-10", 26));
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-10/calculate`)).status).toBe(200);
    const d = await api("accountant", "GET", `${V}/payroll/periods/2026-10`);
    const it = d.body.items.find((i: any) => i.code === "NV-C1");
    expect(it).toMatchObject({ gross: 2_600_000, advances: 2_600_000, advancesCarried: 1_400_000, net: 0 });
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-10/approve`)).status).toBe(200);
    const pay = await api("accountant", "POST", `${V}/payroll/periods/2026-10/pay`, { fundId: 1 });
    expect(pay.status).toBe(200);
    expect(pay.body.vouchers.find((v: any) => v.employee === "NV-C1")).toBeUndefined();
    expect(pay.body).toMatchObject({ advancesCarried: 1_400_000, carriedTo: "2026-11" });
    const rows = (await db().prepare(`SELECT amount, status, deduct_period, carried_from_id FROM salary_advances WHERE employee_id=9511 ORDER BY id`).all<any>()).results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount: 2_600_000, status: "deducted", deduct_period: "2026-10", carried_from_id: null });
    expect(rows[1]).toMatchObject({ amount: 1_400_000, status: "paid", deduct_period: "2026-11" });
    expect(rows[1].carried_from_id).not.toBeNull();
    // kỳ sau: khấu trừ nốt phần dư
    await closeTimesheet("2026-11", dayRows(9511, "2026-11", 26));
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-11/calculate`)).status).toBe(200);
    const it2 = (await api("accountant", "GET", `${V}/payroll/periods/2026-11`)).body.items.find((i: any) => i.code === "NV-C1");
    expect(it2).toMatchObject({ advances: 1_400_000, advancesCarried: 0, net: 1_200_000 });
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-11/approve`)).status).toBe(200);
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-11/pay`, { fundId: 1 })).status).toBe(200);
    const fin = (await db().prepare(`SELECT status FROM salary_advances WHERE employee_id=9511 ORDER BY id`).all<any>()).results;
    expect(fin.map((r) => r.status)).toEqual(["deducted", "deducted"]);
    // phiếu lương cá nhân của kỳ 10 có dòng chuyển kỳ sau
    const me = (await api("accountant", "GET", `${V}/payroll/periods/2026-10`)).body.items.find((i: any) => i.code === "NV-C1");
    expect(me.lines.some((l: any) => l.label === "Tạm ứng chuyển kỳ sau")).toBe(true);
  });
});

describe("C-02 sổ quỹ xuất Excel không lộ lương từng người", () => {
  async function so(role: string) {
    const token = await login(role);
    const today = vnDate();
    const res = await app.request(`${V}/exports/so-quy.xlsx?from=${today}&to=${today}&fundId=1`, { headers: { authorization: `Bearer ${token}` } }, testEnv);
    expect(res.status).toBe(200);
    const z = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return strFromU8(z["xl/worksheets/sheet1.xml"]);
  }
  it("quản lý (reports.view, không hr.sensitive) thấy một dòng 'Chi lương (tổng)'; kế toán/chủ thấy chi tiết", async () => {
    const cat = (await db().prepare(`SELECT id FROM cash_categories WHERE code='LUONG'`).first<{ id: number }>())!.id;
    await db().batch([
      db().prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, status, period, created_by) VALUES ('PC-F3-1','out',1,?,1000000,'NV-SECRET1','payroll_item','posted','2026-11',1)`).bind(cat),
      db().prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, status, period, created_by) VALUES ('PC-F3-2','out',1,?,2500000,'NV-SECRET2','salary_advance','posted','2026-11',1)`).bind(cat),
    ]);
    const m = await so("manager");
    expect(m).not.toContain("NV-SECRET");
    expect(m).not.toContain("PC-F3");
    expect(m).toContain("Chi lương (tổng)");
    const total = (await db().prepare(`SELECT SUM(amount) s FROM cash_vouchers WHERE fund_id=1 AND status='posted' AND (ref_type IN ('payroll_item','salary_advance'))`).first<any>()).s;
    expect(m).toContain(`<v>${total}</v>`);
    expect(m.match(/Chi lương \(tổng\)/g)).toHaveLength(1);
    const a = await so("accountant");
    expect(a).toContain("NV-SECRET1");
    expect(a).toContain("NV-SECRET2");
    expect(await so("owner")).toContain("PC-F3-1");
  });
});

describe("C-22 sao kê ngân hàng", () => {
  it("thủ kho không xem được; kế toán/quản lý vẫn xem", async () => {
    expect((await api("warehouse", "GET", `${V}/bank-transactions`)).status).toBe(403);
    expect((await api("accountant", "GET", `${V}/bank-transactions`)).status).toBe(200);
    expect((await api("manager", "GET", `${V}/bank-transactions`)).status).toBe(200);
  });
});
