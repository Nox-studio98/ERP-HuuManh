const TZ = "Asia/Ho_Chi_Minh";
const vnd = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 });
const dt = new Intl.DateTimeFormat("vi-VN", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dOnly = new Intl.DateTimeFormat("vi-VN", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const tOnly = new Intl.DateTimeFormat("vi-VN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

export const money = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? "—" : vnd.format(Math.round(n)).replace(/ /g, " "));
export const num = (n: number | null | undefined) => (n == null ? "—" : numFmt.format(n));
export const qtyText = (milli: number | null | undefined, unit?: string) => (milli == null ? "—" : `${numFmt.format(milli / 1000)}${unit ? " " + unitLabel(unit) : ""}`);
export const fmtDateTime = (iso?: string | null) => (iso ? dt.format(new Date(iso)) : "—");
export const fmtDate = (iso?: string | null) => (iso ? dOnly.format(new Date(iso)) : "—");
export const fmtTime = (iso?: string | null) => (iso ? tOnly.format(new Date(iso)) : "—");
/** YYYY-MM-DD theo giờ Việt Nam */
export const todayVN = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};
export const parseNum = (s: string) => {
  const v = parseFloat(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};
/** Chuỗi nhập thập phân (cho phép dấu , hoặc .) → số */
export const parseDec = (s: string) => {
  const v = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};
const UNITS: Record<string, string> = { kg: "kg", trai: "trái", khay: "khay", hop: "hộp", thung: "thùng", g: "g", bo: "bó", tui: "túi" };
export const unitLabel = (u: string) => UNITS[u] ?? u;
export const UNIT_OPTIONS = ["kg", "trai", "khay", "hop", "thung", "tui", "bo"];
export const METHODS: Record<string, string> = { cash: "Tiền mặt", transfer: "Chuyển khoản", qr: "QR", card: "Thẻ", ewallet: "Ví điện tử", cod: "COD", marketplace: "Sàn", credit: "Công nợ" };
export const CHANNELS: Record<string, string> = { pos: "Tại quầy", online: "Online", b2b: "Sỉ", fresco: "Fresco", social: "Mạng xã hội" };
export const ROLES: Record<string, string> = { owner: "Chủ", manager: "Quản lý", cashier: "Thu ngân", warehouse: "Thủ kho", accountant: "Kế toán", online_staff: "NV online" };
export const ORDER_STATUS: Record<string, string> = { draft: "Nháp", new: "Mới", confirmed: "Đã xác nhận", preparing: "Đang chuẩn bị", shipping: "Đang giao", completed: "Hoàn tất", cancelled: "Đã huỷ", delivery_failed: "Giao thất bại", returned: "Đã trả", awaiting_payment: "Chờ thanh toán" };
export const DOC_TYPES: Record<string, string> = { receipt: "Nhập hàng", issue: "Xuất", waste: "Huỷ hàng", adjust: "Điều chỉnh", count: "Kiểm kê", transfer: "Chuyển kho" };
export const DOC_STATUS: Record<string, string> = { draft: "Nháp", pending_approval: "Chờ duyệt", posted: "Đã ghi sổ", cancelled: "Đã huỷ" };
export const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); });
export const downloadHref = (path: string) => `/api/v1${path}`;
