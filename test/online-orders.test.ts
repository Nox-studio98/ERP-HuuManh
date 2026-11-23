import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { transitionStmts, normalizeVi, assertTransition } from "../src/worker/services/online-orders";

beforeAll(async () => {
  await seedBase();
  await testEnv.DB.prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (8800,'OL-1','online',1,'new')`).run();
});

describe("online order state machine", () => {
  it("transitions with event and rejects stale concurrent transition", async () => {
    const db = testEnv.DB;
    await db.batch(transitionStmts(db, 8800, "new", "confirmed", { type: "staff", id: 1 }, { note: "Đã xác nhận" }));
    // người thứ hai vẫn nghĩ đơn đang 'new' → phải rollback
    await expect(db.batch(transitionStmts(db, 8800, "new", "cancelled", { type: "staff", id: 2 }))).rejects.toThrow(/CHECK/);
    const o = await db.prepare(`SELECT status FROM orders WHERE id=8800`).first<{ status: string }>();
    expect(o!.status).toBe("confirmed");
    const ev = await db.prepare(`SELECT COUNT(*) n FROM order_events WHERE order_id=8800`).first<{ n: number }>();
    expect(ev!.n).toBe(1);
    const g = await db.prepare(`SELECT COUNT(*) n FROM order_transition_guard`).first<{ n: number }>();
    expect(g!.n).toBe(0);
  });
  it("rejects disallowed transitions", () => {
    expect(() => assertTransition("completed", "shipping")).toThrow();
    expect(() => assertTransition("shipping", "delivery_failed")).not.toThrow();
  });
  it("normalizes Vietnamese district names", () => {
    expect(normalizeVi("  Quận  Bình Thạnh ")).toBe("quan binh thanh");
    expect(normalizeVi("Thủ Đức")).toBe("thu duc");
  });
});
