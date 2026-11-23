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

const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
function Pnl() {
  const [from, setFrom] = useState(todayVN(-6)), [to, setTo] = useState(todayVN()), [by, setBy] = useState("day");
  const r = useAsync(() => get("/reports/pnl", { from, to, groupBy: by }), [from, to, by]);
  const rows: any[] = (items<any>(r.data?.rows ?? r.data?.items ?? r.data) ?? []).map((x) => ({
    ...x, label: String(x.label ?? x.key ?? x.day ?? x.channel ?? x.groupName ?? x.group ?? "—"),
    revenue: x.revenue ?? x.netRevenue ?? 0, cogs: x.cogs ?? x.costOfGoods ?? x.cost ?? 0, gross: x.grossProfit ?? x.gross ?? (x.revenue ?? 0) - (x.cogs ?? x.cost ?? 0),
  }));
  const t = r.data?.totals ?? {};
  const rev = t.revenue ?? sum(rows, "revenue"), cogs = t.cogs ?? sum(rows, "cogs"), gross = t.grossProfit ?? sum(rows, "gross");
  const exp = t.expenses ?? t.expense ?? r.data?.expenses ?? 0;
  const net = t.netProfit ?? gross - (typeof exp === "number" ? exp : 0);
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
          <DataTable rows={rows} rowKey={(x) => x.label} cols={[
            { key: "l", label: by === "day" ? "Ngày" : by === "channel" ? "Kênh" : "Nhóm", title: true, render: (x) => <b>{lab(x.label)}</b> },
            { key: "r", label: "Doanh thu", right: true, render: (x) => money(x.revenue) },
            { key: "c", label: "Giá vốn", right: true, render: (x) => money(x.cogs) },
            { key: "g", label: "Lãi gộp", right: true, render: (x) => money(x.gross) },
            { key: "m", label: "Biên", right: true, render: (x) => (x.revenue ? <Badge tone={x.gross / x.revenue < 0.1 ? "warn" : "ok"}>{Math.round((x.gross / x.revenue) * 100)}%</Badge> : "—") },
          ]} />
          <div className="row wrap"><a className="btn soft" href={downloadHref(`/reports/export/pnl.csv?from=${from}&to=${to}&groupBy=${by}`)} download>Xuất CSV lãi lỗ</a></div>
        </>
      )}
    </div>
  );
}

function Inv() {
  const [asOf, setAsOf] = useState(todayVN());
  const r = useAsync(() => get("/reports/inventory", { asOf }), [asOf]);
  const rows: any[] = items(r.data?.rows ?? r.data?.items ?? r.data);
  return (
    <div className="stack">
      <div className="row between wrap" style={{ alignItems: "flex-end" }}>
        <div style={{ maxWidth: 200 }}><Input label="Tính đến ngày" type="date" value={asOf} max={todayVN()} onChange={(e) => setAsOf(e.target.value)} /></div>
        <a className="btn soft" href={downloadHref(`/reports/export/inventory.csv?asOf=${asOf}`)} download>Xuất CSV tồn kho</a>
      </div>
      {r.loading ? <Spinner /> : <DataTable rows={rows} rowKey={(x) => x.productId ?? x.id ?? x.name} cols={[
        { key: "n", label: "Hàng", title: true, render: (x) => <b>{x.productName ?? x.name}</b> },
        { key: "o", label: "Tồn đầu", right: true, render: (x) => qtyText(x.openingMilli) },
        { key: "i", label: "Nhập", right: true, render: (x) => qtyText(x.inMilli ?? x.receivedMilli) },
        { key: "x", label: "Xuất bán", right: true, render: (x) => qtyText(x.outMilli ?? x.soldMilli) },
        { key: "w", label: "Hao hụt", right: true, render: (x) => qtyText(x.wasteMilli) },
        { key: "c", label: "Tồn cuối", right: true, render: (x) => <b>{qtyText(x.closingMilli ?? x.onHandMilli)}</b> },
        { key: "v", label: "Giá trị", right: true, render: (x) => money(x.value ?? x.stockValue) },
      ]} />}
    </div>
  );
}
export { Button };
