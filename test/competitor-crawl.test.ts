import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { crawlSource } from "../src/worker/services/competitor-crawler";
import { runDueCompetitorCrawls } from "../src/worker/services/competitor-cron";

const V = "/api/v1";
const db = () => testEnv.DB;
const HOST = "https://rival.example.vn";

type Reply = { status?: number; body?: string; headers?: Record<string, string> };
let calls: string[] = [];
function mockFetch(routes: Record<string, Reply | (() => Reply)>) {
  calls = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    const r = routes[url];
    const rep = typeof r === "function" ? r() : r;
    if (!rep) return new Response("not found", { status: 404 });
    return new Response(rep.body ?? "", { status: rep.status ?? 200, headers: rep.headers });
  });
}
const ld = (...products: any[]) =>
  `<html><script type="application/ld+json">${JSON.stringify(products.map((p) => ({ "@type": "Product", ...p })))}</script></html>`;
const prod = (name: string, price: number, path: string, extra: any = {}) => ({
  name, url: `${HOST}${path}`, offers: { "@type": "Offer", price: String(price), priceCurrency: "VND", availability: "https://schema.org/InStock" }, ...extra,
});

let nextId = 8000;
async function mkSource(opts: { parser?: string; cfg?: unknown; url?: string; maxPages?: number } = {}) {
  const n = nextId++;
  const cid = (await db().prepare(`INSERT INTO competitors(name) VALUES (?) RETURNING id`).bind(`Đối thủ ${n}`).first<{ id: number }>())!.id;
  const sid = (
    await db()
      .prepare(`INSERT INTO competitor_sources(competitor_id, kind, url, parser, parser_config_json, min_delay_ms, max_pages) VALUES (?, 'website', ?,?,?, 0, ?) RETURNING id`)
      .bind(cid, opts.url ?? `${HOST}/trai-cay?c=${n}`, opts.parser ?? "jsonld", opts.cfg ? JSON.stringify(opts.cfg) : null, opts.maxPages ?? 5)
      .first<{ id: number }>()
  )!.id;
  if (!opts.url) await db().prepare(`UPDATE competitor_sources SET url=? WHERE id=?`).bind(`${HOST}/trai-cay?c=${sid}`, sid).run();
  return { cid, sid };
}
const srcRow = (sid: number) => db().prepare(`SELECT * FROM competitor_sources WHERE id=?`).bind(sid).first<any>();
const count = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<{ n: number }>())!.n;

beforeAll(async () => {
  await seedBase();
  await seedSales();
});
afterEach(() => vi.restoreAllMocks());

describe("crawler", () => {
  it("robots.txt Disallow -> skipped, no page fetched, alert", async () => {
    const { sid } = await mkSource();
    mockFetch({ [`${HOST}/robots.txt`]: { body: "User-agent: *\nDisallow: /trai-cay" } });
    const r = await crawlSource(testEnv, sid);
    expect(r).toMatchObject({ status: "skipped", sourceStatus: "robots_disallow", pages: 0, items: 0 });
    expect(calls).toEqual([`${HOST}/robots.txt`]);
    const s = await srcRow(sid);
    expect(s).toMatchObject({ robots_allowed: 0, last_status: "robots_disallow" });
    expect(await count(`SELECT COUNT(*) n FROM price_alerts WHERE kind='source_failed' AND source_id=?`, sid)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM crawl_runs WHERE source_id=? AND status='skipped'`, sid)).toBe(1);
  });

  it("JSON-LD page parsed, pack normalised, UA sent, robots cached 24h", async () => {
    const { sid } = await mkSource();
    const url = `${HOST}/trai-cay?c=${sid}`;
    const spy = mockFetch({
      [`${HOST}/robots.txt`]: { body: "User-agent: *\nAllow: /" },
      [url]: { body: ld(prod("Nho Mỹ hộp 500g", 125000, "/p/nho"), prod("Cam sành 1kg", 45000, "/p/cam"), prod("Dưa lưới 2 trái", 90000, "/p/dua"), prod("Quà tặng", 100000, "/p/qua")) },
    });
    const r = await crawlSource(testEnv, sid);
    expect(r).toMatchObject({ status: "ok", sourceStatus: "ok", pages: 1, items: 4 });
    const ua = (spy.mock.calls[1][1] as any).headers["user-agent"];
    expect(ua).toContain("HuuManhPriceBot");
    const { results } = await db()
      .prepare(`SELECT cp.name, cp.pack_unit, cp.pack_qty_milli, o.price, o.unit_price, o.status, o.in_stock FROM competitor_products cp JOIN competitor_price_obs o ON o.competitor_product_id = cp.id WHERE cp.source_id=? ORDER BY cp.id`)
      .bind(sid)
      .all<any>();
    expect(results[0]).toMatchObject({ pack_unit: "kg", pack_qty_milli: 500, unit_price: 250000, price: 125000, status: "ok", in_stock: 1 });
    expect(results[1]).toMatchObject({ unit_price: 45000 });
    expect(results[2]).toMatchObject({ pack_unit: "trai", unit_price: 45000 });
    expect(results[3]).toMatchObject({ pack_qty_milli: null, unit_price: null }); // quy cách chưa rõ -> không so sánh
    const s = await srcRow(sid);
    expect(s).toMatchObject({ robots_allowed: 1, last_status: "ok", consecutive_failures: 0 });
    // lần 2 trong 24h: không tải lại robots.txt
    await crawlSource(testEnv, sid);
    expect(calls.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(1);
    expect(await count(`SELECT COUNT(*) n FROM competitor_price_obs o JOIN competitor_products cp ON cp.id=o.competitor_product_id WHERE cp.source_id=?`, sid)).toBe(8);
  });

  it("CSS config with pagination stops at empty page", async () => {
    const cfg = { itemSelector: "li.p", nameSelector: ".n", priceSelector: ".v", linkSelector: "a", packSelector: ".k", pageParam: "page" };
    const { sid } = await mkSource({ parser: "css", cfg, url: `${HOST}/css?c=1`, maxPages: 5 });
    const item = (n: string, p: string, k: string, l: string) => `<li class="p"><a href="${l}"><span class="n">${n}</span></a><span class="v">${p}</span><span class="k">${k}</span></li>`;
    mockFetch({
      [`${HOST}/robots.txt`]: { status: 404 },
      [`${HOST}/css?c=1`]: { body: `<ul>${item("Xoài cát", "1.250.000 VND", "1kg", "/x1")}${item("Ổi", "30,000 ₫", "500g", "/x2")}</ul>` },
      [`${HOST}/css?c=1&page=2`]: { body: `<ul>${item("Mít", "60.000đ", "2 trái", "/x3")}</ul>` },
      [`${HOST}/css?c=1&page=3`]: { body: `<ul></ul>` },
    });
    const r = await crawlSource(testEnv, sid);
    expect(r).toMatchObject({ status: "ok", pages: 3, items: 3 });
    const { results } = await db().prepare(`SELECT name, pack_unit, last_price FROM competitor_products WHERE source_id=? ORDER BY id`).bind(sid).all<any>();
    expect(results.map((x) => [x.name, x.pack_unit, x.last_price])).toEqual([["Xoài cát", "kg", 1250000], ["Ổi", "kg", 30000], ["Mít", "trai", 60000]]);
  });

  it("respects max_pages", async () => {
    const cfg = { itemSelector: "li", nameSelector: "b", priceSelector: "i", linkSelector: "a", pageParam: "p" };
    const { sid } = await mkSource({ parser: "css", cfg, url: `${HOST}/mp`, maxPages: 2 });
    const page = (n: number) => ({ body: `<li><a href="/m${n}"><b>Mặt hàng ${n} 1kg</b></a><i>10.000đ</i></li>` });
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [`${HOST}/mp`]: page(1), [`${HOST}/mp?p=2`]: page(2), [`${HOST}/mp?p=3`]: page(3) });
    const r = await crawlSource(testEnv, sid);
    expect(r.pages).toBe(2);
  });

  it("429 -> blocked, failure counted, alert, old data kept", async () => {
    const { sid } = await mkSource();
    const url = `${HOST}/trai-cay?c=${sid}`;
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [url]: { body: ld(prod("Lê 1kg", 50000, `/p/le${sid}`)) } });
    await crawlSource(testEnv, sid);
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [url]: { status: 429 } });
    // robots đã cache; chạy lại
    const r = await crawlSource(testEnv, sid);
    expect(r).toMatchObject({ status: "failed", sourceStatus: "blocked" });
    expect(await srcRow(sid)).toMatchObject({ last_status: "blocked", consecutive_failures: 1 });
    expect(await count(`SELECT COUNT(*) n FROM price_alerts WHERE kind='source_failed' AND source_id=?`, sid)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM competitor_products WHERE source_id=?`, sid)).toBe(1); // giữ dữ liệu cũ
    await crawlSource(testEnv, sid);
    expect((await srcRow(sid)).consecutive_failures).toBe(2);
    expect(await count(`SELECT COUNT(*) n FROM price_alerts WHERE kind='source_failed' AND source_id=?`, sid)).toBe(1); // không lặp cảnh báo chưa xử lý
  });

  it("captcha page -> blocked (no bypass)", async () => {
    const { sid } = await mkSource();
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [`${HOST}/trai-cay?c=${sid}`]: { body: "<html><div class='g-recaptcha'></div></html>" } });
    expect((await crawlSource(testEnv, sid)).sourceStatus).toBe("blocked");
  });

  it("layout change (EC-35): zero products where there were some -> layout_changed + alert, data kept", async () => {
    const { sid } = await mkSource();
    const url = `${HOST}/trai-cay?c=${sid}`;
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [url]: { body: ld(prod("Chôm chôm 1kg", 40000, `/p/cc${sid}`)) } });
    await crawlSource(testEnv, sid);
    mockFetch({ [url]: { body: "<html><body>Trang mới</body></html>" } });
    const r = await crawlSource(testEnv, sid);
    expect(r.sourceStatus).toBe("layout_changed");
    expect((await srcRow(sid)).last_status).toBe("layout_changed");
    expect(await count(`SELECT COUNT(*) n FROM price_alerts WHERE kind='source_failed' AND source_id=? AND message LIKE '%layout_changed%'`, sid)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM competitor_products WHERE source_id=?`, sid)).toBe(1);
  });

  it("outlier flagged (EC-36), excluded from comparison until approved; big change + cheaper alerts", async () => {
    const { sid } = await mkSource();
    const url = `${HOST}/trai-cay?c=${sid}`;
    const ext = `${HOST}/p/xoai${sid}`;
    const cp = await db()
      .prepare(`INSERT INTO competitor_products(source_id, external_id, url, name, pack_text, pack_qty_milli, pack_unit, last_price) VALUES (?,?,?, 'Xoài 1kg','1kg',1000,'kg',100000) RETURNING id`)
      .bind(sid, ext, ext)
      .first<{ id: number }>();
    for (let i = 1; i <= 3; i++) {
      await db().prepare(`INSERT INTO competitor_price_obs(competitor_product_id, observed_at, price, unit_price, source, status) VALUES (?,?,100000,100000,'manual','ok')`).bind(cp!.id, new Date(Date.now() - i * 3600_000).toISOString()).run();
    }
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [url]: { body: ld(prod("Xoài 1kg", 300000, `/p/xoai${sid}`)) } });
    await crawlSource(testEnv, sid);
    const obs = await db().prepare(`SELECT id, status FROM competitor_price_obs WHERE competitor_product_id=? ORDER BY id DESC LIMIT 1`).bind(cp!.id).first<any>();
    expect(obs.status).toBe("outlier");
    expect((await db().prepare(`SELECT last_price FROM competitor_products WHERE id=?`).bind(cp!.id).first<any>()).last_price).toBe(100000); // chưa nhận
    expect(await count(`SELECT COUNT(*) n FROM price_alerts WHERE kind='outlier' AND competitor_product_id=?`, cp!.id)).toBe(1);
    const list = await api("manager", "GET", `${V}/competitor-prices/outliers`);
    const row = list.body.items.find((x: any) => x.obsId === obs.id);
    expect(row).toMatchObject({ unitPrice: 300000, medianUnitPrice: 100000, deviationBp: 20000 });
    expect((await api("cashier", "GET", `${V}/competitor-prices/outliers`)).status).toBe(403);
    const ok = await api("manager", "POST", `${V}/competitor-prices/${obs.id}/decide`, { decision: "approved" });
    expect(ok.body.status).toBe("approved_outlier");
    expect((await api("manager", "POST", `${V}/competitor-prices/${obs.id}/decide`, { decision: "approved" })).status).toBe(409);
    expect((await db().prepare(`SELECT last_price FROM competitor_products WHERE id=?`).bind(cp!.id).first<any>()).last_price).toBe(300000);
  });

  it("big price change and competitor-cheaper alerts for approved match", async () => {
    const { sid } = await mkSource();
    const url = `${HOST}/trai-cay?c=${sid}`;
    const ext = `${HOST}/p/tao${sid}`;
    const cp = await db()
      .prepare(`INSERT INTO competitor_products(source_id, external_id, url, name, pack_text, pack_qty_milli, pack_unit, last_price) VALUES (?,?,?, 'Táo Envy 1kg','1kg',1000,'kg',130000) RETURNING id`)
      .bind(sid, ext, ext)
      .first<{ id: number }>();
    await db().prepare(`INSERT INTO product_matches(product_id, competitor_product_id, status) VALUES (1,?, 'approved')`).bind(cp!.id).run();
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [url]: { body: ld(prod("Táo Envy 1kg", 90000, `/p/tao${sid}`)) } });
    await crawlSource(testEnv, sid);
    const kinds = (await db().prepare(`SELECT kind FROM price_alerts WHERE competitor_product_id=? ORDER BY id`).bind(cp!.id).all<any>()).results.map((r) => r.kind);
    expect(kinds).toEqual(["big_change", "competitor_cheaper"]);
    const alerts = await api("manager", "GET", `${V}/price-alerts?acked=0`);
    const a = alerts.body.items.find((x: any) => x.kind === "competitor_cheaper" && x.competitorProductId === cp!.id);
    expect(a.productName).toBe("Táo Envy");
    expect((await api("manager", "POST", `${V}/price-alerts/${a.id}/ack`)).status).toBe(200);
    expect((await api("manager", "GET", `${V}/price-alerts?acked=0`)).body.items.some((x: any) => x.id === a.id)).toBe(false);
  });

  it("manual run endpoint works and rejects manual sources", async () => {
    const { sid } = await mkSource();
    mockFetch({ [`${HOST}/robots.txt`]: { status: 404 }, [`${HOST}/trai-cay?c=${sid}`]: { body: ld(prod("Bưởi 1kg", 35000, `/p/buoi${sid}`)) } });
    const r = await api("manager", "POST", `${V}/competitor-sources/${sid}/run`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok", items: 1 });
    const runs = await api("manager", "GET", `${V}/competitor-sources/${sid}/runs`);
    expect(runs.body.items[0]).toMatchObject({ status: "ok", items: 1 });
    expect((await api("cashier", "POST", `${V}/competitor-sources/${sid}/run`)).status).toBe(403);
    const comp = await api("manager", "POST", `${V}/competitors`, { name: "Thủ công" });
    const man = await api("manager", "POST", `${V}/competitors/${comp.body.id}/sources`, { kind: "manual" });
    expect(man.status).toBe(201);
    expect((await api("manager", "POST", `${V}/competitor-sources/${man.body.id}/run`)).status).toBe(422);
  });

  it("source validation: private URLs rejected", async () => {
    const comp = await api("manager", "POST", `${V}/competitors`, { name: "Kiểm tra URL" });
    for (const url of ["http://localhost/x", "http://169.254.169.254/", "ftp://a.com/x", "http://intranet/x"]) {
      expect((await api("manager", "POST", `${V}/competitors/${comp.body.id}/sources`, { kind: "website", url })).status).toBe(422);
    }
    const css = await api("manager", "POST", `${V}/competitors/${comp.body.id}/sources`, { kind: "website", url: "https://ok.example.vn/a", parser: "css", parserConfig: { itemSelector: "li" } });
    expect(css.status).toBe(422);
  });
});

describe("cron", () => {
  it("processes at most 2 due sources per run and never throws", async () => {
    await db().prepare(`UPDATE competitor_sources SET active = 0`).run();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await mkSource()).sid);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(runDueCompetitorCrawls(testEnv)).resolves.toBeUndefined();
    const runs = await count(`SELECT COUNT(*) n FROM crawl_runs WHERE source_id IN (${ids.join(",")})`);
    expect(runs).toBe(2);
    const failed = await count(`SELECT COUNT(*) n FROM crawl_runs WHERE source_id IN (${ids.join(",")}) AND status='failed'`);
    expect(failed).toBe(2);
    // lần sau xử lý nguồn còn lại (nguồn vừa lỗi lùi lịch)
    await runDueCompetitorCrawls(testEnv);
    expect(await count(`SELECT COUNT(*) n FROM crawl_runs WHERE source_id=?`, ids[2])).toBe(1);
  });
});
