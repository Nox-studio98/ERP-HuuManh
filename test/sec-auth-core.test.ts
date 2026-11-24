import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import { hashPassword } from "../src/worker/lib/crypto";
import type { Env } from "../src/worker/env";
import { PASSWORD, seedBase, testEnv, api } from "./helpers";

const post = (path: string, body: string, env: Partial<Env> = {}, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }, { ...testEnv, ...env } as Env);
const loginReq = (username: string, password: string, env: Partial<Env> = {}) => post("/api/auth/login", JSON.stringify({ username, password }), env);

beforeAll(async () => {
  await seedBase();
  const h = await hashPassword(PASSWORD);
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id, must_change_password) VALUES (800,'mustchg','M',?, 'cashier',1,1)`).bind(h),
    testEnv.DB.prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id) VALUES (801,'locky','L',?, 'cashier',1)`).bind(h),
  ]);
});

describe("Đăng nhập ERP", () => {
  it("tài khoản bị khoá, user không tồn tại và sai mật khẩu cùng trả 401 invalid_credentials", async () => {
    for (let i = 0; i < 5; i++) expect((await loginReq("locky", "wrong-password")).status).toBe(401);
    const locked = await loginReq("locky", PASSWORD); // đúng mật khẩu nhưng đang khoá
    expect(locked.status).toBe(401);
    expect(((await locked.json()) as any).error.code).toBe("invalid_credentials");
    const unknown = await loginReq("khong-ton-tai", "whatever-123");
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as any).error.code).toBe("invalid_credentials");
    const lockAudit = await testEnv.DB.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='auth.account_locked' AND entity_id='801'`).first<{ n: number }>();
    expect(lockAudit!.n).toBe(1);
  });

  it("giới hạn tần suất theo IP khi có RL_AUTH và APP_ENV != dev", async () => {
    const keys: string[] = [];
    const RL_AUTH = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const res = await post("/api/auth/login", JSON.stringify({ username: "owner", password: PASSWORD }), { RL_AUTH, APP_ENV: "staging" }, { "cf-connecting-ip": "1.2.3.4" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error.code).toBe("rate_limited");
    expect(keys).toEqual(["login:1.2.3.4"]);
    // dev bỏ qua
    expect((await post("/api/auth/login", JSON.stringify({ username: "owner", password: PASSWORD }), { RL_AUTH, APP_ENV: "dev" })).status).toBe(200);
  });

  it("body JSON hỏng → 400, không 500", async () => {
    expect((await post("/api/auth/login", "{not json")).status).toBe(400);
  });

  it("đăng xuất được ghi nhật ký", async () => {
    const t = ((await (await loginReq("owner", PASSWORD)).json()) as any).token;
    const r = await app.request("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${t}` } }, testEnv);
    expect(r.status).toBe(200);
    expect((await testEnv.DB.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='auth.logout'`).first<{ n: number }>())!.n).toBeGreaterThan(0);
  });
});

describe("must_change_password", () => {
  it("chặn /api/v1 nhưng vẫn cho /me, change-password, logout", async () => {
    const t = ((await (await loginReq("mustchg", PASSWORD)).json()) as any).token;
    const h = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    const v1 = await app.request("/api/v1/users", { headers: h }, testEnv);
    expect(v1.status).toBe(403);
    expect(((await v1.json()) as any).error.code).toBe("password_change_required");
    expect((await app.request("/api/v1/me/attendance/today", { headers: h }, testEnv)).status).toBe(403);
    expect((await app.request("/api/auth/me", { headers: h }, testEnv)).status).toBe(200);
    const ch = await app.request("/api/auth/change-password", { method: "POST", headers: h, body: JSON.stringify({ current: PASSWORD, next: "Another-Password-456" }) }, testEnv);
    expect(ch.status).toBe(200);
    expect((await app.request("/api/v1/products", { headers: h }, testEnv)).status).not.toBe(403);
  });
});

describe("/img", () => {
  it("escape % sai → 404, không 500", async () => {
    const r = await app.request("/img/products/%E0%A4%A", {}, testEnv);
    expect(r.status).toBe(404);
  });
});

describe("Giá vốn lệnh đóng giỏ", () => {
  it("vai trò không có prices.view_cost không thấy unitCost/extraCost", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (8001,'GIO-8001','Giỏ test','trai')`),
      testEnv.DB.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (8001,'L-8001',8001,1,'2026-11-01',123456,1000,1000)`),
      testEnv.DB.prepare(`INSERT INTO assembly_orders(id, code, bundle_product_id, qty_milli, extra_cost, status, lot_id, created_by) VALUES (8001,'LR-8001',8001,1000,77777,'posted',8001,1)`),
    ]);
    const c = await api("cashier", "GET", "/api/v1/assembly-orders/8001");
    expect(c.status).toBe(200);
    expect(JSON.stringify(c.body)).not.toMatch(/unitCost|extraCost|123456|77777/);
    const l = await api("cashier", "GET", "/api/v1/assembly-orders");
    expect(JSON.stringify(l.body)).not.toMatch(/extraCost|77777/);
    const m = await api("manager", "GET", "/api/v1/assembly-orders/8001");
    expect(m.body.unitCost).toBe(123456);
    expect(m.body.extraCost).toBe(77777);
  });
});
