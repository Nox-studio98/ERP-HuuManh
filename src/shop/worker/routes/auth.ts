import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { hashPassword, randomToken, sha256, verifyPassword } from "../../../worker/lib/crypto";
import { AppError } from "../../../worker/lib/errors";
import { nextCode } from "../../../worker/lib/codes";
import { sysAuditStmt } from "../../../worker/services/sysaudit";
import type { ShopBindings, ShopAccount } from "../env";
import { SESSION_COOKIE, SESSION_DAYS, loadAccount, sessionTokenOf } from "../lib/session";
import { verifyTurnstile } from "../lib/turnstile";
import { baseUrl, clientIp, enqueueByRef, normalizePhone, parseBody, type SCtx } from "../lib/util";

export const authRoutes = new Hono<ShopBindings>();

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const TOKEN_TTL_MS = 3600_000;
const DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const Email = z.string().trim().toLowerCase().email().max(200);
const Password = z.string().min(8, "Mật khẩu tối thiểu 8 ký tự").max(128);
const GENERIC_OK = { ok: true, message: "Nếu thông tin hợp lệ, chúng tôi đã gửi email hướng dẫn." };

export const meShape = (a: ShopAccount) => ({
  id: a.id, fullName: a.fullName, email: a.email, phone: a.phone, kind: a.kind, b2bStatus: a.b2bStatus,
  customerGroup: a.customerGroup, marketingOptIn: a.marketingOptIn,
});

async function startSession(c: SCtx, accountId: number) {
  const token = randomToken(32);
  const exp = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await c.env.DB.prepare(`INSERT INTO shop_sessions(id, account_id, ip, user_agent, expires_at) VALUES (?,?,?,?,?)`)
    .bind(await sha256(token), accountId, clientIp(c), (c.req.header("user-agent") ?? "").slice(0, 200), exp)
    .run();
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
  return token;
}

/** Tạo token một lần (lưu SHA-256), trả token gốc CHỈ để đưa vào link trong payload job email — không ghi log/audit. */
async function issueToken(db: D1Database, accountId: number, purpose: "verify_email" | "reset_password") {
  const token = randomToken(32);
  const stmt = db
    .prepare(`INSERT INTO shop_tokens(id, account_id, purpose, expires_at) VALUES (?,?,?,?)`)
    .bind(await sha256(token), accountId, purpose, new Date(Date.now() + TOKEN_TTL_MS).toISOString());
  return { token, stmt };
}

authRoutes.post("/register", async (c) => {
  await verifyTurnstile(c);
  const b = await parseBody(c, z.object({
    fullName: z.string().trim().min(1).max(100), email: Email, phone: z.string().trim().min(8).max(20), password: Password, marketingOptIn: z.boolean().optional(),
  }));
  const phone = normalizePhone(b.phone);
  if (!phone) throw new AppError(422, "invalid_phone", "Số điện thoại không hợp lệ");
  const db = c.env.DB;
  const exists = await db.prepare(`SELECT id FROM shop_accounts WHERE email = ?`).bind(b.email).first();
  if (exists) {
    await hashPassword(b.password); // cân bằng thời gian phản hồi
    return c.json(GENERIC_OK, 201); // không tiết lộ email đã tồn tại
  }
  const groupId = (await db.prepare(`SELECT id FROM customer_groups WHERE code = 'le'`).first<{ id: number }>())?.id ?? null;
  const ccode = await nextCode(db, "KL");
  const passHash = await hashPassword(b.password);
  const token = randomToken(32);
  const tokenId = await sha256(token);
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO customers(code, type, name, phone, email, customer_group_id, created_at) VALUES (?, 'retail', ?, ?, ?, ?, ?)`)
        .bind(ccode, b.fullName, phone, b.email, groupId, new Date().toISOString()),
      db
        .prepare(`INSERT INTO shop_accounts(customer_id, email, phone, full_name, pass_hash, kind, marketing_opt_in) VALUES ((SELECT id FROM customers WHERE code = ?), ?, ?, ?, ?, 'retail', ?)`)
        .bind(ccode, b.email, phone, b.fullName, passHash, b.marketingOptIn ? 1 : 0),
      db
        .prepare(`INSERT INTO shop_tokens(id, account_id, purpose, expires_at) VALUES (?, (SELECT id FROM shop_accounts WHERE email = ?), 'verify_email', ?)`)
        .bind(tokenId, b.email, new Date(Date.now() + TOKEN_TTL_MS).toISOString()),
      enqueueByRef(db, "notify.email", "shop_account", b.email, { to: b.email, template: "verify_email", link: `${baseUrl(c)}/verify-email?token=${token}` }),
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as Error)?.message))) return c.json(GENERIC_OK, 201); // đăng ký trùng đồng thời
    throw e;
  }
  return c.json(GENERIC_OK, 201);
});

authRoutes.post("/login", async (c) => {
  await verifyTurnstile(c);
  const b = await parseBody(c, z.object({ email: Email, password: z.string().min(1).max(128) }));
  const db = c.env.DB;
  const u = await db
    .prepare(`SELECT id, pass_hash, active, failed_logins, locked_until FROM shop_accounts WHERE email = ? AND deleted_at IS NULL`)
    .bind(b.email)
    .first<{ id: number; pass_hash: string; active: number; failed_logins: number; locked_until: string | null }>();
  const now = new Date();
  if (u?.locked_until && u.locked_until > now.toISOString()) throw new AppError(429, "account_locked", "Đăng nhập sai quá nhiều lần, vui lòng thử lại sau 15 phút");
  const ok = await verifyPassword(b.password, u?.pass_hash ?? DUMMY_HASH);
  if (!u || !ok || !u.active) {
    if (u) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      await db.prepare(`UPDATE shop_accounts SET failed_logins = ?, locked_until = ? WHERE id = ?`).bind(lock ? 0 : fails, lock, u.id).run();
    }
    throw new AppError(401, "invalid_credentials", "Email hoặc mật khẩu không đúng");
  }
  // xoay vòng: thu hồi phiên đang dùng (nếu có) rồi cấp phiên mới
  const old = sessionTokenOf(c);
  const stmts = [db.prepare(`UPDATE shop_accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?`).bind(u.id)];
  if (old) stmts.push(db.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(now.toISOString(), await sha256(old)));
  await db.batch(stmts);
  const token = await startSession(c, u.id);
  const acc = (await loadAccount(c.env, token))!;
  // Token chỉ trả trong body cho app native (header X-Client: native); web chỉ dùng cookie HttpOnly.
  return c.json({ account: meShape(acc), ...(c.req.header("x-client") === "native" ? { token } : {}) });
});

authRoutes.post("/logout", async (c) => {
  const t = sessionTokenOf(c);
  if (t) await c.env.DB.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(new Date().toISOString(), await sha256(t)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

authRoutes.post("/forgot", async (c) => {
  await verifyTurnstile(c);
  const b = await parseBody(c, z.object({ email: Email }));
  const db = c.env.DB;
  const u = await db.prepare(`SELECT id FROM shop_accounts WHERE email = ? AND active = 1 AND deleted_at IS NULL`).bind(b.email).first<{ id: number }>();
  if (u) {
    const { token, stmt } = await issueToken(db, u.id, "reset_password");
    await db.batch([stmt, enqueueByRef(db, "notify.email", "shop_account", b.email, { to: b.email, template: "reset_password", link: `${baseUrl(c)}/reset-password?token=${token}` })]);
  } else await hashPassword("x"); // cân bằng thời gian
  return c.json(GENERIC_OK);
});

/** Dùng token một lần: đánh dấu used_at có điều kiện (an toàn khi hai request cùng lúc). */
async function consumeToken(db: D1Database, token: string, purpose: string) {
  const id = await sha256(token);
  const now = new Date().toISOString();
  const r = await db
    .prepare(`UPDATE shop_tokens SET used_at = ? WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING account_id`)
    .bind(now, id, purpose, now)
    .first<{ account_id: number }>();
  if (!r) throw new AppError(400, "invalid_token", "Liên kết không hợp lệ hoặc đã hết hạn");
  return r.account_id;
}

authRoutes.post("/reset", async (c) => {
  const b = await parseBody(c, z.object({ token: z.string().min(10).max(200), password: Password }));
  const db = c.env.DB;
  const accountId = await consumeToken(db, b.token, "reset_password");
  const hash = await hashPassword(b.password);
  await db.batch([
    db.prepare(`UPDATE shop_accounts SET pass_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ? AND deleted_at IS NULL`).bind(hash, accountId),
    db.prepare(`UPDATE shop_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`).bind(new Date().toISOString(), accountId),
    sysAuditStmt(db, { action: "shop.password_reset", entity: "shop_account", entityId: accountId }),
  ]);
  return c.json({ ok: true });
});

authRoutes.post("/verify-email", async (c) => {
  const b = await parseBody(c, z.object({ token: z.string().min(10).max(200) }));
  const accountId = await consumeToken(c.env.DB, b.token, "verify_email");
  await c.env.DB.prepare(`UPDATE shop_accounts SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`).bind(new Date().toISOString(), accountId).run();
  return c.json({ ok: true });
});
