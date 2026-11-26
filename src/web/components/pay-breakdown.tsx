import { METHODS, money } from "../format";
import { Badge, DataTable } from "./ui";

export const PAY_LABEL: Record<string, string> = { ...METHODS, points: "Điểm tích luỹ", voucher: "Voucher" };
export type PayRow = { method: string; sold: number; refunded: number; net: number; kind: "payment" | "discount" };

/** Tổng các hình thức thu tiền (không gồm điểm/voucher — là giảm trừ, không phải dòng tiền). */
export const payTotals = (rows: PayRow[]) => {
  const p = rows.filter((r) => r.kind === "payment");
  return { sold: p.reduce((s, r) => s + r.sold, 0), refunded: p.reduce((s, r) => s + r.refunded, 0), net: p.reduce((s, r) => s + r.net, 0) };
};

/** Bảng bán / hoàn / ròng theo hình thức thanh toán. */
export function PayTable({ rows, hideRefund }: { rows: PayRow[]; hideRefund?: boolean }) {
  const t = payTotals(rows);
  const zero = (n: number) => (n ? money(n) : <span className="muted">—</span>);
  return (
    <>
    <DataTable rows={rows} rowKey={(r) => r.method} cols={[
      { key: "m", label: "Hình thức", title: true, render: (r) => <>{PAY_LABEL[r.method] ?? r.method}{r.kind === "discount" && <> <Badge>giảm trừ</Badge></>}</> },
      { key: "s", label: "Bán", right: true, num: true, render: (r) => zero(r.sold) },
      ...(hideRefund ? [] : [{ key: "r", label: "Hoàn", right: true, num: true, render: (r: PayRow) => zero(r.refunded) }]),
      { key: "n", label: hideRefund ? "Số tiền" : "Ròng", right: true, num: true, render: (r) => <b>{zero(r.net)}</b> },
    ]} />
    <div className="kv-row" style={{ fontWeight: 700 }}><span>Tổng thu tiền <span className="muted small" style={{ fontWeight: 400 }}>(không gồm điểm, voucher)</span></span><span className="num">{money(hideRefund ? t.sold : t.net)}</span></div>
    </>
  );
}
