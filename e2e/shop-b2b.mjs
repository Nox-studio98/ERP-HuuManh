// E2E cổng khách sỉ trên website: tạo khách sỉ (ERP) → đăng ký tài khoản shop → yêu cầu liên kết → chủ duyệt/liên kết (ERP)
// → shop hiện giá sỉ → đặt nhanh → đơn xuất hiện ở ERP /b2b/orders → vượt hạn mức hiện thông báo credit_blocked.
// Chạy (DB mới): xem docs/SECOPS.md mục e2e; ERP :8794 và shop :8795 đều phục vụ bản BUILD (npm run build && npm run build:shop).
//   SHOP=http://localhost:8795 ERP=http://localhost:8794 node e2e/shop-b2b.mjs
// Biến môi trường: SHOP, ERP, OWNER_USER / OWNER_PASS.
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const SHOP = process.env.SHOP ?? "http://localhost:8795";
const ERP = process.env.ERP ?? "http://localhost:8794";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };

const RUN = Date.now().toString(36).slice(-5);
const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }
const digits = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10);

// 4xx/5xx được CHỦ ĐÍCH mong đợi (mỗi lần khai báo cho phép đúng một phản hồi)
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

let erpToken = "";
async function erp(method, path, body) {
  const r = await fetch(ERP + "/api/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + erpToken, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`ERP ${method} ${path} → ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

const browser = await chromium.launch();
let exitCode = 0;
let page;
try {
  step("Dựng dữ liệu qua ERP: tồn kho, giá sỉ, khách sỉ (địa chỉ + người nhận, hạn mức thấp)");
  const lr = await fetch(ERP + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "hm-erp" }, body: JSON.stringify({ username: OWNER.u, password: OWNER.p }) });
  if (!lr.ok) throw new Error("Không đăng nhập được ERP: " + lr.status);
  erpToken = (await lr.json()).token;

  const exp = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const doc = await erp("POST", "/stock-docs", { type: "receipt", locationId: 1, supplierId: 1 });
  for (const pid of [6, 1]) await erp("POST", `/stock-docs/${doc.id}/lines`, { productId: pid, unit: "kg", qty: 80, unitCost: 40000, expiresAt: exp });
  await erp("POST", `/stock-docs/${doc.id}/post`, {});
  const SI_PRICE = { 6: 91000 + (Date.now() % 7) * 1000, 1: 120000 }; // giá sỉ cấp 1 (bảng giá 3), khác hẳn giá online
  await erp("POST", "/prices/bulk", { priceListId: 3, items: Object.entries(SI_PRICE).map(([productId, unitPrice]) => ({ productId: Number(productId), unitPrice })), note: "e2e shop-b2b giá sỉ" });
  ok(`nhập kho + đặt giá sỉ cam=${SI_PRICE[6]} táo=${SI_PRICE[1]}`);

  const cust = await erp("POST", "/customers", {
    name: `Quán Cà Phê E2E ${RUN}`, type: "b2b", taxCode: "03" + String(Date.now()).slice(-8), phone: "0281234567",
    customerGroupId: 3, creditLimit: 2_000_000, paymentTermsDays: 7,
    contacts: [{ name: "Chị Lan (người nhận)", phone: "0908111222", isReceiver: true }],
    addresses: [{ label: "Quán chính", address: "15 Nguyễn Huệ, Quận 1, TP.HCM", isDefault: true }],
  });
  const custId = cust.id;
  assert(custId > 0, `đã tạo khách sỉ #${custId} (hạn mức 2.000.000đ)`);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
  page = await ctx.newPage();
  page.setDefaultTimeout(9000);
  watch(page, "khách-sỉ");

  step("Đăng ký tài khoản shop → đăng nhập");
  const email = `b2b.e2e.${RUN}@example.com`;
  const PW = "MatKhau-Si-2026";
  await page.goto(SHOP + "/dang-ky");
  await page.getByLabel("Họ và tên").fill("Nguyễn Thị Lan");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Số điện thoại").fill("0908" + String(Math.floor(100000 + Math.random() * 899999)));
  await page.getByLabel("Mật khẩu", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Đăng ký" }).click();
  await page.getByText("Kiểm tra email của bạn").waitFor();
  await page.getByRole("link", { name: "Đăng nhập" }).first().click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu").fill(PW);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByRole("heading", { name: /Xin chào, Nguyễn Thị Lan/ }).waitFor();
  ok("đã đăng nhập tài khoản bán lẻ");

  step("Gửi yêu cầu liên kết khách sỉ (trang /si)");
  await page.goto(SHOP + "/si");
  await page.getByRole("heading", { name: "Đăng ký tài khoản mua sỉ" }).waitFor();
  await page.getByLabel("Tên công ty / cửa hàng").fill(`Quán Cà Phê E2E ${RUN}`);
  await page.getByLabel("Mã số thuế").fill("0312345678");
  await page.getByRole("button", { name: "Gửi yêu cầu" }).click();
  await page.getByText("đang chờ cửa hàng duyệt").waitFor();
  ok("yêu cầu ở trạng thái chờ duyệt");

  step("Chủ cửa hàng liên kết tài khoản với khách sỉ trong ERP (/shop-accounts/:id/b2b-link)");
  const acc = (await erp("GET", `/shop-accounts?q=${encodeURIComponent(email)}`)).items.find((a) => a.email === email);
  assert(acc && acc.b2bStatus === "pending", "ERP thấy yêu cầu liên kết đang chờ");
  const lk = await erp("POST", `/shop-accounts/${acc.id}/b2b-link`, { customerId: custId });
  assert(lk.kind === "b2b" && lk.b2bStatus === "approved", "liên kết thành công (kind=b2b, approved)");

  step("Shop hiện bảng đặt nhanh với giá sỉ + công nợ");
  await page.goto(SHOP + "/si");
  await page.locator("table.qo").waitFor();
  const row = (name) => page.locator("table.qo tbody tr", { hasText: name }).first();
  const camPrice = digits(await row("Cam Mỹ").locator("td").first().innerText());
  assert(camPrice === SI_PRICE[6], `giá sỉ hiển thị ${camPrice} = bảng giá sỉ ${SI_PRICE[6]}`);
  const online = (await (await fetch(SHOP + "/api/products/cam-my")).json()).price;
  assert(online !== camPrice, `giá sỉ (${camPrice}) khác giá online (${online})`);
  const cred = await page.locator("[data-testid=credit]").innerText();
  assert(/2\.000\.000/.test(cred), "hiện hạn mức công nợ 2.000.000đ");

  step("Đặt nhanh 2 kg cam → đơn sỉ tạo thành công");
  await page.getByLabel(/^Số lượng Cam Mỹ/).fill("2");
  await page.getByRole("button", { name: "Đặt hàng sỉ" }).click();
  const okBox = page.getByText(/Đã tạo đơn/).first();
  await okBox.waitFor();
  const code = (await okBox.innerText()).match(/[A-Z]{2,4}-\d{8}-\d{4}/)?.[0];
  assert(!!code, `đơn sỉ ${code}`);

  step("Đơn xuất hiện ở ERP /b2b/orders");
  const list = (await erp("GET", `/b2b/orders?customerId=${custId}`)).items;
  const mine = list.find((o) => o.code === code);
  assert(mine, `ERP có đơn ${code} của khách #${custId}`);
  assert(mine.total === 2 * SI_PRICE[6], `tổng đơn ${mine.total} = 2 × giá sỉ`);

  step("Vượt hạn mức → hiển thị credit_blocked");
  allow(409, /\/api\/b2b\/orders$/, "vượt hạn mức công nợ → 409 credit_blocked (chủ đích)");
  await page.getByLabel(/^Số lượng Táo Envy/).fill("30"); // 30 × 120.000 = 3.600.000 > 2.000.000
  await page.getByRole("button", { name: "Đặt hàng sỉ" }).click();
  await page.getByText(/Đơn bị chặn do công nợ/).waitFor();
  ok("thông báo 'Đơn bị chặn do công nợ' hiển thị");
  const others = (await erp("GET", `/b2b/orders?customerId=${custId}`)).items.filter((o) => o.id !== mine.id && o.status !== "cancelled");
  assert(others.every((o) => o.status === "new"), "đơn vượt hạn mức không được xác nhận (còn 'new' chờ duyệt vượt hạn mức)");

  await page.close();
} catch (e) {
  exitCode = 1;
  console.error("\nLỖI:", e.message);
  if (page) await page.screenshot({ path: "/tmp/shop-b2b-fail.png" }).catch(() => {});
} finally {
  await browser.close();
}
const unused = allowed.filter((a) => a.used === 0);
for (const a of unused) fail(`phản hồi mong đợi không xuất hiện: ${a.status} ${a.re} (${a.why})`);
if (failures.length || exitCode) {
  console.error(`\n✗ ${failures.length} lỗi:\n  - ` + failures.join("\n  - "));
  process.exit(1);
}
console.log("\n✓ E2E shop B2B đạt");
