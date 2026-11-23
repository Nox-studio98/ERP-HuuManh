import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { fmtDateTime, parseDec } from "../format";

export function Button({ variant = "primary", size, block, loading, className = "", children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "soft" | "ghost" | "danger"; size?: "sm" | "lg"; block?: boolean; loading?: boolean }) {
  const v = variant === "primary" ? "" : variant;
  return (
    <button type="button" {...p} disabled={p.disabled || loading} className={`btn ${v} ${size ?? ""} ${block ? "block" : ""} ${className}`}>
      {loading ? "Đang xử lý…" : children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="err" role="alert">{error}</span>}
    </label>
  );
}
export function Input({ label, hint, error, className = "", ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return <Field label={label} hint={hint} error={error}><input {...p} className={"input " + className} /></Field>;
}
export function Select({ label, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return <Field label={label}><select {...p} className="input">{children}</select></Field>;
}
export function TextArea({ label, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return <Field label={label}><textarea {...p} className="input" /></Field>;
}
/** Ô nhập tiền: hiển thị phân cách nghìn, giá trị số nguyên */
export function MoneyInput({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input className="input num" inputMode="numeric" value={value ? new Intl.NumberFormat("vi-VN").format(value) : ""} placeholder="0"
        onChange={(e) => onChange(parseInt(e.target.value.replace(/\D/g, "") || "0", 10))} />
    </Field>
  );
}
/** Ô nhập số thập phân (kg) */
export function DecInput({ label, value, onChange, ...p }: { label: string; value: number | ""; onChange: (n: number) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [txt, setTxt] = useState(value === "" ? "" : String(value).replace(".", ","));
  const last = useRef(value);
  useEffect(() => { if (value !== last.current && parseDec(txt) !== value) setTxt(value === "" ? "" : String(value).replace(".", ",")); last.current = value; }, [value]); // eslint-disable-line
  return (
    <Field label={label}>
      <input {...p} className="input num" inputMode="decimal" value={txt} onChange={(e) => { setTxt(e.target.value); last.current = parseDec(e.target.value); onChange(parseDec(e.target.value)); }} />
    </Field>
  );
}

export function QtyStepper({ value, onChange, step = 1, min = 0, decimal, label }: { value: number; onChange: (n: number) => void; step?: number; min?: number; decimal?: boolean; label: string }) {
  const [txt, setTxt] = useState(String(value).replace(".", ","));
  useEffect(() => { if (parseDec(txt) !== value) setTxt(String(value).replace(".", ",")); }, [value]); // eslint-disable-line
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return (
    <div className="qty" role="group" aria-label={label}>
      <button type="button" aria-label="Giảm" onClick={() => onChange(Math.max(min, round(value - step)))}>−</button>
      <input aria-label={label} inputMode={decimal ? "decimal" : "numeric"} value={txt}
        onChange={(e) => { setTxt(e.target.value); const v = parseDec(e.target.value); onChange(decimal ? Math.max(min, v) : Math.max(min, Math.floor(v))); }}
        onFocus={(e) => e.target.select()} />
      <button type="button" aria-label="Tăng" onClick={() => onChange(round(value + step))}>+</button>
    </div>
  );
}

export function NumberPad({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const press = (k: string) => {
    if (k === "⌫") return onChange(Math.floor(value / 10));
    onChange(parseInt(String(value || "") + k, 10) || 0);
  };
  return (
    <div className="numpad" role="group" aria-label="Bàn phím số">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "000", "0", "⌫"].map((k) => (
        <button key={k} type="button" onClick={() => press(k)} aria-label={k === "⌫" ? "Xoá" : k}>{k}</button>
      ))}
    </div>
  );
}

export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    ref.current?.focus();
    const o = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", k); document.body.style.overflow = o; prev?.focus?.(); };
  }, [open]); // eslint-disable-line
  if (!open) return null;
  return (
    <div className="sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"sheet" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <header><h2 id={id}>{title}</h2><Button variant="ghost" className="icon-btn" aria-label="Đóng" onClick={onClose}>✕</Button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export const Card = ({ title, children, className = "", actions }: { title?: string; children: ReactNode; className?: string; actions?: ReactNode }) => (
  <section className={"card " + className}>
    {(title || actions) && <div className="row between" style={{ marginBottom: 12 }}><h2 style={{ margin: 0 }}>{title}</h2>{actions}</div>}
    {children}
  </section>
);
export const Badge = ({ tone, children }: { tone?: "ok" | "warn" | "danger" | "info"; children: ReactNode }) => <span className={"badge " + (tone ?? "")}>{children}</span>;
export const EmptyState = ({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) => (
  <div className="empty">
    <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 18l16-10 16 10v18l-16 8-16-8z" /><path d="M8 18l16 10 16-10M24 28v16" /></svg>
    <div style={{ fontWeight: 600, color: "var(--text)" }}>{title}</div>
    {hint && <div className="small">{hint}</div>}
    {action && <div style={{ marginTop: 12 }}>{action}</div>}
  </div>
);
export const Spinner = () => <div className="spinner" role="status" aria-label="Đang tải" />;
export const Banner = ({ tone, children }: { tone?: "danger" | "info"; children: ReactNode }) => <div className={"banner " + (tone ?? "")} role="alert">{children}</div>;

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { v: T; label: string }[] }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => <button key={o.v} role="tab" aria-selected={value === o.v} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  );
}

export type Col<T> = { key: string; label: string; render: (r: T) => ReactNode; right?: boolean; hideMobile?: boolean; title?: boolean };
export function DataTable<T>({ cols, rows, rowKey, onRowClick, empty, rowClass }: { cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string | number; onRowClick?: (r: T) => void; empty?: string; rowClass?: (r: T) => string }) {
  if (!rows.length) return <EmptyState title={empty ?? "Chưa có dữ liệu"} />;
  const title = cols.find((c) => c.title) ?? cols[0];
  return (
    <>
      <table className="dt-table">
        <thead><tr>{cols.map((c) => <th key={c.key} className={c.right ? "right" : ""}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={(onRowClick ? "click " : "") + (rowClass?.(r) ?? "")} onClick={() => onRowClick?.(r)} tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={(e) => { if (onRowClick && e.key === "Enter") onRowClick(r); }}>
              {cols.map((c) => <td key={c.key} className={c.right ? "right" : ""}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dt-cards">
        {rows.map((r) => {
          const inner = (
            <>
              <div className="ttl">{title.render(r)}</div>
              {cols.filter((c) => c !== title && !c.hideMobile).map((c) => <div className="kv" key={c.key}><span>{c.label}</span><span className="num">{c.render(r)}</span></div>)}
            </>
          );
          return onRowClick
            ? <button key={rowKey(r)} className={"dt-card " + (rowClass?.(r) === "bad" ? "warn-card" : "")} onClick={() => onRowClick(r)} style={rowClass?.(r) === "bad" ? { background: "var(--warn-soft)" } : undefined}>{inner}</button>
            : <div key={rowKey(r)} className="dt-card" style={rowClass?.(r) === "bad" ? { background: "var(--warn-soft)" } : undefined}>{inner}</div>;
        })}
      </div>
    </>
  );
}

export const when = (iso?: string | null) => fmtDateTime(iso);

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<unknown>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then((d) => { if (live) { setData(d); setErr(undefined); } }).catch((e) => { if (live) setErr(e); }).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [...deps, n]); // eslint-disable-line
  return { data, loading, err, reload: () => setN((x) => x + 1), setData };
}
export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
