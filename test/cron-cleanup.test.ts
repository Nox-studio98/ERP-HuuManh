import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { runScheduled } from "../src/worker/scheduled";

beforeAll(seedBase);

describe("cron */30 — dọn dẹp sau audit", () => {
  it("cancels stale draft orders and frees their clientUuid; keeps fresh drafts", async () => {
    const db = testEnv.DB;
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    await db.batch([
      db.prepare(`INSERT INTO orders(id, code, client_uuid, channel, store_id, status, created_at) VALUES (9971,'DR-OLD','uuid-stale-draft-0001','pos',1,'draft',?)`).bind(old),
      db.prepare(`INSERT INTO orders(id, code, client_uuid, channel, store_id, status) VALUES (9972,'DR-NEW','uuid-fresh-draft-0001','pos',1,'draft')`),
    ]);
    await runScheduled({ cron: "*/30 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, testEnv);
    const rows = (await db.prepare(`SELECT id, status, client_uuid FROM orders WHERE id IN (9971,9972) ORDER BY id`).all<any>()).results;
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].client_uuid).not.toBe("uuid-stale-draft-0001");
    expect(rows[1].status).toBe("draft");
    expect((await db.prepare(`SELECT COUNT(*) n FROM state_guard`).first<{ n: number }>())!.n).toBe(0);
  });

  it("internal transfer category is excluded from P&L expenses", async () => {
    const c = await testEnv.DB.prepare(`SELECT pnl_line FROM cash_categories WHERE code='DOI_SOAT_RA'`).first<{ pnl_line: string }>();
    expect(c!.pnl_line).toBe("transfer");
  });
});

describe("migration không chiếm id của dữ liệu nạp sẵn", () => {
  it("seed BAN_HANG (id 1) can still be inserted after all migrations", async () => {
    const db = testEnv.DB;
    const row = await db.prepare(`SELECT id FROM cash_categories WHERE code='DOI_SOAT_RA'`).first<{ id: number }>();
    expect(row!.id).toBeGreaterThan(99);
    // seedBase/seed.sql chèn danh mục với id tường minh nhỏ → không được trùng
    const clash = await db.prepare(`SELECT COUNT(*) n FROM cash_categories WHERE id < 100 AND code IN ('DOI_SOAT_RA')`).first<{ n: number }>();
    expect(clash!.n).toBe(0);
  });
});
