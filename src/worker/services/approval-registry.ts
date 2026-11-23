import type { Context } from "hono";
import type { AppBindings } from "../env";
import type { Permission } from "../lib/rbac";

export interface ApprovalRow {
  id: number;
  type: string;
  ref_type: string | null;
  ref_id: string | null;
  payload_json: string | null;
  reason: string | null;
  requested_by: number;
}

/**
 * Mỗi module Đợt 2+ tự đăng ký cách xử lý loại yêu cầu duyệt của mình (gọi registerApprovalHandler ở top-level file route),
 * để /approvals/:id/decide (routes/admin.ts) không phải biết từng module.
 *  - perm: quyền cần có để duyệt loại này (ngoài approvals.decide).
 *  - onApprove: áp dụng tác động; có thể tự ghi DB, hoặc trả statements để gộp chung batch với việc đánh dấu approval.
 *  - onReject: statements huỷ/hoàn trạng thái chứng từ liên quan.
 */
export interface ApprovalHandler {
  perm: Permission;
  onApprove?: (c: Context<AppBindings>, a: ApprovalRow, note?: string) => Promise<D1PreparedStatement[] | void>;
  onReject?: (c: Context<AppBindings>, a: ApprovalRow, note?: string) => Promise<D1PreparedStatement[] | void>;
}

const handlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(type: string, h: ApprovalHandler) {
  handlers.set(type, h);
}

export const getApprovalHandler = (type: string) => handlers.get(type);
