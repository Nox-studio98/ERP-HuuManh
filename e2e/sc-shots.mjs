// Ảnh chụp: Báo cáo bán hàng + Hoa hồng. Chạy sau smoke (DB có dữ liệu mẫu đơn nhiều người bán):
//   BASE=http://localhost:8861 node e2e/sc-shots.mjs     (SIZES=1440,390  ONLY=sales,commission)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8861";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
mkdirSync(OUT, { recursive: true });
const USER = process.env.USER_NAME ?? "chu", PASS = process.env.USER_PASS ?? "ChuCuaHang-2026";
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const all = {
  "1440": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common },
  "390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common },
};
// quy tắc mẫu (bỏ qua nếu đã có)
const tok = (await (await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PASS }) })).json()).token;
const H = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
const have = (await (await fetch(BASE + "/api/v1/commission/rules", { headers: H })).json()).items.length;
if (!have) {
  const emps = (await (await fetch(BASE + "/api/v1/employees?limit=5", { headers: H })).json()).items;
  for (const r of [
    { name: "Hoa hồng chung 1%", scope: "all", rateBp: 100 },
    { name: "Trái cây nhập khẩu 2%", scope: "group", productGroupId: 1, rateBp: 200 },
    { name: "Sầu riêng Ri6 3%", scope: "product", productId: 13, rateBp: 300 },
    { name: "Giỏ quà: không hoa hồng", scope: "group", productGroupId: 3, rateBp: 0 },
    { name: `${emps[0].fullName}: nhóm nhập khẩu 2,5%`, scope: "group", productGroupId: 1, employeeId: emps[0].id, rateBp: 250, effectiveFrom: "2026-11-01" },
  ]) { const x = await fetch(BASE + "/api/v1/commission/rules", { method: "POST", headers: H, body: JSON.stringify(r) }); if (x.status !== 201) throw new Error("rule " + x.status + await x.text()); }
}
const browser = await chromium.launch();
const errs = [], over = [];
for (const tag of (process.env.SIZES ?? "1440,390").split(",")) {
  const ctx = await browser.newContext(all[tag]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`[${tag}] console ${m.text()}`); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !/auth\/me$/.test(r.url())) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  const shot = async (name) => {
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (w[0] > w[1]) over.push(`[${tag}] ${name}: scrollWidth ${w[0]} > ${w[1]}`);
    await page.screenshot({ path: join(OUT, `${name}-${tag}.png`), fullPage: tag === "390" });
  };
  const go = async (path) => { await page.goto(BASE + path); await page.locator("main#main").waitFor(); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(600); };
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(USER);
  await page.getByLabel("Mật khẩu").fill(PASS);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  await page.waitForTimeout(600);
  const tab = async (name) => { await page.locator(".seg button, [role=tablist] button, button").filter({ hasText: name }).first().click(); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(500); };
  try {
    await go("/sales-reports");
    await shot("sales-report-nguoi-ban");
    await tab("Theo hàng hoá"); await shot("sales-report-hang-hoa");
    await tab("Không bán trong kỳ"); await shot("sales-report-hang-khong-ban");
    await tab("Theo khách hàng"); await shot("sales-report-khach");
    await tab("Theo nhà cung cấp"); await shot("sales-report-ncc");
    await go("/hr/commission");
    await shot("commission-quy-tac");
    await page.getByTestId("rule-new").click(); await page.waitForTimeout(500); await shot("commission-them-quy-tac");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    await tab("Xem trước hoa hồng"); await shot("commission-xem-truoc");
  } catch (e) { errs.push(`[${tag}] ${e.message.split("\n")[0]}`); }
  await ctx.close();
}
await browser.close();
if (over.length) console.error("TRÀN NGANG:\n" + over.join("\n"));
if (errs.length) console.error(errs.join("\n"));
console.log("xong");
