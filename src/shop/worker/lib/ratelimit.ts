import type { MiddlewareHandler } from "hono";
import type { ShopBindings } from "../env";
import { clientIp, httpError } from "./util";

/**
 * Giới hạn tần suất theo IP bằng binding RATE_LIMITER (Workers Rate Limiting) nếu có; không có → bỏ qua.
 * Nhóm khoá: auth (10/phút), checkout (20/phút), còn lại (120/phút) — mức cụ thể cấu hình ở binding;
 * một binding chỉ có một ngưỡng nên tách bằng tiền tố khoá để ghép nhiều binding khi triển khai.
 */
export const rateLimit: MiddlewareHandler<ShopBindings> = async (c, next) => {
  const rl = c.env.RATE_LIMITER;
  if (rl) {
    const p = c.req.path;
    const bucket = p.startsWith("/api/auth/") ? "auth" : p === "/api/checkout" ? "checkout" : "api";
    const r = await rl.limit({ key: `${bucket}:${clientIp(c)}` });
    if (!r.success) throw httpError(429, "rate_limited", "Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút");
  }
  await next();
};
