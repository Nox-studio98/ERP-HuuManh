import type { Context } from "hono";
import type { AppBindings } from "../env";
import { auditStmt } from "../lib/audit";
import { toMilli } from "../lib/money";
import { assertStmt, onceStmt } from "./guard";
import { isExpired } from "./http";
import type { ParsedSheet } from "./import-parse";
import { ImportFileError, mapColumns, missingColumnsError, parseDecimal, readRow, type ColDef } from "./import-excel";

/**
 * Nhập kết quả kiểm kho từ Excel/CSV vào MỘT phiếu kiểm kê NHÁP (docs/KIOTVIET-KHOANG-TRONG.md #7).
 * Chỉ ghi các dòng đếm (stock_doc_lines) — KHÔNG ghi sổ; ghi sổ/duyệt vẫn theo luồng kiểm kê hiện có (B-02/B-10).
 *
 * Quy tắc khớp dòng (an toàn, không đoán):
 *  - Có "Mã lô" → đúng lô đó, phải thuộc vị trí của phiếu (có thêm mã hàng thì phải cùng mặt hàng).
 *  - Chỉ có mã hàng/mã vạch → nếu mặt hàng có đúng MỘT lô còn tồn tại vị trí thì dùng lô đó;
 *    nhiều lô → LỖI, yêu cầu ghi mã lô (không tự phân bổ FEFO vì kiểm kê là đếm thực tế từng lô).
 *  - Một lô chỉ xuất hiện một lần trong file. Lô đã có dòng đếm trong phiếu sẽ bị ghi đè (có cảnh báo).
 */
export const COUNT_IMPORT_COLS: ColDef[] = [
  { key: "lot", header: "Mã lô", aliases: ["Lô", "Mã vạch lô", "lot_code"], example: [], hint: "Mã lô (tem lô). Bắt buộc nếu mặt hàng có nhiều lô tại vị trí này." },
  { key: "sku", header: "Mã hàng", aliases: ["SKU", "Mã vạch", "Barcode", "Mã hàng / mã vạch"], example: [], hint: "Mã hàng (SKU) hoặc mã vạch; dùng khi file không có mã lô và mặt hàng chỉ có một lô." },
  { key: "unit", header: "Đơn vị", aliases: ["ĐVT", "Đơn vị đếm"], example: [], hint: "Đơn vị của số đếm; để trống = đơn vị chính của mặt hàng." },
  { key: "qty", header: "Số đếm", aliases: ["Số lượng đếm", "Thực đếm", "Thực tế", "Số lượng"], example: [], hint: "Số thực đếm được (0 nếu hết hàng). Để trống = chưa đếm lô này, bỏ qua." },
  { key: "name", header: "Tên hàng", aliases: ["Tên"], example: [], hint: "Chỉ để đọc, không dùng khi nhập." },
  { key: "system", header: "Tồn hệ thống", aliases: ["Tồn", "Tồn kho"], example: [], hint: "Chỉ để tham khảo (tồn hệ thống lúc tải mẫu), không dùng khi nhập." },
];
export const COUNT_IMPORT_NOTES = [
  "Chỉ ghi các dòng đếm vào phiếu kiểm kê đang nháp; chưa ghi sổ. Ghi sổ/duyệt chênh lệch làm trên phiếu như bình thường.",
  "Mặt hàng có nhiều lô: ghi rõ Mã lô ở từng dòng (hệ thống không tự chia số đếm cho các lô).",
  "Lô đã có dòng đếm trong phiếu sẽ bị ghi đè bằng số trong file.",
];

type Ctx = Context<AppBindings>;
export interface CountDoc { id: number; code: string; location_id: number; status: string }
export interface CountPreviewRow {
  line: number;
  status: "ok" | "error" | "skip";
  lotCode: string;
  productName: string;
  sku: string;
  unit: string;
  baseUnit: string;
  /** Tồn hệ thống (theo đơn vị của dòng) tại thời điểm xem trước — chính là mốc "tồn lúc đếm" sẽ lưu vào dòng phiếu. */
  systemQty: number | null;
  countedQty: number | null;
  diffQty: number | null;
  errors: string[];
  warnings: string[];
}
export interface CountAnalysis {
  rows: CountPreviewRow[];
  ignoredColumns: string[];
  build(ctx: { fileHash: string; filename: string }): { stmts: D1PreparedStatement[]; written: number; updated: number };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function analyzeCountImport(c: Ctx, doc: CountDoc, sheet: ParsedSheet): Promise<CountAnalysis> {
  const db = c.env.DB;
  const { idx, ignored, missing } = mapColumns(COUNT_IMPORT_COLS, sheet);
  if (!idx.has("qty")) missing.push("Số đếm");
  if (!idx.has("lot") && !idx.has("sku")) missing.push("Mã lô hoặc Mã hàng");
  if (missing.length) throw new ImportFileError(missingColumnsError(missing));
  const ignoredColumns = ignored.filter(Boolean);

  const prodByCode = new Map<string, any | null>();
  const unitsOf = new Map<number, { unit: string; f: number }[]>();
  const lotsOfProduct = new Map<number, any[]>();
  const lotByCode = new Map<string, any | null>();
  const existingLines = new Map<number, any>();
  const { results: ex } = await db.prepare(`SELECT id, lot_id, qty_milli, unit FROM stock_doc_lines WHERE doc_id = ?`).bind(doc.id).all<any>();
  for (const l of ex) existingLines.set(l.lot_id, l);

  const findLot = async (code: string) => {
    if (!lotByCode.has(code)) lotByCode.set(code, (await db.prepare(`SELECT l.*, p.name AS pname, p.sku, p.base_unit FROM lots l JOIN products p ON p.id = l.product_id WHERE l.lot_code = ?`).bind(code).first<any>()) ?? null);
    return lotByCode.get(code)!;
  };
  const findProduct = async (code: string) => {
    if (!prodByCode.has(code)) {
      let p = await db.prepare(`SELECT id, name, sku, base_unit FROM products WHERE sku = ?1 OR barcode = ?1 ORDER BY (sku = ?1) DESC LIMIT 1`).bind(code).first<any>();
      let unit: string | null = null;
      if (!p) {
        const u = await db.prepare(`SELECT p.id, p.name, p.sku, p.base_unit, pu.unit FROM product_units pu JOIN products p ON p.id = pu.product_id WHERE pu.barcode = ?`).bind(code).first<any>();
        if (u) { p = u; unit = u.unit; }
      }
      prodByCode.set(code, p ? { ...p, matchedUnit: unit } : null);
    }
    return prodByCode.get(code)!;
  };
  const factorOf = async (productId: number, baseUnit: string, unit: string) => {
    if (!unitsOf.has(productId)) {
      const { results } = await db.prepare(`SELECT unit, factor_milli f FROM product_units WHERE product_id = ?`).bind(productId).all<any>();
      unitsOf.set(productId, [{ unit: baseUnit, f: 1000 }, ...results.map((r: any) => ({ unit: r.unit, f: r.f }))]);
    }
    return unitsOf.get(productId)!.find((u) => u.unit === unit)?.f ?? null;
  };
  const candidates = async (productId: number) => {
    if (!lotsOfProduct.has(productId)) {
      const { results } = await db.prepare(`SELECT * FROM lots WHERE product_id = ? AND location_id = ? AND status <> 'closed' AND qty_on_hand_milli > 0 ORDER BY received_at, id`).bind(productId, doc.location_id).all<any>();
      lotsOfProduct.set(productId, results);
    }
    return lotsOfProduct.get(productId)!;
  };

  const now = new Date().toISOString();
  const rows: CountPreviewRow[] = [];
  const items: { lot: any; unit: string; countedMilli: number; systemMilli: number; line: number }[] = [];
  const seenLot = new Map<number, number>();
  const cols = COUNT_IMPORT_COLS;

  for (const r of sheet.rows) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const f = readRow(sheet, cols, idx, r, errors);
    if (!f.lot && !f.sku && !f.unit && !f.qty) continue; // dòng trống hoàn toàn
    const row: CountPreviewRow = { line: r.line, status: "ok", lotCode: f.lot, productName: f.name, sku: f.sku, unit: f.unit, baseUnit: "", systemQty: null, countedQty: null, diffQty: null, errors, warnings };
    rows.push(row);
    if (f.lot.length > 100 || f.sku.length > 100 || f.unit.length > 30) errors.push("Mã/đơn vị dài quá giới hạn");
    if (!f.lot && !f.sku) errors.push("Thiếu Mã lô hoặc Mã hàng");
    const qty = parseDecimal(f.qty);
    if (qty === undefined) errors.push(`Số đếm "${f.qty}" không hợp lệ (phải là số ≥ 0)`);
    else if (qty !== null && qty > 1_000_000) errors.push("Số đếm quá lớn (tối đa 1.000.000)");
    if (errors.length) { row.status = "error"; continue; }
    if (qty === null) { row.status = "skip"; warnings.push("Chưa nhập số đếm — bỏ qua dòng này"); continue; }

    // --- khớp lô
    let lot: any = null;
    let matchedUnit: string | null = null;
    if (f.lot) {
      lot = await findLot(f.lot);
      if (!lot) errors.push(`Không có lô "${f.lot}"`);
      else if (lot.location_id !== doc.location_id) { errors.push(`Lô "${f.lot}" không thuộc vị trí của phiếu kiểm kê`); lot = null; }
      else if (lot.status === "closed") { errors.push(`Lô "${f.lot}" đã đóng`); lot = null; }
      if (lot && f.sku) {
        const p = await findProduct(f.sku);
        if (!p) errors.push(`Không có mặt hàng "${f.sku}"`);
        else if (p.id !== lot.product_id) { errors.push(`Lô "${f.lot}" thuộc mặt hàng khác (${lot.sku}), không phải "${f.sku}"`); lot = null; }
        else matchedUnit = p.matchedUnit;
      }
    } else {
      const p = await findProduct(f.sku);
      if (!p) errors.push(`Không có mặt hàng "${f.sku}"`);
      else {
        matchedUnit = p.matchedUnit;
        const cand = await candidates(p.id);
        if (!cand.length) errors.push(`Mặt hàng "${f.sku}" không có lô còn tồn tại vị trí này — không thể đếm (nhập hàng/kiểm kê trước)`);
        else if (cand.length > 1) errors.push(`Mặt hàng "${f.sku}" có ${cand.length} lô tại vị trí này (${cand.slice(0, 4).map((l) => l.lot_code).join(", ")}${cand.length > 4 ? "…" : ""}) — hãy ghi Mã lô ở từng dòng`);
        else lot = cand[0];
      }
    }
    if (!lot) { row.status = "error"; continue; }
    const prod = await db.prepare(`SELECT name, sku, base_unit FROM products WHERE id = ?`).bind(lot.product_id).first<any>();
    row.lotCode = lot.lot_code; row.productName = prod.name; row.sku = prod.sku; row.baseUnit = prod.base_unit;
    const unit = f.unit || matchedUnit || prod.base_unit;
    row.unit = unit;
    const factor = await factorOf(lot.product_id, prod.base_unit, unit);
    if (factor == null) { errors.push(`Đơn vị "${unit}" không có trong danh mục của mặt hàng`); row.status = "error"; continue; }
    if (seenLot.has(lot.id)) { errors.push(`Trùng lô ${lot.lot_code} với dòng ${seenLot.get(lot.id)} của file`); row.status = "error"; continue; }
    seenLot.set(lot.id, r.line);

    const countedMilli = toMilli(qty!, factor);
    row.countedQty = qty!;
    row.systemQty = round3(lot.qty_on_hand_milli / factor);
    row.diffQty = round3((countedMilli - lot.qty_on_hand_milli) / factor);
    if (lot.status === "quarantine") warnings.push("Lô đang cách ly");
    if (isExpired(lot, now)) warnings.push("Lô đã hết hạn");
    if (lot.qty_reserved_milli > 0 && countedMilli < lot.qty_reserved_milli) warnings.push("Số đếm thấp hơn phần đang giữ cho đơn — khi ghi sổ có thể phải đổi lô giữ");
    const had = existingLines.get(lot.id);
    if (had) warnings.push(`Lô đã có dòng đếm trong phiếu (${round3(had.qty_milli / 1000)}) — sẽ bị ghi đè`);
    items.push({ lot, unit, countedMilli, systemMilli: lot.qty_on_hand_milli, line: r.line });
  }

  return {
    rows,
    ignoredColumns,
    build(ctx) {
      const stmts: D1PreparedStatement[] = [
        // phiếu phải còn nháp và (nếu khoá lô) chưa bị ai thao tác lại ngay lúc ghi
        assertStmt(db, "count_import.draft", `SELECT status = 'draft' AND type = 'count' FROM stock_docs WHERE id = ?`, [doc.id]),
        onceStmt(db, "import.count", `${doc.id}:${ctx.fileHash}:${existingLines.size}`),
      ];
      let written = 0, updated = 0;
      for (const it of items) {
        // tồn lô phải đúng như lúc xem trước, nếu đã đổi thì dừng để xem trước lại (tránh mốc "tồn lúc đếm" sai)
        stmts.push(assertStmt(db, "count_import.lot", `SELECT qty_on_hand_milli = ? AND status <> 'closed' FROM lots WHERE id = ?`, [it.systemMilli, it.lot.id]));
        const had = existingLines.get(it.lot.id);
        if (had) {
          updated++;
          stmts.push(db.prepare(`UPDATE stock_doc_lines SET qty_milli = ?, doc_qty_milli = ?, unit = ? WHERE id = ? AND doc_id = ?`).bind(it.countedMilli, it.systemMilli, it.unit, had.id, doc.id));
        } else {
          written++;
          stmts.push(db.prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, doc_qty_milli, qty_milli, unit_cost) VALUES (?,?,?,?,?,?,?)`).bind(doc.id, it.lot.product_id, it.lot.id, it.unit, it.systemMilli, it.countedMilli, it.lot.unit_cost));
        }
      }
      stmts.push(auditStmt(c, { action: "import.count", entity: "stock_doc", entityId: doc.id, after: { file: ctx.filename, hash: ctx.fileHash.slice(0, 16), added: written, overwritten: updated } }));
      return { stmts, written, updated };
    },
  };
}
