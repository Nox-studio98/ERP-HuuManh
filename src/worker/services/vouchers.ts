import type { Context } from "hono";
import type { AppBindings } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, notFound } from "../lib/errors";
import { isPeriodLocked } from "./period";
import { assertStmt } from "./guard";

/** Duyệt phiếu chi chờ duyệt → posted (dùng chung cho /vouchers/:id/approve và /approvals/:id/decide). */
export async function approveVoucher(c: Context<AppBindings>, voucherId: number, note?: string) {
  const db = c.env.DB;
  const user = c.get("user");
  const v = await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(voucherId).first<any>();
  if (!v) throw notFound("voucher_not_found", "Không tìm thấy phiếu");
  if (v.status !== "pending_approval") throw conflict("not_pending", "Phiếu không ở trạng thái chờ duyệt");
  // B-22: phiếu của kỳ đã khoá không duyệt được (trigger chặn UPDATE) → báo rõ và chỉ đường từ chối thay vì 423 chung chung
  if (await isPeriodLocked(db, v.period)) {
    throw new AppError(423, "period_locked", `Phiếu thuộc kỳ ${v.period} đã khoá sổ nên không duyệt được — hãy từ chối phiếu này và lập phiếu mới ở kỳ hiện tại`, { period: v.period, hint: "reject" });
  }
  await db.batch([
    assertStmt(db, "voucher.approve", `SELECT status = 'pending_approval' FROM cash_vouchers WHERE id = ?`, [voucherId]),
    db.prepare(`UPDATE cash_vouchers SET status='posted', approved_by=? WHERE id=? AND status='pending_approval'`).bind(user.id, voucherId),
    db
      .prepare(
        `UPDATE approvals SET status='approved', decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note=?
          WHERE type='cash_voucher.post' AND ref_id=? AND status='pending'`,
      )
      .bind(user.id, note ?? null, String(voucherId)),
    auditStmt(c, { action: "voucher.approve", entity: "cash_voucher", entityId: voucherId, before: { status: v.status }, after: { status: "posted" } }),
  ]);
  return db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(voucherId).first();
}

/**
 * B-22: từ chối / huỷ phiếu chi đang chờ duyệt (pending_approval → cancelled). Phiếu chờ duyệt chưa tác động quỹ nên huỷ được cả khi kỳ đã khoá
 * (trigger vouchers_locked_update cho phép đúng bước chuyển này). Đồng thời đóng yêu cầu duyệt tương ứng.
 */
export async function cancelPendingVoucher(c: Context<AppBindings>, voucherId: number, reason: string, action: "voucher.reject" | "voucher.cancel") {
  const db = c.env.DB;
  const user = c.get("user");
  const v = await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(voucherId).first<any>();
  if (!v) throw notFound("voucher_not_found", "Không tìm thấy phiếu");
  if (v.status !== "pending_approval") throw conflict("not_pending", "Chỉ từ chối/huỷ được phiếu đang chờ duyệt");
  // Phiếu lương/tạm ứng do module lương quản lý: huỷ ở đó để trạng thái tạm ứng khớp sổ quỹ
  if (v.ref_type === "salary_advance") throw conflict("managed_voucher", "Phiếu tạm ứng lương do module Lương quản lý, hãy huỷ từ khoản tạm ứng", { refType: v.ref_type });
  await db.batch([
    assertStmt(db, action, `SELECT status = 'pending_approval' FROM cash_vouchers WHERE id = ?`, [voucherId]),
    db.prepare(`UPDATE cash_vouchers SET status='cancelled' WHERE id=? AND status='pending_approval'`).bind(voucherId),
    db
      .prepare(
        `UPDATE approvals SET status='rejected', decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note=?
          WHERE type='cash_voucher.post' AND ref_id=? AND status='pending'`,
      )
      .bind(user.id, reason, String(voucherId)),
    auditStmt(c, { action, entity: "cash_voucher", entityId: voucherId, before: { status: v.status, period: v.period }, after: { status: "cancelled" }, reason }),
  ]);
  return db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(voucherId).first();
}
