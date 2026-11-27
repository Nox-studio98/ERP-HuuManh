import { useState } from "react";
import { ApiError, get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { DateRangeFilter, DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, rangeOf, type DateRange } from "../../components/list";
import { toast } from "../../components/toast";
import { METHODS, downloadHref, fmtDateTime, money, num, todayVN } from "../../format";
import { navigate } from "../../router";
import { useCan } from "../../store";
import { ADJ_TYPE, Lnk, ReasonSheet, SupplierSelect, CustomerSelect, qparam, ymd } from "./kit";

type PT = "customer" | "supplier";
const BK: { k: string; label: string; color: string }[] = [
  { k: "current", label: "Chưa đến hạn", color: "var(--accent)" },
  { k: "d1_30", label: "1–30 ngày", color: "var(--info)" },
  { k: "d31_60", label: "31–60 ngày", color: "#c98a1b" },
  { k: "d61_90", label: "61–90 ngày", color: "var(--warn)" },
  { k: "over90", label: "Trên 90 ngày", color: "var(--danger)" },
];
const getRaw = (p: string, q?: any) => get(p, q, { raw: true });

export default function Debts() {
  const can = useCan();
  const [tab, setTab] = useState<"recv" | "pay" | "pays" | "remind" | "adj" | "open">("recv");
  const pre = qparam("statement");
  const [stmt, setStmt] = useState<{ pt: PT; id: number; name?: string } | null>(pre && /^(customer|supplier):\d+$/.test(pre) ? { pt: pre.split(":")[0] as PT, id: Number(pre.split(":")[1]) } : null);
  const [pay, setPay] = useState<{ pt: PT } | null>(null);
  const subtitle: Record<string, string> = { recv: "Công nợ khách hàng theo tuổi nợ — bấm một khách để xem sao kê", pay: "Công nợ nhà cung cấp theo tuổi nợ", pays: "Sổ phiếu thu / chi công nợ", remind: "Khách sắp đến hạn hoặc quá hạn", adj: "Chiết khấu, xoá nợ, cấn trừ", open: "Số dư công nợ đầu kỳ" };
  return (
    <div className="stack">
      <PageHeader subtitle={subtitle[tab]} actions={can("debt.write") && (tab === "recv" || tab === "pay") ? <Button size="sm" onClick={() => setPay({ pt: tab === "pay" ? "supplier" : "customer" })}>{tab === "pay" ? "+ Trả tiền NCC" : "+ Thu tiền khách"}</Button> : undefined} />
      <Segmented fit wrap value={tab} onChange={setTab} options={[{ v: "recv", label: "Phải thu" }, { v: "pay", label: "Phải trả" }, { v: "pays", label: "Phiếu thu/chi" }, { v: "remind", label: "Nhắc nợ" }, { v: "adj", label: "Điều chỉnh" }, { v: "open", label: "Đầu kỳ" }]} />
      <SplitLayout open={!!stmt} panel={stmt ? <PartnerSheet key={`${stmt.pt}:${stmt.id}`} pt={stmt.pt} id={stmt.id} name={stmt.name} onClose={() => { setStmt(null); if (pre) history.replaceState({}, "", "/debts"); }} /> : null}>
        <div className="stack">
          {tab === "recv" && <Aging side="receivable" selected={stmt?.pt === "customer" ? stmt.id : null} onOpen={(r) => setStmt({ pt: "customer", id: r.customerId, name: r.customerName })} />}
          {tab === "pay" && <Aging side="payable" selected={stmt?.pt === "supplier" ? stmt.id : null} onOpen={(r) => setStmt({ pt: "supplier", id: r.supplierId, name: r.supplierName })} />}
          {tab === "pays" && <AllPayments />}
          {tab === "remind" && <Reminders />}
          {tab === "adj" && <Adjustments />}
          {tab === "open" && <Opening />}
        </div>
      </SplitLayout>
      {pay && <PickPartnerPay pt={pay.pt} onClose={() => setPay(null)} />}
    </div>
  );
}

function AllPayments() {
  const can = useCan();
  const [range, setRange] = useState<DateRange>(() => rangeOf("month"));
  const [dir, setDir] = useState(""), [kind, setKind] = useState<"" | PT>(""), [status, setStatus] = useState(""), [q, setQ] = useState("");
  const [partner, setPartner] = useState<{ id: number; name: string } | null>(null);
  const [rev, setRev] = useState<any>(null);
  const l = useAsync(() => get("/debts/payments", { direction: dir, partnerType: kind, partnerId: partner?.id, from: range.from, to: range.to, status, limit: 100 }).then((r) => items<any>(r)), [dir, kind, partner?.id, range.from, range.to, status]);
  const term = q.trim().toLowerCase();
  const rows = (l.data ?? []).filter((p) => !term || `${p.code} ${p.partnerName ?? ""} ${p.ref ?? ""}`.toLowerCase().includes(term));
  const sum = rows.filter((p) => p.status === "posted").reduce((a, p) => ({ in: a.in + (p.direction === "in" ? p.amount : 0), out: a.out + (p.direction === "out" ? p.amount : 0) }), { in: 0, out: 0 });
  const dirty = !!(dir || kind || status || q || partner);
  const reset = () => { setDir(""); setKind(""); setStatus(""); setQ(""); setPartner(null); };
  return (
    <div className="stack" data-testid="all-payments">
      <FilterBar dirty={dirty} onReset={reset} activeCount={[dir, kind, status].filter(Boolean).length} advanced={<>
        <FilterSelect label="Loại phiếu" value={dir} onChange={setDir} allLabel="Thu và chi" options={[{ v: "in", label: "Phiếu thu (khách trả)" }, { v: "out", label: "Phiếu chi (trả NCC)" }]} />
        <FilterSelect label="Đối tác" value={kind} onChange={(v) => { setKind(v as any); setPartner(null); }} options={[{ v: "customer", label: "Khách hàng" }, { v: "supplier", label: "Nhà cung cấp" }]} />
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={[{ v: "posted", label: "Đã ghi" }, { v: "reversed", label: "Đã đảo" }]} />
      </>}>
        <DateRangeFilter value={range} onChange={setRange} />
        <SearchInput value={q} onSearch={setQ} placeholder="Mã phiếu, đối tác…" label="Tìm phiếu" />
        <span style={{ marginLeft: "auto" }}><ExportButton filename={`phieu-thu-chi-cong-no-${range.from}_${range.to}`} rows={rows} columns={[{ label: "Mã", value: (p) => p.code }, { label: "Ngày", value: (p) => fmtDateTime(p.paidAt) }, { label: "Loại", value: (p) => (p.direction === "in" ? "Thu" : "Chi") }, { label: "Đối tác", value: (p) => p.partnerName }, { label: "Hình thức", value: (p) => METHODS[p.method] ?? p.method }, { label: "Trạng thái", value: (p) => p.status }, { label: "Số tiền", value: (p) => p.amount }]} /></span>
      </FilterBar>
      {kind && <div style={{ maxWidth: 420 }}>{kind === "customer" ? <CustomerSelect value={partner as any} onChange={setPartner} label="Lọc theo khách" /> : <SupplierSelect value={partner} onChange={setPartner} />}</div>}
      <KpiRow items={[{ label: "Số phiếu", value: rows.length }, { label: "Tổng thu (đã ghi)", value: money(sum.in), tone: "ok" }, { label: "Tổng chi (đã ghi)", value: money(sum.out) }, { label: "Chênh lệch", value: money(sum.in - sum.out) }]} />
      {l.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(p) => p.id} pageSize={50} emptyState={<EmptyState title={dirty ? "Không có phiếu nào khớp bộ lọc" : "Chưa có phiếu trong khoảng này"} action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}<Button variant="ghost" onClick={() => setRange(rangeOf("lastMonth"))}>Xem tháng trước</Button></div>} />} cols={[
          { key: "c", label: "Mã", title: true, sort: (p) => p.code, render: (p) => <b className="nw">{p.code}</b> },
          { key: "d", label: "Ngày", sort: (p) => p.paidAt, render: (p) => <span className="nw">{fmtDateTime(p.paidAt)}</span> },
          { key: "k", label: "Loại", render: (p) => <Badge tone={p.direction === "in" ? "ok" : "info"}>{p.direction === "in" ? "Thu" : "Chi"}</Badge> },
          { key: "n", label: "Đối tác", sort: (p) => p.partnerName ?? "", render: (p) => p.partnerName ?? `#${p.partnerId}` },
          { key: "m", label: "Hình thức", hideMobile: true, hideBelow: 1280, render: (p) => METHODS[p.method] ?? p.method },
          { key: "s", label: "Trạng thái", render: (p) => (p.status === "posted" ? <Badge tone="ok">Đã ghi</Badge> : <Badge tone="danger">Đã đảo</Badge>) },
          { key: "a", label: "Số tiền", num: true, sort: (p) => p.amount, render: (p) => <span className="money">{money(p.amount)}</span> },
          { key: "r", label: "", render: (p) => (can("debt.write") && p.status === "posted" ? <Button size="sm" variant="ghost" onClick={() => setRev(p)}>Đảo phiếu</Button> : null) },
        ]} />
      )}
      {rev && <ReasonSheet title={`Đảo phiếu ${rev.code}`} confirm={`Đảo phiếu ${money(rev.amount)}`} danger onClose={() => setRev(null)} onSubmit={async (reason) => { await post(`/debts/payments/${rev.id}/reverse`, { reason }); toast("Đã đảo phiếu — tạo phiếu đảo ở kỳ hiện tại", "ok"); setRev(null); l.reload(); }}>
        <Banner>Phiếu cũ không bị sửa. Các khoản đã gạch bởi phiếu này được trả về còn nợ.</Banner>
      </ReasonSheet>}
    </div>
  );
}

function PickPartnerPay({ pt, onClose }: { pt: PT; onClose: () => void }) {
  const [c, setC] = useState<{ id: number; name: string } | null>(null);
  if (!c) return (
    <Sheet open onClose={onClose} title={pt === "customer" ? "Thu tiền: chọn khách" : "Trả tiền: chọn nhà cung cấp"}>
      {pt === "customer" ? <CustomerSelect value={null} onChange={setC} /> : <SupplierSelect value={null} onChange={setC} />}
    </Sheet>
  );
  return <PaymentSheet partnerType={pt} partnerId={c.id} partnerName={c.name} direction={pt === "customer" ? "in" : "out"} onClose={onClose} onDone={onClose} />;
}

function BucketBar({ b, total }: { b: Record<string, number>; total: number }) {
  return (
    <div>
      <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "var(--surface-2)" }} role="img" aria-label="Cơ cấu tuổi nợ">
        {BK.map((x) => (b[x.k] > 0 && total > 0 ? <div key={x.k} title={`${x.label}: ${money(b[x.k])}`} style={{ width: `${(b[x.k] / total) * 100}%`, background: x.color }} /> : null))}
      </div>
      <div className="row wrap small" style={{ marginTop: 6, gap: 12 }}>{BK.map((x) => <span key={x.k} className="row" style={{ gap: 4 }}><i style={{ width: 10, height: 10, borderRadius: 3, background: x.color, display: "inline-block" }} />{x.label}: <b className="money">{money(b[x.k] ?? 0)}</b></span>)}</div>
    </div>
  );
}

function Aging({ side, onOpen, selected }: { side: "receivable" | "payable"; onOpen: (r: any) => void; selected?: number | null }) {
  const [q, setQ] = useState(""), [od, setOd] = useState(false);
  const r = useAsync(() => getRaw(side === "receivable" ? "/debts/receivables" : "/debts/payables", { q, overdueOnly: od ? 1 : undefined }), [side, q, od]);
  const rows: any[] = r.data?.items ?? [];
  const t = r.data?.totals ?? { outstanding: 0, unapplied: 0, balance: 0, overdueAmount: 0 };
  const sum: Record<string, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };
  for (const x of rows) for (const k of Object.keys(sum)) sum[k] += x.buckets?.[k] ?? 0;
  const nameOf = (x: any) => x.customerName ?? x.supplierName;
  const dirty = !!(q || od);
  const reset = () => { setQ(""); setOd(false); };
  return (
    <div className="stack">
      <KpiRow cols={5} items={[
        { label: side === "receivable" ? "Còn phải thu" : "Còn phải trả", value: money(t.outstanding) },
        { label: "Đã trả trước chưa gạch", value: money(t.unapplied), tone: t.unapplied ? "ok" : undefined },
        { label: "Số dư ròng", value: money(t.balance) },
        { label: side === "receivable" ? "Khách dư có" : "NCC dư có", value: money(t.credit ?? 0), tone: t.credit ? "ok" : undefined },
        { label: "Quá hạn", value: money(t.overdueAmount), tone: t.overdueAmount ? "warn" : undefined, onClick: () => setOd(!od) },
      ]} />
      <Card title="Tuổi nợ"><BucketBar b={sum} total={BK.reduce((s, x) => s + sum[x.k], 0)} /></Card>
      <FilterBar dirty={dirty} onReset={reset}>
        <SearchInput value={q} onSearch={setQ} placeholder={side === "receivable" ? "Tên hoặc mã khách…" : "Tên hoặc mã nhà cung cấp…"} label={side === "receivable" ? "Tìm khách" : "Tìm nhà cung cấp"} />
        <label className="row" style={{ minHeight: 40 }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={od} onChange={(e) => setOd(e.target.checked)} /> Chỉ quá hạn</label>
        <span style={{ marginLeft: "auto" }} className="row"><a className="btn ghost sm" href={downloadHref(`/debts/aging.pdf?side=${side}`)} download data-testid="aging-pdf">Tải PDF tuổi nợ</a><ExportButton filename={side === "receivable" ? "cong-no-phai-thu" : "cong-no-phai-tra"} rows={rows} columns={[{ label: side === "receivable" ? "Khách hàng" : "Nhà cung cấp", value: nameOf }, ...BK.map((b) => ({ label: b.label, value: (x: any) => x.buckets?.[b.k] ?? 0 })), { label: "Quá hạn", value: (x: any) => x.overdueAmount }, { label: "Trả trước", value: (x: any) => x.unapplied }, { label: "Số dư", value: (x: any) => x.balance }]} /></span>
      </FilterBar>
      {r.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(x) => x.customerId ?? x.supplierId} onRowClick={onOpen} selectedKey={selected} defaultSort={{ key: "b", dir: "desc" }} pageSize={50}
          emptyState={<EmptyState title={dirty ? "Không có công nợ nào khớp bộ lọc" : "Không có công nợ"} hint={dirty ? undefined : side === "receivable" ? "Khách chưa nợ khoản nào." : "Chưa nợ nhà cung cấp nào."} action={dirty ? <Button variant="soft" onClick={reset}>Xoá lọc</Button> : undefined} />}
          cols={[
            { key: "n", label: side === "receivable" ? "Khách hàng" : "Nhà cung cấp", title: true, sort: (x) => nameOf(x), render: (x) => <b>{nameOf(x)}</b> },
            ...BK.map((b) => ({ key: b.k, label: b.label, num: true, hideMobile: true, hideBelow: (b.k === "d31_60" ? 1280 : 1440) as any, sort: (x: any) => x.buckets?.[b.k] ?? 0, render: (x: any) => (x.buckets?.[b.k] ? <span className="money" style={{ color: b.k === "current" ? undefined : b.color }}>{num(x.buckets[b.k])}</span> : <span className="muted">—</span>) })),
            { key: "age", label: "Tuổi nợ", hideDesktop: true, render: (x: any) => <span className="small">{BK.filter((b) => x.buckets?.[b.k] > 0).map((b) => `${b.label}: ${num(x.buckets[b.k])}`).join(" · ") || "—"}</span> },
            { key: "o", label: "Quá hạn", num: true, sort: (x) => x.overdueAmount, render: (x) => (x.overdueAmount ? <Badge tone="warn">{money(x.overdueAmount)}{x.oldestOverdueDays ? ` · ${x.oldestOverdueDays}n` : ""}</Badge> : <span className="muted">—</span>) },
            { key: "u", label: "Trả trước", num: true, hideMobile: true, hideBelow: 1280, sort: (x) => x.unapplied, render: (x) => (x.unapplied ? <span className="money" style={{ color: "var(--accent)" }}>{money(x.unapplied)}</span> : "—") },
            { key: "b", label: "Số dư", num: true, sort: (x) => x.balance, render: (x) => (x.balance < 0 ? <b className="money" style={{ color: "var(--accent)" }}>{side === "receivable" ? "Khách" : "NCC"} dư có {money(-x.balance)}</b> : <b className="money">{money(x.balance)}</b>) },
          ]} />
      )}
    </div>
  );
}

const DOC_LABEL: Record<string, string> = { invoice: "Hoá đơn", invoice_adjustment: "HĐ điều chỉnh", bill: "Hoá đơn mua", payment: "Thu/chi tiền", discount: "Chiết khấu", write_off: "Xoá nợ", offset: "Cấn trừ" };

function PartnerSheet({ pt, id, name, onClose }: { pt: PT; id: number; name?: string; onClose: () => void }) {
  const can = useCan();
  const [tab, setTab] = useState<"stmt" | "pays">("stmt");
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const s = useAsync(() => get(`/debts/statements/${pt}/${id}`, { from, to }), [pt, id, from, to]);
  const pays = useAsync(() => get("/debts/payments", { partnerType: pt, partnerId: id, limit: 50 }).then((r) => items<any>(r)), [pt, id]);
  const [pay, setPay] = useState(false), [adj, setAdj] = useState(false), [rev, setRev] = useState<any>(null);
  const d = s.data;
  const csv = downloadHref(`/debts/statements/${pt}/${id}?format=csv${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`);
  const reloadAll = () => { s.reload(); pays.reload(); };
  return (
    <DetailPanel onClose={onClose} title={`Sao kê ${d?.partnerName ?? name ?? ""}`}>
      <div className="stack">
        <Segmented value={tab} onChange={setTab} options={[{ v: "stmt", label: "Sao kê" }, { v: "pays", label: "Phiếu thu/chi" }]} />
        <div className="row wrap">
          {can("debt.write") && <Button size="sm" onClick={() => setPay(true)}>{pt === "customer" ? "Thu tiền" : "Trả tiền"}</Button>}
          {can("debt.write") && <Button size="sm" variant="soft" onClick={() => setAdj(true)}>Chiết khấu / xoá nợ / cấn trừ</Button>}
          {pt === "customer" && <Lnk to={`/customers/${id}`} className="btn ghost sm">Hồ sơ khách</Lnk>}
        </div>
        {tab === "stmt" && (
          <>
            <div className="grid2"><Input label="Từ ngày" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="Đến ngày" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            {s.loading ? <Spinner /> : d && (
              <>
                <div className="kpis">
                  <div className="kpi"><div className="l">Số dư đầu kỳ</div><div className="v">{money(d.opening)}</div></div>
                  <div className="kpi"><div className="l">Số dư cuối kỳ</div><div className="v" style={{ color: d.closing < 0 ? "var(--accent)" : undefined }} data-testid="closing">{money(d.closing)}</div></div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="stmt" data-testid="statement">
                    <thead><tr><th>Ngày</th><th>Chứng từ</th><th className="right">Phát sinh</th><th className="right">Số dư</th></tr></thead>
                    <tbody>
                      <tr className="open"><td colSpan={3}>Số dư đầu kỳ</td><td className="right num">{num(d.opening)}</td></tr>
                      {d.lines.map((l: any, i: number) => (
                        <tr key={i}><td className="nw">{ymd(l.date).slice(0, 6) + ymd(l.date).slice(8)}</td><td className="code"><div className="nw">{l.docCode}</div><div className="muted small">{DOC_LABEL[l.docType] ?? l.docType}</div></td>
                          <td className="right num" style={{ color: l.credit ? "var(--accent)" : undefined }}>{l.debit ? "+" + num(l.debit) : "−" + num(l.credit)}</td><td className="right num"><b>{num(l.balance)}</b></td></tr>
                      ))}
                      <tr className="open"><td colSpan={3}>Số dư cuối kỳ</td><td className="right num"><b>{num(d.closing)}</b></td></tr>
                    </tbody>
                  </table>
                  {!d.lines.length && <div className="hint" style={{ padding: 8 }}>Không có phát sinh trong kỳ.</div>}
                </div>
                <div className="hint">Đơn vị: ₫. “+” = hoá đơn phát sinh làm tăng nợ; “−” = thu/chi, chiết khấu, xoá nợ, cấn trừ, hoá đơn điều chỉnh giảm.</div>
                <div><a className="btn soft" href={csv} download>Tải CSV sao kê</a></div>
              </>
            )}
          </>
        )}
        {tab === "pays" && (pays.loading ? <Spinner /> : (
          <DataTable rows={pays.data ?? []} rowKey={(p) => p.id} empty="Chưa có phiếu thu/chi" cols={[
            { key: "c", label: "Mã", title: true, render: (p) => <b>{p.code}</b> },
            { key: "d", label: "Ngày", render: (p) => fmtDateTime(p.paidAt) },
            { key: "m", label: "Hình thức", render: (p) => METHODS[p.method] ?? p.method },
            { key: "s", label: "Trạng thái", render: (p) => (p.status === "posted" ? <Badge tone="ok">Đã ghi</Badge> : <Badge tone="danger">Đã đảo</Badge>) },
            { key: "a", label: "Số tiền", right: true, render: (p) => <span className="money">{money(p.amount)}</span> },
            { key: "r", label: "", render: (p) => (can("debt.write") && p.status === "posted" ? <Button size="sm" variant="ghost" onClick={() => setRev(p)}>Đảo phiếu</Button> : null) },
          ]} />
        ))}
      </div>
      {pay && <PaymentSheet partnerType={pt} partnerId={id} partnerName={d?.partnerName ?? name ?? ""} direction={pt === "customer" ? "in" : "out"} onClose={() => setPay(false)} onDone={() => { setPay(false); reloadAll(); }} />}
      {adj && <AdjustSheet partnerType={pt} partnerId={id} partnerName={d?.partnerName ?? name ?? ""} onClose={() => setAdj(false)} onDone={() => { setAdj(false); reloadAll(); }} />}
      {rev && <ReasonSheet title={`Đảo phiếu ${rev.code}`} confirm={`Đảo phiếu ${money(rev.amount)}`} danger onClose={() => setRev(null)} onSubmit={async (reason) => { await post(`/debts/payments/${rev.id}/reverse`, { reason }); toast("Đã đảo phiếu — tạo phiếu đảo ở kỳ hiện tại", "ok"); setRev(null); reloadAll(); }}>
        <Banner>Phiếu cũ không bị sửa. Các khoản đã gạch bởi phiếu này được trả về còn nợ.</Banner>
      </ReasonSheet>}
    </DetailPanel>
  );
}

/** Hoá đơn / công nợ còn mở của một đối tác */
function useOpenDocs(pt: PT, id: number) {
  return useAsync(async (): Promise<any[]> => {
    if (pt === "customer") return items<any>(await get("/invoices", { customerId: id, status: "open", limit: 200 })).map((x) => ({ key: `inv:${x.id}`, invoiceId: x.id, code: x.code, dueDate: x.dueDate, outstanding: x.outstanding, overdueDays: x.overdueDays }));
    return items<any>(await get(`/suppliers/${id}/bills`, { limit: 200 })).filter((x) => x.outstanding > 0 && x.status === "open").map((x) => ({ key: `bill:${x.id}`, billId: x.id, code: x.code, dueDate: x.dueDate, outstanding: x.outstanding, overdueDays: 0 }));
  }, [pt, id]);
}

export function PaymentSheet({ partnerType, partnerId, partnerName, direction, onClose, onDone, presetAmount }: { partnerType: PT; partnerId: number; partnerName: string; direction: "in" | "out"; onClose: () => void; onDone: (r?: any) => void; presetAmount?: number }) {
  const funds = useAsync(() => get("/funds", undefined, { silent: true }).then((r) => items<any>(r).filter((f) => f.active && ["cash", "bank"].includes(f.type))), []);
  const docs = useOpenDocs(partnerType, partnerId);
  const [fundId, setFundId] = useState(""), [amount, setAmount] = useState(presetAmount ?? 0), [method, setMethod] = useState("cash"), [ref, setRef] = useState(""), [note, setNote] = useState("");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const fid = fundId || String((funds.data ?? []).find((f: any) => (method === "transfer" ? f.type === "bank" : f.type === "cash"))?.id ?? funds.data?.[0]?.id ?? "");
  const allocSum = Object.values(alloc).reduce((s, v) => s + v, 0);
  const manual = mode === "manual";
  const totalOut = (docs.data ?? []).reduce((s: number, d: any) => s + d.outstanding, 0);
  const leftover = manual ? amount - allocSum : Math.max(0, amount - totalOut);
  const bad = manual && (allocSum > amount || (docs.data ?? []).some((d: any) => (alloc[d.key] ?? 0) > d.outstanding));
  const submit = async () => {
    setBusy(true);
    try {
      const allocations = manual ? (docs.data ?? []).filter((d: any) => alloc[d.key] > 0).map((d: any) => ({ ...(d.invoiceId ? { invoiceId: d.invoiceId } : { billId: d.billId }), amount: alloc[d.key] })) : undefined;
      const r = await post("/debts/payments", { direction, partnerType, partnerId, fundId: Number(fid), amount, method, ref: ref || undefined, note: note || undefined, ...(allocations?.length ? { allocations } : {}) });
      setRes(r); toast(direction === "in" ? "Đã ghi phiếu thu" : "Đã ghi phiếu chi", "ok");
    } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet open wide onClose={() => (res ? onDone(res) : onClose())} title={`${direction === "in" ? "Thu tiền" : "Trả tiền"} — ${partnerName}`} footer={!res ? <Button block size="lg" loading={busy} disabled={amount <= 0 || !fid || bad} onClick={submit}>{direction === "in" ? "Ghi phiếu thu" : "Ghi phiếu chi"} {amount > 0 ? money(amount) : ""}</Button> : <Button block onClick={() => onDone(res)}>Xong</Button>}>
      {res ? (
        <div className="stack" data-testid="payment-result">
          <Banner tone="info">Đã ghi phiếu <b>{res.payment.code}</b> số tiền {money(res.payment.amount)}.</Banner>
          <DataTable rows={res.allocations} rowKey={(a: any) => a.id} empty="Không gạch vào hoá đơn nào" cols={[
            { key: "d", label: "Đã gạch vào", title: true, render: (a: any) => (a.invoiceId ? `Hoá đơn #${a.invoiceId}` : `Hoá đơn mua #${a.billId}`) },
            { key: "a", label: "Số tiền", right: true, render: (a: any) => <span className="money">{money(a.amount)}</span> },
          ]} />
          <div className="kpi"><div className="l">Phần dư giữ làm số dư có</div><div className="v" style={{ color: res.unapplied ? "var(--accent)" : undefined }} data-testid="unapplied">{money(res.unapplied)}</div></div>
        </div>
      ) : (
        <div className="stack">
          <MoneyInput label="Số tiền (₫)" value={amount} onChange={setAmount} />
          <div className="grid2">
            <Select label="Hình thức" value={method} onChange={(e) => { setMethod(e.target.value); setFundId(""); }}><option value="cash">Tiền mặt</option><option value="transfer">Chuyển khoản</option></Select>
            <div style={{ gridColumn: "1 / -1", minWidth: 0 }}><Select label="Quỹ" value={fid} onChange={(e) => setFundId(e.target.value)}>{(funds.data ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select></div>
          </div>
          <Input label="Mã tham chiếu / số giao dịch (tuỳ chọn)" value={ref} onChange={(e) => setRef(e.target.value)} />
          <Segmented value={mode} onChange={(m) => { setMode(m); setAlloc({}); }} options={[{ v: "auto", label: "Tự gạch (cũ nhất trước)" }, { v: "manual", label: "Chọn hoá đơn" }]} />
          {docs.loading ? <Spinner /> : manual ? (
            <div className="stack" data-testid="manual-alloc">
              {(docs.data ?? []).map((d: any) => (
                <div key={d.key} className="card flat row between wrap">
                  <div style={{ minWidth: 0 }}><b>{d.code}</b><div className="small muted">Hạn {ymd(d.dueDate)}{d.overdueDays > 0 ? ` · trễ ${d.overdueDays} ngày` : ""} · còn {money(d.outstanding)}</div></div>
                  <div className="row" style={{ gap: 6, width: 190 }}>
                    <div className="grow"><MoneyInput label="Gạch" value={alloc[d.key] ?? 0} onChange={(n) => setAlloc({ ...alloc, [d.key]: n })} /></div>
                    <Button size="sm" variant="ghost" aria-label={`Gạch đủ ${d.code}`} onClick={() => setAlloc({ ...alloc, [d.key]: Math.min(d.outstanding, Math.max(0, amount - (allocSum - (alloc[d.key] ?? 0)))) })}>Đủ</Button>
                  </div>
                </div>
              ))}
              {!(docs.data ?? []).length && <div className="hint">Không có hoá đơn còn nợ.</div>}
              {bad && <div className="err">Số gạch vượt số tiền thu hoặc vượt số còn nợ của hoá đơn.</div>}
            </div>
          ) : (
            <div className="hint">Còn nợ {money(totalOut)} ({(docs.data ?? []).length} chứng từ). Hệ thống gạch từ hoá đơn quá hạn / cũ nhất.</div>
          )}
          <div className="card flat"><div className="row between"><span>{manual ? "Đã gạch" : "Dự kiến gạch"}</span><b className="money">{money(manual ? allocSum : Math.min(amount, totalOut))}</b></div>
            <div className="row between"><span>Phần dư (số dư có)</span><b className="money" style={{ color: leftover > 0 ? "var(--accent)" : undefined }} data-testid="leftover">{money(Math.max(0, leftover))}</b></div></div>
          <Input label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
    </Sheet>
  );
}

function AdjustSheet({ partnerType, partnerId, partnerName, onClose, onDone }: { partnerType: PT; partnerId: number; partnerName: string; onClose: () => void; onDone: () => void }) {
  const docs = useOpenDocs(partnerType, partnerId);
  const [type, setType] = useState("discount"), [amount, setAmount] = useState(0), [doc, setDoc] = useState(""), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [res, setRes] = useState<any>(null);
  const d = (docs.data ?? []).find((x: any) => x.key === doc);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post("/debts/adjustments", { type, partnerType, partnerId, amount, reason: reason.trim(), ...(d && type !== "offset" ? (d.invoiceId ? { invoiceId: d.invoiceId } : { billId: d.billId }) : {}) });
      setRes(r);
    } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={() => (res ? onDone() : onClose())} title={`Điều chỉnh công nợ — ${partnerName}`} footer={!res ? <Button block loading={busy} disabled={amount <= 0 || reason.trim().length < 3} onClick={submit}>Lập điều chỉnh</Button> : <Button block onClick={onDone}>Xong</Button>}>
      {res ? (
        res.status === "pending_approval"
          ? <Banner>Điều chỉnh vượt ngưỡng nên <b>chờ chủ duyệt</b> (yêu cầu #{res.approvalId}). Công nợ chưa thay đổi cho tới khi được duyệt.</Banner>
          : <Banner tone="info">Đã ghi điều chỉnh {ADJ_TYPE[type]} {money(amount)} — công nợ đã được gạch.</Banner>
      ) : (
        <div className="stack">
          <Select label="Loại" value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(ADJ_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          {type === "offset" && <Banner tone="info">Cấn trừ công nợ phải thu ↔ phải trả khi khách cũng là nhà cung cấp (đã liên kết). Cần liên kết trước.</Banner>}
          <MoneyInput label="Số tiền (₫)" value={amount} onChange={setAmount} />
          {type !== "offset" && <Select label="Áp vào" value={doc} onChange={(e) => setDoc(e.target.value)}><option value="">Tất cả (cũ nhất trước)</option>{(docs.data ?? []).map((x: any) => <option key={x.key} value={x.key}>{x.code} — còn {money(x.outstanding)}</option>)}</Select>}
          <TextArea label="Lý do" value={reason} onChange={(e) => setReason(e.target.value)} />
          {type !== "offset" && <div className="hint">Xoá nợ / chiết khấu trên ngưỡng duyệt sẽ chuyển chủ cửa hàng duyệt.</div>}
        </div>
      )}
    </Sheet>
  );
}

function Adjustments() {
  const [status, setStatus] = useState(""), [q, setQ] = useState("");
  const a = useAsync(() => get("/debts/adjustments", { status }).then((r) => items<any>(r)), [status]);
  const ST: Record<string, string> = { posted: "Đã ghi", pending_approval: "Chờ duyệt", rejected: "Bị từ chối" };
  const term = q.trim().toLowerCase();
  const all = a.data ?? [];
  const rows = all.filter((x) => !term || `${x.code} ${x.reason ?? ""}`.toLowerCase().includes(term));
  return (
    <div className="stack">
      <FilterBar dirty={!!(status || q)} onReset={() => { setStatus(""); setQ(""); }}>
        <SearchInput value={q} onSearch={setQ} placeholder="Mã phiếu, lý do…" label="Tìm điều chỉnh" />
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={Object.entries(ST).map(([v, label]) => ({ v, label }))} />
        <span style={{ marginLeft: "auto" }}><ExportButton filename="dieu-chinh-cong-no" rows={rows} columns={[{ label: "Mã", value: (x) => x.code }, { label: "Loại", value: (x) => ADJ_TYPE[x.type] ?? x.type }, { label: "Đối tác", value: (x) => `${x.partnerType} #${x.partnerId}` }, { label: "Trạng thái", value: (x) => ST[x.status] ?? x.status }, { label: "Lý do", value: (x) => x.reason }, { label: "Số tiền", value: (x) => x.amount }]} /></span>
      </FilterBar>
      <KpiRow items={[{ label: "Số điều chỉnh", value: rows.length }, { label: "Chờ duyệt", value: rows.filter((x) => x.status === "pending_approval").length, tone: rows.some((x) => x.status === "pending_approval") ? "warn" : undefined }, { label: "Tổng đã ghi", value: money(rows.filter((x) => x.status === "posted").reduce((s2, x) => s2 + x.amount, 0)) }]} />
      <div className="hint">Lập điều chỉnh từ màn sao kê của từng khách / nhà cung cấp (Phải thu → chọn đối tác).</div>
      {a.loading ? <Spinner /> : <DataTable rows={rows} rowKey={(x) => x.id} pageSize={50} emptyState={<EmptyState title="Chưa có điều chỉnh công nợ" hint="Chiết khấu, xoá nợ, cấn trừ lập từ sao kê từng đối tác." />} cols={[
        { key: "c", label: "Mã", title: true, sort: (x) => x.code, render: (x) => <b className="nw">{x.code}</b> },
        { key: "t", label: "Loại", sort: (x) => x.type, render: (x) => ADJ_TYPE[x.type] ?? x.type },
        { key: "p", label: "Đối tác", render: (x) => `${x.partnerType === "customer" ? "Khách" : "NCC"} #${x.partnerId}` },
        { key: "s", label: "Trạng thái", render: (x) => <Badge tone={x.status === "posted" ? "ok" : x.status === "pending_approval" ? "warn" : "danger"}>{ST[x.status] ?? x.status}</Badge> },
        { key: "r", label: "Lý do", hideMobile: true, render: (x) => x.reason },
        { key: "a", label: "Số tiền", num: true, sort: (x) => x.amount, render: (x) => <span className="money">{money(x.amount)}</span> },
      ]} />}
    </div>
  );
}

function Reminders() {
  const can = useCan();
  const [days, setDays] = useState(3);
  const r = useAsync(() => get("/debts/reminders", { days }), [days]);
  const [sel, setSel] = useState<number[]>([]), [busy, setBusy] = useState(false);
  const rows: any[] = r.data?.items ?? [];
  return (
    <div className="stack">
      <FilterBar>
        <div style={{ width: 200 }}><Input label="Sắp đến hạn trong (ngày)" inputMode="numeric" value={String(days)} onChange={(e) => setDays(Math.max(0, Math.min(60, parseInt(e.target.value) || 0)))} /></div>
        {can("debt.write") && <Button disabled={!sel.length} loading={busy} onClick={async () => { setBusy(true); try { const x = await post("/debts/reminders/send", { customerIds: sel }); toast(`Đã xếp lịch nhắc ${x.queued} khách`, "ok"); setSel([]); } catch {} finally { setBusy(false); } }}>Gửi nhắc ({sel.length})</Button>}
      </FilterBar>
      {!r.loading && rows.length > 0 && <KpiRow items={[{ label: "Khách cần nhắc", value: rows.length }, { label: "Tổng cần thu", value: money(rows.reduce((a, x) => a + x.total, 0)) }, { label: "Đã quá hạn", value: money(rows.reduce((a, x) => a + (x.overdueAmount ?? 0), 0)), tone: "warn" }]} />}
      {r.loading ? <Spinner /> : !rows.length ? <EmptyState title="Không có khoản nào sắp đến hạn / quá hạn" /> : (
        <div className="card-grid">
          {rows.map((x) => (
            <div key={x.customerId} className="card flat">
              <div className="row between">
                <label className="row" style={{ minHeight: 44 }}>{can("debt.write") && <input type="checkbox" style={{ width: 22, height: 22 }} checked={sel.includes(x.customerId)} onChange={(e) => setSel(e.target.checked ? [...sel, x.customerId] : sel.filter((i) => i !== x.customerId))} aria-label={`Chọn ${x.customerName}`} />}<b>{x.customerName}</b></label>
                <span className="money">{money(x.total)}</span>
              </div>
              {x.overdueAmount > 0 && <Badge tone="warn">Quá hạn {money(x.overdueAmount)}</Badge>}
              <div className="small muted" style={{ marginTop: 4 }}>{x.invoices.map((i: any) => `${i.code} (${i.overdueDays > 0 ? `trễ ${i.overdueDays} ngày` : `hạn ${ymd(i.dueDate)}`})`).join(" · ")}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** CSV dán vào → mảng JSON (partnerType, partnerCode, amount, dueDate) */
function parseOpening(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const split = (l: string) => l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, ""));
  const head = split(lines[0] ?? "").map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const hasHead = head.includes("partnertype") || head.includes("amount");
  const cols = hasHead ? head : ["partnertype", "partnercode", "amount", "duedate"];
  const idx = (n: string) => cols.indexOf(n);
  return (hasHead ? lines.slice(1) : lines).map((l) => { const c = split(l); return { partnerType: c[idx("partnertype")], partnerCode: c[idx("partnercode")], amount: parseInt((c[idx("amount")] ?? "").replace(/[^\d]/g, ""), 10) || 0, dueDate: c[idx("duedate")] }; });
}
function Opening() {
  const can = useCan();
  const st = useAsync(() => get("/debts/opening-balances/status"), []);
  const [csv, setCsv] = useState("partnerType,partnerCode,amount,dueDate\ncustomer,KH-0001,1500000," + todayVN(30));
  const [busy, setBusy] = useState(false), [errs, setErrs] = useState<{ row: number; message: string }[]>([]), [lock, setLock] = useState(false);
  const locked = st.data?.locked;
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      {locked ? <Banner tone="info">Số dư đầu kỳ đã khoá vĩnh viễn ({fmtDateTime(st.data.lockedAt)}). Không nhập thêm được.</Banner> : <Banner>Nhập số dư công nợ đầu kỳ một lần khi bắt đầu dùng hệ thống. Sau khi chủ khoá, không thể nhập thêm.</Banner>}
      {!locked && can("debt.write") && (
        <>
          <TextArea label="Dán CSV: partnerType (customer|supplier), partnerCode, amount, dueDate (YYYY-MM-DD)" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} style={{ minHeight: 140, fontFamily: "ui-monospace, monospace" } as any} />
          {errs.length > 0 && <Banner tone="danger"><b>Chưa ghi dòng nào:</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{errs.map((e) => <li key={e.row}>Dòng {e.row}: {e.message}</li>)}</ul></Banner>}
          <div className="row wrap">
            <Button loading={busy} onClick={async () => {
              setBusy(true); setErrs([]);
              try { const r = await post("/debts/opening-balances", parseOpening(csv), { silent: true }); toast(`Đã nhập ${r.created} dòng, tổng ${money(r.total)}`, "ok"); }
              catch (e) { if (e instanceof ApiError) { if (Array.isArray(e.details)) setErrs(e.details as any); else toast(e.message, "error"); } } finally { setBusy(false); }
            }}>Nhập số dư</Button>
            {can("debt.approve") && <Button variant="danger" onClick={() => setLock(true)}>Khoá số dư đầu kỳ (chủ)</Button>}
          </div>
        </>
      )}
      {lock && <Sheet open onClose={() => setLock(false)} title="Khoá số dư đầu kỳ" footer={<Button block variant="danger" onClick={async () => { try { await post("/debts/opening-balances/lock"); toast("Đã khoá số dư đầu kỳ", "ok"); setLock(false); st.reload(); } catch {} }}>Khoá vĩnh viễn</Button>}><Banner>Thao tác này không hoàn tác được. Hãy chắc chắn đã nhập đủ số dư đầu kỳ.</Banner></Sheet>}
    </div>
  );
}

export { navigate };
