import type { Env } from "../env";
import { fmtDate, fmtVnd } from "./pdf";
import { renderReportPdf, type PdfBlock } from "./report-pdf";
import { lineValue } from "./po";
import { vnDate } from "../lib/time";

const qtyText = (milli: number) => {
  const v = milli / 1000;
  return (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")).replace(".", ",");
};

/**
 * PDF đơn đặt hàng gửi NCC. Người xem không có prices.view_cost nhận bản không có đơn giá / thành tiền.
 * `lines`: kết quả poLines() (đã có product_name, factor...).
 */
export async function renderPoPdf(env: Env, po: any, lines: any[], showCost: boolean): Promise<Uint8Array> {
  const rows = lines.map((l, i) => {
    const qty = l.confirmed_qty_milli ?? l.qty_milli;
    const unitQty = `${qtyText(qty / (l.factor / 1000))} ${l.order_unit}`;
    const base = [String(i + 1), l.product_name, unitQty, `${qtyText(qty)} ${l.base_unit}`];
    if (!showCost) return base;
    const cost = l.confirmed_unit_cost ?? l.unit_cost;
    return [...base, cost == null ? "-" : fmtVnd(cost), cost == null ? "-" : fmtVnd(lineValue(qty, cost))];
  });
  const cols = showCost
    ? [{ header: "#", w: 0.6 }, { header: "Mặt hàng", w: 4 }, { header: "Số lượng đặt", w: 2, align: "right" as const }, { header: "Quy ra", w: 2, align: "right" as const }, { header: "Đơn giá / đv chính", w: 2, align: "right" as const }, { header: "Thành tiền", w: 2.2, align: "right" as const }]
    : [{ header: "#", w: 0.6 }, { header: "Mặt hàng", w: 5 }, { header: "Số lượng đặt", w: 2.5, align: "right" as const }, { header: "Quy ra", w: 2.5, align: "right" as const }];
  const blocks: PdfBlock[] = [
    { t: "kv", rows: [
      { label: "Nhà cung cấp", value: po.supplier_name, bold: true },
      ...(po.supplier_phone ? [{ label: "Điện thoại", value: po.supplier_phone }] : []),
      { label: "Ngày giao dự kiến", value: po.expected_date ? fmtDate(po.expected_date) : "Chưa xác định" },
    ] },
    { t: "table", cols, rows, ...(showCost ? { total: ["", "Tổng cộng", "", "", "", fmtVnd(po.total)] } : {}) },
  ];
  if (po.note) blocks.push({ t: "text", text: `Ghi chú: ${po.note}` });
  if (po.supplier_note) blocks.push({ t: "text", text: `Ghi chú của NCC: ${po.supplier_note}`, muted: true });
  return renderReportPdf(env, {
    title: "Đơn đặt hàng",
    code: po.code,
    subtitle: [`Ngày lập: ${fmtDate(vnDate(new Date(po.created_at)))}`, ...(po.status === "draft" ? ["Bản nháp — chưa gửi nhà cung cấp"] : [])],
    blocks,
  });
}
