import { describe, expect, it } from "vitest";
import { matchName, median, nameScore, parseCss, parseJsonLd, parsePack, parseRobots, parseVnPrice, robotsAllows, unitPriceOf, unitsCompatible } from "../src/worker/services/competitor-parse";

describe("parseVnPrice", () => {
  it.each([
    ["125.000đ", 125000],
    ["125,000 ₫", 125000],
    ["1.250.000 VND", 1250000],
    ["Giá: 99.000 đ/kg", 99000],
    ["125000.00", 125000],
    ["125000", 125000],
    ["99k", 99000],
    ["100.000đ - 150.000đ", 100000],
    ["Liên hệ", null],
    ["0đ", null],
  ])("%s -> %s", (t, n) => expect(parseVnPrice(t)).toBe(n));
  it("accepts numbers", () => expect(parseVnPrice(125000)).toBe(125000));
});

describe("parsePack (M7-04)", () => {
  it.each([
    ["500g", 500, "kg"],
    ["1kg", 1000, "kg"],
    ["1,5 kg", 1500, "kg"],
    ["Nho Mỹ hộp 250g", 250, "kg"],
    ["Cam sành túi 2kg", 2000, "kg"],
    ["3 trái", 3000, "trai"],
    ["Dưa hấu 2 quả", 2000, "trai"],
    ["Combo 3 x 500g", 1500, "kg"],
    ["1.500g", 1500, "kg"],
  ])("%s", (t, q, u) => expect(parsePack(t)).toEqual({ qtyMilli: q, unit: u }));
  it("unknown pack -> null; unit price null", () => {
    expect(parsePack("Nho Mỹ hộp")).toBeNull();
    expect(parsePack(null)).toBeNull();
    expect(unitPriceOf(125000, null)).toBeNull();
  });
  it("unit price per kg / per trai", () => {
    expect(unitPriceOf(60000, 500)).toBe(120000);
    expect(unitPriceOf(30000, 3000)).toBe(10000);
    expect(unitsCompatible("kg", "kg")).toBe(true);
    expect(unitsCompatible("kg", "trai")).toBe(false);
    expect(unitsCompatible("khay", "kg")).toBe(false);
  });
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe("matching score", () => {
  it("similar names score high, different low", () => {
    expect(matchName("Nho Mỹ hộp 500g")).toBe("nho my");
    expect(nameScore("Nho Mỹ", "Nho Mỹ hộp 500g")).toBeGreaterThanOrEqual(90);
    expect(nameScore("Táo Envy", "Táo envy New Zealand 1kg")).toBeGreaterThanOrEqual(70);
    expect(nameScore("Táo Envy", "Dưa hấu không hạt")).toBeLessThan(40);
  });
});

describe("robots.txt", () => {
  const ua = "HuuManhPriceBot/1.0 (+x)";
  it("applies * group and longest match with Allow", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.json$\nCrawl-delay: 5", ua);
    expect(robotsAllows(r, "/shop")).toBe(true);
    expect(robotsAllows(r, "/private/x")).toBe(false);
    expect(robotsAllows(r, "/private/ok/y")).toBe(true);
    expect(robotsAllows(r, "/a.json")).toBe(false);
    expect(r.crawlDelaySec).toBe(5);
  });
  it("our own group overrides *", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: HuuManhPriceBot\nDisallow: /admin", ua);
    expect(robotsAllows(r, "/shop")).toBe(true);
    expect(robotsAllows(r, "/admin")).toBe(false);
  });
  it("Disallow: / blocks all; empty Disallow allows", () => {
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /", ua), "/x")).toBe(false);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow:", ua), "/x")).toBe(true);
  });
});

describe("page parsers", () => {
  it("JSON-LD: Product in @graph and ItemList, skips non-VND", () => {
    const html = `<html><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Product", name: "Nho Mỹ hộp 500g", url: "/p/nho", offers: { "@type": "Offer", price: "125000", priceCurrency: "VND", availability: "https://schema.org/InStock" } },
        { "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: { "@type": "Product", name: "Cam 1kg", sku: "C1", offers: [{ price: 45000, priceCurrency: "VND", availability: "OutOfStock" }] } }] },
        { "@type": "Product", name: "USD item", offers: { price: "5", priceCurrency: "USD" } },
      ],
    })}</script><script type="application/ld+json">{broken</script></html>`;
    const items = parseJsonLd(html, "https://x.vn/shop");
    expect(items.map((i) => [i.name, i.price, i.inStock, i.externalId])).toEqual([
      ["Nho Mỹ hộp 500g", 125000, true, "https://x.vn/p/nho"],
      ["Cam 1kg", 45000, false, "sku:C1"],
    ]);
  });
  it("CSS @attr selector reads attribute value", async () => {
    const items = await parseCss(`<p class="i"><b>Lê</b><meta class="pr" content="30,000 đ"></p>`, "https://x.vn/", { itemSelector: "p.i", nameSelector: "b", priceSelector: ".pr@content" });
    expect(items).toMatchObject([{ name: "Lê", price: 30000 }]);
  });
  it("CSS selectors", async () => {
    const html = `<div class="item"><a class="t" href="/a">Xoài cát 1kg</a><span class="pr">1.250.000 VND</span><span class="pk">hộp 1kg</span></div>
      <div class="item"><a class="t" href="/b">Ổi</a><del class="pr">99.000đ</del><i class="soldout"></i></div>
      <div class="item"><a class="t" href="/c">Không giá</a></div>`;
    const items = await parseCss(html, "https://x.vn/s", {
      itemSelector: "div.item", nameSelector: "a.t", priceSelector: ".pr", linkSelector: "a.t", packSelector: ".pk", soldOutSelector: ".soldout",
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "Xoài cát 1kg", price: 1250000, url: "https://x.vn/a", packText: "hộp 1kg", inStock: true });
    expect(items[1]).toMatchObject({ name: "Ổi", price: 99000, inStock: false });
  });
});
