import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
const today = vnDate();
const d = (n: number) => addDays(today, n);

const inv = (id: number, customerId: number, dueOffset: number, total: number, code = `T-HDB-${id}`) =>
  db().prepare(`INSERT INTO invoices(id, code, customer_id, issue_date, due_date, subtotal, total) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, code, customerId, d(dueOffset - 15), d(dueOffset), total, total);
const cust = (id: number, code: string, name: string, extra = "") =>
  db().prepare(`INSERT INTO customers(id, code, type, name, credit_limit, payment_terms_days${extra ? ", linked_supplier_id" : ""}) VALUES (?,?,'b2b',?,?,15${extra ? ",?" : ""})`)
    .bind(...([id, code, name, 5_000_000] as any[]).concat(extra ? [Number(extra)] : []));
const outstanding = async (invoiceId: number) =>
  (await db().prepare(`SELECT i.total + COALESCE((SELECT SUM(a.total) FROM invoices a WHERE a.original_invoice_id=i.id),0) - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x LEFT JOIN debt_payments p ON p.id=x.payment_id LEFT JOIN debt_adjustments j ON j.id=x.adjustment_id WHERE x.invoice_id=i.id AND (p.status='posted' OR j.status='posted')),0) AS os FROM invoices i WHERE i.id=?`).bind(invoiceId).first<{ os: number }>())!.os;

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (2001,'NCC-A','NCC A',30)`),
    cust(1001, "KH-1001", "Khách A"), inv(1, 1001, -45, 300_000), inv(2, 1001, -10, 200_000), inv(3, 1001, 5, 100_000),
    cust(1002, "KH-1002", "Khách B"), inv(4, 1002, -20, 100_000), inv(5, 1002, -5, 100_000),
    cust(1003, "KH-1003", "Khách C"), inv(6, 1003, -20, 100_000), inv(7, 1003, -5, 100_000),
    cust(1004, "KH-1004", "Khách D"), inv(8, 1004, -3, 500_000),
    cust(1005, "KH-1005", "Khách E (cũng là NCC)", "2001"), inv(9, 1005, -3, 300_000),
    db().prepare(`INSERT INTO supplier_bills(id, code, supplier_id, issue_date, due_date, total) VALUES (91,'T-CNP-1',2001,?,?,200000)`).bind(d(-10), d(5)),
    cust(1006, "KH-1006", "Khách F"), inv(10, 1006, -9, 400_000, "HDB-TEST-0010"), inv(11, 1006, -2, 400_000),
  ]);
});

describe("receivables", () => {
  it("summarises per customer with aging buckets; cashier forbidden", async () => {
    expect((await api("cashier", "GET", `${V}/debts/receivables`)).status).toBe(403);
    const r = await api("accountant", "GET", `${V}/debts/receivables?q=KH-1001`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({
      customerId: 1001, outstanding: 600_000, unapplied: 0, balance: 600_000, overdueAmount: 500_000, oldestOverdueDays: 45, creditLimit: 5_000_000,
      buckets: { current: 100_000, d1_30: 200_000, d31_60: 300_000, d61_90: 0, over90: 0 },
    });
    const od = await api("accountant", "GET", `${V}/debts/receivables?overdueOnly=1`);
    expect(od.body.items.every((x: any) => x.overdueAmount > 0)).toBe(true);
    const aging = await api("accountant", "GET", `${V}/debts/aging?side=receivable`);
    expect(aging.body.items.find((x: any) => x.docId === 1)).toMatchObject({ overdueDays: 45, bucket: "d31_60", outstanding: 300_000 });
  });
});

describe("payments", () => {
  it("allocates oldest-first and keeps leftover as credit (EC-24)", async () => {
    const r = await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 1002, fundId: 1, amount: 250_000, method: "cash" });
    expect(r.status).toBe(201);
    expect(r.body.unapplied).toBe(50_000);
    expect(r.body.allocations.map((a: any) => [a.invoiceId, a.amount])).toEqual([[4, 100_000], [5, 100_000]]);
    const v = await db().prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(r.body.payment.cashVoucherId).first<any>();
    expect(v).toMatchObject({ direction: "in", amount: 250_000, fund_id: 1, period: vnPeriod(), ref_type: "debt_payment" });
    const s = await api("accountant", "GET", `${V}/debts/receivables?q=KH-1002`);
    expect(s.body.items[0]).toMatchObject({ outstanding: 0, unapplied: 50_000, balance: -50_000 });
    // gạch phần dư vào hoá đơn mới sau đó
    await db().prepare(`INSERT INTO invoices(id, code, customer_id, issue_date, due_date, subtotal, total) VALUES (12,'T-HDB-12',1002,?,?,70000,70000)`).bind(today, d(15)).run();
    const al = await api("accountant", "POST", `${V}/debts/payments/${r.body.payment.id}/allocate`, {});
    expect(al.status).toBe(200);
    expect(al.body.unapplied).toBe(0);
    expect(await outstanding(12)).toBe(20_000);
  });

  it("supports explicit allocation and rejects over-allocation", async () => {
    const bad = await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 1003, fundId: 1, amount: 200_000, method: "transfer", allocations: [{ invoiceId: 6, amount: 150_000 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("allocation_exceeds_outstanding");
    const bad2 = await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 1003, fundId: 1, amount: 50_000, method: "cash", allocations: [{ invoiceId: 7, amount: 60_000 }] });
    expect(bad2.status).toBe(422);
    expect(bad2.body.error.code).toBe("allocation_exceeds_payment");
    expect((await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 1003, fundId: 1, amount: 50_000, method: "cash", allocations: [{ invoiceId: 1, amount: 10_000 }] })).status).toBe(422);
    const ok = await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 1003, fundId: 1, amount: 80_000, method: "cash", allocations: [{ invoiceId: 7, amount: 80_000 }] });
    expect(ok.status).toBe(201);
    expect(await outstanding(7)).toBe(20_000);
    expect(await outstanding(6)).toBe(100_000);
    // đảo phiếu: còn nợ trở lại, tạo phiếu đảo, đảo lần 2 bị chặn
    const rev = await api("accountant", "POST", `${V}/debts/payments/${ok.body.payment.id}/reverse`, { reason: "Nhập nhầm khách" });
    expect(rev.status).toBe(200);
    expect(rev.body.payment.status).toBe("reversed");
    expect(await outstanding(7)).toBe(100_000);
    const rv = await db().prepare(`SELECT * FROM cash_vouchers WHERE reverses_id = ?`).bind(ok.body.payment.cashVoucherId).first<any>();
    expect(rv).toMatchObject({ direction: "out", amount: 80_000 });
    expect((await api("accountant", "POST", `${V}/debts/payments/${ok.body.payment.id}/reverse`, { reason: "lần hai" })).status).toBe(409);
    const s = await api("accountant", "GET", `${V}/debts/receivables?q=KH-1003`);
    expect(s.body.items[0]).toMatchObject({ outstanding: 200_000, unapplied: 0 });
  });

  it("returns 423 when the current period is locked, with nothing written", async () => {
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, '2026-01-01T00:00:00Z', 1)`).bind(vnPeriod()).run();
    const before = await db().prepare(`SELECT COUNT(*) n FROM debt_payments`).first<{ n: number }>();
    const r = await api("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: 1001, fundId: 1, amount: 10_000, method: "cash" });
    expect(r.status).toBe(423);
    expect((await db().prepare(`SELECT COUNT(*) n FROM debt_payments`).first<{ n: number }>())!.n).toBe(before!.n);
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
  });
});

describe("adjustments", () => {
  it("write-off above threshold is pending; owner approves, manager cannot", async () => {
    const r = await api("manager", "POST", `${V}/debts/adjustments`, { type: "write_off", partnerType: "customer", partnerId: 1004, amount: 100_000, reason: "Khách khó đòi" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.approvalId).toBeGreaterThan(0);
    expect(await outstanding(8)).toBe(500_000);
    const no = await api("manager", "POST", `${V}/approvals/${r.body.approvalId}/decide`, { decision: "approved" });
    expect(no.status).toBe(403);
    expect(await outstanding(8)).toBe(500_000);
    const ok = await api("owner", "POST", `${V}/approvals/${r.body.approvalId}/decide`, { decision: "approved" });
    expect(ok.status).toBe(200);
    expect(await outstanding(8)).toBe(400_000);
    const adj = await db().prepare(`SELECT status FROM debt_adjustments WHERE id = ?`).bind(r.body.adjustment.id).first<any>();
    expect(adj.status).toBe("posted");
    // vượt còn nợ bị chặn; từ chối thì không áp dụng
    expect((await api("manager", "POST", `${V}/debts/adjustments`, { type: "discount", partnerType: "customer", partnerId: 1004, amount: 9_000_000, reason: "quá lớn" })).status).toBe(422);
    const r2 = await api("manager", "POST", `${V}/debts/adjustments`, { type: "discount", partnerType: "customer", partnerId: 1004, amount: 50_000, reason: "Chiết khấu thanh toán sớm" });
    await api("owner", "POST", `${V}/approvals/${r2.body.approvalId}/decide`, { decision: "rejected", note: "không" });
    expect(await outstanding(8)).toBe(400_000);
    // chủ tự lập thì ghi sổ ngay
    const r3 = await api("owner", "POST", `${V}/debts/adjustments`, { type: "discount", partnerType: "customer", partnerId: 1004, amount: 50_000, reason: "Chiết khấu", invoiceId: 8 });
    expect(r3.body.status).toBe("posted");
    expect(await outstanding(8)).toBe(350_000);
  });

  it("offsets between a customer and its linked supplier", async () => {
    expect((await api("accountant", "POST", `${V}/debts/adjustments`, { type: "offset", partnerType: "customer", partnerId: 1001, amount: 1000, reason: "thử" })).body.error.code).toBe("no_linked_supplier");
    const r = await api("accountant", "POST", `${V}/debts/adjustments`, { type: "offset", partnerType: "customer", partnerId: 1005, amount: 150_000, reason: "Cấn trừ công nợ hai chiều" });
    expect(r.status).toBe(201);
    expect(r.body.adjustments).toHaveLength(2);
    expect(await outstanding(9)).toBe(150_000);
    const bill = await db().prepare(`SELECT b.total - COALESCE((SELECT SUM(amount) FROM debt_allocations WHERE bill_id=b.id),0) os FROM supplier_bills b WHERE id=91`).first<any>();
    expect(bill.os).toBe(50_000);
    expect((await api("accountant", "POST", `${V}/debts/adjustments`, { type: "offset", partnerType: "customer", partnerId: 1005, amount: 100_000, reason: "vượt bên NCC" })).status).toBe(422);
  });
});

describe("statements", () => {
  it("returns running balance and a BOM csv", async () => {
    const r = await api("accountant", "GET", `${V}/debts/statements/customer/1002`);
    expect(r.status).toBe(200);
    expect(r.body.opening).toBe(0);
    expect(r.body.lines.map((l: any) => l.docType)).toEqual(expect.arrayContaining(["invoice", "payment"]));
    const last = r.body.lines[r.body.lines.length - 1];
    expect(r.body.closing).toBe(last.balance);
    expect(r.body.closing).toBe(20_000); // 200k + 70k hoá đơn − 250k đã thu
    const sum = r.body.lines.reduce((s: number, l: any) => s + l.debit - l.credit, 0);
    expect(r.body.closing).toBe(sum);
    const { login } = await import("./helpers");
    const { app } = await import("../src/worker/index");
    const res = await app.request(`${V}/debts/statements/customer/1002?format=csv`, { headers: { authorization: `Bearer ${await login("accountant")}` } }, testEnv);
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(text).toContain("Phát sinh tăng");
    const bytes = new Uint8Array(await (await app.request(`${V}/debts/statements/customer/1002?format=csv`, { headers: { authorization: `Bearer ${await login("accountant")}` } }, testEnv)).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("bank transactions", () => {
  const csv =
    "﻿date,amount,description,ref\r\n" +
    `${d(0)},400000,"CK HDB-TEST-0010, thanh toan",FT001\r\n` +
    `${d(0).split("-").reverse().join("/")},150000,"KH-1006 tra tien ""dot 2""",FT002\r\n` +
    `${d(0)},99000,Khong ro noi dung,FT003\r\n`;

  it("imports, auto-matches by invoice / customer code, dedupes by (fund, ref)", async () => {
    const r = await api("accountant", "POST", `${V}/bank-transactions/import`, { fundId: 2, csv });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ imported: 3, duplicates: 0, matched: 2, unmatched: 1 });
    expect(await outstanding(10)).toBe(0);
    expect(await outstanding(11)).toBe(250_000);
    const p = await db().prepare(`SELECT * FROM debt_payments WHERE ref='FT001'`).first<any>();
    expect(p).toMatchObject({ method: "transfer", fund_id: 2, partner_id: 1006 });
    const again = await api("accountant", "POST", `${V}/bank-transactions/import`, { fundId: 2, csv });
    expect(again.body).toMatchObject({ imported: 0, duplicates: 3, matched: 0 });
    // cùng ref ở quỹ khác không bị coi là trùng
    const other = await api("accountant", "POST", `${V}/bank-transactions/import`, { fundId: 1, csv: "date,amount,description,ref\n2026-01-01,5000,x,FT003" });
    expect(other.body.imported).toBe(1);
    const un = await api("accountant", "GET", `${V}/bank-transactions?status=unmatched&fundId=2`);
    expect(un.body.items).toHaveLength(1);
    const m = await api("accountant", "POST", `${V}/bank-transactions/${un.body.items[0].id}/match`, { partnerType: "customer", partnerId: 1006 });
    expect(m.status).toBe(200);
    expect(m.body.bankTransaction.status).toBe("matched");
    expect(m.body.payment.amount).toBe(99_000);
    const ig = await api("accountant", "POST", `${V}/bank-transactions/${other.body.items[0].id}/match`, { ignore: true, reason: "Giao dịch cá nhân" });
    expect(ig.body.status).toBe("ignored");
  });
});

describe("settlements", () => {
  it("requires a reason when the difference is non-zero; confirm posts vouchers", async () => {
    const body = { source: "fresco", externalRef: "DOISOAT-01", fundId: 2, lines: [{ externalOrderId: "A1", expectedAmount: 1_000_000, receivedAmount: 940_000, feeAmount: 50_000 }] };
    expect((await api("cashier", "POST", `${V}/settlements`, body)).status).toBe(403);
    const no = await api("accountant", "POST", `${V}/settlements`, body);
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe("diff_reason_required");
    const ok = await api("accountant", "POST", `${V}/settlements`, { ...body, diffReason: "Sàn giữ lại 10k phí hoàn" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ expectedAmount: 1_000_000, receivedAmount: 940_000, feeAmount: 50_000, diffAmount: -10_000, status: "draft" });
    const c = await api("accountant", "POST", `${V}/settlements/${ok.body.id}/confirm`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("confirmed");
    expect(c.body.vouchers.map((v: any) => [v.direction, v.amount]).sort()).toEqual([["in", 940_000], ["out", 50_000]]);
    expect((await api("accountant", "POST", `${V}/settlements/${ok.body.id}/confirm`)).status).toBe(409);
    expect((await api("accountant", "POST", `${V}/settlements`, { ...body, diffReason: "x" })).status).toBe(409);
    const zero = await api("accountant", "POST", `${V}/settlements`, { ...body, externalRef: "DOISOAT-02", lines: [{ externalOrderId: "B1", expectedAmount: 100_000, receivedAmount: 95_000, feeAmount: 5_000 }] });
    expect(zero.status).toBe(201);
  });
});

describe("opening balances", () => {
  it("imports as 'Số dư đầu kỳ' invoices/bills, then locks permanently (owner only)", async () => {
    const r = await api("accountant", "POST", `${V}/debts/opening-balances`, [
      { partnerType: "customer", partnerCode: "KH-1001", amount: 123_000, dueDate: d(-100) },
      { partnerType: "supplier", partnerCode: "NCC-A", amount: 77_000, dueDate: d(-50) },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(2);
    const i = await db().prepare(`SELECT note, total FROM invoices WHERE customer_id=1001 AND note='Số dư đầu kỳ'`).first<any>();
    expect(i.total).toBe(123_000);
    expect((await db().prepare(`SELECT COUNT(*) n FROM supplier_bills WHERE note='Số dư đầu kỳ'`).first<{ n: number }>())!.n).toBe(1);
    const bad = await api("accountant", "POST", `${V}/debts/opening-balances`, [{ partnerType: "customer", partnerCode: "KO-CO", amount: 1, dueDate: d(0) }]);
    expect(bad.status).toBe(422);
    expect((await api("accountant", "POST", `${V}/debts/opening-balances/lock`)).status).toBe(403);
    expect((await api("manager", "POST", `${V}/debts/opening-balances/lock`)).status).toBe(403);
    expect((await api("owner", "POST", `${V}/debts/opening-balances/lock`)).status).toBe(200);
    const after = await api("accountant", "POST", `${V}/debts/opening-balances`, [{ partnerType: "customer", partnerCode: "KH-1001", amount: 5, dueDate: d(0) }]);
    expect(after.status).toBe(423);
    expect(after.body.error.code).toBe("opening_locked");
  });
});

describe("reminders", () => {
  it("lists overdue/soon-due customers and enqueues debt.remind jobs", async () => {
    const r = await api("accountant", "GET", `${V}/debts/reminders?days=7`);
    expect(r.status).toBe(200);
    expect(r.body.items.find((x: any) => x.customerId === 1001)).toBeTruthy();
    const s = await api("accountant", "POST", `${V}/debts/reminders/send`, { customerIds: [1001] });
    expect(s.body.queued).toBe(1);
    expect((await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='debt.remind' AND ref_id=1001`).first<{ n: number }>())!.n).toBe(1);
  });
});
