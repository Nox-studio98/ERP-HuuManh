import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
const today = vnDate();

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (3001,'NCC-X','NCC X',30),(3002,'NCC-Y','NCC Y',0)`),
    db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (3101,'DAO','Dưa','kg'),(3102,'XOAI','Xoài','kg')`),
  ]);
});

async function receipt(supplierId: number | null, supplierRef: string | null, lines: { productId: number; qty: number; docQty?: number; unitCost: number }[]) {
  const doc = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId, supplierRef });
  expect(doc.status).toBe(201);
  for (const l of lines) expect((await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { unit: "kg", ...l })).status).toBe(201);
  const post = await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`);
  expect(post.status).toBe(200);
  return doc.body.id as number;
}
const billOf = (docId: number) => db().prepare(`SELECT * FROM supplier_bills WHERE stock_doc_id = ?`).bind(docId).first<any>();

describe("supplier bills from receipts", () => {
  let provisionalId = 0;

  it("creates a provisional bill without supplier_ref, excluding rejected goods", async () => {
    // đặt 10kg nhưng chỉ nhận 8kg (2kg từ chối): 8 × 20.000 + 5 × 30.000 = 310.000
    const docId = await receipt(3001, null, [
      { productId: 3101, qty: 8, docQty: 10, unitCost: 20000 },
      { productId: 3102, qty: 5, unitCost: 30000 },
    ]);
    const b = await billOf(docId);
    expect(b.code).toMatch(/^CNP-/);
    expect(b).toMatchObject({ supplier_id: 3001, total: 310_000, is_provisional: 1, issue_date: today, due_date: addDays(today, 30), status: "open" });
    provisionalId = b.id;
  });

  it("creates a final bill when supplier_ref is present; none without a supplier", async () => {
    const docId = await receipt(3002, "HD-NCC-77", [{ productId: 3101, qty: 2, unitCost: 10000 }]);
    expect(await billOf(docId)).toMatchObject({ total: 20_000, is_provisional: 0, supplier_ref: "HD-NCC-77", due_date: today });
    const noSup = await receipt(null, null, [{ productId: 3101, qty: 1, unitCost: 10000 }]);
    expect(await billOf(noSup)).toBeNull();
  });

  it("finalize requires a reason when the price changes; second finalize conflicts", async () => {
    const noReason = await api("accountant", "POST", `${V}/bills/${provisionalId}/finalize`, { supplierRef: "HD-9", total: 300_000 });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe("reason_required");
    expect((await api("cashier", "POST", `${V}/bills/${provisionalId}/finalize`, { supplierRef: "HD-9" })).status).toBe(403);
    const ok = await api("accountant", "POST", `${V}/bills/${provisionalId}/finalize`, { supplierRef: "HD-9", total: 300_000, reason: "NCC giảm giá xoài 2k/kg" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ total: 300_000, isProvisional: 0, supplierRef: "HD-9" });
    expect((await api("accountant", "POST", `${V}/bills/${provisionalId}/finalize`, { supplierRef: "HD-9" })).status).toBe(409);
    const au = await db().prepare(`SELECT reason, before_json, after_json FROM audit_log WHERE action='bill.finalize' ORDER BY id DESC`).first<any>();
    expect(au.reason).toContain("giảm giá");
    expect(JSON.parse(au.before_json).total).toBe(310_000);
  });
});

describe("payables", () => {
  it("pays a supplier oldest-first, shows payables with bills and aging", async () => {
    const list = await api("accountant", "GET", `${V}/debts/payables?q=NCC-X`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ supplierId: 3001, outstanding: 300_000, balance: 300_000 });
    expect(list.body.items[0].bills).toHaveLength(1);
    const pay = await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 3001, fundId: 1, amount: 100_000, method: "cash" });
    expect(pay.status).toBe(201);
    expect(pay.body.allocations).toHaveLength(1);
    const v = await db().prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(pay.body.payment.cashVoucherId).first<any>();
    expect(v).toMatchObject({ direction: "out", amount: 100_000 });
    expect((await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 3001, fundId: 1, amount: 500_000, method: "cash", allocations: [{ billId: provisionalId(list), amount: 500_000 }] })).status).toBe(422);
    const after = await api("accountant", "GET", `${V}/suppliers/3001/bills`);
    expect(after.body.items[0]).toMatchObject({ outstanding: 200_000 });
    const aging = await api("accountant", "GET", `${V}/debts/aging?side=payable`);
    expect(aging.body.items.find((x: any) => x.partnerId === 3001)).toMatchObject({ outstanding: 200_000, bucket: "current" });
    const rev = await api("accountant", "POST", `${V}/debts/payments/${pay.body.payment.id}/reverse`, { reason: "Chi nhầm" });
    expect(rev.status).toBe(200);
    const bill = await api("accountant", "GET", `${V}/bills/${list.body.items[0].bills[0].id}`);
    expect(bill.body.outstanding).toBe(300_000);
    const st = await api("accountant", "GET", `${V}/debts/statements/supplier/3001`);
    expect(st.body.closing).toBe(300_000);
  });
});

function provisionalId(list: any) {
  return list.body.items[0].bills[0].id as number;
}
