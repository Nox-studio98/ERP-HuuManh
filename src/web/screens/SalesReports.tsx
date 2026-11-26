import { useState } from "react";
import { get, items } from "../api";
import { Badge, Card, DataTable, EmptyState, Segmented, Spinner, useAsync } from "../components/ui";
import { DateRangeFilter, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, rangeOf, useWide, type DateRange } from "../components/list";
import { BarChart } from "../components/charts";
import { CHANNELS, fmtDate, money, qtyText } from "../format";
import { useCan } from "../store";

type Tab = "sellers" | "products" | "customers" | "suppliers";
const SUB: Record<Tab, string> = {
  sellers: "Doanh thu theo người bán của đơn (người bán có thể khác thu ngân); trả hàng trừ về người bán đơn gốc",
  products: "Bán chạy, bán chậm và hàng không phát sinh đơn trong kỳ; số lượng và doanh thu đã trừ trả hàng",
  customers: "Khách mua nhiều nhất trong kỳ; trả hàng trừ về khách của đơn gốc",
  suppliers: "Giá trị nhập, trả hàng nhà cung cấp trong kỳ và công nợ còn phải trả hiện tại",
};
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

export default function SalesReports() {
  const can = useCan();
  const cost = can("prices.view_cost");
  const [tab, setTab] = useState<Tab>("sellers");
  const [range, setRange] = useState<DateRange>(() => rangeOf("month"));
  const [channel, setChannel] = useState(""), [groupId, setGroupId] = useState("");
  const groups = useAsync(() => get("/product-groups", undefined, { silent: true }).then((r) => items<{ id: number; name: string }>(r)).catch(() => []), []);
  const q = { from: range.from, to: range.to, channel, groupId };
  const tabs = [{ v: "sellers" as Tab, label: "Theo người bán" }, { v: "products" as Tab, label: "Theo hàng hoá" }, { v: "customers" as Tab, label: "Theo khách hàng" }, ...(cost ? [{ v: "suppliers" as Tab, label: "Theo nhà cung cấp" }] : [])];
  const sales = tab !== "suppliers";
  return (
    <div className="stack" data-testid="sales-reports">
      <PageHeader subtitle={`${range.from === range.to ? range.from : `${range.from} → ${range.to}`} · ${SUB[tab]}`} />
      <Segmented fit wrap value={tab} onChange={setTab} options={tabs} />
      <FilterBar dirty={!!(channel || groupId)} onReset={() => { setChannel(""); setGroupId(""); }}
        advanced={sales ? <>
          <FilterSelect label="Kênh bán" value={channel} onChange={setChannel} options={Object.entries(CHANNELS).map(([v, label]) => ({ v, label }))} />
          <FilterSelect label="Nhóm hàng" value={groupId} onChange={setGroupId} options={(groups.data ?? []).map((g) => ({ v: String(g.id), label: g.name }))} />
        </> : undefined}>
        <DateRangeFilter value={range} onChange={setRange} />
      </FilterBar>
      {tab === "sellers" && <Sellers q={q} cost={cost} />}
      {tab === "products" && <Products q={q} cost={cost} />}
      {tab === "customers" && <Customers q={q} />}
      {tab === "suppliers" && <Suppliers q={q} />}
    </div>
  );
}
type Q = { from: string; to: string; channel: string; groupId: string };
const useReport = (kind: string, q: Q) => useAsync(() => get(`/reports/sales/${kind}`, { from: q.from, to: q.to, channel: q.channel || undefined, groupId: q.groupId || undefined }), [kind, q.from, q.to, q.channel, q.groupId]);
const EMPTY = <EmptyState title="Chưa có số liệu trong khoảng này" hint="Đổi khoảng thời gian hoặc bỏ bộ lọc kênh / nhóm hàng." />;

function Sellers({ q, cost }: { q: Q; cost: boolean }) {
  const r = useReport("sellers", q), wide = useWide();
  const d = r.data, rows: any[] = d?.items ?? [], t = d?.totals;
  if (r.loading) return <Spinner />;
  return (
    <div className="stack">
      <KpiRow items={[
        { label: "Doanh thu thuần", value: money(t?.revenue ?? 0) },
        { label: "Số đơn bán", value: t?.saleCount ?? 0, sub: `Trả hàng: ${money(t?.returns ?? 0)} (${t?.returnCount ?? 0} phiếu)` },
        { label: "Giá trị TB / đơn", value: money(t?.saleCount ? Math.round(t.sales / t.saleCount) : 0) },
        ...(cost ? [{ label: "Lãi gộp", value: money(t?.grossProfit ?? 0), tone: "ok" as const, sub: `Biên ${pct(t?.grossProfit ?? 0, t?.revenue ?? 0)}` }] : []),
      ]} />
      {d?.basis === "lines" && <div className="small muted">Đang lọc theo nhóm hàng: số liệu tính trên dòng hàng của nhóm, không gồm phí giao hàng.</div>}
      {!rows.length ? <Card>{EMPTY}</Card> : (
        <>
          <Card title="Doanh thu thuần theo người bán"><BarChart width={wide ? 1000 : 560} height={wide ? 220 : 180} maxBar={wide ? 56 : 44} data={rows.slice(0, 10).map((x) => ({ label: x.sellerName.length > 14 ? x.sellerName.slice(0, 13) + "…" : x.sellerName, value: x.revenue }))} /></Card>
          <div className="row" style={{ justifyContent: "flex-end" }}><ExportButton filename={`ban-hang-theo-nguoi-ban_${q.from}_${q.to}`} rows={rows} columns={[
              { label: "Người bán", value: (x) => x.sellerName }, { label: "Số đơn", value: (x) => x.saleCount }, { label: "Doanh thu bán", value: (x) => x.sales }, { label: "Trả hàng", value: (x) => x.returns },
              { label: "Doanh thu thuần", value: (x) => x.revenue }, { label: "TB / đơn", value: (x) => x.avgOrder }, ...(cost ? [{ label: "Giá vốn", value: (x: any) => x.cogs }, { label: "Lãi gộp", value: (x: any) => x.grossProfit }] : []),
            ]} /></div>
          <DataTable rows={rows} rowKey={(x) => x.sellerId ?? "none"} defaultSort={{ key: "rev", dir: "desc" }}
                        cols={[
              { key: "n", label: "Người bán", title: true, sort: (x) => x.sellerName, render: (x) => <b>{x.sellerName}</b> },
              { key: "c", label: "Số đơn", num: true, sort: (x) => x.saleCount, render: (x) => x.saleCount },
              { key: "s", label: "Doanh thu bán", num: true, hideBelow: 1024, sort: (x) => x.sales, render: (x) => money(x.sales) },
              { key: "r", label: "Trả hàng", num: true, sort: (x) => x.returns, render: (x) => (x.returns ? <span style={{ color: "var(--danger)" }}>{money(-x.returns)}</span> : "—") },
              { key: "rev", label: "Doanh thu thuần", num: true, sort: (x) => x.revenue, render: (x) => <b>{money(x.revenue)}</b> },
              { key: "a", label: "TB / đơn", num: true, hideBelow: 1280, sort: (x) => x.avgOrder, render: (x) => money(x.avgOrder) },
              ...(cost ? [{ key: "g", label: "Lãi gộp", num: true, sort: (x: any) => x.grossProfit, render: (x: any) => money(x.grossProfit) }, { key: "m", label: "Biên", num: true, hideBelow: 1280 as const, sort: (x: any) => (x.revenue ? x.grossProfit / x.revenue : -1), render: (x: any) => (x.revenue ? <Badge tone={x.grossProfit / x.revenue < 0.1 ? "warn" : "ok"}>{pct(x.grossProfit, x.revenue)}</Badge> : "—") }] : []),
            ]} />
        </>
      )}
    </div>
  );
}

function Products({ q, cost }: { q: Q; cost: boolean }) {
  const r = useReport("products", q);
  const [view, setView] = useState<"best" | "slow" | "unsold">("best");
  if (r.loading) return <Spinner />;
  const d = r.data, rows: any[] = d?.items ?? [], unsold: any[] = d?.unsold ?? [], t = d?.totals;
  const unit = (x: any) => qtyText(x.qtyMilli, x.baseUnit);
  const slow = [...rows].sort((a, b) => a.qtyMilli - b.qtyMilli);
  return (
    <div className="stack">
      <KpiRow items={[
        { label: "Doanh thu hàng hoá", value: money(t?.revenue ?? 0), sub: "Chưa gồm phí giao hàng" },
        { label: "Mặt hàng có bán", value: rows.length },
        { label: "Mặt hàng không bán", value: unsold.length, tone: unsold.length ? "warn" : undefined, onClick: () => setView("unsold") },
        ...(cost ? [{ label: "Lãi gộp", value: money(t?.grossProfit ?? 0), tone: "ok" as const, sub: `Biên ${pct(t?.grossProfit ?? 0, t?.revenue ?? 0)}` }] : []),
      ]} />
      <Segmented fit value={view} onChange={setView} options={[{ v: "best", label: "Bán chạy" }, { v: "slow", label: "Bán chậm" }, { v: "unsold", label: `Không bán trong kỳ (${unsold.length})` }]} />
      {view === "unsold" ? (
        <>
        <div className="row" style={{ justifyContent: "flex-end" }}><ExportButton filename={`hang-khong-ban_${q.from}_${q.to}`} rows={unsold} columns={[{ label: "Mã", value: (x) => x.sku }, { label: "Tên", value: (x) => x.name }, { label: "Nhóm", value: (x) => x.groupName }, { label: "Tồn (milli)", value: (x) => x.onHandMilli }]} /></div>
        <DataTable rows={unsold} rowKey={(x) => x.productId} empty="Mọi mặt hàng đều có bán trong kỳ" defaultSort={{ key: "h", dir: "desc" }}
                    cols={[
            { key: "n", label: "Mặt hàng", title: true, sort: (x) => x.name, render: (x) => <><b>{x.name}</b> <span className="muted small">{x.sku}</span></> },
            { key: "g", label: "Nhóm", hideBelow: 1024, sort: (x) => x.groupName, render: (x) => x.groupName ?? "—" },
            { key: "h", label: "Tồn kho", num: true, sort: (x) => x.onHandMilli, render: (x) => (x.onHandMilli > 0 ? <Badge tone="warn">{unit({ qtyMilli: x.onHandMilli, baseUnit: x.baseUnit })}</Badge> : unit({ qtyMilli: x.onHandMilli, baseUnit: x.baseUnit })) },
          ]} />
        </>
      ) : !rows.length ? <Card>{EMPTY}</Card> : (
        <>
        <div className="row" style={{ justifyContent: "flex-end" }}><ExportButton filename={`ban-hang-theo-hang-hoa_${q.from}_${q.to}`} rows={rows} columns={[
            { label: "Mã", value: (x) => x.sku }, { label: "Tên", value: (x) => x.name }, { label: "Nhóm", value: (x) => x.groupName }, { label: "Số lượng", value: (x) => x.qtyMilli / 1000 }, { label: "Doanh thu", value: (x) => x.revenue },
            ...(cost ? [{ label: "Giá vốn", value: (x: any) => x.cogs }, { label: "Lãi gộp", value: (x: any) => x.grossProfit }] : []),
          ]} /></div>
        <DataTable rows={view === "slow" ? slow : rows} rowKey={(x) => x.productId} pageSize={50} defaultSort={view === "slow" ? { key: "q", dir: "asc" } : { key: "r", dir: "desc" }}
                    cols={[
            { key: "n", label: "Mặt hàng", title: true, sort: (x) => x.name, render: (x) => <><b>{x.name}</b> <span className="muted small">{x.sku}</span></> },
            { key: "g", label: "Nhóm", hideBelow: 1024, sort: (x) => x.groupName, render: (x) => x.groupName ?? "—" },
            { key: "q", label: "Số lượng", num: true, sort: (x) => x.qtyMilli, render: unit },
            { key: "r", label: "Doanh thu", num: true, sort: (x) => x.revenue, render: (x) => money(x.revenue) },
            ...(cost ? [{ key: "gp", label: "Lãi gộp", num: true, sort: (x: any) => x.grossProfit, render: (x: any) => money(x.grossProfit) }, { key: "m", label: "Biên", num: true, hideBelow: 1280 as const, sort: (x: any) => (x.revenue ? x.grossProfit / x.revenue : -1), render: (x: any) => (x.revenue ? <Badge tone={x.grossProfit / x.revenue < 0.1 ? "warn" : "ok"}>{pct(x.grossProfit, x.revenue)}</Badge> : "—") }] : []),
          ]} />
        </>
      )}
    </div>
  );
}

function Customers({ q }: { q: Q }) {
  const r = useReport("customers", q);
  if (r.loading) return <Spinner />;
  const d = r.data, rows: any[] = d?.items ?? [], w = d?.walkIn;
  return (
    <div className="stack">
      <KpiRow items={[
        { label: "Doanh thu thuần", value: money(d?.totals?.revenue ?? 0) },
        { label: "Khách có mua", value: rows.length, sub: "Khách đã lưu thông tin" },
        { label: "Khách lẻ không lưu", value: money(w?.revenue ?? 0), sub: w ? `${w.orders} đơn` : undefined },
      ]} />
      {!rows.length ? <Card>{EMPTY}</Card> : (
        <>
        <div className="row" style={{ justifyContent: "flex-end" }}><ExportButton filename={`ban-hang-theo-khach_${q.from}_${q.to}`} rows={rows} columns={[{ label: "Mã", value: (x) => x.code }, { label: "Khách hàng", value: (x) => x.name }, { label: "SĐT", value: (x) => x.phone }, { label: "Số đơn", value: (x) => x.orders }, { label: "Doanh thu bán", value: (x) => x.sales }, { label: "Trả hàng", value: (x) => x.returns }, { label: "Doanh thu thuần", value: (x) => x.revenue }]} /></div>
        <DataTable rows={rows} rowKey={(x) => x.customerId} pageSize={50} defaultSort={{ key: "rev", dir: "desc" }}
                    cols={[
            { key: "n", label: "Khách hàng", title: true, sort: (x) => x.name, render: (x) => <><b>{x.name}</b> <span className="muted small">{x.code}</span></> },
            { key: "p", label: "SĐT", hideBelow: 1024, render: (x) => x.phone ?? "—" },
            { key: "o", label: "Số đơn", num: true, sort: (x) => x.orders, render: (x) => x.orders },
            { key: "r", label: "Trả hàng", num: true, hideBelow: 1280, sort: (x) => x.returns, render: (x) => (x.returns ? money(-x.returns) : "—") },
            { key: "rev", label: "Doanh thu thuần", num: true, sort: (x) => x.revenue, render: (x) => <b>{money(x.revenue)}</b> },
            { key: "a", label: "TB / đơn", num: true, hideBelow: 1280, sort: (x) => x.avgOrder, render: (x) => money(x.avgOrder) },
            { key: "l", label: "Mua gần nhất", hideBelow: 1024, sort: (x) => x.lastAt, render: (x) => fmtDate(x.lastAt) },
          ]} />
        </>
      )}
    </div>
  );
}

function Suppliers({ q }: { q: Q }) {
  const r = useAsync(() => get("/reports/sales/suppliers", { from: q.from, to: q.to }), [q.from, q.to]);
  if (r.loading) return <Spinner />;
  const d = r.data, rows: any[] = d?.items ?? [], t = d?.totals, hasDebt = t?.debt != null;
  return (
    <div className="stack">
      <KpiRow items={[
        { label: "Giá trị nhập", value: money(t?.purchased ?? 0), sub: `${t?.receiptCount ?? 0} phiếu nhập` },
        { label: "Trả hàng NCC", value: money(t?.returned ?? 0) },
        { label: "Nhập thuần", value: money(t?.netPurchased ?? 0) },
        ...(hasDebt ? [{ label: "Còn phải trả", value: money(t.debt), tone: t.debt > 0 ? ("warn" as const) : undefined, sub: "Tại thời điểm xem" }] : []),
      ]} />
      {!rows.length ? <Card>{EMPTY}</Card> : (
        <>
        <div className="row" style={{ justifyContent: "flex-end" }}><ExportButton filename={`ban-hang-theo-ncc_${q.from}_${q.to}`} rows={rows} columns={[{ label: "Mã", value: (x) => x.code }, { label: "Nhà cung cấp", value: (x) => x.name }, { label: "Số phiếu nhập", value: (x) => x.receiptCount }, { label: "Giá trị nhập", value: (x) => x.purchased }, { label: "Trả hàng NCC", value: (x) => x.returned }, { label: "Nhập thuần", value: (x) => x.netPurchased }, ...(hasDebt ? [{ label: "Còn phải trả", value: (x: any) => x.debt }] : [])]} /></div>
        <DataTable rows={rows} rowKey={(x) => x.supplierId} defaultSort={{ key: "net", dir: "desc" }}
                    cols={[
            { key: "n", label: "Nhà cung cấp", title: true, sort: (x) => x.name, render: (x) => <><b>{x.name}</b> <span className="muted small">{x.code}</span></> },
            { key: "c", label: "Số phiếu", num: true, sort: (x) => x.receiptCount, render: (x) => x.receiptCount },
            { key: "p", label: "Giá trị nhập", num: true, sort: (x) => x.purchased, render: (x) => money(x.purchased) },
            { key: "r", label: "Trả hàng NCC", num: true, sort: (x) => x.returned, render: (x) => (x.returned ? money(-x.returned) : "—") },
            { key: "net", label: "Nhập thuần", num: true, sort: (x) => x.netPurchased, render: (x) => <b>{money(x.netPurchased)}</b> },
            ...(hasDebt ? [{ key: "d", label: "Còn phải trả", num: true, sort: (x: any) => x.debt, render: (x: any) => (x.debt > 0 ? <Badge tone="warn">{money(x.debt)}</Badge> : money(x.debt)) }] : []),
          ]} />
        </>
      )}
    </div>
  );
}
