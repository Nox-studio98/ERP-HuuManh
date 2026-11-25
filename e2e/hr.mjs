// E2E Đợt 4 (Nhân sự – chấm công – bảng công – lương): giao diện thật + backend thật.
// Chạy: node e2e/hr.mjs   Biến môi trường: BASE (mặc định http://localhost:8791), PERSIST (thư mục state wrangler), SHOTS=0 để bỏ chụp ảnh.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8791";
const PERSIST = process.env.PERSIST ?? ".wrangler/state-hr";
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

const allowed = [];
const allow = (status, re, why) => allowed.push({ status, re, why, used: 0, sticky: false });
const allowAlways = (status, re, why) => allowed.push({ status, re, why, used: 0, sticky: true });
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

const STORE = { latitude: 10.7769, longitude: 106.7009, accuracy: 10 };
const FAR = { latitude: 10.82, longitude: 106.75, accuracy: 10 };
const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh", permissions: ["geolocation"], geolocation: STORE };
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
async function newPage(opts, who) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  watch(page, who);
  allowAlways(401, /\/api\/auth\/me$/, "chưa đăng nhập");
  return { ctx, page };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.locator(".toast").first().waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(DIR, name) });
};
const toastOk = (page, re) => page.locator(".toast").filter({ hasText: re }).first().waitFor();
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
const apiGet = async (ctx, path) => { const r = await ctx.request.get(BASE + "/api/v1" + path, { headers: hdr }); if (!r.ok()) throw new Error(`GET ${path} ${r.status()}`); return r.json(); };
const apiPost = async (ctx, path, data) => { const r = await ctx.request.post(BASE + "/api/v1" + path, { headers: hdr, data }); if (!r.ok()) throw new Error(`POST ${path} ${r.status()} ${await r.text()}`); return r.json(); };
const go = async (page, path) => { await page.goto(BASE + path); await page.locator("main#main").waitFor(); };
const dlg = (page) => page.getByRole("dialog").last();
const btn = (scope, name) => scope.getByRole("button", { name, exact: true });

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

// ---- ngày giờ VN
const TZ = "Asia/Ho_Chi_Minh";
const vnDate = (off = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + off * 86400000));
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d) => addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
const TODAY = vnDate(), YESTERDAY = vnDate(-1);
const PAST = (() => { const [y, m] = TODAY.slice(0, 7).split("-").map(Number); const t = y * 12 + m - 1 - 2; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; })();
const STAFF = { u: "nv" + RUN, np: "NhanVien-2026x" };
const ACC = { u: "kt" + RUN, tmp: "KeToan-Tam-2026", np: "KeToan-Moi-2026x" };
const MGR = { u: "ql" + RUN, tmp: "QuanLy-Tam-2026", np: "QuanLy-Moi-2026x" };
const NAME_A = `Nguyễn Văn An ${RUN}`, NAME_B = `Trần Thị Bình ${RUN}`, NAME_C = `Lê Văn Cường ${RUN}`;

function sql(stmts) {
  const f = join(ROOT, ".wrangler", `hr-e2e-${RUN}.sql`);
  writeFileSync(f, stmts.join(";\n") + ";\n");
  execFileSync("npx", ["wrangler", "d1", "execute", "huu-manh-erp", "--local", `--persist-to`, PERSIST, `--file=${f}`], { cwd: ROOT, stdio: "pipe" });
}
const startEnd = (d) => ({ s: `${addDays(d, -1)}T23:00:00.000Z`, e: `${d}T07:00:00.000Z` });

try {
  step("Chủ đăng nhập (390x844) và tạo 2 nhân viên bằng giao diện (1 có tài khoản staff)");
  const o = await newPage(mobile, "owner");
  await login(o.page, OWNER.u, OWNER.p);
  await go(o.page, "/hr/employees");
  const created = {};
  for (const [key, name, account] of [["A", NAME_A, STAFF.u], ["B", NAME_B, null]]) {
    await btn(o.page, "+ Thêm nhân viên").click();
    const d = dlg(o.page);
    await d.getByLabel("Họ và tên").fill(name);
    await d.getByLabel("Ngày vào làm").fill("2026-01-01");
    if (key === "B") await d.getByLabel("Hình thức trả lương").selectOption("hourly");
    if (key === "A") await d.getByLabel("Lương cơ bản tháng (₫)").fill("8000000");
    else await d.getByLabel("Lương theo giờ (₫)").fill("30000");
    if (account) { await d.getByLabel("Tạo tài khoản đăng nhập").check(); await d.getByLabel("Tên đăng nhập").fill(account); }
    await btn(d, "Tạo nhân viên").click();
    if (account) {
      await o.page.getByTestId("tmp-pass").waitFor();
      created.tmp = (await o.page.getByTestId("tmp-pass").innerText()).trim();
      assert(created.tmp.length >= 8, "hiện mật khẩu tạm một lần");
      await btn(o.page, "Đã ghi lại").click();
    } else await toastOk(o.page, /Đã tạo nhân viên/);
  }
  const emps = (await apiGet(o.ctx, "/employees?limit=200")).items;
  const A = emps.find((e) => e.fullName === NAME_A), B = emps.find((e) => e.fullName === NAME_B);
  assert(A && B && A.username === STAFF.u && A.baseSalary === 8000000, "2 nhân viên đã tạo, A có tài khoản & lương (chủ thấy dữ liệu nhạy cảm)");

  step("Chủ tạo kế toán + quản lý (API) và nhân viên C có tài khoản để thử nghỉ việc");
  const sid = (await apiGet(o.ctx, "/auth/me".replace(/^/, "")).catch(() => null)) ;
  const accU = await apiPost(o.ctx, "/users", { username: ACC.u, fullName: "Kế toán E2E", role: "accountant", tempPassword: ACC.tmp });
  await apiPost(o.ctx, "/users", { username: MGR.u, fullName: "Quản lý E2E", role: "manager", tempPassword: MGR.tmp });
  const C = await apiPost(o.ctx, "/employees", { fullName: NAME_C, position: "Bán hàng", storeId: A.storeId, hireDate: "2026-01-01", payType: "shift", shiftRate: 150000, createUser: { username: "c" + RUN, role: "staff" } });
  assert(accU.id && C.tempPassword, "kế toán, quản lý, NV C đã tạo");

  step("Lịch ca: chọn ô tuần này, gán ca sáng cho A và B (3 ngày)");
  await go(o.page, "/hr/schedule");
  await o.page.getByTestId("week-grid").waitFor();
  const wk = mondayOf(TODAY);
  const dayList = [TODAY, addDays(TODAY, 1), addDays(TODAY, 2)].map((d) => (d < wk || d > addDays(wk, 6) ? addDays(wk, 6) : d));
  for (const e of [A, B]) for (const d of [...new Set(dayList)]) await o.page.locator(`[data-cell="${e.id}|${d}"]`).click();
  await o.page.getByTestId("assign-bar").waitFor();
  await o.page.getByTestId("assign-bar").getByLabel("Ca sẽ gán").selectOption({ label: "Ca sáng (06:00–14:00)" });
  await btn(o.page, "Gán ca").click();
  await toastOk(o.page, /Đã gán/);
  await o.page.evaluate(() => window.scrollTo(0, 0));
  await shot(o.page, "hr-schedule.png");
  await o.page.locator(`[data-cell="${A.id}|${TODAY}"] [data-chip]`).first().waitFor();
  const sch = (await apiGet(o.ctx, `/schedule?from=${wk}&to=${addDays(wk, 6)}`)).items;
  assert(sch.filter((s) => s.employeeId === A.id).length >= 1 && sch.some((s) => s.employeeId === B.id), "lịch tuần có ca của A và B");
  await o.page.locator(`[data-cell="${A.id}|${TODAY}"] [data-chip]`).first().click();
  await o.page.getByRole("dialog").getByText("Ca bị huỷ vẫn được lưu vết").waitFor();
  await btn(dlg(o.page), "Huỷ").click();
  ok("chạm vào ca mở hộp xác nhận huỷ ca");
  await go(o.page, "/hr/schedule");
  await o.page.getByRole("tab", { name: "Mẫu ca" }).click();
  await o.page.getByText("Ca chiều").waitFor();
  ok("tab Mẫu ca hiển thị mẫu ca");

  step("Nhân viên staff đăng nhập: buộc đổi mật khẩu, chỉ thấy mục Chấm công");
  const s = await newPage(mobile, "staff");
  await login(s.page, STAFF.u, created.tmp, STAFF.np);
  await s.page.getByTestId("privacy").waitFor();
  const links = await s.page.locator(".tabbar a").allInnerTexts();
  assert(links.length === 1 && /Chấm công/.test(links[0]) && (await s.page.locator(".tabbar button").count()) === 0, `thanh dưới chỉ có "Chấm công" (${links.join(",")})`);
  assert((await s.page.getByTestId("privacy").innerText()).includes("Vị trí chỉ ghi lúc bấm chấm công"), "có ghi chú quyền riêng tư vị trí");
  await s.page.getByText("Ca sáng").first().waitFor();
  ok("hiện ca hôm nay");

  step("GPS ngoài vùng → giải thích + gửi yêu cầu bổ sung công");
  allow(422, /attendance\/punch$/, "out_of_area");
  await s.ctx.setGeolocation(FAR);
  await s.page.getByTestId("punch-btn").click();
  await s.page.getByTestId("punch-problem").waitFor();
  assert(/ngoài khu vực/.test(await s.page.getByTestId("punch-problem").innerText()), "giải thích ngoài khu vực");
  await btn(s.page, "Dùng mã QR").waitFor();
  await btn(s.page, "Gửi yêu cầu bổ sung công").click();
  await s.page.getByLabel("Ngày làm việc").fill(YESTERDAY);
  await s.page.getByLabel("Giờ thực tế (giờ VN)").fill("07:00");
  await s.page.getByLabel("Giải thích").fill("GPS lỗi nên không chấm được");
  await btn(s.page, "Gửi yêu cầu").click();
  await toastOk(s.page, /Đã gửi yêu cầu bổ sung công/);

  step("GPS trong vùng: Vào ca → Ra ca");
  await s.ctx.setGeolocation(STORE);
  await s.page.getByRole("tab", { name: "Chấm công", exact: true }).click();
  await s.page.getByTestId("punch-btn").click();
  await s.page.getByText("Đang trong ca").waitFor();
  assert((await s.page.getByTestId("punch-btn").innerText()) === "Ra ca", "nút đổi thành Ra ca");
  await shot(s.page, "hr-me.png");
  await s.page.getByTestId("punch-btn").click();
  await s.page.getByText("Chưa vào ca").waitFor();
  assert((await s.page.getByTestId("punch-btn").innerText()) === "Vào ca", "sau khi ra ca nút về Vào ca");
  const today = await apiGet(s.ctx, "/me/attendance/today");
  assert(today.punches.length === 2 && today.punches.every((p) => p.status === "accepted" && p.method === "gps"), "2 lần chấm GPS hợp lệ");

  step("Chấm công offline → lưu trên máy → gửi lại khi có mạng → tính công theo giờ bấm, chờ xem lại");
  await s.ctx.setOffline(true);
  await s.page.getByTestId("punch-btn").click();
  await s.page.getByTestId("punch-info").waitFor();
  assert(/Mất kết nối/.test(await s.page.getByTestId("punch-info").innerText()), "báo mất kết nối, đã lưu trên máy");
  assert(JSON.parse(await s.page.evaluate(() => localStorage.getItem("hm_hr_offline"))).length === 1, "hàng đợi localStorage có 1 lần chấm");
  await s.ctx.setOffline(false);
  await s.page.getByText(/Chờ gửi \(1\)/).waitFor({ state: "detached", timeout: 6000 }).catch(async () => { await btn(s.page, "Gửi ngay").click(); });
  await s.page.getByText(/Chờ gửi \(1\)/).waitFor({ state: "detached" });
  await s.page.getByText("Đã tính công · chờ xem lại").first().waitFor();
  ok("lần chấm offline tính công ngay theo giờ bấm, hiển thị 'chờ xem lại' (C-01)");

  step("Chủ duyệt lần chấm offline + yêu cầu bổ sung công (hộp Duyệt chấm công)");
  await go(o.page, "/hr/attendance");
  const pp = o.page.getByTestId("pending-punches");
  await pp.getByText(NAME_A).first().waitFor();
  await shot(o.page, "hr-attendance.png");
  await btn(pp.locator(".card").filter({ hasText: NAME_A }).first(), "Xác nhận").click();
  await toastOk(o.page, /Đã xác nhận/);
  await o.page.getByRole("tab", { name: /Bổ sung công/ }).click();
  const pc = o.page.getByTestId("pending-corrections");
  await btn(pc.locator(".card").filter({ hasText: NAME_A }).first(), "Duyệt").click();
  await toastOk(o.page, /tạo bản ghi chấm công/);
  const log = (await apiGet(o.ctx, `/attendance/punches?employeeId=${A.id}&limit=50`)).items;
  assert(log.some((p) => p.method === "manual" && p.status === "accepted") && log.some((p) => p.method === "offline" && p.status === "accepted"), "nhật ký có punch manual (bổ sung) và offline đã duyệt");
  await o.page.getByRole("tab", { name: "Nhật ký" }).click();
  await o.page.locator(".dt-cards .dt-card").first().waitFor();
  ok("tab Nhật ký tải được");

  step("Chấm công bằng mã QR (ra ca): mã lấy từ màn hình /hr/qr của cửa hàng");
  await go(o.page, "/hr/qr");
  await o.page.getByTestId("hr-qr").waitFor();
  const code = (await o.page.getByTestId("qr-code").innerText()).trim();
  assert(/^\d+\.\d+\.[\w-]+$/.test(code), "màn hình QR hiển thị mã " + code);
  await s.page.reload(); await s.page.getByTestId("punch-btn").waitFor();
  assert((await s.page.getByTestId("punch-btn").innerText()) === "Ra ca", "đang trong ca (lần offline đã được duyệt)");
  await s.page.getByRole("tab", { name: "Bằng mã QR" }).click();
  await s.page.getByLabel("Mã vạch / mã lô").fill(code);
  await btn(s.page, "Tra").click();
  await s.page.getByTestId("punch-info").waitFor();
  assert(/Đã ra ca/.test(await s.page.getByTestId("punch-info").innerText()), "ra ca bằng QR thành công");

  step("Thiết bị thứ hai → 'Thiết bị mới, đã gửi quản lý duyệt' → chủ duyệt → chấm được");
  allow(403, /attendance\/punch$/, "device_not_registered");
  const s2 = await newPage(mobile, "staff-device2");
  await login(s2.page, STAFF.u, STAFF.np);
  await s2.page.getByTestId("punch-btn").click();
  await s2.page.getByTestId("punch-info").waitFor();
  assert(/Thiết bị mới, đã gửi quản lý duyệt/.test(await s2.page.getByTestId("punch-info").innerText()), "hiện thông báo thiết bị mới");
  await go(o.page, "/hr/attendance");
  await o.page.getByRole("tab", { name: /Thiết bị/ }).click();
  await btn(o.page.getByTestId("pending-devices").locator(".card").filter({ hasText: STAFF.u }).first(), "Cho phép thiết bị").click();
  await toastOk(o.page, /Đã duyệt thiết bị/);
  await s2.page.getByTestId("punch-btn").click();
  await s2.page.getByText("Đang trong ca").waitFor();
  ok("thiết bị 2 chấm vào ca sau khi được duyệt");

  step("Nghỉ phép (bình thường + vượt số dư) và tăng ca: nhân viên gửi, chủ duyệt");
  await s.page.getByRole("tab", { name: "Xin nghỉ phép" }).click();
  await s.page.getByTestId("leave-balance").waitFor();
  assert(/12/.test(await s.page.getByTestId("leave-balance").innerText()), "hiện số dư phép 12 ngày");
  const sendLeave = async (from, to) => {
    await s.page.getByLabel("Từ ngày").fill(from); await s.page.getByLabel("Đến ngày").fill(to);
    await btn(s.page, "Gửi đơn xin nghỉ").click();
  };
  await sendLeave(addDays(TODAY, 100), addDays(TODAY, 100));
  await toastOk(s.page, /Đã gửi đơn xin nghỉ/);
  await sendLeave(addDays(TODAY, 120), addDays(TODAY, 140));
  await toastOk(s.page, /vượt số ngày phép/);
  await s.page.getByRole("tab", { name: "Đăng ký tăng ca" }).click();
  await s.page.getByLabel("Ngày làm").fill(YESTERDAY);
  await btn(s.page, "Gửi đăng ký").click();
  await toastOk(s.page, /Đã gửi đăng ký tăng ca/);
  await go(o.page, "/hr/attendance");
  await o.page.getByRole("tab", { name: /Nghỉ phép/ }).click();
  const pl = o.page.getByTestId("pending-leaves");
  const overCard = pl.locator(".card").filter({ hasText: "Vượt số dư phép" });
  await overCard.waitFor();
  // C-08: số dư được kiểm lại lúc duyệt → duyệt đơn thường trước, đơn vượt số dư cần lý do ngoại lệ
  await btn(pl.locator(".card").filter({ hasText: NAME_A }).filter({ hasNotText: "Vượt số dư phép" }).first(), "Duyệt").click();
  await toastOk(o.page, /Đã duyệt đơn nghỉ/);
  await btn(overCard, "Duyệt ngoại lệ…").click();
  await dlg(o.page).getByText(/vượt số dư phép năm còn lại/).waitFor();
  await dlg(o.page).getByLabel("Lý do ngoại lệ (bắt buộc)").fill("Nghỉ chăm người nhà, chủ đồng ý");
  await btn(dlg(o.page), "Duyệt ngoại lệ").click();
  await toastOk(o.page, /Đã duyệt ngoại lệ/);
  await o.page.getByRole("tab", { name: /Tăng ca/ }).click();
  await btn(o.page.getByTestId("pending-ot").locator(".card").filter({ hasText: NAME_A }).first(), "Duyệt").click();
  await toastOk(o.page, /Đã duyệt tăng ca/);
  const lv = (await apiGet(o.ctx, "/leave-requests?status=approved")).items.filter((l) => l.employeeId === A.id);
  assert(lv.length === 2 && lv.some((l) => l.overBalance), "2 đơn nghỉ đã duyệt (1 ngoại lệ)");

  step("Nghỉ việc nhân viên C: hộp xác nhận nêu rõ khoá tài khoản");
  await go(o.page, "/hr/employees");
  await o.page.locator(".dt-cards .dt-card").filter({ hasText: NAME_C }).click();
  await btn(dlg(o.page), "Cho nghỉ việc").click();
  const tdlg = o.page.getByRole("dialog").last();
  await tdlg.getByText(/bị khoá ngay/).waitFor();
  await tdlg.getByLabel("Lý do").fill("Nghỉ theo nguyện vọng");
  await btn(tdlg, "Xác nhận nghỉ việc").click();
  await toastOk(o.page, /Đã cho nghỉ việc/);
  const lr = await o.ctx.request.post(BASE + "/api/auth/login", { headers: hdr, data: { username: "c" + RUN, password: C.tempPassword, deviceId: "x" } });
  assert(lr.status() >= 400, `tài khoản NV C bị khoá sau khi nghỉ việc (HTTP ${lr.status()})`);

  step(`Seed công tháng ${PAST} (SQL) rồi chủ chốt bảng công: thiếu giờ ra → 409 → chốt cưỡng chế`);
  const st = [], pad = (n) => String(n).padStart(2, "0");
  const days = [1, 2, 3, 4, 5, 8].map((d) => `${PAST}-${pad(d)}`);
  const sa = (e, d) => { const { s: a, e: b } = startEnd(d); return `INSERT OR IGNORE INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at, break_minutes) VALUES (${e}, '${d}', 1, '${a}', '${b}', 30)`; };
  const pu = (e, d, kind, at) => `INSERT INTO attendance_punches(employee_id, kind, server_at, method, status, assignment_id) VALUES (${e}, '${kind}', '${at}', 'manual', 'accepted', (SELECT id FROM shift_assignments WHERE employee_id=${e} AND work_date='${d}' LIMIT 1))`;
  for (const d of days) {
    const { s: a, e: b } = startEnd(d);
    st.push(sa(A.id, d), pu(A.id, d, "in", a), pu(A.id, d, "out", b));
  }
  for (const d of days.slice(0, 3)) { const { s: a, e: b } = startEnd(d); st.push(sa(B.id, d), pu(B.id, d, "in", a), pu(B.id, d, "out", b)); }
  { const d = days[3]; const { s: a } = startEnd(d); st.push(sa(B.id, d), pu(B.id, d, "in", a)); } // thiếu giờ ra
  sql(st);
  allow(409, /timesheets\/.*\/close$/, "unresolved_items");
  const w = await newPage(desktop, "owner-desktop");
  await login(w.page, OWNER.u, OWNER.p);
  await go(w.page, `/hr/timesheets?period=${PAST}`);
  await w.page.locator(".dt-table tbody tr").first().waitFor();
  const rowA = w.page.locator(".dt-table tbody tr").filter({ hasText: NAME_A });
  assert((await rowA.innerText()).includes("45g"), "bảng công: A có giờ làm (6 ngày × 7g30 = 45g)");
  await w.page.locator(".dt-table tbody tr").filter({ hasText: NAME_B }).getByText("1 ngày").waitFor();
  ok("bảng công: B thiếu công 1 ngày");
  await shot(w.page, "hr-timesheets-d.png");
  await rowA.click();
  await w.page.locator('aside.detail-panel, [role="dialog"]').last().locator(".dt-table tbody tr").first().waitFor(); // màn rộng: panel chi tiết thay cho hộp thoại
  ok("drill-down từng ngày");
  await w.page.keyboard.press("Escape");
  await btn(w.page, "Chốt bảng công").click();
  await btn(dlg(w.page), "Chốt bảng công").click();
  await w.page.getByTestId("unresolved").waitFor();
  assert(/thiếu giờ ra/.test(await w.page.getByTestId("unresolved").innerText()), "409 liệt kê mục chưa xử lý (thiếu giờ ra)");
  await w.page.getByTestId("force-close").waitFor();
  assert(await w.page.getByTestId("force-close").isDisabled(), "chốt cưỡng chế cần lý do");
  await dlg(w.page).getByLabel(/Lý do chốt cưỡng chế/).fill("Đã đối chiếu thủ công với sổ giấy");
  await w.page.getByTestId("force-close").click();
  await toastOk(w.page, /Đã chốt bảng công/);
  await w.page.getByText("Đã chốt", { exact: true }).first().waitFor();
  const tsr = await apiGet(w.ctx, `/timesheets/${PAST}`);
  assert(tsr.status === "closed", "bảng công đã chốt");

  step("Kế toán: không thấy duyệt lương; tháng chưa chốt → 409 timesheet_open; tính lương kỳ đã chốt");
  allow(409, /payroll\/periods\/.*\/calculate$/, "timesheet_open");
  const k = await newPage(desktop, "accountant");
  await login(k.page, ACC.u, ACC.tmp, ACC.np);
  await go(k.page, "/payroll");
  await k.page.getByTestId("calc-new").waitFor();
  await k.page.getByLabel("Kỳ lương").fill(TODAY.slice(0, 7));
  await k.page.getByTestId("calc-new").click();
  await k.page.getByText(/chưa chốt nên chưa tính lương/).waitFor();
  await k.page.getByRole("link", { name: "Mở bảng công để chốt" }).waitFor();
  ok("hiện liên kết tới bảng công khi timesheet_open");
  // khoản thưởng cho A
  await k.page.getByRole("tab", { name: "Thưởng / phạt" }).click();
  await k.page.getByLabel("Kỳ", { exact: true }).fill(PAST);
  await btn(k.page, "+ Thêm khoản").click();
  const ed = dlg(k.page);
  await ed.getByLabel("Nhân viên").selectOption({ label: NAME_A });
  await ed.getByLabel("Số tiền (₫)").fill("200000");
  await ed.getByLabel("Lý do").fill("Thưởng chuyên cần");
  await btn(ed, "Lưu").click();
  await toastOk(k.page, /Đã thêm khoản/);
  await k.page.getByRole("tab", { name: "Kỳ lương" }).click();
  await k.page.getByLabel("Kỳ lương").fill(PAST);
  await k.page.getByTestId("calc-new").click();
  await k.page.getByTestId("total-net").waitFor();
  assert((await btn(k.page, "Duyệt bảng lương").count()) === 0, "kế toán không thấy nút Duyệt bảng lương");
  const xl = k.page.locator("#main").getByRole("link", { name: "Xuất Excel" });
  const xr = await k.ctx.request.get(BASE + (await xl.getAttribute("href")));
  assert(xr.ok() && /spreadsheetml/.test(xr.headers()["content-type"]), "liên kết Xuất Excel tải được file xlsx");
  const net = await k.page.getByTestId("total-net").innerText();
  assert(/\d/.test(net) && !/^0\s*₫/.test(net), "tổng thực lĩnh có số: " + net);
  const pay = await apiGet(k.ctx, `/payroll/periods/${PAST}`);
  assert(pay.status === "calculated" && pay.items.length >= 2 && pay.items.find((i) => i.employeeId === A.id).bonus === 200000, "bảng lương đã tính, A có thưởng 200.000");

  // C-21: kế toán chỉ xem hồ sơ, không thấy nút tạo/sửa/nghỉ việc; trang không có quyền báo rõ thay vì quay mãi
  await go(k.page, "/hr/employees");
  await k.page.locator(".dt-table tbody tr").first().waitFor();
  assert((await btn(k.page, "+ Thêm nhân viên").count()) === 0, "C-21: kế toán không thấy nút + Thêm nhân viên");
  await k.page.locator(".dt-table tbody tr").first().click();
  await k.page.getByText("Hồ sơ", { exact: false }).first().waitFor().catch(() => {});
  assert((await btn(k.page, "Sửa hồ sơ").count()) === 0 && (await btn(k.page, "Cho nghỉ việc").count()) === 0, "C-21: kế toán không thấy Sửa hồ sơ / Cho nghỉ việc");
  await shot(k.page, "fix6b-accountant-employees-d.png");
  await go(k.page, "/hr/stores");
  await k.page.getByText("Bạn không có quyền xem trang này").waitFor();
  ok("trang không có quyền (/hr/stores) hiện thông báo thay vì spinner");
  await shot(k.page, "fix6b-no-access-d.png");
  step("Chủ duyệt bảng lương rồi chi lương (chọn quỹ); tạm ứng; chi phí");
  await go(w.page, "/payroll");
  await w.page.getByTestId("period-list").waitFor();
  await w.page.getByTestId("period-list").getByText(`Tháng ${PAST.slice(5)}/${PAST.slice(0, 4)}`).click();
  await w.page.getByTestId("total-net").waitFor();
  await w.page.locator(".dt-table tbody tr").filter({ hasText: NAME_A }).click();
  await w.page.getByTestId("payroll-row").waitFor();
  assert((await w.page.getByTestId("payroll-row").innerText()).includes("Lương cơ bản"), "chi tiết dòng lương có diễn giải");
  await w.page.keyboard.press("Escape");
  await w.page.getByTestId("approve").click();
  await btn(dlg(w.page), "Duyệt & khoá kỳ").click();
  await toastOk(w.page, /Đã duyệt bảng lương/);
  await w.page.getByTestId("pay").click();
  await dlg(w.page).getByLabel("Chi từ quỹ").waitFor();
  await btn(dlg(w.page), "Chi lương").click();
  await toastOk(w.page, /phiếu chi lương/);
  await w.page.getByText("Đã chi", { exact: true }).first().waitFor();
  await shot(w.page, "hr-payroll-d.png");
  assert((await apiGet(w.ctx, `/payroll/periods/${PAST}`)).status === "paid", "kỳ lương đã chi");
  await btn(w.page, "← Các kỳ lương").click();
  await w.page.getByRole("tab", { name: "Tạm ứng" }).click();
  await btn(w.page, "+ Tạm ứng lương").click();
  await dlg(w.page).getByLabel("Nhân viên").selectOption({ label: NAME_B });
  await dlg(w.page).getByLabel("Số tiền (₫)").fill("500000");
  await btn(dlg(w.page), "Chi tạm ứng").click();
  await toastOk(w.page, /Đã chi tạm ứng/);
  await w.page.getByRole("tab", { name: "Chi phí nhân sự" }).click();
  await w.page.locator("svg.chart").waitFor();
  ok("biểu đồ chi phí nhân sự hiển thị");

  step("Nhân viên xem phiếu lương (chỉ kỳ đã duyệt/chi)");
  await s.page.getByRole("tab", { name: "Phiếu lương" }).click();
  await s.page.getByTestId("payslip-list").waitFor();
  await s.page.getByTestId("payslip-list").locator("button").first().click();
  await s.page.getByTestId("payslip-detail").waitFor();
  assert((await s.page.getByTestId("payslip-detail").innerText()).includes("Thưởng: Thưởng chuyên cần"), "phiếu lương có dòng thưởng chuyên cần");
  await shot(s.page, "hr-me-payslip.png");

  await s.page.keyboard.press("Escape");
  await s.page.getByRole("tab", { name: "Đổi ca" }).click();
  await s.page.getByText("Yêu cầu đổi ca của tôi").waitFor();
  await s.page.getByRole("tab", { name: "Đăng ký tăng ca" }).click();
  await s.page.getByText("Đã đăng ký", { exact: true }).waitFor();
  ok("tab Đổi ca và lịch sử tăng ca tải từ API mới");

  step("Quản lý (không có hr.sensitive): không thấy lương, không có mục Bảng lương");
  const m = await newPage(desktop, "manager");
  await login(m.page, MGR.u, MGR.tmp, MGR.np);
  await go(m.page, "/hr/employees");
  await m.page.getByText("Bạn không có quyền xem lương").waitFor();
  assert((await m.page.locator(".dt-table th", { hasText: "Lương" }).count()) === 0, "bảng nhân viên không có cột Lương");
  assert((await m.page.locator(".sidebar a", { hasText: "Bảng lương" }).count()) === 0, "menu không có Bảng lương");
  const me = await apiGet(m.ctx, `/employees/${A.id}`);
  assert(me.baseSalary === undefined && me.bankAccount === undefined && me.idNumber === undefined, "API không trả trường nhạy cảm cho quản lý");

  step("Màn hình rộng: bảng nhân viên + nhóm Nhân sự trong sidebar");
  await go(w.page, "/hr/employees");
  await w.page.locator(".dt-table tbody tr").first().waitFor();
  assert(await w.page.locator(".sidebar").getByText("Nhân sự", { exact: true }).isVisible(), "sidebar có nhóm Nhân sự");
} catch (e) {
  if (!String(e.message).startsWith("assert:")) fail("LỖI: " + (e.stack ?? e.message));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n✗ ${failures.length} lỗi:\n${failures.map((f) => " - " + f).join("\n")}` : "\n✓ E2E nhân sự: tất cả đạt");
process.exit(failures.length ? 1 : 0);
