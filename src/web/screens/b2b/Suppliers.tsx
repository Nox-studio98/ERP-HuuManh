import { useState } from "react";
import { get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, Input, MoneyInput, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../../components/ui";
import { toast } from "../../components/toast";
import { money } from "../../format";
import { useCan } from "../../store";
import { PaymentSheet } from "./Debts";
import { ymd } from "./kit";

export default function Suppliers() {
  const can = useCan();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useAsync(() => get("/suppliers", { q: dq, limit: 100 }).then((r) => items<any>(r)), [dq]);
  const debts = useAsync(async () => {
    if (!can("debt.view")) return new Map<number, any>();
    const r = await get("/debts/payables", undefined, { silent: true });
    return new Map<number, any>(items<any>(r).map((x) => [x.supplierId, x]));
  }, []);
  const [sel, setSel] = useState<any>(null);
  return (
    <div className="stack">
      <Input label="Tìm nhà cung cấp" value={q} onChange={(e) => setQ(e.target.value)} />
      {list.loading ? <Spinner /> : <DataTable rows={list.data ?? []} rowKey={(x) => x.id} onRowClick={can("debt.view") ? setSel : undefined} empty="Chưa có nhà cung cấp" cols={[
        { key: "n", label: "Nhà cung cấp", title: true, render: (x) => <span><b>{x.name}</b> <span className="muted small">{x.code}</span></span> },
        { key: "p", label: "SĐT", hideMobile: true, render: (x) => x.phone ?? "—" },
        { key: "t", label: "Hạn trả", render: (x) => `${x.paymentTermsDays ?? 0} ngày` },
        ...(can("debt.view") ? [{ key: "b", label: "Còn phải trả", right: true, render: (x: any) => { const d = debts.data?.get(x.id); return d ? <span><b className="money">{money(d.balance)}</b>{d.overdueAmount > 0 && <> <Badge tone="warn">Quá hạn {money(d.overdueAmount)}</Badge></>}</span> : <span className="muted">—</span>; } }] : []),
      ]} />}
      {sel && <SupplierSheet s={sel} onClose={() => { setSel(null); debts.reload(); }} />}
    </div>
  );
}

function SupplierSheet({ s, onClose }: { s: any; onClose: () => void }) {
  const can = useCan();
  const b = useAsync(() => get(`/suppliers/${s.id}/bills`, { limit: 100 }).then((r) => items<any>(r)), [s.id]);
  const [fin, setFin] = useState<any>(null), [pay, setPay] = useState(false);
  return (
    <Sheet open wide onClose={onClose} title={s.name}>
      <div className="stack">
        <div className="row wrap">{can("debt.write") && <Button size="sm" onClick={() => setPay(true)}>Trả tiền</Button>}<span className="muted small">Hạn trả {s.paymentTermsDays ?? 0} ngày{s.taxCode ? ` · MST ${s.taxCode}` : ""}</span></div>
        {b.loading ? <Spinner /> : <DataTable rows={b.data ?? []} rowKey={(x) => x.id} empty="Chưa có hoá đơn mua — hoá đơn sinh khi nhập hàng có nhà cung cấp" cols={[
          { key: "c", label: "Mã", title: true, render: (x) => <span><b>{x.code}</b> {x.isProvisional ? <Badge tone="warn">Tạm tính</Badge> : null}</span> },
          { key: "r", label: "Số HĐ NCC", render: (x) => x.supplierRef || "—" },
          { key: "d", label: "Hạn", render: (x) => ymd(x.dueDate) },
          { key: "t", label: "Tổng", right: true, render: (x) => <span className="money">{money(x.total)}</span> },
          { key: "o", label: "Còn nợ", right: true, render: (x) => <span className="money">{money(x.outstanding)}</span> },
          { key: "a", label: "", render: (x) => (x.isProvisional && x.status === "open" && can("debt.write") ? <Button size="sm" onClick={() => setFin(x)}>Chốt hoá đơn</Button> : null) },
        ]} />}
      </div>
      {fin && <FinalizeSheet bill={fin} onClose={() => setFin(null)} onDone={() => { setFin(null); b.reload(); }} />}
      {pay && <PaymentSheet partnerType="supplier" partnerId={s.id} partnerName={s.name} direction="out" onClose={() => setPay(false)} onDone={() => { setPay(false); b.reload(); }} />}
    </Sheet>
  );
}

function FinalizeSheet({ bill, onClose, onDone }: { bill: any; onClose: () => void; onDone: () => void }) {
  const [ref, setRef] = useState(bill.supplierRef ?? ""), [total, setTotal] = useState(bill.total), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const changed = total !== bill.total;
  return (
    <Sheet open onClose={onClose} title={`Chốt hoá đơn ${bill.code}`} footer={<Button block loading={busy} disabled={!ref.trim() || total <= 0 || (changed && reason.trim().length < 3)} onClick={async () => {
      setBusy(true);
      try { await post(`/bills/${bill.id}/finalize`, { supplierRef: ref.trim(), ...(changed ? { total, reason: reason.trim() } : {}) }); toast("Đã chốt hoá đơn mua", "ok"); onDone(); } catch {} finally { setBusy(false); }
    }}>Chốt hoá đơn</Button>}>
      <div className="stack">
        <Banner tone="info">Hoá đơn tạm tính theo phiếu nhập: {money(bill.total)}. Nhập số hoá đơn NCC gửi và chốt giá thực tế.</Banner>
        <Input label="Số hoá đơn của nhà cung cấp" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus />
        <MoneyInput label="Tổng tiền chốt (₫)" value={total} onChange={setTotal} />
        {changed && <><Banner>Chênh lệch giá chốt: <b>{money(total - bill.total)}</b> so với tạm tính — bắt buộc ghi lý do.</Banner><TextArea label="Lý do chênh lệch" value={reason} onChange={(e) => setReason(e.target.value)} /></>}
      </div>
    </Sheet>
  );
}
export { Card };
