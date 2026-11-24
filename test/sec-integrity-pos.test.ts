import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { lotQty, seedSales } from "./seed-sales";
import { sweepStaleDrafts } from "../src/worker/services/online-ops";
import { pointsStmts } from "../src/worker/services/loyalty-points";
import { vnPeriod } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const V = "/api/v1";
const line = (productId: number, qty: number, extra: object = {}) => ({ productId, unit: "kg", qty, ...extra });
let n = 0;
const uuid = (p = "sec") => `${p}-${Date.now()}-${++n}-xxxx`;

async function sell(qty: number, extra: Record<string, unknown> = {}) {
  const r = await api("cashier", "POST", `${V}/pos/orders`, {
    clientUuid: uuid(), lines: [line(1, qty)], payments: [{ method: "cash", amount: qty * 100000 }], ...extra,
  });
  expect(r.status).toBe(201);
  return r.body;
}

beforeAll(async () => {
  await seedBase();
  await seedSales();
  expect((await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).status).toBe(201);
});

describe("POS void (audit #1, #15)", () => {
  it("two concurrent voids restock once and only one wins", async () => {
    const before = await lotQty(1);
    const o = await sell(2);
    expect(await lotQty(1)).toBe(before - 2000);
    const res = await Promise.all([
      api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "đồng thời A" }),
      api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "đồng thời B" }),
    ]);
    const codes = res.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(await lotQty(1)).toBe(before); // không nhập kho hai lần
    const moves = await db().prepare(`SELECT COUNT(*) n FROM stock_moves WHERE ref_type='order_void' AND ref_id=?`).bind(o.id).first<{ n: number }>();
    expect(moves!.n).toBe(1);
  });

  it("refuses to void non-POS channels and locked periods", async () => {
    await db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, created_at, completed_at) VALUES (9501,'DH-SEC-1','online','sale',1,'completed',1000,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run();
    const r = await api("manager", "POST", `${V}/orders/9501/void`, { reason: "thử huỷ đơn online" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("wrong_channel");

    const o = await sell(1);
    const before = await lotQty(1);
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1) ON CONFLICT(period) DO UPDATE SET locked_at = excluded.locked_at`).bind(vnPeriod()).run();
    const locked = await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "kỳ đã khoá" });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("period_locked");
    expect(await lotQty(1)).toBe(before);
    await db().prepare(`UPDATE periods SET locked_at = NULL WHERE period = ?`).bind(vnPeriod()).run();
    expect((await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "mở khoá rồi huỷ" })).status).toBe(200);
  });
});

describe("POS return race (audit #2)", () => {
  it("concurrent returns cannot exceed the sold quantity or refund twice", async () => {
    const o = await sell(2);
    const before = await lotQty(1);
    const body = { lines: [{ orderLineId: o.lines[0].id, qty: 2, unit: "kg", restock: true, reason: "khách trả" }], refundMethod: "cash" };
    const res = await Promise.all([
      api("cashier", "POST", `${V}/orders/${o.id}/return`, body),
      api("cashier", "POST", `${V}/orders/${o.id}/return`, body),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await lotQty(1)).toBe(before + 2000);
    const refunds = await db().prepare(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders r ON r.id=p.order_id WHERE r.original_order_id=? AND r.kind='return'`).bind(o.id).first<{ s: number }>();
    expect(refunds!.s).toBe(-200000);
  });
});

describe("orphan drafts (audit #16)", () => {
  it("a stale draft with the same clientUuid is retired so the retry succeeds; a fresh draft still blocks", async () => {
    const stale = uuid("stale");
    const fresh = uuid("fresh");
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    await db().batch([
      db().prepare(`INSERT INTO orders(code, client_uuid, channel, kind, store_id, status, created_at) VALUES ('HD-STALE-1', ?, 'pos','sale',1,'draft', ?)`).bind(stale, old),
      db().prepare(`INSERT INTO orders(code, client_uuid, channel, kind, store_id, status) VALUES ('HD-FRESH-1', ?, 'pos','sale',1,'draft')`).bind(fresh),
    ]);
    const blocked = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: fresh, lines: [line(1, 1)], payments: [{ method: "cash", amount: 100000 }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("order_in_progress");
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: stale, lines: [line(1, 1)], payments: [{ method: "cash", amount: 100000 }] });
    expect(ok.status).toBe(201);
    const oldRow = await db().prepare(`SELECT status FROM orders WHERE code='HD-STALE-1'`).first<{ status: string }>();
    expect(oldRow!.status).toBe("cancelled");
  });

  it("sweepStaleDrafts cancels drafts older than 10 minutes and frees their uuid", async () => {
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const recent = new Date(Date.now() - 3 * 60_000).toISOString();
    await db().batch([
      db().prepare(`INSERT INTO orders(code, client_uuid, channel, kind, store_id, status, created_at) VALUES ('HD-SWEEP-OLD','sweep-old-uuid-1','pos','sale',1,'draft', ?)`).bind(old),
      db().prepare(`INSERT INTO orders(code, client_uuid, channel, kind, store_id, status, created_at) VALUES ('HD-SWEEP-NEW','sweep-new-uuid-1','pos','sale',1,'draft', ?)`).bind(recent),
    ]);
    expect(await sweepStaleDrafts(db())).toBeGreaterThanOrEqual(1);
    const rows = (await db().prepare(`SELECT code, status, client_uuid FROM orders WHERE code IN ('HD-SWEEP-OLD','HD-SWEEP-NEW') ORDER BY code`).all<any>()).results;
    expect(rows[0]).toMatchObject({ code: "HD-SWEEP-NEW", status: "draft", client_uuid: "sweep-new-uuid-1" });
    expect(rows[1].status).toBe("cancelled");
    expect(rows[1].client_uuid).not.toBe("sweep-old-uuid-1");
  });
});

describe("cost leak and approval binding", () => {
  it("hides orders.cost_total from roles without prices.view_cost", async () => {
    const o = await sell(1);
    expect(o.cost_total).toBeUndefined();
    const asCashier = await api("cashier", "GET", `${V}/orders/${o.id}`);
    expect(asCashier.body.cost_total).toBeUndefined();
    const asManager = await api("manager", "GET", `${V}/orders/${o.id}`);
    expect(asManager.body.cost_total).toBe(60000);
  });

  it("an approval is bound to the exact cart, not just the clientUuid", async () => {
    const clientUuid = uuid("appr");
    const cart = { clientUuid, lines: [line(2, 1, { unitPriceOverride: 100000 })], payments: [{ method: "cash", amount: 100000 }] };
    const r = await api("cashier", "POST", `${V}/pos/orders`, cart);
    expect(r.status).toBe(409);
    const approvalId = r.body.error.details.approvalId;
    expect((await api("manager", "POST", `${V}/approvals/${approvalId}/decide`, { decision: "approved" })).status).toBe(200);
    // đổi giỏ (tăng SL lên 3 ở cùng giá dưới vốn) với cùng clientUuid + approvalId → bị từ chối
    const swapped = await api("cashier", "POST", `${V}/pos/orders`, { ...cart, lines: [line(2, 3, { unitPriceOverride: 100000 })], payments: [{ method: "cash", amount: 300000 }], approvalId });
    expect(swapped.status).toBe(409);
    expect(swapped.body.error.code).toBe("approval_invalid");
    // đúng giỏ đã duyệt thì qua
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { ...cart, approvalId });
    expect(ok.status).toBe(201);
  });
});

describe("loyalty ledger clamp (low)", () => {
  it("writes the clamped delta to the ledger when the balance is lower than the reversal", async () => {
    await db().prepare(`INSERT INTO customers(id, code, name, points) VALUES (9601,'KH-SEC-P','Khách điểm',5)`).run();
    await db().batch(pointsStmts(db(), null, 9601, "reverse", -10, "thu hồi vượt số dư", null, true));
    const led = await db().prepare(`SELECT points FROM loyalty_ledger WHERE customer_id=9601`).first<{ points: number }>();
    const cu = await db().prepare(`SELECT points FROM customers WHERE id=9601`).first<{ points: number }>();
    expect(cu!.points).toBe(0);
    expect(led!.points).toBe(-5);
  });
});
