import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Env } from "../env";
import { AppError, notFound } from "../lib/errors";

/**
 * PDF A4 (báo giá / hoá đơn nội bộ). Font Unicode tiếng Việt lấy từ R2 (không commit font vào repo):
 *   fonts/BeVietnamPro-Regular.ttf, fonts/BeVietnamPro-Bold.ttf  (OFL — tải từ Google Fonts rồi `wrangler r2 object put`).
 * Thiếu font → 501 pdf_font_missing.
 */
export const FONT_KEYS = { regular: "fonts/BeVietnamPro-Regular.ttf", bold: "fonts/BeVietnamPro-Bold.ttf" } as const;

const missingFont = (key: string) =>
  new AppError(501 as never, "pdf_font_missing", `Chưa tải font tiếng Việt lên R2 (${key}). Tải BeVietnamPro-Regular.ttf và BeVietnamPro-Bold.ttf vào thư mục fonts/ của bucket FILES.`);

async function loadFonts(env: Env, doc: PDFDocument) {
  const [r, b] = await Promise.all([env.FILES.get(FONT_KEYS.regular), env.FILES.get(FONT_KEYS.bold)]);
  if (!r) throw missingFont(FONT_KEYS.regular);
  if (!b) throw missingFont(FONT_KEYS.bold);
  doc.registerFontkit(fontkit);
  const [regular, bold] = await Promise.all([
    doc.embedFont(new Uint8Array(await r.arrayBuffer()), { subset: true }),
    doc.embedFont(new Uint8Array(await b.arrayBuffer()), { subset: true }),
  ]);
  return { regular, bold };
}

/** 1234567 → "1.234.567" */
export const fmtVnd = (n: number) => {
  const s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (n < 0 ? "-" : "") + s;
};
const fmtQty = (milli: number) => {
  const neg = milli < 0 ? "-" : "";
  const m = Math.abs(Math.round(milli));
  const frac = String(m % 1000).padStart(3, "0").replace(/0+$/, "");
  return neg + fmtVnd(Math.floor(m / 1000)) + (frac ? "," + frac : "");
};
const fmtDate = (ymd: string) => (/^\d{4}-\d{2}-\d{2}/.test(ymd) ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : ymd);

interface DocLine {
  name: string;
  unit: string;
  qtyMilli: number | null;
  unitPrice: number;
  amount: number | null;
}
interface DocData {
  title: string;
  code: string;
  metaLines: string[]; // dòng thông tin phía dưới tiêu đề (ngày, khách...)
  partyLines: string[];
  lines: DocLine[];
  totals: [string, number][];
  note?: string | null;
}

async function shopHeader(env: Env) {
  const s = await env.DB.prepare(`SELECT name, address FROM stores WHERE active=1 ORDER BY id LIMIT 1`).first<{ name: string; address: string | null }>();
  return { name: s?.name ?? "Hữu Mạnh - Trái cây", address: s?.address ?? "" };
}

/** Hiển thị số lượng/đơn giá theo đúng đơn vị đã bán (quy đổi từ đơn vị chính nếu cần). */
async function displayFactor(env: Env, productId: number | null, unit: string): Promise<number> {
  if (!productId) return 1000;
  const r = await env.DB.prepare(`SELECT factor_milli f FROM product_units WHERE product_id=? AND unit=?`).bind(productId, unit).first<{ f: number }>();
  return r?.f ?? 1000;
}

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const w of para.split(/\s+/)) {
      const t = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW) cur = t;
      else {
        if (cur) out.push(cur);
        cur = w;
      }
    }
    out.push(cur);
  }
  return out;
}

async function render(env: Env, d: DocData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { regular, bold } = await loadFonts(env, pdf);
  const shop = await shopHeader(env);
  pdf.setTitle(`${d.title} ${d.code}`);
  pdf.setProducer("Hữu Mạnh ERP");
  const W = 595.28, H = 841.89, M = 40;
  const ink = rgb(0.1, 0.1, 0.12), muted = rgb(0.4, 0.42, 0.46), line = rgb(0.8, 0.82, 0.85);
  // Cột: STT | Tên hàng | ĐVT | SL | Đơn giá | Thành tiền
  const colW = [28, 205, 45, 60, 80, 97];
  const colX: number[] = [];
  colW.reduce((x, w, i) => ((colX[i] = x), x + w), M);
  const right = (page: PDFPage, text: string, xRight: number, y: number, font: PDFFont, size: number) =>
    page.drawText(text, { x: xRight - font.widthOfTextAtSize(text, size), y, size, font, color: ink });

  let page = pdf.addPage([W, H]);
  let y = H - M;
  page.drawText(shop.name, { x: M, y: y - 12, size: 14, font: bold, color: ink });
  y -= 28;
  if (shop.address) {
    page.drawText(shop.address, { x: M, y, size: 9, font: regular, color: muted });
    y -= 14;
  }
  y -= 8;
  page.drawText(d.title.toUpperCase(), { x: M, y: y - 14, size: 17, font: bold, color: ink });
  y -= 32;
  for (const m of [`Số: ${d.code}`, ...d.metaLines, ...d.partyLines]) {
    for (const l of wrap(m, regular, 10, W - 2 * M)) {
      page.drawText(l, { x: M, y, size: 10, font: regular, color: ink });
      y -= 14;
    }
  }
  y -= 8;

  const header = (p: PDFPage, yy: number) => {
    p.drawRectangle({ x: M, y: yy - 4, width: W - 2 * M, height: 18, color: rgb(0.92, 0.94, 0.96) });
    const h = ["STT", "Tên hàng", "ĐVT", "SL", "Đơn giá", "Thành tiền"];
    h.forEach((t, i) => {
      if (i >= 3) right(p, t, colX[i] + colW[i] - 4, yy, bold, 9.5);
      else p.drawText(t, { x: colX[i] + 4, y: yy, size: 9.5, font: bold, color: ink });
    });
    return yy - 20;
  };
  y = header(page, y);

  d.lines.forEach((l, i) => {
    const nameLines = wrap(l.name, regular, 9.5, colW[1] - 8);
    const h = nameLines.length * 12 + 6;
    if (y - h < M + 80) {
      page = pdf.addPage([W, H]);
      y = header(page, H - M);
    }
    page.drawText(String(i + 1), { x: colX[0] + 4, y, size: 9.5, font: regular, color: ink });
    nameLines.forEach((t, k) => page.drawText(t, { x: colX[1] + 4, y: y - k * 12, size: 9.5, font: regular, color: ink }));
    page.drawText(l.unit, { x: colX[2] + 4, y, size: 9.5, font: regular, color: ink });
    right(page, l.qtyMilli == null ? "-" : fmtQty(l.qtyMilli), colX[3] + colW[3] - 4, y, regular, 9.5);
    right(page, fmtVnd(l.unitPrice), colX[4] + colW[4] - 4, y, regular, 9.5);
    right(page, l.amount == null ? "-" : fmtVnd(l.amount), colX[5] + colW[5] - 4, y, regular, 9.5);
    y -= h;
    page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.5, color: line });
  });

  if (y < M + 20 + d.totals.length * 16) {
    page = pdf.addPage([W, H]);
    y = H - M;
  }
  y -= 8;
  d.totals.forEach(([label, v], i) => {
    const f = i === d.totals.length - 1 ? bold : regular;
    const size = i === d.totals.length - 1 ? 11 : 10;
    page.drawText(label, { x: colX[4] - 40, y, size, font: f, color: ink });
    right(page, `${fmtVnd(v)} đ`, W - M - 4, y, f, size);
    y -= 16;
  });
  if (d.note) {
    y -= 8;
    for (const l of wrap(`Ghi chú: ${d.note}`, regular, 9.5, W - 2 * M)) {
      if (y < M) {
        page = pdf.addPage([W, H]);
        y = H - M;
      }
      page.drawText(l, { x: M, y, size: 9.5, font: regular, color: muted });
      y -= 13;
    }
  }
  const pages = pdf.getPages();
  pages.forEach((p, i) => p.drawText(`Trang ${i + 1}/${pages.length}`, { x: W - M - 50, y: 22, size: 8, font: regular, color: muted }));
  return pdf.save();
}

export async function renderQuotePdf(env: Env, quoteId: number): Promise<Uint8Array> {
  const q = await env.DB
    .prepare(
      `SELECT q.*, c.name AS customer_name, c.code AS customer_code, c.tax_code, c.phone, c.billing_address
         FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.id = ?`,
    )
    .bind(quoteId)
    .first<any>();
  if (!q) throw notFound("quote_not_found", "Không tìm thấy báo giá");
  const { results } = await env.DB
    .prepare(`SELECT ql.*, p.name AS product_name FROM quote_lines ql JOIN products p ON p.id = ql.product_id WHERE ql.quote_id = ? ORDER BY ql.id`)
    .bind(quoteId)
    .all<any>();
  const lines: DocLine[] = [];
  for (const l of results) {
    const f = await displayFactor(env, l.product_id, l.unit);
    const unitPrice = Math.round((l.unit_price * f) / 1000);
    const qtyMilli = l.qty_milli == null ? null : Math.round((l.qty_milli * 1000) / f);
    lines.push({ name: l.product_name + (l.note ? ` (${l.note})` : ""), unit: l.unit, qtyMilli, unitPrice, amount: l.qty_milli == null ? null : Math.round((l.unit_price * l.qty_milli) / 1000) });
  }
  return render(env, {
    title: "Báo giá",
    code: q.code,
    metaLines: [`Ngày: ${fmtDate(q.valid_from)}   Hiệu lực đến: ${fmtDate(q.valid_until)}`],
    partyLines: [`Khách hàng: ${q.customer_name} (${q.customer_code})`, ...(q.tax_code ? [`MST: ${q.tax_code}`] : []), ...(q.billing_address ? [`Địa chỉ: ${q.billing_address}`] : [])],
    lines,
    totals: [["Cộng tiền hàng", q.subtotal]],
    note: q.note,
  });
}

export async function renderInvoicePdf(env: Env, invoiceId: number): Promise<Uint8Array> {
  const i = await env.DB
    .prepare(`SELECT i.*, c.name AS customer_name, c.code AS customer_code FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`)
    .bind(invoiceId)
    .first<any>();
  if (!i) throw notFound("invoice_not_found", "Không tìm thấy hoá đơn");
  const { results } = await env.DB.prepare(`SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id`).bind(invoiceId).all<any>();
  const lines: DocLine[] = [];
  for (const l of results) {
    const f = await displayFactor(env, l.product_id, l.unit);
    lines.push({ name: l.description, unit: l.unit, qtyMilli: Math.round((l.qty_milli * 1000) / f), unitPrice: Math.round((l.unit_price * f) / 1000), amount: l.amount });
  }
  const buyer = i.buyer_name ?? i.customer_name;
  const kindLabel = i.kind === "adjustment" ? "Hoá đơn điều chỉnh" : i.kind === "replacement" ? "Hoá đơn thay thế" : "Hoá đơn bán hàng";
  return render(env, {
    title: kindLabel,
    code: i.code,
    metaLines: [
      `Ngày lập: ${fmtDate(i.issue_date)}   Hạn thanh toán: ${fmtDate(i.due_date)}`,
      ...(i.einvoice_no ? [`HĐĐT: ${i.einvoice_series ?? ""} ${i.einvoice_no}${i.einvoice_lookup_code ? `   Mã tra cứu: ${i.einvoice_lookup_code}` : ""}`] : ["(Bản thể hiện nội bộ, không thay thế hoá đơn điện tử)"]),
    ],
    partyLines: [`Khách hàng: ${buyer ?? "Khách lẻ"}`, ...(i.buyer_tax_code ? [`MST: ${i.buyer_tax_code}`] : []), ...(i.buyer_address ? [`Địa chỉ: ${i.buyer_address}`] : [])],
    lines,
    totals: [
      ["Cộng tiền hàng", i.subtotal],
      ...(i.vat_amount ? ([[`Thuế GTGT (${i.vat_rate_bp / 100}%)`, i.vat_amount]] as [string, number][]) : []),
      ["Tổng thanh toán", i.total],
    ],
    note: i.note,
  });
}
