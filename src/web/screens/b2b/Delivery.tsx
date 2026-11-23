import { useRef, useState } from "react";
import { ApiError, get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, Segmented, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { Scanner } from "../../components/Scanner";
import { toast } from "../../components/toast";
import { money, unitLabel } from "../../format";
import { navigate, usePath } from "../../router";
import { Back, DELIVERY_STATUS, EINVOICE, Lnk, REJECT_LABEL, REJECT_REASONS, deliveryTone, einvTone, q3, round3, ymd } from "./kit";

export default function Delivery() {
  const path = usePath();
  const m = path.match(/^\/deliveries\/(\d+)/);
  return m ? <DeliveryDetail id={Number(m[1])} /> : <DeliveryList />;
}

/** Danh sách việc cần làm của thủ kho: đơn cần soạn / đang soạn / đang giao */
function DeliveryList() {
  const [tab, setTab] = useState<"confirmed" | "preparing" | "shipping">("confirmed");
  const l = useAsync(() => get("/b2b/orders", { status: tab, limit: 100 }).then((r) => items<any>(r)), [tab]);
  const [busy, setBusy] = useState<number | null>(null);
  const open = async (o: any) => {
    setBusy(o.id);
    try {
      if (tab === "confirmed") { const r = await post(`/b2b/orders/${o.id}/pick`); toast("Đã tạo phiếu soạn", "ok"); navigate(`/deliveries/${r.deliveryId}`); }
      else {
        const d = await get(`/b2b/orders/${o.id}`);
        const dl = [...d.deliveries].reverse().find((x: any) => ["picking", "ready", "shipping"].includes(x.status));
        if (dl) navigate(`/deliveries/${dl.id}`); else toast("Đơn chưa có phiếu giao đang xử lý", "error");
      }
    } catch { /* toast */ } finally { setBusy(null); }
  };
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={[{ v: "confirmed", label: "Cần soạn" }, { v: "preparing", label: "Đang soạn" }, { v: "shipping", label: "Đang giao" }]} />
      {l.loading ? <Spinner /> : !(l.data ?? []).length ? <EmptyState title={tab === "confirmed" ? "Không có đơn cần soạn" : "Không có phiếu"} hint="Đơn sỉ đã giữ hàng sẽ hiện ở đây." /> : (
        <div className="stack">
          {(l.data ?? []).map((o) => (
            <button key={o.id} className="dt-card" disabled={busy === o.id} onClick={() => open(o)} style={{ minHeight: 76 }}>
              <div className="row between"><b>{o.code}</b><span className="money">{money(o.total)}</span></div>
              <div>{o.customerName}</div>
              <div className="row between small muted"><span>Giao {ymd(o.deliveryDate)} · {o.addressLabel ?? ""}</span><Badge tone="info">{tab === "confirmed" ? "Bấm để soạn" : "Mở phiếu"}</Badge></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Flash = { kind: "ok" | "error"; text: string } | null;
const SCAN_MSG: Record<string, string> = {
  not_in_doc: "Sai hàng — mặt hàng này không thuộc đơn.",
  wrong_lot: "Sai lô — lô này không được giữ cho đơn. Lấy đúng lô theo phiếu.",
  duplicate_scan: "Quét trùng — lô này đã được quét rồi.",
  unknown_code: "Mã không tồn tại trong hệ thống.",
  over_pick: "Đã soạn đủ số lượng cho mặt hàng này.",
  unknown_unit: "Đơn vị không hợp lệ.",
};

function DeliveryDetail({ id }: { id: number }) {
  const d = useAsync(() => get(`/deliveries/${id}`), [id]);
  const [data, setData] = useState<any>(null);
  const del = data ?? d.data;
  const [flash, setFlash] = useState<Flash>(null);
  const [log, setLog] = useState<{ code: string; ok: boolean; msg: string }[]>([]);
  const [mode, setMode] = useState<"" | "confirm" | "fail" | "ship" | "ready">("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [reason, setReason] = useState("");
  const busyScan = useRef(false);
  if (d.loading && !del) return <Spinner />;
  if (!del) return <div className="stack"><Back to="/deliveries" label="Soạn & giao" /><EmptyState title="Không tìm thấy phiếu giao" /></div>;

  // đổi số lượng sang đơn vị của dòng: milli cơ bản × (qty / qtyMilli)
  const toU = (l: any, milli: number) => (l.qtyMilli > 0 ? round3((milli * l.qty) / l.qtyMilli) : 0);
  const picking = del.status === "picking";
  const mismatch = del.lines.some((l: any) => l.pickedMilli !== l.qtyMilli);
  const totalOrdered = del.lines.reduce((s: number, l: any) => s + l.qtyMilli, 0);
  const totalPicked = del.lines.reduce((s: number, l: any) => s + Math.min(l.pickedMilli, l.qtyMilli), 0);
  const pct = totalOrdered ? Math.round((totalPicked / totalOrdered) * 100) : 0;

  const onCode = async (code: string) => {
    if (!picking || busyScan.current) return;
    busyScan.current = true;
    try {
      const r = await post(`/deliveries/${id}/scan`, { code }, { silent: true });
      setData(r); setFlash({ kind: "ok", text: `Đã nhận ${code}` }); setLog((x) => [{ code, ok: true, msg: "Đã nhận" }, ...x].slice(0, 6));
      navigator.vibrate?.(40);
    } catch (e) {
      const msg = e instanceof ApiError ? SCAN_MSG[e.code] ?? e.message : "Lỗi quét";
      setFlash({ kind: "error", text: msg }); setLog((x) => [{ code, ok: false, msg }, ...x].slice(0, 6));
      navigator.vibrate?.([80, 60, 80]);
    } finally { busyScan.current = false; }
  };
  const act = async (path: string, body: unknown, okMsg: string) => {
    setBusy(true);
    try { const r = await post(`/deliveries/${id}/${path}`, body, { silent: true }); if (path !== "confirm") { setData(r); } toast(okMsg, "ok"); setMode(""); return r; }
    catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "reason_required") { setMode("ready"); toast("Số soạn lệch so với đơn — nhập lý do", "error"); }
        else toast(e.message, "error");
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <Back to="/deliveries" label="Soạn & giao" />
      <div className="page-head">
        <div style={{ minWidth: 0 }}><h2 style={{ margin: 0 }}>Phiếu {del.code}</h2><div className="muted small"><Lnk to={`/b2b-orders/${del.orderId}`}>Xem đơn #{del.orderId}</Lnk>{del.shipper ? ` · Người giao: ${del.shipper}` : ""}{del.receiverName ? ` · Nhận: ${del.receiverName}` : ""}</div></div>
        <Badge tone={deliveryTone(del.status)}>{DELIVERY_STATUS[del.status] ?? del.status}</Badge>
      </div>
      <div className="card flat">
        <div className="row between"><b>Đã soạn {pct}%</b><span className="muted small">{del.lines.filter((l: any) => l.pickedMilli >= l.qtyMilli).length}/{del.lines.length} mặt hàng đủ</span></div>
        <div style={{ height: 10, borderRadius: 999, background: "var(--surface-2)", marginTop: 8, overflow: "hidden" }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "var(--accent)" : "var(--warn)" }} /></div>
      </div>

      {picking && (
        <Card title="Quét lô để soạn">
          <div className="stack">
            <Scanner continuous onCode={onCode} />
            {flash && <div role={flash.kind === "error" ? "alert" : "status"} data-testid="scan-flash" className={"banner " + (flash.kind === "error" ? "danger" : "info")} style={{ fontSize: "1.05rem", fontWeight: 600 }}>{flash.kind === "error" ? "✗ " : "✓ "}{flash.text}</div>}
            {log.length > 0 && <div className="small muted">{log.map((x, i) => <div key={i}>{x.ok ? "✓" : "✗"} <span className="num">{x.code}</span> — {x.msg}</div>)}</div>}
          </div>
        </Card>
      )}

      <div className="stack" data-testid="pick-list">
        {del.lines.map((l: any) => {
          const full = l.pickedMilli >= l.qtyMilli;
          return (
            <div key={l.orderLineId} className="card flat" style={{ borderColor: full ? "var(--accent)" : undefined }}>
              <div className="row between wrap"><b>{l.productName}</b><Badge tone={full ? "ok" : l.pickedMilli > 0 ? "warn" : "info"}>Soạn {q3(toU(l, l.pickedMilli))}/{q3(l.qty)} {unitLabel(l.unit)}</Badge></div>
              {l.lots.length ? (
                <div className="stack" style={{ gap: 4, marginTop: 8 }}>
                  <div className="small muted">Lấy theo lô (FEFO):</div>
                  {l.lots.map((x: any) => (
                    <div key={x.lotId} className="row between" style={{ background: "var(--surface-2)", borderRadius: 8, padding: "6px 10px" }}>
                      <span className="num" style={{ fontWeight: 700, fontSize: "1.05rem" }}>{x.lotCode}</span>
                      <span className="small">{q3(toU(l, x.qtyMilli))} {unitLabel(l.unit)}{x.expiresAt ? ` · HSD ${ymd(x.expiresAt)}` : ""}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="small muted" style={{ marginTop: 6 }}>Không còn lô giữ (đã xuất hoặc đã nhả).</div>}
              {del.status === "delivered" && <div className="small" style={{ marginTop: 6 }}>Đã giao {q3(toU(l, l.deliveredMilli))}{l.rejectedMilli ? <> · <b style={{ color: "var(--danger)" }}>từ chối {q3(toU(l, l.rejectedMilli))} ({REJECT_LABEL[l.rejectReason] ?? l.rejectReason})</b></> : null}</div>}
            </div>
          );
        })}
      </div>

      {del.note && <div className="small muted">Ghi chú: {del.note}</div>}
      <div className="row wrap">
        {picking && <Button size="lg" onClick={() => (mismatch ? setMode("ready") : act("ready", {}, "Đã soạn xong"))} loading={busy && mode === ""}>Soạn xong</Button>}
        {del.status === "ready" && <Button size="lg" onClick={() => setMode("ship")}>Giao đi</Button>}
        {["ready", "shipping"].includes(del.status) && <Button size="lg" variant="soft" onClick={() => setMode("confirm")}>Xác nhận đã giao</Button>}
        {["picking", "ready", "shipping"].includes(del.status) && <Button variant="danger" onClick={() => setMode("fail")}>Giao thất bại</Button>}
        {del.status === "delivered" && <Lnk to={`/b2b-orders/${del.orderId}`} className="btn soft">Xem đơn & hoá đơn</Lnk>}
      </div>

      {mode === "ready" && (
        <Sheet open onClose={() => setMode("")} title="Soạn xong — có lệch số lượng" footer={<Button block loading={busy} disabled={reason.trim().length < 3} onClick={() => act("ready", { reason: reason.trim() }, "Đã soạn xong")}>Xác nhận soạn xong</Button>}>
          <div className="stack">
            <Banner>Số soạn chưa khớp đơn ở: {del.lines.filter((l: any) => l.pickedMilli !== l.qtyMilli).map((l: any) => `${l.productName} (${q3(toU(l, l.pickedMilli))}/${q3(l.qty)})`).join("; ")}. Phải ghi lý do.</Banner>
            <TextArea label="Lý do lệch" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </Sheet>
      )}
      {mode === "ship" && <ShipSheet busy={busy} onClose={() => setMode("")} onSubmit={(shipper) => act("ship", shipper ? { shipper } : {}, "Đã giao đi")} />}
      {mode === "fail" && (
        <Sheet open onClose={() => setMode("")} title="Giao thất bại" footer={<Button block variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => act("fail", { reason: reason.trim() }, "Đã ghi nhận giao thất bại — hàng được nhả giữ")}>Xác nhận thất bại</Button>}>
          <div className="stack"><Banner>Hàng giữ sẽ được nhả; đơn chuyển "Giao thất bại" và có thể giữ hàng lại để giao lần khác.</Banner><TextArea label="Lý do" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </Sheet>
      )}
      {mode === "confirm" && <ConfirmSheet del={del} toU={toU} busy={busy} onClose={() => setMode("")} onSubmit={async (body) => { const r = await act("confirm", body, "Đã xác nhận giao hàng"); if (r) { setDone(r); d.reload(); setData(null); } }} />}
      {done && (
        <Sheet open onClose={() => setDone(null)} title="Đã giao hàng" footer={<Button block onClick={() => { setDone(null); navigate(`/b2b-orders/${del.orderId}`); }}>Xem đơn</Button>}>
          <div className="stack">
            <Banner tone="info">Đơn đã hoàn tất theo số thực giao.</Banner>
            {done.invoice ? (
              <div className="card flat stack" style={{ gap: 4 }} data-testid="invoice-result">
                <div className="row between"><b>Hoá đơn {done.invoice.code}</b><Badge tone={einvTone(done.invoice.einvoiceStatus)}>HĐĐT: {EINVOICE[done.invoice.einvoiceStatus] ?? done.invoice.einvoiceStatus}</Badge></div>
                <div className="row between"><span className="muted">Tổng tiền</span><b className="money">{money(done.invoice.total)}</b></div>
                <div className="row between"><span className="muted">Hạn thanh toán</span><span>{ymd(done.invoice.dueDate)}</span></div>
                <Lnk to={`/invoices?id=${done.invoice.id}`}>Mở hoá đơn</Lnk>
              </div>
            ) : <Banner>Không có hàng giao nên không lập hoá đơn.</Banner>}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function ShipSheet({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (s: string) => void }) {
  const [s, setS] = useState("");
  return <Sheet open onClose={onClose} title="Giao đi" footer={<Button block loading={busy} onClick={() => onSubmit(s.trim())}>Xác nhận giao đi</Button>}><Input label="Người giao / biển số xe (tuỳ chọn)" value={s} onChange={(e) => setS(e.target.value)} /></Sheet>;
}

function ConfirmSheet({ del, toU, busy, onClose, onSubmit }: { del: any; toU: (l: any, m: number) => number; busy: boolean; onClose: () => void; onSubmit: (b: any) => void }) {
  const [name, setName] = useState("");
  const [st, setSt] = useState<Record<number, { del: number; rej: number; reason: string }>>(() => Object.fromEntries(del.lines.map((l: any) => [l.orderLineId, { del: Math.min(toU(l, l.pickedMilli) || l.qty, l.qty), rej: 0, reason: "" }])));
  const set = (id: number, p: Partial<{ del: number; rej: number; reason: string }>) => setSt({ ...st, [id]: { ...st[id], ...p } });
  const invalid = del.lines.some((l: any) => { const s = st[l.orderLineId]; return s.del + s.rej > l.qty + 1e-9 || (s.rej > 0 && !s.reason); });
  return (
    <Sheet open wide onClose={onClose} title="Xác nhận giao hàng" footer={<Button block size="lg" loading={busy} disabled={!name.trim() || invalid} onClick={() => onSubmit({ receiverName: name.trim(), lines: del.lines.map((l: any) => { const s = st[l.orderLineId]; return { orderLineId: l.orderLineId, deliveredQty: s.del, ...(s.rej > 0 ? { rejectedQty: s.rej, rejectReason: s.reason } : {}) }; }) })}>Xác nhận & lập hoá đơn</Button>}>
      <div className="stack">
        <Input label="Người nhận hàng" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="hint">Hoá đơn lập theo <b>số thực giao</b>. Hàng bị từ chối không xuất kho.</div>
        {del.lines.map((l: any) => {
          const s = st[l.orderLineId];
          const over = s.del + s.rej > l.qty + 1e-9;
          return (
            <div key={l.orderLineId} className="card flat stack">
              <div className="row between"><b>{l.productName}</b><span className="muted small">Đặt {q3(l.qty)} {unitLabel(l.unit)}</span></div>
              <div className="grid2">
                <DecInput label={`Giao (${unitLabel(l.unit)})`} value={s.del} onChange={(n) => set(l.orderLineId, { del: n })} />
                <DecInput label="Từ chối" value={s.rej || ""} onChange={(n) => set(l.orderLineId, { rej: n, ...(n === 0 ? { reason: "" } : {}) })} />
              </div>
              {over && <div className="err">Giao + từ chối vượt số đặt.</div>}
              {s.rej > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="small muted">Lý do từ chối</span>
                  <div className="chips">{REJECT_REASONS.map(([k, v]) => <button key={k} className="chip" aria-pressed={s.reason === k} onClick={() => set(l.orderLineId, { reason: k })}>{v}</button>)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
