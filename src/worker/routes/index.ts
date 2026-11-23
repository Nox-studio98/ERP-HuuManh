import type { Hono } from "hono";
import type { AppBindings } from "../env";
import { productRoutes } from "./products";
import { inventoryRoutes } from "./inventory";
import { priceRoutes } from "./prices";
import { posRoutes } from "./pos";
import { financeRoutes } from "./finance";
import { reportRoutes } from "./reports";
import { adminRoutes } from "./admin";

/**
 * Đăng ký route các module. Mỗi file export một Hono<AppBindings> mount tại gốc /api/v1
 * (mỗi file tự khai báo đường dẫn đầy đủ như trong docs/API.md, ví dụ "/products", "/stock-docs").
 */
export function registerModuleRoutes(v1: Hono<AppBindings>) {
  v1.route("/", productRoutes);
  v1.route("/", inventoryRoutes);
  v1.route("/", priceRoutes);
  v1.route("/", posRoutes);
  v1.route("/", financeRoutes);
  v1.route("/", reportRoutes);
  v1.route("/", adminRoutes);
}
