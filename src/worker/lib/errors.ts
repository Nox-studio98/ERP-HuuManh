import type { Context } from "hono";
import { ZodError } from "zod";

type Status = 400 | 401 | 403 | 404 | 409 | 422 | 423 | 429 | 500 | 501 | 503;

export class AppError extends Error {
  constructor(public status: Status, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}
export const badRequest = (code: string, msg?: string, d?: unknown) => new AppError(400, code, msg, d);
export const forbidden = (code = "forbidden", msg = "Không có quyền") => new AppError(403, code, msg);
export const notFound = (code = "not_found", msg = "Không tìm thấy") => new AppError(404, code, msg);
export const conflict = (code: string, msg?: string, d?: unknown) => new AppError(409, code, msg, d);

/** Lỗi trả về client: không lộ stack/SQL ra ngoài. */
export function onError(err: Error, c: Context) {
  const requestId = c.get("requestId");
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details }, requestId }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: { code: "validation_error", message: "Dữ liệu không hợp lệ", details: err.issues }, requestId }, 422);
  }
  const msg = String(err?.message ?? "");
  if (msg.includes("period_locked")) {
    return c.json(
      { error: { code: "period_locked", message: "Kỳ đã khoá sổ, chỉ được lập bút toán điều chỉnh ở kỳ sau" }, requestId },
      423,
    );
  }
  if (msg.includes("state_changed")) {
    return c.json({ error: { code: "state_changed", message: "Dữ liệu vừa được người khác thay đổi — vui lòng tải lại và thử lại" }, requestId }, 409);
  }
  if (msg.includes("UNIQUE constraint failed: once_keys")) {
    return c.json({ error: { code: "already_done", message: "Thao tác này đã được thực hiện" }, requestId }, 409);
  }
  if (msg.includes("overallocated")) {
    return c.json({ error: { code: "overallocated", message: "Số tiền gạch vượt số còn nợ của chứng từ" }, requestId }, 409);
  }
  if (msg.includes("idx_vouchers_reverse_once") || msg.includes("cash_vouchers.reverses_id")) {
    return c.json({ error: { code: "already_reversed", message: "Phiếu này đã được đảo" }, requestId }, 409);
  }
  if (msg.includes("CHECK constraint failed")) {
    return c.json(
      { error: { code: "constraint_violation", message: "Vi phạm ràng buộc dữ liệu (tồn kho có thể vừa thay đổi)" }, requestId },
      409,
    );
  }
  console.error(JSON.stringify({ level: "error", requestId, msg, stack: err?.stack }));
  return c.json({ error: { code: "internal_error", message: "Lỗi hệ thống" }, requestId }, 500);
}
