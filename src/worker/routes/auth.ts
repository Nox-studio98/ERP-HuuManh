import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { AppBindings } from "../env";
import { hashPassword, randomToken, sha256, timingSafeEqual, verifyPassword } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { audit } from "../lib/audit";
import { requireAuth, SESSION_COOKIE } from "../lib/auth";
import { ROLE_PERMS } from "../lib/rbac";
import { parseBody } from "../services/http";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Hash giả để thời gian phản hồi giống nhau khi username không tồn tại (chống dò tài khoản)
const DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const PasswordSchema = z.string().min(10, "Mật khẩu tối thiểu 10 ký tự").max(128);

export const authRoutes = new Hono<AppBindings>();

authRoutes.post("/login", async (c) => {
  if (c.env.RL_AUTH && c.env.APP_ENV !== "dev") {
    const rl = await c.env.RL_AUTH.limit({ key: `login:${c.req.header("cf-connecting-ip") ?? "unknown"}` });
    if (!rl.success) throw new AppError(429, "rate_limited", "Quá nhiều lần thử, vui lòng thử lại sau");
  }
  const body = await parseBody(
    c,
    z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128), deviceId: z.string().max(64).optional() }),
  );

  const u = await c.env.DB.prepare(
    `SELECT id, pass_hash, role, active, failed_logins, locked_until, must_change_password FROM users WHERE username = ?`,
  )
    .bind(body.username)
    .first<{ id: number; pass_hash: string; role: string; active: number; failed_logins: number; locked_until: string | null; must_change_password: number }>();

  const now = new Date();
  // Luôn chạy PBKDF2 (hash giả khi không có user) và trả cùng một lỗi cho: sai mật khẩu / không tồn tại / đang khoá
  const locked = !!(u?.locked_until && u.locked_until > now.toISOString());
  const ok = await verifyPassword(body.password, u?.pass_hash ?? DUMMY_HASH);
  if (!u || !ok || !u.active || locked) {
    if (u) {
      if (locked) {
        await audit(c, { action: "auth.login_blocked_locked", entity: "user", entityId: u.id }, u.id);
      } else {
        const fails = u.failed_logins + 1;
        const lock = fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
        await c.env.DB.prepare(`UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`)
          .bind(lock ? 0 : fails, lock, u.id)
          .run();
        if (lock) await audit(c, { action: "auth.account_locked", entity: "user", entityId: u.id, after: { lockedUntil: lock } }, u.id);
      }
    }
    await audit(c, { action: "auth.login_failed", entity: "user", entityId: body.username }, u?.id ?? null);
    throw new AppError(401, "invalid_credentials", "Sai tên đăng nhập hoặc mật khẩu");
  }

  const ttlH = Number(
    (await c.env.DB.prepare(`SELECT value FROM settings WHERE key='session.ttl_hours'`).first<{ value: string }>())?.value ?? 12,
  );
  const token = randomToken();
  const expires = new Date(now.getTime() + ttlH * 3600_000);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(u.id),
    c.env.DB.prepare(`INSERT INTO sessions(id, user_id, device_id, ip, user_agent, expires_at) VALUES (?,?,?,?,?,?)`).bind(
      await sha256(token),
      u.id,
      body.deviceId ?? null,
      c.req.header("cf-connecting-ip") ?? null,
      (c.req.header("user-agent") ?? "").slice(0, 200),
      expires.toISOString(),
    ),
  ]);
  await audit(c, { action: "auth.login", entity: "user", entityId: u.id }, u.id);

  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", expires });
  // token cũng trả về cho app native (lưu trong secure storage); web chỉ dùng cookie
  return c.json({ token, expiresAt: expires.toISOString(), mustChangePassword: !!u.must_change_password });
});

authRoutes.post("/logout", requireAuth, async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(new Date().toISOString(), u.sessionId).run();
  await audit(c, { action: "auth.logout", entity: "user", entityId: u.id });
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const u = c.get("user");
  const store = u.storeId ? await c.env.DB.prepare(`SELECT name FROM stores WHERE id = ?`).bind(u.storeId).first<{ name: string }>() : null;
  return c.json({ ...u, sessionId: undefined, storeName: store?.name ?? null, permissions: [...ROLE_PERMS[u.role]] });
});

authRoutes.post("/change-password", requireAuth, async (c) => {
  const u = c.get("user");
  const body = await parseBody(c, z.object({ current: z.string(), next: PasswordSchema }));
  const row = await c.env.DB.prepare(`SELECT pass_hash FROM users WHERE id = ?`).bind(u.id).first<{ pass_hash: string }>();
  if (!row || !(await verifyPassword(body.current, row.pass_hash))) throw new AppError(401, "invalid_credentials", "Mật khẩu hiện tại không đúng");
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET pass_hash = ?, must_change_password = 0 WHERE id = ?`).bind(await hashPassword(body.next), u.id),
    // thu hồi mọi phiên khác
    c.env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`).bind(
      new Date().toISOString(),
      u.id,
      u.sessionId,
    ),
  ]);
  await audit(c, { action: "auth.password_changed", entity: "user", entityId: u.id });
  return c.json({ ok: true });
});

/**
 * Khởi tạo tài khoản chủ lần đầu. Chỉ chạy khi bảng users rỗng VÀ có header X-Bootstrap-Token khớp secret.
 * Sau khi dùng nên xoá secret: wrangler secret delete BOOTSTRAP_TOKEN
 */
authRoutes.post("/bootstrap", async (c) => {
  const expected = c.env.BOOTSTRAP_TOKEN;
  const given = c.req.header("x-bootstrap-token") ?? "";
  const enc = new TextEncoder();
  if (!expected || !timingSafeEqual(enc.encode(await sha256(given)), enc.encode(await sha256(expected)))) {
    throw new AppError(404, "not_found");
  }
  const count = await c.env.DB.prepare(`SELECT COUNT(*) n FROM users WHERE username NOT IN ('system', 'he-thong-sepay')`).first<{ n: number }>();
  if ((count?.n ?? 0) > 0) throw new AppError(409, "already_bootstrapped");
  const body = z
    .object({ username: z.string().min(3).max(64), fullName: z.string().min(1).max(100), password: PasswordSchema })
    .parse(await c.req.json());
  const r = await c.env.DB.prepare(
    `INSERT INTO users(username, full_name, pass_hash, role, store_id) VALUES (?,?,?,'owner',(SELECT MIN(id) FROM stores)) RETURNING id`,
  )
    .bind(body.username, body.fullName, await hashPassword(body.password))
    .first<{ id: number }>();
  await audit(c, { action: "auth.bootstrap_owner", entity: "user", entityId: r!.id }, r!.id);
  return c.json({ ok: true, userId: r!.id });
});
