import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import { api, login, PASSWORD, seedBase, testEnv } from "./helpers";
import { allocateFefo, moveStatements } from "../src/worker/services/stock";
import { nextCode } from "../src/worker/lib/codes";

beforeAll(seedBase);

describe("auth", () => {
  it("rejects bad password and audits it", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "cashier", password: "wrong" }),
    }, testEnv);
    expect(res.status).toBe(401);
    const a = await testEnv.DB.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='auth.login_failed'`).first<{ n: number }>();
    expect(a!.n).toBeGreaterThan(0);
  });

  it("logs in and returns permissions", async () => {
    const r = await api("cashier", "GET", "/api/auth/me");
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("cashier");
    expect(r.body.permissions).toContain("pos.sell");
    expect(r.body.permissions).not.toContain("finance.write");
  });

  it("requires auth on /api/v1", async () => {
    const res = await app.request("/api/v1/anything", {}, testEnv);
    expect(res.status).toBe(401);
  });

  it("requires CSRF header for cookie-authenticated writes", async () => {
    const token = await login("manager");
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `__Host-hm_session=${token}` },
    }, testEnv);
    expect(res.status).toBe(403);
  });

  it("locks account after 5 failed attempts", async () => {
    for (let i = 0; i < 5; i++) {
      await app.request("/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "online_staff", password: "nope" }),
      }, testEnv);
    }
    const res = await app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "online_staff", password: PASSWORD }),
    }, testEnv);
    expect(res.status).toBe(401); // khoá không lộ khác biệt với sai mật khẩu (chống dò tài khoản)
  });

  it("audit_log is append-only", async () => {
    await expect(testEnv.DB.prepare(`DELETE FROM audit_log`).run()).rejects.toThrow();
  });
});

describe("stock FEFO + concurrency guard", () => {
  it("allocates earliest-expiry first, skips expired lots, and CHECK blocks oversell", async () => {
    const db = testEnv.DB;
    await db.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight) VALUES (100,'TAO-ENVY','Táo Envy','kg',1)`).run();
    const past = new Date(Date.now() - 86400_000).toISOString();
    const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
    const later = new Date(Date.now() + 5 * 86400_000).toISOString();
    await db.batch([
      db.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli)
                  VALUES (1,'L1',100,1,?,?,80000,5000,5000)`).bind(past, past),
      db.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli)
                  VALUES (2,'L2',100,1,?,?,90000,3000,3000)`).bind(past, later),
      db.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli)
                  VALUES (3,'L3',100,1,?,?,85000,1000,1000)`).bind(past, soon),
    ]);
    const alloc = await allocateFefo(db, 100, 2500, 1);
    expect(alloc).toEqual([
      { lotId: 3, qtyMilli: 1000, unitCost: 85000 },
      { lotId: 2, qtyMilli: 1500, unitCost: 90000 },
    ]);
    await expect(allocateFefo(db, 100, 4500, 1)).rejects.toMatchObject({ code: "insufficient_stock" });

    // Mô phỏng EC-02: hai thu ngân cùng đọc phân bổ, người thứ 2 phải bị rollback
    const a1 = await allocateFefo(db, 100, 4000, 1);
    const a2 = await allocateFefo(db, 100, 4000, 1);
    await db.batch(moveStatements(db, 100, a1, -1, "sale", "order", 1, 1));
    await expect(db.batch(moveStatements(db, 100, a2, -1, "sale", "order", 2, 1))).rejects.toThrow(/CHECK/);
    const left = await db.prepare(`SELECT SUM(qty_on_hand_milli) q FROM lots WHERE product_id=100 AND id<>1`).first<{ q: number }>();
    expect(left!.q).toBe(0);
    const moves = await db.prepare(`SELECT COUNT(*) n FROM stock_moves WHERE ref_id=2`).first<{ n: number }>();
    expect(moves!.n).toBe(0); // batch thứ 2 rollback cả thẻ kho
  });

  it("generates unique sequential document codes", async () => {
    const a = await nextCode(testEnv.DB, "HD");
    const b = await nextCode(testEnv.DB, "HD");
    expect(a).not.toBe(b);
    expect(b.endsWith("0002")).toBe(true);
  });
});
