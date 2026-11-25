import { useRef, useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Banner, Button, DecInput, Input, MoneyInput, Select, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { lineName } from "../components/Receipt";
import { toast } from "../components/toast";
import { METHODS, money, qtyText, unitLabel, uuid } from "../format";
import { priceOf, type Product } from "./Pos";

// A-13 (EC-10): Đổi hàng tại quầy — trả một phần đơn cũ + lấy hàng mới trong MỘT lần; thu thêm / hoàn phần chênh lệch.
// Tách đơn con KHÔNG nằm trong phạm vi.
const REASON_VI: Record<string, string> = { other_shift: "đơn không thuộc ca đang mở", high_value: "giá trị trả lớn", no_restock: "không nhập lại kho" };
type NewLine = { product: Product; qty: number };

export function ExchangeForm({ order, onCancel, onDone }: { order: any; onCancel: () => void; onDone: (r: any) => void }) {
  const [q, setQ] = useState<Record<number, number>>({});
  const [restock, setRestock] = useState(true), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const dq = useDebounced(search, 250);
  const prods = useAsync(() => (dq.trim() ? get("/products", { q: dq, limit: 6, active: 1 }).then((r) => items<Product>(r)) : Promise.resolve([] as Product[])), [dq]);
  const [news, setNews] = useState<NewLine[]>([]);
  const [method, setMethod] = useState("cash"), [given, setGiven] = useState(0);
  const [approval, setApproval] = useState<{ id: number; reasons: string[] } | null>(null);
  const uid = useRef(uuid());

  const chosen = (order.lines ?? []).filter((l: any) => (q[l.id] ?? 0) > 0);
  // Ước tính để hiển thị: số tiền trả theo giá đã bán, hàng mới theo giá niêm yết hiện hành (máy chủ tính lại khi xác nhận)
  const returnTotal = chosen.reduce((s: number, l: any) => s + Math.round(((l.lineTotal ?? 0) * q[l.id] * 1000) / (l.qtyShown || 1)), 0);
  const newTotal = news.reduce((s, n) => s + Math.round(priceOf(n.product) * n.qty), 0);
  const net = newTotal - returnTotal;
  const paid = method === "cash" ? Math.max(given, 0) : net;
  const change = net > 0 && method === "cash" ? Math.max(0, paid - net) : 0;
  const ready = chosen.length > 0 && news.length > 0 && news.every((n) => n.qty > 0) && reason.trim().length >= 2 && (net <= 0 || paid >= net);

  const addNew = (p: Product) => { setNews((a) => (a.some((x) => x.product.id === p.id) ? a.map((x) => (x.product.id === p.id ? { ...x, qty: x.qty + 1 } : x)) : [...a, { product: p, qty: 1 }])); setSearch(""); };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post(`/orders/${order.id}/exchange`, {
        clientUuid: uid.current,
        returnLines: chosen.map((l: any) => ({ orderLineId: l.id, qty: q[l.id], unit: l.unit, restock, reason })),
        newLines: news.map((n) => ({ productId: n.product.id, unit: n.product.baseUnit, qty: n.qty })),
        refundMethod: net > 0 ? "cash" : method,
        payments: net > 0 ? [{ method, amount: method === "cash" ? paid : net }] : [],
        ...(approval ? { approvalId: approval.id } : {}),
      });
      toast("Đã đổi hàng", "ok"); onDone(r);
    } catch (e) {
      // A-16: đơn ca khác / giá trị lớn / không nhập lại kho cần quản lý duyệt, rồi bấm xác nhận lại
      if (e instanceof ApiError && e.code === "approval_required") setApproval({ id: e.details?.approvalId, reasons: e.details?.reasons ?? [] });
      else if (e instanceof ApiError && e.code === "approval_invalid") setApproval(null);
    } finally { setBusy(false); }
  };

  return (
    <div className="stack exchange">
      <div className="ex-step"><span className="ex-n">1</span><b>Hàng khách trả lại</b></div>
      {(order.lines ?? []).map((l: any) => (
        <div key={l.id} className="row between wrap">
          <div style={{ minWidth: 0 }}><b>{lineName(l)}</b><div className="small muted">Đã mua {qtyText(l.qtyShown, l.unit)}</div></div>
          <div style={{ width: 140 }}><DecInput label={`Trả (${unitLabel(l.unit)})`} value={q[l.id] ?? ""} onChange={(n) => setQ({ ...q, [l.id]: Math.min(n, l.qtyShown / 1000) })} /></div>
        </div>
      ))}
      <label className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} style={{ width: 22, height: 22 }} /> <span>Nhập lại kho (hàng còn bán được)</span></label>
      <TextArea label="Lý do đổi hàng" value={reason} onChange={(e) => setReason(e.target.value)} />

      <div className="ex-step"><span className="ex-n">2</span><b>Hàng khách lấy</b></div>
      <Input label="Tìm hàng mới" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tên hoặc mã…" />
      {dq.trim() && (prods.loading ? <Spinner /> : (
        <div className="ex-results">
          {(prods.data ?? []).length === 0 ? <div className="muted small">Không tìm thấy hàng phù hợp.</div> : (prods.data ?? []).map((p) => (
            <button key={p.id} type="button" className="ex-pick" onClick={() => addNew(p)}>
              <span className="n">{p.name}</span><span className="muted small">{priceOf(p) ? `${money(priceOf(p))}/${unitLabel(p.baseUnit)}` : "Chưa có giá"}</span>
            </button>
          ))}
        </div>
      ))}
      {news.map((n) => (
        <div key={n.product.id} className="row between wrap">
          <div style={{ minWidth: 0 }}><b>{n.product.name}</b><div className="small muted">{money(priceOf(n.product))}/{unitLabel(n.product.baseUnit)} · <span className="money">{money(Math.round(priceOf(n.product) * n.qty))}</span></div></div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div style={{ width: 120 }}><DecInput label={`SL (${unitLabel(n.product.baseUnit)})`} value={n.qty} onChange={(v) => setNews((a) => a.map((x) => (x.product.id === n.product.id ? { ...x, qty: v } : x)))} /></div>
            <Button size="sm" variant="ghost" onClick={() => setNews((a) => a.filter((x) => x.product.id !== n.product.id))} aria-label={`Bỏ ${n.product.name}`}>Bỏ</Button>
          </div>
        </div>
      ))}

      <div className="ex-step"><span className="ex-n">3</span><b>Chênh lệch</b></div>
      <div className="totals ex-sum">
        <div><span className="muted">Hàng trả lại</span><span className="money">-{money(returnTotal)}</span></div>
        <div><span className="muted">Hàng lấy mới</span><span className="money">+{money(newTotal)}</span></div>
        <div className="grand"><span>{net > 0 ? "Khách trả thêm" : net < 0 ? "Hoàn lại khách" : "Không chênh lệch"}</span><span className="money">{money(Math.abs(net))}</span></div>
      </div>
      {net !== 0 && (
        <Select label={net > 0 ? "Khách thanh toán bằng" : "Hoàn tiền bằng"} value={method} onChange={(e) => setMethod(e.target.value)}>
          {["cash", "transfer", "qr", "card"].map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}
        </Select>
      )}
      {net > 0 && method === "cash" && (
        <MoneyInput label="Khách đưa (₫)" value={given} onChange={setGiven} hint={change > 0 ? `Thối lại ${money(change)}` : given && given < net ? `Còn thiếu ${money(net - given)}` : `Cần thu ${money(net)}`} />
      )}
      <div className="hint">Giá hàng mới theo bảng giá hiện hành, máy chủ tính lại khi xác nhận. Tiền chênh lệch đi qua két của ca đang mở.</div>
      {approval && <Banner tone="info">Đổi hàng này cần quản lý duyệt ({approval.reasons.map((r) => REASON_VI[r] ?? r).join(", ")}). Đã gửi yêu cầu duyệt #{approval.id}; khi quản lý duyệt xong, bấm “Xác nhận đổi hàng” lại.</Banner>}
      <div className="row"><Button variant="ghost" onClick={onCancel}>Quay lại</Button><Button className="grow" loading={busy} disabled={!ready} onClick={submit}>Xác nhận đổi hàng</Button></div>
    </div>
  );
}
