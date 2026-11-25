import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

// Fix 5c: B-12 trả hàng NCC, B-21 số dư đầu kỳ không vào VAT, B-22 từ chối phiếu chi chờ duyệt của kỳ đã khoá
const V = "/api/v1";
const db = () => testEnv.DB;
const today = vnDate();
const period = vnPeriod();

/** Phiếu nhập đã ghi sổ qua API: sinh lô + hoá đơn mua (không tạm tính). */
async function receipt(supplierId: number, productId: number, qty: number, unitCost: number, ref: string) {
  const d = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId, supplierRef: ref });
  expect(d.status).toBe(201);
  expect((await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { productId, unit: "kg", qty, unitCost })).status).toBe(201);
  expect((await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`)).status).toBe(200);
  const lot = await db().prepare(`SELECT * FROM lots WHERE receipt_doc_id = ?`).bind(d.body.id).first<any>();
  const bill = await db().prepare(`SELECT * FROM supplier_bills WHERE stock_doc_id = ?`).bind(d.body.id).first<any>();
  return { docId: d.body.id as number, lot, bill };
}
const outstanding = async (billId: number) =>
  (await db().prepare(`SELECT b.total - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x LEFT JOIN debt_payments p ON p.id=x.payment_id LEFT JOIN debt_adjustments d ON d.id=x.adjustment_id WHERE x.bill_id=b.id AND (p.status='posted' OR d.status='posted')),0) AS os FROM supplier_bills b WHERE b.id=?`).bind(billId).first<any>()).os as number;
const onHand = async (lotId: number) => (await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=?`).bind(lotId).first<any>()).q as number;

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (5301,'F5C-NCC','NCC 5c',7)`),
    db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (5301,'F5C-A','Cam 5c','kg')`),
  ]);
});

describe("B-12: trả hàng NCC", () => {
  it("trả một phần: xuất kho theo lô, debit note giảm công nợ, thẻ kho + nhật ký", async () => {
    const r = await receipt(5301, 5301, 100, 20_000, "HD-5C-1"); // 2.000.000
    expect(r.bill.total).toBe(2_000_000);
    const res = await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Hàng dập", lines: [{ lotId: r.lot.id, qty: 30 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("posted");
    expect(res.body.total).toBe(600_000);
    expect(res.body.creditedAmount).toBe(600_000);
    expect(await onHand(r.lot.id)).toBe(70_000);
    expect(await outstanding(r.bill.id)).toBe(1_400_000);
    const mv = await db().prepare(`SELECT qty_delta_milli q, move_type t FROM stock_moves WHERE ref_type='purchase_return' AND ref_id=?`).bind(res.body.id).first<any>();
    expect([mv.q, mv.t]).toEqual([-30_000, "return_supplier"]);
    const adj = await db().prepare(`SELECT type, partner_type, amount FROM debt_adjustments WHERE code=?`).bind(res.body.adjustmentCode).first<any>();
    expect([adj.type, adj.partner_type, adj.amount]).toEqual(["return_credit", "supplier", 600_000]);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='purchase_return.post' AND entity_id=?`).bind(String(res.body.id)).first<any>()).n).toBe(1);
    // vượt tồn còn lại của lô → 409; lô không thuộc phiếu → 422
    const over = await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Trả thêm", lines: [{ lotId: r.lot.id, qty: 71 }] });
    expect(over.status).toBe(409);
    const other = await receipt(5301, 5301, 10, 10_000, "HD-5C-X");
    expect((await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Sai lô", lines: [{ lotId: other.lot.id, qty: 1 }] })).status).toBe(422);
  });

  it("trả toàn bộ hoá đơn chưa thanh toán → huỷ hoá đơn, VAT đầu vào loại hoá đơn đó", async () => {
    const before = (await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body.input.count as number;
    const r = await receipt(5301, 5301, 50, 10_000, "HD-5C-2");
    expect((await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body.input.count).toBe(before + 1);
    const res = await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Nhập nhầm", lines: [{ lotId: r.lot.id, qty: 50 }] });
    expect(res.status).toBe(201);
    expect(res.body.billCancelled).toBe(true);
    expect((await db().prepare(`SELECT status FROM supplier_bills WHERE id=?`).bind(r.bill.id).first<any>()).status).toBe("cancelled");
    expect(await onHand(r.lot.id)).toBe(0);
    expect((await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body.input.count).toBe(before);
  });

  it("hoá đơn đã thanh toán đủ: vẫn trả hàng, phần NCC phải hoàn ghi vào refund_due", async () => {
    const r = await receipt(5301, 5301, 10, 10_000, "HD-5C-3"); // 100.000
    await db().batch([
      db().prepare(`INSERT INTO debt_payments(id, code, direction, partner_type, partner_id, fund_id, amount, method, paid_at, status, created_by) VALUES (95301,'TTN-F5C-1','out','supplier',5301,1,100000,'cash',?, 'posted',1)`).bind(today),
      db().prepare(`INSERT INTO debt_allocations(payment_id, bill_id, amount) VALUES (95301, ?, 100000)`).bind(r.bill.id),
    ]);
    const res = await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Hàng hỏng", lines: [{ lotId: r.lot.id, qty: 4 }] });
    expect(res.status).toBe(201);
    expect([res.body.total, res.body.creditedAmount, res.body.refundDue]).toEqual([40_000, 0, 40_000]);
    expect(await onHand(r.lot.id)).toBe(6_000);
  });

  it("thủ kho lập phiếu → chờ duyệt (chưa trừ kho); quản lý duyệt → ghi sổ; từ chối → rejected", async () => {
    const r = await receipt(5301, 5301, 20, 10_000, "HD-5C-4");
    const p = await api("warehouse", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Hàng dập", lines: [{ lotId: r.lot.id, qty: 5 }] });
    expect(p.status).toBe(201);
    expect(p.body.status).toBe("pending_approval");
    expect(await onHand(r.lot.id)).toBe(20_000);
    const ap = (await db().prepare(`SELECT id FROM approvals WHERE type='purchase_return.post' AND ref_id=?`).bind(String(p.body.id)).first<any>()).id;
    expect((await api("warehouse", "POST", `${V}/approvals/${ap}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/approvals/${ap}/decide`, { decision: "approved" })).status).toBe(200);
    expect(await onHand(r.lot.id)).toBe(15_000);
    expect(await outstanding(r.bill.id)).toBe(150_000);
    expect((await api("manager", "GET", `${V}/purchase-returns/${p.body.id}`)).body.status).toBe("posted");

    const p2 = await api("warehouse", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Trả tiếp", lines: [{ lotId: r.lot.id, qty: 2 }] });
    const ap2 = (await db().prepare(`SELECT id FROM approvals WHERE type='purchase_return.post' AND ref_id=?`).bind(String(p2.body.id)).first<any>()).id;
    expect((await api("owner", "POST", `${V}/approvals/${ap2}/decide`, { decision: "rejected" })).status).toBe(200);
    expect((await api("manager", "GET", `${V}/purchase-returns/${p2.body.id}`)).body.status).toBe("rejected");
    expect(await onHand(r.lot.id)).toBe(15_000);
    // người lập tự huỷ phiếu chờ duyệt
    const p3 = await api("warehouse", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Nhầm", lines: [{ lotId: r.lot.id, qty: 1 }] });
    expect((await api("warehouse", "POST", `${V}/purchase-returns/${p3.body.id}/cancel`)).status).toBe(200);
  });

  it("kỳ đã khoá sổ → 423; vai trò không có quyền → 403; giá vốn bị ẩn với người không có quyền xem giá vốn", async () => {
    const r = await receipt(5301, 5301, 10, 10_000, "HD-5C-5");
    await db().prepare(`INSERT OR REPLACE INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(period).run();
    const locked = await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Trả", lines: [{ lotId: r.lot.id, qty: 1 }] });
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(period).run();
    expect(locked.status).toBe(423);
    expect(await onHand(r.lot.id)).toBe(10_000);
    expect((await api("cashier", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Trả", lines: [{ lotId: r.lot.id, qty: 1 }] })).status).toBe(403);
    expect((await api("accountant", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Trả", lines: [{ lotId: r.lot.id, qty: 1 }] })).status).toBe(403);
    const ok = await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r.docId, reason: "Trả", lines: [{ lotId: r.lot.id, qty: 1 }] });
    expect(ok.status).toBe(201);
    const asCashier = await api("cashier", "GET", `${V}/purchase-returns/${ok.body.id}`);
    expect(asCashier.status).toBe(200);
    expect(asCashier.body.total).toBeUndefined();
    expect(asCashier.body.lines[0].unitCost).toBeUndefined();
  });
});

describe("B-21: số dư đầu kỳ không vào cơ sở VAT", () => {
  it("nhập số dư đầu kỳ khách + NCC → báo cáo VAT tháng không đổi", async () => {
    await db().prepare(`INSERT INTO customers(id, code, type, name) VALUES (5302,'F5C-KH','b2b','KH 5c')`).run();
    const v0 = (await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body;
    const r = await api("accountant", "POST", `${V}/debts/opening-balances`, [
      { partnerType: "customer", partnerCode: "F5C-KH", amount: 100_000_000, dueDate: today },
      { partnerType: "supplier", partnerCode: "F5C-NCC", amount: 50_000_000, dueDate: today },
    ]);
    expect(r.status).toBe(201);
    const v1 = (await api("owner", "GET", `${V}/reports/vat?period=${period}`)).body;
    expect(v1.output.base).toBe(v0.output.base);
    expect(v1.output.count).toBe(v0.output.count);
    expect(v1.input.total).toBe(v0.input.total);
    expect(v1.input.count).toBe(v0.input.count);
  });
});

describe("B-22: phiếu chi chờ duyệt của kỳ đã khoá", () => {
  const mk = async () => {
    const cat = (await db().prepare(`SELECT id FROM cash_categories WHERE code='DIEN_NUOC'`).first<any>()).id;
    const v = await api("accountant", "POST", `${V}/vouchers`, { direction: "out", fundId: 1, categoryId: cat, amount: 8_000_000 });
    expect(v.body.status).toBe("pending_approval");
    return v.body;
  };
  it("kỳ khoá: duyệt báo rõ 423 + gợi ý từ chối; từ chối được và đóng yêu cầu duyệt", async () => {
    const v = await mk();
    await db().prepare(`INSERT OR REPLACE INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(period).run();
    try {
      const ap = await api("owner", "POST", `${V}/vouchers/${v.id}/approve`);
      expect(ap.status).toBe(423);
      expect(ap.body.error.code).toBe("period_locked");
      expect(ap.body.error.message).toContain("từ chối");
      expect((await api("accountant", "POST", `${V}/vouchers/${v.id}/reject`, { reason: "Từ chối thử" })).status).toBe(403);
      const rj = await api("owner", "POST", `${V}/vouchers/${v.id}/reject`, { reason: "Kỳ đã khoá, lập lại" });
      expect(rj.status).toBe(200);
      expect(rj.body.status).toBe("cancelled");
    } finally {
      await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(period).run();
    }
    expect((await db().prepare(`SELECT status FROM approvals WHERE type='cash_voucher.post' AND ref_id=?`).bind(String(v.id)).first<any>()).status).toBe("rejected");
    expect((await api("owner", "POST", `${V}/vouchers/${v.id}/reject`, { reason: "Lần hai" })).status).toBe(409);
  });
  it("người lập tự huỷ phiếu chờ duyệt; người khác không có quyền duyệt thì không huỷ được", async () => {
    const v = await mk();
    expect((await api("manager", "POST", `${V}/vouchers/${v.id}/cancel`, { reason: "Không phải của tôi" })).status).toBe(403);
    const c = await api("accountant", "POST", `${V}/vouchers/${v.id}/cancel`, { reason: "Nhập nhầm số tiền" });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("cancelled");
  });
});
