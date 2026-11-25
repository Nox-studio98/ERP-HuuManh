import { AppError } from "./errors";
// Máy chủ là nguồn giờ duy nhất (M9-12). Lưu UTC, tính "ngày/kỳ" theo giờ Việt Nam (UTC+7, không DST).
const VN_OFFSET_MS = 7 * 3600_000;
export const nowIso = () => new Date().toISOString();
export const vnDate = (d = new Date()) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10); // 2026-11-23
export const vnDay = (d = new Date()) => vnDate(d).replaceAll("-", ""); // 20261123
export const vnPeriod = (d = new Date()) => vnDate(d).slice(0, 7); // 2026-11
/** Khoảng UTC [from, to) của một ngày VN 'YYYY-MM-DD'. */
export function vnDayRangeUtc(day: string) {
  const start = new Date(Date.parse(day + "T00:00:00Z") - VN_OFFSET_MS);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86400_000).toISOString() };
}
/** Đọc khoảng ngày VN `from`/`to` (YYYY-MM-DD, gồm cả hai đầu, tối đa 366 ngày) từ query; trả null nếu không có. Ném 422 khi sai. */
export function parseDayRange(from?: string, to?: string): { from: string; to: string } | null {
  if (!from && !to) return null;
  const ok = (v: string, n: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new AppError(422, "validation_error", `${n} phải dạng YYYY-MM-DD`);
    return v;
  };
  const f = ok(from ?? to!, "from"), t = ok(to ?? from!, "to");
  if (t < f) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
  if ((Date.parse(t) - Date.parse(f)) / 86400_000 > 366) throw new AppError(422, "validation_error", "Khoảng ngày tối đa 366 ngày");
  return { from: f, to: t };
}
