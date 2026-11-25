import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Env } from "../env";
import { fmtDate, fmtVnd, loadFonts, shopHeader, wrap } from "./pdf";
import { vnDate } from "../lib/time";
import type { PayslipLine } from "./payroll-calc";

/**
 * C-28: PDF cho báo cáo (lãi lỗ, tuổi nợ), bảng lương kỳ và phiếu lương. Dùng chung font BeVietnamPro trên R2 với báo giá/hoá đơn (services/pdf.ts).
 * Bộ dựng nhỏ theo khối: tiêu đề → các khối (bảng, cặp nhãn/giá trị, đoạn chữ), tự ngắt trang, lặp dòng tiêu đề bảng.
 * Phân quyền do route quyết định TRƯỚC khi gọi các hàm render ở đây (dữ liệu truyền vào đã là dữ liệu người dùng được xem).
 */

export interface PdfCol { header: string; w: number; align?: "left" | "right" }
export type PdfBlock =
  | { t: "heading"; text: string }
  | { t: "kv"; rows: { label: string; value: string; bold?: boolean; indent?: number; muted?: boolean }[] }
  | { t: "table"; cols: PdfCol[]; rows: string[][]; total?: string[]; size?: number }
  | { t: "text"; text: string; muted?: boolean };
export interface PdfReport { title: string; code?: string; subtitle: string[]; landscape?: boolean; blocks: PdfBlock[] }

const ink = rgb(0.1, 0.1, 0.12), muted = rgb(0.4, 0.42, 0.46), hair = rgb(0.8, 0.82, 0.85), tint = rgb(0.92, 0.94, 0.96);

/** Font BeVietnamPro không có một số ký hiệu (→, ≤, ≥, −...): đổi sang ký tự thường để không bị khoảng trống. */
const clean = <T,>(v: T): T =>
  typeof v === "string" ? (v.replaceAll("→", "thành").replaceAll("≤", "<=").replaceAll("≥", ">=").replaceAll("−", "-").replaceAll("÷", "/") as T)
  : Array.isArray(v) ? (v.map(clean) as T)
  : v && typeof v === "object" ? (Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) as T)
  : v;

export async function renderReportPdf(env: Env, report: PdfReport): Promise<Uint8Array> {
  const r = clean(report);
  const pdf = await PDFDocument.create();
  const { regular, bold } = await loadFonts(env, pdf);
  const shop = await shopHeader(env);
  pdf.setTitle(r.title + (r.code ? ` ${r.code}` : ""));
  pdf.setProducer("Hữu Mạnh ERP");
  const [W, H] = r.landscape ? [841.89, 595.28] : [595.28, 841.89];
  const M = 40, CW = W - 2 * M;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - M;
  const txt = (p: PDFPage, t: string, x: number, yy: number, f: PDFFont, size: number, color = ink) => p.drawText(t, { x, y: yy, size, font: f, color });
  const rtxt = (p: PDFPage, t: string, xr: number, yy: number, f: PDFFont, size: number, color = ink) => txt(p, t, xr - f.widthOfTextAtSize(t, size), yy, f, size, color);
  const ensure = (h: number) => {
    if (y - h < M + 14) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };

  txt(page, shop.name, M, y - 12, bold, 13);
  y -= 26;
  if (shop.address) { txt(page, shop.address, M, y, regular, 9, muted); y -= 14; }
  y -= 6;
  txt(page, r.title.toUpperCase(), M, y - 14, bold, 16);
  y -= 30;
  for (const m of [...(r.code ? [`Số: ${r.code}`] : []), ...r.subtitle]) {
    for (const l of wrap(m, regular, 10, CW)) { txt(page, l, M, y, regular, 10); y -= 14; }
  }
  y -= 6;

  for (const b of r.blocks) {
    if (b.t === "heading") {
      ensure(34);
      y -= 8;
      txt(page, b.text, M, y, bold, 11.5);
      y -= 6;
      page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: ink });
      y -= 16;
    } else if (b.t === "text") {
      for (const l of wrap(b.text, regular, 9.5, CW)) { ensure(14); txt(page, l, M, y, regular, 9.5, b.muted ? muted : ink); y -= 13; }
      y -= 4;
    } else if (b.t === "kv") {
      for (const k of b.rows) {
        const f = k.bold ? bold : regular;
        const indent = (k.indent ?? 0) * 14;
        const lines = wrap(k.label, f, 10, CW - 130 - indent);
        ensure(lines.length * 14 + 4);
        lines.forEach((l, i) => txt(page, l, M + indent, y - i * 14, f, 10, k.muted ? muted : ink));
        rtxt(page, k.value, W - M - 4, y, f, 10, k.muted ? muted : ink);
        y -= lines.length * 14;
        if (k.bold) page.drawLine({ start: { x: M, y: y + 10 }, end: { x: W - M, y: y + 10 }, thickness: 0.4, color: hair });
        y -= 4;
      }
    } else {
      const size = b.size ?? 9;
      const sum = b.cols.reduce((a, c) => a + c.w, 0);
      const cw = b.cols.map((c) => (c.w / sum) * CW);
      const cx: number[] = [];
      cw.reduce((x, w, i) => ((cx[i] = x), x + w), M);
      const head = () => {
        // Tiêu đề cột có thể dài: ngắt dòng theo độ rộng cột, ô nền cao đủ
        const hl = b.cols.map((c, i) => wrap(c.header, bold, size, cw[i] - 8));
        const n = Math.max(...hl.map((x) => x.length));
        const h = n * (size + 3) + 6;
        ensure(h + 30);
        page.drawRectangle({ x: M, y: y - h + (size + 3), width: CW, height: h, color: tint });
        b.cols.forEach((c, i) =>
          hl[i].forEach((l, k) => (c.align === "right" ? rtxt(page, l, cx[i] + cw[i] - 4, y - k * (size + 3), bold, size) : txt(page, l, cx[i] + 4, y - k * (size + 3), bold, size))),
        );
        y -= h + 2;
      };
      head();
      const drawRow = (row: string[], f: PDFFont) => {
        const cells = row.map((v, i) => (b.cols[i].align === "right" ? [v] : wrap(v, f, size, cw[i] - 8)));
        const n = Math.max(...cells.map((x) => x.length));
        const h = n * (size + 3) + 5;
        if (y - h < M + 14) { page = pdf.addPage([W, H]); y = H - M; head(); }
        cells.forEach((ls, i) =>
          ls.forEach((l, k) => (b.cols[i].align === "right" ? rtxt(page, l, cx[i] + cw[i] - 4, y - k * (size + 3), f, size) : txt(page, l, cx[i] + 4, y - k * (size + 3), f, size))),
        );
        y -= h;
        page.drawLine({ start: { x: M, y: y + size + 1 }, end: { x: W - M, y: y + size + 1 }, thickness: 0.4, color: hair });
      };
      if (!b.rows.length) { ensure(20); txt(page, "Không có dữ liệu.", M + 4, y, regular, size, muted); y -= 18; }
      for (const row of b.rows) drawRow(row, regular);
      if (b.total) drawRow(b.total, bold);
      y -= 6;
    }
  }

  const stamp = `Xuất ngày ${fmtDate(vnDate())} ${new Date(Date.now() + 7 * 3600_000).toISOString().slice(11, 16)}`;
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    txt(p, stamp, M, 22, regular, 8, muted);
    rtxt(p, `Trang ${i + 1}/${pages.length}`, W - M, 22, regular, 8, muted);
  });
  return pdf.save();
}

// ---------------------------------------------------------------- báo cáo lãi lỗ
const EXP_NAMES: Record<string, string> = {
  opex: "Chi phí vận hành", payroll: "Lương", shrinkage: "Hao hụt", other: "Chi khác", badDebt: "Xoá nợ khó đòi",
  stockCount: "Chênh lệch kiểm kê", purchaseVariance: "Chênh lệch giá mua",
};
const money = (n: number) => fmtVnd(n);
const GROUP_NAMES: Record<string, string> = { day: "ngày", channel: "kênh bán", group: "nhóm hàng" };

export async function renderPnlPdf(env: Env, p: any): Promise<Uint8Array> {
  const exp = Object.entries(p.expenses as Record<string, number>).filter(([, v]) => v);
  const oi = p.otherIncome ?? {};
  const oiRows = ([["forfeitedDeposits", "Cọc không hoàn"], ["payableDiscounts", "Chiết khấu nhà cung cấp"], ["settlementSurplus", "Chênh lệch đối soát thừa"], ["otherReceipts", "Thu khác"]] as const)
    .filter(([k]) => oi[k]);
  const blocks: PdfBlock[] = [
    { t: "heading", text: "Kết quả kinh doanh" },
    { t: "kv", rows: [
      { label: "Doanh thu bán hàng", value: money(p.salesTotal) },
      { label: "Trừ: hàng trả lại", value: money(-p.returnsTotal), indent: 1, muted: true },
      { label: "Doanh thu thuần", value: money(p.revenue), bold: true },
      { label: "Giá vốn hàng bán", value: money(p.cogs) },
      { label: "Lợi nhuận gộp", value: money(p.grossProfit), bold: true },
      ...(p.revenueDeductions?.paymentDiscount ? [{ label: "Chiết khấu thanh toán", value: money(p.revenueDeductions.paymentDiscount) }] : []),
    ] },
    { t: "heading", text: "Chi phí" },
    { t: "kv", rows: [
      ...exp.map(([k, v]) => ({ label: EXP_NAMES[k] ?? k, value: money(v as number), indent: 1 })),
      { label: "Tổng chi phí", value: money(p.totalExpenses), bold: true },
    ] },
    ...(oi.total ? [{ t: "heading", text: "Thu nhập khác" } as PdfBlock, { t: "kv", rows: [...oiRows.map(([k, l]) => ({ label: l, value: money(oi[k]), indent: 1 })), { label: "Tổng thu nhập khác", value: money(oi.total), bold: true }] } as PdfBlock] : []),
    { t: "kv", rows: [{ label: p.netProfit < 0 ? "LỖ RÒNG" : "LỢI NHUẬN RÒNG", value: `${money(p.netProfit)} đ`, bold: true }] },
  ];
  if (p.breakdown?.length) {
    blocks.push({ t: "heading", text: `Chi tiết theo ${GROUP_NAMES[p.groupBy] ?? p.groupBy}` });
    blocks.push({
      t: "table",
      cols: [{ header: "Mục", w: 3 }, { header: "Doanh thu", w: 2, align: "right" }, { header: "Giá vốn", w: 2, align: "right" }, { header: "Lợi nhuận gộp", w: 2, align: "right" }],
      rows: p.breakdown.map((b: any) => [p.groupBy === "day" ? fmtDate(b.key) : String(b.key ?? ""), money(b.revenue), money(b.cogs), money(b.grossProfit)]),
    });
  }
  return renderReportPdf(env, {
    title: "Báo cáo kết quả kinh doanh (lãi lỗ)",
    subtitle: [`Từ ngày ${fmtDate(p.from)} đến ngày ${fmtDate(p.to)}`, "Đơn vị tính: đồng (VND)"],
    blocks,
  });
}

// ---------------------------------------------------------------- tuổi nợ
const BUCKET_LABEL = (b: [number, number, number]) => ({
  current: "Chưa đến hạn", d1_30: `Quá hạn 1–${b[0]} ngày`, d31_60: `Quá hạn ${b[0] + 1}–${b[1]} ngày`, d61_90: `Quá hạn ${b[1] + 1}–${b[2]} ngày`, over90: `Quá hạn trên ${b[2]} ngày`,
}) as Record<string, string>;

export async function renderAgingPdf(env: Env, a: { side: string; asOf: string; items: any[]; totals: Record<string, number>; bounds: [number, number, number] }): Promise<Uint8Array> {
  const labels = BUCKET_LABEL(a.bounds);
  const recv = a.side === "receivable";
  const total = Object.values(a.totals).reduce((s, x) => s + x, 0);
  const byPartner = new Map<string, Record<string, number>>();
  for (const i of a.items) {
    const rec = byPartner.get(i.partnerName) ?? { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 };
    rec[i.bucket] += i.outstanding;
    byPartner.set(i.partnerName, rec);
  }
  const keys = ["current", "d1_30", "d31_60", "d61_90", "over90"];
  return renderReportPdf(env, {
    title: recv ? "Báo cáo tuổi nợ phải thu" : "Báo cáo tuổi nợ phải trả",
    landscape: true,
    subtitle: [`Tính đến ngày ${fmtDate(a.asOf)}`, "Đơn vị tính: đồng (VND)"],
    blocks: [
      { t: "heading", text: "Tổng hợp theo nhóm tuổi nợ" },
      { t: "kv", rows: [...keys.map((k) => ({ label: labels[k], value: money(a.totals[k] ?? 0), indent: 1 })), { label: "Tổng còn nợ", value: money(total), bold: true }] },
      { t: "heading", text: recv ? "Theo khách hàng" : "Theo nhà cung cấp" },
      {
        t: "table",
        cols: [{ header: recv ? "Khách hàng" : "Nhà cung cấp", w: 3.2 }, ...keys.map((k) => ({ header: labels[k], w: 1.6, align: "right" as const })), { header: "Tổng", w: 1.8, align: "right" as const }],
        rows: [...byPartner].sort((x, y) => Object.values(y[1]).reduce((s, v) => s + v, 0) - Object.values(x[1]).reduce((s, v) => s + v, 0))
          .map(([n, r]) => [n || "Khách lẻ", ...keys.map((k) => (r[k] ? money(r[k]) : "")), money(Object.values(r).reduce((s, v) => s + v, 0))]),
        total: ["Cộng", ...keys.map((k) => money(a.totals[k] ?? 0)), money(total)],
      },
      { t: "heading", text: "Chi tiết theo chứng từ" },
      {
        t: "table", size: 8.5,
        cols: [{ header: recv ? "Khách hàng" : "Nhà cung cấp", w: 3 }, { header: "Chứng từ", w: 2 }, { header: "Ngày", w: 1.4 }, { header: "Hạn", w: 1.4 }, { header: "Quá hạn (ngày)", w: 1.2, align: "right" }, { header: "Giá trị", w: 1.6, align: "right" }, { header: "Còn nợ", w: 1.6, align: "right" }, { header: "Nhóm", w: 2.4 }],
        rows: [...a.items].sort((x, y) => y.overdueDays - x.overdueDays)
          .map((i) => [i.partnerName || "Khách lẻ", i.docCode, fmtDate(i.issueDate), fmtDate(i.dueDate), String(i.overdueDays), money(i.total), money(i.outstanding), labels[i.bucket]]),
      },
    ],
  });
}

// ---------------------------------------------------------------- lương
const PAY_TYPE: Record<string, string> = { monthly: "Theo tháng", hourly: "Theo giờ", shift: "Theo ca" };
const STATUS: Record<string, string> = { draft: "Nháp", calculated: "Đã tính (chưa duyệt)", approved: "Đã duyệt", paid: "Đã chi" };
const periodLabel = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;

export async function renderPayrollPdf(env: Env, d: { period: string; status: string; totals: any; items: any[] }): Promise<Uint8Array> {
  const cols: PdfCol[] = [
    { header: "Mã NV", w: 1.1 }, { header: "Họ tên", w: 2.6 }, { header: "Hình thức", w: 1.3 }, { header: "Công (giờ/ngày)", w: 1.2, align: "right" },
    { header: "Lương cơ bản", w: 1.5, align: "right" }, { header: "Phụ cấp", w: 1.3, align: "right" }, { header: "Tăng ca", w: 1.3, align: "right" }, { header: "Thưởng, phạt, điều chỉnh", w: 1.6, align: "right" },
    { header: "Tổng thu nhập", w: 1.6, align: "right" }, { header: "Bảo hiểm", w: 1.3, align: "right" }, { header: "Thuế TNCN", w: 1.2, align: "right" }, { header: "Tạm ứng", w: 1.2, align: "right" }, { header: "Thực lĩnh", w: 1.6, align: "right" },
  ];
  const sum = (f: (i: any) => number) => d.items.reduce((s, i) => s + f(i), 0);
  const bonus = (i: any) => i.bonus + i.salesBonus + i.adjustments - i.penalties;
  const work = (i: any) => (i.payType === "hourly" ? `${(i.workedMinutes / 60).toFixed(1)} giờ` : i.payType === "shift" ? `${i.shifts} ca` : `${i.paidDaysX10 / 10} ngày`);
  return renderReportPdf(env, {
    title: `Bảng lương tháng ${periodLabel(d.period)}`,
    landscape: true,
    subtitle: [`Trạng thái: ${STATUS[d.status] ?? d.status}   —   ${d.items.length} nhân viên`, "Đơn vị tính: đồng (VND). Tài liệu mật, chỉ dùng nội bộ."],
    blocks: [
      { t: "table", size: 8, cols,
        rows: d.items.map((i) => [i.code, i.name, PAY_TYPE[i.payType] ?? i.payType, work(i), money(i.basePay), money(i.allowances), money(i.overtimePay), money(bonus(i)), money(i.gross), money(i.insuranceEmployee), money(i.pit), money(i.advances), money(i.net)]),
        total: ["", "Cộng", "", "", money(sum((i) => i.basePay)), money(sum((i) => i.allowances)), money(sum((i) => i.overtimePay)), money(sum(bonus)), money(d.totals.gross), money(d.totals.insuranceEmployee), money(d.totals.pit), money(sum((i) => i.advances)), money(d.totals.net)] },
      { t: "kv", rows: [
        { label: "Bảo hiểm doanh nghiệp đóng", value: money(d.totals.insuranceEmployer), muted: true },
        { label: "Tổng chi phí lương của cửa hàng", value: `${money(d.totals.cost)} đ`, bold: true },
      ] },
    ],
  });
}

export async function renderPayslipPdf(env: Env, s: { period: string; status: string; employee: { code: string; name: string; position: string | null }; item: any }): Promise<Uint8Array> {
  const i = s.item;
  const lines: PayslipLine[] = i.lines ?? [];
  const income = lines.filter((l) => l.group === "income");
  const deduct = lines.filter((l) => l.group === "deduction");
  const info = lines.filter((l) => l.group === "info");
  const row = (l: PayslipLine) => ({ label: l.note ? `${l.label} (${l.note})` : l.label, value: money(l.amount), indent: 1 });
  const blocks: PdfBlock[] = [
    { t: "kv", rows: [
      { label: "Nhân viên", value: `${s.employee.name} (${s.employee.code})`, bold: true },
      ...(s.employee.position ? [{ label: "Vị trí", value: s.employee.position }] : []),
      { label: "Hình thức trả lương", value: PAY_TYPE[i.payType] ?? i.payType },
      { label: "Giờ công / số ca", value: `${(i.workedMinutes / 60).toFixed(1)} giờ, ${i.shifts} ca, ${i.paidDaysX10 / 10} ngày hưởng lương` },
    ] },
    { t: "heading", text: "Thu nhập" },
    { t: "kv", rows: [
      ...(income.length ? income.map(row) : [
        { label: "Lương cơ bản", value: money(i.basePay), indent: 1 }, { label: "Phụ cấp", value: money(i.allowances), indent: 1 }, { label: "Tăng ca", value: money(i.overtimePay), indent: 1 },
        { label: "Thưởng", value: money(i.bonus + i.salesBonus), indent: 1 }, { label: "Phạt", value: money(-i.penalties), indent: 1 }, { label: "Điều chỉnh", value: money(i.adjustments), indent: 1 },
      ]),
      { label: "Tổng thu nhập", value: money(i.gross), bold: true },
    ] },
    { t: "heading", text: "Khấu trừ" },
    { t: "kv", rows: [
      { label: "Bảo hiểm người lao động", value: money(-i.insuranceEmployee), indent: 1 },
      { label: `Thuế thu nhập cá nhân (thu nhập tính thuế ${money(i.taxableIncome)})`, value: money(-i.pit), indent: 1 },
      { label: "Tạm ứng khấu trừ kỳ này", value: money(-i.advances), indent: 1 },
      ...deduct.filter((l) => !/bảo hiểm|thuế|tạm ứng/i.test(l.label)).map(row),
    ] },
    { t: "kv", rows: [{ label: "THỰC LĨNH", value: `${money(i.net)} đ`, bold: true }] },
  ];
  if (i.advancesCarried) blocks.push({ t: "text", text: `Tạm ứng chuyển sang kỳ sau: ${money(i.advancesCarried)} đ`, muted: true });
  const infoText = info.filter((l) => l.note).map((l) => `${l.label}: ${l.note}`);
  if (infoText.length) blocks.push({ t: "text", text: infoText.join("\n"), muted: true });
  if (s.status !== "approved" && s.status !== "paid") blocks.push({ t: "text", text: "Bản tham khảo: kỳ lương chưa được duyệt, số liệu có thể thay đổi.", muted: true });
  return renderReportPdf(env, {
    title: `Phiếu lương tháng ${periodLabel(s.period)}`,
    code: `${s.employee.code}-${s.period}`,
    subtitle: [`Trạng thái kỳ lương: ${STATUS[s.status] ?? s.status}`, "Đơn vị tính: đồng (VND). Tài liệu mật của nhân viên."],
    blocks,
  });
}
