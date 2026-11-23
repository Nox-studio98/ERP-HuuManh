import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { ROLE_PERMS } from "../src/worker/lib/rbac";

const V = "/api/v1";
const db = () => testEnv.DB;
let compA = 0, compB = 0;

beforeAll(async () => {
  await seedBase();
  await seedSales(); // Táo (1): giá 100k, vốn 60k; Nho (2): giá 200k, vốn 150k; nhóm 1 biên 30%
  compA = (await api("manager", "POST", `${V}/competitors`, { name: "Cửa hàng A" })).body.id;
  compB = (await api("manager", "POST", `${V}/competitors`, { name: "Cửa hàng B" })).body.id;
});
afterAll(() => (ROLE_PERMS.accountant as Set<string>).delete("prices.write"));

describe("permissions", () => {
  it("cashier/warehouse/accountant cannot use competitors; manager can", async () => {
    for (const role of ["cashier", "warehouse", "accountant", "online_staff"]) {
      expect((await api(role, "GET", `${V}/competitors`)).status).toBe(403);
      expect((await api(role, "GET", `${V}/price-comparison`)).status).toBe(403);
      expect((await api(role, "POST", `${V}/competitor-prices/manual`, {})).status).toBe(403);
    }
    expect((await api("manager", "GET", `${V}/competitors`)).status).toBe(200);
    expect((await api("owner", "GET", `${V}/price-alerts`)).status).toBe(200);
  });
});

describe("manual prices, matching and comparison", () => {
  it("manual prices with explicit product link produce comparison numbers", async () => {
    const m1 = await api("manager", "POST", `${V}/competitor-prices/manual`, { competitorId: compA, name: "Táo Envy NZ", packText: "1kg", packQtyMilli: 1000, packUnit: "kg", price: 90000, productId: 1, inStock: true });
    expect(m1.status).toBe(201);
    expect(m1.body.unitPrice).toBe(90000);
    const m2 = await api("manager", "POST", `${V}/competitor-prices/manual`, { competitorId: compB, name: "Táo Envy NZ", packText: "500g", packQtyMilli: 500, packUnit: "kg", price: 40000, productId: 1, observedAt: new Date().toISOString() });
    expect(m2.body.unitPrice).toBe(80000);
    const r = await api("manager", "GET", `${V}/price-comparison`);
    const it = r.body.items.find((x: any) => x.productId === 1);
    expect(it).toMatchObject({ ourPrice: 100000, marketMin: 80000, marketAvg: 85000, diffMinBp: 2500, diffAvgBp: 1765 });
    expect(it.competitors).toHaveLength(2);
    for (const c of it.competitors) expect(c.observedAt).toBeTruthy();
    expect((await api("manager", "GET", `${V}/price-comparison?onlyCheaper=1`)).body.items.some((x: any) => x.productId === 1)).toBe(true);
    expect((await api("manager", "GET", `${V}/price-comparison?groupId=2`)).body.items).toHaveLength(0);
  });

  it("stale observation (>7 days) and unknown pack are excluded; editing pack includes them", async () => {
    const stale = new Date(Date.now() - 10 * 86400_000).toISOString();
    const comp = (await api("manager", "POST", `${V}/competitors`, { name: "Cửa hàng C" })).body.id;
    const src = await db().prepare(`INSERT INTO competitor_sources(competitor_id, kind, parser) VALUES (?, 'manual','manual') RETURNING id`).bind(comp).first<{ id: number }>();
    const cp = await db().prepare(`INSERT INTO competitor_products(source_id, external_id, name) VALUES (?, 'x1', 'Táo Envy 1kg') RETURNING id`).bind(src!.id).first<{ id: number }>();
    await db().prepare(`INSERT INTO competitor_price_obs(competitor_product_id, observed_at, price, unit_price, source) VALUES (?,?,50000,NULL,'crawl')`).bind(cp!.id, new Date().toISOString()).run();
    await db().prepare(`INSERT INTO product_matches(product_id, competitor_product_id, status) VALUES (1,?, 'approved')`).bind(cp!.id).run();
    const names = async () => (await api("manager", "GET", `${V}/price-comparison`)).body.items.find((x: any) => x.productId === 1).competitors.map((c: any) => c.competitorName);
    expect(await names()).not.toContain("Cửa hàng C"); // quy cách chưa rõ
    const put = await api("manager", "PUT", `${V}/competitor-products/${cp!.id}`, { packQtyMilli: 1000, packUnit: "kg" });
    expect(put.status).toBe(200);
    expect(put.body.packKnown).toBe(true);
    expect(await names()).toContain("Cửa hàng C");
    // quan sát cũ hơn 7 ngày không được dùng
    await db().prepare(`UPDATE competitor_price_obs SET observed_at=? WHERE competitor_product_id=?`).bind(stale, cp!.id).run();
    expect(await names()).not.toContain("Cửa hàng C");
    await db().prepare(`UPDATE product_matches SET status='rejected' WHERE competitor_product_id=?`).bind(cp!.id).run();
    // history
    const h = await api("manager", "GET", `${V}/competitor-prices/history?productId=1&days=30`);
    expect(h.status).toBe(200);
    expect(h.body.series.length).toBeGreaterThanOrEqual(2);
    expect(h.body.series[0].points[0]).toHaveProperty("observedAt");
  });

  it("CSV import", async () => {
    const csv = `competitor,name,pack_qty,pack_unit,price,in_stock,observed_at,product_sku\nCửa hàng A,Nho Mỹ,500,g,"125.000",1,2026-11-20,NHO\nKhông có,X,1,kg,1000,,,\nCửa hàng B,Nho Mỹ,1,kg,230000,0,,`;
    const r = await api("manager", "POST", `${V}/competitor-prices/import`, { csv });
    expect(r.status).toBe(201);
    expect(r.body.imported).toBe(2);
    expect(r.body.errors).toHaveLength(1);
    const cp = await db().prepare(`SELECT o.unit_price, o.observed_at FROM competitor_price_obs o JOIN competitor_products cp ON cp.id=o.competitor_product_id WHERE cp.name='Nho Mỹ' AND o.source='import' AND cp.pack_qty_milli=500`).first<any>();
    expect(cp.unit_price).toBe(250000);
    expect(cp.observed_at.startsWith("2026-11-20")).toBe(true);
  });
});

describe("matching suggestions (M7-03, EC-37)", () => {
  it("suggests by name similarity + unit compat, never auto-approves, decision persisted", async () => {
    const xoai = (await api("manager", "POST", `${V}/products`, { sku: "XOAI-M", name: "Xoài cát Hòa Lộc", baseUnit: "kg", sellByWeight: true })).body.id;
    const src = await db().prepare(`INSERT INTO competitor_sources(competitor_id, kind, parser) VALUES (?, 'manual','manual') RETURNING id`).bind(compB).first<{ id: number }>();
    const ins = async (ext: string, name: string, unit: string | null, qty: number | null) =>
      (await db().prepare(`INSERT INTO competitor_products(source_id, external_id, name, pack_unit, pack_qty_milli) VALUES (?,?,?,?,?) RETURNING id`).bind(src!.id, ext, name, unit, qty).first<{ id: number }>())!.id;
    const good = await ins("g", "Xoài cát Hòa Lộc loại 1 hộp 1kg", "kg", 1000);
    const wrongUnit = await ins("w", "Xoài cát Hòa Lộc 3 trái", "trai", 3000);
    const unrelated = await ins("u", "Dưa hấu không hạt", "kg", 2000);
    const r = await api("manager", "POST", `${V}/product-matches/suggest`, {});
    expect(r.body.created).toBeGreaterThan(0);
    const list = await api("manager", "GET", `${V}/product-matches?status=suggested`);
    const mine = list.body.items.filter((m: any) => [good, wrongUnit, unrelated].includes(m.competitorProductId));
    expect(mine.map((m: any) => m.competitorProductId)).toEqual(expect.arrayContaining([good]));
    expect(mine.some((m: any) => m.competitorProductId === wrongUnit)).toBe(false);
    expect(mine.some((m: any) => m.competitorProductId === unrelated && m.productId === xoai)).toBe(false);
    const m = mine.find((x: any) => x.competitorProductId === good && x.productId === xoai);
    expect(m).toMatchObject({ productName: "Xoài cát Hòa Lộc", competitorName: "Cửa hàng B", competitorProductName: "Xoài cát Hòa Lộc loại 1 hộp 1kg", status: "suggested" });
    expect(m.score).toBeGreaterThanOrEqual(70);
    // chưa duyệt => không vào so sánh
    expect(await db().prepare(`SELECT COUNT(*) n FROM product_matches WHERE status='approved' AND competitor_product_id=?`).bind(good).first<any>()).toMatchObject({ n: 0 });
    // suggest lần 2 không tạo trùng
    expect((await api("manager", "POST", `${V}/product-matches/suggest`, {})).body.created).toBe(0);
    const d = await api("manager", "POST", `${V}/product-matches/${m.id}/decide`, { decision: "approved" });
    expect(d.body.status).toBe("approved");
    const row = await db().prepare(`SELECT decided_by, decided_at FROM product_matches WHERE id=?`).bind(m.id).first<any>();
    expect(row.decided_by).toBeTruthy();
    expect((await api("manager", "GET", `${V}/product-matches?status=suggested`)).body.items.some((x: any) => x.id === m.id)).toBe(false);
    const rej = mine.find((x: any) => x.id !== m.id);
    if (rej) expect((await api("manager", "POST", `${V}/product-matches/${rej.id}/decide`, { decision: "rejected" })).body.status).toBe("rejected");
    const manual = await api("manager", "POST", `${V}/product-matches`, { productId: xoai, competitorProductId: unrelated });
    expect(manual.status).toBe(201);
    expect(manual.body.status).toBe("approved");
    expect((await api("cashier", "POST", `${V}/product-matches/${m.id}/decide`, { decision: "approved" })).status).toBe(403);
  });
});

describe("price suggestions (M7-10)", () => {
  let tao = 0, nho = 0;
  it("generates suggestions that never go below cost + group target margin", async () => {
    // Nho: thị trường 140k/kg nhưng giá sàn = 150k × 1.3 = 195k
    const nhoMkt = await db().prepare(`SELECT COUNT(*) n FROM competitor_price_obs o JOIN product_matches m ON m.competitor_product_id=o.competitor_product_id WHERE m.product_id=2 AND m.status='approved'`).first<any>();
    expect(nhoMkt.n).toBeGreaterThan(0); // đã có từ import CSV (SKU NHO) và match tay
    await api("manager", "POST", `${V}/competitor-prices/manual`, { competitorId: compA, name: "Nho giá rẻ", packQtyMilli: 1000, packUnit: "kg", price: 140000, productId: 2 });
    await db().prepare(`UPDATE competitor_price_obs SET status='rejected' WHERE source='import'`).run(); // chỉ giữ giá 140k làm thị trường
    const g = await api("manager", "POST", `${V}/price-suggestions/generate`, {});
    expect(g.status).toBe(200);
    const items = g.body.items;
    const sTao = items.find((x: any) => x.productId === 1);
    const sNho = items.find((x: any) => x.productId === 2);
    expect(sTao).toMatchObject({ currentPrice: 100000, status: "pending" });
    expect(sTao.suggestedPrice).toBeLessThan(100000);
    expect(sTao.suggestedPrice).toBeGreaterThanOrEqual(78000);
    expect(sNho).toMatchObject({ currentPrice: 200000, suggestedPrice: 195000 });
    expect(sNho.suggestedPrice).toBeGreaterThanOrEqual(195000);
    tao = sTao.id;
    nho = sNho.id;
    // tạo lần 2 không trùng
    expect((await api("manager", "POST", `${V}/price-suggestions/generate`, {})).body.created).toBe(0);
    expect((await api("manager", "GET", `${V}/price-suggestions?status=pending`)).body.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([tao, nho]));
  });

  it("accept goes through the M3 flow: manager -> active price with history", async () => {
    const before = (await db().prepare(`SELECT COUNT(*) n FROM prices WHERE product_id=1`).first<any>()).n;
    const r = await api("manager", "POST", `${V}/price-suggestions/${tao}/accept`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "accepted", priceStatus: "active" });
    const s = await db().prepare(`SELECT status, price_id FROM price_suggestions WHERE id=?`).bind(tao).first<any>();
    expect(s.status).toBe("accepted");
    const p = await db().prepare(`SELECT unit_price, status FROM prices WHERE id=?`).bind(s.price_id).first<any>();
    expect(p).toMatchObject({ status: "active" });
    expect((await db().prepare(`SELECT COUNT(*) n FROM prices WHERE product_id=1`).first<any>()).n).toBe(before + 1); // giữ lịch sử
    expect((await db().prepare(`SELECT COUNT(*) n FROM prices WHERE product_id=1 AND effective_to IS NOT NULL`).first<any>()).n).toBeGreaterThan(0);
    expect((await api("manager", "POST", `${V}/price-suggestions/${tao}/accept`)).status).toBe(409);
  });

  it("without prices.approve the new price is pending with an approval request", async () => {
    (ROLE_PERMS.accountant as Set<string>).add("prices.write");
    const r = await api("accountant", "POST", `${V}/price-suggestions/${nho}/accept`);
    (ROLE_PERMS.accountant as Set<string>).delete("prices.write");
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: "accepted", priceStatus: "pending_approval" });
    const ap = await db().prepare(`SELECT status, ref_type FROM approvals WHERE type='price.activate' AND ref_id=?`).bind(String(r.body.priceId)).first<any>();
    expect(ap).toMatchObject({ status: "pending", ref_type: "price" });
    expect((await api("cashier", "GET", `${V}/prices/quote?productId=2`)).body.unitPrice).toBe(200000); // chưa đổi
  });

  it("accept refuses a price under the current cost floor; dismiss works", async () => {
    const bad = await db()
      .prepare(`INSERT INTO price_suggestions(product_id, price_list_id, current_price, suggested_price, reason) VALUES (1,1,100000,50000,'test') RETURNING id`)
      .first<{ id: number }>();
    const r = await api("manager", "POST", `${V}/price-suggestions/${bad!.id}/accept`);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("below_cost_floor");
    expect((await db().prepare(`SELECT status FROM price_suggestions WHERE id=?`).bind(bad!.id).first<any>()).status).toBe("pending");
    const d = await api("manager", "POST", `${V}/price-suggestions/${bad!.id}/dismiss`);
    expect(d.body.status).toBe("dismissed");
    expect((await api("manager", "POST", `${V}/price-suggestions/${bad!.id}/dismiss`)).status).toBe(409);
    expect((await api("cashier", "POST", `${V}/price-suggestions/${bad!.id}/accept`)).status).toBe(403);
  });
});
