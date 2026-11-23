import type { Hono } from "hono";
import type { AppBindings } from "../env";
import { productRoutes } from "./products";
import { inventoryRoutes } from "./inventory";
import { priceRoutes } from "./prices";
import { posRoutes } from "./pos";
import { financeRoutes } from "./finance";
import { reportRoutes } from "./reports";
import { adminRoutes } from "./admin";
// Đợt 2
import { customerRoutes } from "./customers";
import { quoteRoutes } from "./quotes";
import { b2bRoutes } from "./b2b";
import { debtRoutes } from "./debts";
import { integrationRoutes } from "./integrations";
import { exportRoutes } from "./exports";
// Đợt 3
import { onlineOrderRoutes } from "./online-orders";
import { cmsRoutes } from "./cms";

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
  v1.route("/", customerRoutes);
  v1.route("/", quoteRoutes);
  v1.route("/", b2bRoutes);
  v1.route("/", debtRoutes);
  v1.route("/", integrationRoutes);
  v1.route("/", exportRoutes);
  v1.route("/", onlineOrderRoutes);
  v1.route("/", cmsRoutes);
}
