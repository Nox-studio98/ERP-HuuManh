import { useRef, useState } from "react";
import { get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { money, todayVN } from "../../format";
import { useCan } from "../../store";
import { CustomerSelect, SupplierSelect, ymd } from "./kit";

export default function Bank() {
  const can = useCan();
  const [tab, setTab] = useState<"bank" | "settle">(can("debt.view") ? "bank" : "settle");
  const opts = [...(can("debt.view") ? [{ v: "bank" as const, label: "Giao dịch ngân hàng" }] : []), ...(can("finance.write") ? [{ v: "settle" as const, label: "Đối soát COD / sàn" }] : [])];
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={opts} />
      {tab === "bank" ? <BankTxns /> : <Settlements />}
    </div>
  );
}

const SAMPLE = "date,amount,description,ref\n" + todayVN() + ",500000,Chuyen khoan thanh toan,FT" + Date.now().toString().slice(-6);
function BankTxns() {
  const can = useCan();
  const funds = useAsync(() => get("/funds", undefined, { silent: true }).then((r) => items<any>(r).filter((f) => f.type === "bank" && f.active)), []);
  const [fundId, setFundId] = useState(""), [csv, setCsv] = useState(""), [busy, setBusy] = useState(false), [res, setRes] = useState<any>(null);
  const [status, setStatus] = useState("unmatched");
  const list = useAsync(() => get("/bank-transactions", { status, limit: 100 }).then((r) => items<any>(r)), [status]);
  const [match, setMatch] = useState<any>(null);
  const file = useRef<HTMLInputElement>(null);
  const fid = fundId || String(funds.data?.[0]?.id ?? "");
  const ST: Record<string, string> = { unmatched: "Chưa khớp", matched: "Đã khớp", ignored: "Bỏ qua" };
  const imp = async () => {
    setBusy(true); setRes(null);
    try { const r = await post("/bank-transactions/import", { fundId: Number(fid), csv }); setRes(r); toast(`Nhập ${r.imported} giao dịch, tự khớp ${r.matched}`, "ok"); list.reload(); } catch {} finally { setBusy(false); }
  };
  return (
    <div className="stack">
      {can("debt.write") && (
        <Card title="Nhập sao kê ngân hàng (CSV)">
          <div className="stack">
            <div className="hint">Cột: <code>date, amount, description, ref</code>. Tiền vào dương, tiền ra âm. Giao dịch trùng (quỹ + ref) bị bỏ qua; nội dung chứa mã khách <b>KH-xxxx</b> hoặc số hoá đơn sẽ tự khớp.</div>
            <Select label="Tài khoản ngân hàng" value={fid} onChange={(e) => setFundId(e.target.value)}>{(funds.data ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
            <TextArea label="Dán nội dung CSV" value={csv} onChange={(e) => setCsv(e.target.value)} rows={5} placeholder={SAMPLE} style={{ fontFamily: "ui-monospace, monospace" } as any} />
            <div className="row wrap">
              <input ref={file} type="file" accept=".csv,text/csv,text/plain" hidden aria-label="Chọn tệp CSV" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); e.target.value = ""; }} />
              <Button variant="ghost" onClick={() => file.current?.click()}>Chọn tệp CSV…</Button>
              <Button loading={busy} disabled={!csv.trim() || !fid} onClick={imp}>Nhập giao dịch</Button>
            </div>
            {res && <Banner tone="info">Đã nhập {res.imported} · tự khớp {res.matched} · chưa khớp {res.unmatched} · trùng {res.duplicates} · lỗi dòng {res.invalid}.</Banner>}
          </div>
        </Card>
      )}
      <Select label="Hiển thị" value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      {list.loading ? <Spinner /> : (
        <DataTable rows={list.data ?? []} rowKey={(x) => x.id} onRowClick={(x) => x.status === "unmatched" && can("debt.write") && setMatch(x)} empty={status === "unmatched" ? "Không có giao dịch chưa khớp" : "Không có giao dịch"} cols={[
          { key: "d", label: "Ngày", title: true, render: (x) => <b>{ymd(x.txnDate)}</b> },
          { key: "n", label: "Nội dung", render: (x) => x.description || "—" },
          { key: "r", label: "Mã GD", hideMobile: true, render: (x) => <span className="num small">{x.bankRef}</span> },
          { key: "s", label: "Trạng thái", render: (x) => <Badge tone={x.status === "matched" ? "ok" : x.status === "unmatched" ? "warn" : undefined}>{ST[x.status] ?? x.status}</Badge> },
          { key: "a", label: "Số tiền", right: true, render: (x) => <b className="money" style={{ color: x.amount > 0 ? "var(--accent)" : "var(--danger)" }}>{x.amount > 0 ? "+" : ""}{money(x.amount)}</b> },
        ]} />
      )}
      {match && <MatchSheet txn={match} onClose={() => setMatch(null)} onDone={() => { setMatch(null); list.reload(); }} />}
    </div>
  );
}

function MatchSheet({ txn, onClose, onDone }: { txn: any; onClose: () => void; onDone: () => void }) {
  const isIn = txn.amount > 0;
  const [p, setP] = useState<{ id: number; name: string } | null>(null);
  const [ignore, setIgnore] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (ignore) await post(`/bank-transactions/${txn.id}/match`, { ignore: true, reason: reason.trim() });
      else { const r = await post(`/bank-transactions/${txn.id}/match`, { partnerType: isIn ? "customer" : "supplier", partnerId: p!.id }); toast(`Đã ghi phiếu ${r.payment.code}${r.unapplied ? ` — dư ${money(r.unapplied)}` : ""}`, "ok"); }
      onDone();
    } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Khớp giao dịch" footer={<Button block loading={busy} disabled={ignore ? reason.trim().length < 3 : !p} onClick={submit}>{ignore ? "Bỏ qua giao dịch" : isIn ? "Khớp & ghi phiếu thu" : "Khớp & ghi phiếu chi"}</Button>}>
      <div className="stack">
        <div className="card flat"><div className="row between"><b className="money" style={{ color: isIn ? "var(--accent)" : "var(--danger)" }}>{money(txn.amount)}</b><span className="muted small">{ymd(txn.txnDate)}</span></div><div className="small">{txn.description}</div></div>
        <Segmented value={ignore ? "ig" : "m"} onChange={(v) => setIgnore(v === "ig")} options={[{ v: "m", label: isIn ? "Khớp với khách" : "Khớp với NCC" }, { v: "ig", label: "Bỏ qua" }]} />
        {ignore ? <TextArea label="Lý do bỏ qua" value={reason} onChange={(e) => setReason(e.target.value)} /> : (isIn ? <CustomerSelect value={p} onChange={setP} /> : <SupplierSelect value={p} onChange={setP} />)}
        {!ignore && <div className="hint">Tiền được gạch vào hoá đơn cũ nhất; phần dư giữ làm số dư có.</div>}
      </div>
    </Sheet>
  );
}

type SLine = { ref: string; expected: number; received: number; fee: number };
function Settlements() {
  const l = useAsync(() => get("/settlements", { limit: 50 }).then((r) => items<any>(r)), []);
  const [add, setAdd] = useState(false), [sel, setSel] = useState<any>(null);
  const ST: Record<string, string> = { draft: "Nháp", confirmed: "Đã xác nhận" };
  return (
    <div className="stack">
      <div><Button onClick={() => setAdd(true)}>+ Tạo đợt đối soát</Button></div>
      {l.loading ? <Spinner /> : <DataTable rows={l.data ?? []} rowKey={(x) => x.id} onRowClick={setSel} empty="Chưa có đợt đối soát" cols={[
        { key: "c", label: "Mã", title: true, render: (x) => <b>{x.code}</b> },
        { key: "s", label: "Nguồn", render: (x) => `${x.source} · ${x.externalRef}` },
        { key: "st", label: "Trạng thái", render: (x) => <Badge tone={x.status === "confirmed" ? "ok" : "warn"}>{ST[x.status] ?? x.status}</Badge> },
        { key: "e", label: "Phải nhận", right: true, render: (x) => <span className="money">{money(x.expectedAmount)}</span> },
        { key: "f", label: "Phí", right: true, hideMobile: true, render: (x) => <span className="money">{money(x.feeAmount)}</span> },
        { key: "r", label: "Thực nhận", right: true, render: (x) => <span className="money">{money(x.receivedAmount)}</span> },
        { key: "d", label: "Chênh lệch", right: true, render: (x) => (x.diffAmount ? <Badge tone="warn">{money(x.diffAmount)}</Badge> : <Badge tone="ok">Khớp</Badge>) },
      ]} />}
      {add && <SettlementForm onClose={() => setAdd(false)} onSaved={() => { setAdd(false); l.reload(); }} />}
      {sel && <SettlementDetail id={sel.id} onClose={() => setSel(null)} onChanged={l.reload} />}
    </div>
  );
}
function SettlementForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const funds = useAsync(() => get("/funds", undefined, { silent: true }).then((r) => items<any>(r).filter((f) => f.active)), []);
  const [source, setSource] = useState("cod"), [ext, setExt] = useState(""), [fundId, setFundId] = useState(""), [diffReason, setDiffReason] = useState("");
  const [lines, setLines] = useState<SLine[]>([{ ref: "", expected: 0, received: 0, fee: 0 }]);
  const [busy, setBusy] = useState(false);
  const fid = fundId || String((funds.data ?? []).find((f: any) => /clearing/.test(f.type))?.id ?? funds.data?.[0]?.id ?? "");
  const exp = lines.reduce((s, x) => s + x.expected, 0), rec = lines.reduce((s, x) => s + x.received, 0), fee = lines.reduce((s, x) => s + x.fee, 0);
  const diff = rec - (exp - fee);
  const set = (i: number, p: Partial<SLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <Sheet open wide onClose={onClose} title="Tạo đợt đối soát" footer={<Button block size="lg" loading={busy} disabled={!ext.trim() || !fid || lines.some((x) => !x.ref.trim()) || (diff !== 0 && diffReason.trim().length < 3)} onClick={async () => {
      setBusy(true);
      try { await post("/settlements", { source, externalRef: ext.trim(), fundId: Number(fid), ...(diff !== 0 ? { diffReason: diffReason.trim() } : {}), lines: lines.map((x) => ({ externalOrderId: x.ref.trim(), expectedAmount: x.expected, receivedAmount: x.received, feeAmount: x.fee })) }); toast("Đã tạo đợt đối soát", "ok"); onSaved(); } catch {} finally { setBusy(false); }
    }}>Lưu đợt đối soát</Button>}>
      <div className="stack">
        <div className="grid2">
          <Select label="Nguồn" value={source} onChange={(e) => setSource(e.target.value)}><option value="cod">COD (đơn vị giao hàng)</option><option value="fresco">Sàn Fresco</option><option value="khac">Khác</option></Select>
          <Input label="Mã đợt / mã tham chiếu đối tác" value={ext} onChange={(e) => setExt(e.target.value)} />
        </div>
        <Select label="Quỹ đối soát" value={fid} onChange={(e) => setFundId(e.target.value)}>{(funds.data ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>
        {lines.map((x, i) => (
          <div key={i} className="card flat stack">
            <Input label="Mã đơn (sàn / nội bộ)" value={x.ref} onChange={(e) => set(i, { ref: e.target.value })} />
            <div className="grid3"><MoneyInput label="Phải nhận" value={x.expected} onChange={(n) => set(i, { expected: n })} /><MoneyInput label="Phí" value={x.fee} onChange={(n) => set(i, { fee: n })} /><MoneyInput label="Thực nhận" value={x.received} onChange={(n) => set(i, { received: n })} /></div>
            {lines.length > 1 && <Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Bỏ dòng</Button>}
          </div>
        ))}
        <Button variant="soft" onClick={() => setLines([...lines, { ref: "", expected: 0, received: 0, fee: 0 }])}>+ Thêm dòng</Button>
        <div className="card flat"><div className="row between"><span>Phải nhận − phí</span><b className="money">{money(exp - fee)}</b></div><div className="row between"><span>Thực nhận</span><b className="money">{money(rec)}</b></div>
          <div className="row between"><span>Chênh lệch</span><b className="money" style={{ color: diff ? "var(--warn)" : "var(--accent)" }} data-testid="diff">{money(diff)}</b></div></div>
        {diff !== 0 && <TextArea label="Lý do chênh lệch (bắt buộc)" value={diffReason} onChange={(e) => setDiffReason(e.target.value)} />}
      </div>
    </Sheet>
  );
}
function SettlementDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const s = useAsync(() => get(`/settlements/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const d = s.data;
  return (
    <Sheet open wide onClose={onClose} title={d ? `Đối soát ${d.code}` : "Đối soát"} footer={d?.status === "draft" && can("finance.write") ? <Button block size="lg" loading={busy} onClick={async () => { setBusy(true); try { await post(`/settlements/${id}/confirm`); toast("Đã xác nhận — lập phiếu thu và phiếu chi phí", "ok"); s.reload(); onChanged(); } catch {} finally { setBusy(false); } }}>Xác nhận đối soát</Button> : undefined}>
      {s.loading || !d ? <Spinner /> : (
        <div className="stack">
          <div className="kpis">
            <div className="kpi"><div className="l">Phải nhận</div><div className="v">{money(d.expectedAmount)}</div></div>
            <div className="kpi"><div className="l">Phí</div><div className="v">{money(d.feeAmount)}</div></div>
            <div className="kpi"><div className="l">Thực nhận</div><div className="v">{money(d.receivedAmount)}</div></div>
            <div className="kpi"><div className="l">Chênh lệch</div><div className="v" style={{ color: d.diffAmount ? "var(--warn)" : undefined }}>{money(d.diffAmount)}</div></div>
          </div>
          {d.diffReason && <Banner>Lý do chênh lệch: {d.diffReason}</Banner>}
          <DataTable rows={d.lines} rowKey={(x: any) => x.id} cols={[
            { key: "o", label: "Đơn", title: true, render: (x: any) => x.externalOrderId ?? `#${x.orderId}` },
            { key: "e", label: "Phải nhận", right: true, render: (x: any) => <span className="money">{money(x.expectedAmount)}</span> },
            { key: "f", label: "Phí", right: true, render: (x: any) => <span className="money">{money(x.feeAmount)}</span> },
            { key: "r", label: "Thực nhận", right: true, render: (x: any) => <span className="money">{money(x.receivedAmount)}</span> },
          ]} />
          {d.status === "confirmed" && <Banner tone="info">Đã xác nhận: đã lập phiếu thu số thực nhận và phiếu chi phí sàn.</Banner>}
        </div>
      )}
    </Sheet>
  );
}
export { EmptyState, DecInput };
