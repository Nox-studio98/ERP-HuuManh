import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { crawlSource } from "../src/worker/services/competitor-crawler";
import { vnDate } from "../src/worker/lib/time";

// Fix 5c: B-15 giá đối thủ hết hàng / ngưỡng bất thường khi ít dữ liệu, B-18 làm tròn quy đổi thùng→kg
const V = "/api/v1";
const db = () => testEnv.DB;
const HOST = "https://rival5c.example.vn";

beforeAll(async () => {
  await seedBase();
  await seedSales(); // Táo (1): giá 100k, vốn 60k
});
afterEach(() => vi.restoreAllMocks());

describe("B-15: giá đối thủ hết hàng", () => {
  it("quan sát in_stock=0 không vào min/avg và không sinh gợi ý giá thấp", async () => {
    const now = new Date().toISOString();
    for (const [name, price, stock] of [["Đối thủ còn hàng", 90000, 1], ["Đối thủ hết hàng", 40000, 0]] as const) {
      const comp = (await api("manager", "POST", `${V}/competitors`, { name })).body.id;
      const src = await db().prepare(`INSERT INTO competitor_sources(competitor_id, kind, parser) VALUES (?, 'manual','manual') RETURNING id`).bind(comp).first<{ id: number }>();
      const cp = await db().prepare(`INSERT INTO competitor_products(source_id, external_id, name, pack_qty_milli, pack_unit) VALUES (?, 'k', 'Táo 1kg', 1000, 'kg') RETURNING id`).bind(src!.id).first<{ id: number }>();
      await db().prepare(`INSERT INTO competitor_price_obs(competitor_product_id, observed_at, price, unit_price, in_stock, source, status) VALUES (?,?,?,?,?,'crawl','ok')`).bind(cp!.id, now, price, price, stock).run();
      await db().prepare(`INSERT INTO product_matches(product_id, competitor_product_id, status) VALUES (1,?, 'approved')`).bind(cp!.id).run();
    }
    const it = (await api("manager", "GET", `${V}/price-comparison`)).body.items.find((x: any) => x.productId === 1);
    expect(it.marketMin).toBe(90000);
    expect(it.marketAvg).toBe(90000);
    expect(it.competitors).toHaveLength(2); // vẫn hiện, kèm cờ hết hàng
    expect(it.competitors.some((c: any) => c.inStock === false)).toBe(true);
    const gen = await api("manager", "POST", `${V}/price-suggestions/generate`);
    expect(gen.status).toBe(200);
    const s = gen.body.items.find((x: any) => x.productId === 1);
    expect(s.marketMin).toBe(90000);
    expect(s.suggestedPrice).toBeGreaterThanOrEqual(78000);
    expect(s.suggestedPrice).toBe(90000);
  });

  it("ít hơn 3 giá tham chiếu: so với giá bán của ta → quan sát lệch >50% bị đánh dấu bất thường", async () => {
    const comp = (await api("manager", "POST", `${V}/competitors`, { name: "Đối thủ crawl 5c" })).body.id;
    const url = `${HOST}/trai-cay`;
    const sid = (await db().prepare(`INSERT INTO competitor_sources(competitor_id, kind, url, parser, min_delay_ms, max_pages) VALUES (?, 'website', ?, 'jsonld', 0, 1) RETURNING id`).bind(comp, url).first<{ id: number }>())!.id;
    const page = (price: number) =>
      `<script type="application/ld+json">${JSON.stringify([{ "@type": "Product", name: "Táo Envy 1kg", url: `${HOST}/p/tao`, offers: { "@type": "Offer", price: String(price), priceCurrency: "VND", availability: "https://schema.org/InStock" } }])}</script>`;
    let price = 95000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const u = typeof input === "string" ? input : input.url;
      if (u === `${HOST}/robots.txt`) return new Response("User-agent: *\nAllow: /");
      if (u === url) return new Response(page(price));
      return new Response("", { status: 404 });
    });
    await crawlSource(testEnv, sid);
    const cp = await db().prepare(`SELECT id FROM competitor_products WHERE source_id=?`).bind(sid).first<{ id: number }>();
    await db().prepare(`INSERT INTO product_matches(product_id, competitor_product_id, status) VALUES (1,?, 'approved')`).bind(cp!.id).run();
    price = 30000; // lệch 70% so với giá bán 100.000; chỉ có 1 giá tham chiếu
    await crawlSource(testEnv, sid);
    const last = await db().prepare(`SELECT status FROM competitor_price_obs WHERE competitor_product_id=? ORDER BY id DESC LIMIT 1`).bind(cp!.id).first<any>();
    expect(last.status).toBe("outlier");
    // giá lệch ít vẫn được nhận
    price = 92000;
    await crawlSource(testEnv, sid);
    expect((await db().prepare(`SELECT status FROM competitor_price_obs WHERE competitor_product_id=? ORDER BY id DESC LIMIT 1`).bind(cp!.id).first<any>()).status).toBe("ok");
  });
});

describe("B-18: làm tròn thống nhất SQL / code", () => {
  it("giá trị tồn / hao hụt báo cáo làm tròn từng dòng thẻ kho như money.ts (không cắt cụt)", async () => {
    await db().batch([
      db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (5801,'F5C-R','Hàng làm tròn','kg')`),
      db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (5801,'F5C-RL',5801,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,3000,3000)`),
      // mỗi dòng 1500 milli × 1đ = 1,5đ → Math.round = 2đ; SQL chia nguyên cắt cụt = 1đ
      db().prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id) VALUES (5801,5801,1500,1,'receipt','x',1),(5801,5801,1500,1,'receipt','x',2)`),
    ]);
    const today = vnDate();
    const inv = await api("manager", "GET", `${V}/reports/inventory?asOf=${today}`);
    expect(inv.status).toBe(200);
    const row = inv.body.items.find((i: any) => i.sku === "F5C-R");
    expect(row.stockValue).toBe(4);
  });

  it("quy đổi thùng→kg: ghi sổ phiếu nhập ghi lệch làm tròn giữa giá trị lô và hoá đơn mua", async () => {
    await db().prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (5801,'thung',10000)`).run();
    await db().prepare(`INSERT INTO suppliers(id, code, name) VALUES (5802,'F5C-N2','NCC làm tròn')`).run();
    const d = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId: 5802, supplierRef: "HD-RND" });
    await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { productId: 5801, unit: "thung", qty: 3, unitCost: 155_555 });
    const p = await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`);
    expect(p.status).toBe(200);
    const bill = await db().prepare(`SELECT total FROM supplier_bills WHERE stock_doc_id=?`).bind(d.body.id).first<any>();
    const lot = await db().prepare(`SELECT unit_cost, qty_in_milli FROM lots WHERE receipt_doc_id=?`).bind(d.body.id).first<any>();
    expect(bill.total).toBe(466_665);
    expect(Math.round((lot.unit_cost * lot.qty_in_milli) / 1000)).toBe(466_680);
    expect(p.body.roundingDiff).toBe(15);
    const a = await db().prepare(`SELECT after_json FROM audit_log WHERE action='stock_doc.post.receipt' AND entity_id=?`).bind(String(d.body.id)).first<any>();
    expect(a.after_json).toContain('"roundingDiff":15');
  });
});
