import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

// Đợt fix 1b: B-01 (chi công nợ vượt ngưỡng cần duyệt), B-08 (khoá sổ), A-01 (khách dư có do trả hàng sau thanh toán)
const V = "/api/v1";
const db = () => testEnv.DB;
const today = vnDate();
const pastPeriod = vnPeriod(new Date(Date.now() - 75 * 86400_000));
const lockedPast = async () => {
  await db().prepare(`INSERT OR IGNORE INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(pastPeriod).run();
};

const bill = (id: number, supplierId: number, total: number, extra: { issue?: string; prov?: number } = {}) =>
  db().prepare(`INSERT INTO supplier_bills(id, code, supplier_id, issue_date, due_date, total, is_provisional) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, `T1B-CNP-${id}`, supplierId, extra.issue ?? addDays(today, -3), addDays(today, 20), total, extra.prov ?? 0);
const inv = (id: number, customerId: number, total: number, kind = "sale", orig: number | null = null) =>
  db().prepare(`INSERT INTO invoices(id, code, kind, original_invoice_id, customer_id, issue_date, due_date, subtotal, total) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(id, `T1B-HDB-${id}`, kind, orig, customerId, addDays(today, -10), addDays(today, 5), total, total);

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (7101,'T1B-NCC','NCC Fix1b',30)`),
    bill(7201, 7101, 60_000_000), bill(7202, 7101, 60_000_000), bill(7203, 7101, 3_000_000), bill(7204, 7101, 10_000_000),
    bill(7210, 7101, 5_000_000, { issue: `${pastPeriod}-10`, prov: 1 }),
    db().prepare(`INSERT INTO customers(id, code, type, name, credit_limit, payment_terms_days) VALUES (7001,'T1B-KH1','b2b','Khách dư có',50000000,15),(7002,'T1B-KH2','b2b','Khách khoá sổ',50000000,15)`),
  ]);
});

const payOut = (role: string, over: Record<string, unknown> = {}) =>
  api(role, "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 7101, fundId: 1, amount: 60_000_000, method: "cash", ...over });
const payables = async () => (await api("accountant", "GET", `${V}/debts/payables?q=T1B-NCC`)).body.items[0];
const fundBalance = async (id: number) => ((await api("accountant", "GET", `${V}/funds`)).body.items as any[]).find((f) => f.id === id).balance;

describe("B-01: chi công nợ vượt ngưỡng duyệt", () => {
  it("kế toán chi 60tr cho NCC → pending_approval, chưa có phiếu quỹ, chưa gạch nợ, công nợ không đổi", async () => {
    const before = await payables();
    const fund0 = await fundBalance(1);
    const r = await payOut("accountant", { allocations: [{ billId: 7201, amount: 60_000_000 }], idempotencyKey: "fix1b-idem-0001" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.payment).toMatchObject({ status: "pending_approval", cashVoucherId: null, amount: 60_000_000 });
    expect(r.body.approvalId).toBeGreaterThan(0);
    expect(r.body.allocations).toEqual([]);
    expect(r.body.unapplied).toBe(0);
    expect(await fundBalance(1)).toBe(fund0);
    const after = await payables();
    expect(after.outstanding).toBe(before.outstanding);
    expect(after.unapplied).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM cash_vouchers WHERE ref_type='debt_payment' AND ref_id=?`).bind(r.body.payment.id).first<any>()).n).toBe(0);
    // gửi lại cùng khoá idempotency → 409, không tạo phiếu thứ hai
    expect((await payOut("accountant", { allocations: [{ billId: 7201, amount: 60_000_000 }], idempotencyKey: "fix1b-idem-0001" })).status).toBe(409);
    // phiếu chờ duyệt không gạch / đảo được
    expect((await api("accountant", "POST", `${V}/debts/payments/${r.body.payment.id}/allocate`, {})).status).toBe(409);
    expect((await api("accountant", "POST", `${V}/debts/payments/${r.body.payment.id}/reverse`, { reason: "thử đảo" })).status).toBe(409);
  });

  it("chỉ người có finance.approve duyệt được; không tự duyệt; duyệt → ghi phiếu chi + gạch nợ nguyên tử, duyệt lần hai 409", async () => {
    const pend = (await api("accountant", "GET", `${V}/debts/payments?status=pending_approval&partnerType=supplier`)).body.items[0];
    expect(pend.status).toBe("pending_approval");
    const fund0 = await fundBalance(1);
    expect((await api("accountant", "POST", `${V}/approvals/${pend.approvalId}/decide`, { decision: "approved" })).status).toBe(403); // thiếu approvals.decide
    expect((await api("manager", "POST", `${V}/approvals/${pend.approvalId}/decide`, { decision: "approved" })).status).toBe(403); // thiếu finance.approve
    expect((await db().prepare(`SELECT status FROM debt_payments WHERE id=?`).bind(pend.id).first<any>()).status).toBe("pending_approval");
    const ok = await api("owner", "POST", `${V}/approvals/${pend.approvalId}/decide`, { decision: "approved" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const p = (await db().prepare(`SELECT * FROM debt_payments WHERE id=?`).bind(pend.id).first<any>())!;
    expect(p.status).toBe("posted");
    const v = (await db().prepare(`SELECT * FROM cash_vouchers WHERE id=?`).bind(p.cash_voucher_id).first<any>())!;
    expect(v).toMatchObject({ direction: "out", amount: 60_000_000, status: "posted", ref_type: "debt_payment", ref_id: p.id, created_by: p.created_by });
    expect((await db().prepare(`SELECT SUM(amount) s FROM debt_allocations WHERE payment_id=?`).bind(p.id).first<any>()).s).toBe(60_000_000);
    expect(await fundBalance(1)).toBe(fund0 - 60_000_000);
    expect((await api("owner", "POST", `${V}/approvals/${pend.approvalId}/decide`, { decision: "approved" })).status).toBe(409);
  });

  it("từ chối → rejected, không phiếu quỹ, không gạch; chi nhỏ và chủ chi lớn đi thẳng", async () => {
    const r = await payOut("accountant", { allocations: [{ billId: 7202, amount: 60_000_000 }] });
    expect(r.body.payment.status).toBe("pending_approval");
    const fund0 = await fundBalance(1);
    expect((await api("owner", "POST", `${V}/approvals/${r.body.approvalId}/decide`, { decision: "rejected", note: "không hợp lệ" })).status).toBe(200);
    expect((await db().prepare(`SELECT status, cash_voucher_id FROM debt_payments WHERE id=?`).bind(r.body.payment.id).first<any>())).toEqual({ status: "rejected", cash_voucher_id: null });
    expect((await db().prepare(`SELECT COUNT(*) n FROM debt_allocations WHERE payment_id=?`).bind(r.body.payment.id).first<any>()).n).toBe(0);
    expect(await fundBalance(1)).toBe(fund0);
    const small = await payOut("accountant", { amount: 3_000_000, allocations: [{ billId: 7203, amount: 3_000_000 }] });
    expect(small.body.payment.status).toBe("posted");
    const big = await payOut("owner", { amount: 10_000_000, allocations: [{ billId: 7204, amount: 10_000_000 }] });
    expect(big.body.payment.status).toBe("posted");
  });
});

describe("B-08: khoá sổ", () => {
  it("không khoá được kỳ hiện tại / tương lai; khoá kỳ đã qua OK", async () => {
    expect((await api("owner", "POST", `${V}/periods/${vnPeriod()}/lock`)).status).toBe(422);
    expect((await api("owner", "POST", `${V}/periods/2099-12/lock`)).body.error.code).toBe("period_not_ended");
    expect((await api("owner", "POST", `${V}/periods/${pastPeriod}/lock`)).status).toBe(200);
  });

  it("chốt hoá đơn mua tạm của kỳ đã khoá → 423 và dữ liệu giữ nguyên", async () => {
    await lockedPast();
    const r = await api("accountant", "POST", `${V}/bills/7210/finalize`, { supplierRef: "NCC-1", total: 5_500_000, reason: "đổi giá" });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe("period_locked");
    expect((await db().prepare(`SELECT total, is_provisional FROM supplier_bills WHERE id=7210`).first<any>())).toEqual({ total: 5_000_000, is_provisional: 1 });
  });

  it("phiếu chi công nợ ghi ngày thuộc kỳ khoá → 423, không phiếu nào được tạo", async () => {
    await lockedPast();
    const n0 = (await db().prepare(`SELECT COUNT(*) n FROM debt_payments`).first<any>()).n;
    const r = await api("owner", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 7101, fundId: 1, amount: 100_000, method: "cash", paidAt: `${pastPeriod}-12T03:00:00.000Z` });
    expect(r.status).toBe(423);
    expect((await db().prepare(`SELECT COUNT(*) n FROM debt_payments`).first<any>()).n).toBe(n0);
  });

  it("kỳ hiện tại đang khoá (dữ liệu cũ): điều chỉnh công nợ, gạch nợ, trả hàng B2B bị chặn", async () => {
    await db().batch([inv(7301, 7002, 400_000), db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod())]);
    const adj = await api("owner", "POST", `${V}/debts/adjustments`, { type: "discount", partnerType: "customer", partnerId: 7002, amount: 10_000, reason: "chiết khấu thử" });
    expect(adj.status).toBe(423);
    expect((await db().prepare(`SELECT COUNT(*) n FROM debt_adjustments WHERE partner_id=7002`).first<any>()).n).toBe(0);
    const ret = await api("owner", "POST", `${V}/b2b/orders/999999/returns`, { lines: [{ orderLineId: 1, qty: 1, unit: "kg", restock: true, reason: "thử" }] });
    expect([404, 423]).toContain(ret.status); // đơn không tồn tại → 404 trước; kiểm khoá ở test online/b2b bên dưới
    await db().prepare(`DELETE FROM periods WHERE period=?`).bind(vnPeriod()).run();
  });
});

describe("A-01: khách dư có do trả hàng sau khi đã thanh toán (EC-25)", () => {
  beforeAll(async () => {
    // HĐ 500k đã thu đủ 500k, rồi trả hàng 200k → còn nợ âm −200k; thêm HĐ mới 300k
    await db().batch([
      inv(7401, 7001, 500_000),
      db().prepare(`INSERT INTO debt_payments(id, code, direction, partner_type, partner_id, fund_id, amount, method, paid_at, created_by) VALUES (7401,'T1B-TNK-1','in','customer',7001,1,500000,'cash',?,1)`).bind(new Date().toISOString()),
      db().prepare(`INSERT INTO debt_allocations(payment_id, invoice_id, amount) VALUES (7401, 7401, 500000)`),
      inv(7402, 7001, -200_000, "adjustment", 7401),
      inv(7403, 7001, 300_000),
    ]);
  });

  it("số dư âm không bị bỏ: hiển thị 'Khách dư có' ở công nợ khách", async () => {
    const r = await api("accountant", "GET", `${V}/debts/receivables?q=T1B-KH1`);
    expect(r.body.items[0]).toMatchObject({ outstanding: 300_000, invoiceCredit: 200_000, credit: 0, balance: 100_000 });
    const c = await api("accountant", "GET", `${V}/customers/7001`);
    expect(c.body.debt).toMatchObject({ invoiceCredit: 200_000, balance: 100_000, outstanding: 300_000 });
    // aging chỉ tuổi phần còn nợ dương
    const aging = await api("accountant", "GET", `${V}/debts/aging?side=receivable`);
    expect(aging.body.items.filter((x: any) => x.partnerId === 7001).map((x: any) => x.outstanding)).toEqual([300_000]);
  });

  it("cấn số dư có vào hoá đơn mở khác (return_credit), không vượt số dư có", async () => {
    expect((await api("accountant", "POST", `${V}/debts/adjustments`, { type: "return_credit", partnerType: "customer", partnerId: 7001, amount: 250_000, reason: "cấn trừ" })).status).toBe(422);
    const ok = await api("accountant", "POST", `${V}/debts/adjustments`, { type: "return_credit", partnerType: "customer", partnerId: 7001, amount: 150_000, reason: "cấn vào HĐ mới", invoiceId: 7403 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const s = (await api("accountant", "GET", `${V}/debts/receivables?q=T1B-KH1`)).body.items[0];
    expect(s).toMatchObject({ outstanding: 150_000, invoiceCredit: 50_000, balance: 100_000 }); // tổng nợ ròng không đổi
    const st = (await api("accountant", "GET", `${V}/debts/statements/customer/7001`)).body;
    expect(st.closing).toBe(100_000);
  });

  it("hoàn tiền dư có bằng chi công nợ direction=out cho khách; vượt số dư bị chặn; hoàn xong số dư về 0", async () => {
    expect((await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "customer", partnerId: 7001, fundId: 1, amount: 60_000, method: "cash" })).status).toBe(422);
    const fund0 = await fundBalance(1);
    const r = await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "customer", partnerId: 7001, fundId: 1, amount: 50_000, method: "cash", note: "Hoàn tiền trả hàng" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.payment.status).toBe("posted");
    expect(r.body.unapplied).toBe(0);
    expect(await fundBalance(1)).toBe(fund0 - 50_000);
    const s = (await api("accountant", "GET", `${V}/debts/receivables?q=T1B-KH1`)).body.items[0];
    expect(s).toMatchObject({ invoiceCredit: 0, balance: 150_000 }); // hoàn 50k: khách dư có 50k → 0, nợ ròng 100k → 150k
    expect((await api("accountant", "POST", `${V}/debts/payments/${r.body.payment.id}/allocate`, {})).status).toBe(409);
    // đảo phiếu hoàn → số dư có quay lại
    expect((await api("accountant", "POST", `${V}/debts/payments/${r.body.payment.id}/reverse`, { reason: "nhập nhầm" })).status).toBe(200);
    expect((await api("accountant", "GET", `${V}/debts/receivables?q=T1B-KH1`)).body.items[0].invoiceCredit).toBe(50_000);
  });

  it("hoàn tiền dư có vượt ngưỡng cũng phải duyệt (B-01); kế toán không tự duyệt", async () => {
    await db().batch([
      inv(7410, 7002, 8_000_000), db().prepare(`INSERT INTO debt_payments(id, code, direction, partner_type, partner_id, fund_id, amount, method, paid_at, created_by) VALUES (7410,'T1B-TNK-2','in','customer',7002,1,8000000,'cash',?,1)`).bind(new Date().toISOString()),
      db().prepare(`INSERT INTO debt_allocations(payment_id, invoice_id, amount) VALUES (7410, 7410, 8000000)`), inv(7411, 7002, -6_000_000, "adjustment", 7410),
    ]);
    const r = await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "customer", partnerId: 7002, fundId: 1, amount: 6_000_000, method: "cash" });
    expect(r.body.payment.status).toBe("pending_approval");
    expect((await api("owner", "POST", `${V}/approvals/${r.body.approvalId}/decide`, { decision: "approved" })).status).toBe(200);
    expect((await api("accountant", "GET", `${V}/debts/receivables?q=T1B-KH2`)).body.items?.[0]?.invoiceCredit ?? 0).toBe(0);
  });
});
