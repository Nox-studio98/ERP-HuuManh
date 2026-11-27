import { Badge, Banner, Card, DataTable } from "./ui";
import { PAY_LABEL, PayTable, payTotals } from "./pay-breakdown";
import { PrintDoc, type DocSection, type Paper } from "./report-print";
import { CHANNELS, fmtDateTime, money } from "../format";

/** Kết quả GET /shifts/:id/summary (đã camelize). */
export type ShiftSummary = any;

const methodsText = (ms: string[]) => ms.map((m) => PAY_LABEL[m] ?? m).join(", ") || "—";

/** Nội dung chi tiết một ca: tiền mặt, bán theo hình thức, công thức tiền mặt, thu/chi, trả hàng. */
export function ShiftDetailBody({ s }: { s: ShiftSummary }) {
  const sh = s.shift, f = s.cashFormula;
  const closed = sh.status === "closed";
  const diff = sh.diffCash;
  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><div className="l">Tiền đầu ca</div><div className="v">{money(sh.openingCash)}</div></div>
        <div className="kpi"><div className="l">Tiền mặt dự kiến</div><div className="v">{money(sh.expectedCash)}</div></div>
        <div className="kpi"><div className="l">{closed ? "Bàn giao (kiểm đếm)" : "Kiểm đếm"}</div><div className="v">{closed ? money(sh.countedCash) : "—"}</div></div>
        <div className="kpi"><div className="l">Chênh lệch</div><div className="v" style={{ color: diff ? "var(--warn)" : undefined }}>{closed ? money(diff ?? 0) : "—"}</div></div>
      </div>
      {closed && diff ? <Banner tone="danger">Chênh lệch {diff > 0 ? "thừa" : "thiếu"} {money(Math.abs(diff))}. Lý do: {sh.diffReason || "—"}</Banner> : null}
      <Card title="Thông tin ca">
        <div className="kv-row"><span className="muted">Thu ngân</span><b>{sh.cashierName}</b></div>
        <div className="kv-row"><span className="muted">Giờ mở</span><b>{fmtDateTime(sh.openedAt)}</b></div>
        <div className="kv-row"><span className="muted">Giờ đóng</span><b>{closed ? fmtDateTime(sh.closedAt) : <Badge tone="info">Đang mở</Badge>}</b></div>
        <div className="kv-row"><span className="muted">Doanh thu thuần</span><b className="money">{money(s.sales.revenue)}</b></div>
        <div className="kv-row"><span className="muted">Số đơn bán · phiếu trả</span><b>{s.sales.saleCount} · {s.sales.returnCount}</b></div>
        {s.sales.otherCharges ? <div className="kv-row"><span className="muted">Trong đó thu khác (phí đóng gói…)</span><b className="money">{money(s.sales.otherCharges)}</b></div> : null}
      </Card>
      <Card title="Bán theo hình thức thanh toán"><PayTable rows={s.byPayment} /></Card>
      <Card title="Tiền mặt cuối ca">
        <div className="kv-row"><span className="muted">Tiền đầu ca</span><span className="num">{money(f.opening)}</span></div>
        <div className="kv-row"><span className="muted">+ Thu tiền mặt bán hàng</span><span className="num">{money(f.cashSold)}</span></div>
        <div className="kv-row"><span className="muted">− Hoàn tiền mặt trả hàng</span><span className="num">{money(f.cashRefunded)}</span></div>
        <div className="kv-row"><span className="muted">± Cọc đặt trước (phiếu thu/chi)</span><span className="num">{money(f.deposits)}</span></div>
        <div className="kv-row" data-testid="shift-debt-collected"><span className="muted">+ Thu nợ khách lẻ bằng tiền mặt</span><span className="num">{money(f.debtCollected ?? 0)}</span></div>
        <div className="kv-row"><span className="muted">− Hoàn tiền mặt khi huỷ đơn</span><span className="num">{money(f.voidRefunds)}</span></div>
        <div className="kv-row" style={{ fontWeight: 700 }}><span>= Dự kiến trong két</span><span className="num">{money(f.expected)}</span></div>
      </Card>
      <Card title={`Phiếu thu / chi của quầy trong ca (${s.vouchers.items.length})`}>
        {s.vouchers.items.length === 0 ? <div className="hint">Không có phiếu thu/chi.</div> : (
          <DataTable rows={s.vouchers.items} rowKey={(v: any) => v.code + v.direction} cols={[
            { key: "c", label: "Phiếu", title: true, render: (v: any) => <>{v.code} <Badge tone={v.direction === "in" ? "ok" : "warn"}>{v.direction === "in" ? "Thu" : "Chi"}</Badge></> },
            { key: "k", label: "Khoản mục", render: (v: any) => <>{v.category}{v.inExpected ? <> <Badge tone="info">tính vào két</Badge></> : null}</> },
            { key: "a", label: "Số tiền", right: true, num: true, render: (v: any) => money(v.amount) },
          ]} />
        )}
        <div className="hint">Chỉ phiếu cọc đặt trước và phiếu thu nợ khách lẻ được tính vào tiền mặt dự kiến; các phiếu khác hiển thị để đối chiếu.</div>
      </Card>
      <Card title={`Trả hàng trong ca (${s.returns.length})`}>
        {s.returns.length === 0 ? <div className="hint">Không có phiếu trả hàng.</div> : (
          <DataTable rows={s.returns} rowKey={(r: any) => r.code} cols={[
            { key: "c", label: "Phiếu trả", title: true, render: (r: any) => r.code },
            { key: "m", label: "Hoàn bằng", render: (r: any) => methodsText(r.methods) },
            { key: "t", label: "Số tiền", right: true, num: true, render: (r: any) => money(r.total) },
          ]} />
        )}
        {s.voided.count > 0 && <div className="hint">Huỷ đơn có hoàn tiền từ két ca này: {s.voided.count} đơn · {money(s.voided.total)}.</div>}
      </Card>
    </div>
  );
}

/** Phiếu bàn giao ca (bản in). */
export function shiftSections(s: ShiftSummary): DocSection[] {
  const sh = s.shift, f = s.cashFormula, t = payTotals(s.byPayment);
  const closed = sh.status === "closed";
  return [
    { kv: [["Mã ca", `#${sh.id}`], ["Thu ngân", sh.cashierName], ["Giờ mở", fmtDateTime(sh.openedAt)], ["Giờ đóng", closed ? fmtDateTime(sh.closedAt) : "đang mở"]] },
    { heading: "Tiền mặt", kv: [["Tiền đầu ca", money(f.opening)], ["+ Thu tiền mặt bán hàng", money(f.cashSold)], ["− Hoàn tiền mặt trả hàng", money(f.cashRefunded)], ["± Cọc đặt trước", money(f.deposits)], ["+ Thu nợ khách lẻ (tiền mặt)", money(f.debtCollected ?? 0)], ["− Hoàn tiền huỷ đơn", money(f.voidRefunds)],
      ["Dự kiến trong két", money(sh.expectedCash), true], ...(closed ? ([["Tiền bàn giao (kiểm đếm)", money(sh.countedCash), true], ["Chênh lệch", money(sh.diffCash ?? 0), true]] as [string, string, boolean?][]) : [])],
      note: closed && sh.diffCash ? `Lý do chênh lệch: ${sh.diffReason || "—"}` : undefined },
    { heading: "Bán hàng", kv: [["Số đơn bán", s.sales.saleCount], ["Doanh thu bán", money(s.sales.saleTotal)], [`Trả hàng (${s.sales.returnCount} phiếu)`, s.sales.returnTotal ? `-${money(s.sales.returnTotal)}` : money(0)], ["Doanh thu thuần", money(s.sales.revenue), true], ...(s.sales.otherCharges ? ([["Trong đó thu khác", money(s.sales.otherCharges)]] as [string, string, boolean?][]) : [])] },
    { heading: "Theo hình thức thanh toán", table: { head: ["Hình thức", "Bán", "Hoàn", "Ròng"], right: [1, 2, 3], rows: s.byPayment.map((p: any) => [PAY_LABEL[p.method] ?? p.method, money(p.sold), money(p.refunded), money(p.net)]), foot: ["Thu tiền", money(t.sold), money(t.refunded), money(t.net)] },
      note: "Điểm và voucher là giảm trừ, không phải tiền thu." },
    { heading: "Theo kênh", table: { head: ["Kênh", "Đơn", "Doanh thu"], right: [1, 2], rows: (s.byChannel ?? []).map((c: any) => [CHANNELS[c.channel] ?? c.channel, c.orders, money(c.revenue)]) } },
    ...(s.vouchers.items.length ? [{ heading: "Phiếu thu / chi", table: { head: ["Phiếu", "Khoản mục", "Số tiền"], right: [2], rows: s.vouchers.items.map((v: any) => [`${v.code} (${v.direction === "in" ? "thu" : "chi"})`, v.category, money(v.amount)]) } }] : []),
    ...(s.returns.length ? [{ heading: "Trả hàng", table: { head: ["Phiếu", "Hoàn bằng", "Số tiền"], right: [2], rows: s.returns.map((r: any) => [r.code, methodsText(r.methods), money(r.total)]) } }] : []),
  ];
}

export function ShiftHandoverDoc({ s, paper }: { s: ShiftSummary; paper: Paper }) {
  return <PrintDoc paper={paper} title="PHIẾU BÀN GIAO CA" meta={`Ca #${s.shift.id} · in lúc ${fmtDateTime(new Date().toISOString())}`} sections={shiftSections(s)}
    footer={<div className="rpt-sign"><div><b>Người giao</b><span>(ký, ghi rõ họ tên)</span></div><div><b>Người nhận</b><span>(ký, ghi rõ họ tên)</span></div></div>} />;
}
