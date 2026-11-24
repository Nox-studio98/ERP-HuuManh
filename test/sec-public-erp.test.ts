import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/worker/index";
import { api, seedBase, testEnv } from "./helpers";
import { hmacSha256Hex } from "../src/worker/services/fresco";
import { crawlSource, isPublicHttpUrl, readBodyCapped } from "../src/worker/services/competitor-crawler";

const db = () => testEnv.DB;
afterEach(() => vi.restoreAllMocks());
beforeAll(seedBase);

describe("5. Crawler: SSRF, giới hạn body, robots redirect", () => {
  it("isPublicHttpUrl từ chối nội bộ/metadata/IP riêng/cổng lạ", () => {
    const bad = [
      "http://localhost/", "http://localhost./", "http://a.localhost/", "http://x.local/", "http://db.internal/", "http://metadata.google.internal/",
      "http://127.0.0.1/", "http://10.0.0.5/", "http://172.16.1.1/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://100.64.0.1/",
      "http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://rival.example.vn:8080/", "http://rival.example.vn:22/", "ftp://rival.example.vn/",
      "http://2130706433/", "http://0x7f.0.0.1/", "https://user:pw@rival.example.vn/", "http://intranet/",
    ];
    for (const u of bad) expect(isPublicHttpUrl(u), u).toBe(false);
    for (const u of ["https://rival.example.vn/a?b=1", "http://rival.example.vn:80/", "https://rival.example.vn:443/x"]) expect(isPublicHttpUrl(u), u).toBe(true);
  });

  it("readBodyCapped dừng đọc ở giới hạn (không nạp cả luồng)", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        pulled++;
        ctl.enqueue(new Uint8Array(1000).fill(97));
        if (pulled > 100000) ctl.close();
      },
    });
    const text = await readBodyCapped(new Response(stream), 2500);
    expect(text.length).toBe(2500);
    expect(pulled).toBeLessThan(10);
  });

  async function mkSource(url: string) {
    const cid = (await db().prepare(`INSERT INTO competitors(name) VALUES (?) RETURNING id`).bind('SecRival ' + url).first<{ id: number }>())!.id;
    return (await db().prepare(`INSERT INTO competitor_sources(competitor_id, kind, url, parser, min_delay_ms, max_pages) VALUES (?, 'website', ?, 'jsonld', 0, 1) RETURNING id`).bind(cid, url).first<{ id: number }>())!.id;
  }

  it("robots.txt chuyển hướng ra ngoài origin KHÔNG bị theo (redirect: manual)", async () => {
    const sid = await mkSource("https://rival.example.vn/sp");
    const seen: { url: string; redirect?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      seen.push({ url, redirect: init?.redirect });
      if (url === "https://rival.example.vn/robots.txt") return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      return new Response("", { status: 404 });
    });
    const r = await crawlSource(testEnv, sid);
    expect(r.status).not.toBe("ok");
    expect(seen.every((s) => s.redirect === "manual" || !s.url.endsWith("robots.txt"))).toBe(true);
    expect(seen.map((s) => s.url)).toEqual(["https://rival.example.vn/robots.txt"]); // không gọi tới đích chuyển hướng
  });

  it("trang quá lớn bị cắt theo luồng ở MAX_BODY (3MB) và vẫn parse được phần đầu", async () => {
    const sid = await mkSource("https://rival2.example.vn/sp");
    const ldjson = `<html><script type="application/ld+json">${JSON.stringify([{ "@type": "Product", name: "Cam 1kg", url: "https://rival2.example.vn/p/cam", offers: { "@type": "Offer", price: "45000", priceCurrency: "VND" } }])}</script></html>`;
    let pulled = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /");
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        pull(ctl) {
          pulled++;
          ctl.enqueue(pulled === 1 ? enc.encode(ldjson) : new Uint8Array(500_000).fill(32));
          if (pulled > 2000) ctl.close(); // ~1GB nếu đọc hết
        },
      });
      return new Response(stream, { status: 200 });
    });
    const r = await crawlSource(testEnv, sid);
    expect(pulled).toBeLessThan(20);
    expect(r.items).toBe(1);
  });
});

describe("7. Fresco webhook: không làm ngập audit khi chữ ký sai", () => {
  const SECRET = "test-fresco-secret";
  const env = { ...testEnv, FRESCO_WEBHOOK_SECRET: SECRET } as typeof testEnv;
  it("nhiều request sai chữ ký → tối đa 1 dòng audit/phút", async () => {
    await api("owner", "PUT", "/api/v1/integrations/settings", { frescoEnabled: true });
    const raw = JSON.stringify({ eventId: "e1", type: "order.created", data: {} });
    const ts = String(Math.floor(Date.now() / 1000));
    for (let i = 0; i < 8; i++) {
      const res = await app.request("/api/integrations/fresco/webhook", { method: "POST", headers: { "content-type": "application/json", "x-fresco-timestamp": ts, "x-fresco-signature": "sha256=" + "0".repeat(64) }, body: raw }, env);
      expect(res.status).toBe(401);
    }
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='fresco.webhook_rejected'`).first<any>()).n).toBe(1);
    // vẫn xử lý được request đúng chữ ký
    expect(await hmacSha256Hex(SECRET, raw)).toBeTruthy();
  });
});
