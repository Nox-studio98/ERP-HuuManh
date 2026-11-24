import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate, vnPeriod } from "../src/worker/lib/time";
import { addDays } from "../src/worker/services/debt";
import { containsCode } from "../src/worker/routes/debts";
import { csvCell } from "../src/worker/services/debt-ledger";

const db = () => testEnv.DB;
const V = "/api/v1";
const today = vnDate();
let n = 0;
const key = () => `idem-${Date.now()}-${++n}-key`;

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CLR','Chờ đối soát COD','cod_clearing')`),
    db().prepare(`INSERT INTO employees(id, code, full_name, position, store_id, hire_date, status) VALUES (9701,'NV-P1','NV Một','kho',1,'2026-01-01','active'),(9702,'NV-P2','NV Hai','kho',1,'2026-01-01','active'),(9703,'NV-P3','NV Ba','kho',1,'2026-01-01','active')`),
  ]);
});

describe("payroll pay (audit #3)", () => {
  it("concurrent pay creates one voucher per employee; zero-net employees carry their advances to next period", async () => {
    await db().batch([
      db().prepare(`INSERT INTO payroll_periods(id, period, status, calculated_at) VALUES (9701,'2026-10','approved', '2026-11-01T00:00:00.000Z')`),
      db().prepare(`INSERT INTO payroll_items(payroll_period_id, employee_id, pay_type, gross, advances, advances_carried, net) VALUES (9701,9701,'monthly',5000000,100000,0,5000000),(9701,9702,'monthly',0,0,1000000,0)`),
      db().prepare(`INSERT INTO salary_advances(id, employee_id, amount, advance_date, deduct_period, fund_id, status, created_by, created_at) VALUES (9701,9701,100000,'2026-10-01','2026-10',1,'paid',1,'2026-10-02T00:00:00.000Z'),(9702,9702,1000000,'2026-10-01','2026-10',1,'paid',1,'2026-10-02T00:00:00.000Z')`),
    ]);
    const res = await Promise.all([
      api("accountant", "POST", `${V}/payroll/periods/2026-10/pay`, { fundId: 1 }),
      api("accountant", "POST", `${V}/payroll/periods/2026-10/pay`, { fundId: 1 }),
    ]);
    const statuses = res.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(409);
    const v = await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers WHERE ref_type='payroll_item' AND counterparty='NV-P1'`).first<{ n: number }>();
    expect(v!.n).toBe(1);
    const adv = (await db().prepare(`SELECT id, status, deduct_period FROM salary_advances WHERE id IN (9701, 9702) ORDER BY id`).all<any>()).results;
    expect(adv.find((a) => a.id === 9701).status).toBe("deducted");
    // C-05: net = 0 → chưa khấu trừ được; khoản tạm ứng không mất mà chuyển sang kỳ sau
    expect(adv.find((a) => a.id === 9702)).toMatchObject({ status: "paid", deduct_period: "2026-11" });
  });

  it("advances above approval.cash_out_vnd need approval unless finance.approve", async () => {
    const r = await api("accountant", "POST", `${V}/payroll/advances`, { employeeId: 9703, amount: 6_000_000, fundId: 1, reason: "ứng lớn", deductPeriod: "2027-03" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_approval");
    const v = await db().prepare(`SELECT status FROM cash_vouchers WHERE code=?`).bind(r.body.voucherCode).first<{ status: string }>();
    expect(v!.status).toBe("pending_approval");
    const ap = await db().prepare(`SELECT COUNT(*) n FROM approvals WHERE type='cash_voucher.post' AND ref_id = CAST((SELECT id FROM cash_vouchers WHERE code=?) AS TEXT)`).bind(r.body.voucherCode).first<{ n: number }>();
    expect(ap!.n).toBe(1);
    const small = await api("accountant", "POST", `${V}/payroll/advances`, { employeeId: 9703, amount: 1_000_000, fundId: 1, deductPeriod: "2027-03" });
    expect(small.body.status).toBe("paid");
    const owner = await api("owner", "POST", `${V}/payroll/advances`, { employeeId: 9703, amount: 6_000_000, fundId: 1, deductPeriod: "2027-04" });
    expect(owner.body.status).toBe("paid");
  });
});

describe("vouchers (audit #6, #10, low)", () => {
  it("rejects managed refTypes on create and concurrent double reverse yields one reversal", async () => {
    const out = await db().prepare(`SELECT id FROM cash_categories WHERE code='MAT_BANG'`).first<{ id: number }>();
    const bad = await api("accountant", "POST", `${V}/vouchers`, { direction: "out", fundId: 1, categoryId: out!.id, amount: 1000, refType: "debt_payment", refId: 1 });
    expect(bad.status).toBe(422);
    const ok = await api("accountant", "POST", `${V}/vouchers`, { direction: "out", fundId: 1, categoryId: out!.id, amount: 1000, refType: "manual" });
    expect(ok.status).toBe(201);
    const res = await Promise.all([
      api("accountant", "POST", `${V}/vouchers/${ok.body.id}/reverse`, { reason: "nhập nhầm A" }),
      api("accountant", "POST", `${V}/vouchers/${ok.body.id}/reverse`, { reason: "nhập nhầm B" }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    const c = await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers WHERE reverses_id=?`).bind(ok.body.id).first<{ n: number }>();
    expect(c!.n).toBe(1);
  });

  it("refuses to reverse vouchers owned by another module", async () => {
    const v = await db().prepare(`SELECT id FROM cash_vouchers WHERE ref_type='payroll_item' LIMIT 1`).first<{ id: number }>();
    const r = await api("accountant", "POST", `${V}/vouchers/${v!.id}/reverse`, { reason: "đảo lương bằng tay" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("managed_voucher");
  });

  it("hides payroll/advance vouchers from roles without hr.sensitive", async () => {
    const asManager = await api("manager", "GET", `${V}/vouchers?limit=200`);
    expect(asManager.status).toBe(200);
    expect(asManager.body.items.some((x: any) => x.ref_type === "payroll_item" || x.ref_type === "salary_advance" || x.category_name === "Lương")).toBe(false);
    const asOwner = await api("owner", "GET", `${V}/vouchers?limit=200`);
    expect(asOwner.body.items.some((x: any) => x.ref_type === "payroll_item")).toBe(true);
  });
});

describe("debt payments (audit #5, #6)", () => {
  beforeAll(async () => {
    await db().batch([
      db().prepare(`INSERT INTO customers(id, code, type, name, credit_limit) VALUES (9801,'KH-9801','b2b','Khách đua',9000000),(9802,'KH-77001','b2b','=HYPERLINK("x")',9000000)`),
      db().prepare(`INSERT INTO invoices(id, code, customer_id, issue_date, due_date, subtotal, total) VALUES (9801,'HDB-9801',9801,?,?,100000,100000),(9802,'HDB-9802',9802,?,?,100000,100000)`).bind(addDays(today, -5), addDays(today, 10), addDays(today, -5), addDays(today, 10)),
    ]);
  });
  const pay = (extra: Record<string, unknown> = {}) =>
    api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 9801, fundId: 1, amount: 100_000, method: "cash", allocations: [{ invoiceId: 9801, amount: 100_000 }], ...extra });

  it("concurrent payments never over-allocate an invoice and leave no orphan voucher", async () => {
    const res = await Promise.all([pay(), pay(), pay()]);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of res.filter((x) => x.status !== 201)) expect([409, 422]).toContain(r.status);
    const alloc = await db().prepare(`SELECT COALESCE(SUM(amount),0) s FROM debt_allocations WHERE invoice_id=9801`).first<{ s: number }>();
    expect(alloc!.s).toBe(100_000);
    const vs = await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers WHERE ref_type='debt_payment' AND counterparty='Khách đua'`).first<{ n: number }>();
    const ps = await db().prepare(`SELECT COUNT(*) n FROM debt_payments WHERE partner_id=9801`).first<{ n: number }>();
    expect(vs!.n).toBe(1);
    expect(ps!.n).toBe(1);
  });

  it("idempotencyKey makes a repeated payment a 409 already_done without a second voucher", async () => {
    const k = key();
    const body = { partnerId: 9802, allocations: undefined, amount: 30_000 };
    const a = await pay({ ...body, idempotencyKey: k });
    expect(a.status).toBe(201);
    const b = await pay({ ...body, idempotencyKey: k });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("already_done");
    const c = await db().prepare(`SELECT COUNT(*) n FROM debt_payments WHERE partner_id=9802`).first<{ n: number }>();
    expect(c!.n).toBe(1);
  });

  it("concurrent reverse of one payment reverses its voucher once", async () => {
    const p = await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 9802, fundId: 1, amount: 20_000, method: "cash" });
    expect(p.status).toBe(201);
    const res = await Promise.all([
      api("accountant", "POST", `${V}/debts/payments/${p.body.payment.id}/reverse`, { reason: "đảo A" }),
      api("accountant", "POST", `${V}/debts/payments/${p.body.payment.id}/reverse`, { reason: "đảo B" }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const rv = await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers WHERE reverses_id=?`).bind(p.body.payment.cashVoucherId).first<{ n: number }>();
    expect(rv!.n).toBe(1);
  });

  it("a bank transaction is matched only once, even concurrently", async () => {
    const imp = await api("accountant", "POST", `${V}/bank-transactions/import`, { fundId: 2, csv: `date,amount,description,ref\n${today},70000,chuyen khoan khong ro ma,SEC-BANK-1` });
    expect(imp.status).toBe(201);
    const id = imp.body.items[0].id;
    expect(imp.body.items[0].status).toBe("unmatched");
    const m = () => api("accountant", "POST", `${V}/bank-transactions/${id}/match`, { partnerType: "customer", partnerId: 9801 });
    const res = await Promise.all([m(), m()]);
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    const c = await db().prepare(`SELECT COUNT(*) n FROM debt_payments WHERE bank_txn_id=?`).bind(id).first<{ n: number }>();
    expect(c!.n).toBe(1);
  });

  it("auto-match requires a whole customer code (KH-77001 must not match inside KH-770012)", async () => {
    expect(containsCode("CK KH-77001 tra no", "KH-77001")).toBe(true);
    expect(containsCode("CK KH-770012 tra no", "KH-77001")).toBe(false);
    expect(containsCode("KH-77001", "KH-77001")).toBe(true);
    expect(containsCode("XKH-77001", "KH-77001")).toBe(false);
    const imp = await api("accountant", "POST", `${V}/bank-transactions/import`, {
      fundId: 2, csv: `date,amount,description,ref\n${today},11000,CK KH-770012 tra no,SEC-BANK-2\n${today},12000,CK KH-77001 tra no,SEC-BANK-3`,
    });
    const st = Object.fromEntries(imp.body.items.map((i: any) => [i.ref, i.status]));
    expect(st["SEC-BANK-2"]).toBe("unmatched");
    expect(st["SEC-BANK-3"]).toBe("matched");
  });

  it("CSV cells starting with = + - @ are neutralised", async () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(-5)).toBe("-5");
    const r = await testEnvStatementCsv();
    expect(r).toContain(`'=HYPERLINK`);
  });
});

async function testEnvStatementCsv() {
  const { app } = await import("../src/worker/index");
  const { login } = await import("./helpers");
  const res = await app.request(`${V}/debts/statements/customer/9802?format=csv`, { headers: { authorization: `Bearer ${await login("accountant")}` } }, testEnv);
  return res.text();
}

describe("COD clearing does not double count (audit #11)", () => {
  it("settlement confirm drains the clearing fund and cash flow counts the money once", async () => {
    await db().batch([
      db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, paid_total, payment_method, payment_status, created_at, completed_at) VALUES (9901,'DH-COD-1','online','sale',1,'completed',1000000,1000000,'cod','paid',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
      db().prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (9901,'cod',1000000,3,'confirmed')`),
    ]);
    const bankBefore = (await api("owner", "GET", `${V}/funds`)).body.items.find((f: any) => f.id === 2).balance;
    const flowBefore = await api("owner", "GET", `${V}/reports/cash-flow?from=${today}&to=${today}`);
    expect(flowBefore.status).toBe(200);
    const clrBefore = flowBefore.body.byFund.find((f: any) => f.fundId === 3);
    expect(clrBefore.counted).toBe(false);
    const inBefore = flowBefore.body.totalInflow;

    const s = await api("owner", "POST", `${V}/settlements`, {
      source: "cod", externalRef: "SEC-COD-1", fundId: 2, diffReason: "phí giao hộ",
      lines: [{ orderId: 9901, expectedAmount: 1_000_000, receivedAmount: 980_000, feeAmount: 20_000 }],
    });
    expect(s.status).toBe(201);
    expect((await api("owner", "POST", `${V}/settlements/${s.body.id}/confirm`)).status).toBe(200);

    const funds = (await api("owner", "GET", `${V}/funds`)).body.items;
    const clr = funds.find((f: any) => f.id === 3);
    expect(clr.balance).toBe(0); // tiền chờ đối soát đã chuyển ra
    const flow = await api("owner", "GET", `${V}/reports/cash-flow?from=${today}&to=${today}`);
    // chỉ phần thực nhận 980.000 vào quỹ thật được tính là thu; quỹ chờ không cộng thêm 1.000.000
    expect(flow.body.totalInflow - inBefore).toBe(980_000);
    // A-03/B-05: `received` đã là tiền thực nhận (net) nên phí 20.000 KHÔNG được ghi ra từ quỹ ngân hàng lần nữa
    // (trước đây bank = +980.000 − 20.000 = 960.000, sai). Phí là chi phí ghi ra từ quỹ chờ → không tính vào dòng tiền quỹ thật.
    expect(flow.body.totalOutflow - flowBefore.body.totalOutflow).toBe(0);
    const bank = funds.find((f: any) => f.id === 2);
    expect(bank.balance - bankBefore).toBe(980_000);
    // đợt đối soát không thể xác nhận hai lần, và một đơn không nằm trong hai đợt
    expect((await api("owner", "POST", `${V}/settlements/${s.body.id}/confirm`)).status).toBe(409);
    const dup = await api("owner", "POST", `${V}/settlements`, {
      source: "cod", externalRef: "SEC-COD-2", fundId: 2, lines: [{ orderId: 9901, expectedAmount: 1_000_000, receivedAmount: 1_000_000, feeAmount: 0 }],
    });
    expect(dup.status).toBe(409);
  });
});
