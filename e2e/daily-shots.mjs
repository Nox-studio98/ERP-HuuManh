// Ảnh chụp Báo cáo cuối ngày + Lịch sử ca + bản in. Chạy SAU smoke: BASE=http://localhost:8831 node e2e/daily-shots.mjs
// Bản in: emulateMedia print, khổ A4 (794px) và 80mm (~302px); lưu docs/screenshots/daily-print-a4.png, daily-print-80.png, shift-handover-*.png
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8831";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
mkdirSync(DIR, { recursive: true });
const USER = process.env.USER_NAME ?? "chu", PASS = process.env.USER_PASS ?? "ChuCuaHang-2026";
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const SIZES = {
  d: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common },
  m: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common },
};
const errs = [], over = [];
const browser = await chromium.launch();
for (const [tag, opt] of Object.entries(SIZES)) {
  const ctx = await browser.newContext(opt);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`[${tag}] console ${m.text()}`); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !/auth\/me$/.test(r.url())) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  const shot = async (name, full = false) => {
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (w[0] > w[1]) over.push(`[${tag}] ${name}: scrollWidth ${w[0]} > ${w[1]}`);
    if (full && tag === "d") await page.setViewportSize({ width: 1440, height: 1500 }); // cao hơn để sidebar dính không che nội dung ảnh full-page
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(DIR, `${name}-${tag}.png`), fullPage: full });
    if (full && tag === "d") await page.setViewportSize(opt.viewport);
  };
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(USER);
  await page.getByLabel("Mật khẩu").fill(PASS);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  await page.waitForTimeout(500);
  const go = async (p) => { await page.goto(BASE + p); await page.locator("main#main").waitFor(); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(700); };
  await go("/reports/daily"); await shot("daily", true);
  await go("/shift-history"); await shot("shift-history", true);
  const row = page.locator("tr.click:visible, button.dt-card:visible").first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(900); await shot("shift-history-detail", tag === "m"); }
  if (tag === "d") {
    // bản in (chỉ chụp một lần, ở desktop)
    for (const [paper, width, btn] of [["a4", 794, "In A4"], ["80", 302, "In 80mm"]]) {
      await go("/reports/daily");
      await page.getByRole("button", { name: btn }).click();
      await page.waitForTimeout(200);
      await page.emulateMedia({ media: "print" });
      await page.setViewportSize({ width, height: 1100 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(DIR, `daily-print-${paper}.png`), fullPage: true });
      await page.pdf({ path: join(DIR, `../../.wrangler/daily-print-${paper}.pdf`), preferCSSPageSize: true });
      await page.emulateMedia({ media: "screen" });
      await page.setViewportSize(opt.viewport);
    }
    await go("/shift-history");
    const r2 = page.locator("tr.click:visible").first();
    if (await r2.count()) {
      await r2.click(); await page.waitForTimeout(900);
      await page.getByRole("button", { name: "In 80mm" }).click(); await page.waitForTimeout(200);
      await page.emulateMedia({ media: "print" }); await page.setViewportSize({ width: 302, height: 1000 }); await page.waitForTimeout(300);
      await page.screenshot({ path: join(DIR, "shift-handover-80.png"), fullPage: true });
      await page.emulateMedia({ media: "screen" }); await page.setViewportSize(opt.viewport);
      await page.getByRole("button", { name: "In A4" }).click(); await page.waitForTimeout(200);
      await page.emulateMedia({ media: "print" }); await page.setViewportSize({ width: 794, height: 1100 }); await page.waitForTimeout(300);
      await page.screenshot({ path: join(DIR, "shift-handover-a4.png"), fullPage: true });
      await page.emulateMedia({ media: "screen" }); await page.setViewportSize(opt.viewport);
    }
  }
  await ctx.close();
}
await browser.close();
if (over.length) console.error("TRÀN NGANG:\n" + over.join("\n"));
if (errs.length) console.error(errs.join("\n"));
console.log("xong");
