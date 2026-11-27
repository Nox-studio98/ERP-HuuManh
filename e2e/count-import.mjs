// E2E nhập kết quả kiểm kho từ Excel/CSV vào phiếu kiểm kê nháp (docs/KIOTVIET-KHOANG-TRONG.md #7). Chạy trên DB MỚI:
//   npm run build && bash scripts/e2e-db.sh .wrangler/e-g9s 9041
//   BASE=http://localhost:9041 PERSIST=.wrangler/e-g9s SHOTS=1 node e2e/count-import.mjs

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:9041";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });

const RUN = Date.now().toString(36).slice(-5);
const SELLER_NAME = `Người bán ${RUN}`;
const NEWPW = "MatKhau-Moi-2026";
const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }

// phản hồi 4xx được CHỦ ĐÍCH mong đợi (mỗi lần gọi cho phép đúng một phản hồi)
const allowed = [];
const allow = (status, re, why) => allowed.push({ status, re, why, used: 0 });
function watch(page, who) {
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) fail(`[${who}] console.error: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`[${who}] pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/") || r.status() < 400) return;
    if (r.status() === 401 && /\/auth\/me$/.test(u.pathname)) return;
    const hit = allowed.find((a) => a.status === r.status() && a.re.test(u.pathname) && a.used === 0);
    if (hit) { hit.used++; return; }
    fail(`[${who}] ${r.request().method()} ${u.pathname} → ${r.status()} (không dự kiến)`);
  });
}

const browser = await chromium.launch();
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
async function newPage(opts, who) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  watch(page, who);
  return { ctx, page };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(DIR, name) });
};
const toastOk = (page, re) => page.locator(".toast").filter({ hasText: re }).first().waitFor();
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
// máy chủ trả snake_case ở một số phản hồi; giao diện tự chuyển sang camelCase (src/web/api.ts) → bộ E2E làm tương tự
const camel = (v) => Array.isArray(v) ? v.map(camel) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camel(x)])) : v;
const apiGet = async (ctx, p) => { const r = await ctx.request.get(BASE + "/api/v1" + p, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${p} ${r.status()}`); return camel(await r.json()); };
const apiSend = async (ctx, method, p, data) => { const r = await ctx.request.fetch(BASE + "/api/v1" + p, { method, headers: hdr, data }); if (!r.ok()) throw new Error(`${method} ${p} ${r.status()} ${await r.text()}`); return r.json(); };
const apiPost = (ctx, p, data) => apiSend(ctx, "POST", p, data);
async function login(page, u, p) {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(u);
  await page.getByLabel("Mật khẩu").fill(p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
}
const go = async (page, path) => { await page.goto(BASE + path); await page.locator("main#main").waitFor(); };
const noOverflow = async (page, what) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(w <= 390, `390px: ${what} không tràn ngang (scrollWidth=${w})`);
};
/** Trên điện thoại giỏ nằm ở màn riêng: bấm "Xem giỏ" nếu có. Trên PC giỏ luôn hiện. */
const digits = (s) => parseInt(String(s).replace(/\D/g, ""), 10);
const csv = (rows) => Buffer.from("﻿" + rows.map((r) => r.join(",")).join("\r\n") + "\r\n", "utf8");

try {
  step("Chuẩn bị (qua API): nhập 2 lô Bưởi + 1 lô Cam, tạo phiếu kiểm kê nháp");
  const o = await newPage(desktop, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  const exp = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const rc = await apiPost(o.ctx, "/stock-docs", { type: "receipt", locationId: 1 });
  await apiPost(o.ctx, `/stock-docs/${rc.id}/lines`, { productId: 12, unit: "trai", qty: 40, unitCost: 40000, expiresAt: exp });
  await apiPost(o.ctx, `/stock-docs/${rc.id}/lines`, { productId: 12, unit: "trai", qty: 25, unitCost: 41000, expiresAt: exp });
  await apiPost(o.ctx, `/stock-docs/${rc.id}/post`);
  const lots = (await apiGet(o.ctx, "/stock/lots?productId=12")).items.filter((l) => l.locationId === 1);
  assert(lots.length >= 2, `Bưởi có ${lots.length} lô tại quầy`);
  const cd = await apiPost(o.ctx, "/stock-docs", { type: "count", locationId: 1 });

  step("[PC 1440] Mở phiếu kiểm kê → Nhập kết quả từ Excel/CSV → xem trước (lỗi: thiếu mã lô, mã lạ; lệch; bỏ qua)");
  await go(o.page, "/inventory");
  await o.page.getByRole("tab", { name: "Chứng từ" }).click();
  await o.page.getByText(cd.code).first().click();
  await o.page.getByTestId("count-import-open").click();
  const sheet = o.page.getByRole("dialog", { name: new RegExp("Nhập kết quả kiểm kho") });
  await sheet.waitFor();
  const href = await sheet.getByTestId("ci-template").getAttribute("href");
  const tpl = await o.ctx.request.get(BASE + href, { headers: hdr });
  assert(tpl.ok() && (tpl.headers()["content-type"] ?? "").includes("spreadsheet"), "tải được file mẫu .xlsx");
  const file = csv([
    ["Mã lô", "Mã hàng", "Đơn vị", "Số đếm"],
    [lots[0].lotCode, "", "trai", "38"],
    [lots[1].lotCode, "", "trai", "25"],
    ["", "BUOI-DA-XANH", "trai", "60"],
    ["LOT-KHONG-CO", "", "trai", "3"],
    [lots[0].lotCode, "", "trai", "x"],
  ]);
  await sheet.getByTestId("ci-file").setInputFiles({ name: "kiem-kho.csv", mimeType: "text/csv", buffer: file });
  await sheet.getByText("Sẽ ghi").waitFor();
  assert((await sheet.innerText()).includes("Không có lô"), "xem trước báo lỗi lô không tồn tại");
  await shot(o.page, "count-import-1440-xem-truoc.png");

  step("[PC 1440] Xác nhận ghi: các dòng hợp lệ vào phiếu (nháp, chưa ghi sổ)");
  await sheet.getByTestId("ci-commit").click();
  await toastOk(o.page, /Đã ghi \d+ dòng đếm/);
  const doc = await apiGet(o.ctx, "/stock-docs/" + cd.id);
  assert(doc.status === "draft" && doc.lines.length === 2, `phiếu vẫn nháp, có ${doc.lines.length} dòng đếm`);
  await shot(o.page, "count-import-1440-phieu.png");
  await o.ctx.close();

  step("[ĐT 390] Xem trước trên điện thoại không tràn ngang");
  const m = await newPage(mobile, "mobile");
  await login(m.page, OWNER.u, OWNER.p);
  const cd2 = await apiPost(m.ctx, "/stock-docs", { type: "count", locationId: 1 });
  await go(m.page, "/inventory");
  await m.page.getByRole("tab", { name: "Chứng từ" }).click();
  await m.page.getByText(cd2.code).locator("visible=true").first().click();
  await m.page.getByTestId("count-import-open").click();
  const ms = m.page.getByRole("dialog", { name: new RegExp("Nhập kết quả kiểm kho") });
  await ms.getByTestId("ci-file").setInputFiles({ name: "kiem-kho.csv", mimeType: "text/csv", buffer: file });
  await ms.getByText("Sẽ ghi").waitFor();
  await noOverflow(m.page, "xem trước nhập kiểm kho");
  await shot(m.page, "count-import-390-xem-truoc.png");
  await ms.evaluate((el) => { const b = el.closest(".body"); if (b) b.scrollTop = 99999; });
  await shot(m.page, "count-import-390-duoi.png");
  await m.ctx.close();
} catch (e) {
  if (!failures.some((f) => f.includes(String(e.message)))) fail("EXCEPTION: " + e.message);
  console.error(e.stack);
} finally {
  await browser.close();
}
if (failures.length) { console.error(`\n${failures.length} lỗi:`); failures.forEach((f) => console.error(" - " + f)); process.exit(1); }
console.log("\nE2E nhập kiểm kho: ĐẠT");
