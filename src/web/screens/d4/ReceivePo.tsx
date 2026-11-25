import { useState } from "react";
import { ApiError, get, post } from "../../api";
import { Badge, Banner, Button, Card, DecInput, EmptyState, Input, MoneyInput, Sheet, Spinner, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { fmtDateTime, money, qtyText, unitLabel } from "../../format";
import { useCan } from "../../store";
import { navigate } from "../../router";
import { ymd } from "../b2b/kit";

/** Nhận hàng theo PO (Kho → "Nhận hàng theo PO"): một lần ghi sổ = phiếu nhập + lô + hoá đơn mua; hàng về giữ ngay cho đơn đang chờ. */
export default function ReceivePoSheet({ poId, onClose, onDone }: { poId?: number; onClose: () => void; onDone?: () => void }) {
  const [pick, setPick] = useState<number | null>(poId ?? null);
  return (
    <Sheet portal open wide onClose={onClose} title={pick ? "Nhận hàng theo PO" : "Chọn PO cần nhận hàng"}>
      {pick == null ? <PickPo onPick={setPick} /> : <ReceiveForm id={pick} onBack={poId ? undefined : () => setPick(null)} onClose={onClose} onDone={onDone} />}
    </Sheet>
  );
}

function PickPo({ onPick }: { onPick: (id: number) => void }) {
  const l = useAsync(() => get("/purchase-orders", { receivable: 1, limit: 100 }), []);
  if (l.loading) return <Spinner />;
  const rows: any[] = l.data?.items ?? [];
  if (!rows.length) return <EmptyState title="Chưa có PO nào chờ nhận hàng" hint="PO cần được gửi NCC và NCC xác nhận (hoặc cửa hàng ghi nhận hộ) trước khi nhận hàng." />;
  return (
    <div className="stack">
      {rows.map((r) => (
        <button key={r.id} className="dt-card" onClick={() => onPick(r.id)}>
          <div className="row between"><b>{r.code}</b><Badge tone={r.status === "partially_received" ? "info" : "ok"}>{r.status === "partially_received" ? "Đã nhận một phần" : "NCC đã xác nhận"}</Badge></div>
          <div className="small muted">{r.supplierName} · {r.lineCount} dòng · giao dự kiến {r.expectedDate ? ymd(r.expectedDate) : "chưa có"}{r.overdue ? " · trễ hẹn" : ""}</div>
        </button>))}
    </div>
  );
}

function ReceiveForm({ id, onBack, onClose, onDone }: { id: number; onBack?: () => void; onClose: () => void; onDone?: () => void }) {
  const can = useCan();
  const costVisible = can("prices.view_cost");
  const d = useAsync(() => get(`/purchase-orders/${id}`), [id]);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [exp, setExp] = useState<Record<number, string>>({});
  const [cost, setCost] = useState<Record<number, number>>({});
  const [ref, setRef] = useState(""), [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const po = d.data;
  if (d.loading && !po) return <Spinner />;
  if (!po) return <EmptyState title="Không tìm thấy PO" />;
  if (res) {
    const r = res.result;
    return (
      <div className="stack">
        <Banner tone="info">Đã nhận hàng theo <b>{po.code}</b>: phiếu nhập <b>{r.stockDoc?.code}</b>{r.bill ? <> · hoá đơn mua <b>{r.bill.code}</b> {r.bill.isProvisional ? "(tạm tính — chờ số hoá đơn NCC)" : ""}</> : null}. PO {res.status === "received" ? "đã nhận đủ" : "mới nhận một phần"}.</Banner>
        {r.filledShortages?.length > 0 ? (
          <Card title="Đã giữ hàng cho đơn đang chờ">
            <div className="stack small" style={{ gap: 4 }}>{r.filledShortages.map((f: any, i: number) => (
              <div key={i} className="row between"><span><b className="num">{f.orderCode}</b> <span className="muted">· {f.productName}</span></span><span>{qtyText(f.qtyMilli, f.baseUnit)} {f.done ? <Badge tone="ok">Đã đủ hàng</Badge> : <Badge tone="warn">Còn thiếu</Badge>}</span></div>))}</div>
          </Card>) : <div className="hint">Không có đơn nào đang chờ hàng này — hàng nhập vào tồn bán lẻ.</div>}
        <div className="row wrap"><Button onClick={() => { onClose(); navigate(`/purchase-orders?open=${id}`); }}>Mở PO</Button><Button variant="ghost" onClick={onClose}>Đóng</Button></div>
      </div>
    );
  }
  const lines: any[] = po.lines.filter((l: any) => l.remainingMilli > 0);
  const valOf = (l: any) => qty[l.id] ?? l.remainingMilli / 1000;
  const chosen = lines.filter((l) => valOf(l) > 0);
  const bad = lines.some((l) => Math.round(valOf(l) * 1000) > l.remainingMilli);
  const missingCost = costVisible ? chosen.some((l) => (cost[l.id] ?? l.confirmedUnitCost ?? l.unitCost) == null) : false;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post(`/purchase-orders/${id}/receive`, {
        version: po.version, supplierRef: ref.trim() || null, note: note.trim() || null,
        lines: chosen.map((l) => ({ poLineId: l.id, qtyMilli: Math.round(valOf(l) * 1000), ...(exp[l.id] ? { expiresAt: new Date(`${exp[l.id]}T23:59:00+07:00`).toISOString() } : {}), ...(cost[l.id] != null ? { unitCost: cost[l.id] } : {}) })),
      }, { silent: true });
      toast("Đã nhận hàng và ghi sổ", "ok"); setRes(r); onDone?.();
    } catch (e) { toast(e instanceof ApiError ? e.message : "Không ghi sổ được", "error"); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="row between wrap">
        <div><b>{po.code}</b> · {po.supplierName}<div className="small muted">Giao dự kiến {po.expectedDate ? ymd(po.expectedDate) : "chưa có"} · xác nhận {fmtDateTime(po.confirmedAt)}</div></div>
        {onBack && <Button size="sm" variant="ghost" onClick={onBack}>Chọn PO khác</Button>}
      </div>
      {!can("inventory.write") && <Banner tone="danger">Cần quyền nhập kho để ghi sổ.</Banner>}
      {lines.map((l) => (
        <div key={l.id} className="card flat" style={{ padding: 12 }}>
          <div className="row between wrap"><b>{l.productName}</b><span className="small muted">Còn phải nhận {qtyText(l.remainingMilli, l.baseUnit)} / chốt {qtyText(l.targetMilli, l.baseUnit)}</span></div>
          <div className="grid3" style={{ marginTop: 8 }}>
            <DecInput label={`Thực nhận (${unitLabel(l.baseUnit)})`} value={valOf(l)} onChange={(n) => setQty({ ...qty, [l.id]: n })} />
            <Input label="Hạn dùng (tuỳ chọn)" type="date" value={exp[l.id] ?? ""} onChange={(e) => setExp({ ...exp, [l.id]: e.target.value })} />
            {costVisible && <MoneyInput label={`Đơn giá / ${unitLabel(l.baseUnit)}`} value={cost[l.id] ?? l.confirmedUnitCost ?? l.unitCost ?? 0} onChange={(n) => setCost({ ...cost, [l.id]: n })} hint={(l.confirmedUnitCost ?? l.unitCost) == null ? "PO chưa có giá — nhập giá nhận" : "Giá đã chốt với NCC"} />}
          </div>
          {Math.round(valOf(l) * 1000) > l.remainingMilli && <div className="small" style={{ color: "var(--danger)", marginTop: 4 }}>Vượt phần còn lại của PO.</div>}
        </div>))}
      {!lines.length && <EmptyState title="PO đã nhận đủ" />}
      <div className="grid2">
        <Input label="Số hoá đơn NCC (nếu có)" value={ref} onChange={(e) => setRef(e.target.value)} hint="Chưa có số: hoá đơn mua được ghi tạm tính, cập nhật sau ở Công nợ." />
        <Input label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="hint">Hàng hỏng / trả lại NCC: ghi sổ nhận đúng số hàng tốt, phần hỏng dùng “Trả hàng NCC”. Hàng về sẽ tự giữ cho đơn sỉ / đơn online đang chờ, ưu tiên ngày giao sớm.</div>
      <Button block size="lg" loading={busy} disabled={!chosen.length || bad || missingCost || !can("inventory.write")} onClick={submit}>Ghi sổ nhận hàng{costVisible && chosen.length ? ` (${money(chosen.reduce((s, l) => s + Math.round((Math.round(valOf(l) * 1000) * (cost[l.id] ?? l.confirmedUnitCost ?? l.unitCost ?? 0)) / 1000), 0))})` : ""}</Button>
    </div>
  );
}
