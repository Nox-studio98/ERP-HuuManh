import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppBindings, Role } from "../env";
import { can, requirePerm, type Permission } from "../lib/rbac";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { nextCode, PREFIX } from "../lib/codes";
import { toMilli } from "../lib/money";
import { addDays } from "../services/debt";
import { vnDate, vnDayRangeUtc } from "../lib/time";
import { LOT_NOT_LOCKED_SQL, moveStatements } from "../services/stock";
import { assertStmt, onceStmt } from "../services/guard";
import { assertPeriodOpen } from "../services/period";
import { freeLotReservations, swapBadReservations } from "../services/reservations";
import { sysAuditStmt } from "../services/sysaudit";
import { enqueueJobStmt, kickJobs } from "../services/outbox";
import { addVnRange, deviceIdOf, getSetting, guarded, isExpired, pageParams, parseBody, unitFactor } from "../services/http";

export const inventoryRoutes = new Hono<AppBindings>();

type Ctx = Context<AppBindings>;
const DOC_TYPES = ["receipt", "waste", "adjust", "count", "transfer", "internal_use"] as const;
type DocType = (typeof DOC_TYPES)[number];

// ---------------------------------------------------------------- helpers
function normDate(s: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59+07:00` : s;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new AppError(422, "validation_error", "Ngày không hợp lệ");
  return new Date(t).toISOString();
}

const docSel = `SELECT d.*, u.full_name AS created_by_name FROM stock_docs d LEFT JOIN users u ON u.id = d.created_by`;

function docShape(d: any) {
  return {
    id: d.id, code: d.code, type: d.type, status: d.status, storeId: d.store_id,
    locationId: d.location_id, toLocationId: d.to_location_id, supplierId: d.supplier_id, supplierRef: d.supplier_ref,
    reason: d.reason, note: d.note, totalAmount: d.total_amount, createdBy: d.created_by, createdByName: d.created_by_name,
    createdAt: d.created_at, approvedBy: d.approved_by, postedAt: d.posted_at, version: d.version, vatAmount: d.vat_amount ?? 0,
    lockLots: !!d.lock_lots, transferStatus: d.transfer_status ?? null, receivedAt: d.received_at ?? null,
  };
}

async function loadDoc(db: D1Database, id: number) {
  const d = await db.prepare(`${docSel} WHERE d.id = ?`).bind(id).first<any>();
  if (!d) throw notFound("not_found", "Không tìm thấy chứng từ");
  return d;
}

async function loadLines(db: D1Database, docId: number, role: Role) {
  const { results } = await db
    .prepare(
      `SELECT l.*, p.name AS product_name, p.sku, lot.lot_code
         FROM stock_doc_lines l JOIN products p ON p.id = l.product_id LEFT JOIN lots lot ON lot.id = l.lot_id
        WHERE l.doc_id = ? ORDER BY l.id`,
    )
    .bind(docId)
    .all<any>();
  const cost = can(role, "prices.view_cost");
  return results.map((l) => ({
    id: l.id, docId: l.doc_id, productId: l.product_id, productName: l.product_name, sku: l.sku,
    lotId: l.lot_id, lotCode: l.lot_code, unit: l.unit, docQtyMilli: l.doc_qty_milli, qtyMilli: l.qty_milli,
    diffMilli: l.doc_qty_milli != null ? l.qty_milli - l.doc_qty_milli : null,
    // B-02: kiểm kê — tồn hệ thống tại thời điểm đếm (snapshot); chênh lệch khi ghi sổ = số đếm − snapshot
    systemQtyMilli: l.lot_id != null && l.doc_qty_milli != null ? l.doc_qty_milli : null,
    receivedQtyMilli: l.received_qty_milli ?? null, receivedLotId: l.received_lot_id ?? null, lostReason: l.lost_reason ?? null,
    expiresAt: l.expires_at, reason: l.reason, ...(cost ? { unitCost: l.unit_cost } : {}),
  }));
}

async function requireDraft(db: D1Database, id: number) {
  const d = await loadDoc(db, id);
  if (d.status !== "draft") throw conflict("doc_not_draft", "Chứng từ không còn ở trạng thái nháp");
  return d;
}

export async function loadLot(db: D1Database, id: number) {
  const lot = await db.prepare(`SELECT * FROM lots WHERE id = ?`).bind(id).first<any>();
  if (!lot) throw new AppError(422, "unknown_lot", "Không tìm thấy lô hàng");
  return lot;
}

const logScanStmt = (c: Ctx, code: string, context: string, result: string, message: string | null) =>
  c.env.DB
    .prepare(`INSERT INTO scan_events(user_id, device_id, code, context, result, message) VALUES (?,?,?,?,?,?)`)
    .bind(c.get("user").id, deviceIdOf(c), code, context, result, message);

// ---------------------------------------------------------------- chứng từ
inventoryRoutes.get("/stock-docs", requirePerm("inventory.view"), async (c) => {
  const { limit, cursor } = pageParams(c);
  const where: string[] = [];
  const binds: unknown[] = [];
  const { type, status, day, q: qs } = c.req.query();
  if (qs?.trim()) (where.push(`d.code LIKE ? ESCAPE '\\'`), binds.push(`%${qs.trim().replace(/[\\%_]/g, (m) => "\\" + m)}%`));
  if (!day) addVnRange(c.req.query(), "d.created_at", where, binds);
  if (type) (where.push("d.type = ?"), binds.push(type));
  if (status) (where.push("d.status = ?"), binds.push(status));
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError(422, "validation_error", "day phải dạng YYYY-MM-DD");
    const r = vnDayRangeUtc(day);
    where.push("d.created_at >= ? AND d.created_at < ?");
    binds.push(r.from, r.to);
  }
  if (cursor) (where.push("d.id < ?"), binds.push(cursor));
  const { results } = await c.env.DB
    .prepare(`${docSel} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<any>();
  return c.json({ items: results.slice(0, limit).map(docShape), nextCursor: results.length > limit ? results[limit - 1].id : null });
});

inventoryRoutes.get("/stock-docs/:id", requirePerm("inventory.view"), async (c) => {
  const d = await loadDoc(c.env.DB, Number(c.req.param("id")));
  return c.json({ ...docShape(d), lines: await loadLines(c.env.DB, d.id, c.get("user").role) });
});

const createDocBody = z.object({
  type: z.enum(DOC_TYPES),
  locationId: z.number().int().positive(),
  toLocationId: z.number().int().positive().nullish(),
  supplierId: z.number().int().positive().nullish(),
  supplierRef: z.string().trim().max(60).nullish(),
  vatAmount: z.number().int().min(0).max(10_000_000_000).optional(), // B-07: VAT đầu vào (VND) của phiếu nhập, chuyển sang hoá đơn mua khi ghi sổ
  reason: z.string().trim().max(200).nullish(),
  note: z.string().trim().max(500).nullish(),
  lockLots: z.boolean().optional(), // EC-18: chỉ phiếu kiểm kê — khoá xuất/bán các lô tại vị trí trong lúc đếm
});

inventoryRoutes.post("/stock-docs", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, createDocBody);
  const loc = await db.prepare(`SELECT id, store_id FROM locations WHERE id = ?`).bind(b.locationId).first<any>();
  if (!loc) throw new AppError(422, "invalid_location", "Vị trí kho không tồn tại");
  if (b.type === "transfer") {
    if (!b.toLocationId || b.toLocationId === b.locationId) throw new AppError(422, "validation_error", "Chuyển kho cần vị trí đích khác vị trí nguồn");
    const to = await db.prepare(`SELECT id FROM locations WHERE id = ?`).bind(b.toLocationId).first();
    if (!to) throw new AppError(422, "invalid_location", "Vị trí đích không tồn tại");
  }
  if (b.type === "internal_use" && (b.reason?.length ?? 0) < 3) {
    throw new AppError(422, "validation_error", "Xuất dùng nội bộ phải ghi rõ lý do / mục đích sử dụng", { fields: { reason: "Nhập lý do / mục đích (ít nhất 3 ký tự)" } });
  }
  if (b.type === "receipt" && b.supplierId) {
    const s = await db.prepare(`SELECT id FROM suppliers WHERE id = ?`).bind(b.supplierId).first();
    if (!s) throw new AppError(422, "invalid_supplier", "Nhà cung cấp không tồn tại");
  }
  const code = await nextCode(db, PREFIX[b.type]);
  const u = c.get("user");
  await guarded(() =>
    db.batch([
      db
        .prepare(
          `INSERT INTO stock_docs(code, type, store_id, location_id, to_location_id, supplier_id, supplier_ref, reason, note, created_by, vat_amount, lock_lots)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(code, b.type, loc.store_id, b.locationId, b.type === "transfer" ? b.toLocationId : null, b.type === "receipt" ? (b.supplierId ?? null) : null, b.supplierRef ?? null, b.reason ?? null, b.note ?? null, u.id, b.type === "receipt" && b.supplierId ? (b.vatAmount ?? 0) : 0, b.type === "count" && b.lockLots ? 1 : 0),
      auditStmt(c, { action: "stock_doc.create", entity: "stock_doc", entityId: code, after: b }),
    ]),
  );
  const d = await db.prepare(`${docSel} WHERE d.code = ?`).bind(code).first<any>();
  return c.json({ ...docShape(d), lines: [] }, 201);
});

// ---------------------------------------------------------------- dòng chứng từ
const receiptLine = z.object({
  productId: z.number().int().positive(),
  unit: z.string().trim().min(1),
  qty: z.number().min(0).max(1_000_000),
  docQty: z.number().min(0).max(1_000_000).optional(),
  unitCost: z.number().min(0).max(10_000_000_000),
  expiresAt: z.string().optional(),
});
const lotLine = z.object({
  lotId: z.number().int().positive(),
  qty: z.number().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Số lượng phải khác 0"),
  unit: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(100).optional(),
});
const internalUseLine = z
  .object({
    lotId: z.number().int().positive().optional(),
    productId: z.number().int().positive().optional(),
    qty: z.number().positive().max(1_000_000),
    unit: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(100).optional(),
  })
  .refine((v) => !!v.lotId !== !!v.productId, "Chọn lô hoặc mặt hàng (chỉ một trong hai)");
const countLine = z.object({
  lotId: z.number().int().positive(),
  countedQty: z.number().min(0).max(1_000_000),
  unit: z.string().trim().min(1),
});

inventoryRoutes.post("/stock-docs/:id/lines", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const doc = await requireDraft(db, Number(c.req.param("id")));
  const type = doc.type as DocType;
  const stmts: D1PreparedStatement[] = [];
  let lineSql: D1PreparedStatement | null = null;

  if (type === "receipt") {
    const b = await parseBody(c, receiptLine);
    const p = await db.prepare(`SELECT id, active FROM products WHERE id = ?`).bind(b.productId).first<any>();
    if (!p || !p.active) throw new AppError(422, "invalid_product", "Mặt hàng không tồn tại hoặc đã ngừng kinh doanh");
    const f = await unitFactor(db, b.productId, b.unit);
    const qty = toMilli(b.qty, f);
    const docQty = b.docQty != null ? toMilli(b.docQty, f) : qty;
    const unitCost = Math.round((b.unitCost * 1000) / f);
    lineSql = db
      .prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, unit, doc_qty_milli, qty_milli, unit_cost, expires_at, amount) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(doc.id, b.productId, b.unit, docQty, qty, unitCost, b.expiresAt ? normDate(b.expiresAt) : null, Math.round(b.qty * b.unitCost));
  } else if (type === "internal_use") {
    // Xuất dùng nội bộ: chọn đích danh lô (lotId) hoặc chỉ nêu mặt hàng + số lượng để hệ thống chọn lô theo FEFO (hết hạn trước xuất trước)
    const b = await parseBody(c, internalUseLine);
    const lines: { lot: any; qtyMilli: number; unit: string }[] = [];
    if (b.lotId) {
      const lot = await loadLot(db, b.lotId);
      if (lot.location_id !== doc.location_id) throw new AppError(422, "not_in_doc", "Lô không thuộc vị trí của chứng từ");
      if (isExpired(lot)) throw new AppError(422, "lot_expired", "Lô đã hết hạn, chỉ được xuất qua phiếu hao hụt");
      if (lot.status !== "active") throw new AppError(422, "lot_not_active", "Lô đang cách ly / không hoạt động, không thể xuất", { lotId: lot.id, status: lot.status });
      lines.push({ lot, qtyMilli: toMilli(b.qty, await unitFactor(db, lot.product_id, b.unit)), unit: b.unit });
    } else {
      const f = await unitFactor(db, b.productId!, b.unit);
      let need = toMilli(b.qty, f);
      const { results: cand } = await db
        .prepare(
          `SELECT l.* FROM lots l WHERE l.product_id = ? AND l.location_id = ? AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?)
              AND l.qty_on_hand_milli - l.qty_reserved_milli > 0 AND ${LOT_NOT_LOCKED_SQL}
            ORDER BY (l.expires_at IS NULL), l.expires_at, l.received_at, l.id`,
        )
        .bind(b.productId, doc.location_id, new Date().toISOString())
        .all<any>();
      const taken = new Map<number, number>();
      for (const l of (await db.prepare(`SELECT lot_id, SUM(qty_milli) q FROM stock_doc_lines WHERE doc_id = ? GROUP BY lot_id`).bind(doc.id).all<any>()).results) taken.set(l.lot_id, l.q);
      for (const lot of cand) {
        if (need <= 0) break;
        const avail = lot.qty_on_hand_milli - lot.qty_reserved_milli - (taken.get(lot.id) ?? 0);
        const take = Math.min(avail, need);
        if (take > 0) { lines.push({ lot, qtyMilli: take, unit: b.unit }); need -= take; }
      }
      if (need > 0) throw conflict("insufficient_stock", "Không đủ tồn khả dụng tại vị trí này để xuất", { productId: b.productId, requestedMilli: toMilli(b.qty, f), missingMilli: need });
    }
    for (const l of lines) {
      stmts.push(db.prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, qty_milli, unit_cost, expires_at, reason) VALUES (?,?,?,?,?,?,?,?)`).bind(doc.id, l.lot.product_id, l.lot.id, l.unit, l.qtyMilli, l.lot.unit_cost, l.lot.expires_at, b.reason ?? null));
    }
  } else if (type === "count") {
    const b = await parseBody(c, countLine);
    const lot = await loadLot(db, b.lotId);
    if (lot.location_id !== doc.location_id) throw new AppError(422, "not_in_doc", "Lô không thuộc vị trí đang kiểm kê");
    const f = await unitFactor(db, lot.product_id, b.unit);
    const counted = toMilli(b.countedQty, f);
    const existing = await db.prepare(`SELECT id FROM stock_doc_lines WHERE doc_id = ? AND lot_id = ?`).bind(doc.id, lot.id).first<any>();
    lineSql = existing
      ? db.prepare(`UPDATE stock_doc_lines SET qty_milli = ?, doc_qty_milli = ?, unit = ? WHERE id = ?`).bind(counted, lot.qty_on_hand_milli, b.unit, existing.id)
      : db
          .prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, doc_qty_milli, qty_milli, unit_cost) VALUES (?,?,?,?,?,?,?)`)
          .bind(doc.id, lot.product_id, lot.id, b.unit, lot.qty_on_hand_milli, counted, lot.unit_cost);
  } else {
    const b = await parseBody(c, lotLine);
    const lot = await loadLot(db, b.lotId);
    if (lot.location_id !== doc.location_id) throw new AppError(422, "not_in_doc", "Lô không thuộc vị trí của chứng từ");
    if (type !== "adjust" && b.qty < 0) throw new AppError(422, "validation_error", "Số lượng phải lớn hơn 0");
    if (type !== "waste" && isExpired(lot)) throw new AppError(422, "lot_expired", "Lô đã hết hạn, chỉ được xuất qua phiếu hao hụt");
    if (type === "transfer" && lot.status !== "active") throw new AppError(422, "lot_not_active", "Lô đang cách ly / không hoạt động, không thể chuyển kho", { lotId: lot.id, status: lot.status });
    if ((type === "waste" || type === "adjust") && !b.reason) throw new AppError(422, "validation_error", "Cần nhập lý do");
    const f = await unitFactor(db, lot.product_id, b.unit);
    lineSql = db
      .prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, qty_milli, unit_cost, expires_at, reason) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(doc.id, lot.product_id, lot.id, b.unit, toMilli(b.qty, f), lot.unit_cost, lot.expires_at, b.reason ?? null);
  }
  if (lineSql) stmts.push(lineSql);
  stmts.push(auditStmt(c, { action: "stock_doc.line_add", entity: "stock_doc", entityId: doc.id, after: { type } }));
  await db.batch(stmts);
  return c.json({ ...docShape(doc), lines: await loadLines(db, doc.id, c.get("user").role) }, 201);
});

inventoryRoutes.delete("/stock-docs/:id/lines/:lineId", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const doc = await requireDraft(db, Number(c.req.param("id")));
  const lineId = Number(c.req.param("lineId"));
  const line = await db.prepare(`SELECT * FROM stock_doc_lines WHERE id = ? AND doc_id = ?`).bind(lineId, doc.id).first<any>();
  if (!line) throw notFound("not_found", "Không tìm thấy dòng");
  await db.batch([
    db.prepare(`DELETE FROM stock_doc_lines WHERE id = ? AND doc_id = ?`).bind(lineId, doc.id),
    auditStmt(c, { action: "stock_doc.line_delete", entity: "stock_doc", entityId: doc.id, before: line }),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- quét mã (M2-16)
const scanBody = z.object({
  code: z.string().trim().min(1).max(100),
  qty: z.number().positive().max(1_000_000).optional(),
  unit: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).max(100).optional(),
});

inventoryRoutes.post("/stock-docs/:id/scan", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const doc = await requireDraft(db, Number(c.req.param("id")));
  const b = await parseBody(c, scanBody);
  const type = doc.type as DocType;
  const context = `${type}:${doc.id}`;
  const fail = async (result: string, code: string, message: string, details?: unknown): Promise<never> => {
    await logScanStmt(c, b.code, context, result, message).run();
    throw new AppError(422, code, message, details);
  };

  const lot = await db.prepare(`SELECT * FROM lots WHERE lot_code = ?`).bind(b.code).first<any>();
  let productId: number | null = lot?.product_id ?? null;
  let matchedUnit: string | null = null;
  if (!lot) {
    const pr = await db.prepare(`SELECT id FROM products WHERE barcode = ? OR sku = ?`).bind(b.code, b.code).first<any>();
    if (pr) productId = pr.id;
    else {
      const un = await db.prepare(`SELECT product_id, unit FROM product_units WHERE barcode = ?`).bind(b.code).first<any>();
      if (un) (productId = un.product_id, (matchedUnit = un.unit));
    }
  }
  if (productId == null) return fail("unknown", "unknown_code", "Mã không tồn tại trong hệ thống", { code: b.code });
  const product = await db.prepare(`SELECT id, base_unit FROM products WHERE id = ?`).bind(productId).first<any>();
  const unit = b.unit ?? matchedUnit ?? product.base_unit;
  const f = await unitFactor(db, productId, unit);
  const qtyMilli = toMilli(b.qty ?? 1, f);
  const okScan = logScanStmt(c, b.code, context, "ok", null);

  if (type === "receipt") {
    const line = await db.prepare(`SELECT id FROM stock_doc_lines WHERE doc_id = ? AND product_id = ? ORDER BY id LIMIT 1`).bind(doc.id, productId).first<any>();
    if (!line) return fail("not_in_doc", "not_in_doc", "Mặt hàng không có trong phiếu nhập", { productId });
    await db.batch([
      db.prepare(`UPDATE stock_doc_lines SET qty_milli = qty_milli + ?, amount = NULL WHERE id = ?`).bind(qtyMilli, line.id),
      okScan,
      auditStmt(c, { action: "stock_doc.scan", entity: "stock_doc", entityId: doc.id, after: { code: b.code, qtyMilli } }),
    ]);
  } else {
    if (!lot) return fail("unknown", "unknown_code", "Cần quét tem mã lô của hàng", { code: b.code });
    if (lot.location_id !== doc.location_id) return fail("not_in_doc", "not_in_doc", "Lô không thuộc vị trí của chứng từ", { lotId: lot.id });
    if ((type === "adjust" || type === "transfer" || type === "internal_use") && isExpired(lot)) return fail("expired", "lot_expired", "Lô đã hết hạn, chỉ được xuất qua phiếu hao hụt", { lotId: lot.id });
    if (type === "transfer" && lot.status !== "active") return fail("not_active", "lot_not_active", "Lô đang cách ly / không hoạt động, không thể chuyển kho", { lotId: lot.id, status: lot.status });
    const existing = await db.prepare(`SELECT id FROM stock_doc_lines WHERE doc_id = ? AND lot_id = ?`).bind(doc.id, lot.id).first<any>();
    if (existing) {
      if (type !== "count") return fail("duplicate", "duplicate_scan", "Lô này đã được quét trong chứng từ", { lineId: existing.id });
      await db.batch([
        db.prepare(`UPDATE stock_doc_lines SET qty_milli = qty_milli + ? WHERE id = ?`).bind(qtyMilli, existing.id),
        okScan,
        auditStmt(c, { action: "stock_doc.scan", entity: "stock_doc", entityId: doc.id, after: { code: b.code, qtyMilli } }),
      ]);
    } else {
      const ins =
        type === "count"
          ? db
              .prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, doc_qty_milli, qty_milli, unit_cost) VALUES (?,?,?,?,?,?,?)`)
              .bind(doc.id, productId, lot.id, unit, lot.qty_on_hand_milli, qtyMilli, lot.unit_cost)
          : db
              .prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, lot_id, unit, qty_milli, unit_cost, expires_at, reason) VALUES (?,?,?,?,?,?,?,?)`)
              .bind(doc.id, productId, lot.id, unit, qtyMilli, lot.unit_cost, lot.expires_at, b.reason ?? "khac");
      await db.batch([ins, okScan, auditStmt(c, { action: "stock_doc.scan", entity: "stock_doc", entityId: doc.id, after: { code: b.code, qtyMilli } })]);
    }
  }
  return c.json({ ...docShape(doc), lines: await loadLines(db, doc.id, c.get("user").role) }, 201);
});

// ---------------------------------------------------------------- post / duyệt
interface Plan {
  stmts: D1PreparedStatement[];
  total: number;
  approvalReason: string | null;
  variances: { lineId: number; productId: number; docQtyMilli: number; qtyMilli: number }[];
  /** Cảnh báo không chặn (vd. kiểm kê: lô có biến động giữa lúc đếm và lúc ghi sổ). */
  warnings: { code: string; lotId: number; lotCode: string; snapshotMilli: number; currentMilli: number; deltaMilli: number }[];
  /** B-18: phiếu nhập — giá trị lô (đơn giá/đv chính làm tròn × SL) trừ tổng hoá đơn mua; ≠ 0 khi quy đổi thùng→kg làm tròn. Ghi vào nhật ký để đối chiếu. */
  roundingDiff: number;
}

/**
 * B-03: bảo đảm lô còn đủ `out` khả dụng (tồn − đã giữ). Nếu chỉ thiếu vì phần giữ cho đơn → chuyển phần giữ sang lô khác (FEFO);
 * không chuyển được → 409 kèm reservedQty và gợi ý cách ly lô.
 */
export async function ensureAvailable(db: D1Database, lotId: number, out: number) {
  let lot = await loadLot(db, lotId);
  const detail = (l: any) => ({ lotId, requestedMilli: out, availableMilli: l.qty_on_hand_milli - l.qty_reserved_milli, onHandMilli: l.qty_on_hand_milli, reservedQty: l.qty_reserved_milli });
  if (out > lot.qty_on_hand_milli) throw conflict("insufficient_stock", "Không đủ tồn khả dụng của lô", detail(lot));
  if (out > lot.qty_on_hand_milli - lot.qty_reserved_milli) {
    const left = await freeLotReservations(db, lotId, out);
    lot = await loadLot(db, lotId);
    if (left > 0) {
      throw conflict("insufficient_stock", "Lô đang được giữ cho đơn hàng và không còn lô khác để chuyển phần giữ — hãy cách ly lô hỏng (POST /lots/:id/quarantine) để nhả/đổi lô cho đơn, hoặc xử lý đơn trước", { ...detail(lot), hint: "quarantine" });
    }
  }
  return lot;
}

async function planPost(c: Ctx, doc: any, approvedBy: number | null): Promise<Plan> {
  const db = c.env.DB;
  const u = c.get("user");
  const type = doc.type as DocType;
  const { results: lines } = await db.prepare(`SELECT * FROM stock_doc_lines WHERE doc_id = ? ORDER BY id`).bind(doc.id).all<any>();
  if (!lines.length) throw new AppError(422, "empty_doc", "Chứng từ chưa có dòng nào");
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let total = 0;
  let approvalReason: string | null = null;
  const variances: Plan["variances"] = [];
  const warnings: Plan["warnings"] = [];
  let lotValue = 0;
  const creator = await db.prepare(`SELECT role FROM users WHERE id = ?`).bind(doc.created_by).first<{ role: Role }>();
  const creatorCanApprove = !!creator && can(creator.role, "inventory.approve");
  const val = (cost: number, qty: number) => Math.round((cost * Math.abs(qty)) / 1000);

  const lotIds = [...new Set(lines.filter((l) => l.lot_id).map((l) => l.lot_id as number))];
  const lots = new Map<number, any>();
  for (const id of lotIds) lots.set(id, await loadLot(db, id));

  if (type === "receipt") {
    for (const l of lines) {
      if (l.qty_milli <= 0) throw new AppError(422, "zero_qty", "Có dòng chưa nhập số lượng thực nhận", { lineId: l.id });
      const prod = await db.prepare(`SELECT shelf_life_days FROM products WHERE id = ?`).bind(l.product_id).first<any>();
      const expires = l.expires_at ?? (prod?.shelf_life_days ? new Date(Date.now() + prod.shelf_life_days * 86400_000).toISOString() : null);
      const tmp = `TMP-${crypto.randomUUID()}`;
      lotValue += val(l.unit_cost, l.qty_milli);
      total += l.amount ?? val(l.unit_cost, l.qty_milli); // thành tiền theo đơn giá chứng từ, làm tròn một lần (audit #13)
      if (l.doc_qty_milli != null && l.doc_qty_milli !== l.qty_milli) variances.push({ lineId: l.id, productId: l.product_id, docQtyMilli: l.doc_qty_milli, qtyMilli: l.qty_milli });
      stmts.push(
        db
          .prepare(
            `INSERT INTO lots(lot_code, product_id, location_id, supplier_id, receipt_doc_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(tmp, l.product_id, doc.location_id, doc.supplier_id, doc.id, now, expires, l.unit_cost, l.qty_milli, l.qty_milli),
        db
          .prepare(
            `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
             SELECT id, product_id, qty_in_milli, unit_cost, 'receipt', 'stock_doc', ?, ? FROM lots WHERE lot_code = ?`,
          )
          .bind(doc.id, doc.created_by, tmp),
        db.prepare(`UPDATE stock_doc_lines SET lot_id = (SELECT id FROM lots WHERE lot_code = ?), expires_at = ? WHERE id = ?`).bind(tmp, expires, l.id),
        db.prepare(`UPDATE lots SET lot_code = 'HML' || substr('00000000' || id, -8) WHERE lot_code = ?`).bind(tmp),
      );
    }
    // M5: phiếu nhập có NCC → sinh hoá đơn mua (phải trả) trong cùng batch; không có supplier_ref → tạm tính (EC-30)
    if (doc.supplier_id && total > 0) {
      const sup = await db.prepare(`SELECT payment_terms_days d FROM suppliers WHERE id = ?`).bind(doc.supplier_id).first<{ d: number | null }>();
      const issue = vnDate();
      const ref = typeof doc.supplier_ref === "string" ? doc.supplier_ref.trim() : "";
      const vat = doc.vat_amount ?? 0;
      if (vat > total) throw new AppError(422, "vat_exceeds_total", "VAT đầu vào không được lớn hơn tổng tiền phiếu nhập", { vatAmount: vat, total });
      stmts.push(
        db
          .prepare(
            `INSERT INTO supplier_bills(code, supplier_id, stock_doc_id, supplier_ref, is_provisional, issue_date, due_date, total, created_by, vat_amount)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(await nextCode(db, "CNP"), doc.supplier_id, doc.id, ref || null, ref ? 0 : 1, issue, addDays(issue, sup?.d ?? 0), total, doc.created_by, vat),
      );
    }
  } else if (type === "count") {
    const countDiffMax = await getSetting(db, "approval.count_diff_vnd", 1_000_000);
    let diffValue = 0;
    const reduceByLot = new Map<number, number>();
    const counted: { l: any; diff: number }[] = [];
    for (const l of lines) {
      const lot = lots.get(l.lot_id)!;
      // B-02: chênh lệch = số đếm − tồn hệ thống LÚC ĐẾM (snapshot doc_qty_milli), không phải tồn lúc ghi sổ.
      // Biến động hợp lệ giữa lúc đếm và lúc post (bán, hao hụt) được giữ nguyên, không thành chênh lệch ảo.
      const snapshot = l.doc_qty_milli ?? lot.qty_on_hand_milli;
      const diff = l.qty_milli - snapshot;
      if (lot.qty_on_hand_milli !== snapshot) {
        warnings.push({ code: "lot_moved_since_count", lotId: lot.id, lotCode: lot.lot_code, snapshotMilli: snapshot, currentMilli: lot.qty_on_hand_milli, deltaMilli: lot.qty_on_hand_milli - snapshot });
      }
      if (lot.qty_on_hand_milli + diff < 0) {
        throw conflict("count_stale", "Tồn lô đã giảm sau khi đếm — số đếm không còn phù hợp, hãy đếm lại lô này", { lotId: lot.id, snapshotMilli: snapshot, currentMilli: lot.qty_on_hand_milli, countedMilli: l.qty_milli });
      }
      if (diff < 0) reduceByLot.set(lot.id, (reduceByLot.get(lot.id) ?? 0) - diff);
      counted.push({ l, diff });
    }
    for (const [lotId, out] of reduceByLot) lots.set(lotId, await ensureAvailable(db, lotId, out));
    for (const { l, diff } of counted) {
      const lot = lots.get(l.lot_id)!;
      if (diff !== 0) {
        diffValue += val(lot.unit_cost, diff);
        stmts.push(...moveStatements(db, lot.product_id, [{ lotId: lot.id, qtyMilli: Math.abs(diff), unitCost: lot.unit_cost }], diff > 0 ? 1 : -1, "adjust", "stock_doc", doc.id, doc.created_by));
      }
    }
    total = diffValue;
    if (diffValue > countDiffMax) approvalReason = `Chênh lệch kiểm kê ${diffValue}đ vượt ngưỡng ${countDiffMax}đ`;
    // B-10: mọi thay đổi tồn phải có người duyệt — người lập không có quyền duyệt mà có chênh lệch thì chờ duyệt
    else if (counted.some((x) => x.diff !== 0) && !creatorCanApprove) approvalReason = "Người lập phiếu kiểm kê không có quyền duyệt chênh lệch tồn";
  } else {
    // waste | adjust | transfer | internal_use: kiểm tra khả dụng theo từng lô (gộp các dòng cùng lô)
    if (type === "internal_use") await assertPeriodOpen(db, new Date(), "phiếu xuất dùng nội bộ");
    const lock = await db
      .prepare(`SELECT code FROM stock_docs WHERE type = 'count' AND lock_lots = 1 AND status IN ('draft','pending_approval') AND location_id = ? AND id <> ? LIMIT 1`)
      .bind(doc.location_id, doc.id)
      .first<{ code: string }>();
    if (lock) throw conflict("count_in_progress", `Vị trí đang kiểm kê (${lock.code}) và đã khoá lô — hoàn tất hoặc huỷ phiếu kiểm kê trước`, { countDoc: lock.code });
    const outPerLot = new Map<number, number>();
    for (const l of lines) {
      const lot = lots.get(l.lot_id)!;
      if (type !== "waste" && isExpired(lot, now)) throw new AppError(422, "lot_expired", "Lô đã hết hạn, chỉ được xuất qua phiếu hao hụt", { lotId: lot.id });
      if (type === "transfer" && lot.status !== "active") throw new AppError(422, "lot_not_active", "Lô đang cách ly / không hoạt động, không thể chuyển kho", { lotId: lot.id, status: lot.status });
      if (lot.location_id !== doc.location_id) throw new AppError(422, "not_in_doc", "Lô không còn ở vị trí của chứng từ", { lotId: lot.id });
      const out = type === "adjust" ? Math.max(-l.qty_milli, 0) : l.qty_milli;
      outPerLot.set(lot.id, (outPerLot.get(lot.id) ?? 0) + out);
    }
    // B-03: vượt phần khả dụng nhưng còn trong tồn → thử chuyển phần giữ của đơn sang lô khác trước khi báo lỗi
    for (const [lotId, out] of outPerLot) lots.set(lotId, await ensureAvailable(db, lotId, out));
    if (type === "waste") {
      const pct = await getSetting(db, "approval.waste_pct_bp", 500);
      for (const [lotId, out] of outPerLot) {
        const lot = lots.get(lotId)!;
        const prior = await db.prepare(`SELECT COALESCE(-SUM(qty_delta_milli),0) q FROM stock_moves WHERE lot_id = ? AND move_type = 'waste'`).bind(lotId).first<{ q: number }>();
        if (out + (prior?.q ?? 0) > (lot.qty_in_milli * pct) / 10000) approvalReason = `Hao hụt vượt ${pct / 100}% lượng nhập của lô ${lot.lot_code}`;
      }
      if (!approvalReason && !creatorCanApprove) approvalReason = "Người lập phiếu không có quyền duyệt hao hụt";
    }
    if (type === "internal_use") {
      // Giá trị xuất theo giá vốn lô vượt ngưỡng → duyệt; người lập không có quyền duyệt kho → luôn chờ duyệt (giống điều chỉnh tồn)
      const max = await getSetting(db, "approval.internal_use_vnd", 500_000);
      const v = lines.reduce((s, l) => s + val(lots.get(l.lot_id)!.unit_cost, l.qty_milli), 0);
      if (v > max) approvalReason = `Giá trị xuất dùng nội bộ ${v}đ vượt ngưỡng ${max}đ`;
      else if (!creatorCanApprove) approvalReason = "Người lập phiếu không có quyền duyệt xuất dùng nội bộ";
    }
    if (type === "adjust") {
      const countDiffMax = await getSetting(db, "approval.count_diff_vnd", 1_000_000);
      const v = lines.reduce((s, l) => s + val(lots.get(l.lot_id)!.unit_cost, l.qty_milli), 0);
      if (v > countDiffMax) approvalReason = `Giá trị điều chỉnh ${v}đ vượt ngưỡng ${countDiffMax}đ`;
      else if (!creatorCanApprove) approvalReason = "Người lập phiếu không có quyền duyệt điều chỉnh tồn";
    }
    for (const l of lines) {
      const lot = lots.get(l.lot_id)!;
      total += val(lot.unit_cost, l.qty_milli);
      const alloc = [{ lotId: lot.id, qtyMilli: Math.abs(l.qty_milli), unitCost: lot.unit_cost }];
      if (type === "waste") stmts.push(...moveStatements(db, lot.product_id, alloc, -1, "waste", "stock_doc", doc.id, doc.created_by));
      else if (type === "internal_use") stmts.push(...moveStatements(db, lot.product_id, alloc, -1, "internal_use", "stock_doc", doc.id, doc.created_by));
      else if (type === "adjust") stmts.push(...moveStatements(db, lot.product_id, alloc, l.qty_milli > 0 ? 1 : -1, "adjust", "stock_doc", doc.id, doc.created_by));
      else {
        // B-19 / EC-21: chuyển kho 2 bước — chỉ xuất khỏi lô nguồn (đang đi đường, không bán được ở đâu cả);
        // lô mới tại vị trí đích chỉ được tạo khi nhận hàng (POST /stock-docs/:id/receive)
        stmts.push(...moveStatements(db, lot.product_id, alloc, -1, "transfer_out", "stock_doc", doc.id, doc.created_by));
      }
    }
    if (type === "transfer") stmts.push(db.prepare(`UPDATE stock_docs SET transfer_status = 'in_transit' WHERE id = ?`).bind(doc.id));
  }
  void u;
  void approvedBy;
  return { stmts, total, approvalReason, variances, warnings, roundingDiff: type === "receipt" ? lotValue - total : 0 };
}

function postedStmts(c: Ctx, doc: any, plan: Plan, approvedBy: number | null) {
  const db = c.env.DB;
  return [
    // Chốt chặn (audit #8): post/huỷ đồng thời — chỉ chứng từ còn nháp/chờ duyệt mới được ghi sổ
    assertStmt(db, "stock_doc.post", `SELECT status IN ('draft','pending_approval') FROM stock_docs WHERE id = ?`, [doc.id]),
    // Khoá chống post trùng: lần thứ hai vi phạm PRIMARY KEY → cả batch rollback (migrations/0002)
    db.prepare(`INSERT INTO stock_doc_post_guard(doc_id) VALUES (?)`).bind(doc.id),
    db
      .prepare(`UPDATE stock_docs SET status='posted', posted_at=?, total_amount=?, approved_by=?, version=version+1 WHERE id=? AND status IN ('draft','pending_approval')`)
      .bind(new Date().toISOString(), plan.total, approvedBy, doc.id),
    ...plan.stmts,
    auditStmt(c, { action: `stock_doc.post.${doc.type}`, entity: "stock_doc", entityId: doc.id, before: { status: doc.status }, after: { status: "posted", total: plan.total, variances: plan.variances, ...(plan.roundingDiff ? { roundingDiff: plan.roundingDiff } : {}), ...(plan.warnings.length ? { warnings: plan.warnings } : {}) } }),
  ];
}

inventoryRoutes.post("/stock-docs/:id/post", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const doc = await loadDoc(db, id);
  if (doc.status !== "draft") throw conflict("doc_not_draft", doc.status === "pending_approval" ? "Chứng từ đang chờ duyệt" : "Chứng từ đã được xử lý");
  const plan = await planPost(c, doc, null);
  const u = c.get("user");
  const approvalReason = plan.approvalReason;
  if (approvalReason) {
    await guarded(() => db.batch([
      assertStmt(db, "stock_doc.request", `SELECT status = 'draft' FROM stock_docs WHERE id = ?`, [id]),
      db.prepare(`UPDATE stock_docs SET status='pending_approval', version=version+1 WHERE id=? AND status='draft'`).bind(id),
      db
        .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('stock_doc.post','stock_doc',?,?,?,?)`)
        .bind(String(id), JSON.stringify({ code: doc.code, type: doc.type, totalAmount: plan.total }), approvalReason, u.id),
      auditStmt(c, { action: "stock_doc.request_approval", entity: "stock_doc", entityId: id, reason: approvalReason, after: { status: "pending_approval" } }),
    ]));
    const ap = await db.prepare(`SELECT id FROM approvals WHERE ref_type='stock_doc' AND ref_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).bind(String(id)).first<any>();
    const d = await loadDoc(db, id);
    return c.json({ ...docShape(d), status: "pending_approval", approvalId: ap?.id ?? null, approvalReason: plan.approvalReason, warnings: plan.warnings });
  }
  await guarded(() => db.batch(postedStmts(c, doc, plan, doc.created_by === u.id ? null : u.id)));
  const d = await loadDoc(db, id);
  return c.json({ ...docShape(d), variances: plan.variances, warnings: plan.warnings, roundingDiff: plan.roundingDiff, lines: await loadLines(db, id, u.role) });
});

/**
 * Áp dụng tác động khi chứng từ kho đã được duyệt (gọi từ /approvals/:id/decide).
 * Người duyệt = user hiện tại trong context. Bỏ qua kiểm tra ngưỡng duyệt; vẫn kiểm tra tồn khả dụng.
 */
export async function applyStockDocPost(c: Ctx, docId: number) {
  const db = c.env.DB;
  const doc = await loadDoc(db, docId);
  if (doc.status !== "pending_approval" && doc.status !== "draft") throw conflict("doc_not_pending", "Chứng từ không ở trạng thái chờ duyệt");
  const plan = await planPost(c, doc, c.get("user").id);
  await guarded(() => db.batch(postedStmts(c, doc, plan, c.get("user").id)));
  return { ...docShape(await loadDoc(db, docId)), warnings: plan.warnings };
}

/** Khi yêu cầu duyệt bị từ chối: trả chứng từ về nháp để người lập chỉnh sửa hoặc huỷ. */
export async function rejectStockDocPost(c: Ctx, docId: number, note?: string) {
  const db = c.env.DB;
  const doc = await loadDoc(db, docId);
  if (doc.status !== "pending_approval") return docShape(doc);
  await db.batch([
    assertStmt(db, "stock_doc.reject", `SELECT status = 'pending_approval' FROM stock_docs WHERE id = ?`, [docId]),
    db.prepare(`UPDATE stock_docs SET status='draft', version=version+1 WHERE id=? AND status='pending_approval'`).bind(docId),
    auditStmt(c, { action: "stock_doc.approval_rejected", entity: "stock_doc", entityId: docId, reason: note, after: { status: "draft" } }),
  ]);
  return docShape(await loadDoc(db, docId));
}

inventoryRoutes.post("/stock-docs/:id/cancel", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const doc = await loadDoc(db, id);
  if (doc.status !== "draft" && doc.status !== "pending_approval") throw conflict("doc_not_cancellable", "Chỉ huỷ được chứng từ nháp hoặc đang chờ duyệt");
  const u = c.get("user");
  await db.batch([
    assertStmt(db, "stock_doc.cancel", `SELECT status IN ('draft','pending_approval') FROM stock_docs WHERE id = ?`, [id]),
    db.prepare(`UPDATE stock_docs SET status='cancelled', version=version+1 WHERE id=? AND status IN ('draft','pending_approval')`).bind(id),
    db
      .prepare(`UPDATE approvals SET status='rejected', decided_by=?, decided_at=?, decision_note='Chứng từ đã huỷ' WHERE ref_type='stock_doc' AND ref_id=? AND status='pending'`)
      .bind(u.id, new Date().toISOString(), String(id)),
    auditStmt(c, { action: "stock_doc.cancel", entity: "stock_doc", entityId: id, before: { status: doc.status }, after: { status: "cancelled" } }),
  ]);
  return c.json(docShape(await loadDoc(db, id)));
});

// ---------------------------------------------------------------- nhận hàng chuyển kho (B-19 / EC-21)
const receiveBody = z.object({
  reason: z.string().trim().min(1).max(200).optional(), // lý do hao hụt chung cho các dòng nhận thiếu
  lines: z
    .array(z.object({ lineId: z.number().int().positive(), qty: z.number().min(0).max(1_000_000), reason: z.string().trim().min(1).max(200).optional() }))
    .optional(), // không gửi = nhận đủ; dòng không liệt kê = nhận đủ
});

inventoryRoutes.post("/stock-docs/:id/receive", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const id = Number(c.req.param("id"));
  const b = await parseBody(c, receiveBody.default({}));
  const doc = await loadDoc(db, id);
  if (doc.type !== "transfer" || doc.status !== "posted") throw conflict("not_transfer", "Chỉ nhận được phiếu chuyển kho đã xuất");
  if (doc.transfer_status !== "in_transit") throw conflict("already_received", "Phiếu chuyển kho này đã được nhận");
  const { results: lines } = await db.prepare(`SELECT * FROM stock_doc_lines WHERE doc_id = ? ORDER BY id`).bind(id).all<any>();
  const want = new Map((b.lines ?? []).map((x) => [x.lineId, x]));
  for (const x of b.lines ?? []) if (!lines.some((l) => l.id === x.lineId)) throw new AppError(422, "line_not_in_doc", "Dòng không thuộc phiếu", { lineId: x.lineId });
  const threshold = await getSetting(db, "approval.count_diff_vnd", 1_000_000);
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, "transfer.receive", `SELECT status = 'posted' AND transfer_status = 'in_transit' FROM stock_docs WHERE id = ?`, [id]),
    onceStmt(db, "transfer.receive", id),
    db.prepare(`UPDATE stock_docs SET transfer_status = 'received', received_at = ?, received_by = ?, version = version + 1 WHERE id = ?`).bind(now, u.id, id),
  ];
  const summary: { lineId: number; sentMilli: number; receivedMilli: number; lostMilli: number }[] = [];
  let lostValue = 0;
  for (const l of lines) {
    const src = await loadLot(db, l.lot_id);
    const w = want.get(l.id);
    const received = w ? toMilli(w.qty, await unitFactor(db, l.product_id, l.unit)) : l.qty_milli;
    if (received > l.qty_milli) throw new AppError(422, "over_receive", "Số nhận vượt số đã chuyển", { lineId: l.id, sentMilli: l.qty_milli });
    const lost = l.qty_milli - received;
    const reason = w?.reason ?? b.reason ?? null;
    if (lost > 0 && !reason) throw new AppError(422, "reason_required", "Nhận thiếu hàng cần ghi lý do hao hụt", { lineId: l.id, lostMilli: lost });
    lostValue += Math.round((src.unit_cost * lost) / 1000);
    const tmp = `TMP-${crypto.randomUUID()}`;
    stmts.push(
      // giữ nguyên ngày nhập / hạn dùng / giá vốn / qty_in gốc của lô nguồn → % hao hụt tính theo lượng nhập ban đầu
      db
        .prepare(
          `INSERT INTO lots(lot_code, product_id, location_id, supplier_id, receipt_doc_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(tmp, l.product_id, doc.to_location_id, src.supplier_id, src.receipt_doc_id, src.received_at, src.expires_at, src.unit_cost, src.qty_in_milli, l.qty_milli),
      db
        .prepare(
          `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
           SELECT id, product_id, qty_on_hand_milli, unit_cost, 'transfer_in', 'stock_doc', ?, ? FROM lots WHERE lot_code = ?`,
        )
        .bind(id, u.id, tmp),
    );
    if (lost > 0) {
      stmts.push(
        db.prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli - ? WHERE lot_code = ?`).bind(lost, tmp),
        db
          .prepare(
            `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
             SELECT id, product_id, ?, unit_cost, 'waste', 'stock_doc', ?, ? FROM lots WHERE lot_code = ?`,
          )
          .bind(-lost, id, u.id, tmp),
      );
    }
    stmts.push(
      db.prepare(`UPDATE stock_doc_lines SET received_qty_milli = ?, received_lot_id = (SELECT id FROM lots WHERE lot_code = ?), lost_reason = ? WHERE id = ?`).bind(received, tmp, lost > 0 ? reason : null, l.id),
      db.prepare(`UPDATE lots SET lot_code = 'HML' || substr('00000000' || id, -8) WHERE lot_code = ?`).bind(tmp),
    );
    summary.push({ lineId: l.id, sentMilli: l.qty_milli, receivedMilli: received, lostMilli: lost });
  }
  if (lostValue > threshold && !can(u.role, "inventory.approve")) {
    throw new AppError(403, "approval_required", `Hao hụt khi nhận hàng ${lostValue}đ vượt ngưỡng ${threshold}đ — cần quản lý xác nhận`, { lostValue });
  }
  stmts.push(auditStmt(c, { action: "stock_doc.transfer_receive", entity: "stock_doc", entityId: id, before: { transferStatus: "in_transit" }, after: { transferStatus: "received", lines: summary, lostValue } }));
  await guarded(() => db.batch(stmts));
  const d = await loadDoc(db, id);
  return c.json({ ...docShape(d), received: summary, lines: await loadLines(db, id, u.role) });
});

// ---------------------------------------------------------------- cách ly lô hỏng (B-03 / EC-15)
const quarantineBody = z.object({ reason: z.string().trim().min(3).max(200) });

inventoryRoutes.post("/lots/:id/quarantine", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const lotId = Number(c.req.param("id"));
  const b = await parseBody(c, quarantineBody);
  const lot = await db
    .prepare(`SELECT l.*, loc.store_id FROM lots l JOIN locations loc ON loc.id = l.location_id WHERE l.id = ?`)
    .bind(lotId)
    .first<any>();
  if (!lot) throw notFound("not_found", "Không tìm thấy lô hàng");
  if (lot.status !== "active") throw conflict("lot_not_active", "Chỉ cách ly được lô đang hoạt động", { status: lot.status });
  const now = new Date().toISOString();
  await db.batch([
    assertStmt(db, "lot.quarantine", `SELECT status = 'active' FROM lots WHERE id = ?`, [lotId]),
    db.prepare(`UPDATE lots SET status = 'quarantine', quarantine_reason = ?, quarantined_at = ?, quarantined_by = ? WHERE id = ?`).bind(b.reason, now, u.id, lotId),
    auditStmt(c, { action: "lot.quarantine", entity: "lot", entityId: lotId, before: { status: "active" }, after: { status: "quarantine", lotCode: lot.lot_code }, reason: b.reason }),
  ]);
  // Ngay lập tức chuyển phần giữ của các đơn sang lô tốt khác (FEFO); phần không thay được → nhả, đánh dấu đơn, báo quản lý
  const r = await swapBadReservations(db, lot.store_id, { lotId, actorId: u.id });
  for (const o of new Set(r.short.map((x) => x.orderId))) await kickJobs(c.env, "order", o).catch(() => {});
  const after = await db.prepare(`SELECT l.*, p.name AS product_name FROM lots l JOIN products p ON p.id = l.product_id WHERE l.id = ?`).bind(lotId).first<any>();
  return c.json({ lot: lotShape(after, can(u.role, "prices.view_cost")), swappedOrders: r.swapped, shortOrders: r.short });
});

inventoryRoutes.post("/lots/:id/release-quarantine", requirePerm("inventory.approve"), async (c) => {
  const db = c.env.DB;
  const lotId = Number(c.req.param("id"));
  const b = await parseBody(c, quarantineBody);
  const lot = await db.prepare(`SELECT * FROM lots WHERE id = ?`).bind(lotId).first<any>();
  if (!lot) throw notFound("not_found", "Không tìm thấy lô hàng");
  if (lot.status !== "quarantine") throw conflict("lot_not_quarantined", "Lô không ở trạng thái cách ly", { status: lot.status });
  await db.batch([
    assertStmt(db, "lot.release_quarantine", `SELECT status = 'quarantine' FROM lots WHERE id = ?`, [lotId]),
    db.prepare(`UPDATE lots SET status = 'active', quarantine_reason = NULL, quarantined_at = NULL, quarantined_by = NULL WHERE id = ?`).bind(lotId),
    auditStmt(c, { action: "lot.release_quarantine", entity: "lot", entityId: lotId, before: { status: "quarantine", reason: lot.quarantine_reason }, after: { status: "active" }, reason: b.reason }),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- thông báo trong ứng dụng
/** Thông báo: mọi vai trò đăng nhập đều có hr.self hoặc inventory.view; từng thông báo còn lọc theo người nhận / quyền. */
const requireNotifyAccess: MiddlewareHandler<AppBindings> = async (c, next) => {
  const role = c.get("user")?.role;
  if (!role || !(can(role, "inventory.view") || can(role, "hr.self"))) throw forbidden();
  await next();
};
const visibleTo = (n: { target_user_id: number | null; audience_perm: string }, user: { id: number; role: Role }) =>
  n.target_user_id != null ? n.target_user_id === user.id : can(user.role, n.audience_perm as Permission);

inventoryRoutes.get("/notifications", requireNotifyAccess, async (c) => {
  const user = c.get("user");
  const unread = c.req.query("unread") === "1";
  const { results } = await c.env.DB
    .prepare(`SELECT id, kind, title, body, audience_perm, target_user_id, url, ref_type, ref_id, created_at, read_at FROM notifications WHERE (target_user_id IS NULL OR target_user_id = ?) ${unread ? "AND read_at IS NULL" : ""} ORDER BY id DESC LIMIT 100`)
    .bind(user.id)
    .all<any>();
  const items = results
    .filter((n) => visibleTo(n, user))
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, url: n.url, refType: n.ref_type, refId: n.ref_id, createdAt: n.created_at, readAt: n.read_at }));
  return c.json({ items, unread: items.filter((n) => !n.readAt).length });
});

inventoryRoutes.post("/notifications/:id/read", requireNotifyAccess, async (c) => {
  const id = Number(c.req.param("id"));
  const n = await c.env.DB.prepare(`SELECT audience_perm, target_user_id FROM notifications WHERE id = ?`).bind(id).first<{ audience_perm: string; target_user_id: number | null }>();
  if (!n || !visibleTo(n, c.get("user"))) throw notFound("not_found", "Không tìm thấy thông báo");
  await c.env.DB.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, ?), read_by = COALESCE(read_by, ?) WHERE id = ?`).bind(new Date().toISOString(), c.get("user").id, id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- tồn kho
const lotShape = (l: any, seeCost: boolean) => ({
  id: l.id, lotCode: l.lot_code, productId: l.product_id, productName: l.product_name, locationId: l.location_id,
  supplierId: l.supplier_id, receiptDocId: l.receipt_doc_id, receivedAt: l.received_at, expiresAt: l.expires_at,
  qtyInMilli: l.qty_in_milli, qtyOnHandMilli: l.qty_on_hand_milli, qtyReservedMilli: l.qty_reserved_milli,
  status: l.status, quarantineReason: l.quarantine_reason ?? null, quarantinedAt: l.quarantined_at ?? null, expired: isExpired(l), ...(seeCost ? { unitCost: l.unit_cost } : {}),
});

inventoryRoutes.get("/stock/lots", requirePerm("inventory.view"), async (c) => {
  const { productId, status, includeEmpty } = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (productId) (where.push("l.product_id = ?"), binds.push(Number(productId)));
  if (status) (where.push("l.status = ?"), binds.push(status));
  if (includeEmpty !== "1") where.push("l.qty_on_hand_milli > 0");
  const { limit, cursor } = pageParams(c);
  if (cursor) (where.push("l.id > ?"), binds.push(cursor));
  const { results } = await c.env.DB
    .prepare(`SELECT l.*, p.name AS product_name FROM lots l JOIN products p ON p.id = l.product_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.id LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<any>();
  const seeCost = can(c.get("user").role, "prices.view_cost");
  return c.json({ items: results.slice(0, limit).map((l) => lotShape(l, seeCost)), nextCursor: results.length > limit ? results[limit - 1].id : null });
});

inventoryRoutes.get("/stock/card", requirePerm("inventory.view"), async (c) => {
  const db = c.env.DB;
  const { productId, from, to } = c.req.query();
  if (!productId) throw new AppError(422, "validation_error", "Thiếu productId");
  const pid = Number(productId);
  const fromUtc = from ? vnDayRangeUtc(from).from : "0000";
  const toUtc = to ? vnDayRangeUtc(to).to : "9999";
  // EC-22: thẻ kho của mã đích gồm cả lịch sử các mã đã gộp vào nó (stock_moves vẫn trỏ về mã nguồn)
  const fam = `(SELECT id FROM products WHERE id = ?1 OR merged_into = ?1)`;
  const opening = await db.prepare(`SELECT COALESCE(SUM(qty_delta_milli),0) q FROM stock_moves WHERE product_id IN ${fam} AND at < ?2`).bind(pid, fromUtc).first<{ q: number }>();
  const { results } = await db
    .prepare(
      `SELECT m.*, l.lot_code FROM stock_moves m JOIN lots l ON l.id = m.lot_id
        WHERE m.product_id IN ${fam} AND m.at >= ?2 AND m.at < ?3 ORDER BY m.id`,
    )
    .bind(pid, fromUtc, toUtc)
    .all<any>();
  const seeCost = can(c.get("user").role, "prices.view_cost");
  let bal = opening?.q ?? 0;
  const moves = results.map((m) => {
    bal += m.qty_delta_milli;
    return {
      id: m.id, at: m.at, lotId: m.lot_id, lotCode: m.lot_code, moveType: m.move_type, refType: m.ref_type, refId: m.ref_id,
      qtyDeltaMilli: m.qty_delta_milli, balanceMilli: bal, userId: m.user_id, ...(seeCost ? { unitCost: m.unit_cost } : {}),
    };
  });
  return c.json({ productId: pid, openingMilli: opening?.q ?? 0, closingMilli: bal, moves });
});

inventoryRoutes.get("/stock/alerts", requirePerm("inventory.view"), async (c) => {
  const db = c.env.DB;
  const now = new Date();
  const nowIso = now.toISOString();
  const soon = new Date(now.getTime() + 2 * 86400_000).toISOString();
  const { results: low } = await db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.min_stock_milli AS minStockMilli,
              COALESCE((SELECT SUM(l.qty_on_hand_milli) FROM lots l WHERE l.product_id = p.id AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at > ?1)), 0) AS onHandMilli
         FROM products p WHERE p.active = 1 AND p.min_stock_milli > 0 AND p.merged_into IS NULL
          AND onHandMilli < p.min_stock_milli ORDER BY p.name`,
    )
    .bind(nowIso)
    .all();
  const lotQ = (cond: string) =>
    `SELECT l.*, p.name AS product_name FROM lots l JOIN products p ON p.id = l.product_id
      WHERE l.qty_on_hand_milli > 0 AND ${cond} ORDER BY l.expires_at`;
  const seeCost = can(c.get("user").role, "prices.view_cost");
  const { results: exp } = await db.prepare(lotQ(`l.status <> 'closed' AND l.expires_at IS NOT NULL AND l.expires_at > ?1 AND l.expires_at <= ?2 AND l.status = 'active'`)).bind(nowIso, soon).all<any>();
  const { results: dead } = await db.prepare(lotQ(`l.status <> 'closed' AND (l.status = 'expired' OR (l.expires_at IS NOT NULL AND l.expires_at <= ?1))`)).bind(nowIso).all<any>();
  const { results: quar } = await db.prepare(lotQ(`l.status = 'quarantine'`)).all<any>();
  return c.json({ lowStock: low, expiringSoon: exp.map((l) => lotShape(l, seeCost)), expired: dead.map((l) => lotShape(l, seeCost)), quarantined: quar.map((l) => lotShape(l, seeCost)) });
});

inventoryRoutes.get("/stock/lots/:lotCode/trace", requirePerm("inventory.view"), async (c) => {
  const db = c.env.DB;
  const seeCost = can(c.get("user").role, "prices.view_cost");
  const lot = await db
    .prepare(`SELECT l.*, p.name AS product_name FROM lots l JOIN products p ON p.id = l.product_id WHERE l.lot_code = ?`)
    .bind(c.req.param("lotCode"))
    .first<any>();
  if (!lot) throw notFound("not_found", "Không tìm thấy lô");
  const receipt = lot.receipt_doc_id
    ? await db
        .prepare(
          `SELECT d.id, d.code, d.type, d.posted_at AS postedAt, d.supplier_ref AS supplierRef, s.id AS supplierId, s.name AS supplierName
             FROM stock_docs d LEFT JOIN suppliers s ON s.id = d.supplier_id WHERE d.id = ?`,
        )
        .bind(lot.receipt_doc_id)
        .first()
    : null;
  const { results: moves } = await db
    .prepare(`SELECT id, at, move_type AS moveType, ref_type AS refType, ref_id AS refId, qty_delta_milli AS qtyDeltaMilli, user_id AS userId FROM stock_moves WHERE lot_id = ? ORDER BY id`)
    .bind(lot.id)
    .all();
  const { results: orders } = await db
    .prepare(
      `SELECT o.id, o.code, o.kind, o.channel, o.status, o.created_at AS createdAt, oll.qty_milli AS qtyMilli
         FROM order_line_lots oll JOIN order_lines ol ON ol.id = oll.order_line_id JOIN orders o ON o.id = ol.order_id
        WHERE oll.lot_id = ? ORDER BY o.id`,
    )
    .bind(lot.id)
    .all();
  return c.json({ lot: lotShape(lot, seeCost), receipt, moves, orders });
});
