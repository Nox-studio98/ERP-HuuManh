import type { MiddlewareHandler } from "hono";
import type { AppBindings, Role } from "../env";
import { forbidden } from "./errors";

/**
 * Ma trận quyền — chuyển từ mục 12 tài liệu nghiệp vụ [Cần xác nhận].
 * Nguyên tắc: deny-by-default; mọi route phải khai báo quyền qua requirePerm().
 */
export const PERMISSIONS = [
  // M1
  "pos.sell", "pos.void", "pos.return", "pos.shift", "orders.view", "orders.online.manage",
  // M2
  "inventory.view", "inventory.write", "inventory.approve", "products.write",
  // M3
  "prices.view_sell", "prices.view_cost", "prices.write", "prices.approve",
  // M6
  "finance.view", "finance.write", "finance.approve", "finance.shift_reconcile", "finance.lock_period",
  // M4 B2B (Đợt 2)
  "b2b.view", "b2b.write", "b2b.approve", "b2b.credit_override", "b2b.deliver",
  // M5 Công nợ (Đợt 2)
  "debt.view", "debt.write", "debt.approve",
  // Tích hợp (MISA, Fresco), hoá đơn điện tử
  "invoices.issue", "integrations.manage",
  // M9 Nhân sự – chấm công – lương (Đợt 4)
  "hr.self", "hr.view", "hr.schedule", "hr.manage", "hr.sensitive", "payroll.write", "payroll.approve",
  // M7 giá đối thủ, M2-11 gợi ý đặt hàng, khuyến mãi / tích điểm (Đợt 4)
  "competitors.view", "competitors.write", "purchasing.view", "promotions.write", "promotions.approve", "loyalty.adjust",
  // Chung
  "reports.view", "customers.view_pii", "users.manage", "audit.view", "approvals.decide",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

export const ROLE_PERMS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  manager: new Set<Permission>([
    "pos.sell", "pos.void", "pos.return", "pos.shift", "orders.view", "orders.online.manage",
    "inventory.view", "inventory.write", "inventory.approve", "products.write",
    "prices.view_sell", "prices.view_cost", "prices.write", "prices.approve",
    "finance.view", "finance.shift_reconcile",
    "reports.view", "customers.view_pii", "approvals.decide", "audit.view",
    "b2b.view", "b2b.write", "b2b.approve", "b2b.deliver", "debt.view", "debt.write", "invoices.issue",
    // M9: quản lý xem chấm công, xếp ca, duyệt quên chấm/phép/tăng ca (không xem lương)
    "hr.self", "hr.view", "hr.schedule",
    "competitors.view", "competitors.write", "purchasing.view", "promotions.write", "promotions.approve", "loyalty.adjust",
  ]),
  cashier: new Set<Permission>(["pos.sell", "pos.return", "pos.shift", "orders.view", "prices.view_sell", "inventory.view", "finance.shift_reconcile", "hr.self"]),
  // Thủ kho: xem đơn sỉ cần xuất, soạn/giao hàng; xem công nợ (mục 12)
  warehouse: new Set<Permission>(["inventory.view", "inventory.write", "prices.view_cost", "orders.view", "b2b.view", "b2b.deliver", "debt.view", "hr.self", "purchasing.view"]),
  accountant: new Set<Permission>([
    "orders.view", "inventory.view", "prices.view_sell", "prices.view_cost",
    "finance.view", "finance.write", "reports.view", "customers.view_pii",
    "b2b.view", "debt.view", "debt.write", "invoices.issue",
    // M9: kế toán xem chấm công, quản lý hồ sơ, tạo bảng lương (chủ duyệt)
    "hr.self", "hr.view", "hr.manage", "hr.sensitive", "payroll.write",
  ]),
  online_staff: new Set<Permission>(["orders.view", "orders.online.manage", "inventory.view", "prices.view_sell", "customers.view_pii", "b2b.view", "hr.self"]),
  // Nhân viên chỉ chấm công, xem lịch ca và phiếu lương của chính mình
  staff: new Set<Permission>(["hr.self"]),
};

// Chỉ chủ cửa hàng: vượt hạn mức nợ (EC-23), xoá nợ (M5-08), cấu hình tích hợp — owner có ALL.

export const can = (role: Role, p: Permission) => ROLE_PERMS[role]?.has(p) ?? false;

export function requirePerm(...perms: Permission[]): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const u = c.get("user");
    if (!u || !perms.every((p) => can(u.role, p))) throw forbidden();
    await next();
  };
}

/** Ẩn PII khách hàng (SĐT, địa chỉ) với vai trò không có quyền — M8 quy tắc, yêu cầu chung mục 12. */
export function maskPhone(phone: string | null | undefined, role: Role) {
  if (!phone) return phone ?? null;
  return can(role, "customers.view_pii") ? phone : phone.slice(0, 3) + "****" + phone.slice(-3);
}
