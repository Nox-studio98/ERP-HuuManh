// E2E POS-KV đợt B (docs/POS-KV-B.md), phần B1 (bán nợ khách lẻ) + B2 (thu khác). Giao diện thật + backend thật, 1440×900 và 390×844.
// Chạy trên DB MỚI:  npm run build && bash scripts/e2e-db.sh .wrangler/e-pkb1 8941
//                    BASE=http://localhost:8941 PERSIST=.wrangler/e-pkb1 SHOTS=1 node e2e/pos-kv-b.mjs
// Biến: BASE, SHOTS=0 để bỏ ảnh. Bộ này chuẩn bị dữ liệu qua API (nhập kho, bật bán nợ + SePay) nên không cần ghi DB trực tiếp.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8941";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });

const RUN = Date.now().toString(36).slice(-5);
const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }

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
const showCart = async (page) => {
  const b = page.getByRole("button", { name: /^Xem giỏ/ });
  if (await b.isVisible().catch(() => false)) await b.click();
  await page.locator(".pos-cart .grand").waitFor();
};
const addProduct = (page, name) => page.getByRole("button", { name: `Thêm ${name}`, exact: true }).click();
const digits = (s) => parseInt(String(s).replace(/\D/g, ""), 10);
const findOrder = async (ctx, code) => {
  const list = (await apiGet(ctx, "/orders?limit=100")).items;
  const o = list.find((x) => x.code === code);
  if (!o) throw new Error("không thấy đơn " + code);
  return apiGet(ctx, "/orders/" + o.id);
};
const receiptCode = async (rcpt) => (await rcpt.locator(".receipt .l", { hasText: "Số" }).first().innerText()).replace(/Số\s*/, "").trim();
/** Mở gắn khách ở giỏ, tìm theo tên và chọn khách đầu tiên. */
async function attachCustomer(page, name) {
  await page.getByRole("button", { name: /^(Gắn khách|Đổi khách)$/ }).click();
  const dlg = page.getByRole("dialog", { name: "Gắn khách hàng" });
  await dlg.getByLabel("Tên, mã hoặc số điện thoại").fill(name);
  await dlg.locator("button.dt-card", { hasText: name }).first().click();
  await page.getByTestId("pos-customer").getByText(name).waitFor();
}
const setMoney = async (scope, label, v) => { const i = scope.getByLabel(label, { exact: true }); await i.fill(String(v)); };

try {
  // ============================================================ chuẩn bị
  step("Chuẩn bị (qua API): nhập kho, bật bán nợ + SePay, tạo khách lẻ");
  const o = await newPage(desktop, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  const doc = await apiPost(o.ctx, "/stock-docs", { type: "receipt", locationId: 1 });
  const exp = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  for (const [productId, unit, qty, unitCost] of [[10, "trai", 300, 80000], [9, "trai", 300, 50000]]) {
    await apiPost(o.ctx, `/stock-docs/${doc.id}/lines`, { productId, unit, qty, unitCost, expiresAt: exp });
  }
  await apiPost(o.ctx, `/stock-docs/${doc.id}/post`);
  await apiSend(o.ctx, "PUT", "/settings", { settings: {
    "pos.retail_credit_enabled": 1, "sepay.enabled": 1, "payment.bank_account": "0123456789", "payment.bank_account_name": "HUU MANH", "payment.bank_bin": "970436",
  } });
  const cfg = await apiGet(o.ctx, "/pos/credit-config");
  assert(cfg.enabled === true && cfg.approvalVnd === 500000, "bán nợ đã bật, ngưỡng duyệt 500.000đ");
  const NAME_A = `Chị Nợ ${RUN}`, NAME_B = `Anh Chưa Hạn Mức ${RUN}`;
  const custA = await apiPost(o.ctx, "/pos/customers", { name: NAME_A, phone: "0903" + String(Math.floor(Math.random() * 900000) + 100000) });
  const custB = await apiPost(o.ctx, "/pos/customers", { name: NAME_B, phone: "0904" + String(Math.floor(Math.random() * 900000) + 100000) });
  assert(custA.id > 0 && custB.id > 0, "tạo 2 khách lẻ");

  // ============================================================ Khách lẻ: đặt hạn mức (PC 1440)
  step("[PC 1440] Khách lẻ: đặt hạn mức nợ 2.000.000đ + kỳ hạn 10 ngày cho khách A");
  await go(o.page, "/retail-customers");
  await o.page.getByPlaceholder("Tên, mã khách, SĐT…").fill(NAME_A);
  await o.page.getByRole("button", { name: new RegExp(NAME_A) }).first().click().catch(async () => { await o.page.getByText(NAME_A).first().click(); });
  await o.page.getByTestId("rc-credit-limit").waitFor();
  assert(/Chưa cho nợ/.test(await o.page.getByTestId("rc-credit-limit").innerText()), "khách mới: hạn mức nợ 'Chưa cho nợ' (mặc định 0)");
  await o.page.getByTestId("rc-credit-edit").click();
  const cs = o.page.getByRole("dialog", { name: "Hạn mức nợ khách lẻ" });
  await cs.getByLabel("Hạn mức nợ (₫)").fill("2000000");
  await cs.getByLabel("Kỳ hạn trả (ngày)").fill("10");
  await cs.getByLabel("Lý do (bắt buộc)").fill("khách quen mua thường xuyên");
  await shot(o.page, "pos-kv-b-1440-khach-le-han-muc.png");
  await cs.getByRole("button", { name: "Lưu" }).click();
  await toastOk(o.page, /Đã lưu hạn mức nợ/);
  await o.page.waitForFunction(() => /2\.000\.000/.test(document.querySelector('[data-testid="rc-credit-limit"]')?.textContent ?? ""));
  assert(/10 ngày/.test(await o.page.getByTestId("rc-credit-limit").innerText()), "chi tiết khách: hạn mức 2.000.000đ, kỳ hạn 10 ngày");
  const dA = await apiGet(o.ctx, "/retail-customers/" + custA.id);
  assert(dA.creditLimit === 2000000 && dA.paymentTermsDays === 10, "API: creditLimit 2.000.000, terms 10");

  // ============================================================ Cài đặt: loại thu khác (PC 1440)
  step("[PC 1440] Cài đặt → Thu khác: chủ thêm loại 'Phí gói tết' 15.000đ");
  await go(o.page, "/settings");
  await o.page.getByRole("tab", { name: "Thu khác" }).click().catch(async () => { await o.page.getByRole("button", { name: "Thu khác" }).click(); });
  await o.page.getByTestId("charge-types").waitFor();
  await o.page.getByTestId("charge-type-row").first().waitFor();
  assert((await o.page.getByTestId("charge-type-row").count()) === 3, "có sẵn 3 loại: đóng gói, giao hàng, giỏ quà");
  await o.page.getByTestId("charge-type-new").click();
  const ct = o.page.getByRole("dialog", { name: "Thêm loại thu khác" });
  await ct.getByLabel("Mã (chữ, số, gạch dưới)").fill("PHI_GOI_TET");
  await ct.getByLabel("Tên hiển thị").fill("Phí gói tết");
  await ct.getByLabel("Số tiền mặc định (₫)").fill("15000");
  await ct.getByRole("button", { name: "Lưu" }).click();
  await toastOk(o.page, /Đã lưu loại thu khác/);
  await o.page.waitForFunction(() => document.querySelectorAll('[data-testid="charge-type-row"]').length === 4);
  await shot(o.page, "pos-kv-b-1440-cai-dat-thu-khac.png");
  ok("danh sách có 4 loại, 'Phí gói tết' hiện 15.000đ");

  // ============================================================ POS PC
  step("[PC 1440] Mở ca bán hàng");
  await go(o.page, "/pos");
  await o.page.getByRole("heading", { name: "Mở ca bán hàng" }).waitFor();
  await o.page.getByLabel("Tiền đầu ca (₫)").fill("500000");
  await o.page.getByRole("button", { name: "Mở ca", exact: true }).click();
  await toastOk(o.page, /Đã mở ca/);
  await o.page.getByLabel("Tìm sản phẩm").waitFor();
  const shiftId = (await apiGet(o.ctx, "/shifts/current")).shift.id;

  step("[PC 1440] B2 Thu khác: chọn loại có sẵn + nhập tay → tổng đơn, phiếu in, báo cáo");
  await addProduct(o.page, "Dưa lưới Đài Loan");
  await showCart(o.page);
  const goods = digits(await o.page.locator(".pos-cart .grand").innerText());
  assert(goods > 0, `tiền hàng ${goods}`);
  await o.page.getByTestId("pos-add-charge").click();
  const chs = o.page.getByRole("dialog", { name: "Thu khác" });
  await chs.getByTestId("pos-charge-type").filter({ hasText: "Phí đóng gói" }).click();
  await chs.getByTestId("pos-charge-add").click();
  await chs.getByTestId("pos-charge-type").filter({ hasText: "Phí gói tết" }).click();
  await chs.getByTestId("pos-charge-add").click();
  await chs.getByTestId("pos-charge-name").fill("Phí lót hộp");
  await setMoney(chs, "Số tiền (₫)", 7000);
  await chs.getByTestId("pos-charge-add-manual").click();
  await shot(o.page, "pos-kv-b-1440-thu-khac-sheet.png");
  await chs.getByRole("button", { name: "Xong" }).click();
  await o.page.locator(".sheet-back").waitFor({ state: "detached" });
  assert((await o.page.locator(".pos-cart").getByTestId("pos-charge-row").count()) === 3, "giỏ có 3 dòng thu khác");
  const total1 = digits(await o.page.locator(".pos-cart .grand").innerText());
  assert(total1 === goods + 5000 + 15000 + 7000, `tổng giỏ = hàng ${goods} + 5.000 + 15.000 + 7.000 = ${goods + 27000}`);
  await shot(o.page, "pos-kv-b-1440-gio-thu-khac.png");
  await o.page.getByRole("button", { name: /^Thanh toán/ }).click();
  const sheet = o.page.getByRole("dialog", { name: "Thanh toán" });
  assert((await sheet.getByTestId("pos-charge-row").count()) === 3, "màn thanh toán hiện 3 dòng thu khác");
  assert(digits(await sheet.getByTestId("pos-total").innerText()) === total1, "cần thanh toán = tổng giỏ (thu khác không bị giảm)");
  await sheet.getByRole("button", { name: /^Hoàn tất/ }).click();
  const r1 = o.page.getByRole("dialog", { name: "Hoá đơn" });
  await r1.getByText("HOÁ ĐƠN BÁN HÀNG").waitFor();
  assert((await r1.getByTestId("receipt-charge").count()) === 3, "phiếu in có 3 dòng thu khác");
  const code1 = await receiptCode(r1);
  await shot(o.page, "pos-kv-b-1440-phieu-thu-khac.png");
  await r1.getByRole("button", { name: "Đơn mới" }).click();
  const ord1 = await findOrder(o.ctx, code1);
  assert(ord1.total === total1 && ord1.chargesTotal === 27000, "API: tổng đơn đúng, charges_total 27.000");
  assert(ord1.charges.map((x) => x.name).join("|") === "Phí đóng gói|Phí gói tết|Phí lót hộp", "API: 3 dòng thu khác đúng tên");
  const daily1 = await apiGet(o.ctx, "/reports/daily");
  assert(daily1.otherCharges === 27000, "báo cáo cuối ngày: thu khác 27.000 (đã nằm trong doanh thu)");

  step("[PC 1440] B1 Bán nợ: khách A mua, ghi nợ toàn bộ → phiếu in có CÒN NỢ + mã QR HDS");
  await addProduct(o.page, "Dưa lưới Đài Loan");
  await addProduct(o.page, "Dưa lưới Đài Loan");
  await showCart(o.page);
  await attachCustomer(o.page, NAME_A);
  await o.page.getByRole("button", { name: /^Thanh toán/ }).click();
  const sh2 = o.page.getByRole("dialog", { name: "Thanh toán" });
  await sh2.getByTestId("pos-credit").waitFor();
  const total2 = digits(await sh2.getByTestId("pos-total").innerText());
  assert(/2\.000\.000/.test(await sh2.getByTestId("pos-credit").innerText()), "thẻ Ghi nợ hiện hạn mức 2.000.000đ");
  await sh2.getByTestId("pos-credit-all").click();
  await sh2.getByTestId("pos-credit-row").waitFor();
  assert(digits(await sh2.getByTestId("pos-credit-row").innerText()) === total2, `Ghi nợ = toàn bộ ${total2}`);
  await shot(o.page, "pos-kv-b-1440-ghi-no.png");
  await sh2.getByRole("button", { name: /^Ghi nợ & hoàn tất/ }).click();
  const r2 = o.page.getByRole("dialog", { name: "Hoá đơn" });
  await r2.getByTestId("receipt-credit").waitFor();
  await r2.getByTestId("receipt-credit-qr").waitFor();
  const code2 = await receiptCode(r2);
  const credTxt = await r2.getByTestId("receipt-credit").innerText();
  assert(/CÒN NỢ/.test(credTxt) && digits(credTxt.match(/CÒN NỢ\s*([\d.]+)/)?.[1]) === total2, `phiếu in: CÒN NỢ ${total2}`);
  assert(/HDS\d{8}/.test(credTxt), "phiếu in: mã thanh toán HDS…");
  assert(/Công nợ/.test(await r2.locator(".receipt").innerText()), "phiếu in: dòng thanh toán 'Công nợ'");
  await shot(o.page, "pos-kv-b-1440-phieu-no-qr.png");
  await r2.getByRole("button", { name: "Đơn mới" }).click();
  const ord2 = await findOrder(o.ctx, code2);
  assert(ord2.credit.outstanding === total2 && ord2.credit.payCode.startsWith("HDS") && !!ord2.credit.qrPayload, "API: hoá đơn nợ đúng số tiền, có mã HDS + VietQR");
  assert(ord2.payments.some((p) => p.method === "credit" && p.amount === total2), "API: payments có dòng credit");

  step("[PC 1440] B1 Bán nợ một phần: khách A trả tiền mặt 40.000đ, phần còn lại ghi nợ");
  await addProduct(o.page, "Dưa lưới Đài Loan");
  await showCart(o.page);
  await attachCustomer(o.page, NAME_A);
  await o.page.getByRole("button", { name: /^Thanh toán/ }).click();
  const sh3 = o.page.getByRole("dialog", { name: "Thanh toán" });
  await sh3.getByTestId("pos-credit").waitFor();
  const total3 = digits(await sh3.getByTestId("pos-total").innerText());
  await setMoney(sh3, "Số tiền (Tiền mặt)", 40000);
  await sh3.getByRole("button", { name: "Nợ phần còn thiếu" }).click();
  await sh3.getByTestId("pos-credit-row").waitFor();
  assert(digits(await sh3.getByTestId("pos-credit-row").innerText()) === total3 - 40000, `Ghi nợ = ${total3 - 40000}`);
  await sh3.getByRole("button", { name: /^Ghi nợ & hoàn tất/ }).click();
  const r3 = o.page.getByRole("dialog", { name: "Hoá đơn" });
  await r3.getByTestId("receipt-credit").waitFor();
  const code3 = await receiptCode(r3);
  await r3.getByRole("button", { name: "Đơn mới" }).click();
  const ord3 = await findOrder(o.ctx, code3);
  assert(ord3.paidTotal === 40000 && ord3.credit.outstanding === total3 - 40000, "API: đã thu 40.000, còn nợ phần còn lại");

  step("[PC 1440] B1 Khách B chưa có hạn mức: không ghi nợ được, nút bị khoá + thông báo");
  await addProduct(o.page, "Dưa lưới Đài Loan");
  await showCart(o.page);
  await attachCustomer(o.page, NAME_B);
  await o.page.getByRole("button", { name: /^Thanh toán/ }).click();
  const sh4 = o.page.getByRole("dialog", { name: "Thanh toán" });
  await sh4.getByTestId("pos-credit").waitFor();
  await sh4.getByTestId("pos-credit-all").click();
  await sh4.getByText(/Khách chưa được đặt hạn mức nợ/).waitFor();
  assert(await sh4.getByRole("button", { name: /^Ghi nợ & hoàn tất/ }).isDisabled(), "nút Ghi nợ & hoàn tất bị khoá khi vượt hạn mức (0)");
  await shot(o.page, "pos-kv-b-1440-vuot-han-muc.png");
  await o.page.keyboard.press("Escape");
  await o.page.locator(".sheet-back").waitFor({ state: "detached" });
  await o.page.getByRole("button", { name: "Xoá giỏ" }).click();

  step("[PC 1440] B1 Thu nợ tại quầy: khách A trả 100.000đ tiền mặt vào két ca; hiện QR thu nợ");
  const before = (await apiGet(o.ctx, `/shifts/${shiftId}/summary`)).cashFormula;
  await o.page.getByTestId("pos-debt-btn").click();
  const ds = o.page.getByRole("dialog", { name: "Thu nợ khách lẻ" });
  await ds.getByTestId("debt-search").fill(NAME_A);
  await ds.getByTestId("debt-pick").first().click();
  await ds.getByTestId("debt-body").waitFor();
  const owed = total2 + (total3 - 40000);
  await o.page.waitForFunction((n) => (document.querySelector('[data-testid="debt-outstanding"]')?.textContent ?? "").replace(/\D/g, "") === String(n), owed);
  assert((await ds.getByTestId("debt-invoice").count()) === 2, "khách A có 2 hoá đơn nợ");
  await ds.getByTestId("debt-invoice").first().click();
  await ds.getByTestId("debt-qr-btn").click();
  await ds.getByTestId("debt-qr").waitFor();
  assert(/HDS\d{8}/.test(await ds.getByTestId("debt-qr").innerText()), "mã QR thu nợ có mã HDS…");
  await shot(o.page, "pos-kv-b-1440-thu-no.png");
  await ds.getByLabel("Số tiền thu (₫)").fill("100000");
  await ds.getByTestId("debt-pay").click();
  await ds.getByTestId("debt-done").waitFor();
  await o.page.waitForFunction((n) => (document.querySelector('[data-testid="debt-outstanding"]')?.textContent ?? "").replace(/\D/g, "") === String(n), owed - 100000);
  assert(true, `còn nợ giảm còn ${owed - 100000}`);
  await shot(o.page, "pos-kv-b-1440-thu-no-xong.png");
  await ds.getByRole("button", { name: "Đóng" }).click();
  const after = (await apiGet(o.ctx, `/shifts/${shiftId}/summary`)).cashFormula;
  assert(after.debtCollected - before.debtCollected === 100000 && after.expected - before.expected === 100000, "tiền mặt dự kiến của ca tăng đúng 100.000đ (thu nợ tiền mặt)");

  step("[PC 1440] Chốt ca & báo cáo cuối ngày: dòng thu nợ, Công nợ, Thu khác");
  await go(o.page, "/shift-close");
  await o.page.getByTestId("shift-debt-collected").waitFor();
  assert(digits(await o.page.getByTestId("shift-debt-collected").innerText()) === after.debtCollected, "màn Chốt ca hiện dòng '+ Thu nợ khách lẻ bằng tiền mặt'");
  await shot(o.page, "pos-kv-b-1440-chot-ca.png");
  await go(o.page, "/reports/daily");
  await o.page.getByText("Theo hình thức thanh toán").first().waitFor();
  await o.page.getByText(/gồm thu khác/).first().waitFor();
  const dailyText = await o.page.locator("main#main").innerText();
  assert(/Công nợ/.test(dailyText) && /gồm thu khác 27\.000/.test(dailyText), "báo cáo cuối ngày: có dòng Công nợ và 'gồm thu khác 27.000'");
  const daily = await apiGet(o.ctx, "/reports/daily");
  const credRow = daily.byPayment.find((p) => p.method === "credit");
  assert(credRow.sold === total2 + (total3 - 40000), "byPayment: Công nợ = tổng phần ghi nợ");
  await shot(o.page, "pos-kv-b-1440-bao-cao-ngay.png");

  step("[PC 1440] Khách lẻ → khách A: tab Công nợ");
  await go(o.page, "/retail-customers");
  await o.page.getByPlaceholder("Tên, mã khách, SĐT…").fill(NAME_A);
  await o.page.getByText(NAME_A).first().click();
  await o.page.getByTestId("rc-debt-out").waitFor();
  assert(digits(await o.page.getByTestId("rc-debt-out").innerText()) === owed - 100000, `Còn nợ ${owed - 100000}`);
  await o.page.getByRole("tab", { name: /^Công nợ/ }).click();
  await o.page.getByTestId("rc-debt-tab").waitFor();
  assert((await o.page.getByTestId("rc-debt-tab").locator("tbody tr, .dt-card").count()) >= 3, "tab Công nợ: 2 hoá đơn + 1 phiếu thu");
  await o.page.getByTestId("rc-debt-tab").scrollIntoViewIfNeeded();
  await shot(o.page, "pos-kv-b-1440-khach-le-cong-no.png");

  // ============================================================ Điện thoại 390
  step("[Mobile 390] Thu khác + bán nợ + phiếu in QR + thu nợ + khách lẻ");
  const m = await newPage(mobile, "mobile");
  await login(m.page, OWNER.u, OWNER.p);
  await go(m.page, "/pos");
  await m.page.getByLabel("Tìm sản phẩm").waitFor();
  await noOverflow(m.page, "POS danh sách sản phẩm (nút Thu nợ)");
  await shot(m.page, "pos-kv-b-390-san-pham.png");
  await addProduct(m.page, "Dưa lưới Đài Loan");
  await showCart(m.page);
  await m.page.getByTestId("pos-add-charge").click();
  const mchs = m.page.getByRole("dialog", { name: "Thu khác" });
  await mchs.getByTestId("pos-charge-type").filter({ hasText: "Phí đóng gói" }).click();
  await mchs.getByTestId("pos-charge-add").click();
  await noOverflow(m.page, "sheet Thu khác");
  await shot(m.page, "pos-kv-b-390-thu-khac-sheet.png");
  await mchs.getByRole("button", { name: "Xong" }).click();
  await m.page.locator(".sheet-back").waitFor({ state: "detached" });
  await attachCustomer(m.page, NAME_A);
  await noOverflow(m.page, "giỏ có thu khác");
  await shot(m.page, "pos-kv-b-390-gio.png");
  await m.page.getByRole("button", { name: /^Thanh toán/ }).click();
  const msh = m.page.getByRole("dialog", { name: "Thanh toán" });
  await msh.getByTestId("pos-credit").waitFor();
  const mtotal = digits(await msh.getByTestId("pos-total").innerText());
  await msh.getByTestId("pos-credit-all").click();
  await msh.getByTestId("pos-credit-row").waitFor();
  await noOverflow(m.page, "thanh toán ghi nợ");
  await shot(m.page, "pos-kv-b-390-ghi-no.png");
  await msh.getByRole("button", { name: /^Ghi nợ & hoàn tất/ }).click();
  const mr = m.page.getByRole("dialog", { name: "Hoá đơn" });
  await mr.getByTestId("receipt-credit-qr").waitFor();
  const mcode = await receiptCode(mr);
  assert(digits((await mr.getByTestId("receipt-credit").innerText()).match(/CÒN NỢ\s*([\d.]+)/)?.[1]) === mtotal, `390: phiếu in CÒN NỢ ${mtotal} + QR`);
  await noOverflow(m.page, "phiếu in có QR");
  await shot(m.page, "pos-kv-b-390-phieu-no-qr.png");
  await mr.getByRole("button", { name: "Đơn mới" }).click();
  const mord = await findOrder(o.ctx, mcode);
  assert(mord.chargesTotal === 5000 && mord.credit.outstanding === mtotal, "API: đơn mobile có thu khác 5.000 và nợ đúng");

  await m.page.getByTestId("pos-debt-btn").click();
  const mds = m.page.getByRole("dialog", { name: "Thu nợ khách lẻ" });
  await mds.getByTestId("debt-search").fill(NAME_A);
  await mds.getByTestId("debt-pick").first().click();
  await mds.getByTestId("debt-body").waitFor();
  await mds.getByTestId("debt-invoice").first().click();
  await noOverflow(m.page, "sheet Thu nợ");
  await shot(m.page, "pos-kv-b-390-thu-no.png");
  await mds.getByRole("button", { name: "Đóng" }).click();
  await m.page.locator(".sheet-back").waitFor({ state: "detached" });

  await go(m.page, "/retail-customers");
  const mrow = m.page.locator(`text=${NAME_A} >> visible=true`).first();
  await mrow.waitFor();
  await mrow.click();
  await m.page.getByTestId("rc-debt-out").waitFor();
  await m.page.getByRole("tab", { name: /^Công nợ/ }).click();
  await m.page.getByTestId("rc-debt-tab").waitFor();
  await m.page.getByTestId("rc-debt-tab").scrollIntoViewIfNeeded();
  await noOverflow(m.page, "Khách lẻ tab Công nợ");
  await shot(m.page, "pos-kv-b-390-khach-le-cong-no.png");

  await go(m.page, "/settings");
  await m.page.getByRole("tab", { name: "Thu khác" }).click().catch(async () => { await m.page.getByRole("button", { name: "Thu khác" }).click(); });
  await m.page.getByTestId("charge-types").waitFor();
  await m.page.getByTestId("charge-type-row").first().waitFor();
  await noOverflow(m.page, "Cài đặt → Thu khác");
  await shot(m.page, "pos-kv-b-390-cai-dat-thu-khac.png");
} catch (e) {
  if (!failures.some((f) => f.includes(String(e.message)))) fail("EXCEPTION: " + e.message);
  console.error(e.stack);
} finally {
  await browser.close();
}
console.log(failures.length ? `\nKẾT QUẢ: ${failures.length} lỗi\n` + failures.map((f) => " - " + f).join("\n") : "\nKẾT QUẢ: ĐẠT");
process.exit(failures.length ? 1 : 0);
