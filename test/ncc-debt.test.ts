import { beforeAll, describe, expect, it } from "vitest";
import { api, db, mkNcc, mkSupplier, ncc, seedBase, V, type NccSession } from "./ncc-helpers";
import { seedShop } from "./shop-helpers";
import { addDays, supplierDebtStatus } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

// Cổng NCC — công nợ, sao kê, thanh toán: khớp sổ ERP, không lộ dữ liệu nội bộ (docs/PO-NCC.md mục 5)
const today = vnDate();
let A: NccSession, B: NccSession;

/** Phiếu nhập đã ghi sổ qua API: sinh lô + hoá đơn mua (không tạm tính). */
async function receipt(supplierId: number, productId: number, qty: number, unitCost: number, ref: string) {
  const d = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId, supplierRef: ref });
  await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { productId, unit: "kg", qty, unitCost });
  expect((await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`)).status).toBe(200);
  return { docId: d.body.id as number, lot: (await db().prepare(`SELECT * FROM lots WHERE receipt_doc_id = ?`).bind(d.body.id).first<any>())!, bill: (await db().prepare(`SELECT * FROM supplier_bills WHERE stock_doc_id = ?`).bind(d.body.id).first<any>())! };
}

beforeAll(async () => {
  await seedShop();
  await seedBase();
  await mkSupplier(9801, "NCC Nợ A", 7);
  await mkSupplier(9802, "NCC Nợ B", 30);
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (9801,'N9801','Cam nợ','kg'),(9802,'N9802','Xoài nợ','kg')`),
  ]);
  A = await mkNcc(9801, "no-a@example.com");
  B = await mkNcc(9802, "no-b@example.com");
});

describe("công nợ + sao kê + thanh toán", () => {
  it("không có phát sinh: số 0, danh sách rỗng", async () => {
    const d = await ncc(A, "GET", "/debt");
    expect(d.status).toBe(200);
    expect(d.body.summary).toEqual({ balance: 0, outstanding: 0, overdueAmount: 0, overdueCount: 0, prepaid: 0 });
    expect(d.body.bills).toEqual([]);
    expect((await ncc(A, "GET", "/payments")).body).toMatchObject({ items: [], nextCursor: null, summary: { count: 0, amount: 0 } });
    const st = await ncc(A, "GET", "/statement");
    expect(st.body).toMatchObject({ opening: 0, closing: 0, lines: [] });
  });

  it("số cửa hàng còn nợ, hoá đơn mở/quá hạn, sao kê (hoá đơn, thanh toán, chiết khấu, trả hàng) khớp sổ ERP từng đồng", async () => {
    const r1 = await receipt(9801, 9801, 100, 20_000, "HD-A-1"); // 2.000.000
    const r2 = await receipt(9801, 9802, 50, 10_000, "HD-A-2"); // 500.000
    await receipt(9802, 9801, 10, 10_000, "HD-B-1"); // NCC B: 100.000 (không được lẫn)
    // hoá đơn A-2 quá hạn: lùi hạn
    await db().prepare(`UPDATE supplier_bills SET due_date = ? WHERE id = ?`).bind(addDays(today, -10), r2.bill.id).run();
    // thanh toán 800.000 (gạch cũ nhất trước) + chiết khấu 50.000 + trả hàng 30kg (600.000)
    const pay = await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 9801, fundId: 1, amount: 800_000, method: "transfer", ref: "NGAN-HANG-REF-NOI-BO", note: "GHI CHÚ NỘI BỘ CHI TIỀN" });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const disc = await api("owner", "POST", `${V}/debts/adjustments`, { type: "discount", partnerType: "supplier", partnerId: 9801, amount: 50_000, reason: "LÝ DO NỘI BỘ chiết khấu", billId: r1.bill.id });
    expect(disc.status, JSON.stringify(disc.body)).toBe(201);
    const ret = await api("manager", "POST", `${V}/purchase-returns`, { receiptDocId: r1.docId, reason: "LÝ DO NỘI BỘ hàng dập", lines: [{ lotId: r1.lot.id, qty: 30 }] });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);

    const erp = await supplierDebtStatus(db(), 9801);
    expect(erp.balance).toBe(2_500_000 - 800_000 - 50_000 - 600_000); // 1.050.000
    const d = await ncc(A, "GET", "/debt");
    expect(d.body.summary).toEqual({ balance: erp.balance, outstanding: erp.outstanding, overdueAmount: erp.overdueAmount, overdueCount: erp.overdueCount, prepaid: erp.unapplied });
    expect(d.body.summary.balance).toBe(1_050_000);
    // ERP: bảng công nợ phải trả
    const pbl = (await api("accountant", "GET", `${V}/debts/payables`)).body.items.find((x: any) => x.supplierId === 9801);
    expect(pbl.balance).toBe(d.body.summary.balance);
    expect(pbl.overdueAmount).toBe(d.body.summary.overdueAmount);
    // hoá đơn mở: cùng số còn nợ với ERP, chỉ của NCC A
    const erpBills = (await api("accountant", "GET", `${V}/suppliers/9801/bills`)).body.items.filter((b: any) => b.outstanding > 0);
    expect(d.body.bills.map((b: any) => [b.code, b.outstanding]).sort()).toEqual(erpBills.map((b: any) => [b.code, b.outstanding]).sort());
    expect(d.body.bills.reduce((s: number, b: any) => s + b.outstanding, 0)).toBe(erp.outstanding);
    const overdueBill = d.body.bills.find((b: any) => b.code === r2.bill.code);
    if (overdueBill) expect(overdueBill.overdueDays).toBeGreaterThanOrEqual(10);
    expect(d.body.bills.find((b: any) => b.code.startsWith("CNP") && b.supplierRef === "HD-A-1")).toBeTruthy();
    expect(JSON.stringify(d.body)).not.toContain("HD-B-1");

    // sao kê: số dư cuối khớp công nợ, các loại chứng từ đủ
    const st = await ncc(A, "GET", `/statement?from=${addDays(today, -30)}&to=${today}`);
    expect(st.status).toBe(200);
    expect(st.body.closing).toBe(erp.balance);
    expect(st.body.opening).toBe(0);
    const types = st.body.lines.map((l: any) => l.docType).sort();
    expect(types).toEqual(["bill", "bill", "discount", "payment", "return_credit"]);
    expect(st.body.totals).toEqual({ debit: 2_500_000, credit: 800_000 + 50_000 + 600_000 });
    // tương tự sao kê ERP (sau khi sửa return_credit của NCC là bút toán giảm nợ)
    const erpSt = (await api("accountant", "GET", `${V}/debts/statements/supplier/9801?from=${addDays(today, -30)}&to=${today}`)).body;
    expect(erpSt.closing).toBe(st.body.closing);
    expect(erpSt.lines.map((l: any) => [l.docCode, l.debit, l.credit, l.balance])).toEqual(st.body.lines.map((l: any) => [l.docCode, l.debit, l.credit, l.balance]));
    // khoảng sau ngày phát sinh: số dư đầu kỳ mang sang, không có dòng
    const later = await ncc(A, "GET", `/statement?from=${addDays(today, 1)}&to=${addDays(today, 5)}`);
    expect(later.body).toMatchObject({ opening: erp.balance, closing: erp.balance, lines: [] });
    // khoảng sai
    expect((await ncc(A, "GET", `/statement?from=${today}&to=${addDays(today, -3)}`)).status).toBe(422);
    expect((await ncc(A, "GET", `/statement?from=2020-01-01&to=${today}`)).status).toBe(422);
    // NCC B độc lập
    expect((await ncc(B, "GET", "/debt")).body.summary.balance).toBe(100_000);
    expect((await ncc(B, "GET", "/statement")).body.lines.map((l: any) => l.docType)).toEqual(["bill"]);
  });

  it("thanh toán: ngày, số tiền, phương thức, hoá đơn được gạch — KHÔNG có quỹ, người lập, ghi chú, tham chiếu nội bộ; chỉ phiếu đã ghi sổ", async () => {
    // phiếu chi lớn chờ chủ duyệt chưa thực chi → chưa hiện
    await db().prepare(`UPDATE settings SET value = '50000' WHERE key = 'approval.cash_out_vnd'`).run();
    const big = await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 9801, fundId: 1, amount: 100_000, method: "cash", note: "BÍ MẬT" });
    expect(big.status).toBe(201);
    expect(big.body.payment.status).toBe("pending_approval");
    const p = await ncc(A, "GET", "/payments");
    expect(p.status).toBe(200);
    expect(p.body.items).toHaveLength(1); // chỉ khoản 800.000 đã chi
    expect(p.body.items[0]).toMatchObject({ amount: 800_000, method: "transfer", paidDate: today });
    expect(p.body.items[0].allocations.length).toBeGreaterThan(0);
    expect(p.body.items[0].allocations.reduce((s: number, a: any) => s + a.amount, 0)).toBe(800_000);
    expect(Object.keys(p.body.items[0]).sort()).toEqual(["allocations", "amount", "code", "method", "paidAt", "paidDate"]);
    const txt = JSON.stringify(p.body);
    for (const leak of ["NGAN-HANG-REF", "NOI-BO", "NỘI BỘ", "fund", "TM-CH1", "NH-VCB", "Test accountant", "createdBy", "created_by", "cashVoucher", "voucher", "BÍ MẬT"]) expect(txt, leak).not.toContain(leak);
    expect(p.body.summary).toEqual({ count: 1, amount: 800_000 });
    // lọc ngày
    expect((await ncc(A, "GET", `/payments?from=${addDays(today, 1)}`)).body.items).toHaveLength(0);
    expect((await ncc(A, "GET", `/payments?from=${today}&to=${today}`)).body.items).toHaveLength(1);
    // sao kê cũng không lộ
    const stTxt = JSON.stringify((await ncc(A, "GET", "/statement")).body);
    for (const leak of ["NỘI BỘ", "NGAN-HANG", "reason", "note", "Test "]) expect(stTxt, leak).not.toContain(leak);
    await db().prepare(`UPDATE settings SET value = '5000000' WHERE key = 'approval.cash_out_vnd'`).run();
  });

  it("trả trước chưa gạch hiện ở prepaid; số dư giảm tương ứng; phân trang thanh toán", async () => {
    const before = (await ncc(B, "GET", "/debt")).body.summary;
    expect(before.balance).toBe(100_000);
    for (let i = 0; i < 3; i++) await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 9802, fundId: 1, amount: 50_000, method: "cash" });
    const d = (await ncc(B, "GET", "/debt")).body.summary;
    const erp = await supplierDebtStatus(db(), 9802);
    expect(d.balance).toBe(erp.balance);
    expect(d.prepaid).toBe(erp.unapplied);
    expect(d.balance).toBe(100_000 - 150_000);
    const pg = await ncc(B, "GET", "/payments?limit=2");
    expect(pg.body.items).toHaveLength(2);
    const pg2 = await ncc(B, "GET", `/payments?limit=2&cursor=${pg.body.nextCursor}`);
    expect(pg2.body.items).toHaveLength(1);
    expect(pg2.body.nextCursor).toBeNull();
    expect(pg.body.summary).toEqual({ count: 3, amount: 150_000 });
  });
});
