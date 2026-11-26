import { beforeAll, describe, expect, it } from "vitest";
import { api, PASSWORD, seedBase, testEnv } from "./helpers";
import { insertOrders } from "./sales-helpers";
import { hashPassword } from "../src/worker/lib/crypto";
import { calculatePayslip, DEFAULT_PAYROLL_SETTINGS, type PayslipInput } from "../src/worker/services/payroll-calc";

// Hoa hồng theo quy tắc: ưu tiên quy tắc, trả hàng trừ, tích hợp lương, inputs_hash, quay về thưởng doanh số cũ khi không có quy tắc.
const db = () => testEnv.DB;
const V = "/api/v1";
const SEP = "2026-09-10T03:00:00.000Z";
const AUG = "2026-08-10T03:00:00.000Z";
const A_USER = 8601, B_USER = 8602, A_EMP = 8601, B_EMP = 8602, CASHIER = 3;

async function closeTimesheet(period: string) {
  await db().batch([
    db().prepare(`INSERT INTO timesheets(period, status) VALUES (?, 'open')`).bind(period),
    ...[A_EMP, B_EMP].flatMap((e) => Array.from({ length: 26 }, (_, i) => db().prepare(`INSERT INTO timesheet_days(period, employee_id, work_date, worked_minutes, shifts_worked) VALUES (?,?,?,?,1)`).bind(period, e, `${period}-${String(i + 1).padStart(2, "0")}`, 480))),
    db().prepare(`UPDATE timesheets SET status='closed' WHERE period = ?`).bind(period),
  ]);
}
const rule = (o: Record<string, unknown>) => api("owner", "POST", `${V}/commission/rules`, o);
const itemOf = async (period: string, emp: number) => (await api("accountant", "GET", `${V}/payroll/periods/${period}`)).body.items.find((i: any) => i.employeeId === emp || i.code === `NV-${emp}`);
const ids: Record<string, number> = {};

beforeAll(async () => {
  await seedBase();
  const hash = await hashPassword(PASSWORD);
  await db().batch([
    db().prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id) VALUES (8601,'sc_a','NV Bán A',?,'staff',1),(8602,'sc_b','NV Bán B',?,'staff',1)`).bind(hash, hash),
    db().prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date, pay_type, base_salary, insurance_salary, pit_enabled) VALUES
      (8601,'NV-8601',8601,'NV Bán A','bán hàng',1,'2026-01-01','monthly',10400000,0,0),(8602,'NV-8602',8602,'NV Bán B','bán hàng',1,'2026-01-01','monthly',10400000,0,0)`),
    db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (601,'SC-1','Cam SC','kg',1),(602,'SC-2','Táo SC','kg',2),(603,'SC-3','Mít SC','kg',1)`),
  ]);
  await insertOrders([
    // A bán qua tay thu ngân (seller_id = A), B tự bán
    { id: 6001, createdBy: CASHIER, sellerId: A_USER, at: SEP, lines: [[601, 10000, 1000000, 600000], [602, 5000, 500000, 300000]] },
    { id: 6002, createdBy: B_USER, at: SEP, lines: [[601, 2000, 200000, 120000]] },
    { id: 6003, createdBy: B_USER, at: SEP, lines: [[603, 1000, 100000, 60000]] },
    // trả 100.000 mặt hàng 601 của đơn 6001: trừ vào A dù người xử lý trả hàng là B
    { id: 6004, kind: "return", orig: 6001, createdBy: B_USER, at: SEP, lines: [[601, 1000, 100000, 60000, 60010]] },
    // tháng 8: doanh số cũ (created_by) để kiểm tra đường tính cũ
    { id: 6101, createdBy: A_USER, at: AUG, lines: [[601, 10000, 1000000, 600000]] },
  ]);
  await closeTimesheet("2026-09");
  await closeTimesheet("2026-08");
});

describe("quy tắc hoa hồng: CRUD và phân quyền", () => {
  it("chỉ chủ tạo/sửa; kế toán xem; validate; sửa có version → 409; chỉ ngừng, không xoá", async () => {
    const body = { name: "Mặc định 2%", scope: "all", rateBp: 200, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" };
    for (const role of ["accountant", "manager", "cashier"]) expect((await api(role, "POST", `${V}/commission/rules`, body)).status).toBe(403);
    expect((await rule({ ...body, rateBp: 10001 })).status).toBe(422);
    expect((await rule({ ...body, scope: "group" })).status).toBe(422);
    expect((await rule({ ...body, scope: "product", productId: 999999 })).status).toBe(422);
    expect((await rule({ ...body, effectiveFrom: "2026-10-01" })).status).toBe(422);
    const all = await rule(body);
    expect(all.status).toBe(201);
    ids.all = all.body.id;
    ids.g2 = (await rule({ name: "Nhóm táo 5%", scope: "group", productGroupId: 2, rateBp: 500, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" })).body.id;
    ids.p601 = (await rule({ name: "Cam 3%", scope: "product", productId: 601, rateBp: 300, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" })).body.id;
    ids.bAll = (await rule({ name: "B mọi hàng 10%", scope: "all", employeeId: B_EMP, rateBp: 1000, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" })).body.id;
    ids.bP601 = (await rule({ name: "B bán cam 8%", scope: "product", productId: 601, employeeId: B_EMP, rateBp: 800, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-30" })).body.id;
    const list = await api("accountant", "GET", `${V}/commission/rules`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(5);
    expect((await api("manager", "GET", `${V}/commission/rules`)).status).toBe(403);
    const cur = list.body.items.find((x: any) => x.id === ids.all);
    expect(cur).toMatchObject({ scope: "all", rateBp: 200, version: 1, active: true });
    const stale = await api("owner", "PATCH", `${V}/commission/rules/${ids.all}`, { version: 99, rateBp: 250 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await api("accountant", "PATCH", `${V}/commission/rules/${ids.all}`, { version: 1, rateBp: 250 })).status).toBe(403);
    expect((await api("owner", "DELETE", `${V}/commission/rules/${ids.all}`)).status).toBe(404);
    expect(() => db().prepare(`DELETE FROM commission_rules WHERE id = ?`).bind(ids.all).run()).rejects.toThrow();
  });

  it("ngừng rồi bật lại tăng version, ghi audit", async () => {
    const off = await api("owner", "PATCH", `${V}/commission/rules/${ids.g2}`, { version: 1, active: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ active: false, version: 2 });
    const on = await api("owner", "PATCH", `${V}/commission/rules/${ids.g2}`, { version: 2, active: true });
    expect(on.body).toMatchObject({ active: true, version: 3 });
    const n = await db().prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity='commission_rule' AND entity_id = ?`).bind(String(ids.g2)).first<{ n: number }>();
    expect(n!.n).toBe(3); // tạo, ngừng, bật lại
  });
});

describe("xem trước hoa hồng", () => {
  it("quy tắc cụ thể nhất thắng, trả hàng trừ lại người bán đơn gốc", async () => {
    const r = await api("accountant", "GET", `${V}/commission/preview?period=2026-09`);
    expect(r.status).toBe(200);
    expect(r.body.rulesActive).toBe(true);
    const by = Object.fromEntries(r.body.items.map((i: any) => [i.userId, i]));
    // A: cam 1.000.000 − trả 100.000 = 900.000 × 3% (quy tắc sản phẩm thắng "tất cả" 2%) = 27.000; táo 500.000 × 5% (nhóm) = 25.000
    expect(by[A_USER].revenue).toBe(1_400_000);
    expect(by[A_USER].commission).toBe(52_000);
    expect(by[A_USER].parts.map((p: any) => [p.name, p.revenue, p.amount])).toEqual([["Nhóm táo 5%", 500_000, 25_000], ["Cam 3%", 900_000, 27_000]]);
    // B: cam 200.000 × 8% (sản phẩm + riêng B thắng sản phẩm chung 3%) = 16.000; mít 100.000 × 10% (tất cả + riêng B thắng tất cả chung 2%) = 10.000
    expect(by[B_USER].commission).toBe(26_000);
    expect(by[B_USER].parts.map((p: any) => [p.name, p.amount])).toEqual([["B mọi hàng 10%", 10_000], ["B bán cam 8%", 16_000]]);
    expect(r.body.total).toBe(78_000);
    // thu ngân (người lập đơn 6001) không có doanh số: người bán là A
    expect(by[CASHIER]).toBeUndefined();
  });

  it("quy tắc ngoài kỳ không áp dụng; phân quyền; tham số", async () => {
    const aug = await api("accountant", "GET", `${V}/commission/preview?period=2026-08`);
    expect(aug.body).toMatchObject({ rulesActive: false, items: [], total: 0 });
    for (const role of ["manager", "cashier"]) expect((await api(role, "GET", `${V}/commission/preview?period=2026-09`)).status).toBe(403);
    expect((await api("owner", "GET", `${V}/commission/preview?period=2026-9`)).status).toBe(422);
  });
});

describe("tích hợp bảng lương", () => {
  it("kỳ có quy tắc: salesBonus = hoa hồng theo quy tắc, có dòng diễn giải từng quy tắc", async () => {
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-09/calculate`)).status).toBe(200);
    const a = await itemOf("2026-09", A_EMP);
    expect(a.salesBonus).toBe(52_000);
    expect(a.gross).toBe(10_400_000 + 52_000);
    const labels = a.lines.filter((l: any) => l.label.startsWith("Hoa hồng:")).map((l: any) => [l.label, l.amount]);
    expect(labels).toEqual([["Hoa hồng: Nhóm táo 5%", 25_000], ["Hoa hồng: Cam 3%", 27_000]]);
    expect((await itemOf("2026-09", B_EMP)).salesBonus).toBe(26_000);
  });

  it("đổi quy tắc sau khi tính → inputs_hash đổi, duyệt báo payroll_stale; tính lại rồi duyệt được", async () => {
    const before = (await db().prepare(`SELECT inputs_hash FROM payroll_periods WHERE period='2026-09'`).first<any>()).inputs_hash;
    expect((await api("owner", "PATCH", `${V}/commission/rules/${ids.p601}`, { version: 1, rateBp: 400 })).status).toBe(200);
    const stale = await api("owner", "POST", `${V}/payroll/periods/2026-09/approve`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("payroll_stale");
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-09/calculate`)).status).toBe(200);
    const after = (await db().prepare(`SELECT inputs_hash FROM payroll_periods WHERE period='2026-09'`).first<any>()).inputs_hash;
    expect(after).not.toBe(before);
    expect((await itemOf("2026-09", A_EMP)).salesBonus).toBe(36_000 + 25_000); // 900.000 × 4% + 25.000
    // phát sinh trả hàng mới trong kỳ cũng làm dữ liệu đổi
    await insertOrders([{ id: 6005, kind: "return", orig: 6001, createdBy: B_USER, at: SEP, lines: [[601, 1000, 50000, 30000, 60010]] }]);
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-09/approve`)).body.error.code).toBe("payroll_stale");
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-09/calculate`)).status).toBe(200);
    expect((await itemOf("2026-09", A_EMP)).salesBonus).toBe(34_000 + 25_000); // 850.000 × 4%
    expect((await api("owner", "POST", `${V}/payroll/periods/2026-09/approve`)).status).toBe(200);
  });

  it("không quy tắc nào cho kỳ → vẫn tính thưởng doanh số cũ (hr.sales_bonus_bp), không dòng Hoa hồng", async () => {
    await db().prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('hr.sales_bonus_bp','100')`).run();
    expect((await api("accountant", "POST", `${V}/payroll/periods/2026-08/calculate`)).status).toBe(200);
    const a = await itemOf("2026-08", A_EMP);
    expect(a.salesBonus).toBe(10_000); // 1.000.000 × 1%
    expect(a.lines.some((l: any) => l.label === "Thưởng doanh số")).toBe(true);
    expect(a.lines.some((l: any) => String(l.label).startsWith("Hoa hồng"))).toBe(false);
    expect(a.gross).toBe(10_400_000 + 10_000);
  });

  it("hàm tính phiếu lương: không truyền commission → y như cũ; có commission thay thế", () => {
    const base: PayslipInput = {
      employee: { payType: "monthly", baseSalary: 10_400_000, hourlyRate: 0, shiftRate: 0, insuranceSalary: 0, dependents: 0, pitEnabled: false },
      days: Array.from({ length: 26 }, (_, i) => ({ workDate: `2026-09-${String(i + 1).padStart(2, "0")}`, workedMinutes: 480, overtimeMinutes: 0, overtimeMultiplierBp: 15000, shiftsWorked: 1, leavePaidX10: 0, holiday: false })),
      adjustMinutes: { work: 0, overtime: 0 }, allowances: [], entries: [], advances: [], salesRevenue: 1_000_000,
    };
    const legacy = calculatePayslip(base, { ...DEFAULT_PAYROLL_SETTINGS, salesBonusBp: 100 });
    expect(legacy.salesBonus).toBe(10_000);
    const ruled = calculatePayslip({ ...base, commission: { parts: [{ name: "X", rateBp: 300, revenue: 500_000, amount: 15_000 }] } }, { ...DEFAULT_PAYROLL_SETTINGS, salesBonusBp: 100 });
    expect(ruled.salesBonus).toBe(15_000);
    const neg = calculatePayslip({ ...base, commission: { parts: [{ name: "X", rateBp: 300, revenue: -100_000, amount: -3_000 }] } });
    expect(neg.salesBonus).toBe(0);
    expect(neg.gross).toBe(legacy.gross - 10_000);
  });
});

describe("không lộ lương / hoa hồng", () => {
  it("vai trò không có hr.sensitive không thấy quy tắc, xem trước hay phiếu lương", async () => {
    for (const role of ["manager", "cashier", "warehouse", "online_staff"]) {
      expect((await api(role, "GET", `${V}/commission/preview?period=2026-09`)).status).toBe(403);
      expect((await api(role, "GET", `${V}/commission/rules`)).status).toBe(403);
      expect((await api(role, "GET", `${V}/payroll/periods/2026-09`)).status).toBe(403);
    }
  });
});
