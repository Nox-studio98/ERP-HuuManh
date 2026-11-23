import { useState } from "react";
import { get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { toast } from "../components/toast";
import { fmtDateTime, fmtTime, money, todayVN } from "../format";
import { useCan } from "../store";

export default function Finance() {
  const can = useCan();
  const [tab, setTab] = useState<"funds" | "vouchers" | "recon">(can("finance.view") ? "funds" : "recon");
  const opts = [
    ...(can("finance.view") ? [{ v: "funds" as const, label: "Quỹ" }, { v: "vouchers" as const, label: "Phiếu thu chi" }] : []),
    ...(can("finance.shift_reconcile") ? [{ v: "recon" as const, label: "Đối soát ca" }] : []),
  ];
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={opts} />
      {tab === "funds" && <Funds />}
      {tab === "vouchers" && <Vouchers />}
      {tab === "recon" && <Recon />}
    </div>
  );
}

function Funds() {
  const f = useAsync(() => get("/funds").then((r) => items<any>(r)), []);
  if (f.loading) return <Spinner />;
  return <div className="kpis">{(f.data ?? []).map((x) => <div className="kpi" key={x.id}><div className="l">{x.name}</div><div className="v" style={{ color: x.balance < 0 ? "var(--danger)" : undefined }}>{money(x.balance)}</div></div>)}</div>;
}

const vTone = (s: string) => (s === "posted" ? "ok" : s === "pending_approval" ? "warn" : "danger") as any;
function Vouchers() {
  const can = useCan();
  const funds = useAsync(() => get("/funds").then((r) => items<any>(r)), []);
  const cats = useAsync(() => get("/cash-categories").then((r) => items<any>(r)), []);
  const [fundId, setFundId] = useState(""), [dir, setDir] = useState("");
  const v = useAsync(() => get("/vouchers", { fundId, direction: dir, period: todayVN().slice(0, 7) }).then((r) => items<any>(r)), [fundId, dir]);
  const [add, setAdd] = useState(false);
  const [rev, setRev] = useState<any>(null);
  return (
    <div className="stack">
      <div className="grid3">
        <Select label="Quỹ" value={fundId} onChange={(e) => setFundId(e.target.value)}><option value="">Tất cả</option>{(funds.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select label="Loại" value={dir} onChange={(e) => setDir(e.target.value)}><option value="">Thu & chi</option><option value="in">Phiếu thu</option><option value="out">Phiếu chi</option></Select>
        {can("finance.write") && <div style={{ alignSelf: "flex-end" }}><Button block onClick={() => setAdd(true)}>+ Lập phiếu</Button></div>}
      </div>
      {v.loading ? <Spinner /> : <DataTable rows={v.data ?? []} rowKey={(x) => x.id} empty="Chưa có phiếu trong tháng" cols={[
        { key: "c", label: "Mã", title: true, render: (x) => <b>{x.code}</b> },
        { key: "d", label: "Loại", render: (x) => <Badge tone={x.direction === "in" ? "ok" : "warn"}>{x.direction === "in" ? "Thu" : "Chi"}</Badge> },
        { key: "t", label: "Thời gian", render: (x) => fmtDateTime(x.createdAt) },
        { key: "n", label: "Nội dung", render: (x) => x.counterparty || x.note || "—" },
        { key: "s", label: "TT", render: (x) => <Badge tone={vTone(x.status)}>{x.status === "posted" ? "Đã ghi" : x.status === "pending_approval" ? "Chờ duyệt" : x.status}</Badge> },
        { key: "a", label: "Số tiền", right: true, render: (x) => <b className="money" style={{ color: x.direction === "in" ? "var(--accent)" : undefined }}>{x.direction === "in" ? "+" : "−"}{money(x.amount)}</b> },
        { key: "r", label: "", render: (x) => (can("finance.write") && x.status === "posted" && !x.reversesId ? <Button size="sm" variant="ghost" onClick={() => setRev(x)}>Đảo phiếu</Button> : x.reversesId ? <Badge>Phiếu đảo</Badge> : null) },
      ]} />}
      {add && <VoucherForm funds={funds.data ?? []} cats={cats.data ?? []} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); v.reload(); }} />}
      {rev && <ReverseSheet v={rev} onClose={() => setRev(null)} onDone={() => { setRev(null); v.reload(); }} />}
    </div>
  );
}

function VoucherForm({ funds, cats, onClose, onSaved }: { funds: any[]; cats: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ direction: "out", fundId: "", categoryId: "", amount: 0, counterparty: "", note: "" });
  const [busy, setBusy] = useState(false);
  const fc = cats.filter((c) => !c.direction || c.direction === f.direction);
  return (
    <Sheet open onClose={onClose} title="Lập phiếu thu / chi" footer={<Button block size="lg" loading={busy} disabled={!(f.fundId || funds[0]) || !(f.categoryId || fc[0]) || f.amount <= 0} onClick={async () => {
      setBusy(true);
      try { const r = await post("/vouchers", { direction: f.direction, fundId: Number(f.fundId || funds[0]?.id), categoryId: Number(f.categoryId || fc[0]?.id), amount: f.amount, ...(f.counterparty ? { counterparty: f.counterparty } : {}), ...(f.note ? { note: f.note } : {}) }); toast(r?.status === "pending_approval" ? "Phiếu chi lớn — đã gửi duyệt" : "Đã lập phiếu", "ok"); onSaved(); } catch {} finally { setBusy(false); }
    }}>Lưu phiếu</Button>}>
      <div className="stack">
        <div className="seg">{[["out", "Phiếu chi"], ["in", "Phiếu thu"]].map(([k, l]) => <button key={k} aria-pressed={f.direction === k} onClick={() => setF({ ...f, direction: k, categoryId: "" })}>{l}</button>)}</div>
        <Select label="Quỹ" value={f.fundId || funds[0]?.id || ""} onChange={(e) => setF({ ...f, fundId: e.target.value })}>{funds.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Select label="Hạng mục" value={f.categoryId || fc[0]?.id || ""} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>{fc.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <MoneyInput label="Số tiền (₫)" value={f.amount} onChange={(n) => setF({ ...f, amount: n })} />
        <Input label="Đối tượng (người nhận / nộp)" value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} />
        <TextArea label="Ghi chú" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
    </Sheet>
  );
}
function ReverseSheet({ v, onClose, onDone }: { v: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={`Đảo phiếu ${v.code}`} footer={<Button block variant="danger" loading={busy} disabled={!reason.trim()} onClick={async () => { setBusy(true); try { await post(`/vouchers/${v.id}/reverse`, { reason, note: reason }); toast("Đã tạo phiếu đảo", "ok"); onDone(); } catch {} finally { setBusy(false); } }}>Tạo phiếu đảo {money(v.amount)}</Button>}>
      <div className="stack"><Banner>Phiếu cũ không bị sửa; hệ thống tạo phiếu đảo ở kỳ hiện tại.</Banner><TextArea label="Lý do đảo" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Sheet>
  );
}

function Recon() {
  const [day, setDay] = useState(todayVN());
  const r = useAsync(() => get("/reconcile/shifts", { day }).then((x) => items<any>(x)), [day]);
  return (
    <div className="stack">
      <div style={{ maxWidth: 200 }}><Input label="Ngày" type="date" value={day} max={todayVN()} onChange={(e) => setDay(e.target.value)} /></div>
      {r.loading ? <Spinner /> : <DataTable rows={r.data ?? []} rowKey={(x) => x.id} empty="Không có ca trong ngày" rowClass={(x) => (x.diffCash ?? (x.countedCash != null && x.expectedCash != null ? x.countedCash - x.expectedCash : 0) ? "bad" : "")} cols={[
        { key: "s", label: "Ca", title: true, render: (x) => <b>#{x.id} {x.userName ?? x.fullName ?? ""}</b> },
        { key: "t", label: "Giờ", render: (x) => `${fmtTime(x.openedAt)} – ${x.closedAt ? fmtTime(x.closedAt) : "đang mở"}` },
        { key: "e", label: "Dự kiến", right: true, render: (x) => money(x.expectedCash) },
        { key: "c", label: "Kiểm đếm", right: true, render: (x) => money(x.countedCash) },
        { key: "d", label: "Chênh lệch", right: true, render: (x) => { const d = x.diffCash ?? (x.countedCash != null && x.expectedCash != null ? x.countedCash - x.expectedCash : 0); return d ? <Badge tone="warn">{money(d)}</Badge> : <Badge tone="ok">Khớp</Badge>; } },
        { key: "r", label: "Lý do", render: (x) => x.diffReason ?? "—" },
      ]} />}
    </div>
  );
}
