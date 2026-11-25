import type { Env } from "../env";
import { vnDate } from "../lib/time";
import { getSettingInt } from "./settings";
import { sysAuditStmt } from "./sysaudit";

/**
 * Chính sách lưu giữ dữ liệu (C-29) — chạy trong cron hằng ngày. Mọi mốc là tham số Cài đặt (xem docs/SECOPS.md mục 7):
 *  - retention.gps_months (12, tối thiểu 6): đặt lat/lng/accuracy_m = NULL ở attendance_punches cũ hơn mốc.
 *    Bảng này bất biến bằng trigger; migration 0026 chỉ chừa đúng một ngoại lệ (xoá cả ba cột toạ độ trên bản ghi > 6 tháng).
 *  - retention.employee_pii_months (24): nhân viên nghỉ việc quá mốc → che CCCD, ngân hàng, địa chỉ, SĐT, email, ngày sinh.
 *  - backup.retention_days (90): do backupToR2 xử lý (pruneBackups).
 *  - retention.audit_years (10): chỉ là chính sách ghi nhận, audit_log không bị xoá.
 * Mỗi bước độc lập, idempotent, ghi một dòng audit tổng hợp (số bản ghi đã xử lý) cùng batch với thay đổi.
 */
export const GPS_MIN_MONTHS = 6; // phải khớp trigger punches_geo_scrub_only (migrations/0026)

export interface RetentionResult { gpsScrubbed: number; employeesPurged: number }

const n = async (db: D1Database, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;

export async function scrubOldGps(env: Env): Promise<number> {
  const db = env.DB;
  const months = Math.max(GPS_MIN_MONTHS, await getSettingInt(db, "retention.gps_months", 12));
  const where = `(lat IS NOT NULL OR lng IS NOT NULL OR accuracy_m IS NOT NULL) AND server_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ? || ' months')`;
  const count = await n(db, `SELECT COUNT(*) n FROM attendance_punches WHERE ${where}`, months);
  if (!count) return 0;
  await db.batch([
    db.prepare(`UPDATE attendance_punches SET lat = NULL, lng = NULL, accuracy_m = NULL WHERE ${where}`).bind(months),
    sysAuditStmt(db, { action: "retention.gps_scrub", entity: "attendance_punches", after: { rows: count, olderThanMonths: months } }),
  ]);
  return count;
}

export async function purgeFormerEmployeePii(env: Env): Promise<number> {
  const db = env.DB;
  const months = Math.max(12, await getSettingInt(db, "retention.employee_pii_months", 24));
  const today = vnDate();
  const where = `status = 'terminated' AND pii_purged_at IS NULL AND termination_date IS NOT NULL AND termination_date < date(?, '-' || ? || ' months')`;
  const count = await n(db, `SELECT COUNT(*) n FROM employees WHERE ${where}`, today, months);
  if (!count) return 0;
  const at = new Date().toISOString();
  await db.batch([
    db.prepare(
      `UPDATE employees SET id_number = NULL, bank_name = NULL, bank_account = NULL, address = NULL, phone = NULL, email = NULL, dob = NULL,
         pii_purged_at = ?, version = version + 1 WHERE ${where}`,
    ).bind(at, today, months),
    sysAuditStmt(db, { action: "retention.employee_pii_purge", entity: "employees", after: { rows: count, terminatedOverMonths: months } }),
  ]);
  return count;
}

export async function runRetention(env: Env): Promise<RetentionResult> {
  const r: RetentionResult = { gpsScrubbed: 0, employeesPurged: 0 };
  for (const [name, fn] of [["gps", async () => (r.gpsScrubbed = await scrubOldGps(env))], ["pii", async () => (r.employeesPurged = await purgeFormerEmployeePii(env))]] as const) {
    try { await fn(); } catch (e) { console.error(JSON.stringify({ level: "error", msg: `cron_retention_${name}`, err: String((e as Error)?.message).slice(0, 200) })); }
  }
  return r;
}
