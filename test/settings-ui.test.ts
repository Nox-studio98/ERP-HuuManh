import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { DEF_BY_KEY, GROUPS, SETTING_DEFS, isInternalKey } from "../src/worker/services/settings-registry";
import { vnPeriod } from "../src/worker/lib/time";

beforeAll(seedBase);

const sqlFiles = import.meta.glob(["../migrations/*.sql", "../seed/*.sql"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const S = "/api/v1/settings";
const flat = (b: any) => b.groups.flatMap((g: any) => g.items);

describe("settings registry", () => {
  it("covers every key present in DB after migrations", async () => {
    const { results } = await testEnv.DB.prepare(`SELECT key FROM settings`).all<{ key: string }>();
    const missing = results.map((r) => r.key).filter((k) => !DEF_BY_KEY.has(k) && !isInternalKey(k));
    expect(missing, `Khoá chưa có trong settings-registry.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("covers every key inserted by migrations and seed files", () => {
    const keys = new Set<string>();
    for (const sql of Object.values(sqlFiles)) {
      for (const stmt of sql.split(/;\s*\n/)) {
        if (!/INSERT\s+(OR\s+\w+\s+)?INTO\s+settings/i.test(stmt)) continue;
        for (const m of stmt.matchAll(/\(\s*'([a-z0-9_.]+)'\s*,/g)) keys.add(m[1]);
      }
    }
    expect(keys.size).toBeGreaterThan(50);
    const missing = [...keys].filter((k) => !DEF_BY_KEY.has(k));
    expect(missing, `Khoá chưa có trong settings-registry.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every def has group, label and valid constraints", () => {
    for (const d of SETTING_DEFS) {
      expect(GROUPS).toContain(d.group);
      expect(d.label.length).toBeGreaterThan(3);
      expect(d.help.length).toBeGreaterThan(3);
      if (d.type === "enum" || d.type === "multi") expect(d.options?.length).toBeGreaterThan(0);
    }
    expect(new Set(SETTING_DEFS.map((d) => d.key)).size).toBe(SETTING_DEFS.length);
  });
});

describe("GET /settings", () => {
  it("owner and manager read grouped values; others forbidden", async () => {
    const r = await api("owner", "GET", S);
    expect(r.status).toBe(200);
    expect(r.body.groups.map((g: any) => g.group)).toEqual([...GROUPS]);
    expect(r.body.canWrite).toBe(true);
    const cash = flat(r.body).find((i: any) => i.key === "approval.cash_out_vnd");
    expect(cash).toMatchObject({ type: "vnd", needsConfirm: true });
    expect(r.body.items.length).toBeGreaterThan(50);
    const m = await api("manager", "GET", S);
    expect(m.status).toBe(200);
    expect(m.body.canWrite).toBe(false);
    for (const role of ["cashier", "accountant", "warehouse"]) expect((await api(role, "GET", S)).status).toBe(403);
  });

  it("lists unknown keys raw and masks secret-looking ones; hides internal keys", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT OR REPLACE INTO settings(key, value, note) VALUES ('legacy.flag','x','cũ')`),
      testEnv.DB.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('legacy.api_token','SUPER-SECRET-123')`),
      testEnv.DB.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('competitor.robots_at.9','2026-01-01')`),
    ]);
    const r = await api("owner", "GET", S);
    const txt = JSON.stringify(r.body);
    expect(txt).not.toContain("SUPER-SECRET-123");
    expect(r.body.unknown.find((u: any) => u.key === "legacy.flag").value).toBe("x");
    expect(r.body.unknown.find((u: any) => u.key === "legacy.api_token").value).toBe("***");
    expect(r.body.unknown.some((u: any) => u.key.startsWith("competitor.robots_at"))).toBe(false);
    // khoá lạ không ghi được
    const w = await api("owner", "PUT", S, { settings: { "legacy.flag": "y" } });
    expect(w.status).toBe(422);
    expect(w.body.error.details.fields["legacy.flag"]).toBeTruthy();
    // không rò secret qua audit
    expect(JSON.stringify((await api("owner", "GET", "/api/v1/audit?entity=settings")).body)).not.toContain("SUPER-SECRET-123");
  });
});

describe("PUT /settings", () => {
  it("is owner-only", async () => {
    expect((await api("manager", "PUT", S, { settings: { "approval.cash_out_vnd": 1 } })).status).toBe(403);
    expect((await api("accountant", "PUT", S, { settings: { "approval.cash_out_vnd": 1 } })).status).toBe(403);
  });

  it("returns 422 with per-field errors and writes nothing", async () => {
    const before = await api("owner", "GET", S);
    const r = await api("owner", "PUT", S, {
      settings: { "approval.cash_out_vnd": -5, "hr.ot_weekday_bp": 100, "costing.method": "fifo", "pos.allow_offline": "2", "debt.aging_buckets": "60,30", "hr.pit_brackets_json": "[[1,500]]", "approval.waste_pct_bp": 700 },
    });
    expect(r.status).toBe(422);
    const f = r.body.error.details.fields;
    expect(Object.keys(f).sort()).toEqual(["approval.cash_out_vnd", "costing.method", "debt.aging_buckets", "hr.ot_weekday_bp", "hr.pit_brackets_json", "pos.allow_offline"].sort());
    const after = await api("owner", "GET", S);
    expect(after.body.items).toEqual(before.body.items); // không ghi một phần
  });

  it("validates PIT brackets table", async () => {
    const bad = (v: unknown) => api("owner", "PUT", S, { settings: { "hr.pit_brackets_json": v as any } });
    expect((await bad("[[10000000,500],[5000000,1000],[null,2000]]")).status).toBe(422); // trần giảm
    expect((await bad("[[10000000,500],[20000000,1000]]")).status).toBe(422); // bậc cuối có trần
    expect((await bad("[[10000000,500],[null,20000]]")).status).toBe(422); // thuế suất > 100%
    expect((await bad("not json")).status).toBe(422);
    const ok = await bad("[[10000000,500],[30000000,1000],[null,2000]]");
    expect(ok.status).toBe(200);
    expect(flat(ok.body).find((i: any) => i.key === "hr.pit_brackets_json").value).toBe("[[10000000,500],[30000000,1000],[null,2000]]");
    await bad("[[10000000,500],[30000000,1000],[60000000,2000],[100000000,3000],[null,3500]]");
  });

  it("writes changed keys with per-key before/after audit and confirmation marker", async () => {
    const g0 = await api("owner", "GET", S);
    const it0 = flat(g0.body).find((i: any) => i.key === "approval.discount_pct_bp");
    expect(it0.needsConfirm).toBe(true);
    expect(it0.pending).toBe(true);
    const pend0 = g0.body.pendingCount;
    const oldVal = it0.value;
    const r = await api("owner", "PUT", S, { settings: { "approval.discount_pct_bp": 1200, "hr.ot_weekday_bp": "16000" } });
    expect(r.status).toBe(200);
    const it1 = flat(r.body).find((i: any) => i.key === "approval.discount_pct_bp");
    expect(it1).toMatchObject({ value: "1200", confirmed: true, pending: false, needsConfirm: true });
    expect(it1.confirmedByName).toBe("Test owner");
    expect(r.body.pendingCount).toBe(pend0 - 2);
    const a = await api("manager", "GET", "/api/v1/audit?entity=settings&action=settings.update&limit=1");
    const row = a.body.items[0];
    expect(JSON.parse(row.before_json)).toEqual({ "approval.discount_pct_bp": oldVal, "hr.ot_weekday_bp": "15000" });
    expect(JSON.parse(row.after_json)).toEqual({ "approval.discount_pct_bp": "1200", "hr.ot_weekday_bp": "16000" });
    // giá trị không đổi → không ghi audit update mới, nhưng vẫn xác nhận
    const n = (await testEnv.DB.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='settings.update'`).first<any>()).n;
    await api("owner", "PUT", S, { settings: { "approval.discount_pct_bp": 1200 } });
    expect((await testEnv.DB.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='settings.update'`).first<any>()).n).toBe(n);
    await api("owner", "PUT", S, { settings: { "hr.ot_weekday_bp": 15000 } });
  });

  it("confirm-only marks a key confirmed without changing value", async () => {
    const before = flat((await api("owner", "GET", S)).body).find((i: any) => i.key === "pos.allow_offline");
    expect(before.pending).toBe(true);
    const r = await api("owner", "PUT", S, { settings: {}, confirm: ["pos.allow_offline"] });
    expect(r.status).toBe(200);
    const after = flat(r.body).find((i: any) => i.key === "pos.allow_offline");
    expect(after).toMatchObject({ pending: false, confirmed: true, value: before.value });
    const row = await testEnv.DB.prepare(`SELECT confirmed_by FROM settings_confirmations WHERE key='pos.allow_offline'`).first<any>();
    expect(row.confirmed_by).toBe(1);
    expect((await api("manager", "PUT", S, { settings: {}, confirm: ["costing.method"] })).status).toBe(403);
    expect((await api("owner", "PUT", S, { settings: {}, confirm: ["nope.key"] })).status).toBe(422);
    expect((await api("owner", "PUT", S, { settings: {} })).status).toBe(422);
  });

  it("accepts booleans and numbers for typed keys", async () => {
    const r = await api("owner", "PUT", S, { settings: { "loyalty.enabled": true, "payment.methods": "cod,transfer", "debt.aging_buckets": "15, 45,90" } });
    expect(r.status).toBe(200);
    const f = flat(r.body);
    expect(f.find((i: any) => i.key === "loyalty.enabled").value).toBe("1");
    expect(f.find((i: any) => i.key === "debt.aging_buckets").value).toBe("15,45,90");
    await api("owner", "PUT", S, { settings: { "loyalty.enabled": 0, "debt.aging_buckets": "30,60,90" } });
  });

  it("refuses einvoice.provider=misa without MISA config", async () => {
    const r = await api("owner", "PUT", S, { settings: { "einvoice.provider": "misa" } });
    expect(r.status).toBe(422);
  });
});

describe("period lock / unlock", () => {
  const past = (() => { const [y, m] = vnPeriod().split("-").map(Number); const t = y * 12 + m - 1 - 3; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; })();

  it("lists, locks only ended periods, unlocks with reason (owner only) and audits", async () => {
    expect((await api("owner", "POST", `/api/v1/periods/${vnPeriod()}/lock`)).status).toBe(422);
    const l = await api("owner", "POST", `/api/v1/periods/${past}/lock`);
    expect(l.status).toBe(200);
    const list = await api("manager", "GET", "/api/v1/periods");
    const p = list.body.items.find((x: any) => x.period === past);
    expect(p).toMatchObject({ locked: true, locked_by_name: "Test owner" });

    expect((await api("manager", "POST", `/api/v1/periods/${past}/unlock`, { reason: "Sửa lại số liệu" })).status).toBe(403);
    expect((await api("accountant", "POST", `/api/v1/periods/${past}/unlock`, { reason: "Sửa lại số liệu" })).status).toBe(403);
    const noReason = await api("owner", "POST", `/api/v1/periods/${past}/unlock`, {});
    expect(noReason.status).toBe(422);
    expect((await api("owner", "POST", `/api/v1/periods/${past}/unlock`, { reason: "abc" })).status).toBe(422);
    expect((await api("owner", "POST", `/api/v1/periods/2020-01/unlock`, { reason: "Không có gì" })).status).toBe(409);

    // payroll/timesheet khoá riêng: không bị ảnh hưởng
    await testEnv.DB.prepare(`INSERT OR IGNORE INTO payroll_periods(period, status) VALUES (?, 'approved')`).bind(past).run().catch(() => {});
    const before = await testEnv.DB.prepare(`SELECT COUNT(*) n FROM payroll_periods WHERE status != 'draft'`).first<any>();
    const u = await api("owner", "POST", `/api/v1/periods/${past}/unlock`, { reason: "Chủ mở khoá để chỉnh phiếu chi" });
    expect(u.status).toBe(200);
    expect(u.body.locked).toBe(false);
    const after = await testEnv.DB.prepare(`SELECT COUNT(*) n FROM payroll_periods WHERE status != 'draft'`).first<any>();
    expect(after.n).toBe(before.n);
    expect((await api("owner", "GET", "/api/v1/periods")).body.items.find((x: any) => x.period === past)?.locked ?? false).toBe(false);
    expect((await api("owner", "POST", `/api/v1/periods/${past}/unlock`, { reason: "Lần hai không hợp lệ" })).status).toBe(409);

    const a = await api("owner", "GET", "/api/v1/audit?action=period.unlock");
    expect(a.body.items[0]).toMatchObject({ entity: "period", entity_id: past, reason: "Chủ mở khoá để chỉnh phiếu chi" });
    expect(JSON.parse(a.body.items[0].before_json).locked).toBe(true);
  });
});

describe("audit viewer filters", () => {
  it("filters by user, action, entity and date range with paging", async () => {
    await api("owner", "PUT", S, { settings: { "quote.valid_days": 8 } });
    await api("owner", "PUT", S, { settings: { "quote.valid_days": 7 } });
    const f = await api("manager", "GET", "/api/v1/audit/facets");
    expect(f.status).toBe(200);
    expect(f.body.actions).toContain("settings.update");
    expect(f.body.entities).toContain("settings");
    expect((await api("cashier", "GET", "/api/v1/audit/facets")).status).toBe(403);
    const ownerId = f.body.users.find((u: any) => u.username === "owner").id;
    const r = await api("manager", "GET", `/api/v1/audit?userId=${ownerId}&action=settings.update&entity=settings&from=2020-01-01&to=2099-01-01&limit=1`);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.nextCursor).toBeTruthy();
    const r2 = await api("manager", "GET", `/api/v1/audit?userId=${ownerId}&action=settings.update&cursor=${r.body.nextCursor}&limit=1`);
    expect(r2.body.items[0].id).toBeLessThan(r.body.items[0].id);
    expect((await api("manager", "GET", `/api/v1/audit?userId=999999`)).body.items).toHaveLength(0);
    expect((await api("manager", "GET", `/api/v1/audit?to=2000-01-01`)).body.items).toHaveLength(0);
  });
});
