/**
 * Bộ component danh sách chuẩn (xem docs/UI-KIT.md): PageHeader, FilterBar (DateRangeFilter, SearchInput, FilterSelect),
 * KpiRow, ExportButton, DetailPanel + SplitLayout. DataTable / EmptyState nằm ở ui.tsx.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { get, items as asItems } from "../api";
import { downloadCsv } from "../csv";
import { todayVN } from "../format";
import { Button, Sheet } from "./ui";

/* ---------------- PageHeader ---------------- */
/** Tiêu đề màn hình nằm ở thanh trên cùng (tự lấy từ menu). PageHeader chỉ thêm phụ đề + nút thao tác bên phải. `title` chỉ dùng cho màn con (vd. "Đơn DS-001"). */
export function PageHeader({ title, subtitle, actions, compact }: { title?: string; subtitle?: ReactNode; actions?: ReactNode; compact?: boolean }) {
  if (!title && !subtitle && !actions) return null;
  return (
    <div className="page-header">
      <div className="ph-text">
        {title && <h2 className="ph-title">{title}</h2>}
        {subtitle && <div className="ph-sub muted">{subtitle}</div>}
      </div>
      {actions && <div className={"ph-actions" + (compact ? " compact" : "")}>{actions}</div>}
    </div>
  );
}

/* ---------------- Bộ lọc ngày ---------------- */
export type Preset = "today" | "yesterday" | "7d" | "month" | "lastMonth" | "custom";
export type DateRange = { preset: Preset; from: string; to: string };
const PRESETS: { v: Preset; label: string }[] = [
  { v: "today", label: "Hôm nay" }, { v: "yesterday", label: "Hôm qua" }, { v: "7d", label: "7 ngày" },
  { v: "month", label: "Tháng này" }, { v: "lastMonth", label: "Tháng trước" }, { v: "custom", label: "Tuỳ chọn" },
];
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12
export function presetRange(p: Exclude<Preset, "custom">): { from: string; to: string } {
  const today = todayVN();
  if (p === "today") return { from: today, to: today };
  if (p === "yesterday") { const y = todayVN(-1); return { from: y, to: y }; }
  if (p === "7d") return { from: todayVN(-6), to: today };
  const [Y, M] = today.split("-").map(Number);
  if (p === "month") return { from: `${Y}-${String(M).padStart(2, "0")}-01`, to: today };
  const py = M === 1 ? Y - 1 : Y, pm = M === 1 ? 12 : M - 1;
  return { from: `${py}-${String(pm).padStart(2, "0")}-01`, to: `${py}-${String(pm).padStart(2, "0")}-${lastDayOfMonth(py, pm)}` };
}
export const rangeOf = (p: Exclude<Preset, "custom">): DateRange => ({ preset: p, ...presetRange(p) });

export function DateRangeFilter({ value, onChange, presets }: { value: DateRange; onChange: (v: DateRange) => void; presets?: Preset[] }) {
  const list = presets ? PRESETS.filter((p) => presets.includes(p.v)) : PRESETS;
  return (
    <div className="daterange">
      <div className="seg" role="group" aria-label="Khoảng thời gian">
        {list.map((p) => (
          <button key={p.v} type="button" aria-pressed={value.preset === p.v} onClick={() => onChange(p.v === "custom" ? { ...value, preset: "custom" } : rangeOf(p.v))}>{p.label}</button>
        ))}
      </div>
      {value.preset === "custom" && (
        <div className="row daterange-inputs">
          <input className="input" type="date" aria-label="Từ ngày" value={value.from} max={value.to || todayVN()} onChange={(e) => e.target.value && onChange({ preset: "custom", from: e.target.value, to: value.to < e.target.value ? e.target.value : value.to })} />
          <span className="muted">→</span>
          <input className="input" type="date" aria-label="Đến ngày" value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ preset: "custom", from: value.from > e.target.value ? e.target.value : value.from, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}

/* ---------------- Ô tìm kiếm (debounce) & ô chọn ---------------- */
/** `onSearch` được gọi sau `delay` ms kể từ lần gõ cuối (hoặc ngay khi bấm Enter). */
export function SearchInput({ value, onSearch, placeholder, delay = 350, label = "Tìm kiếm" }: { value: string; onSearch: (v: string) => void; placeholder?: string; delay?: number; label?: string }) {
  const [txt, setTxt] = useState(value);
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { setTxt(value); last.current = value; } }, [value]);
  useEffect(() => {
    if (txt === last.current) return;
    const t = setTimeout(() => { last.current = txt; onSearch(txt); }, delay);
    return () => clearTimeout(t);
  }, [txt]); // eslint-disable-line
  return (
    <label className="searchbox">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.5-4.5" /></svg>
      <input type="search" className="input" aria-label={label} placeholder={placeholder} value={txt} onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { last.current = txt; onSearch(txt); } }} />
    </label>
  );
}

export function FilterSelect({ label, value, onChange, options, allLabel = "Tất cả" }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; label: string }[]; allLabel?: string }) {
  return (
    <label className="field filter-select">
      <span className="lbl">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </label>
  );
}

/**
 * Khung chứa các bộ lọc. Phần chính (`children`: ngày + tìm kiếm) luôn hiện; `advanced` (các ô chọn) hiện sẵn trên desktop
 * và gập sau nút "Bộ lọc" trên điện thoại. `dirty` + `onReset` hiện nút "Xoá lọc"; `activeCount` hiện số bộ lọc đang bật.
 */
export function FilterBar({ children, advanced, dirty, onReset, activeCount }: { children: ReactNode; advanced?: ReactNode; dirty?: boolean; onReset?: () => void; activeCount?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="filterbar card flat">
      {children}
      {advanced && <Button variant="ghost" size="sm" className="fb-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>Bộ lọc{activeCount ? ` (${activeCount})` : ""} {open ? "▴" : "▾"}</Button>}
      {advanced && <div className={"fb-adv" + (open ? " open" : "")}>{advanced}</div>}
      {dirty && onReset && <Button variant="ghost" size="sm" className="filter-reset" onClick={onReset}>Xoá lọc</Button>}
    </div>
  );
}

/* ---------------- KpiRow ---------------- */
export type Kpi = { label: string; value: ReactNode; sub?: ReactNode; tone?: "ok" | "warn" | "danger" | "info"; onClick?: () => void; delta?: { pct: number | null; label?: string } };
export function KpiRow({ items, cols }: { items: Kpi[]; cols?: number }) {
  return (
    <div className="kpis kpi-row" style={cols ? ({ ["--kpi-cols" as any]: cols } as any) : undefined}>
      {items.map((k) => {
        const inner = (
          <>
            <div className="l">{k.label}</div>
            <div className={"v" + (k.tone ? " " + k.tone : "")}>{k.value}</div>
            {(k.sub || k.delta) && (
              <div className="s small muted">
                {k.delta && k.delta.pct != null && <span className={"delta " + (k.delta.pct > 0 ? "up" : k.delta.pct < 0 ? "down" : "")}>{k.delta.pct > 0 ? "▲" : k.delta.pct < 0 ? "▼" : "●"} {Math.abs(k.delta.pct).toFixed(0)}%{k.delta.label ? " " + k.delta.label : ""}</span>}
                {k.sub && <span> {k.sub}</span>}
              </div>
            )}
          </>
        );
        return k.onClick
          ? <button key={k.label} type="button" className="kpi click" onClick={k.onClick}>{inner}</button>
          : <div key={k.label} className="kpi">{inner}</div>;
      })}
    </div>
  );
}
export const deltaPct = (cur: number, prev: number): number | null => (prev === 0 ? (cur === 0 ? 0 : null) : ((cur - prev) / Math.abs(prev)) * 100);

/* ---------------- Xuất CSV ---------------- */
export type ExportCol<T> = { label: string; value: (r: T) => string | number | null | undefined };
/** Xuất các dòng ĐANG HIỂN THỊ ra CSV (UTF-8 BOM, mở bằng Excel). Số xuất dạng số thật, không kèm "₫". */
export function ExportButton<T>({ filename, rows, columns, disabled, label = "Xuất CSV", className }: { filename: string; rows: T[]; columns: ExportCol<T>[]; disabled?: boolean; label?: string; className?: string }) {
  return (
    <Button variant="ghost" size="sm" className={className} disabled={disabled || !rows.length} onClick={() => downloadCsv(filename, columns.map((c) => c.label), rows.map((r) => columns.map((c) => c.value(r) ?? "")))}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style={{ stroke: "currentColor", fill: "none", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
      {label}
    </Button>
  );
}

/* ---------------- Panel chi tiết (≥1280px) / Sheet (nhỏ hơn) ---------------- */
const WIDE = "(min-width: 1280px)";
const subWide = (f: () => void) => { const m = window.matchMedia(WIDE); m.addEventListener("change", f); return () => m.removeEventListener("change", f); };
export const useWide = () => useSyncExternalStore(subWide, () => window.matchMedia(WIDE).matches, () => false);

/** Bố cục chia đôi: danh sách bên trái, panel chi tiết bên phải khi `open` (≥1280px). Nhỏ hơn: chỉ render danh sách, DetailPanel tự mở Sheet. */
export function SplitLayout({ open, panel, children }: { open: boolean; panel: ReactNode; children: ReactNode }) {
  const wide = useWide();
  if (wide && open) return <div className="split open"><div className="split-main">{children}</div><div className="split-side">{panel}</div></div>;
  return <>{children}{open && panel}</>;
}
export function DetailPanel({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const wide = useWide();
  useEffect(() => {
    if (!wide) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !(document.querySelector(".sheet-back"))) onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [wide]); // eslint-disable-line
  if (!wide) return <Sheet open onClose={onClose} wide title={title} footer={footer}>{children}</Sheet>;
  return (
    <aside className="detail-panel card" aria-label={title}>
      <header><h2>{title}</h2><Button variant="ghost" className="icon-btn" aria-label="Đóng" onClick={onClose}>✕</Button></header>
      <div className="dp-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </aside>
  );
}

/* ---------------- Tải danh sách theo con trỏ ---------------- */
type Q = Record<string, string | number | boolean | undefined | null>;
/**
 * Tải trang đầu khi `deps` đổi, `loadMore()` nối trang kế (API trả `{ items, nextCursor, ...extra }`).
 * `extra` là phần còn lại của phản hồi trang đầu (vd. `summary`).
 */
export function usePagedList<T = any>(path: string, query: Q, deps: unknown[]) {
  const [rows, setRows] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [extra, setExtra] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const qRef = useRef(query); qRef.current = query;
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true); setError(false);
    get(path, qRef.current)
      .then((r: any) => { if (my !== seq.current) return; setRows(asItems<T>(r)); setNext(r?.nextCursor != null ? String(r.nextCursor) : null); const { items: _i, rows: _r, nextCursor: _n, ...rest } = r ?? {}; setExtra(rest); })
      .catch(() => { if (my === seq.current) { setError(true); setRows([]); setNext(null); } })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [path, tick, ...deps]); // eslint-disable-line
  const loadMore = async () => {
    if (!next || loadingMore) return;
    const my = seq.current;
    setLoadingMore(true);
    try {
      const r: any = await get(path, { ...qRef.current, cursor: next });
      if (my !== seq.current) return;
      setRows((x) => [...x, ...asItems<T>(r)]); setNext(r?.nextCursor != null ? String(r.nextCursor) : null);
    } catch { /* toast */ } finally { setLoadingMore(false); }
  };
  return { rows, loading, loadingMore, hasMore: !!next, loadMore, reload: () => setTick((x) => x + 1), extra, error };
}

/** Theo dõi một media query (vd. "(min-width: 1024px)"). */
export function useMedia(query: string) {
  const sub = (f: () => void) => { const m = window.matchMedia(query); m.addEventListener("change", f); return () => m.removeEventListener("change", f); };
  return useSyncExternalStore(sub, () => window.matchMedia(query).matches, () => false);
}
