// E2E Đợt 3 (ERP đơn online + website): giao diện thật + backend thật.
// Chạy: node e2e/online.mjs   Biến môi trường: BASE, OWNER_USER / OWNER_PASS, SHOTS=0 để bỏ chụp ảnh.
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const act = (page, name) => page.getByRole("button", { name, exact: true });
const statusIs = async (page, label) => { await page.locator(".page-head .badge").filter({ hasText: label }).first().waitFor(); ok("trạng thái: " + label); };
const stock = async (ctx, id) => (await apiGet(ctx, "/products?q=&limit=50")).items.find((p) => p.id === id).availableMilli;
const orderLines = [{ productId: 1, unit: "kg", qty: 2 }, { productId: 9, unit: "trai", qty: 2 }];
const social = (extra = {}) => ({ receiverName: `Khách E2E ${RUN}`, receiverPhone: "0901234567", addressLine: "1 Lê Lợi", district: "Quận 1", paymentMethod: "cod", items: orderLines, ...extra });

try {
  step("Chủ đăng nhập (390x844), menu có nhóm Bán online");
  const o = await newPage(mobile, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  await o.page.locator(".tabbar").waitFor();
  assert((await o.page.locator(".tabbar > *").count()) <= 5, "thanh dưới tối đa 5 mục");
  await o.page.getByRole("button", { name: "Thêm" }).click();
  await o.page.getByRole("dialog").getByText("Bán online", { exact: true }).waitFor();
  for (const t of ["Đơn online", "Website", "Khu vực giao", "Tài khoản khách"]) assert(await o.page.getByRole("dialog").getByRole("link", { name: t }).isVisible(), `menu Thêm có "${t}"`);
  await o.page.keyboard.press("Escape");

  step("Nhập kho (API) để có tồn: 30 kg Táo Envy + 30 trái Lựu");
  const exp = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const doc = await apiPost(o.ctx, "/stock-docs", { type: "receipt", locationId: 1, supplierId: 1 });
  await apiPost(o.ctx, `/stock-docs/${doc.id}/lines`, { productId: 1, unit: "kg", qty: 30, unitCost: 100000, expiresAt: exp });
  await apiPost(o.ctx, `/stock-docs/${doc.id}/lines`, { productId: 9, unit: "trai", qty: 30, unitCost: 40000, expiresAt: exp });
  assert((await apiPost(o.ctx, `/stock-docs/${doc.id}/post`, {})).status === "posted", "phiếu nhập đã ghi sổ");

  // ============ Đơn A: nhập tay → xác nhận → soạn → cân trong dung sai → giao → COD hoàn tất
  step("Đơn A: tạo đơn mạng xã hội bằng giao diện (1 hàng kg, 1 hàng đơn vị)");
  await go(o.page, "/online-orders/new");
  await o.page.getByLabel("Tên người nhận").fill(`Khách E2E ${RUN}`);
  await o.page.getByLabel("Số điện thoại").fill("0901234567");
  await o.page.getByLabel("Địa chỉ (số nhà, đường)").fill("12 Nguyễn Huệ");
  await o.page.getByLabel("Quận/huyện").fill("Quận 1");
  const create = o.page.getByRole("button", { name: "Tạo đơn" });
  assert(await create.isDisabled(), "chưa có hàng → không tạo được");
  await o.page.getByLabel("Thêm hàng").fill("Táo Envy");
  await o.page.getByRole("button", { name: "Chọn Táo Envy" }).first().click();
  await o.page.getByLabel("Số lượng (Táo Envy)").fill("2");
  await o.page.getByLabel("Thêm hàng").fill("Lựu");
  await o.page.getByRole("button", { name: "Chọn Lựu Ấn Độ" }).first().click();
  await o.page.getByLabel("Số lượng (Lựu Ấn Độ)").fill("2");
  assert((await o.page.getByTestId("social-line").count()) === 2, "2 dòng hàng");
  await shot(o.page, "online-new.png");
  await create.click();
  await o.page.waitForURL(/\/online-orders\/\d+$/);
  const idA = Number(o.page.url().match(/online-orders\/(\d+)/)[1]);
  await statusIs(o.page, "Chờ xác nhận");
  let dA = await apiGet(o.ctx, `/online-orders/${idA}`);
  assert(dA.channel === "social" && dA.lines.length === 2, `API: đơn ${dA.code} kênh social, 2 dòng`);
  assert(dA.lines.some((l) => l.lots.some((x) => x.kind === "reserved")), "hàng được giữ tồn theo lô");

  step("Đơn A: chỉ hiện hành động hợp lệ (new → Xác nhận / Huỷ)");
  assert(await act(o.page, "Xác nhận").isVisible() && await act(o.page, "Huỷ đơn").isVisible(), "có Xác nhận + Huỷ đơn");
  assert((await act(o.page, "Giao cho shipper").count()) === 0 && (await act(o.page, "Đã giao").count()) === 0, "chưa có Giao/Đã giao");
  await act(o.page, "Xác nhận").click(); await statusIs(o.page, "Đã xác nhận");
  assert((await act(o.page, "Xác nhận").count()) === 0 && await act(o.page, "Bắt đầu soạn").isVisible(), "đã xác nhận → Bắt đầu soạn");
  await act(o.page, "Bắt đầu soạn").click(); await statusIs(o.page, "Đang chuẩn bị");
  await o.page.getByText(/đang giữ/).first().waitFor();
  await shot(o.page, "online-detail.png");

  step("Đơn A: cân & đóng gói trong dung sai (2,05 kg), giao cho shipper, đã giao (COD)");
  await act(o.page, "Cân & đóng gói").click();
  await o.page.getByLabel("Thực cân (kg)").fill("2,05");
  await o.page.getByText("Trong dung sai").waitFor();
  ok("hiện 'Trong dung sai'");
  await o.page.getByRole("dialog").getByRole("button", { name: "Lưu số cân" }).click();
  await o.page.locator(".badge", { hasText: "Cân trong dung sai" }).waitFor();
  dA = await apiGet(o.ctx, `/online-orders/${idA}`);
  assert(dA.weightAdjustStatus === "auto_accepted" && dA.lines[0].qtyMilli === 2050, "API: auto_accepted, cân thực 2,05");
  await o.page.getByText("cân thực 2,05 kg").waitFor();
  await act(o.page, "Giao cho shipper").click();
  await o.page.getByLabel("Đơn vị vận chuyển / shipper").fill("Ahamove");
  await o.page.getByLabel("Mã vận đơn").fill("AHA" + RUN);
  await o.page.getByRole("button", { name: "Xác nhận giao đi" }).click();
  await statusIs(o.page, "Đang giao");
  await o.page.getByText("AHA" + RUN).first().waitFor();
  await o.page.getByText(/đã xuất/).first().waitFor();
  ok("lô đã xuất hiển thị");
  await act(o.page, "Đã giao").click();
  await statusIs(o.page, "Hoàn tất");
  dA = await apiGet(o.ctx, `/online-orders/${idA}`);
  assert(dA.payments.some((p) => p.method === "cod"), "COD ghi nhận khi giao");
  assert((await o.page.getByTestId("timeline").locator("li").count()) >= 5, "timeline có đủ mốc");

  // ============ Đơn B: lệch cân vượt dung sai
  step("Đơn B: cân lệch lớn → chờ khách xác nhận, chặn giao");
  const B = await apiPost(o.ctx, "/online-orders", social({ clientUuid: crypto.randomUUID() }));
  await apiPost(o.ctx, `/online-orders/${B.id}/confirm`); await apiPost(o.ctx, `/online-orders/${B.id}/prepare`);
  await go(o.page, `/online-orders/${B.id}`);
  await act(o.page, "Cân & đóng gói").click();
  await o.page.getByLabel("Thực cân (kg)").fill("3,5");
  await o.page.getByText(/khách sẽ phải xác nhận lại/).waitFor();
  ok("cảnh báo khách phải xác nhận lại khi lệch vượt dung sai");
  await shot(o.page, "online-pack.png");
  await o.page.getByRole("dialog").getByRole("button", { name: "Lưu số cân" }).click();
  await o.page.locator(".badge", { hasText: "Chờ khách xác nhận cân" }).first().waitFor();
  assert(await act(o.page, "Giao cho shipper").isDisabled(), "nút Giao cho shipper bị khoá");
  await o.page.getByText(/Đang chờ khách xác nhận khối lượng/).waitFor();
  ok("hiện lý do chặn giao");
  assert((await apiGet(o.ctx, `/online-orders/${B.id}`)).weightAdjustStatus === "pending_customer", "API: pending_customer");

  // ============ Đơn C: chuyển khoản
  step("Đơn C: chuyển khoản → chờ thanh toán → xác nhận đã nhận tiền → giao");
  const C = await apiPost(o.ctx, "/online-orders", social({ paymentMethod: "transfer", clientUuid: crypto.randomUUID() }));
  await go(o.page, `/online-orders/${C.id}`);
  await statusIs(o.page, "Chờ thanh toán");
  assert((await act(o.page, "Xác nhận").count()) === 0, "chưa thanh toán → không có Xác nhận");
  await act(o.page, "Xác nhận đã nhận tiền").click();
  const pd = dlg(o.page);
  assert(await pd.getByRole("button", { name: /^Xác nhận đã nhận/ }).isDisabled(), "chưa chọn giao dịch/mã → không xác nhận được");
  await pd.getByLabel("Hoặc nhập mã giao dịch / tham chiếu").fill("FT" + RUN + "XYZ");
  await pd.getByRole("button", { name: /^Xác nhận đã nhận/ }).click();
  await statusIs(o.page, "Chờ xác nhận");
  assert((await apiGet(o.ctx, `/online-orders/${C.id}`)).paymentStatus === "paid", "API: đã thanh toán");
  await act(o.page, "Xác nhận").click(); await statusIs(o.page, "Đã xác nhận");
  await act(o.page, "Bắt đầu soạn").click(); await statusIs(o.page, "Đang chuẩn bị");
  assert(await act(o.page, "Giao cho shipper").isEnabled(), "đã thanh toán → giao được");
  await act(o.page, "Giao cho shipper").click();
  await o.page.getByRole("button", { name: "Xác nhận giao đi" }).click();
  await statusIs(o.page, "Đang giao");

  step("Đơn C: giao thất bại → giao lại → hoàn kho (restock) → hoàn tiền");
  await act(o.page, "Giao thất bại").click();
  await dlg(o.page).getByLabel("Lý do giao thất bại").fill("Khách không nghe máy");
  await dlg(o.page).getByRole("button", { name: "Xác nhận thất bại" }).click();
  await statusIs(o.page, "Giao thất bại");
  await act(o.page, "Giao lại").click();
  await dlg(o.page).getByLabel("Khung giờ").selectOption({ index: 1 });
  await dlg(o.page).getByRole("button", { name: "Đặt lịch giao lại" }).click();
  await statusIs(o.page, "Đã xác nhận");
  // C quay về confirmed: soạn → giao lại → thất bại lần 2 → hoàn kho
  await act(o.page, "Bắt đầu soạn").click(); await statusIs(o.page, "Đang chuẩn bị");
  await act(o.page, "Giao cho shipper").click();
  await o.page.getByRole("button", { name: "Xác nhận giao đi" }).click(); await statusIs(o.page, "Đang giao");
  await act(o.page, "Giao thất bại").click();
  await dlg(o.page).getByLabel("Lý do giao thất bại").fill("Khách từ chối nhận");
  await dlg(o.page).getByRole("button", { name: "Xác nhận thất bại" }).click(); await statusIs(o.page, "Giao thất bại");
  await act(o.page, "Hoàn kho").click();
  await dlg(o.page).getByLabel("Lý do hoàn kho").fill("Hàng còn tươi");
  await dlg(o.page).getByRole("button", { name: "Xác nhận hoàn kho" }).click();
  await statusIs(o.page, "Đã trả hàng");
  const dC = await apiGet(o.ctx, `/online-orders/${C.id}`);
  if (dC.refundDue > 0) { // A-14: huỷ/trả chỉ ghi nghĩa vụ hoàn, finance.write hoàn thực
    await o.page.locator(".badge", { hasText: "Chờ hoàn tiền" }).first().waitFor();
    await o.page.getByRole("button", { name: /^Hoàn tiền/ }).click();
    await o.page.locator(".badge", { hasText: /Đã hoàn/ }).first().waitFor();
    ok("hoàn tiền đơn đã trả");
  } else ok("không có khoản cần hoàn (" + dC.paymentStatus + ")");

  // ============ Đơn D: huỷ sau khi soạn → hàng về kho
  step("Đơn D: huỷ sau khi soạn → tồn kho được khôi phục");
  const s0 = await stock(o.ctx, 9);
  const D = await apiPost(o.ctx, "/online-orders", social({ clientUuid: crypto.randomUUID() }));
  assert((await stock(o.ctx, 9)) < s0, "tạo đơn giữ tồn");
  await apiPost(o.ctx, `/online-orders/${D.id}/confirm`); await apiPost(o.ctx, `/online-orders/${D.id}/prepare`);
  await go(o.page, `/online-orders/${D.id}`);
  await act(o.page, "Huỷ đơn").click();
  await dlg(o.page).getByLabel("Lý do huỷ").fill("Khách đổi ý");
  await dlg(o.page).getByRole("button", { name: "Xác nhận huỷ đơn" }).click();
  await statusIs(o.page, "Đã huỷ");
  assert((await stock(o.ctx, 9)) === s0, "tồn kho khôi phục đúng như trước khi tạo đơn D");
  await o.page.getByText("Lý do huỷ: Khách đổi ý").waitFor();

  // ============ Danh sách
  step("Danh sách: chip trạng thái có đếm, lọc kênh/ngày, badge");
  await go(o.page, "/online-orders");
  await o.page.getByRole("tab", { name: /^Hoàn tất \(\d+\)/ }).waitFor();
  await o.page.getByRole("tab", { name: /^Đang chuẩn bị \(\d+\)/ }).click();
  await o.page.locator("button.dt-card").getByText("Chờ khách xác nhận cân").first().waitFor();
  ok("badge 'Chờ khách xác nhận cân' ở danh sách");
  await o.page.getByRole("tab", { name: /^Tất cả/ }).click();
  await o.page.getByRole("button", { name: /^Bộ lọc/ }).click(); // mobile: bộ lọc nâng cao gập sau nút
  await o.page.getByLabel("Kênh").selectOption("social");
  await o.page.getByTestId("online-list").locator("button.dt-card").nth(3).waitFor(); ok("lọc kênh social có ≥4 đơn");
  await o.page.getByLabel("Kênh").selectOption("fresco");
  await o.page.getByText("Không có đơn online").waitFor(); ok("lọc kênh fresco trống");
  await o.page.getByLabel("Kênh").selectOption("");
  await o.page.getByRole("tab", { name: /^Đã huỷ/ }).click();
  await o.page.locator("button.dt-card", { hasText: D.code }).waitFor();
  await o.page.getByRole("tab", { name: /^Tất cả/ }).click();
  await shot(o.page, "online-list.png");

  // ============ Website
  step("Bán online: publish sản phẩm, tải ảnh, sắp xếp, xoá");
  await go(o.page, "/products");
  await o.page.locator("button.dt-card", { hasText: "Táo Envy" }).first().click();
  await o.page.getByRole("tab", { name: "Bán online" }).click();
  const po = o.page.getByTestId("product-online");
  await po.getByLabel("Hiển thị trên website (công khai)").check();
  await po.getByLabel("Mô tả (markdown)").fill("# Táo Envy\n\n- Giòn ngọt\n- **Nhập khẩu** New Zealand\n\n<script>alert(1)</script> [Xem thêm](/p/tao-envy)");
  const pv = o.page.getByTestId("md-preview");
  await pv.locator("strong", { hasText: "Nhập khẩu" }).waitFor();
  assert((await pv.locator("script").count()) === 0 && (await pv.locator("li").count()) === 2, "xem trước markdown an toàn, không chèn <script>");
  await po.getByRole("button", { name: "Lưu cài đặt bán online" }).click();
  await toastOk(o.page, /Đã lưu cài đặt bán online/);
  const pOn = await apiGet(o.ctx, "/products/1/online");
  assert(pOn.publishedOnline === true && !!pOn.slug, `API: publish, slug ${pOn.slug}`);
  const nImg = pOn.images.length;
  const fileIn = po.locator('input[type=file]');
  await fileIn.setInputFiles({ name: "tao.png", mimeType: "image/png", buffer: PNG });
  await po.getByTestId("image-list").locator("img").nth(nImg).waitFor();
  await fileIn.setInputFiles({ name: "tao2.png", mimeType: "image/png", buffer: PNG });
  await po.getByTestId("image-list").locator("img").nth(nImg + 1).waitFor();
  assert((await apiGet(o.ctx, "/products/1/online")).images.length === nImg + 2, "đã tải 2 ảnh");
  const firstKey = (await apiGet(o.ctx, "/products/1/online")).images.at(-1).key;
  await po.getByRole("button", { name: "Lên" }).nth(nImg + 1).click();
  await o.page.waitForTimeout(500);
  assert((await apiGet(o.ctx, "/products/1/online")).images[nImg].key === firstKey, "sắp xếp ảnh: ảnh cuối lên trước");
  assert(await po.getByTestId("image-list").locator("img").first().evaluate((i) => i.complete && i.naturalWidth > 0), "ERP phục vụ ảnh /img/… (ảnh hiển thị được)");
  o.page.once("dialog", (d) => d.accept());
  await po.getByRole("button", { name: `Xoá ảnh ${nImg + 2}` }).click();
  await o.page.waitForTimeout(500);
  assert((await apiGet(o.ctx, "/products/1/online")).images.length === nImg + 1, "xoá 1 ảnh");
  await o.page.keyboard.press("Escape");

  step("Website: banner + bài viết (markdown)");
  await go(o.page, "/website");
  await o.page.getByRole("button", { name: "+ Thêm banner" }).click();
  let d = dlg(o.page);
  await d.getByLabel("Tiêu đề").fill(`Banner ${RUN}`);
  assert(await d.getByRole("button", { name: "Lưu banner" }).isDisabled(), "banner chưa có ảnh → không lưu được");
  await d.locator('input[type=file]').setInputFiles({ name: "b.png", mimeType: "image/png", buffer: PNG });
  await d.locator("img[alt='Ảnh banner']").waitFor();
  await d.getByLabel(/^Liên kết/).fill("/p/tao-envy");
  await d.getByRole("button", { name: "Lưu banner" }).click();
  await o.page.getByTestId("banner-list").getByText(`Banner ${RUN}`).waitFor();
  assert((await apiGet(o.ctx, "/cms/banners")).items.some((b) => b.title === `Banner ${RUN}`), "API: banner đã tạo");
  await shot(o.page, "online-website.png");
  await o.page.getByRole("tab", { name: "Bài viết" }).click();
  await o.page.getByRole("button", { name: "+ Viết bài" }).click();
  d = dlg(o.page);
  await d.getByLabel("Tiêu đề").fill(`Bài viết ${RUN}`);
  await d.getByLabel("Nội dung (markdown)").fill("## Chọn táo ngon\n\n- Vỏ căng bóng\n- *Thơm* nhẹ");
  await d.getByTestId("md-preview").locator("h4").waitFor();
  await d.getByLabel("Trạng thái").selectOption("published");
  await d.getByRole("button", { name: "Lưu bài viết" }).click();
  await o.page.getByTestId("post-list").getByText(`Bài viết ${RUN}`).waitFor();
  const post = (await apiGet(o.ctx, "/cms/posts")).items.find((p) => p.title === `Bài viết ${RUN}`);
  assert(post && post.status === "published", `API: bài viết /${post?.slug} đã đăng`);

  step("Khu vực & khung giờ, tài khoản khách, duyệt");
  await go(o.page, "/delivery-zones");
  await o.page.getByTestId("zone-list").locator("button.dt-card").getByText("Nội thành gần").first().waitFor();
  await o.page.getByRole("button", { name: "+ Thêm khu vực" }).click();
  d = dlg(o.page);
  await d.getByLabel("Tên khu vực").fill(`Khu ${RUN}`);
  await d.getByLabel("Quận/huyện").fill("Quận 4"); await d.getByLabel("Quận/huyện").press("Enter");
  await d.getByLabel("Phí giao (₫)").fill("25000");
  await d.getByRole("button", { name: "Lưu khu vực" }).click();
  await o.page.getByTestId("zone-list").locator("button.dt-card").getByText(`Khu ${RUN}`).first().waitFor();
  assert((await apiGet(o.ctx, "/delivery-zones")).items.some((z) => z.name === `Khu ${RUN}` && z.districts[0] === "Quận 4" && z.fee === 25000), "API: khu vực mới");
  await o.page.getByRole("tab", { name: "Khung giờ giao" }).click();
  await o.page.getByTestId("slot-list").locator("button.dt-card").getByText("8:00–10:00").first().waitFor();
  await o.page.getByRole("button", { name: "+ Thêm khung giờ" }).click();
  d = dlg(o.page);
  await d.getByLabel("Tên khung giờ").fill(`Ca ${RUN}`);
  await d.getByRole("button", { name: "Lưu khung giờ" }).click();
  await o.page.getByTestId("slot-list").locator("button.dt-card").getByText(`Ca ${RUN}`).first().waitFor();
  ok("khung giờ mới đã tạo");
  // Dọn dữ liệu thử: tắt khu vực / khung giờ vừa tạo để không ảnh hưởng website và các kịch bản khác
  for (const [path, match] of [["/delivery-zones", (z) => z.name === `Khu ${RUN}`], ["/delivery-slots", (s) => s.label === `Ca ${RUN}`]]) {
    const it = (await apiGet(o.ctx, path)).items.find(match);
    if (it) {
      const r = await o.ctx.request.put(BASE + "/api/v1" + path + "/" + it.id, { headers: hdr, data: { ...it, active: false } });
      assert(r.ok(), `tắt ${path}/${it.id} sau khi thử (${r.status()})`);
    }
  }
  await go(o.page, "/shop-accounts");
  await o.page.getByRole("tab", { name: "Tất cả tài khoản" }).click();
  await o.page.getByTestId("account-list").locator("button.dt-card, .empty").first().waitFor();
  ok("màn Tài khoản khách tải được");
  assert((await o.page.getByLabel("Thông báo đơn online mới").count()) === 0, "không có khoá VAPID → ẩn công tắc push");
  await go(o.page, "/approvals");
  await o.page.locator("main").getByText(/Không có yêu cầu chờ duyệt|Chờ duyệt/).first().waitFor();
  ok("hộp Duyệt tải được");

  step("Màn hình rộng 1280x800");
  const w = await newPage(desktop, "owner-desktop");
  await login(w.page, OWNER.u, OWNER.p);
  await go(w.page, "/online-orders");
  await w.page.getByTestId("online-list").waitFor();
  assert(await w.page.locator(".sidebar").getByText("Bán online").isVisible(), "sidebar có nhóm Bán online");
  await shot(w.page, "online-list-d.png");
} catch (e) {
  if (!String(e.message).startsWith("assert:")) fail("LỖI: " + (e.stack ?? e.message));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n✗ ${failures.length} lỗi:\n${failures.map((f) => " - " + f).join("\n")}` : "\n✓ E2E online: tất cả đạt");
process.exit(failures.length ? 1 : 0);
