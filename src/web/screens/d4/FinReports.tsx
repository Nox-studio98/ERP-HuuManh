import { useEffect, useState } from "react";
import { ApiError, get, items, put } from "../../api";
import { Badge, Banner, Button, Card, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, useAsync } from "../../components/ui";
import { DateRangeFilter, FilterBar, PageHeader, rangeOf, useWide, type DateRange } from "../../components/list";
import { toast } from "../../components/toast";
import { CHANNELS, money, todayVN } from "../../format";
import { useCan } from "../../store";
import { Tile, bpPct, downloadCsv } from "./shared";

type Tab = "cash" | "pnl" | "vat" | "budget";
const first = () => todayVN().slice(0, 8) + "01";

const TAB_SUB: Record<Tab, string> = { cash: "Tiền vào / ra các quỹ theo nhóm thu chi", pnl: "Doanh thu, giá vốn và chi phí phân bổ theo kênh bán", vat: "Thuế GTGT đầu ra / đầu vào theo tháng", budget: "Chi thực tế so với ngân sách đã đặt" };
export default function FinReports() {
  const [tab, setTab] = useState<Tab>("cash");
  const [range, setRange] = useState<DateRange>(() => rangeOf("month"));
  const { from, to } = range;
  const [period, setPeriod] = useState(todayVN().slice(0, 7));
  const ranged = tab === "cash" || tab === "pnl";
  return (
    <div className="stack d4">
      <PageHeader subtitle={TAB_SUB[tab]} />
      <Segmented fit wrap value={tab} onChange={setTab} options={[{ v: "cash", label: "Dòng tiền" }, { v: "pnl", label: "Lãi lỗ theo kênh" }, { v: "vat", label: "Thuế GTGT" }, { v: "budget", label: "Ngân sách & thực tế" }]} />
      <FilterBar>
        {ranged ? <DateRangeFilter value={range} onChange={setRange} /> : <Input label="Kỳ (tháng)" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />}
      </FilterBar>
      {tab === "cash" && <CashFlow from={from} to={to} />}
      {tab === "pnl" && <Pnl from={from} to={to} />}
      {tab === "vat" && <Vat period={period} />}
      {tab === "budget" && <Budget period={period} />}
    </div>
  );
}

// ---------------------------------------------------------------- biểu đồ
function HBars({ rows, color = "var(--accent)" }: { rows: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div role="list">{rows.map((r) => (
      <div className="barrow" key={r.label} role="listitem">
        <div className="row between"><span>{r.label}</span><b className="num">{money(r.value)}</b></div>
        <div className="bartrack"><i style={{ width: `${(Math.abs(r.value) / max) * 100}%`, background: r.value < 0 ? "var(--danger)" : color }} /></div>
      </div>))}</div>
  );
}
type GSeries = { name: string; color: string; vals: number[] };
function GroupBars({ labels, series, height = 200 }: { labels: string[]; series: GSeries[]; height?: number }) {
  const wide = useWide();
  if (wide) height = 240;
  const W = wide ? 1000 : 560, p = { l: 8, r: 8, t: 14, b: 26 };
  const all = series.flatMap((s) => s.vals);
  const max = Math.max(1, ...all), min = Math.min(0, ...all);
  const Y = (v: number) => p.t + ((max - v) / (max - min)) * (height - p.t - p.b);
  const gw = (W - p.l - p.r) / Math.max(1, labels.length);
  const bw = Math.min(wide ? 44 : 40, (gw * 0.8) / series.length);
  const fmt = (n: number) => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + "tr" : Math.round(n / 1000) + "k");
  return (
    <div className="stack" style={{ gap: 6 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Biểu đồ cột theo ${labels.join(", ")}`}>
        <line className="axis" x1={p.l} x2={W - p.r} y1={Y(0)} y2={Y(0)} />
        {labels.map((l, i) => (
          <g key={l}>
            {series.map((s, k) => {
              const v = s.vals[i] ?? 0, x = p.l + i * gw + (gw - bw * series.length) / 2 + k * bw;
              return <g key={s.name}><rect x={x} y={Math.min(Y(v), Y(0))} width={bw - 3} height={Math.max(1, Math.abs(Y(v) - Y(0)))} rx={3} fill={v < 0 ? "var(--danger)" : s.color}><title>{`${l} · ${s.name}: ${money(v)}`}</title></rect>{labels.length <= 4 && <text x={x + (bw - 3) / 2} y={Math.min(Y(v), Y(0)) - 3} textAnchor="middle">{fmt(v)}</text>}</g>;
            })}
            <text x={p.l + i * gw + gw / 2} y={height - 8} textAnchor="middle">{l}</text>
          </g>))}
      </svg>
      <div className="legend">{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}

// ---------------------------------------------------------------- dòng tiền
function CashFlow({ from, to }: { from: string; to: string }) {
  const r = useAsync(() => get("/reports/cash-flow", { from, to }), [from, to]);
  if (r.loading) return <Spinner />;
  const d = r.data;
  if (!d) return <Banner tone="danger">Không tải được báo cáo dòng tiền.</Banner>;
  const net = d.totalInflow - d.totalOutflow;
  return (
    <div className="stack">
      <div className="tiles"><Tile label="Đầu kỳ" value={money(d.opening)} /><Tile label="Tổng thu" value={money(d.totalInflow)} tone="ok" /><Tile label="Tổng chi" value={money(d.totalOutflow)} tone="danger" /><Tile label="Cuối kỳ" value={money(d.closing)} sub={`Thu − chi: ${net >= 0 ? "+" : ""}${money(net)}`} /></div>
      <div className="two-col">
        <Card title="Thu theo nhóm">{d.inflows.length ? <HBars rows={d.inflows.map((x: any) => ({ label: x.category, value: x.amount }))} /> : <div className="muted">Không có khoản thu trong kỳ.</div>}</Card>
        <Card title="Chi theo nhóm">{d.outflows.length ? <HBars color="var(--warn)" rows={d.outflows.map((x: any) => ({ label: x.category, value: x.amount }))} /> : <div className="muted">Không có khoản chi trong kỳ.</div>}</Card>
      </div>
      <Card title="Theo quỹ">
        <div className="scrollx"><table className="tbl"><thead><tr><th>Quỹ</th><th className="r">Đầu kỳ</th><th className="r">Thu</th><th className="r">Chi</th><th className="r">Cuối kỳ</th></tr></thead>
          <tbody>{d.byFund.map((f: any) => <tr key={f.fundId}><td>{f.name}</td><td className="r">{money(f.opening)}</td><td className="r">{money(f.inflow)}</td><td className="r">{money(f.outflow)}</td><td className="r"><b>{money(f.closing)}</b></td></tr>)}</tbody></table></div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- lãi lỗ theo kênh
function Pnl({ from, to }: { from: string; to: string }) {
  const can = useCan();
  const r = useAsync(() => get("/reports/pnl-by-channel", { from, to }), [from, to]);
  const [rules, setRules] = useState(false);
  if (r.loading) return <Spinner />;
  const d = r.data;
  if (!d) return <Banner tone="danger">Không tải được báo cáo lãi lỗ.</Banner>;
  const t = d.totals;
  const ch: any[] = d.channels;
  return (
    <div className="stack">
      <div className="tiles"><Tile label="Doanh thu" value={money(t.revenue)} /><Tile label="Lãi gộp" value={money(t.grossProfit)} sub={t.revenue ? bpPct(Math.round((t.grossProfit * 10000) / t.revenue)) + " doanh thu" : undefined} /><Tile label="Tổng chi phí" value={money(t.totalExpenses)} tone="warn" /><Tile label="Lãi ròng" value={money(t.netProfit)} tone={t.netProfit < 0 ? "danger" : "ok"} /></div>
      <Card title="Theo kênh bán" actions={<Button size="sm" variant="ghost" onClick={() => downloadCsv(`lai-lo-kenh-${from}-${to}.csv`, [["Kênh", "Doanh thu", "Giá vốn", "Lãi gộp", "CP trực tiếp", "CP phân bổ", "Lãi ròng"], ...ch.map((c) => [CHANNELS[c.channel] ?? c.channel, c.revenue, c.cogs, c.grossProfit, c.directCosts, c.allocatedCosts, c.netProfit])])}>Xuất CSV</Button>}>
        <GroupBars labels={ch.map((c) => CHANNELS[c.channel] ?? c.channel)} series={[{ name: "Doanh thu", color: "var(--accent)", vals: ch.map((c) => c.revenue) }, { name: "Lãi gộp", color: "var(--info)", vals: ch.map((c) => c.grossProfit) }, { name: "Lãi ròng", color: "var(--warn)", vals: ch.map((c) => c.netProfit) }]} />
        <div className="scrollx" style={{ marginTop: 8 }}><table className="tbl"><thead><tr><th>Kênh</th><th className="r">Doanh thu</th><th className="r">Giá vốn</th><th className="r">Lãi gộp</th><th className="r">CP trực tiếp</th><th className="r">CP phân bổ</th><th className="r">Lãi ròng</th></tr></thead>
          <tbody>{ch.map((c) => <tr key={c.channel}><td>{CHANNELS[c.channel] ?? c.channel}</td><td className="r">{money(c.revenue)}</td><td className="r">{money(c.cogs)}</td><td className="r">{money(c.grossProfit)}</td><td className="r">{money(c.directCosts)}</td><td className="r">{money(c.allocatedCosts)}</td><td className="r"><b style={{ color: c.netProfit < 0 ? "var(--danger)" : undefined }}>{money(c.netProfit)}</b></td></tr>)}
            <tr><td><b>Tổng</b></td><td className="r"><b>{money(t.revenue)}</b></td><td className="r"><b>{money(t.cogs)}</b></td><td className="r"><b>{money(t.grossProfit)}</b></td><td className="r"><b>{money(t.directCosts)}</b></td><td className="r"><b>{money(t.allocatedCosts)}</b></td><td className="r"><b>{money(t.netProfit)}</b></td></tr></tbody></table></div>
      </Card>
      <Card title="Chi phí chung đã phân bổ" actions={can("finance.write") ? <Button size="sm" variant="soft" onClick={() => setRules(true)}>Quy tắc phân bổ</Button> : undefined}>
        {d.allocations.length === 0 ? <div className="muted">Chưa có chi phí chung được phân bổ.</div> : d.allocations.map((a: any) => (
          <div className="li" key={a.categoryId}><div className="t"><b>{a.category}</b><span className="small muted">{a.method === "revenue_share" ? "Theo tỉ trọng doanh thu" : "Tỉ lệ cố định"} · {Object.entries(a.byChannel).map(([k, v]) => `${CHANNELS[k] ?? k} ${money(v as number)}`).join(" · ")}</span></div><b className="num">{money(a.amount)}</b></div>))}
        {d.unallocated.length > 0 && <div style={{ marginTop: 8 }}><Banner>Chưa phân bổ vào kênh: {d.unallocated.map((u: any) => `${u.category} ${money(u.amount)}${u.reason === "no_rule" ? " (chưa có quy tắc)" : ""}`).join("; ")}. Các khoản này vẫn được trừ vào lãi ròng tổng.</Banner></div>}
        {d.otherIncome?.total > 0 && <div className="small muted" style={{ marginTop: 6 }}>Thu khác: {money(d.otherIncome.total)} (cọc không hoàn {money(d.otherIncome.forfeitedDeposits)}, chiết khấu/xoá nợ NCC {money(d.otherIncome.payableDiscounts)}, chênh lệch đối soát thừa {money(d.otherIncome.settlementSurplus)}, phiếu thu khác {money(d.otherIncome.otherReceipts ?? 0)}) — đã cộng vào lãi ròng, chưa tính vào doanh thu kênh.</div>}
        {d.revenueDeductions?.paymentDiscount > 0 && <div className="small muted" style={{ marginTop: 6 }}>Chiết khấu thanh toán: {money(d.revenueDeductions.paymentDiscount)} — đã trừ vào lãi ròng.</div>}
      </Card>
      {rules && <RulesEditor onClose={() => setRules(false)} onSaved={() => { setRules(false); r.reload(); }} />}
    </div>
  );
}

type Rule = { categoryId: number; method: "revenue_share" | "fixed_bp"; weights: Record<string, number>; active: boolean };
const CH_KEYS = ["pos", "online", "b2b"];
function RulesEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const cats = useAsync(() => get("/cash-categories").then((r) => items<any>(r).filter((c) => c.direction === "out")), []);
  const [rules, setRules] = useState<Rule[] | null>(null);
  useAsync(async () => { const r = await get("/cost-allocation-rules"); setRules(items<any>(r).map((x) => ({ categoryId: x.categoryId, method: x.method, weights: x.weights ?? {}, active: x.active }))); return 1; }, []);
  const [err, setErr] = useState("");
  const set = (cid: number, patch: Partial<Rule> | null) => setRules((rs) => {
    const rest = rs!.filter((r) => r.categoryId !== cid);
    if (!patch) return rest;
    const cur = rs!.find((r) => r.categoryId === cid) ?? { categoryId: cid, method: "revenue_share" as const, weights: {}, active: true };
    return [...rest, { ...cur, ...patch }];
  });
  const save = async () => {
    setErr("");
    try { await put("/cost-allocation-rules", { rules: rules!.map((r) => ({ categoryId: r.categoryId, method: r.method, active: r.active, ...(r.method === "fixed_bp" ? { weights: Object.fromEntries(Object.entries(r.weights).filter(([, v]) => v > 0)) } : {}) })) }, { silent: true }); toast("Đã lưu quy tắc phân bổ", "ok"); onSaved(); }
    catch (e) { if (e instanceof ApiError) setErr(e.code === "weights_not_100" ? "Tổng tỉ lệ các kênh phải bằng 100%." : e.message); }
  };
  return (
    <Sheet open onClose={onClose} title="Quy tắc phân bổ chi phí chung" footer={<div className="stack" style={{ width: "100%" }}>{err && <div className="err" role="alert">{err}</div>}<Button block disabled={!rules} onClick={save}>Lưu quy tắc</Button></div>}>
      {!rules || cats.loading ? <Spinner /> : (
        <div className="stack">
          <div className="hint">Chi phí không gắn kênh sẽ được chia vào các kênh theo quy tắc. Không có quy tắc = không phân bổ (chỉ trừ ở lãi ròng tổng).</div>
          {(cats.data ?? []).map((c) => {
            const r = rules.find((x) => x.categoryId === c.id);
            const sum = r ? Object.values(r.weights).reduce((s, x) => s + x, 0) : 0;
            return (
              <Card key={c.id}>
                <div className="stack">
                  <Select label={c.name} value={r ? r.method : ""} onChange={(e) => set(c.id, e.target.value ? { method: e.target.value as Rule["method"] } : null)}><option value="">Không phân bổ</option><option value="revenue_share">Theo tỉ trọng doanh thu</option><option value="fixed_bp">Tỉ lệ cố định</option></Select>
                  {r?.method === "fixed_bp" && (
                    <div className="stack" style={{ gap: 6 }}>
                      <div className="grid3">{CH_KEYS.map((k) => <Input key={k} label={`${CHANNELS[k]} (%)`} type="number" min={0} max={100} value={(r.weights[k] ?? 0) / 100} onChange={(e) => set(c.id, { weights: { ...r.weights, [k]: Math.round(Number(e.target.value) * 100) } })} />)}</div>
                      <div className="small" style={{ color: sum === 10000 ? "var(--accent)" : "var(--danger)" }}>Tổng: {sum / 100}% {sum === 10000 ? "✓" : "(phải bằng 100%)"}</div>
                    </div>)}
                </div>
              </Card>);
          })}
        </div>)}
    </Sheet>
  );
}

// ---------------------------------------------------------------- GTGT
function Vat({ period }: { period: string }) {
  const r = useAsync(() => get("/reports/vat", { period }), [period]);
  if (r.loading) return <Spinner />;
  const d = r.data;
  if (!d) return <Banner tone="danger">Không tải được báo cáo thuế.</Banner>;
  return (
    <div className="stack">
      <div className="tiles"><Tile label="Thuế đầu ra" value={money(d.output.vat)} sub={`${d.output.count} hoá đơn bán`} /><Tile label="Thuế đầu vào" value={money(d.input.vat)} sub={`${d.input.count} hoá đơn mua`} /><Tile label={d.payable >= 0 ? "Tạm tính phải nộp" : "Được khấu trừ"} value={money(Math.abs(d.payable))} tone={d.payable >= 0 ? "warn" : "ok"} /><Tile label="Doanh thu chịu thuế" value={money(d.output.base)} /></div>
      <Card title="Đầu ra theo thuế suất">
        {d.output.byRate.length === 0 ? <div className="muted">Không có hoá đơn bán trong kỳ.</div> : <div className="scrollx"><table className="tbl"><thead><tr><th>Thuế suất</th><th className="r">Số HĐ</th><th className="r">Doanh thu</th><th className="r">Thuế</th></tr></thead>
          <tbody>{d.output.byRate.map((x: any) => <tr key={x.rateBp}><td>{bpPct(x.rateBp)}</td><td className="r">{x.count}</td><td className="r">{money(x.base)}</td><td className="r">{money(x.vat)}</td></tr>)}</tbody></table></div>}
      </Card>
      <Card title="Đầu vào (hoá đơn nhà cung cấp)"><div className="totals"><div><span className="muted">Tổng giá trị</span><span className="money">{money(d.input.total)}</span></div><div><span className="muted">Thuế GTGT đầu vào</span><span className="money">{money(d.input.vat)}</span></div></div></Card>
      <Banner tone="info">{d.notice}</Banner>
    </div>
  );
}

// ---------------------------------------------------------------- ngân sách
const LINES: Record<string, string> = { revenue: "Doanh thu", cogs: "Giá vốn", opex: "Chi phí vận hành", payroll: "Lương", shrinkage: "Hao hụt & chênh lệch kiểm kê", other: "Khác" };
function Budget({ period }: { period: string }) {
  const can = useCan();
  const r = useAsync(() => get("/reports/budget-vs-actual", { period }), [period]);
  const [edit, setEdit] = useState(false);
  if (r.loading) return <Spinner />;
  const rows: any[] = r.data?.items ?? [];
  const totBudget = rows.filter((x) => x.line && x.line !== "revenue").reduce((s, x) => s + x.budget, 0);
  const totAct = rows.filter((x) => x.line && x.line !== "revenue").reduce((s, x) => s + x.actual, 0);
  return (
    <div className="stack">
      <div className="row between wrap"><div className="muted">Ngân sách kỳ {period}</div>{can("finance.write") && <Button size="sm" variant="soft" onClick={() => setEdit(true)}>Sửa ngân sách</Button>}</div>
      {rows.length > 0 && <div className="tiles"><Tile label="Ngân sách chi" value={money(totBudget)} /><Tile label="Thực tế chi" value={money(totAct)} tone={totAct > totBudget ? "danger" : "ok"} /><Tile label="Chênh lệch" value={`${totAct - totBudget > 0 ? "+" : ""}${money(totAct - totBudget)}`} tone={totAct > totBudget ? "danger" : "ok"} /><Tile label="Số dòng" value={rows.length} /></div>}
      {rows.length === 0 ? <EmptyState title="Chưa đặt ngân sách cho kỳ này" hint="Bấm “Sửa ngân sách” để nhập mức dự kiến theo dòng hoặc nhóm chi." /> : (
        <Card title="Thực tế so với ngân sách">
          {rows.map((x) => {
            const isRev = x.line === "revenue";
            const bad = isRev ? x.actual < x.budget : x.actual > x.budget;
            const scale = Math.max(x.budget, x.actual, 1);
            return (
              <div className="barrow" key={x.id}>
                <div className="row between"><b>{x.categoryName ?? LINES[x.line] ?? x.line}</b><span className="small muted">{x.variancePct != null ? `${x.variancePct > 0 ? "+" : ""}${x.variancePct}%` : "—"}</span></div>
                <div className="bartrack" role="img" aria-label={`Thực tế ${money(x.actual)} trên ngân sách ${money(x.budget)}`}><i className={bad ? "over" : ""} style={{ width: `${(x.actual / scale) * 100}%`, background: bad ? undefined : "var(--accent)" }} /><b style={{ left: `calc(${(x.budget / scale) * 100}% - 1px)` }} /></div>
                <div className="row between small"><span className="muted">Thực tế <b style={{ color: "var(--text)" }}>{money(x.actual)}</b></span><span className="muted">Ngân sách <b style={{ color: "var(--text)" }}>{money(x.budget)}</b></span><Badge tone={bad ? "danger" : "ok"}>{isRev ? (bad ? "Chưa đạt" : "Đạt") : bad ? "Vượt" : "Trong mức"}</Badge></div>
              </div>);
          })}
        </Card>
      )}
      {edit && <BudgetEditor period={period} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); r.reload(); }} />}
    </div>
  );
}
type BRow = { key: string; categoryId?: number; line?: string; amount: number };
function BudgetEditor({ period, onClose, onSaved }: { period: string; onClose: () => void; onSaved: () => void }) {
  const cats = useAsync(() => get("/cash-categories").then((r) => items<any>(r)), []);
  const [rows, setRows] = useState<BRow[] | null>(null);
  useAsync(async () => { const r = await get("/budgets", { period }); setRows(items<any>(r).map((x) => ({ key: x.categoryId ? `c${x.categoryId}` : `l${x.line}`, categoryId: x.categoryId ?? undefined, line: x.line ?? undefined, amount: x.amount }))); return 1; }, [period]);
  const [add, setAdd] = useState("");
  useEffect(() => setAdd(""), [rows?.length]);
  const options = [
    ...Object.entries(LINES).map(([k, l]) => ({ key: `l${k}`, label: `${l} (tổng)`, line: k })),
    ...(cats.data ?? []).filter((c) => c.direction === "out").map((c) => ({ key: `c${c.id}`, label: c.name, categoryId: c.id as number })),
  ].filter((o) => !rows?.some((r) => r.key === o.key));
  const save = async () => {
    try { await put("/budgets", { period, items: rows!.filter((r) => r.amount >= 0).map((r) => ({ ...(r.categoryId ? { categoryId: r.categoryId } : { line: r.line }), amount: r.amount })) }); toast("Đã lưu ngân sách", "ok"); onSaved(); } catch {}
  };
  const label = (r: BRow) => (r.line ? `${LINES[r.line]} (tổng)` : cats.data?.find((c) => c.id === r.categoryId)?.name ?? `Nhóm #${r.categoryId}`);
  return (
    <Sheet open onClose={onClose} title={`Ngân sách ${period}`} footer={<Button block disabled={!rows} onClick={save}>Lưu ngân sách</Button>}>
      {!rows ? <Spinner /> : (
        <div className="stack">
          {rows.map((r, i) => (
            <div className="row" key={r.key} style={{ alignItems: "flex-end" }}>
              <div className="grow"><MoneyInput label={label(r)} value={r.amount} onChange={(n) => setRows((x) => x!.map((y, j) => (j === i ? { ...y, amount: n } : y)))} /></div>
              <Button size="sm" variant="ghost" aria-label={`Bỏ ${label(r)}`} onClick={() => setRows((x) => x!.filter((_, j) => j !== i))}>✕</Button>
            </div>))}
          <Select label="Thêm dòng ngân sách" value={add} onChange={(e) => { const o = options.find((x) => x.key === e.target.value); if (o) setRows([...rows, { key: o.key, categoryId: (o as any).categoryId, line: (o as any).line, amount: 0 }]); }}>
            <option value="">Chọn dòng…</option>{options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select>
          <div className="hint">“Tổng” là các dòng gộp: doanh thu, giá vốn, vận hành, lương, hao hụt. Thêm theo nhóm chi (vd. Tiền điện nước) để theo dõi chi tiết.</div>
        </div>)}
    </Sheet>
  );
}
