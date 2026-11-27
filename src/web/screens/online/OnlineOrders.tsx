import { useEffect, useMemo, useState } from "react";
import { ApiError, get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../../components/ui";
import { toast } from "../../components/toast";
import { fmtDateTime, money, todayVN, unitLabel, uuid } from "../../format";
import { navigate, usePath } from "../../router";
import { useCan } from "../../store";
import { Back, Lnk, q3, waitLabel } from "../b2b/kit";
import { DateRangeFilter, DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, rangeOf, usePagedList, useWide, type DateRange } from "../../components/list";
import { CHANNEL_LABEL, PAY_METHOD, PAY_STATUS, STATUS_LABEL, TABS, WEIGHT_LABEL, statusTone, ymdShow } from "./kit";

export default function OnlineOrders() {
  const path = usePath();
  if (path === "/online-orders/new") return <NewSocialOrder />;
  const m = path.match(/^\/online-orders\/(\d+)/);
  return m ? <OrderDetail id={Number(m[1])} /> : <OrderList />;
}

/* ============================================================ danh sách */
const chLabel = (o: { channel: string; source?: string | null }) => (o.source === "pos" ? "Từ quầy" : CHANNEL_LABEL[o.channel] ?? o.channel);
const qs = (k: string) => { try { return new URLSearchParams(location.search).get(k) ?? ""; } catch { return ""; } };
function OrderList() {
  const [status, setStatus] = useState(qs("status") || "all");
  const [range, setRange] = useState<DateRange>(() => rangeOf("month"));
  const [slotDate, setSlotDate] = useState("");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const wide = useWide();
  const l = usePagedList<any>("/online-orders", { status: status === "all" ? undefined : status, slotDate, channel: channel === "pos" ? "all" : channel || "all", source: channel === "pos" ? "pos" : undefined, q, from: range.from, to: range.to, limit: 50 }, [status, slotDate, channel, q, range.from, range.to]);
  const counts: Record<string, number> = l.extra?.counts ?? {};
  const sum = l.extra?.summary;
  const cnt = (v: string) => counts[v.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
  const rows: any[] = l.rows;
  const dirty = !!(q || channel || slotDate || status !== "all");
  const reset = () => { setQ(""); setChannel(""); setSlotDate(""); setStatus("all"); };
  const rangeLabel = range.from === range.to ? ymdShow(range.from) : `${ymdShow(range.from)} – ${ymdShow(range.to)}`;
  const openRow = (o: any) => { if (wide) setSel(o.id); else navigate(`/online-orders/${o.id}`); };
  const pending = (counts.new ?? 0) + (counts.awaitingPayment ?? 0);
  return (
    <div className="stack">
      <PageHeader compact subtitle={<>Đặt từ {rangeLabel}{sum ? <> · {sum.count} đơn</> : null}</>}
        actions={<>
          <ExportButton filename={`don-online-${range.from}_${range.to}`} rows={rows} columns={[
            { label: "Mã đơn", value: (o) => o.code }, { label: "Thời gian", value: (o) => fmtDateTime(o.createdAt) }, { label: "Kênh", value: (o) => chLabel(o) }, { label: "Trạng thái", value: (o) => STATUS_LABEL[o.status] ?? o.status },
            { label: "Người nhận", value: (o) => o.receiverName }, { label: "SĐT", value: (o) => o.receiverPhone }, { label: "Khu vực", value: (o) => o.district ?? o.zoneName }, { label: "Ngày giao", value: (o) => o.slotDate },
            { label: "Thanh toán", value: (o) => `${PAY_METHOD[o.paymentMethod] ?? o.paymentMethod} · ${PAY_STATUS[o.paymentStatus] ?? o.paymentStatus}` }, { label: "Tổng", value: (o) => o.total },
          ]} />
          <Lnk to="/online-orders/new" className="btn">+ Tạo đơn mạng xã hội</Lnk>
        </>} />
      <div className="chips scroll" role="tablist" aria-label="Lọc theo trạng thái">
        {TABS.map(([v, label]) => (
          <button key={v} className="chip" role="tab" aria-pressed={status === v} onClick={() => setStatus(v)}>{label}{cnt(v) != null ? ` (${cnt(v)})` : ""}</button>
        ))}
      </div>
      <FilterBar dirty={dirty} onReset={reset} activeCount={[channel, slotDate].filter(Boolean).length} advanced={<>
        <FilterSelect label="Kênh" value={channel} onChange={setChannel} allLabel="Tất cả kênh" options={[{ v: "online", label: "Website" }, { v: "fresco", label: "Fresco" }, { v: "social", label: "Mạng xã hội" }, { v: "pos", label: "Từ quầy" }]} />
        <label className="field"><span className="lbl">Ngày giao</span><input className="input" type="date" aria-label="Ngày giao" value={slotDate} onChange={(e) => setSlotDate(e.target.value)} style={{ minHeight: 40 }} /></label>
      </>}>
        <DateRangeFilter value={range} onChange={setRange} presets={["today", "yesterday", "7d", "month", "lastMonth", "custom"]} />
        <SearchInput value={q} onSearch={setQ} placeholder="Mã đơn, tên, SĐT" label="Tìm" />
      </FilterBar>
      <KpiRow items={[
        { label: "Số đơn", value: sum ? sum.count : "—", sub: sum ? `${sum.cancelled} huỷ / trả` : undefined },
        { label: "Doanh thu đã hoàn tất", value: sum ? money(sum.revenue) : "—", tone: "ok" },
        { label: "Đang xử lý", value: sum ? money(sum.pipelineTotal) : "—", sub: "giá trị đơn chưa hoàn tất", tone: "info" },
        { label: "Chờ xác nhận / thanh toán", value: l.extra ? pending : "—", tone: pending ? "warn" : undefined, onClick: () => setStatus("new") },
      ]} />
      <SplitLayout open={sel != null && wide} panel={sel != null ? <OrderDetail key={sel} id={sel} panel={{ onClose: () => setSel(null), onChanged: l.reload }} /> : null}>
        {l.loading && !rows.length ? <Spinner /> : (
          <div data-testid="online-list">
            <DataTable rows={rows} rowKey={(o) => o.id} onRowClick={openRow} selectedKey={sel} hasMore={l.hasMore} loadingMore={l.loadingMore} onLoadMore={l.loadMore}
              footer={`Đang hiển thị ${rows.length}${sum ? ` / ${sum.count}` : ""} đơn`}
              emptyState={<EmptyState title={dirty ? "Không có đơn online nào khớp bộ lọc" : "Chưa có đơn online trong khoảng này"} hint="Đơn từ website, Fresco và mạng xã hội sẽ hiện ở đây."
                action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}<Lnk to="/online-orders/new" className="btn">+ Tạo đơn mạng xã hội</Lnk>{range.preset !== "lastMonth" && <Button variant="ghost" onClick={() => setRange(rangeOf("lastMonth"))}>Xem tháng trước</Button>}</div>} />}
              cols={[
                { key: "c", label: "Mã đơn", title: true, sort: (o) => o.code, render: (o) => <b className="num nw">{o.code}</b> },
                { key: "t", label: "Đặt lúc", hideBelow: 1600, sort: (o) => o.createdAt, render: (o) => <span className="nw">{fmtDateTime(o.createdAt)}</span> },
                { key: "r", label: "Người nhận", sort: (o) => o.receiverName ?? "", render: (o) => <span><span className="nw">{o.receiverName}</span><div className="small muted">{o.receiverPhone}</div></span> },
                { key: "ch", label: "Kênh", hideBelow: 1440, sort: (o) => chLabel(o), render: (o) => <span className="nw">{chLabel(o)}</span> },
                { key: "z", label: "Giao", sort: (o) => o.slotDate ?? "", render: (o) => <span>{o.slotDate ? `${ymdShow(o.slotDate)} ${o.slotLabel ?? ""}` : "Chưa hẹn"}<div className="small muted">{o.district ?? "—"}</div></span> },
                { key: "p", label: "Thanh toán", hideBelow: 1600, render: (o) => <Badge tone={o.paymentStatus === "paid" ? "ok" : "warn"}>{PAY_METHOD[o.paymentMethod] ?? o.paymentMethod} · {PAY_STATUS[o.paymentStatus] ?? o.paymentStatus}</Badge> },
                { key: "s", label: "Trạng thái", sort: (o) => o.status, render: (o) => (
                  <span className="row wrap st-badges" style={{ gap: 4 }}>
                    <Badge tone={statusTone(o.status)}>{STATUS_LABEL[o.status] ?? o.status}</Badge>
                    {o.isPreorder && <Badge tone="info">Đặt trước</Badge>}
                    {o.awaitingStock && <Badge tone="warn">{waitLabel(o.shortLines)}</Badge>}
                    {o.weightAdjustStatus === "pending_customer" && <Badge tone="warn">Chờ khách xác nhận cân</Badge>}
                    {o.needsRefund && <Badge tone="danger">Chờ hoàn tiền</Badge>}
                    {o.diffAmount > 0 && <Badge tone="warn">Thu thêm {money(o.diffAmount)}</Badge>}
                    {o.diffAmount < 0 && <Badge tone="danger">Hoàn {money(-o.diffAmount)}</Badge>}
                  </span>) },
                { key: "tt", label: "Tổng", num: true, sort: (o) => o.total, render: (o) => <span className="money">{money(o.total)}{o.estimated ? "*" : ""}</span> },
              ]} />
          </div>
        )}
      </SplitLayout>
    </div>
  );
}

/* ============================================================ chi tiết */
type Mode = "" | "pack" | "ship" | "fail" | "redeliver" | "return" | "cancel" | "paid";
function OrderDetail({ id, panel }: { id: number; panel?: { onClose: () => void; onChanged: () => void } }) {
  const can = useCan();
  const d = useAsync(() => get(`/online-orders/${id}`), [id]);
  const [data, setData] = useState<any>(null);
  const o = data ?? d.data;
  const [mode, setMode] = useState<Mode>("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setData(null), [id]);
  if (d.loading && !o) return panel ? <DetailPanel title="Đơn online" onClose={panel.onClose}><Spinner /></DetailPanel> : <Spinner />;
  if (!o) return panel ? <DetailPanel title="Đơn online" onClose={panel.onClose}><EmptyState title="Không tìm thấy đơn" /></DetailPanel> : <div className="stack"><Back to="/online-orders" label="Đơn online" /><EmptyState title="Không tìm thấy đơn" /></div>;

  const run = async (path: string, body: unknown, okMsg: string) => {
    setBusy(true);
    try { const r = await post(`/online-orders/${id}/${path}`, body ?? {}); setData(r); setMode(""); toast(okMsg, "ok"); panel?.onChanged(); return r; }
    catch { return null; } finally { setBusy(false); }
  };
  const st = o.status as string;
  const needsPay = (o.paymentMethod === "transfer" || o.paymentMethod === "gateway") && o.paymentStatus !== "paid";
  const weightBlock = o.weightAdjustStatus === "pending_customer" || o.weightAdjustStatus === "rejected";
  const shipBlocked: string[] = [];
  if (needsPay) shipBlocked.push("Đơn chuyển khoản chưa nhận được tiền — hãy xác nhận đã nhận tiền trước.");
  if (weightBlock) shipBlocked.push(o.weightAdjustStatus === "rejected" ? "Khách từ chối khối lượng thực cân." : "Đang chờ khách xác nhận khối lượng thực cân.");
  const canCancel = ["awaiting_payment", "new", "confirmed", "preparing"].includes(st);
  const needsRefund = o.refundDue > 0;
  const Act = ({ children, ...p }: any) => <Button size="lg" loading={busy && !mode} {...p}>{children}</Button>;

  const body = (
    <div className="stack">
      {!panel && <Back to="/online-orders" label="Đơn online" />}
      {!panel ? (
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0 }} className="num">{o.code}</h2>
            <div className="muted small">{chLabel(o)} · tạo {fmtDateTime(o.createdAt)}</div>
          </div>
          <Badge tone={statusTone(st)}>{STATUS_LABEL[st] ?? st}</Badge>
        </div>
      ) : (
        <div className="row between wrap"><span className="muted small">{chLabel(o)} · tạo {fmtDateTime(o.createdAt)}</span><Badge tone={statusTone(st)}>{STATUS_LABEL[st] ?? st}</Badge></div>
      )}
      <div className="row wrap" style={{ gap: 6 }}>
        <Badge tone={o.paymentStatus === "paid" ? "ok" : "warn"}>{PAY_METHOD[o.paymentMethod] ?? o.paymentMethod} · {PAY_STATUS[o.paymentStatus] ?? o.paymentStatus}</Badge>
        {o.isPreorder && <Badge tone="info">Đặt trước</Badge>}
        {o.awaitingStock && <Badge tone="warn">Chờ hàng về</Badge>}
        {WEIGHT_LABEL[o.weightAdjustStatus] && <Badge tone={weightBlock ? "warn" : "info"}>{WEIGHT_LABEL[o.weightAdjustStatus]}</Badge>}
        {needsRefund && <Badge tone="danger">Chờ hoàn tiền</Badge>}
      </div>

      {o.awaitingStock && ["confirmed", "preparing"].includes(st) && <Banner>Đơn đặt trước đang <b>chờ hàng về</b> ({o.lines.filter((l: any) => l.shortMilli > 0).map((l: any) => `${l.name} thiếu ${q3(l.shortMilli / 1000)} ${unitLabel(l.baseUnit)}`).join("; ")}). Chưa soạn / giao được tới khi hàng về đủ — hệ thống tự giữ hàng khi nhận theo đơn đặt NCC.</Banner>}
      {shipBlock(st, shipBlocked)}
      {o.diffKind === "collect" && <Banner tone="info">Thu thêm {money(o.diffAmount)}: khách đã chuyển khoản theo giá tạm tính, sau cân tổng cao hơn — thu phần chênh khi giao (ghi nhận khi bấm "Đã giao").</Banner>}
      {o.diffKind === "refund" && <Banner tone="danger">Hoàn lại {money(-o.diffAmount)}: sau cân tổng thấp hơn số khách đã chuyển. Cần hoàn phần dư hoặc miễn (người có quyền duyệt) trước khi hoàn tất đơn.</Banner>}
      {o.diffStatus === "waived" && <Banner>Đã miễn khoản chênh lệch cân: {o.diffNote}</Banner>}
      {o.returnedTotal > 0 && <Banner>Đã trả hàng {money(o.returnedTotal)}{o.fullyReturned ? " (trả hết)" : ""} — {(o.returns ?? []).map((r: any) => r.code).join(", ")}</Banner>}
      {needsRefund && <Banner tone="danger">Chờ hoàn {money(o.refundDue)} cho khách (đơn {STATUS_LABEL[st].toLowerCase()}). {can("finance.write") ? "Bấm “Hoàn tiền” để ghi chi quỹ." : "Chỉ kế toán/quản lý (quyền ghi sổ quỹ) mới hoàn tiền thực tế."}</Banner>}

      <div className="row wrap action-bar" data-testid="action-bar">
        {st === "new" && <Act onClick={() => run("confirm", {}, "Đã xác nhận đơn")}>Xác nhận</Act>}
        {st === "confirmed" && <Act disabled={!!o.awaitingStock} onClick={() => run("prepare", {}, "Bắt đầu soạn hàng")}>Bắt đầu soạn</Act>}
        {st === "preparing" && <Act variant="soft" onClick={() => setMode("pack")}>Cân &amp; đóng gói</Act>}
        {st === "preparing" && <Act disabled={shipBlocked.length > 0} onClick={() => setMode("ship")}>Giao cho shipper</Act>}
        {st === "shipping" && <Act onClick={() => run("deliver", {}, "Đã giao hàng")}>Đã giao</Act>}
        {st === "shipping" && <Act variant="danger" onClick={() => setMode("fail")}>Giao thất bại</Act>}
        {st === "delivery_failed" && <Act onClick={() => setMode("redeliver")}>Giao lại</Act>}
        {(st === "delivery_failed" || (st === "completed" && !o.fullyReturned)) && <Act variant="soft" onClick={() => setMode("return")}>{st === "completed" ? "Trả hàng" : "Hoàn kho"}</Act>}
        {needsPay && !["cancelled", "returned", "completed"].includes(st) && can("finance.write") && <Act variant="soft" onClick={() => setMode("paid")}>Xác nhận đã nhận tiền</Act>}
        {st === "preparing" && o.weightAdjustStatus === "pending_customer" && <Act variant="soft" onClick={() => { const reason = window.prompt("Khách đã đồng ý giá theo khối lượng thực tế qua điện thoại. Ghi lý do / người xác nhận (bắt buộc, tối thiểu 5 ký tự):"); if (reason && reason.trim().length >= 5) run("weight-override", { reason: reason.trim() }, "Đã ghi nhận khách đồng ý lệch cân"); }}>Khách đồng ý qua điện thoại</Act>}
        {o.diffKind === "refund" && o.diffStatus === "pending" && can("finance.write") && <Act variant="danger" onClick={async () => { const r = await run("refund-diff", {}, "Đã hoàn phần chênh lệch"); if (r?.result?.refund) toast(`Đã hoàn ${money(r.result.refund)}`, "ok"); }}>Hoàn lại {money(-o.diffAmount)}</Act>}
        {o.diffStatus === "pending" && can("finance.approve") && <Act variant="soft" onClick={() => { const reason = window.prompt("Lý do miễn khoản chênh lệch (bắt buộc):"); if (reason && reason.trim().length >= 3) run("waive-diff", { reason: reason.trim() }, "Đã miễn chênh lệch"); }}>Miễn chênh lệch</Act>}
        {needsRefund && can("finance.write") && <Act variant="danger" onClick={async () => { const r = await run("refund", {}, "Đã hoàn tiền"); if (r?.result?.refund) toast(`Đã hoàn ${money(r.result.refund)}`, "ok"); }}>Hoàn tiền {money(o.refundDue)}</Act>}
        {canCancel && <Act variant="danger" onClick={() => setMode("cancel")}>Huỷ đơn</Act>}
        <Button variant="ghost" onClick={() => window.print()}>In phiếu soạn</Button>
      </div>

      <Card title="Giao nhận">
        <div className="stack" style={{ gap: 4 }}>
          <div><b>{o.receiverName}</b> · {o.receiverPhone}</div>
          <div>{o.shipAddress}</div>
          <div className="small muted">{o.zone?.name ? `Khu vực ${o.zone.name} · ` : ""}{o.slotDate ? `Giao ${ymdShow(o.slotDate)} ${o.slot?.label ?? ""}` : "Chưa hẹn giờ giao"}</div>
          {o.source === "pos" && <div className="small" data-testid="pos-origin"><Badge tone="info">Từ quầy</Badge> Đơn giao hàng tạo tại quầy (ca #{o.posShiftId ?? "—"}), hàng đã đóng gói tại quầy</div>}
          {(o.carrier || o.carrierTrackingNo) && <div className="small" data-testid="carrier-info">{o.delivererUserId ? "Người giao" : "Vận chuyển"}: {o.carrier ?? "—"}{o.delivererUserId ? "" : <> · Mã vận đơn: <span className="num">{o.carrierTrackingNo ?? "—"}</span></>}</div>}
          {o.note && <div className="small">Ghi chú khách: {o.note}</div>}
          {o.cancelReason && <div className="small" style={{ color: "var(--danger)" }}>Lý do huỷ: {o.cancelReason}</div>}
        </div>
      </Card>

      <Card title="Hàng hoá">
        <div className="stack" data-testid="order-lines">
          {o.lines.map((l: any) => {
            const ord = l.orderedQtyMilli / 1000, act = l.qtyMilli / 1000, changed = l.orderedQtyMilli !== l.qtyMilli;
            return (
              <div key={l.id} className="card flat" style={{ padding: 12 }}>
                <div className="row between"><b>{l.name}</b><span className="money">{money(l.lineTotal)}</span></div>
                <div className="small muted">{money(l.unitPrice)}/{unitLabel(l.baseUnit)}{l.preorderMilli ? ` · đặt trước ${q3(l.preorderMilli / 1000)}` : ""}{l.shortMilli > 0 ? <> · <b style={{ color: "var(--warn)" }}>chờ hàng {q3(l.shortMilli / 1000)}</b>{l.poCode ? ` (${l.poCode}${l.poExpectedDate ? `, về ${ymdShow(l.poExpectedDate)}` : ""})` : ""}</> : null}</div>
                <div className="small">Đặt {q3(ord)} {unitLabel(l.baseUnit)}{changed && <> → <b>cân thực {q3(act)} {unitLabel(l.baseUnit)}</b></>}</div>
                {l.lots.length > 0 && (
                  <div className="stack" style={{ gap: 2, marginTop: 6 }}>
                    {l.lots.map((x: any, i: number) => (
                      <div key={i} className="row between small" style={{ background: "var(--surface-2)", borderRadius: 8, padding: "4px 10px" }}>
                        <span className="num">{x.lotCode}</span><span>{q3(x.qtyMilli / 1000)} {unitLabel(l.baseUnit)} · {x.kind === "shipped" ? "đã xuất" : "đang giữ"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="totals stack" style={{ gap: 2 }}>
            <div className="row between"><span className="muted">Tạm tính</span><span className="money">{money(o.subtotal)}</span></div>
            {o.discount > 0 && <div className="row between"><span className="muted">Giảm giá</span><span className="money">-{money(o.discount)}</span></div>}
            <div className="row between"><span className="muted">Phí giao</span><span className="money">{money(o.shippingFee)}</span></div>
            <div className="row between"><b>Tổng cộng</b><b className="money">{money(o.total)}</b></div>
            {o.estimatedTotal != null && o.estimatedTotal !== o.total && <div className="small muted">Ước tính ban đầu {money(o.estimatedTotal)}</div>}
          </div>
        </div>
      </Card>

      {(o.paymentIntents.length > 0 || o.payments.length > 0) && (
        <Card title="Thanh toán">
          <div className="stack small" style={{ gap: 4 }}>
            {o.paymentIntents.map((i: any) => <div key={"i" + i.id} className="row between"><span>Yêu cầu {i.provider} <span className="num">{i.transferContent ?? ""}</span></span><span>{money(i.amount)} · {i.status}</span></div>)}
            {o.payments.map((p: any) => <div key={"p" + p.id} className="row between"><span>Thu {PAY_METHOD[p.method] ?? p.method} <span className="num muted">{p.ref ?? ""}</span></span><span>{money(p.amount)} · {p.status}</span></div>)}
          </div>
        </Card>
      )}

      <Card title="Lịch sử">
        <ol className="timeline" data-testid="timeline">
          {[...o.events].reverse().map((e: any) => (
            <li key={e.id}>
              <div className="row between"><b>{e.statusLabel}</b><span className="small muted">{fmtDateTime(e.at)}</span></div>
              {e.note && <div className="small">{e.note}</div>}
              {e.internalNote && <div className="internal-note"><Badge tone="warn">Nội bộ</Badge> {e.internalNote}</div>}
              <div className="small muted">{e.actorType === "staff" ? "Nhân viên" : e.actorType === "customer" ? "Khách" : "Hệ thống"}</div>
            </li>
          ))}
        </ol>
      </Card>

      <PackingSlip o={o} />

      {mode === "pack" && <PackSheet o={o} busy={busy} onClose={() => setMode("")} onSubmit={async (lines, note) => { const r = await run("pack", { lines, ...(note ? { note } : {}) }, "Đã cân & đóng gói"); if (r?.result?.weightAdjustStatus === "pending_customer") toast("Lệch cân vượt dung sai — chờ khách xác nhận", "info"); }} />}
      {mode === "ship" && <ShipSheet busy={busy} onClose={() => setMode("")} onSubmit={(b) => run("ship", b, "Đã giao cho shipper")} />}
      {mode === "fail" && <ReasonSheet title="Giao thất bại" label="Lý do giao thất bại" cta="Xác nhận thất bại" danger busy={busy} onClose={() => setMode("")} onSubmit={(reason) => run("fail", { reason }, "Đã ghi nhận giao thất bại")} />}
      {mode === "cancel" && <ReasonSheet title="Huỷ đơn" label="Lý do huỷ" cta="Xác nhận huỷ đơn" danger busy={busy} note={st === "preparing" ? "Hàng đã soạn sẽ được trả về kho đúng lô." : "Hàng đang giữ sẽ được nhả."} onClose={() => setMode("")} onSubmit={(reason) => run("cancel", { reason }, "Đã huỷ đơn")} />}
      {mode === "redeliver" && <RedeliverSheet busy={busy} onClose={() => setMode("")} onSubmit={(b) => run("redeliver", b, "Đã lên lịch giao lại")} />}
      {mode === "return" && <ReturnSheet o={o} busy={busy} onClose={() => setMode("")} onSubmit={(lines) => run("return-to-stock", { lines }, "Đã hoàn kho")} />}
      {mode === "paid" && <PaidSheet o={o} busy={busy} onClose={() => setMode("")} onSubmit={(b) => run("mark-paid", b, "Đã xác nhận nhận tiền")} />}
    </div>
  );
  return panel ? <DetailPanel title={`Đơn ${o.code}`} onClose={panel.onClose}>{body}</DetailPanel> : body;
}
const shipBlock = (st: string, reasons: string[]) => (st === "preparing" && reasons.length > 0 ? <Banner>{reasons.map((r) => <div key={r}>⚠ Chưa thể giao: {r}</div>)}</Banner> : null);

function PackingSlip({ o }: { o: any }) {
  return (
    <div className="print-area slip slip-only">
      <h2>Phiếu soạn hàng {o.code}</h2>
      <div>{o.receiverName} · {o.receiverPhone}</div>
      <div>{o.shipAddress}</div>
      <div>Giao: {o.slotDate ? `${ymdShow(o.slotDate)} ${o.slot?.label ?? ""}` : "—"} · {PAY_METHOD[o.paymentMethod] ?? o.paymentMethod} · {PAY_STATUS[o.paymentStatus] ?? o.paymentStatus}</div>
      <table>
        <thead><tr><th>Mặt hàng</th><th>Đặt</th><th>Thực cân</th><th>Lô</th></tr></thead>
        <tbody>{o.lines.map((l: any) => <tr key={l.id}><td>{l.name}</td><td>{q3(l.orderedQtyMilli / 1000)} {unitLabel(l.baseUnit)}</td><td>______</td><td>{l.lots.map((x: any) => x.lotCode).join(", ")}</td></tr>)}</tbody>
      </table>
      <div>Tổng: {money(o.total)}{o.paymentMethod === "cod" ? " — thu khi giao" : ""}</div>
      {o.note && <div>Ghi chú: {o.note}</div>}
    </div>
  );
}

/* ---- cân & đóng gói ---- */
function PackSheet({ o, busy, onClose, onSubmit }: { o: any; busy: boolean; onClose: () => void; onSubmit: (lines: any[], note: string) => void }) {
  const [act, setAct] = useState<Record<number, number | "">>(() => Object.fromEntries(o.lines.map((l: any) => [l.id, l.qtyMilli / 1000])));
  const [note, setNote] = useState("");
  const tolBp: number = o.weightToleranceBp ?? 1000; // ngưỡng lệch cân trả kèm chi tiết đơn
  const calc = useMemo(() => {
    let base = 0, sub = 0;
    for (const l of o.lines) { base += Math.round((l.unitPrice * l.orderedQtyMilli) / 1000); sub += Math.round((l.unitPrice * Math.round(Number(act[l.id] || 0) * 1000)) / 1000); }
    const bp = base > 0 ? Math.round((Math.abs(sub - base) * 10000) / base) : 0;
    return { base, sub, bp, signed: base > 0 ? ((sub - base) / base) * 100 : 0 };
  }, [act, o.lines]);
  const over = calc.bp > tolBp;
  const valid = o.lines.every((l: any) => act[l.id] !== "" && Number(act[l.id]) >= 0);
  return (
    <Sheet open onClose={onClose} wide title="Cân & đóng gói" footer={<Button block loading={busy} disabled={!valid} onClick={() => onSubmit(o.lines.map((l: any) => ({ orderLineId: l.id, actualQty: Number(act[l.id]), unit: l.baseUnit })), note.trim())}>Lưu số cân</Button>}>
      <div className="stack">
        {o.lines.map((l: any) => {
          const ord = l.orderedQtyMilli / 1000, a = Number(act[l.id] || 0), dv = ord > 0 ? ((a - ord) / ord) * 100 : 0;
          return (
            <div key={l.id} className="card flat" style={{ padding: 12 }} data-testid="pack-line">
              <div className="row between"><b>{l.name}</b><span className="small muted">Đặt {q3(ord)} {unitLabel(l.baseUnit)}</span></div>
              <DecInput label={`Thực cân (${unitLabel(l.baseUnit)})`} value={act[l.id]} onChange={(n) => setAct((x) => ({ ...x, [l.id]: n }))} />
              <div className="small" style={{ marginTop: 6, color: Math.abs(dv) * 100 > tolBp ? "var(--warn)" : "var(--muted)" }}>Lệch {dv >= 0 ? "+" : ""}{dv.toFixed(1).replace(".", ",")}%</div>
            </div>
          );
        })}
        <div className="card flat" data-testid="pack-total">
          <div className="row between"><span className="muted">Giá trị theo đặt</span><span className="money">{money(calc.base)}</span></div>
          <div className="row between"><span className="muted">Giá trị theo cân</span><b className="money">{money(calc.sub)}</b></div>
          <div className="row between"><span className="muted">Lệch tổng (dung sai {(tolBp / 100).toFixed(0)}%)</span><b style={{ color: over ? "var(--warn)" : "var(--accent)" }}>{calc.signed >= 0 ? "+" : ""}{calc.signed.toFixed(1).replace(".", ",")}%</b></div>
        </div>
        {over ? <Banner>Lệch vượt dung sai: khách sẽ phải xác nhận lại khối lượng. Chưa giao được cho tới khi khách đồng ý.</Banner> : <Banner tone="info">Trong dung sai — tự chấp nhận, có thể giao ngay.</Banner>}
        <TextArea label="Ghi chú nội bộ (tuỳ chọn)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Sheet>
  );
}

function ShipSheet({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (b: any) => void }) {
  const [carrier, setCarrier] = useState(""), [tracking, setTracking] = useState("");
  return (
    <Sheet open onClose={onClose} title="Giao cho shipper" footer={<Button block loading={busy} onClick={() => onSubmit({ ...(carrier.trim() ? { carrier: carrier.trim() } : {}), ...(tracking.trim() ? { trackingNo: tracking.trim() } : {}) })}>Xác nhận giao đi</Button>}>
      <div className="stack">
        <Banner tone="info">Hàng sẽ được xuất kho theo số thực cân.</Banner>
        <Input label="Đơn vị vận chuyển / shipper" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
        <Input label="Mã vận đơn" value={tracking} onChange={(e) => setTracking(e.target.value)} />
      </div>
    </Sheet>
  );
}

function ReasonSheet({ title, label, cta, danger, busy, note, onClose, onSubmit }: { title: string; label: string; cta: string; danger?: boolean; busy: boolean; note?: string; onClose: () => void; onSubmit: (r: string) => void }) {
  const [r, setR] = useState("");
  return (
    <Sheet open onClose={onClose} title={title} footer={<Button block variant={danger ? "danger" : undefined} loading={busy} disabled={r.trim().length < 3} onClick={() => onSubmit(r.trim())}>{cta}</Button>}>
      <div className="stack">{note && <Banner tone="info">{note}</Banner>}<TextArea label={label} value={r} onChange={(e) => setR(e.target.value)} /></div>
    </Sheet>
  );
}

function RedeliverSheet({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (b: any) => void }) {
  const slots = useAsync(() => get("/delivery-slots").then((r) => items<any>(r).filter((s) => s.active)), []);
  const [date, setDate] = useState(todayVN(1)), [slotId, setSlotId] = useState<number | "">("");
  return (
    <Sheet open onClose={onClose} title="Giao lại" footer={<Button block loading={busy} disabled={!slotId || !date} onClick={() => onSubmit({ slotDate: date, slotId: Number(slotId) })}>Đặt lịch giao lại</Button>}>
      <div className="stack">
        <Input label="Ngày giao" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />
        <Select label="Khung giờ" value={slotId} onChange={(e) => setSlotId(Number(e.target.value) || "")}>
          <option value="">Chọn khung giờ…</option>
          {(slots.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.label} ({s.startTime}–{s.endTime})</option>)}
        </Select>
        <div className="hint">Hàng vẫn ở shipper/kho; đơn quay về "Đã xác nhận".</div>
      </div>
    </Sheet>
  );
}

function ReturnSheet({ o, busy, onClose, onSubmit }: { o: any; busy: boolean; onClose: () => void; onSubmit: (lines: any[]) => void }) {
  const [restock, setRestock] = useState<Record<number, boolean>>(() => Object.fromEntries(o.lines.map((l: any) => [l.id, true])));
  const [reason, setReason] = useState("");
  return (
    <Sheet open onClose={onClose} wide title="Hoàn kho" footer={<Button block loading={busy} disabled={reason.trim().length < 2} onClick={() => onSubmit(o.lines.map((l: any) => ({ orderLineId: l.id, qty: l.qtyMilli / 1000, unit: l.baseUnit, restock: !!restock[l.id], reason: reason.trim() })))}>Xác nhận hoàn kho</Button>}>
      <div className="stack">
        <Banner tone="info">Chọn hàng còn đủ độ tươi để nhập lại đúng lô. Hàng không nhập lại sẽ tính hao hụt. Nếu khách đã trả tiền, hệ thống hoàn tiền.</Banner>
        {o.lines.map((l: any) => (
          <label key={l.id} className="card flat row between" style={{ padding: 12, minHeight: 56 }}>
            <span><b>{l.name}</b><br /><span className="small muted">{q3(l.qtyMilli / 1000)} {unitLabel(l.baseUnit)}</span></span>
            <span className="row" style={{ gap: 8 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={!!restock[l.id]} onChange={(e) => setRestock((x) => ({ ...x, [l.id]: e.target.checked }))} aria-label={`Nhập lại kho ${l.name}`} /> Nhập lại kho</span>
          </label>
        ))}
        <TextArea label="Lý do hoàn kho" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Sheet>
  );
}

function PaidSheet({ o, busy, onClose, onSubmit }: { o: any; busy: boolean; onClose: () => void; onSubmit: (b: any) => void }) {
  const txns = useAsync(() => get("/bank-transactions", { status: "unmatched", limit: 50 }, { silent: true }).then((r) => items<any>(r)).catch(() => [] as any[]), []);
  const [sel, setSel] = useState<number | null>(null), [ref, setRef] = useState("");
  const list = [...(txns.data ?? [])].sort((a, b) => Number(b.amount === o.total) - Number(a.amount === o.total));
  return (
    <Sheet open onClose={onClose} wide title="Xác nhận đã nhận tiền" footer={<Button block loading={busy} disabled={!sel && ref.trim().length < 3} onClick={() => onSubmit(sel ? { bankTxnId: sel } : { ref: ref.trim() })}>Xác nhận đã nhận {money(o.total)}</Button>}>
      <div className="stack">
        <div className="small muted">Chọn giao dịch ngân hàng chưa khớp có đúng số tiền {money(o.total)}, hoặc nhập mã giao dịch.</div>
        {txns.loading ? <Spinner /> : list.length === 0 ? <div className="hint">Không có giao dịch chưa khớp.</div> : (
          <div className="stack" role="listbox" aria-label="Giao dịch ngân hàng chưa khớp" style={{ gap: 6 }}>
            {list.map((t) => (
              <button key={t.id} role="option" aria-selected={sel === t.id} className="dt-card" disabled={t.amount !== o.total} onClick={() => setSel(sel === t.id ? null : t.id)} style={{ borderColor: sel === t.id ? "var(--accent)" : undefined, borderWidth: sel === t.id ? 2 : undefined }}>
                <div className="row between"><b className="money">{money(t.amount)}</b><span className="small muted">{t.date ?? t.txnDate ?? ""}</span></div>
                <div className="small truncate">{t.description}</div>
                {t.amount !== o.total && <div className="small muted">Số tiền không khớp tổng đơn</div>}
              </button>
            ))}
          </div>
        )}
        <Input label="Hoặc nhập mã giao dịch / tham chiếu" value={ref} disabled={!!sel} onChange={(e) => setRef(e.target.value)} />
      </div>
    </Sheet>
  );
}

/* ============================================================ tạo đơn mạng xã hội */
type Item = { productId: number; name: string; baseUnit: string; units: string[]; unit: string; qty: number | "" };
function NewSocialOrder() {
  const zones = useAsync(() => get("/delivery-zones").then((r) => items<any>(r).filter((z) => z.active)), []);
  const slots = useAsync(() => get("/delivery-slots").then((r) => items<any>(r).filter((s) => s.active)), []);
  const [f, setF] = useState({ receiverName: "", receiverPhone: "", addressLine: "", district: "", ward: "", note: "", paymentMethod: "cod", slotDate: "", slotId: "" as number | "", shippingFee: "" as number | "", acceptPreorder: false });
  const [lines, setLines] = useState<Item[]>([]);
  const [q, setQ] = useState(""); const dq = useDebounced(q);
  const prods = useAsync(() => (dq.trim().length < 1 ? Promise.resolve([] as any[]) : get("/products", { q: dq, limit: 8 }).then((r) => items<any>(r))), [dq]);
  const [busy, setBusy] = useState(false);
  const [cid] = useState(uuid());
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const districts = [...new Set((zones.data ?? []).flatMap((z: any) => z.districts as string[]))];
  const ok = f.receiverName.trim() && f.receiverPhone.trim().length >= 8 && f.addressLine.trim().length >= 3 && f.district.trim() && lines.length > 0 && lines.every((l) => Number(l.qty) > 0) && (!!f.slotDate === !!f.slotId);
  const submit = async () => {
    setBusy(true);
    try {
      const o = await post("/online-orders", {
        clientUuid: cid, receiverName: f.receiverName.trim(), receiverPhone: f.receiverPhone.trim(), addressLine: f.addressLine.trim(), district: f.district.trim(),
        ...(f.ward.trim() ? { ward: f.ward.trim() } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}),
        paymentMethod: f.paymentMethod, ...(f.slotDate && f.slotId ? { slotDate: f.slotDate, slotId: Number(f.slotId) } : {}),
        ...(f.shippingFee !== "" ? { shippingFee: Number(f.shippingFee) } : {}), ...(f.acceptPreorder ? { acceptPreorder: true } : {}),
        items: lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: Number(l.qty) })),
      });
      toast(`Đã tạo đơn ${o.code}`, "ok"); navigate(`/online-orders/${o.id}`);
    } catch (e) { if (!(e instanceof ApiError)) throw e; } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Back to="/online-orders" label="Đơn online" />
      <Card title="Khách nhận hàng">
        <div className="stack">
          <div className="grid2"><Input label="Tên người nhận" value={f.receiverName} onChange={(e) => set("receiverName", e.target.value)} /><Input label="Số điện thoại" inputMode="tel" value={f.receiverPhone} onChange={(e) => set("receiverPhone", e.target.value)} /></div>
          <Input label="Địa chỉ (số nhà, đường)" value={f.addressLine} onChange={(e) => set("addressLine", e.target.value)} />
          <div className="grid2"><Input label="Phường/xã" value={f.ward} onChange={(e) => set("ward", e.target.value)} /><Input label="Quận/huyện" list="dl-districts" value={f.district} onChange={(e) => set("district", e.target.value)} /></div>
          <datalist id="dl-districts">{districts.map((d) => <option key={d} value={d} />)}</datalist>
        </div>
      </Card>
      <Card title="Hàng đặt">
        <div className="stack">
          {lines.map((l, i) => (
            <div key={l.productId} className="card flat" style={{ padding: 12 }} data-testid="social-line">
              <div className="row between"><b>{l.name}</b><Button size="sm" variant="ghost" aria-label={`Bỏ ${l.name}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</Button></div>
              <div className="grid2">
                <DecInput label={`Số lượng (${l.name})`} value={l.qty} onChange={(n) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: n } : x)))} />
                <Select label="Đơn vị" value={l.unit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}>{l.units.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}</Select>
              </div>
            </div>
          ))}
          <Input label="Thêm hàng" type="search" placeholder="Tìm tên / SKU" value={q} onChange={(e) => setQ(e.target.value)} />
          {(prods.data ?? []).map((p: any) => (
            <button key={p.id} className="dt-card" aria-label={`Chọn ${p.name}`} onClick={() => { if (!lines.some((x) => x.productId === p.id)) setLines([...lines, { productId: p.id, name: p.name, baseUnit: p.baseUnit, units: [...new Set([p.baseUnit, ...(p.units ?? []).map((u: any) => u.unit)])] as string[], unit: p.baseUnit, qty: 1 }]); setQ(""); }}>
              <div className="row between"><b>{p.name}</b><span className="muted small">{p.sku}</span></div>
            </button>
          ))}
        </div>
      </Card>
      <Card title="Thanh toán & giao hàng">
        <div className="stack">
          <Select label="Thanh toán" value={f.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)}><option value="cod">COD (thu khi giao)</option><option value="transfer">Chuyển khoản (chờ tiền về)</option></Select>
          <div className="grid2">
            <Input label="Ngày giao" type="date" min={todayVN()} value={f.slotDate} onChange={(e) => set("slotDate", e.target.value)} />
            <Select label="Khung giờ" value={f.slotId} onChange={(e) => set("slotId", Number(e.target.value) || "")}><option value="">Chưa hẹn</option>{(slots.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
          </div>
          <Input label="Phí giao (để trống: theo khu vực)" inputMode="numeric" value={f.shippingFee === "" ? "" : String(f.shippingFee)} onChange={(e) => set("shippingFee", e.target.value.replace(/\D/g, "") === "" ? "" : Number(e.target.value.replace(/\D/g, "")))} />
          <TextArea label="Ghi chú" value={f.note} onChange={(e) => set("note", e.target.value)} />
          <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.acceptPreorder} onChange={(e) => set("acceptPreorder", e.target.checked)} /> Chấp nhận đặt trước khi thiếu hàng</label>
        </div>
      </Card>
      <Button size="lg" block loading={busy} disabled={!ok} onClick={submit}>Tạo đơn</Button>
    </div>
  );
}
