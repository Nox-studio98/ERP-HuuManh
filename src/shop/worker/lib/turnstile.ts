import type { ShopEnv } from "../env";
import type { SCtx } from "./util";
import { clientIp, httpError } from "./util";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Xác minh Cloudflare Turnstile (header X-Turnstile-Token).
 *  - Chưa có TURNSTILE_SECRET: APP_ENV=dev → bỏ qua; môi trường khác → 503 turnstile_not_configured.
 *  - Thiếu token / xác minh thất bại / lỗi mạng → 403 turnstile_failed. Có TURNSTILE_HOSTNAME / TURNSTILE_ACTION → phản hồi phải khớp.
 */
export async function verifyTurnstile(c: SCtx) {
  const env: ShopEnv = c.env;
  if (!env.TURNSTILE_SECRET) {
    if (env.APP_ENV === "dev") return;
    throw httpError(503, "turnstile_not_configured", "Hệ thống xác thực chống bot chưa được cấu hình");
  }
  const token = c.req.header("x-turnstile-token");
  if (!token || token.length > 2048) throw httpError(403, "turnstile_failed", "Vui lòng xác nhận bạn không phải robot");
  let ok = false;
  try {
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    const ip = clientIp(c);
    if (ip !== "unknown") form.set("remoteip", ip);
    const res = await fetch(VERIFY_URL, { method: "POST", body: form });
    if (res.ok) {
      const j = (await res.json()) as { success?: boolean; hostname?: string; action?: string };
      ok = j.success === true;
      if (ok && env.TURNSTILE_HOSTNAME && j.hostname !== env.TURNSTILE_HOSTNAME) ok = false;
      if (ok && env.TURNSTILE_ACTION && j.action !== env.TURNSTILE_ACTION) ok = false;
    }
  } catch {
    ok = false;
  }
  if (!ok) throw httpError(403, "turnstile_failed", "Xác minh chống robot không thành công, vui lòng thử lại");
}
