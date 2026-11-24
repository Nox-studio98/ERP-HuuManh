// Ảnh chụp UX đợt 2C. Chạy sau smoke/b2b/hr: BASE=http://localhost:8831 node e2e/ux2c-shots.mjs
// Biến: SIZES=1920,1440,390  ONLY=cong-no,hoa-don  OUT=<thư mục>  USER_NAME / USER_PASS
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8831";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const OUT = process.env.OUT ?? DIR;
mkdirSync(OUT, { recursive: true });
const USER = process.env.USER_NAME ?? "chu", PASS = process.env.USER_PASS ?? "ChuCuaHang-2026";
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const all = {
  "1920": { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ...common },
  "1440": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common },
  "390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common },
};
const want = (process.env.SIZES ?? "1920,1440,390").split(",");
const only = process.env.ONLY?.split(",");
// [tên, đường dẫn, bấm dòng đầu để mở chi tiết?]
const SCREENS = [
  ["cong-no", "/debts", true], ["hoa-don", "/invoices", true], ["thu-chi", "/finance", false], ["ngan-hang", "/bank", false],
  ["bao-cao", "/reports", false], ["bao-cao-tai-chinh", "/fin-reports", false], ["xuat-excel", "/exports", false], ["duyet", "/approvals", false],
  ["nhan-vien", "/hr/employees", true], ["lich-ca", "/hr/schedule", false], ["duyet-cham-cong", "/hr/attendance", false], ["cham-cong", "/me", false],
  ["bang-cong", "/hr/timesheets", false], ["luong", "/payroll", true], ["cua-hang", "/hr/stores", false],
  ["nguoi-dung", "/users", true], ["cai-dat", "/settings", false], ["tich-hop", "/integrations", false],
];
const browser = await chromium.launch();
const errs = [], over = [];
for (const tag of want) {
  const ctx = await browser.newContext(all[tag]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`[${tag}] console ${m.text()}`); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !/auth\/me$/.test(r.url())) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  const shot = async (name) => {
    await page.locator(".toast").first().waitFor({ state: "detached", timeout: 7000 }).catch(() => {});
    await page.waitForTimeout(250);
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (w[0] > w[1]) over.push(`[${tag}] ${name}: scrollWidth ${w[0]} > ${w[1]}`);
    await page.screenshot({ path: join(OUT, `ux2c-${name}-${tag}.png`) });
  };
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(USER);
  await page.getByLabel("Mật khẩu").fill(PASS);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  await page.waitForTimeout(600);
  for (const [name, path, detail] of SCREENS) {
    if (only && !only.includes(name)) continue;
    try {
      await page.goto(BASE + path); await page.locator("main#main").waitFor();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(700);
      await shot(name);
      if (detail) {
        const row = page.locator("tr.click:visible, button.dt-card:visible, tbody tr:visible").first();
        if (await row.count()) { await row.click().catch(() => {}); await page.waitForTimeout(800); await shot(name + "-chi-tiet"); }
      }
    } catch (e) { errs.push(`[${tag}] ${name}: ${e.message.split("\n")[0]}`); }
  }
  await ctx.close();
}
await browser.close();
if (over.length) console.error("TRÀN NGANG:\n" + over.join("\n"));
if (errs.length) console.error(errs.join("\n"));
console.log("xong");
