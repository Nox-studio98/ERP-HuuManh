import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const V = "/api/v1";
const today = vnDate();
const period = today.slice(0, 7);

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CLR','Chờ đối soát COD','cod_clearing')`),
    db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (3101,'NCC-V','NCC VAT',0)`),
    db().prepare(`INSERT INTO customers(id, code, type, name, credit_limit, payment_terms_days) VALUES (3101,'KH-V','b2b','KH VAT',1000000,15)`),
  ]);
});

const bal = async (id: number) => (await api("owner", "GET", `${V}/funds`)).body.items.find((f: any) => f.id === id).balance as number;
const pnl = async () => (await api("owner", "GET", `${V}/reports/pnl?from=${today}&to=${today}`)).body;

describe("A-03/B-05 + B-13: đối soát COD", () => {
  it("quỹ thật +received, quỹ chờ về 0, phí là chi phí từ quỹ chờ, chênh lệch thiếu vào chi phí", async () => {
    await db().batch([
      db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, paid_total, payment_method, payment_status, created_at, completed_at) VALUES (9801,'DH-F1A-1','online','sale',1,'completed',1000000,1000000,'cod','paid',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
      db().prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (9801,'cod',1000000,3,'confirmed')`),
    ]);
    const bankBefore = await bal(2), clrBefore = await bal(3), p0 = await pnl();
    // expected 1.000.000, phí 20.000, nhận 970.000 (thiếu 10.000 so với 980.000 kỳ vọng)
    const s = await api("owner", "POST", `${V}/settlements`, {
      source: "cod", externalRef: "F1A-1", fundId: 2, diffReason: "COD thiếu 10k",
      lines: [{ orderId: 9801, expectedAmount: 1_000_000, receivedAmount: 970_000, feeAmount: 20_000 }],
    });
    expect(s.status).toBe(201);
    const c = await api("owner", "POST", `${V}/settlements/${s.body.id}/confirm`);
    expect(c.status).toBe(200);
    expect(await bal(2) - bankBefore).toBe(970_000);
    expect(await bal(3) - clrBefore).toBe(-1_000_000); // quỹ chờ ra đúng bằng số đã ghi lúc giao → về 0
    expect(c.body.vouchers.filter((v: any) => v.fundId === 2 && v.direction === "out")).toHaveLength(0); // quỹ thật không có phiếu phí
    const p1 = await pnl();
    expect(p1.expenses.opex - (p0.expenses.opex ?? 0)).toBe(30_000); // phí 20.000 + chênh lệch thiếu 10.000
    expect((await api("owner", "POST", `${V}/settlements/${s.body.id}/confirm`)).status).toBe(409);
  });

  it("chênh lệch thừa ghi thu khác vào quỹ chờ; dòng chỉ có externalOrderId cũng rút khỏi quỹ chờ", async () => {
    const clrBefore = await bal(3), bankBefore = await bal(2), p0 = await pnl();
    const s = await api("owner", "POST", `${V}/settlements`, {
      source: "cod", externalRef: "F1A-2", fundId: 2, diffReason: "Nhận dư 5k",
      lines: [{ externalOrderId: "EXT-1", expectedAmount: 500_000, receivedAmount: 495_000, feeAmount: 10_000 }],
    });
    const c = await api("owner", "POST", `${V}/settlements/${s.body.id}/confirm`);
    expect(c.status).toBe(200);
    expect(await bal(2) - bankBefore).toBe(495_000);
    // quỹ chờ: +5.000 thu thừa, rồi ra 495.000 (về quỹ thật) + 10.000 (phí) → ròng −500.000 = đúng expected, về 0
    expect(await bal(3) - clrBefore).toBe(-500_000);
    const p1 = await pnl();
    expect(p1.otherIncome.settlementSurplus - p0.otherIncome.settlementSurplus).toBe(5_000);
    expect(p1.expenses.opex - p0.expenses.opex).toBe(10_000);
  });

  it("quỹ nhận tiền phải là quỹ thật", async () => {
    const r = await api("owner", "POST", `${V}/settlements`, {
      source: "cod", externalRef: "F1A-3", fundId: 3, lines: [{ externalOrderId: "EXT-9", expectedAmount: 1000, receivedAmount: 1000, feeAmount: 0 }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("fund_is_clearing");
  });
});

describe("A-04: P&L có xoá nợ, chiết khấu, cọc không hoàn", () => {
  it("các dòng mới xuất hiện và ảnh hưởng lãi ròng; return_credit không tính", async () => {
    const p0 = await pnl();
    await db().batch([
      db().prepare(`INSERT INTO debt_adjustments(code, type, partner_type, partner_id, amount, status, reason, created_by) VALUES ('DCN-F1A-1','write_off','customer',3101,70000,'posted','khó đòi',1),('DCN-F1A-2','discount','customer',3101,30000,'posted','CK',1),('DCN-F1A-3','discount','supplier',3101,20000,'posted','NCC giảm',1),('DCN-F1A-4','return_credit','customer',3101,99000,'posted','trả hàng',1),('DCN-F1A-5','write_off','customer',3101,5000,'pending_approval','chưa duyệt',1)`),
      db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, paid_total, payment_method, payment_status, created_at) VALUES (9811,'DH-F1A-D','pos','sale',1,'draft',0,0,'cash','unpaid',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
      db().prepare(`INSERT INTO order_deposits(order_id, amount, method, fund_id, status, created_by, settled_at) VALUES (9811,40000,'cash',1,'forfeited',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    ]);
    const p1 = await pnl();
    expect(p1.expenses.badDebt).toBe(70_000);
    expect(p1.revenueDeductions.paymentDiscount - p0.revenueDeductions.paymentDiscount).toBe(30_000);
    expect(p1.otherIncome.payableDiscounts).toBe(20_000);
    expect(p1.otherIncome.forfeitedDeposits).toBe(40_000);
    expect(p1.netProfit - p0.netProfit).toBe(-70_000 - 30_000 + 20_000 + 40_000);
    const ch = (await api("owner", "GET", `${V}/reports/pnl-by-channel?from=${today}&to=${today}`)).body;
    expect(ch.totals.netProfit - p1.netProfit).toBe(0); // hai báo cáo cùng cơ sở
  });
});

describe("B-06: chênh lệch kiểm kê vào P&L", () => {
  it("kiểm kê thiếu = chi phí, kiểm kê thừa giảm chi phí", async () => {
    const prod = await api("manager", "POST", `${V}/products`, { sku: "F1A-KK", name: "F1A-KK", baseUnit: "kg", sellByWeight: true });
    const doc = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierRef: "R-1" });
    await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/lines`, { productId: prod.body.id, unit: "kg", qty: 20, unitCost: 110000 });
    expect((await api("manager", "POST", `${V}/stock-docs/${doc.body.id}/post`)).status).toBe(200);
    const lot = await db().prepare(`SELECT id FROM lots WHERE product_id = ?`).bind(prod.body.id).first<any>();
    const p0 = await pnl();
    const cnt = await api("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 });
    await api("manager", "POST", `${V}/stock-docs/${cnt.body.id}/lines`, { lotId: lot.id, countedQty: 15, unit: "kg" });
    expect((await api("manager", "POST", `${V}/stock-docs/${cnt.body.id}/post`)).status).toBe(200);
    const p1 = await pnl();
    expect((p1.expenses.stockCount ?? 0) - (p0.expenses.stockCount ?? 0)).toBe(550_000);
    const cnt2 = await api("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 });
    await api("manager", "POST", `${V}/stock-docs/${cnt2.body.id}/lines`, { lotId: lot.id, countedQty: 16, unit: "kg" });
    expect((await api("manager", "POST", `${V}/stock-docs/${cnt2.body.id}/post`)).status).toBe(200);
    const p2 = await pnl();
    expect(p2.expenses.stockCount - p1.expenses.stockCount).toBe(-110_000);
  });
});

describe("B-07: VAT đầu vào", () => {
  it("vatAmount trên phiếu nhập và khi chốt hoá đơn tạm tính vào báo cáo VAT", async () => {
    const prod = await api("manager", "POST", `${V}/products`, { sku: "F1A-VAT", name: "F1A-VAT", baseUnit: "kg", sellByWeight: true });
    const mk = async (ref: string | undefined, vat: number | undefined) => {
      const d = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId: 3101, supplierRef: ref, vatAmount: vat });
      await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { productId: prod.body.id, unit: "kg", qty: 10, unitCost: 100000 });
      return d.body.id as number;
    };
    const neg = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId: 3101, vatAmount: -1 });
    expect(neg.status).toBe(422);
    const tooBig = await mk("HD-V0", 2_000_000);
    const bad = await api("manager", "POST", `${V}/stock-docs/${tooBig}/post`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("vat_exceeds_total");
    const ok = await mk("HD-V1", 100_000); // tổng 1.000.000, VAT 10%
    expect((await api("manager", "POST", `${V}/stock-docs/${ok}/post`)).status).toBe(200);
    const prov = await mk(undefined, undefined);
    expect((await api("manager", "POST", `${V}/stock-docs/${prov}/post`)).status).toBe(200);
    const bill = await db().prepare(`SELECT id, vat_amount FROM supplier_bills WHERE stock_doc_id = ?`).bind(prov).first<any>();
    expect(bill.vat_amount).toBe(0);
    expect((await api("accountant", "POST", `${V}/bills/${bill.id}/finalize`, { supplierRef: "HD-V2", vatAmount: 5_000_000 })).status).toBe(422);
    const fin = await api("accountant", "POST", `${V}/bills/${bill.id}/finalize`, { supplierRef: "HD-V2", vatAmount: 80_000 });
    expect(fin.status).toBe(200);
    const au = await db().prepare(`SELECT after_json FROM audit_log WHERE action='bill.finalize' ORDER BY id DESC`).first<any>();
    expect(JSON.parse(au.after_json).vat).toBe(80_000);
    const vat = await api("owner", "GET", `${V}/reports/vat?period=${period}`);
    expect(vat.body.input.vat).toBe(180_000);
  });
});
