// Ảnh màn Đơn hàng có menu "Cột" (1440 và 390). Chạy: BASE=http://localhost:9031 node e2e/orders-columns-shots.mjs
// Cũng kiểm: tắt cột "Kênh" → cột biến mất, tải lại vẫn nhớ; "Mặc định" khôi phục; tải file Excel chi tiết hàng.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:9031";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const USER = process.env.USER_NAME ?? "chu", PASS = process.env.USER_PASS ?? "ChuCuaHang-2026";
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh", acceptDownloads: true };
const sizes = { "1440": { viewport: { width: 1440, height: 900 }, ...common }, "390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common } };
const browser = await chromium.launch();
let fail = 0;
const check = (ok, msg) => { console.log((ok ? "OK  " : "LỖI ") + msg); if (!ok) fail++; };
for (const [tag, opt] of Object.entries(sizes)) {
  const ctx = await browser.newContext(opt);
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(USER);
  await page.getByLabel("Mật khẩu").fill(PASS);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  await page.goto(BASE + "/orders?q=%20"); await page.locator("main#main").waitFor();
  await page.waitForTimeout(1200);
  const th = (n) => page.locator(`.dt-table th:visible:has-text("${n}")`).count();
  const before = tag === "1440" ? await th("Kênh") : 1;
  await page.getByRole("button", { name: /^Cột/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `orders-columns-${tag}.png`) });
  if (tag === "1440") {
    await page.getByRole("group", { name: "Chọn cột hiển thị" }).getByLabel("Kênh").uncheck();
    await page.waitForTimeout(200);
    check(before === 1 && (await th("Kênh")) === 0, "tắt cột Kênh làm cột biến mất");
    await page.reload(); await page.locator("main#main").waitFor(); await page.waitForTimeout(1000);
    check((await th("Kênh")) === 0, "tải lại vẫn nhớ cột đã tắt");
    await page.getByRole("button", { name: /^Cột/ }).click();
    await page.getByRole("button", { name: "Mặc định" }).click();
    await page.waitForTimeout(200);
    check((await th("Kênh")) === 1, "Mặc định khôi phục cột");
    await page.keyboard.press("Escape");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.getByRole("button", { name: /Xuất chi tiết hàng/ }).click()]);
    check(/\.xlsx$/.test(dl.suggestedFilename()), "tải được " + dl.suggestedFilename());
  }
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check(w[0] <= w[1], `[${tag}] không tràn ngang (${w})`);
  await ctx.close();
}
await browser.close();
process.exit(fail ? 1 : 0);
