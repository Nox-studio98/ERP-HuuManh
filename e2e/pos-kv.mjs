// E2E POS kiểu KiotViet (docs/POS-KV.md): nhiều tab hoá đơn, lưới ảnh + lọc nhóm, máy quét mã vạch,
// người bán, sao chép đơn, sửa người bán/ghi chú hàng loạt. Giao diện thật + backend thật, 1440×900 và 390×844.
// Chạy trên DB MỚI:  npm run build && bash scripts/e2e-db.sh .wrangler/e-poskv 8871
//                    BASE=http://localhost:8871 PERSIST=.wrangler/e-poskv SHOTS=1 node e2e/pos-kv.mjs
// Biến: BASE, PERSIST (giữ cho thống nhất với các bộ khác; bộ này chuẩn bị dữ liệu qua API nên không cần ghi DB trực tiếp), SHOTS=0 để bỏ ảnh.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8871";
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

// mã vạch dùng cho máy quét
const BC_DUA = "8930000000010", BC_LE_THUNG = "8930000000055", BC_UNKNOWN = "8939999999999";

try {
  // ============================================================ chuẩn bị
  step("Chuẩn bị (qua API): nhập kho, gán mã vạch, tạo người bán thứ hai");
  const o = await newPage(desktop, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  const doc = await apiPost(o.ctx, "/stock-docs", { type: "receipt", locationId: 1 });
  const exp = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  for (const [productId, unit, qty, unitCost] of [[1, "kg", 200, 100000], [5, "kg", 200, 60000], [10, "trai", 200, 80000], [9, "trai", 100, 50000], [12, "trai", 100, 40000], [25, "hop", 50, 300000], [27, "hop", 50, 40000]]) {
    await apiPost(o.ctx, `/stock-docs/${doc.id}/lines`, { productId, unit, qty, unitCost, expiresAt: exp });
  }
  await apiPost(o.ctx, `/stock-docs/${doc.id}/post`);
  for (const [id, bc, unitBc] of [[10, BC_DUA, null], [5, null, { thung: BC_LE_THUNG }]]) {
    const p = await apiGet(o.ctx, "/products/" + id);
    const units = p.units.map((u) => ({ unit: u.unit, factorMilli: u.factorMilli, barcode: unitBc?.[u.unit] ?? u.barcode ?? null }));
    await apiSend(o.ctx, "PUT", "/products/" + id, { sku: p.sku, barcode: bc, name: p.name, groupId: p.groupId, baseUnit: p.baseUnit, sellByWeight: p.sellByWeight, origin: p.origin, shelfLifeDays: p.shelfLifeDays, minStockMilli: p.minStockMilli, active: true, units, version: p.version });
  }
  const sellerUser = await apiPost(o.ctx, "/users", { username: `banhang_${RUN}`, fullName: SELLER_NAME, role: "cashier", tempPassword: NEWPW });
  assert(sellerUser.id > 0, `tạo người bán "${SELLER_NAME}"`);
  const sellers = (await apiGet(o.ctx, "/pos/sellers")).items;
  assert(sellers.some((s) => s.name === SELLER_NAME), "/pos/sellers có người bán mới");

  // ============================================================ PC 1440
  step("[PC 1440] Mở ca bán hàng");
  await go(o.page, "/pos");
  await o.page.getByRole("heading", { name: "Mở ca bán hàng" }).waitFor();
  await o.page.getByLabel("Tiền đầu ca (₫)").fill("500000");
  await o.page.getByRole("button", { name: "Mở ca", exact: true }).click();
  await toastOk(o.page, /Đã mở ca/);
  await o.page.getByLabel("Tìm sản phẩm").waitFor();

  const flowTabs = async (page, tag, big) => {
    step(`[${tag}] 2 tab hoá đơn (nút + và F3): tab 1 giữ hàng, bán ở tab 2, tải lại vẫn còn`);
    await go(page, "/pos");
    await page.getByLabel("Tìm sản phẩm").waitFor();
    assert((await tabCount(page)) === 1, "bắt đầu với 1 tab");
    await addProduct(page, "Dưa lưới Đài Loan");
    await addProduct(page, "Dưa lưới Đài Loan");
    assert((await tabBadge(page, 1)) === 1, "tab 1 có 1 dòng (Dưa lưới ×2)");
    await page.getByTestId("pos-tab-add").click(); // nút +
    assert((await tabCount(page)) === 2, "bấm + → có tab 2");
    await page.keyboard.press("F3");               // phím tắt
    assert((await tabCount(page)) === 3, "F3 → có tab 3");
    await page.getByRole("button", { name: "Đóng hoá đơn 3" }).click();
    assert((await tabCount(page)) === 2, "đóng tab 3 (trống) → còn 2 tab");
    await page.getByTestId("pos-tab-2").click();
    assert((await tabBadge(page, 1)) === 1, "sang tab 2: tab 1 vẫn giữ hàng");
    await addProduct(page, "Bưởi da xanh");
    await showCart(page);
    assert(digits(await page.locator(".grand").innerText()) === 65000, "tab 2 tổng 65.000 (chỉ có Bưởi, không lẫn hàng tab 1)");
    await shot(page, `pos-kv-e2e-${tag}-tabs.png`);
    const code = await payCash(page);
    const ord = await findOrder(o.ctx, code);
    assert(ord.lines.length === 1 && /Bưởi/.test(ord.lines[0].productName ?? ord.lines[0].name ?? JSON.stringify(ord.lines[0])), `đơn ${code} chỉ có Bưởi`);
    assert((await tabCount(page)) === 1, "bán xong tab 2 → tab đó đóng, còn tab 1");
    assert((await tabBadge(page, 1)) === 1, "tab 1 vẫn giữ Dưa lưới sau khi bán tab 2");
    await page.reload();
    await page.getByLabel("Tìm sản phẩm").waitFor();
    assert((await tabBadge(page, 1)) === 1, "tải lại trang: tab 1 còn hàng");
    await showCart(page);
    const qtyIn = page.getByLabel("Số lượng Dưa lưới Đài Loan").last();
    assert((await qtyIn.inputValue()) === "2", "tải lại trang: Dưa lưới số lượng 2");
    // dọn: bỏ giỏ tab 1 để các bước sau bắt đầu sạch
    await page.getByRole("button", { name: "Xoá giỏ" }).click();
    if (!big) await page.getByRole("button", { name: /← Thêm hàng/ }).click().catch(() => {});
  };
  await flowTabs(o.page, "1440", true);

  step("[PC 1440] Lưới ảnh + lọc chip nhóm hàng");
  const gridFlow = async (page, tag) => {
    await go(page, "/pos");
    await page.getByLabel("Tìm sản phẩm").waitFor();
    const groups = (await apiGet(o.ctx, "/product-groups")).items;
    const countApi = async (gid) => (await apiGet(o.ctx, `/products?limit=60&active=1${gid ? "&groupId=" + gid : ""}`)).items.length;
    const tiles = () => page.locator(".pos-products .ptile");
    await page.getByRole("tab", { name: "Lưới ảnh" }).click();
    await page.getByTestId("pos-photo-grid").waitFor();
    const all = await tiles().count();
    assert(all === (await countApi(0)), `lưới ảnh: tất cả ${all} ô`);
    assert((await page.locator(".pos-products .pimg").count()) === all, "mỗi ô có khung ảnh (ảnh hoặc chữ cái đầu)");
    const nums = new Set([all]);
    for (const g of groups) {
      await page.getByRole("group", { name: "Nhóm hàng" }).getByRole("button", { name: g.name, exact: true }).click();
      const want = await countApi(g.id);
      await page.waitForFunction((n) => document.querySelectorAll(".pos-products .ptile").length === n, want);
      assert((await tiles().count()) === want, `chip "${g.name}": ${want} ô`);
      nums.add(want);
    }
    assert(nums.size >= 3, "số ô thay đổi theo nhóm");
    await page.getByRole("group", { name: "Nhóm hàng" }).getByRole("button", { name: "Giỏ quà", exact: true }).click();
    await shot(page, `pos-kv-e2e-${tag}-luoi.png`);
    await page.getByRole("group", { name: "Nhóm hàng" }).getByRole("button", { name: "Tất cả", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".pos-products .ptile").length === n, all);
    if (tag === "390") await noOverflow(page, "POS lưới ảnh");
    await page.getByRole("tab", { name: "Danh sách" }).click();
    assert((await page.getByTestId("pos-photo-grid").count()) === 0, "về dạng danh sách");
  };
  await gridFlow(o.page, "1440");

  step("[PC 1440] Máy quét: TẮT thì không thêm; BẬT thì thêm đúng; gõ tay chậm không nhận nhầm; mã lạ báo lỗi");
  await go(o.page, "/pos");
  await o.page.getByLabel("Tìm sản phẩm").waitFor();
  await o.page.getByTestId("pos-tab-add").click();
  await o.page.locator("body").click({ position: { x: 5, y: 5 } });
  assert((await tabBadge(o.page, 2)) === 0, "tab mới trống");
  allow(404, /\/products\/lookup$/, "mã lạ");
  await o.page.keyboard.type(BC_DUA, { delay: 5 });
  await o.page.keyboard.press("Enter");
  await o.page.waitForTimeout(700);
  assert((await tabBadge(o.page, 2)) === 0, "máy quét TẮT: quét mã nhanh + Enter không thêm hàng");
  assert((await o.page.locator(".toast").count()) === 0, "máy quét TẮT: không có toast");
  await o.page.getByTestId("pos-settings").click();
  await o.page.getByTestId("pos-scanner-on").check();
  await shot(o.page, "pos-kv-e2e-1440-cai-dat-quay.png");
  await o.page.keyboard.press("Escape");
  await o.page.locator(".sheet-back").waitFor({ state: "detached" });
  await o.page.locator("body").click({ position: { x: 5, y: 5 } });
  await o.page.keyboard.type(BC_DUA, { delay: 5 });
  await o.page.keyboard.press("Enter");
  await toastOk(o.page, /Đã thêm: Dưa lưới Đài Loan/);
  assert((await tabBadge(o.page, 2)) === 1, "máy quét BẬT: quét mã nhanh thêm đúng 1 dòng");
  await o.page.keyboard.type(BC_DUA, { delay: 5 });
  await o.page.keyboard.press("Enter");
  await o.page.waitForFunction(() => document.querySelector('.pos-cart input[aria-label="Số lượng Dưa lưới Đài Loan"]')?.value === "2");
  ok("quét lần 2 → cộng dồn số lượng 2");
  // quét khi ô tìm đang focus: mã không nằm lại trong ô
  await o.page.getByLabel("Tìm sản phẩm").focus();
  await o.page.keyboard.type(BC_LE_THUNG, { delay: 5 });
  await o.page.keyboard.press("Enter");
  await o.page.waitForFunction(() => /Lê Hàn Quốc/.test(document.querySelector(".pos-cart")?.textContent ?? ""));
  assert((await o.page.getByLabel("Tìm sản phẩm").inputValue()) === "", "quét khi ô tìm đang focus: ô tìm không dính mã");
  const leLine = o.page.locator(".cartline", { hasText: "Lê Hàn Quốc" });
  assert((await leLine.locator('select[aria-label="Đơn vị"]').inputValue()) === "thung", "mã vạch đơn vị quy đổi → thêm đúng đơn vị thùng");
  assert((await leLine.getByLabel("Số lượng Lê Hàn Quốc").last().inputValue()) === "1", "Lê thùng số lượng 1");
  const before = await o.page.locator(".cartline").count();
  await o.page.locator("body").click({ position: { x: 5, y: 5 } });
  await o.page.keyboard.type(BC_DUA, { delay: 120 }); // gõ tay chậm
  await o.page.keyboard.press("Enter");
  await o.page.waitForTimeout(700);
  assert((await o.page.getByLabel("Số lượng Dưa lưới Đài Loan").last().inputValue()) === "2" && (await o.page.locator(".cartline").count()) === before, "gõ tay chậm (120ms/phím) + Enter không bị nhận nhầm là quét");
  await o.page.keyboard.type(BC_UNKNOWN, { delay: 5 });
  await o.page.keyboard.press("Enter");
  await toastOk(o.page, new RegExp(`Không có hàng với mã ${BC_UNKNOWN}`));
  assert(allowed.find((a) => /lookup/.test(a.re.source)).used === 1, "mã lạ: máy chủ trả 404 và UI hiện toast lỗi");
  await shot(o.page, "pos-kv-e2e-1440-quet-ma.png");

  step("[PC 1440] Chọn Người bán khác người đăng nhập khi bán");
  // tab 2 đang có Dưa ×2 + Lê thùng
  const sel = o.page.getByTestId("pos-seller");
  await sel.waitFor();
  assert((await sel.locator("option").allInnerTexts()).some((t) => t.includes(SELLER_NAME)), "ô Người bán liệt kê người bán mới");
  await sel.selectOption({ label: SELLER_NAME });
  await shot(o.page, "pos-kv-e2e-1440-nguoi-ban.png");
  const sellCode = await payCash(o.page);
  const sellOrd = await findOrder(o.ctx, sellCode);
  assert(sellOrd.sellerName === SELLER_NAME && sellOrd.sellerId === sellerUser.id, `đơn ${sellCode}: người bán = "${SELLER_NAME}"`);
  assert(sellOrd.cashierName === "Chủ cửa hàng" || sellOrd.createdBy !== sellerUser.id, "thu ngân vẫn là người đăng nhập");
  const filtered = (await apiGet(o.ctx, `/orders?limit=100&sellerId=${sellerUser.id}`)).items;
  assert(filtered.some((x) => x.code === sellCode), "lọc sellerId trả về đơn này");

  // ----- tạo đơn mẫu qua API để thử Sao chép + sửa hàng loạt
  step("Chuẩn bị đơn mẫu (API): Lê 2 thùng + Táo 1,25 kg + Dưa 3 trái; thêm 2 đơn để sửa hàng loạt");
  const shiftRes = await apiGet(o.ctx, "/shifts/current");
  const shiftId = (shiftRes.shift ?? shiftRes).id;
  const mk = (lines, note) => apiPost(o.ctx, "/pos/orders", { clientUuid: `e2e-${RUN}-${Math.random().toString(36).slice(2, 10)}`, shiftId, lines, payments: [{ method: "cash", amount: 20000000 }], ...(note ? { note } : {}) });
  const orderA = await mk([{ productId: 5, unit: "thung", qty: 2 }, { productId: 1, unit: "kg", qty: 1.25 }, { productId: 10, unit: "trai", qty: 3 }], `Mẫu sao chép ${RUN}`);
  const orderC = await mk([{ productId: 12, unit: "trai", qty: 1 }], null);
  const orderD = await mk([{ productId: 9, unit: "trai", qty: 2 }], null);
  const fullA = await apiGet(o.ctx, "/orders/" + orderA.id);
  const byProd = (id) => fullA.lines.find((l) => l.productId === id);
  assert(byProd(5).qtyMilli === 20000 && byProd(1).qtyMilli === 1250, `đơn gốc: qtyMilli Lê=${byProd(5).qtyMilli} (2 thùng × 10 kg), Táo=${byProd(1).qtyMilli}`);

  const copyFlow = async (page, tag) => {
    step(`[${tag}] Đơn hàng → Sao chép: tab mới ở POS đúng hàng, đơn vị, số lượng`);
    await go(page, `/orders?open=${orderA.id}`);
    await page.getByRole("button", { name: "Sao chép", exact: true }).waitFor();
    if (tag === "390") await noOverflow(page, "Đơn hàng (mở chi tiết)");
    await shot(page, `pos-kv-e2e-${tag}-don-hang.png`);
    const tabsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("hm_pos_tabs") ?? "{\"tabs\":[]}").tabs.length);
    await page.getByRole("button", { name: "Sao chép", exact: true }).click();
    await page.waitForURL(/\/pos/);
    await page.locator(".cartline").first().waitFor();
    await toastOk(page, /Đã sao chép hoá đơn/);
    assert((await tabCount(page)) === tabsBefore + 1, "sao chép mở thêm 1 tab mới");
    assert((await page.locator(".cartline").count()) === 3, "tab mới có 3 dòng");
    const le = page.locator(".cartline", { hasText: "Lê Hàn Quốc" }), tao = page.locator(".cartline", { hasText: "Táo Envy" }), dua = page.locator(".cartline", { hasText: "Dưa lưới" });
    assert((await le.locator('select[aria-label="Đơn vị"]').inputValue()) === "thung" && (await le.getByLabel("Số lượng Lê Hàn Quốc").last().inputValue()) === "2", "Lê: 2 thùng (đúng đơn vị quy đổi và SỐ LƯỢNG = 2, không phải 20)");
    assert((await tao.locator('select[aria-label="Đơn vị"]').inputValue()) === "kg" && (await tao.getByLabel("Số lượng Táo Envy").last().inputValue()) === "1,25", "Táo: 1,25 kg (bán theo cân)");
    assert((await dua.getByLabel("Số lượng Dưa lưới Đài Loan").last().inputValue()) === "3", "Dưa lưới: 3 trái");
    assert(digits(await page.locator(".grand").innerText()) === fullA.total, `tổng giỏ sao chép = tổng đơn gốc (${fullA.total})`);
    await shot(page, `pos-kv-e2e-${tag}-sao-chep.png`);
    if (tag === "390") await noOverflow(page, "POS giỏ sau sao chép");
  };
  await copyFlow(o.page, "1440");

  step("[PC 1440] Đơn hàng → Chọn nhiều → Sửa người bán / ghi chú cho 2 đơn");
  const bulkFlow = async (page, tag, pickSeller, noteText) => {
    await go(page, "/orders");
    await page.getByRole("button", { name: "Chọn nhiều" }).click();
    await page.locator(`input[aria-label="Chọn đơn ${orderC.code}"]:visible`).check();
    await page.locator(`input[aria-label="Chọn đơn ${orderD.code}"]:visible`).check();
    await page.getByRole("region", { name: "Chọn nhiều đơn" }).getByText("2", { exact: true }).waitFor();
    if (tag === "390") await noOverflow(page, "Đơn hàng (chọn nhiều)");
    await shot(page, `pos-kv-e2e-${tag}-chon-nhieu.png`);
    await page.getByRole("button", { name: "Sửa người bán / ghi chú" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Người bán").selectOption({ label: pickSeller });
    await dlg.getByLabel(/^Ghi chú/).fill(noteText);
    await shot(page, `pos-kv-e2e-${tag}-sua-hang-loat.png`);
    await dlg.getByRole("button", { name: "Áp dụng cho 2 đơn" }).click();
    await toastOk(page, /Đã cập nhật 2 đơn/);
    // danh sách trả sellerName = người bán (nếu trùng thu ngân thì chính thu ngân); chi tiết đơn trả note
    const rows = (await apiGet(o.ctx, "/orders?limit=100")).items;
    for (const c of [orderC, orderD]) {
      const r = rows.find((x) => x.code === c.code), full = await apiGet(o.ctx, "/orders/" + c.id);
      assert(r.sellerName === pickSeller && full.note === noteText, `đơn ${c.code}: người bán "${r.sellerName}", ghi chú "${full.note}"`);
    }
    const other = await apiGet(o.ctx, "/orders/" + orderA.id);
    assert(other.note === `Mẫu sao chép ${RUN}`, "đơn không chọn không bị đổi ghi chú");
    assert((await page.getByRole("region", { name: "Chọn nhiều đơn" }).count()) === 0, "thoát chế độ chọn nhiều sau khi áp dụng");
  };
  await bulkFlow(o.page, "1440", SELLER_NAME, `Ghi chú hàng loạt ${RUN}`);
  await shot(o.page, "pos-kv-e2e-1440-don-hang-sau-sua.png");

  // ============================================================ ĐT 390
  step("[ĐT 390] Đăng nhập chủ, 2 tab + bán + tải lại");
  const m = await newPage(mobile, "mobile");
  await login(m.page, OWNER.u, OWNER.p);
  await flowTabs(m.page, "390", false);
  await noOverflow(m.page, "POS (giỏ)");
  await m.page.getByRole("button", { name: /← Thêm hàng/ }).click().catch(() => {});
  await noOverflow(m.page, "POS (danh sách hàng)");

  step("[ĐT 390] Lưới ảnh + lọc nhóm, không tràn ngang");
  await gridFlow(m.page, "390");

  step("[ĐT 390] Máy quét đã bật theo thiết bị này? (cài đặt lưu theo thiết bị) — bật rồi quét");
  await go(m.page, "/pos");
  await m.page.getByLabel("Tìm sản phẩm").waitFor();
  await m.page.getByTestId("pos-tab-add").click();
  await m.page.getByTestId("pos-settings").click();
  await m.page.getByTestId("pos-scanner-on").check();
  await noOverflow(m.page, "Cài đặt quầy");
  await m.page.keyboard.press("Escape");
  await m.page.locator(".sheet-back").waitFor({ state: "detached" });
  await m.page.locator("body").click({ position: { x: 5, y: 5 } });
  await m.page.keyboard.type(BC_DUA, { delay: 5 });
  await m.page.keyboard.press("Enter");
  await toastOk(m.page, /Đã thêm: Dưa lưới Đài Loan/);
  ok("390: quét mã nhanh thêm đúng hàng");
  await showCart(m.page);
  await shot(m.page, "pos-kv-e2e-390-quet-ma.png");
  await noOverflow(m.page, "POS giỏ có hàng + Người bán");
  assert(await m.page.getByTestId("pos-seller").isVisible(), "390: ô Người bán hiện trong giỏ");
  await m.page.getByRole("button", { name: "Xoá giỏ" }).click();

  await copyFlow(m.page, "390");
  await bulkFlow(m.page, "390", sellers.find((s) => s.name !== SELLER_NAME).name, `Ghi chú ĐT ${RUN}`);
  await go(m.page, "/orders");
  await noOverflow(m.page, "Đơn hàng (danh sách)");
  await shot(m.page, "pos-kv-e2e-390-don-hang-ds.png");
} catch (e) {
  if (!/^assert:/.test(e.message)) fail("EXCEPTION: " + (e.stack ?? e.message));
}

await browser.close();
for (const a of allowed) if (a.used === 0) fail(`phản hồi ${a.status} chủ đích (${a.why}) không xảy ra`);
console.log("\n" + (failures.length ? `THẤT BẠI: ${failures.length} lỗi\n` + failures.map((f) => " - " + f).join("\n") : "TẤT CẢ ĐẠT (bộ pos-kv)"));
process.exit(failures.length ? 1 : 0);
