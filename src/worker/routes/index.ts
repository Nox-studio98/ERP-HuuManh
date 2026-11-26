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
import { retailCustomerRoutes } from "./retail-customers";
import { quoteRoutes } from "./quotes";
import { b2bRoutes } from "./b2b";
import { debtRoutes } from "./debts";
import { integrationRoutes } from "./integrations";
import { exportRoutes } from "./exports";
// Đợt 3
import { onlineOrderRoutes } from "./online-orders";
import { cmsRoutes } from "./cms";
// Đợt 4
import { hrRoutes } from "./hr";
import { payrollRoutes } from "./payroll";
import { competitorRoutes } from "./competitors";
import { purchasingRoutes } from "./purchasing";
import { purchaseReturnRoutes } from "./purchase-returns";
import { promotionRoutes } from "./promotions";
import { financeExtraRoutes } from "./finance-extra";
import { dashboardRoutes } from "./dashboard";
import { sepayRoutes } from "./sepay";
import { purchaseOrderRoutes } from "./purchase-orders";
import { supplierPortalRoutes } from "./supplier-portal";
import { shiftReportRoutes } from "./shift-report";
import { salesReportRoutes } from "./sales-reports";
import { commissionRoutes } from "./commission";

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
  v1.route("/", retailCustomerRoutes);
  v1.route("/", quoteRoutes);
  v1.route("/", b2bRoutes);
  v1.route("/", debtRoutes);
  v1.route("/", integrationRoutes);
  v1.route("/", onlineOrderRoutes);
  v1.route("/", cmsRoutes);
  v1.route("/", hrRoutes);
  v1.route("/", payrollRoutes);
  // exportRoutes sau payrollRoutes: /exports/:file bắt mọi tên, nên /exports/bang-luong.xlsx (payroll) phải đăng ký trước
  v1.route("/", exportRoutes);
  v1.route("/", competitorRoutes);
  v1.route("/", purchasingRoutes);
  v1.route("/", purchaseReturnRoutes);
  v1.route("/", promotionRoutes);
  v1.route("/", financeExtraRoutes);
  v1.route("/", dashboardRoutes);
  v1.route("/", sepayRoutes);
  v1.route("/", purchaseOrderRoutes);
  v1.route("/", supplierPortalRoutes);
  v1.route("/", shiftReportRoutes);
  v1.route("/", salesReportRoutes);
  v1.route("/", commissionRoutes);
}
