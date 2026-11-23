const TZ = "Asia/Ho_Chi_Minh";
const vndFmt = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 });
const dtFmt = new Intl.DateTimeFormat("vi-VN", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dFmt = new Intl.DateTimeFormat("vi-VN", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });

/** 125000 → "125.000 ₫" (khoảng trắng không ngắt để không xuống dòng giữa số và ký hiệu). */
export const money = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? "—" : `${vndFmt.format(Math.round(n))} ₫`);
export const num = (n: number) => numFmt.format(n);

const UNITS: Record<string, string> = { kg: "kg", g: "g", trai: "trái", khay: "khay", hop: "hộp", thung: "thùng", tui: "túi", bo: "bó", chum: "chùm" };
export const unitName = (u: string) => UNITS[u] ?? u;
export const qtyText = (qty: number, unit: string) => `${num(qty)} ${unitName(unit)}`;

export const fmtDateTime = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso.includes("T") || iso.includes("Z") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(dtFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};
export const fmtDate = (iso?: string | null) => (iso ? dFmt.format(new Date(iso.length === 10 ? iso + "T00:00:00+07:00" : iso)) : "");
const WD = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
export const weekdayOf = (ymd: string) => WD[new Date(ymd + "T00:00:00+07:00").getDay()];
export const dayMonth = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
export const todayVN = (offset = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));

/** "1,5" hoặc "1.5" → 1.5 */
export const parseDec = (s: string) => {
  const v = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(v) ? v : NaN;
};
export const uuid = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
};
export const strHash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};
