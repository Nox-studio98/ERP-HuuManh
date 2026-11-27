// E2E G9: Trả hàng nhanh (không hoá đơn gốc) ở màn POS + Sửa hoá đơn đã lập ở màn Đơn hàng. Giao diện thật + backend thật, 1440×900 và 390×844.
// Chạy trên DB MỚI:  npm run build && bash scripts/e2e-db.sh .wrangler/e-g9r 9021
//                    BASE=http://localhost:9021 SHOTS=1 node e2e/pos-return-fix.mjs
// Biến: BASE, OWNER_USER/OWNER_PASS, SHOTS=0 để bỏ ảnh.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:9021";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });

const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }

function watch(page, who) {
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) fail(`[${who}] console.error: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`[${who}] pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/") || r.status() < 400) return;
    if (r.status() === 401 && /\/auth\/me$/.test(u.pathname)) return;
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
const apiPost = async (ctx, p, data) => { const r = await ctx.request.post(BASE + "/api/v1" + p, { headers: hdr, data }); if (!r.ok()) throw new Error(`POST ${p} ${r.status()} ${await r.text()}`); return camel(await r.json()); };
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
const lotTotal = async (ctx, productId) => (await apiGet(ctx, `/inventory/lots?productId=${productId}&limit=100`).catch(() => ({ items: [] }))).items?.reduce((s, l) => s + (l.qtyOnHandMilli ?? 0), 0) ?? 0;
const stockOf = async (ctx, productId) => {
  const p = await apiGet(ctx, "/products/" + productId);
  return p.availableMilli ?? p.stockMilli ?? null;
};

try {
  step("Chuẩn bị: nhập kho Táo Envy, mở ca, bán một đơn 2kg qua API");
  const o = await newPage(desktop, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  const doc = await apiPost(o.ctx, "/stock-docs", { type: "receipt", locationId: 1 });
  const exp = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await apiPost(o.ctx, `/stock-docs/${doc.id}/lines`, { productId: 1, unit: "kg", qty: 100, unitCost: 100000, expiresAt: exp });
  await apiPost(o.ctx, `/stock-docs/${doc.id}/post`);
  await apiPost(o.ctx, "/shifts/open", { openingCash: 500000 });
  const tao = (await apiGet(o.ctx, "/products?q=Táo Envy&limit=5&active=1")).items.find((p) => p.id === 1);
  const price = typeof tao.price === "number" ? tao.price : tao.price?.unitPrice;
  assert(price > 0, `Táo Envy có giá bán hiện hành (${price})`);
  const sell = async (qty) => apiPost(o.ctx, "/pos/orders", { clientUuid: "g9-" + Math.random().toString(36).slice(2, 12), lines: [{ productId: 1, unit: "kg", qty }], payments: [{ method: "cash", amount: price * qty }] });
  const cashExpected = async () => { const s = await apiGet(o.ctx, "/shifts/current"); return (await apiGet(o.ctx, `/shifts/${s.shift.id}/summary`)).cashFormula.expected; };

  // ============================================================ Trả hàng nhanh (PC 1440)
  step("[PC 1440] POS → Trả hàng nhanh: chọn hàng + số lượng + lý do → hoàn tất (chủ tự duyệt); tiền trừ két, kho tăng");
  const e0 = await cashExpected();
  await go(o.page, "/pos");
  await o.page.getByLabel("Tìm sản phẩm").waitFor();
  await o.page.getByTestId("pos-quick-return-btn").click();
  const dlg = o.page.getByRole("dialog", { name: "Trả hàng nhanh" });
  await dlg.waitFor();
  await dlg.getByTestId("qr-search").fill("Táo Envy");
  await dlg.locator(".ex-pick", { hasText: "Táo Envy" }).first().click();
  await dlg.getByTestId("qr-line").waitFor();
  await dlg.getByLabel(/^Số lượng/).fill("2");
  const submit = dlg.getByTestId("qr-submit");
  assert(await submit.isDisabled(), "chưa nhập lý do → nút hoàn tất bị khoá");
  await dlg.getByLabel("Giá hoàn (₫)").fill(String(price + 1000).replace(/\B(?=(\d{3})+(?!\d))/g, "."));
  await dlg.getByText("Không được cao hơn giá hiện hành").waitFor();
  assert(await submit.isDisabled(), "giá cao hơn hiện hành → nút bị khoá");
  await dlg.getByLabel("Giá hoàn (₫)").fill(String(price).replace(/\B(?=(\d{3})+(?!\d))/g, "."));
  await dlg.getByTestId("qr-reason").fill("Khách trả hàng không mang hoá đơn");
  await shot(o.page, "pos-quick-return-1440.png");
  await submit.click();
  await toastOk(o.page, /Đã trả hàng/);
  const rets = (await apiGet(o.ctx, "/orders?kind=return&limit=20")).items;
  const qr = rets.find((r) => !r.originalOrderId && r.total === price * 2);
  assert(!!qr, `có phiếu trả nhanh ${price * 2} không có hoá đơn gốc`);
  assert((await cashExpected()) === e0 - price * 2, "tiền mặt dự kiến của ca giảm đúng số hoàn");
  await go(o.page, `/orders?open=${qr.id}`);
  await o.page.getByText("Trả hàng nhanh (không có hoá đơn gốc)").waitFor();
  await shot(o.page, "pos-quick-return-chi-tiet-1440.png");

  // ============================================================ Sửa hoá đơn (PC 1440)
  step("[PC 1440] Đơn hàng → chi tiết đơn POS → Sửa hoá đơn: đổi 2kg thành 3kg, lý do, xác nhận");
  const ord = await sell(2);
  const e1 = await cashExpected();
  await go(o.page, `/orders?open=${ord.id}`);
  await o.page.getByTestId("order-correct-btn").click();
  const form = o.page.getByTestId("order-correction");
  await form.waitFor();
  await form.getByLabel(/^Số lượng/).first().fill("3");
  assert(await form.getByTestId("oc-submit").isDisabled(), "chưa nhập lý do → nút xác nhận bị khoá");
  await form.getByTestId("oc-reason").fill("Khách lấy thêm 1kg, nhập nhầm số lượng");
  await form.getByText("Khách trả thêm").waitFor();
  await form.getByLabel("Khách đưa (₫)").fill(String(price).replace(/\B(?=(\d{3})+(?!\d))/g, "."));
  await shot(o.page, "order-correction-1440.png");
  await form.getByTestId("oc-submit").click();
  await toastOk(o.page, /Đã sửa hoá đơn/);
  const after = await apiGet(o.ctx, "/orders/" + ord.id);
  assert(after.correction?.role === "replaced", "đơn cũ liên kết tới đơn thay thế");
  const sale = await apiGet(o.ctx, "/orders/" + after.correction.linkedId);
  assert(sale.total === price * 3 && sale.correctedFromOrderId === ord.id, `đơn mới ${price * 3} liên kết đơn cũ`);
  assert((await cashExpected()) === e1 + price, "két chỉ tăng phần chênh (khoản đã thu chuyển sang đơn mới)");
  await o.page.getByText("Đơn này thay thế đơn đã sửa").waitFor();
  await shot(o.page, "order-correction-ket-qua-1440.png");

  // ============================================================ ĐT 390
  step("[ĐT 390] Trả hàng nhanh + Sửa hoá đơn: bố cục, không tràn ngang");
  const m = await newPage(mobile, "mobile");
  await login(m.page, OWNER.u, OWNER.p);
  await go(m.page, "/pos");
  await m.page.getByLabel("Tìm sản phẩm").waitFor();
  await m.page.getByTestId("pos-quick-return-btn").click();
  const md = m.page.getByRole("dialog", { name: "Trả hàng nhanh" });
  await md.waitFor();
  await md.getByTestId("qr-search").fill("Táo Envy");
  await md.locator(".ex-pick", { hasText: "Táo Envy" }).first().click();
  await md.getByTestId("qr-line").waitFor();
  await md.getByTestId("qr-reason").fill("Khách trả hàng");
  await noOverflow(m.page, "sheet Trả hàng nhanh");
  await shot(m.page, "pos-quick-return-390.png");
  await md.getByTestId("qr-submit").click();
  await toastOk(m.page, /Đã trả hàng/);
  const ord2 = await sell(2);
  await go(m.page, `/orders?open=${ord2.id}`);
  await m.page.getByTestId("order-correct-btn").click();
  const mf = m.page.getByTestId("order-correction");
  await mf.waitFor();
  await mf.getByLabel(/^Số lượng/).first().fill("1");
  await mf.getByTestId("oc-reason").fill("Khách bớt 1kg");
  await mf.getByText("Hoàn lại khách").waitFor();
  await noOverflow(m.page, "form Sửa hoá đơn");
  await shot(m.page, "order-correction-390.png");
  await mf.getByTestId("oc-submit").click();
  await toastOk(m.page, /Đã sửa hoá đơn/);
  const after2 = await apiGet(o.ctx, "/orders/" + ord2.id);
  const sale2 = await apiGet(o.ctx, "/orders/" + after2.correction.linkedId);
  assert(sale2.total === price, "đơn sau khi sửa còn 1kg");
  await noOverflow(m.page, "chi tiết đơn sau khi sửa");
} catch (e) {
  if (!/^assert:/.test(e.message)) fail("EXCEPTION: " + (e.stack ?? e.message));
}

await browser.close();
console.log("\n" + (failures.length ? `THẤT BẠI: ${failures.length} lỗi\n` + failures.map((f) => " - " + f).join("\n") : "TẤT CẢ ĐẠT (bộ pos-return-fix)"));
process.exit(failures.length ? 1 : 0);
