import { useState } from "react";
import { get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, Select, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { Receipt, lineName } from "../components/Receipt";
import { toast } from "../components/toast";
import { CHANNELS, METHODS, ORDER_STATUS, fmtTime, money, qtyText, todayVN, unitLabel, withShown } from "../format";
import { useUnitMap } from "../units";
import { useCan } from "../store";

const tone = (s: string) => (s === "completed" ? "ok" : s === "cancelled" || s === "returned" ? "danger" : "info") as any;

export default function Orders() {
  const [day, setDay] = useState(todayVN());
  const [sel, setSel] = useState<number | null>(null);
  const list = useAsync(() => get("/orders", { day, limit: 100 }).then((r) => items<any>(r)), [day]);
  const total = (list.data ?? []).filter((o) => o.status !== "cancelled").reduce((s, o) => s + (o.kind === "return" ? -o.total : o.total), 0);
  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ maxWidth: 200 }}><Input label="Ngày" type="date" value={day} onChange={(e) => setDay(e.target.value)} max={todayVN()} /></div>
        <div className="muted">{list.data?.length ?? 0} đơn · <b className="money">{money(total)}</b></div>
      </div>
      {list.loading ? <Spinner /> : (
        <DataTable rows={list.data ?? []} rowKey={(o) => o.id} onRowClick={(o) => setSel(o.id)} empty="Không có đơn nào trong ngày"
          cols={[
            { key: "code", label: "Mã đơn", title: true, render: (o) => <b>{o.code}</b> },
            { key: "t", label: "Giờ", render: (o) => fmtTime(o.createdAt) },
            { key: "ch", label: "Kênh", render: (o) => CHANNELS[o.channel] ?? o.channel },
            { key: "st", label: "Trạng thái", render: (o) => <Badge tone={tone(o.status)}>{o.kind === "return" ? "Trả hàng" : ORDER_STATUS[o.status] ?? o.status}</Badge> },
            { key: "tt", label: "Tổng", right: true, render: (o) => <span className="money">{money(o.total)}</span> },
          ]} />
      )}
      {sel != null && <OrderDetail id={sel} onClose={() => setSel(null)} onChanged={list.reload} />}
    </div>
  );
}

function OrderDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const o = useAsync(() => get(`/orders/${id}`), [id]);
  const pmap = useUnitMap();
  const [mode, setMode] = useState<"view" | "return" | "void" | "receipt">("view");
  const d = o.data && pmap ? withShown(o.data, pmap) : o.data;
  return (
    <Sheet open onClose={onClose} wide title={d ? `Đơn ${d.code}` : "Đơn hàng"}>
      {o.loading || !d || !pmap ? <Spinner /> : mode === "receipt" ? (
        <div className="stack"><Receipt order={d} /><Button variant="ghost" onClick={() => setMode("view")}>← Quay lại</Button></div>
      ) : mode === "return" ? (
        <ReturnForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); o.reload(); setMode("view"); }} />
      ) : mode === "void" ? (
        <VoidForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); onClose(); }} />
      ) : (
        <div className="stack">
          <div className="row wrap"><Badge tone={tone(d.status)}>{ORDER_STATUS[d.status] ?? d.status}</Badge><span className="muted small">{CHANNELS[d.channel] ?? d.channel} · {fmtTime(d.createdAt)}</span></div>
          {d.voidReason && <Banner tone="danger">Đã huỷ: {d.voidReason}</Banner>}
          <DataTable rows={d.lines ?? []} rowKey={(l: any) => l.id} cols={[
            { key: "n", label: "Hàng", title: true, render: (l: any) => lineName(l) },
            { key: "q", label: "SL", right: true, render: (l: any) => qtyText(l.qtyShown, l.unit) },
            { key: "p", label: "Đơn giá", right: true, render: (l: any) => money(l.priceShown) },
            { key: "t", label: "Thành tiền", right: true, render: (l: any) => money(l.lineTotal) },
          ]} />
          <div className="totals">
            {d.discount ? <div><span className="muted">Giảm giá</span><span className="money">-{money(d.discount)}</span></div> : null}
            <div className="grand"><span>Tổng</span><span className="money">{money(d.total)}</span></div>
            {(d.payments ?? []).map((p: any, i: number) => <div key={i}><span className="muted">{METHODS[p.method] ?? p.method}</span><span className="money">{money(p.amount)}</span></div>)}
          </div>
          <div className="row wrap">
            <Button variant="soft" onClick={() => setMode("receipt")}>Xem / in hoá đơn</Button>
            {can("pos.return") && d.kind !== "return" && d.status !== "cancelled" && <Button variant="ghost" onClick={() => setMode("return")}>Trả hàng</Button>}
            {can("pos.void") && d.kind !== "return" && d.status !== "cancelled" && <Button variant="danger" onClick={() => setMode("void")}>Huỷ đơn</Button>}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function ReturnForm({ order, onCancel, onDone }: { order: any; onCancel: () => void; onDone: () => void }) {
  const [q, setQ] = useState<Record<number, number>>({});
  const [restock, setRestock] = useState(true), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [method, setMethod] = useState((order.payments?.[0]?.method as string) ?? "cash");
  const chosen = (order.lines ?? []).filter((l: any) => (q[l.id] ?? 0) > 0);
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/orders/${order.id}/return`, { lines: chosen.map((l: any) => ({ orderLineId: l.id, qty: q[l.id], unit: l.unit, restock, reason })), refundMethod: method });
      toast("Đã tạo phiếu trả hàng", "ok"); onDone();
    } catch {} finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="muted">Nhập số lượng khách trả cho từng dòng.</div>
      {(order.lines ?? []).map((l: any) => (
        <div key={l.id} className="row between wrap">
          <div style={{ minWidth: 0 }}><b>{lineName(l)}</b><div className="small muted">Đã mua {qtyText(l.qtyShown, l.unit)}</div></div>
          <div style={{ width: 140 }}><DecInput label={`Trả (${unitLabel(l.unit)})`} value={q[l.id] ?? ""} onChange={(n) => setQ({ ...q, [l.id]: Math.min(n, l.qtyShown / 1000) })} /></div>
        </div>
      ))}
      <label className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} style={{ width: 22, height: 22 }} /> <span>Nhập lại kho (hàng còn bán được)</span></label>
      {!restock && <div className="hint">Không nhập lại kho: ghi nhận hao hụt.</div>}
      <Select label="Hoàn tiền bằng" value={method} onChange={(e) => setMethod(e.target.value)}>{["cash", "transfer", "qr", "card"].map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}</Select>
      <TextArea label="Lý do trả hàng" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row"><Button variant="ghost" onClick={onCancel}>Quay lại</Button><Button className="grow" loading={busy} disabled={!chosen.length || !reason.trim()} onClick={submit}>Xác nhận trả hàng</Button></div>
    </div>
  );
}

function VoidForm({ order, onCancel, onDone }: { order: any; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <Banner>Huỷ đơn sẽ hoàn kho đúng lô và ghi nhật ký. Chỉ huỷ được đơn trong ca đang mở (đơn ca đã chốt cần quản lý).</Banner>
      <TextArea label="Lý do huỷ đơn" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row"><Button variant="ghost" onClick={onCancel}>Quay lại</Button><Button variant="danger" className="grow" loading={busy} disabled={!reason.trim()} onClick={async () => { setBusy(true); try { await post(`/orders/${order.id}/void`, { reason }); toast("Đã huỷ đơn", "ok"); onDone(); } catch {} finally { setBusy(false); } }}>Huỷ đơn {order.code}</Button></div>
    </div>
  );
}
export { EmptyState };
