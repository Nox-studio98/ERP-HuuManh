import { unzipSync, strFromU8 } from "fflate";
import { AppError } from "../lib/errors";

/**
 * Đọc file nhập liệu (.xlsx hoặc .csv UTF-8) thành bảng chuỗi. Không bao giờ thực thi/tính công thức:
 * ô công thức trong xlsx được ĐÁNH DẤU (`formulas`) để bước kiểm tra báo lỗi — chống chèn công thức.
 */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 1000;
const MAX_COLS = 40;
const MAX_UNZIPPED = 25 * 1024 * 1024;

export interface ParsedSheet {
  /** Dòng đầu tiên không rỗng là tiêu đề; các dòng sau là dữ liệu. rows[i].line = số dòng trong file gốc (1-based). */
  header: string[];
  rows: { line: number; cells: string[] }[];
  /** Tập "dòng:cột" (cột 0-based theo header) có công thức. */
  formulas: Set<string>;
  format: "xlsx" | "csv";
}

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    const n = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
  });

/** Nối nội dung các thẻ <t> trong một đoạn XML (chuỗi chung hoặc inlineStr, kể cả rich text). */
const textOf = (xml: string) => {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeEntities(m[1]);
  return out;
};

const colIndex = (ref: string) => {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function numText(v: string): string {
  // số thực/số mũ do Excel ghi (vd 8.93456E+12) → chuỗi số nguyên nếu là số nguyên an toàn
  if (/e/i.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return String(n);
  }
  return v;
}

function parseXlsx(bytes: Uint8Array): ParsedSheet {
  let files: Record<string, Uint8Array>;
  try {
    let total = 0;
    files = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new Error("zip_too_big");
        return /^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/.test(f.name);
      },
    });
  } catch (e) {
    if ((e as Error).message === "zip_too_big") throw new AppError(422, "file_too_large", "File Excel giải nén quá lớn");
    throw new AppError(422, "bad_file", "Không đọc được file Excel (.xlsx). Hãy dùng file mẫu hoặc lưu lại dạng .xlsx");
  }
  // Chọn sheet đầu tiên theo workbook.xml (nếu có), không thì sheet1
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  const firstRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (firstRid && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (new RegExp(`\\bId="${firstRid}"`).test(tag)) {
        const t = /\bTarget="([^"]+)"/.exec(tag)?.[1];
        if (t) sheetPath = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
      }
    }
  }
  const sheetBytes = files[sheetPath] ?? Object.entries(files).find(([k]) => k.startsWith("xl/worksheets/"))?.[1];
  if (!sheetBytes) throw new AppError(422, "bad_file", "File Excel không có trang tính nào");
  const shared: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    for (const m of strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  }
  const xml = strFromU8(sheetBytes);
  const grid: { line: number; cells: string[]; formulaCols: number[] }[] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const line = Number(/\br="(\d+)"/.exec(rm[1])?.[1] ?? grid.length + 1);
    const cells: string[] = [];
    const formulaCols: number[] = [];
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const idx = ref ? colIndex(ref) : cells.length;
      if (idx < 0 || idx >= MAX_COLS) continue;
      const t = /\bt="(\w+)"/.exec(attrs)?.[1] ?? "n";
      const body = cm[2] ?? "";
      let val = "";
      if (t === "s") val = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? "";
      else if (t === "inlineStr") val = textOf(body);
      else if (t === "b") val = /<v>1<\/v>/.test(body) ? "1" : "0";
      else if (t === "e") val = "";
      else val = numText(decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ""));
      if (/<f\b/.test(body)) formulaCols.push(idx);
      while (cells.length <= idx) cells.push("");
      cells[idx] = val;
    }
    grid.push({ line, cells, formulaCols });
  }
  return finish(grid, "xlsx");
}

function parseCsv(bytes: Uint8Array): ParsedSheet {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError(422, "bad_encoding", "File CSV phải lưu dạng UTF-8 (Excel: Lưu thành → CSV UTF-8)");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [[",", 0], [";", 0], ["\t", 0]];
  for (const ch of firstLine) for (const c of counts) if (ch === c[0]) c[1]++;
  const delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ",";
  const grid: { line: number; cells: string[]; formulaCols: number[] }[] = [];
  let row: string[] = [], cur = "", inQ = false, line = 1, rowLine = 1, any = false;
  const endCell = () => { row.push(cur); cur = ""; };
  const endRow = () => {
    endCell();
    if (any || row.some((x) => x !== "")) grid.push({ line: rowLine, cells: row.slice(0, MAX_COLS), formulaCols: [] });
    row = []; any = false; rowLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else { if (ch === "\n") line++; cur += ch; }
    } else if (ch === '"') { inQ = true; any = true; }
    else if (ch === delim) { endCell(); any = true; }
    else if (ch === "\n") { line++; endRow(); }
    else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) endRow();
  return finish(grid, "csv");
}

function finish(grid: { line: number; cells: string[]; formulaCols: number[] }[], format: "xlsx" | "csv"): ParsedSheet {
  const nonEmpty = grid.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) throw new AppError(422, "empty_file", "File không có dữ liệu");
  const [head, ...rest] = nonEmpty;
  if (rest.length > IMPORT_MAX_ROWS) throw new AppError(422, "too_many_rows", `File có ${rest.length} dòng dữ liệu, tối đa ${IMPORT_MAX_ROWS} dòng mỗi lần — hãy chia nhỏ file`);
  const formulas = new Set<string>();
  for (const r of rest) for (const c of r.formulaCols) formulas.add(`${r.line}:${c}`);
  return { header: head.cells.map((c) => c.trim()), rows: rest.map((r) => ({ line: r.line, cells: r.cells })), formulas, format };
}

/** Nhận diện theo nội dung (PK = zip/xlsx) rồi theo đuôi; ném 422 nếu file quá lớn / sai định dạng. */
export function parseImportFile(bytes: Uint8Array, filename: string): ParsedSheet {
  if (bytes.length > IMPORT_MAX_BYTES) throw new AppError(422, "file_too_large", `File quá lớn (tối đa ${IMPORT_MAX_BYTES / 1024 / 1024}MB)`);
  if (!bytes.length) throw new AppError(422, "empty_file", "File rỗng");
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const name = filename.toLowerCase();
  if (isZip) return parseXlsx(bytes);
  if (name.endsWith(".xlsx")) throw new AppError(422, "bad_file", "File không phải Excel .xlsx hợp lệ");
  if (name.endsWith(".xls")) throw new AppError(422, "bad_file", "Chưa đọc được file .xls cũ — hãy lưu lại thành .xlsx hoặc .csv");
  if (!name.endsWith(".csv") && !name.endsWith(".txt")) throw new AppError(422, "bad_file", "Chỉ nhận file .xlsx hoặc .csv (UTF-8)");
  return parseCsv(bytes);
}

/** Chuẩn hoá tiêu đề cột để so khớp: bỏ dấu, chữ thường, chỉ giữ chữ-số. */
export const normHeader = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Ô bắt đầu bằng ký tự mà Excel/Sheets hiểu là công thức. */
export const looksLikeFormula = (s: string) => !/^[+-]?[\d\s().,-]+$/.test(s) && /^[=+\-@\t\r]/.test(s); // số / SĐT dạng +84... không phải công thức
