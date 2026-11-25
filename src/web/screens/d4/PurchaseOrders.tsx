import { useMemo, useState } from "react";
import { ApiError, get, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, usePagedList } from "../../components/list";
import { downloadHref, fmtDateTime, money, qtyText, todayVN, unitLabel } from "../../format";
import { navigate } from "../../router";
import { useCan } from "../../store";
import { SupplierSelect, ymd } from "../b2b/kit";
import { ProductPicker, type Prod } from "./shared";
import ReceivePoSheet from "./ReceivePo";

/** Đơn đặt NCC (PO): danh sách + chi tiết + tab "Phần thiếu" (docs/PO-NCC.md mục 6). */
export const PO_STATUS: Record<string, string> = {
  draft: "Nháp", pending_approval: "Chờ chủ duyệt", sent: "Đã gửi, chờ NCC", supplier_proposed: "NCC đề xuất sửa", confirmed: "NCC đã xác nhận",
  partially_received: "Nhận một phần", received: "Đã nhận đủ", rejected: "NCC từ chối", cancelled: "Đã huỷ", closed: "Đã đóng",
};
export const poTone = (s: string) =>
  ({ draft: "info", pending_approval: "warn", sent: "warn", supplier_proposed: "warn", confirmed: "info", partially_received: "info", received: "ok", rejected: "danger", cancelled: undefined, closed: undefined } as any)[s];
const CHANNEL: Record<string, string> = { b2b: "Đơn sỉ", online: "Online", social: "Mạng xã hội", fresco: "Fresco" };
const HISTORY: Record<string, string> = {
  "po.create": "Tạo PO", "po.update": "Sửa PO nháp", "po.approve": "Duyệt & gửi NCC", "po.request_approval": "Gửi chủ duyệt", "po.approval_rejected": "Chủ từ chối duyệt", "po.cancel": "Huỷ PO", "po.close": "Đóng PO thiếu",
  "po.supplier_confirm": "NCC xác nhận", "po.supplier_propose": "NCC đề xuất sửa", "po.supplier_reject": "NCC từ chối", "po.proposal_accept": "Chấp nhận đề xuất", "po.proposal_reject": "Từ chối đề xuất", "po.receive": "Nhận hàng",
  "po.cutoff.create": "Chốt đêm tạo PO nháp", "po.cutoff.update": "Chốt đêm cập nhật PO nháp", "po.cutoff_now.create": "Chốt ngay tạo PO nháp", "po.cutoff_now.update": "Chốt ngay cập nhật PO nháp",
  "po.recalc.create": "Tính lại: tạo PO nháp", "po.recalc.update": "Tính lại: cập nhật PO nháp", "po.recalc.cancel": "Tính lại: huỷ nháp hết nhu cầu",
};
const num = (v: any, k: string) => v?.[k] ?? v?.[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? 0;
const q3 = (n: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n);

export default function PurchaseOrders() {
  const can = useCan();
  const qs = new URLSearchParams(location.search);
  const [tab, setTab] = useState<"po" | "short">(qs.get("tab") === "short" ? "short" : "po");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");
  const [rev, setRev] = useState(0);
  const [lastRun, setLastRun] = useState<any>(null);
  const run = async (what: "cutoff-now" | "recalculate") => {
    setBusy(what);
    try {
      const r = await post(`/purchase-orders/${what}`, {});
      setLastRun(r);
      const n = r.created.length + r.updated.length;
      toast(n ? `Đã ${r.created.length ? `tạo ${r.created.length} PO nháp` : ""}${r.created.length && r.updated.length ? ", " : ""}${r.updated.length ? `cập nhật ${r.updated.length} PO nháp` : ""}` : "Không có phần thiếu mới cần đặt", "ok");
      setRev((x) => x + 1);
    } catch { /* toast */ } finally { setBusy(""); }
  };
  return (
    <div className="stack">
      <PageHeader compact subtitle="Gom phần thiếu của đơn sỉ / đơn online đặt trước thành đơn đặt hàng theo từng nhà cung cấp"
        actions={can("purchasing.write") && (
          <>
            <Button variant="soft" loading={busy === "cutoff-now"} onClick={() => run("cutoff-now")} title="Chạy chốt đêm ngay (khi đã nhập xong đơn tối nay)">Chốt ngay</Button>
            <Button variant="soft" loading={busy === "recalculate"} onClick={() => run("recalculate")} title="Tính lại các PO nháp từ phần thiếu hiện tại">Tính lại</Button>
            <Button onClick={() => setCreating(true)}>+ Tạo PO</Button>
          </>
        )} />
      <Segmented className="tabs-d" value={tab} onChange={setTab} options={[{ v: "po", label: "Đơn đặt NCC" }, { v: "short", label: "Phần thiếu" }]} />
      {lastRun && (lastRun.noSupplier?.length > 0) && <Banner>Có {lastRun.noSupplier.length} mặt hàng thiếu nhưng <b>chưa có nhà cung cấp</b> — gắn NCC cho sản phẩm ở màn "Gợi ý đặt hàng" rồi bấm Tính lại.</Banner>}
      {tab === "po" ? <PoList key={rev} onCreate={() => setCreating(true)} /> : <Shortages key={rev} />}
      {creating && <PoForm onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); setTab("po"); setRev((x) => x + 1); navigate(`/purchase-orders?open=${id}`); }} />}
    </div>
  );
}

/* ------------------------------------------------------------------ danh sách */
function PoList({ onCreate }: { onCreate: () => void }) {
  const can = useCan();
  const costVisible = can("prices.view_cost");
  const [status, setStatus] = useState(""), [q, setQ] = useState("");
  const [sel, setSel] = useState<number | null>(() => Number(new URLSearchParams(location.search).get("open")) || null);
  const list = usePagedList<any>("/purchase-orders", { status, q, limit: 50 }, [status, q]);
  const sum = list.extra?.summary;
  const dirty = !!(status || q);
  const draftN = sum ? (sum.draft ?? 0) + (sum.pendingApproval ?? 0) : 0;
  return (
    <div className="stack">
      <FilterBar dirty={dirty} onReset={() => { setStatus(""); setQ(""); }} activeCount={[status].filter(Boolean).length}
        advanced={<FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={Object.entries(PO_STATUS).map(([v, label]) => ({ v, label }))} />}>
        <SearchInput value={q} onSearch={setQ} placeholder="Mã PO, nhà cung cấp…" label="Tìm đơn đặt NCC" />
        <ExportButton filename="don-dat-ncc" rows={list.rows} columns={[
          { label: "Mã PO", value: (r) => r.code }, { label: "Nhà cung cấp", value: (r) => r.supplierName }, { label: "Trạng thái", value: (r) => PO_STATUS[r.status] ?? r.status },
          { label: "Ngày giao dự kiến", value: (r) => r.expectedDate }, { label: "Số dòng", value: (r) => r.lineCount }, ...(costVisible ? [{ label: "Tổng tiền", value: (r: any) => r.total }] : []),
        ]} />
      </FilterBar>
      <KpiRow items={[
        { label: "Nháp chờ duyệt", value: sum ? draftN : "—", sub: sum?.pendingApproval ? `${sum.pendingApproval} chờ chủ duyệt` : undefined, tone: draftN ? "warn" : undefined, onClick: () => setStatus("draft") },
        { label: "Chờ NCC xác nhận", value: sum ? sum.awaitingSupplier : "—", tone: "info", onClick: () => setStatus("sent") },
        { label: "NCC đề xuất sửa", value: sum ? sum.supplierProposed : "—", tone: sum?.supplierProposed ? "warn" : undefined, onClick: () => setStatus("supplier_proposed") },
        { label: "Trễ hẹn giao", value: sum ? sum.overdue : "—", tone: sum?.overdue ? "danger" : undefined },
        { label: "Chờ nhận hàng", value: sum ? sum.receivable : "—", sub: sum?.openValue != null ? `${money(sum.openValue)} đang mở` : undefined, onClick: () => setStatus("confirmed,partially_received") },
      ]} />
      <SplitLayout open={sel != null} panel={sel != null ? <PoDetail key={sel} id={sel} onClose={() => setSel(null)} onChanged={list.reload} /> : null}>
        {list.loading && !list.rows.length ? <Spinner /> : (
          <DataTable rows={list.rows} rowKey={(r) => r.id} onRowClick={(r) => setSel(r.id)} selectedKey={sel} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
            footer={`Đang hiển thị ${list.rows.length} đơn đặt NCC`}
            emptyState={<EmptyState title={dirty ? "Không có PO nào khớp bộ lọc" : "Chưa có đơn đặt NCC"} hint="Sau giờ chốt đêm, phần thiếu của đơn sỉ / đơn online đặt trước sẽ tự gom thành PO nháp theo từng nhà cung cấp."
              action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={() => { setStatus(""); setQ(""); }}>Xoá lọc</Button>}{can("purchasing.write") && <Button onClick={onCreate}>+ Tạo PO</Button>}</div>} />}
            cols={[
              { key: "c", label: "Mã PO", title: true, sort: (r) => r.code, render: (r) => <b className="nw">{r.code}</b> },
              { key: "s", label: "Nhà cung cấp", sort: (r) => r.supplierName, render: (r) => r.supplierName },
              { key: "st", label: "Trạng thái", sort: (r) => r.status, render: (r) => <span className="row wrap" style={{ gap: 4 }}><Badge tone={poTone(r.status)}>{PO_STATUS[r.status] ?? r.status}</Badge>{r.overdue && <Badge tone="danger">Trễ hẹn</Badge>}</span> },
              { key: "o", label: "Nguồn", hideBelow: 1280, render: (r) => (r.source === "nightly" ? `Chốt đêm ${ymd(r.cutoffDay)}` : "Tạo tay") },
              { key: "l", label: "Dòng", hideBelow: 1280, num: true, sort: (r) => r.lineCount, render: (r) => r.lineCount },
              { key: "d", label: "Giao dự kiến", sort: (r) => r.expectedDate ?? "", render: (r) => (r.expectedDate ? ymd(r.expectedDate) : "—") },
              ...(costVisible ? [{ key: "t", label: "Tổng tiền", num: true, sort: (r: any) => r.total, render: (r: any) => <span className="money">{money(r.total)}</span> }] : []),
            ]} />
        )}
      </SplitLayout>
    </div>
  );
}

/* ------------------------------------------------------------------ chi tiết */
function PoDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const costVisible = can("prices.view_cost");
  const d = useAsync(() => get(`/purchase-orders/${id}`), [id]);
  const [mode, setMode] = useState<"" | "edit" | "respond" | "reject_proposal" | "cancel" | "close" | "receive">("");
  const [busy, setBusy] = useState("");
  const po = d.data;
  const reload = () => { d.reload(); onChanged(); };
  if (d.loading && !po) return <DetailPanel title="Đơn đặt NCC" onClose={onClose}><Spinner /></DetailPanel>;
  if (!po) return <DetailPanel title="Đơn đặt NCC" onClose={onClose}><EmptyState title="Không tìm thấy PO" /></DetailPanel>;
  const call = async (path: string, body: unknown, ok: string) => {
    setBusy(path);
    try { const r = await post(`/purchase-orders/${id}/${path}`, body); toast(r?.result === "pending_approval" ? "Đã gửi chủ duyệt (PO vượt ngưỡng)" : ok, "ok"); reload(); } catch { /* toast */ } finally { setBusy(""); }
  };
  const approveTxt = po.status === "pending_approval" ? "Duyệt & gửi NCC" : "Duyệt & gửi NCC";
  const canApprove = can("purchasing.approve");
  return (
    <DetailPanel title={po.code} onClose={onClose}>
      <div className="stack">
        <div className="row between wrap">
          <span className="row wrap" style={{ gap: 6 }}><Badge tone={poTone(po.status)}>{PO_STATUS[po.status] ?? po.status}</Badge>{po.overdue && <Badge tone="danger">Trễ hẹn giao</Badge>}</span>
          <a className="btn ghost sm" href={downloadHref(`/purchase-orders/${id}/pdf`)} target="_blank" rel="noreferrer">PDF</a>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <div><b>{po.supplierName}</b>{po.supplierPhone ? <span className="muted"> · {po.supplierPhone}</span> : null}</div>
          <div className="small muted">{po.source === "nightly" ? `Chốt đêm ngày ${ymd(po.cutoffDay)}` : "Tạo tay"} · lập {fmtDateTime(po.createdAt)}{po.createdByName ? ` bởi ${po.createdByName}` : ""}</div>
          <div className="small">Giao dự kiến: <b>{po.expectedDate ? ymd(po.expectedDate) : "chưa có"}</b>{po.proposedExpectedDate ? <> · NCC đề xuất <b>{ymd(po.proposedExpectedDate)}</b></> : null}</div>
        </div>
        {po.status === "pending_approval" && <Banner tone="info">PO vượt ngưỡng duyệt của quản lý — đang chờ chủ duyệt (có thông báo ở màn Duyệt).</Banner>}
        {po.status === "supplier_proposed" && <Banner>NCC đề xuất sửa{po.supplierNote ? `: “${po.supplierNote}”` : ""}. Xem cột “NCC đề xuất” rồi chấp nhận hoặc từ chối.</Banner>}
        {po.status === "rejected" && <Banner tone="danger">NCC từ chối: {po.rejectReason}. Phần thiếu sẽ được tính lại ở lần chạy sau (bấm “Tính lại” để chọn NCC khác).</Banner>}
        {po.sourceCancelled && !["cancelled", "closed"].includes(po.status) && <Banner>Có đơn nguồn đã huỷ — hàng về sẽ thành tồn bán lẻ, không giữ cho đơn đó.</Banner>}
        {po.supplierNote && po.status !== "supplier_proposed" && <div className="small muted">Ghi chú NCC: {po.supplierNote}</div>}
        {po.note && <div className="small muted">Ghi chú: {po.note}</div>}

        <Card title="Hàng đặt">
          <div className="stack" data-testid="po-lines">
            {po.lines.map((l: any) => (
              <div key={l.id} className="card flat" style={{ padding: 12 }}>
                <div className="row between wrap"><b>{l.productName}</b>
                  <span className="nw"><b>{q3(l.orderQty)} {unitLabel(l.orderUnit)}</b>{l.orderUnit !== l.baseUnit && <span className="muted small"> ({qtyText(l.qtyMilli, l.baseUnit)})</span>}</span></div>
                <div className="small muted row wrap" style={{ gap: 10 }}>
                  {costVisible && <span>Giá đặt {l.unitCost == null ? <b style={{ color: "var(--warn)" }}>chưa có giá</b> : `${money(l.unitCost)}/${unitLabel(l.baseUnit)}`}</span>}
                  {l.proposedQtyMilli != null && po.status === "supplier_proposed" && <Badge tone="warn">NCC đề xuất {qtyText(l.proposedQtyMilli, l.baseUnit)}{costVisible && l.proposedUnitCost != null ? ` · ${money(l.proposedUnitCost)}` : ""}</Badge>}
                  {l.confirmedQtyMilli != null && <span>Chốt {qtyText(l.confirmedQtyMilli, l.baseUnit)}{costVisible && l.confirmedUnitCost != null ? ` · ${money(l.confirmedUnitCost)}` : ""}</span>}
                  {["confirmed", "partially_received", "received", "closed"].includes(po.status) && <span>Đã nhận <b>{qtyText(l.receivedMilli, l.baseUnit)}</b> / {qtyText(l.targetMilli, l.baseUnit)}</span>}
                </div>
                {l.sources.length > 0 && (
                  <div className="stack" style={{ gap: 2, marginTop: 8 }}>
                    <span className="small muted">PO này phủ:</span>
                    {l.sources.map((s: any) => (
                      <div key={s.shortageId} className="row between small" style={{ background: "var(--surface-2)", borderRadius: 8, padding: "4px 10px", opacity: s.sourceCancelled ? 0.55 : 1 }}>
                        <span><a href={s.channel === "b2b" ? `/b2b-orders/${s.orderId}` : `/online-orders?open=${s.orderId}`} onClick={(e) => { e.preventDefault(); navigate(s.channel === "b2b" ? `/b2b-orders/${s.orderId}` : `/online-orders?open=${s.orderId}`); }}><b className="num">{s.orderCode}</b></a> · {s.customerName ?? CHANNEL[s.channel]}{s.needBy ? ` · giao ${ymd(s.needBy)}` : ""}</span>
                        <span className="nw">{s.sourceCancelled ? "đã huỷ" : s.shortageStatus === "filled" ? "đã đủ hàng" : qtyText(s.qtyMilli, l.baseUnit)}</span>
                      </div>))}
                  </div>)}
              </div>))}
            {costVisible && <div className="row between"><b>Tổng cộng</b><b className="money">{money(po.total)}</b></div>}
          </div>
        </Card>

        {(po.stockDocs.length > 0 || po.bills.length > 0) && (
          <Card title="Phiếu nhập & hoá đơn mua">
            <div className="stack small" style={{ gap: 4 }}>
              {po.stockDocs.map((x: any) => <div key={x.id} className="row between"><span>Phiếu nhập <b>{x.code}</b></span><span className="muted">{fmtDateTime(x.postedAt)}{costVisible && x.totalAmount != null ? ` · ${money(x.totalAmount)}` : ""}</span></div>)}
              {po.bills.map((b: any) => <div key={b.id} className="row between"><span>Hoá đơn mua <b>{b.code}</b></span><span>{money(b.total)} {b.provisional ? <Badge tone="warn">Tạm tính</Badge> : <Badge tone="ok">Đã chốt</Badge>}</span></div>)}
            </div>
          </Card>)}

        <div className="row wrap">
          {po.status === "draft" && can("purchasing.write") && <Button variant="soft" onClick={() => setMode("edit")}>Sửa nháp</Button>}
          {(po.status === "draft" || po.status === "pending_approval") && canApprove && (po.status === "draft" || can("purchasing.approve_high")) && <Button loading={busy === "approve"} onClick={() => call("approve", { version: po.version }, "Đã duyệt và gửi NCC")}>{approveTxt}</Button>}
          {po.status === "sent" && canApprove && <Button onClick={() => setMode("respond")}>Ghi nhận NCC phản hồi</Button>}
          {po.status === "supplier_proposed" && canApprove && <><Button loading={busy === "proposal/accept"} onClick={() => call("proposal/accept", { version: po.version }, "Đã chấp nhận đề xuất của NCC")}>Chấp nhận đề xuất</Button><Button variant="soft" onClick={() => setMode("reject_proposal")}>Từ chối đề xuất</Button></>}
          {["confirmed", "partially_received"].includes(po.status) && can("purchasing.write") && can("inventory.write") && <Button onClick={() => setMode("receive")}>Nhận hàng</Button>}
          {po.status === "partially_received" && canApprove && <Button variant="soft" onClick={() => setMode("close")}>Đóng PO (thiếu hàng)</Button>}
          {["draft", "pending_approval", "sent", "supplier_proposed", "confirmed"].includes(po.status) && (po.status === "draft" ? can("purchasing.write") : canApprove) && <Button variant="danger" onClick={() => setMode("cancel")}>Huỷ PO</Button>}
        </div>

        <Card title="Lịch sử">
          <ol className="timeline">
            {po.history.map((h: any, i: number) => <li key={i}><div className="row between"><b>{HISTORY[h.action] ?? h.action}</b><span className="small muted">{fmtDateTime(h.at)}</span></div><div className="small muted">{h.by ?? "Hệ thống"}{h.reason ? ` · ${h.reason}` : ""}</div></li>)}
          </ol>
        </Card>
      </div>
      {mode === "edit" && <PoForm po={po} onClose={() => setMode("")} onSaved={() => { setMode(""); reload(); }} />}
      {mode === "respond" && <RespondSheet po={po} onClose={() => setMode("")} onDone={() => { setMode(""); reload(); }} />}
      {mode === "reject_proposal" && <ReasonSheet title="Từ chối đề xuất của NCC" confirm="Từ chối đề xuất" onClose={() => setMode("")} onSubmit={async (reason) => { await post(`/purchase-orders/${id}/proposal/reject`, { version: po.version, reason }); toast("Đã từ chối đề xuất, PO về trạng thái đã gửi", "ok"); setMode(""); reload(); }} />}
      {mode === "cancel" && <ReasonSheet title={`Huỷ ${po.code}`} confirm="Huỷ PO" danger onClose={() => setMode("")} onSubmit={async (reason) => { await post(`/purchase-orders/${id}/cancel`, { reason, version: po.version }); toast("Đã huỷ PO", "ok"); setMode(""); reload(); }} />}
      {mode === "close" && <ReasonSheet title={`Đóng ${po.code}`} confirm="Đóng PO" onClose={() => setMode("")} onSubmit={async (reason) => { await post(`/purchase-orders/${id}/close`, { reason, version: po.version }); toast("Đã đóng PO, phần chưa về quay lại nhu cầu đặt hàng", "ok"); setMode(""); reload(); }}>
        <Banner tone="info">Phần chưa về sẽ được tính lại ở lần chốt đêm kế tiếp (hoặc bấm “Tính lại”).</Banner></ReasonSheet>}
      {mode === "receive" && <ReceivePoSheet poId={id} onClose={() => setMode("")} onDone={() => { reload(); }} />}
    </DetailPanel>
  );
}

function ReasonSheet({ title, confirm, danger, onClose, onSubmit, children }: { title: string; confirm: string; danger?: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<void>; children?: React.ReactNode }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={title} footer={<Button block variant={danger ? "danger" : "primary"} loading={busy} disabled={reason.trim().length < 3} onClick={async () => { setBusy(true); try { await onSubmit(reason.trim()); } catch { /* toast */ } finally { setBusy(false); } }}>{confirm}</Button>}>
      <div className="stack">{children}<TextArea label="Lý do" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ NCC phản hồi (ghi nhận hộ) */
function RespondSheet({ po, onClose, onDone }: { po: any; onClose: () => void; onDone: () => void }) {
  const costVisible = useCan()("prices.view_cost");
  const [action, setAction] = useState<"confirm" | "propose" | "reject">("confirm");
  const [date, setDate] = useState(po.expectedDate ?? ""), [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<number, number>>(() => Object.fromEntries(po.lines.map((l: any) => [l.id, l.qtyMilli / 1000])));
  const [cost, setCost] = useState<Record<number, number>>(() => Object.fromEntries(po.lines.map((l: any) => [l.id, l.unitCost ?? 0])));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const lines = action === "propose"
        ? po.lines.filter((l: any) => Math.round((qty[l.id] ?? 0) * 1000) !== l.qtyMilli || (costVisible && (cost[l.id] ?? 0) !== (l.unitCost ?? 0)))
            .map((l: any) => ({ lineId: l.id, qtyMilli: Math.round((qty[l.id] ?? 0) * 1000), ...(costVisible ? { unitCost: cost[l.id] ?? 0 } : {}) }))
        : undefined;
      await post(`/purchase-orders/${po.id}/supplier-response`, { action, version: po.version, expectedDate: date || null, note: note.trim() || null, ...(lines ? { lines } : {}) }, { silent: true });
      toast(action === "confirm" ? "Đã ghi nhận NCC xác nhận" : action === "propose" ? "Đã ghi nhận đề xuất của NCC" : "Đã ghi nhận NCC từ chối", "ok"); onDone();
    } catch (e) { toast(e instanceof ApiError ? e.message : "Không ghi nhận được", "error"); } finally { setBusy(false); }
  };
  const valid = action === "reject" ? note.trim().length >= 3 : action === "propose" ? (date !== (po.expectedDate ?? "") || po.lines.some((l: any) => Math.round((qty[l.id] ?? 0) * 1000) !== l.qtyMilli || (costVisible && (cost[l.id] ?? 0) !== (l.unitCost ?? 0)))) : true;
  return (
    <Sheet open wide onClose={onClose} title={`NCC phản hồi ${po.code}`} footer={<Button block loading={busy} disabled={!valid} onClick={submit}>Ghi nhận</Button>}>
      <div className="stack">
        <Banner tone="info">Dùng khi NCC trả lời qua điện thoại / Zalo. Khi có cổng NCC, phản hồi sẽ tự vào đây.</Banner>
        <Segmented value={action} onChange={setAction} options={[{ v: "confirm", label: "Xác nhận đủ" }, { v: "propose", label: "Đề xuất sửa" }, { v: "reject", label: "Từ chối" }]} />
        {action !== "reject" && <Input label="Ngày giao" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />}
        {action === "propose" && po.lines.map((l: any) => (
          <div key={l.id} className="card flat" style={{ padding: 12 }}>
            <b>{l.productName}</b> <span className="small muted">đặt {qtyText(l.qtyMilli, l.baseUnit)}</span>
            <div className="grid2" style={{ marginTop: 8 }}>
              <DecInput label={`Số lượng NCC giao (${unitLabel(l.baseUnit)})`} value={qty[l.id] ?? 0} onChange={(n) => setQty({ ...qty, [l.id]: n })} />
              {costVisible && <MoneyInput label={`Giá / ${unitLabel(l.baseUnit)}`} value={cost[l.id] ?? 0} onChange={(n) => setCost({ ...cost, [l.id]: n })} />}
            </div>
          </div>))}
        <TextArea label={action === "reject" ? "Lý do NCC từ chối" : "Ghi chú của NCC"} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ tạo / sửa PO nháp */
type FLine = { key: string; productId: number; name: string; baseUnit: string; units: { unit: string; factorMilli: number }[]; unit: string; qty: number; unitCost: number | null };
function PoForm({ po, preset, onClose, onSaved }: { po?: any; preset?: { supplier: { id: number; name: string }; lines: FLine[] }; onClose: () => void; onSaved: (id: number) => void }) {
  const costVisible = useCan()("prices.view_cost");
  const [supplier, setSupplier] = useState<{ id: number; name: string } | null>(po ? { id: po.supplierId, name: po.supplierName } : preset?.supplier ?? null);
  const [lines, setLines] = useState<FLine[]>(() => po
    ? po.lines.map((l: any) => ({ key: String(l.id), productId: l.productId, name: l.productName, baseUnit: l.baseUnit, units: [], unit: l.orderUnit, qty: l.orderQty, unitCost: l.unitCost }))
    : preset?.lines ?? []);
  const [date, setDate] = useState<string>(po?.expectedDate ?? ""), [note, setNote] = useState<string>(po?.note ?? "");
  const [pick, setPick] = useState(false), [busy, setBusy] = useState(false);
  const set = (k: string, patch: Partial<FLine>) => setLines((x) => x.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const add = (p: Prod) => {
    if (lines.some((l) => l.productId === p.id)) return toast("Mặt hàng đã có trong PO", "error");
    setLines((x) => [...x, { key: `n${p.id}`, productId: p.id, name: p.name, baseUnit: p.baseUnit, units: p.units ?? [], unit: p.baseUnit, qty: 1, unitCost: null }]);
  };
  const total = useMemo(() => lines.reduce((s, l) => {
    const f = l.unit === l.baseUnit ? 1000 : l.units.find((u) => u.unit === l.unit)?.factorMilli ?? 1000;
    return s + (l.unitCost == null ? 0 : Math.round((Math.round(l.qty * f) * l.unitCost) / 1000));
  }, 0), [lines]);
  const save = async () => {
    setBusy(true);
    try {
      const payload = lines.map((l) => ({ productId: l.productId, qty: l.qty, unit: l.unit, ...(costVisible && l.unitCost != null ? { unitCost: l.unitCost } : {}) }));
      if (po) { await put(`/purchase-orders/${po.id}`, { version: po.version, expectedDate: date || null, note: note.trim() || null, lines: payload }); toast("Đã lưu PO nháp", "ok"); onSaved(po.id); }
      else { const r = await post("/purchase-orders", { supplierId: supplier!.id, expectedDate: date || null, note: note.trim() || null, lines: payload }); toast(`Đã tạo ${r.code}`, "ok"); onSaved(r.id); }
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open wide onClose={onClose} title={po ? `Sửa ${po.code}` : "Tạo đơn đặt NCC"} footer={<Button block size="lg" loading={busy} disabled={!supplier || !lines.length || lines.some((l) => !(l.qty > 0))} onClick={save}>{po ? "Lưu" : "Tạo PO nháp"}</Button>}>
      <div className="stack">
        {po ? <div><b>{po.supplierName}</b></div> : <SupplierSelect value={supplier} onChange={setSupplier} />}
        <Input label="Ngày giao dự kiến" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />
        {lines.map((l) => (
          <div key={l.key} className="card flat" style={{ padding: 12 }}>
            <div className="row between"><b>{l.name}</b><Button size="sm" variant="ghost" aria-label={`Bỏ ${l.name}`} onClick={() => setLines((x) => x.filter((y) => y.key !== l.key))}>✕</Button></div>
            <div className="grid3" style={{ marginTop: 8 }}>
              <DecInput label="Số lượng" value={l.qty} onChange={(n) => set(l.key, { qty: n })} />
              <Select label="Đơn vị" value={l.unit} onChange={(e) => set(l.key, { unit: e.target.value })}>
                {[l.baseUnit, ...l.units.map((u) => u.unit).filter((u) => u !== l.baseUnit), ...(l.unit !== l.baseUnit && !l.units.some((u) => u.unit === l.unit) ? [l.unit] : [])].map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}
              </Select>
              {costVisible && <MoneyInput label={`Giá / ${unitLabel(l.baseUnit)}`} value={l.unitCost ?? 0} onChange={(n) => set(l.key, { unitCost: n || null })} hint={l.unitCost == null ? "Để trống = chưa có giá" : undefined} />}
            </div>
          </div>))}
        <Button variant="soft" onClick={() => setPick(true)}>+ Thêm mặt hàng</Button>
        {costVisible && lines.length > 0 && <div className="row between"><b>Tạm tính</b><b className="money">{money(total)}</b></div>}
        <TextArea label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <ProductPicker open={pick} onClose={() => setPick(false)} title="Chọn mặt hàng đặt" onPick={add} />
    </Sheet>
  );
}

/** Dùng từ màn Gợi ý đặt hàng: mở form tạo PO với sẵn các dòng đã chọn. */
export { PoForm };

/* ------------------------------------------------------------------ tab phần thiếu */
function Shortages() {
  const d = useAsync(() => get("/purchase-orders/shortages"), []);
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (d.loading && !d.data) return <Spinner />;
  const data = d.data;
  if (!data) return <EmptyState title="Không tải được phần thiếu" />;
  const items: any[] = data.items ?? [];
  const uncovered = items.filter((x) => x.uncoveredMilli > 0).length;
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="stack">
      <KpiRow items={[
        { label: "Mặt hàng đang thiếu", value: items.length, tone: items.length ? "warn" : undefined },
        { label: "Dòng đơn đang chờ hàng", value: data.summary?.lines ?? 0, tone: "info" },
        { label: "Chưa có PO phủ", value: uncovered, tone: uncovered ? "danger" : "ok" },
        { label: "Thiếu chưa có NCC", value: data.noSupplier?.length ?? 0, tone: data.noSupplier?.length ? "danger" : undefined },
      ]} />
      <div className="hint">Chốt đêm lúc <b>{data.cutoff?.time}</b> (giờ VN): đơn nhập tối nay đến trước giờ này thuộc ngày chốt <b>{ymd(data.cutoff?.windowDay)}</b>. Bấm <b>Chốt ngay</b> nếu đã nhập xong sớm.</div>
      {data.noSupplier?.length > 0 && <Banner tone="danger"><b>Thiếu chưa có nhà cung cấp:</b> {data.noSupplier.map((x: any) => `${x.name} (${q3(x.qtyMilli / 1000)})`).join(", ")}. Gắn NCC cho các sản phẩm này ở màn “Gợi ý đặt hàng” → “NCC theo sản phẩm”.</Banner>}
      {items.length === 0 ? <Card><EmptyState title="Không có phần thiếu" hint="Đơn sỉ / đơn online đặt trước thiếu hàng khi xác nhận sẽ hiện ở đây cho tới khi hàng về." /></Card> : items.map((p) => (
        <Card key={p.productId} title={p.name} actions={<span className="row" style={{ gap: 6 }}>
          {p.noSupplier ? <Badge tone="danger">Chưa có NCC</Badge> : <Badge>{p.supplier.supplierName}</Badge>}
          {p.uncoveredMilli > 0 ? <Badge tone="warn">Chưa phủ {qtyText(p.uncoveredMilli, p.baseUnit)}</Badge> : <Badge tone="ok">Đã có PO</Badge>}
        </span>}>
          <div className="row between"><span>Thiếu tổng <b>{qtyText(p.totalMilli, p.baseUnit)}</b> · {p.lines.length} dòng đơn</span><Button size="sm" variant="ghost" onClick={() => toggle(p.productId)}>{open.has(p.productId) ? "Thu gọn" : "Xem đơn"}</Button></div>
          {open.has(p.productId) && (
            <div className="stack" style={{ gap: 4, marginTop: 10 }}>
              {p.lines.map((l: any) => (
                <div key={l.shortageId} className="row between wrap small" style={{ background: "var(--surface-2)", borderRadius: 8, padding: "6px 10px" }}>
                  <span><b className="num">{l.orderCode}</b> · {l.customerName ?? CHANNEL[l.channel]} · {CHANNEL[l.channel] ?? l.channel}{l.needBy ? ` · giao ${ymd(l.needBy)}` : ""}{l.overdue && <> <Badge tone="danger">Quá hạn giao</Badge></>}</span>
                  <span className="row" style={{ gap: 6 }}><b>{qtyText(l.qtyMilli, p.baseUnit)}</b>{l.po.length ? l.po.map((x: any) => <a key={x.id} href={`/purchase-orders?open=${x.id}`} onClick={(e) => { e.preventDefault(); navigate(`/purchase-orders?open=${x.id}`); }}><Badge tone="info">{x.code}</Badge></a>) : <Badge tone="warn">Chưa có PO</Badge>}</span>
                </div>))}
            </div>)}
        </Card>))}
    </div>
  );
}
void num;
