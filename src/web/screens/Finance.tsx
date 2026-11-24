import { useState } from "react";
import { get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { DateRangeFilter, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, rangeOf, usePagedList, type DateRange } from "../components/list";
import { toast } from "../components/toast";
import { fmtDateTime, fmtTime, money, todayVN } from "../format";
import { useCan } from "../store";

type Tab = "funds" | "vouchers" | "recon";
export default function Finance() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>(can("finance.view") ? "funds" : "recon");
  const [fundId, setFundId] = useState("");
  const [add, setAdd] = useState<null | "in" | "out">(null);
  const [tick, setTick] = useState(0);
  const funds = useAsync(() => (can("finance.view") ? get("/funds").then((r) => items<any>(r)) : Promise.resolve([] as any[])), []);
  const cats = useAsync(() => (can("finance.view") ? get("/cash-categories").then((r) => items<any>(r)) : Promise.resolve([] as any[])), []);
  const opts = [
    ...(can("finance.view") ? [{ v: "funds" as const, label: "Quỹ" }, { v: "vouchers" as const, label: "Phiếu thu chi" }] : []),
    ...(can("finance.shift_reconcile") ? [{ v: "recon" as const, label: "Đối soát ca" }] : []),
  ];
  const openVouchers = (fid = "") => { setFundId(fid); setTab("vouchers"); };
  return (
    <div className="stack">
      <PageHeader subtitle={tab === "funds" ? "Số dư các quỹ và phiếu thu chi gần đây" : tab === "vouchers" ? "Sổ phiếu thu / phiếu chi" : "Đối chiếu tiền mặt kiểm đếm với hệ thống theo từng ca"}
        actions={can("finance.write") && tab !== "recon" ? <><Button size="sm" variant="soft" onClick={() => setAdd("in")}>+ Phiếu thu</Button><Button size="sm" onClick={() => setAdd("out")}>+ Phiếu chi</Button></> : undefined} />
      <Segmented fit value={tab} onChange={setTab} options={opts} />
      {tab === "funds" && <Funds funds={funds.data ?? []} loading={funds.loading} reloadKey={tick} onOpen={openVouchers} onAdd={setAdd} />}
      {tab === "vouchers" && <Vouchers key={fundId} funds={funds.data ?? []} cats={cats.data ?? []} fundId={fundId} setFundId={setFundId} reloadKey={tick} onAdd={() => setAdd("out")} />}
      {tab === "recon" && <Recon />}
      {add && <VoucherForm dir={add} funds={funds.data ?? []} cats={cats.data ?? []} onClose={() => setAdd(null)} onSaved={() => { setAdd(null); funds.reload(); setTick((x) => x + 1); }} />}
    </div>
  );
}

const vTone = (s: string) => (s === "posted" ? "ok" : s === "pending_approval" ? "warn" : "danger") as any;
const vLabel = (s: string) => (s === "posted" ? "Đã ghi" : s === "pending_approval" ? "Chờ duyệt" : s === "cancelled" ? "Đã huỷ" : s);
const sgn = (x: any) => (x.direction === "in" ? x.amount : -x.amount);

function Funds({ funds, loading, reloadKey, onOpen, onAdd }: { funds: any[]; loading: boolean; reloadKey: number; onOpen: (fundId?: string) => void; onAdd: (d: "in" | "out") => void }) {
  const can = useCan();
  const monthFrom = rangeOf("month").from, today = todayVN();
  const recent = useAsync(() => get("/vouchers", { from: monthFrom, to: today, limit: 10 }), [reloadKey]);
  const sum = recent.data?.summary;
  const total = funds.reduce((a, f) => a + f.balance, 0);
  if (loading) return <Spinner />;
  return (
    <div className="stack">
      <KpiRow cols={Math.min(5, funds.length + 1)} items={[
        { label: "Tổng số dư", value: <span style={{ color: total < 0 ? "var(--danger)" : undefined }}>{money(total)}</span>, sub: `${funds.length} quỹ` },
        ...funds.map((f) => ({ label: f.name, value: <span style={{ color: f.balance < 0 ? "var(--danger)" : undefined }}>{money(f.balance)}</span>, sub: f.type === "bank" ? "Ngân hàng" : "Tiền mặt", onClick: () => onOpen(String(f.id)) })),
      ]} />
      <div className="two-col wide-left">
        <Card title="Phiếu thu chi gần đây" actions={<Button size="sm" variant="ghost" onClick={() => onOpen()}>Xem tất cả →</Button>}>
          {recent.loading ? <Spinner /> : (
            <DataTable rows={recent.data ? items<any>(recent.data) : []} rowKey={(x) => x.id} onRowClick={() => onOpen()}
              emptyState={<EmptyState title="Tháng này chưa có phiếu thu chi" hint="Lập phiếu để ghi nhận tiền vào / ra các quỹ." action={can("finance.write") ? <div className="row wrap" style={{ justifyContent: "center" }}><Button variant="soft" onClick={() => onAdd("in")}>+ Phiếu thu</Button><Button onClick={() => onAdd("out")}>+ Phiếu chi</Button></div> : undefined} />}
              cols={[
                { key: "c", label: "Mã", title: true, render: (x) => <b className="nw">{x.code}</b> },
                { key: "t", label: "Thời gian", render: (x) => <span className="nw">{fmtDateTime(x.createdAt)}</span> },
                { key: "n", label: "Nội dung", render: (x) => x.counterparty || x.note || x.categoryName || "—" },
                { key: "f", label: "Quỹ", hideBelow: 1440, render: (x) => x.fundName },
                { key: "a", label: "Số tiền", num: true, render: (x) => <b className="money" style={{ color: x.direction === "in" ? "var(--accent)" : undefined }}>{x.direction === "in" ? "+" : "−"}{money(x.amount)}</b> },
              ]} />
          )}
        </Card>
        <div className="stack">
          <KpiRow cols={2} items={[
            { label: "Thu tháng này", value: sum ? money(sum.totalIn) : "—", tone: "ok" },
            { label: "Chi tháng này", value: sum ? money(sum.totalOut) : "—" },
            { label: "Chênh lệch thu − chi", value: sum ? money(sum.totalIn - sum.totalOut) : "—", tone: sum && sum.totalIn - sum.totalOut < 0 ? "danger" : undefined },
            { label: "Phiếu chờ duyệt", value: sum?.pending ?? "—", tone: sum?.pending ? "warn" : undefined },
          ]} />
          {can("finance.write") && (
            <Card title="Thao tác nhanh">
              <div className="quick-actions"><Button variant="soft" onClick={() => onAdd("in")}>+ Phiếu thu</Button><Button onClick={() => onAdd("out")}>+ Phiếu chi</Button><Button variant="ghost" onClick={() => onOpen()}>Sổ phiếu thu chi</Button></div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Vouchers({ funds, cats, fundId, setFundId, reloadKey, onAdd }: { funds: any[]; cats: any[]; fundId: string; setFundId: (v: string) => void; reloadKey: number; onAdd: () => void }) {
  const can = useCan();
  const [range, setRange] = useState<DateRange>(() => rangeOf("month"));
  const [dir, setDir] = useState(""), [status, setStatus] = useState(""), [q, setQ] = useState("");
  const [rev, setRev] = useState<any>(null);
  const list = usePagedList<any>("/vouchers", { from: range.from, to: range.to, fundId, direction: dir, status, q, limit: 50 }, [range.from, range.to, fundId, dir, status, q, reloadKey]);
  const sum = list.extra?.summary;
  const dirty = !!(fundId || dir || status || q);
  const reset = () => { setFundId(""); setDir(""); setStatus(""); setQ(""); };
  return (
    <div className="stack">
      <FilterBar dirty={dirty} onReset={reset} activeCount={[fundId, dir, status].filter(Boolean).length} advanced={<>
        <FilterSelect label="Quỹ" value={fundId} onChange={setFundId} options={funds.map((x) => ({ v: String(x.id), label: x.name }))} />
        <FilterSelect label="Loại" value={dir} onChange={setDir} options={[{ v: "in", label: "Phiếu thu" }, { v: "out", label: "Phiếu chi" }]} allLabel="Thu & chi" />
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={[{ v: "posted", label: "Đã ghi" }, { v: "pending_approval", label: "Chờ duyệt" }, { v: "cancelled", label: "Đã huỷ" }]} />
      </>}>
        <DateRangeFilter value={range} onChange={setRange} />
        <SearchInput value={q} onSearch={setQ} placeholder="Mã phiếu, đối tượng, nội dung…" label="Tìm phiếu" />
        <span style={{ marginLeft: "auto" }} className="row"><ExportButton filename={`phieu-thu-chi-${range.from}_${range.to}`} rows={list.rows} columns={[
          { label: "Mã", value: (x) => x.code }, { label: "Loại", value: (x) => (x.direction === "in" ? "Thu" : "Chi") }, { label: "Thời gian", value: (x) => fmtDateTime(x.createdAt) }, { label: "Quỹ", value: (x) => x.fundName }, { label: "Hạng mục", value: (x) => x.categoryName },
          { label: "Đối tượng", value: (x) => x.counterparty }, { label: "Ghi chú", value: (x) => x.note }, { label: "Trạng thái", value: (x) => vLabel(x.status) }, { label: "Số tiền", value: sgn },
        ]} />{can("finance.write") && <Button size="sm" onClick={onAdd}>+ Lập phiếu</Button>}</span>
      </FilterBar>
      <KpiRow items={[
        { label: "Số phiếu", value: sum?.count ?? "—" },
        { label: "Tổng thu", value: sum ? money(sum.totalIn) : "—", tone: "ok" },
        { label: "Tổng chi", value: sum ? money(sum.totalOut) : "—" },
        { label: "Chênh lệch", value: sum ? money(sum.totalIn - sum.totalOut) : "—", tone: sum && sum.totalIn - sum.totalOut < 0 ? "danger" : undefined, sub: sum?.pending ? `${sum.pending} phiếu chờ duyệt` : undefined },
      ]} />
      {list.loading ? <Spinner /> : <DataTable rows={list.rows} rowKey={(x) => x.id} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore} footer={sum ? `Hiển thị ${list.rows.length}/${sum.count} phiếu` : undefined}
        emptyState={<EmptyState title={dirty ? "Không có phiếu nào khớp bộ lọc" : "Chưa có phiếu trong khoảng này"} hint="Phiếu thu / chi tiền mặt và ngân hàng hiện ở đây." action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{range.preset !== "lastMonth" && <Button variant="ghost" onClick={() => setRange(rangeOf("lastMonth"))}>Xem tháng trước</Button>}{can("finance.write") && <Button onClick={onAdd}>+ Lập phiếu</Button>}</div>} />}
        cols={[
          { key: "c", label: "Mã", title: true, sort: (x) => x.code, render: (x) => <b className="nw">{x.code}</b> },
          { key: "d", label: "Loại", sort: (x) => x.direction, render: (x) => <Badge tone={x.direction === "in" ? "ok" : "warn"}>{x.direction === "in" ? "Thu" : "Chi"}</Badge> },
          { key: "t", label: "Thời gian", sort: (x) => x.createdAt, render: (x) => <span className="nw">{fmtDateTime(x.createdAt)}</span> },
          { key: "n", label: "Nội dung", render: (x) => x.counterparty || x.note || "—" },
          { key: "k", label: "Hạng mục", hideBelow: 1280, sort: (x) => x.categoryName, render: (x) => x.categoryName },
          { key: "f", label: "Quỹ", hideBelow: 1440, sort: (x) => x.fundName, render: (x) => x.fundName },
          { key: "s", label: "TT", render: (x) => <Badge tone={vTone(x.status)}>{vLabel(x.status)}</Badge> },
          { key: "a", label: "Số tiền", num: true, sort: sgn, render: (x) => <b className="money" style={{ color: x.direction === "in" ? "var(--accent)" : undefined }}>{x.direction === "in" ? "+" : "−"}{money(x.amount)}</b> },
          { key: "r", label: "", render: (x) => (can("finance.write") && x.status === "posted" && !x.reversesId ? <Button size="sm" variant="ghost" onClick={() => setRev(x)}>Đảo phiếu</Button> : x.reversesId ? <Badge>Phiếu đảo</Badge> : null) },
        ]} />}
      {rev && <ReverseSheet v={rev} onClose={() => setRev(null)} onDone={() => { setRev(null); list.reload(); }} />}
    </div>
  );
}

function VoucherForm({ dir, funds, cats, onClose, onSaved }: { dir: "in" | "out"; funds: any[]; cats: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ direction: dir as string, fundId: "", categoryId: "", amount: 0, counterparty: "", note: "" });
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
    <Sheet open onClose={onClose} title={`Đảo phiếu ${v.code}`} footer={<Button block variant="danger" loading={busy} disabled={!reason.trim()} onClick={async () => { setBusy(true); try { await post(`/vouchers/${v.id}/reverse`, { reason }); toast("Đã tạo phiếu đảo", "ok"); onDone(); } catch {} finally { setBusy(false); } }}>Tạo phiếu đảo {money(v.amount)}</Button>}>
      <div className="stack"><Banner>Phiếu cũ không bị sửa; hệ thống tạo phiếu đảo ở kỳ hiện tại.</Banner><TextArea label="Lý do đảo" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Sheet>
  );
}

function Recon() {
  const [day, setDay] = useState(todayVN());
  const r = useAsync(() => get("/reconcile/shifts", { day }).then((x) => items<any>(x)), [day]);
  const rows = r.data ?? [];
  return (
    <div className="stack">
      <FilterBar>
        <Input label="Ngày" type="date" value={day} max={todayVN()} onChange={(e) => setDay(e.target.value)} />
        <Button size="sm" variant="ghost" onClick={() => setDay(todayVN(-1))}>Hôm qua</Button><Button size="sm" variant="ghost" onClick={() => setDay(todayVN())}>Hôm nay</Button>
        <span style={{ marginLeft: "auto" }}><ExportButton filename={`doi-soat-ca-${day}`} rows={r.data ?? []} columns={[{ label: "Ca", value: (x: any) => x.id }, { label: "Thu ngân", value: (x: any) => x.cashierName }, { label: "Dự kiến", value: (x: any) => x.expectedCash }, { label: "Kiểm đếm", value: (x: any) => x.countedCash }, { label: "Chênh lệch", value: (x: any) => x.diff }, { label: "Lý do", value: (x: any) => x.diffReason }]} /></span>
      </FilterBar>
      {!r.loading && <KpiRow items={[
        { label: "Số ca", value: rows.length },
        { label: "Tiền mặt dự kiến", value: money(rows.reduce((a, x) => a + (x.expectedCash ?? 0), 0)) },
        { label: "Kiểm đếm", value: money(rows.reduce((a, x) => a + (x.countedCash ?? 0), 0)) },
        { label: "Ca lệch tiền", value: rows.filter((x) => x.diff).length, tone: rows.some((x) => x.diff) ? "warn" : "ok", sub: rows.some((x) => x.diff) ? `Tổng lệch ${money(rows.reduce((a, x) => a + (x.diff ?? 0), 0))}` : "Tất cả khớp" },
      ]} />}
      {r.loading ? <Spinner /> : <DataTable rows={rows} rowKey={(x) => x.id} emptyState={<EmptyState title="Không có ca nào trong ngày này" hint="Ca bán hàng được mở ở màn Bán hàng." action={<Button variant="ghost" onClick={() => setDay(todayVN(-1))}>Xem hôm qua</Button>} />} rowClass={(x) => (x.diff ? "bad" : "")} cols={[
        { key: "s", label: "Ca", title: true, render: (x) => <b>#{x.id} {x.cashierName ?? ""}</b> },
        { key: "t", label: "Giờ", render: (x) => `${fmtTime(x.openedAt)} – ${x.closedAt ? fmtTime(x.closedAt) : "đang mở"}` },
        { key: "e", label: "Dự kiến", right: true, render: (x) => money(x.expectedCash) },
        { key: "c", label: "Kiểm đếm", right: true, render: (x) => x.countedCash != null ? money(x.countedCash) : "—" },
        { key: "d", label: "Chênh lệch", right: true, render: (x) => { if (x.status !== "closed") return <Badge>Đang mở</Badge>; const d = x.diff ?? 0; return d ? <Badge tone="warn">{money(d)}</Badge> : <Badge tone="ok">Khớp</Badge>; } },
        { key: "r", label: "Lý do", render: (x) => x.diffReason ?? "—" },
      ]} />}
    </div>
  );
}
