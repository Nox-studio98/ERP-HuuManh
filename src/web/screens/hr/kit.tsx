import { useMemo, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { ApiError } from "../../api";
import { Button, Sheet } from "../../components/ui";
import { todayVN } from "../../format";

/* ---------- ngày / kỳ (chuỗi YYYY-MM-DD, giờ VN) ---------- */
export const addDaysS = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const mondayOf = (d: string) => { const wd = new Date(d + "T00:00:00Z").getUTCDay(); return addDaysS(d, -((wd + 6) % 7)); };
export const WD_SHORT = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
export const wdOf = (d: string) => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7;
export const dm = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);
export const dmy = (d?: string | null) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "—");
export const thisPeriod = () => todayVN().slice(0, 7);
export const shiftPeriod = (p: string, n: number) => { const [y, m] = p.split("-").map(Number); const t = y * 12 + m - 1 + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
export const periodLabel = (p: string) => `Tháng ${p.slice(5)}/${p.slice(0, 4)}`;
export const vnTime = (iso?: string | null) => (iso ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) : "—");
/** HH:MM theo giờ VN + ngày → ISO có múi giờ */
export const vnIso = (date: string, hhmm: string) => `${date}T${hhmm}:00+07:00`;

/** phút → "7g30" */
export const hm = (m: number | null | undefined) => { if (!m) return "0"; const h = Math.floor(Math.abs(m) / 60), r = Math.abs(m) % 60; return `${m < 0 ? "-" : ""}${h}g${r ? String(r).padStart(2, "0") : ""}`; };
export const days10 = (x: number | null | undefined) => ((x ?? 0) / 10).toLocaleString("vi-VN");

/* ---------- nhãn ---------- */
export const PAY_TYPE: Record<string, string> = { monthly: "Theo tháng", hourly: "Theo giờ", shift: "Theo ca" };
export const EMP_STATUS: Record<string, string> = { active: "Đang làm", terminated: "Đã nghỉ" };
export const PUNCH_METHOD: Record<string, string> = { gps: "GPS", qr: "Mã QR", offline: "Offline", exempt: "Miễn vị trí", manual: "Bổ sung" };
export const PUNCH_STATUS: Record<string, string> = { accepted: "Hợp lệ", pending: "Chờ duyệt", rejected: "Từ chối" };
export const KIND: Record<string, string> = { in: "Vào ca", out: "Ra ca" };
export const REQ_STATUS: Record<string, string> = { pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Từ chối", accepted: "Đã nhận ca", cancelled: "Đã huỷ" };
export const reqTone = (s: string) => ({ pending: "warn", approved: "ok", accepted: "ok", rejected: "danger", cancelled: "danger" } as any)[s];
export const CORR_TYPE: Record<string, string> = { missing_in: "Quên chấm vào", missing_out: "Quên chấm ra", out_of_area: "Ngoài vùng / GPS lỗi", other: "Khác" };
export const LEAVE_TYPE: Record<string, string> = { annual: "Phép năm", sick: "Nghỉ ốm", unpaid: "Nghỉ không lương" };
export const PERIOD_STATUS: Record<string, string> = { draft: "Nháp", calculated: "Đã tính", approved: "Đã duyệt", paid: "Đã chi" };
export const periodTone = (s: string) => ({ draft: "info", calculated: "warn", approved: "info", paid: "ok" } as any)[s];
export const ENTRY_KIND: Record<string, string> = { bonus: "Thưởng", penalty: "Phạt", allowance: "Phụ cấp", adjustment: "Điều chỉnh" };

export const errCode = (e: unknown) => (e instanceof ApiError ? e.code : "");

/** Hộp xác nhận (dùng Sheet của hệ thống) */
export function Confirm({ title, children, confirmLabel = "Xác nhận", danger, onClose, onConfirm, busy, disabled }: { title: string; children: ReactNode; confirmLabel?: string; danger?: boolean; onClose: () => void; onConfirm: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <Sheet open onClose={onClose} title={title} footer={<div className="row"><Button variant="ghost" onClick={onClose}>Huỷ</Button><Button variant={danger ? "danger" : "primary"} loading={busy} disabled={disabled} onClick={onConfirm} className="grow">{confirmLabel}</Button></div>}>
      <div className="stack">{children}</div>
    </Sheet>
  );
}

/** Mã QR (SVG, dựng tại trình duyệt) */
export function QrSvg({ value, size = 260, label }: { value: string; size?: number; label?: string }) {
  const { path, n } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!q.isDark(r, c)) { c++; continue; }
        let e = c;
        while (e < n && q.isDark(r, e)) e++;
        d += `M${c} ${r}h${e - c}v1h-${e - c}z`;
        c = e;
      }
    }
    return { path: d, n };
  }, [value]);
  const quiet = 3;
  return (
    <svg width={size} height={size} style={{ maxWidth: "100%", height: "auto" }} viewBox={`${-quiet} ${-quiet} ${n + quiet * 2} ${n + quiet * 2}`} role="img" aria-label={label ?? "Mã QR"} shapeRendering="crispEdges" data-testid="hr-qr">
      <rect x={-quiet} y={-quiet} width={n + quiet * 2} height={n + quiet * 2} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}

export const moneyFmt = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("vi-VN").format(Math.round(n)));

export const cellStyle = { minWidth: 0 } as const;
