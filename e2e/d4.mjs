// E2E Đợt 4 (khuyến mãi / voucher / tích điểm / giỏ quà & đặt trước / giá đối thủ / gợi ý đặt hàng / báo cáo tài chính)
// Giao diện thật + Worker thật. Chạy: node e2e/d4.mjs
// Biến môi trường: ERP (http://localhost:8792), SHOP (http://localhost:8793), OWNER_USER / OWNER_PASS, SHOTS=0 để bỏ chụp ảnh.
// Điều kiện: ERP + Shop worker dùng chung một DB; `loyalty.enabled=1` trong settings (script tự bật qua API /settings).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const ERP = process.env.ERP ?? "http://localhost:8792";
const SHOP = process.env.SHOP ?? "http://localhost:8793";
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
const digits = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10);
const vnd = (n) => new Intl.NumberFormat("vi-VN").format(n);

// ---- phản hồi 4xx/5xx CHỦ ĐÍCH mong đợi (mỗi lần gọi cho phép đúng một phản hồi) ----
const allowed = [];
const allow = (status, re, why) => allowed.push({ status, re, why, used: 0 });
function watch(page, who) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return; // đã kiểm ở bộ nghe response
    fail(`[${who}] console.error: ${t}`);
  });
  page.on("pageerror", (e) => fail(`[${who}] pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (r.status() < 400 || !u.pathname.startsWith("/api/")) return;
    const hit = allowed.find((a) => a.status === r.status() && a.re.test(u.pathname) && a.used === 0);
    if (hit) { hit.used++; return; }
    fail(`[${who}] ${r.request().method()} ${u.pathname} → ${r.status()} (không dự kiến)`);
  });
}

const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
async function newPage(opts, who) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(9000);
  watch(page, who);
  return { ctx, page };
}
const shot = async (page, name, o = {}) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 7000 }).catch(() => {});
  await page.screenshot({ path: join(DIR, name), ...o });
};
const noHScroll = async (page, what) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(over <= 1, `${what}: không tràn ngang (${over}px)`);
};

// ---------------------------------------------------------------- ERP API (Bearer) để dựng dữ liệu
let token = "";
async function erp(method, path, body, expect) {
  const r = await fetch(ERP + "/api/v1" + path, { method, headers: { Authorization: "Bearer " + token, "X-Requested-With": "hm-erp", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  const j = t ? JSON.parse(t) : null;
  if (expect != null) { if (r.status !== expect) throw new Error(`ERP ${method} ${path} → ${r.status} (cần ${expect}) ${t.slice(0, 200)}`); return j; }
  if (!r.ok) throw new Error(`ERP ${method} ${path} → ${r.status} ${t.slice(0, 300)}`);
  return j;
}
const shopApi = async (path, body) => { const r = await fetch(SHOP + "/api" + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Requested-With": "hm-shop" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const products = async () => (await erp("GET", "/products?limit=200&active=1")).items;
const toastOk = (page, re) => page.locator(".toast", { hasText: re }).first().waitFor();
const goErp = async (page, path) => { await page.goto(ERP + path); await page.locator("main, .main").first().waitFor(); };

async function posSaleApi(lines, customerId, voucherCode) {
  const mk = (total) => ({ clientUuid: crypto.randomUUID(), lines, ...(customerId ? { customerId } : {}), ...(voucherCode ? { voucherCode } : {}), payments: [{ method: "cash", amount: total }] });
  const r = await fetch(ERP + "/api/v1/pos/orders", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Requested-With": "hm-erp" }, body: JSON.stringify(mk(100_000_000)) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let exitCode = 0;
let pg, cp, sh;
const dbgShot = async (why) => { for (const [n, x] of [["pg", pg], ["cp", cp], ["sh", sh]]) if (x) await x.screenshot({ path: `${process.env.DBG_DIR ?? "/tmp"}/d4-fail-${n}.png`, fullPage: true }).catch(() => {}); };
try {
  // ================= 0. Dựng dữ liệu =================
  step("Dựng dữ liệu qua ERP: đăng nhập, mở ca, nhập kho, bật tích điểm");
  const lr = await fetch(ERP + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "hm-erp" }, body: JSON.stringify({ username: OWNER.u, password: OWNER.p }) });
  if (!lr.ok) throw new Error("Không đăng nhập được ERP: " + lr.status);
  token = (await lr.json()).token;
  const exp = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const prods0 = await products();
  const byId = new Map(prods0.map((p) => [p.id, p]));
  const doc = await erp("POST", "/stock-docs", { type: "receipt", locationId: 1, supplierId: 2 });
  for (const pid of [1, 2, 4, 5, 12]) await erp("POST", `/stock-docs/${doc.id}/lines`, { productId: pid, unit: byId.get(pid).baseUnit, qty: 80, unitCost: 50000, expiresAt: exp });
  await erp("POST", `/stock-docs/${doc.id}/lines`, { productId: 3, unit: "kg", qty: 5, unitCost: 300000, expiresAt: exp });
  await erp("POST", `/stock-docs/${doc.id}/post`, {});
  const shiftR = await fetch(ERP + "/api/v1/shifts/open", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Requested-With": "hm-erp" }, body: JSON.stringify({ openingCash: 2000000 }) });
  assert(shiftR.ok || shiftR.status === 409, `ca bán hàng đã mở (${shiftR.status})`);
  await erp("PUT", "/settings", { settings: { "loyalty.enabled": "1" } });
  ok("đã nhập kho (Táo, Nho, Kiwi, Lê, Bưởi 80; Cherry 5) và bật loyalty.enabled");
  // Cherry bán 4 kg → gợi ý đặt hàng có nhu cầu thật (tồn còn 1 kg)
  const cherry = await posSaleApi([{ productId: 3, unit: "kg", qty: 4 }]);
  assert(cherry.status === 201, `bán 4 kg Cherry (tạo tốc độ bán cho gợi ý đặt hàng) → ${cherry.status}`);

  await erp("POST", "/prices/bulk", { priceListId: 1, items: [{ productId: 1, unitPrice: 159000 }], note: "e2e Đợt 4: đưa giá Táo về mốc ban đầu" });
  const taoPrice = (await products()).find((p) => p.id === 1).price;
  assert(taoPrice === 159000, `giá Táo Envy ở mốc 159.000 (${taoPrice})`);
  const o = await newPage(mobile, "chủ-mobile");
  pg = o.page;
  const login = await o.ctx.request.post(ERP + "/api/auth/login", { data: { username: OWNER.u, password: OWNER.p }, headers: { "X-Requested-With": "hm-erp" } });
  assert(login.ok(), "trình duyệt đăng nhập ERP (cookie)");

  // ================= 1. Khuyến mãi % =================
  step("Khuyến mãi: tạo giảm 10% cho Táo Envy → gửi duyệt (chủ → kích hoạt ngay)");
  await goErp(pg, "/promotions");
  const promoName = `E2E giảm 10% Táo ${RUN}`;
  await pg.getByRole("button", { name: "+ Khuyến mãi mới" }).click();
  {
    const dlg = pg.getByRole("dialog").first();
    await dlg.getByLabel("Tên chương trình").fill(promoName);
    await dlg.getByRole("button", { name: "+ Sản phẩm" }).click();
    const pick = pg.getByRole("dialog").last();
    await pick.getByLabel("Tìm sản phẩm").fill("Táo Envy");
    await pick.locator("button.dt-card", { hasText: "Táo Envy" }).first().click();
    await dlg.getByText("Táo Envy").first().waitFor();
    await dlg.getByRole("button", { name: "Lưu & gửi duyệt" }).click();
  }
  await toastOk(pg, /kích hoạt/);
  await pg.locator(".dt-card", { hasText: promoName }).first().waitFor();
  assert((await pg.locator(".dt-card", { hasText: promoName }).first().innerText()).includes("Đang chạy"), "khuyến mãi % hiển thị trạng thái Đang chạy");

  step("Khuyến mãi voucher: giảm 20.000 chỉ khi nhập mã → sinh 3 voucher dùng 1 lần");
  const vName = `E2E voucher 20k ${RUN}`;
  await pg.getByRole("button", { name: "+ Khuyến mãi mới" }).click();
  {
    const dlg = pg.getByRole("dialog").first();
    await dlg.getByLabel("Tên chương trình").fill(vName);
    await dlg.getByLabel("Loại khuyến mãi").selectOption("amount");
    await dlg.getByLabel("Số tiền giảm (₫)").fill("20000");
    await dlg.getByLabel("Chỉ áp dụng khi nhập voucher").check();
    await dlg.getByRole("button", { name: "Lưu & gửi duyệt" }).click();
  }
  await toastOk(pg, /kích hoạt/);
  await pg.getByRole("tab", { name: "Voucher" }).click();
  await pg.getByLabel("Số lượng (1–500)").waitFor();
  const optVal = await pg.locator("select").first().locator("option", { hasText: vName }).first().getAttribute("value");
  await pg.locator("select").first().selectOption(optVal);
  await pg.getByLabel("Số lượng (1–500)").fill("3");
  await pg.getByLabel("Số lượt dùng / mã").fill("1");
  await pg.getByLabel(/^Tiền tố/).fill("E2E");
  await pg.getByRole("button", { name: "Tạo voucher" }).click();
  await pg.locator("[data-testid=new-vouchers]").waitFor();
  const codes = (await pg.locator("[data-testid=new-vouchers]").innerText()).trim().split(/\s+/);
  assert(codes.length === 3 && codes.every((c) => c.startsWith("E2E")), `đã sinh 3 voucher (${codes[0]}…)`);
  const [vPos, vShop] = codes;
  await pg.getByText("Danh sách voucher (3)").waitFor();

  // ================= 2. POS: khuyến mãi tự động =================
  step("POS: bán 1 kg Táo → thấy giảm 10% tự động ở bước thanh toán");
  const posAddTao = async () => {
    await pg.locator('button.ptile[aria-label="Thêm Táo Envy"]').click();
    await pg.getByRole("button", { name: "1 kg", exact: true }).click();
    await pg.getByRole("button", { name: /^Thêm 1 kg/ }).click();
    await pg.getByRole("button", { name: /^Xem giỏ/ }).click();
    await pg.getByRole("button", { name: /^Thanh toán/ }).click();
  };
  const finishSale = async () => {
    await pg.getByRole("button", { name: /^Hoàn tất/ }).click();
    await pg.getByRole("dialog", { name: "Hoá đơn" }).waitFor();
    await pg.getByRole("button", { name: "Đơn mới" }).click();
  };
  await goErp(pg, "/pos");
  await posAddTao();
  const disc10 = Math.round(taoPrice * 0.1);
  await pg.locator("[data-testid=pos-discount]").first().waitFor();
  assert(digits(await pg.locator("[data-testid=pos-total]").innerText()) === taoPrice - disc10, `tổng sau KM 10% = ${vnd(taoPrice - disc10)}`);
  await finishSale();
  let last = (await erp("GET", "/orders?limit=1&kind=sale")).items?.[0];
  const ord1 = last ? await erp("GET", `/pos/orders/${last.id}`).catch(() => null) : null;
  if (ord1) assert(ord1.discounts?.length >= 1 && ord1.total === taoPrice - disc10, "đơn POS lưu discounts[] và tổng đúng");

  // ================= 3. POS: voucher dùng 1 lần =================
  step("POS: bán với voucher (lần 1 thành công, lần 2 bị từ chối)");
  await posAddTao();
  await pg.getByLabel("Mã voucher").fill(vPos);
  await pg.getByRole("button", { name: "Áp dụng" }).click();
  await pg.getByText(`Đã áp dụng voucher ${vPos}`).waitFor();
  assert(digits(await pg.locator("[data-testid=pos-total]").innerText()) === taoPrice - 20000, `tổng sau voucher 20.000 = ${vnd(taoPrice - 20000)} (voucher lợi hơn KM 10%)`);
  await pg.locator(".sheet .body").evaluate((e) => { e.scrollTop = 0; });
  await shot(pg, "d4-pos-voucher.png");
  await finishSale();
  const pv = await erp("GET", `/promotions/${(await erp("GET", "/promotions?status=active")).items.find((p) => p.name === vName).id}/vouchers`);
  assert(pv.items.find((v) => v.code === vPos).usedCount === 1, "voucher đã ghi nhận 1 lượt dùng");
  // dùng lại: UI báo hết lượt
  await posAddTao();
  await pg.getByLabel("Mã voucher").fill(vPos);
  await pg.getByRole("button", { name: "Áp dụng" }).click();
  await pg.getByText(/Voucher đã hết lượt/).waitFor();
  ok("UI báo “Voucher đã hết lượt” khi dùng lần 2");
  assert(await pg.getByRole("button", { name: /^Hoàn tất/ }).isEnabled(), "vẫn bán được không voucher");
  await pg.getByRole("button", { name: "Bỏ" }).click();
  await pg.getByRole("button", { name: "Đóng", exact: true }).click();
  await pg.getByRole("button", { name: "Xoá giỏ" }).click();
  // API trực tiếp: 409 voucher_exhausted
  allow(409, /\/api\/v1\/pos\/orders$/, "voucher đã hết lượt → 409 voucher_exhausted");
  const again = await posSaleApi([{ productId: 1, unit: "kg", qty: 1 }], null, vPos);
  assert(again.status === 409 && again.body?.error?.code === "voucher_exhausted", "API: dùng voucher lần 2 → 409 voucher_exhausted");
  allow(422, /\/api\/v1\/pos\/orders$/, "voucher sai → 422 voucher_invalid");
  const bad = await posSaleApi([{ productId: 1, unit: "kg", qty: 1 }], null, "KHONGCOTHAT");
  assert(bad.status === 422 && bad.body?.error?.code === "voucher_invalid", "API: voucher không tồn tại → 422 voucher_invalid");

  // ================= 4. Tích điểm =================
  step("Tích điểm: gắn khách → bán tích điểm → bán kế tiếp đổi điểm");
  const cust = await erp("POST", "/customers", { name: `Khách tích điểm ${RUN}`, phone: "09" + String(Math.floor(10000000 + Math.random() * 89999999)), customerGroupId: 1, creditLimit: 0, paymentTermsDays: 0, contacts: [{ name: "Người nhận", phone: "0901234567", isReceiver: true }], addresses: [{ label: "Nhà", address: "12 Nguyễn Huệ, Quận 1", isDefault: true }] });
  await goErp(pg, "/pos");
  await pg.locator('button.ptile[aria-label="Thêm Táo Envy"]').click();
  await pg.getByRole("button", { name: "1 kg", exact: true }).click();
  await pg.getByRole("button", { name: /^Thêm 1 kg/ }).click();
  await pg.getByRole("button", { name: /^Xem giỏ/ }).click();
  await pg.getByRole("button", { name: "Gắn khách" }).click();
  await pg.getByRole("dialog").getByLabel("Tên, mã hoặc số điện thoại").fill(`Khách tích điểm ${RUN}`);
  await pg.getByRole("dialog").locator("button.dt-card", { hasText: `Khách tích điểm ${RUN}` }).first().click();
  await pg.locator("[data-testid=pos-customer]", { hasText: `Khách tích điểm ${RUN}` }).waitFor();
  await pg.getByRole("button", { name: /^Thanh toán/ }).click();
  await finishSale();
  let loy = await erp("GET", `/customers/${cust.id}/loyalty`);
  const earn = Math.floor((taoPrice - disc10) / 10000);
  assert(loy.points === earn, `khách được tích ${earn} điểm (hiện ${loy.points})`);
  // lần 2: đổi điểm
  await pg.locator('button.ptile[aria-label="Thêm Táo Envy"]').click();
  await pg.getByRole("button", { name: "1 kg", exact: true }).click();
  await pg.getByRole("button", { name: /^Thêm 1 kg/ }).click();
  await pg.getByRole("button", { name: /^Xem giỏ/ }).click();
  await pg.getByRole("button", { name: "Gắn khách" }).click();
  await pg.getByRole("dialog").getByLabel("Tên, mã hoặc số điện thoại").fill(`Khách tích điểm ${RUN}`);
  await pg.getByRole("dialog").locator("button.dt-card", { hasText: `Khách tích điểm ${RUN}` }).first().click();
  await pg.getByRole("button", { name: /^Thanh toán/ }).click();
  await pg.locator("[data-testid=pos-points]").waitFor();
  assert(digits(await pg.locator("[data-testid=pos-points]").innerText()) === earn, `POS hiển thị số dư ${earn} điểm`);
  await pg.getByRole("button", { name: "Tối đa" }).click();
  await pg.getByText(`Đổi ${earn} điểm`).waitFor();
  const afterRedeem = taoPrice - disc10 - earn * 100;
  await pg.waitForFunction((v) => document.querySelector("[data-testid=pos-total]")?.textContent.replace(/\D/g, "") === String(v), afterRedeem);
  ok(`tổng sau đổi ${earn} điểm = ${vnd(afterRedeem)}`);
  await finishSale();
  loy = await erp("GET", `/customers/${cust.id}/loyalty`);
  assert(loy.ledger.some((l) => l.kind === "redeem" && l.points === -earn), "sổ điểm có dòng đổi điểm");
  assert(loy.points === Math.floor(afterRedeem / 10000), `số dư sau đổi + tích lại = ${loy.points}`);
  // điều chỉnh qua màn Khuyến mãi → Tích điểm
  await goErp(pg, "/promotions");
  await pg.getByRole("tab", { name: "Tích điểm" }).click();
  await pg.getByLabel("Tên / mã / số điện thoại").fill(`Khách tích điểm ${RUN}`);
  await pg.getByRole("button", { name: "Tìm", exact: true }).click();
  await pg.locator("button.dt-card", { hasText: `Khách tích điểm ${RUN}` }).first().click();
  await pg.getByLabel(/^Số điểm \(\+ cộng/).fill("50");
  await pg.getByLabel(/^Lý do/).fill("Thưởng thử nghiệm e2e");
  await pg.getByRole("button", { name: "Lưu điều chỉnh" }).click();
  await toastOk(pg, /Đã điều chỉnh điểm/);
  loy = await erp("GET", `/customers/${cust.id}/loyalty`);
  assert(loy.ledger.some((l) => l.kind === "adjust" && l.points === 50), "điều chỉnh +50 điểm ghi vào sổ");

  // ================= 5. Màn Khuyến mãi (ảnh) =================
  step("Màn Khuyến mãi: danh sách + tính thử");
  await goErp(pg, "/promotions");
  await pg.locator(".dt-card", { hasText: promoName }).first().waitFor();
  await noHScroll(pg, "Khuyến mãi");
  await shot(pg, "d4-promotions.png");
  await pg.getByRole("tab", { name: "Tính thử" }).click();
  await pg.getByRole("button", { name: "+ Thêm sản phẩm" }).click();
  await pg.getByRole("dialog").getByLabel("Tìm sản phẩm").fill("Táo Envy");
  await pg.getByRole("dialog").locator("button.dt-card", { hasText: "Táo Envy" }).first().click();
  await pg.getByRole("button", { name: "Tính giảm giá" }).click();
  await pg.getByText("Khách trả").waitFor();
  assert(digits(await pg.locator(".totals .grand .money").innerText()) === taoPrice - disc10, "tính thử: khách trả đúng sau KM 10%");

  // ================= 6. Shop: voucher =================
  step("Shop: áp voucher trong giỏ → thấy giảm giá → thanh toán đúng tổng");
  const sp = await newPage(mobile, "khách-shop");
  sh = sp.page;
  await sh.goto(SHOP + "/san-pham/tao-envy");
  await sh.getByRole("heading", { level: 1 }).waitFor();
  { const qi = sh.getByRole("group", { name: /^Số lượng/ }).locator("input"); await qi.fill("1"); await qi.press("Tab"); }
  await sh.getByRole("button", { name: /Thêm (nữa )?vào giỏ/ }).click();
  await sh.locator("[role=status][aria-live=polite]").filter({ hasText: /Đã thêm|vào giỏ/ }).first().waitFor({ state: "attached" });
  await sh.goto(SHOP + "/gio-hang");
  await sh.getByLabel("Giao đến quận/huyện").selectOption("Quận 1");
  await sh.locator("[data-testid=ship-fee]", { hasText: /\d/ }).waitFor();
  await sh.getByLabel("Mã giảm giá").fill(vShop);
  await sh.getByRole("button", { name: "Áp dụng" }).click();
  await sh.locator("[data-testid=voucher-ok]").waitFor();
  await sh.locator("[data-testid=discount-row]").first().waitFor();
  const quote = (await shopApi("/cart/quote", { items: [{ productId: 1, unit: "kg", qty: 0.5 }], district: "Quận 1", voucherCode: vShop })).body;
  const shown = digits(await sh.locator("[data-testid=grand-total]").innerText());
  const cartItems = JSON.parse(await sh.evaluate(() => localStorage.getItem("hm_shop_cart_v1")));
  const qtyKg = cartItems[0].qtyMilli / 1000;
  const quote2 = (await shopApi("/cart/quote", { items: [{ productId: 1, unit: "kg", qty: qtyKg }], district: "Quận 1", voucherCode: vShop })).body;
  assert(quote2.voucher?.applied === true && quote2.discount === 20000 && shown === quote2.total, `giỏ hiển thị tổng ${vnd(shown)} = báo giá server (giảm ${vnd(quote2.discount)})`);
  assert(quote.voucher?.applied !== undefined, "báo giá trả voucher{applied}");
  await sh.addStyleTag({ content: ".tabbar{display:none!important}" });
  await noHScroll(sh, "giỏ hàng shop");
  await shot(sh, "d4-shop-voucher.png", { fullPage: true });
  await sh.getByRole("button", { name: "Tiến hành đặt hàng" }).click();
  await sh.waitForURL(/\/thanh-toan/);
  await sh.getByLabel("Họ tên người nhận").fill("Khách E2E Đợt 4");
  await sh.getByLabel("Số điện thoại").fill("0909" + String(Math.floor(100000 + Math.random() * 899999)));
  await sh.getByLabel("Số nhà, tên đường").fill("12 Nguyễn Huệ");
  await sh.getByLabel("Phường/xã").fill("Bến Nghé");
  await sh.getByLabel("Quận/huyện", { exact: true }).selectOption("Quận 1");
  await sh.locator(".slot:not(.off)").first().waitFor();
  await sh.locator(".slot:not(.off)").first().click();
  await sh.locator("[data-testid=voucher-ok]").waitFor();
  assert(digits(await sh.locator("[data-testid=grand-total]").innerText()) === quote2.total, "trang thanh toán giữ voucher, tổng = báo giá");
  await sh.getByRole("button", { name: /^Đặt hàng ·/ }).click();
  await sh.waitForURL(/\/track\/[^?]+\?placed=1/);
  ok("đặt hàng online thành công với voucher");
  const tk = sh.url().match(/\/track\/([^?]+)/)[1];
  const vs = await erp("GET", `/promotions/${(await erp("GET", "/promotions?status=active")).items.find((p) => p.name === vName).id}/vouchers`);
  assert(vs.items.find((v) => v.code === vShop).usedCount === 1, "voucher online ghi nhận 1 lượt dùng");
  // dùng lại → báo hết lượt trong giỏ
  await sh.goto(SHOP + "/san-pham/tao-envy");
  await sh.getByRole("button", { name: /Thêm (nữa )?vào giỏ/ }).click();
  await sh.locator("[role=status][aria-live=polite]").filter({ hasText: /Đã thêm|vào giỏ/ }).first().waitFor({ state: "attached" });
  await sh.goto(SHOP + "/gio-hang");
  await sh.getByLabel("Mã giảm giá").fill(vShop);
  await sh.getByRole("button", { name: "Áp dụng" }).click();
  await sh.locator("[data-testid=voucher-bad]").waitFor();
  assert(/hết lượt/.test(await sh.locator("[data-testid=voucher-bad]").innerText()), "dùng lại voucher → “đã hết lượt sử dụng”");
  void tk;
  await sp.ctx.close();

  // ================= 7. Giỏ quà → đóng giỏ =================
  step("Giỏ quà: kiểm tra thành phần → đóng 3 giỏ → tồn giỏ tăng");
  const before = (await products()).find((p) => p.id === 25).availableMilli ?? 0;
  await goErp(pg, "/bundles");
  await pg.getByText("Thành phần cho 1 giỏ").waitFor();
  await pg.locator(".li", { hasText: "Táo Envy" }).first().waitFor();
  assert((await pg.locator(".li").count()) >= 3, "giỏ quà Tết có ≥ 3 thành phần");
  await pg.getByRole("tab", { name: "Đóng giỏ" }).click();
  await pg.getByLabel("Số giỏ cần đóng").fill("3");
  await pg.locator(".tbl tbody tr").first().waitFor();
  await pg.getByText("Đủ", { exact: true }).first().waitFor();
  await pg.getByRole("button", { name: "Đóng 3 giỏ" }).click();
  await pg.getByText(/Đã đóng giỏ/).first().waitFor();
  const after = (await products()).find((p) => p.id === 25).availableMilli ?? 0;
  assert(after - before === 3000, `tồn Giỏ quà Tết tăng 3 (${before / 1000} → ${after / 1000})`);
  await noHScroll(pg, "Giỏ quà");
  await shot(pg, "d4-bundles.png", { fullPage: false });

  step("Đặt trước: đặt cọc → giao hàng (thu phần còn lại); huỷ đơn khác hoàn cọc");
  await pg.getByRole("tab", { name: "Đặt trước" }).click();
  await pg.getByRole("button", { name: "+ Đơn đặt trước" }).click();
  {
    const dlg = pg.getByRole("dialog").first();
    await dlg.getByLabel("Tên khách").fill("Khách đặt giỏ " + RUN);
    await dlg.getByLabel("Số điện thoại").fill("0988" + String(Math.floor(100000 + Math.random() * 899999)));
    await dlg.getByRole("button", { name: "+ Thêm hàng" }).click();
    const pk = pg.getByRole("dialog").last();
    await pk.getByLabel("Tìm sản phẩm").fill("Giỏ quà Tết");
    await pk.locator("button.dt-card", { hasText: "Giỏ quà Tết" }).first().click();
    await dlg.getByRole("button", { name: /^Nhận cọc/ }).click();
  }
  await pg.getByRole("dialog").getByText(/Đặt trước DH|Đặt trước /).first().waitFor();
  await pg.getByRole("dialog").getByText("Đang giữ cọc").first().waitFor();
  const dlgPre = pg.getByRole("dialog").first();
  assert((await dlgPre.innerText()).includes("Còn phải thu khi giao"), "chi tiết đơn đặt trước hiển thị tiền cọc + còn phải thu");
  await shot(pg, "d4-preorder.png");
  await dlgPre.getByRole("button", { name: "Giao hàng" }).click();
  await dlgPre.getByRole("button", { name: "Xác nhận giao" }).click();
  await toastOk(pg, /Đã giao hàng/);
  await dlgPre.getByText("Đã trừ vào đơn").waitFor();
  ok("đơn đặt trước đã giao, cọc chuyển sang “Đã trừ vào đơn”");
  await dlgPre.getByRole("button", { name: "Đóng", exact: true }).click();
  // đơn thứ hai (API) rồi huỷ qua UI
  const pre2 = await erp("POST", "/pos/preorders", { customer: { name: "Khách huỷ " + RUN, phone: "0977" + String(Math.floor(100000 + Math.random() * 899999)) }, pickupDate: new Date(Date.now() + 2 * 86400000 + 7 * 3600000).toISOString().slice(0, 10), lines: [{ productId: 26, unit: "hop", qty: 1 }], deposit: { amount: 300000, method: "cash" } }, 201);
  await pg.getByRole("button", { name: "Đã huỷ", exact: true }).click(); // đổi bộ lọc để làm mới
  await pg.getByRole("button", { name: "Chờ giao", exact: true }).click();
  await pg.locator(".dt-card", { hasText: pre2.code }).first().click();
  await pg.getByRole("dialog").first().getByRole("button", { name: "Huỷ đơn" }).click();
  await pg.getByRole("dialog").first().getByLabel("Lý do huỷ").fill("Khách đổi ý");
  await pg.getByRole("dialog").first().getByRole("button", { name: "Xác nhận huỷ" }).click();
  await toastOk(pg, /hoàn cọc/);
  const pre2v = await erp("GET", `/pos/preorders/${pre2.id}`);
  assert(pre2v.status === "cancelled" && pre2v.deposit.status === "refunded", "huỷ đơn đặt trước → cọc “refunded”");
  await pg.getByRole("button", { name: "Đóng", exact: true }).click();

  // ================= 8. Gợi ý đặt hàng =================
  step("Gợi ý đặt hàng → tạo phiếu nhập nháp");
  await goErp(pg, "/purchasing");
  await pg.getByLabel("Chọn Cherry Mỹ").waitFor();
  const row = pg.locator("tr", { hasText: "Cherry Mỹ" }).first();
  assert(/\d/.test(await row.innerText()), "Cherry Mỹ có trong gợi ý (đã bán 4 kg, tồn 1 kg)");
  await pg.getByLabel("Chọn Cherry Mỹ").check();
  await pg.getByRole("button", { name: "Tạo phiếu nhập nháp" }).first().click();
  await pg.getByText(/Đã tạo phiếu nhập nháp/).first().waitFor();
  const rc = (await pg.locator(".banner b").first().innerText()).trim();
  assert(/^PN/i.test(rc) || rc.length > 3, `phiếu nháp ${rc}`);
  await noHScroll(pg, "Gợi ý đặt hàng");
  await pg.getByRole("button", { name: "Mở trong Kho" }).click();
  await pg.waitForURL(/\/inventory/);
  const docs = (await erp("GET", "/stock-docs?type=receipt&limit=10")).items ?? [];
  assert(docs.some((d) => d.code === rc && d.status === "draft"), `phiếu ${rc} ở trạng thái nháp trong Kho (API)`);

  // ================= 9. Giá đối thủ =================
  step("Giá đối thủ: nhập giá tay → ghép sản phẩm → so sánh → gợi ý giá");
  const cm = await newPage(desktop, "chủ-desktop");
  cp = cm.page;
  await cm.ctx.request.post(ERP + "/api/auth/login", { data: { username: OWNER.u, password: OWNER.p }, headers: { "X-Requested-With": "hm-erp" } });
  await goErp(cp, "/competitors");
  await cp.getByRole("tab", { name: "Nhập giá" }).click();
  const enter = async (compIdx, name, price) => {
    await cp.getByLabel(/^Đối thủ/).selectOption({ index: compIdx });
    await cp.getByLabel("Tên hàng của đối thủ").fill(name);
    await cp.getByLabel("Quy cách (số lượng)").fill("1");
    await cp.getByLabel("Giá bán (₫)").fill(String(price));
    await cp.getByRole("button", { name: "Ghi giá" }).click();
    await toastOk(cp, /Đã ghi giá/);
  };
  await enter(0, "Táo Envy New Zealand 1kg", Math.round((taoPrice * 0.8) / 1000) * 1000);
  await enter(1, "Táo Envy NZ loại 1", Math.round((taoPrice * 0.75) / 1000) * 1000);
  await cp.getByRole("tab", { name: "Ghép sản phẩm" }).click();
  await cp.getByRole("button", { name: "Tạo gợi ý" }).click();
  await cp.getByRole("button", { name: "Duyệt", exact: true }).first().waitFor({ timeout: 4000 }).catch(() => {}); // chạy lại: có thể đã ghép từ lần trước
  let approved = 0;
  for (let i = 0; i < 4; i++) {
    const b = cp.locator(".li", { hasText: "Táo Envy" }).getByRole("button", { name: "Duyệt" }).first();
    if (!(await b.count())) break;
    await b.click();
    await toastOk(cp, /Đã duyệt ghép/);
    await cp.locator(".toast").first().waitFor({ state: "detached" }).catch(() => {});
    approved++;
  }
  ok(`đã duyệt ${approved} gợi ý ghép`);
  await cp.getByRole("tab", { name: "So sánh giá" }).click();
  const crow = cp.locator("table.dt-table tbody tr", { hasText: "Táo Envy" }).first();
  await crow.waitFor();
  const ctext = await crow.innerText();
  assert(/\+\d/.test(ctext), `bảng so sánh hiển thị chênh lệch dương (ta đắt hơn): ${ctext.replace(/\s+/g, " ").slice(0, 90)}`);
  await noHScroll(cp, "So sánh giá (desktop)");
  await shot(cp, "d4-competitors-d.png");
  await crow.click();
  await cp.getByRole("dialog").locator("svg.chart").waitFor();
  ok("biểu đồ lịch sử giá hiển thị");
  await cp.getByRole("button", { name: "Đóng", exact: true }).click();
  await cp.getByRole("tab", { name: "Gợi ý giá" }).click();
  await cp.getByRole("button", { name: "Tạo gợi ý từ giá thị trường" }).click();
  const sugCard = cp.locator("section.card", { hasText: "Táo Envy" }).first();
  await sugCard.waitFor();
  await sugCard.getByRole("button", { name: "Chấp nhận" }).click();
  await toastOk(cp, /Đã áp dụng giá mới|Đã gửi duyệt/);
  const newTao = (await products()).find((p) => p.id === 1).price;
  assert(newTao < taoPrice,  `giá Táo Envy đổi theo gợi ý qua luồng giá (${vnd(taoPrice)} → ${vnd(newTao)})`);
  await cp.getByRole("tab", { name: /^Cảnh báo/ }).click();
  await cp.getByText(/Cảnh báo chưa xử lý/).waitFor();
  await cp.getByRole("tab", { name: "Nguồn & thu thập" }).click();
  await cp.getByText("Nguồn dữ liệu").waitFor();

  // ================= 10. Báo cáo tài chính =================
  step("Báo cáo tài chính: dòng tiền, lãi lỗ kênh, thuế, ngân sách");
  await goErp(cp, "/fin-reports");
  await cp.locator(".kpi", { hasText: "Tổng thu" }).waitFor();
  const inflow = digits(await cp.locator(".kpi", { hasText: "Tổng thu" }).locator(".v").innerText());
  assert(inflow > 0, `dòng tiền: tổng thu ${vnd(inflow)} > 0`);
  await cp.getByRole("tab", { name: "Lãi lỗ theo kênh" }).click();
  await cp.locator(".kpi:has(.l:text-is(\"Doanh thu\"))").waitFor();
  const rev = digits(await cp.locator(".kpi:has(.l:text-is(\"Doanh thu\"))").locator(".v").innerText());
  assert(rev > 0, `lãi lỗ theo kênh: doanh thu ${vnd(rev)} > 0`);
  await cp.getByRole("button", { name: "Quy tắc phân bổ" }).click();
  await cp.getByRole("dialog").getByLabel("Tiền điện, nước").selectOption("revenue_share");
  await cp.getByRole("dialog").getByRole("button", { name: "Lưu quy tắc" }).click();
  await toastOk(cp, /Đã lưu quy tắc/);
  await cp.getByRole("tab", { name: "Thuế GTGT" }).click();
  await cp.locator(".kpi", { hasText: "Thuế đầu ra" }).waitFor();
  await cp.getByRole("tab", { name: "Ngân sách & thực tế" }).click();
  await cp.getByRole("button", { name: "Sửa ngân sách" }).click();
  {
    const dlg = cp.getByRole("dialog");
    await dlg.getByLabel("Thêm dòng ngân sách").waitFor();
    for (const [label, val] of [["Doanh thu (tổng)", "10000000"], ["Giá vốn (tổng)", "4000000"]]) {
      if (!(await dlg.getByRole("textbox", { name: label }).count())) await dlg.getByLabel("Thêm dòng ngân sách").selectOption({ label });
      await dlg.getByRole("textbox", { name: label }).fill(val);
    }
    await dlg.getByRole("button", { name: "Lưu ngân sách" }).click();
  }
  await toastOk(cp, /Đã lưu ngân sách/);
  await cp.locator(".barrow", { hasText: "Doanh thu" }).first().waitFor();
  const rb = await cp.locator(".barrow", { hasText: "Doanh thu" }).first().innerText();
  assert(/[1-9]/.test(rb.replace(/10\.000\.000/, "")), "thanh ngân sách doanh thu có số thực tế khác 0");
  await cp.getByRole("tab", { name: "Lãi lỗ theo kênh" }).click();
  await cp.locator(".kpi:has(.l:text-is(\"Doanh thu\"))").waitFor();
  await noHScroll(cp, "Báo cáo tài chính (desktop)");
  await shot(cp, "d4-fin-reports-d.png");
  await cm.ctx.close();

  await o.ctx.close();
} catch (e) {
  exitCode = 1;
  console.error("\nLỖI KỊCH BẢN:", e?.message ?? e);
  await dbgShot();
}
await browser.close();
if (failures.length) { console.error(`\n${failures.length} lỗi:`); failures.forEach((f) => console.error(" - " + f)); exitCode = 1; }
else if (!exitCode) console.log("\nE2E Đợt 4: ĐẠT");
process.exit(exitCode);
