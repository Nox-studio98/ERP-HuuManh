import { useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Badge, Banner, Button, EmptyState, Input, MoneyInput, Segmented, Sheet, Spinner, useAsync, useDebounced } from "./ui";
import { QrImage } from "./QrImage";
import { toast } from "./toast";
import { fmtDate, money, uuid } from "../format";
import { useCan } from "../store";

type Cust = { id: number; name: string; phone?: string | null; code?: string };

/** POS-KV B1: "Thu nợ" tại quầy — chọn khách lẻ → hoá đơn đang nợ → thu tiền mặt (vào két của ca) hoặc quét mã QR HDS (tự xác nhận). Ghi chuyển khoản thủ công chỉ có khi có quyền finance.write. */
export function PosDebtSheet({ onClose }: { onClose: () => void }) {
  const [cust, setCust] = useState<Cust | null>(null);
  return (
    <Sheet open onClose={onClose} title="Thu nợ khách lẻ" wide>
      {cust ? <DebtBody cust={cust} onBack={() => setCust(null)} /> : <Pick onPick={setCust} />}
    </Sheet>
  );
}

function Pick({ onPick }: { onPick: (c: Cust) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const res = useAsync(async () => {
    if (dq.trim().length < 2) return { list: [] as any[], denied: false };
    try { return { list: items<any>(await get("/pos/customers", { q: dq.trim() }, { silent: true })), denied: false }; }
    catch (e) { if (e instanceof ApiError && e.status === 403) return { list: [], denied: true }; throw e; }
  }, [dq]);
  return (
    <div className="stack">
      <Input label="Tên, mã hoặc số điện thoại khách" type="search" autoFocus data-testid="debt-search" value={q} onChange={(e) => setQ(e.target.value)} />
      {res.data?.denied && <Banner tone="info">Tài khoản này không có quyền tra cứu khách — nhờ quản lý thu nợ.</Banner>}
      {res.loading ? <Spinner /> : res.data?.list.map((c) => (
        <button key={c.id} className="dt-card" data-testid="debt-pick" onClick={() => onPick({ id: c.id, name: c.name, phone: c.phone, code: c.code })}>
          <div className="ttl">{c.name}</div><div className="small muted">{c.code}{c.phone ? " · " + c.phone : ""}</div>
        </button>
      ))}
      {!res.loading && dq.trim().length >= 2 && !res.data?.denied && !res.data?.list.length && <div className="muted">Không tìm thấy khách.</div>}
      {dq.trim().length < 2 && <div className="hint">Gõ ít nhất 2 ký tự để tìm khách đang nợ.</div>}
    </div>
  );
}

function DebtBody({ cust, onBack }: { cust: Cust; onBack: () => void }) {
  const can = useCan();
  const canTransfer = can("finance.write"); // thu ngân không tự khai chuyển khoản — khách chuyển khoản thì quét QR để hệ thống tự xác nhận
  const d = useAsync(() => get(`/pos/customers/${cust.id}/debts`), [cust.id]);
  const [sel, setSel] = useState<number | 0>(0); // 0 = cũ nhất trước
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<"cash" | "transfer">("cash");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ code: string; amount: number } | null>(null);
  const [qr, setQr] = useState<any>(null);
  const data = d.data;
  if (d.loading || !data) return <Spinner />;
  const invoices: any[] = data.invoices;
  const target = sel ? invoices.find((i) => i.id === sel) : null;
  const cap = target ? target.outstanding : data.outstanding;
  const amt = amount ?? cap;
  const valid = amt > 0 && amt <= cap;
  const pay = async () => {
    setBusy(true);
    try {
      const r = await post("/pos/debt-payments", { customerId: cust.id, amount: amt, method, ...(target ? { invoiceId: target.id } : {}), idempotencyKey: uuid() }, { silent: true });
      setDone({ code: r.payment?.code ?? "", amount: amt });
      toast(`Đã thu nợ ${money(amt)}`, "ok");
      setAmount(null); setSel(0); setQr(null); d.reload();
      window.dispatchEvent(new Event("hm:shift"));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Không thu được nợ", "error");
      if (e instanceof ApiError && e.code === "amount_exceeds_debt") d.reload();
    } finally { setBusy(false); }
  };
  const showQr = async (id: number) => {
    try { const r = await post(`/pos/invoices/${id}/pay-info`, {}, { silent: true }); setQr(r?.available ? r : { unavailable: true }); } catch { setQr({ unavailable: true }); }
  };
  return (
    <div className="stack" data-testid="debt-body">
      <div className="row between"><Button size="sm" variant="ghost" onClick={onBack}>← Đổi khách</Button><span style={{ textAlign: "right" }}><b>{data.customer.name}</b><div className="small muted">{data.customer.code}{data.customer.phone ? ` · ${data.customer.phone}` : ""}</div></span></div>
      <div className="grid2">
        <div className="kpi"><div className="l">Còn nợ</div><div className="v money" data-testid="debt-outstanding">{money(data.outstanding)}</div></div>
        <div className="kpi"><div className="l">Quá hạn</div><div className="v money" style={{ color: data.overdueAmount > 0 ? "var(--danger)" : undefined }}>{money(data.overdueAmount)}</div></div>
      </div>
      <div className="small muted">Hạn mức nợ {data.customer.creditLimit > 0 ? money(data.customer.creditLimit) : "chưa đặt"} · còn được nợ thêm {money(data.available)}</div>
      {done && <Banner tone="info"><span data-testid="debt-done">Đã thu {money(done.amount)}{done.code ? ` (phiếu ${done.code})` : ""}.</span></Banner>}
      {!invoices.length ? <EmptyState title="Khách không còn nợ" hint={done ? "Đã thu đủ." : "Không có hoá đơn nào còn nợ."} /> : (
        <>
          <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label="Hoá đơn cần thu">
            <button className="card flat row between" role="radio" aria-checked={sel === 0} data-testid="debt-all" onClick={() => { setSel(0); setAmount(null); setQr(null); }} style={{ textAlign: "left", cursor: "pointer", outline: sel === 0 ? "2px solid var(--accent)" : undefined }}>
              <span><b>Tất cả hoá đơn</b><div className="small muted">Gạch hoá đơn cũ nhất trước</div></span><b className="money">{money(data.outstanding)}</b>
            </button>
            {invoices.map((i) => (
              <button key={i.id} className="card flat row between" role="radio" aria-checked={sel === i.id} data-testid="debt-invoice" onClick={() => { setSel(i.id); setAmount(null); setQr(null); }} style={{ textAlign: "left", cursor: "pointer", outline: sel === i.id ? "2px solid var(--accent)" : undefined }}>
                <span><b className="nw">{i.code}</b>{i.orderCode && <div className="small muted nw">đơn {i.orderCode}</div>}
                  <div className="small muted">Hạn {fmtDate(i.dueDate)}{i.overdueDays > 0 && <> <Badge tone="danger">quá {i.overdueDays} ngày</Badge></>}</div></span>
                <b className="money">{money(i.outstanding)}</b>
              </button>
            ))}
          </div>
          {canTransfer
            ? <Segmented value={method} onChange={setMethod} fit options={[{ v: "cash", label: "Tiền mặt" }, { v: "transfer", label: "Chuyển khoản" }]} />
            : <div className="hint">Thu tiền mặt tại quầy. Khách chuyển khoản: bấm “Hiện mã QR thu nợ” để khách quét, hệ thống tự gạch nợ khi tiền về.</div>}
          <MoneyInput label="Số tiền thu (₫)" value={amt} onChange={(n) => setAmount(n)} hint={`Tối đa ${money(cap)}`} />
          {method === "cash" && <div className="hint">Tiền mặt vào két của ca đang mở và được tính vào tiền mặt dự kiến khi chốt ca.</div>}
          {target && (
            <div className="stack">
              <Button variant="soft" onClick={() => showQr(target.id)} data-testid="debt-qr-btn">Hiện mã QR thu nợ</Button>
              {qr?.unavailable && <div className="hint">Chưa bật xác nhận chuyển khoản tự động (Cài đặt → Thanh toán SePay).</div>}
              {qr?.qrPayload && (
                <div className="qr-wait" data-testid="debt-qr">
                  <QrImage value={qr.qrPayload} size={200} label={`Mã QR thu nợ ${money(qr.amount)}`} />
                  <b className="num">{qr.code}</b>
                  <span className="small muted">Khách quét mã, hệ thống tự gạch nợ khi tiền về ({money(qr.amount)}).</span>
                </div>
              )}
            </div>
          )}
          <Button size="lg" block loading={busy} disabled={!valid} onClick={pay} data-testid="debt-pay">Thu {money(amt)}</Button>
        </>
      )}
    </div>
  );
}
