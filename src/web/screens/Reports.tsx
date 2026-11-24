import { useState } from "react";
import { get, items } from "../api";
import { Badge, Button, Card, DataTable, Input, Segmented, Select, Spinner, useAsync } from "../components/ui";
import { BarChart } from "../components/charts";
import { CHANNELS, downloadHref, money, qtyText, todayVN } from "../format";

export default function Reports() {
  const [tab, setTab] = useState<"pnl" | "inv">("pnl");
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={[{ v: "pnl", label: "Lãi lỗ" }, { v: "inv", label: "Tồn kho" }]} />
      {tab === "pnl" ? <Pnl /> : <Inv />}
    </div>
  );
}

const EXP_LABEL: Record<string, string> = { opex: "Chi phí vận hành", shrinkage: "Hao hụt / huỷ hàng", other: "Chi phí khác", payroll: "Lương", marketing: "Marketing", badDebt: "Xoá nợ khó đòi", stockCount: "Chênh lệch kiểm kê", purchaseVariance: "Chênh lệch giá mua" };
function Pnl() {
  const [from, setFrom] = useState(todayVN(-6)), [to, setTo] = useState(todayVN()), [by, setBy] = useState("day");
  const r = useAsync(() => get("/reports/pnl", { from, to, groupBy: by }), [from, to, by]);
  // Backend: { revenue, cogs, grossProfit, expenses:{[pnlLine]:vnd}, totalExpenses, netProfit, breakdown:[{key,revenue,cogs,grossProfit}] }
  const d = r.data ?? {};
  const rows: any[] = (d.breakdown ?? []).map((x: any) => ({ label: String(x.key ?? "—"), revenue: x.revenue ?? 0, cogs: x.cogs ?? 0, gross: x.grossProfit ?? (x.revenue ?? 0) - (x.cogs ?? 0) }));
  const rev = d.revenue ?? 0, cogs = d.cogs ?? 0, gross = d.grossProfit ?? 0, exp = d.totalExpenses ?? 0, net = d.netProfit ?? gross - exp;
  const expRows = Object.entries(d.expenses ?? {}).filter(([, v]) => Number(v) !== 0) as [string, number][];
  const lab = (x: string) => (by === "channel" ? CHANNELS[x] ?? x : by === "day" ? x.slice(5) : x);
  return (
    <div className="stack">
      <div className="grid3">
        <Input label="Từ ngày" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input label="Đến ngày" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        <Select label="Nhóm theo" value={by} onChange={(e) => setBy(e.target.value)}><option value="day">Ngày</option><option value="channel">Kênh bán</option><option value="group">Nhóm hàng</option></Select>
      </div>
      {r.loading ? <Spinner /> : (
        <>
          <div className="kpis">
            <div className="kpi"><div className="l">Doanh thu</div><div className="v">{money(rev)}</div></div>
            <div className="kpi"><div className="l">Giá vốn</div><div className="v">{money(cogs)}</div></div>
            <div className="kpi"><div className="l">Lãi gộp</div><div className="v" style={{ color: "var(--accent)" }}>{money(gross)}</div></div>
            <div className="kpi"><div className="l">Lãi sau chi phí</div><div className="v" style={{ color: net < 0 ? "var(--danger)" : undefined }}>{money(net)}</div></div>
          </div>
          <Card title="Doanh thu"><BarChart data={rows.map((x) => ({ label: lab(x.label), value: x.revenue }))} /></Card>
          {(d.revenueDeductions?.paymentDiscount > 0 || d.otherIncome?.total > 0) && (
            <Card title="Giảm trừ doanh thu và thu khác"><DataTable rows={[
              ["Chiết khấu thanh toán (giảm trừ doanh thu)", -(d.revenueDeductions?.paymentDiscount ?? 0)],
              ["Cọc không hoàn", d.otherIncome?.forfeitedDeposits ?? 0],
              ["Chiết khấu / xoá nợ nhà cung cấp", d.otherIncome?.payableDiscounts ?? 0],
              ["Chênh lệch đối soát thừa", d.otherIncome?.settlementSurplus ?? 0],
              ["Thu khác (phiếu thu)", d.otherIncome?.otherReceipts ?? 0],
            ].filter((x) => Number(x[1]) !== 0) as [string, number][]} rowKey={(x) => x[0]} cols={[{ key: "k", label: "Khoản", title: true, render: (x) => x[0] }, { key: "v", label: "Số tiền", right: true, render: (x) => money(x[1]) }]} /></Card>
          )}
          {expRows.length > 0 && <Card title="Chi phí"><DataTable rows={expRows} rowKey={(x) => x[0]} cols={[{ key: "k", label: "Khoản", title: true, render: (x) => EXP_LABEL[x[0]] ?? x[0] }, { key: "v", label: "Số tiền", right: true, render: (x) => money(x[1]) }]} /></Card>}
          <DataTable rows={rows} rowKey={(x) => x.label} cols={[
            { key: "l", label: by === "day" ? "Ngày" : by === "channel" ? "Kênh" : "Nhóm", title: true, render: (x) => <b>{lab(x.label)}</b> },
            { key: "r", label: "Doanh thu", right: true, render: (x) => money(x.revenue) },
            { key: "c", label: "Giá vốn", right: true, render: (x) => money(x.cogs) },
            { key: "g", label: "Lãi gộp", right: true, render: (x) => money(x.gross) },
            { key: "m", label: "Biên", right: true, render: (x) => (x.revenue ? <Badge tone={x.gross / x.revenue < 0.1 ? "warn" : "ok"}>{Math.round((x.gross / x.revenue) * 100)}%</Badge> : "—") },
          ]} />
          <div className="row wrap"><a className="btn soft" href={downloadHref(`/reports/export/pnl.csv?from=${from}&to=${to}&groupBy=${by}`)} download="pnl.csv">Xuất CSV lãi lỗ</a>
            <a className="btn soft" href={downloadHref(`/reports/export/orders.csv?from=${from}&to=${to}`)} download="orders.csv">Xuất CSV đơn hàng</a>
            <a className="btn soft" href={downloadHref(`/reports/export/daily.csv?day=${to}`)} download="daily.csv">Xuất CSV theo ngày ({to})</a></div>
        </>
      )}
    </div>
  );
}

function Inv() {
  const [asOf, setAsOf] = useState(todayVN());
  const r = useAsync(() => get("/reports/inventory", { asOf }), [asOf]);
  const rows: any[] = items(r.data);
  return (
    <div className="stack">
      <div className="row between wrap" style={{ alignItems: "flex-end" }}>
        <div style={{ maxWidth: 200 }}><Input label="Tính đến ngày" type="date" value={asOf} max={todayVN()} onChange={(e) => setAsOf(e.target.value)} /></div>
        <a className="btn soft" href={downloadHref(`/reports/export/inventory.csv?asOf=${asOf}`)} download="inventory.csv">Xuất CSV tồn kho</a>
      </div>
      {r.loading ? <Spinner /> : <DataTable rows={rows} rowKey={(x) => x.productId} cols={[
        { key: "n", label: "Hàng", title: true, render: (x) => <b>{x.name}</b> },
        { key: "o", label: "Tồn đầu", right: true, render: (x) => qtyText(x.openingMilli, x.baseUnit) },
        { key: "i", label: "Nhập", right: true, render: (x) => qtyText(x.inMilli, x.baseUnit) },
        { key: "x", label: "Xuất bán", right: true, render: (x) => qtyText(x.soldMilli, x.baseUnit) },
        { key: "w", label: "Hao hụt", right: true, render: (x) => qtyText(x.wasteMilli, x.baseUnit) },
        { key: "c", label: "Tồn cuối", right: true, render: (x) => <b>{qtyText(x.onHandMilli, x.baseUnit)}</b> },
        { key: "v", label: "Giá trị", right: true, render: (x) => money(x.stockValue) },
      ]} />}
    </div>
  );
}
export { Button };
