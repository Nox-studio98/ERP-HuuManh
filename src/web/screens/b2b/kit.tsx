import { useEffect, useState, type ReactNode } from "react";
import { ApiError, get, items } from "../../api";
import { Badge, Button, DecInput, Input, MoneyInput, Select, Sheet, Spinner, useDebounced } from "../../components/ui";
import { money, unitLabel } from "../../format";
import { navigate, onLink } from "../../router";

/* ---------- nhãn trạng thái ---------- */
export const QUOTE_STATUS: Record<string, string> = { draft: "Nháp", pending_approval: "Chờ duyệt", sent: "Đã gửi", accepted: "Đã chốt đơn", expired: "Hết hạn", cancelled: "Đã huỷ" };
export const DELIVERY_STATUS: Record<string, string> = { picking: "Đang soạn", ready: "Soạn xong", shipping: "Đang giao", delivered: "Đã giao", failed: "Giao thất bại", cancelled: "Đã huỷ" };
export const EINVOICE: Record<string, string> = { none: "Chưa phát hành", queued: "Đang chờ", issued: "Đã phát hành", failed: "Lỗi", not_required: "Không cần" };
export const INVOICE_KIND: Record<string, string> = { sale: "Bán hàng", adjustment: "Điều chỉnh", replacement: "Thay thế" };
export const CREDIT_REASON: Record<string, string> = { overdue: "Khách đang có nợ quá hạn", over_limit: "Vượt hạn mức công nợ" };
export const REJECT_REASONS: [string, string][] = [["hong", "Hư hỏng"], ["sai_quy_cach", "Sai quy cách"], ["thua", "Thừa"], ["khac", "Khác"]];
export const REJECT_LABEL = Object.fromEntries(REJECT_REASONS) as Record<string, string>;
export const ADJ_TYPE: Record<string, string> = { discount: "Chiết khấu", write_off: "Xoá nợ", offset: "Cấn trừ" };

export const quoteTone = (s: string) => ({ draft: "info", pending_approval: "warn", sent: "info", accepted: "ok", expired: "warn", cancelled: "danger" } as any)[s];
export const einvTone = (s: string) => ({ issued: "ok", queued: "info", failed: "danger", none: "warn" } as any)[s];
export const deliveryTone = (s: string) => ({ delivered: "ok", failed: "danger", cancelled: "danger", picking: "info", ready: "info", shipping: "info" } as any)[s];
export const orderTone = (s: string) => (s === "completed" ? "ok" : s === "cancelled" || s === "delivery_failed" ? "danger" : s === "new" ? "warn" : "info") as any;

/** YYYY-MM-DD → dd/mm/yyyy */
export const ymd = (s?: string | null) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "—");
export const qparam = (k: string) => { try { return new URLSearchParams(location.search).get(k); } catch { return null; } };
/** số lượng hiển thị gọn (tối đa 3 số lẻ, dấu phẩy) */
export const q3 = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n));
/** số lượng theo đơn vị của dòng (không phải milli) */
export const qtyU = (n: number | null | undefined, unit: string) => (n == null ? "—" : `${q3(n)} ${unitLabel(unit)}`);
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function Back({ to, label }: { to: string; label: string }) {
  return <a href={to} className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={(e) => onLink(e, to)}>← {label}</a>;
}
export function Lnk({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={(e) => onLink(e, to)}>{children}</a>;
}

/** Huy hiệu công nợ: số dư + quá hạn (cam) */
export function DebtBadge({ debt }: { debt?: { balance: number; overdueAmount: number } | null }) {
  if (!debt) return <span className="muted">—</span>;
  return (
    <span className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
      <span className="money" style={{ color: debt.balance < 0 ? "var(--accent)" : undefined }}>{debt.balance < 0 ? `Dư có ${money(-debt.balance)}` : debt.balance ? money(debt.balance) : "Không nợ"}</span>
      {debt.overdueAmount > 0 && <Badge tone="warn">Quá hạn {money(debt.overdueAmount)}</Badge>}
    </span>
  );
}

/** Tìm & chọn khách sỉ */
export type CustomerLite = { id: number; name: string; code?: string; customerGroupId?: number | null; debt?: any };
export function CustomerSelect({ value, onChange, label = "Khách hàng" }: { value: CustomerLite | null; onChange: (c: CustomerLite | null) => void; label?: string }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 200);
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (value) return;
    let live = true;
    get("/customers", { type: "b2b", q: dq, limit: 8 }, { silent: true }).then((r) => live && setRows(items(r))).catch(() => {});
    return () => { live = false; };
  }, [dq, value]);
  if (value) return (
    <div className="field"><span className="lbl">{label}</span>
      <div className="row between card flat" style={{ padding: "8px 12px" }}><span><b>{value.name}</b> {value.code && <span className="muted small">{value.code}</span>}</span><Button size="sm" variant="ghost" onClick={() => onChange(null)}>Đổi</Button></div>
    </div>
  );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Input label={label} placeholder="Gõ tên, mã hoặc SĐT khách…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      <div className="stack" style={{ gap: 4 }} role="listbox" aria-label="Kết quả khách hàng">
        {rows.map((c) => (
          <button key={c.id} role="option" aria-selected={false} className="dt-card" onClick={() => onChange(c)}>
            <div className="row between"><b>{c.name}</b><span className="muted small">{c.code}</span></div>
          </button>
        ))}
        {!rows.length && <div className="hint">Không tìm thấy khách sỉ.</div>}
      </div>
    </div>
  );
}

/** Tìm & chọn nhà cung cấp */
export function SupplierSelect({ value, onChange }: { value: { id: number; name: string } | null; onChange: (c: { id: number; name: string } | null) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 200);
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (value) return;
    let live = true;
    get("/suppliers", { q: dq, limit: 8 }, { silent: true }).then((r) => live && setRows(items(r))).catch(() => {});
    return () => { live = false; };
  }, [dq, value]);
  if (value) return <div className="field"><span className="lbl">Nhà cung cấp</span><div className="row between card flat" style={{ padding: "8px 12px" }}><b>{value.name}</b><Button size="sm" variant="ghost" onClick={() => onChange(null)}>Đổi</Button></div></div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Input label="Nhà cung cấp" placeholder="Gõ tên hoặc mã…" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows.map((c) => <button key={c.id} className="dt-card" onClick={() => onChange(c)}><b>{c.name}</b> <span className="muted small">{c.code}</span></button>)}
    </div>
  );
}

/** Chọn hàng hoá (sheet) */
export type ProductLite = { id: number; name: string; sku?: string; baseUnit: string; units?: { unit: string; factorMilli: number }[]; avgCost?: number; availableMilli?: number };
export function ProductPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (p: ProductLite) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 200);
  const [rows, setRows] = useState<ProductLite[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    get("/products", { q: dq, limit: 30, active: 1 }, { silent: true }).then((r) => live && setRows(items(r))).catch(() => live && setRows([]));
    return () => { live = false; };
  }, [dq, open]);
  return (
    <Sheet open={open} onClose={onClose} title="Chọn hàng hoá">
      <div className="stack">
        <Input label="Tìm hàng" placeholder="Tên hoặc mã hàng…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {rows === null ? <Spinner /> : rows.map((p) => (
          <button key={p.id} className="dt-card" onClick={() => { onPick(p); onClose(); }} aria-label={`Chọn ${p.name}`}>
            <div className="row between"><b>{p.name}</b><span className="muted small">{p.sku}</span></div>
            <div className="small muted">Đơn vị: {unitLabel(p.baseUnit)}{p.availableMilli != null ? ` · Tồn khả dụng ${q3(p.availableMilli / 1000)}` : ""}</div>
          </button>
        ))}
        {rows && !rows.length && <div className="hint">Không có hàng phù hợp.</div>}
      </div>
    </Sheet>
  );
}

/** Dòng hàng trong báo giá / đơn sỉ */
export type EditLine = { key: string; product: ProductLite; unit: string; qty: number; unitPrice: number; listPrice: number | null };
export const factorOf = (l: EditLine) => (l.unit === l.product.baseUnit ? 1000 : l.product.units?.find((u) => u.unit === l.unit)?.factorMilli ?? 1000);
export const effPrice = (l: EditLine) => (l.unitPrice > 0 ? l.unitPrice : l.listPrice ?? 0);
export const lineAmt = (l: EditLine) => Math.round((effPrice(l) * Math.round(l.qty * factorOf(l))) / 1000);

export function LinesEditor({ lines, setLines, groupId, customerId, allowPrice, showCost }: { lines: EditLine[]; setLines: (l: EditLine[]) => void; groupId?: number | null; customerId?: number | null; allowPrice: boolean; showCost: boolean }) {
  const [pick, setPick] = useState(false);
  const add = async (p: ProductLite) => {
    let listPrice: number | null = null;
    try { const r = await get("/prices/quote", { productId: p.id, channel: "b2b", customerGroupId: groupId ?? undefined, customerId: customerId ?? undefined }, { silent: true }); listPrice = r?.unitPrice ?? null; } catch { /* không có quyền xem giá */ }
    setLines([...lines, { key: `${p.id}-${Date.now()}`, product: p, unit: p.baseUnit, qty: 1, unitPrice: 0, listPrice }]);
  };
  const upd = (k: string, patch: Partial<EditLine>) => setLines(lines.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + lineAmt(l), 0);
  return (
    <div className="stack">
      {lines.map((l) => {
        const p = effPrice(l);
        const cost = l.product.avgCost;
        const below = showCost && cost != null && p > 0 && p < cost;
        const margin = showCost && cost != null && p > 0 ? Math.round(((p - cost) * 100) / p) : null;
        const disc = l.listPrice && l.unitPrice > 0 && l.unitPrice < l.listPrice ? Math.round(((l.listPrice - l.unitPrice) * 1000) / l.listPrice) / 10 : 0;
        return (
          <div key={l.key} className="card flat" style={below ? { background: "var(--danger-soft)", borderColor: "var(--danger)" } : undefined} data-testid="edit-line">
            <div className="row between"><b>{l.product.name}</b><Button size="sm" variant="ghost" aria-label={`Bỏ ${l.product.name}`} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>Bỏ</Button></div>
            <div className="grid2" style={{ marginTop: 8 }}>
              <DecInput label="Số lượng" value={l.qty || ""} onChange={(n) => upd(l.key, { qty: n })} />
              <Select label="Đơn vị" value={l.unit} onChange={(e) => upd(l.key, { unit: e.target.value })}>
                {(l.product.units?.length ? l.product.units : [{ unit: l.product.baseUnit, factorMilli: 1000 }]).map((u) => <option key={u.unit} value={u.unit}>{unitLabel(u.unit)}</option>)}
              </Select>
            </div>
            <div style={{ marginTop: 8 }}>
              {allowPrice
                ? <MoneyInput label={`Đơn giá (₫/${unitLabel(l.product.baseUnit)}) — để trống: theo bảng giá`} value={l.unitPrice} onChange={(n) => upd(l.key, { unitPrice: n })} />
                : null}
              <div className="row between wrap small" style={{ marginTop: 6 }}>
                <span className="muted">Giá bảng: {l.listPrice != null ? money(l.listPrice) : "—"}{disc > 0 && <> · <b style={{ color: "var(--warn)" }}>giảm {disc}%</b></>}</span>
                <span className="row" style={{ gap: 6 }}>
                  {margin != null && <Badge tone={below ? "danger" : margin < 10 ? "warn" : "ok"}>{below ? "Dưới giá vốn · " : "Biên "}{margin}%</Badge>}
                  <b className="money">{money(lineAmt(l))}</b>
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <div className="row between"><Button variant="soft" onClick={() => setPick(true)}>+ Thêm hàng</Button><span>Tạm tính: <b className="money">{money(total)}</b></span></div>
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={add} />
    </div>
  );
}
export const linePayload = (lines: EditLine[], withPrice: boolean) =>
  lines.map((l) => ({ productId: l.product.id, unit: l.unit, qty: l.qty, ...(withPrice && l.unitPrice > 0 ? { unitPrice: l.unitPrice } : {}) }));

/** Khối giải thích 409 credit_blocked */
export function CreditBlocked({ details, orderLink }: { details: any; orderLink?: ReactNode }) {
  const st = details?.status ?? {};
  return (
    <div className="stack" data-testid="credit-blocked">
      <div className="banner danger">
        <b>Đơn bị chặn công nợ</b>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{(details?.reasons ?? []).map((r: string) => <li key={r}>{CREDIT_REASON[r] ?? r}</li>)}</ul>
      </div>
      <div className="kpis">
        {details?.orderAmount != null && <div className="kpi"><div className="l">Giá trị đơn này</div><div className="v">{money(details.orderAmount)}</div></div>}
        <div className="kpi"><div className="l">Công nợ hiện tại</div><div className="v">{money(st.balance)}</div></div>
        <div className="kpi"><div className="l">Quá hạn</div><div className="v" style={{ color: st.overdueAmount ? "var(--warn)" : undefined }}>{money(st.overdueAmount)}</div></div>
        <div className="kpi"><div className="l">Hạn mức</div><div className="v">{money(st.creditLimit)}</div></div>
        <div className="kpi"><div className="l">Còn được nợ</div><div className="v" style={{ color: st.available < 0 ? "var(--danger)" : undefined }}>{money(st.available)}</div></div>
      </div>
      <div className="banner info">Đã gửi chủ duyệt{details?.approvalId ? <> — yêu cầu <b>#{details.approvalId}</b></> : null}. Sau khi chủ duyệt, bấm <b>Giữ hàng lại</b> trên đơn để giữ tồn.</div>
      {orderLink}
    </div>
  );
}

export const unitLabelSafe = unitLabel;
export const errCode = (e: unknown) => (e instanceof ApiError ? e.code : "");

/** Hộp nhập lý do dùng chung */
export function ReasonSheet({ title, label = "Lý do", confirm, danger, onClose, onSubmit, minLen = 3, children }: { title: string; label?: string; confirm: string; danger?: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<void>; minLen?: number; children?: ReactNode }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={title} footer={<Button block variant={danger ? "danger" : "primary"} loading={busy} disabled={reason.trim().length < minLen} onClick={async () => { setBusy(true); try { await onSubmit(reason.trim()); } catch { /* đã báo lỗi */ } finally { setBusy(false); } }}>{confirm}</Button>}>
      <div className="stack">{children}<Input label={label} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></div>
    </Sheet>
  );
}

export { navigate };
