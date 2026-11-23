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
