// E2E Bảng chấm công dạng lưới (docs/API-attendance-board.md): giao diện thật + backend thật.
// Chạy: BASE=http://localhost:8791 node e2e/hr-board.mjs   (SHOTS=0 để bỏ chụp ảnh). Chạy được trên DB mới hoặc sau e2e/hr.mjs.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8791";
const OWNER = { u: process.env.OWNER_USER ?? "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const SHOTS = process.env.SHOTS !== "0";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });

const RUN = Date.now().toString(36).slice(-5);
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
const apiGet = async (ctx, p) => { const r = await ctx.request.get(BASE + "/api/v1" + p, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${p} ${r.status()}`); return r.json(); };
const apiPost = async (ctx, p, data) => { const r = await ctx.request.post(BASE + "/api/v1" + p, { headers: hdr, data }); if (!r.ok()) throw new Error(`POST ${p} ${r.status()} ${await r.text()}`); return r.json(); };
async function login(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(OWNER.u);
  await page.getByLabel("Mật khẩu").fill(OWNER.p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
}

const TZ = "Asia/Ho_Chi_Minh";
const vnDate = (off = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + off * 86400000));
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d) => addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
const TODAY = vnDate(), DAY = vnDate(-1);
const NAMES = [`Bảng An ${RUN}`, `Bảng Bình ${RUN}`, `Bảng Cường ${RUN}`];
const card = (page, name) => page.locator(`[data-testid="board"] .bd-card[data-cell]`, { hasText: name }).first();

try {
  step(`Chuẩn bị: 3 nhân viên, cùng ca sáng ngày ${DAY} (qua API)`);
  const o = await newPage(desktop, "owner");
  await login(o.page);
  const base = { position: "Bán hàng", storeId: 1, hireDate: "2026-01-01", payType: "monthly", baseSalary: 7000000 };
  const emps = [];
  for (const n of NAMES) emps.push(await apiPost(o.ctx, "/employees", { ...base, fullName: n }));
  const tpl = (await apiGet(o.ctx, "/shift-templates")).items.find((t) => t.code === "SANG");
  await apiPost(o.ctx, "/schedule/bulk", { assignments: emps.map((e) => ({ employeeId: e.id, workDate: DAY, shiftTemplateId: tpl.id })) });
  const from = mondayOf(DAY), to = addDays(from, 6);
  let b = await apiGet(o.ctx, `/attendance/board?from=${from}&to=${to}`);
  const cellOf = (bb, e) => bb.cells.find((c) => c.employeeId === e.id && c.workDate === DAY);
  assert(emps.every((e) => cellOf(b, e)?.status === "not_yet"), "3 ô ở trạng thái Chưa chấm công");

  step("Mở Bảng chấm công (1440), menu có mục mới");
  await o.page.goto(BASE + "/hr/attendance");
  await o.page.getByTestId("board").waitFor();
  assert(await o.page.getByRole("link", { name: "Bảng chấm công" }).count() > 0, "menu có 'Bảng chấm công'");
  assert(await o.page.getByRole("link", { name: "Duyệt chấm công", exact: true }).count() === 0, "menu không còn 'Duyệt chấm công'");
  if (mondayOf(TODAY) !== from) await o.page.getByRole("button", { name: "Tuần trước" }).click();
  await card(o.page, NAMES[0]).waitFor();
  assert((await card(o.page, NAMES[0]).getAttribute("data-status")) === "not_yet", "thẻ NV hiện màu Chưa chấm công");
  await shot(o.page, "hr-board-1440.png");

  step("Chấm công thủ công một ô (08:00–14:00)");
  await card(o.page, NAMES[0]).click();
  const sheet = o.page.getByTestId("cell-sheet");
  await sheet.waitFor();
  await o.page.getByLabel("Ghi chú (bắt buộc, từ 3 ký tự)").fill("Quên mang điện thoại");
  await o.page.getByLabel("Giờ vào").fill("06:00");
  await o.page.getByLabel("Giờ ra").fill("14:00");
  await shot(o.page, "hr-board-cell-1440.png");
  await o.page.getByRole("button", { name: "Lưu", exact: true }).click();
  await toastOk(o.page, /Đã lưu chấm công/);
  b = await apiGet(o.ctx, `/attendance/board?from=${from}&to=${to}`);
  assert(cellOf(b, emps[0]).status === "on_time" && cellOf(b, emps[0]).manual, "ô thành Đúng giờ, đánh dấu thủ công");
  await o.page.waitForFunction((n) => [...document.querySelectorAll(".bd-card")].some((el) => el.textContent.includes(n) && el.dataset.status === "on_time"), NAMES[0]);
  ok("lưới cập nhật màu ngay");

  step("Chọn 2 ô cùng ca → chấm hàng loạt (vào 06:10 → muộn)");
  await o.page.getByRole("button", { name: "Chọn", exact: true }).click();
  await card(o.page, NAMES[1]).click();
  await card(o.page, NAMES[2]).click();
  await o.page.getByTestId("select-bar").getByRole("button", { name: "Chỉnh sửa chấm công" }).click();
  const bulk = o.page.getByTestId("bulk-edit");
  await bulk.waitFor();
  await bulk.getByLabel("Ghi chú (bắt buộc, từ 3 ký tự)").fill("Máy chấm công hỏng");
  await bulk.getByLabel("Giờ vào").fill("06:10");
  await bulk.getByLabel("Giờ ra").fill("14:00");
  await o.page.getByRole("button", { name: "Lưu cho 2 ô" }).click();
  await o.page.locator(".toast").first().waitFor();
  b = await apiGet(o.ctx, `/attendance/board?from=${from}&to=${to}`);
  assert([1, 2].every((i) => cellOf(b, emps[i]).status === "late_early" && cellOf(b, emps[i]).lateMinutes > 0), "2 ô thành Đi muộn");
  await o.page.keyboard.press("Escape").catch(() => {});
  if (await o.page.getByRole("button", { name: "Chọn", exact: true, pressed: true }).count()) await o.page.getByRole("button", { name: "Chọn", exact: true }).click();

  step("Ghi phạt đi muộn cho NV thứ hai");
  await card(o.page, NAMES[1]).click();
  await sheet.waitFor();
  await sheet.getByRole("tab", { name: "Phạt vi phạm" }).click();
  await o.page.getByRole("button", { name: "+ Thêm vi phạm" }).click();
  const typeSel = o.page.getByLabel("Loại vi phạm");
  const opt = await typeSel.locator("option", { hasText: "Đi muộn không lý do" }).getAttribute("value");
  await typeSel.selectOption(opt);
  await o.page.getByLabel("Số lần").fill("1");
  await o.page.getByTestId("cell-penalty").getByRole("button", { name: "Lưu", exact: true }).click();
  await o.page.locator(".toast").first().waitFor();
  const inc = await apiGet(o.ctx, `/attendance/incidents?from=${DAY}&to=${DAY}&employeeId=${emps[1].id}`);
  assert(inc.items.length === 1 && inc.items[0].amount === 20000, "đã ghi phạt 20.000 ₫ (chủ thấy số tiền)");
  await shot(o.page, "hr-board-penalty-1440.png");
  await o.page.keyboard.press("Escape").catch(() => {});

  step("Điện thoại 390: dải ngày, danh sách theo ca, không tràn ngang");
  const m = await newPage(mobile, "owner-m");
  await login(m.page);
  await m.page.goto(BASE + "/hr/attendance");
  await m.page.getByTestId("board").waitFor();
  if (mondayOf(TODAY) !== from) await m.page.getByRole("button", { name: "Tuần trước" }).click();
  await m.page.getByTestId("day-strip").waitFor();
  await m.page.getByTestId("day-strip").locator("button").nth((new Date(DAY + "T00:00:00Z").getUTCDay() + 6) % 7).click();
  await card(m.page, NAMES[0]).waitFor();
  const sw = await m.page.evaluate(() => document.documentElement.scrollWidth);
  assert(sw <= 391, `không tràn ngang (scrollWidth ${sw})`);
  await shot(m.page, "hr-board-390.png");
  await card(m.page, NAMES[1]).click();
  await m.page.getByTestId("cell-sheet").waitFor();
  await shot(m.page, "hr-board-cell-390.png");

  step("Theo tháng (1440)");
  await o.page.getByRole("tab", { name: "Theo tháng" }).click();
  await o.page.getByTestId("board").waitFor();
  await shot(o.page, "hr-board-month-1440.png");
} catch (e) {
  fail("Dừng: " + (e?.message ?? e));
}
await browser.close();
if (failures.length) { console.error(`\n✗ E2E bảng chấm công: ${failures.length} lỗi`); process.exit(1); }
console.log("\n✓ E2E bảng chấm công: tất cả đạt");
