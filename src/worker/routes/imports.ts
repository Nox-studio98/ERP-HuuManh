import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { buildXlsx, XLSX_MIME } from "../services/xlsx";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseImportFile } from "../services/import-parse";
import { IMPORT_KINDS, ImportFileError, templateRows, type ImportKind, type ImportMode, type KindDef } from "../services/import-excel";
import { guarded } from "../services/http";

/**
 * Nhập hàng loạt từ Excel/CSV (hàng hoá, khách sỉ, nhà cung cấp). Luồng hai bước:
 *  POST /imports/:kind/preview  — tải file, kiểm từng dòng, KHÔNG ghi gì;
 *  POST /imports/:kind/commit   — tải lại cùng file + mode, ghi các dòng hợp lệ trong một db.batch (kèm audit `import.<kind>`).
 * Quyền theo từng loại = quyền tạo danh mục tương ứng (products.write / b2b.write / inventory.write).
 */
export const importRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const kindDef = (c: Ctx): KindDef => {
  const d = IMPORT_KINDS[c.req.param("kind") as ImportKind];
  if (!d) throw notFound("import_kind_not_found", "Loại nhập liệu không hợp lệ");
  return d;
};
const guard: MiddlewareHandler<AppBindings> = async (c, next) => requirePerm(kindDef(c).perm)(c, next);

importRoutes.get("/imports/:kind", guard, (c) => {
  const d = kindDef(c);
  return c.json({
    kind: d.kind, title: d.title, notes: d.notes, limits: { maxBytes: IMPORT_MAX_BYTES, maxRows: IMPORT_MAX_ROWS },
    columns: d.columns.map((x) => ({ key: x.key, header: x.header, required: !!x.required, hint: x.hint })),
  });
});

importRoutes.get("/imports/:kind/template.xlsx", guard, (c) => {
  const d = kindDef(c);
  const t = templateRows(d);
  const bytes = buildXlsx([
    { name: "Dữ liệu", columns: t.header.map((h) => ({ header: h, type: "text" as const, width: Math.max(14, h.length + 4) })), rows: t.rows },
    {
      name: "Hướng dẫn",
      columns: [{ header: "Cột", type: "text", width: 28 }, { header: "Bắt buộc", type: "text", width: 11 }, { header: "Ý nghĩa", type: "text", width: 90 }],
      rows: [
        ...d.columns.map((x) => [x.header, x.required ? "Có" : "", x.hint]),
        ["", "", ""],
        ["Lưu ý", "", `Xoá các dòng ví dụ (mã bắt đầu bằng VD-...) trước khi tải lên. Tối đa ${IMPORT_MAX_ROWS} dòng mỗi lần.`],
        ...d.notes.map((n) => ["", "", n]),
      ],
    },
  ]);
  return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": XLSX_MIME, "content-disposition": `attachment; filename="mau-nhap-${d.kind}.xlsx"`, "cache-control": "no-store" } });
});

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
importRoutes.get("/imports/:kind/template.csv", guard, (c) => {
  const d = kindDef(c);
  const t = templateRows(d);
  const csv = "﻿" + [t.header, ...t.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="mau-nhap-${d.kind}.csv"`, "cache-control": "no-store" } });
});

async function readUpload(c: Ctx) {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > IMPORT_MAX_BYTES + 64 * 1024) throw new AppError(422, "file_too_large", `File quá lớn (tối đa ${IMPORT_MAX_BYTES / 1024 / 1024}MB)`);
  let form: Record<string, string | File | (string | File)[]>;
  try { form = await c.req.parseBody(); } catch { throw new AppError(400, "invalid_form", "Hãy gửi file dạng multipart/form-data (trường \"file\")"); }
  const file = form.file;
  if (!file || typeof file === "string" || Array.isArray(file)) throw new AppError(422, "file_required", "Chưa chọn file");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const modeRaw = typeof form.mode === "string" ? form.mode : "skip";
  if (modeRaw !== "skip" && modeRaw !== "update") throw new AppError(422, "validation_error", "mode phải là skip hoặc update");
  return { bytes, filename: file.name || "import", mode: modeRaw as ImportMode };
}

async function sha256(bytes: Uint8Array) {
  const h = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function analyze(c: Ctx, d: KindDef, bytes: Uint8Array, filename: string) {
  const sheet = parseImportFile(bytes, filename);
  try {
    return { sheet, a: await d.analyze(c, sheet) };
  } catch (e) {
    if (e instanceof ImportFileError) throw new AppError(422, "missing_columns", e.message);
    throw e;
  }
}

const summarize = (rows: { status: string; errors: string[] }[]) => ({
  lines: rows.length,
  create: rows.filter((r) => r.status === "create" && !r.errors.length).length,
  exists: rows.filter((r) => r.status === "exists" && !r.errors.length).length,
  merged: rows.filter((r) => r.status === "merged" && !r.errors.length).length,
  error: rows.filter((r) => r.errors.length).length,
});

importRoutes.post("/imports/:kind/preview", guard, async (c) => {
  const d = kindDef(c);
  const { bytes, filename } = await readUpload(c);
  const { sheet, a } = await analyze(c, d, bytes, filename);
  for (const r of a.rows) if (r.errors.length) r.status = "error";
  return c.json({ kind: d.kind, filename, format: sheet.format, summary: summarize(a.rows), ignoredColumns: a.ignoredColumns, rows: a.rows });
});

importRoutes.post("/imports/:kind/commit", guard, async (c) => {
  const d = kindDef(c);
  const { bytes, filename, mode } = await readUpload(c);
  const { a } = await analyze(c, d, bytes, filename);
  const fileHash = await sha256(bytes);
  const built = a.build(mode, { fileHash, filename });
  const errorRows = a.rows.filter((r) => r.errors.length).length;
  if (built.created + built.updated === 0) {
    throw new AppError(422, "nothing_to_import", errorRows ? "Không có dòng hợp lệ nào để ghi — hãy sửa các dòng lỗi rồi tải lại" : "Không có dòng nào cần ghi (tất cả đã tồn tại và đang chọn bỏ qua)", { skipped: built.skipped, errors: errorRows });
  }
  try {
    await guarded(() => c.env.DB.batch(built.stmts), "Dữ liệu vừa bị trùng với một mã đã có (có người khác vừa thêm) — hãy xem trước lại");
  } catch (e) {
    if (String((e as Error)?.message ?? "").includes("once_keys")) throw conflict("already_done", "File này đã được nhập rồi (cùng nội dung, cùng cách xử lý mã trùng). Nếu đã sửa file, hãy lưu lại rồi tải lên lần nữa.");
    throw e;
  }
  return c.json({ kind: d.kind, filename, mode, created: built.created, updated: built.updated, skipped: built.skipped, errors: errorRows }, 201);
});
