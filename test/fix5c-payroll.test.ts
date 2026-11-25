import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnPeriod } from "../src/worker/lib/time";

// Fix 5c: C-23 đảo chi lương / huỷ tạm ứng chọn nhầm quỹ
const V = "/api/v1";
const db = () => testEnv.DB;
const fund = async (id: number) => (await api("owner", "GET", `${V}/funds`)).body.items.find((f: any) => f.id === id).balance as number;
const P = "2026-06";
const NEXT = "2026-07";

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, pay_type, base_salary) VALUES (5901,'NV-5C1','NV Một','kho',1,'2026-01-01','monthly',5000000),(5902,'NV-5C2','NV Hai','kho',1,'2026-01-01','monthly',6000000)`),
    db().prepare(`INSERT INTO payroll_periods(id, period, status, calculated_at, total_net) VALUES (5901, ?, 'approved', '2026-06-30T00:00:00.000Z', 10000000)`).bind(P),
    db().prepare(`INSERT INTO payroll_items(payroll_period_id, employee_id, pay_type, net, advances, gross) VALUES (5901,5901,'monthly',4000000,1000000,5000000),(5901,5902,'monthly',6000000,0,6000000)`),
    // NV1: tạm ứng 1.000.000 khấu trừ kỳ 6 (trừ đủ) + 500.000 sẽ bị trừ một phần... đơn giản: một khoản trừ đủ, một khoản dời kỳ
    db().prepare(`INSERT INTO salary_advances(id, employee_id, amount, advance_date, deduct_period, fund_id, status, created_by, created_at) VALUES
      (5901,5901,1000000,'2026-06-10',?,1,'paid',1,'2026-06-10T00:00:00.000Z'),
      (5902,5902,300000,'2026-06-12',?,1,'paid',1,'2026-06-12T00:00:00.000Z')`).bind(P, P),
  ]);
});

describe("C-23: đảo chi lương", () => {
  it("không đảo được khi chưa chi / không đủ quyền", async () => {
    expect((await api("owner", "POST", `${V}/payroll/periods/${P}/reverse-pay`, { reason: "Chưa chi mà đảo" })).status).toBe(409);
    expect((await api("accountant", "POST", `${V}/payroll/periods/${P}/reverse-pay`, { reason: "Không có quyền" })).status).toBe(403);
  });

  it("chi nhầm quỹ ngân hàng → đảo: quỹ về như cũ, kỳ về approved, tạm ứng khôi phục, chi lại được quỹ khác", async () => {
    const bank0 = await fund(2), cash0 = await fund(1);
    expect((await api("accountant", "POST", `${V}/payroll/periods/${P}/pay`, { fundId: 2 })).status).toBe(200);
    expect(await fund(2)).toBe(bank0 - 10_000_000);
    expect((await db().prepare(`SELECT status FROM salary_advances WHERE id=5901`).first<any>()).status).toBe("deducted");
    expect((await db().prepare(`SELECT deduct_period p, moved_from_period m FROM salary_advances WHERE id=5902`).first<any>())).toEqual({ p: NEXT, m: P }); // NV2 có phiếu lương nhưng advances = 0 → khoản tạm ứng bị dời sang kỳ sau, ghi kỳ gốc

    const rv = await api("owner", "POST", `${V}/payroll/periods/${P}/reverse-pay`, { reason: "Chọn nhầm quỹ ngân hàng" });
    expect(rv.status).toBe(200);
    expect(rv.body.status).toBe("approved");
    expect(rv.body.reversals).toHaveLength(2);
    expect(await fund(2)).toBe(bank0);
    const pp = await db().prepare(`SELECT status, paid_at, paid_fund_id FROM payroll_periods WHERE id=5901`).first<any>();
    expect(pp).toEqual({ status: "approved", paid_at: null, paid_fund_id: null });
    expect((await db().prepare(`SELECT status FROM salary_advances WHERE id=5901`).first<any>()).status).toBe("paid");
    expect((await db().prepare(`SELECT deduct_period p FROM salary_advances WHERE id=5902`).first<any>()).p).toBe(P);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='payroll.reverse_pay'`).first<any>()).n).toBe(1);
    // đảo lần hai: kỳ không còn paid
    expect((await api("owner", "POST", `${V}/payroll/periods/${P}/reverse-pay`, { reason: "Đảo lần hai" })).status).toBe(409);

    // chi lại bằng quỹ tiền mặt
    expect((await api("accountant", "POST", `${V}/payroll/periods/${P}/pay`, { fundId: 1 })).status).toBe(200);
    expect(await fund(1)).toBe(cash0 - 10_000_000);
    expect(await fund(2)).toBe(bank0);
    expect((await db().prepare(`SELECT status FROM salary_advances WHERE id=5901`).first<any>()).status).toBe("deducted");
  });

  it("kỳ hiện tại đã khoá sổ → không đảo được (423)", async () => {
    await db().prepare(`INSERT OR REPLACE INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    const r = await api("owner", "POST", `${V}/payroll/periods/${P}/reverse-pay`, { reason: "Thử khi khoá sổ" });
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    expect(r.status).toBe(423);
    expect((await db().prepare(`SELECT status FROM payroll_periods WHERE id=5901`).first<any>()).status).toBe("paid");
  });
});

describe("C-23: huỷ tạm ứng chọn nhầm quỹ", () => {
  it("tạm ứng chưa khấu trừ: đảo phiếu chi, đánh dấu cancelled; đã khấu trừ thì không huỷ được", async () => {
    const bank0 = await fund(2);
    const a = await api("accountant", "POST", `${V}/payroll/advances`, { employeeId: 5901, amount: 700_000, fundId: 2, reason: "Ứng" });
    expect(a.status).toBe(201);
    expect(await fund(2)).toBe(bank0 - 700_000);
    expect((await api("manager", "POST", `${V}/payroll/advances/${a.body.id}/cancel`, { reason: "Chọn nhầm quỹ" })).status).toBe(403);
    const c = await api("accountant", "POST", `${V}/payroll/advances/${a.body.id}/cancel`, { reason: "Chọn nhầm quỹ" });
    expect(c.status).toBe(200);
    expect(c.body.reversalCode).toBeTruthy();
    expect(await fund(2)).toBe(bank0);
    expect((await db().prepare(`SELECT status FROM salary_advances WHERE id=?`).bind(a.body.id).first<any>()).status).toBe("cancelled");
    expect((await api("accountant", "POST", `${V}/payroll/advances/${a.body.id}/cancel`, { reason: "Huỷ lần hai" })).status).toBe(409);
    expect((await api("accountant", "POST", `${V}/payroll/advances/5901/cancel`, { reason: "Đã khấu trừ rồi" })).status).toBe(409);
  });
});
