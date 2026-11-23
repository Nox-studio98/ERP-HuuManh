import { strToU8, zipSync } from "fflate";

/**
 * Writer XLSX tối thiểu (SpreadsheetML): chuỗi inline, số, tiền VND (#,##0), ngày (serial), header đậm,
 * độ rộng cột, đóng băng dòng tiêu đề, auto-filter. Dùng fflate.zipSync — chạy được trong Workers.
 */
export type ColType = "text" | "int" | "money" | "qty" | "date" | "datetime";

export interface XlsxColumn {
  header: string;
  type?: ColType;
  width?: number;
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: unknown[][];
  /** Chỉ số cột cần cộng ở dòng "Tổng cộng" cuối bảng. */
  totalCols?: number[];
}

// Chỉ số cellXfs trong styles.xml
const S = { default: 0, header: 1, money: 2, date: 3, datetime: 4, qty: 5, totalLabel: 6, totalMoney: 7, int: 8 } as const;

const VN_OFFSET_MS = 7 * 3600_000;
const EPOCH_1899 = Date.UTC(1899, 11, 30);

/** 'YYYY-MM-DD' → số ngày serial Excel. */
export const dateSerial = (ymd: string) => Math.round((Date.parse(ymd.slice(0, 10) + "T00:00:00Z") - EPOCH_1899) / 86400_000);
/** ISO UTC → serial theo giờ VN (có phần thập phân là giờ). */
export const datetimeSerial = (iso: string) => (Date.parse(iso) + VN_OFFSET_MS - EPOCH_1899) / 86400_000;

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Tên cột kiểu A, B, ..., AA. */
export function colRef(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cell(ref: string, v: unknown, type: ColType, forceStyle?: number): string {
  if (v === null || v === undefined || v === "") return "";
  const style = (n: number) => (forceStyle ?? n);
  if (type === "text") return `<c r="${ref}" t="inlineStr"${forceStyle ? ` s="${forceStyle}"` : ""}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
  let num: number;
  let s: number;
  if (type === "date") {
    if (typeof v === "number") num = v;
    else if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) num = dateSerial(String(v));
    else return `<c r="${ref}" t="inlineStr"><is><t>${esc(String(v))}</t></is></c>`;
    s = style(S.date);
  } else if (type === "datetime") {
    if (typeof v === "number") num = v;
    else if (!Number.isNaN(Date.parse(String(v)))) num = datetimeSerial(String(v));
    else return `<c r="${ref}" t="inlineStr"><is><t>${esc(String(v))}</t></is></c>`;
    s = style(S.datetime);
  } else {
    num = Number(v);
    if (!Number.isFinite(num)) return `<c r="${ref}" t="inlineStr"><is><t>${esc(String(v))}</t></is></c>`;
    s = style(type === "money" ? S.money : type === "qty" ? S.qty : S.int);
  }
  return `<c r="${ref}" s="${s}"><v>${num}</v></c>`;
}

function sheetXml(sh: XlsxSheet): string {
  const cols = sh.columns;
  const lastCol = colRef(Math.max(cols.length - 1, 0));
  const rowsXml: string[] = [];
  rowsXml.push(
    `<row r="1" ht="20" customHeight="1">${cols
      .map((c, i) => `<c r="${colRef(i)}1" s="${S.header}" t="inlineStr"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`)
      .join("")}</row>`,
  );
  sh.rows.forEach((row, ri) => {
    const r = ri + 2;
    rowsXml.push(`<row r="${r}">${cols.map((c, ci) => cell(`${colRef(ci)}${r}`, row[ci], c.type ?? "text")).join("")}</row>`);
  });
  let lastRow = sh.rows.length + 1;
  if (sh.totalCols?.length && sh.rows.length) {
    const r = lastRow + 1;
    const cells = cols.map((c, ci) => {
      const ref = `${colRef(ci)}${r}`;
      if (ci === 0) return `<c r="${ref}" s="${S.totalLabel}" t="inlineStr"><is><t>Tổng cộng</t></is></c>`;
      if (!sh.totalCols!.includes(ci)) return "";
      const sum = sh.rows.reduce((a, row) => a + (Number(row[ci]) || 0), 0);
      return `<c r="${ref}" s="${S.totalMoney}"><v>${sum}</v></c>`;
    });
    rowsXml.push(`<row r="${r}">${cells.join("")}</row>`);
    lastRow = r;
  }
  const colsXml = `<cols>${cols
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? defaultWidth(c)}" customWidth="1"/>`)
    .join("")}</cols>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${rowsXml.join("")}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${Math.max(sh.rows.length + 1, 1)}"/>` +
    `</worksheet>`
  );
}

function defaultWidth(c: XlsxColumn) {
  if (c.type === "money") return 16;
  if (c.type === "date") return 12;
  if (c.type === "datetime") return 18;
  if (c.type === "qty" || c.type === "int") return 12;
  return Math.min(Math.max(c.header.length + 4, 14), 40);
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="167" formatCode="#,##0.000"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function safeSheetName(n: string, used: Set<string>) {
  let s = n.replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let k = 2;
  while (used.has(s.toLowerCase())) s = s.slice(0, 28) + ` ${k++}`;
  used.add(s.toLowerCase());
  return s;
}

export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  if (!sheets.length) throw new Error("Cần ít nhất một sheet");
  const used = new Set<string>();
  const names = sheets.map((s) => safeSheetName(s.name, used));
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(STYLES),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
