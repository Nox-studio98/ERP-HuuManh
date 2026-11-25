import { beforeAll, describe, expect, it } from "vitest";
import { api, call, cookieOf, db, invite, loginNcc, mkNcc, mkSupplier, ncc, NCC_PW, seedBase, tokenOf, V, NCC_PW_NEW, NCC_PW_NEW_B, NCC_PW_WRONG } from "./ncc-helpers";
import { register, seedShop } from "./shop-helpers";
import { sha256 } from "../src/worker/lib/crypto";
import { _resetRateLimitWarn } from "../src/shop/worker/lib/ratelimit";

// Cổng NCC — bước 4: mời, đặt mật khẩu, đăng nhập, phiên riêng, CSRF, rate limit (docs/PO-NCC.md mục 3.3, 5)
beforeAll(async () => {
  await seedShop();
  await seedBase();
  await mkSupplier(9601, "NCC Cam Cổng");
  await mkSupplier(9602, "NCC Xoài Cổng");
});

const login = (email: string, password: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  call("POST", "/api/ncc/auth/login", { email, password }, { env: extra, headers });

describe("mời NCC từ ERP", () => {
  it("chỉ chủ/quản lý (purchasing.approve) mời được; kho/kế toán/thu ngân bị chặn; link chỉ trả một lần, DB chỉ lưu băm", async () => {
    for (const role of ["warehouse", "cashier", "accountant", "online_staff"])
      expect((await api(role, "POST", `${V}/suppliers/9601/portal/invites`, { fullName: "A", email: `${role}@x.vn` })).status, role).toBe(403);
    expect((await api("warehouse", "GET", `${V}/suppliers/9601/portal`)).status).toBe(403);
    const r = await api("manager", "POST", `${V}/suppliers/9601/portal/invites`, { fullName: "Chị Lan", email: "Lan.Cam@Example.com", phone: "0901112233" });
    expect(r.status).toBe(201);
    expect(r.body.account).toMatchObject({ email: "lan.cam@example.com", status: "invited", hasPassword: false });
    const token = tokenOf(r.body.invite.path);
    expect(r.body.invite.path).toMatch(/^\/ncc\/dat-mat-khau#\d+\.[A-Za-z0-9_-]{20,}$/);
    const secret = token.split(".")[1];
    const row = (await db().prepare(`SELECT * FROM supplier_invites WHERE id = ?`).bind(r.body.invite.id).first<any>())!;
    expect(row.token_hash).toBe(await sha256(secret)); // chỉ lưu SHA-256
    expect(JSON.stringify(row)).not.toContain(secret);
    // hạn = ncc.invite_ttl_hours (72)
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(71 * 3600_000);
    expect(Date.parse(row.expires_at) - Date.now()).toBeLessThanOrEqual(72 * 3600_000 + 5000);
    // audit không chứa token
    const aud = await db().prepare(`SELECT * FROM audit_log WHERE action = 'ncc.account_invite' AND entity_id = '9601'`).all<any>();
    expect(aud.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(aud.results)).not.toContain(secret);
    // danh sách tài khoản không lộ token
    const list = await api("manager", "GET", `${V}/suppliers/9601/portal`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body.items.find((a: any) => a.email === "lan.cam@example.com").pendingInvite).toMatchObject({ id: r.body.invite.id, expired: false });
  });

  it("email trùng toàn hệ thống → 409; NCC không tồn tại → 404; email sai → 422", async () => {
    await invite(9601, "trung@example.com");
    expect((await api("manager", "POST", `${V}/suppliers/9602/portal/invites`, { fullName: "B", email: "TRUNG@example.com" })).body.error.code).toBe("email_taken");
    expect((await api("manager", "POST", `${V}/suppliers/999999/portal/invites`, { fullName: "B", email: "b@example.com" })).status).toBe(404);
    expect((await api("manager", "POST", `${V}/suppliers/9601/portal/invites`, { fullName: "B", email: "khong-hop-le" })).status).toBe(422);
  });

  it("kiểm tra link + đặt mật khẩu: sai token, token của lời mời khác, quá ngắn đều 400 đồng nhất; đặt xong dùng lại không được", async () => {
    const inv = await invite(9601, "dat-mk@example.com", "Anh Đạt");
    const tok = tokenOf(inv.invite.path);
    const info = await call("POST", "/api/ncc/auth/invite", { token: tok });
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ fullName: "Anh Đạt", email: "dat-mk@example.com", supplierName: "NCC Cam Cổng", firstTime: true });
    // sai bí mật, đúng id
    const bad = await call("POST", "/api/ncc/auth/invite", { token: `${inv.invite.id}.${"x".repeat(43)}` });
    const garbage = await call("POST", "/api/ncc/auth/invite", { token: "khong-phai-token-hop-le" });
    const unknownId = await call("POST", "/api/ncc/auth/invite", { token: `99999999.${"x".repeat(43)}` });
    for (const b of [bad, garbage, unknownId]) { expect(b.status).toBe(400); expect(b.body.error.code).toBe("invalid_token"); }
    expect(bad.body.error.message).toBe(garbage.body.error.message);
    // mật khẩu < 10 ký tự
    expect((await call("POST", "/api/ncc/auth/accept", { token: tok, password: "ngan123" })).status).toBe(422);
    // sai token không làm hỏng lời mời
    expect((await call("POST", "/api/ncc/auth/accept", { token: `${inv.invite.id}.${"y".repeat(43)}`, password: NCC_PW })).status).toBe(400);
    const ok = await call("POST", "/api/ncc/auth/accept", { token: tok, password: NCC_PW });
    expect(ok.status).toBe(200);
    expect(ok.body.account).toMatchObject({ email: "dat-mk@example.com", fullName: "Anh Đạt", supplier: { name: "NCC Cam Cổng" } });
    expect(cookieOf(ok.res)).toBeTruthy();
    expect(ok.res.headers.get("set-cookie")).toMatch(/__Host-ncc=.*HttpOnly.*Secure.*SameSite=Strict/i);
    expect((await db().prepare(`SELECT status, pass_hash FROM supplier_accounts WHERE email = 'dat-mk@example.com'`).first<any>())).toMatchObject({ status: "active" });
    // dùng lại link → 400
    expect((await call("POST", "/api/ncc/auth/accept", { token: tok, password: NCC_PW_NEW_B })).status).toBe(400);
    expect((await call("POST", "/api/ncc/auth/invite", { token: tok })).status).toBe(400);
    expect((await login("dat-mk@example.com", "MatKhauKhac-9999")).status).toBe(401);
    expect((await login("dat-mk@example.com", NCC_PW)).status).toBe(200);
  });

  it("link hết hạn bị từ chối; chỉnh ncc.invite_ttl_hours có hiệu lực", async () => {
    const inv = await invite(9601, "het-han@example.com");
    await db().prepare(`UPDATE supplier_invites SET expires_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), inv.invite.id).run();
    const tok = tokenOf(inv.invite.path);
    expect((await call("POST", "/api/ncc/auth/invite", { token: tok })).status).toBe(400);
    expect((await call("POST", "/api/ncc/auth/accept", { token: tok, password: NCC_PW })).status).toBe(400);
    const list = await api("manager", "GET", `${V}/suppliers/9601/portal`);
    expect(list.body.items.find((a: any) => a.email === "het-han@example.com").pendingInvite.expired).toBe(true);
    await db().prepare(`UPDATE settings SET value = '1' WHERE key = 'ncc.invite_ttl_hours'`).run();
    const short = await invite(9601, "ttl1@example.com");
    expect(Date.parse(short.invite.expiresAt) - Date.now()).toBeLessThanOrEqual(3600_000 + 5000);
    await db().prepare(`UPDATE settings SET value = '72' WHERE key = 'ncc.invite_ttl_hours'`).run();
  });

  it("gửi lại link thu hồi link cũ; thu hồi lời mời; hai request đặt mật khẩu đồng thời chỉ một thành công", async () => {
    const inv = await invite(9601, "gui-lai@example.com");
    const again = await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${inv.account.id}/invite`, {});
    expect(again.status).toBe(201);
    expect((await call("POST", "/api/ncc/auth/invite", { token: tokenOf(inv.invite.path) })).status).toBe(400); // cũ bị thu hồi
    expect((await call("POST", "/api/ncc/auth/invite", { token: tokenOf(again.body.invite.path) })).status).toBe(200);
    const rev = await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${inv.account.id}/revoke-invite`, {});
    expect(rev.body.account.pendingInvite).toBeNull();
    expect((await call("POST", "/api/ncc/auth/accept", { token: tokenOf(again.body.invite.path), password: NCC_PW })).status).toBe(400);
    // đồng thời
    const again2 = await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${inv.account.id}/invite`, {});
    const t2 = tokenOf(again2.body.invite.path);
    const rs = await Promise.all([1, 2, 3].map((i) => call("POST", "/api/ncc/auth/accept", { token: t2, password: `MatKhau-song-song-${i}` })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(2);
  });

  it("thao tác chéo NCC: tài khoản của NCC 9602 không gửi lại/khoá được qua đường dẫn NCC 9601", async () => {
    const other = await invite(9602, "cheo@example.com");
    for (const act of ["invite", "revoke-invite", "unlock"]) expect((await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${other.account.id}/${act}`, {})).status, act).toBe(404);
    expect((await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${other.account.id}/lock`, {})).status).toBe(404);
    expect((await db().prepare(`SELECT status FROM supplier_accounts WHERE id = ?`).bind(other.account.id).first<any>()).status).toBe("invited");
  });
});

describe("đăng nhập", () => {
  it("sai mật khẩu / email không tồn tại / chưa đặt mật khẩu / tài khoản khoá: cùng 401 và cùng nội dung (không lộ tồn tại)", async () => {
    await mkNcc(9601, "dn1@example.com");
    const pending = await invite(9601, "chua-dat@example.com");
    const locked = await mkNcc(9601, "dn-khoa@example.com");
    const accId = locked.account.id as number;
    expect((await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${accId}/lock`, { reason: "nghỉ việc" })).body.account.status).toBe("locked");
    const results = [
      await login("dn1@example.com", "SaiMatKhau-123"),
      await login("khong-co@example.com", "SaiMatKhau-123"),
      await login("chua-dat@example.com", "SaiMatKhau-123"),
      await login("dn-khoa@example.com", NCC_PW), // đúng mật khẩu nhưng đã bị khoá
    ];
    for (const r of results) expect(r.status).toBe(401);
    for (const r of results) expect(r.body.error).toEqual(results[0].body.error);
    expect(results[0].body.error.code).toBe("invalid_credentials");
    expect(pending.account.status).toBe("invited");
    // mở khoá → vào lại được
    await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${accId}/unlock`, {});
    expect((await login("dn-khoa@example.com", NCC_PW)).status).toBe(200);
  });

  it("khoá 5 lần sai (theo tài khoản + IP, 15 phút): lần thứ 6 đúng mật khẩu vẫn bị từ chối, phản hồi y hệt; IP khác không bị khoá", async () => {
    await mkNcc(9601, "khoa5@example.com");
    const ip1 = { "cf-connecting-ip": "10.1.1.1" };
    for (let i = 0; i < 5; i++) expect((await login("khoa5@example.com", `Sai-${i}-xxxxxxx`, {}, ip1)).status).toBe(401);
    const lockedTry = await login("khoa5@example.com", NCC_PW, {}, ip1);
    expect(lockedTry.status).toBe(401);
    expect(lockedTry.body.error.code).toBe("invalid_credentials");
    expect((await login("khoa5@example.com", NCC_PW, {}, { "cf-connecting-ip": "10.2.2.2" })).status).toBe(200);
    expect((await db().prepare(`SELECT failed_logins FROM supplier_accounts WHERE email = 'khoa5@example.com'`).first<any>()).failed_logins).toBe(0); // đăng nhập thành công ở IP khác đã đặt lại
  });

  it("đăng nhập đúng: audit actor = supplier_account:<id>, ghi last_login; đăng xuất thu hồi phiên", async () => {
    const s = await mkNcc(9601, "audit@example.com");
    const aud = await db().prepare(`SELECT actor, user_id, ip FROM audit_log WHERE action = 'ncc.login_ok' AND entity_id = ?`).bind(String(s.account.id)).first<any>();
    expect(aud).toMatchObject({ actor: `supplier_account:${s.account.id}`, user_id: null });
    expect((await ncc(s, "GET", "/me")).body.account.email).toBe("audit@example.com");
    expect((await ncc(s, "POST", "/auth/logout")).status).toBe(200);
    expect((await ncc(s, "GET", "/me")).status).toBe(401);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'ncc.logout' AND actor = ?`).bind(`supplier_account:${s.account.id}`).first<any>()).n).toBe(1);
  });

  it("Turnstile: môi trường thật thiếu secret → 503; có secret mà thiếu token → 403", async () => {
    expect((await login("a@example.com", "x", { APP_ENV: "production" })).status).toBe(503);
    expect((await login("a@example.com", "x", { APP_ENV: "production", TURNSTILE_SECRET: "s" })).status).toBe(403);
    expect((await call("POST", "/api/ncc/auth/accept", { token: "1.xxxxxxxxxxxxxxxxxxxxxxxxxxxx", password: NCC_PW }, { env: { APP_ENV: "production", TURNSTILE_SECRET: "s" } })).status).toBe(403);
  });

  it("rate limit: login / invite / accept / đổi mật khẩu dùng RL_AUTH (khoá theo nhóm + IP); bị từ chối → 429", async () => {
    _resetRateLimitWarn();
    const keys: string[] = [];
    const RL_AUTH = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    const RATE_LIMITER = { limit: async () => ({ success: true }) };
    const h = { "cf-connecting-ip": "9.9.9.9" };
    await call("POST", "/api/ncc/auth/login", { email: "a@example.com", password: "x" }, { env: { RL_AUTH, RATE_LIMITER }, headers: h });
    await call("POST", "/api/ncc/auth/invite", { token: "abcdefghijk" }, { env: { RL_AUTH, RATE_LIMITER }, headers: h });
    await call("POST", "/api/ncc/auth/accept", { token: "abcdefghijk", password: NCC_PW }, { env: { RL_AUTH, RATE_LIMITER }, headers: h });
    await call("POST", "/api/ncc/me/password", {}, { env: { RL_AUTH, RATE_LIMITER }, headers: h });
    expect(keys).toEqual(["ncc-auth:login:9.9.9.9", "ncc-auth:invite:9.9.9.9", "ncc-auth:accept:9.9.9.9", "ncc-auth:password:9.9.9.9"]);
    const deny = { limit: async () => ({ success: false }) };
    for (const p of ["login", "invite", "accept"]) expect((await call("POST", `/api/ncc/auth/${p}`, {}, { env: { RL_AUTH: deny } })).status, p).toBe(429);
  });
});

describe("phiên riêng, CSRF, tách khỏi khách và nhân viên", () => {
  it("API cần phiên: không cookie → 401; cookie rác → 401; không nhận Bearer", async () => {
    expect((await call("GET", "/api/ncc/orders")).status).toBe(401);
    expect((await call("GET", "/api/ncc/orders", undefined, { headers: { cookie: "__Host-ncc=rac" } })).status).toBe(401);
    expect((await call("GET", "/api/ncc/orders", undefined, { headers: { authorization: "Bearer rac" } })).status).toBe(401);
  });

  it("CSRF: request ghi có cookie NCC mà thiếu header X-Requested-With → 403 csrf (kể cả có Authorization)", async () => {
    const s = await mkNcc(9601, "csrf@example.com");
    const cookie = { cookie: s.headers.cookie };
    for (const h of [cookie, { ...cookie, authorization: "Bearer x" }]) {
      const r = await call("POST", "/api/ncc/me/password", { currentPassword: NCC_PW, newPassword: NCC_PW_NEW }, { headers: h });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("csrf");
    }
    expect((await ncc(s, "POST", "/me/password", { currentPassword: NCC_PW_WRONG, newPassword: NCC_PW_NEW })).status).toBe(403); // có header → vào được logic (sai mật khẩu)
    expect((await call("GET", "/api/ncc/me", undefined, { headers: cookie })).status).toBe(200); // GET không cần header
  });

  it("phiên khách (shop) và phiên NCC không dùng chung: cookie khách không vào /api/ncc, cookie NCC không vào /api/me", async () => {
    const guest = await register("khach-ncc@example.com");
    expect((await call("GET", "/api/ncc/me", undefined, { headers: guest.headers })).status).toBe(401);
    expect((await call("GET", "/api/ncc/orders", undefined, { headers: guest.headers })).status).toBe(401);
    const s = await mkNcc(9601, "tach@example.com");
    expect((await call("GET", "/api/me", undefined, { headers: { cookie: s.headers.cookie.replace("__Host-ncc", "__Host-hm_shop"), "x-requested-with": "hm-shop" } })).status).toBe(401);
    expect((await call("GET", "/api/me", undefined, { headers: s.headers })).status).toBe(401);
    // đăng xuất khách không ảnh hưởng phiên NCC
    await call("POST", "/api/auth/logout", {}, { headers: guest.headers });
    expect((await ncc(s, "GET", "/me")).status).toBe(200);
    // cookie NCC không phải là token ERP
    const tok = s.headers.cookie.split("=")[1];
    expect((await app_erp_me(tok)).status).toBe(401);
  });

  it("đổi mật khẩu: sai mật khẩu hiện tại → 403; trùng cũ → 422; thành công thu hồi phiên khác, giữ phiên hiện tại", async () => {
    const a = await mkNcc(9601, "doi-mk@example.com");
    const b = await loginNcc("doi-mk@example.com");
    expect((await ncc(a, "POST", "/me/password", { currentPassword: NCC_PW_WRONG, newPassword: NCC_PW_NEW })).status).toBe(403);
    expect((await ncc(a, "POST", "/me/password", { currentPassword: NCC_PW, newPassword: NCC_PW })).status).toBe(422);
    expect((await ncc(a, "POST", "/me/password", { currentPassword: NCC_PW, newPassword: "ngan" })).status).toBe(422);
    expect((await ncc(a, "POST", "/me/password", { currentPassword: NCC_PW, newPassword: NCC_PW_NEW })).status).toBe(200);
    expect((await ncc(a, "GET", "/me")).status).toBe(200);
    expect((await ncc(b, "GET", "/me")).status).toBe(401);
    expect((await login("doi-mk@example.com", NCC_PW)).status).toBe(401);
    expect((await login("doi-mk@example.com", NCC_PW_NEW)).status).toBe(200);
  });

  it("khoá từ ERP thu hồi phiên đang mở ngay; NCC ngừng giao dịch cũng không vào được; portal_enabled=0 chặn cả đăng nhập lẫn phiên", async () => {
    const s = await mkNcc(9601, "thu-hoi@example.com");
    expect((await ncc(s, "GET", "/me")).status).toBe(200);
    await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${s.account.id}/lock`, {});
    expect((await ncc(s, "GET", "/me")).status).toBe(401);
    await api("manager", "POST", `${V}/suppliers/9601/portal/accounts/${s.account.id}/unlock`, {});
    const s2 = await loginNcc("thu-hoi@example.com");
    expect((await ncc(s2, "GET", "/me")).status).toBe(200);
    await db().prepare(`UPDATE settings SET value = '0' WHERE key = 'ncc.portal_enabled'`).run();
    try {
      expect((await ncc(s2, "GET", "/me")).status).toBe(503);
      expect((await login("thu-hoi@example.com", NCC_PW)).status).toBe(503);
    } finally { await db().prepare(`UPDATE settings SET value = '1' WHERE key = 'ncc.portal_enabled'`).run(); }
    await db().prepare(`UPDATE suppliers SET active = 0 WHERE id = 9601`).run();
    try { expect((await ncc(s2, "GET", "/me")).status).toBe(401); } finally { await db().prepare(`UPDATE suppliers SET active = 1 WHERE id = 9601`).run(); }
  });

  it("danh sách người dùng của NCC chỉ có tài khoản cùng NCC, không có NCC khác / người mời", async () => {
    const s = await mkNcc(9601, "ds-nd@example.com");
    await mkNcc(9602, "khac-ncc@example.com");
    const r = await ncc(s, "GET", "/users");
    expect(r.status).toBe(200);
    const emails = r.body.items.map((u: any) => u.email);
    expect(emails).toContain("ds-nd@example.com");
    expect(emails).not.toContain("khac-ncc@example.com");
    expect(r.body.items.find((u: any) => u.isMe).email).toBe("ds-nd@example.com");
    expect(JSON.stringify(r.body)).not.toMatch(/invited_by|invitedBy|pass|hash|locked_by/i);
    expect(Object.keys(r.body.items[0]).sort()).toEqual(["email", "fullName", "id", "isMe", "lastLoginAt", "phone", "status"]);
  });
});

import { app } from "../src/worker/index";
import { testEnv } from "./helpers";
async function app_erp_me(token: string) {
  return app.request("/api/auth/me", { headers: { authorization: `Bearer ${token}` } }, testEnv);
}
