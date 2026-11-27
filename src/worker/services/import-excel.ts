import type { Context } from "hono";
import type { AppBindings } from "../env";
import type { Permission } from "../lib/rbac";
import { can } from "../lib/rbac";
import { auditStmt } from "../lib/audit";
import { vnDay } from "../lib/time";
import { getSettingInt } from "./settings";
import { onceStmt } from "./guard";
import { looksLikeFormula, normHeader, type ParsedSheet } from "./import-parse";

/**
 * Nhập hàng loạt từ Excel/CSV (go-live nạp danh mục): hàng hoá, khách sỉ, nhà cung cấp.
 * Hai bước: analyze() chỉ ĐỌC + kiểm từng dòng (xem trước) → build() trả các statement để ghi trong MỘT db.batch (kèm audit).
 * Không đụng tồn kho (tồn đầu kỳ nhập qua phiếu nhập).
 */
export type ImportKind = "products" | "customers" | "suppliers";
export type ImportMode = "skip" | "update";
type Ctx = Context<AppBindings>;

export interface ColDef { key: string; header: string; aliases?: string[]; required?: boolean; example: string[]; hint: string }
export interface PreviewRow {
  line: number;
  status: "create" | "exists" | "error" | "merged";
  key: string;
  label: string;
  errors: string[];
  warnings: string[];
  changes: string[];
  fields: Record<string, string>;
}
export interface Analysis {
  rows: PreviewRow[];
  ignoredColumns: string[];
  /** Ghi các dòng hợp lệ; mode quyết định dòng trùng mã (skip: bỏ qua; update: cập nhật). Trả về số liệu + statement. */
  build(mode: ImportMode, ctx: { fileHash: string; filename: string }): { stmts: D1PreparedStatement[]; created: number; updated: number; skipped: number };
}
export interface KindDef {
  kind: ImportKind;
  title: string;
  perm: Permission;
  columns: ColDef[];
  notes: string[];
  analyze(c: Ctx, sheet: ParsedSheet): Promise<Analysis>;
}

// ---------------------------------------------------------------- tiện ích chung
export const nfc = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const lc = (s: string) => nfc(s).toLowerCase();

export function mapColumns(cols: ColDef[], sheet: ParsedSheet) {
  const byNorm = new Map<string, ColDef>();
  for (const c of cols) { byNorm.set(normHeader(c.header), c); for (const a of c.aliases ?? []) byNorm.set(normHeader(a), c); }
  const idx = new Map<string, number>();
  const ignored: string[] = [];
  sheet.header.forEach((h, i) => {
    if (!h) return;
    const c = byNorm.get(normHeader(h));
    if (c && !idx.has(c.key)) idx.set(c.key, i);
    else ignored.push(h);
  });
  const missing = cols.filter((c) => c.required && !idx.has(c.key)).map((c) => c.header);
  return { idx, ignored, missing };
}

export function missingColumnsError(missing: string[]) {
  return `Thiếu cột bắt buộc: ${missing.join(", ")}. Hãy tải file mẫu và giữ nguyên dòng tiêu đề.`;
}

/** Đọc một dòng thành {khoá: chuỗi} + ghi lỗi công thức (xlsx) / ký tự công thức (csv, ô chữ). */
export function readRow(sheet: ParsedSheet, cols: ColDef[], idx: Map<string, number>, row: { line: number; cells: string[] }, errors: string[]) {
  const f: Record<string, string> = {};
  for (const c of cols) {
    const i = idx.get(c.key);
    if (i === undefined) { f[c.key] = ""; continue; }
    const v = nfc(row.cells[i] ?? "");
    f[c.key] = v;
    if (sheet.formulas.has(`${row.line}:${i}`)) errors.push(`Cột "${c.header}": ô chứa công thức — hãy dán giá trị thay vì công thức`);
    else if (v && looksLikeFormula(v)) errors.push(`Cột "${c.header}": không được bắt đầu bằng = + - @ (có thể là công thức)`);
  }
  return f;
}

const textMax = (errors: string[], label: string, v: string, max: number, required = false) => {
  if (required && !v) errors.push(`Thiếu ${label}`);
  else if (v.length > max) errors.push(`${label} dài quá ${max} ký tự`);
};

/** "25.000", "25,000", "25000", "25000đ" → 25000. null = trống, undefined = sai định dạng. */
export function parseMoney(s: string): number | null | undefined {
  const t = s.replace(/[đ₫\s]|vnd/gi, "");
  if (!t) return null;
  const n = /^\d{1,3}([.,]\d{3})+$/.test(t) ? Number(t.replace(/[.,]/g, "")) : /^\d+$/.test(t) ? Number(t) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000_000 ? n : undefined;
}
/** Số thập phân dương/không âm: "10", "0,5", "2.5". null = trống, undefined = sai. */
export function parseDecimal(s: string): number | null | undefined {
  const t = s.replace(/\s/g, "");
  if (!t) return null;
  const norm = t.includes(".") && t.includes(",") ? t.replace(/,/g, "") : t.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(norm)) return undefined;
  const n = Number(norm);
  return Number.isFinite(n) && n <= 1_000_000_000 ? n : undefined;
}
export function parseBool(s: string): boolean | undefined {
  const t = normHeader(s);
  if (["", "0", "khong", "k", "no", "n", "false", "f"].includes(t)) return false;
  if (["1", "co", "c", "x", "yes", "y", "true", "t", "can", "theocan"].includes(t)) return true;
  return undefined;
}
const intIn = (s: string, min: number, max: number): number | null | undefined => {
  if (!s) return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= min && n <= max ? n : undefined;
};

export const sampleRows = (cols: ColDef[]) => {
  const n = Math.max(...cols.map((c) => c.example.length));
  return Array.from({ length: n }, (_, i) => cols.map((c) => c.example[i] ?? ""));
};
export const templateRows = (def: KindDef) => ({ header: def.columns.map((c) => c.header), rows: sampleRows(def.columns) });
const fmt = (n: number) => n.toLocaleString("vi-VN");

// ---------------------------------------------------------------- HÀNG HOÁ
const PRODUCT_COLS: ColDef[] = [
  { key: "sku", header: "Mã hàng", aliases: ["SKU", "Mã"], required: true, example: ["VD-TAO", "VD-TAO", "VD-NHO"], hint: "Mã duy nhất, tối đa 40 ký tự. Trùng mã hàng đã có → hỏi cập nhật." },
  { key: "name", header: "Tên hàng", aliases: ["Tên"], required: true, example: ["Táo Envy Mỹ", "", "Nho đỏ không hạt"], hint: "Dòng thứ hai của cùng mã hàng (để trống tên) dùng để khai thêm đơn vị quy đổi." },
  { key: "baseUnit", header: "Đơn vị chính", aliases: ["ĐVT", "Đơn vị"], required: true, example: ["kg", "kg", "kg"], hint: "Đơn vị nhỏ nhất dùng để tính tồn kho (kg, quả, hộp...)." },
  { key: "group", header: "Nhóm hàng", aliases: ["Nhóm"], example: ["Trái cây nhập", "", "Trái cây nhập"], hint: "Tên nhóm; chưa có sẽ được tạo mới." },
  { key: "byWeight", header: "Bán theo cân", aliases: ["Bán theo cân (có/không)", "Cân"], example: ["Có", "", "Có"], hint: "Có/Không (hoặc 1/0, x). Để trống = Không." },
  { key: "barcode", header: "Mã vạch", aliases: ["Barcode"], example: ["", "", ""], hint: "Mã vạch của đơn vị chính. Để trống: hệ thống tự sinh mã nội bộ." },
  { key: "unit", header: "Đơn vị quy đổi", aliases: ["ĐV quy đổi"], example: ["", "thùng", ""], hint: "Ví dụ thùng. Phải đi kèm Hệ số quy đổi." },
  { key: "factor", header: "Hệ số quy đổi", aliases: ["Quy đổi", "Hệ số"], example: ["", "10", ""], hint: "1 đơn vị quy đổi = bao nhiêu đơn vị chính (thùng 10 kg → 10)." },
  { key: "unitBarcode", header: "Mã vạch đơn vị quy đổi", aliases: ["Mã vạch quy đổi"], example: ["", "", ""], hint: "Tuỳ chọn." },
  { key: "price", header: "Giá bán chung", aliases: ["Giá bán", "Giá"], example: ["120000", "", "180000"], hint: "VND trên một đơn vị chính. Cần quyền đổi giá; người không có quyền duyệt giá sẽ tạo yêu cầu chờ duyệt." },
  { key: "shelfLife", header: "Hạn dùng (ngày)", aliases: ["HSD (ngày)", "Hạn dùng"], example: ["14", "", "7"], hint: "Số ngày dùng được từ lúc nhập (tuỳ chọn)." },
  { key: "origin", header: "Xuất xứ", example: ["Mỹ", "", "Chile"], hint: "Tuỳ chọn." },
  { key: "minStock", header: "Tồn tối thiểu", aliases: ["Tồn tối thiểu (đơn vị chính)"], example: ["20", "", ""], hint: "Theo đơn vị chính, để cảnh báo sắp hết (tuỳ chọn). Không phải tồn đầu kỳ." },
];

interface ProdUnit { unit: string; factorMilli: number; barcode: string | null }
interface ProdItem {
  line: number; sku: string; name: string; baseUnit: string; group: string | null; groupNew: boolean; byWeight: boolean; barcode: string | null;
  units: ProdUnit[]; price: number | null; shelfLife: number | null; origin: string | null; minStockMilli: number | null;
  existing: any | null; priceChanged: boolean; row: PreviewRow;
}

async function analyzeProducts(c: Ctx, sheet: ParsedSheet): Promise<Analysis> {
  const db = c.env.DB;
  const user = c.get("user");
  const { idx, ignored, missing } = mapColumns(PRODUCT_COLS, sheet);
  if (missing.length) throw new ImportFileError(missingColumnsError(missing));
  const existing = new Map<string, any>();
  for (const p of (await db.prepare(`SELECT id, sku, name, base_unit, barcode, group_id, sell_by_weight FROM products`).all<any>()).results) existing.set(lc(p.sku), p);
  const barcodeOwner = new Map<string, string>();
  for (const r of (await db.prepare(`SELECT p.sku, p.barcode AS b FROM products p WHERE p.barcode IS NOT NULL UNION ALL SELECT p.sku, u.barcode FROM product_units u JOIN products p ON p.id = u.product_id WHERE u.barcode IS NOT NULL`).all<any>()).results) barcodeOwner.set(r.b, lc(r.sku));
  const groups = new Map<string, string>();
  for (const g of (await db.prepare(`SELECT name FROM product_groups`).all<any>()).results) groups.set(lc(g.name), g.name);
  const canPrice = can(user.role, "prices.write");
  const canApprovePrice = can(user.role, "prices.approve");
  const baseList = canPrice ? await db.prepare(`SELECT id FROM price_lists WHERE kind='base' AND active=1 ORDER BY priority, id LIMIT 1`).first<{ id: number }>() : null;
  const curPrice = new Map<number, number>();
  if (baseList) {
    const now = new Date().toISOString();
    for (const r of (await db.prepare(`SELECT product_id, unit_price FROM prices WHERE price_list_id = ? AND status='active' AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?) ORDER BY effective_from`).bind(baseList.id, now, now).all<any>()).results) curPrice.set(r.product_id, r.unit_price);
  }

  const items = new Map<string, ProdItem>();
  const rows: PreviewRow[] = [];
  const newGroups = new Map<string, string>(); // lc → tên mới
  const fileBarcodes = new Map<string, string>(); // barcode → sku (lc) trong file
  let anyPriceIgnored = false;

  for (const raw of sheet.rows) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const f = readRow(sheet, PRODUCT_COLS, idx, raw, errors);
    const row: PreviewRow = { line: raw.line, status: "create", key: f.sku, label: f.name, errors, warnings, changes: [], fields: f };
    rows.push(row);
    const skuKey = lc(f.sku);
    textMax(errors, "Mã hàng", f.sku, 40, true);
    const main = items.get(skuKey);
    const merged = !!main;
    if (merged) {
      row.status = "merged";
      if (f.name) errors.push(`Trùng mã hàng với dòng ${main.line} — muốn khai thêm đơn vị quy đổi thì để trống Tên hàng`);
      row.label = main.name;
    } else {
      textMax(errors, "Tên hàng", f.name, 200, true);
      textMax(errors, "Đơn vị chính", f.baseUnit, 20, true);
    }
    const baseUnit = merged ? main!.baseUnit : f.baseUnit;

    // đơn vị quy đổi
    let unit: ProdUnit | null = null;
    if (f.unit || f.factor || f.unitBarcode) {
      textMax(errors, "Đơn vị quy đổi", f.unit, 20, true);
      const fac = parseDecimal(f.factor);
      if (fac === null) errors.push("Thiếu Hệ số quy đổi");
      else if (fac === undefined || fac <= 0 || Math.round(fac * 1000) < 1) errors.push("Hệ số quy đổi phải là số lớn hơn 0");
      else if (f.unit && lc(f.unit) === lc(baseUnit)) errors.push("Đơn vị quy đổi trùng đơn vị chính");
      else if (f.unit) {
        unit = { unit: f.unit, factorMilli: Math.round(fac * 1000), barcode: f.unitBarcode || null };
        if (merged && main!.units.some((u) => lc(u.unit) === lc(unit!.unit))) errors.push(`Đơn vị quy đổi "${f.unit}" bị lặp trong cùng mã hàng`);
      }
      if (f.unitBarcode) textMax(errors, "Mã vạch đơn vị quy đổi", f.unitBarcode, 64);
    }
    const checkBarcode = (code: string, label: string) => {
      if (!code) return;
      const owner = barcodeOwner.get(code);
      if (owner && owner !== skuKey) errors.push(`${label} ${code} đã dùng cho hàng có mã "${owner}"`);
      const inFile = fileBarcodes.get(code);
      if (inFile && inFile !== skuKey) errors.push(`${label} ${code} trùng với một dòng khác trong file`);
      else if (!errors.length) fileBarcodes.set(code, skuKey);
    };
    if (unit?.barcode) checkBarcode(unit.barcode, "Mã vạch đơn vị quy đổi");

    if (merged) {
      if (!unit && !errors.length) warnings.push("Dòng này không khai đơn vị quy đổi nên bị bỏ qua");
      if (main!.row.errors.length) errors.push(`Dòng chính của mã hàng này (dòng ${main!.line}) đang lỗi`);
      if (unit && !errors.length) main!.units.push(unit);
      row.status = errors.length ? "error" : "merged";
      continue;
    }

    // dòng chính
    const g = f.group ? (groups.get(lc(f.group)) ?? newGroups.get(lc(f.group)) ?? null) : null;
    textMax(errors, "Nhóm hàng", f.group, 100);
    let groupNew = false;
    if (f.group && !g && f.group.length <= 100) { groupNew = true; warnings.push(`Sẽ tạo nhóm hàng mới "${f.group}"`); }
    const byWeight = parseBool(f.byWeight);
    if (byWeight === undefined) errors.push('Bán theo cân chỉ nhận "Có" hoặc "Không"');
    if (f.barcode) { textMax(errors, "Mã vạch", f.barcode, 64); checkBarcode(f.barcode, "Mã vạch"); }
    const price = parseMoney(f.price);
    if (price === undefined) errors.push("Giá bán chung phải là số tiền VND không âm (ví dụ 25000)");
    const shelf = intIn(f.shelfLife, 1, 3650);
    if (shelf === undefined) errors.push("Hạn dùng (ngày) phải là số nguyên dương");
    textMax(errors, "Xuất xứ", f.origin, 100);
    const minStock = parseDecimal(f.minStock);
    if (minStock === undefined) errors.push("Tồn tối thiểu phải là số không âm");
    const ex = existing.get(skuKey) ?? null;
    if (ex) {
      row.status = "exists";
      if (f.baseUnit && lc(f.baseUnit) !== lc(ex.base_unit)) errors.push(`Đơn vị chính khác hàng đã có ("${ex.base_unit}") — không đổi được qua nhập Excel`);
    }
    if (price != null && !canPrice) { anyPriceIgnored = true; }
    const item: ProdItem = {
      line: raw.line, sku: f.sku, name: f.name, baseUnit: f.baseUnit, group: g ?? (groupNew ? f.group : null), groupNew, byWeight: !!byWeight, barcode: f.barcode || null,
      units: unit ? [unit] : [], price: canPrice ? (price ?? null) : null, shelfLife: shelf ?? null, origin: f.origin || null,
      minStockMilli: minStock != null ? Math.round(minStock * 1000) : null, existing: ex, priceChanged: false, row,
    };
    if (groupNew) newGroups.set(lc(f.group), f.group);
    if (ex) {
      if (nfc(ex.name) !== f.name) row.changes.push(`Tên: ${ex.name} → ${f.name}`);
      if (!!ex.sell_by_weight !== item.byWeight && f.byWeight !== "") row.changes.push(`Bán theo cân: ${ex.sell_by_weight ? "Có" : "Không"} → ${item.byWeight ? "Có" : "Không"}`);
      const was = curPrice.get(ex.id);
      if (item.price != null && item.price !== (was ?? -1)) { item.priceChanged = true; row.changes.push(`Giá bán: ${was != null ? fmt(was) : "chưa có"} → ${fmt(item.price)}`); }
      if (f.group) row.changes.push(`Nhóm hàng: ${f.group}`);
    }
    items.set(skuKey, item);
  }
  if (anyPriceIgnored) rows.find((r) => r.fields.price)?.warnings.push("Bạn không có quyền đổi giá: cột Giá bán chung bị bỏ qua");

  // trùng mã vạch giữa các dòng chính vs unit barcode đã kiểm; hoàn tất: các item có lỗi sẽ không ghi
  return {
    rows,
    ignoredColumns: ignored,
    build(mode, ctx) {
      const db = c.env.DB;
      const stmts: D1PreparedStatement[] = [onceStmt(db, "import.products", `${ctx.fileHash}:${mode}`)];
      const now = new Date().toISOString();
      let created = 0, updated = 0, skipped = 0;
      const groupDone = new Set<string>();
      const body: D1PreparedStatement[] = [];
      for (const it of items.values()) {
        if (it.row.errors.length || it.row.status === "error") continue;
        if (it.existing && mode === "skip") { skipped++; continue; }
        if (it.group && it.groupNew && !groupDone.has(lc(it.group))) {
          groupDone.add(lc(it.group));
          body.push(db.prepare(`INSERT OR IGNORE INTO product_groups(name, target_margin_bp) VALUES (?, 3000)`).bind(it.group));
        }
        const groupSql = it.group ? `(SELECT id FROM product_groups WHERE name = ?)` : `NULL`;
        const gb = it.group ? [it.group] : [];
        if (!it.existing) {
          created++;
          body.push(
            db.prepare(`INSERT INTO products(sku, barcode, name, group_id, base_unit, sell_by_weight, origin, shelf_life_days, min_stock_milli, active) VALUES (?,?,?,${groupSql},?,?,?,?,?,1)`)
              .bind(it.sku, it.barcode, it.name, ...gb, it.baseUnit, it.byWeight ? 1 : 0, it.origin, it.shelfLife, it.minStockMilli ?? 0),
            db.prepare(`UPDATE products SET barcode = 'HMP' || substr('00000000' || id, -8) WHERE sku = ? AND barcode IS NULL`).bind(it.sku),
            db.prepare(`INSERT INTO product_units(product_id, unit, factor_milli, barcode) SELECT id, ?, 1000, NULL FROM products WHERE sku = ?`).bind(it.baseUnit, it.sku),
          );
        } else {
          updated++;
          const sets = ["name = ?", "version = version + 1", "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
          const binds: unknown[] = [it.name];
          if (it.group) { sets.push(`group_id = ${groupSql}`); binds.push(...gb); }
          if (it.row.fields.byWeight !== "") { sets.push("sell_by_weight = ?"); binds.push(it.byWeight ? 1 : 0); }
          if (it.barcode) { sets.push("barcode = ?"); binds.push(it.barcode); }
          if (it.origin) { sets.push("origin = ?"); binds.push(it.origin); }
          if (it.shelfLife != null) { sets.push("shelf_life_days = ?"); binds.push(it.shelfLife); }
          if (it.minStockMilli != null) { sets.push("min_stock_milli = ?"); binds.push(it.minStockMilli); }
          body.push(db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, it.existing.id));
        }
        // B-N4: hàng đã có → dùng mã đúng như trong DB (so khớp không phân biệt hoa/thường, nhưng products.sku phân biệt)
        const dbSku = it.existing ? it.existing.sku : it.sku;
        for (const u of it.units) {
          body.push(
            db.prepare(`INSERT INTO product_units(product_id, unit, factor_milli, barcode) SELECT id, ?, ?, ? FROM products WHERE sku = ?
                        ON CONFLICT(product_id, unit) DO UPDATE SET factor_milli = excluded.factor_milli, barcode = COALESCE(excluded.barcode, product_units.barcode)`)
              .bind(u.unit, u.factorMilli, u.barcode, dbSku),
          );
        }
        if (baseList && it.price != null && (!it.existing || it.priceChanged)) {
          const pid = `(SELECT id FROM products WHERE sku = ?)`;
          if (canApprovePrice) {
            body.push(
              db.prepare(`UPDATE prices SET effective_to = ? WHERE price_list_id = ? AND product_id = ${pid} AND status = 'active' AND effective_to IS NULL AND effective_from < ?`).bind(now, baseList.id, dbSku, now),
              db.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by, approved_by, note) SELECT ?, id, ?, ?, 'active', ?, ?, 'Nhập từ Excel' FROM products WHERE sku = ?`).bind(baseList.id, it.price, now, user.id, user.id, dbSku),
            );
          } else {
            body.push(
              db.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by, note) SELECT ?, id, ?, ?, 'pending', ?, 'Nhập từ Excel' FROM products WHERE sku = ?`).bind(baseList.id, it.price, now, user.id, dbSku),
              // B-N4: trỏ đúng bản ghi giá vừa tạo (không dùng last_insert_rowid() — INSERT…SELECT 0 dòng sẽ trỏ nhầm bản ghi trước)
              db.prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by)
                          SELECT 'price.activate','price',CAST(p.id AS TEXT),?,'Giá nhập từ Excel',? FROM prices p
                           WHERE p.price_list_id = ? AND p.product_id = ${pid} AND p.status = 'pending' AND p.effective_from = ? AND p.created_by = ? ORDER BY p.id DESC LIMIT 1`)
                .bind(JSON.stringify({ priceListId: baseList.id, sku: dbSku, unitPrice: it.price, effectiveFrom: now, belowCost: false }), user.id, baseList.id, dbSku, now, user.id),
            );
          }
        }
      }
      stmts.push(...body);
      stmts.push(auditStmt(c, { action: "import.products", entity: "import", entityId: ctx.filename, after: { mode, fileHash: ctx.fileHash, created, updated, skipped, errors: rows.filter((r) => r.status === "error").length, skus: [...items.values()].filter((i) => !i.row.errors.length).slice(0, 50).map((i) => i.sku) } }));
      return { stmts, created, updated, skipped };
    },
  };
}

// ---------------------------------------------------------------- KHÁCH SỈ
const CUSTOMER_COLS: ColDef[] = [
  { key: "code", header: "Mã khách", aliases: ["Mã KH", "Mã"], example: ["", ""], hint: "Để trống: hệ thống tự sinh KH-xxxx. Trùng mã khách đã có → hỏi cập nhật." },
  { key: "name", header: "Tên khách", aliases: ["Tên", "Tên khách hàng"], required: true, example: ["Nhà hàng Hải Sản Biển Xanh", "Quán cà phê Ban Mai"], hint: "Tên công ty / cửa hàng." },
  { key: "group", header: "Nhóm khách", aliases: ["Nhóm"], required: true, example: ["Sỉ cấp 1", "Sỉ cấp 2"], hint: "Tên hoặc mã nhóm khách (xem ở màn Khách sỉ)." },
  { key: "phone", header: "SĐT", aliases: ["Số điện thoại", "Điện thoại"], example: ["0901234567", "0912345678"], hint: "Khách đã có cùng SĐT được coi là trùng khi để trống Mã khách." },
  { key: "email", header: "Email", example: ["", ""], hint: "Tuỳ chọn." },
  { key: "taxCode", header: "Mã số thuế", aliases: ["MST"], example: ["0312345678", ""], hint: "Tuỳ chọn." },
  { key: "address", header: "Địa chỉ giao hàng", aliases: ["Địa chỉ"], required: true, example: ["12 Nguyễn Huệ, Q1, TP.HCM", "45 Lê Lợi, Q3, TP.HCM"], hint: "Bắt buộc với khách mới (dùng cho giao hàng + địa chỉ xuất hoá đơn)." },
  { key: "receiver", header: "Người nhận", aliases: ["Người liên hệ"], example: ["Chị Lan", ""], hint: "Để trống: dùng tên khách." },
  { key: "receiverPhone", header: "SĐT người nhận", example: ["", ""], hint: "Để trống: dùng SĐT khách." },
  { key: "creditLimit", header: "Hạn mức nợ", aliases: ["Hạn mức"], example: ["20000000", "0"], hint: "VND. Người không phải chủ chỉ đặt được trong ngưỡng cho phép khi tạo mới." },
  { key: "terms", header: "Hạn thanh toán (ngày)", aliases: ["Hạn thanh toán", "Kỳ hạn"], example: ["15", "0"], hint: "Số ngày công nợ." },
  { key: "note", header: "Ghi chú", example: ["", ""], hint: "Tuỳ chọn." },
];

interface CustItem {
  line: number; code: string | null; name: string; groupId: number; phone: string | null; email: string | null; taxCode: string | null; address: string;
  receiver: string; receiverPhone: string | null; creditLimit: number | null; terms: number | null; note: string | null; existing: any | null; row: PreviewRow;
}

async function nextCodes(db: D1Database, prefix: string, day: string, fmtCode: (n: number) => string, taken: Set<string>) {
  const r = await db.prepare(`SELECT seq FROM doc_sequences WHERE prefix = ? AND day = ?`).bind(prefix, day).first<{ seq: number }>();
  let seq = r?.seq ?? 0;
  return {
    next() { let code: string; do { seq++; code = fmtCode(seq); } while (taken.has(code.toLowerCase())); taken.add(code.toLowerCase()); return code; },
    get seq() { return seq; },
  };
}
const seqStmt = (db: D1Database, prefix: string, day: string, seq: number) =>
  db.prepare(`INSERT INTO doc_sequences(prefix, day, seq) VALUES (?,?,?) ON CONFLICT(prefix, day) DO UPDATE SET seq = MAX(seq, excluded.seq)`).bind(prefix, day, seq);

async function analyzeCustomers(c: Ctx, sheet: ParsedSheet): Promise<Analysis> {
  const db = c.env.DB;
  const user = c.get("user");
  const { idx, ignored, missing } = mapColumns(CUSTOMER_COLS, sheet);
  if (missing.length) throw new ImportFileError(missingColumnsError(missing));
  const byCode = new Map<string, any>();
  const byPhone = new Map<string, any>();
  const takenCodes = new Set<string>();
  for (const r of (await db.prepare(`SELECT id, code, type, name, phone FROM customers`).all<any>()).results) {
    byCode.set(r.code.toLowerCase(), r); takenCodes.add(r.code.toLowerCase());
    if (r.type === "b2b" && r.phone) byPhone.set(r.phone.replace(/\D/g, ""), r);
  }
  const groups = new Map<string, number>();
  for (const g of (await db.prepare(`SELECT id, code, name FROM customer_groups`).all<any>()).results) { groups.set(lc(g.name), g.id); groups.set(lc(g.code), g.id); }
  const owner = can(user.role, "b2b.credit_override");
  const maxLimit = await getSettingInt(db, "b2b.new_credit_limit_max_vnd", 50_000_000);
  const maxDays = await getSettingInt(db, "b2b.new_payment_terms_max_days", 30);
  const rows: PreviewRow[] = [];
  const items: CustItem[] = [];
  const seenKey = new Map<string, number>();

  for (const raw of sheet.rows) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const f = readRow(sheet, CUSTOMER_COLS, idx, raw, errors);
    const row: PreviewRow = { line: raw.line, status: "create", key: f.code || f.phone, label: f.name, errors, warnings, changes: [], fields: f };
    rows.push(row);
    textMax(errors, "Tên khách", f.name, 150, true);
    textMax(errors, "Mã khách", f.code, 30);
    textMax(errors, "SĐT", f.phone, 30);
    textMax(errors, "Email", f.email, 120);
    textMax(errors, "Mã số thuế", f.taxCode, 20);
    textMax(errors, "Địa chỉ giao hàng", f.address, 300);
    textMax(errors, "Người nhận", f.receiver, 100);
    textMax(errors, "Ghi chú", f.note, 500);
    const gid = f.group ? groups.get(lc(f.group)) : undefined;
    if (!f.group) errors.push("Thiếu Nhóm khách"); else if (!gid) errors.push(`Nhóm khách "${f.group}" không tồn tại`);
    const credit = parseMoney(f.creditLimit);
    if (credit === undefined) errors.push("Hạn mức nợ phải là số tiền VND không âm");
    const terms = intIn(f.terms, 0, 365);
    if (terms === undefined) errors.push("Hạn thanh toán phải là số ngày từ 0 đến 365");
    const ex = f.code ? byCode.get(f.code.toLowerCase()) : f.phone ? byPhone.get(f.phone.replace(/\D/g, "")) : undefined;
    if (f.code && ex && ex.type !== "b2b") errors.push(`Mã ${f.code} đang là khách lẻ, không cập nhật được qua file khách sỉ`);
    const key = ex ? ex.code.toLowerCase() : "";
    if (ex && seenKey.has(key)) errors.push(`Trùng khách với dòng ${seenKey.get(key)} trong file`);
    else if (ex) seenKey.set(key, raw.line);
    if (!ex && f.code) { if (seenKey.has("c:" + f.code.toLowerCase())) errors.push(`Trùng mã khách với dòng ${seenKey.get("c:" + f.code.toLowerCase())}`); else seenKey.set("c:" + f.code.toLowerCase(), raw.line); }
    if (!ex && !f.address) errors.push("Thiếu Địa chỉ giao hàng (khách sỉ mới phải có ít nhất 1 địa chỉ)");
    if (ex) {
      row.status = "exists";
      row.key = ex.code;
      if (f.name && nfc(ex.name) !== f.name) row.changes.push(`Tên: ${ex.name} → ${f.name}`);
      if ((credit != null || terms != null) && !owner) warnings.push("Chỉ chủ cửa hàng đổi được hạn mức / hạn thanh toán của khách đã có — hai cột này bị bỏ qua");
    } else {
      if (!owner && ((credit ?? 0) > maxLimit)) errors.push(`Hạn mức nợ vượt ngưỡng ${fmt(maxLimit)}đ — chỉ chủ cửa hàng đặt được; hãy để thấp hơn rồi nâng qua duyệt`);
      if (!owner && ((terms ?? 0) > maxDays)) errors.push(`Hạn thanh toán vượt ngưỡng ${maxDays} ngày — chỉ chủ cửa hàng đặt được`);
    }
    items.push({
      line: raw.line, code: ex ? ex.code : f.code || null, name: f.name, groupId: gid ?? 0, phone: f.phone || null, email: f.email || null, taxCode: f.taxCode || null, address: f.address,
      receiver: f.receiver || f.name, receiverPhone: f.receiverPhone || f.phone || null, creditLimit: credit ?? null, terms: terms ?? null, note: f.note || null, existing: ex ?? null, row,
    });
  }
  // Mã khách mới: cấp sẵn một dải từ doc_sequences ('KH','-'), bỏ qua mã đã dùng; ghi lại số cuối trong cùng batch
  const gen = await nextCodes(db, "KH", "-", (n) => `KH-${String(n).padStart(4, "0")}`, takenCodes);
  for (const it of items) if (!it.existing && !it.row.errors.length && !it.code) it.code = gen.next();
  for (const it of items) if (!it.existing && it.code) it.row.key = it.code;
  return {
    rows,
    ignoredColumns: ignored,
    build(mode, ctx) {
      const stmts: D1PreparedStatement[] = [onceStmt(db, "import.customers", `${ctx.fileHash}:${mode}`)];
      let created = 0, updated = 0, skipped = 0;
      for (const it of items) {
        if (it.row.errors.length) continue;
        if (it.existing && mode === "skip") { skipped++; continue; }
        if (!it.existing) {
          created++;
          const byCode = `(SELECT id FROM customers WHERE code = ?)`;
          stmts.push(
            db.prepare(`INSERT INTO customers(code, type, name, phone, email, customer_group_id, tax_code, credit_limit, payment_terms_days, billing_address, note, created_at) VALUES (?,'b2b',?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
              .bind(it.code, it.name, it.phone, it.email, it.groupId, it.taxCode, it.creditLimit ?? 0, it.terms ?? 0, it.address, it.note),
            db.prepare(`INSERT INTO customer_contacts(customer_id, name, phone, email, role, is_receiver) VALUES (${byCode},?,?,?,NULL,1)`).bind(it.code, it.receiver, it.receiverPhone, it.email),
            db.prepare(`INSERT INTO customer_addresses(customer_id, label, address, receiver_contact_id, delivery_note, is_default)
                        VALUES (${byCode}, 'Địa chỉ giao hàng', ?, (SELECT id FROM customer_contacts WHERE customer_id = ${byCode} ORDER BY id LIMIT 1), NULL, 1)`).bind(it.code, it.address, it.code),
          );
        } else {
          updated++;
          const owner = can(user.role, "b2b.credit_override");
          const sets = ["name = ?", "customer_group_id = ?", "version = version + 1"];
          const binds: unknown[] = [it.name, it.groupId];
          if (it.phone) { sets.push("phone = ?"); binds.push(it.phone); }
          if (it.email) { sets.push("email = ?"); binds.push(it.email); }
          if (it.taxCode) { sets.push("tax_code = ?"); binds.push(it.taxCode); }
          if (it.address) { sets.push("billing_address = ?"); binds.push(it.address); }
          if (it.note) { sets.push("note = ?"); binds.push(it.note); }
          if (owner && it.creditLimit != null) { sets.push("credit_limit = ?"); binds.push(it.creditLimit); }
          if (owner && it.terms != null) { sets.push("payment_terms_days = ?"); binds.push(it.terms); }
          stmts.push(db.prepare(`UPDATE customers SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, it.existing.id));
        }
      }
      if (created) stmts.push(seqStmt(db, "KH", "-", gen.seq));
      stmts.push(auditStmt(c, { action: "import.customers", entity: "import", entityId: ctx.filename, after: { mode, fileHash: ctx.fileHash, created, updated, skipped, errors: rows.filter((r) => r.status === "error" || r.errors.length).length } }));
      return { stmts, created, updated, skipped };
    },
  };
}

// ---------------------------------------------------------------- NHÀ CUNG CẤP
const SUPPLIER_COLS: ColDef[] = [
  { key: "code", header: "Mã NCC", aliases: ["Mã nhà cung cấp", "Mã"], example: ["", ""], hint: "Để trống: hệ thống tự sinh. Trùng mã (hoặc trùng tên khi để trống mã) → hỏi cập nhật." },
  { key: "name", header: "Tên nhà cung cấp", aliases: ["Tên NCC", "Tên"], required: true, example: ["Vựa Trái Cây Ba Tư", "Công ty Nhập khẩu Fresh Việt"], hint: "Bắt buộc." },
  { key: "phone", header: "SĐT", aliases: ["Số điện thoại", "Điện thoại"], example: ["0987654321", ""], hint: "Tuỳ chọn." },
  { key: "address", header: "Địa chỉ", example: ["Chợ đầu mối Thủ Đức", ""], hint: "Tuỳ chọn." },
  { key: "taxCode", header: "Mã số thuế", aliases: ["MST"], example: ["", "0301234567"], hint: "Tuỳ chọn." },
  { key: "terms", header: "Hạn thanh toán (ngày)", aliases: ["Hạn thanh toán", "Kỳ hạn"], example: ["7", "30"], hint: "Số ngày công nợ phải trả." },
];

async function analyzeSuppliers(c: Ctx, sheet: ParsedSheet): Promise<Analysis> {
  const db = c.env.DB;
  const { idx, ignored, missing } = mapColumns(SUPPLIER_COLS, sheet);
  if (missing.length) throw new ImportFileError(missingColumnsError(missing));
  const byCode = new Map<string, any>();
  const byName = new Map<string, any>();
  const taken = new Set<string>();
  for (const r of (await db.prepare(`SELECT id, code, name FROM suppliers`).all<any>()).results) { byCode.set(r.code.toLowerCase(), r); byName.set(lc(r.name), r); taken.add(r.code.toLowerCase()); }
  const day = vnDay();
  const rows: PreviewRow[] = [];
  const items: { code: string | null; f: Record<string, string>; terms: number | null; existing: any | null; row: PreviewRow }[] = [];
  const seen = new Map<string, number>();
  for (const raw of sheet.rows) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const f = readRow(sheet, SUPPLIER_COLS, idx, raw, errors);
    const row: PreviewRow = { line: raw.line, status: "create", key: f.code, label: f.name, errors, warnings, changes: [], fields: f };
    rows.push(row);
    textMax(errors, "Tên nhà cung cấp", f.name, 200, true);
    textMax(errors, "Mã NCC", f.code, 30);
    textMax(errors, "SĐT", f.phone, 30);
    textMax(errors, "Địa chỉ", f.address, 300);
    textMax(errors, "Mã số thuế", f.taxCode, 30);
    const terms = intIn(f.terms, 0, 365);
    if (terms === undefined) errors.push("Hạn thanh toán phải là số ngày từ 0 đến 365");
    const ex = (f.code ? byCode.get(f.code.toLowerCase()) : byName.get(lc(f.name))) ?? null;
    const k = ex ? "id:" + ex.id : f.code ? "c:" + f.code.toLowerCase() : "n:" + lc(f.name);
    if (seen.has(k)) errors.push(`Trùng nhà cung cấp với dòng ${seen.get(k)} trong file`); else seen.set(k, raw.line);
    if (ex) { row.status = "exists"; row.key = ex.code; if (f.name && nfc(ex.name) !== f.name) row.changes.push(`Tên: ${ex.name} → ${f.name}`); }
    items.push({ code: ex ? ex.code : f.code || null, f, terms: terms ?? null, existing: ex, row });
  }
  const gen = await nextCodes(db, "NCC", day, (n) => `NCC-${day}-${String(n).padStart(4, "0")}`, taken);
  for (const it of items) { if (!it.existing && !it.row.errors.length && !it.code) it.code = gen.next(); if (!it.existing && it.code) it.row.key = it.code; }
  return {
    rows,
    ignoredColumns: ignored,
    build(mode, ctx) {
      const stmts: D1PreparedStatement[] = [onceStmt(db, "import.suppliers", `${ctx.fileHash}:${mode}`)];
      let created = 0, updated = 0, skipped = 0;
      for (const it of items) {
        if (it.row.errors.length) continue;
        if (it.existing && mode === "skip") { skipped++; continue; }
        if (!it.existing) {
          created++;
          stmts.push(db.prepare(`INSERT INTO suppliers(code, name, phone, address, tax_code, payment_terms_days, active) VALUES (?,?,?,?,?,?,1)`).bind(it.code, it.f.name, it.f.phone || null, it.f.address || null, it.f.taxCode || null, it.terms ?? 0));
        } else {
          updated++;
          const sets = ["name = ?"];
          const binds: unknown[] = [it.f.name];
          if (it.f.phone) { sets.push("phone = ?"); binds.push(it.f.phone); }
          if (it.f.address) { sets.push("address = ?"); binds.push(it.f.address); }
          if (it.f.taxCode) { sets.push("tax_code = ?"); binds.push(it.f.taxCode); }
          if (it.terms != null) { sets.push("payment_terms_days = ?"); binds.push(it.terms); }
          stmts.push(db.prepare(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, it.existing.id));
        }
      }
      if (created) stmts.push(seqStmt(db, "NCC", day, gen.seq));
      stmts.push(auditStmt(c, { action: "import.suppliers", entity: "import", entityId: ctx.filename, after: { mode, fileHash: ctx.fileHash, created, updated, skipped, errors: rows.filter((r) => r.errors.length).length } }));
      return { stmts, created, updated, skipped };
    },
  };
}

// ---------------------------------------------------------------- đăng ký
/** Lỗi do nội dung file (thiếu cột...) — route đổi thành 422. */
export class ImportFileError extends Error {}

export const IMPORT_KINDS: Record<ImportKind, KindDef> = {
  products: {
    kind: "products", title: "Hàng hoá", perm: "products.write", columns: PRODUCT_COLS, analyze: analyzeProducts,
    notes: [
      "Mỗi dòng là một mặt hàng. Muốn khai thêm đơn vị quy đổi, thêm dòng cùng Mã hàng nhưng để trống Tên hàng.",
      "Không nhập tồn kho ở đây: tồn đầu kỳ nhập qua phiếu nhập kho để có lô, hạn dùng và giá vốn.",
      "Giá bán chung ghi vào bảng giá cơ bản; người không có quyền duyệt giá tạo yêu cầu chờ duyệt.",
    ],
  },
  customers: {
    kind: "customers", title: "Khách sỉ", perm: "b2b.write", columns: CUSTOMER_COLS, analyze: analyzeCustomers,
    notes: [
      "Khách sỉ mới bắt buộc có Nhóm khách và Địa chỉ giao hàng; người nhận mặc định là chính khách.",
      "Hạn mức nợ / hạn thanh toán: chỉ chủ đặt được vượt ngưỡng cho phép và đổi cho khách đã có.",
    ],
  },
  suppliers: {
    kind: "suppliers", title: "Nhà cung cấp", perm: "inventory.write", columns: SUPPLIER_COLS, analyze: analyzeSuppliers,
    notes: ["Trùng Mã NCC (hoặc trùng tên khi để trống mã) với nhà cung cấp đã có sẽ được hỏi: bỏ qua hay cập nhật."],
  },
};
