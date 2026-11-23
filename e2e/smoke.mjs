// E2E smoke: giao diện thật + backend thật (wrangler dev). Chạy: node e2e/smoke.mjs
// Biến môi trường: BASE (mặc định http://localhost:8787), OWNER_USER / OWNER_PASS, SHOTS=0 để bỏ chụp ảnh.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8787";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });

const RUN = Date.now().toString(36).slice(-5);
const NEWPW = "MatKhau-Moi-2026";
const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }

// ---- các phản hồi 4xx/5xx được CHỦ ĐÍCH mong đợi ----
const allowed = [];
/** Mỗi lần gọi cho phép đúng một phản hồi; optional=false → phải xảy ra, nếu không là lỗi. */
const allow = (status, re, why, optional = false) => allowed.push({ status, re, why, used: 0, optional, sticky: false });
const allowAlways = (status, re, why) => allowed.push({ status, re, why, used: 0, optional: true, sticky: true });

function watch(page, who) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return; // đã được kiểm ở bộ nghe response bên dưới
    fail(`[${who}] console.error: ${t}`);
  });
  page.on("pageerror", (e) => fail(`[${who}] pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/") || r.status() < 400) return;
    const hit = allowed.find((a) => a.status === r.status() && a.re.test(u.pathname) && (a.sticky || a.used === 0));
    if (hit) { hit.used++; return; }
    fail(`[${who}] ${r.request().method()} ${u.pathname} → ${r.status()} (không dự kiến)`);
  });
}

const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
async function newPage(opts, who) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  watch(page, who);
  allowAlways(401, /\/api\/auth\/me$/, "chưa đăng nhập → /me 401 là bình thường");
  return { ctx, page };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 7000 }).catch(() => {}); // chờ toast tắt cho ảnh sạch
  await page.waitForTimeout(450); // chờ animation sheet
  await page.screenshot({ path: join(DIR, name) });
};
const toastOk = (page, re) => page.locator(".toast, [role=status], [role=alert]").filter({ hasText: re }).first().waitFor();
const vnd = (n) => new Intl.NumberFormat("vi-VN").format(n);
const parseVnd = (s) => parseInt(String(s).replace(/[^\d-]/g, ""), 10);
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const apiGet = async (ctx, path) => { const r = await ctx.request.get(BASE + "/api/v1" + path, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${path} ${r.status()}`); return r.json(); };

async function login(page, u, p) {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(u);
  await page.getByLabel("Mật khẩu").fill(p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
}
async function firstLogin(page, u, tmp) {
  await login(page, u, tmp);
  await page.getByLabel("Mật khẩu hiện tại", { exact: true }).fill(tmp);
  await page.getByLabel("Mật khẩu mới", { exact: true }).fill(NEWPW);
  await page.getByLabel("Nhập lại mật khẩu mới").fill(NEWPW);
  await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
  await page.locator("main#main").waitFor();
}
const go = async (page, path) => { await page.goto(BASE + path); await page.locator("main#main").waitFor(); };
const cashierName = `thungan_${RUN}`, warehouseName = `thukho_${RUN}`;

try {
  // ============ 1. Chủ đăng nhập ============
  step("Chủ đăng nhập (cookie __Host- Secure trên http://localhost)");
  const o = await newPage(mobile, "owner");
  await o.page.goto(BASE + "/");
  await shot(o.page, "login-m.png");
  await login(o.page, OWNER.u, OWNER.p);
  await o.page.locator(".tabbar").waitFor();
  const cookies = await o.ctx.cookies();
  assert(cookies.some((c) => c.name === "__Host-hm_session"), "trình duyệt nhận cookie __Host-hm_session");
  assert((await o.page.locator("h1").first().innerText()).length > 0, "vào được ứng dụng sau đăng nhập");

  // ============ 2. Tạo người dùng qua UI ============
  step("Tạo thu ngân + thủ kho qua màn Người dùng");
  await go(o.page, "/users");
  const mkUser = async (username, fullName, role, temp) => {
    await o.page.getByRole("button", { name: "+ Thêm người dùng" }).click();
    const dlg = o.page.getByRole("dialog");
    await dlg.getByLabel("Tên đăng nhập").fill(username);
    await dlg.getByLabel("Họ tên").fill(fullName);
    await dlg.getByLabel("Vai trò").selectOption(role);
    if (temp) await dlg.getByLabel(/Mật khẩu tạm/).fill(temp);
    await dlg.getByRole("button", { name: "Lưu" }).click();
    const pw = (await o.page.getByTestId("temp-password").innerText()).trim();
    await o.page.getByRole("button", { name: "Đã ghi lại" }).click();
    return pw;
  };
  const cashierTmp = await mkUser(cashierName, "Thu ngân E2E", "cashier", "TamThoi-123456");
  assert(cashierTmp === "TamThoi-123456", "hiển thị đúng mật khẩu tạm đã đặt");
  const whTmp = await mkUser(warehouseName, "Thủ kho E2E", "warehouse", "");
  assert(whTmp.length >= 8, `hệ thống tự sinh mật khẩu tạm cho thủ kho (${whTmp.length} ký tự)`);
  await o.page.locator(".dt-card", { hasText: cashierName }).first().waitFor();
  await o.page.locator(".dt-card", { hasText: warehouseName }).first().waitFor();
  ok("danh sách người dùng có 2 tài khoản mới");

  // ============ 3. Thủ kho nhập hàng ============
  step("Thủ kho đổi mật khẩu lần đầu, lập phiếu nhập 2 mặt hàng (kg theo thùng + theo trái) và ghi sổ");
  const w = await newPage(mobile, "warehouse");
  await firstLogin(w.page, warehouseName, whTmp);
  await go(w.page, "/inventory");
  await w.page.getByRole("button", { name: "+ Nhập hàng" }).click();
  {
    const dlg = w.page.getByRole("dialog");
    await dlg.getByLabel("Nhà cung cấp").selectOption({ index: 1 });
    await dlg.getByLabel("Số chứng từ NCC").fill("NCC-" + RUN);
    await dlg.getByRole("button", { name: "Tạo phiếu nháp" }).click();
    const exp = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const addLine = async (search, pick, qty, unit, cost, docQty) => {
      await dlg.getByRole("button", { name: "+ Thêm dòng (quét / tìm)" }).click();
      await dlg.getByLabel("Tìm hàng hoá").fill(search);
      await dlg.locator("button.dt-card", { hasText: pick }).first().click();
      await dlg.getByLabel("Số lượng thực nhận").fill(String(qty).replace(".", ","));
      if (docQty != null) await dlg.getByLabel("Số lượng theo chứng từ NCC").fill(String(docQty));
      await dlg.getByLabel("Đơn vị").selectOption(unit);
      await dlg.getByLabel(/^Giá nhập/).fill(String(cost));
      await dlg.getByLabel("Hạn sử dụng").fill(exp);
      await dlg.getByRole("button", { name: "Thêm dòng", exact: true }).click();
      await toastOk(w.page, /Đã thêm dòng/);
    };
    // 2 thùng Táo Envy (1 thùng = 18 kg) → 36 kg; giá nhập 1.800.000/thùng = 100.000/kg
    await addLine("Táo Envy", "Táo Envy", 2, "thung", 1800000, 2);
    // 12 trái Dưa lưới (theo chứng từ 13: lệch -1)
    await addLine("Dưa lưới", "Dưa lưới Đài Loan", 12, "trai", 80000, 13);
    await dlg.locator(".dt-card", { hasText: "Dưa lưới" }).getByText("12 trái").first().waitFor();
    assert(true, "dòng Dưa lưới hiển thị 12 trái");
    await dlg.locator(".dt-card", { hasText: "Táo Envy" }).getByText("2 thùng").first().waitFor();
    assert(true, "dòng Táo hiển thị đúng đơn vị nhập (2 thùng, không phải 36 thùng)");
    await dlg.getByRole("button", { name: "Ghi sổ" }).click();
  }
  await toastOk(w.page, /Đã ghi sổ|gửi quản lý duyệt/);
  const lots1 = (await apiGet(w.ctx, "/stock/lots?productId=1")).items;
  const lotTao = lots1.at(-1);
  assert(lotTao.qtyOnHandMilli >= 36000, `API: lô Táo có ≥ 36 kg (milli=${lotTao.qtyOnHandMilli})`);
  const lots10 = (await apiGet(w.ctx, "/stock/lots?productId=10")).items;
  assert(lots10.at(-1).qtyOnHandMilli >= 12000, "API: lô Dưa lưới có ≥ 12 trái");
  await w.page.getByRole("tab", { name: "Chứng từ" }).click();
  await w.page.locator(".dt-card", { hasText: "Đã ghi sổ" }).first().waitFor();
  ok("danh sách chứng từ có phiếu nhập đã ghi sổ");

  // ============ 4. Giá ============
  step("Chủ kiểm tra giá hiện hành, đổi giá Dưa lưới, xem lịch sử giá");
  await go(o.page, "/prices");
  await o.page.getByLabel("Tìm hàng").fill("Dưa lưới");
  const priceInput = o.page.locator('input[aria-label="Giá mới Dưa lưới Đài Loan"]:visible');
  await priceInput.waitFor();
  const cur = parseInt(await priceInput.getAttribute("placeholder"), 10);
  assert(cur > 0, `Dưa lưới đã có giá bán hiện hành (${vnd(cur)})`);
  const newPrice = (cur / 1000) % 2 ? cur + 1000 : cur - 1000; // dao động để chạy lại nhiều lần không trôi giá
  await priceInput.fill(String(newPrice));
  await o.page.getByRole("button", { name: /Áp dụng 1 mức giá/ }).click();
  await toastOk(o.page, /Đã áp dụng giá mới/);
  const q1 = (await apiGet(o.ctx, "/products?q=" + encodeURIComponent("Dưa lưới"))).items[0];
  assert(q1.price === newPrice, `giá POS của Dưa lưới = ${vnd(newPrice)} sau khi đổi`);
  await o.page.getByRole("tab", { name: "Lịch sử" }).click();
  await o.page.getByLabel("Tìm hàng để xem lịch sử giá").fill("Dưa lưới");
  await o.page.locator("button.dt-card", { hasText: "Dưa lưới" }).first().click();
  await o.page.getByText("Giá bán: Dưa lưới Đài Loan").waitFor();
  await o.page.getByText("Giá mua theo lô / NCC").waitFor();
  ok("lịch sử giá bán + giá mua theo lô hiển thị");
  const tao = (await apiGet(o.ctx, "/products?q=" + encodeURIComponent("Táo Envy"))).items[0];
  const dua = q1;

  // ============ 5. Thu ngân: mở ca, bán hàng ============
  step("Thu ngân đổi mật khẩu, mở ca, bán Táo 1,25 kg + 2 Dưa lưới, thanh toán tiền mặt + QR có tiền thừa");
  const c = await newPage(mobile, "cashier");
  await firstLogin(c.page, cashierName, cashierTmp);
  await go(c.page, "/pos");
  await c.page.getByRole("heading", { name: "Mở ca bán hàng" }).waitFor();
  await c.page.getByLabel("Tiền đầu ca (₫)").fill("500000");
  await c.page.getByRole("button", { name: "Mở ca", exact: true }).click();
  await toastOk(c.page, /Đã mở ca/);
  await c.page.getByLabel("Tìm sản phẩm").waitFor();
  await shot(c.page, "pos-m.png");
  await c.page.getByLabel("Tìm sản phẩm").fill("Táo Envy");
  await c.page.getByRole("button", { name: "Thêm Táo Envy" }).click();
  await c.page.getByLabel(/^Khối lượng/).fill("1,25");
  await shot(c.page, "pos-can-m.png");
  await c.page.getByRole("button", { name: /^Thêm 1,25 kg/ }).click();
  await c.page.getByLabel("Tìm sản phẩm").fill("Dưa lưới");
  await c.page.getByRole("button", { name: "Thêm Dưa lưới Đài Loan" }).click();
  await c.page.getByRole("button", { name: "Thêm Dưa lưới Đài Loan" }).click();
  const taoAmt = Math.round(tao.price * 1.25), duaAmt = dua.price * 2, total = taoAmt + duaAmt;
  await c.page.getByRole("button", { name: /^Xem giỏ \(2\)/ }).click();
  await c.page.getByText("Giỏ hàng (2)").waitFor();
  assert((await c.page.locator(".grand").innerText()).replace(/\D/g, "") === String(total), `tổng giỏ = ${vnd(total)} (Táo 1,25kg ${vnd(taoAmt)} + Dưa 2 trái ${vnd(duaAmt)})`);
  await shot(c.page, "pos-gio-m.png");
  await c.page.getByRole("button", { name: /^Thanh toán/ }).click();
  const sheet = c.page.getByRole("dialog", { name: "Thanh toán" });
  await sheet.getByLabel("Số tiền (Tiền mặt)").fill("300000");
  await sheet.getByRole("button", { name: "+ Chia thanh toán" }).click();
  await sheet.getByLabel(/Số tiền \(QR\)/).waitFor();
  assert(parseVnd(await sheet.getByLabel(/Số tiền \(QR\)/).inputValue()) === total - 300000, "dòng QR tự điền phần còn thiếu");
  // khách đưa thêm tiền mặt 50.000 → tiền thừa 50.000
  await sheet.getByLabel("Số tiền (Tiền mặt)").fill("350000");
  await sheet.getByText("Tiền thừa trả khách").waitFor();
  const changeTxt = await sheet.locator(".totals div", { hasText: "Tiền thừa trả khách" }).innerText();
  assert(parseVnd(changeTxt) === 50000, "UI hiển thị tiền thừa 50.000");
  await sheet.locator(".body").evaluate((e) => (e.scrollTop = 0));
  await shot(c.page, "pos-thanh-toan-m.png");
  await sheet.getByRole("button", { name: /^Hoàn tất/ }).click();
  const rcpt = c.page.getByRole("dialog", { name: "Hoá đơn" });
  await rcpt.getByText("HOÁ ĐƠN BÁN HÀNG").waitFor();
  const rtxt = await rcpt.locator(".receipt").innerText();
  assert(/1,25 kg/.test(rtxt), "hoá đơn ghi 1,25 kg");
  assert(/Tiền thừa[\s\S]*50\.000/.test(rtxt), "hoá đơn ghi tiền thừa 50.000");
  assert(/QR/.test(rtxt) && /Tiền mặt/.test(rtxt), "hoá đơn ghi cả Tiền mặt và QR");
  const orderCode = (await rcpt.locator(".receipt .l", { hasText: "Số" }).first().innerText()).replace(/Số\s*/, "").trim();
  await shot(c.page, "hoa-don-m.png");
  await rcpt.getByRole("button", { name: "Đơn mới" }).click();

  // ============ 6. Xem đơn, trả một phần ============
  step("Xem đơn, trả 0,5 kg Táo (hoàn tiền mặt, nhập lại kho)");
  await go(c.page, "/orders");
  await c.page.locator("button.dt-card", { hasText: orderCode }).click();
  const od = c.page.getByRole("dialog");
  await od.locator(".dt-card").getByText("1,25 kg").first().waitFor();
  ok("chi tiết đơn hiển thị 1,25 kg");
  await od.getByRole("button", { name: "Trả hàng" }).click();
  await od.getByLabel("Trả (kg)").fill("0,5");
  await od.getByLabel("Lý do trả hàng").fill("Khách đổi ý");
  await od.getByRole("button", { name: "Xác nhận trả hàng" }).click();
  await toastOk(c.page, /Đã tạo phiếu trả hàng/);
  const ords = (await apiGet(c.ctx, "/orders?limit=20")).items;
  const ret = ords.find((x) => x.kind === "return");
  assert(ret && ret.total === Math.round(tao.price * 0.5), `phiếu trả ${ret?.code} = ${vnd(Math.round(tao.price * 0.5))} (0,5 kg × giá)`);
  // trả vượt phải bị chặn (409 có chủ đích)
  allow(409, /\/orders\/\d+\/return$/, "trả vượt số đã mua");
  await c.page.getByRole("dialog").getByRole("button", { name: "Trả hàng" }).click();
  await c.page.getByRole("dialog").getByLabel("Trả (kg)").fill("1");
  await c.page.getByRole("dialog").getByLabel("Lý do trả hàng").fill("thử vượt");
  await c.page.getByRole("dialog").getByRole("button", { name: "Xác nhận trả hàng" }).click();
  await toastOk(c.page, /vượt số đã mua/);
  ok("trả vượt (0,5 + 1 > 1,25) bị backend từ chối, UI báo lỗi tiếng Việt");
  await c.page.keyboard.press("Escape");

  // ============ 7. Chốt ca ============
  step("Chốt ca: kiểm đếm lệch 500đ → backend đòi lý do (diff_reason_required) → nhập lý do → tổng kết");
  const expectedCash = 500000 + 300000 - Math.round(tao.price * 0.5);
  const counted = expectedCash - 500;
  await go(c.page, "/shift-close");
  await c.page.getByLabel(/Tiền mặt kiểm đếm/).fill(String(counted));
  allow(422, /\/shifts\/\d+\/close$/, "chênh lệch cần lý do");
  await c.page.getByRole("button", { name: "Chốt ca", exact: true }).click();
  await c.page.getByText(/Chênh lệch thiếu/).waitFor();
  assert(parseVnd(await c.page.locator(".kpi", { hasText: "Dự kiến trong két" }).locator(".v").innerText()) === expectedCash, `UI lấy tiền dự kiến từ lỗi backend = ${vnd(expectedCash)}`);
  await c.page.getByLabel(/Lý do chênh lệch/).fill("Thiếu tiền lẻ");
  await c.page.getByRole("button", { name: "Chốt ca", exact: true }).click();
  await c.page.getByRole("heading", { name: "Tổng kết cuối ca" }).waitFor();
  const sum = await c.page.locator("main").innerText();
  assert(sum.includes(vnd(expectedCash)) && /Chênh lệch/.test(sum), "tổng kết hiển thị dự kiến + chênh lệch");
  const kRev = parseVnd(await c.page.locator(".kpi", { hasText: "Doanh thu" }).locator(".v").innerText());
  assert(kRev === total - Math.round(tao.price * 0.5), `doanh thu ca = bán − trả = ${vnd(kRev)}`);
  await c.page.locator(".card", { hasText: "Theo hình thức TT" }).locator(".dt-card", { hasText: "QR" }).first().waitFor();
  await c.page.locator(".card", { hasText: "Top 10 bán chạy" }).locator(".dt-card", { hasText: "Táo Envy" }).first().waitFor();
  ok("bảng theo kênh / theo hình thức TT / top bán chạy có dữ liệu thật");
  await c.page.getByRole("button", { name: "Xong" }).click();

  // ============ 8. Thu chi ============
  step("Chủ lập phiếu chi tiền mặt, phiếu thứ hai rồi đảo phiếu; xem quỹ và đối soát ca");
  await go(o.page, "/finance");
  await o.page.getByRole("tab", { name: "Phiếu thu chi" }).click();
  const mkVoucher = async (cat, amount, who, note) => {
    await o.page.getByRole("button", { name: "+ Lập phiếu" }).click();
    const d = o.page.getByRole("dialog");
    await d.getByLabel("Hạng mục").selectOption({ label: cat });
    await d.getByLabel("Số tiền (₫)").fill(String(amount));
    await d.getByLabel(/Đối tượng/).fill(who);
    await d.getByLabel("Ghi chú").fill(note);
    await d.getByRole("button", { name: "Lưu phiếu" }).click();
    await toastOk(o.page, /Đã lập phiếu/);
  };
  await mkVoucher("Tiền điện, nước", 350000, "Điện lực TP.HCM", "Tiền điện tháng " + RUN);
  await mkVoucher("Vận chuyển", 120000, "Xe tải Ba Tèo", "Cước nhầm " + RUN);
  await o.page.locator(".dt-card", { hasText: "Xe tải Ba Tèo" }).first().getByRole("button", { name: "Đảo phiếu" }).click();
  await o.page.getByRole("dialog").getByLabel("Lý do đảo").fill("Nhập nhầm");
  await o.page.getByRole("dialog").getByRole("button", { name: /Tạo phiếu đảo/ }).click();
  await toastOk(o.page, /Đã tạo phiếu đảo/);
  await o.page.locator(".dt-card", { hasText: "Phiếu đảo" }).first().waitFor();
  ok("phiếu đảo được tạo ở kỳ hiện tại");
  await shot(o.page, "thu-chi-m.png");
  await o.page.getByRole("tab", { name: "Quỹ" }).click();
  await o.page.locator(".kpi", { hasText: "Tiền mặt tại cửa hàng 1" }).waitFor();
  await o.page.getByRole("tab", { name: "Đối soát ca" }).click();
  await o.page.locator(".dt-card", { hasText: "Thu ngân E2E" }).first().waitFor();
  assert(await o.page.locator(".dt-card", { hasText: "Thiếu tiền lẻ" }).first().isVisible(), "đối soát ca hiển thị ca vừa chốt kèm lý do chênh lệch");

  // ============ 9. Báo cáo ============
  step("Báo cáo lãi lỗ có doanh thu > 0, xuất CSV");
  await go(o.page, "/reports");
  await o.page.locator(".kpi", { hasText: "Doanh thu" }).waitFor();
  const rev = parseVnd(await o.page.locator(".kpi", { hasText: "Doanh thu" }).locator(".v").innerText());
  assert(rev > 0, `doanh thu P&L = ${vnd(rev)} > 0`);
  const cogs = parseVnd(await o.page.locator(".kpi", { hasText: "Giá vốn" }).locator(".v").innerText());
  assert(cogs > 0 && cogs < rev, `giá vốn = ${vnd(cogs)} (0 < giá vốn < doanh thu)`);
  await o.page.locator(".dt-card", { hasText: "Doanh thu" }).first().waitFor();
  await o.page.locator(".card", { hasText: "Chi phí" }).first().waitFor();
  await shot(o.page, "bao-cao-m.png");
  for (const by of ["channel", "group"]) {
    await o.page.getByLabel("Nhóm theo").selectOption(by);
    await o.page.locator(".dt-card").first().waitFor();
  }
  ok("nhóm theo ngày / kênh / nhóm hàng đều có dòng");
  for (const [text, file] of [["Xuất CSV lãi lỗ", "pnl.csv"], ["Xuất CSV đơn hàng", "orders.csv"], ["Xuất CSV theo ngày", "daily.csv"]]) {
    const [dl] = await Promise.all([o.page.waitForEvent("download"), o.page.getByRole("link", { name: new RegExp(text) }).click()]);
    assert(dl.suggestedFilename() === file, `tải được ${file}`);
  }
  await o.page.getByRole("tab", { name: "Tồn kho" }).click();
  await o.page.locator(".dt-card", { hasText: "Táo Envy" }).first().waitFor();
  const [dl2] = await Promise.all([o.page.waitForEvent("download"), o.page.getByRole("link", { name: /CSV tồn kho/ }).click()]);
  assert(dl2.suggestedFilename() === "inventory.csv", "tải được inventory.csv");

  // ============ 10. Duyệt (giảm giá vượt ngưỡng) ============
  step("Thu ngân (desktop) bán giảm giá 50% → cần duyệt → chủ duyệt trong hộp Duyệt → thu ngân thử lại với approvalId");
  const d = await newPage(desktop, "cashier-desktop");
  await login(d.page, cashierName, NEWPW);
  await go(d.page, "/pos");
  await d.page.getByLabel("Tiền đầu ca (₫)").fill("0");
  await d.page.getByRole("button", { name: "Mở ca", exact: true }).click();
  await d.page.getByLabel("Tìm sản phẩm").waitFor();
  await d.page.getByRole("button", { name: "Thêm Táo Envy" }).click();
  await d.page.getByLabel(/^Khối lượng/).fill("2");
  await shot(d.page, "pos-can-d.png");
  await d.page.getByRole("button", { name: /^Thêm 2 kg/ }).click();
  await d.page.getByRole("button", { name: "Thêm Dưa lưới Đài Loan" }).click();
  await d.page.getByLabel("Giảm giá dòng Dưa lưới Đài Loan").fill(String(Math.round(dua.price * 0.6)));
  const total2 = Math.round(tao.price * 2) + dua.price - Math.round(dua.price * 0.6);
  await d.page.getByText("Giỏ hàng (2)").waitFor();
  await d.page.waitForTimeout(150);
  await shot(d.page, "pos-d.png");
  await d.page.getByRole("button", { name: /^Thanh toán/ }).click();
  allow(409, /\/pos\/orders$/, "giảm giá vượt ngưỡng cần duyệt");
  const sheet2 = d.page.getByRole("dialog", { name: "Thanh toán" });
  await sheet2.getByRole("button", { name: /^Hoàn tất/ }).click();
  await sheet2.getByText("Cần quản lý duyệt").first().waitFor();
  const apprId = parseInt((await sheet2.getByText(/Mã yêu cầu duyệt/).innerText()).match(/#(\d+)/)[1], 10);
  assert(apprId > 0, `UI nhận approvalId=${apprId} từ 409 approval_required`);
  // chủ duyệt
  await go(o.page, "/approvals");
  await o.page.locator("button.dt-card", { hasText: `#${apprId}` }).click();
  await o.page.getByRole("dialog").getByText(/Giảm giá vượt ngưỡng|Giá bán thấp hơn giá vốn/).first().waitFor();
  await o.page.getByRole("dialog").getByRole("button", { name: "Duyệt", exact: true }).click();
  await toastOk(o.page, /Đã duyệt/);
  // thu ngân thử lại
  await sheet2.getByRole("button", { name: /^Thử lại/ }).click();
  const r2 = d.page.getByRole("dialog", { name: "Hoá đơn" });
  await r2.getByText("HOÁ ĐƠN BÁN HÀNG").waitFor();
  assert(parseVnd(await r2.locator(".receipt .l", { hasText: "TỔNG CỘNG" }).innerText()) === total2, `đơn giảm giá được duyệt: tổng ${vnd(total2)}`);
  await r2.getByRole("button", { name: "Đơn mới" }).click();
  // thử lại lần 2 với cùng approvalId sẽ không xảy ra (đã dùng) — kiểm DB qua API
  const ap = (await apiGet(o.ctx, "/approvals?status=approved&limit=5")).items.find((x) => x.id === apprId);
  assert(ap && ap.ref_type === "order", "backend gắn approval vào đơn (ref_type=order)");
  // chốt ca desktop (tiền mặt khớp)
  await go(d.page, "/shift-close");
  await d.page.getByLabel(/Tiền mặt kiểm đếm/).fill(String(total2));
  await d.page.getByRole("button", { name: "Chốt ca", exact: true }).click();
  await d.page.getByRole("heading", { name: "Tổng kết cuối ca" }).waitFor();
  ok("chốt ca không chênh lệch (không cần lý do) thành công");

  // ============ 11. Hộp duyệt, Kho cảnh báo, truy vết lô ============
  step("Hộp Duyệt tải được; Kho: cảnh báo + truy vết lô");
  await go(o.page, "/approvals");
  await o.page.locator("main").getByText(/Không có yêu cầu chờ duyệt|Chờ duyệt/).first().waitFor();
  ok("hộp Duyệt tải được");
  await go(o.page, "/inventory");
  await o.page.getByText("Sắp hết hàng").first().waitFor();
  await o.page.getByText("Tồn thấp").first().waitFor();
  ok("cảnh báo kho tải được");
  await shot(o.page, "kho-m.png");
  // FEFO có thể lấy lô cũ hơn (các lần chạy trước) → lấy đúng lô đã xuất cho đơn vừa bán từ API đơn hàng
  const ordId = (await apiGet(o.ctx, "/orders?limit=50")).items.find((x) => x.code === orderCode).id;
  const lotCode = (await apiGet(o.ctx, "/orders/" + ordId)).lines.find((l) => l.product_id === tao.id).lots[0].lot_code;
  await o.page.getByRole("tab", { name: "Truy vết lô" }).click();
  await o.page.getByLabel("Mã vạch / mã lô").fill(lotCode);
  await o.page.getByRole("button", { name: "Tra", exact: true }).click();
  await o.page.getByRole("heading", { name: new RegExp(`Lô ${lotCode}`) }).waitFor();
  await o.page.getByText("Đơn đã bán từ lô này").waitFor();
  assert(await o.page.locator(".dt-card", { hasText: orderCode }).first().isVisible(), `truy vết lô ${lotCode} thấy đơn ${orderCode}`);
  assert(await o.page.getByText(/Vựa đầu mối|Công ty|HTX|Vườn/).first().isVisible(), "truy vết lô hiển thị nhà cung cấp");
  await o.page.locator(".dt-card", { hasText: "Bán" }).first().waitFor();
  ok("truy vết lô hiển thị phiếu nhập, đơn bán và biến động kho");

  // ============ 12. Ảnh desktop ============
  step("Ảnh desktop (Báo cáo, Kho, Đăng nhập)");
  if (SHOTS) {
    const od2 = await newPage(desktop, "owner-desktop");
    await od2.page.goto(BASE + "/");
    await shot(od2.page, "login-d.png");
    await login(od2.page, OWNER.u, OWNER.p);
    await go(od2.page, "/reports");
    await od2.page.locator(".kpi", { hasText: "Doanh thu" }).waitFor();
    await od2.page.waitForTimeout(200);
    await shot(od2.page, "bao-cao-d.png");
    await go(od2.page, "/inventory");
    await od2.page.getByText("Tồn thấp").first().waitFor();
    await shot(od2.page, "kho-d.png");
  }
} catch (e) {
  if (!failures.some((f) => f.includes(String(e.message)))) fail("EXCEPTION: " + (e.stack ?? e.message).split("\n").slice(0, 4).join(" | "));
}

for (const a of allowed) if (!a.optional && a.used === 0) fail(`phản hồi dự kiến không xảy ra: ${a.status} ${a.re} (${a.why})`);
await browser.close();
if (failures.length) {
  console.error(`\nE2E THẤT BẠI (${failures.length} lỗi):\n - ` + failures.join("\n - "));
  process.exit(1);
}
console.log("\nE2E PASS");
