import { useState } from "react";
import { get, items } from "../api";
import { Badge, Button, Card, DataTable, EmptyState, Segmented, Spinner, useAsync } from "../components/ui";
import { DateRangeFilter, FilterBar, KpiRow, PageHeader, SearchInput, rangeOf, useWide, type DateRange } from "../components/list";
import { ExportButton } from "../components/list";
import { BarChart } from "../components/charts";
import { CHANNELS, downloadHref, money, qtyText, todayVN } from "../format";

export default function Reports() {
  const [tab, setTab] = useState<"pnl" | "inv">("pnl");
  return (
    <div className="stack">
      <Segmented fit value={tab} onChange={setTab} options={[{ v: "pnl", label: "Lãi lỗ" }, { v: "inv", label: "Tồn kho" }]} />
      {tab === "pnl" ? <Pnl /> : <Inv />}
    </div>
  );
}

const EXP_LABEL: Record<string, string> = { opex: "Chi phí vận hành", shrinkage: "Hao hụt / huỷ hàng", other: "Chi phí khác", payroll: "Lương", marketing: "Marketing", badDebt: "Xoá nợ khó đòi", stockCount: "Chênh lệch kiểm kê", purchaseVariance: "Chênh lệch giá mua" };
function Pnl() {
  const [range, setRange] = useState<DateRange>(() => rangeOf("7d")), [by, setBy] = useState("day");
  const { from, to } = range;
  const wide = useWide();
  const r = useAsync(() => get("/reports/pnl", { from, to, groupBy: by }), [from, to, by]);
  // Backend: { revenue, cogs, grossProfit, expenses:{[pnlLine]:vnd}, totalExpenses, netProfit, breakdown:[{key,revenue,cogs,grossProfit}] }
  const d = r.data ?? {};
  const rows: any[] = (d.breakdown ?? []).map((x: any) => ({ label: String(x.key ?? "—"), revenue: x.revenue ?? 0, cogs: x.cogs ?? 0, gross: x.grossProfit ?? (x.revenue ?? 0) - (x.cogs ?? 0) }));
  const rev = d.revenue ?? 0, cogs = d.cogs ?? 0, gross = d.grossProfit ?? 0, exp = d.totalExpenses ?? 0, net = d.netProfit ?? gross - exp;
  const expRows = Object.entries(d.expenses ?? {}).filter(([, v]) => Number(v) !== 0) as [string, number][];
  const lab = (x: string) => (by === "channel" ? CHANNELS[x] ?? x : by === "day" ? x.slice(5) : x);
  const hasData = rows.length > 0 && (rev > 0 || cogs > 0 || exp > 0);
  return (
    <div className="stack">
      <PageHeader subtitle={`${from === to ? from : `${from} → ${to}`} · nhóm theo ${by === "day" ? "ngày" : by === "channel" ? "kênh bán" : "nhóm hàng"}`} actions={<>
        <ExportButton filename={`lai-lo-${from}_${to}`} rows={rows} columns={[{ label: by === "day" ? "Ngày" : by === "channel" ? "Kênh" : "Nhóm", value: (x) => lab(x.label) }, { label: "Doanh thu", value: (x) => x.revenue }, { label: "Giá vốn", value: (x) => x.cogs }, { label: "Lãi gộp", value: (x) => x.gross }]} />
        <a className="btn ghost sm" href={downloadHref(`/reports/export/orders.csv?from=${from}&to=${to}`)} download="orders.csv">Xuất CSV đơn hàng</a>
        <a className="btn ghost sm" href={downloadHref(`/reports/export/pnl.csv?from=${from}&to=${to}&groupBy=${by}`)} download="pnl.csv">Xuất CSV lãi lỗ</a>
        <a className="btn ghost sm" href={downloadHref(`/reports/export/daily.csv?day=${to}`)} download="daily.csv">Xuất CSV theo ngày ({to})</a></>} />
      <FilterBar>
        <DateRangeFilter value={range} onChange={setRange} />
        <Segmented value={by} onChange={setBy} options={[{ v: "day", label: "Theo ngày" }, { v: "channel", label: "Theo kênh" }, { v: "group", label: "Theo nhóm hàng" }]} />
      </FilterBar>
      {r.loading ? <Spinner /> : (
        <>
          <KpiRow items={[
            { label: "Doanh thu", value: money(rev) },
            { label: "Giá vốn", value: money(cogs) },
            { label: "Lãi gộp", value: money(gross), tone: "ok", sub: rev ? `Biên ${Math.round((gross / rev) * 100)}%` : undefined },
            { label: "Lãi sau chi phí", value: money(net), tone: net < 0 ? "danger" : undefined, sub: exp ? `Chi phí ${money(exp)}` : undefined },
          ]} />
          {!hasData ? <Card><EmptyState title="Chưa có số liệu trong khoảng này" hint="Đổi khoảng thời gian để xem lãi lỗ." action={<div className="row wrap" style={{ justifyContent: "center" }}><Button variant="soft" onClick={() => setRange(rangeOf("month"))}>Xem tháng này</Button><Button variant="ghost" onClick={() => setRange(rangeOf("lastMonth"))}>Xem tháng trước</Button></div>} /></Card> : (
            <div className="two-col wide-left">
              <div className="stack">
                <Card title={`Doanh thu theo ${by === "day" ? "ngày" : by === "channel" ? "kênh" : "nhóm hàng"}`}>
                  <BarChart width={wide ? 1000 : 560} height={wide ? 240 : 180} maxBar={wide ? 56 : 44} data={rows.map((x) => ({ label: lab(x.label), value: x.revenue }))} />
                  {rows.length === 1 && <div className="small muted" style={{ textAlign: "center" }}>Chỉ có 1 mốc dữ liệu: {lab(rows[0].label)} — {money(rows[0].revenue)}</div>}
                </Card>
                <DataTable rows={rows} rowKey={(x) => x.label} pageSize={31} cols={[
                  { key: "l", label: by === "day" ? "Ngày" : by === "channel" ? "Kênh" : "Nhóm", title: true, sort: (x) => x.label, render: (x) => <b>{lab(x.label)}</b> },
                  { key: "r", label: "Doanh thu", num: true, sort: (x) => x.revenue, render: (x) => money(x.revenue) },
                  { key: "c", label: "Giá vốn", num: true, sort: (x) => x.cogs, render: (x) => money(x.cogs) },
                  { key: "g", label: "Lãi gộp", num: true, sort: (x) => x.gross, render: (x) => money(x.gross) },
                  { key: "m", label: "Biên", num: true, sort: (x) => (x.revenue ? x.gross / x.revenue : -1), render: (x) => (x.revenue ? <Badge tone={x.gross / x.revenue < 0.1 ? "warn" : "ok"}>{Math.round((x.gross / x.revenue) * 100)}%</Badge> : "—") },
                ]} />
              </div>
              <div className="stack">
                {(d.revenueDeductions?.paymentDiscount > 0 || d.otherIncome?.total > 0) && (
                  <Card title="Giảm trừ doanh thu và thu khác"><DataTable rows={[
                    ["Chiết khấu thanh toán (giảm trừ doanh thu)", -(d.revenueDeductions?.paymentDiscount ?? 0)],
                    ["Cọc không hoàn", d.otherIncome?.forfeitedDeposits ?? 0],
                    ["Chiết khấu / xoá nợ nhà cung cấp", d.otherIncome?.payableDiscounts ?? 0],
                    ["Chênh lệch đối soát thừa", d.otherIncome?.settlementSurplus ?? 0],
                    ["Thu khác (phiếu thu)", d.otherIncome?.otherReceipts ?? 0],
                  ].filter((x) => Number(x[1]) !== 0) as [string, number][]} rowKey={(x) => x[0]} cols={[{ key: "k", label: "Khoản", title: true, render: (x) => x[0] }, { key: "v", label: "Số tiền", num: true, render: (x) => money(x[1]) }]} /></Card>
                )}
                {expRows.length > 0 ? <Card title="Chi phí"><DataTable rows={expRows} rowKey={(x) => x[0]} cols={[{ key: "k", label: "Khoản", title: true, render: (x) => EXP_LABEL[x[0]] ?? x[0] }, { key: "v", label: "Số tiền", num: true, sort: (x) => x[1], render: (x) => money(x[1]) }]} footer={`Tổng chi phí ${money(exp)}`} /></Card> : <Card title="Chi phí"><div className="muted">Chưa ghi nhận chi phí trong kỳ.</div></Card>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Inv() {
  const [asOf, setAsOf] = useState(todayVN()), [q, setQ] = useState("");
  const r = useAsync(() => get("/reports/inventory", { asOf }), [asOf]);
  const all: any[] = items(r.data);
  const term = q.trim().toLowerCase();
  const rows = all.filter((x) => !term || String(x.name ?? "").toLowerCase().includes(term) || String(x.sku ?? "").toLowerCase().includes(term));
  const hasVal = all.some((x) => x.stockValue != null);
  return (
    <div className="stack">
      <PageHeader subtitle={`Tồn kho tính đến ${asOf} · ${rows.length}/${all.length} mặt hàng`} actions={<>
        <ExportButton filename={`ton-kho-${asOf}`} rows={rows} columns={[{ label: "Hàng", value: (x) => x.name }, { label: "Tồn đầu (milli)", value: (x) => x.openingMilli }, { label: "Nhập (milli)", value: (x) => x.inMilli }, { label: "Xuất bán (milli)", value: (x) => x.soldMilli }, { label: "Hao hụt (milli)", value: (x) => x.wasteMilli }, { label: "Tồn cuối (milli)", value: (x) => x.onHandMilli }, ...(hasVal ? [{ label: "Giá trị", value: (x: any) => x.stockValue }] : [])]} />
        <a className="btn ghost sm" href={downloadHref(`/reports/export/inventory.csv?asOf=${asOf}`)} download="inventory.csv">Xuất CSV tồn kho</a></>} />
      <FilterBar>
        <label className="field"><span className="lbl">Tính đến ngày</span><input className="input" type="date" value={asOf} max={todayVN()} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên hàng…" label="Tìm hàng" />
      </FilterBar>
      {!r.loading && <KpiRow items={[
        { label: "Mặt hàng", value: all.length },
        { label: "Còn tồn", value: all.filter((x) => x.onHandMilli > 0).length, tone: "ok" },
        { label: "Hết hàng", value: all.filter((x) => !(x.onHandMilli > 0)).length, tone: all.some((x) => !(x.onHandMilli > 0)) ? "warn" : undefined },
        ...(hasVal ? [{ label: "Giá trị tồn", value: money(all.reduce((a, x) => a + (x.stockValue ?? 0), 0)) }] : [{ label: "Hao hụt (kỳ)", value: all.filter((x) => x.wasteMilli > 0).length, sub: "mặt hàng" }]),
      ]} />}
      {r.loading ? <Spinner /> : <DataTable rows={rows} rowKey={(x) => x.productId} pageSize={50} emptyState={<EmptyState title={q ? "Không có hàng nào khớp" : "Chưa có dữ liệu tồn kho"} action={q ? <Button variant="soft" onClick={() => setQ("")}>Xoá lọc</Button> : undefined} />} cols={[
        { key: "n", label: "Hàng", title: true, sort: (x) => x.name, render: (x) => <b>{x.name}</b> },
        { key: "o", label: "Tồn đầu", num: true, sort: (x) => x.openingMilli, hideBelow: 1280, render: (x) => qtyText(x.openingMilli, x.baseUnit) },
        { key: "i", label: "Nhập", num: true, sort: (x) => x.inMilli, render: (x) => qtyText(x.inMilli, x.baseUnit) },
        { key: "x", label: "Xuất bán", num: true, sort: (x) => x.soldMilli, render: (x) => qtyText(x.soldMilli, x.baseUnit) },
        { key: "w", label: "Hao hụt", num: true, sort: (x) => x.wasteMilli, render: (x) => qtyText(x.wasteMilli, x.baseUnit) },
        { key: "c", label: "Tồn cuối", num: true, sort: (x) => x.onHandMilli, render: (x) => <b>{qtyText(x.onHandMilli, x.baseUnit)}</b> },
        { key: "v", label: "Giá trị", num: true, sort: (x) => x.stockValue, render: (x) => (x.stockValue != null ? money(x.stockValue) : "—") },
      ]} />}
    </div>
  );
}
export { Button };
