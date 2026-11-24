import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { backupToR2, listBackupTables, pruneBackups, type BackupManifest } from "../src/worker/services/backup";
import { runScheduled } from "../src/worker/scheduled";

const db = () => testEnv.DB;

async function gunzipText(obj: R2ObjectBody) {
  const s = obj.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(s).text();
}

beforeAll(async () => {
  await seedBase();
  await db().prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5100) INSERT INTO settings(key, value) SELECT 'bk.' || i, 'v' || i FROM n`).run();
});

describe("C-06 sao lưu R2 đầy đủ", () => {
  it("danh sách bảng tự sinh: gồm bảng nghiệp vụ M9/M4/M5, loại sessions/state_guard/d1_*", async () => {
    const t = await listBackupTables(db());
    for (const n of ["employees", "payroll_items", "salary_advances", "attendance_punches", "leave_requests", "invoices", "supplier_bills", "debt_adjustments", "bank_transactions", "quotes", "users", "audit_log"]) expect(t).toContain(n);
    for (const n of ["sessions", "state_guard"]) expect(t).not.toContain(n);
    expect(t.some((n) => n.startsWith("sqlite_") || n.startsWith("d1_") || n.startsWith("_cf_"))).toBe(false);
  });

  it("ghi từng bảng thành các phần NDJSON gz + manifest khớp số dòng; bỏ pass_hash; phân trang qua nhiều trang/phần", async () => {
    const m = await backupToR2(testEnv, "2026-11-24");
    const obj = await testEnv.FILES.get("backups/2026-11-24/manifest.json");
    const man = (await obj!.json()) as BackupManifest;
    expect(man.totalRows).toBe(m.totalRows);
    const st = man.tables.find((t) => t.name === "settings")!;
    const real = (await db().prepare(`SELECT COUNT(*) n FROM settings`).first<{ n: number }>())!.n;
    expect(st.rows).toBe(real);
    expect(st.parts.length).toBeGreaterThanOrEqual(2); // > PART_ROWS dòng → nhiều phần
    let seen = 0;
    for (const p of st.parts) {
      const o = await testEnv.FILES.get(p.key);
      expect(o).not.toBeNull();
      const lines = (await gunzipText(o!)).split("\n").filter(Boolean);
      expect(lines.length).toBe(p.rows);
      seen += lines.length;
    }
    expect(seen).toBe(real);
    // mọi bảng trong manifest khớp COUNT(*)
    for (const t of man.tables) {
      const n = (await db().prepare(`SELECT COUNT(*) n FROM "${t.name}"`).first<{ n: number }>())!.n;
      expect(t.rows, t.name).toBe(n);
    }
    const users = man.tables.find((t) => t.name === "users")!;
    const txt = await gunzipText((await testEnv.FILES.get(users.parts[0].key))!);
    expect(txt).not.toContain("pass_hash");
    expect(txt).toContain('"username"');
  });

  it("giữ N ngày: xoá thư mục cũ hơn, giữ thư mục trong hạn; cron hằng ngày chạy được", async () => {
    await testEnv.FILES.put("backups/2020-01-01/old.ndjson", "x");
    await testEnv.FILES.put("backups/2020-01-01/manifest.json", "{}");
    await testEnv.FILES.put("backups/2026-11-20/keep.ndjson", "x");
    const removed = await pruneBackups(testEnv, "2026-11-24", 30);
    expect(removed).toEqual(["backups/2020-01-01/"]);
    expect(await testEnv.FILES.get("backups/2020-01-01/old.ndjson")).toBeNull();
    expect(await testEnv.FILES.get("backups/2026-11-20/keep.ndjson")).not.toBeNull();
    await runScheduled({ cron: "0 17 * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, testEnv);
    const l = await testEnv.FILES.list({ prefix: "backups/", delimiter: "/" });
    expect(l.delimitedPrefixes.length).toBeGreaterThanOrEqual(2);
  });
});
