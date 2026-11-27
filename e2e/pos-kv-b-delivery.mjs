// E2E POS-KV đợt B3: bán giao hàng tại quầy (docs/POS-KV-B.md mục B3). Giao diện thật + backend thật, 1440×900 và 390×844.
// Giỏ POS → nút "Giao hàng" → sheet (người nhận, khu vực/phí, người giao, trả trước + COD) → đơn sang "Đang giao" → phiếu giao 80mm
// → màn Đơn online (lọc "Từ quầy") → hoàn tất / giao thất bại. Chạy trên DB MỚI:
//   npm run build && bash scripts/e2e-db.sh .wrangler/e-pkb3 8951
//   BASE=http://localhost:8951 PERSIST=.wrangler/e-pkb3 SHOTS=1 node e2e/pos-kv-b-delivery.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8951";
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
const showCart = async (page) => {
  const b = page.getByRole("button", { name: /^Xem giỏ/ });
  if (await b.isVisible().catch(() => false)) await b.click();
  await page.locator(".pos-cart .grand").waitFor();
};
const tabBadge = async (page, i) => {
  const n = page.getByTestId(`pos-tab-${i}`).locator(".pos-tab-n");
  return (await n.count()) ? parseInt(await n.innerText(), 10) : 0;
};
const tabCount = (page) => page.locator('[data-testid^="pos-tab-"]:not([data-testid="pos-tab-add"])').count();
const addProduct = (page, name) => page.getByRole("button", { name: `Thêm ${name}`, exact: true }).click();
const digits = (s) => parseInt(String(s).replace(/\D/g, ""), 10);
async function payCash(page) {
  await page.getByRole("button", { name: /^Thanh toán/ }).click();
  const sheet = page.getByRole("dialog", { name: "Thanh toán" });
  await sheet.getByRole("button", { name: /^Hoàn tất/ }).click();
  const rcpt = page.getByRole("dialog", { name: "Hoá đơn" });
  await rcpt.getByText("HOÁ ĐƠN BÁN HÀNG").waitFor();
  const code = (await rcpt.locator(".receipt .l", { hasText: "Số" }).first().innerText()).replace(/Số\s*/, "").trim();
  await rcpt.getByRole("button", { name: "Đơn mới" }).click();
  return code;
}
const findOrder = async (ctx, code) => {
  const list = (await apiGet(ctx, "/orders?limit=100")).items;
  const o = list.find((x) => x.code === code);
  if (!o) throw new Error("không thấy đơn " + code);
  return apiGet(ctx, "/orders/" + o.id);
};


const bigNum = (s) => digits(s);
async function openShiftUi(page) {
  await go(page, "/pos");
  await page.getByRole("heading", { name: "Mở ca bán hàng" }).or(page.getByLabel("Tìm sản phẩm")).first().waitFor();
  if (await page.getByRole("heading", { name: "Mở ca bán hàng" }).isVisible().catch(() => false)) {
    await page.getByLabel("Tiền đầu ca (₫)").fill("500000");
    await page.getByRole("button", { name: "Mở ca", exact: true }).click();
    await toastOk(page, /Đã mở ca/);
  }
  await page.getByLabel("Tìm sản phẩm").waitFor();
}
/** Tạo đơn giao từ giỏ POS. `mode`: "part" (trả trước một phần) | "cod". Trả { code, total, cod, prepay }. */
async function deliveryFlow(page, tag, { mode, name, phoneNo, addr, shotName }) {
  await go(page, "/pos");
  await page.getByLabel("Tìm sản phẩm").waitFor();
  await addProduct(page, "Bưởi da xanh");
  await addProduct(page, "Bưởi da xanh");
  await showCart(page);
  await page.getByTestId("pos-delivery").click();
  const sheet = page.getByTestId("delivery-sheet");
  await sheet.waitFor();
  await page.getByRole("dialog", { name: "Giao hàng" }).waitFor();
  const submit = page.getByTestId("delivery-submit");
  assert(await submit.isDisabled(), `[${tag}] chưa nhập người nhận → nút Tạo đơn giao bị khoá`);
  await sheet.getByLabel("Người nhận").fill(name);
  await sheet.getByLabel("Số điện thoại").fill(phoneNo);
  await sheet.getByLabel("Địa chỉ giao").fill(addr);
  await sheet.getByLabel("Khu vực giao").selectOption({ label: "Nội thành gần · 20.000 ₫" }).catch(async () => { await sheet.getByLabel("Khu vực giao").selectOption({ index: 1 }); });
  await page.waitForFunction(() => /20\.000/.test(document.querySelector('[data-testid="delivery-totals"]')?.textContent ?? ""));
  assert(bigNum(await sheet.getByLabel("Phí giao (₫)").inputValue()) === 20000, `[${tag}] chọn khu vực → gợi ý phí giao 20.000`);
  const totalTxt = await sheet.locator('[data-testid="delivery-totals"] .grand .money').innerText();
  const total = digits(totalTxt);
  assert(total > 20000, `[${tag}] tổng đơn giao = ${total} (hàng + phí giao)`);
  let prepay = 0;
  if (mode === "part") {
    await sheet.getByRole("tab", { name: "Trả một phần" }).click();
    prepay = 50000;
    await sheet.getByLabel("Số trả trước (₫)").fill("50000");
  }
  const cod = total - prepay;
  assert(digits(await sheet.getByTestId("delivery-cod").innerText()) === cod, `[${tag}] thu hộ COD hiển thị ${cod}`);
  await sheet.getByLabel("Nhân viên giao").waitFor();
  if (shotName) await shot(page, shotName);
  await submit.click();
  const done = page.getByRole("dialog", { name: "Đã tạo đơn giao hàng" });
  await done.waitFor();
  const slip = done.getByTestId("delivery-slip");
  await slip.getByText("PHIẾU GIAO HÀNG").waitFor();
  const code = (await slip.locator(".l", { hasText: "Mã đơn" }).first().innerText()).replace(/Mã đơn\s*/, "").trim();
  assert(/^DH/.test(code), `[${tag}] phiếu giao có mã đơn ${code}`);
  assert((await slip.innerText()).includes(name) && (await slip.innerText()).includes(addr), `[${tag}] phiếu giao có người nhận + địa chỉ`);
  assert(digits(await slip.locator(".l", { hasText: "THU HỘ" }).innerText()) === cod, `[${tag}] phiếu giao: THU HỘ ${cod}`);
  assert((await slip.locator("svg[aria-label^='Mã vạch']").count()) === 1, `[${tag}] phiếu giao có mã vạch`);
  if (shotName) await shot(page, shotName.replace(".png", "-phieu.png"));
  await done.getByRole("button", { name: "Đơn mới" }).click();
  await page.getByLabel("Tìm sản phẩm").waitFor();
  return { code, total, cod, prepay };
}
const orderByCode = async (ctx, code) => {
  const list = (await apiGet(ctx, "/online-orders?source=pos&limit=100")).items;
  const o = list.find((x) => x.code === code);
  if (!o) throw new Error("không thấy đơn online " + code);
  return apiGet(ctx, "/online-orders/" + o.id);
};

try {
  step("Chuẩn bị (qua API): nhập kho Bưởi");
  const o = await newPage(desktop, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  const doc = await apiPost(o.ctx, "/stock-docs", { type: "receipt", locationId: 1 });
  const exp = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await apiPost(o.ctx, `/stock-docs/${doc.id}/lines`, { productId: 12, unit: "trai", qty: 100, unitCost: 40000, expiresAt: exp });
  await apiPost(o.ctx, `/stock-docs/${doc.id}/post`);
  const users = (await apiGet(o.ctx, "/pos/deliverers")).items;
  assert(users.length >= 1, "/pos/deliverers có nhân viên");
  const zones = (await apiGet(o.ctx, "/pos/delivery-zones")).items;
  assert(zones.some((z) => z.fee === 20000), "/pos/delivery-zones có khu vực phí 20.000");

  step("[PC 1440] Mở ca + tạo đơn giao: trả trước 50.000 tiền mặt, còn lại COD");
  await openShiftUi(o.page);
  const a = await deliveryFlow(o.page, "1440", { mode: "part", name: "Chị Lan E2E", phoneNo: "0909123456", addr: "12 Lê Lợi, Quận 1", shotName: "pos-kv-b3-1440-sheet.png" });
  const ao = await orderByCode(o.ctx, a.code);
  assert(ao.status === "shipping" && ao.source === "pos", "đơn giao từ quầy ở trạng thái Đang giao, source=pos");
  assert(ao.paidTotal === 50000 && ao.shippingFee === 20000 && ao.total === a.total, "trả trước 50.000 vào đơn, phí giao 20.000, tổng khớp");
  assert(!!ao.delivererUserId && /Nhân viên/.test(ao.carrier ?? ""), "người giao là nhân viên cửa hàng");

  step("[PC 1440] Màn Đơn online: lọc Từ quầy → thấy đơn Đang giao → xem người giao → Đã giao");
  await go(o.page, "/online-orders");
  await o.page.getByLabel("Kênh").selectOption("pos").catch(async () => {
    await o.page.getByRole("button", { name: /Bộ lọc/ }).click();
    await o.page.getByLabel("Kênh").selectOption("pos");
  });
  const row = o.page.locator("tr, .dt-card").filter({ hasText: a.code }).first();
  await row.waitFor();
  assert(/Đang giao/.test(await row.innerText()) && /Từ quầy/.test(await row.innerText()), "dòng đơn: Đang giao + nhãn Từ quầy");
  await row.click();
  await o.page.getByTestId("pos-origin").waitFor();
  assert(/Người giao: Nhân viên:/.test(await o.page.getByTestId("carrier-info").innerText()), "chi tiết đơn hiện người giao");
  await shot(o.page, "pos-kv-b3-1440-online-orders.png");
  await o.page.getByRole("button", { name: "Đã giao", exact: true }).click();
  await toastOk(o.page, /Đã giao hàng/);
  const done = await orderByCode(o.ctx, a.code);
  assert(done.status === "completed" && done.paidTotal === a.total, "đã giao: completed, paid_total = tổng (50.000 trả trước + COD)");
  const sum = await apiGet(o.ctx, "/online-orders?source=pos&status=completed");
  assert(sum.summary.revenue >= a.total, "doanh thu chỉ ghi sau khi hoàn tất giao");

  step("[PC 1440] Đơn thứ hai giao thất bại → trả hàng nhập lại kho");
  const b = await deliveryFlow(o.page, "1440b", { mode: "cod", name: "Anh Minh E2E", phoneNo: "0988777666", addr: "45 Nguyễn Huệ, Quận 1" });
  const onHand = async () => (await apiGet(o.ctx, "/stock/lots?productId=12&limit=100")).items.reduce((t, l) => t + (l.qtyOnHandMilli ?? 0), 0);
  const stockBefore = await onHand();
  const bo = await orderByCode(o.ctx, b.code);
  assert(bo.status === "shipping" && bo.paidTotal === 0, "đơn COD thuần: Đang giao, chưa có tiền");
  await go(o.page, "/online-orders");
  await o.page.getByRole("tab", { name: /Đang giao/ }).click();
  await o.page.locator("tr, .dt-card").filter({ hasText: b.code }).first().click();
  await o.page.getByRole("button", { name: "Giao thất bại", exact: true }).click();
  await o.page.getByLabel("Lý do giao thất bại").fill("Khách không nhận hàng");
  await o.page.getByRole("button", { name: "Xác nhận thất bại" }).click();
  await toastOk(o.page, /giao thất bại/i);
  const failed = await orderByCode(o.ctx, b.code);
  assert(failed.status === "delivery_failed", "đơn chuyển Giao thất bại");
  await apiPost(o.ctx, `/online-orders/${failed.id}/return-to-stock`, { lines: failed.lines.map((l) => ({ orderLineId: l.id, qty: l.qtyShown ?? 2, restock: true, reason: "Hàng còn nguyên" })) });
  const ret = await orderByCode(o.ctx, b.code);
  assert(ret.status !== "completed" && ret.status !== "shipping", `trả hàng xong: đơn ở trạng thái ${ret.status}, không tính doanh thu`);
  assert((await onHand()) === stockBefore + 2000, "trả hàng nhập lại kho đúng 2 trái (tồn tăng 2.000 milli)");

  step("[PC 1440] API báo giá giao hàng (quyền pos.sell)");
  const r403 = await o.ctx.request.post(BASE + "/api/v1/pos/delivery-quote", { headers: hdr, data: { lines: [{ productId: 12, unit: "trai", qty: 1 }] } });
  assert(r403.ok(), "chủ gọi được /pos/delivery-quote");

  // ============================================================ 390
  step("[ĐT 390] Tạo đơn giao từ điện thoại (xe ngoài + mã vận đơn, trả trước đủ chuyển khoản)");
  const m = await newPage(mobile, "mobile");
  await login(m.page, OWNER.u, OWNER.p);
  await go(m.page, "/pos");
  await m.page.getByLabel("Tìm sản phẩm").waitFor();
  await addProduct(m.page, "Bưởi da xanh");
  await showCart(m.page);
  await m.page.getByTestId("pos-delivery").click();
  const ms = m.page.getByTestId("delivery-sheet");
  await ms.waitFor();
  await ms.getByLabel("Người nhận").fill("Cô Hoa E2E");
  await ms.getByLabel("Số điện thoại").fill("0912345678");
  await ms.getByLabel("Địa chỉ giao").fill("7 Võ Văn Tần, Quận 3");
  await ms.getByLabel("Khu vực giao").selectOption({ index: 1 });
  await ms.getByRole("tab", { name: "Xe ngoài" }).click();
  await ms.getByLabel("Tên hãng / xe").fill("Ahamove");
  await ms.getByLabel("Mã vận đơn (nếu có)").fill("AHM-" + RUN);
  await ms.getByRole("tab", { name: "Trả đủ" }).click();
  await ms.getByLabel("Hình thức trả trước").selectOption("transfer");
  await noOverflow(m.page, "sheet giao hàng");
  await shot(m.page, "pos-kv-b3-390-sheet.png");
  await m.page.getByTestId("delivery-submit").click();
  const md = m.page.getByRole("dialog", { name: "Đã tạo đơn giao hàng" });
  await md.getByTestId("delivery-slip").waitFor();
  const mcode = (await md.getByTestId("delivery-slip").locator(".l", { hasText: "Mã đơn" }).first().innerText()).replace(/Mã đơn\s*/, "").trim();
  assert(digits(await md.getByTestId("delivery-slip").locator(".l", { hasText: "THU HỘ" }).innerText()) === 0, "trả trước đủ → phiếu giao THU HỘ 0");
  await noOverflow(m.page, "phiếu giao");
  await shot(m.page, "pos-kv-b3-390-phieu.png");
  await md.getByRole("button", { name: "Đơn mới" }).click();
  const mo = await orderByCode(o.ctx, mcode);
  assert(mo.carrier === "Ahamove" && mo.carrierTrackingNo === "AHM-" + RUN && mo.paymentStatus === "paid", "xe ngoài: hãng + mã vận đơn lưu đúng, đã trả đủ");
  await go(m.page, "/online-orders");
  await noOverflow(m.page, "Đơn online");
  await shot(m.page, "pos-kv-b3-390-online-orders.png");
  await m.ctx.close();
  await o.ctx.close();
} catch (e) {
  if (!failures.some((f) => f.includes(String(e.message)))) fail("EXCEPTION: " + e.message);
  console.error(e.stack);
} finally {
  await browser.close();
}
if (failures.length) { console.error(`\n${failures.length} lỗi:`); failures.forEach((f) => console.error(" - " + f)); process.exit(1); }
console.log("\nE2E POS-KV B3: ĐẠT");
