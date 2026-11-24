import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate, vnPeriod } from "../src/worker/lib/time";

// Fix 4b: B-09 (chốt hoá đơn tạm khác giá → giá vốn), B-11 (thu khác / phiếu đảo trong P&L), số dư quỹ đầu kỳ
const db = () => testEnv.DB;
const V = "/api/v1";
const today = vnDate();
const pnl = async () => (await api("owner", "GET", `${V}/reports/pnl?from=${today}&to=${today}`)).body;
const byCh = async () => (await api("owner", "GET", `${V}/reports/pnl-by-channel?from=${today}&to=${today}`)).body;
const bal = async (id: number) => (await api("owner", "GET", `${V}/funds`)).body.items.find((f: any) => f.id === id).balance as number;

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT OR IGNORE INTO cash_categories(code, name, direction, pnl_line) VALUES ('THU_KHAC','Thu khác','in','other')`),
    db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (4801,'F4B-NCC','NCC 4b',0)`),
    db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (4801,'F4B-A','Táo 4b','kg'),(4802,'F4B-B','Cam 4b','kg')`),
    db().prepare(`INSERT INTO stock_docs(id, code, type, status, store_id, location_id, supplier_id, created_by, posted_at) VALUES (4801,'F4B-PN1','receipt','posted',1,1,4801,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    // lô A: nhập 20kg × 50.000, đã bán 15kg (còn 5kg); lô B: nhập 10kg × 30.000, còn nguyên
    db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, supplier_id, receipt_doc_id, received_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES
      (4801,'F4B-L1',4801,1,4801,4801,strftime('%Y-%m-%dT%H:%M:%fZ','now'),50000,20000,5000),
      (4802,'F4B-L2',4802,1,4801,4801,strftime('%Y-%m-%dT%H:%M:%fZ','now'),30000,10000,10000)`),
    db().prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, qty_milli, unit_cost, amount) VALUES (4801,4801,4801,'kg',20000,50000,1000000),(4801,4802,4802,'kg',10000,30000,300000)`),
    db().prepare(`INSERT INTO supplier_bills(id, code, supplier_id, stock_doc_id, is_provisional, issue_date, due_date, total) VALUES (4801,'F4B-CNP-1',4801,4801,1,?,?,1300000)`).bind(today, today),
  ]);
});

describe("B-09: chốt hoá đơn tạm khác giá đổi giá vốn", () => {
  it("phân bổ theo thành tiền; còn tồn → đổi unit_cost; đã bán → chênh lệch giá mua vào P&L; tồn + giá vốn = chênh lệch", async () => {
    const p0 = await pnl();
    const r = await api("accountant", "POST", `${V}/bills/4801/finalize`, { supplierRef: "HD-4B-1", total: 1_170_000, reason: "NCC giảm giá" });
    expect(r.status).toBe(200);
    const a = await db().prepare(`SELECT unit_cost FROM lots WHERE id=4801`).first<any>();
    const b = await db().prepare(`SELECT unit_cost FROM lots WHERE id=4802`).first<any>();
    expect(a.unit_cost).toBe(45_000); // phần của lô A = −100.000; còn 5/20 → −25.000 → −5.000/kg
    expect(b.unit_cost).toBe(27_000); // phần của dòng cuối = −30.000 (phần dư dồn dòng cuối), còn nguyên
    const adj = (await db().prepare(`SELECT * FROM purchase_cost_adjustments WHERE bill_id=4801 ORDER BY lot_id`).all<any>()).results;
    expect(adj.map((x) => [x.diff_amount, x.onhand_amount, x.cogs_amount])).toEqual([[-100000, -25000, -75000], [-30000, -30000, 0]]);
    expect(adj.reduce((n, x) => n + x.diff_amount, 0)).toBe(-130_000);
    // giá trị tồn còn lại: 5kg×45.000 + 10kg×27.000 = 495.000 = giá trị ban đầu 5×50.000+10×30.000 (550.000) − phần tồn (55.000)
    expect(5 * 45_000 + 10 * 27_000).toBe(550_000 - 55_000);
    expect((await db().prepare(`SELECT COUNT(*) n FROM stock_moves WHERE move_type='cost_adjust' AND ref_id=4801`).first<any>()).n).toBe(2);
    const p1 = await pnl();
    expect(p1.expenses.purchaseVariance).toBe(-75_000);
    expect(p1.netProfit - p0.netProfit).toBe(75_000);
    // pnl-by-channel khớp /reports/pnl
    expect((await byCh()).totals.netProfit).toBe(p1.netProfit);
  });

  it("không đổi tổng → không có bản ghi điều chỉnh; kỳ khoá sổ vẫn chặn chốt (423)", async () => {
    await db().prepare(`INSERT INTO supplier_bills(id, code, supplier_id, is_provisional, issue_date, due_date, total) VALUES (4802,'F4B-CNP-2',4801,1,?,?,500000)`).bind(today, today).run();
    await db().prepare(`INSERT OR IGNORE INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    const r = await api("accountant", "POST", `${V}/bills/4802/finalize`, { supplierRef: "HD-4B-2" });
    expect(r.status).toBe(423);
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    expect((await api("accountant", "POST", `${V}/bills/4802/finalize`, { supplierRef: "HD-4B-2" })).status).toBe(200);
    expect((await db().prepare(`SELECT COUNT(*) n FROM purchase_cost_adjustments WHERE bill_id=4802`).first<any>()).n).toBe(0);
  });
});

describe("B-11: phiếu thu khác và phiếu đảo trong P&L", () => {
  it("thu khác vào thu nhập khác; đảo phiếu thu trừ lại đúng dòng, không thành chi phí; pnl = pnl-by-channel", async () => {
    const cat = (await db().prepare(`SELECT id FROM cash_categories WHERE code='THU_KHAC'`).first<any>()).id;
    const p0 = await pnl();
    const v = await api("owner", "POST", `${V}/vouchers`, { direction: "in", fundId: 1, categoryId: cat, amount: 2_000_000, note: "thu khác" });
    expect(v.status).toBe(201);
    const p1 = await pnl();
    expect(p1.otherIncome.otherReceipts).toBe(2_000_000);
    expect(p1.netProfit - p0.netProfit).toBe(2_000_000);
    expect(p1.totalExpenses).toBe(p0.totalExpenses);
    const c1 = await byCh();
    expect(c1.totals.netProfit).toBe(p1.netProfit);
    expect(c1.totals.otherIncome).toBe(p1.otherIncome.total);
    const rv = await api("owner", "POST", `${V}/vouchers/${v.body.id}/reverse`, { reason: "nhập nhầm" });
    expect(rv.status).toBe(201);
    const p2 = await pnl();
    expect(p2.otherIncome.otherReceipts).toBe(0);
    expect(p2.netProfit).toBe(p0.netProfit);
    expect(p2.totalExpenses).toBe(p0.totalExpenses);
    expect((await byCh()).totals.netProfit).toBe(p2.netProfit);
  });

  it("phiếu chi vẫn là chi phí, đảo phiếu chi trừ lại", async () => {
    const cat = (await db().prepare(`SELECT id FROM cash_categories WHERE code='DIEN_NUOC'`).first<any>()).id;
    const p0 = await pnl();
    const v = await api("owner", "POST", `${V}/vouchers`, { direction: "out", fundId: 1, categoryId: cat, amount: 300_000 });
    expect((await pnl()).totalExpenses - p0.totalExpenses).toBe(300_000);
    await api("owner", "POST", `${V}/vouchers/${v.body.id}/reverse`, { reason: "đảo thử" });
    expect((await pnl()).totalExpenses).toBe(p0.totalExpenses);
  });

  it("số dư quỹ đầu kỳ (SO_DU_DAU_KY, transfer): tăng quỹ nhưng không vào P&L", async () => {
    const cat = await db().prepare(`SELECT id, direction, pnl_line FROM cash_categories WHERE code='SO_DU_DAU_KY'`).first<any>();
    expect(cat).toMatchObject({ id: 907, direction: "in", pnl_line: "transfer" });
    const p0 = await pnl(), b0 = await bal(1);
    const v = await api("owner", "POST", `${V}/vouchers`, { direction: "in", fundId: 1, categoryId: 907, amount: 15_000_000, note: "số dư đầu kỳ" });
    expect(v.status).toBe(201);
    expect(await bal(1)).toBe(b0 + 15_000_000);
    const p1 = await pnl();
    expect(p1.netProfit).toBe(p0.netProfit);
    expect(p1.otherIncome.total).toBe(p0.otherIncome.total);
    expect((await byCh()).totals.netProfit).toBe(p1.netProfit);
  });
});
