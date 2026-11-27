import { beforeAll, describe, expect, it } from "vitest";
import { api, testEnv } from "./helpers";
import { lotQty, seedSales } from "./seed-sales";
import { seedShop } from "./shop-helpers";
import { enableSepay, hook, tx } from "./sepay-helpers";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uid = () => `uuid-credit-${Date.now()}-${++seq}`;
const set = (k: string, v: string) => db().prepare(`INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(k, v).run();
const line = (qty: number) => ({ productId: 1, unit: "kg", qty }); // Táo 100.000đ/kg
let cseq = 0;
async function retail(opts: { limit?: number; terms?: number; phone?: string | null } = {}) {
  const n = ++cseq;
  const r = await db()
    .prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id, credit_limit, payment_terms_days) VALUES (?, 'retail', ?, ?, 1, ?, ?) RETURNING id`)
    .bind(`KL-T${n}`, `Khách nợ ${n}`, opts.phone === null ? null : opts.phone ?? `09000000${String(n).padStart(2, "0")}`, opts.limit ?? 1_000_000, opts.terms ?? 0)
    .first<{ id: number }>();
  return r!.id;
}
const sell = (role: string, body: any) => api(role, "POST", `${V}/pos/orders`, { clientUuid: uid(), lines: [line(2)], payments: [], ...body });
const invoiceOf = (orderId: number) => db().prepare(`SELECT * FROM invoices WHERE order_id = ? AND kind = 'sale'`).bind(orderId).first<any>();
const outstanding = async (invoiceId: number) =>
  (await db().prepare(`SELECT (i.total + COALESCE((SELECT SUM(a.total) FROM invoices a WHERE a.original_invoice_id = i.id AND a.kind='adjustment' AND a.status='open'),0)
      - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x WHERE x.invoice_id = i.id),0)) AS os FROM invoices i WHERE i.id = ?`).bind(invoiceId).first<{ os: number }>())!.os;
let cashierShift: number;
let managerShift: number;
let ownerShift: number;

beforeAll(async () => {
  await seedShop();
  await seedSales();
  await enableSepay();
  await db().prepare(`UPDATE lots SET qty_in_milli = 500000, qty_on_hand_milli = 500000 WHERE id = 1`).run();
  await set("pos.retail_credit_enabled", "0");
  cashierShift = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 100000 })).body.shift.id;
  managerShift = (await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift.id;
  ownerShift = (await api("owner", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift.id;
});

describe("B1: bán nợ khách lẻ — điều kiện", () => {
  it("mặc định tắt → 409 credit_disabled", async () => {
    const cu = await retail();
    const r = await sell("cashier", { customerId: cu, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("credit_disabled");
  });

  it("bật: không khách / khách không có SĐT → 422 credit_needs_customer", async () => {
    await set("pos.retail_credit_enabled", "1");
    const a = await sell("cashier", { payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe("credit_needs_customer");
    const noPhone = await retail({ phone: null });
    const b = await sell("cashier", { customerId: noPhone, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe("credit_needs_customer");
  });

  it("số ghi nợ phải bằng tổng − đã thu → 422 credit_mismatch", async () => {
    const cu = await retail();
    const r = await sell("cashier", { customerId: cu, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 100000 } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("credit_mismatch");
    // không ghi nợ mà thiếu tiền vẫn là payment_mismatch
    const r2 = await sell("cashier", { customerId: cu, payments: [{ method: "cash", amount: 50000 }] });
    expect(r2.body.error.code).toBe("payment_mismatch");
  });

  it("hạn mức 0 → 409 credit_limit_exceeded (chưa được bán nợ, không có đường duyệt); vượt hạn mức > 0 không duyệt → 409 approval_required; không trừ kho", async () => {
    const before = await lotQty(1);
    const zero = await retail({ limit: 0 });
    const a = await sell("cashier", { customerId: zero, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe("credit_limit_exceeded");
    const small = await retail({ limit: 100000 });
    const b = await sell("cashier", { customerId: small, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("approval_required");
    expect(await lotQty(1)).toBe(before);
  });

  it("vượt hạn mức: quản lý duyệt (order.credit) → qua, dùng một lần, đúng khách + đúng số tiền; chủ cũng phải có phiếu duyệt", async () => {
    const cu = await retail({ limit: 100000 });
    const body = { clientUuid: uid(), customerId: cu, lines: [line(2)], payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } };
    const r1 = await api("cashier", "POST", `${V}/pos/orders`, body);
    expect(r1.body.error.code).toBe("approval_required");
    const aid = r1.body.error.details.approvalId;
    expect((await db().prepare(`SELECT type FROM approvals WHERE id = ?`).bind(aid).first<any>()).type).toBe("order.credit");
    expect((await api("warehouse", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    // sai số tiền / sai khách → không hợp lệ
    const other = await retail({ limit: 100000 });
    expect((await api("cashier", "POST", `${V}/pos/orders`, { ...body, clientUuid: uid(), credit: { amount: 160000 }, payments: [{ method: "cash", amount: 40000 }], approvalId: aid })).body.error.code).toBe("approval_invalid");
    expect((await api("cashier", "POST", `${V}/pos/orders`, { ...body, clientUuid: uid(), customerId: other, approvalId: aid })).body.error.code).toBe("approval_invalid");
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { ...body, approvalId: aid });
    expect(ok.status).toBe(201);
    expect((await invoiceOf(ok.body.id)).total).toBe(150000);
    // dùng lại phiếu duyệt → lỗi, không tạo thêm đơn
    const again = await api("cashier", "POST", `${V}/pos/orders`, { ...body, clientUuid: uid(), approvalId: aid });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("approval_invalid");
    expect((await db().prepare(`SELECT COUNT(*) n FROM invoices WHERE customer_id = ?`).bind(cu).first<any>()).n).toBe(1);
    // chủ không tự bỏ qua: vượt hạn mức vẫn cần phiếu duyệt
    const o = await api("owner", "POST", `${V}/pos/orders`, { ...body, clientUuid: uid(), customerId: other });
    expect(o.body.error.code).toBe("approval_required");
  });

  it("đơn offline (có soldAt) không được ghi nợ", async () => {
    const cu = await retail();
    const r = await sell("cashier", { customerId: cu, soldAt: new Date().toISOString(), payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("credit_offline_not_allowed");
  });
});

describe("B1: bán nợ — hoá đơn, phiếu in, báo cáo", () => {
  let cu: number;
  let order: any;
  let inv: any;
  it("tạo đơn ghi nợ: hoá đơn phải thu đúng số tiền, hạn = ngày bán + kỳ hạn, không HĐĐT", async () => {
    cu = await retail({ limit: 1_000_000, terms: 5 });
    const before = await lotQty(1);
    const r = await sell("cashier", { customerId: cu, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(r.status).toBe(201);
    order = r.body;
    expect(order.total).toBe(200000);
    expect(order.paid_total).toBe(50000);
    expect(order.change).toBe(0);
    expect(await lotQty(1)).toBe(before - 2000); // kho trừ như đơn thường
    expect(order.payments.map((p: any) => [p.method, p.amount, p.fund_id])).toEqual([["cash", 50000, 1], ["credit", 150000, null]]);
    inv = await invoiceOf(order.id);
    expect(inv).toMatchObject({ kind: "sale", customer_id: cu, total: 150000, subtotal: 150000, status: "open", einvoice_status: "not_required", issue_date: vnDate() });
    const due = new Date(Date.parse(vnDate() + "T00:00:00Z") + 5 * 86400_000).toISOString().slice(0, 10);
    expect(inv.due_date).toBe(due);
    expect(await outstanding(inv.id)).toBe(150000);
    // phiếu in: dòng Còn nợ + mã QR HDS
    expect(order.credit).toMatchObject({ invoiceCode: inv.code, amount: 150000, outstanding: 150000, dueDate: due });
    expect(order.credit.payCode).toMatch(/^HDS\d{8}$/);
    expect(order.credit.qrPayload).toContain(order.credit.payCode);
    const rc = await api("cashier", "GET", `${V}/pos/receipt/${order.id}`);
    expect(rc.body.credit.payCode).toBe(order.credit.payCode);
    expect(rc.body.payments.some((p: any) => p.method === "credit" && p.amount === 150000)).toBe(true);
  });

  it("kỳ hạn mặc định khi khách chưa có kỳ hạn riêng (7 ngày)", async () => {
    const c0 = await retail({ terms: 0 });
    const r = await sell("cashier", { customerId: c0, lines: [line(1)], payments: [], credit: { amount: 100000 } });
    expect(r.status).toBe(201);
    const i = await invoiceOf(r.body.id);
    expect(i.due_date).toBe(new Date(Date.parse(vnDate() + "T00:00:00Z") + 7 * 86400_000).toISOString().slice(0, 10));
  });

  it("ghi nợ toàn bộ (không thu đồng nào) được; tiền mặt dự kiến của ca chỉ gồm phần thu tiền mặt", async () => {
    const sum = (await api("cashier", "GET", `${V}/shifts/${cashierShift}/summary`)).body;
    // đã bán: 50.000 tiền mặt (đơn đầu), 0 (đơn 100.000 ghi nợ hết), ... → chỉ phần cash
    const cashRows = (await db().prepare(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.shift_id = ? AND p.method = 'cash'`).bind(cashierShift).first<{ s: number }>())!.s;
    expect(sum.cashFormula.cashSold).toBe(cashRows);
    expect(sum.cashFormula.expected).toBe(100000 + cashRows + sum.cashFormula.debtCollected);
  });

  it("báo cáo cuối ngày: dòng Công nợ trong bảng hình thức thanh toán = phần ghi nợ", async () => {
    const creditSum = (await db().prepare(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.method='credit' AND o.status='completed'`).first<{ s: number }>())!.s;
    expect(creditSum).toBeGreaterThanOrEqual(250000);
    const rep = (await api("manager", "GET", `${V}/reports/daily`)).body;
    const row = rep.byPayment.find((p: any) => p.method === "credit");
    expect(row).toMatchObject({ sold: creditSum, refunded: 0, net: creditSum });
  });

  it("SePay: khách chuyển khoản đúng mã HDS + đúng số còn nợ → gạch đúng hoá đơn này", async () => {
    const t = tx(order.credit.payCode, 150000);
    expect((await hook(t)).body).toEqual({ success: true });
    expect(await outstanding(inv.id)).toBe(0);
    const al = await db().prepare(`SELECT a.invoice_id, a.amount, p.partner_id FROM debt_allocations a JOIN debt_payments p ON p.id = a.payment_id WHERE a.invoice_id = ?`).bind(inv.id).first<any>();
    expect(al).toEqual({ invoice_id: inv.id, amount: 150000, partner_id: cu });
  });
});

describe("B1: duyệt khi ghi nợ vượt ngưỡng", () => {
  it("thu ngân ghi nợ > 500.000đ → cần quản lý duyệt (order.credit); duyệt xong thử lại được; chỉ dùng một lần", async () => {
    const cu = await retail({ limit: 5_000_000 });
    const body = { clientUuid: uid(), customerId: cu, lines: [line(6)], payments: [], credit: { amount: 600000 } };
    const r1 = await api("cashier", "POST", `${V}/pos/orders`, body);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe("approval_required");
    const aid = r1.body.error.details.approvalId;
    const a = await db().prepare(`SELECT type, status FROM approvals WHERE id = ?`).bind(aid).first<any>();
    expect(a).toMatchObject({ type: "order.credit", status: "pending" });
    expect((await api("cashier", "POST", `${V}/pos/orders`, { ...body, approvalId: aid })).body.error.code).toBe("approval_required"); // còn chờ
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    // đổi số ghi nợ sau khi duyệt → mã duyệt không còn hợp lệ
    const bad = await api("cashier", "POST", `${V}/pos/orders`, { ...body, clientUuid: uid(), lines: [line(7)], credit: { amount: 700000 }, approvalId: aid });
    expect(bad.body.error.code).toBe("approval_invalid");
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { ...body, approvalId: aid });
    expect(ok.status).toBe(201);
    expect((await invoiceOf(ok.body.id)).total).toBe(600000);
    const again = await api("cashier", "POST", `${V}/pos/orders`, { ...body, clientUuid: uid(), approvalId: aid });
    expect(again.body.error.code).toBe("approval_invalid");
  });

  it("quản lý (có pos.credit) ghi nợ vượt ngưỡng không cần duyệt; thu ngân ghi nợ ≤ ngưỡng không cần duyệt", async () => {
    const cu = await retail({ limit: 5_000_000 });
    const m = await api("manager", "POST", `${V}/pos/orders`, { clientUuid: uid(), customerId: cu, lines: [line(6)], payments: [], credit: { amount: 600000 } });
    expect(m.status).toBe(201);
    const c = await sell("cashier", { customerId: cu, lines: [line(5)], payments: [], credit: { amount: 500000 } });
    expect(c.status).toBe(201);
  });
});

describe("B1: hai quầy ghi nợ đồng thời", () => {
  it("hạn mức 300.000, mỗi quầy ghi nợ 200.000 → chỉ một đơn qua, kho chỉ trừ một lần", async () => {
    const cu = await retail({ limit: 300000 });
    const before = await lotQty(1);
    const [a, b] = await Promise.all([
      sell("manager", { customerId: cu, payments: [], credit: { amount: 200000 } }),
      sell("owner", { customerId: cu, payments: [], credit: { amount: 200000 } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const fail = a.status === 409 ? a : b;
    expect(fail.body.error.code).toBe("credit_limit_exceeded");
    expect(await lotQty(1)).toBe(before - 2000);
    const n = await db().prepare(`SELECT COUNT(*) n, SUM(total) t FROM invoices WHERE customer_id = ?`).bind(cu).first<any>();
    expect(n).toEqual({ n: 1, t: 200000 });
    const orphan = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE customer_id = ? AND status = 'completed'`).bind(cu).first<any>();
    expect(orphan.n).toBe(1);
  });
});

describe("B1: thu nợ tại quầy", () => {
  it("thu tiền mặt vào quỹ ca → có trong tiền mặt dự kiến; quá số nợ bị chặn; cần ca mở", async () => {
    const cu = await retail({ limit: 1_000_000 });
    const o = await sell("cashier", { customerId: cu, payments: [], credit: { amount: 200000 } });
    const inv = await invoiceOf(o.body.id);
    const before = (await api("cashier", "GET", `${V}/shifts/${cashierShift}/summary`)).body.cashFormula;
    const debts = await api("cashier", "GET", `${V}/pos/customers/${cu}/debts`);
    expect(debts.status).toBe(200);
    expect(debts.body).toMatchObject({ outstanding: 200000, available: 800000 });
    expect(debts.body.invoices).toHaveLength(1);
    expect(debts.body.invoices[0]).toMatchObject({ id: inv.id, outstanding: 200000, orderCode: o.body.code });

    const over = await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 300000, method: "cash", idempotencyKey: uid() });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("amount_exceeds_debt");
    const key = uid();
    const pay = await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 120000, method: "cash", invoiceId: inv.id, idempotencyKey: key });
    expect(pay.status).toBe(201);
    expect(pay.body.allocations[0]).toMatchObject({ amount: 120000 });
    expect((await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 50000, method: "cash", idempotencyKey: key })).body.error.code).toBe("already_done");
    expect(await outstanding(inv.id)).toBe(80000);

    const after = (await api("cashier", "GET", `${V}/shifts/${cashierShift}/summary`)).body.cashFormula;
    expect(after.debtCollected - before.debtCollected).toBe(120000);
    expect(after.expected - before.expected).toBe(120000);
    // phiếu thu nằm ở quỹ tiền mặt của ca
    const v = await db().prepare(`SELECT v.fund_id, v.direction, v.amount FROM debt_payments p JOIN cash_vouchers v ON v.id = p.cash_voucher_id WHERE p.partner_id = ? ORDER BY p.id DESC LIMIT 1`).bind(cu).first<any>();
    expect(v).toEqual({ fund_id: 1, direction: "in", amount: 120000 });

    // chuyển khoản vào quỹ ngân hàng — không vào tiền mặt ca
    const tf = await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 80000, method: "transfer", ref: "FT-ABC", idempotencyKey: uid() });
    expect(tf.status).toBe(201);
    expect(await outstanding(inv.id)).toBe(0);
    expect((await api("cashier", "GET", `${V}/shifts/${cashierShift}/summary`)).body.cashFormula.expected).toBe(after.expected);
    // hết nợ → không còn gì để thu
    expect((await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 1000, method: "cash", idempotencyKey: uid() })).body.error.code).toBe("no_open_documents");
  });

  it("chốt ca: tiền mặt dự kiến gồm thu nợ của ca", async () => {
    const mgr = await retail({ limit: 1_000_000 });
    await sell("manager", { customerId: mgr, payments: [], credit: { amount: 200000 } });
    expect((await api("manager", "POST", `${V}/pos/debt-payments`, { customerId: mgr, amount: 50000, method: "cash", idempotencyKey: uid() })).status).toBe(201);
    const sum = (await api("manager", "GET", `${V}/shifts/${managerShift}/summary`)).body;
    const close = await api("manager", "POST", `${V}/shifts/${managerShift}/close`, { countedCash: 0 });
    expect(close.status).toBe(422); // chênh lệch → cần lý do (dự kiến ≠ 0)
    expect(close.body.error.details.expectedCash).toBe(sum.cashFormula.expected);
    expect(sum.cashFormula.debtCollected).toBeGreaterThanOrEqual(50000);
  });
});

describe("B1: trả hàng / huỷ đơn có ghi nợ", () => {
  it("trả hàng trừ vào nợ còn lại trước (hoá đơn adjustment âm), phần vượt mới hoàn tiền", async () => {
    const cu = await retail({ limit: 1_000_000 });
    const o = await sell("cashier", { customerId: cu, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    const inv = await invoiceOf(o.body.id);
    const l = o.body.lines[0];
    // trả 1kg (100.000đ): nợ 150.000 → 50.000, không hoàn tiền
    const r1 = await api("cashier", "POST", `${V}/orders/${o.body.id}/return`, { refundMethod: "cash", lines: [{ orderLineId: l.id, qty: 1, unit: "kg", restock: true, reason: "khách đổi ý" }] });
    expect(r1.status).toBe(201);
    expect(r1.body.total).toBe(100000);
    expect(r1.body.payments.map((p: any) => [p.method, p.amount])).toEqual([["credit", -100000]]);
    const adj = await db().prepare(`SELECT * FROM invoices WHERE original_invoice_id = ?`).bind(inv.id).first<any>();
    expect(adj).toMatchObject({ kind: "adjustment", total: -100000, customer_id: cu, due_date: inv.due_date, einvoice_status: "not_required" });
    expect(await outstanding(inv.id)).toBe(50000);
    // trả nốt 1kg: trừ nợ 50.000 + hoàn tiền mặt 50.000
    const r2 = await api("cashier", "POST", `${V}/orders/${o.body.id}/return`, { refundMethod: "cash", lines: [{ orderLineId: l.id, qty: 1, unit: "kg", restock: true, reason: "trả nốt" }] });
    expect(r2.status).toBe(201);
    expect(r2.body.payments.map((p: any) => [p.method, p.amount])).toEqual([["cash", -50000], ["credit", -50000]]);
    expect(await outstanding(inv.id)).toBe(0);
    // báo cáo: dòng Công nợ trừ phần đã trừ vào nợ
    const rep = (await api("manager", "GET", `${V}/reports/daily`)).body.byPayment.find((p: any) => p.method === "credit");
    expect(rep.refunded).toBeGreaterThanOrEqual(150000);
  });

  it("huỷ đơn chưa thu đồng nào → hoá đơn adjustment bằng toàn bộ; đã thu một phần → 409 dùng Trả hàng", async () => {
    const cu = await retail({ limit: 1_000_000 });
    const a = await sell("cashier", { customerId: cu, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    const ia = await invoiceOf(a.body.id);
    const v = await api("manager", "POST", `${V}/orders/${a.body.id}/void`, { reason: "nhập nhầm" });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe("cancelled");
    expect(await outstanding(ia.id)).toBe(0);
    const adj = await db().prepare(`SELECT total, kind FROM invoices WHERE original_invoice_id = ?`).bind(ia.id).first<any>();
    expect(adj).toEqual({ total: -150000, kind: "adjustment" });
    // đã thu một phần
    const b = await sell("cashier", { customerId: cu, payments: [], credit: { amount: 200000 } });
    expect((await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 10000, method: "cash", idempotencyKey: uid() })).status).toBe(201);
    const v2 = await api("manager", "POST", `${V}/orders/${b.body.id}/void`, { reason: "nhập nhầm" });
    expect(v2.status).toBe(409);
    expect(v2.body.error.code).toBe("credit_already_paid");
    // đơn có ghi nợ không đổi hàng
    const ex = await api("cashier", "POST", `${V}/orders/${b.body.id}/exchange`, { clientUuid: uid(), returnLines: [{ orderLineId: b.body.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "đổi hàng" }], newLines: [line(1)], payments: [] });
    expect(ex.body.error.code).toBe("credit_order_no_exchange");
  });
});

describe("B1: khách lẻ — hạn mức, kỳ hạn, tab công nợ", () => {
  it("quản lý đặt hạn mức trong ngưỡng được ngay; vượt ngưỡng → chờ chủ duyệt; thu ngân không được", async () => {
    const cu = await retail({ limit: 0 });
    const d = (await api("manager", "GET", `${V}/retail-customers/${cu}`)).body;
    expect(d.creditLimit).toBe(0);
    expect((await api("cashier", "PUT", `${V}/retail-customers/${cu}/credit`, { version: d.version, creditLimit: 1000000, reason: "thử" })).status).toBe(403);
    const ok = await api("manager", "PUT", `${V}/retail-customers/${cu}/credit`, { version: d.version, creditLimit: 2_000_000, paymentTermsDays: 10, reason: "khách thân thiết" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ creditLimit: 2_000_000, paymentTermsDays: 10 });
    const big = await api("manager", "PUT", `${V}/retail-customers/${cu}/credit`, { version: ok.body.version, creditLimit: 80_000_000, reason: "mua sỉ" });
    expect(big.status).toBe(200);
    expect(big.body).toMatchObject({ creditLimit: 2_000_000, creditApprovalPending: true, requestedCreditLimit: 80_000_000 });
    const ap = await db().prepare(`SELECT id FROM approvals WHERE type='customer.credit_change' AND ref_id = ? AND status='pending'`).bind(String(cu)).first<{ id: number }>();
    expect((await api("owner", "POST", `${V}/approvals/${ap!.id}/decide`, { decision: "approved" })).status).toBe(200);
    const d2 = (await api("manager", "GET", `${V}/retail-customers/${cu}`)).body;
    expect(d2.creditLimit).toBe(80_000_000);
    expect((await api("manager", "PUT", `${V}/retail-customers/${cu}/credit`, { version: 1, creditLimit: 5, reason: "bản cũ" })).body.error.code).toBe("version_conflict");
  });

  it("chi tiết khách có tab công nợ cho người xem công nợ, ẩn với người không có quyền", async () => {
    const cu = await retail({ limit: 1_000_000 });
    const o = await sell("cashier", { customerId: cu, payments: [], credit: { amount: 200000 } });
    const d = (await api("manager", "GET", `${V}/retail-customers/${cu}`)).body;
    expect(d.debt).toMatchObject({ outstanding: 200000, available: 800000 });
    expect(d.debt.invoices[0]).toMatchObject({ outstanding: 200000, orderCode: o.body.code });
    const hidden = (await api("online_staff", "GET", `${V}/retail-customers/${cu}`)).body;
    expect(hidden.debt).toBeNull();
  });

  it("khách lẻ mới tạo ở quầy nhận hạn mức/kỳ hạn mặc định theo cài đặt", async () => {
    await set("pos.retail_credit_default_limit", "300000");
    const r = await api("cashier", "POST", `${V}/pos/customers`, { name: "Khách mới", phone: "0912345678" });
    expect(r.status).toBe(201);
    const row = await db().prepare(`SELECT credit_limit, payment_terms_days FROM customers WHERE id = ?`).bind(r.body.id).first<any>();
    expect(row).toEqual({ credit_limit: 300000, payment_terms_days: 7 });
    await set("pos.retail_credit_default_limit", "0");
  });
});

describe("B1: kỳ đã khoá sổ", () => {
  it("kỳ hiện tại khoá → ghi nợ 423 period_locked, không tạo hoá đơn/đơn", async () => {
    const cu = await retail();
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1) ON CONFLICT(period) DO UPDATE SET locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(vnPeriod()).run();
    const before = (await db().prepare(`SELECT COUNT(*) n FROM invoices`).first<any>()).n;
    const r = await sell("cashier", { customerId: cu, payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe("period_locked");
    expect((await db().prepare(`SELECT COUNT(*) n FROM invoices`).first<any>()).n).toBe(before);
    await db().prepare(`UPDATE periods SET locked_at = NULL WHERE period = ?`).bind(vnPeriod()).run();
  });
});
