import { vnDate } from "../lib/time";
import { assertStmt } from "./guard";

export interface SlotRule {
  start_time: string;
  cutoff_minutes: number;
  weekdays: string;
}
export type SlotRuleReason = "closed" | "past" | "cutoff";

/** Thứ trong tuần 1..7 (Thứ Hai = 1) của ngày YYYY-MM-DD. */
export const isoWeekday = (day: string) => ((new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;

/** Quy tắc thời gian của khung giờ (không gồm sức chứa): không giao hôm đó / ngày đã qua / quá giờ chốt. */
export function slotRuleProblem(slot: SlotRule, date: string, now = new Date()): SlotRuleReason | null {
  if (!slot.weekdays.split(",").map((x) => x.trim()).includes(String(isoWeekday(date)))) return "closed";
  if (date < vnDate(now)) return "past";
  const start = Date.parse(`${date}T${slot.start_time}:00+07:00`);
  if (now.getTime() > start - slot.cutoff_minutes * 60_000) return "cutoff";
  return null;
}

/**
 * A-18: MỘT cách đếm sức chứa khung giờ giao hàng dùng chung cho website, ERP (đơn mạng xã hội) và giao lại.
 * Đơn chiếm chỗ = đơn bán còn sống: không tính huỷ / đã trả / nháp / giao thất bại (đơn giao thất bại sẽ được xếp ngày giao lại,
 * không còn chiếm khung cũ). `exclude`: bỏ qua đơn đang được đổi khung (giao lại).
 */
export const SLOT_OCCUPYING = `kind = 'sale' AND status NOT IN ('cancelled','returned','draft','delivery_failed')`;

export async function slotUsed(db: D1Database, date: string, slotId: number, excludeOrderId?: number): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE slot_date = ? AND slot_id = ? AND ${SLOT_OCCUPYING} AND id <> ?`)
    .bind(date, slotId, excludeOrderId ?? 0)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Chốt chặn trong batch: khung còn chỗ (đếm cùng quy tắc `slotUsed`). Đặt ĐẦU batch. */
export function slotCapacityGuard(db: D1Database, code: string, date: string, slotId: number, capacity: number, excludeOrderId?: number) {
  return assertStmt(db, code, `SELECT (SELECT COUNT(*) FROM orders WHERE slot_date = ? AND slot_id = ? AND ${SLOT_OCCUPYING} AND id <> ?) < ?`, [date, slotId, excludeOrderId ?? 0, capacity]);
}
