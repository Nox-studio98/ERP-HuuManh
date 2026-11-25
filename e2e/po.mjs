// E2E PO tự động: SO thiếu hàng → Chốt ngay → duyệt → NCC xác nhận (ghi nhận hộ) → nhận hàng theo PO → SO đủ hàng.
// Chạy: BASE=http://localhost:8901 [SHOTS=0] [OUT=/đường/dẫn/ảnh] node e2e/po.mjs   (cần chạy smoke.mjs trước trên cùng DB để có chủ + hàng mẫu)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8787";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = process.env.OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });
const RUN = Date.now().toString(36).slice(-5);

const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }

const allowed = [];
const allowAlways = (status, re) => allowed.push({ status, re });
function watch(page, who) {
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) fail(`[${who}] console.error: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`[${who}] pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/") || r.status() < 400) return;
    if (allowed.some((a) => a.status === r.status() && a.re.test(u.pathname))) return;
    fail(`[${who}] ${r.request().method()} ${u.pathname} → ${r.status()} (không dự kiến)`);
  });
}
const browser = await chromium.launch();
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
async function newPage(opts, who) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  watch(page, who);
  allowAlways(401, /\/api\/auth\/me$/);
  return { ctx, page };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(DIR, name) });
};
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const apiGet = async (ctx, path) => { const r = await ctx.request.get(BASE + "/api/v1" + path, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${path} ${r.status()}`); return r.json(); };
const apiSend = async (ctx, method, path, data) => { const r = await ctx.request[method](BASE + "/api/v1" + path, { headers: hdr, data }); if (!r.ok()) throw new Error(`${method} ${path} ${r.status()} ${await r.text()}`); return r.json(); };
const go = async (page, path) => { await page.goto(BASE + path); await page.locator("main#main").waitFor(); };
async function login(page, u, p) {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(u);
  await page.getByLabel("Mật khẩu").fill(p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
}
const toast = (page, re) => page.locator(".toast, [role=status], [role=alert]").filter({ hasText: re }).first().waitFor();

try {
  step("Chủ đăng nhập (1440x900) và chuẩn bị dữ liệu qua API");
  const d = await newPage(desktop, "owner");
  await login(d.page, OWNER.u, OWNER.p);
  const m = await newPage(mobile, "owner-mobile");
  await login(m.page, OWNER.u, OWNER.p);
  const noOverflow = async (what) => assert(!(await m.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `không tràn ngang ở 390px: ${what}`);
  const sup = await apiSend(d.ctx, "post", "/suppliers", { name: `NCC PO E2E ${RUN}`, paymentTermsDays: 7, phone: "0909000111" });
  const prods = (await apiGet(d.ctx, "/products?q=&limit=50")).items.filter((p) => p.baseUnit === "kg");
  const prod = prods[0];
  assert(!!prod, `có sản phẩm tính theo kg: ${prod?.name}`);
  await apiSend(d.ctx, "put", `/product-suppliers?productId=${prod.id}`, { items: [{ supplierId: sup.id, leadTimeDays: 1, orderUnit: null, minOrderMilli: 0, preferred: true }] });
  const avail = prod.availableMilli ?? 0;
  const orderKg = Math.ceil(avail / 1000) + 30;
  const shortExpect = orderKg * 1000 - avail;
  const cust = await apiSend(d.ctx, "post", "/customers", { name: `KH PO E2E ${RUN}`, type: "b2b", customerGroupId: 1, creditLimit: 500000000, paymentTermsDays: 15, contacts: [{ name: "Chị Mai", phone: "0909123987", isReceiver: true }], addresses: [{ label: "Kho", address: "9 Lê Lợi, Quận 1", isDefault: true }] });
  const tomorrow = new Date(Date.now() + 7 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const so = await apiSend(d.ctx, "post", "/b2b/orders", { customerId: cust.id, addressId: cust.addresses[0].id, deliveryDate: tomorrow, clientUuid: `po-e2e-${RUN}-${Date.now()}`, lines: [{ productId: prod.id, unit: "kg", qty: orderKg }] });
  assert(so.status === "confirmed" && so.awaitingStock && so.shortMilli === shortExpect, `SO ${so.code} xác nhận khi thiếu ${shortExpect / 1000} kg (không bị chặn 409)`);

  step("Đơn sỉ hiện nhãn Chờ hàng");
  await go(d.page, `/b2b-orders?q=${so.code}`);
  await d.page.getByText(/Chờ hàng [\d,.]+ kg/).first().waitFor();
  ok("danh sách Đơn sỉ có nhãn 'Chờ hàng … kg'");
  await shot(d.page, "po-b2b-cho-hang-1440.png");
  await go(d.page, `/b2b-orders/${so.id}`);
  await d.page.getByText("chờ hàng về").first().waitFor();
  await shot(d.page, "po-b2b-chi-tiet-cho-hang-1440.png");

  await go(m.page, `/b2b-orders?q=${so.code}`);
  await m.page.getByText(/Chờ hàng [\d,.]+ kg/).locator("visible=true").first().waitFor();
  await shot(m.page, "po-b2b-cho-hang-390.png");
  await noOverflow("Đơn sỉ");
  await go(m.page, "/purchase-orders?tab=short");
  await m.page.getByText(prod.name).locator("visible=true").first().waitFor();
  await m.page.getByRole("button", { name: "Xem đơn" }).first().click();
  await shot(m.page, "po-phan-thieu-390.png");
  await noOverflow("Phần thiếu");

  step("Màn Đơn đặt NCC: Chốt ngay → PO nháp theo NCC");
  await go(d.page, "/purchase-orders?tab=short");
  await d.page.getByText(prod.name, { exact: false }).first().waitFor();
  await d.page.getByRole("button", { name: "Xem đơn" }).first().click();
  await d.page.getByText(so.code).first().waitFor();
  await shot(d.page, "po-phan-thieu-1440.png");
  await d.page.getByRole("tab", { name: "Đơn đặt NCC" }).click();
  await d.page.getByRole("button", { name: "Chốt ngay" }).click();
  await toast(d.page, /PO nháp/);
  const list = await apiGet(d.ctx, `/purchase-orders?q=${encodeURIComponent(sup.name ?? `NCC PO E2E ${RUN}`)}`);
  const po = list.items.find((x) => x.supplierId === sup.id);
  assert(!!po && po.status === "draft", `PO nháp ${po?.code} cho NCC mới`);
  await d.page.getByText(po.code).first().click();
  await d.page.locator("aside.detail-panel").waitFor();
  await d.page.getByText("PO này phủ:").first().waitFor();
  assert(await d.page.locator("aside.detail-panel").getByText(so.code).first().isVisible(), "chi tiết PO nêu SO nguồn");
  await shot(d.page, "po-chi-tiet-nhap-1440.png");
  await go(m.page, "/purchase-orders");
  await m.page.getByText(po.code).locator("visible=true").first().waitFor();
  await shot(m.page, "po-danh-sach-390.png");
  await noOverflow("Danh sách PO");
  await m.page.getByText(po.code).locator("visible=true").first().click();
  await m.page.getByRole("dialog").getByText("PO này phủ:").first().waitFor();
  await shot(m.page, "po-chi-tiet-390.png");
  await m.page.keyboard.press("Escape");

  step("Duyệt & gửi NCC → NCC xác nhận (ghi nhận hộ)");
  await d.page.getByRole("button", { name: "Duyệt & gửi NCC" }).click();
  await toast(d.page, /Đã duyệt và gửi NCC/);
  await d.page.getByRole("button", { name: "Ghi nhận NCC phản hồi" }).click();
  await shot(d.page, "po-ncc-phan-hoi-1440.png");
  await d.page.getByRole("dialog").getByRole("button", { name: "Ghi nhận", exact: true }).click();
  await toast(d.page, /NCC xác nhận/);
  await d.page.locator("aside.detail-panel").getByText("NCC đã xác nhận").first().waitFor();
  let cur = await apiGet(d.ctx, `/purchase-orders/${po.id}`);
  assert(cur.status === "confirmed" && cur.lines[0].confirmedQtyMilli >= shortExpect, "PO ở trạng thái NCC đã xác nhận, chốt đủ phần thiếu");
  await shot(d.page, "po-da-xac-nhan-1440.png");

  step("Kho → Nhận hàng theo PO");
  await go(m.page, "/inventory");
  await m.page.getByRole("button", { name: "Nhận hàng theo PO" }).click();
  await m.page.getByRole("button", { name: new RegExp(po.code) }).click();
  await m.page.getByLabel(/Thực nhận/).waitFor();
  await shot(m.page, "po-nhan-hang-390.png");
  await m.page.keyboard.press("Escape");
  await go(d.page, "/inventory");
  await d.page.getByRole("button", { name: "Nhận hàng theo PO" }).click();
  await d.page.getByRole("button", { name: new RegExp(po.code) }).click();
  await d.page.getByLabel(/Thực nhận/).waitFor();
  await shot(d.page, "po-nhan-hang-1440.png");
  await d.page.getByRole("button", { name: /Ghi sổ nhận hàng/ }).click();
  await d.page.getByText("Đã giữ hàng cho đơn đang chờ").waitFor();
  assert(await d.page.getByRole("dialog").getByText(so.code).first().isVisible(), "kết quả nhận hàng nêu SO được giữ hàng");
  await shot(d.page, "po-nhan-hang-xong-1440.png");
  cur = await apiGet(d.ctx, `/purchase-orders/${po.id}`);
  assert(cur.status === "received" && cur.stockDocs.length === 1 && cur.bills.length === 1 && cur.bills[0].provisional, "PO received, 1 phiếu nhập + 1 hoá đơn mua tạm tính");

  step("SO đã đủ hàng");
  const so2 = await apiGet(d.ctx, `/b2b/orders/${so.id}`);
  assert(!so2.awaitingStock && so2.lines[0].reservedMilli === so2.lines[0].qtyMilli, "SO đủ hàng: giữ đủ, không còn chờ hàng");
  await go(d.page, `/b2b-orders/${so.id}`);
  await d.page.getByText("Đã giữ đủ").first().waitFor();
  const pk = await apiSend(d.ctx, "post", `/b2b/orders/${so.id}/pick`, {});
  assert(!!pk.deliveryId, "SO soạn hàng được sau khi đủ hàng");

} catch (e) {
  fail(`Lỗi: ${e.message}`);
}
await browser.close();
if (failures.length) { console.error(`\nE2E FAIL (${failures.length})`); process.exit(1); }
console.log("\nE2E PASS");
