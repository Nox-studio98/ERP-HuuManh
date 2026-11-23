import { beforeAll, describe, expect, it, vi } from "vitest";
import { ADDR, call, checkoutBody, login, register, seedShop, testEnv } from "./shop-helpers";

beforeAll(seedShop);

const db = () => testEnv.DB;
const mailJob = async (email: string, template: string) => {
  const rows = (await db().prepare(`SELECT payload_json FROM integration_jobs WHERE type='notify.email' AND ref_id=(SELECT id FROM shop_accounts WHERE email=?) ORDER BY id`).bind(email).all<any>()).results;
  const j = rows.map((r) => JSON.parse(r.payload_json)).filter((p) => p.template === template).at(-1);
  return j as { to: string; template: string; link: string } | undefined;
};
const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
const REG = (email: string, over: Record<string, unknown> = {}) => ({ fullName: "Trần Thị B", email, phone: "0987654321", password: "Matkhau-123", ...over });

describe("register / verify", () => {
  it("creates retail customer (group le) + account, stores only token hash, emails link via job", async () => {
    const r = await call("POST", "/api/auth/register", REG("New@Example.com", { marketingOptIn: true }));
    expect(r.status).toBe(201);
    const acc = await db().prepare(`SELECT * FROM shop_accounts WHERE email='new@example.com'`).first<any>();
    expect(acc).toMatchObject({ kind: "retail", b2b_status: null, marketing_opt_in: 1, phone: "0987654321", active: 1 });
    expect(acc.pass_hash.startsWith("pbkdf2$")).toBe(true);
    const cu = await db().prepare(`SELECT c.code, c.type, g.code AS g FROM customers c LEFT JOIN customer_groups g ON g.id=c.customer_group_id WHERE c.id=?`).bind(acc.customer_id).first<any>();
    expect(cu).toMatchObject({ type: "retail", g: "le" });
    expect(cu.code).toMatch(/^KL-/);
    const job = await mailJob("new@example.com", "verify_email");
    expect(job!.to).toBe("new@example.com");
    const token = tokenOf(job!.link);
    expect(job!.link).toContain("/verify-email?token=");
    const row = await db().prepare(`SELECT id, purpose, used_at FROM shop_tokens WHERE account_id=?`).bind(acc.id).first<any>();
    expect(row.id).not.toBe(token); // chỉ lưu SHA-256
    expect(row.id).toMatch(/^[0-9a-f]{64}$/);
    // token không xuất hiện trong audit_log
    const audits = JSON.stringify((await db().prepare(`SELECT * FROM audit_log`).all()).results);
    expect(audits).not.toContain(token);
    // xác minh email (một lần)
    expect((await call("POST", "/api/auth/verify-email", { token })).status).toBe(200);
    expect((await db().prepare(`SELECT email_verified_at v FROM shop_accounts WHERE id=?`).bind(acc.id).first<any>()).v).not.toBeNull();
    expect((await call("POST", "/api/auth/verify-email", { token })).status).toBe(400);
  });

  it("does not reveal duplicate emails and validates input", async () => {
    const a = await call("POST", "/api/auth/register", REG("dup@example.com"));
    const b = await call("POST", "/api/auth/register", REG("dup@example.com", { fullName: "Khác" }));
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    expect((await db().prepare(`SELECT COUNT(*) n FROM shop_accounts WHERE email='dup@example.com'`).first<any>()).n).toBe(1);
    expect((await call("POST", "/api/auth/register", REG("short@example.com", { password: "abc123" }))).status).toBe(422);
    expect((await call("POST", "/api/auth/register", REG("bad-email"))).status).toBe(422);
    expect((await call("POST", "/api/auth/register", REG("ph@example.com", { phone: "123" }))).status).toBe(422);
  });

  it("requires Turnstile in production (failed verification → 403)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ success: false })));
    const r = await call("POST", "/api/auth/register", REG("ts@example.com"), { env: { APP_ENV: "production", TURNSTILE_SECRET: "x" }, headers: { "x-turnstile-token": "t" } });
    vi.restoreAllMocks();
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("turnstile_failed");
    expect((await call("POST", "/api/auth/login", { email: "a@b.co", password: "x" }, { env: { APP_ENV: "production" } })).status).toBe(503);
    expect((await db().prepare(`SELECT COUNT(*) n FROM shop_accounts WHERE email='ts@example.com'`).first<any>()).n).toBe(0);
  });
});

describe("login, sessions, CSRF, lockout", () => {
  it("logs in with HttpOnly __Host- cookie; CSRF header needed for cookie writes; Bearer for native", async () => {
    await call("POST", "/api/auth/register", REG("sess@example.com"));
    const r = await call("POST", "/api/auth/login", { email: "SESS@example.com", password: "Matkhau-123" });
    expect(r.status).toBe(200);
    const sc = r.res.headers.get("set-cookie")!;
    expect(sc).toMatch(/^__Host-hm_shop=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain=/i);
    expect(r.body.token).toBeUndefined(); // web: token không lộ trong body
    expect(r.body.account).toMatchObject({ email: "sess@example.com", kind: "retail", b2bStatus: null, customerGroup: "le", marketingOptIn: false, phone: "0987654321" });
    const cookie = /__Host-hm_shop=[^;]+/.exec(sc)![0];
    const stored = await db().prepare(`SELECT id FROM shop_sessions WHERE account_id=?`).bind(r.body.account.id).first<any>();
    expect(stored.id).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toContain(stored.id);

    expect((await call("GET", "/api/me", undefined, { headers: { cookie } })).status).toBe(200); // GET không cần CSRF
    const noCsrf = await call("PUT", "/api/me", { fullName: "X" }, { headers: { cookie } });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("csrf");
    const ok = await call("PUT", "/api/me", { fullName: "Tên mới", marketingOptIn: true }, { headers: { cookie, "x-requested-with": "hm-shop" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ fullName: "Tên mới", marketingOptIn: true });
    expect((await db().prepare(`SELECT name FROM customers WHERE id=(SELECT customer_id FROM shop_accounts WHERE email='sess@example.com')`).first<any>()).name).toBe("Tên mới");

    const nat = await call("POST", "/api/auth/login", { email: "sess@example.com", password: "Matkhau-123" }, { headers: { "x-client": "native" } });
    const bearer = { authorization: `Bearer ${nat.body.token}` };
    expect((await call("PUT", "/api/me", { fullName: "Native" }, { headers: bearer })).status).toBe(200); // Bearer không cần CSRF

    const out = await call("POST", "/api/auth/logout", undefined, { headers: { cookie, "x-requested-with": "hm-shop" } });
    expect(out.status).toBe(200);
    expect((await call("GET", "/api/me", undefined, { headers: { cookie } })).status).toBe(401);
  });

  it("gives identical errors for unknown email and wrong password, then locks after 5 failures", async () => {
    await call("POST", "/api/auth/register", REG("lock@example.com"));
    const unknown = await call("POST", "/api/auth/login", { email: "nobody@example.com", password: "Matkhau-123" });
    const wrong = await call("POST", "/api/auth/login", { email: "lock@example.com", password: "Sai-mat-khau" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    for (let i = 0; i < 4; i++) await call("POST", "/api/auth/login", { email: "lock@example.com", password: "Sai-mat-khau" });
    const locked = await call("POST", "/api/auth/login", { email: "lock@example.com", password: "Matkhau-123" });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("account_locked");
    await db().prepare(`UPDATE shop_accounts SET locked_until=? WHERE email='lock@example.com'`).bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await call("POST", "/api/auth/login", { email: "lock@example.com", password: "Matkhau-123" })).status).toBe(200);
  });

  it("forgot/reset: generic response, one-time token, sessions revoked, new password works", async () => {
    const s = await register("reset@example.com");
    const unknown = await call("POST", "/api/auth/forgot", { email: "ghost@example.com" });
    const known = await call("POST", "/api/auth/forgot", { email: "reset@example.com" });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect((await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='notify.email' AND payload_json LIKE '%ghost@%'`).first<any>()).n).toBe(0);
    const job = await mailJob("reset@example.com", "reset_password");
    const token = tokenOf(job!.link);
    expect((await call("POST", "/api/auth/reset", { token, password: "short" })).status).toBe(422);
    expect((await call("POST", "/api/auth/reset", { token: "x".repeat(40), password: "Mat-khau-moi-1" })).status).toBe(400);
    expect((await call("POST", "/api/auth/reset", { token, password: "Mat-khau-moi-1" })).status).toBe(200);
    expect((await call("POST", "/api/auth/reset", { token, password: "Mat-khau-moi-2" })).status).toBe(400); // dùng một lần
    expect((await call("GET", "/api/me", undefined, { headers: s.headers })).status).toBe(401); // phiên cũ bị thu hồi
    expect((await call("POST", "/api/auth/login", { email: "reset@example.com", password: "Matkhau-123" })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { email: "reset@example.com", password: "Mat-khau-moi-1" })).status).toBe(200);
    // token hết hạn
    await call("POST", "/api/auth/forgot", { email: "reset@example.com" });
    const t2 = tokenOf((await mailJob("reset@example.com", "reset_password"))!.link);
    await db().prepare(`UPDATE shop_tokens SET expires_at=? WHERE purpose='reset_password' AND used_at IS NULL`).bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await call("POST", "/api/auth/reset", { token: t2, password: "Mat-khau-moi-3" })).status).toBe(400);
  });
});

describe("addresses, push, deletion", () => {
  it("manages the address book with zone assignment and a single default", async () => {
    const s = await register("book@example.com");
    const a1 = await call("POST", "/api/me/addresses", { ...ADDR, label: "Nhà" }, { headers: s.headers });
    const a2 = await call("POST", "/api/me/addresses", { ...ADDR, district: "Quận 12", label: "Cơ quan", isDefault: true }, { headers: s.headers });
    expect(a1.body).toMatchObject({ zoneId: 1, isDefault: true, receiverPhone: "0901234567" });
    expect(a2.body.zoneId).toBeNull();
    const list = await call("GET", "/api/me/addresses", undefined, { headers: s.headers });
    expect(list.body.items.map((a: any) => [a.id, a.isDefault])).toEqual([[a2.body.id, true], [a1.body.id, false]]);
    const up = await call("PUT", `/api/me/addresses/${a2.body.id}`, { ...ADDR, district: "Bình Thạnh" }, { headers: s.headers });
    expect(up.body.zoneId).toBe(1);
    const other = await register("book2@example.com", "Matkhau-123", "0966666666");
    expect((await call("PUT", `/api/me/addresses/${a1.body.id}`, ADDR, { headers: other.headers })).status).toBe(404);
    expect((await call("DELETE", `/api/me/addresses/${a1.body.id}`, undefined, { headers: other.headers })).status).toBe(404);
    expect((await call("DELETE", `/api/me/addresses/${a1.body.id}`, undefined, { headers: s.headers })).status).toBe(200);
    expect((await call("GET", "/api/me/addresses", undefined, { headers: s.headers })).body.items).toHaveLength(1);
    const q = await call("POST", "/api/cart/quote", { items: [{ productId: 901, unit: "kg", qty: 3 }], addressId: a2.body.id }, { headers: s.headers });
    expect(q.body.zone).toMatchObject({ id: 1 });
    expect((await call("POST", "/api/cart/quote", { items: [{ productId: 901, unit: "kg", qty: 3 }], addressId: a2.body.id }, { headers: other.headers })).status).toBe(404);
  });

  it("stores push subscriptions and exposes the VAPID public key", async () => {
    const s = await register("push@example.com");
    const sub = { endpoint: "https://push.example.com/abc", keys: { p256dh: "BPxxxxxxxxxxxxxxxx", auth: "authsecret12345" } };
    expect((await call("POST", "/api/me/push-subscriptions", sub, { headers: s.headers })).status).toBe(201);
    expect((await call("POST", "/api/me/push-subscriptions", sub, { headers: s.headers })).status).toBe(201); // upsert
    expect((await db().prepare(`SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint=?`).bind(sub.endpoint).first<any>()).n).toBe(1);
    expect((await call("POST", "/api/me/push-subscriptions", { ...sub, endpoint: "http://insecure.example/x" }, { headers: s.headers })).status).toBe(422);
    expect((await call("GET", "/api/push/vapid-public-key", undefined, { env: { VAPID_PUBLIC_KEY: "PUB" } })).body).toEqual({ publicKey: "PUB" });
  });

  it("DELETE /api/me anonymizes PII but keeps orders; needs password; blocked while orders are open", async () => {
    const s = await register("gone@example.com", "Matkhau-123", "0977777777");
    await call("POST", "/api/me/addresses", ADDR, { headers: s.headers });
    await call("POST", "/api/me/push-subscriptions", { endpoint: "https://push.example.com/gone", keys: { p256dh: "BPxxxxxxxxxxxxxxxx", auth: "authsecret12345" } }, { headers: s.headers });
    const o = await call("POST", "/api/checkout", checkoutBody(), { headers: s.headers });
    expect(o.status).toBe(201);
    expect((await call("DELETE", "/api/me", { password: "Sai-mat-khau" }, { headers: s.headers })).status).toBe(403);
    const blocked = await call("DELETE", "/api/me", { password: "Matkhau-123" }, { headers: s.headers });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("active_orders");
    await db().prepare(`UPDATE orders SET status='completed' WHERE code=?`).bind(o.body.code).run();
    const del = await call("DELETE", "/api/me", { password: "Matkhau-123" }, { headers: s.headers });
    expect(del.status).toBe(200);
    const acc = await db().prepare(`SELECT * FROM shop_accounts WHERE id=?`).bind(s.account.id).first<any>();
    expect(acc).toMatchObject({ phone: null, full_name: "Tài khoản đã xoá", active: 0, pass_hash: "!deleted" });
    expect(acc.email).toBe(`deleted+${s.account.id}@deleted.invalid`);
    expect(acc.deleted_at).not.toBeNull();
    expect((await db().prepare(`SELECT COUNT(*) n FROM shop_addresses WHERE account_id=?`).bind(s.account.id).first<any>()).n).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM push_subscriptions WHERE account_id=?`).bind(s.account.id).first<any>()).n).toBe(0);
    const cu = await db().prepare(`SELECT name, phone, email, active FROM customers WHERE id=?`).bind(acc.customer_id).first<any>();
    expect(cu).toMatchObject({ phone: null, email: null, active: 0 });
    expect(cu.name).toContain("đã xoá");
    // đơn/chứng từ vẫn còn
    const kept = await db().prepare(`SELECT code, receiver_name, total FROM orders WHERE code=?`).bind(o.body.code).first<any>();
    expect(kept).toMatchObject({ receiver_name: ADDR.receiverName, total: 170000 });
    expect((await call("GET", "/api/me", undefined, { headers: s.headers })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { email: "gone@example.com", password: "Matkhau-123" })).status).toBe(401);
    // email cũ có thể đăng ký lại
    expect((await call("POST", "/api/auth/register", REG("gone@example.com"))).status).toBe(201);
    expect((await login("gone@example.com")).account.id).not.toBe(s.account.id);
  });
});
