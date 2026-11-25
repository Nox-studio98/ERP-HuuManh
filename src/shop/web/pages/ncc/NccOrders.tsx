import { useState, type FormEvent } from "react";
import { ApiError, errMsg } from "../../lib/api";
import { fmtDate, fmtDateTime, money, num, parseDec, todayVN } from "../../lib/format";
import { nccApi, qtyKg, STATUS_LABEL, STATUS_TONE, type NccLine, type NccOrder, type NccOrderDetail } from "../../lib/ncc";
import { Link, usePageMeta } from "../../lib/router";
import { announce } from "../../lib/store";
import { Empty, ErrorBox, Field, Icon, Loading, Modal, Notice, useAsync } from "../../ui";

const Status = ({ s }: { s: string }) => <span className={`status ${STATUS_TONE[s] ?? ""}`}>{STATUS_LABEL[s] ?? s}</span>;

const FILTERS: { v: string; t: string }[] = [
  { v: "", t: "Tất cả" },
  { v: "sent", t: "Chờ bạn xác nhận" },
  { v: "supplier_proposed", t: "Đã đề xuất" },
  { v: "confirmed,partially_received", t: "Chờ giao" },
  { v: "received", t: "Đã giao đủ" },
  { v: "rejected,cancelled,closed", t: "Đã đóng / huỷ" },
];

interface ListRes { items: NccOrder[]; nextCursor: string | null; counts: Record<string, number>; summary: { awaitingYou: number; proposed: number; confirmed: number; overdue: number; openValue: number } }

export function NccOrdersPage() {
  usePageMeta("Đơn đặt hàng");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [extra, setExtra] = useState<NccOrder[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (q.trim()) qs.set("q", q.trim());
  const key = qs.toString();
  const { data, error, loading, reload } = useAsync(async () => {
    const r = await nccApi<ListRes>(`/orders?${key}`);
    setExtra([]); setCursor(r.nextCursor);
    return r;
  }, [key]);
  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const r = await nccApi<ListRes>(`/orders?${key}${key ? "&" : ""}cursor=${cursor}`);
      setExtra((e) => [...e, ...r.items]); setCursor(r.nextCursor);
    } finally { setMore(false); }
  };
  const rows = [...(data?.items ?? []), ...extra];
  const sum = data?.summary;
  const dirty = !!(status || from || to || q.trim());
  return (
    <div className="ncc-page">
      <div className="ncc-head"><div><h1>Đơn đặt hàng</h1><p className="muted">Các đơn Hữu Mạnh đã gửi cho bạn. Xác nhận, đề xuất sửa hoặc từ chối ngay trên đây.</p></div></div>
      {sum && (
        <dl className="ncc-kpis">
          <div className={sum.awaitingYou ? "hot" : ""}><dt>Chờ bạn xác nhận</dt><dd>{sum.awaitingYou}</dd></div>
          <div><dt>Đã đề xuất, chờ cửa hàng</dt><dd>{sum.proposed}</dd></div>
          <div><dt>Đã xác nhận, chờ giao</dt><dd>{sum.confirmed}</dd></div>
          <div className={sum.overdue ? "bad" : ""}><dt>Trễ hẹn giao</dt><dd>{sum.overdue}</dd></div>
          <div className="wide"><dt>Giá trị đơn đang mở</dt><dd>{money(sum.openValue)}</dd></div>
        </dl>
      )}
      <div className="ncc-filters">
        <div className="chips scroll" role="group" aria-label="Lọc theo trạng thái">
          {FILTERS.map((f) => <button key={f.v} type="button" className={`chip ${status === f.v ? "on" : ""}`} aria-pressed={status === f.v} onClick={() => setStatus(f.v)}>{f.t}{f.v === "sent" && sum?.awaitingYou ? ` (${sum.awaitingYou})` : ""}</button>)}
        </div>
        <div className="ncc-filter-row">
          <Field id="of-q" label="Mã đơn">{(p) => <input {...p} type="search" placeholder="PO-…" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
          <Field id="of-from" label="Gửi từ ngày">{(p) => <input {...p} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field id="of-to" label="Đến ngày">{(p) => <input {...p} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />}</Field>
          {dirty && <button className="btn ghost sm ncc-reset" onClick={() => { setStatus(""); setFrom(""); setTo(""); setQ(""); }}>Xoá lọc</button>}
        </div>
      </div>
      {loading && !data ? <Loading /> : error || !data ? <ErrorBox error={error} onRetry={reload} /> : !rows.length ? (
        <Empty title={dirty ? "Không có đơn nào khớp bộ lọc" : "Chưa có đơn đặt hàng"} art>
          <p>{dirty ? "Thử bỏ bớt bộ lọc." : "Khi Hữu Mạnh gửi đơn đặt hàng, đơn sẽ hiện ở đây."}</p>
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="qo rt" data-testid="ncc-orders">
              <thead><tr><th>Mã đơn</th><th>Ngày gửi</th><th>Giao dự kiến</th><th className="r">Số dòng</th><th className="r">Giá trị</th><th>Trạng thái</th><th><span className="sr-only">Mở</span></th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className={o.awaitingYou ? "hot" : ""}>
                    <td data-label="Mã đơn"><Link to={`/ncc/don/${o.id}`} className="oc-code">{o.code}</Link></td>
                    <td data-label="Ngày gửi">{fmtDateTime(o.sentAt)}</td>
                    <td data-label="Giao dự kiến">{o.expectedDate ? <>{fmtDate(o.expectedDate)}{o.overdue && <span className="status bad ncc-late">Trễ hẹn</span>}</> : <span className="muted">Chưa hẹn</span>}</td>
                    <td data-label="Số dòng" className="r">{o.lineCount}</td>
                    <td data-label="Giá trị" className="r"><strong>{money(o.total)}</strong></td>
                    <td data-label="Trạng thái"><Status s={o.status} /></td>
                    <td className="ncc-act"><Link to={`/ncc/don/${o.id}`} className={`btn sm ${o.awaitingYou ? "" : "ghost"}`}>{o.awaitingYou ? "Xử lý" : "Xem"}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && <div className="center"><button className="btn ghost" onClick={loadMore} disabled={more}>{more ? "Đang tải…" : "Xem thêm đơn"}</button></div>}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- chi tiết */

type Action = "confirm" | "propose" | "reject" | null;

export function NccOrderDetailPage({ id }: { id: number }) {
  const { data: o, error, loading, reload } = useAsync(() => nccApi<NccOrderDetail>(`/orders/${id}`), [id]);
  usePageMeta(o ? `Đơn ${o.code}` : "Đơn đặt hàng");
  const [action, setAction] = useState<Action>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  if (loading && !o) return <Loading />;
  if (error || !o) {
    const nf = error instanceof ApiError && error.status === 404;
    return nf ? <Empty title="Không tìm thấy đơn đặt hàng"><p>Đơn không tồn tại hoặc chưa được gửi cho bạn.</p><Link to="/ncc" className="btn">Về danh sách đơn</Link></Empty> : <ErrorBox error={error} onRetry={reload} />;
  }
  const proposedView = o.status === "supplier_proposed";
  const confirmed = ["confirmed", "partially_received", "received", "closed"].includes(o.status) && o.lines.some((l) => l.confirmedQtyMilli != null);
  const done = () => { setAction(null); reload(); };
  const onConflict = (msg: string) => { setAction(null); setConflict(msg); reload(); };
  return (
    <div className="ncc-page order">
      <Link to="/ncc" className="back"><Icon n="chevL" size={18} /> Tất cả đơn đặt hàng</Link>
      <div className="ncc-head">
        <div>
          <h1 className="mono">{o.code}</h1>
          <div className="order-head"><Status s={o.status} />{o.overdue && <span className="status bad">Trễ hẹn giao</span>}<span className="muted small">Gửi {fmtDateTime(o.sentAt)}</span></div>
        </div>
        <div className="row-actions">
          <a className="btn ghost" href={`/api/ncc/orders/${o.id}/pdf`} download data-testid="ncc-pdf"><Icon n="download" size={18} /> Tải PDF</a>
        </div>
      </div>

      {conflict && <Notice kind="warn">{conflict}</Notice>}
      {o.canRespond && (
        <section className="card-box ncc-action" aria-labelledby="h-act">
          <h2 id="h-act">Đơn này đang chờ bạn phản hồi</h2>
          <p className="muted">Xác nhận nếu giao đủ theo số lượng và giá trên đơn. Nếu cần đổi số lượng, giá hoặc ngày giao, hãy gửi đề xuất để cửa hàng xem.</p>
          {o.storeReply && <Notice kind="warn"><strong>Cửa hàng không chấp nhận đề xuất trước:</strong> {o.storeReply}</Notice>}
          <div className="row-actions">
            <button className="btn lg" onClick={() => setAction("confirm")} data-testid="act-confirm"><Icon n="check" size={20} /> Xác nhận đơn</button>
            <button className="btn lg ghost" onClick={() => setAction("propose")} data-testid="act-propose">Đề xuất sửa</button>
            <button className="btn lg ghost danger" onClick={() => setAction("reject")} data-testid="act-reject">Từ chối</button>
          </div>
        </section>
      )}
      {proposedView && <Notice kind="info">Bạn đã gửi đề xuất sửa{o.proposedExpectedDate ? ` (giao ${fmtDate(o.proposedExpectedDate)})` : ""}. Đơn đang chờ cửa hàng chấp nhận hoặc từ chối.</Notice>}
      {o.status === "confirmed" && <Notice kind="ok">Đã xác nhận{o.expectedDate ? `, giao dự kiến ${fmtDate(o.expectedDate)}` : ""}. Cửa hàng sẽ nhận hàng và ghi hoá đơn mua khi hàng về.</Notice>}

      <div className="order-cols">
        <div>
          <section className="card-box" aria-labelledby="h-lines">
            <h2 id="h-lines">Mặt hàng</h2>
            <div className="table-wrap flat">
              <table className="qo rt" data-testid="ncc-lines">
                <thead>
                  <tr><th>Mặt hàng</th><th className="r">Số lượng đặt</th><th className="r">Đơn giá</th>
                    {proposedView && <th className="r">Bạn đề xuất</th>}
                    {confirmed && <th className="r">Đã chốt</th>}
                    {(confirmed || o.status === "partially_received") && <th className="r">Đã nhận</th>}
                    <th className="r">Thành tiền</th></tr>
                </thead>
                <tbody>
                  {o.lines.map((l) => <LineRow key={l.id} l={l} proposed={proposedView} confirmed={confirmed} showRecv={confirmed || o.status === "partially_received"} />)}
                </tbody>
              </table>
            </div>
            <dl className="totals"><div className="grand"><dt>Tổng giá trị đơn</dt><dd>{money(o.total)}</dd></div></dl>
          </section>
        </div>
        <div>
          <section className="card-box" aria-labelledby="h-info">
            <h2 id="h-info">Thông tin đơn</h2>
            <dl className="info">
              <div><dt>Ngày gửi</dt><dd>{fmtDateTime(o.sentAt)}</dd></div>
              <div><dt>Giao dự kiến</dt><dd>{o.expectedDate ? fmtDate(o.expectedDate) : "Chưa xác nhận"}</dd></div>
              {o.proposedExpectedDate && <div><dt>Bạn đề xuất giao</dt><dd>{fmtDate(o.proposedExpectedDate)}</dd></div>}
              {o.note && <div><dt>Ghi chú của cửa hàng</dt><dd className="wrap-any">{o.note}</dd></div>}
              {o.supplierNote && <div><dt>Ghi chú của bạn</dt><dd className="wrap-any">{o.supplierNote}</dd></div>}
            </dl>
          </section>
          {o.bills.length > 0 && (
            <section className="card-box" aria-labelledby="h-bills">
              <h2 id="h-bills">Hoá đơn mua đã ghi nhận</h2>
              <ul className="wd-lines">{o.bills.map((b) => <li key={b.code}><span>{b.code}{b.provisional && <span className="status warn ncc-late">Tạm tính</span>}<br /><small className="muted">{fmtDate(b.issueDate)}</small></span><strong>{money(b.total)}</strong></li>)}</ul>
              <Link to="/ncc/cong-no" className="small">Xem công nợ →</Link>
            </section>
          )}
          <section className="card-box" aria-labelledby="h-hist">
            <h2 id="h-hist">Diễn biến</h2>
            {o.history.length ? (
              <ol className="timeline">
                {o.history.map((h, i) => (
                  <li key={i} className={i === o.history.length - 1 ? "last" : ""}><span className="dot" aria-hidden="true" /><div><strong>{h.label}</strong>{h.note && <p className="wrap-any">“{h.note}”</p>}<time dateTime={h.at}>{fmtDateTime(h.at)}</time></div></li>
                ))}
              </ol>
            ) : <p className="muted">Chưa có diễn biến.</p>}
          </section>
        </div>
      </div>

      {action === "confirm" && <ConfirmModal o={o} onClose={() => setAction(null)} onDone={() => { announce("Đã xác nhận đơn"); done(); }} onConflict={onConflict} />}
      {action === "propose" && <ProposeModal o={o} onClose={() => setAction(null)} onDone={() => { announce("Đã gửi đề xuất"); done(); }} onConflict={onConflict} />}
      {action === "reject" && <RejectModal o={o} onClose={() => setAction(null)} onDone={() => { announce("Đã từ chối đơn"); done(); }} onConflict={onConflict} />}
    </div>
  );
}

function LineRow({ l, proposed, confirmed, showRecv }: { l: NccLine; proposed: boolean; confirmed: boolean; showRecv: boolean }) {
  const orderQty = l.orderUnit !== l.baseUnit ? ` (${num(l.orderQty)} ${l.orderUnit})` : "";
  return (
    <tr>
      <th data-label="Mặt hàng" scope="row"><span className="cv">{l.productName}{l.supplierNote && <small className="n wrap-any">Ghi chú của bạn: {l.supplierNote}</small>}</span></th>
      <td data-label="Số lượng đặt" className="r"><span className="cv">{qtyKg(l.qtyMilli, l.baseUnit)}<small className="n">{orderQty}</small></span></td>
      <td data-label="Đơn giá" className="r"><span className="cv">{l.unitCost == null ? <span className="muted">Chưa có giá</span> : <>{money(l.unitCost)}<small className="n">/ {l.baseUnit}</small></>}</span></td>
      {proposed && <td data-label="Bạn đề xuất" className="r"><span className="cv">{l.proposedQtyMilli != null ? qtyKg(l.proposedQtyMilli, l.baseUnit) : "—"}<small className="n">{l.proposedUnitCost != null ? `${money(l.proposedUnitCost)} / ${l.baseUnit}` : ""}</small></span></td>}
      {confirmed && <td data-label="Đã chốt" className="r"><span className="cv">{l.confirmedQtyMilli != null ? qtyKg(l.confirmedQtyMilli, l.baseUnit) : "—"}<small className="n">{l.confirmedUnitCost != null ? `${money(l.confirmedUnitCost)} / ${l.baseUnit}` : ""}</small></span></td>}
      {showRecv && <td data-label="Đã nhận" className="r"><span className="cv">{qtyKg(l.receivedMilli, l.baseUnit)}{l.remainingMilli > 0 && <small className="n">còn {qtyKg(l.remainingMilli, l.baseUnit)}</small>}</span></td>}
      <td data-label="Thành tiền" className="r"><span className="cv"><strong>{l.lineTotal == null ? "—" : money(l.lineTotal)}</strong></span></td>
    </tr>
  );
}

/* ---------------------------------------------------------------- phản hồi */

interface ModalProps { o: NccOrderDetail; onClose: () => void; onDone: () => void; onConflict: (m: string) => void }

async function respond(o: NccOrderDetail, body: Record<string, unknown>, onConflict: (m: string) => void): Promise<boolean> {
  try {
    await nccApi(`/orders/${o.id}/respond`, { body: { ...body, version: o.version } });
    return true;
  } catch (e) {
    if (e instanceof ApiError && (e.code === "version_conflict" || e.code === "invalid_status")) { onConflict("Đơn vừa được cửa hàng thay đổi nên chưa gửi được phản hồi của bạn. Đã tải lại đơn, vui lòng xem và thử lại."); return false; }
    throw e;
  }
}

function ConfirmModal({ o, onClose, onDone, onConflict }: ModalProps) {
  const [date, setDate] = useState(o.expectedDate ?? "");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { if (await respond(o, { action: "confirm", expectedDate: date || null, note: note.trim() || null }, onConflict)) onDone(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Xác nhận đơn ${o.code}`}>
      <form onSubmit={submit}>
        <p>Bạn đồng ý giao đủ <strong>{o.lines.length} mặt hàng</strong> với tổng giá trị <strong>{money(o.total)}</strong>.</p>
        <Field id="cf-date" label="Ngày giao dự kiến" hint="Không bắt buộc.">{(p) => <input {...p} type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field id="cf-note" label="Ghi chú cho cửa hàng">{(p) => <textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {err && <Notice kind="err">{err}</Notice>}
        <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>Đóng</button><button className="btn" disabled={busy} type="submit">{busy ? "Đang gửi…" : "Xác nhận đơn"}</button></div>
      </form>
    </Modal>
  );
}

function ProposeModal({ o, onClose, onDone, onConflict }: ModalProps) {
  const [rows, setRows] = useState(() => o.lines.map((l) => ({ id: l.id, qty: String(l.qtyMilli / 1000).replace(".", ","), cost: l.unitCost == null ? "" : String(l.unitCost), note: "" })));
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, k: "qty" | "cost" | "note", v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    const lines: { lineId: number; qtyMilli?: number; unitCost?: number; note?: string }[] = [];
    for (let i = 0; i < o.lines.length; i++) {
      const l = o.lines[i], r = rows[i];
      const q = parseDec(r.qty);
      if (!Number.isFinite(q) || q < 0) { setErr(`Số lượng của "${l.productName}" chưa hợp lệ.`); return; }
      const qtyMilli = Math.round(q * 1000);
      const cost = r.cost.trim() === "" ? null : Math.round(Number(r.cost.replace(/[.\s]/g, "")));
      if (cost != null && (!Number.isFinite(cost) || cost < 0)) { setErr(`Giá của "${l.productName}" chưa hợp lệ.`); return; }
      const item: { lineId: number; qtyMilli?: number; unitCost?: number; note?: string } = { lineId: l.id };
      if (qtyMilli !== l.qtyMilli) item.qtyMilli = qtyMilli;
      if (cost != null && cost !== l.unitCost) item.unitCost = cost;
      if (r.note.trim()) item.note = r.note.trim();
      if (item.qtyMilli != null || item.unitCost != null || item.note) lines.push(item);
    }
    if (!lines.length && !date) { setErr("Hãy đổi ít nhất một số lượng, giá, ngày giao hoặc ghi chú dòng rồi gửi đề xuất."); return; }
    setBusy(true);
    try { if (await respond(o, { action: "propose", expectedDate: date || null, note: note.trim() || null, lines }, onConflict)) onDone(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Đề xuất sửa đơn ${o.code}`}>
      <form onSubmit={submit} className="ncc-propose">
        <p className="muted small">Chỉ đổi những dòng cần sửa. Dòng giữ nguyên sẽ được coi là bạn đồng ý. Số lượng và giá tính theo đơn vị chính (kg…). Điền 0 nếu không giao được mặt hàng đó.</p>
        <ul className="ncc-pl">
          {o.lines.map((l, i) => (
            <li key={l.id} className="card-box flat">
              <strong>{l.productName}</strong>
              <span className="muted small">Đặt {qtyKg(l.qtyMilli, l.baseUnit)} · {l.unitCost == null ? "chưa có giá" : `${money(l.unitCost)} / ${l.baseUnit}`}</span>
              <div className="ncc-pl-in">
                <Field id={`pq-${l.id}`} label={`Số lượng (${l.baseUnit})`}>{(p) => <input {...p} inputMode="decimal" value={rows[i].qty} onChange={(e) => set(i, "qty", e.target.value)} />}</Field>
                <Field id={`pc-${l.id}`} label={`Giá (₫ / ${l.baseUnit})`}>{(p) => <input {...p} inputMode="numeric" value={rows[i].cost} onChange={(e) => set(i, "cost", e.target.value)} />}</Field>
              </div>
              <Field id={`pn-${l.id}`} label="Ghi chú dòng (không bắt buộc)">{(p) => <input {...p} maxLength={200} value={rows[i].note} onChange={(e) => set(i, "note", e.target.value)} />}</Field>
            </li>
          ))}
        </ul>
        <Field id="pp-date" label="Ngày giao đề xuất">{(p) => <input {...p} type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field id="pp-note" label="Lời nhắn cho cửa hàng">{(p) => <textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {err && <Notice kind="err">{err}</Notice>}
        <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>Đóng</button><button className="btn" disabled={busy} type="submit">{busy ? "Đang gửi…" : "Gửi đề xuất"}</button></div>
      </form>
    </Modal>
  );
}

function RejectModal({ o, onClose, onDone, onConflict }: ModalProps) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (note.trim().length < 3) { setErr("Vui lòng ghi lý do từ chối (ít nhất 3 ký tự)."); return; }
    setBusy(true);
    try { if (await respond(o, { action: "reject", note: note.trim() }, onConflict)) onDone(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Từ chối đơn ${o.code}`}>
      <form onSubmit={submit}>
        <p>Cửa hàng sẽ biết bạn không nhận đơn này và tìm nhà cung cấp khác. Thao tác không hoàn tác được.</p>
        <Field id="rj-note" label="Lý do từ chối" error={err}>{(p) => <textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <div className="modal-foot"><button type="button" className="btn ghost" onClick={onClose}>Đóng</button><button className="btn danger" disabled={busy} type="submit">{busy ? "Đang gửi…" : "Từ chối đơn"}</button></div>
      </form>
    </Modal>
  );
}


