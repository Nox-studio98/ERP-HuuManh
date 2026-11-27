import { useState, type ReactNode } from "react";
import { upload } from "../../api";
import { Button } from "../../components/ui";
import { toast } from "../../components/toast";

export const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: "Chờ thanh toán", new: "Chờ xác nhận", confirmed: "Đã xác nhận", preparing: "Đang chuẩn bị", shipping: "Đang giao",
  delivery_failed: "Giao thất bại", completed: "Hoàn tất", cancelled: "Đã huỷ", returned: "Đã trả hàng",
};
export const TABS: [string, string][] = [["all", "Tất cả"], ["awaiting_payment", "Chờ thanh toán"], ["new", "Chờ xác nhận"], ["confirmed", "Đã xác nhận"], ["preparing", "Đang chuẩn bị"], ["shipping", "Đang giao"], ["delivery_failed", "Giao thất bại"], ["completed", "Hoàn tất"], ["cancelled", "Đã huỷ"], ["returned", "Đã trả hàng"]];
export const statusTone = (s: string) => (s === "completed" ? "ok" : s === "cancelled" || s === "delivery_failed" || s === "returned" ? "danger" : s === "new" || s === "awaiting_payment" ? "warn" : "info") as "ok" | "danger" | "warn" | "info";
export const PAY_STATUS: Record<string, string> = { unpaid: "Chưa thanh toán", pending: "Chờ thanh toán", paid: "Đã thanh toán", partial: "Thanh toán một phần", refunded: "Đã hoàn tiền", partially_refunded: "Hoàn một phần", cod: "Thu khi giao", failed: "Thanh toán lỗi" };
export const PAY_METHOD: Record<string, string> = { cod: "COD", transfer: "Chuyển khoản", gateway: "Cổng thanh toán", cash: "Tiền mặt" };
export const WEIGHT_LABEL: Record<string, string> = { none: "", auto_accepted: "Cân trong dung sai", pending_customer: "Chờ khách xác nhận cân", accepted: "Khách đã xác nhận cân", rejected: "Khách từ chối cân" };
export const CHANNEL_LABEL: Record<string, string> = { online: "Website", fresco: "Fresco", social: "Mạng xã hội" };
export const WEEKDAYS: [number, string][] = [[1, "T2"], [2, "T3"], [3, "T4"], [4, "T5"], [5, "T6"], [6, "T7"], [7, "CN"]];
export const ymdShow = (s?: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "—");
export const dev = (ordered: number, actual: number) => (ordered > 0 ? ((actual - ordered) / ordered) * 100 : 0);

/** Markdown tối giản, an toàn: chỉ sinh phần tử React (không dùng innerHTML). Hỗ trợ #, ##, ###, danh sách -, **đậm**, *nghiêng*, [text](/đường/dẫn hoặc https://…). */
function inline(s: string, k: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k + i}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("*")) out.push(<em key={k + i}>{t.slice(1, -1)}</em>);
    else {
      const mm = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(t)!;
      const safe = /^(https?:\/\/|\/(?!\/))/.test(mm[2]);
      out.push(safe ? <a key={k + i} href={mm[2]} target="_blank" rel="noopener noreferrer nofollow">{mm[1]}</a> : mm[1]);
    }
    last = m.index + t.length; i++;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { const l = list; blocks.push(<ul key={"u" + blocks.length}>{l.map((x, i) => <li key={i}>{inline(x, "l" + i)}</li>)}</ul>); list = []; } };
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trimEnd();
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { list.push(li[1]); return; }
    flush();
    if (!line.trim()) return;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { const L = h[1].length; const C = (L === 1 ? "h3" : L === 2 ? "h4" : "h5") as "h3"; blocks.push(<C key={idx}>{inline(h[2], "h" + idx)}</C>); }
    else blocks.push(<p key={idx}>{inline(line, "p" + idx)}</p>);
  });
  flush();
  return <div className="md">{blocks.length ? blocks : <span className="muted">(trống)</span>}</div>;
}

/** Nút chọn & tải ảnh (≤2MB jpg/png/webp). onUploaded nhận kết quả server. */
export function ImagePicker({ path, label = "Tải ảnh lên", onUploaded }: { path: string; label?: string; onUploaded: (r: any) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={"btn soft " + (busy ? "disabled" : "")} style={{ cursor: "pointer" }}>
      {busy ? "Đang tải…" : label}
      <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy} aria-label={label}
        onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) { toast("Ảnh tối đa 2 MB", "error"); return; }
          setBusy(true);
          try { onUploaded(await upload(path, f)); } catch { /* toast */ } finally { setBusy(false); }
        }} />
    </label>
  );
}
export const Img = ({ src, alt = "", size = 72 }: { src?: string | null; alt?: string; size?: number }) =>
  src ? <img src={src} alt={alt} style={{ width: size, height: size, objectFit: "cover", borderRadius: 8, background: "var(--surface-2)" }} /> : <div style={{ width: size, height: size, borderRadius: 8, background: "var(--surface-2)" }} />;

export function TagInput({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const [t, setT] = useState("");
  const add = () => { const v = t.trim(); if (v && !value.includes(v)) onChange([...value, v]); setT(""); };
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      <div className="chips" style={{ marginBottom: 6 }}>{value.map((d) => <span key={d} className="chip" style={{ minHeight: 32, padding: "0 10px", display: "inline-flex", alignItems: "center", gap: 6 }}>{d}<button type="button" aria-label={`Xoá ${d}`} className="btn ghost sm" style={{ minHeight: 24, padding: "0 4px" }} onClick={() => onChange(value.filter((x) => x !== d))}>✕</button></span>)}</div>
      <div className="row">
        <input className="input grow" aria-label={label} value={t} placeholder="Gõ quận/huyện rồi Enter" onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} />
        <Button variant="soft" onClick={add}>Thêm</Button>
      </div>
    </div>
  );
}
export const Toggle = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}</label>
);

/** Nhãn thanh toán của đơn online. Đơn giao từ quầy (source=pos): "Trả trước X · thu hộ Y" hoặc "Đã thanh toán" thay vì "COD · Chưa thanh toán". */
export const payText = (o: { source?: string | null; paymentMethod?: string | null; paymentStatus?: string; paidTotal?: number; total?: number }) => {
  if (o.source === "pos" && o.paymentStatus === "paid") return "Đã thanh toán";
  if (o.source === "pos" && (o.paidTotal ?? 0) > 0 && o.paymentStatus === "unpaid") {
    const f = (n: number) => new Intl.NumberFormat("vi-VN").format(n) + " ₫";
    return `Trả trước ${f(o.paidTotal!)} · thu hộ ${f(Math.max(0, (o.total ?? 0) - o.paidTotal!))}`;
  }
  return `${PAY_METHOD[o.paymentMethod ?? ""] ?? o.paymentMethod} · ${PAY_STATUS[o.paymentStatus ?? ""] ?? o.paymentStatus}`;
};
