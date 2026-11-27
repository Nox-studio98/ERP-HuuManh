// Ảnh + kiểm EC-39 (màn chuyển việc) và vùng chạm checkbox >= 40px ở 390. Chạy trên DB mới:
//   bash scripts/e2e-db.sh .wrangler/e-g9h 9051 && BASE=http://localhost:9051 PERSIST=.wrangler/e-g9h node e2e/handover-shots.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:9051", PERSIST = process.env.PERSIST ?? ".wrangler/e-g9h";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."), DIR = join(ROOT, "docs", "screenshots");
const OWNER = { u: "chu", p: process.env.OWNER_PASS ?? "ChuCuaHang-2026" };
const hdr = { "X-Requested-With": "hm-erp", "Content-Type": "application/json" };
let bad = 0;
const check = (c, m) => { console.log((c ? "  ✓ " : "  ✗ ") + m); if (!c) bad++; };
const sql = (s) => { const f = join(ROOT, ".wrangler", "handover-e2e.sql"); writeFileSync(f, s.join(";\n") + ";\n"); try { execFileSync("npx", ["wrangler", "d1", "execute", "huu-manh-erp", "--local", "--persist-to", PERSIST, `--file=${f}`], { cwd: ROOT, stdio: "pipe" }); } catch (e) { console.error(String(e.stdout) + String(e.stderr)); throw e; } };
const browser = await chromium.launch();
const ctxOpts = (w, h, mobile) => ({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile, serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
async function open(w, h, mobile) {
  const ctx = await browser.newContext(ctxOpts(w, h, mobile)); const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => { console.error("pageerror", e.message); bad++; });
  await page.goto(BASE + "/"); await page.getByLabel("Tên đăng nhập").fill(OWNER.u); await page.getByLabel("Mật khẩu").fill(OWNER.p);
  await page.getByRole("button", { name: "Đăng nhập" }).click(); await page.locator("main#main").waitFor();
  return { ctx, page };
}
const shot = async (p, n) => { await p.waitForTimeout(500); await p.screenshot({ path: join(DIR, n) }); };
const { ctx: api } = await open(1440, 900);
const post = async (path, data) => { const r = await api.request.post(BASE + "/api/v1" + path, { headers: hdr, data }); if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`); return r.json(); };
const RUN = Date.now().toString(36).slice(-4);
await post("/users", { username: "ql" + RUN, fullName: "Quản lý Hoa", role: "manager", tempPassword: "QuanLy-Tam-2026" });
const names = { pc: `Phạm Văn Đức ${RUN}`, mb: `Lê Thị Mai ${RUN}` };
for (const [k, n] of Object.entries(names)) await post("/users", { username: "nv" + k + RUN, fullName: n, role: "manager", tempPassword: "NhanVien-Tam-2026" });
const U = (k) => `(SELECT id FROM users WHERE username='nv${k}${RUN}')`;
const fut = (n) => new Date(Date.now() + (n + 0.3) * 86400000).toISOString().slice(0, 10);
const stmts = [`INSERT OR IGNORE INTO shift_templates(id, code, name, start_time, end_time) VALUES (990,'HO1','Ca sáng','08:00','12:00')`];
let id = 9000;
for (const k of ["pc", "mb"]) {
  const e = ++id;
  stmts.push(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date) VALUES (${e},'NV-HO${e}',${U(k)},'${names[k]}','Quản lý ca',1,'2026-01-01')`);
  stmts.push(`INSERT INTO customers(id, code, type, name, owner_user_id) VALUES (${e},'KH-HO${e}','b2b','Quán Cơm Hạnh Phúc ${k}',${U(k)}),(${e + 50},'KH-HO${e + 50}','b2b','Nhà hàng Bình An ${k}',${U(k)})`);
  stmts.push(`INSERT INTO quotes(id, code, customer_id, status, valid_from, valid_until, created_by) VALUES (${e},'BG-HO${e}',${e},'draft','2026-11-01','2026-12-30',${U(k)})`);
  stmts.push(`INSERT INTO stock_docs(id, code, type, status, store_id, created_by) VALUES (${e},'PN-HO${e}','receipt','draft',1,${U(k)}),(${e + 50},'PN-HO${e + 50}','receipt','pending_approval',1,${U(k)})`);
  stmts.push(`INSERT INTO orders(id, code, channel, store_id, status, created_by) VALUES (${e},'SO-HO${e}','b2b',1,'new',${U(k)})`);
  stmts.push(`INSERT INTO approvals(id, type, status, requested_by) VALUES (${e},'price_below_cost','pending',${U(k)})`);
  stmts.push(`INSERT INTO recurring_orders(id, customer_id, weekdays, lines_json, created_by) VALUES (${e},${e},'1,4','[]',${U(k)})`);
  stmts.push(`INSERT INTO shift_assignments(employee_id, work_date, shift_template_id, start_at, end_at) VALUES (${e},'${fut(2)}',990,'${fut(2)}T01:00:00Z','${fut(2)}T05:00:00Z'),(${e},'${fut(3)}',990,'${fut(3)}T01:00:00Z','${fut(3)}T05:00:00Z')`);
}
sql(stmts);

for (const [tag, w, h, mobile, k] of [["1440", 1440, 900, false, "pc"], ["390", 390, 844, true, "mb"]]) {
  console.log("\n== " + tag);
  const { page } = await open(w, h, mobile);
  await page.goto(BASE + "/hr/employees"); await page.locator("main#main").waitFor();
  await page.getByText(names[k]).locator("visible=true").first().click();
  await page.getByTestId("open-handover").click();
  await page.getByTestId("handover").waitFor();
  await page.getByTestId("handover-customers").waitFor();
  check(true, "nhóm khách sỉ hiển thị");
  await shot(page, `handover-${tag}.png`);
  await page.getByTestId("handover-all").selectOption({ label: /Quản lý Hoa/ }).catch(async () => { const v = await page.getByTestId("handover-all").locator("option", { hasText: "Quản lý Hoa" }).getAttribute("value"); await page.getByTestId("handover-all").selectOption(v); });
  await page.getByTestId("handover-stock_docs").getByRole("combobox").selectOption({ index: 2 }).catch(() => {});
  await page.getByTestId("handover-quotes").getByRole("combobox").selectOption("cancel");
  await page.getByTestId("handover-shifts").getByRole("combobox").selectOption({ index: 1 });
  await page.getByLabel("Lý do bàn giao (ghi vào nhật ký)").fill("Nghỉ việc, bàn giao cho quản lý");
  await shot(page, `handover-chon-${tag}.png`);
  await page.getByTestId("handover-submit").click();
  await page.locator(".toast").filter({ hasText: "Đã chuyển việc" }).first().waitFor();
  check(true, "đã chuyển việc (toast)");
  await page.getByTestId("handover").waitFor({ state: "detached" });
  await page.getByTestId("open-handover").click();
  await page.getByText("Không còn việc nào cần chuyển").waitFor().catch(() => { bad++; console.log("  ✗ chưa hết việc"); });
  await shot(page, `handover-xong-${tag}.png`);
}

console.log("\n== Checkbox 390");
const { page: m } = await open(390, 844, true);
const small = async (label) => {
  const r = await m.evaluate(() => [...document.querySelectorAll('input[type="checkbox"]')].filter((i) => i.offsetParent !== null).map((i) => { const b = (i.closest("label") ?? i).getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; }));
  check(r.length > 0 && r.every((x) => x.w >= 40 && x.h >= 40), `${label}: ${r.length} checkbox, nhỏ nhất ${Math.min(...r.map((x) => Math.min(x.w, x.h)))}px`);
};
await m.goto(BASE + "/orders"); await m.locator("main#main").waitFor();
await m.getByRole("button", { name: "Chọn nhiều" }).click().catch(() => {});
await m.waitForTimeout(600);
const hasRows = await m.locator('input[type="checkbox"]').count();
if (hasRows) await small("Đơn hàng (chọn nhiều)"); else console.log("  (không có đơn nào để chọn trên DB này)");
await m.locator('input[type="checkbox"]').first().scrollIntoViewIfNeeded().catch(() => {});
await shot(m, "checkbox-orders-390.png");
await m.goto(BASE + "/settings"); await m.locator("main#main").waitFor(); await m.waitForTimeout(500);
await small("Cài đặt");
await m.locator('input[type="checkbox"]').first().scrollIntoViewIfNeeded().catch(() => {});
await shot(m, "checkbox-settings-390.png");
await m.goto(BASE + "/users"); await m.locator("main#main").waitFor();
await m.getByText("Quản lý Hoa").locator("visible=true").first().click(); await m.waitForTimeout(400);
await small("Người dùng (form)");
await shot(m, "checkbox-users-390.png");
await browser.close();
console.log(bad ? `\n✗ ${bad} lỗi` : "\n✓ Handover + checkbox: tất cả đạt");
process.exit(bad ? 1 : 0);
