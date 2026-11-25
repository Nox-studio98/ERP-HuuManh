// E2E cổng NCC: mời từ ERP → NCC đặt mật khẩu → đăng nhập → đề xuất sửa → ERP chấp nhận → NCC thấy đã xác nhận → nhận hàng
// → NCC thấy công nợ/sao kê → ERP chi trả → NCC thấy thanh toán; kiểm không tràn ngang ở 390px.
// Chạy: ERP=http://localhost:8911 SHOP=http://localhost:8912 [SHOTS=0] [OUT=/đường/dẫn/ảnh] node e2e/ncc.mjs
// Cần: ERP chạy với biến SHOP_BASE_URL=$SHOP (wrangler dev --var SHOP_BASE_URL:...), đã chạy smoke.mjs + b2b.mjs trên cùng DB (có chủ + hàng mẫu).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const ERP = process.env.ERP ?? "http://localhost:8787";
const SHOP = process.env.SHOP ?? "http://localhost:8788";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = process.env.OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });
const RUN = Date.now().toString(36).slice(-5);
const NCC_PW = "NccMatkhau-2026";
const EMAIL = `ncc-${RUN}@example.com`;

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
  allowAlways(401, /\/api\/ncc\/me$/); // chưa đăng nhập: trang đăng nhập hỏi /me
  return { ctx, page };
}
const shot = async (page, name, full = false) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(DIR, name), fullPage: full });
};
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const apiGet = async (ctx, path) => { const r = await ctx.request.get(ERP + "/api/v1" + path, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${path} ${r.status()}`); return r.json(); };
const apiSend = async (ctx, method, path, data) => { const r = await ctx.request[method](ERP + "/api/v1" + path, { headers: hdr, data }); if (!r.ok()) throw new Error(`${method} ${path} ${r.status()} ${await r.text()}`); return r.json(); };
async function erpLogin(page) {
  await page.goto(ERP + "/");
  await page.getByLabel("Tên đăng nhập").fill(OWNER.u);
  await page.getByLabel("Mật khẩu").fill(OWNER.p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
}
const noOverflow = async (page, what) => assert(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `không tràn ngang ở 390px: ${what}`);
const toast = (page, re) => page.locator(".toast, [role=status], [role=alert]").filter({ hasText: re }).first().waitFor();
const nccReady = (page) => page.locator("main#main, .ncc-auth").first().waitFor();

try {
  step("Chuẩn bị: NCC mới, sản phẩm, PO đã gửi (qua API ERP)");
  const d = await newPage(desktop, "erp");
  await erpLogin(d.page);
  const supName = `NCC Cổng E2E ${RUN}`;
  const sup = await apiSend(d.ctx, "post", "/suppliers", { name: supName, paymentTermsDays: 7, phone: "0909000222" });
  const prod = (await apiGet(d.ctx, "/products?q=&limit=50")).items.find((p) => p.baseUnit === "kg");
  assert(!!prod, `có sản phẩm tính theo kg: ${prod?.name}`);
  const created = await apiSend(d.ctx, "post", "/purchase-orders", { supplierId: sup.id, note: "Giao trước 6h sáng", lines: [{ productId: prod.id, qty: 20, unitCost: 30000 }] });
  const sent = await apiSend(d.ctx, "post", `/purchase-orders/${created.id}/approve`, {});
  assert(sent.status === "sent", `PO ${created.code} đã gửi NCC`);
  const draftPo = await apiSend(d.ctx, "post", "/purchase-orders", { supplierId: sup.id, lines: [{ productId: prod.id, qty: 1, unitCost: 1000 }] });

  step("ERP: màn Nhà cung cấp → Mời vào cổng → link một lần");
  await d.page.goto(ERP + "/suppliers");
  await d.page.getByLabel("Tìm nhà cung cấp").fill(supName);
  await d.page.getByText(supName).first().click();
  await d.page.getByTestId("portal-box").waitFor();
  await d.page.getByTestId("portal-invite").click();
  await d.page.getByLabel("Họ tên người được mời").fill("Anh Cường NCC");
  await d.page.getByLabel(/Email \(dùng để đăng nhập\)/).fill(EMAIL);
  await d.page.getByLabel(/Số điện thoại/).fill("0909111333");
  await shot(d.page, "ncc-erp-moi-1440.png");
  await d.page.getByRole("button", { name: "Tạo link mời" }).click();
  await d.page.getByTestId("portal-link").waitFor();
  const link = await d.page.getByTestId("portal-link-text").inputValue();
  assert(link.startsWith(SHOP + "/ncc/dat-mat-khau#") , `link mời trỏ website (${link.slice(0, 60)}…)`);
  await shot(d.page, "ncc-erp-link-1440.png");
  await d.page.getByRole("button", { name: "Xong" }).click();
  await d.page.getByTestId("portal-account").filter({ hasText: EMAIL }).getByText("Chưa đặt mật khẩu").waitFor();
  await shot(d.page, "ncc-erp-tai-khoan-1440.png");
  const m0 = await newPage(mobile, "erp-mobile");
  await erpLogin(m0.page);
  await m0.page.goto(ERP + "/suppliers");
  await m0.page.getByLabel("Tìm nhà cung cấp").fill(supName);
  await m0.page.getByText(supName).locator("visible=true").first().click();
  await m0.page.getByTestId("portal-box").waitFor();
  await shot(m0.page, "ncc-erp-tai-khoan-390.png");
  await noOverflow(m0.page, "ERP Nhà cung cấp + cổng");
  await m0.page.getByTestId("portal-invite").click();
  await shot(m0.page, "ncc-erp-moi-390.png");
  await noOverflow(m0.page, "ERP Sheet mời");
  await m0.ctx.close();

  step("NCC: mở link → đặt mật khẩu (1440)");
  const n = await newPage(desktop, "ncc");
  await n.page.goto(link);
  await n.page.getByText("Anh Cường NCC").first().waitFor();
  assert(!n.page.url().includes("#"), "token bị xoá khỏi thanh địa chỉ sau khi đọc");
  await shot(n.page, "ncc-dat-mat-khau-1440.png");
  await n.page.getByLabel("Mật khẩu mới").fill(NCC_PW);
  await n.page.getByLabel("Nhập lại mật khẩu").fill(NCC_PW);
  await n.page.getByRole("button", { name: /Đặt mật khẩu và vào cổng/ }).click();
  await n.page.getByTestId("ncc-orders").waitFor();
  assert(await n.page.getByText(created.code).first().isVisible(), `NCC thấy PO ${created.code}`);
  assert((await n.page.getByText(draftPo.code).count()) === 0, "PO nháp KHÔNG hiện cho NCC");
  await shot(n.page, "ncc-don-dat-hang-1440.png");
  // dùng lại link → không được
  const reuse = await newPage(desktop, "ncc-reuse");
  allowAlways(400, /\/api\/ncc\/auth\/invite$/);
  await reuse.page.goto(link);
  await reuse.page.getByText("Liên kết không dùng được").waitFor();
  ok("link mời dùng rồi thì không dùng lại được");
  await reuse.ctx.close();

  step("NCC: chi tiết đơn → đề xuất sửa");
  await n.page.getByRole("link", { name: created.code }).first().click();
  await n.page.getByTestId("ncc-lines").waitFor();
  await shot(n.page, "ncc-chi-tiet-1440.png", true);
  await n.page.getByTestId("act-propose").click();
  await n.page.getByLabel(/Số lượng \(kg\)/).first().fill("15");
  await n.page.getByLabel(/Ghi chú dòng/).first().fill("Chỉ còn 15kg");
  await n.page.getByLabel("Lời nhắn cho cửa hàng").fill("Đợt này thiếu hàng");
  await shot(n.page, "ncc-de-xuat-1440.png");
  await n.page.getByRole("button", { name: "Gửi đề xuất" }).click();
  await n.page.getByText(/Bạn đã gửi đề xuất sửa/).waitFor();
  let po = await apiGet(d.ctx, `/purchase-orders/${created.id}`);
  assert(po.status === "supplier_proposed" && po.lines[0].proposedQtyMilli === 15000, "PO ở trạng thái NCC đề xuất sửa (15 kg)");
  const notes = await apiGet(d.ctx, "/notifications");
  assert(notes.items.some((x) => x.title.includes(created.code) && /đề xuất/.test(x.title)), "ERP có thông báo NCC đề xuất sửa");

  step("ERP chấp nhận đề xuất → NCC thấy đã xác nhận");
  await apiSend(d.ctx, "post", `/purchase-orders/${created.id}/proposal/accept`, { version: po.version });
  await n.page.reload();
  await n.page.getByText("Đã xác nhận, chờ giao").first().waitFor();
  await shot(n.page, "ncc-da-xac-nhan-1440.png", true);

  step("ERP nhận hàng theo PO (có số hoá đơn) → NCC thấy công nợ + sao kê");
  po = await apiGet(d.ctx, `/purchase-orders/${created.id}`);
  await apiSend(d.ctx, "post", `/purchase-orders/${created.id}/receive`, { version: po.version, supplierRef: `HD-${RUN}`, lines: [{ poLineId: po.lines[0].id, qtyMilli: 15000 }] });
  await n.page.goto(SHOP + "/ncc/cong-no");
  await n.page.getByTestId("debt-balance").waitFor();
  assert((await n.page.getByTestId("debt-balance").innerText()).replace(/\D/g, "") === "450000", "công nợ = 15 kg × 30.000 = 450.000 ₫");
  await n.page.getByTestId("ncc-statement").waitFor();
  await n.page.getByTestId("ncc-statement").getByText("Hoá đơn mua").first().waitFor();
  await shot(n.page, "ncc-cong-no-1440.png", true);

  step("ERP chi trả 200.000 ₫ → NCC thấy thanh toán và công nợ giảm");
  const pay = await apiSend(d.ctx, "post", "/debts/payments", { direction: "out", partnerType: "supplier", partnerId: sup.id, fundId: 1, amount: 200000, method: "transfer", ref: "REF-NOI-BO", note: "ghi chú nội bộ" });
  assert(pay.payment.status === "posted", "phiếu chi đã ghi sổ");
  await n.page.goto(SHOP + "/ncc/thanh-toan");
  await n.page.getByTestId("ncc-payments").waitFor();
  assert((await n.page.getByTestId("pay-total").innerText()).replace(/\D/g, "") === "200000", "tổng đã thanh toán 200.000 ₫");
  assert(!(await n.page.content()).includes("REF-NOI-BO") && !(await n.page.content()).includes("ghi chú nội bộ"), "trang thanh toán không lộ tham chiếu/ghi chú nội bộ");
  await shot(n.page, "ncc-thanh-toan-1440.png");
  await n.page.goto(SHOP + "/ncc/cong-no");
  await n.page.getByTestId("debt-balance").waitFor();
  assert((await n.page.getByTestId("debt-balance").innerText()).replace(/\D/g, "") === "250000", "công nợ còn 250.000 ₫ sau khi trả");
  await n.page.goto(SHOP + "/ncc/tai-khoan");
  await n.page.getByText("Người dùng của nhà cung cấp").waitFor();
  await shot(n.page, "ncc-tai-khoan-1440.png");

  step("NCC trên điện thoại 390px: đăng nhập + mọi màn không tràn ngang");
  const m = await newPage(mobile, "ncc-mobile");
  await m.page.goto(SHOP + "/ncc");
  await m.page.getByLabel("Email").waitFor();
  await shot(m.page, "ncc-dang-nhap-390.png");
  await noOverflow(m.page, "đăng nhập");
  // đăng nhập sai không lộ tài khoản
  allowAlways(401, /\/api\/ncc\/auth\/login$/);
  await m.page.getByLabel("Email").fill(EMAIL);
  await m.page.getByLabel("Mật khẩu").fill("sai-mat-khau-123");
  await m.page.getByRole("button", { name: "Đăng nhập" }).click();
  await m.page.getByText("Email hoặc mật khẩu không đúng").waitFor();
  await m.page.getByLabel("Mật khẩu").fill(NCC_PW);
  await m.page.getByRole("button", { name: "Đăng nhập" }).click();
  await m.page.getByTestId("ncc-orders").waitFor();
  await shot(m.page, "ncc-don-dat-hang-390.png");
  await noOverflow(m.page, "danh sách đơn");
  await m.page.getByText(created.code).locator("visible=true").first().click();
  await m.page.getByTestId("ncc-lines").waitFor();
  await shot(m.page, "ncc-chi-tiet-390.png", true);
  await noOverflow(m.page, "chi tiết đơn");
  await m.page.goto(SHOP + "/ncc/cong-no");
  await m.page.getByTestId("ncc-statement").waitFor();
  await shot(m.page, "ncc-cong-no-390.png", true);
  await noOverflow(m.page, "công nợ + sao kê");
  await m.page.goto(SHOP + "/ncc/thanh-toan");
  await m.page.getByTestId("ncc-payments").waitFor();
  await shot(m.page, "ncc-thanh-toan-390.png", true);
  await noOverflow(m.page, "thanh toán");
  await m.page.goto(SHOP + "/ncc/tai-khoan");
  await m.page.getByText("Đổi mật khẩu").first().waitFor();
  await shot(m.page, "ncc-tai-khoan-390.png", true);
  await noOverflow(m.page, "tài khoản");

  step("Phiên tách biệt: cookie NCC không vào được API khách; khoá từ ERP đăng xuất NCC ngay");
  const meCust = await n.ctx.request.get(SHOP + "/api/me");
  assert(meCust.status() === 401, "phiên NCC không phải phiên khách (/api/me → 401)");
  const accs = await apiGet(d.ctx, `/suppliers/${sup.id}/portal`);
  await apiSend(d.ctx, "post", `/suppliers/${sup.id}/portal/accounts/${accs.items[0].id}/lock`, {});
  const after = await n.ctx.request.get(SHOP + "/api/ncc/me");
  assert(after.status() === 401, "khoá từ ERP → phiên NCC bị thu hồi ngay");
} catch (e) {
  fail(`Lỗi: ${e.message}`);
}
await browser.close();
if (failures.length) { console.error(`\nE2E FAIL (${failures.length})`); process.exit(1); }
console.log("\nE2E PASS");
