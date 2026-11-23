import { beforeAll, describe, expect, it } from "vitest";
import { call, seedShop, testEnv, today, tomorrow } from "./shop-helpers";
import { app } from "../src/shop/worker/index";
import { buildVietQr, crc16ccitt } from "../src/shop/worker/lib/vietqr";

beforeAll(seedShop);

describe("catalog", () => {
  it("hides unpublished and unpriced products and caps/floors availability", async () => {
    const r = await call("GET", "/api/products");
    expect(r.status).toBe(200);
    const ids = r.body.items.map((p: any) => p.id);
    expect(ids).toContain(901);
    expect(ids).toContain(902);
    expect(ids).not.toContain(903); // chưa công bố
    expect(ids).not.toContain(904); // không có giá
    const cam = r.body.items.find((p: any) => p.id === 901);
    // 300 kg thật → hiển thị tối đa 99 kg
    expect(cam).toMatchObject({ slug: "cam-sanh", price: 50000, baseUnit: "kg", unitLabel: "kg", inStock: true, availableMilli: 99000, stepMilli: 500, allowPreorder: false, imageUrl: "/img/products/901/a.webp" });
    expect(cam.units).toEqual([{ unit: "kg", factorMilli: 1000 }, { unit: "thung", factorMilli: 10000 }]);
    // tồn thật 2 kg, bước 0,5 → 2000; hết hàng → inStock false
    expect(r.body.items.find((p: any) => p.id === 902).availableMilli).toBe(2000);
    const mit = await call("GET", "/api/products/mit-het");
    expect(mit.body.inStock).toBe(false);
    expect(mit.body.availableMilli).toBe(0);
    expect(JSON.stringify(r.body)).not.toContain("300000");
  });

  it("floors availability to the step", async () => {
    await testEnv.DB.prepare(`UPDATE lots SET qty_on_hand_milli = 2700 WHERE id = 902`).run();
    expect((await call("GET", "/api/products/dau-da-lat")).body.availableMilli).toBe(2500);
    await testEnv.DB.prepare(`UPDATE lots SET qty_on_hand_milli = 2000 WHERE id = 902`).run();
  });

  it("searches, sorts and returns detail with related", async () => {
    expect((await call("GET", "/api/products?q=cam")).body.items.map((p: any) => p.id)).toEqual([901]);
    const asc = await call("GET", "/api/products?sort=price_asc");
    const prices = asc.body.items.map((p: any) => p.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect((await call("GET", "/api/products?groupId=2")).body.items.every((p: any) => [901, 902].includes(p.id))).toBe(true);
    const d = await call("GET", "/api/products/cam-sanh");
    expect(d.body).toMatchObject({ description: "Cam ngọt", images: ["/img/products/901/a.webp"], groupName: "Trái cây nội" });
    expect(d.body.related.map((p: any) => p.id)).toEqual([902]);
    expect((await call("GET", "/api/products/tao-an")).status).toBe(404);
    expect((await call("GET", "/api/products/xoai")).status).toBe(404);
  });

  it("home: only safe banner links, published posts, groups", async () => {
    const r = await call("GET", "/api/home");
    expect(r.status).toBe(200);
    expect(r.body.banners.find((b: any) => b.id === 1).linkUrl).toBe("/san-pham");
    expect(r.body.banners.find((b: any) => b.id === 2).linkUrl).toBeNull();
    expect(r.body.posts.map((p: any) => p.slug)).toEqual(["mua-cam"]);
    expect(r.body.featured.map((p: any) => p.id)).toEqual([901]);
    expect(r.body.groups.length).toBeGreaterThan(0);
    expect((await call("GET", "/api/posts/mua-cam")).body.title).toBe("Mùa cam");
    expect((await call("GET", "/api/posts/nhap")).status).toBe(404);
  });
});

describe("quote and delivery", () => {
  const item = (o: Record<string, unknown> = {}) => ({ productId: 901, unit: "kg", qty: 3, ...o });

  it("computes fee, free_over and zone", async () => {
    const r = await call("POST", "/api/cart/quote", { items: [item()], district: "quận 1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ subtotal: 150000, shippingFee: 20000, total: 170000, zone: { id: 1, name: "Nội thành" }, estimated: false, issues: [] });
    expect(r.body.lines[0]).toMatchObject({ productId: 901, unit: "kg", qty: 3, qtyMilli: 3000, unitPrice: 50000, lineTotal: 150000, available: true, preorderMilli: 0, sellByWeight: false });
    const free = await call("POST", "/api/cart/quote", { items: [item({ qty: 6 })], district: "Quan 1" });
    expect(free.body).toMatchObject({ subtotal: 300000, shippingFee: 0, total: 300000 });
    const thung = await call("POST", "/api/cart/quote", { items: [item({ unit: "thung", qty: 1 })], district: "Quận 3" });
    expect(thung.body.lines[0]).toMatchObject({ qtyMilli: 10000, lineTotal: 500000 });
  });

  it("reports zone_unsupported, min_order, unpublished, stock issues and weight estimate", async () => {
    const z = await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 12" });
    expect(z.body.zone).toBeNull();
    expect(z.body.issues.map((i: any) => i.code)).toContain("zone_unsupported");
    const m = await call("POST", "/api/cart/quote", { items: [item({ qty: 1 })], district: "Quận 1" });
    expect(m.body.issues.map((i: any) => i.code)).toContain("min_order");
    const u = await call("POST", "/api/cart/quote", { items: [item({ productId: 903 })] });
    expect(u.body.issues[0]).toMatchObject({ productId: 903, code: "unpublished" });
    expect(u.body.lines).toEqual([]);
    const s = await call("POST", "/api/cart/quote", { items: [{ productId: 902, unit: "kg", qty: 3 }] });
    expect(s.body.issues[0]).toMatchObject({ productId: 902, code: "insufficient" });
    expect(s.body.lines[0]).toMatchObject({ available: false, preorderMilli: 1000 }); // 902 cho đặt trước
    const o = await call("POST", "/api/cart/quote", { items: [{ productId: 906, unit: "kg", qty: 1 }] });
    expect(o.body.issues[0].code).toBe("out_of_stock");
    const w = await call("POST", "/api/cart/quote", { items: [{ productId: 905, unit: "kg", qty: 1 }] });
    expect(w.body.estimated).toBe(true);
    expect((await call("POST", "/api/cart/quote", { items: [item({ qty: 0.3 })] })).status).toBe(422); // sai bước 0,5 kg
  });

  it("lists slots with availability, reasons and the 7-day window", async () => {
    const r = await call("GET", `/api/delivery/slots?date=${tomorrow()}&district=Quận 1`);
    expect(r.body.zone).toMatchObject({ id: 1, name: "Nội thành" });
    expect(r.body.slots.find((s: any) => s.id === 1)).toMatchObject({ date: tomorrow(), label: "8:00–10:00", startTime: "08:00", endTime: "10:00", available: true });
    const t = await call("GET", `/api/delivery/slots?date=${today()}`);
    expect(t.body.slots.find((s: any) => s.id === 3)).toMatchObject({ available: false, reason: "cutoff" });
    const week = await call("GET", "/api/delivery/slots");
    expect(new Set(week.body.slots.map((s: any) => s.date)).size).toBe(7);
  });
});

describe("static endpoints and security headers", () => {
  it("serves images only from products/ and cms/ without traversal", async () => {
    await testEnv.FILES.put("products/901/a.webp", "IMG", { httpMetadata: { contentType: "application/octet-stream" } });
    await testEnv.FILES.put("secret/x.png", "SECRET");
    const ok = await call("GET", "/img/products/901/a.webp");
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get("content-type")).toBe("image/webp");
    expect(ok.res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(ok.text).toBe("IMG");
    expect((await call("GET", "/img/secret/x.png")).status).toBe(404);
    expect((await call("GET", "/img/products/..%2Fsecret%2Fx.png")).status).toBe(404);
    expect((await call("GET", "/img/products/%2e%2e/secret/x.png")).status).toBe(404);
    expect((await call("GET", "/img/products/901/a.exe")).status).toBe(404);
    expect((await call("GET", "/img/products/zzz.png")).status).toBe(404);
  });

  it("robots, sitemap and CSP", async () => {
    const r = await call("GET", "/robots.txt");
    expect(r.text).toContain("Disallow: /api/");
    expect(r.text).toContain("Sitemap: http://localhost/sitemap.xml");
    const s = await call("GET", "/sitemap.xml");
    expect(s.res.headers.get("content-type")).toContain("xml");
    expect(s.text).toContain("cam-sanh");
    expect(s.text).toContain("mua-cam");
    expect(s.text).not.toContain("tao-an");
    expect(s.text).not.toContain("nhap<");
    const h = await call("GET", "/api/health");
    const csp = h.res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(csp).toContain("connect-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(h.res.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/api/nope", {}, { ...testEnv } as any)).status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("returns 429 when RATE_LIMITER rejects, keyed per bucket and IP; no-op without binding", async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: !key.startsWith("auth:") }) };
    const ok = await call("GET", "/api/health", undefined, { env: { RATE_LIMITER: limiter }, headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(ok.status).toBe(200);
    const blocked = await call("POST", "/api/auth/login", { email: "a@b.co", password: "x" }, { env: { RATE_LIMITER: limiter }, headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(blocked.status).toBe(429);
    expect(keys).toEqual(["api:1.2.3.4", "auth:1.2.3.4"]);
    expect((await call("GET", "/api/health")).status).toBe(200);
  });
});

describe("VietQR", () => {
  it("CRC16-CCITT matches the standard check value", () => {
    expect(crc16ccitt("123456789")).toBe("29B1");
  });
  it("builds the EMVCo payload with a CRC computed independently (python binascii.crc_hqx)", () => {
    const qr = buildVietQr({ bankBin: "970436", accountNo: "0123456789", amount: 50000, content: "HM DH202611230001" });
    expect(qr).toBe("00020101021238540010A00000072701240006970436011001234567890208QRIBFTTA53037045405500005802VN62210817HM DH20261123000163043D7E");
  });
});
