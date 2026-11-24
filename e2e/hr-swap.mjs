// E2E đổi ca: NV A xin đổi ca sắp tới sang NV B → B nhận → quản lý duyệt → ca thuộc về B (lịch ca + "Lịch ca của tôi").
// Chạy: BASE=http://localhost:8796 node e2e/hr-swap.mjs   (SHOTS=0 để bỏ chụp ảnh)
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
const SHIFT_DAY = addDays(TODAY, 2);
const dm = (d) => d.slice(8, 10) + "/" + d.slice(5, 7);
const NAME_A = `Nguyễn An ${RUN}`, NAME_B = `Trần Bình ${RUN}`;
const UA = "swa" + RUN, UB = "swb" + RUN, NP = "NhanVien-Moi-2026x";

const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const newPage = async (who) => {
  const ctx = await browser.newContext(mobile);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => fail(`[${who}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) fail(`[${who}] console.error: ${m.text()}`); });
  page.on("response", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() >= 400 && !(r.status() === 401 && /auth\/me$/.test(u.pathname))) fail(`[${who}] ${r.request().method()} ${u.pathname} → ${r.status()}`); });
  return { ctx, page };
};
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const apiGet = async (ctx, p) => { const r = await ctx.request.get(BASE + "/api/v1" + p, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${p} ${r.status()}`); return r.json(); };
const apiPost = async (ctx, p, data) => { const r = await ctx.request.post(BASE + "/api/v1" + p, { headers: hdr, data }); if (!r.ok()) throw new Error(`POST ${p} ${r.status()} ${await r.text()}`); return r.json(); };
const toastOk = (page, re) => page.locator(".toast").filter({ hasText: re }).first().waitFor();
const shot = async (page, name) => { if (!SHOTS) return; await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {}); await page.waitForTimeout(400); await page.screenshot({ path: join(DIR, name) }); };
async function login(page, u, p, np) {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(u);
  await page.getByLabel("Mật khẩu").fill(p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  if (np) {
    await page.getByLabel("Mật khẩu hiện tại").fill(p);
    await page.getByLabel("Mật khẩu mới", { exact: true }).fill(np);
    await page.getByLabel("Nhập lại mật khẩu mới").fill(np);
    await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
  }
  await page.locator("main#main").waitFor();
}
const myScheduleRow = (page) => page.getByTestId("my-schedule").locator("> div", { hasText: dm(SHIFT_DAY) }).first();

try {
  step("Chủ tạo NV A, B (có tài khoản) và gán ca sáng cho A ở ngày " + SHIFT_DAY);
  const o = await newPage("owner");
  await login(o.page, OWNER.u, OWNER.p);
  const base = { position: "Bán hàng", storeId: 1, hireDate: "2026-01-01", payType: "monthly", baseSalary: 7000000 };
  const A = await apiPost(o.ctx, "/employees", { ...base, fullName: NAME_A, createUser: { username: UA, role: "staff" } });
  const B = await apiPost(o.ctx, "/employees", { ...base, fullName: NAME_B, createUser: { username: UB, role: "staff" } });
  const tpl = (await apiGet(o.ctx, "/shift-templates")).items.find((t) => t.code === "SANG");
  await apiPost(o.ctx, "/schedule/bulk", { assignments: [{ employeeId: A.id, workDate: SHIFT_DAY, shiftTemplateId: tpl.id }] });
  const before = (await apiGet(o.ctx, `/schedule?from=${SHIFT_DAY}&to=${SHIFT_DAY}`)).items.filter((s) => s.status === "scheduled");
  assert(before.some((s) => s.employeeId === A.id) && !before.some((s) => s.employeeId === B.id), "ban đầu ca thuộc A, B chưa có ca");

  step("A đăng nhập, mở Đổi ca và xin đổi ca sang B");
  const a = await newPage("A");
  await login(a.page, UA, A.tempPassword, NP);
  await a.page.getByRole("tab", { name: "Đổi ca" }).click();
  await a.page.getByLabel("Đồng nghiệp nhận ca").selectOption({ label: NAME_B });
  await a.page.getByLabel("Lý do").fill("Bận việc gia đình");
  await shot(a.page, "gaps2-swap-request.png");
  await a.page.getByRole("button", { name: "Gửi yêu cầu đổi ca", exact: true }).click();
  await toastOk(a.page, /Đã gửi yêu cầu đổi ca/);
  await a.page.getByText("Chờ nhận ca").first().waitFor();
  ok("A thấy yêu cầu ở trạng thái Chờ nhận ca");

  step("B đăng nhập, thấy yêu cầu và đồng ý nhận ca");
  const b = await newPage("B");
  await login(b.page, UB, B.tempPassword, NP);
  await b.page.getByRole("tab", { name: "Lịch ca của tôi" }).click();
  assert(!(await myScheduleRow(b.page).innerText()).includes("Ca sáng"), "trước khi duyệt B chưa có ca ở ngày đó");
  await b.page.getByRole("tab", { name: "Đổi ca" }).click();
  await b.page.getByText(`${NAME_A} → ${NAME_B}`).waitFor();
  await b.page.getByRole("button", { name: "Đồng ý nhận ca" }).click();
  await toastOk(b.page, /Đã đồng ý nhận ca/);
  await b.page.getByText("Chờ quản lý duyệt").first().waitFor();
  ok("yêu cầu chuyển sang Chờ quản lý duyệt");

  step("Chủ (quản lý) duyệt đổi ca ở Lịch ca → Đổi ca");
  await o.page.goto(BASE + "/hr/schedule");
  await o.page.getByRole("tab", { name: "Đổi ca" }).click();
  const card = o.page.locator(".card", { hasText: `${NAME_A} → ${NAME_B}` }).first();
  await card.waitFor();
  await card.getByRole("button", { name: "Duyệt", exact: true }).click();
  await toastOk(o.page, /Đã duyệt đổi ca/);
  await shot(o.page, "gaps2-swap-approved.png");

  step("Kiểm tra ca đã chuyển sang B: /hr/schedule (API + UI) và Lịch ca của tôi của B");
  const after = (await apiGet(o.ctx, `/schedule?from=${SHIFT_DAY}&to=${SHIFT_DAY}`)).items.filter((s) => s.status === "scheduled");
  assert(after.some((s) => s.employeeId === B.id) && !after.some((s) => s.employeeId === A.id), "API /schedule: ca thuộc B, A không còn ca");
  await o.page.goto(BASE + "/hr/schedule");
  await o.page.getByTestId("week-grid").waitFor();
  // Lưới tuần: nếu ngày ca nằm tuần sau, chuyển tuần
  if (!(await o.page.locator(`[data-cell="${B.id}|${SHIFT_DAY}"]`).count())) await o.page.getByRole("button", { name: /Tuần sau|›|→/ }).first().click();
  await o.page.locator(`[data-cell="${B.id}|${SHIFT_DAY}"] [data-chip]`).first().waitFor();
  assert((await o.page.locator(`[data-cell="${A.id}|${SHIFT_DAY}"] [data-chip]`).count()) === 0, "UI lịch tuần: ô của A trống, ô của B có ca");
  await b.page.reload();
  await b.page.getByRole("tab", { name: "Lịch ca của tôi" }).click();
  await b.page.getByTestId("my-schedule").waitFor();
  assert((await myScheduleRow(b.page).innerText()).includes("Ca sáng"), "B thấy Ca sáng ngày " + dm(SHIFT_DAY) + " trong Lịch ca của tôi");
  await shot(b.page, "gaps2-swap-b-schedule.png");
  await a.page.reload();
  await a.page.getByRole("tab", { name: "Lịch ca của tôi" }).click();
  await a.page.getByTestId("my-schedule").waitFor();
  assert(!(await myScheduleRow(a.page).innerText()).includes("Ca sáng"), "A không còn ca ngày đó");
} catch (e) {
  if (!String(e.message).startsWith("assert:")) fail("LỖI: " + (e.stack ?? e.message));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n✗ ${failures.length} lỗi:\n${failures.map((f) => " - " + f).join("\n")}` : "\n✓ E2E đổi ca: tất cả đạt");
process.exit(failures.length ? 1 : 0);
