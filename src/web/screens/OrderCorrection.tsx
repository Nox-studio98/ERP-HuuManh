import { useRef, useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Banner, Button, DecInput, Input, MoneyInput, Select, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { lineName } from "../components/Receipt";
import { toast } from "../components/toast";
import { METHODS, money, unitLabel, uuid } from "../format";
import { priceOf, type Product } from "./Pos";

/**
 * G9: Sửa chi tiết hoá đơn POS đã lập. Không sửa chứng từ cũ: hệ thống lập phiếu trả toàn bộ đơn cũ (nhập lại đúng lô) + đơn bán mới đã sửa,
 * khoản khách đã trả chuyển sang đơn mới (không ra tiền); chênh lệch thu thêm / hoàn qua két ca đang mở.
 */
const REASON_VI: Record<string, string> = { other_shift: "đơn không thuộc ca đang mở", high_value: "giá trị lớn" };
// Dòng của đơn mới: dòng giữ từ đơn cũ (giữ giá cũ) hoặc dòng thêm (giá hiện hành). price = giá / ĐƠN VỊ CHÍNH.
type Line = { key: string; origId?: number; productId: number; name: string; unit: string; baseUnit: string; qty: number; basePrice: number; price: number; factor: number };

export function CorrectionForm({ order, onCancel, onDone }: { order: any; onCancel: () => void; onDone: (r: any) => void }) {
  const [lines, setLines] = useState<Line[]>(() => (order.lines ?? []).map((l: any) => ({
    key: `o${l.id}`, origId: l.id, productId: l.productId, name: lineName(l), unit: l.unit, baseUnit: l.unit, qty: l.qtyShown / 1000, basePrice: l.unitPrice, price: l.unitPrice, factor: l.factor ?? 1000,
  })));
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [search, setSearch] = useState("");
  const dq = useDebounced(search, 250);
  const prods = useAsync(() => (dq.trim() ? get("/products", { q: dq, limit: 6, active: 1 }).then((r) => items<Product>(r)) : Promise.resolve([] as Product[])), [dq]);
  const [method, setMethod] = useState("cash"), [given, setGiven] = useState(0);
  const [approval, setApproval] = useState<{ id: number; reasons: string[] } | null>(null);
  const uid = useRef(uuid());

  const charges = (order.charges ?? []).reduce((s: number, c: any) => s + c.amount, 0);
  const lineTotal = (l: Line) => Math.round((l.price * l.qty * l.factor) / 1000);
  const newTotal = lines.reduce((s, l) => s + lineTotal(l), 0) + charges;
  const oldTotal = order.total as number;
  const diff = newTotal - oldTotal;
  const paid = method === "cash" ? Math.max(given, 0) : diff;
  const change = diff > 0 && method === "cash" ? Math.max(0, paid - diff) : 0;
  const valid = lines.length > 0 && lines.every((l) => l.qty > 0 && l.price > 0 && l.price <= l.basePrice) && reason.trim().length >= 3 && (diff <= 0 || paid >= diff);
  const patch = (key: string, p: Partial<Line>) => setLines((a) => a.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const add = (p: Product) => {
    setLines((a) => [...a, { key: `n${p.id}-${a.length}`, productId: p.id, name: p.name, unit: p.baseUnit, baseUnit: p.baseUnit, qty: 1, basePrice: priceOf(p), price: priceOf(p), factor: 1000 }]);
    setSearch("");
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post(`/orders/${order.id}/correct`, {
        clientUuid: uid.current, reason: reason.trim(),
        lines: lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty, ...(l.origId ? { originalLineId: l.origId } : {}), ...(l.price !== l.basePrice ? { unitPrice: l.price } : {}) })),
        refundMethod: diff < 0 ? method : "cash",
        payments: diff > 0 ? [{ method, amount: method === "cash" ? paid : diff }] : [],
        ...(approval ? { approvalId: approval.id } : {}),
      });
      toast("Đã sửa hoá đơn", "ok"); onDone(r);
    } catch (e) {
      if (e instanceof ApiError && e.code === "approval_required") setApproval({ id: e.details?.approvalId, reasons: e.details?.reasons ?? [] });
      else if (e instanceof ApiError && e.code === "approval_invalid") { setApproval(null); uid.current = uuid(); }
    } finally { setBusy(false); }
  };

  return (
    <div className="stack" data-testid="order-correction">
      <Banner tone="info">Hoá đơn cũ không bị sửa: hệ thống trả lại toàn bộ đơn <b>{order.code}</b> (nhập lại đúng lô) và lập đơn bán mới với nội dung bạn sửa. Khoản khách đã trả được chuyển sang đơn mới.</Banner>
      <div className="ex-step"><span className="ex-n">1</span><b>Nội dung đơn mới</b></div>
      {lines.map((l) => (
        <div key={l.key} className="oc-line" data-testid="oc-line">
          <div className="row between wrap">
            <div style={{ minWidth: 0 }}><b>{l.name}</b><div className="oc-tag">{l.origId ? "Dòng của đơn cũ — giữ giá cũ" : "Hàng thêm — giá hiện hành"} · {money(l.basePrice)}/{unitLabel(l.baseUnit)}</div></div>
            <Button size="sm" variant="ghost" onClick={() => setLines((a) => a.filter((x) => x.key !== l.key))} aria-label={`Bỏ ${l.name}`}>Bỏ</Button>
          </div>
          <div className="qr-grid">
            <DecInput label={`Số lượng (${unitLabel(l.unit)})`} value={l.qty} onChange={(n) => patch(l.key, { qty: n })} />
            <MoneyInput label="Giá / đơn vị chính (₫)" value={l.price} onChange={(n) => patch(l.key, { price: n })}
              hint={l.price > l.basePrice ? "Không được cao hơn giá gốc" : l.price < l.basePrice ? "Đã giảm" : undefined} />
          </div>
          <div className="small muted">Thành tiền <span className="money">{money(lineTotal(l))}</span></div>
        </div>
      ))}
      <Input label="Thêm hàng" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tên hoặc mã…" />
      {dq.trim() && (prods.loading ? <Spinner /> : (
        <div className="ex-results">
          {(prods.data ?? []).length === 0 ? <div className="muted small">Không tìm thấy hàng phù hợp.</div> : (prods.data ?? []).map((p) => (
            <button key={p.id} type="button" className="ex-pick" onClick={() => add(p)}>
              <span className="n">{p.name}</span><span className="muted small">{priceOf(p) ? `${money(priceOf(p))}/${unitLabel(p.baseUnit)}` : "Chưa có giá"}</span>
            </button>
          ))}
        </div>
      ))}
      <TextArea label="Lý do sửa hoá đơn (bắt buộc)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="oc-reason" />

      <div className="ex-step"><span className="ex-n">2</span><b>Chênh lệch</b></div>
      <div className="totals ex-sum">
        <div><span className="muted">Đơn cũ đã thu</span><span className="money">{money(oldTotal)}</span></div>
        {charges > 0 && <div><span className="muted">Thu khác (mang sang)</span><span className="money">{money(charges)}</span></div>}
        <div><span className="muted">Đơn mới</span><span className="money">{money(newTotal)}</span></div>
        <div className="grand"><span>{diff > 0 ? "Khách trả thêm" : diff < 0 ? "Hoàn lại khách" : "Không chênh lệch"}</span><span className="money">{money(Math.abs(diff))}</span></div>
      </div>
      {diff !== 0 && (
        <Select label={diff > 0 ? "Khách thanh toán bằng" : "Hoàn tiền bằng"} value={method} onChange={(e) => setMethod(e.target.value)}>
          {["cash", "transfer", "qr", "card"].map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}
        </Select>
      )}
      {diff > 0 && method === "cash" && <MoneyInput label="Khách đưa (₫)" value={given} onChange={setGiven} hint={change > 0 ? `Thối lại ${money(change)}` : given && given < diff ? `Còn thiếu ${money(diff - given)}` : `Cần thu ${money(diff)}`} />}
      <div className="hint">Giá không được cao hơn giá gốc của dòng. Máy chủ tính lại khi xác nhận; tiền chênh lệch đi qua két của ca đang mở.</div>
      {approval && <Banner tone="info">Cần quản lý duyệt ({approval.reasons.map((r) => REASON_VI[r] ?? r).join(", ")}). Đã gửi yêu cầu #{approval.id}; khi được duyệt, bấm “Xác nhận sửa hoá đơn” lại.</Banner>}
      <div className="row"><Button variant="ghost" onClick={onCancel}>Quay lại</Button><Button className="grow" loading={busy} disabled={!valid} data-testid="oc-submit" onClick={submit}>Xác nhận sửa hoá đơn</Button></div>
    </div>
  );
}
