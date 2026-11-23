import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

beforeAll(seedBase);

describe("Đợt 4 — ghép nối", () => {
  it("cancelling an order (any path) releases its voucher exactly once", async () => {
    const db = testEnv.DB;
    await db.batch([
      db.prepare(`INSERT INTO promotions(id, code, name, kind, value_amount, starts_at, ends_at, status, requires_voucher, created_by) VALUES (9401,'KM-INT','Int','amount',10000,'2020-01-01','2099-01-01','active',1,1)`),
      db.prepare(`INSERT INTO vouchers(id, code, promotion_id, max_uses, used_count) VALUES (9401,'INTV1',9401,1,1)`),
      db.prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (9401,'OL-INT','online',1,'new')`),
      db.prepare(`INSERT INTO voucher_redemptions(voucher_id, order_id, amount) VALUES (9401,9401,10000)`),
    ]);
    // huỷ bằng UPDATE trực tiếp (giống mọi đường huỷ đi qua transitionStmts)
    await db.prepare(`UPDATE orders SET status='cancelled' WHERE id=9401`).run();
    const v = await db.prepare(`SELECT used_count FROM vouchers WHERE id=9401`).first<{ used_count: number }>();
    expect(v!.used_count).toBe(0);
    const r = await db.prepare(`SELECT status FROM voucher_redemptions WHERE order_id=9401`).first<{ status: string }>();
    expect(r!.status).toBe("reversed");
    // đổi trạng thái lần nữa không trừ thêm (idempotent)
    await db.prepare(`UPDATE orders SET status='returned' WHERE id=9401`).run();
    expect((await db.prepare(`SELECT used_count FROM vouchers WHERE id=9401`).first<{ used_count: number }>())!.used_count).toBe(0);
  });

  it("reports reject impossible dates with 422 instead of 500", async () => {
    const r = await api("owner", "GET", "/api/v1/reports/pnl?from=2026-13-40&to=2026-13-41");
    expect(r.status).toBe(422);
    expect((await api("owner", "GET", "/api/v1/reports/pnl?from=2026-02-30")).status).toBe(422);
  });

  it("cash vouchers can be tagged with a channel (M6-06 direct cost)", async () => {
    const cat = await testEnv.DB.prepare(`SELECT id FROM cash_categories WHERE code='VAN_CHUYEN'`).first<{ id: number }>();
    const r = await api("owner", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: cat!.id, amount: 120000, channel: "online", note: "Phí ship" });
    expect(r.status).toBeLessThan(300);
    const row = await testEnv.DB.prepare(`SELECT channel FROM cash_vouchers WHERE amount=120000 ORDER BY id DESC LIMIT 1`).first<{ channel: string }>();
    expect(row!.channel).toBe("online");
    expect((await api("owner", "POST", "/api/v1/vouchers", { direction: "out", fundId: 1, categoryId: cat!.id, amount: 1, channel: "tv" })).status).toBe(422);
  });
});
