import { useState } from "react";
import { get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, Segmented, Sheet, Spinner, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { downloadHref, money, qtyText } from "../../format";
import { useCan } from "../../store";
import { EINVOICE, INVOICE_KIND, Lnk, einvTone, qparam, ymd } from "./kit";

export default function Invoices() {
  const [f, setF] = useState<"all" | "open" | "overdue">("all");
  const [sel, setSel] = useState<number | null>(qparam("id") ? Number(qparam("id")) : null);
  const l = useAsync(() => get("/invoices", { status: f === "open" ? "open" : undefined, overdue: f === "overdue" ? 1 : undefined, limit: 100 }).then((r) => items<any>(r)), [f]);
  const rows = l.data ?? [];
  const out = rows.reduce((s, x) => s + (x.outstanding ?? 0), 0);
  return (
    <div className="stack">
      <Segmented value={f} onChange={setF} options={[{ v: "all", label: "Tất cả" }, { v: "open", label: "Còn nợ" }, { v: "overdue", label: "Quá hạn" }]} />
      <div className="muted">{rows.length} hoá đơn · còn nợ <b className="money">{money(out)}</b></div>
      {l.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(x) => x.id} onRowClick={(x) => setSel(x.id)} empty="Không có hoá đơn" cols={[
          { key: "c", label: "Số HĐ", title: true, render: (x) => <b>{x.code}</b> },
          { key: "k", label: "Khách", render: (x) => x.customerName ?? "—" },
          { key: "i", label: "Ngày", hideMobile: true, render: (x) => ymd(x.issueDate) },
          { key: "d", label: "Hạn", render: (x) => <span>{ymd(x.dueDate)}{x.overdueDays > 0 && <Badge tone="warn">trễ {x.overdueDays} ngày</Badge>}</span> },
          { key: "e", label: "HĐĐT", render: (x) => <Badge tone={einvTone(x.einvoiceStatus)}>{EINVOICE[x.einvoiceStatus] ?? x.einvoiceStatus}</Badge> },
          { key: "t", label: "Tổng", right: true, render: (x) => <span className="money" style={{ color: x.total < 0 ? "var(--danger)" : undefined }}>{money(x.total)}</span> },
          { key: "o", label: "Còn nợ", right: true, render: (x) => <span className="money" style={{ color: x.overdueDays > 0 ? "var(--warn)" : undefined }}>{x.kind === "adjustment" ? "—" : money(x.outstanding)}</span> },
        ]} />
      )}
      {sel != null && <InvoiceDetail id={sel} onClose={() => { setSel(null); if (qparam("id")) history.replaceState({}, "", "/invoices"); }} onChanged={l.reload} />}
    </div>
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
    <Sheet open wide onClose={onClose} title={i ? `Hoá đơn ${i.code}` : "Hoá đơn"}>
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
          <DataTable rows={i.lines} rowKey={(l: any) => l.id} cols={[
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
    </Sheet>
  );
}
