import type { Env } from "../env";

/**
 * Outbox pattern cho tích hợp ngoài (MISA, Fresco, email/push nhắc nợ):
 *  1. Ghi job vào integration_jobs TRONG CÙNG batch với nghiệp vụ (không mất job nếu commit, không có job ma nếu rollback).
 *  2. Sau khi commit gọi kickJobs() → gửi message {jobId} vào Queue JOBS để xử lý ngay.
 *  3. Cron mỗi 5 phút quét job quá hạn (phòng khi Queue lỗi) — xem services/jobs.ts (processJob, sweepJobs).
 * Không bao giờ gọi API ngoài trong request của nhân viên quầy.
 */
export type JobType = "einvoice.issue" | "einvoice.adjust" | "einvoice.cancel" | "debt.remind" | "fresco.ack"
  | "notify.order_status" | "notify.staff_new_order" | "notify.email" | "notify.managers";

export function enqueueJobStmt(db: D1Database, type: JobType, refType: string, refId: number, payload: unknown = {}) {
  return db
    .prepare(`INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) VALUES (?,?,?,?)`)
    .bind(type, refType, refId, JSON.stringify(payload));
}

/** Đẩy các job queued của ref vừa commit lên Queue (best effort; cron sẽ quét lại nếu thất bại). */
export async function kickJobs(env: Env, refType: string, refId: number) {
  if (!env.JOBS) return;
  const { results } = await env.DB.prepare(`SELECT id FROM integration_jobs WHERE ref_type = ? AND ref_id = ? AND status = 'queued'`)
    .bind(refType, refId)
    .all<{ id: number }>();
  if (results.length) await env.JOBS.sendBatch(results.map((r) => ({ body: { jobId: r.id } })));
}
