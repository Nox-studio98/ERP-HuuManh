import type { Env } from "../../../worker/env";
import { transitionStmts } from "../../../worker/services/online-orders";
import { kickJobs } from "../../../worker/services/outbox";
import { releaseOrderStmts } from "../../../worker/services/reservations";
import { sysAuditStmt } from "../../../worker/services/sysaudit";

/**
 * Cron (gợi ý mỗi 30 phút): đơn COD (khách vãng lai VÀ tài khoản đăng nhập) ở trạng thái 'new' (chưa ai xác nhận) quá `online.cod_unconfirmed_hours`
 * giờ (mặc định 72; đặt 0 để tắt) → tự huỷ và NHẢ TỒN, tránh giữ hàng vô hạn bằng đơn ảo. Trả số đơn đã huỷ.
 */
export async function cancelStaleCodOrders(env: Pick<Env, "DB"> & Partial<Env>, now = new Date()): Promise<number> {
  const db = env.DB;
  const raw = (await db.prepare(`SELECT value FROM settings WHERE key='online.cod_unconfirmed_hours'`).first<{ value: string }>())?.value;
  const n = raw == null || raw === "" ? 72 : Number(raw);
  const hours = Number.isFinite(n) ? n : 72;
  if (hours <= 0) return 0;
  const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, code FROM orders WHERE channel = 'online' AND status = 'new' AND payment_method = 'cod' AND created_at <= ? ORDER BY id LIMIT 100`,
    )
    .bind(cutoff)
    .all<{ id: number; code: string }>();
  let cancelled = 0;
  for (const o of results) {
    try {
      const release = await releaseOrderStmts(db, o.id);
      await db.batch([
        ...transitionStmts(db, o.id, "new", "cancelled", { type: "system", id: null }, {
          note: "Đơn tự huỷ do không được xác nhận kịp thời",
          extraSet: "cancel_reason = ?3",
          extraBinds: ["COD không được xác nhận quá hạn"],
        }),
        ...release,
        db.prepare(`INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES ('notify.order_status','order',?,?)`).bind(o.id, JSON.stringify({ orderCode: o.code, status: "cancelled" })),
        sysAuditStmt(db, { action: "online_order.cod_expired", entity: "order", entityId: o.id, after: { code: o.code, hours } }),
      ]);
      cancelled++;
      try { await kickJobs(env as Env, "order", o.id); } catch { /* cron quét lại */ }
    } catch {
      /* đơn vừa được xác nhận/huỷ ở nơi khác: guard rollback, bỏ qua */
    }
  }
  return cancelled;
}
