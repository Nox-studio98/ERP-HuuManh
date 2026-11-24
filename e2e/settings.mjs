// E2E màn hình Cài đặt (Tham số / Khoá sổ / Nhật ký): DB mới + build + wrangler dev + giao diện thật.
// Chạy: node e2e/settings.mjs   (SHOTS=0 để bỏ chụp ảnh; SKIP_BUILD=1 để bỏ qua npm run build)
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8798, INSPECTOR = 9358;
const BASE = `http://localhost:${PORT}`;
const PERSIST = ".wrangler/state-set";
const OWNER = { u: "chu", p: "ChuCuaHang-2026" };
const MGR = { u: "quanly", tmp: "QuanLy-Tam-2026", np: "QuanLy-Moi-2026x" };
const SHOTS = process.env.SHOTS !== "0";
const DIR = join(ROOT, "docs", "screenshots");
if (SHOTS) mkdirSync(DIR, { recursive: true });

const failures = [];
const fail = (m) => { failures.push(m); console.error("  ✗ " + m); };
let stepNo = 0;
const step = (t) => console.log(`\n[${String(++stepNo).padStart(2, "0")}] ${t}`);
const ok = (t) => console.log("  ✓ " + t);
function assert(c, m) { if (!c) { fail("ASSERT: " + m); throw new Error("assert: " + m); } ok(m); }
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: "pipe", env: process.env });

step("DB mới: migrations + seed, build, khởi động wrangler dev");
rmSync(join(ROOT, PERSIST), { recursive: true, force: true });
sh("npx", ["wrangler", "d1", "migrations", "apply", "huu-manh-erp", "--local", "--persist-to", PERSIST]);
for (const f of ["seed/seed.sql", "seed/seed-dot3.sql", "seed/seed-dot4.sql"]) sh("npx", ["wrangler", "d1", "execute", "huu-manh-erp", "--local", "--persist-to", PERSIST, `--file=${f}`]);
if (process.env.SKIP_BUILD !== "1") sh("npm", ["run", "build"]);
const server = spawn("npx", ["wrangler", "dev", "-c", "dist/huu_manh_erp/wrangler.json", "--port", String(PORT), "--inspector-port", String(INSPECTOR), "--persist-to", PERSIST], { cwd: ROOT, stdio: "ignore", detached: true });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
let up = false;
for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(BASE + "/api/health").catch(() => fetch(BASE + "/"))).status < 500; } catch {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
if (!up) { stop(); throw new Error("wrangler dev không lên"); }
const boot = await fetch(BASE + "/api/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json", "x-bootstrap-token": "local-dev-bootstrap" }, body: JSON.stringify({ username: OWNER.u, fullName: "Chủ cửa hàng", password: OWNER.p }) });
if (boot.status !== 200) { stop(); throw new Error("bootstrap " + boot.status + " " + (await boot.text())); }
ok("server + owner sẵn sàng");

const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const desktop = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const allowed = [];
async function newPage(opts, who) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) fail(`[${who}] console.error: ${m.text()}`); });
  page.on("pageerror", (e) => fail(`[${who}] pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/") || r.status() < 400) return;
    if (r.status() === 401 && /\/auth\/me$/.test(u.pathname)) return;
    if (allowed.some((a) => a(r.status(), u.pathname))) return;
    fail(`[${who}] ${r.request().method()} ${u.pathname} → ${r.status()} (không dự kiến)`);
  });
  return { ctx, page };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(DIR, name) });
};
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const apiGet = async (ctx, p) => { const r = await ctx.request.get(BASE + "/api/v1" + p, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${p} ${r.status()}`); return r.json(); };
const apiPost = async (ctx, p, data) => { const r = await ctx.request.post(BASE + "/api/v1" + p, { headers: hdr, data }); if (!r.ok()) throw new Error(`POST ${p} ${r.status()} ${await r.text()}`); return r.json(); };
const dlg = (page) => page.getByRole("dialog").last();
const btn = (scope, name) => scope.getByRole("button", { name, exact: true });
const toastOk = (page, re) => page.locator(".toast").filter({ hasText: re }).first().waitFor();
async function login(page, u, p, newPass) {
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill(u);
  await page.getByLabel("Mật khẩu").fill(p);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  if (newPass) {
    await page.getByLabel("Mật khẩu hiện tại").fill(p);
    await page.getByLabel("Mật khẩu mới", { exact: true }).fill(newPass);
    await page.getByLabel("Nhập lại mật khẩu mới").fill(newPass);
    await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
  }
  await page.locator("main#main").waitFor();
}
const row = (page, key) => page.locator(`.set-row[data-key="${key}"]`);
const tab = (page, name) => page.getByRole("tab", { name, exact: true });

try {
  step("Chủ mở Cài đặt (390x844): nhóm tham số, huy hiệu Cần xác nhận");
  const o = await newPage(mobile, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  await o.page.goto(BASE + "/settings");
  await o.page.getByRole("heading", { name: "Ngưỡng duyệt" }).waitFor();
  assert((await o.page.locator(".set-head").count()) === 9, "9 nhóm tham số");
  await shot(o.page, "settings-01-params-mobile.png");
  const before = (await apiGet(o.ctx, "/settings")).pendingCount;
  assert(before > 20, `có ${before} mục cần xác nhận`);

  step("Lọc 'Chỉ mục cần xác nhận', sửa ngưỡng chi và hệ số tăng ca");
  await o.page.getByLabel(/Chỉ mục cần xác nhận/).check();
  await row(o.page, "approval.cash_out_vnd").waitFor();
  assert((await row(o.page, "approval.cash_out_vnd").innerText()).includes("Cần xác nhận"), "badge hiện ở ngưỡng chi");
  assert((await row(o.page, "approval.cash_out_vnd").getByTestId("val-approval.cash_out_vnd").innerText()).includes("5.000.000"), "hiển thị 5.000.000 ₫");
  await shot(o.page, "settings-02-pending-filter-mobile.png");
  await row(o.page, "approval.cash_out_vnd").getByRole("button", { name: "Sửa Phiếu chi cần chủ duyệt khi vượt" }).click();
  await row(o.page, "approval.cash_out_vnd").getByRole("textbox").fill("8000000");
  await btn(row(o.page, "approval.cash_out_vnd"), "Xong").click();
  await row(o.page, "hr.ot_weekday_bp").getByRole("button", { name: /^Sửa / }).click();
  await row(o.page, "hr.ot_weekday_bp").getByRole("textbox").fill("160");
  await btn(row(o.page, "hr.ot_weekday_bp"), "Xong").click();
  assert((await o.page.locator(".set-bar").innerText()).includes("2"), "thanh 2 thay đổi chưa lưu");
  await btn(o.page, "Xem & lưu").click();
  const d = dlg(o.page);
  assert((await d.getByTestId("diff-approval.cash_out_vnd").innerText()).includes("8.000.000"), "diff ngưỡng chi 5tr → 8tr");
  assert((await d.getByTestId("diff-hr.ot_weekday_bp").innerText()).includes("160%"), "diff hệ số 150% → 160%");
  await shot(o.page, "settings-03-diff-confirm-mobile.png");
  await btn(d, "Xác nhận lưu 2 thay đổi").click();
  await toastOk(o.page, /Đã lưu 2/);
  await o.page.waitForTimeout(300);
  assert((await o.page.locator('.set-row[data-key="approval.cash_out_vnd"]').count()) === 0, "badge biến mất (mục rời khỏi bộ lọc cần xác nhận)");
  const s = await apiGet(o.ctx, "/settings");
  assert(s.pendingCount === before - 2, "pendingCount giảm 2");
  const flat = s.groups.flatMap((g) => g.items);
  assert(flat.find((i) => i.key === "approval.cash_out_vnd").value === "8000000" && flat.find((i) => i.key === "hr.ot_weekday_bp").value === "16000", "giá trị đã lưu đúng");

  step("Xác nhận giữ nguyên một mục + lỗi validate hiện trên dòng");
  await row(o.page, "costing.method").getByRole("button", { name: /^Xác nhận giữ nguyên/ }).click();
  await toastOk(o.page, /Đã xác nhận/);
  await o.page.getByLabel(/Chỉ mục cần xác nhận/).uncheck();
  await o.page.getByRole("button", { name: /Nhân sự & lương/ }).click();
  await row(o.page, "hr.late_grace_minutes").getByRole("button", { name: /^Sửa / }).click();
  await row(o.page, "hr.late_grace_minutes").getByRole("spinbutton").fill("9999");
  await btn(row(o.page, "hr.late_grace_minutes"), "Xong").click();
  await btn(o.page, "Xem & lưu").click();
  allowed.push((st, p) => st === 422 && p.endsWith("/settings"));
  await btn(dlg(o.page), "Xác nhận lưu 1 thay đổi").click();
  await row(o.page, "hr.late_grace_minutes").locator(".err").waitFor();
  ok("lỗi 422 hiện đỏ ở dòng");
  await row(o.page, "hr.late_grace_minutes").getByRole("button", { name: "Bỏ sửa" }).click();

  step("Bảng thuế TNCN sửa như bảng");
  await o.page.getByRole("button", { name: /Thuế TNCN/ }).click();
  await row(o.page, "hr.pit_brackets_json").getByRole("button", { name: /^Sửa / }).click();
  assert((await o.page.getByTestId("pit-editor").locator(".pit-row").count()) === 5, "5 bậc thuế");
  await shot(o.page, "settings-04-pit-editor-mobile.png");
  await btn(row(o.page, "hr.pit_brackets_json"), "Huỷ").click();

  step("Tab Nhật ký: thấy bản ghi sửa cài đặt, diff trước/sau");
  await tab(o.page, "Nhật ký").click();
  await o.page.getByTestId("audit-list").locator(".audit-row").first().waitFor();
  await o.page.getByLabel("Hành động").selectOption("settings.update");
  await btn(o.page, "Lọc").click();
  await o.page.getByTestId("audit-list").locator(".audit-row").filter({ hasText: "Sửa cài đặt" }).first().click();
  const diffTxt = await dlg(o.page).getByTestId("audit-diff").innerText();
  assert(diffTxt.includes("approval.cash_out_vnd") && diffTxt.includes("5000000") && diffTxt.includes("8000000") && diffTxt.includes("16000"), "diff hiện trước/sau của 2 khoá");
  await shot(o.page, "settings-05-audit-diff-mobile.png");
  await o.page.keyboard.press("Escape");

  step("Tab Khoá sổ: khoá kỳ đã qua, mở khoá bắt buộc lý do");
  await tab(o.page, "Khoá sổ").click();
  const cur = (await apiGet(o.ctx, "/periods")).current;
  const [cy, cm] = cur.split("-").map(Number);
  const t = cy * 12 + cm - 2;
  const past = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  const pr = o.page.locator(`.period-row[data-period="${past}"]`);
  await pr.waitFor();
  assert((await o.page.locator(`.period-row[data-period="${cur}"]`).getByRole("button").count()) === 0, "kỳ hiện tại không có nút khoá");
  await pr.getByRole("button", { name: /^Khoá sổ/ }).click();
  await btn(dlg(o.page), "Khoá sổ").click();
  await toastOk(o.page, /Đã khoá sổ/);
  await pr.getByText("Đã khoá").waitFor();
  await shot(o.page, "settings-06-periods-mobile.png");
  await pr.getByRole("button", { name: /^Mở khoá/ }).click();
  assert(await btn(dlg(o.page), "Mở khoá").isDisabled(), "nút Mở khoá bị chặn khi chưa có lý do");
  await dlg(o.page).getByLabel(/Lý do mở khoá/).fill("Sửa phiếu chi nhập nhầm kỳ");
  await btn(dlg(o.page), "Mở khoá").click();
  await toastOk(o.page, /Đã mở khoá/);
  await pr.getByText("Chưa khoá").waitFor();
  const au = (await apiGet(o.ctx, "/audit?action=period.unlock")).items[0];
  assert(au.entity_id === past && au.reason === "Sửa phiếu chi nhập nhầm kỳ", "audit period.unlock có lý do");

  step("Quản lý chỉ xem (không có nút sửa/khoá), nhật ký xem được");
  await apiPost(o.ctx, "/users", { username: MGR.u, fullName: "Quản lý E2E", role: "manager", tempPassword: MGR.tmp });
  const m = await newPage(mobile, "manager");
  await login(m.page, MGR.u, MGR.tmp, MGR.np);
  await m.page.goto(BASE + "/settings");
  await m.page.getByRole("heading", { name: "Ngưỡng duyệt" }).waitFor();
  assert((await m.page.getByText("Bạn chỉ có quyền xem").count()) === 1, "banner chỉ xem");
  assert((await m.page.getByRole("button", { name: /^Sửa / }).count()) === 0, "không có nút Sửa");
  await tab(m.page, "Khoá sổ").click();
  await m.page.locator(".period-row").first().waitFor();
  assert((await m.page.locator(".period-row").getByRole("button").count()) === 0, "không có nút khoá/mở khoá");
  await tab(m.page, "Nhật ký").click();
  await m.page.getByTestId("audit-list").locator(".audit-row").first().waitFor();
  ok("quản lý xem được nhật ký");

  step("Màn hình desktop");
  const dk = await newPage(desktop, "owner-desktop");
  await login(dk.page, OWNER.u, OWNER.p);
  await dk.page.goto(BASE + "/settings");
  await dk.page.getByRole("button", { name: /Nhân sự & lương/ }).click();
  await dk.page.getByRole("button", { name: /Bán hàng & giá/ }).click();
  await dk.page.getByRole("heading", { name: "Ngưỡng duyệt" }).waitFor();
  await dk.page.evaluate(() => { window.scrollTo(0, 0); document.querySelector(".main")?.scrollTo(0, 0); });
  await shot(dk.page, "settings-07-params-desktop.png");
} catch (e) {
  fail("Ngoại lệ: " + (e?.message ?? e));
} finally {
  await browser.close().catch(() => {});
  stop();
}
if (failures.length) { console.error(`\n${failures.length} lỗi`); process.exit(1); }
console.log("\nE2E Cài đặt: OK");
