import { useState } from "react";
import { ApiError, get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { ORDER_STATUS, money, todayVN, unitLabel, uuid } from "../../format";
import { navigate, usePath } from "../../router";
import Recurring from "./Recurring";
import { DateRangeFilter, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, rangeOf, usePagedList, type DateRange } from "../../components/list";
import { useCan } from "../../store";
import {
  Back, CreditBlocked, CustomerSelect, DELIVERY_STATUS, waitLabel, EINVOICE, INVOICE_KIND, LinesEditor, Lnk, QUOTE_STATUS, ReasonSheet, deliveryTone, einvTone, linePayload, orderTone, qparam, q3, qtyU, ymd,
  type CustomerLite, type EditLine,
} from "./kit";

export default function B2bOrders() {
  const path = usePath();
  const m = path.match(/^\/b2b-orders\/(\d+)/);
  return m ? <OrderDetail id={Number(m[1])} /> : <OrderList />;
}

const OSTATUS = ["new", "confirmed", "preparing", "shipping", "completed", "delivery_failed", "cancelled"];
function OrderList() {
  const can = useCan();
  const [range, setRange] = useState<DateRange>(() => rangeOf("month"));
  const [status, setStatus] = useState(""), [day, setDay] = useState(""), [cust, setCust] = useState(""), [q, setQ] = useState("");
  const pre = qparam("new");
  const [creating, setCreating] = useState(!!pre);
  const [tab, setTab] = useState<"orders" | "recurring">("orders");
  const custs = useAsync(() => get("/customers", { type: "b2b", limit: 200 }, { silent: true }).then((r) => items<any>(r)).catch(() => [] as any[]), []);
  const list = usePagedList<any>("/b2b/orders", { status, deliveryDate: day, customerId: cust, q, from: range.from, to: range.to, limit: 50 }, [status, day, cust, q, range.from, range.to]);
  const sum = list.extra?.summary;
  const by = (k: string) => sum?.byStatus?.[k]?.count ?? 0;
  const dirty = !!(status || day || cust || q);
  const reset = () => { setStatus(""); setDay(""); setCust(""); setQ(""); };
  const tabs = can("b2b.write") ? <Segmented className="tabs-d" value={tab} onChange={setTab} options={[{ v: "orders", label: "Đơn sỉ" }, { v: "recurring", label: "Đơn lặp" }]} /> : null;
  if (tab === "recurring") return <Recurring tabs={tabs ?? <Segmented className="tabs-d" value={tab} onChange={setTab} options={[{ v: "orders", label: "Đơn sỉ" }, { v: "recurring", label: "Đơn lặp" }]} />} />;
  const rangeLabel = range.from === range.to ? ymd(range.from) : `${ymd(range.from)} – ${ymd(range.to)}`;
  return (
    <div className="stack">
      <PageHeader compact subtitle={<>Tạo từ {rangeLabel}{sum ? <> · {sum.count} đơn</> : null}</>}
        actions={<>
          <ExportButton filename={`don-si-${range.from}_${range.to}`} rows={list.rows} columns={[
            { label: "Mã đơn", value: (o) => o.code }, { label: "Khách hàng", value: (o) => o.customerName }, { label: "Trạng thái", value: (o) => ORDER_STATUS[o.status] ?? o.status },
            { label: "Ngày tạo", value: (o) => ymd(o.createdAt) }, { label: "Ngày giao", value: (o) => ymd(o.deliveryDate) }, { label: "Địa chỉ", value: (o) => o.addressLabel }, { label: "Tổng", value: (o) => o.total },
          ]} />
          {can("b2b.write") && <Button onClick={() => setCreating(true)}>+ Tạo đơn sỉ</Button>}
        </>} />
      {tabs}
      <FilterBar dirty={dirty} onReset={reset} activeCount={[status, cust, day].filter(Boolean).length} advanced={<>
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={OSTATUS.map((v) => ({ v, label: ORDER_STATUS[v] ?? v }))} />
        <FilterSelect label="Khách hàng" value={cust} onChange={setCust} options={(custs.data ?? []).map((c: any) => ({ v: String(c.id), label: c.name }))} />
        <label className="field"><span className="lbl">Ngày giao</span><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ minHeight: 40 }} /></label>
      </>}>
        <DateRangeFilter value={range} onChange={setRange} presets={["today", "7d", "month", "lastMonth", "custom"]} />
        <SearchInput value={q} onSearch={setQ} placeholder="Mã đơn, khách…" label="Tìm đơn sỉ" />
      </FilterBar>
      <KpiRow items={[
        { label: "Số đơn", value: sum ? sum.count : "—", sub: sum ? `${by("cancelled")} đã huỷ` : undefined },
        { label: "Giá trị đơn", value: sum ? money(sum.total) : "—", sub: "không tính đơn huỷ", tone: "ok" },
        { label: "Đang xử lý", value: sum ? by("new") + by("confirmed") + by("preparing") + by("shipping") : "—", sub: sum ? `${by("new")} mới · ${by("shipping")} đang giao` : undefined, tone: "info" },
        { label: "Đã giao xong", value: sum ? by("completed") : "—", sub: sum && by("delivery_failed") ? `${by("delivery_failed")} giao thất bại` : undefined },
      ]} />
      {list.loading ? <Spinner /> : (
        <DataTable rows={list.rows} rowKey={(o) => o.id} onRowClick={(o) => navigate(`/b2b-orders/${o.id}`)} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
          footer={`Đang hiển thị ${list.rows.length}${sum ? ` / ${sum.count}` : ""} đơn`}
          emptyState={<EmptyState title={dirty ? "Không có đơn sỉ nào khớp bộ lọc" : "Chưa có đơn sỉ trong khoảng này"} hint="Đơn sỉ tạo trực tiếp, từ báo giá hoặc từ mẫu đơn lặp sẽ hiện ở đây."
            action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{can("b2b.write") && <Button onClick={() => setCreating(true)}>+ Tạo đơn sỉ</Button>}{range.preset !== "lastMonth" && <Button variant="ghost" onClick={() => setRange(rangeOf("lastMonth"))}>Xem tháng trước</Button>}</div>} />}
          cols={[
            { key: "c", label: "Mã đơn", title: true, sort: (o) => o.code, render: (o) => <b className="nw">{o.code}</b> },
            { key: "k", label: "Khách hàng", sort: (o) => o.customerName, render: (o) => o.customerName },
            { key: "s", label: "Trạng thái", sort: (o) => o.status, render: (o) => <span className="row wrap st-badges" style={{ gap: 4 }}><Badge tone={orderTone(o.status)}>{ORDER_STATUS[o.status] ?? o.status}</Badge>{o.awaitingStock && <Badge tone="warn">{waitLabel(o.shortLines)}</Badge>}</span> },
            { key: "cr", label: "Ngày tạo", hideBelow: 1280, sort: (o) => o.createdAt, render: (o) => ymd(o.createdAt) },
            { key: "d", label: "Ngày giao", sort: (o) => o.deliveryDate, render: (o) => ymd(o.deliveryDate) },
            { key: "a", label: "Địa chỉ", hideMobile: true, hideBelow: 1024, render: (o) => o.addressLabel ?? "—" },
            { key: "t", label: "Tổng", num: true, sort: (o) => o.total, render: (o) => <span className="money">{money(o.total)}</span> },
          ]} />
      )}
      {creating && <OrderForm presetCustomerId={pre ? Number(pre) : undefined} onClose={() => { setCreating(false); if (pre) history.replaceState({}, "", "/b2b-orders"); }} onCreated={(id) => { setCreating(false); if (pre) history.replaceState({}, "", "/b2b-orders"); navigate(`/b2b-orders/${id}`); }} />}
    </div>
  );
}

function OrderForm({ presetCustomerId, onClose, onCreated }: { presetCustomerId?: number; onClose: () => void; onCreated: (id: number) => void }) {
  const can = useCan();
  const [cust, setCust] = useState<any>(null);
  const [mode, setMode] = useState<"lines" | "quote">("lines");
  const [lines, setLines] = useState<EditLine[]>([]);
  const [addr, setAddr] = useState(""), [date, setDate] = useState(todayVN(1)), [note, setNote] = useState("");
  const [quoteId, setQuoteId] = useState(""), [qtys, setQtys] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [uid] = useState(() => uuid());
  const [res, setRes] = useState<{ kind: "blocked" | "stock"; details?: any; orderId?: number } | null>(null);
  useAsync(async () => { if (presetCustomerId) { try { setCust(await get(`/customers/${presetCustomerId}`, undefined, { silent: true })); } catch {} } return 1; }, [presetCustomerId]);
  const pickCustomer = async (c: CustomerLite | null) => {
    if (!c) { setCust(null); return; }
    try { setCust(await get(`/customers/${c.id}`)); } catch { setCust(null); }
    setLines([]); setQuoteId(""); setAddr("");
  };
  const addrs = (cust?.addresses ?? []).filter((a: any) => a.active);
  const addrId = addr || String(addrs.find((a: any) => a.isDefault)?.id ?? addrs[0]?.id ?? "");
  const quotes = useAsync(async () => {
    if (!cust) return [];
    const [a, b] = await Promise.all([get("/quotes", { customerId: cust.id, status: "sent" }, { silent: true }), get("/quotes", { customerId: cust.id, status: "draft" }, { silent: true })]);
    return [...items<any>(a), ...items<any>(b)];
  }, [cust?.id]);
  const quote = useAsync(() => (quoteId ? get(`/quotes/${quoteId}`) : Promise.resolve(null)), [quoteId]);

  const fail = async (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === "credit_blocked") { setRes({ kind: "blocked", details: e.details, orderId: e.details?.orderId }); return; }
      if (e.code === "insufficient_stock") {
        let id: number | undefined;
        try { id = items<any>(await get("/b2b/orders", { customerId: cust.id, status: "new", limit: 1 }, { silent: true }))[0]?.id; } catch {}
        setRes({ kind: "stock", orderId: id }); return;
      }
      toast(e.message, "error");
    }
  };
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "quote" && quote.data) {
        const r = await post(`/quotes/${quote.data.id}/convert`, { addressId: Number(addrId), deliveryDate: date, note: note || undefined, clientUuid: uid, lines: Object.entries(qtys).filter(([, v]) => v > 0).map(([k, v]) => ({ productId: Number(k), qty: v })) }, { silent: true });
        toast(`Đã tạo đơn ${r.code}`, "ok"); onCreated(r.id);
      } else {
        const r = await post("/b2b/orders", { customerId: cust.id, addressId: Number(addrId), deliveryDate: date, note: note || undefined, lines: linePayload(lines, can("b2b.approve")), clientUuid: uid }, { silent: true });
        toast(`Đã tạo đơn ${r.code}${r.status === "confirmed" ? " và giữ hàng" : ""}`, "ok"); onCreated(r.id);
      }
    } catch (e) { await fail(e); } finally { setBusy(false); }
  };
  const ready = cust && addrId && date && (mode === "lines" ? lines.length > 0 && lines.every((l) => l.qty > 0) : quote.data && quote.data.lines.every((l: any) => l.qty != null || qtys[l.productId] > 0));
  return (
    <Sheet open wide onClose={onClose} title="Tạo đơn sỉ" footer={!res ? <Button block size="lg" loading={busy} disabled={!ready} onClick={submit}>Tạo đơn & giữ hàng</Button> : undefined}>
      {res?.kind === "blocked" ? (
        <CreditBlocked details={res.details} orderLink={res.orderId ? <Button onClick={() => onCreated(res.orderId!)}>Mở đơn đã tạo</Button> : undefined} />
      ) : res?.kind === "stock" ? (
        <div className="stack"><Banner>Đơn đã tạo nhưng <b>không đủ tồn khả dụng</b> để giữ hàng. Nhập thêm hàng rồi bấm "Giữ hàng lại" trên đơn.</Banner>{res.orderId && <Button onClick={() => onCreated(res.orderId!)}>Mở đơn</Button>}</div>
      ) : (
        <div className="stack">
          <CustomerSelect value={cust} onChange={pickCustomer} />
          {cust && (
            <>
              {cust.debt?.overdueAmount > 0 && <Banner>Khách đang có nợ quá hạn {money(cust.debt.overdueAmount)} — đơn mới sẽ phải chờ chủ duyệt.</Banner>}
              <Select label="Địa chỉ giao" value={addrId} onChange={(e) => setAddr(e.target.value)}>{addrs.map((a: any) => <option key={a.id} value={a.id}>{a.label} — {a.address}</option>)}</Select>
              <Input label="Ngày giao" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />
              <Segmented value={mode} onChange={setMode} options={[{ v: "lines", label: "Nhập hàng" }, { v: "quote", label: "Từ báo giá" }]} />
              {mode === "lines" ? (
                <LinesEditor lines={lines} setLines={setLines} groupId={cust.customerGroupId} customerId={cust.id} allowPrice={can("b2b.approve")} showCost={false} />
              ) : (
                <div className="stack">
                  {quotes.loading ? <Spinner /> : !(quotes.data ?? []).length ? <EmptyState title="Khách chưa có báo giá còn hiệu lực" /> : (
                    <Select label="Báo giá" value={quoteId} onChange={(e) => { setQuoteId(e.target.value); setQtys({}); }}>
                      <option value="">— Chọn báo giá —</option>{(quotes.data ?? []).map((q: any) => <option key={q.id} value={q.id}>{q.code} · {QUOTE_STATUS[q.status]} · {money(q.subtotal)}</option>)}
                    </Select>
                  )}
                  {quote.data && quote.data.lines.map((l: any) => (
                    <div key={l.id} className="card flat row between wrap">
                      <div><b>{l.productName}</b><div className="small muted">Giá báo {money(l.unitPrice)}/{unitLabel(l.unit)}</div></div>
                      {l.qty != null ? <b>{qtyU(l.qty, l.unit)}</b> : <div style={{ width: 130 }}><DecInput label={`SL (${unitLabel(l.unit)})`} value={qtys[l.productId] ?? ""} onChange={(n) => setQtys({ ...qtys, [l.productId]: n })} /></div>}
                    </div>
                  ))}
                </div>
              )}
              <TextArea label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="hint">Trình tự: kiểm tra hạn mức & nợ quá hạn rồi mới giữ tồn theo lô (FEFO).</div>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function OrderDetail({ id }: { id: number }) {
  const can = useCan();
  const o = useAsync(() => get(`/b2b/orders/${id}`), [id]);
  const [mode, setMode] = useState<"" | "cancel" | "return" | "edit">("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<any>(null);
  const [stockMsg, setStockMsg] = useState("");
  const d = o.data;
  if (o.loading && !d) return <Spinner />;
  if (!d) return <div className="stack"><Back to="/b2b-orders" label="Đơn sỉ" /><EmptyState title="Không tìm thấy đơn" /></div>;
  const confirm = async () => {
    setBusy(true); setBlocked(null); setStockMsg("");
    try { await post(`/b2b/orders/${id}/confirm`, {}, { silent: true }); toast("Đã giữ hàng", "ok"); o.reload(); }
    catch (e) {
      if (e instanceof ApiError && e.code === "credit_blocked") setBlocked(e.details);
      else if (e instanceof ApiError && e.code === "insufficient_stock") setStockMsg(e.message);
      else if (e instanceof ApiError) toast(e.message, "error");
    } finally { setBusy(false); }
  };
  const pick = async () => {
    setBusy(true);
    try { const r = await post(`/b2b/orders/${id}/pick`); toast("Đã tạo phiếu soạn", "ok"); navigate(`/deliveries/${r.deliveryId}`); } catch {} finally { setBusy(false); }
  };
  const openDelivery = d.deliveries.find((x: any) => ["picking", "ready", "shipping"].includes(x.status));
  const lineReserved = (l: any) => (l.qtyMilli > 0 ? Math.min(1, l.reservedMilli / l.qtyMilli) : 0);
  const rs = (l: any) => {
    if (["completed"].includes(d.status)) return <Badge tone="ok">Đã giao {qtyU((l.deliveredMilli * l.qty) / l.qtyMilli, l.unit)}</Badge>;
    if (["cancelled"].includes(d.status)) return <Badge>—</Badge>;
    if (l.shortMilli > 0) return <span className="row wrap" style={{ gap: 4 }}><Badge tone="warn">Chờ hàng {qtyU((l.shortMilli * l.qty) / l.qtyMilli, l.unit)}</Badge>{l.poCode && <Badge tone="info">{l.poCode}{l.poExpectedDate ? ` · về ${ymd(l.poExpectedDate)}` : ""}</Badge>}</span>;
    const r = lineReserved(l);
    return r >= 1 ? <Badge tone="ok">Đã giữ đủ</Badge> : r > 0 ? <Badge tone="warn">Giữ {Math.round(r * 100)}%</Badge> : <Badge tone={d.status === "new" ? "warn" : undefined}>Chưa giữ</Badge>;
  };
  return (
    <div className="stack">
      <Back to="/b2b-orders" label="Đơn sỉ" />
      <div className="page-head">
        <div style={{ minWidth: 0 }}><h2 style={{ margin: 0 }}>Đơn {d.code}</h2><div className="muted small"><Lnk to={`/customers/${d.customerId}`}>{d.customerName}</Lnk> · giao {ymd(d.deliveryDate)}{d.address ? ` · ${d.addressLabel}: ${d.address}` : ""}</div></div>
        <Badge tone={orderTone(d.status)}>{ORDER_STATUS[d.status] ?? d.status}</Badge>
      </div>
      {(blocked || (d.status === "new" && d.credit && (d.credit.overdueCount > 0 || d.credit.available < d.total))) && !blocked && (
        <Banner>Đơn chưa giữ hàng. Khách {d.credit.overdueCount > 0 ? "đang có nợ quá hạn" : "có thể vượt hạn mức"} — nếu bị chặn, đơn sẽ được gửi chủ duyệt.</Banner>
      )}
      {d.awaitingStock && ["confirmed", "preparing"].includes(d.status) && (
        <Banner>Đơn đang <b>chờ hàng về</b> — đã giữ phần có tồn, phần thiếu được gom vào đơn đặt NCC. {d.lines.filter((l: any) => l.poCode).length ? "" : "Chưa có PO phủ phần thiếu (chạy “Chốt ngay” ở màn Đơn đặt NCC). "}Chỉ giao được phần đã giữ; khi hàng về hệ thống tự giữ thêm cho đơn.</Banner>
      )}
      {blocked && <CreditBlocked details={blocked} />}
      {stockMsg && <Banner tone="danger">{stockMsg} — nhập thêm hàng rồi bấm "Giữ hàng lại".</Banner>}
      <div className="kpis">
        <div className="kpi"><div className="l">Giá trị đơn</div><div className="v">{money(d.total)}</div></div>
        <div className="kpi"><div className="l">Công nợ khách</div><div className="v">{money(d.credit.balance)}</div></div>
        <div className="kpi"><div className="l">Quá hạn</div><div className="v" style={{ color: d.credit.overdueAmount ? "var(--warn)" : undefined }}>{money(d.credit.overdueAmount)}</div></div>
        <div className="kpi"><div className="l">Còn được nợ</div><div className="v" style={{ color: d.credit.available < 0 ? "var(--danger)" : undefined }}>{money(d.credit.available)}</div></div>
      </div>
      <Card title="Hàng đặt">
        <DataTable rows={d.lines} rowKey={(l: any) => l.id} cols={[
          { key: "n", label: "Hàng", title: true, render: (l: any) => <b>{l.productName}</b> },
          { key: "q", label: "SL", right: true, render: (l: any) => qtyU(l.qty, l.unit) },
          { key: "p", label: "Đơn giá", right: true, render: (l: any) => <span className="money">{money(l.unitPrice)}</span> },
          { key: "r", label: "Giữ tồn", render: rs },
          { key: "t", label: "Thành tiền", right: true, render: (l: any) => <span className="money">{money(l.lineTotal)}</span> },
        ]} />
      </Card>
      {d.note && <div className="small muted">Ghi chú: {d.note}</div>}
      <div className="row wrap">
        {["new", "delivery_failed"].includes(d.status) && can("b2b.write") && <Button loading={busy} onClick={confirm}>Giữ hàng lại</Button>}
        {d.status === "confirmed" && can("b2b.deliver") && <Button loading={busy} onClick={pick}>Soạn hàng</Button>}
        {openDelivery && <Lnk to={`/deliveries/${openDelivery.id}`} className="btn soft">Mở phiếu giao {openDelivery.code}</Lnk>}
        {["new", "confirmed", "preparing"].includes(d.status) && can("b2b.write") && <Button variant="ghost" onClick={() => setMode("edit")}>Đổi ngày / địa chỉ</Button>}
        {d.status === "completed" && d.invoiceId && can("b2b.write") && <Button variant="ghost" onClick={() => setMode("return")}>Trả hàng</Button>}
        {["new", "confirmed", "preparing", "delivery_failed"].includes(d.status) && can("b2b.write") && <Button variant="danger" onClick={() => setMode("cancel")}>Huỷ đơn</Button>}
      </div>
      {d.deliveries.length > 0 && (
        <Card title="Phiếu giao"><DataTable rows={d.deliveries} rowKey={(x: any) => x.id} onRowClick={(x: any) => navigate(`/deliveries/${x.id}`)} cols={[
          { key: "c", label: "Mã", title: true, render: (x: any) => <b>{x.code}</b> },
          { key: "s", label: "Trạng thái", render: (x: any) => <Badge tone={deliveryTone(x.status)}>{DELIVERY_STATUS[x.status] ?? x.status}</Badge> },
          { key: "r", label: "Người nhận", render: (x: any) => x.receiverName ?? "—" },
        ]} /></Card>
      )}
      {d.invoices.length > 0 && (
        <Card title="Hoá đơn"><DataTable rows={d.invoices} rowKey={(x: any) => x.id} onRowClick={(x: any) => navigate(`/invoices?id=${x.id}`)} cols={[
          { key: "c", label: "Số HĐ", title: true, render: (x: any) => <b>{x.code}</b> },
          { key: "k", label: "Loại", render: (x: any) => INVOICE_KIND[x.kind] ?? x.kind },
          { key: "e", label: "HĐĐT", render: (x: any) => <Badge tone={einvTone(x.einvoiceStatus)}>{EINVOICE[x.einvoiceStatus] ?? x.einvoiceStatus}</Badge> },
          { key: "d", label: "Hạn", render: (x: any) => ymd(x.dueDate) },
          { key: "t", label: "Tổng", right: true, render: (x: any) => <span className="money" style={{ color: x.total < 0 ? "var(--danger)" : undefined }}>{money(x.total)}</span> },
        ]} /></Card>
      )}
      {mode === "cancel" && <ReasonSheet title={`Huỷ đơn ${d.code}`} confirm="Huỷ đơn & nhả hàng" danger onClose={() => setMode("")} onSubmit={async (reason) => { await post(`/b2b/orders/${id}/cancel`, { reason }); toast("Đã huỷ đơn", "ok"); setMode(""); o.reload(); }} />}
      {mode === "return" && <ReturnSheet d={d} onClose={() => setMode("")} onDone={() => { setMode(""); o.reload(); }} />}
      {mode === "edit" && <EditSheet d={d} onClose={() => setMode("")} onDone={() => { setMode(""); o.reload(); }} />}
    </div>
  );
}

function EditSheet({ d, onClose, onDone }: { d: any; onClose: () => void; onDone: () => void }) {
  const cu = useAsync(() => get(`/customers/${d.customerId}`), [d.customerId]);
  const [date, setDate] = useState(d.deliveryDate), [addr, setAddr] = useState(String(d.addressId)), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Đổi ngày / địa chỉ giao" footer={<Button block loading={busy} onClick={async () => { setBusy(true); try { await put(`/b2b/orders/${d.id}`, { deliveryDate: date, addressId: Number(addr) }); toast("Đã cập nhật đơn", "ok"); onDone(); } catch {} finally { setBusy(false); } }}>Lưu</Button>}>
      {cu.loading ? <Spinner /> : <div className="stack">
        {d.status === "preparing" && <Banner>Đơn đang soạn: đổi địa chỉ cần quyền duyệt (chủ / quản lý).</Banner>}
        <Input label="Ngày giao" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />
        <Select label="Địa chỉ giao" value={addr} onChange={(e) => setAddr(e.target.value)}>{(cu.data?.addresses ?? []).filter((a: any) => a.active).map((a: any) => <option key={a.id} value={a.id}>{a.label} — {a.address}</option>)}</Select>
      </div>}
    </Sheet>
  );
}

function ReturnSheet({ d, onClose, onDone }: { d: any; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState<Record<number, number>>({});
  const [restock, setRestock] = useState(true), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const chosen = d.lines.filter((l: any) => (q[l.id] ?? 0) > 0);
  return (
    <Sheet open wide onClose={onClose} title="Trả hàng sau hoá đơn" footer={<Button block variant="danger" loading={busy} disabled={!chosen.length || reason.trim().length < 2} onClick={async () => {
      setBusy(true);
      try { const r = await post(`/b2b/orders/${d.id}/returns`, { lines: chosen.map((l: any) => ({ orderLineId: l.id, qty: q[l.id], unit: l.unit, restock, reason: reason.trim() })) }); toast(`Đã lập hoá đơn điều chỉnh ${r.invoice.code} (${money(r.invoice.total)})`, "ok"); onDone(); } catch {} finally { setBusy(false); }
    }}>Lập hoá đơn điều chỉnh</Button>}>
      <div className="stack">
        <Banner tone="info">Hoá đơn gốc không bị sửa: hệ thống lập <b>hoá đơn điều chỉnh âm</b> và giảm công nợ.</Banner>
        {d.lines.map((l: any) => {
          const delivered = l.qtyMilli > 0 ? (l.deliveredMilli * l.qty) / l.qtyMilli : 0;
          return (
            <div key={l.id} className="row between wrap">
              <div style={{ minWidth: 0 }}><b>{l.productName}</b><div className="small muted">Đã giao {q3(delivered)} {unitLabel(l.unit)}</div></div>
              <div style={{ width: 140 }}><DecInput label={`Trả (${unitLabel(l.unit)})`} value={q[l.id] ?? ""} onChange={(n) => setQ({ ...q, [l.id]: Math.min(n, delivered) })} /></div>
            </div>
          );
        })}
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Nhập lại kho đúng lô gốc</label>
        <Input label="Lý do trả" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Sheet>
  );
}
