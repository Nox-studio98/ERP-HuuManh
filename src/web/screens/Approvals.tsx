import { useState } from "react";
import { get, items, post } from "../api";
import { Badge, Button, Card, DataTable, EmptyState, Segmented, Spinner, TextArea, useAsync } from "../components/ui";
import { DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout } from "../components/list";
import { Obj } from "./Inventory";
import { toast } from "../components/toast";
import { fmtDateTime, money } from "../format";
import { Lnk } from "./b2b/kit";
import { navigate } from "../router";

/** Loại yêu cầu thật của backend (routes/pos.ts, finance.ts, inventory.ts, prices.ts). */
const TYPES: Record<string, string> = { "order.below_cost": "Bán dưới giá vốn", "order.discount": "Giảm giá vượt ngưỡng", "order.return": "Trả hàng POS cần duyệt", "stock_doc.post": "Chứng từ kho cần duyệt", "cash_voucher.post": "Chi tiền lớn", "price.activate": "Đổi giá bán", "order.credit_override": "Đơn sỉ vượt hạn mức công nợ", "quote.approve": "Báo giá giảm sâu / dưới giá vốn", "debt_adjustment.post": "Điều chỉnh công nợ", "debt_payment.post": "Chi công nợ vượt ngưỡng", "shop.b2b_link": "Khách web xin liên kết khách sỉ" };
const CREDIT: Record<string, string> = { overdue: "Khách đang có nợ quá hạn", over_limit: "Vượt hạn mức công nợ" };
const ADJ: Record<string, string> = { discount: "Chiết khấu", write_off: "Xoá nợ", offset: "Cấn trừ" };
export default function Approvals() {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [type, setType] = useState(""), [q, setQ] = useState("");
  const a = useAsync(() => get("/approvals", { status, limit: 200 }).then((r) => items<any>(r)), [status]);
  const [sel, setSel] = useState<any>(null);
  const [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try { await post(`/approvals/${sel.id}/decide`, { decision, note }); toast(decision === "approved" ? "Đã duyệt" : "Đã từ chối", "ok"); setSel(null); setNote(""); a.reload(); } catch {} finally { setBusy(false); }
  };
  const REASON: Record<string, string> = { discount: "Giảm giá vượt ngưỡng", below_cost: "Giá bán thấp hơn giá vốn", ...CREDIT };
const reasonText = (x: any) => (String(x.type).startsWith("order.") || x.type === "quote.approve" ? String(x.reason ?? "").split(",").map((r) => REASON[r] ?? r).join(", ") : x.reason);
/** Chi tiết theo từng loại payload của backend. */
const detail = (x: any) => {
  const p = x.payload ?? {};
  const d: Record<string, any> = { "Loại": TYPES[x.type] ?? x.type, "Lý do": reasonText(x), "Người yêu cầu": x.requestedByName, "Lúc": fmtDateTime(x.requestedAt) };
  if (x.type === "order.credit_override") { d["Mã đơn"] = p.orderCode ?? `#${x.refId}`; d["Giá trị đơn"] = money(p.total); d["Lý do chặn"] = reasonText(x); }
  else if (x.type === "quote.approve") { d["Mã báo giá"] = p.quoteCode ?? `#${x.refId}`; d["Tạm tính"] = money(p.subtotal); d["Lý do cần duyệt"] = reasonText(x); }
  else if (x.type === "debt_adjustment.post") { d["Phiếu"] = p.code; d["Loại"] = ADJ[p.type] ?? p.type; d["Đối tác"] = `${p.partnerType === "supplier" ? "Nhà cung cấp" : "Khách"} #${p.partnerId}`; d["Số tiền"] = money(p.amount); }
  else if (String(x.type).startsWith("order.")) { d["Tổng đơn"] = money(p.total); d["Giá trị giảm"] = money(p.discountValue); }
  else if (x.type === "debt_payment.post") { d["Phiếu"] = p.code; d["Đối tác"] = p.partnerName; d["Số tiền"] = money(p.amount); }
  else if (x.type === "cash_voucher.post") { d["Phiếu"] = p.code; d["Số tiền"] = money(p.amount); }
  else if (x.type === "price.activate") { d["Giá mới"] = money(p.unitPrice); d["Mặt hàng #"] = p.productId; d["Có hiệu lực từ"] = fmtDateTime(p.effectiveFrom); if (p.belowCost) d["Cảnh báo"] = "Thấp hơn giá vốn"; }
  else if (x.type === "shop.b2b_link") { d["Công ty"] = p.companyName; d["Mã số thuế"] = p.taxCode; if (p.note) d["Ghi chú"] = p.note; d["Tài khoản web #"] = x.refId; }
  else if (x.refType) d["Tham chiếu"] = `${x.refType} #${x.refId}`;
  return d;
};
  const isLink = sel?.type === "shop.b2b_link";
  const all = a.data ?? [];
  const typeCount = all.reduce<Record<string, number>>((m, x) => ({ ...m, [x.type]: (m[x.type] ?? 0) + 1 }), {});
  const term = q.trim().toLowerCase();
  const rows = all.filter((x) => (!type || x.type === type) && (!term || [TYPES[x.type], x.type, x.requestedByName, reasonText(x), x.payload?.orderCode, x.payload?.quoteCode, x.payload?.code, String(x.id)].some((v) => String(v ?? "").toLowerCase().includes(term))));
  const open = (x: any) => { setSel(x); setNote(""); };
  const dirty = !!(type || q);
  const reset = () => { setType(""); setQ(""); };
  const cols = [
    { key: "m", label: "Yêu cầu", title: true, hideDesktop: true, render: (x: any) => <div><b>#{x.id} · {TYPES[x.type] ?? x.type}</b>{(reasonText(x) || x.type === "order.credit_override") && <div className="small muted" style={{ fontWeight: 400 }}>{reasonText(x)}{x.type === "order.credit_override" ? ` · ${x.payload?.orderCode} · ${money(x.payload?.total)}` : ""}</div>}</div> },
    { key: "id", label: "Mã", hideMobile: true, sort: (x: any) => x.id, render: (x: any) => <b className="nw">#{x.id}</b> },
    { key: "t", label: "Loại yêu cầu", hideMobile: true, sort: (x: any) => TYPES[x.type] ?? x.type, render: (x: any) => TYPES[x.type] ?? x.type },
    { key: "r", label: "Lý do / nội dung", hideMobile: true, hideBelow: 1280 as const, render: (x: any) => <span>{reasonText(x) || "—"}{x.type === "order.credit_override" && <span className="small muted"> · {x.payload?.orderCode} · {money(x.payload?.total)}</span>}</span> },
    { key: "u", label: "Người yêu cầu", sort: (x: any) => x.requestedByName ?? "", render: (x: any) => x.requestedByName ?? `NV #${x.requestedBy}` },
    { key: "w", label: "Lúc", sort: (x: any) => x.requestedAt, render: (x: any) => <span className="nw">{fmtDateTime(x.requestedAt)}</span> },
    { key: "s", label: "Trạng thái", render: (x: any) => <Badge tone={x.status === "approved" ? "ok" : x.status === "rejected" ? "danger" : "warn"}>{x.status === "approved" ? "Đã duyệt" : x.status === "rejected" ? "Đã từ chối" : "Chờ duyệt"}</Badge> },
  ];
  return (
    <div className="stack">
      <PageHeader subtitle={a.loading ? "Đang tải…" : `${rows.length} yêu cầu${status === "pending" ? " đang chờ" : ""}`}
        actions={<ExportButton filename={`yeu-cau-duyet-${status}`} rows={rows} columns={[{ label: "Mã", value: (x: any) => x.id }, { label: "Loại", value: (x: any) => TYPES[x.type] ?? x.type }, { label: "Lý do", value: (x: any) => reasonText(x) }, { label: "Người yêu cầu", value: (x: any) => x.requestedByName }, { label: "Lúc", value: (x: any) => fmtDateTime(x.requestedAt) }, { label: "Trạng thái", value: (x: any) => x.status }]} />} />
      <Segmented fit value={status} onChange={(v) => { setStatus(v); setType(""); setSel(null); }} options={[{ v: "pending", label: "Chờ duyệt" }, { v: "approved", label: "Đã duyệt" }, { v: "rejected", label: "Đã từ chối" }]} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={type ? 1 : 0}
        advanced={<FilterSelect label="Loại yêu cầu" value={type} onChange={setType} options={Object.entries(typeCount).map(([v, n]) => ({ v, label: `${TYPES[v] ?? v} (${n})` }))} />}>
        <SearchInput value={q} onSearch={setQ} placeholder="Mã, người yêu cầu, lý do…" label="Tìm yêu cầu" />
      </FilterBar>
      {status === "pending" && all.length > 0 && <KpiRow cols={Math.min(4, Math.max(2, Object.keys(typeCount).length + 1))} items={[{ label: "Chờ duyệt", value: all.length, tone: "warn" }, ...Object.entries(typeCount).slice(0, 3).map(([v, n]) => ({ label: TYPES[v] ?? v, value: n, onClick: () => setType(type === v ? "" : v) }))]} />}
      {a.loading ? <Spinner /> : (
        <SplitLayout open={!!sel} panel={sel ? (
          <DetailPanel title={`Yêu cầu #${sel.id}`} onClose={() => setSel(null)} footer={sel.status !== "pending" ? undefined : <>
            <Button variant="danger" disabled={busy} onClick={() => decide("rejected")}>Từ chối</Button>
            {isLink ? <Button className="grow" onClick={() => { const id = sel.refId; setSel(null); navigate(`/shop-accounts?id=${id}`); }}>Chọn khách sỉ để liên kết</Button> : <Button className="grow" loading={busy} onClick={() => decide("approved")}>Duyệt</Button>}</>}>
            <div className="stack"><Card className="flat"><Obj v={detail(sel)} /></Card>
              {sel.type === "order.credit_override" && <Lnk to={`/b2b-orders/${sel.refId}`}>Xem đơn</Lnk>}
              {sel.type === "debt_adjustment.post" && sel.payload?.partnerId && <Lnk to={`/debts?statement=${sel.payload.partnerType}:${sel.payload.partnerId}`}>Xem sao kê đối tác</Lnk>}
              {sel.status === "pending" && <TextArea label="Ghi chú quyết định" value={note} onChange={(e) => setNote(e.target.value)} />}
              {sel.status !== "pending" && sel.decisionNote && <div className="small muted">Ghi chú: {sel.decisionNote}</div>}</div>
          </DetailPanel>) : null}>
          <DataTable rows={rows} rowKey={(x) => x.id} onRowClick={open} selectedKey={sel?.id} defaultSort={{ key: "id", dir: "desc" }} pageSize={50} cols={cols}
            emptyState={<EmptyState title={status === "pending" && !dirty ? "Không có yêu cầu chờ duyệt" : dirty ? "Không có yêu cầu nào khớp bộ lọc" : "Chưa có yêu cầu nào"} hint={status === "pending" && !dirty ? "Mọi thứ đã được xử lý." : undefined}
              action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{status === "pending" && <Button variant="ghost" onClick={() => setStatus("approved")}>Xem đã duyệt</Button>}</div>} />} />
        </SplitLayout>
      )}
    </div>
  );
}
