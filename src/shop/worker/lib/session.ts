import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { sha256 } from "../../../worker/lib/crypto";
import { AppError } from "../../../worker/lib/errors";
import type { ShopAccount, ShopBindings, ShopEnv } from "../env";
import type { SCtx } from "./util";

export const SESSION_COOKIE = "__Host-hm_shop";
export const SESSION_DAYS = 30;

export function sessionTokenOf(c: SCtx): string | null {
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  return getCookie(c, SESSION_COOKIE) ?? null;
}

export async function loadAccount(env: ShopEnv, token: string): Promise<ShopAccount | null> {
  const id = await sha256(token);
  const r = await env.DB.prepare(
    `SELECT a.id, a.customer_id, a.email, a.phone, a.full_name, a.kind, a.b2b_status, a.marketing_opt_in, a.email_verified_at,
            cu.customer_group_id, cg.code AS group_code
       FROM shop_sessions s
       JOIN shop_accounts a ON a.id = s.account_id
       JOIN customers cu ON cu.id = a.customer_id
       LEFT JOIN customer_groups cg ON cg.id = cu.customer_group_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.active = 1 AND a.deleted_at IS NULL`,
  )
    .bind(id, new Date().toISOString())
    .first<any>();
  if (!r) return null;
  return {
    id: r.id,
    customerId: r.customer_id,
    email: r.email,
    phone: r.phone,
    fullName: r.full_name,
    kind: r.kind,
    b2bStatus: r.b2b_status,
    marketingOptIn: !!r.marketing_opt_in,
    emailVerified: !!r.email_verified_at,
    customerGroupId: r.customer_group_id,
    customerGroup: r.group_code,
    sessionId: id,
  };
}

/** Nạp tài khoản nếu có phiên hợp lệ; không bắt buộc đăng nhập. */
export const optionalAuth: MiddlewareHandler<ShopBindings> = async (c, next) => {
  const t = sessionTokenOf(c);
  c.set("account", t ? await loadAccount(c.env, t) : null);
  await next();
};

export const requireAccount: MiddlewareHandler<ShopBindings> = async (c, next) => {
  const t = sessionTokenOf(c);
  const a = t ? await loadAccount(c.env, t) : null;
  if (!a) throw new AppError(401, "unauthenticated", "Vui lòng đăng nhập");
  c.set("account", a);
  await next();
};

export const requireB2b: MiddlewareHandler<ShopBindings> = async (c, next) => {
  const a = c.get("account");
  if (!a || a.kind !== "b2b" || a.b2bStatus !== "approved") throw new AppError(403, "b2b_not_approved", "Tài khoản chưa được duyệt là khách sỉ");
  await next();
};

/**
 * CSRF: request ghi (không phải GET/HEAD/OPTIONS) mang cookie phiên phải có header X-Requested-With: hm-shop.
 * (Header tuỳ biến buộc trình duyệt gửi preflight CORS; origin khác không qua được.) Bearer (app native) không cần.
 */
export const csrfGuard: MiddlewareHandler<ShopBindings> = async (c, next) => {
  const m = c.req.method;
  // Cổng NCC chỉ nhận cookie (không Bearer): request ghi mang cookie __Host-ncc luôn phải có header, kể cả khi có Authorization
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && getCookie(c, "__Host-ncc") && c.req.header("x-requested-with") !== "hm-shop")
    throw new AppError(403, "csrf", "Yêu cầu không hợp lệ (thiếu header X-Requested-With)");
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !c.req.header("authorization") && getCookie(c, SESSION_COOKIE)) {
    if (c.req.header("x-requested-with") !== "hm-shop") throw new AppError(403, "csrf", "Yêu cầu không hợp lệ (thiếu header X-Requested-With)");
  }
  await next();
};
