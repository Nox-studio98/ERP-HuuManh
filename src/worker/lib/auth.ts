import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings, Role } from "../env";
import { AppError } from "./errors";
import { sha256 } from "./crypto";

export const SESSION_COOKIE = "__Host-hm_session";

/**
 * Xác thực phiên:
 *  - Web/PWA: cookie __Host- HttpOnly Secure SameSite=Strict + bắt buộc header X-Requested-With (chống CSRF).
 *  - App di động: Authorization: Bearer <token>.
 * Token chỉ lưu dạng SHA-256 trong D1.
 */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const cookie = getCookie(c, SESSION_COOKIE);
  const token = bearer ?? cookie;
  if (!token) throw new AppError(401, "unauthenticated", "Chưa đăng nhập");

  if (!bearer && c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-requested-with") !== "hm-erp") {
    throw new AppError(403, "csrf", "Thiếu header chống CSRF");
  }

  const row = await c.env.DB.prepare(
    `SELECT s.id sid, s.device_id, u.id, u.username, u.full_name, u.role, u.store_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1`,
  )
    .bind(await sha256(token), new Date().toISOString())
    .first<{ sid: string; device_id: string | null; id: number; username: string; full_name: string; role: Role; store_id: number | null }>();
  if (!row) throw new AppError(401, "session_expired", "Phiên đăng nhập hết hạn");

  c.set("user", {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    storeId: row.store_id,
    sessionId: row.sid,
    deviceId: row.device_id,
  });
  await next();
};
