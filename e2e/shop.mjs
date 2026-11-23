// E2E cửa hàng khách (M8): giao diện thật + Shop Worker + ERP Worker thật.
// Chạy: npm run build:shop && npx wrangler dev -c wrangler.shop.jsonc --port 8788   (và ERP: wrangler dev --port 8787)
//       node e2e/shop.mjs
// Biến môi trường: SHOP (http://localhost:8788), ERP (http://localhost:8787), OWNER_USER / OWNER_PASS,
//                  SHOTS=0 để bỏ chụp ảnh, DEMO_MEDIA=0 để không tải ảnh minh hoạ/banner lên.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const qrcode = require("qrcode-generator");
const SHOP = process.env.SHOP ?? "http://localhost:8788";
const ERP = process.env.ERP ?? "http://localhost:8787";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DEMO = process.env.DEMO_MEDIA !== "0";
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

// ---- phản hồi 4xx/5xx được CHỦ ĐÍCH mong đợi (mỗi lần gọi cho phép đúng một phản hồi) ----
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
    if (r.status() < 400 || (!u.pathname.startsWith("/api/") && !u.pathname.startsWith("/img/"))) return;
    const hit = allowed.find((a) => a.status === r.status() && a.re.test(u.pathname) && a.used === 0);
    if (hit) { hit.used++; return; }
    fail(`[${who}] ${r.request().method()} ${u.pathname} → ${r.status()} (không dự kiến)`);
  });
}

const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
async function newPage(opts, who) {
  const ctx = await browser.newContext(opts);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SHOP }).catch(() => {});
  const page = await ctx.newPage();
  page.setDefaultTimeout(9000);
  watch(page, who);
  return { ctx, page };
}
const settle = async (page) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(350); };
const shot = async (page, name, opts = {}) => {
  if (!SHOTS) return;
  await settle(page);
  await page.screenshot({ path: join(DIR, name), ...opts });
};
const noHScroll = async (page, what) => {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert(o.sw <= o.iw + 1, `${what}: không tràn ngang (${o.sw} ≤ ${o.iw})`);
};
const shopApi = async (path, init) => { const r = await fetch(SHOP + "/api" + path, init); return { status: r.status, body: await r.json().catch(() => null) }; };

// ---------------------------------------------------------------- ERP (API) để dựng dữ liệu
let erpToken = "";
async function erp(method, path, body, form) {
  const r = await fetch(ERP + "/api/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + erpToken, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const t = await r.text();
  const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`ERP ${method} ${path} → ${r.status} ${t.slice(0, 200)}`);
  return j;
}

const art = (kind, w, h, zoom = 1) => {
  const P = { apple: ["#fde7e4", "#f9c3bd", "#e5483e", "#a8242a"], orange: ["#ffeccf", "#ffd09a", "#fb9a2e", "#d9620c"], melon: ["#e6f4dc", "#c6e5ad", "#ee4d5f", "#2f7d3a"], berry: ["#efe6fb", "#d8c8f3", "#9b3a8e", "#5d2a7e"], kiwi: ["#e8f3d3", "#cfe5a5", "#8fc23f", "#4c8a24"] }[kind];
  const cx = w / 2, cy = h * (zoom > 1 ? 0.5 : 0.54), r = h * 0.3 * zoom;
  const body = {
    apple: `<path d="M${cx} ${cy - r * 0.55}C${cx + r * 0.3} ${cy - r},${cx + r * 1.25} ${cy - r * 0.6},${cx + r * 1.1} ${cy + r * 0.3}C${cx + r} ${cy + r * 1.1},${cx + r * 0.4} ${cy + r * 1.3},${cx} ${cy + r * 1.1}C${cx - r * 0.4} ${cy + r * 1.3},${cx - r} ${cy + r * 1.1},${cx - r * 1.1} ${cy + r * 0.3}C${cx - r * 1.25} ${cy - r * 0.6},${cx - r * 0.3} ${cy - r},${cx} ${cy - r * 0.55}Z" fill="url(#f)"/><ellipse cx="${cx - r * 0.5}" cy="${cy - r * 0.1}" rx="${r * 0.14}" ry="${r * 0.3}" fill="#fff" opacity=".3" transform="rotate(18 ${cx - r * 0.5} ${cy - r * 0.1})"/><path d="M${cx} ${cy - r * 0.55}q0-${r * 0.4} ${r * 0.18}-${r * 0.65}" stroke="#6b4a2a" stroke-width="${r * 0.08}" fill="none" stroke-linecap="round"/><path d="M${cx + r * 0.18} ${cy - r * 1.05}c${r * 0.4}-${r * 0.45} ${r * 0.95}-${r * 0.4} ${r * 1.15} 0c-${r * 0.45} ${r * 0.45}-${r * 0.95} ${r * 0.45}-${r * 1.15} 0z" fill="#3f9a4a"/>`,
    orange: `<circle cx="${cx}" cy="${cy}" r="${r * 1.15}" fill="url(#f)"/><circle cx="${cx - r * 0.4}" cy="${cy - r * 0.45}" r="${r * 0.22}" fill="#fff" opacity=".35"/><path d="M${cx} ${cy - r * 1.1}c${r * 0.3}-${r * 0.4} ${r * 0.9}-${r * 0.5} ${r * 1.2}-${r * 0.2}c-${r * 0.4} ${r * 0.5}-${r * 0.9} ${r * 0.6}-${r * 1.2} ${r * 0.2}z" fill="#3f9a4a"/>`,
    melon: `<path d="M${cx - r * 1.5} ${cy - r * 0.2}a${r * 1.5} ${r * 1.5} 0 0 0 ${r * 3} 0z" fill="${P[3]}"/><path d="M${cx - r * 1.38} ${cy - r * 0.2}a${r * 1.38} ${r * 1.38} 0 0 0 ${r * 2.76} 0z" fill="#f4f9e9"/><path d="M${cx - r * 1.26} ${cy - r * 0.2}a${r * 1.26} ${r * 1.26} 0 0 0 ${r * 2.52} 0z" fill="url(#f)"/>${[-0.7, 0, 0.7].map((k, i) => `<ellipse cx="${cx + k * r}" cy="${cy + r * (0.35 + (i % 2) * 0.3)}" rx="${r * 0.05}" ry="${r * 0.1}" fill="#2b1a14"/>`).join("")}`,
    berry: [[-0.7, 0.3, 0.55], [0.5, 0.1, 0.62], [-0.1, 0.75, 0.5], [0.9, 0.75, 0.42], [-1.15, 0.9, 0.38]].map(([x, y, k]) => `<circle cx="${cx + x * r}" cy="${cy + (y - 0.2) * r}" r="${k * r}" fill="url(#f)"/><circle cx="${cx + x * r - k * r * 0.3}" cy="${cy + (y - 0.2) * r - k * r * 0.35}" r="${k * r * 0.18}" fill="#fff" opacity=".4"/>`).join("") + `<path d="M${cx - r * 0.2} ${cy - r * 0.6}c${r * 0.2}-${r * 0.6} ${r * 0.7}-${r * 0.8} ${r * 1.1}-${r * 0.6}c-${r * 0.2} ${r * 0.5}-${r * 0.7} ${r * 0.8}-${r * 1.1} ${r * 0.6}z" fill="#3f9a4a"/>`,
    kiwi: `<circle cx="${cx}" cy="${cy}" r="${r * 1.15}" fill="#7a5c3a"/><circle cx="${cx}" cy="${cy}" r="${r * 1.04}" fill="url(#f)"/><circle cx="${cx}" cy="${cy}" r="${r * 0.32}" fill="#f4f9e9"/>${Array.from({ length: 16 }).map((_, i) => `<ellipse cx="${cx}" cy="${cy - r * 0.62}" rx="${r * 0.04}" ry="${r * 0.09}" fill="#1c1a12" transform="rotate(${i * 22.5} ${cx} ${cy})"/>`).join("")}`,
  }[kind];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P[0]}"/><stop offset="1" stop-color="${P[1]}"/></linearGradient><radialGradient id="f" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="${P[2]}"/><stop offset="1" stop-color="${P[3]}"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#b)"/><circle cx="${w * 0.88}" cy="${h * 0.15}" r="${h * 0.32}" fill="#fff" opacity=".35"/><circle cx="${w * 0.08}" cy="${h * 0.95}" r="${h * 0.4}" fill="#fff" opacity=".25"/><ellipse cx="${cx}" cy="${cy + r * 1.35}" rx="${r * 1.3}" ry="${r * 0.14}" fill="#000" opacity=".1"/>${body}</svg>`;
};

async function renderPng(svg, w, h) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<body style="margin:0">${svg}</body>`);
  const buf = await p.screenshot({ type: "png" });
  await p.close();
  return buf;
}
const upload = async (path, buf, name) => {
  const f = new FormData();
  f.set("file", new Blob([buf], { type: "image/png" }), name);
  return erp("POST", path, null, f);
};

async function setupData() {
  const r = await fetch(ERP + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "hm-erp" }, body: JSON.stringify({ username: OWNER.u, password: OWNER.p }) });
  if (!r.ok) throw new Error("Không đăng nhập được ERP: " + r.status);
  erpToken = (await r.json()).token;

  // tồn kho: nhập lô cho các sản phẩm dùng trong kịch bản
  const exp = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const doc = await erp("POST", "/stock-docs", { type: "receipt", locationId: 1, supplierId: 1 });
  const stock = [[1, "kg"], [2, "kg"], [3, "kg"], [4, "kg"], [6, "kg"], [11, "kg"], [16, "trai"]];
  for (const [pid, unit] of stock) await erp("POST", `/stock-docs/${doc.id}/lines`, { productId: pid, unit, qty: 60, unitCost: 40000, expiresAt: exp });
  await erp("POST", `/stock-docs/${doc.id}/post`, {});
  ok(`đã nhập kho ${stock.length} mặt hàng (qua ERP)`);

  // tài khoản nhận chuyển khoản (để có QR)
  await erp("PUT", "/settings", { settings: { "payment.bank_account": "0123456789", "payment.bank_account_name": "CUA HANG HUU MANH" } });

  // ảnh minh hoạ & banner (một lần; FORCE_MEDIA=1 để tạo lại)
  if (DEMO) {
    const banners = (await erp("GET", "/cms/banners")).items;
    const mine = banners.filter((b) => b.title === "Trái cây tươi mỗi ngày");
    if (!mine.length || process.env.FORCE_MEDIA === "1") {
      for (const b of mine) await erp("DELETE", `/cms/banners/${b.id}`);
      const key = (await upload("/cms/images", await renderPng(art("orange", 1200, 525), 1200, 525), "banner.png")).key;
      await erp("POST", "/cms/banners", { title: "Trái cây tươi mỗi ngày", imageKey: key, linkUrl: "/san-pham", sort: -10, active: true });
      const imgs = { 1: "apple", 6: "orange", 16: "melon", 3: "berry", 4: "kiwi", 2: "kiwi", 11: "orange" };
      for (const [pid, kind] of Object.entries(imgs)) {
        const cur = (await erp("GET", `/products/${pid}/online`)).images ?? [];
        for (let i = cur.length - 1; i >= 0; i--) await erp("DELETE", `/products/${pid}/images/${i}`);
        await upload(`/products/${pid}/images`, await renderPng(art(kind, 800, 600), 800, 600), `${kind}.png`);
        await upload(`/products/${pid}/images`, await renderPng(art(kind, 800, 600, 1.7), 800, 600), `${kind}-2.png`);
      }
      ok("đã tải banner và ảnh minh hoạ sản phẩm");
    }
  }
}

const price = async (slug) => (await shopApi("/products/" + slug)).body.price;
const pickSlot = async (page) => {
  await page.locator(".slot:not(.off)").first().waitFor();
  await page.locator(".slot:not(.off)").first().click();
};
async function fillGuest(page, o) {
  await page.getByLabel("Họ tên người nhận").fill(o.name);
  await page.getByLabel("Số điện thoại").fill(o.phone);
  await page.getByLabel("Số nhà, tên đường").fill(o.line);
  await page.getByLabel("Phường/xã").fill("Bến Nghé");
  await page.getByLabel("Quận/huyện", { exact: true }).selectOption(o.district ?? "Quận 1");
}
async function addFromProduct(page, slug, qtyText) {
  await page.goto(SHOP + "/san-pham/" + slug);
  await page.getByRole("heading", { level: 1 }).waitFor();
  if (qtyText) {
    const input = page.getByRole("group", { name: /^Số lượng/ }).locator("input");
    await input.fill(qtyText);
    await input.press("Tab");
  }
  await page.getByRole("button", { name: /Thêm (nữa )?vào giỏ/ }).click();
  await page.locator('[role=status][aria-live=polite]').filter({ hasText: /Đã thêm|vào giỏ/ }).first().waitFor({ state: "attached" });
}

let exitCode = 0;
let page;
let restorePrice = null;
try {
  step("Dựng dữ liệu qua ERP (tồn kho, tài khoản nhận tiền, ảnh minh hoạ)");
  await setupData();
  const pCam = await price("cam-my");
  const pDua = await price("dua-hau");
  const pTao = await price("tao-envy");

  // ================= 1. Trang chủ =================
  step("Trang chủ (390×844): banner, nhóm hàng, sản phẩm nổi bật");
  const m = await newPage(mobile, "khách");
  page = m.page;
  await page.goto(SHOP + "/");
  await page.locator(".pcard").first().waitFor();
  const featured = await page.locator(".pcard").count();
  assert(featured >= 1, `trang chủ có ${featured} sản phẩm nổi bật`);
  assert((await page.title()).includes("Hữu Mạnh"), "tiêu đề trang chứa tên cửa hàng");
  assert((await page.locator('meta[name="description"]').getAttribute("content")).length > 20, "có meta description");
  await noHScroll(page, "trang chủ");
  await shot(page, "shop-home.png");

  const d = await newPage(desktop, "khách-desktop");
  await d.page.goto(SHOP + "/");
  await d.page.locator(".pcard").first().waitFor();
  await shot(d.page, "shop-home-d.png");
  await d.ctx.close();

  // ================= 2. Tìm kiếm & sắp xếp =================
  step("Tìm kiếm và sắp xếp");
  await page.getByRole("searchbox", { name: "Tìm trái cây" }).fill("cam");
  await page.getByRole("searchbox", { name: "Tìm trái cây" }).press("Enter");
  await page.waitForURL(/\/san-pham\?q=cam/);
  await page.locator(".pcard h3", { hasText: "Cam" }).first().waitFor();
  assert((await page.locator(".pcard").count()) >= 1, "tìm “cam” ra kết quả");
  await page.goto(SHOP + "/san-pham?sort=price_asc");
  await page.locator(".pcard").nth(1).waitFor();
  const prices = (await page.locator(".pcard .price strong").allTextContents()).map(digits);
  assert(prices.every((v, i) => i === 0 || prices[i - 1] <= v), "sắp xếp giá thấp → cao đúng thứ tự");
  await page.getByRole("button", { name: "Trái cây nhập khẩu" }).click();
  await page.waitForURL(/groupId=/);
  assert(page.url().includes("groupId="), "lọc theo nhóm hàng");

  // ================= 3. Sản phẩm + giỏ =================
  step("Trang sản phẩm: hàng cân 1,5 kg và hàng đếm 1 trái");
  await page.goto(SHOP + "/san-pham/cam-my");
  await page.getByRole("heading", { level: 1, name: "Cam Mỹ" }).waitFor();
  assert((await page.title()).startsWith("Cam Mỹ"), "tiêu đề trang = tên sản phẩm");
  assert(await page.getByText("Giá tạm tính, chốt theo cân thực tế").first().isVisible(), "hàng cân hiện “Giá tạm tính, chốt theo cân thực tế”");
  await noHScroll(page, "trang sản phẩm");
  await shot(page, "shop-product.png");
  const pd = await newPage(desktop, "khách-desktop");
  await pd.page.goto(SHOP + "/san-pham/tao-envy");
  await pd.page.getByRole("heading", { level: 1 }).waitFor();
  await shot(pd.page, "shop-product-d.png");
  await pd.ctx.close();
  await addFromProduct(page, "cam-my", "1,5");
  await addFromProduct(page, "dua-hau", null);
  const cart = JSON.parse(await page.evaluate(() => localStorage.getItem("hm_shop_cart_v1")));
  assert(cart.length === 2 && cart.find((c) => c.slug === "cam-my").qtyMilli === 1500, "giỏ lưu localStorage: Cam Mỹ 1,5 kg + Dưa hấu");

  // ================= 4. Giỏ hàng + phí giao =================
  step("Giỏ hàng: báo giá server, phí giao Quận 1");
  await page.goto(SHOP + "/gio-hang");
  await page.locator(".line").nth(1).waitFor();
  assert((await page.locator(".line").count()) === 2, "giỏ có 2 dòng (tải lại vẫn còn)");
  await page.getByLabel("Giao đến quận/huyện").selectOption("Quận 1");
  const sub = Math.round(pCam * 1.5) + pDua;
  await page.locator('[data-testid=ship-fee]', { hasText: "20.000" }).waitFor();
  assert(digits(await page.locator('[data-testid=ship-fee]').textContent()) === 20000, "phí giao Quận 1 = 20.000 ₫ (khu “Nội thành gần”)");
  assert(digits(await page.locator('[data-testid=grand-total]').textContent()) === sub + 20000, `tổng = tạm tính ${sub} + phí 20.000`);
  // bước đặt hàng cân: tăng 1 lần = +0,5 kg
  await page.getByRole("button", { name: /^Tăng 0,5 kg/ }).first().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("hm_shop_cart_v1")).find((c) => c.slug === "cam-my").qtyMilli === 2000);
  await page.getByRole("button", { name: /^Giảm 0,5 kg/ }).first().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("hm_shop_cart_v1")).find((c) => c.slug === "cam-my").qtyMilli === 1500);
  ok("nút +/- đổi 0,5 kg theo stepMilli");
  await page.locator('[data-testid=grand-total]', { hasText: String(sub + 20000).replace(/\B(?=(\d{3})+(?!\d))/g, ".") }).waitFor();
  await noHScroll(page, "giỏ hàng");
  await page.addStyleTag({ content: ".tabbar{display:none!important}" });
  await shot(page, "shop-cart.png", { fullPage: true });

  // ================= 5. Checkout khách vãng lai COD =================
  step("Đặt hàng khách vãng lai, COD, chọn khung giờ");
  await page.getByRole("button", { name: "Tiến hành đặt hàng" }).click();
  await page.waitForURL(/\/thanh-toan/);
  const phone1 = "0909" + String(Math.floor(100000 + Math.random() * 899999));
  await page.getByRole("button", { name: "Đặt hàng" }).first().click(); // thử gửi trống → phải báo lỗi
  await page.getByText("Vui lòng nhập họ tên người nhận").waitFor();
  assert(await page.getByText("Vui lòng chọn ngày và khung giờ giao").isVisible(), "form trống → báo lỗi từng trường (a11y: aria-invalid)");
  await fillGuest(page, { name: "Nguyễn Văn An", phone: phone1, line: "12 Nguyễn Huệ" });
  await pickSlot(page);
  await page.getByLabel(/^Email nhận thông báo/).fill(`khach.${RUN}@example.com`);
  await page.locator('[data-testid=ship-fee]', { hasText: "20.000" }).waitFor();
  await noHScroll(page, "thanh toán");
  await page.locator("#h-slot").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -16));
  await shot(page, "shop-checkout.png");
  await page.getByRole("button", { name: /^Đặt hàng ·/ }).click();
  await page.waitForURL(/\/track\/[^?]+\?placed=1/);
  const token1 = page.url().match(/\/track\/([^?]+)/)[1];
  const code1 = (await page.locator("[data-testid=order-code]").textContent()).trim();
  assert(/^DH-/.test(code1), `đặt hàng thành công, mã ${code1}`);
  assert(/Chờ|mới|Đã nhận|Đặt hàng/i.test(await page.locator("[data-testid=order-status]").textContent()), "trạng thái đơn hiển thị");
  const cartAfter = await page.evaluate(() => localStorage.getItem("hm_shop_cart_v1"));
  assert(cartAfter === "[]", "giỏ hàng được xoá sau khi đặt");

  // ================= 6. Tra cứu đơn bằng 4 số cuối =================
  step("Trang theo dõi /track/<token>: hỏi 4 số cuối SĐT → timeline");
  const t = await newPage(mobile, "tra-cứu");
  await t.page.goto(SHOP + "/track/" + token1);
  await t.page.getByLabel("4 số cuối điện thoại").waitFor();
  allow(404, /\/api\/orders\/track\//, "sai 4 số cuối → 404");
  await t.page.getByLabel("4 số cuối điện thoại").fill("0000");
  await t.page.getByRole("button", { name: "Xem đơn hàng" }).click();
  await t.page.getByText("Không tìm thấy đơn hàng").waitFor();
  ok("sai 4 số cuối → không lộ đơn");
  await t.page.getByLabel("4 số cuối điện thoại").fill(phone1.slice(-4));
  await t.page.getByRole("button", { name: "Xem đơn hàng" }).click();
  await t.page.locator("[data-testid=timeline] li").first().waitFor();
  assert((await t.page.locator("[data-testid=timeline] li").count()) >= 1, "timeline có sự kiện");
  assert((await t.page.getByText("Đặt hàng thành công").count()) >= 1, "sự kiện “Đặt hàng thành công” hiển thị");
  assert(!(await t.page.content()).includes(phone1), "SĐT người nhận được che trên trang");
  await noHScroll(t.page, "theo dõi đơn");

  // ================= 7. EC-03 khách chốt cân thực tế =================
  step("EC-03: ERP cân thực lệch > ngưỡng → khách xác nhận trên trang theo dõi");
  const list = await erp("GET", `/online-orders?q=${encodeURIComponent(code1)}`);
  const oid = list.items.find((x) => x.code === code1).id;
  await erp("POST", `/online-orders/${oid}/confirm`, {});
  await erp("POST", `/online-orders/${oid}/prepare`, {});
  const det = await erp("GET", `/online-orders/${oid}`);
  const camLine = det.lines.find((l) => /Cam/.test(l.productName ?? l.name ?? l.product_name ?? ""));
  const otherLine = det.lines.find((l) => l !== camLine);
  await erp("POST", `/online-orders/${oid}/pack`, { lines: [{ orderLineId: camLine.id ?? camLine.orderLineId, actualQty: 2.5, unit: "kg" }, ...(otherLine ? [{ orderLineId: otherLine.id ?? otherLine.orderLineId, actualQty: 1, unit: "trai" }] : [])] });
  await t.page.reload();
  await t.page.locator("[data-testid=weight-decision]").waitFor();
  assert(await t.page.getByText("Cần bạn xác nhận khối lượng thực tế").isVisible(), "hiện yêu cầu xác nhận khối lượng (pending_customer)");
  await t.page.getByRole("button", { name: "Đồng ý, giao hàng" }).click();
  await t.page.getByText("Bạn đã đồng ý giá theo khối lượng thực tế").waitFor();
  ok("khách đồng ý → đơn tiếp tục");
  await t.page.reload();
  await t.page.locator("[data-testid=timeline] li").nth(3).waitFor();
  await shot(t.page, "shop-track.png");
  await t.ctx.close();

  // ================= 8. Chuyển khoản + QR =================
  step("Đơn thứ hai: chuyển khoản → VietQR, nút sao chép");
  await addFromProduct(page, "tao-envy", "1");
  await page.goto(SHOP + "/thanh-toan");
  await page.getByLabel("Họ tên người nhận").waitFor();
  const phone2 = "0908" + String(Math.floor(100000 + Math.random() * 899999));
  await fillGuest(page, { name: "Trần Thị Bích", phone: phone2, line: "45 Lê Lợi" });
  await pickSlot(page);
  await page.getByLabel(/Chuyển khoản ngân hàng/).check({ force: true }).catch(async () => { await page.getByText("Chuyển khoản ngân hàng (VietQR)").click(); });
  await page.getByRole("button", { name: /^Đặt hàng ·/ }).click();
  await page.waitForURL(/\/track\/[^?]+\?placed=1/);
  const token2 = page.url().match(/\/track\/([^?]+)/)[1];
  await page.locator("[data-testid=qr]").waitFor();
  const content = (await page.locator("[data-testid=tr-content]").textContent()).trim();
  assert(/^HM DH/.test(content), `nội dung chuyển khoản “${content}”`);
  const vb = (await page.locator("[data-testid=qr]").getAttribute("viewBox")).split(" ").map(Number)[2];
  const view2 = (await shopApi(`/orders/track/${token2}?phone4=${phone2.slice(-4)}`)).body;
  const q = qrcode(0, "M"); q.addData(view2.transfer.qrPayload); q.make();
  assert(vb === q.getModuleCount() + 6, `QR (SVG) mã hoá đúng payload VietQR (${q.getModuleCount()}×${q.getModuleCount()} module)`);
  assert((await page.locator("[data-testid=qr] path").getAttribute("d")).length > 500, "QR có nội dung");
  await page.getByRole("button", { name: "Sao chép nội dung chuyển khoản" }).click();
  assert((await page.evaluate(() => navigator.clipboard.readText())) === content, "nút sao chép chép đúng nội dung chuyển khoản");
  await page.getByRole("button", { name: "Sao chép số tài khoản" }).click();
  assert((await page.evaluate(() => navigator.clipboard.readText())) === "0123456789", "nút sao chép chép đúng số tài khoản");
  assert(view2.transfer.amount === pTao * 1 + (pTao >= 500000 ? 0 : 20000), "số tiền chuyển khoản = tổng đơn");
  await noHScroll(page, "đơn chuyển khoản");
  await page.locator("[data-testid=transfer]").scrollIntoViewIfNeeded();
  await page.locator("[data-testid=transfer]").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -16));
  await shot(page, "shop-transfer-qr.png");

  // ================= 9. Đăng ký → đăng nhập → sổ địa chỉ → đơn → lịch sử → mua lại =================
  step("Đăng ký → đăng nhập → sổ địa chỉ");
  const email = `e2e.${RUN}@example.com`;
  const PW = "MatKhau-Shop-2026";
  await page.goto(SHOP + "/dang-ky");
  await page.getByLabel("Họ và tên").fill("Lê Thu Hà");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Số điện thoại").fill("0912" + String(Math.floor(100000 + Math.random() * 899999)));
  await page.getByLabel("Mật khẩu", { exact: true }).fill("123");
  await page.getByRole("button", { name: "Đăng ký" }).click();
  await page.getByText("Mật khẩu tối thiểu 8 ký tự").waitFor();
  ok("mật khẩu ngắn bị chặn ở client");
  await page.getByLabel("Mật khẩu", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Đăng ký" }).click();
  await page.getByText("Kiểm tra email của bạn").waitFor();
  ok("đăng ký 201 (thông báo chung, không lộ email tồn tại)");
  await page.getByRole("link", { name: "Đăng nhập" }).first().click();
  allow(401, /\/api\/auth\/login/, "sai mật khẩu → 401");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu").fill("sai-mat-khau");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByText("Email hoặc mật khẩu không đúng").waitFor();
  await page.getByLabel("Mật khẩu").fill(PW);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByRole("heading", { name: /Xin chào, Lê Thu Hà/ }).waitFor();
  ok("đăng nhập thành công (cookie HttpOnly)");
  assert(!(await page.evaluate(() => document.cookie.includes("hm_shop"))), "cookie phiên là HttpOnly (JS không đọc được)");

  await page.getByRole("link", { name: "Địa chỉ" }).click();
  await page.getByRole("button", { name: "Thêm địa chỉ" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Tên gợi nhớ").fill("Nhà");
  await dlg.getByLabel("Họ tên người nhận").fill("Lê Thu Hà");
  await dlg.getByLabel("Số điện thoại").fill("0912345678");
  await dlg.getByLabel("Số nhà, tên đường").fill("88 Điện Biên Phủ");
  await dlg.getByLabel("Quận/huyện").selectOption("Bình Thạnh");
  await dlg.getByRole("button", { name: "Lưu địa chỉ" }).click();
  await page.locator("[data-testid=addresses] li", { hasText: "88 Điện Biên Phủ" }).waitFor();
  ok("địa chỉ xuất hiện trong sổ địa chỉ (mặc định)");
  await noHScroll(page, "tài khoản");

  step("Đơn của khách đăng nhập (địa chỉ đã lưu) → lịch sử → mua lại");
  await addFromProduct(page, "cam-my", "1");
  await addFromProduct(page, "xoai-cat-hoa-loc", "1");
  await page.goto(SHOP + "/thanh-toan");
  await page.getByText("88 Điện Biên Phủ").first().waitFor();
  await pickSlot(page);
  await page.locator('[data-testid=ship-fee]').filter({ hasText: /\d/ }).waitFor();
  await page.getByRole("button", { name: /^Đặt hàng ·/ }).click();
  await page.waitForURL(/\/track\/[^?]+\?placed=1/);
  const code3 = (await page.locator("[data-testid=order-code]").textContent()).trim();
  await page.goto(SHOP + "/tai-khoan/don-hang");
  await page.locator("[data-testid=orders] li", { hasText: code3 }).waitFor();
  ok(`đơn ${code3} có trong lịch sử`);
  await shot(page, "shop-account.png");
  await page.locator("[data-testid=orders] li", { hasText: code3 }).getByRole("button", { name: "Mua lại" }).click();
  await page.waitForURL(/\/gio-hang/);
  await page.locator(".line").nth(1).waitFor();
  const reCart = JSON.parse(await page.evaluate(() => localStorage.getItem("hm_shop_cart_v1")));
  assert(reCart.length === 2 && reCart.some((c) => c.slug === "cam-my" && c.qtyMilli === 1000), "mua lại: giỏ có đủ 2 mặt hàng với số lượng cũ");

  // ================= 10. EC-11 giá đổi giữa báo giá và đặt hàng =================
  step("EC-11: ERP đổi giá giữa lúc báo giá và đặt hàng → 409 price_changed");
  await page.goto(SHOP + "/thanh-toan");
  await page.getByText("88 Điện Biên Phủ").first().waitFor();
  await pickSlot(page);
  await page.locator('[data-testid=grand-total]').filter({ hasText: /\d/ }).waitFor();
  await settle(page);
  const camBefore = await price("cam-my");
  const camAfter = camBefore + 12000;
  restorePrice = () => erp("POST", "/prices/bulk", { priceListId: 2, items: [{ productId: 6, unitPrice: camBefore }], note: "e2e shop khôi phục giá" });
  await erp("POST", "/prices/bulk", { priceListId: 2, items: [{ productId: 6, unitPrice: camAfter }], note: "e2e shop price_changed" });
  allow(409, /\/api\/checkout$/, "giá đã đổi → 409 price_changed");
  await page.getByRole("button", { name: /^Đặt hàng ·/ }).click();
  const modal = page.getByRole("dialog", { name: "Giá đã thay đổi" });
  await modal.waitFor();
  const diffTxt = await modal.locator(".price-diff li").first().textContent();
  assert(digits(diffTxt.replace(/Cam Mỹ/, "")) !== 0 && diffTxt.includes("Cam Mỹ"), `hộp thoại hiển thị giá cũ → mới: ${diffTxt.replace(/\s+/g, " ")}`);
  await modal.getByRole("button", { name: "Đồng ý giá mới và đặt hàng" }).click();
  await page.waitForURL(/\/track\/[^?]+\?placed=1/);
  const code4 = (await page.locator("[data-testid=order-code]").textContent()).trim();
  const ov = (await (async () => { const r = await page.evaluate(async (c) => (await fetch(`/api/me/orders/${c}`)).json(), code4); return r; })());
  assert(ov.lines.find((l) => /Cam/.test(l.name)).unitPrice === camAfter, `đơn ${code4} tạo với giá mới ${camAfter}`);
  await restorePrice();
  restorePrice = null;

  // ================= 11. Xoá tài khoản =================
  step("Xoá tài khoản: bị chặn khi còn đơn đang xử lý → huỷ đơn → xoá với mật khẩu");
  await page.goto(SHOP + "/tai-khoan");
  await page.getByRole("button", { name: "Xoá tài khoản của tôi" }).click();
  allow(403, /\/api\/me$/, "sai mật khẩu khi xoá → 403");
  allow(409, /\/api\/me$/, "còn đơn đang xử lý → 409 active_orders");
  let dd = page.getByRole("dialog");
  await dd.getByLabel("Mật khẩu").fill("sai-mat-khau");
  await dd.getByRole("button", { name: "Xoá vĩnh viễn" }).click();
  await dd.getByText("Mật khẩu không đúng").waitFor();
  await dd.getByLabel("Mật khẩu").fill(PW);
  await dd.getByRole("button", { name: "Xoá vĩnh viễn" }).click();
  await dd.getByText(/còn đơn hàng đang xử lý/).waitFor();
  ok("không cho xoá khi còn đơn đang xử lý (409 active_orders)");
  await dd.getByRole("button", { name: "Giữ tài khoản" }).click();
  // huỷ các đơn đang mở của khách
  for (const code of [code3, code4]) {
    await page.goto(SHOP + "/tai-khoan/don-hang/" + code);
    await page.getByRole("button", { name: "Huỷ đơn hàng" }).click();
    await page.getByRole("dialog").getByRole("button", { name: `Huỷ đơn ${code}` }).click();
    await page.locator("[data-testid=order-status]", { hasText: /huỷ/i }).waitFor();
  }
  ok("khách tự huỷ 2 đơn (EC-06)");
  await page.goto(SHOP + "/tai-khoan");
  await page.getByRole("button", { name: "Xoá tài khoản của tôi" }).click();
  dd = page.getByRole("dialog");
  await dd.getByLabel("Mật khẩu").fill(PW);
  await dd.getByRole("button", { name: "Xoá vĩnh viễn" }).click();
  await page.waitForURL(SHOP + "/");
  ok("đã xoá tài khoản, về trang chủ");
  allow(401, /\/api\/auth\/login/, "tài khoản đã xoá → đăng nhập 401");
  await page.goto(SHOP + "/dang-nhap");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu").fill(PW);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByText("Email hoặc mật khẩu không đúng").waitFor();
  ok("không đăng nhập lại được tài khoản đã xoá");

  // ================= 12. PWA =================
  step("PWA: manifest, service worker không cache /api");
  const mf = await (await fetch(SHOP + "/manifest.webmanifest")).json();
  assert(mf.name === "Hữu Mạnh" && mf.icons.length >= 3, "manifest có tên “Hữu Mạnh” và biểu tượng");
  const sw = await (await fetch(SHOP + "/sw.js")).text();
  assert(/startsWith\("\/api\/"\)/.test(sw) && /\/img\//.test(sw), "sw.js bỏ qua /api/*, cache ảnh /img/");
  const csp = (await fetch(SHOP + "/")).headers.get("content-security-policy") ?? "";
  assert(csp.includes("default-src 'self'") && !/unsafe-eval/.test(csp), "CSP chặt (không eval, không CDN ngoài trừ Turnstile)");
  await m.ctx.close();
} catch (e) {
  exitCode = 1;
  console.error("\nLỖI KỊCH BẢN:", e.message);
  if (process.env.FAIL_SHOT) await page?.screenshot({ path: process.env.FAIL_SHOT }).catch(() => {});
}

if (restorePrice) await restorePrice().catch(() => {});
console.log("\n=== Kết quả ===");
const unusedExpected = allowed.filter((a) => a.used === 0);
for (const a of unusedExpected) fail(`phản hồi mong đợi không xảy ra: ${a.status} ${a.re} (${a.why})`);
if (failures.length) {
  console.error(`${failures.length} lỗi:`);
  failures.forEach((f) => console.error(" - " + f));
  exitCode = 1;
} else if (!exitCode) console.log("TẤT CẢ ĐẠT");
await browser.close();
process.exit(exitCode);
