import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";

const V = "/api/v1";
const db = () => testEnv.DB;
let p3 = 0, pNoCost = 0;

beforeAll(async () => {
  await seedBase();
  await seedSales(); // Táo (1): lô 20kg hạn +10 ngày, vốn 60k
  await db().prepare(`INSERT INTO suppliers(id, code, name) VALUES (7001,'NCC-7001','NCC Táo'),(7002,'NCC-7002','NCC Phụ')`).run();
  p3 = (await api("manager", "POST", `${V}/products`, { sku: "PUR-3", name: "Lê sắp hết hạn", baseUnit: "kg", sellByWeight: true })).body.id;
  pNoCost = (await api("manager", "POST", `${V}/products`, { sku: "PUR-4", name: "Mận chưa nhập", baseUnit: "kg", sellByWeight: true })).body.id;
  const exp = new Date(Date.now() + 86400_000).toISOString();
  await db().batch([
    db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (9301,'LOT-PUR-3',?,1,?,?,40000,10000,10000)`).bind(p3, new Date().toISOString(), exp),
    // Táo: bán 140kg trong 14 ngày => 10kg/ngày
    db().prepare(`INSERT INTO stock_moves(at, lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id) VALUES (?,1,1,-140000,60000,'sale','order',1)`).bind(new Date(Date.now() - 3 * 86400_000).toISOString()),
    // bán quá lookback thì không tính
    db().prepare(`INSERT INTO stock_moves(at, lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id) VALUES (?,1,1,-999000,60000,'sale','order',2)`).bind(new Date(Date.now() - 30 * 86400_000).toISOString()),
    db().prepare(`INSERT INTO stock_moves(at, lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id) VALUES (?,9301,?,-14000,40000,'sale','order',3)`).bind(new Date(Date.now() - 86400_000).toISOString(), p3),
  ]);
});

describe("product-suppliers", () => {
  it("PUT replaces the set; validates; permissions", async () => {
    const put = await api("manager", "PUT", `${V}/product-suppliers?productId=1`, {
      items: [
        { supplierId: 7001, leadTimeDays: 2, orderUnit: "thung", minOrderMilli: 0, preferred: true },
        { supplierId: 7002, leadTimeDays: 5 },
      ],
    });
    expect(put.status).toBe(200);
    expect(put.body.items.map((i: any) => [i.supplierId, i.preferred])).toEqual([[7001, true], [7002, false]]);
    expect((await api("manager", "PUT", `${V}/product-suppliers?productId=1`, { items: [{ supplierId: 7001, preferred: true }, { supplierId: 7002, preferred: true }] })).status).toBe(422);
    expect((await api("manager", "PUT", `${V}/product-suppliers?productId=1`, { items: [{ supplierId: 7001, orderUnit: "bao" }] })).status).toBe(422);
    expect((await api("warehouse", "PUT", `${V}/product-suppliers?productId=1`, { items: [] })).status).toBe(403);
    expect((await api("warehouse", "GET", `${V}/product-suppliers?productId=1`)).body.items).toHaveLength(2);
    await api("manager", "PUT", `${V}/product-suppliers?productId=1`, { items: [{ supplierId: 7001, leadTimeDays: 2, orderUnit: "thung", preferred: true }, { supplierId: 7002, leadTimeDays: 5 }] });
    await api("manager", "PUT", `${V}/product-suppliers?productId=${p3}`, { items: [{ supplierId: 7001, leadTimeDays: 2, preferred: true }] });
    await api("manager", "PUT", `${V}/product-suppliers?productId=${pNoCost}`, { items: [{ supplierId: 7001, leadTimeDays: 1, preferred: true }] });
  });
});

describe("purchasing suggestions (M2-11)", () => {
  it("formula: avg sales x (lead + cover) - available, rounded up to order unit", async () => {
    const r = await api("warehouse", "GET", `${V}/purchasing/suggestions?supplierId=7001`);
    expect(r.status).toBe(200);
    const tao = r.body.items.find((i: any) => i.productId === 1);
    // 140000/14 = 10000/ngày; (2 + 3) × 10000 - 20000 = 30000 -> 3 thùng (10kg)
    expect(tao).toMatchObject({ name: "Táo Envy", baseUnit: "kg", onHandMilli: 20000, reservedMilli: 0, avgDailySalesMilli: 10000, daysCover: 2, leadTimeDays: 2, suggestedMilli: 30000, supplierId: 7001, supplierName: "NCC Táo", lastCost: 60000 });
    expect(tao.orderUnit).toBe("thung");
    expect(tao.orderQty).toBe(3);
  });

  it("near-expiry stock is not counted as available", async () => {
    const r = await api("manager", "GET", `${V}/purchasing/suggestions?supplierId=7001`);
    const le = r.body.items.find((i: any) => i.productId === p3);
    // hạn +1 ngày <= hôm nay + lead 2 ngày -> không tính vào tồn; 14000/14 = 1000/ngày; 5 × 1000 - 0 = 5000
    expect(le).toMatchObject({ onHandMilli: 0, expiringMilli: 10000, avgDailySalesMilli: 1000, suggestedMilli: 5000 });
  });

  it("no sales -> nothing suggested; onlyNeeded filters; reserved reduces availability", async () => {
    const all = await api("manager", "GET", `${V}/purchasing/suggestions?supplierId=7001`);
    expect(all.body.items.find((i: any) => i.productId === pNoCost)).toMatchObject({ suggestedMilli: 0, daysCover: null, lastCost: null });
    const needed = await api("manager", "GET", `${V}/purchasing/suggestions?supplierId=7001&onlyNeeded=1`);
    expect(needed.body.items.some((i: any) => i.productId === pNoCost)).toBe(false);
    await db().prepare(`UPDATE lots SET qty_reserved_milli = 5000 WHERE id = 1`).run();
    const r = await api("manager", "GET", `${V}/purchasing/suggestions?supplierId=7001`);
    // (50000 - 15000) = 35000 -> 4 thùng
    expect(r.body.items.find((i: any) => i.productId === 1)).toMatchObject({ reservedMilli: 5000, suggestedMilli: 40000 });
    await db().prepare(`UPDATE lots SET qty_reserved_milli = 0 WHERE id = 1`).run();
  });

  it("without supplierId uses the preferred supplier; cashier/accountant forbidden", async () => {
    const r = await api("manager", "GET", `${V}/purchasing/suggestions`);
    expect(r.body.items.filter((i: any) => i.productId === 1)).toHaveLength(1);
    expect(r.body.items.find((i: any) => i.productId === 1).supplierId).toBe(7001);
    expect((await api("cashier", "GET", `${V}/purchasing/suggestions`)).status).toBe(403);
    expect((await api("accountant", "GET", `${V}/purchasing/suggestions`)).status).toBe(403);
  });
});

describe("to-receipt", () => {
  it("creates a draft receipt with the selected lines", async () => {
    const r = await api("warehouse", "POST", `${V}/purchasing/suggestions/to-receipt`, {
      supplierId: 7001,
      lines: [{ productId: 1, qtyMilli: 30000 }, { productId: p3, qtyMilli: 5000, unitCost: 42000 }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: "receipt", status: "draft", supplierId: 7001, totalAmount: 30 * 60000 + 5 * 42000 });
    expect(r.body.code).toMatch(/^PN-\d{8}-\d{4}$/);
    const lines = await db().prepare(`SELECT product_id, unit, qty_milli, doc_qty_milli, unit_cost FROM stock_doc_lines WHERE doc_id=? ORDER BY id`).bind(r.body.id).all<any>();
    expect(lines.results).toEqual([
      { product_id: 1, unit: "kg", qty_milli: 30000, doc_qty_milli: 30000, unit_cost: 60000 },
      { product_id: p3, unit: "kg", qty_milli: 5000, doc_qty_milli: 5000, unit_cost: 42000 },
    ]);
    // tồn chưa đổi (nháp)
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=1`).first<any>()).q).toBe(20000);
    expect(await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE entity_id=? AND action='stock_doc.create'`).bind(r.body.code).first<any>()).toMatchObject({ n: 1 });
    // dùng được với luồng phiếu hiện có
    const doc = await api("warehouse", "GET", `${V}/stock-docs/${r.body.id}`);
    expect(doc.body).toMatchObject({ status: "draft", type: "receipt" });
    expect(doc.body.lines).toHaveLength(2);
  });

  it("rejects missing cost, duplicates, unknown supplier and wrong role", async () => {
    const noCost = await api("manager", "POST", `${V}/purchasing/suggestions/to-receipt`, { supplierId: 7001, lines: [{ productId: pNoCost, qtyMilli: 1000 }] });
    expect(noCost.status).toBe(422);
    expect(noCost.body.error.code).toBe("missing_cost");
    expect((await api("manager", "POST", `${V}/purchasing/suggestions/to-receipt`, { supplierId: 7001, lines: [{ productId: 1, qtyMilli: 1000 }, { productId: 1, qtyMilli: 2000 }] })).status).toBe(422);
    expect((await api("manager", "POST", `${V}/purchasing/suggestions/to-receipt`, { supplierId: 99999, lines: [{ productId: 1, qtyMilli: 1000 }] })).status).toBe(422);
    expect((await api("accountant", "POST", `${V}/purchasing/suggestions/to-receipt`, { supplierId: 7001, lines: [{ productId: 1, qtyMilli: 1000 }] })).status).toBe(403);
    expect((await api("cashier", "POST", `${V}/purchasing/suggestions/to-receipt`, { supplierId: 7001, lines: [{ productId: 1, qtyMilli: 1000 }] })).status).toBe(403);
  });
});
