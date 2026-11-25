// E2E Đợt 2 (bán sỉ → giao → hoá đơn → thu tiền → sao kê → vượt hạn mức → duyệt): giao diện thật + backend thật.
// Chạy: node e2e/b2b.mjs   Biến môi trường: BASE, OWNER_USER / OWNER_PASS, SHOTS=0 để bỏ chụp ảnh.
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
const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }

const allowed = [];
const allow = (status, re, why, optional = false) => allowed.push({ status, re, why, used: 0, optional, sticky: false });
const allowAlways = (status, re, why) => allowed.push({ status, re, why, used: 0, optional: true, sticky: true });

function watch(page, who) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return;
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
  page.setDefaultTimeout(10000);
  watch(page, who);
  allowAlways(401, /\/api\/auth\/me$/, "chưa đăng nhập → /me 401 là bình thường");
  return { ctx, page };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(DIR, name) });
};
const toastOk = (page, re) => page.locator(".toast, [role=status], [role=alert]").filter({ hasText: re }).first().waitFor();
const parseVnd = (s) => parseInt(String(s).replace(/[^\d-]/g, ""), 10);
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const apiGet = async (ctx, path) => { const r = await ctx.request.get(BASE + "/api/v1" + path, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${path} ${r.status()}`); return r.json(); };
const apiPost = async (ctx, path, data) => { const r = await ctx.request.post(BASE + "/api/v1" + path, { headers: hdr, data }); if (!r.ok()) throw new Error(`POST ${path} ${r.status()} ${await r.text()}`); return r.json(); };
const go = async (page, path) => { await page.goto(BASE + path); await page.locator("main#main").waitFor(); };
const dlg = (page) => page.getByRole("dialog").last();

async function login(page, u, p) {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(u);
  await page.getByLabel("Mật khẩu").fill(p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
}
const pickProduct = async (page, search, name) => {
  await page.getByRole("button", { name: "+ Thêm hàng" }).click();
  await page.getByLabel("Tìm hàng", { exact: true }).fill(search);
  await page.getByRole("button", { name: `Chọn ${name}` }).first().click();
};

try {
  // ============ 1. Đăng nhập ============
  step("Chủ đăng nhập (390x844)");
  const o = await newPage(mobile, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  await o.page.locator(".tabbar").waitFor();
  assert((await o.page.locator(".tabbar > *").count()) <= 5, "thanh dưới tối đa 5 mục (có nút Thêm)");
  await o.page.getByRole("button", { name: "Thêm" }).click();
  for (const t of ["Bán sỉ", "Tài chính"]) await o.page.getByRole("dialog").getByText(t, { exact: true }).waitFor();
  assert(await o.page.getByRole("dialog").getByRole("link", { name: "Công nợ" }).isVisible(), "menu Thêm gom nhóm Bán sỉ / Tài chính, có Công nợ");
  await o.page.keyboard.press("Escape");

  // ============ 2. Khách sỉ ============
  step("Tạo khách sỉ (hạn mức 2.000.000, 7 ngày) — kiểm tra bắt buộc ≥1 địa chỉ + người nhận");
  const custName = `Nhà hàng E2E ${RUN}`;
  await go(o.page, "/customers");
  await shot(o.page, "khach-si.png");
  await o.page.getByRole("button", { name: "+ Thêm khách sỉ" }).first().click();
  {
    const d = dlg(o.page);
    await d.getByLabel("Tên khách / công ty").fill(custName);
    await d.getByLabel("Họ tên", { exact: true }).fill("Chị Lan");
    await d.getByLabel("SĐT").nth(1).fill("0909123456");
    const save = d.getByRole("button", { name: "Lưu khách hàng" });
    assert(await save.isDisabled(), "thiếu địa chỉ → không lưu được");
    await d.getByLabel("Địa chỉ", { exact: true }).fill("12 Nguyễn Huệ, Quận 1");
    await d.getByLabel("Hạn mức công nợ (₫)").fill("2000000");
    await d.getByLabel("Hạn thanh toán (ngày)").fill("7");
    // bỏ tick "Người nhận hàng" → phải chặn
    await d.getByLabel("Người nhận hàng").uncheck();
    assert(await save.isDisabled(), "không có người nhận hàng → không lưu được");
    await d.getByLabel("Người nhận hàng").check();
    assert(await save.isEnabled(), "đủ địa chỉ + người nhận → lưu được");
    await save.click();
  }
  await o.page.waitForURL(/\/customers\/\d+$/);
  const custId = Number(o.page.url().match(/customers\/(\d+)/)[1]);
  await o.page.getByRole("heading", { name: custName }).waitFor();
  const cu = await apiGet(o.ctx, `/customers/${custId}`);
  assert(cu.creditLimit === 2000000 && cu.paymentTermsDays === 7 && cu.addresses.length === 1 && cu.contacts[0].isReceiver, `API: khách ${cu.code} hạn mức 2.000.000, 7 ngày, 1 địa chỉ, người nhận`);
  const custCode = cu.code;

  // ============ 3. Nhập kho ============
  step("Phiếu nhập kho (API) để có tồn, kèm NCC → hoá đơn mua tạm tính");
  const supplierBefore = (await apiGet(o.ctx, "/suppliers/1/bills?limit=1")).items?.[0]?.id ?? 0;
  const exp = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const doc = await apiPost(o.ctx, "/stock-docs", { type: "receipt", locationId: 1, supplierId: 1 });
  await apiPost(o.ctx, `/stock-docs/${doc.id}/lines`, { productId: 1, unit: "kg", qty: 40, unitCost: 100000, expiresAt: exp });
  const posted = await apiPost(o.ctx, `/stock-docs/${doc.id}/post`, {});
  assert(posted.status === "posted", "phiếu nhập đã ghi sổ (40 kg Táo Envy)");
  const bills = (await apiGet(o.ctx, "/suppliers/1/bills?limit=5")).items;
  assert(bills[0].id > supplierBefore && bills[0].isProvisional, "sinh hoá đơn mua tạm tính (EC-30)");

  // ============ 4. Báo giá ============
  step("Báo giá từ khách → thêm hàng → lưu → gửi (PDF)");
  await o.page.getByRole("link", { name: "Tạo báo giá" }).click();
  await o.page.getByRole("button", { name: "Lưu báo giá" }).waitFor();
  await pickProduct(o.page, "Táo Envy", "Táo Envy");
  await o.page.getByLabel("Số lượng", { exact: true }).fill("10");
  await o.page.getByText("Giá bảng: 143.000").first().waitFor();
  assert(true, "hiện giá bảng sỉ cấp 1 = 143.000 ₫/kg khi chọn hàng");
  await o.page.getByRole("button", { name: "Lưu báo giá" }).click();
  const qHead = await o.page.getByRole("dialog").getByRole("heading", { name: /^Báo giá BG-/ }).innerText();
  const quoteCode = qHead.replace("Báo giá ", "").trim();
  const quote = (await apiGet(o.ctx, "/quotes?limit=5")).items.find((x) => x.code === quoteCode);
  assert(quote.status === "draft" && quote.subtotal === 1430000, `báo giá ${quoteCode} nháp, tạm tính 1.430.000`);
  await shot(o.page, "bao-gia.png");
  await o.page.getByRole("button", { name: "Gửi khách" }).click();
  await toastOk(o.page, /Đã gửi báo giá/);
  const pdfHref = await o.page.getByRole("link", { name: "Mở PDF báo giá" }).getAttribute("href");
  assert(pdfHref === `/api/v1/quotes/${quote.id}/pdf`, "có link PDF báo giá đúng đường dẫn");
  const pdf = await o.ctx.request.get(BASE + pdfHref, { headers: hdr });
  assert(pdf.status() === 200 && /application\/pdf/.test(pdf.headers()["content-type"]), `GET ${pdfHref} → 200 application/pdf`);
  assert((await pdf.body()).subarray(0, 4).toString() === "%PDF", "nội dung là PDF thật (%PDF)");

  // ============ 5. Chuyển thành đơn ============
  step("Chuyển báo giá thành đơn → kiểm hạn mức → giữ hàng");
  await o.page.getByRole("button", { name: "Chuyển thành đơn" }).click();
  await o.page.getByRole("button", { name: "Tạo đơn & giữ hàng" }).click();
  const openBtn = o.page.getByRole("button", { name: /^Mở đơn DS-/ });
  await openBtn.waitFor();
  const orderCode = (await openBtn.innerText()).replace("Mở đơn", "").trim();
  assert(true, `đã tạo đơn ${orderCode} từ báo giá`);
  await openBtn.click();
  await o.page.waitForURL(/\/b2b-orders\/\d+$/);
  const orderId = Number(o.page.url().match(/b2b-orders\/(\d+)/)[1]);
  await o.page.getByRole("heading", { name: `Đơn ${orderCode}` }).waitFor();
  await o.page.locator(".dt-card", { hasText: "Đã giữ đủ" }).first().waitFor();
  const od = await apiGet(o.ctx, `/b2b/orders/${orderId}`);
  assert(od.status === "confirmed" && od.lines[0].reservedMilli === 10000, "đơn đã xác nhận, giữ đủ 10 kg theo lô");

  // ============ 6. Soạn hàng & quét ============
  step("Soạn hàng: quét sai hàng / sai lô / đúng lô / trùng");
  await o.page.getByRole("button", { name: "Soạn hàng" }).click();
  await o.page.waitForURL(/\/deliveries\/\d+$/);
  const delId = Number(o.page.url().match(/deliveries\/(\d+)/)[1]);
  await o.page.getByTestId("pick-list").waitFor();
  const lotCodes = (await o.page.getByTestId("pick-list").locator(".num").allInnerTexts()).filter((t) => /^HML/.test(t));
  assert(lotCodes.length >= 1, `phiếu soạn hiện lô giữ: ${lotCodes.join(", ")}`);
  const scan = async (code) => { await o.page.getByLabel("Mã vạch / mã lô").fill(code); await o.page.getByRole("button", { name: "Tra", exact: true }).click(); };
  const flash = () => o.page.getByTestId("scan-flash");
  allow(422, /\/deliveries\/\d+\/scan$/, "quét sai hàng (not_in_doc)");
  allow(422, /\/deliveries\/\d+\/scan$/, "quét sai lô (wrong_lot)");
  const lotsAll = (await apiGet(o.ctx, "/stock/lots?productId=10")).items;
  const otherProductLot = lotsAll.at(-1)?.lotCode;
  assert(!!otherProductLot, "có lô Dưa lưới để thử quét sai hàng");
  await scan(otherProductLot);
  await flash().filter({ hasText: "Sai hàng" }).waitFor();
  ok("lô của mặt hàng khác → báo 'Sai hàng' (not_in_doc)");
  const taoLots = (await apiGet(o.ctx, "/stock/lots?productId=1")).items;
  const wrong = taoLots.find((l) => !lotCodes.includes(l.lotCode) && l.qtyOnHandMilli > 0);
  await scan(wrong.lotCode);
  await flash().filter({ hasText: "Sai lô" }).waitFor();
  ok(`lô ${wrong.lotCode} không giữ cho đơn → báo 'Sai lô' (wrong_lot)`);
  await shot(o.page, "soan-hang.png");
  for (const c of lotCodes) { await scan(c); await flash().filter({ hasText: `Đã nhận ${c}` }).waitFor(); }
  ok("quét đúng các lô được giữ → được nhận");
  await o.page.getByText("Đã soạn 100%").waitFor();
  allow(422, /\/deliveries\/\d+\/scan$/, "quét trùng lô (duplicate)");
  await scan(lotCodes[0]);
  await flash().filter({ hasText: "Quét trùng" }).waitFor();
  ok("quét lại lô đã quét → báo 'Quét trùng'");
  await o.page.getByRole("button", { name: "Soạn xong" }).click();
  await o.page.getByRole("button", { name: "Giao đi" }).waitFor();
  await o.page.getByRole("button", { name: "Giao đi" }).click();
  await dlg(o.page).getByLabel(/Người giao/).fill("Anh Hùng 51A-123.45");
  await o.page.getByRole("button", { name: "Xác nhận giao đi" }).click();
  await toastOk(o.page, /Đã giao đi/);
  assert((await apiGet(o.ctx, `/deliveries/${delId}`)).status === "shipping", "phiếu giao ở trạng thái đang giao");

  // ============ 7. Xác nhận giao, từ chối một phần ============
  step("Xác nhận giao: giao 8 kg, từ chối 2 kg (hư hỏng) → hoá đơn theo số thực giao");
  await o.page.getByRole("button", { name: "Xác nhận đã giao" }).click();
  {
    const d = dlg(o.page);
    await d.getByLabel("Người nhận hàng").fill("Chị Lan");
    await d.getByLabel("Giao (kg)").fill("8");
    await d.getByLabel("Từ chối", { exact: true }).fill("2");
    const submit = d.getByRole("button", { name: "Xác nhận & lập hoá đơn" });
    assert(await submit.isDisabled(), "từ chối chưa có lý do → chưa gửi được");
    await d.getByRole("button", { name: "Hư hỏng" }).click();
    assert(await submit.isEnabled(), "chọn lý do 'Hư hỏng' → gửi được");
    await submit.click();
  }
  const inv = o.page.getByTestId("invoice-result");
  await inv.waitFor();
  const invCode = (await inv.locator("b").first().innerText()).replace("Hoá đơn", "").trim();
  assert(parseVnd(await inv.locator(".money").first().innerText()) === 1144000, "hoá đơn = 8 kg × 143.000 = 1.144.000 (không tính 2 kg từ chối)");
  const orderAfter = await apiGet(o.ctx, `/b2b/orders/${orderId}`);
  const invoiceId = orderAfter.invoiceId;
  assert(orderAfter.status === "completed" && invoiceId, `đơn hoàn tất, có hoá đơn #${invoiceId} (${invCode})`);
  const di = (await apiGet(o.ctx, `/invoices/${invoiceId}`));
  const plus7 = new Date(Date.parse(di.issueDate + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
  assert(di.dueDate === plus7, `hạn thanh toán = ngày xuất + 7 ngày (${di.issueDate} → ${di.dueDate})`);

  // ============ 8. Hoá đơn & HĐĐT ============
  step("Hoá đơn: trạng thái HĐĐT (fake provider) + PDF");
  await o.page.getByRole("link", { name: "Mở hoá đơn" }).click();
  await o.page.getByTestId("einvoice-box").waitFor();
  let einv = (await apiGet(o.ctx, `/invoices/${invoiceId}`)).einvoiceStatus;
  for (let i = 0; i < 12 && einv !== "issued"; i++) {
    if (i === 3) await o.page.getByRole("button", { name: /Phát hành HĐĐT|Thử phát hành lại/ }).click({ timeout: 2000 }).catch(() => {});
    await o.page.waitForTimeout(1000);
    einv = (await apiGet(o.ctx, `/invoices/${invoiceId}`)).einvoiceStatus;
  }
  if (einv !== "issued") {
    // xử lý job qua API retry (nếu job đang failed/dead) rồi đợi
    const jobs = (await apiGet(o.ctx, "/integrations/jobs?limit=20")).items.filter((j) => j.refType === "invoice" && j.refId === invoiceId);
    for (const j of jobs.filter((x) => ["failed", "dead"].includes(x.status))) await apiPost(o.ctx, `/integrations/jobs/${j.id}/retry`, {});
    for (let i = 0; i < 10 && einv !== "issued"; i++) { await o.page.waitForTimeout(1000); einv = (await apiGet(o.ctx, `/invoices/${invoiceId}`)).einvoiceStatus; }
  }
  assert(["issued", "queued"].includes(einv), `HĐĐT: ${einv} (issued qua nhà cung cấp giả lập hoặc đang xếp hàng)`);
  await o.page.reload();
  await o.page.getByTestId("einvoice-box").waitFor();
  const badge = await o.page.getByTestId("einvoice-box").locator(".badge").first().innerText();
  assert(/Đã phát hành|Đang chờ/.test(badge), `màn hình hiển thị huy hiệu HĐĐT: ${badge}`);
  assert(parseVnd(await o.page.getByTestId("outstanding").innerText()) === 1144000, "hoá đơn còn nợ 1.144.000");
  const ipdf = await o.ctx.request.get(BASE + `/api/v1/invoices/${invoiceId}/pdf`, { headers: hdr });
  assert(ipdf.status() === 200 && /pdf/.test(ipdf.headers()["content-type"]), "PDF hoá đơn tải được");

  // ============ 9. Thu tiền ============
  step("Thu tiền 1.500.000, gạch tay vào hoá đơn → dư 356.000 thành số dư có");
  await go(o.page, `/customers/${custId}`);
  await o.page.getByRole("tab", { name: "Công nợ" }).click();
  await o.page.getByRole("button", { name: "Thu tiền", exact: true }).click();
  {
    const d = dlg(o.page);
    await d.getByLabel("Số tiền (₫)").fill("1500000");
    await d.getByRole("tab", { name: "Chọn hoá đơn" }).click();
    await d.getByRole("button", { name: new RegExp("^Gạch đủ ") }).first().click();
    assert(parseVnd(await d.getByTestId("leftover").innerText()) === 356000, "UI báo phần dư 356.000 ₫");
    await d.getByRole("button", { name: /^Ghi phiếu thu/ }).click();
    await d.getByTestId("payment-result").waitFor();
    assert(parseVnd(await d.getByTestId("unapplied").innerText()) === 356000, "kết quả: dư chưa gạch 356.000 ₫");
    await d.getByRole("button", { name: "Xong" }).click();
  }
  const st1 = (await apiGet(o.ctx, `/customers/${custId}`)).debt;
  assert(st1.outstanding === 0 && st1.unapplied === 356000 && st1.balance === -356000, "API: nợ 0, số dư có 356.000, balance −356.000");

  // ============ 10. Sao kê ============
  step("Sao kê: số dư chạy đúng + tải CSV");
  await go(o.page, `/debts?statement=customer:${custId}`);
  await o.page.getByTestId("statement").waitFor();
  const rows = await o.page.getByTestId("statement").locator("tbody tr").allInnerTexts();
  assert(rows.length === 4, `sao kê có đầu kỳ + 2 phát sinh + cuối kỳ (${rows.length} dòng)`);
  const bal = (await o.page.getByTestId("statement").locator("tbody tr").evaluateAll((trs) => trs.map((t) => t.lastElementChild.textContent)));
  assert(parseVnd(bal[1]) === 1144000 && parseVnd(bal[2]) === -356000 && parseVnd(bal[3]) === -356000, `số dư chạy: ${bal.join(" → ")}`);
  assert(parseVnd(await o.page.getByTestId("closing").innerText()) === -356000, "số dư cuối kỳ −356.000");
  await shot(o.page, "sao-ke.png");
  const csvHref = await o.page.getByRole("link", { name: "Tải CSV sao kê" }).getAttribute("href");
  const csv = await o.ctx.request.get(BASE + csvHref, { headers: hdr });
  assert(csv.status() === 200 && /text\/csv/.test(csv.headers()["content-type"]) && (await csv.text()).includes("-356000"), "CSV sao kê tải được, có số dư cuối");

  // ============ 11. Vượt hạn mức ============
  step("Đơn thứ hai 20 kg (2.860.000) vượt hạn mức → credit_blocked → chủ duyệt → giữ hàng lại");
  allow(409, /\/b2b\/orders$/, "tạo đơn vượt hạn mức → credit_blocked");
  await go(o.page, `/customers/${custId}`);
  await o.page.getByRole("link", { name: "Tạo đơn" }).click();
  await o.page.getByRole("button", { name: "+ Thêm hàng" }).waitFor();
  await pickProduct(o.page, "Táo Envy", "Táo Envy");
  await o.page.getByLabel("Số lượng", { exact: true }).fill("20");
  await o.page.getByRole("button", { name: "Tạo đơn & giữ hàng" }).click();
  const cb = o.page.getByTestId("credit-blocked");
  await cb.waitFor();
  await cb.getByText("Vượt hạn mức công nợ").waitFor();
  const apprText = await cb.getByText(/yêu cầu/).first().innerText();
  const approvalId = Number(apprText.match(/#(\d+)/)[1]);
  assert(approvalId > 0, `hiện lý do 'Vượt hạn mức' + 'Đã gửi chủ duyệt' #${approvalId}`);
  await shot(o.page, "don-si-credit-blocked.png");
  await o.page.getByRole("button", { name: "Mở đơn đã tạo" }).click();
  await o.page.waitForURL(/\/b2b-orders\/\d+$/);
  const order2Id = Number(o.page.url().match(/b2b-orders\/(\d+)/)[1]);
  const order2 = await apiGet(o.ctx, `/b2b/orders/${order2Id}`);
  assert(order2.status === "new" && order2.lines[0].reservedMilli === 0, "đơn ở trạng thái Mới, CHƯA giữ hàng (kiểm hạn mức trước khi giữ)");
  allow(409, /\/b2b\/orders\/\d+\/confirm$/, "giữ lại khi chưa được duyệt vẫn bị chặn");
  await o.page.getByRole("button", { name: "Giữ hàng lại" }).click();
  await o.page.getByTestId("credit-blocked").waitFor();
  ok("bấm 'Giữ hàng lại' trước khi duyệt → vẫn bị chặn, hiện yêu cầu duyệt");
  // duyệt trong hộp thư duyệt
  await go(o.page, "/approvals");
  await o.page.locator(".dt-card", { hasText: `#${approvalId}` }).first().click();
  await dlg(o.page).getByText("Đơn sỉ vượt hạn mức công nợ").first().waitFor();
  await dlg(o.page).getByText("Vượt hạn mức công nợ").first().waitFor();
  assert(true, "hộp thư duyệt hiển thị loại 'order.credit_override' bằng tiếng Việt");
  await dlg(o.page).getByRole("button", { name: "Duyệt", exact: true }).click();
  await toastOk(o.page, /Đã duyệt/);
  await go(o.page, `/b2b-orders/${order2Id}`);
  await o.page.getByRole("button", { name: "Giữ hàng lại" }).click();
  await toastOk(o.page, /Đã giữ hàng/);
  await o.page.locator(".dt-card", { hasText: "Đã giữ đủ" }).first().waitFor();
  const order2b = await apiGet(o.ctx, `/b2b/orders/${order2Id}`);
  assert(order2b.status === "confirmed" && order2b.lines[0].reservedMilli === 20000, "sau khi chủ duyệt: 'Giữ hàng lại' giữ đủ 20 kg, đơn Đã xác nhận");

  // ============ 12. Excel ============
  step("Xuất Excel");
  await go(o.page, "/exports");
  const [download] = await Promise.all([o.page.waitForEvent("download"), o.page.getByTestId("export-so-ban-hang").click()]);
  assert(/\.xlsx$/.test(download.suggestedFilename()), `tải được tệp ${download.suggestedFilename()}`);
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  for (const n of ["so-ban-hang", "so-quy", "cong-no-phai-thu", "cong-no-phai-tra", "nhap-xuat-ton", "hoa-don-ban"]) {
    const r = await o.ctx.request.get(`${BASE}/api/v1/exports/${n}.xlsx?from=${today}&to=${today}`, { headers: hdr });
    assert(r.status() === 200 && /spreadsheetml\.sheet/.test(r.headers()["content-type"]), `GET exports/${n}.xlsx → 200 ${r.headers()["content-type"].slice(0, 40)}…`);
  }

  // ============ 13. Duyệt các màn còn lại ============
  step("Các màn còn lại tải được, không lỗi: Công nợ, Hoá đơn, Ngân hàng, NCC, Tích hợp, Báo giá, Đơn sỉ, Soạn & giao");
  // số dư đầu kỳ quá hạn 45 ngày để thấy tuổi nợ / nợ quá hạn
  const due45 = new Date(Date.now() + 7 * 3600000 - 45 * 86400000).toISOString().slice(0, 10);
  const ob = await apiPost(o.ctx, "/debts/opening-balances", [{ partnerType: "customer", partnerCode: custCode, amount: 800000, dueDate: due45 }]);
  assert(ob.created === 1, "nhập số dư đầu kỳ 800.000 quá hạn 45 ngày (API)");
  await go(o.page, "/debts");
  await o.page.locator(".dt-card", { hasText: custName }).first().waitFor();
  await shot(o.page, "cong-no.png");
  await o.page.getByRole("tab", { name: "Phải trả" }).click();
  await o.page.getByText("Còn phải trả").first().waitFor();
  await o.page.getByRole("tab", { name: "Nhắc nợ" }).click();
  await o.page.getByLabel("Sắp đến hạn trong (ngày)").waitFor();
  await o.page.getByRole("tab", { name: "Điều chỉnh" }).click();
  await o.page.getByRole("tab", { name: "Đầu kỳ" }).click();
  await o.page.getByText(/Dán CSV|đã khoá vĩnh viễn/).first().waitFor();
  ok("Công nợ: Phải thu / Phải trả / Nhắc nợ / Điều chỉnh / Đầu kỳ");
  await go(o.page, "/invoices");
  await o.page.getByRole("button", { name: /Bộ lọc/ }).click();
  await o.page.getByLabel("Thanh toán").selectOption("open");
  await go(o.page, "/bank");
  const ref = `E2E${RUN}${Date.now() % 100000}`;
  await o.page.getByLabel("Dán nội dung CSV").fill(`date,amount,description,ref\n${today},100000,${custCode} thanh toan them,${ref}\n${today},250000,Khach la chuyen khoan ${RUN},${ref}B`);
  await o.page.getByRole("button", { name: "Nhập giao dịch" }).click();
  await o.page.getByText(/Đã nhập 2 · tự khớp 1 · chưa khớp 1/).waitFor();
  assert(true, "nhập CSV ngân hàng: 2 giao dịch, tự khớp theo mã khách, 1 chưa khớp");
  await o.page.locator(".dt-card", { hasText: `Khach la chuyen khoan ${RUN}` }).first().click();
  await dlg(o.page).getByRole("textbox", { name: "Khách hàng" }).fill(custName);
  await dlg(o.page).getByRole("option").first().click();
  await dlg(o.page).getByRole("button", { name: /Khớp & ghi phiếu thu/ }).click();
  await toastOk(o.page, /Đã ghi phiếu/);
  await go(o.page, "/suppliers");
  await o.page.locator(".dt-card").filter({ hasText: "Vựa đầu mối" }).first().click();
  await o.page.getByRole("button", { name: "Chốt hoá đơn" }).first().click();
  await dlg(o.page).getByLabel("Số hoá đơn của nhà cung cấp").fill("HDNCC-" + RUN);
  await dlg(o.page).getByLabel(/^Tổng tiền chốt/).fill("3900000");
  assert(await dlg(o.page).getByRole("button", { name: "Chốt hoá đơn" }).isDisabled(), "đổi giá chốt thì bắt buộc nhập lý do");
  await dlg(o.page).getByLabel("Lý do chênh lệch").fill("NCC tăng giá theo hoá đơn");
  await dlg(o.page).getByRole("button", { name: "Chốt hoá đơn" }).click();
  await toastOk(o.page, /Đã chốt hoá đơn mua/);
  await go(o.page, "/integrations");
  await o.page.getByRole("tab", { name: "Cài đặt" }).click();
  await o.page.getByText("Hoá đơn điện tử").first().waitFor();
  await o.page.getByRole("tab", { name: "SKU Fresco" }).click();
  await o.page.getByRole("tab", { name: "Nhập đơn" }).click();
  await o.page.getByRole("tab", { name: "Tác vụ" }).click();
  await o.page.locator(".dt-card").filter({ hasText: /Phát hành HĐĐT/ }).first().waitFor();
  assert((await o.page.locator("input[type=password]").count()) === 0, "màn Tích hợp không có ô nhập secret");
  await go(o.page, "/quotes");
  await o.page.locator(".dt-card").filter({ hasText: quoteCode }).first().waitFor();
  await go(o.page, "/b2b-orders");
  await o.page.locator(".dt-card").filter({ hasText: orderCode }).first().waitFor();
  await go(o.page, "/deliveries");
  await o.page.getByRole("tab", { name: "Cần soạn" }).waitFor();
  ok("Báo giá / Đơn sỉ / Soạn & giao / NCC / Tích hợp / Ngân hàng hiển thị đúng");

  // ============ 14. Ảnh desktop ============
  step("Ảnh desktop (Công nợ, Đơn sỉ)");
  if (SHOTS) {
    const od = await newPage(desktop, "owner-desktop");
    await login(od.page, OWNER.u, OWNER.p);
    await go(od.page, "/debts");
    await od.page.locator("tr", { hasText: custName }).first().waitFor();
    await shot(od.page, "cong-no-d.png");
    await go(od.page, `/b2b-orders/${orderId}`);
    await od.page.getByRole("heading", { name: `Đơn ${orderCode}` }).waitFor();
    await shot(od.page, "don-si-d.png");
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
