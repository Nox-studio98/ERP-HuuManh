import type { Context } from "hono";
import type { AppBindings } from "../env";
import { auditStmt } from "../lib/audit";
import { conflict, notFound } from "../lib/errors";
import { assertStmt } from "./guard";

/** Duyệt phiếu chi chờ duyệt → posted (dùng chung cho /vouchers/:id/approve và /approvals/:id/decide). */
export async function approveVoucher(c: Context<AppBindings>, voucherId: number, note?: string) {
  const db = c.env.DB;
  const user = c.get("user");
  const v = await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(voucherId).first<any>();
  if (!v) throw notFound("voucher_not_found", "Không tìm thấy phiếu");
  if (v.status !== "pending_approval") throw conflict("not_pending", "Phiếu không ở trạng thái chờ duyệt");
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
