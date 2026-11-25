import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FruitArt } from "./lib/art";
import { ApiError, errMsg, type Card } from "./lib/api";
import { money, num, unitName } from "./lib/format";
import { Link } from "./lib/router";
import { cartActions, stepInUnit, type CartItem } from "./lib/store";

/* ---------- icon ---------- */
const P: Record<string, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10" />,
  grid: <path d="M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z" />,
  cart: <><path d="M3 4h2.4l2.1 11h10.2l2-8H6.3" /><circle cx="9" cy="19.5" r="1.4" /><circle cx="17" cy="19.5" r="1.4" /></>,
  user: <><circle cx="12" cy="8.5" r="4" /><path d="M4.5 20c.8-4 3.8-6 7.5-6s6.7 2 7.5 6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></>,
  trash: <path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7M10 11v5M14 11v5" />,
  chevR: <path d="m9 5 7 7-7 7" />,
  chevL: <path d="m15 5-7 7 7 7" />,
  truck: <><path d="M3 6.5h11v10H3zM14 10h4l3 3v3.5h-7" /><circle cx="7.5" cy="18" r="1.7" /><circle cx="17" cy="18" r="1.7" /></>,
  leaf: <path d="M5 19c0-9 5-14 15-14 0 10-5 15-14 15M5 19c3-5 6-8 10-10" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pin: <><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  bell: <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  alert: <><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.5M12 17.2v.1" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></>,
  box: <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9" />,
  logout: <path d="M10 4.5H5.5v15H10M15 8l4 4-4 4M19 12H9" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  receipt: <path d="M6 3.5h12v17l-2.2-1.5-2.1 1.5-1.7-1.5-1.7 1.5-2.1-1.5L6 20.5zM9 8.5h6M9 12h6" />,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18M7 15h3" /></>,
  download: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />,
};
export function Icon({ n, size = 22, className }: { n: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {P[n]}
    </svg>
  );
}

/* ---------- ảnh ---------- */
export function Img({ src, alt, seed, className, eager }: { src: string | null | undefined; alt: string; seed: string; className?: string; eager?: boolean }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  if (!src || bad) return <div className={`img ${className ?? ""}`} role="img" aria-label={alt}><FruitArt seed={seed} /></div>;
  return (
    <div className={`img ${className ?? ""}`}>
      <img src={src} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setBad(true)} />
    </div>
  );
}

/* ---------- async ---------- */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState({ data: null, error, loading: false }),
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload };
}

export function Loading({ label = "Đang tải…" }: { label?: string }) {
  return <div className="loading" role="status"><span className="spin" aria-hidden="true" />{label}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state err" role="alert">
      <Icon n="alert" size={28} />
      <p>{errMsg(error)}</p>
      {onRetry && <button className="btn" onClick={onRetry}>Thử lại</button>}
    </div>
  );
}

export function Empty({ title, children, art }: { title: string; children?: ReactNode; art?: boolean }) {
  return (
    <div className="state">
      {art && <div className="empty-art"><FruitArt seed={title} /></div>}
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/* ---------- form ---------- */
export function Field({ label, hint, error, children, id }: { label: string; hint?: string; error?: string | null; children: (p: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode; id: string }) {
  const d = error ? `${id}-e` : hint ? `${id}-h` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": d, "aria-invalid": error ? true : undefined })}
      {error ? <p className="hint err" id={`${id}-e`}>{error}</p> : hint ? <p className="hint" id={`${id}-h`}>{hint}</p> : null}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "err" | "ok"; children: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === "err" ? "alert" : "status"}>
      <Icon n={kind === "ok" ? "check" : kind === "info" ? "info" : "alert"} size={20} />
      <div>{children}</div>
    </div>
  );
}

/* ---------- sao chép ---------- */
export function CopyButton({ text, label, what }: { text: string; label?: string; what: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm ghost copy"
      aria-label={`Sao chép ${what}`}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); }
        catch {
          const t = document.createElement("textarea");
          t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
          document.body.appendChild(t); t.select();
          try { document.execCommand("copy"); } catch { /* bỏ qua */ }
          t.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1800);
      }}
    >
      <Icon n={done ? "check" : "copy"} size={16} />
      <span aria-live="polite">{done ? "Đã chép" : label ?? "Sao chép"}</span>
    </button>
  );
}

/* ---------- hộp thoại (native <dialog>) ---------- */
export function Modal({ open, onClose, title, children, foot }: { open: boolean; onClose: () => void; title: string; children: ReactNode; foot?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }} aria-labelledby="modal-title">
      {open && (
        <div className="modal-body">
          <div className="modal-head">
            <h2 id="modal-title">{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Đóng"><Icon n="x" /></button>
          </div>
          <div className="modal-content">{children}</div>
          {foot && <div className="modal-foot">{foot}</div>}
        </div>
      )}
    </dialog>
  );
}

/* ---------- số lượng ---------- */
export function Stepper({ item, onChange, compact, allowRemove }: { allowRemove?: boolean; item: Pick<CartItem, "name" | "unit" | "qtyMilli" | "factorMilli" | "stepMilli">; onChange: (qtyMilli: number) => void; compact?: boolean }) {
  const step = stepInUnit(item);
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? num(item.qtyMilli / 1000);
  const commit = (raw: string) => {
    setText(null);
    const v = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(v)) return;
    const m = Math.max(step, Math.round(Math.round(v * 1000) / step) * step);
    onChange(m);
  };
  return (
    <div className={`stepper ${compact ? "compact" : ""}`} role="group" aria-label={`Số lượng ${item.name}`}>
      <button type="button" onClick={() => onChange(item.qtyMilli - step)} aria-label={allowRemove && item.qtyMilli - step <= 0 ? `Bỏ ${item.name} khỏi giỏ` : `Giảm ${num(step / 1000)} ${unitName(item.unit)}`}><Icon n={allowRemove && item.qtyMilli - step <= 0 ? "trash" : "minus"} size={18} /></button>
      <input
        inputMode="decimal"
        aria-label={`Số lượng (${unitName(item.unit)})`}
        value={shown}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => text !== null && commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
      />
      <span className="u" aria-hidden="true">{unitName(item.unit)}</span>
      <button type="button" onClick={() => onChange(item.qtyMilli + step)} aria-label={`Tăng ${num(step / 1000)} ${unitName(item.unit)}`}><Icon n="plus" size={18} /></button>
    </div>
  );
}

/* ---------- thẻ sản phẩm ---------- */
export function ProductCard({ p, eager }: { p: Card; eager?: boolean }) {
  const soldOut = !p.inStock && !p.allowPreorder;
  return (
    <article className="pcard">
      <Link to={`/san-pham/${encodeURIComponent(p.slug)}`} className="pcard-link" aria-label={`${p.name}, ${money(p.price)} một ${unitName(p.baseUnit)}`}>
        <Img src={p.imageUrl} alt="" seed={p.name} eager={eager} className="pcard-img" />
        <div className="pcard-badges">
          {soldOut && <span className="badge dark">Tạm hết</span>}
          {!p.inStock && p.allowPreorder && <span className="badge accent">Đặt trước</span>}
          {p.sellByWeight && p.inStock && <span className="badge soft">Cân theo ký</span>}
        </div>
        <div className="pcard-body">
          <h3>{p.name}</h3>
          {p.origin && <p className="origin">{p.origin}</p>}
          <p className="price"><strong>{money(p.price)}</strong><span>/{unitName(p.baseUnit)}</span></p>
        </div>
      </Link>
      <button
        className="btn sm add"
        disabled={soldOut}
        onClick={() => cartActions.add(p)}
        aria-label={soldOut ? `${p.name} tạm hết hàng` : `Thêm ${p.name} vào giỏ`}
      >
        <Icon n="plus" size={16} /> Thêm
      </button>
    </article>
  );
}

export const isNetErr = (e: unknown) => e instanceof ApiError && e.status === 0;
