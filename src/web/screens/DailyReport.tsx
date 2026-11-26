import { useState } from "react";
import { get } from "../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Spinner, useAsync } from "../components/ui";
import { ExportButton, FilterBar, KpiRow, PageHeader } from "../components/list";
import { PAY_LABEL, PayTable, payTotals, type PayRow } from "../components/pay-breakdown";
import { PrintButtons, PrintDoc, usePrintDoc, type DocSection } from "../components/report-print";
import { CHANNELS, fmtDate, fmtDateTime, fmtTime, money, todayVN } from "../format";
import { navigate } from "../router";
import { useCan } from "../store";

/** Báo cáo cuối ngày (GET /reports/daily): doanh thu theo kênh + hình thức thanh toán, trả hàng, huỷ, thu/chi quỹ, danh sách ca. In A4 / 80mm, xuất CSV. */
export default function DailyReport() {
  const can = useCan();
  const [day, setDay] = useState(() => new URLSearchParams(location.search).get("day") || todayVN());
  const r = useAsync(() => get("/reports/daily", { day }), [day]);
  const { paper, print } = usePrintDoc();
  const d = r.data;
  const pay: PayRow[] = d?.byPayment ?? [];
  const showCost = d && d.grossProfit != null && can("prices.view_cost");
  const totals = payTotals(pay);
  const cashIn = d?.cashFlow?.in ?? 0, cashOut = d?.cashFlow?.out ?? 0;
  const shifts: any[] = d?.shifts ?? [];
  const dayLabel = fmtDate(`${day}T05:00:00Z`);

  const csvRows = !d ? [] : [
    { s: "Tổng quan", k: "Số đơn bán", v: d.saleCount }, { s: "Tổng quan", k: "Doanh thu bán", v: d.saleTotal }, { s: "Tổng quan", k: "Trả hàng", v: d.returnTotal }, { s: "Tổng quan", k: "Doanh thu thuần", v: d.revenue },
    ...(showCost ? [{ s: "Tổng quan", k: "Giá vốn", v: d.cogs }, { s: "Tổng quan", k: "Lãi gộp", v: d.grossProfit }] : []),
    ...(d.byChannel ?? []).map((c: any) => ({ s: "Theo kênh", k: CHANNELS[c.channel] ?? c.channel, v: c.revenue })),
    ...pay.flatMap((p) => [{ s: "Theo hình thức thanh toán", k: `${PAY_LABEL[p.method] ?? p.method} - bán`, v: p.sold }, { s: "Theo hình thức thanh toán", k: `${PAY_LABEL[p.method] ?? p.method} - hoàn`, v: p.refunded }]),
    { s: "Huỷ đơn", k: "Số đơn huỷ", v: d.cancelled?.count ?? 0 }, { s: "Huỷ đơn", k: "Giá trị huỷ", v: d.cancelled?.total ?? 0 },
    ...(d.cashFlow?.byCategory ?? []).map((c: any) => ({ s: c.direction === "in" ? "Thu quỹ" : "Chi quỹ", k: c.category, v: c.amount })),
    ...shifts.map((s) => ({ s: "Ca", k: `#${s.id} ${s.cashierName}`, v: s.diffCash ?? "" })),
  ];

  const sections: DocSection[] = !d ? [] : [
    { heading: "Tổng quan", kv: [["Số đơn bán", d.saleCount], ["Doanh thu bán", money(d.saleTotal)], [`Trả hàng (${d.returnCount} phiếu)`, d.returnTotal ? `-${money(d.returnTotal)}` : money(0)], ["Doanh thu thuần", money(d.revenue), true],
      ...(showCost ? ([["Giá vốn", money(d.cogs)], ["Lãi gộp", money(d.grossProfit), true]] as [string, string, boolean?][]) : [])] },
    { heading: "Theo kênh bán", table: { head: ["Kênh", "Đơn", "Doanh thu"], right: [1, 2], rows: (d.byChannel ?? []).map((c: any) => [CHANNELS[c.channel] ?? c.channel, c.orders, money(c.revenue)]) } },
    { heading: "Theo hình thức thanh toán", table: { head: ["Hình thức", "Bán", "Hoàn", "Ròng"], right: [1, 2, 3], rows: pay.map((p) => [PAY_LABEL[p.method] ?? p.method, money(p.sold), money(p.refunded), money(p.net)]), foot: ["Thu tiền (không gồm điểm/voucher)", money(totals.sold), money(totals.refunded), money(totals.net)] },
      note: "Điểm tích luỹ và voucher là phần giảm trừ, không phải tiền thu." },
    { heading: "Huỷ đơn", kv: [["Số đơn huỷ", d.cancelled?.count ?? 0], ["Giá trị huỷ", money(d.cancelled?.total ?? 0)]] },
    { heading: "Thu / chi quỹ", kv: [["Tổng thu", money(cashIn)], ["Tổng chi", money(cashOut)], ...(d.cashFlow?.transfers ? [["Chuyển giữa các quỹ", money(d.cashFlow.transfers)] as [string, string]] : []), ...(d.cashFlow?.byCategory ?? []).map((c: any) => [`${c.direction === "in" ? "Thu" : "Chi"}: ${c.category}`, money(c.amount)] as [string, string])] },
    { heading: "Ca làm việc", table: { head: ["Ca", "Thu ngân", "Mở", "Chênh lệch"], right: [3], rows: shifts.map((s) => [`#${s.id}`, s.cashierName, fmtTime(s.openedAt), s.status === "closed" ? money(s.diffCash ?? 0) : "đang mở"]) } },
  ];

  return (
    <div className="stack">
      <PageHeader subtitle={`Ngày ${dayLabel} (giờ Việt Nam)`} actions={<>
        <PrintButtons print={print} disabled={!d} />
        <ExportButton filename={`bao-cao-cuoi-ngay-${day}`} rows={csvRows} columns={[{ label: "Mục", value: (x) => x.s }, { label: "Chỉ tiêu", value: (x) => x.k }, { label: "Số liệu (VND hoặc số lượng)", value: (x) => x.v }]} />
        <Button size="sm" variant="ghost" onClick={() => navigate("/shift-history")}>Lịch sử ca</Button>
      </>} />
      <FilterBar>
        <div className="row wrap" style={{ alignItems: "center" }}>
          <input className="input" type="date" aria-label="Chọn ngày" value={day} max={todayVN()} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ maxWidth: 190 }} />
          <div className="seg fit" role="group" aria-label="Chọn nhanh">
            <button type="button" aria-pressed={day === todayVN()} onClick={() => setDay(todayVN())}>Hôm nay</button>
            <button type="button" aria-pressed={day === todayVN(-1)} onClick={() => setDay(todayVN(-1))}>Hôm qua</button>
          </div>
        </div>
      </FilterBar>
      {r.loading ? <Spinner /> : !d ? <Banner tone="danger">Không tải được báo cáo. Thử lại sau.</Banner> : (
        <>
          <KpiRow items={[
            { label: "Doanh thu thuần", value: money(d.revenue), sub: `${d.saleCount} đơn bán`, tone: "ok" },
            { label: "Trả hàng", value: money(d.returnTotal), sub: `${d.returnCount} phiếu` },
            { label: "Huỷ đơn", value: d.cancelled?.count ?? 0, sub: money(d.cancelled?.total ?? 0), tone: d.cancelled?.count ? "warn" : undefined },
            showCost ? { label: "Lãi gộp", value: money(d.grossProfit), sub: `Giá vốn ${money(d.cogs)}` } : { label: "Thu − chi quỹ", value: money(cashIn - cashOut), sub: `Thu ${money(cashIn)} · chi ${money(cashOut)}` },
          ]} />
          {d.saleCount === 0 && d.returnCount === 0 && shifts.length === 0 ? (
            <Card><EmptyState title="Ngày này chưa có giao dịch" hint="Chọn ngày khác để xem báo cáo." action={<Button variant="soft" onClick={() => setDay(todayVN(-1))}>Xem hôm qua</Button>} /></Card>
          ) : (
            <div className="two-col">
              <div className="stack">
                <Card title="Theo hình thức thanh toán"><PayTable rows={pay} /><div className="hint">Điểm tích luỹ và voucher là phần giảm trừ khi bán, không phải tiền thu. “Hoàn” là tiền trả lại khách trên phiếu trả hàng.</div></Card>
                <Card title="Theo kênh bán">
                  <DataTable rows={d.byChannel ?? []} rowKey={(c: any) => c.channel} empty="Chưa có đơn" cols={[
                    { key: "c", label: "Kênh", title: true, render: (c: any) => CHANNELS[c.channel] ?? c.channel },
                    { key: "o", label: "Số đơn", right: true, num: true, render: (c: any) => c.orders },
                    { key: "v", label: "Doanh thu", right: true, num: true, render: (c: any) => <b>{money(c.revenue)}</b> },
                  ]} />
                </Card>
              </div>
              <div className="stack">
                <Card title="Thu / chi quỹ trong ngày">
                  <div className="kv-row"><span className="muted">Tổng thu</span><b className="money">{money(cashIn)}</b></div>
                  <div className="kv-row"><span className="muted">Tổng chi</span><b className="money">{money(cashOut)}</b></div>
                  {d.cashFlow?.transfers ? <div className="kv-row"><span className="muted">Chuyển giữa các quỹ (không tính vào thu/chi)</span><b className="money">{money(d.cashFlow.transfers)}</b></div> : null}
                  {(d.cashFlow?.byCategory ?? []).length === 0 ? <div className="hint">Không có phiếu thu/chi.</div> : (
                    <DataTable rows={d.cashFlow.byCategory} rowKey={(c: any) => c.direction + c.category} cols={[
                      { key: "c", label: "Khoản mục", title: true, render: (c: any) => <>{c.category} <Badge tone={c.transfer ? "info" : c.direction === "in" ? "ok" : "warn"}>{c.transfer ? "Chuyển quỹ" : c.direction === "in" ? "Thu" : "Chi"}</Badge></> },
                      { key: "n", label: "Số phiếu", right: true, num: true, render: (c: any) => c.count },
                      { key: "a", label: "Số tiền", right: true, num: true, render: (c: any) => money(c.amount) },
                    ]} />
                  )}
                </Card>
                <Card title="Trả hàng và huỷ đơn">
                  <div className="kv-row"><span className="muted">Phiếu trả hàng</span><b>{d.returnCount} · {money(d.returnTotal)}</b></div>
                  {(d.returns?.byMethod ?? []).map((m: any) => <div className="kv-row" key={m.method}><span className="muted">Hoàn bằng {(PAY_LABEL[m.method] ?? m.method).toLowerCase()}</span><b className="money">{money(m.amount)}</b></div>)}
                  <div className="kv-row"><span className="muted">Đơn bị huỷ trong ngày</span><b>{d.cancelled?.count ?? 0} · {money(d.cancelled?.total ?? 0)}</b></div>
                </Card>
              </div>
            </div>
          )}
          <Card title="Ca làm việc trong ngày">
            <DataTable rows={shifts} rowKey={(s: any) => s.id} empty="Không có ca nào mở trong ngày" onRowClick={(s: any) => navigate(`/shift-history?open=${s.id}`)} cols={[
              { key: "id", label: "Ca", title: true, render: (s: any) => <b>#{s.id}</b> },
              { key: "u", label: "Thu ngân", render: (s: any) => s.cashierName },
              { key: "t", label: "Mở – đóng", render: (s: any) => <span className="nw">{fmtTime(s.openedAt)} – {s.closedAt ? fmtTime(s.closedAt) : "đang mở"}</span> },
              { key: "o", label: "Tiền đầu ca", right: true, num: true, render: (s: any) => money(s.openingCash) },
              { key: "e", label: "Dự kiến", right: true, num: true, render: (s: any) => (s.status === "closed" ? money(s.expectedCash) : "—") },
              { key: "c", label: "Kiểm đếm", right: true, num: true, render: (s: any) => (s.status === "closed" ? money(s.countedCash) : "—") },
              { key: "d", label: "Chênh lệch", right: true, num: true, render: (s: any) => (s.status === "closed" ? <span style={{ color: s.diffCash ? "var(--warn)" : undefined }}>{money(s.diffCash ?? 0)}</span> : <Badge tone="info">Đang mở</Badge>) },
            ]} />
          </Card>
        </>
      )}
      {d && <PrintDoc paper={paper} title="BÁO CÁO CUỐI NGÀY" meta={`Ngày ${dayLabel} · in lúc ${fmtDateTime(new Date().toISOString())}`} sections={sections} footer={<div className="rpt-kv"><span>Người lập: ....................</span><span>Chủ cửa hàng: ....................</span></div>} />}
    </div>
  );
}
