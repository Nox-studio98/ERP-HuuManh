import type { Hono } from "hono";
import type { AppBindings } from "../env";

/**
 * Nơi đăng ký route các module. Mỗi module 1 file trong src/worker/routes/, export một Hono<AppBindings>.
 * Đợt 1: products (M2-01), inventory (M2), prices (M3), pos (M1), finance (M6), reports, users, approvals.
 */
export function registerModuleRoutes(_v1: Hono<AppBindings>) {
  // v1.route("/products", productRoutes) ...
}
