// Chụp mọi màn trong NAV + hộp thoại chính ở 1920/1440/390 để rà UX. Chạy sau smoke/b2b/pos-kv trên cùng DB.
// Dùng: BASE=http://localhost:8961 OUT=/tmp/ux node e2e/ux-audit-shots.mjs   (SIZES=1920,1440,390)
// In ra tràn ngang, lỗi console/HTTP, vùng chạm < 36px ở 390.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:8961";
const OUT = process.env.OUT ?? "/tmp/ux-shots"; mkdirSync(OUT, { recursive: true });
const common = { serviceWorkers: "block", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" };
const all = {
  "1920": { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, ...common },
  "1440": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...common },
  "390": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...common },
};
const want = (process.env.SIZES ?? "1920,1440,390").split(",");
const nav = readFileSync("src/web/App.tsx", "utf8");
const paths = [...nav.matchAll(/\{ path: "([^"]+)", label: "([^"]+)"/g)].map((m) => [m[1], m[2]]);
const slug = (p) => p.replace(/^\//, "").replace(/\//g, "_") || "root";
const log = { over: [], errs: [], small: [], noLabel: [], notes: [] };
const browser = await chromium.launch();
for (const tag of want) {
  const ctx = await browser.newContext(all[tag]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  let cur = "login";
  page.on("pageerror", (e) => log.errs.push(`[${tag}] ${cur} pageerror ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") log.errs.push(`[${tag}] ${cur} console ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !/auth\/me$/.test(r.url())) log.errs.push(`[${tag}] ${cur} ${r.status()} ${r.url().replace(BASE, "")}`); });
  const shot = async (name) => {
    cur = name;
    await page.locator(".toast").first().waitFor({ state: "detached", timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(250);
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (w[0] > w[1]) log.over.push(`[${tag}] ${name}: ${w[0]} > ${w[1]}`);
    if (tag === "390") {
      const r = await page.evaluate(() => {
        const small = [], nl = [];
        for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, [role=button], [role=tab]")) {
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height || b.bottom < 0 || b.top > innerHeight) continue;
          const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none") continue;
          const txt = (el.innerText || "").trim() || el.getAttribute("aria-label") || el.getAttribute("title") || el.labels?.[0]?.innerText || el.getAttribute("placeholder");
          const id = (el.tagName + "." + (el.className?.toString?.().split(" ")[0] || "") + ":" + (txt || "").slice(0, 25));
          if (b.height < 36 || (b.width < 36 && el.tagName !== "INPUT")) small.push(`${id} ${Math.round(b.width)}x${Math.round(b.height)}`);
          if (!txt) nl.push(id);
        }
        return { small: [...new Set(small)].slice(0, 12), nl: [...new Set(nl)].slice(0, 8) };
      });
      if (r.small.length) log.small.push(`${name}: ${r.small.join(" | ")}`);
      if (r.nl.length) log.noLabel.push(`${name}: ${r.nl.join(" | ")}`);
    }
    await page.screenshot({ path: join(OUT, `${name}-${tag}.png`) });
  };
  const go = async (p) => { cur = p; await page.goto(BASE + p); await page.locator("main#main").waitFor().catch(() => {}); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(700); };
  const close = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(200); };
  const click = async (name, scope = page) => { const b = scope.getByRole("button", { name }).first(); await b.click({ timeout: 3000 }); await page.waitForTimeout(500); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { log.notes.push(`[${tag}] ${name}: ${e.message.split("\n")[0]}`); await close(); } };
  await page.goto(BASE + "/");
  await page.getByLabel("Tên đăng nhập").fill("chu");
  await page.getByLabel("Mật khẩu").fill("ChuCuaHang-2026");
  await shot("login-filled");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.locator("main#main").waitFor();
  await page.waitForTimeout(700);
  for (const [p] of paths) {
    const n = slug(p);
    await step(n, async () => {
      await go(p); await shot(n);
      const row = page.locator("tr.click:visible, button.dt-card:visible").first();
      if (await row.count()) { await row.click().catch(() => {}); await page.waitForTimeout(800); await shot(n + "--chi-tiet"); }
    });
  }
  // --- hộp thoại chính ---
  await step("pos", async () => {
    await go("/pos");
    await page.locator("button.ptile").first().click(); await page.waitForTimeout(300); await page.getByRole("dialog").getByRole("button",{name:"1 kg"}).click({timeout:1500}).catch(()=>{}); await page.getByRole("dialog").getByRole("button",{name:/^Thêm /}).click({timeout:1500}).catch(()=>{}); await page.waitForTimeout(400);
    const xg = page.getByRole("button", { name: /^Xem giỏ/ }); if (await xg.isVisible().catch(() => false)) await xg.click();
    await page.waitForTimeout(300); await shot("dlg-pos-gio");
    await click(/^Thanh toán/); await shot("dlg-pos-thanh-toan");
    const names = await page.getByRole("dialog").getByRole("button").allInnerTexts();
    log.notes.push(`[${tag}] nút Thanh toán: ${names.join(" / ")}`);
    for (const [lbl, nm] of [[/Ghi nợ|Công nợ/, "ghi-no"], [/Giao hàng|Giao/, "giao-hang"], [/Chuyển khoản/, "chuyen-khoan"], [/Thẻ/, "the"]]) {
      await step("pos-" + nm, async () => { await page.getByRole("dialog").getByText(lbl).first().click({ timeout: 2000 }); await page.waitForTimeout(400); await shot("dlg-pos-" + nm); });
    }
    await close();
  });
  await step("debts", async () => {
    await go("/debts");
    const row = page.locator("tr.click:visible, button.dt-card:visible").first(); await row.click(); await page.waitForTimeout(600);
    await click(/^Thu (tiền|nợ)/); await shot("dlg-thu-no"); await close();
  });
  await step("finance", async () => {
    await go("/finance");
    await click(/Chuyển quỹ/); await shot("dlg-chuyen-quy"); await close();
    await click(/Phiếu thu/); await shot("dlg-phieu-thu"); await close();
    await click(/Phiếu chi/); await shot("dlg-phieu-chi"); await close();
  });
  await step("inventory-xuat", async () => { await go("/inventory"); await click("Xuất dùng nội bộ"); await shot("dlg-xuat-noi-bo"); await close(); });
  await step("inventory-nhap", async () => { await go("/inventory"); await click(/Nhập kho|Nhập hàng/); await shot("dlg-nhap-kho"); await close(); });
  await step("import", async () => { await go("/import"); await shot("dlg-import-0"); });
  await step("orders-bulk", async () => {
    await go("/orders"); await click("Chọn nhiều");
    const cbs = page.locator('input[type=checkbox]:visible'); await cbs.nth(1).check().catch(() => {}); await cbs.nth(2).check().catch(() => {});
    await shot("dlg-chon-nhieu"); await click("Sửa người bán / ghi chú"); await shot("dlg-sua-nguoi-ban"); await close();
  });
  await step("delivery", async () => {
    await go("/deliveries"); const row = page.locator("tr.click:visible, button.dt-card:visible, .card button:visible").first();
    const names = await page.getByRole("button").allInnerTexts(); log.notes.push(`[${tag}] nút Soạn & giao: ${names.slice(0, 15).join(" / ")}`);
  });
  await step("shift-close", async () => { await go("/shift-close"); await shot("shift-close"); });
  await step("palette", async () => { await go("/dashboard"); await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await shot("dlg-tim-nhanh"); await close(); });
  await ctx.close();
}
await browser.close();
writeFileSync(join(OUT, "_log.json"), JSON.stringify(log, null, 1));
console.log(JSON.stringify(log, null, 1).slice(0, 9000));
