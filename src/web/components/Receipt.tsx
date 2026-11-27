import { CHANNELS, METHODS, fmtDate, fmtDateTime, money, qtyText } from "../format";
import { QrImage } from "./QrImage";
import { Button } from "./ui";
import { toast } from "./toast";

export type ReceiptOrder = any;
export const lineName = (l: any, names?: Record<number, string>) => l.productName ?? l.name ?? names?.[l.productId] ?? `Sản phẩm #${l.productId}`;

export function receiptText(o: ReceiptOrder, names?: Record<number, string>) {
  const L = (o.lines ?? []).map((l: any) => `${lineName(l, names)} ${qtyText(l.qtyShown ?? l.qtyMilli, l.unit)} x ${money(l.priceShown ?? l.unitPrice)} = ${money(l.lineTotal)}`);
  const C = (o.charges ?? []).map((c: any) => `${c.name}: ${money(c.amount)}`);
  const D = o.credit && o.credit.outstanding > 0 ? [`Còn nợ: ${money(o.credit.outstanding)} (hạn ${fmtDate(o.credit.dueDate)})`] : [];
  return [`Hữu Mạnh — Hoá đơn ${o.code ?? ""}`, fmtDateTime(o.createdAt), ...L, ...C, `Tổng: ${money(o.total)}`, ...D].join("\n");
}

export function Receipt({ order, names, change }: { order: ReceiptOrder; names?: Record<number, string>; change?: number }) {
  const o = order;
  const ch = change ?? o.change;
  const share = async () => {
    const text = receiptText(o, names);
    try {
      if (navigator.share) await navigator.share({ title: `Hoá đơn ${o.code}`, text });
      else { await navigator.clipboard.writeText(text); toast("Đã sao chép nội dung hoá đơn", "ok"); }
    } catch { /* người dùng huỷ */ }
  };
  return (
    <div className="stack">
      <div className="receipt print-area" aria-label="Hoá đơn">
        <div style={{ textAlign: "center", fontWeight: 700 }}>CỬA HÀNG TRÁI CÂY HỮU MẠNH</div>
        <div style={{ textAlign: "center" }}>{o.kind === "return" ? "PHIẾU TRẢ HÀNG" : "HOÁ ĐƠN BÁN HÀNG"}</div>
        <hr />
        <div className="l"><span>Số</span><span>{o.code}</span></div>
        <div className="l"><span>Ngày</span><span>{fmtDateTime(o.createdAt)}</span></div>
        {o.channel && <div className="l"><span>Kênh</span><span>{CHANNELS[o.channel] ?? o.channel}</span></div>}
        <hr />
        {(o.lines ?? []).map((l: any, i: number) => (
          <div key={l.id ?? i} style={{ marginBottom: 6 }}>
            <div>{lineName(l, names)}</div>
            <div className="l"><span>{qtyText(l.qtyShown ?? l.qtyMilli, l.unit)} × {money(l.priceShown ?? l.unitPrice)}</span><span>{money(l.lineTotal)}</span></div>
            {l.discount ? <div className="l"><span>Giảm</span><span>-{money(l.discount)}</span></div> : null}
          </div>
        ))}
        <hr />
        {Array.isArray(o.discounts) && o.discounts.length
          ? o.discounts.map((d: { description: string; amount: number }, i: number) => <div key={i} className="l"><span>{d.description}</span><span>-{money(d.amount)}</span></div>)
          : o.discount ? <div className="l"><span>Giảm giá đơn</span><span>-{money(o.discount)}</span></div> : null}
        {(o.charges ?? []).map((c: any, i: number) => <div key={`ch${i}`} className="l" data-testid="receipt-charge"><span>{c.name}</span><span>+{money(c.amount)}</span></div>)}
        <div className="l" style={{ fontWeight: 700, fontSize: "1.05em" }}><span>TỔNG CỘNG</span><span>{money(o.total)}</span></div>
        {(o.payments ?? []).map((p: any, i: number) => <div className="l" key={i}><span>{METHODS[p.method] ?? p.method}</span><span>{money(p.amount)}</span></div>)}
        {ch ? <div className="l"><span>Tiền thừa</span><span>{money(ch)}</span></div> : null}
        {o.credit && (
          <div data-testid="receipt-credit">
            <hr />
            {o.credit.outstanding > 0 ? (
              <>
                <div className="l" style={{ fontWeight: 700, fontSize: "1.05em" }}><span>CÒN NỢ</span><span>{money(o.credit.outstanding)}</span></div>
                <div className="l"><span>Hạn trả</span><span>{fmtDate(o.credit.dueDate)}</span></div>
                {o.credit.qrPayload && (
                  <div style={{ textAlign: "center", marginTop: 6 }} data-testid="receipt-credit-qr">
                    <QrImage value={o.credit.qrPayload} size={150} label={`Mã QR trả nợ ${money(o.credit.outstanding)}`} />
                    <div>Quét mã để trả nợ</div>
                    <div style={{ fontWeight: 700 }}>{o.credit.payCode}</div>
                  </div>
                )}
              </>
            ) : <div style={{ textAlign: "center" }}>Khoản nợ đã được thanh toán đủ</div>}
          </div>
        )}
        <hr />
        <div style={{ textAlign: "center" }}>Cảm ơn quý khách!</div>
      </div>
      <div className="row">
        <Button className="grow" onClick={() => window.print()}>In hoá đơn</Button>
        <Button className="grow" variant="soft" onClick={share}>Chia sẻ</Button>
      </div>
    </div>
  );
}
