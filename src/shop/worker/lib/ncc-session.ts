import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256 } from "../../../worker/lib/crypto";
import { AppError } from "../../../worker/lib/errors";
import type { ShopBindings, ShopEnv, SupplierAccount } from "../env";
import { clientIp, httpError, setting, type SCtx } from "./util";

/**
 * Phiên cổng nhà cung cấp (/ncc). TÁCH hẳn phiên khách (__Host-hm_shop / shop_sessions) và nhân viên ERP:
 * cookie riêng `__Host-ncc` (HttpOnly, Secure, SameSite=Strict, Path=/), bảng riêng supplier_sessions, KHÔNG nhận Bearer.
 * CSRF: mọi request ghi bắt buộc header X-Requested-With: hm-shop (cộng SameSite=Strict).
 */
export const NCC_COOKIE = "__Host-ncc";
export const NCC_SESSION_DAYS = 7;

export const nccTokenOf = (c: SCtx): string | null => getCookie(c, NCC_COOKIE) ?? null;

export async function loadSupplier(env: ShopEnv, token: string): Promise<SupplierAccount | null> {
  const id = await sha256(token);
  const r = await env.DB.prepare(
    `SELECT a.id, a.supplier_id, a.email, a.phone, a.full_name, s.name AS supplier_name, s.code AS supplier_code
       FROM supplier_sessions ss
       JOIN supplier_accounts a ON a.id = ss.account_id
       JOIN suppliers s ON s.id = a.supplier_id
      WHERE ss.id = ? AND ss.revoked_at IS NULL AND ss.expires_at > ? AND a.status = 'active' AND s.active = 1`,
  )
    .bind(id, new Date().toISOString())
    .first<any>();
  if (!r) return null;
  return { id: r.id, supplierId: r.supplier_id, supplierName: r.supplier_name, supplierCode: r.supplier_code, email: r.email, phone: r.phone, fullName: r.full_name, sessionId: id };
}

export async function nccEnabled(db: D1Database) {
  return (await setting(db, "ncc.portal_enabled", "1")) !== "0";
}

export const assertNccEnabled = async (db: D1Database) => {
  if (!(await nccEnabled(db))) throw httpError(503, "ncc_disabled", "Cổng nhà cung cấp đang tạm đóng. Vui lòng liên hệ cửa hàng.");
};

/** Cấp phiên mới (cookie + dòng supplier_sessions). Gọi SAU khi đã xác thực. */
export async function startNccSession(c: SCtx, accountId: number) {
  const token = randomToken(32);
  const exp = new Date(Date.now() + NCC_SESSION_DAYS * 86400_000).toISOString();
  await c.env.DB.prepare(`INSERT INTO supplier_sessions(id, account_id, ip, user_agent, expires_at) VALUES (?,?,?,?,?)`)
    .bind(await sha256(token), accountId, clientIp(c), (c.req.header("user-agent") ?? "").slice(0, 200), exp)
    .run();
  setCookie(c, NCC_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: NCC_SESSION_DAYS * 86400 });
  return token;
}

export const clearNccCookie = (c: SCtx) => deleteCookie(c, NCC_COOKIE, { path: "/", secure: true });

/** Bắt buộc đăng nhập cổng NCC; nạp `c.get("supplier")`. Chỉ nhận cookie. */
export const requireSupplier: MiddlewareHandler<ShopBindings> = async (c, next) => {
  await assertNccEnabled(c.env.DB);
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && c.req.header("x-requested-with") !== "hm-shop")
    throw new AppError(403, "csrf", "Yêu cầu không hợp lệ (thiếu header X-Requested-With)");
  const t = nccTokenOf(c);
  const a = t ? await loadSupplier(c.env, t) : null;
  if (!a) throw new AppError(401, "unauthenticated", "Vui lòng đăng nhập");
  c.set("supplier", a);
  await next();
};
