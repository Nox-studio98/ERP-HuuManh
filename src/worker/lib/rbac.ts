import type { MiddlewareHandler } from "hono";
import type { AppBindings, Role } from "../env";
import { forbidden } from "./errors";

/**
 * Ma trận quyền — chuyển từ mục 12 tài liệu nghiệp vụ [Cần xác nhận].
 * Nguyên tắc: deny-by-default; mọi route phải khai báo quyền qua requirePerm().
 */
export const PERMISSIONS = [
  // M1
  "pos.sell", "pos.void", "pos.return", "pos.shift", "orders.view", "orders.online.manage", "orders.edit",
  // POS-KV đợt B: ghi nợ khách lẻ vượt ngưỡng không cần duyệt; nhập tay khoản thu khác
  "pos.credit", "pos.other_charge",
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
  // C-21: chốt công + điều chỉnh công kỳ đã chốt (tách khỏi hr.manage: kế toán cần để tính lương)
  "timesheet.close",
  // M7 giá đối thủ, M2-11 gợi ý đặt hàng, khuyến mãi / tích điểm (Đợt 4)
  "competitors.view", "competitors.write", "purchasing.view", "promotions.write", "promotions.approve", "loyalty.adjust",
  // Đơn đặt NCC (PO): write = tạo/sửa nháp, chốt đêm, nhận hàng; approve = duyệt/gửi/xử lý đề xuất NCC; approve_high = duyệt PO vượt ngưỡng (chỉ chủ)
  "purchasing.write", "purchasing.approve", "purchasing.approve_high",
  // Chung
  "reports.view", "customers.view_pii", "users.manage", "audit.view", "approvals.decide",
  // Cài đặt hệ thống: xem (chủ + quản lý), sửa (chỉ chủ)
  "settings.view", "settings.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

export const ROLE_PERMS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  manager: new Set<Permission>([
    "pos.sell", "pos.void", "pos.return", "pos.shift", "orders.view", "orders.online.manage", "orders.edit", "pos.credit", "pos.other_charge",
    "inventory.view", "inventory.write", "inventory.approve", "products.write",
    "prices.view_sell", "prices.view_cost", "prices.write", "prices.approve",
    "finance.view", "finance.shift_reconcile",
    "reports.view", "customers.view_pii", "approvals.decide", "audit.view", "settings.view",
    "b2b.view", "b2b.write", "b2b.approve", "b2b.deliver", "debt.view", "debt.write", "invoices.issue",
    // M9: quản lý xem chấm công, xếp ca, duyệt quên chấm/phép/tăng ca (không xem lương)
    "hr.self", "hr.view", "hr.schedule",
    "competitors.view", "competitors.write", "purchasing.view", "purchasing.write", "purchasing.approve", "promotions.write", "promotions.approve", "loyalty.adjust",
  ]),
  cashier: new Set<Permission>(["pos.sell", "pos.return", "pos.shift", "orders.view", "prices.view_sell", "inventory.view", "finance.shift_reconcile", "hr.self"]),
  // Thủ kho: xem đơn sỉ cần xuất, soạn/giao hàng; xem công nợ (mục 12)
  warehouse: new Set<Permission>(["inventory.view", "inventory.write", "prices.view_cost", "orders.view", "b2b.view", "b2b.deliver", "debt.view", "hr.self", "purchasing.view", "purchasing.write"]),
  accountant: new Set<Permission>([
    "orders.view", "inventory.view", "prices.view_sell", "prices.view_cost",
    "finance.view", "finance.write", "reports.view", "customers.view_pii",
    "b2b.view", "debt.view", "debt.write", "invoices.issue",
    // M9 (C-21, chủ đã chốt): kế toán chỉ XEM hồ sơ nhân viên (kể cả dữ liệu nhạy cảm cần cho lương), chốt công và làm bảng lương
    // (chủ duyệt). KHÔNG có hr.manage: không tạo/sửa hồ sơ, hợp đồng, phụ cấp, không cho nghỉ việc/khoá tài khoản.
    "hr.self", "hr.view", "hr.sensitive", "payroll.write", "timesheet.close",
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
