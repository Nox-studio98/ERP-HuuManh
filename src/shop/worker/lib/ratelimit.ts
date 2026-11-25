import type { Context, MiddlewareHandler } from "hono";
import type { ShopBindings } from "../env";
import { clientIp, httpError } from "./util";

let warnedMissing = false;

/** Nhóm khoá theo đường dẫn: auth → RL_AUTH (chặt); checkout/báo giá/còn lại → RATE_LIMITER. */
export function rateBucket(method: string, path: string): { bucket: string; strict: boolean } {
  if (/^\/api\/auth\/(login|register|forgot|reset|verify-email)$/.test(path)) return { bucket: `auth:${path.slice(10)}`, strict: true };
  if (path.startsWith("/api/auth/")) return { bucket: "auth", strict: true };
  // Cổng NCC: đăng nhập / kiểm tra + đặt mật khẩu từ link mời / đổi mật khẩu dùng nhóm chặt (RL_AUTH)
  if (/^\/api\/ncc\/auth\/(login|invite|accept)$/.test(path) || path === "/api/ncc/me/password") return { bucket: `ncc-auth:${path.split("/").pop()}`, strict: true };
  if (path === "/api/checkout") return { bucket: "checkout", strict: false };
  if (path.startsWith("/api/payments/")) return { bucket: "payments", strict: false };
  if (/quote/.test(path)) return { bucket: "quote", strict: false };
  return { bucket: method === "GET" ? "read" : "write", strict: false };
}

/**
 * Giới hạn tần suất theo IP bằng Workers Rate Limiting. Auth dùng RL_AUTH (rơi về RATE_LIMITER nếu thiếu);
 * còn lại dùng RATE_LIMITER. Thiếu binding ở môi trường không phải dev → cảnh báo MỘT lần (không hỏng cứng).
 */
export const rateLimit: MiddlewareHandler<ShopBindings> = async (c, next) => {
  const { bucket, strict } = rateBucket(c.req.method, c.req.path);
  const rl = strict ? (c.env.RL_AUTH ?? c.env.RATE_LIMITER) : c.env.RATE_LIMITER;
  if (rl) {
    const r = await rl.limit({ key: `${bucket}:${clientIp(c)}` });
    if (!r.success) throw httpError(429, "rate_limited", "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút");
  } else if (c.env.APP_ENV !== "dev" && !warnedMissing) {
    warnedMissing = true;
    console.warn(`[ratelimit] thiếu binding ${strict ? "RL_AUTH/RATE_LIMITER" : "RATE_LIMITER"} (APP_ENV=${c.env.APP_ENV}) — API công khai không được giới hạn tần suất`);
  }
  await next();
};

/** Dùng trong route (vd. checkout khách vãng lai): tính thêm một lượt vào nhóm riêng. */
export async function limitBy(c: Context<ShopBindings>, bucket: string, key: string, strict = false) {
  const rl = strict ? (c.env.RL_AUTH ?? c.env.RATE_LIMITER) : c.env.RATE_LIMITER;
  if (!rl) return;
  const r = await rl.limit({ key: `${bucket}:${key}` });
  if (!r.success) throw httpError(429, "rate_limited", "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút");
}

/** Chỉ cho test: đặt lại cờ cảnh báo. */
export const _resetRateLimitWarn = () => { warnedMissing = false; };
