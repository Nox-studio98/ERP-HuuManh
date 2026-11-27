// E2E "gaps 2": đơn lặp, quản trị bảng giá, phiếu thu/chi công nợ, sửa hợp đồng, loại nghỉ cấu hình, chọn người phụ trách khách.
// Chạy: BASE=http://localhost:8796 node e2e/gaps2.mjs   (SHOTS=0 để bỏ chụp ảnh)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8796";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });
const RUN = Date.now().toString(36).slice(-5);
const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let n = 0;
const step = (t) => console.log(`\n[${String(++n).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }
const addDays = (d, k) => new Date(Date.parse(d + "T00:00:00Z") + k * 86400000).toISOString().slice(0, 10);
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const ctx = await browser.newContext(mobile);
const page = await ctx.newPage();
page.setDefaultTimeout(10000);
page.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) fail(`console.error: ${m.text()}`); });
page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() >= 400 && !(r.status() === 401 && /auth\/me$/.test(u.pathname))) fail(`${r.request().method()} ${u.pathname} → ${r.status()}`); });
const apiGet = async (p) => { const r = await ctx.request.get(BASE + "/api/v1" + p, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${p} ${r.status()}`); return r.json(); };
const apiPost = async (p, data) => { const r = await ctx.request.post(BASE + "/api/v1" + p, { headers: hdr, data }); if (!r.ok()) throw new Error(`POST ${p} ${r.status()} ${await r.text()}`); return r.json(); };
const toastOk = (re) => page.locator(".toast").filter({ hasText: re }).first().waitFor();
const shot = async (name) => { if (!SHOTS) return; await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {}); await page.waitForTimeout(450); await page.screenshot({ path: join(DIR, name) }); };
const go = async (p) => { await page.goto(BASE + p); await page.locator("main#main").waitFor(); };
const dlg = () => page.getByRole("dialog").last();
const btn = (scope, name) => scope.getByRole("button", { name, exact: true });

try {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(OWNER.u);
  await page.getByLabel("Mật khẩu").fill(OWNER.p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();

  // dữ liệu nền: khách sỉ + nhập hàng để đơn lặp có tồn
  const cName = `Quán lặp ${RUN}`;
  const cust = await apiPost("/customers", { name: cName, type: "b2b", customerGroupId: 1, creditLimit: 50_000_000, paymentTermsDays: 7, contacts: [{ name: "Chị Lan", phone: "0900000009", isReceiver: true }], addresses: [{ label: "Quán chính", address: "12 Nguyễn Huệ, Q1", isDefault: true }] });

  step("Chọn người phụ trách khách sỉ từ /users/assignable (quản lý không có users.manage)");
  const mgrU = "ql" + RUN;
  const mgr = await apiPost("/users", { username: mgrU, fullName: `Quản lý ${RUN}`, role: "manager", tempPassword: "QuanLy-Tam-2026" });
  await go("/customers");
  await btn(page, "+ Thêm khách sỉ").click().catch(async () => { await page.getByRole("button", { name: /Thêm khách/ }).first().click(); });
  const d1 = dlg();
  const ownerSel = d1.getByLabel("Nhân viên phụ trách");
  await ownerSel.waitFor();
  const opts = await ownerSel.locator("option").allInnerTexts();
  assert(opts.some((t) => t.includes(`Quản lý ${RUN}`)) && opts.some((t) => t.includes("(tôi)")), "danh sách phụ trách gồm chủ (tôi) và quản lý mới");
  await shot("gaps2-customer-owner.png");
  await d1.getByLabel("Tên khách / công ty").fill(`Khách phụ trách ${RUN}`);
  await ownerSel.selectOption({ label: `Quản lý ${RUN}` });
  await d1.getByLabel("Tên người liên hệ").first().fill("Anh Nam").catch(() => {});
  await page.keyboard.press("Escape");
  ok("form có bộ chọn người phụ trách");

  step("Đơn lặp: tạo mẫu, bật/tắt, tạo đơn ngay");
  await go("/b2b-orders");
  await page.getByRole("tab", { name: "Đơn lặp" }).click();
  await page.getByTestId("recurring").waitFor();
  await btn(page, "+ Mẫu đơn lặp").first().click(); // nút ở đầu trang (trạng thái rỗng cũng có nút cùng tên)
  const d2 = dlg();
  await d2.getByLabel("Gõ tên, mã hoặc SĐT khách…").fill(cName).catch(async () => { await d2.getByPlaceholder("Gõ tên, mã hoặc SĐT khách…").fill(cName); });
  await d2.getByRole("option", { name: new RegExp(cName) }).click();
  await d2.getByRole("button", { name: "T2", exact: true }).click();
  await d2.getByRole("button", { name: "T5", exact: true }).click();
  await btn(d2, "+ Thêm hàng").click();
  await page.getByLabel("Tìm hàng", { exact: true }).fill("Táo Envy");
  await page.getByRole("button", { name: "Chọn Táo Envy" }).first().click();
  await shot("gaps2-recurring-form.png");
  await btn(d2, "Lưu").click();
  await toastOk(/Đã tạo mẫu đơn lặp/);
  const card = page.locator("[data-testid=recurring] .cards-grid .card", { hasText: cName }).first();
  await card.getByText("T2, T5").waitFor();
  await shot("gaps2-recurring-list.png");
  const tpl = (await apiGet("/b2b/recurring")).items.find((t) => t.customerName === cName);
  assert(tpl && tpl.weekdays.join() === "1,4" && tpl.active && tpl.lines[0].productName, "mẫu đã lưu: T2,T5, đang chạy, có tên hàng");
  // sửa: thêm T7
  await btn(card, "Sửa").click();
  await dlg().getByRole("button", { name: "T7", exact: true }).click();
  await btn(dlg(), "Lưu").click();
  await toastOk(/Đã lưu mẫu đơn lặp/);
  await page.locator("[data-testid=recurring] .cards-grid .card", { hasText: cName }).first().getByText("T2, T5, T7").waitFor();
  ok("sửa mẫu: thêm T7");
  // tắt → nút tạo ngay bị khoá
  await btn(page.locator("[data-testid=recurring] .cards-grid .card", { hasText: cName }).first(), "Tắt").click();
  await toastOk(/Đã tắt mẫu đơn lặp/);
  assert(await btn(page.locator("[data-testid=recurring] .cards-grid .card", { hasText: cName }).first(), "Tạo đơn ngay").isDisabled(), "mẫu tắt thì không tạo đơn ngay được");
  await btn(page.locator("[data-testid=recurring] .cards-grid .card", { hasText: cName }).first(), "Bật").click();
  await toastOk(/Đã bật mẫu đơn lặp/);
  // tạo đơn ngay (có thể thiếu tồn → chấp nhận 409 cho phép; kiểm tra bằng API sau)
  await btn(page.locator("[data-testid=recurring] .cards-grid .card", { hasText: cName }).first(), "Tạo đơn ngay").click();
  await dlg().getByLabel("Ngày giao").fill(addDays(TODAY, 3));
  await shot("gaps2-recurring-generate.png");
  await btn(dlg(), "Tạo đơn").click();
  await toastOk(/Đã tạo đơn/);
  const ords = (await apiGet(`/b2b/orders?customerId=${cust.id}&limit=10`)).items;
  assert(ords.length === 1 && ords[0].deliveryDate.slice(0, 10) === addDays(TODAY, 3), "đơn sinh từ mẫu cho đúng ngày giao");

  step("Quản trị bảng giá: tạo, sửa (ưu tiên, nhóm khách), tắt");
  await go("/prices");
  await page.getByRole("tab", { name: "Bảng giá" }).click();
  await btn(page, "+ Bảng giá mới").click();
  const d3 = dlg();
  await d3.getByLabel("Tên bảng giá").fill(`Sỉ E2E ${RUN}`);
  await d3.getByLabel("Kênh").selectOption("b2b");
  await d3.getByLabel("Loại").selectOption("group");
  await d3.getByLabel("Nhóm khách hàng").selectOption({ index: 1 });
  await d3.getByLabel("Ưu tiên (số lớn thắng)").fill("40");
  await shot("gaps2-pricelist-form.png");
  await btn(d3, "Tạo").click();
  await toastOk(/Đã tạo bảng giá/);
  await page.getByTestId("price-lists").getByText(`Sỉ E2E ${RUN}`).locator("visible=true").first().click();
  const d4 = dlg();
  await d4.getByLabel("Ưu tiên (số lớn thắng)").fill("55");
  await d4.getByLabel("Đang dùng").uncheck();
  await btn(d4, "Lưu").click();
  await toastOk(/Đã lưu bảng giá/);
  const pl = (await apiGet("/price-lists")).items.find((x) => x.name === `Sỉ E2E ${RUN}`);
  assert(pl && pl.priority === 55 && pl.active === false && pl.channel === "b2b" && pl.kind === "group" && pl.customerGroupId, "bảng giá đã sửa: ưu tiên 55, tắt, nhóm khách gắn");
  await page.getByTestId("price-lists").getByText("Đã tắt").locator("visible=true").first().waitFor();
  await shot("gaps2-pricelists.png");

  step("Công nợ → Phiếu thu/chi: lọc và đảo phiếu");
  const pay = await apiPost("/debts/payments", { direction: "in", partnerType: "customer", partnerId: cust.id, fundId: 1, amount: 150000, method: "cash" });
  await go("/debts");
  await page.getByRole("tab", { name: "Phiếu thu/chi" }).click();
  await page.getByTestId("all-payments").waitFor();
  // giao diện mới: bộ lọc phụ gập sau nút "Bộ lọc" (điện thoại), khoảng ngày chọn bằng nút "Tuỳ chọn"
  await page.getByTestId("all-payments").getByRole("button", { name: /^Bộ lọc/ }).click();
  await page.getByTestId("all-payments").getByRole("button", { name: "Tuỳ chọn", exact: true }).click();
  await page.getByLabel("Loại phiếu").selectOption("in");
  await page.getByLabel("Đối tác").selectOption("customer");
  await page.getByLabel("Từ ngày").fill(TODAY);
  await page.getByLabel("Đến ngày").fill(TODAY);
  await page.getByTestId("all-payments").getByText(pay.payment.code).locator("visible=true").first().waitFor();
  await shot("gaps2-debt-payments.png");
  await page.getByLabel("Loại phiếu").selectOption("out");
  await page.getByText("Không có phiếu nào khớp bộ lọc").waitFor();
  ok("lọc chi: không còn phiếu thu");
  await page.getByLabel("Loại phiếu").selectOption("in");
  await page.getByTestId("all-payments").getByRole("button", { name: "Đảo phiếu" }).locator("visible=true").first().click();
  await dlg().getByLabel("Lý do").fill("Nhập nhầm khách");
  await dlg().getByRole("button", { name: /Đảo phiếu/ }).last().click();
  await toastOk(/Đã đảo phiếu/);
  const pays = (await apiGet(`/debts/payments?partnerId=${cust.id}&partnerType=customer`)).items;
  assert(pays.some((p) => p.id === pay.payment.id && p.status === "reversed"), "phiếu đã đảo (status reversed)");

  step("Nhân sự: loại nghỉ cấu hình + sửa hợp đồng + form xin nghỉ của NV đọc từ API");
  const stU = "nv" + RUN;
  const emp = await apiPost("/employees", { fullName: `NV Lặp ${RUN}`, position: "Bán hàng", storeId: 1, hireDate: "2026-01-01", payType: "monthly", baseSalary: 7000000, createUser: { username: stU, role: "staff" } });
  await apiPost(`/employees/${emp.id}/contracts`, { type: "Thử việc", startDate: "2026-01-01", salary: 6000000 });
  await go("/hr/employees");
  await btn(page, "Loại nghỉ phép").click();
  const d5 = dlg();
  await btn(d5, "+ Loại nghỉ mới").click();
  await d5.getByLabel("Mã (chữ thường, không dấu, vd: cuoi)").fill("cuoi" + RUN.replace(/[^a-z0-9]/g, ""));
  await d5.getByLabel("Tên hiển thị").fill("Nghỉ cưới");
  await d5.getByLabel("Trừ vào số dư phép năm").uncheck();
  await btn(d5, "Lưu").click();
  await toastOk(/Đã lưu loại nghỉ/);
  await d5.getByText("Nghỉ cưới").waitFor();
  await shot("gaps2-leave-types.png");
  await page.keyboard.press("Escape");
  await page.getByText(`NV Lặp ${RUN}`).locator("visible=true").first().click();
  await page.getByRole("button", { name: /Sửa hợp đồng Thử việc/ }).click();
  const d6 = dlg();
  await d6.getByLabel("Loại hợp đồng").fill("Chính thức 12 tháng");
  await d6.getByLabel("Lương theo hợp đồng (₫)").fill("8000000");
  await shot("gaps2-contract-edit.png");
  await btn(d6, "Lưu hợp đồng").click();
  await toastOk(/Đã lưu hợp đồng/);
  const ct = (await apiGet(`/employees/${emp.id}`)).contracts[0];
  assert(ct.type === "Chính thức 12 tháng" && ct.salary === 8000000, "hợp đồng đã sửa (loại + lương)");

  // NV mới mở tab xin nghỉ: thấy loại nghỉ mới từ API
  const ctx2 = await browser.newContext(mobile);
  const p2 = await ctx2.newPage();
  p2.setDefaultTimeout(10000);
  const u = emp.tempPassword;
  await p2.goto(BASE + "/");
  await p2.getByLabel("Tên đăng nhập").fill(stU);
  await p2.getByLabel("Mật khẩu").fill(u);
  await p2.getByRole("button", { name: "Đăng nhập" }).click();
  await p2.getByLabel("Mật khẩu hiện tại").fill(u);
  await p2.getByLabel("Mật khẩu mới", { exact: true }).fill("NhanVien-Moi-2026x");
  await p2.getByLabel("Nhập lại mật khẩu mới").fill("NhanVien-Moi-2026x");
  await p2.getByRole("button", { name: "Đổi mật khẩu" }).click();
  await p2.locator("main#main").waitFor();
  await p2.getByRole("tab", { name: "Xin nghỉ phép" }).click();
  const types = await p2.getByLabel("Loại nghỉ").locator("option").allInnerTexts();
  assert(types.includes("Nghỉ cưới") && types.includes("Phép năm"), "form xin nghỉ của NV có loại nghỉ mới từ API: " + types.join(", "));
  if (SHOTS) { await p2.waitForTimeout(400); await p2.screenshot({ path: join(DIR, "gaps2-me-leave.png") }); }
  await ctx2.close();
} catch (e) {
  if (!String(e.message).startsWith("assert:")) fail("LỖI: " + (e.stack ?? e.message));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n✗ ${failures.length} lỗi:\n${failures.map((f) => " - " + f).join("\n")}` : "\n✓ E2E gaps2: tất cả đạt");
process.exit(failures.length ? 1 : 0);
