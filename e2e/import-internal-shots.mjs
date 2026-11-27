// Ảnh chụp đợt 8: nhập Excel, xuất dùng nội bộ, chuyển quỹ. Chạy sau smoke (cần dữ liệu nền):
//   BASE=http://localhost:8851 node e2e/import-internal-shots.mjs     (SIZES=1440,390  OUT=<thư mục>)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8851";
const OUT = process.env.OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
mkdirSync(OUT, { recursive: true });
const USER = process.env.USER_NAME ?? "chu", PASS = process.env.USER_PASS ?? "ChuCuaHang-2026";
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const all = {
  "1440": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common },
  "390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common },
};
const want = (process.env.SIZES ?? "1440,390").split(",");
const RUN0 = Date.now().toString(36).slice(-4).toUpperCase();
const errs = [];
const browser = await chromium.launch();

for (const tag of want) {
  const RUN = RUN0 + tag;
  const ctx = await browser.newContext(all[tag]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errs.push(`[${tag}] pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`[${tag}] console ${m.text()}`); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !/auth\/me$/.test(r.url()) && !r.url().includes("/imports/")) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  const shot = async (name) => {
    await page.locator(".toast").first().waitFor({ state: "detached", timeout: 7000 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `${name}-${tag}.png`) });
    console.log("  ảnh", `${name}-${tag}.png`);
  };
  const api = async (method, path, data) => {
    const r = await ctx.request.fetch(`${BASE}/api/v1${path}`, { method, data, headers: { "X-Requested-With": "hm-erp", "content-type": "application/json" } });
    const t = await r.text();
    if (r.status() >= 400) throw new Error(`${method} ${path} → ${r.status()} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };

  await page.goto(BASE + "/");
  await page.getByLabel(/tên đăng nhập/i).fill(USER);
  await page.getByLabel(/mật khẩu/i).fill(PASS);
  await page.getByRole("button", { name: /đăng nhập/i }).click();
  await page.waitForURL((u) => !/login/i.test(u.pathname), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  // ---------------- Nhập Excel ----------------
  console.log(`[${tag}] nhập Excel`);
  const exist = `Mã hàng,Tên hàng,Đơn vị chính\r\nSHOT-${RUN}-CAM,Cam sành,kg\r\n`;
  await api("POST", "/products", { sku: `SHOT-${RUN}-CAM`, name: "Cam sành", baseUnit: "kg", sellByWeight: true });
  void exist;
  await page.goto(BASE + "/import");
  await page.getByText("Tải file mẫu").first().waitFor();
  await shot("import-1-chon-file");
  const csv = [
    "Mã hàng,Tên hàng,Đơn vị chính,Nhóm hàng,Bán theo cân,Mã vạch,Đơn vị quy đổi,Hệ số quy đổi,Giá bán chung,Hạn dùng (ngày),Xuất xứ",
    `SHOT-${RUN}-TAO,Táo Envy Mỹ,kg,Trái cây nhập,Có,,thùng,10,120000,14,Mỹ`,
    `SHOT-${RUN}-TAO,,,,,,khay,2.5,,,`,
    `SHOT-${RUN}-NHO,Nho đỏ không hạt,kg,Trái cây nhập,Có,,,,180000,7,Chile`,
    `SHOT-${RUN}-LE,Lê Hàn Quốc,kg,Trái cây nhập,Có,,thùng,15,95000,10,Hàn Quốc`,
    `SHOT-${RUN}-CAM,Cam sành loại 1,kg,Trái cây nội,Có,,,,45000,5,Việt Nam`,
    `SHOT-${RUN}-ERR1,,kg,,,,,,,,`,
    `SHOT-${RUN}-ERR2,Xoài cát,kg,,,,,,abc,,`,
    `SHOT-${RUN}-ERR3,=HYPERLINK("http://x"),kg,,,,,,,,`,
  ].join("\r\n");
  await page.getByTestId("imp-file").setInputFiles({ name: "danh-muc-hang-hoa.csv", mimeType: "text/csv", buffer: Buffer.from("﻿" + csv, "utf8") });
  await page.getByText("Xác nhận ghi").first().waitFor();
  await page.waitForTimeout(400);
  await page.getByText("Số dòng").first().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -12));
  await shot("import-2-xem-truoc");
  await page.getByRole("tab", { name: "Cập nhật", exact: true }).click();
  await shot("import-3-cap-nhat-trung-ma");
  await page.getByTestId("imp-commit").click();
  await page.getByText("Đã nhập xong").waitFor();
  await shot("import-4-xong");

  // ---------------- Xuất dùng nội bộ ----------------
  console.log(`[${tag}] xuất dùng nội bộ`);
  const p = await api("POST", "/products", { sku: `SHOT-${RUN}-IU`, name: "Quýt đường", baseUnit: "kg", sellByWeight: true });
  for (const [qty, days] of [[3, 4], [12, 20]]) {
    const d = await api("POST", "/stock-docs", { type: "receipt", locationId: 1, supplierRef: "NCC-SHOT" });
    await api("POST", `/stock-docs/${d.id}/lines`, { productId: p.id, unit: "kg", qty, unitCost: 40000, expiresAt: new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10) });
    await api("POST", `/stock-docs/${d.id}/post`);
  }
  await page.goto(BASE + "/inventory");
  await page.getByRole("button", { name: "Xuất dùng nội bộ" }).click();
  await page.getByText("Lý do / mục đích sử dụng").waitFor();
  await page.getByLabel(/Lý do \/ mục đích/).fill("Làm hàng mẫu cho khách sỉ nhà hàng Biển Xanh");
  await shot("internal-use-1-tao-phieu");
  await page.getByRole("button", { name: "Tạo phiếu nháp" }).click();
  await page.getByText("Chưa có dòng nào").waitFor();
  await page.getByRole("button", { name: /Thêm dòng/ }).click();
  await page.getByLabel("Tìm hàng hoá").fill(`SHOT-${RUN}-IU`);
  await page.locator("button.dt-card").first().click();
  await page.getByLabel("Số lượng xuất dùng").fill("5");
  await page.getByRole("button", { name: "Thêm dòng" }).last().click();
  await page.getByText("Đã thêm dòng").waitFor().catch(() => {});
  await page.waitForTimeout(500);
  await shot("internal-use-2-fefo");
  await page.getByRole("button", { name: "Ghi sổ" }).click();
  await page.waitForTimeout(800);
  await page.goto(BASE + "/reports");
  await page.waitForTimeout(800);
  await shot("internal-use-3-lai-lo");

  // ---------------- Chuyển quỹ ----------------
  console.log(`[${tag}] chuyển quỹ`);
  const funds = (await api("GET", "/funds")).items;
  const cash = funds.find((f) => f.type === "cash"), bank = funds.find((f) => f.type === "bank");
  if (cash && bank) {
    const cat = (await api("GET", "/cash-categories")).items.find((c) => c.code === "SO_DU_DAU_KY");
    if (cash.balance < 3_000_000 && cat) await api("POST", "/vouchers", { direction: "in", fundId: cash.id, categoryId: cat.id, amount: 5_000_000, note: "Số dư đầu kỳ (ảnh chụp)" }).catch(() => {});
    await page.goto(BASE + "/finance");
    await page.getByRole("button", { name: /Chuyển quỹ/ }).first().click();
    await page.getByText("Chuyển tiền giữa các quỹ").first().waitFor();
    await page.getByLabel(/Số tiền/).fill("2000000");
    await page.getByLabel("Ghi chú").fill("Nộp tiền mặt cuối ngày vào ngân hàng");
    await shot("fund-transfer-1-form");
    await page.getByRole("button", { name: /^Chuyển / }).last().click();
    await page.getByText("Chưa có lần chuyển quỹ nào").waitFor({ state: "detached" }).catch(() => {});
    await page.waitForTimeout(900);
    await shot("fund-transfer-2-danh-sach");
    await page.goto(BASE + "/finance");
    await page.waitForTimeout(600);
    await shot("fund-transfer-3-so-du");
  }
  await ctx.close();
}
await browser.close();
if (errs.length) { console.error("LỖI:\n" + errs.join("\n")); process.exit(1); }
console.log("xong");
