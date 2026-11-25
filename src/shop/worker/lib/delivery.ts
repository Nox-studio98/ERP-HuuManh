import { normalizeVi } from "../../../worker/services/online-orders";
import { vnDate } from "../../../worker/lib/time";
import { isoWeekday, slotRuleProblem, slotUsed } from "../../../worker/services/slots";

export interface Zone {
  id: number;
  name: string;
  fee: number;
  freeOver: number | null;
  minOrder: number;
}

/** Tìm khu vực giao theo quận/huyện (so khớp không dấu, không phân biệt hoa thường). */
export async function findZone(db: D1Database, district: string | null | undefined): Promise<Zone | null> {
  if (!district?.trim()) return null;
  const want = normalizeVi(district);
  const { results } = await db.prepare(`SELECT id, name, districts_json, fee, free_over, min_order FROM delivery_zones WHERE active = 1 ORDER BY id`).all<any>();
  for (const z of results) {
    let list: unknown;
    try {
      list = JSON.parse(z.districts_json);
    } catch {
      continue;
    }
    if (Array.isArray(list) && list.some((d) => typeof d === "string" && normalizeVi(d) === want))
      return { id: z.id, name: z.name, fee: z.fee, freeOver: z.free_over, minOrder: z.min_order };
  }
  return null;
}

export const shippingFee = (z: Zone, subtotal: number) => (z.freeOver != null && subtotal >= z.freeOver ? 0 : z.fee);

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export { isoWeekday };

export const addDaysStr = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

export interface SlotRow {
  id: number;
  label: string;
  start_time: string;
  end_time: string;
  cutoff_minutes: number;
  capacity: number;
  weekdays: string;
}

export type SlotReason = "closed" | "past" | "cutoff" | "full";

/** Kiểm tra một khung giờ của một ngày: trả lý do không đặt được hoặc null nếu còn đặt được. */
export async function slotProblem(db: D1Database, slot: SlotRow, date: string, now = new Date()): Promise<SlotReason | null> {
  const rule = slotRuleProblem(slot, date, now);
  if (rule) return rule;
  if ((await slotUsed(db, date, slot.id)) >= slot.capacity) return "full"; // A-18: cùng cách đếm với ERP
  return null;
}

export async function activeSlots(db: D1Database) {
  return (await db.prepare(`SELECT id, label, start_time, end_time, cutoff_minutes, capacity, weekdays FROM delivery_slots WHERE active = 1 ORDER BY start_time, id`).all<SlotRow>()).results;
}

export async function getSlot(db: D1Database, id: number) {
  return db.prepare(`SELECT id, label, start_time, end_time, cutoff_minutes, capacity, weekdays FROM delivery_slots WHERE id = ? AND active = 1`).bind(id).first<SlotRow>();
}
