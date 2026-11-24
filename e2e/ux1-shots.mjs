// Ảnh chụp UX đợt 1: Tổng quan, Đơn hàng (có dữ liệu / lọc / panel chi tiết / trống), sidebar thu gọn, Ctrl+K, /me của chủ.
// Chạy sau smoke.mjs (cần có đơn): BASE=http://localhost:8801 node e2e/ux1-shots.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8801";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
mkdirSync(DIR, { recursive: true });
const browser = await chromium.launch();
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const sizes = [
  ["1920", { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ...common }],
  ["1440", { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common }],
  ["390", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common }],
];
const errs = [];
for (const [tag, opts] of sizes) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`[${tag}] console ${m.text()}`); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !/auth\/me$/.test(r.url())) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  const shot = async (name) => { await page.locator(".toast").first().waitFor({ state: "detached", timeout: 7000 }).catch(() => {}); await page.waitForTimeout(250); await page.screenshot({ path: join(DIR, `ux1-${name}-${tag}.png`) }); };
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill("chu");
  await page.getByLabel("Mật khẩu").fill("ChuCuaHang-2026");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  await page.waitForURL(/\/dashboard/);
  await page.getByText("Việc cần làm").waitFor();
  await page.waitForTimeout(400);
  await shot("tong-quan");

  await page.goto(BASE + "/orders"); await page.locator("main#main").waitFor();
  await page.locator("b:visible", { hasText: "HD-" }).first().waitFor();
  await shot("don-hang");
  // lọc: kênh Tại quầy + tìm "HD"
  if (tag === "390") await page.getByRole("button", { name: /^Bộ lọc/ }).click();
  await page.getByLabel("Kênh").selectOption("pos");
  await page.getByLabel("Tìm đơn hàng").fill("HD-");
  await page.waitForTimeout(900);
  await shot("don-hang-loc");
  // panel chi tiết
  await page.locator("tr.click:visible, button.dt-card:visible").first().click();
  await page.getByText("Xem / in hoá đơn").waitFor();
  await shot("don-hang-chi-tiet");
  // trống: Hôm qua
  await page.goto(BASE + "/orders"); await page.locator("main#main").waitFor();
  await page.getByRole("button", { name: "Tháng trước" }).first().click();
  await page.getByText("Không có đơn nào").first().waitFor();
  await page.waitForTimeout(500);
  await shot("don-hang-trong");

  if (tag !== "390") {
    await page.goto(BASE + "/orders"); await page.locator("main#main").waitFor();
    await page.getByRole("button", { name: "Thu gọn thanh bên" }).click();
    await page.waitForTimeout(300);
    await shot("sidebar-thu-gon");
    await page.getByRole("button", { name: "Mở rộng thanh bên" }).click();
  }
  // Ctrl+K
  await page.goto(BASE + "/dashboard"); await page.locator("main#main").waitFor();
  if (tag === "390") await page.getByRole("button", { name: "Tìm nhanh" }).first().click(); else await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "Tìm nhanh" }).waitFor();
  await page.getByRole("combobox").fill("DS");
  await page.getByText("Đơn hàng", { exact: true }).first().waitFor().catch(() => {});
  await page.waitForTimeout(900);
  await shot("ctrl-k");
  await page.keyboard.press("Escape");

  await page.goto(BASE + "/me"); await page.locator("main#main").waitFor();
  await page.getByText("chưa gắn hồ sơ nhân viên").waitFor();
  await shot("me-chu");
  await ctx.close();
}
await browser.close();
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
console.log("OK");
