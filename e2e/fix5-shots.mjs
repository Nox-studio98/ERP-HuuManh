// Ảnh phần giao diện mới của đợt 5 (sửa lỗi audit). Chạy sau smoke + b2b + hr + online trên cùng DB:
//   BASE=http://localhost:8851 OUT=<thư mục> node e2e/fix5-shots.mjs
// Biến: SIZES=1440,390  ONLY=tra-hang-ncc,pos  USER_NAME / USER_PASS
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8851";
const OUT = process.env.OUT ?? "/tmp/fix5-shots";
mkdirSync(OUT, { recursive: true });
const USER = process.env.USER_NAME ?? "chu", PASS = process.env.USER_PASS ?? "ChuCuaHang-2026";
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const all = {
  "1440": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common },
  "390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common },
};
const want = (process.env.SIZES ?? "1440,390").split(",");
const only = process.env.ONLY?.split(",");
const browser = await chromium.launch();
const errs = [], over = [], skipped = [];
for (const tag of want) {
  const ctx = await browser.newContext(all[tag]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  const shot = async (name) => {
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      return [document.documentElement.scrollWidth, innerWidth, dlg ? dlg.scrollWidth - dlg.clientWidth : 0];
    });
    if (w[0] > w[1] || w[2] > 0) over.push(`[${tag}] ${name}: scrollWidth ${w[0]} > ${w[1]} / dialog ${w[2]}`);
    await page.screenshot({ path: `${OUT}/fix5-${name}-${tag}.png` });
  };
  const go = async (path) => { await page.goto(BASE + path); await page.locator("main#main").waitFor(); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(500); };
  const section = async (name, fn) => {
    if (only && !only.includes(name)) return;
    try { await fn(); } catch (e) { skipped.push(`[${tag}] ${name}: ${String(e.message).split("\n")[0]}`); await page.screenshot({ path: `${OUT}/fix5-LOI-${name}-${tag}.png` }).catch(() => {}); }
  };
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(USER);
  await page.getByLabel("Mật khẩu").fill(PASS);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  await page.waitForTimeout(600);

  await section("tra-hang-ncc", async () => {
    await go("/inventory");
    await page.getByRole("tab", { name: "Chứng từ" }).or(page.getByText("Chứng từ", { exact: true })).first().click();
    await page.waitForTimeout(600);
    await page.locator("tr.click:visible, button.dt-card:visible, tbody tr:visible").first().click();
    await page.getByRole("button", { name: "Trả hàng NCC" }).click();
    await shot("tra-hang-ncc");
  });
  await section("phieu-chi", async () => {
    await go("/finance");
    await page.getByText("Phiếu thu chi", { exact: true }).first().click();
    await page.waitForTimeout(600);
    const btn = page.getByRole("button", { name: /^(Từ chối|Huỷ phiếu)$/ }).first();
    await btn.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shot("thu-chi-nut-tu-choi");
    await btn.click();
    await shot("thu-chi-tu-choi");
  });
  await section("luong", async () => {
    await go("/payroll");
    await page.locator("tr.click:visible, button.dt-card:visible, tbody tr:visible").first().click();
    await page.getByRole("button", { name: "Đảo chi lương" }).waitFor();
    await shot("luong-nut-dao-chi");
    await page.getByRole("button", { name: "Đảo chi lương" }).click();
    await shot("luong-dao-chi");
  });
  await section("canh-bao-cham-cong", async () => {
    await go("/hr/attendance");
    await page.getByRole("button", { name: /^Cảnh báo/ }).or(page.getByText(/^Cảnh báo/)).first().click();
    await shot("cham-cong-canh-bao");
  });
  await section("pos", async () => {
    await go("/pos");
    const open = page.getByRole("button", { name: "Mở ca", exact: true });
    if (await open.count()) { await page.getByLabel("Tiền đầu ca (₫)").fill("0"); await open.click(); }
    await page.getByLabel("Tìm sản phẩm").waitFor();
    await page.getByRole("button", { name: /^Thêm Dưa lưới/ }).first().click();
    if (tag === "390") await page.getByRole("button", { name: /^Xem giỏ/ }).click();
    const disc = page.getByLabel(/^Giảm giá dòng/).first();
    await disc.fill("90000");
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: /^Thanh toán/ }).click();
    const sheet = page.getByRole("dialog", { name: "Thanh toán" });
    await sheet.getByRole("button", { name: /^Hoàn tất/ }).click();
    await sheet.getByText("Bạn có quyền tự duyệt").waitFor();
    await shot("pos-ly-do-tu-duyet");
  });
  await section("khach-si", async () => {
    await go("/customers");
    await page.locator("tr.click:visible, button.dt-card:visible, tbody tr:visible").first().click();
    await page.getByRole("button", { name: /^Sửa/ }).first().click();
    const lim = page.getByLabel(/^Hạn mức/).first();
    await lim.fill("9000000");
    await page.getByLabel(/Lý do đổi hạn mức/).scrollIntoViewIfNeeded();
    await shot("khach-si-ly-do-han-muc");
  });
  await section("online", async () => {
    await go("/online-orders");
    await page.locator("tr.click, button.dt-card").filter({ hasText: "DH-20261125-0002" }).first().dispatchEvent("click");
    await page.getByRole("button", { name: "Khách đồng ý qua điện thoại" }).waitFor();
    await shot("online-khach-dong-y");
  });
  await section("nhan-vien", async () => {
    await go("/hr/employees");
    await page.locator("tr.click:visible, button.dt-card:visible, tbody tr:visible").first().click();
    await page.getByRole("button", { name: /^Sửa/ }).first().click();
    const el = page.getByLabel("Mức lương mới có hiệu lực từ ngày");
    await el.scrollIntoViewIfNeeded();
    await shot("nhan-vien-hieu-luc-luong");
  });
  await ctx.close();
}
await browser.close();
console.log("Tràn ngang:", over.length ? "\n" + over.join("\n") : "không");
console.log("Lỗi trang:", errs.length ? "\n" + errs.join("\n") : "không");
console.log("Bỏ qua:", skipped.length ? "\n" + skipped.join("\n") : "không");
