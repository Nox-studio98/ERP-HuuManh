import "./d4.css";
import { useMemo, useState, type ReactNode } from "react";
import { get, items } from "../../api";
import { Button, Input, Sheet, Spinner, useAsync, useDebounced } from "../../components/ui";
import { toast } from "../../components/toast";
import { money } from "../../format";

export type Prod = { id: number; sku: string; name: string; groupId?: number | null; baseUnit: string; sellByWeight?: boolean | number; units?: { unit: string; factorMilli: number }[]; availableMilli?: number; price?: number | null; avgCost?: number | null };

/** Danh mục sản phẩm + nhóm (tải một lần, dùng chung giữa các màn Đợt 4). */
let catalogP: Promise<{ products: Prod[]; groups: { id: number; name: string }[] }> | null = null;
export const reloadCatalog = () => { catalogP = null; };
export function loadCatalog() {
  catalogP ??= Promise.all([
    get("/products", { limit: 200, active: 1 }).then((r) => items<Prod>(r)),
    get("/product-groups", undefined, { silent: true }).then((r) => items<{ id: number; name: string }>(r)).catch(() => []),
  ]).then(([products, groups]) => ({ products, groups })).catch((e) => { catalogP = null; throw e; });
  return catalogP;
}
export function useCatalog(deps: unknown[] = []) {
  const a = useAsync(() => loadCatalog(), deps);
  const byId = useMemo(() => new Map((a.data?.products ?? []).map((p) => [p.id, p])), [a.data]);
  return { products: a.data?.products ?? [], groups: a.data?.groups ?? [], byId, loading: a.loading, reload: () => { reloadCatalog(); a.reload(); } };
}

export const bpPct = (bp: number | null | undefined) => (bp == null ? "—" : `${(bp / 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}%`);
/** chênh lệch cơ sở bp → "+12,5%" */
export const diffText = (bp: number | null | undefined) => (bp == null ? "—" : `${bp > 0 ? "+" : ""}${(bp / 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`);

export function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); toast("Đã sao chép", "ok"); }
  catch {
    const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Đã sao chép", "ok"); } catch { toast("Không sao chép được", "error"); }
    ta.remove();
  }
}

export function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ok" | "danger" | "warn" }) {
  const c = tone === "ok" ? "var(--accent)" : tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : undefined;
  return <div className="kpi"><div className="l">{label}</div><div className="v" style={{ color: c }}>{value}</div>{sub && <div className="small muted">{sub}</div>}</div>;
}

/** Hộp chọn sản phẩm (tìm theo tên / SKU). */
export function ProductPicker({ open, onClose, onPick, title = "Chọn sản phẩm", only }: { open: boolean; onClose: () => void; onPick: (p: Prod) => void; title?: string; only?: (p: Prod) => boolean }) {
  const { products, loading } = useCatalog();
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 120).trim().toLowerCase();
  const list = products.filter((p) => (!only || only(p)) && (!dq || p.name.toLowerCase().includes(dq) || p.sku.toLowerCase().includes(dq))).slice(0, 60);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="stack">
        <Input label="Tìm sản phẩm" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {loading ? <Spinner /> : list.length === 0 ? <div className="muted">Không có sản phẩm phù hợp.</div> : (
          <div className="stack" style={{ gap: 6 }}>
            {list.map((p) => (
              <button key={p.id} type="button" className="dt-card" onClick={() => { onPick(p); setQ(""); onClose(); }}>
                <div className="ttl">{p.name}</div>
                <div className="small muted">{p.sku} · {p.price ? money(p.price) + "/" + p.baseUnit : "chưa có giá"}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

export const Loading = ({ on }: { on: boolean }) => (on ? <Spinner /> : null);
export const act = async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
  try { const r = await fn(); if (okMsg) toast(okMsg, "ok"); return r; } catch { return undefined; }
};
export const BtnRow = ({ children }: { children: ReactNode }) => <div className="row wrap" style={{ gap: 8 }}>{children}</div>;
export { Button };

/** Nhóm điều khiển (nút, ô tick…) có nhãn — không dùng <label> bao ngoài để tên nút không bị nhãn che. */
export const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="field" role="group" aria-label={label}><span className="lbl">{label}</span>{children}</div>
);
