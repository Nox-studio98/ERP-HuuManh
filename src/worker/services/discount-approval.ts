import type { Context } from "hono";
import type { AppBindings } from "../env";
import { AppError, conflict } from "../lib/errors";
import { auditStmt } from "../lib/audit";

type Ctx = Context<AppBindings>;

/** Băm giỏ hàng (dòng + giảm giá) để phiếu duyệt gắn với đúng giỏ đã được quản lý xem. */
export async function cartHashOf(canon: unknown): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canon)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Yêu cầu duyệt giảm giá vượt ngưỡng / bán dưới giá vốn / ghi nợ vượt ngưỡng (A-29): nguồn duy nhất cho `POST /pos/orders` và đơn giao từ quầy.
 * Cùng bảng `approvals` + màn Duyệt với POS: trả approvalId đã duyệt (chưa dùng), hoặc ném 409 `approval_required`.
 * Phiếu chỉ dùng một lần: bên gọi phải đưa `assertStmt(... approvals.status='approved' AND ref_id IS NULL)` + `UPDATE approvals SET ref_id` vào batch ghi đơn.
 */
export async function requireDiscountApproval(c: Ctx, clientUuid: string, approvalId: number | undefined, reasons: string[], payload: object, hash: string): Promise<number> {
  const db = c.env.DB;
  const user = c.get("user");
  const type = reasons.includes("below_cost") ? "order.below_cost" : reasons.includes("discount") ? "order.discount" : "order.credit";
  if (approvalId) {
    const a = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(approvalId).first<any>();
    const okUuid = a && (() => { try { const j = JSON.parse(a.payload_json ?? "{}"); return j.clientUuid === clientUuid && j.hash === hash; } catch { return false; } })();
    // C2-04: lý do hiện tại phải nằm trong lý do người duyệt đã thấy; duyệt vượt hạn mức bao cả vượt ngưỡng
    const okReasons = a && (() => {
      try {
        const approved = new Set<string>(JSON.parse(a.payload_json ?? "{}").reasons ?? []);
        if (approved.has("credit_limit")) approved.add("credit");
        return reasons.every((r) => approved.has(r));
      } catch { return false; }
    })();
    if (a && okUuid && okReasons && a.requested_by === user.id && a.type === type) {
      if (a.status === "approved" && !a.ref_id) return a.id;
      if (a.status === "rejected") throw new AppError(403, "approval_rejected", "Yêu cầu duyệt đã bị từ chối", { approvalId: a.id });
      if (a.status === "pending") throw conflict("approval_required", "Đang chờ quản lý duyệt", { approvalId: a.id, reasons });
    }
    throw conflict("approval_invalid", "Mã duyệt không hợp lệ hoặc đã được sử dụng", { approvalId });
  }
  const pending = await db
    .prepare(`SELECT id FROM approvals WHERE type LIKE 'order.%' AND status='pending' AND requested_by=? AND json_extract(payload_json,'$.clientUuid')=? AND json_extract(payload_json,'$.hash')=? AND type=? AND json_extract(payload_json,'$.reasons')=?`)
    .bind(user.id, clientUuid, hash, type, JSON.stringify(reasons))
    .first<{ id: number }>();
  let id = pending?.id;
  if (!id) {
    const r = await db
      .prepare(`INSERT INTO approvals(type, ref_type, payload_json, reason, requested_by) VALUES (?,?,?,?,?)`)
      .bind(type, "order_draft", JSON.stringify({ clientUuid, reasons, hash, ...payload }), reasons.join(","), user.id)
      .run();
    id = r.meta.last_row_id as number;
    await auditStmt(c, { action: "approval.request", entity: "approval", entityId: id, after: { type, reasons } }).run();
  }
  throw conflict(
    "approval_required",
    reasons.includes("below_cost") ? "Giá bán thấp hơn giá vốn, cần quản lý duyệt" : reasons.includes("discount") ? "Giảm giá vượt ngưỡng, cần quản lý duyệt" : reasons.includes("credit_limit") ? "Ghi nợ vượt hạn mức của khách, cần quản lý duyệt" : "Ghi nợ vượt ngưỡng cho phép, cần quản lý duyệt",
    { approvalId: id, reasons },
  );
}
