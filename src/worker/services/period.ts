import { AppError } from "../lib/errors";
import { vnPeriod } from "../lib/time";

/** Kỳ 'YYYY-MM' (giờ VN) của một mốc: period, ngày 'YYYY-MM-DD' hoặc chuỗi ISO UTC. */
export function periodOf(when: string | Date = new Date()): string {
  if (when instanceof Date) return vnPeriod(when);
  if (/^\d{4}-\d{2}$/.test(when)) return when;
  if (/^\d{4}-\d{2}-\d{2}$/.test(when)) return when.slice(0, 7);
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? vnPeriod() : vnPeriod(d);
}

export async function isPeriodLocked(db: D1Database, when: string | Date = new Date()): Promise<boolean> {
  const r = await db.prepare(`SELECT 1 AS x FROM periods WHERE period = ? AND locked_at IS NOT NULL`).bind(periodOf(when)).first();
  return !!r;
}

/**
 * Chốt chặn khoá sổ dùng chung (B-08, EC-33): chứng từ/bút toán ghi vào kỳ đã khoá → 423 period_locked.
 * `when` là ngày hiệu lực của bút toán (mặc định: hôm nay). Chứng từ cũ muốn sửa phải lập bút toán điều chỉnh ở kỳ hiện tại.
 */
export async function assertPeriodOpen(db: D1Database, when: string | Date = new Date(), what = "chứng từ này") {
  if (await isPeriodLocked(db, when)) {
    throw new AppError(423, "period_locked", `Kỳ ${periodOf(when)} đã khoá sổ, không ghi ${what} vào kỳ này được — hãy lập bút toán điều chỉnh ở kỳ sau`, { period: periodOf(when) });
  }
}
