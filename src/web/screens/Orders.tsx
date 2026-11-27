import { useState } from "react";
import { ApiError, api, get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Select, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { DateRangeFilter, DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, rangeOf, usePagedList, type DateRange } from "../components/list";
import { Receipt, lineName, receiptText } from "../components/Receipt";
import { toast } from "../components/toast";
import { CHANNELS, METHODS, ORDER_STATUS, fmtDateTime, fmtTime, money, qtyText, todayVN, unitLabel, withShown } from "../format";
import { navigate, setQuery } from "../router";
import { useUnitMap } from "../units";
import { useCan } from "../store";
import { ExchangeForm } from "./Exchange";
import { CorrectionForm } from "./OrderCorrection";

const tone = (s: string) => (s === "completed" ? "ok" : s === "cancelled" || s === "returned" ? "danger" : "info") as any;
const STATUS_OPTS = [...Object.entries(ORDER_STATUS).filter(([k]) => k !== "draft").map(([v, label]) => ({ v, label })), { v: "returns", label: "Phiếu trả hàng" }];
const sp = () => new URLSearchParams(location.search);

export default function Orders() {
  const can = useCan();
  const [range, setRange] = useState<DateRange>(() => { const q = sp(); return q.get("q") || q.get("open") ? rangeOf("month") : rangeOf("today"); });
  const [channel, setChannel] = useState(""), [status, setStatus] = useState(""), [cashier, setCashier] = useState(""), [method, setMethod] = useState(""), [seller, setSeller] = useState("");
  const [picking, setPicking] = useState(false), [picked, setPicked] = useState<Set<number>>(new Set()), [bulkOpen, setBulkOpen] = useState(false);
  const [q, setQ] = useState(() => sp().get("q") ?? "");
  const [sel, setSel] = useState<number | null>(() => Number(sp().get("open")) || null);
  const cashiers = useAsync(() => get("/orders/cashiers").then((r) => items<{ id: number; name: string }>(r)), []);
  const sellers = useSellers();
  const query = { from: range.from, to: range.to, channel, cashierId: cashier, sellerId: seller, method, q, ...(status === "returns" ? { kind: "return" } : { status }), limit: 50 };
  const list = usePagedList<any>("/orders", query, [range.from, range.to, channel, status, cashier, seller, method, q]);
  const sum = list.extra?.summary;
  const dirty = !!(channel || status || cashier || seller || method || q);
  const reset = () => { setChannel(""); setStatus(""); setCashier(""); setSeller(""); setMethod(""); setQ(""); setQuery({ q: undefined }); };
  const canEdit = can("orders.edit");
  const selectable = (o: any) => o.kind === "sale";
  const toggle = (id: number) => setPicked((s0) => { const n = new Set(s0); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const stopPicking = () => { setPicking(false); setPicked(new Set()); };
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
        actions={<>{canEdit && <Button variant={picking ? "soft" : "ghost"} onClick={() => (picking ? stopPicking() : setPicking(true))}>{picking ? "Thoát chọn nhiều" : "Chọn nhiều"}</Button>}<ExportButton filename={`don-hang-${range.from}_${range.to}`} rows={list.rows} columns={[
          { label: "Mã đơn", value: (o) => o.code }, { label: "Thời gian", value: (o) => fmtDateTime(o.createdAt) }, { label: "Kênh", value: (o) => CHANNELS[o.channel] ?? o.channel },
          { label: "Loại", value: (o) => (o.kind === "return" ? "Trả hàng" : "Bán") }, { label: "Trạng thái", value: (o) => ORDER_STATUS[o.status] ?? o.status },
          { label: "Khách hàng", value: (o) => o.customerName }, { label: "SĐT", value: (o) => o.customerPhone }, { label: "Thu ngân", value: (o) => o.cashierName }, { label: "Người bán", value: (o) => o.sellerName },
          { label: "Thanh toán", value: (o) => (o.methods ?? []).map((m: string) => METHODS[m] ?? m).join(" + ") }, { label: "Giảm giá", value: (o) => o.discount }, { label: "Tổng", value: signed },
        ]} /></>} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[channel, status, cashier, seller, method].filter(Boolean).length} advanced={<>
        <FilterSelect label="Kênh" value={channel} onChange={setChannel} options={Object.entries(CHANNELS).map(([v, label]) => ({ v, label }))} />
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={STATUS_OPTS} />
        <FilterSelect label="Thu ngân" value={cashier} onChange={setCashier} options={(cashiers.data ?? []).map((u) => ({ v: String(u.id), label: u.name }))} />
        <FilterSelect label="Người bán" value={seller} onChange={setSeller} options={(sellers ?? []).map((u) => ({ v: String(u.id), label: u.name }))} />
        <FilterSelect label="Thanh toán" value={method} onChange={setMethod} options={Object.entries(METHODS).map(([v, label]) => ({ v, label }))} />
      </>}>
        <DateRangeFilter value={range} onChange={setRange} />
        <SearchInput value={q} onSearch={(v) => { setQ(v); setQuery({ q: v || undefined }); }} placeholder="Mã đơn, SĐT, khách, tên hàng, ghi chú…" label="Tìm đơn hàng" />
      </FilterBar>
      <KpiRow items={[
        { label: "Số đơn", value: sum ? sum.orderCount : "—", sub: sum ? `${sum.saleCount} đã hoàn tất` : undefined },
        { label: "Doanh thu", value: sum ? money(sum.revenue) : "—", sub: sum && sum.returnTotal ? `đã trừ trả ${money(sum.returnTotal)}` : "đơn hoàn tất", tone: "ok" },
        { label: "Trả / huỷ", value: sum ? sum.returnCount + sum.cancelledCount : "—", sub: sum ? `${sum.returnCount} trả · ${sum.cancelledCount} huỷ` : undefined, tone: sum && sum.returnCount + sum.cancelledCount > 0 ? "warn" : undefined },
        { label: "Giá trị TB / đơn", value: sum ? money(sum.avgOrder) : "—" },
      ]} />
      {picking && (
        <div className="card row wrap between" role="region" aria-label="Chọn nhiều đơn" style={{ padding: "10px 14px", gap: 10 }}>
          <span><b>{picked.size}</b> đơn đã chọn <span className="muted small">(chỉ đơn bán)</span></span>
          <div className="row wrap">
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(list.rows.filter(selectable).slice(0, 100).map((o: any) => o.id)))}>Chọn tất cả đang hiển thị</Button>
            <Button size="sm" variant="ghost" disabled={!picked.size} onClick={() => setPicked(new Set())}>Bỏ chọn</Button>
            <Button size="sm" disabled={!picked.size} onClick={() => setBulkOpen(true)}>Sửa người bán / ghi chú</Button>
          </div>
        </div>
      )}
      {bulkOpen && <MetaSheet ids={[...picked]} onClose={() => setBulkOpen(false)} onDone={() => { setBulkOpen(false); stopPicking(); list.reload(); }} />}
      <SplitLayout open={sel != null} panel={sel != null ? <OrderDetail id={sel} onClose={() => open(null)} onChanged={list.reload} onOpen={open} /> : null}>
        {list.error ? <Banner tone="danger">Không tải được danh sách đơn. <Button size="sm" variant="ghost" onClick={list.reload}>Tải lại</Button></Banner>
          : list.loading ? <Spinner /> : (
            <DataTable rows={list.rows} rowKey={(o) => o.id} onRowClick={(o) => (picking ? selectable(o) && toggle(o.id) : open(o.id))} selectedKey={picking ? null : sel} rowClass={(o) => (picking && picked.has(o.id) ? "sel" : "")} emptyState={empty}
              hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
              footer={`Đang hiển thị ${list.rows.length}${sum ? ` / ${sum.rowsTotal}` : ""} phiếu`}
              cols={[
                { key: "code", label: "Mã đơn", title: true, sort: (o) => o.code, render: (o) => (
                  <span className="row nw" style={{ gap: 8 }}>
                    {picking && <input type="checkbox" aria-label={`Chọn đơn ${o.code}`} disabled={!selectable(o)} checked={picked.has(o.id)} onChange={() => toggle(o.id)} onClick={(e) => e.stopPropagation()} style={{ width: 20, height: 20 }} />}
                    <b>{o.code}</b>
                  </span>) },
                { key: "t", label: "Thời gian", sort: (o) => o.createdAt, render: (o) => (range.from === range.to ? fmtTime(o.createdAt) : `${fmtDayShort(o.createdAt)} ${fmtTime(o.createdAt)}`) },
                { key: "ch", label: "Kênh", sort: (o) => CHANNELS[o.channel] ?? o.channel, render: (o) => <span className="nw">{CHANNELS[o.channel] ?? o.channel}</span> },
                { key: "cu", label: "Khách", sort: (o) => o.customerName ?? "", render: (o) => o.customerName ? <span>{o.customerName}{o.customerPhone && <div className="small muted">{o.customerPhone}</div>}</span> : <span className="muted">Khách lẻ</span> },
                { key: "sl", label: "Người bán", hideBelow: 1024, sort: (o) => o.sellerName ?? "", render: (o) => <span className="nw">{o.sellerName ?? "—"}</span> },
                { key: "ca", label: "Thu ngân", hideBelow: 1280, sort: (o) => o.cashierName ?? "", render: (o) => <span className="nw">{o.cashierName ?? "—"}</span> },
                { key: "pm", label: "Thanh toán", hideBelow: 1600, render: (o) => (o.methods?.length ? o.methods.map((m: string) => METHODS[m] ?? m).join(" + ") : "—") },
                { key: "st", label: "Trạng thái", sort: (o) => o.status, render: (o) => <Badge tone={tone(o.status)}>{o.kind === "return" ? "Trả hàng" : ORDER_STATUS[o.status] ?? o.status}</Badge> },
                { key: "tt", label: "Tổng", num: true, sort: signed, render: (o) => <span className="money">{o.kind === "return" ? "-" : ""}{money(o.total)}</span> },
              ]} />
          )}
      </SplitLayout>
    </div>
  );
}
/** Danh sách người bán để lọc: dùng /pos/sellers nếu có quyền bán, không thì danh sách người đã lập đơn. */
function useSellers() {
  const can = useCan();
  const r = useAsync(() => get(can("pos.sell") ? "/pos/sellers" : "/orders/cashiers", undefined, { silent: true }).then((x) => items<{ id: number; name: string }>(x)).catch(() => []), []);
  return r.data;
}

const fmtDay = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const fmtDayShort = (iso: string) => new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" }).format(new Date(iso));

function OrderDetail({ id, onClose, onChanged, onOpen }: { id: number; onClose: () => void; onChanged: () => void; onOpen: (id: number) => void }) {
  const can = useCan();
  const o = useAsync(() => get(`/orders/${id}`), [id]);
  const pmap = useUnitMap();
  const [mode, setMode] = useState<"view" | "return" | "exchange" | "correct" | "void" | "receipt" | "meta">("view");
  const d = o.data && pmap ? withShown(o.data, pmap) : o.data;
  return (
    <DetailPanel onClose={onClose} title={d ? `Đơn ${d.code}` : "Đơn hàng"}>
      {o.loading || !d || !pmap ? <Spinner /> : mode === "receipt" ? (
        <div className="stack"><Receipt order={d} /><Button variant="ghost" onClick={() => setMode("view")}>← Quay lại</Button></div>
      ) : mode === "meta" ? (
        <MetaForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); o.reload(); setMode("view"); }} />
      ) : mode === "return" ? (
        <ReturnForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); o.reload(); setMode("view"); }} />
      ) : mode === "exchange" ? (
        <ExchangeForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); o.reload(); setMode("view"); }} />
      ) : mode === "correct" ? (
        <CorrectionForm order={d} onCancel={() => setMode("view")} onDone={(r: any) => { onChanged(); o.reload(); setMode("view"); if (r?.sale?.id) onOpen(r.sale.id); }} />
      ) : mode === "void" ? (
        <VoidForm order={d} onCancel={() => setMode("view")} onDone={() => { onChanged(); onClose(); }} />
      ) : (
        <div className="stack">
          <div className="row wrap"><Badge tone={tone(d.status)}>{ORDER_STATUS[d.status] ?? d.status}</Badge><span className="muted small">{CHANNELS[d.channel] ?? d.channel} · {fmtTime(d.createdAt)}</span></div>
          {d.voidReason && <Banner tone="danger">Đã huỷ: {d.voidReason}</Banner>}
          {d.correction && <Banner tone="info">{d.correction.role === "replacement" ? "Đơn này thay thế đơn đã sửa" : "Đơn đã được sửa — đơn thay thế"}: <Button size="sm" variant="soft" onClick={() => onOpen(d.correction.linkedId)}>{d.correction.linkedCode}</Button></Banner>}
          {d.kind === "return" && !d.originalOrderId && <Banner tone="info">Trả hàng nhanh (không có hoá đơn gốc).{d.note ? <> {d.note}</> : null}</Banner>}
          {d.exchange && <Banner tone="info">{d.exchange.role === "new_sale" ? "Đơn đổi hàng từ đơn" : "Phiếu trả của lần đổi hàng, đơn mới:"} <b>{d.exchange.linkedCode}</b></Banner>}
          {d.kind === "sale" && (
            <div className="small stack" style={{ gap: 2 }}>
              <div><span className="muted">Người bán: </span><b>{d.sellerName ?? d.cashierName ?? "—"}</b>{d.sellerId && d.sellerId !== d.createdBy ? <span className="muted"> · thu ngân {d.cashierName}</span> : null}</div>
              {d.note ? <div><span className="muted">Ghi chú: </span>{d.note}</div> : null}
            </div>
          )}
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
            <Button variant="soft" onClick={() => { o.reload(); setMode("receipt"); }}>In lại</Button>{/* tải lại để QR/số còn nợ trên phiếu là số hiện tại */}
            <Button variant="ghost" onClick={() => shareReceipt(d)}>Chia sẻ</Button>
            {can("pos.sell") && d.kind === "sale" && d.channel === "pos" && <Button variant="ghost" onClick={() => copyToPos(d)}>Sao chép</Button>}
            {can("orders.edit") && d.kind === "sale" && <Button variant="ghost" onClick={() => setMode("meta")}>Sửa thông tin</Button>}
            {can("pos.return") && d.kind !== "return" && d.status !== "cancelled" && <Button variant="ghost" onClick={() => setMode("return")}>Trả hàng</Button>}
            {can("pos.return") && can("pos.sell") && d.kind !== "return" && d.status === "completed" && d.channel === "pos" && <Button variant="ghost" onClick={() => setMode("exchange")}>Đổi hàng</Button>}
            {can("orders.edit") && can("pos.sell") && can("pos.return") && d.kind === "sale" && d.status === "completed" && d.channel === "pos" && d.correction?.role !== "replaced" && <Button variant="ghost" data-testid="order-correct-btn" onClick={() => setMode("correct")}>Sửa hoá đơn</Button>}
            {can("pos.void") && d.kind !== "return" && d.status !== "cancelled" && <Button variant="danger" onClick={() => setMode("void")}>Huỷ đơn</Button>}
          </div>
        </div>
      )}
    </DetailPanel>
  );
}

/** A5: đưa hàng của đơn sang một tab mới ở màn POS (hợp đồng với màn POS: sessionStorage["hm_pos_copy"]). */
function copyToPos(d: any) {
  // qtyMilli theo ĐƠN VỊ CHÍNH (như order_lines.qty_milli); màn POS tự quy ra số lượng theo `unit` của dòng
  const lines = (d.lines ?? []).map((l: any) => ({ productId: l.productId, unit: l.unit, qtyMilli: l.qtyMilli }));
  try {
    sessionStorage.setItem("hm_pos_copy", JSON.stringify({ ...(d.customer ? { customerId: d.customer.id, customerName: d.customer.name } : {}), lines }));
  } catch { toast("Trình duyệt không cho lưu tạm, không sao chép được đơn", "error"); return; }
  navigate("/pos?copy=1");
}

/** A6: gửi hoá đơn qua Web Share (Zalo…); không hỗ trợ thì sao chép văn bản. */
async function shareReceipt(d: any) {
  const text = receiptText(d);
  try {
    if (navigator.share) await navigator.share({ title: `Hoá đơn ${d.code}`, text });
    else { await navigator.clipboard.writeText(text); toast("Đã sao chép nội dung hoá đơn", "ok"); }
  } catch (e) { if ((e as Error)?.name !== "AbortError") toast("Không chia sẻ được hoá đơn", "error"); }
}

type Seller = { id: number; name: string };
function useSellerList() {
  const r = useAsync(() => get("/pos/sellers").then((x) => items<Seller>(x)), []);
  return r.data;
}

function MetaForm({ order, onCancel, onDone }: { order: any; onCancel: () => void; onDone: () => void }) {
  const sellers = useSellerList();
  const [seller, setSeller] = useState(String(order.sellerId ?? order.createdBy ?? "")), [note, setNote] = useState(order.note ?? ""), [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/orders/${order.id}/meta`, { method: "PATCH", body: { sellerId: Number(seller), note: note.trim() || null, version: order.metaVersion } });
      toast("Đã cập nhật thông tin đơn", "ok"); onDone();
    } catch { /* api đã báo lỗi */ } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="muted small">Chỉ sửa người bán và ghi chú. Tiền và hàng của đơn không đổi.</div>
      {!sellers ? <Spinner /> : (
        <Select label="Người bán" value={seller} onChange={(e) => setSeller(e.target.value)}>
          {sellers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === order.createdBy ? " (thu ngân)" : ""}</option>)}
        </Select>
      )}
      <TextArea label="Ghi chú" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <div className="row"><Button variant="ghost" onClick={onCancel}>Quay lại</Button><Button className="grow" loading={busy} disabled={!sellers} onClick={submit}>Lưu thông tin</Button></div>
    </div>
  );
}

function MetaSheet({ ids, onClose, onDone }: { ids: number[]; onClose: () => void; onDone: () => void }) {
  const sellers = useSellerList();
  const [seller, setSeller] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const nothing = !seller && !note.trim();
  const submit = async () => {
    setBusy(true);
    try {
      await post("/orders/meta/bulk", { ids, ...(seller ? { sellerId: Number(seller) } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      toast(`Đã cập nhật ${ids.length} đơn`, "ok"); onDone();
    } catch { /* api đã báo lỗi */ } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={`Sửa ${ids.length} đơn đã chọn`} footer={<Button block size="lg" loading={busy} disabled={nothing} onClick={submit}>Áp dụng cho {ids.length} đơn</Button>}>
      <div className="stack">
        <Banner tone="info">Chỉ đổi người bán và ghi chú, không đổi tiền hay hàng. Việc này được ghi vào nhật ký. Đơn thuộc kỳ đã khoá sổ sẽ không sửa được.</Banner>
        {!sellers ? <Spinner /> : (
          <Select label="Người bán" value={seller} onChange={(e) => setSeller(e.target.value)}>
            <option value="">— Không đổi —</option>
            {sellers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        )}
        <TextArea label="Ghi chú (thay ghi chú cũ)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <div className="hint">Để trống ô ghi chú nếu không muốn đổi ghi chú.</div>
      </div>
    </Sheet>
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
