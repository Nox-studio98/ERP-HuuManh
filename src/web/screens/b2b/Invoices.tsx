import { useState } from "react";
import { get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Spinner, useAsync } from "../../components/ui";
import { DateRangeFilter, DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, rangeOf, usePagedList, type DateRange } from "../../components/list";
import { toast } from "../../components/toast";
import { downloadHref, money, qtyText } from "../../format";
import { useCan } from "../../store";
import { QrImage } from "../../components/QrImage";
import { EINVOICE, INVOICE_KIND, Lnk, einvTone, qparam, ymd } from "./kit";

export default function Invoices() {
  const [range, setRange] = useState<DateRange>(() => rangeOf("month"));
  const [f, setF] = useState<"" | "open" | "overdue">(""), [cust, setCust] = useState(""), [q, setQ] = useState(() => qparam("q") ?? "");
  const [sel, setSel] = useState<number | null>(qparam("id") ? Number(qparam("id")) : null);
  const customers = useAsync(() => get("/customers", { type: "b2b", limit: 100 }, { silent: true }).then((r) => items<any>(r)).catch(() => [] as any[]), []);
  const list = usePagedList<any>("/invoices", { status: f === "open" ? "open" : undefined, overdue: f === "overdue" ? 1 : undefined, customerId: cust, q, from: range.from, to: range.to, limit: 50 }, [f, cust, q, range.from, range.to]);
  const rows = list.rows, sum = list.extra?.summary;
  const dirty = !!(f || cust || q);
  const reset = () => { setF(""); setCust(""); setQ(""); };
  const close = () => { setSel(null); if (qparam("id")) history.replaceState({}, "", "/invoices"); };
  return (
    <div className="stack">
      <PageHeader subtitle={<>{range.from === range.to ? ymd(range.from) : `${ymd(range.from)} – ${ymd(range.to)}`}{sum ? <> · {sum.count} hoá đơn</> : null}</>}
        actions={<ExportButton filename={`hoa-don-${range.from}_${range.to}`} rows={rows} columns={[
          { label: "Số HĐ", value: (x) => x.code }, { label: "Khách", value: (x) => x.customerName }, { label: "Ngày", value: (x) => x.issueDate }, { label: "Hạn", value: (x) => x.dueDate },
          { label: "HĐĐT", value: (x) => EINVOICE[x.einvoiceStatus] ?? x.einvoiceStatus }, { label: "Số HĐĐT", value: (x) => x.einvoiceNo }, { label: "Tổng", value: (x) => x.total }, { label: "Còn nợ", value: (x) => (x.kind === "adjustment" ? "" : x.outstanding) },
        ]} />} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[f, cust].filter(Boolean).length} advanced={<>
        <FilterSelect label="Thanh toán" value={f} onChange={(v) => setF(v as any)} options={[{ v: "open", label: "Còn nợ" }, { v: "overdue", label: "Quá hạn" }]} />
        <FilterSelect label="Khách hàng" value={cust} onChange={setCust} options={(customers.data ?? []).map((c: any) => ({ v: String(c.id), label: c.name }))} />
      </>}>
        <DateRangeFilter value={range} onChange={setRange} presets={["month", "lastMonth", "7d", "custom"]} />
        <SearchInput value={q} onSearch={setQ} placeholder="Số HĐ, khách, số HĐĐT…" label="Tìm hoá đơn" />
      </FilterBar>
      <KpiRow items={[
        { label: "Số hoá đơn", value: sum?.count ?? "—" },
        { label: "Tổng giá trị", value: sum ? money(sum.total) : "—" },
        { label: "Còn nợ", value: sum ? money(sum.outstanding) : "—", tone: sum?.outstanding ? "warn" : undefined, onClick: () => setF(f === "open" ? "" : "open") },
        { label: "Quá hạn", value: sum ? money(sum.overdue) : "—", tone: sum?.overdue ? "danger" : undefined, onClick: () => setF(f === "overdue" ? "" : "overdue") },
      ]} />
      {list.loading ? <Spinner /> : (
        <SplitLayout open={sel != null} panel={sel != null ? <InvoiceDetail id={sel} onClose={close} onChanged={list.reload} /> : null}>
          <DataTable rows={rows} rowKey={(x) => x.id} onRowClick={(x) => setSel(x.id)} selectedKey={sel} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
            footer={sum ? `Hiển thị ${rows.length}/${sum.count} hoá đơn` : undefined}
            emptyState={<EmptyState title={dirty ? "Không có hoá đơn nào khớp bộ lọc" : "Chưa có hoá đơn trong khoảng này"} hint="Hoá đơn được tạo khi giao đơn sỉ." action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{range.preset !== "lastMonth" && <Button variant="ghost" onClick={() => setRange(rangeOf("lastMonth"))}>Xem tháng trước</Button>}<Lnk to="/b2b-orders" className="btn ghost">Đơn sỉ</Lnk></div>} />}
            cols={[
              { key: "c", label: "Số HĐ", title: true, sort: (x) => x.code, render: (x) => <b className="nw">{x.code}</b> },
              { key: "k", label: "Khách", sort: (x) => x.customerName, render: (x) => x.customerName ?? "—" },
              { key: "i", label: "Ngày", hideMobile: true, hideBelow: 1440, sort: (x) => x.issueDate, render: (x) => ymd(x.issueDate) },
              { key: "d", label: "Hạn", sort: (x) => x.dueDate, render: (x) => <span className="nw">{ymd(x.dueDate)}{x.overdueDays > 0 && <span className="hb-1440"> <Badge tone="warn">trễ {x.overdueDays} ngày</Badge></span>}</span> },
              { key: "e", label: "HĐĐT", hideBelow: 1440, render: (x) => <Badge tone={einvTone(x.einvoiceStatus)}>{EINVOICE[x.einvoiceStatus] ?? x.einvoiceStatus}</Badge> },
              { key: "t", label: "Tổng", num: true, sort: (x) => x.total, render: (x) => <span className="money" style={{ color: x.total < 0 ? "var(--danger)" : undefined }}>{money(x.total)}</span> },
              { key: "o", label: "Còn nợ", num: true, sort: (x) => (x.kind === "adjustment" ? 0 : x.outstanding), render: (x) => <span className="money" style={{ color: x.overdueDays > 0 ? "var(--warn)" : undefined }}>{x.kind === "adjustment" ? "—" : money(x.outstanding)}</span> },
            ]} />
        </SplitLayout>
      )}
    </div>
  );
}

/** Mã thanh toán SePay + VietQR của hoá đơn còn nợ: khách chuyển khoản kèm mã này thì tự thu nợ và gạch đúng hoá đơn. */
function SepayPayCard({ id, outstanding }: { id: number; outstanding: number }) {
  const info = useAsync(() => get(`/sepay/invoices/${id}/pay-info`).catch(() => ({ available: false })), [id, outstanding]);
  const p = info.data;
  if (!p?.available) return null;
  return (
    <Card title="Thu nợ bằng chuyển khoản (tự động)" className="flat">
      <div className="pay-card" data-testid="sepay-pay-card">
        <QrImage value={p.qrPayload} size={168} label={`VietQR thu nợ hoá đơn ${p.invoiceCode}`} />
        <dl className="pay-info">
          <div><dt>Số tài khoản</dt><dd className="num">{p.bank.account}</dd></div>
          <div><dt>Chủ tài khoản</dt><dd>{p.bank.name}</dd></div>
          <div><dt>Số tiền</dt><dd className="money">{money(p.amount)}</dd></div>
          <div><dt>Nội dung</dt><dd><b className="num" data-testid="sepay-code">{p.code}</b></dd></div>
        </dl>
      </div>
      <p className="hint">Khách phải chuyển <b>đúng số tiền còn nợ</b> và giữ nguyên nội dung. Tiền về, hệ thống tự lập phiếu thu và gạch nợ đúng hoá đơn này; sai số tiền thì giao dịch nằm ở mục “Giao dịch SePay”.</p>
    </Card>
  );
}

function InvoiceDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const d = useAsync(() => get(`/invoices/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const i = d.data;
  const retry = async () => {
    setBusy(true);
    try { await post(`/invoices/${id}/einvoice`); toast("Đã xếp hàng phát hành hoá đơn điện tử", "ok"); d.reload(); onChanged(); } catch {} finally { setBusy(false); }
  };
  return (
    <DetailPanel onClose={onClose} title={i ? `Hoá đơn ${i.code}` : "Hoá đơn"}>
      {d.loading || !i ? <Spinner /> : (
        <div className="stack">
          <div className="row wrap"><Badge>{INVOICE_KIND[i.kind] ?? i.kind}</Badge>{i.status !== "open" && <Badge tone="danger">Đã huỷ</Badge>}<span className="muted small">{i.customerName} · phát hành {ymd(i.issueDate)} · hạn {ymd(i.dueDate)}</span></div>
          <Card title="Hoá đơn điện tử" className="flat">
            <div className="stack" style={{ gap: 6 }} data-testid="einvoice-box">
              <div className="row between"><span className="muted">Trạng thái</span><Badge tone={einvTone(i.einvoiceStatus)}>{EINVOICE[i.einvoiceStatus] ?? i.einvoiceStatus}</Badge></div>
              {i.einvoiceNo && <div className="row between"><span className="muted">Số HĐĐT</span><b className="num">{i.einvoiceNo}</b></div>}
              {i.einvoiceSeries && <div className="row between"><span className="muted">Ký hiệu</span><span>{i.einvoiceSeries}</span></div>}
              {i.einvoiceLookupCode && <div className="row between"><span className="muted">Mã tra cứu</span><span className="num">{i.einvoiceLookupCode}</span></div>}
              {i.einvoiceError && <Banner tone="danger">Lỗi phát hành: {i.einvoiceError}</Banner>}
              {can("invoices.issue") && i.einvoiceStatus !== "issued" && i.einvoiceStatus !== "not_required" && i.status === "open" && <div><Button loading={busy} variant={i.einvoiceStatus === "failed" ? "primary" : "soft"} onClick={retry}>{i.einvoiceStatus === "failed" ? "Thử phát hành lại" : "Phát hành HĐĐT"}</Button></div>}
            </div>
          </Card>
          {i.kind !== "adjustment" && i.status === "open" && i.outstanding > 0 && can("debt.view") && <SepayPayCard id={i.id} outstanding={i.outstanding} />}
          <DataTable rows={i.lines} rowKey={(l: any) => l.id} emptyState={<div className="hint">Hoá đơn chưa có dòng hàng.</div>} cols={[
            { key: "n", label: "Nội dung", title: true, render: (l: any) => l.description },
            { key: "q", label: "SL", right: true, render: (l: any) => qtyText(l.qtyMilli, l.unit) },
            { key: "p", label: "Đơn giá", right: true, render: (l: any) => <span className="money">{money(l.unitPrice)}</span> },
            { key: "a", label: "Thành tiền", right: true, render: (l: any) => <span className="money">{money(l.amount)}</span> },
          ]} />
          <div className="totals">
            <div><span className="muted">Tiền hàng</span><span className="money">{money(i.subtotal)}</span></div>
            {i.vatAmount ? <div><span className="muted">Thuế GTGT</span><span className="money">{money(i.vatAmount)}</span></div> : null}
            <div className="grand"><span>Tổng</span><span className="money">{money(i.total)}</span></div>
            {i.kind !== "adjustment" && <div><span className="muted">Còn nợ</span><b className="money" style={{ color: i.outstanding > 0 ? "var(--warn)" : "var(--accent)" }} data-testid="outstanding">{money(i.outstanding)}</b></div>}
          </div>
          {i.allocations.length > 0 && <Card title="Đã thu / gạch nợ" className="flat"><DataTable rows={i.allocations} rowKey={(a: any) => a.id} cols={[
            { key: "c", label: "Chứng từ", title: true, render: (a: any) => a.paymentCode ?? a.adjustmentCode },
            { key: "t", label: "Lúc", render: (a: any) => ymd(a.createdAt) },
            { key: "a", label: "Số tiền", right: true, render: (a: any) => <span className="money">{money(a.amount)}</span> },
          ]} /></Card>}
          {i.adjustments.length > 0 && <Card title="Hoá đơn điều chỉnh" className="flat"><DataTable rows={i.adjustments} rowKey={(a: any) => a.id} cols={[
            { key: "c", label: "Số HĐ", title: true, render: (a: any) => a.code },
            { key: "e", label: "HĐĐT", render: (a: any) => <Badge tone={einvTone(a.einvoiceStatus)}>{EINVOICE[a.einvoiceStatus] ?? a.einvoiceStatus}</Badge> },
            { key: "t", label: "Tổng", right: true, render: (a: any) => <span className="money" style={{ color: "var(--danger)" }}>{money(a.total)}</span> },
          ]} /></Card>}
          <div className="row wrap">
            <a className="btn soft" href={downloadHref(`/invoices/${i.id}/pdf`)} target="_blank" rel="noreferrer">Mở PDF hoá đơn</a>
            {i.orderId && <Lnk to={`/b2b-orders/${i.orderId}`} className="btn ghost">Xem đơn</Lnk>}
            {i.customerId && <Lnk to={`/debts?statement=customer:${i.customerId}`} className="btn ghost">Sao kê khách</Lnk>}
          </div>
        </div>
      )}
    </DetailPanel>
  );
}
