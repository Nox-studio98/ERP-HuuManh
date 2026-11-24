// Ảnh chụp UX đợt 2B (Bán hàng, Kho, Hàng hoá, … Tài khoản khách). Chạy sau smoke.mjs + b2b.mjs (cần có dữ liệu):
//   BASE=http://localhost:8802 [ONLY=pos,orders] [SIZES=1440,390] [OUT=<thư mục>] node e2e/ux2b-shots.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8802";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const SIZES = process.env.SIZES ? process.env.SIZES.split(",") : ["1920", "1440", "390"];
const DIR = process.env.OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
mkdirSync(DIR, { recursive: true });
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const sizes = {
  "1920": { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ...common },
  "1440": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common },
  "390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common },
};
// [tên, đường dẫn, bước phụ (page, tag) tuỳ chọn]
const SCREENS = [
  ["shift-close", "/shift-close"], ["pos", "/pos"],
  ["pos-shift", "/pos", async (p) => {
    const ob = p.getByRole("button", { name: "Mở ca", exact: true }); if (await ob.count()) await ob.click(); await p.locator(".pgrid").waitFor();
    const t = p.locator(".ptile");
    for (const i of [0, 3, 9, 5]) {
      await t.nth(i).click(); await p.waitForTimeout(250);
      const d = p.getByRole("dialog");
      if (await d.count()) { await d.locator("input").first().fill("1,5"); await d.getByRole("button", { name: /^Thêm/ }).click(); await p.waitForTimeout(200); }
    }
    await p.waitForTimeout(500);
  }],
  ["shift-close-open", "/shift-close"],
  ["inventory-alerts", "/inventory"],
  ["inventory-docs", "/inventory", async (p) => { await p.getByRole("tab", { name: "Chứng từ" }).click(); await p.waitForTimeout(500); }],
  ["inventory-trace", "/inventory", async (p) => { await p.getByRole("tab", { name: "Truy vết lô" }).click(); await p.waitForTimeout(400); }],
  ["products", "/products"], ["prices", "/prices"],
  ["prices-lists", "/prices", async (p) => { await p.getByRole("tab", { name: "Bảng giá" }).click(); await p.waitForTimeout(500); }],
  ["suppliers", "/suppliers"], ["purchasing", "/purchasing"], ["competitors", "/competitors"], ["promotions", "/promotions"], ["bundles", "/bundles"],
  ["customers", "/customers"], ["quotes", "/quotes"],
  ["quotes-detail", "/quotes", async (p, tag) => { await (tag === "390" ? p.locator("button.dt-card").first() : p.locator("tbody tr.click").first()).click(); await p.waitForTimeout(900); }],
  ["suppliers-detail", "/suppliers", async (p, tag) => { await (tag === "390" ? p.locator("button.dt-card").first() : p.locator("tbody tr.click").first()).click(); await p.waitForTimeout(900); }],
  ["b2b-orders", "/b2b-orders"],
  ["b2b-recurring", "/b2b-orders", async (p) => { await p.getByRole("tab", { name: "Đơn lặp" }).click(); await p.waitForTimeout(500); }],
  ["deliveries", "/deliveries"], ["online-orders", "/online-orders"],
  ["online-orders-detail", "/online-orders", async (p, tag) => { if (tag === "390") return; await p.locator("tbody tr.click").first().click(); await p.waitForTimeout(1200); }], ["website", "/website"],
  ["website-posts", "/website", async (p) => { await p.getByRole("tab", { name: "Bài viết" }).click(); await p.waitForTimeout(500); }],
  ["website-products", "/website", async (p) => { await p.getByRole("tab", { name: "Sản phẩm online" }).click(); await p.waitForTimeout(500); }],
  ["delivery-zones", "/delivery-zones"],
  ["delivery-slots", "/delivery-zones", async (p) => { await p.getByRole("tab", { name: "Khung giờ giao" }).click(); await p.waitForTimeout(500); }],
  ["shop-accounts", "/shop-accounts"],
];
const browser = await chromium.launch();
const errs = [];
for (const tag of SIZES) {
  const ctx = await browser.newContext(sizes[tag]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`[${tag}] console ${m.text()}`); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !/auth\/me$/.test(r.url())) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill("chu");
  await page.getByLabel("Mật khẩu").fill("ChuCuaHang-2026");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  for (const [name, path, extra] of SCREENS) {
    if (ONLY && !ONLY.includes(name)) continue;
    try {
      await page.goto(BASE + path); await page.locator("main#main").waitFor();
      await page.waitForTimeout(700);
      if (extra) await extra(page, tag);
      await page.locator(".toast").first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (sw > 2) errs.push(`[${tag}] ${name}: tràn ngang ${sw}px`);
      await page.screenshot({ path: join(DIR, `ux2b-${name}-${tag}.png`) });
    } catch (e) { errs.push(`[${tag}] ${name}: ${e.message.split("\n")[0]}`); }
  }
  // đóng ca còn mở (nếu có) để các cỡ màn hình sau lại thấy trạng thái "Mở ca"
  try {
    await page.goto(BASE + "/shift-close"); await page.locator("main#main").waitFor();
    const b = page.getByRole("button", { name: "Chốt ca", exact: true });
    if (await b.count()) { await b.click(); await page.locator(".toast").first().waitFor().catch(() => {}); }
  } catch {}
  await ctx.close();
}
await browser.close();
console.log(errs.length ? "LỖI:\n" + errs.join("\n") : "OK không lỗi");
