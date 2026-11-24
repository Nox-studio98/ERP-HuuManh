/**
 * Chống lạm dụng gửi email (bơm thư rác vào hộp thư người khác): theo từng người nhận + mẫu thư,
 * cách nhau tối thiểu 60 giây và tối đa 5 thư/24 giờ. Đếm từ outbox integration_jobs (đã có sẵn, không cần bảng mới).
 * Bị chặn → bỏ qua im lặng (response giữ nguyên để không lộ thông tin).
 */
export const MAIL_COOLDOWN_S = 60;
export const MAIL_MAX_PER_DAY = 5;

export async function mailAllowed(db: D1Database, jobType: string, template: string | null, to: string | null | undefined, now = new Date()): Promise<boolean> {
  if (!to) return false;
  const addr = to.trim().toLowerCase();
  const path = jobType === "notify.email" ? "$.to" : "$.email";
  const since = new Date(now.getTime() - 86400_000).toISOString();
  const tplSql = template ? `AND json_extract(payload_json, '$.template') = ?3` : "";
  const binds: unknown[] = [jobType, addr, ...(template ? [template] : [])];
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM integration_jobs
        WHERE type = ?1 AND lower(json_extract(payload_json, '${path}')) = ?2 ${tplSql} AND created_at >= '${since}'`,
    )
    .bind(...binds)
    .first<{ n: number; last: string | null }>();
  if ((r?.n ?? 0) >= MAIL_MAX_PER_DAY) return false;
  if (r?.last && now.getTime() - Date.parse(r.last) < MAIL_COOLDOWN_S * 1000) return false;
  return true;
}
