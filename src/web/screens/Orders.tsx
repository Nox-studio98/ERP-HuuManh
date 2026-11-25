import { useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Select, Spinner, TextArea, useAsync } from "../components/ui";
import { DateRangeFilter, DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, rangeOf, usePagedList, type DateRange } from "../components/list";
import { Receipt, lineName } from "../components/Receipt";
import { toast } from "../components/toast";
import { CHANNELS, METHODS, ORDER_STATUS, fmtDateTime, fmtTime, money, qtyText, todayVN, unitLabel, withShown } from "../format";
import { navigate, setQuery } from "../router";
import { useUnitMap } from "../units";
import { useCan } from "../store";
import { ExchangeForm } from "./Exchange";

const tone = (s: string) => (s === "completed" ? "ok" : s === "cancelled" || s === "returned" ? "danger" : "info") as any;
const STATUS_OPTS = [...Object.entries(ORDER_STATUS).filter(([k]) => k !== "draft").map(([v, label]) => ({ v, label })), { v: "returns", label: "Phiếu trả hàng" }];
const sp = () => new URLSearchParams(location.search);

export default function Orders() {
  const can = useCan();
  const [range, setRange] = useState<DateRange>(() => { const q = sp(); return q.get("q") || q.get("open") ? rangeOf("month") : rangeOf("today"); });
  const [channel, setChannel] = useState(""), [status, setStatus] = useState(""), [cashier, setCashier] = useState(""), [method, setMethod] = useState("");
  const [q, setQ] = useState(() => sp().get("q") ?? "");
  const [sel, setSel] = useState<number | null>(() => Number(sp().get("open")) || null);
  const cashiers = useAsync(() => get("/orders/cashiers").then((r) => items<{ id: number; name: string }>(r)), []);
  const query = { from: range.from, to: range.to, channel, cashierId: cashier, method, q, ...(status === "returns" ? { kind: "return" } : { status }), limit: 50 };
  const list = usePagedList<any>("/orders", query, [range.from, range.to, channel, status, cashier, method, q]);
  const sum = list.extra?.summary;
  const dirty = !!(channel || status || cashier || method || q);
  const reset = () => { setChannel(""); setStatus(""); setCashier(""); setMethod(""); setQ(""); setQuery({ q: undefined }); };
  const open = (id: number | null) => { setSel(id); setQuery({ open: id ? String(id) : undefined }); };
  const rangeLabel = range.from === range.to ? fmtDay(range.from) : `${fmtDay(range.from)} – ${fmtDay(range.to)}`;
  const signed = (o: any) => (o.kind === "return" ? -o.total : o.total);
  const empty = (
    <EmptyState
      title={dirty ? "Không có đơn nào khớp bộ lọc" : range.preset === "today" ? "Hôm nay chưa có đơn hàng nào" : "Không có đơn nào trong khoảng này"}
      hint={dirty ? "Thử bỏ bớt bộ lọc hoặc đổi khoảng thời gian." : "Đơn bán tại quầy, online và đơn sỉ sẽ hiện ở đây."}
      action={
        <div className="row wrap" style={{ justifyContent: "center" }}>
          {dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}
          {can("pos.sell") && <Button onClick={() => navigate("/pos")}>Bán hàng</Button>}
          {!(range.preset === "yesterday") && <Button variant="ghost" onClick={() => setRange(rangeOf("yesterday"))}>Xem hôm qua</Button>}
        </div>
      }
    />
  );
  return (
    <div className="stack">
      <PageHeader subtitle={<>{rangeLabel}{sum ? <> · {sum.rowsTotal} phiếu</> : null}</>}
        actions={<ExportButton filename={`don-hang-${range.from}_${range.to}`} rows={list.rows} columns={[
          { label: "Mã đơn", value: (o) => o.code }, { label: "Thời gian", value: (o) => fmtDateTime(o.createdAt) }, { label: "Kênh", value: (o) => CHANNELS[o.channel] ?? o.channel },
          { label: "Loại", value: (o) => (o.kind === "return" ? "Trả hàng" : "Bán") }, { label: "Trạng thái", value: (o) => ORDER_STATUS[o.status] ?? o.status },
          { label: "Khách hàng", value: (o) => o.customerName }, { label: "SĐT", value: (o) => o.customerPhone }, { label: "Thu ngân", value: (o) => o.cashierName },
          { label: "Thanh toán", value: (o) => (o.methods ?? []).map((m: string) => METHODS[m] ?? m).join(" + ") }, { label: "Giảm giá", value: (o) => o.discount }, { label: "Tổng", value: signed },
        ]} />} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[channel, status, cashier, method].filter(Boolean).length} advanced={<>
        <FilterSelect label="Kênh" value={channel} onChange={setChannel} options={Object.entries(CHANNELS).map(([v, label]) => ({ v, label }))} />
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={STATUS_OPTS} />
        <FilterSelect label="Thu ngân" value={cashier} onChange={setCashier} options={(cashiers.data ?? []).map((u) => ({ v: String(u.id), label: u.name }))} />
        <FilterSelect label="Thanh toán" value={method} onChange={setMethod} options={Object.entries(METHODS).map(([v, label]) => ({ v, label }))} />
      </>}>
        <DateRangeFilter value={range} onChange={setRange} />
        <SearchInput value={q} onSearch={(v) => { setQ(v); setQuery({ q: v || undefined }); }} placeholder="Mã đơn, SĐT, tên khách…" label="Tìm đơn hàng" />
      </FilterBar>
      <KpiRow items={[
        { label: "Số đơn", value: sum ? sum.orderCount : "—", sub: sum ? `${sum.saleCount} đã hoàn tất` : undefined },
        { label: "Doanh thu", value: sum ? money(sum.revenue) : "—", sub: sum && sum.returnTotal ? `đã trừ trả ${money(sum.returnTotal)}` : "đơn hoàn tất", tone: "ok" },
        { label: "Trả / huỷ", value: sum ? sum.returnCount + sum.cancelledCount : "—", sub: sum ? `${sum.returnCount} trả · ${sum.cancelledCount} huỷ` : undefined, tone: sum && sum.returnCount + sum.cancelledCount > 0 ? "warn" : undefined },
        { label: "Giá trị TB / đơn", value: sum ? money(sum.avgOrder) : "—" },
      ]} />
      <SplitLayout open={sel != null} panel={sel != null ? <OrderDetail id={sel} onClose={() => open(null)} onChanged={list.reload} /> : null}>
        {list.error ? <Banner tone="danger">Không tải được danh sách đơn. <Button size="sm" variant="ghost" onClick={list.reload}>Tải lại</Button></Banner>
          : list.loading ? <Spinner /> : (
            <DataTable rows={list.rows} rowKey={(o) => o.id} onRowClick={(o) => open(o.id)} selectedKey={sel} emptyState={empty}
              hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
              footer={`Đang hiển thị ${list.rows.length}${sum ? ` / ${sum.rowsTotal}` : ""} phiếu`}
              cols={[
                { key: "code", label: "Mã đơn", title: true, sort: (o) => o.code, render: (o) => <b className="nw">{o.code}</b> },
                { key: "t", label: "Thời gian", sort: (o) => o.createdAt, render: (o) => (range.from === range.to ? fmtTime(o.createdAt) : `${fmtDayShort(o.createdAt)} ${fmtTime(o.createdAt)}`) },
                { key: "ch", label: "Kênh", sort: (o) => CHANNELS[o.channel] ?? o.channel, render: (o) => CHANNELS[o.channel] ?? o.channel },
                { key: "cu", label: "Khách", sort: (o) => o.customerName ?? "", render: (o) => o.customerName ? <span>{o.customerName}{o.customerPhone && <div className="small muted">{o.customerPhone}</div>}</span> : <span className="muted">Khách lẻ</span> },
                { key: "ca", label: "Thu ngân", hideBelow: 1280, sort: (o) => o.cashierName ?? "", render: (o) => o.cashierName ?? "—" },
                { key: "pm", label: "Thanh toán", hideBelow: 1440, render: (o) => (o.methods?.length ? o.methods.map((m: string) => METHODS[m] ?? m).join(" + ") : "—") },
                { key: "st", label: "Trạng thái", sort: (o) => o.status, render: (o) => <Badge tone={tone(o.status)}>{o.kind === "return" ? "Trả hàng" : ORDER_STATUS[o.status] ?? o.status}</Badge> },
                { key: "tt", label: "Tổng", num: true, sort: signed, render: (o) => <span className="money">{o.kind === "return" ? "-" : ""}{money(o.total)}</span> },
              ]} />
          )}
      </SplitLayout>
    </div>
  );
}
const fmtDay = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const fmtDayShort = (iso: string) => new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" }).format(new Date(iso));

function OrderDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const o = useAsync(() => get(`/orders/${id}`), [id]);
  const pmap = useUnitMap();
  const [mode, setMode] = useState<"view" | "return" | "exchange" | "void" | "receipt">("view");
  const d = o.data && pmap ? withShown(o.data, pmap) : o.data;
  return (
    <DetailPanel onClose={onClose} title={d ? `Đơn ${d.code}` : "Đơn hàng"}>
      {o.loading || !d || !pmap ? <Spinner /> : mode === "receipt" ? (
        <div className="stack"><Receipt order={d} /><Button variant="ghost" onClick={() => setMode("view")}>← Quay lại</Button></div>
      ) : mode === "return" ? (
        <ReturnForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); o.reload(); setMode("view"); }} />
      ) : mode === "exchange" ? (
        <ExchangeForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); o.reload(); setMode("view"); }} />
      ) : mode === "void" ? (
        <VoidForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); onClose(); }} />
      ) : (
        <div className="stack">
          <div className="row wrap"><Badge tone={tone(d.status)}>{ORDER_STATUS[d.status] ?? d.status}</Badge><span className="muted small">{CHANNELS[d.channel] ?? d.channel} · {fmtTime(d.createdAt)}</span></div>
          {d.voidReason && <Banner tone="danger">Đã huỷ: {d.voidReason}</Banner>}
          {d.exchange && <Banner tone="info">{d.exchange.role === "new_sale" ? "Đơn đổi hàng từ đơn" : "Phiếu trả của lần đổi hàng, đơn mới:"} <b>{d.exchange.linkedCode}</b></Banner>}
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
            {can("pos.return") && can("pos.sell") && d.kind !== "return" && d.status === "completed" && d.channel === "pos" && <Button variant="ghost" onClick={() => setMode("exchange")}>Đổi hàng</Button>}
            {can("pos.void") && d.kind !== "return" && d.status !== "cancelled" && <Button variant="danger" onClick={() => setMode("void")}>Huỷ đơn</Button>}
          </div>
        </div>
      )}
    </DetailPanel>
  );
}

const REASON_VI: Record<string, string> = { other_shift: "đơn không thuộc ca đang mở", high_value: "giá trị lớn", no_restock: "không nhập lại kho" };

function ReturnForm({ order, onCancel, onDone }: { order: any; onCancel: () => void; onDone: () => void }) {
  const [q, setQ] = useState<Record<number, number>>({});
  const [restock, setRestock] = useState(true), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [method, setMethod] = useState((order.payments?.[0]?.method as string) ?? "cash");
  const [approval, setApproval] = useState<{ id: number; reasons: string[] } | null>(null);
  const chosen = (order.lines ?? []).filter((l: any) => (q[l.id] ?? 0) > 0);
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/orders/${order.id}/return`, { lines: chosen.map((l: any) => ({ orderLineId: l.id, qty: q[l.id], unit: l.unit, restock, reason })), refundMethod: method, ...(approval ? { approvalId: approval.id } : {}) });
      toast("Đã tạo phiếu trả hàng", "ok"); onDone();
    } catch (e) {
      // A-16: thu ngân trả đơn ca khác / giá trị lớn / không nhập lại kho cần quản lý duyệt, rồi bấm xác nhận lại
      if (e instanceof ApiError && e.code === "approval_required") setApproval({ id: e.details?.approvalId, reasons: e.details?.reasons ?? [] });
      else if (e instanceof ApiError && e.code === "approval_invalid") setApproval(null);
    } finally { setBusy(false); }
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
      {approval && <Banner tone="info">Trả hàng này cần quản lý duyệt ({approval.reasons.map((r) => REASON_VI[r] ?? r).join(", ")}). Đã gửi yêu cầu duyệt #{approval.id}; khi quản lý duyệt xong, bấm “Xác nhận trả hàng” lại.</Banner>}
      <TextArea label="Lý do trả hàng" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row"><Button variant="ghost" onClick={onCancel}>Quay lại</Button><Button className="grow" loading={busy} disabled={!chosen.length || !reason.trim()} onClick={submit}>Xác nhận trả hàng</Button></div>
    </div>
  );
}

function VoidForm({ order, onCancel, onDone }: { order: any; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <Banner>Huỷ đơn sẽ hoàn kho đúng lô và ghi nhật ký. Chỉ huỷ được đơn trong ca đang mở (đơn ca đã chốt chỉ quản lý huỷ, và tiền mặt hoàn trả khách được tính vào két của CA ĐANG MỞ của người huỷ). Đơn đặt trước đã giao không huỷ được — hãy dùng “Trả hàng”.</Banner>
      <TextArea label="Lý do huỷ đơn" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row"><Button variant="ghost" onClick={onCancel}>Quay lại</Button><Button variant="danger" className="grow" loading={busy} disabled={!reason.trim()} onClick={async () => { setBusy(true); try { await post(`/orders/${order.id}/void`, { reason }); toast("Đã huỷ đơn", "ok"); onDone(); } catch {} finally { setBusy(false); } }}>Huỷ đơn {order.code}</Button></div>
    </div>
  );
}
export { EmptyState };
