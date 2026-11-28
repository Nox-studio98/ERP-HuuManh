import type { Context } from "hono";
import type { AppBindings, Role } from "../env";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { can } from "../lib/rbac";
import { vnDate } from "../lib/time";
import { addDays } from "./debt";
import { assertStmt, onceStmt } from "./guard";
import { assertPeriodOpen } from "./period";
import { getSettingInt } from "./settings";
import { sysAuditStmt } from "./sysaudit";
import { enqueueJobStmt } from "./outbox";
import { unitFactor } from "./http";
import { allocateReceivedToShortages, fillShortagesFromStock, linkCoveredShortages, sweepDeadShortagesStmt } from "./shortages";

/**
 * Đơn đặt NCC (PO) — docs/PO-NCC.md.
 * Nguồn nhu cầu: so_shortages (phần thiếu khi xác nhận SO). Job chốt đêm gom thành PO nháp theo NCC; quản lý duyệt → gửi;
 * NCC xác nhận / đề xuất / từ chối (applySupplierResponse — đợt cổng NCC sẽ gọi lại hàm này); nhận hàng theo PO → giữ hàng cho SO chờ.
 * Mọi ghi nhiều dòng nằm trong MỘT db.batch kèm audit; chuyển trạng thái dùng assertStmt + UPDATE có điều kiện (status, version).
 */

type Ctx = Context<AppBindings>;

export const IN_FLIGHT = ["pending_approval", "sent", "supplier_proposed", "confirmed", "partially_received"] as const;
const IN_FLIGHT_SQL = IN_FLIGHT.map((s) => `'${s}'`).join(",");
export const PO_PREFIX = "PO";

/** Người thực hiện: nhân viên (userId) hoặc NCC (đợt cổng NCC: userId = null, type = 'supplier'). */
export interface PoActor {
  type: "staff" | "supplier" | "system";
  userId: number | null;
  /** id tài khoản NCC (cổng) hoặc nhân viên ghi nhận hộ */
  id?: number | null;
  role?: Role;
  c?: Ctx | null;
  /** IP request (cổng NCC) để ghi audit */
  ip?: string | null;
}

const audit = (db: D1Database, a: PoActor, e: { action: string; entityId: number | string; before?: unknown; after?: unknown; reason?: string }) =>
  a.c
    ? auditStmt(a.c, { ...e, entity: "purchase_order" })
    : sysAuditStmt(db, { ...e, entity: "purchase_order", actor: a.type === "supplier" ? `supplier_account:${a.id ?? "?"}` : undefined, ip: a.ip, after: { ...(e.after as object | undefined), actor: a.type === "supplier" ? `supplier_account:${a.id ?? "?"}` : a.type } }, a.userId);

// ---------------------------------------------------------------- thời gian chốt đêm

export function parseCutoffMinutes(v: string | null | undefined): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((v ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 3 * 60;
}

export async function cutoffMinutes(db: D1Database) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = 'po.cutoff_time'`).first<{ value: string }>();
  return parseCutoffMinutes(r?.value);
}

/**
 * Ngày chốt của một thời điểm: ngày làm việc của buổi tối nhập đơn = ngày VN của (thời điểm − giờ chốt).
 * Ví dụ giờ chốt 03:00: 25/11 23:30 → 25/11; 26/11 02:00 → 25/11; 26/11 03:00 → 26/11 (ngày chốt mới bắt đầu).
 */
export const cutoffWindowDay = (now: Date, cutoffMin: number) => vnDate(new Date(now.getTime() - cutoffMin * 60_000));

// ---------------------------------------------------------------- làm tròn (dùng lại logic M2-11)

/** Số lượng đặt (đơn vị chính, milli): tối thiểu min_order, làm tròn LÊN theo hệ số đơn vị đặt. */
export function roundOrderQty(needMilli: number, factorMilli: number, minOrderMilli: number): number {
  if (needMilli <= 0) return 0;
  let need = needMilli;
  if (minOrderMilli > need) need = minOrderMilli;
  const f = Math.max(1, factorMilli);
  return Math.ceil(need / f) * f;
}

export const lineValue = (qtyMilli: number, unitCost: number | null | undefined) => (unitCost == null ? 0 : Math.floor((qtyMilli * unitCost + 500) / 1000));

// ---------------------------------------------------------------- chạy chốt đêm

export type CutoffMode = "auto" | "now" | "recalc";
export interface CutoffResult {
  cutoffDay: string;
  mode: CutoffMode;
  skipped?: "already_done";
  created: { id: number; code: string; supplierId: number; lines: number }[];
  updated: { id: number; code: string; supplierId: number; lines: number }[];
  cancelled: { id: number; code: string }[];
  noSupplier: { productId: number; name: string; qtyMilli: number }[];
  shortageCount: number;
}

interface Need {
  productId: number;
  name: string;
  baseUnit: string;
  shorts: { id: number; qty: number }[];
  total: number;
  incoming: number;
}

const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? ""));

/**
 * Gom phần thiếu → PO nháp theo NCC (docs/PO-NCC.md 4.2).
 *  auto  : cron sau giờ chốt; chốt ngày làm việc vừa kết thúc; idempotent bằng onceStmt('po.cutoff', ngày chốt).
 *  now   : "Chốt ngay" — ngày chốt hiện tại (đơn nhập tới giờ). Job tự động sau đó chỉ cập nhật PO nháp cùng ngày chốt, không tạo trùng.
 *  recalc: "Tính lại" — như now; chỉ ghi vào PO NHÁP của ngày chốt, không đụng PO đã gửi.
 */
export async function runPoCutoff(db: D1Database, opts: { mode: CutoffMode; actor: PoActor; now?: Date }): Promise<CutoffResult> {
  const now = opts.now ?? new Date();
  const cm = await cutoffMinutes(db);
  const windowDay = cutoffWindowDay(now, cm);
  const cutoffDay = opts.mode === "auto" ? addDays(windowDay, -1) : windowDay;
  const result: CutoffResult = { cutoffDay, mode: opts.mode, created: [], updated: [], cancelled: [], noSupplier: [], shortageCount: 0 };

  if (opts.mode === "auto") {
    try {
      await onceStmt(db, "po.cutoff", cutoffDay).run();
    } catch (e) {
      if (isUnique(e)) return { ...result, skipped: "already_done" };
      throw e;
    }
  }
  try {
    await buildDrafts(db, cutoffDay, now, opts, result);
  } catch (e) {
    if (opts.mode === "auto") await db.prepare(`DELETE FROM once_keys WHERE scope = 'po.cutoff' AND key = ?`).bind(cutoffDay).run(); // cho lần quét sau thử lại
    throw e;
  }
  return result;
}

/** Cron */
export async function runPoCutoffIfDue(db: D1Database, now = new Date()) {
  const cm = await cutoffMinutes(db);
  const closeDay = addDays(cutoffWindowDay(now, cm), -1);
  const done = await db.prepare(`SELECT 1 AS x FROM once_keys WHERE scope = 'po.cutoff' AND key = ?`).bind(closeDay).first();
  if (done) return null;
  return runPoCutoff(db, { mode: "auto", actor: { type: "system", userId: null }, now });
}

async function buildDrafts(db: D1Database, cutoffDay: string, now: Date, opts: { mode: CutoffMode; actor: PoActor }, result: CutoffResult) {
  const today = vnDate(now);
  await sweepDeadShortagesStmt(db).run(); // phần thiếu của đơn đã huỷ/hoàn tất ở nơi khác
  // K-PO1b: tồn tự do (nhập thường, đơn khác huỷ, chuyển kho về) giữ cho phần thiếu đang mở TRƯỚC khi tính nhu cầu đặt NCC
  await fillShortagesFromStock(db, { actorUserId: opts.actor.userId });
  const horizon = Math.max(0, await getSettingInt(db, "po.horizon_days", 2));
  const until = addDays(today, horizon);

  const shorts = (
    await db
      .prepare(
        `SELECT s.id, s.product_id, s.qty_milli, p.name, p.base_unit
           FROM so_shortages s JOIN orders o ON o.id = s.order_id JOIN products p ON p.id = s.product_id
          WHERE s.status = 'open' AND s.qty_milli > 0 AND o.status IN ('confirmed','preparing','shipping','delivery_failed')
            AND (s.need_by IS NULL OR s.need_by <= ?)
          ORDER BY s.product_id, (s.need_by IS NULL), s.need_by, s.created_at, s.id`,
      )
      .bind(until)
      .all<{ id: number; product_id: number; qty_milli: number; name: string; base_unit: string }>()
  ).results;
  result.shortageCount = shorts.length;

  // Hàng sắp về: PO đang chạy (chưa nhận) + PO nháp KHÁC (không phải nháp tự động của chính ngày chốt này — nháp đó sẽ được tính lại)
  const incomingRows = (
    await db
      .prepare(
        `SELECT pl.product_id, SUM(MAX(COALESCE(pl.confirmed_qty_milli, pl.qty_milli) - pl.received_milli, 0)) AS q
           FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
          WHERE po.status IN (${IN_FLIGHT_SQL}) OR (po.status = 'draft' AND NOT (po.source = 'nightly' AND po.cutoff_day = ?))
          GROUP BY pl.product_id`,
      )
      .bind(cutoffDay)
      .all<{ product_id: number; q: number }>()
  ).results;
  const incoming = new Map(incomingRows.map((r) => [r.product_id, r.q ?? 0]));

  const needs = new Map<number, Need>();
  for (const s of shorts) {
    const n = needs.get(s.product_id) ?? { productId: s.product_id, name: s.name, baseUnit: s.base_unit, shorts: [], total: 0, incoming: incoming.get(s.product_id) ?? 0 };
    n.shorts.push({ id: s.id, qty: s.qty_milli });
    n.total += s.qty_milli;
    needs.set(s.product_id, n);
  }

  interface PLine { productId: number; unit: string; qty: number; cost: number | null; links: { shortageId: number; qty: number }[]; leadDays: number }
  const bySupplier = new Map<number, PLine[]>();
  for (const n of needs.values()) {
    const net = n.total - n.incoming;
    if (net <= 0) continue;
    const sup = await db
      .prepare(
        `SELECT ps.supplier_id, ps.lead_time_days, ps.order_unit, ps.min_order_milli FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id AND s.active = 1
          WHERE ps.product_id = ? ORDER BY ps.preferred DESC, ps.lead_time_days, ps.supplier_id LIMIT 1`,
      )
      .bind(n.productId)
      .first<{ supplier_id: number; lead_time_days: number; order_unit: string | null; min_order_milli: number }>();
    if (!sup) {
      result.noSupplier.push({ productId: n.productId, name: n.name, qtyMilli: net });
      continue;
    }
    const unit = sup.order_unit ?? n.baseUnit;
    const f = await unitFactor(db, n.productId, unit).catch(() => 1000);
    const qty = roundOrderQty(net, f, sup.min_order_milli);
    const cost = (
      await db.prepare(`SELECT unit_cost FROM lots WHERE product_id = ? ORDER BY (supplier_id = ?) DESC, received_at DESC, id DESC LIMIT 1`).bind(n.productId, sup.supplier_id).first<{ unit_cost: number }>()
    )?.unit_cost ?? null;
    // phần thiếu đứng đầu (ngày giao sớm / tạo trước) được coi là đã có hàng sắp về; phần còn lại thuộc PO này
    const links: PLine["links"] = [];
    let skip = n.incoming;
    for (const s of n.shorts) {
      let q = s.qty;
      if (skip >= q) { skip -= q; continue; }
      q -= skip;
      skip = 0;
      links.push({ shortageId: s.id, qty: q });
    }
    bySupplier.set(sup.supplier_id, [...(bySupplier.get(sup.supplier_id) ?? []), { productId: n.productId, unit, qty, cost, links, leadDays: sup.lead_time_days }]);
  }

  const existing = (
    await db
      .prepare(`SELECT id, code, supplier_id, version FROM purchase_orders WHERE source = 'nightly' AND cutoff_day = ? AND status = 'draft'`)
      .bind(cutoffDay)
      .all<{ id: number; code: string; supplier_id: number; version: number }>()
  ).results;
  const exBySup = new Map(existing.map((e) => [e.supplier_id, e]));
  const storeId = (await db.prepare(`SELECT id FROM stores WHERE active = 1 ORDER BY id LIMIT 1`).first<{ id: number }>())?.id ?? 1;

  for (const [supplierId, lines] of bySupplier) {
    const total = lines.reduce((s, l) => s + lineValue(l.qty, l.cost), 0);
    const maxLead = Math.max(...lines.map((l) => l.leadDays), 0);
    const expected = addDays(today, maxLead);
    for (let attempt = 0; attempt < 3; attempt++) {
      const ex = attempt === 0 ? exBySup.get(supplierId) : (await db.prepare(`SELECT id, code, supplier_id, version FROM purchase_orders WHERE supplier_id = ? AND source = 'nightly' AND cutoff_day = ? AND status = 'draft'`).bind(supplierId, cutoffDay).first<{ id: number; code: string; supplier_id: number; version: number }>());
      try {
        if (ex) {
          await db.batch([
            assertStmt(db, "po.recalc", `SELECT status = 'draft' AND version = ? FROM purchase_orders WHERE id = ?`, [ex.version, ex.id]),
            db.prepare(`DELETE FROM po_shortage_links WHERE po_line_id IN (SELECT id FROM purchase_order_lines WHERE po_id = ?)`).bind(ex.id),
            db.prepare(`DELETE FROM purchase_order_lines WHERE po_id = ?`).bind(ex.id),
            ...lineStmts(db, ex.id, null, lines),
            db.prepare(`UPDATE purchase_orders SET total = ?, expected_date = ?, version = version + 1 WHERE id = ? AND status = 'draft'`).bind(total, expected, ex.id),
            audit(db, opts.actor, { action: `po.${opts.mode === "auto" ? "cutoff" : opts.mode === "now" ? "cutoff_now" : "recalc"}.update`, entityId: ex.id, after: { cutoffDay, lines: lines.length, total } }),
          ]);
          result.updated.push({ id: ex.id, code: ex.code, supplierId, lines: lines.length });
        } else {
          const code = await nextCode(db, PO_PREFIX);
          await db.batch([
            db
              .prepare(`INSERT INTO purchase_orders(code, supplier_id, store_id, status, source, cutoff_day, expected_date, total, created_by) VALUES (?,?,?,'draft','nightly',?,?,?,?)`)
              .bind(code, supplierId, storeId, cutoffDay, expected, total, opts.actor.userId),
            ...lineStmts(db, null, code, lines),
            audit(db, opts.actor, { action: `po.${opts.mode === "auto" ? "cutoff" : opts.mode === "now" ? "cutoff_now" : "recalc"}.create`, entityId: code, after: { cutoffDay, supplierId, lines: lines.length, total } }),
          ]);
          const row = await db.prepare(`SELECT id FROM purchase_orders WHERE code = ?`).bind(code).first<{ id: number }>();
          result.created.push({ id: row!.id, code, supplierId, lines: lines.length });
        }
        break;
      } catch (e) {
        const m = String((e as Error)?.message);
        if ((isUnique(e) || m.includes("state_changed")) && attempt < 2) continue; // hai lần chạy đồng thời: đọc lại PO nháp rồi cập nhật
        throw e;
      }
    }
  }

  // PO nháp tự động của ngày chốt mà không còn nhu cầu (phần thiếu đã được lấp / huỷ) → huỷ nháp
  for (const ex of existing) {
    if (bySupplier.has(ex.supplier_id)) continue;
    const cur = await db.prepare(`SELECT version FROM purchase_orders WHERE id = ? AND status = 'draft'`).bind(ex.id).first<{ version: number }>();
    if (!cur) continue;
    await db.batch([
      assertStmt(db, "po.recalc_cancel", `SELECT status = 'draft' AND version = ? FROM purchase_orders WHERE id = ?`, [cur.version, ex.id]),
      db.prepare(`DELETE FROM po_shortage_links WHERE po_line_id IN (SELECT id FROM purchase_order_lines WHERE po_id = ?)`).bind(ex.id),
      db.prepare(`UPDATE purchase_orders SET status = 'cancelled', cancel_reason = 'Không còn phần thiếu cần đặt', total = 0, version = version + 1 WHERE id = ? AND status = 'draft'`).bind(ex.id),
      audit(db, opts.actor, { action: "po.recalc.cancel", entityId: ex.id, after: { reason: "Không còn phần thiếu cần đặt" } }),
    ]);
    result.cancelled.push({ id: ex.id, code: ex.code });
  }
  // K-PO1: phần thiếu được coi là "đã có hàng sắp về" phải gắn vào dòng PO đang chạy cụ thể (ưu tiên ngày giao sớm)
  await linkCoveredShortages(db, opts.actor.userId, [...needs.keys()]);
}

function lineStmts(
  db: D1Database,
  poId: number | null,
  poCode: string | null,
  lines: { productId: number; unit: string; qty: number; cost: number | null; links: { shortageId: number; qty: number }[] }[],
): D1PreparedStatement[] {
  const poRef = poId != null ? "?" : "(SELECT id FROM purchase_orders WHERE code = ?)";
  const poVal = poId ?? poCode;
  const out: D1PreparedStatement[] = [];
  for (const l of lines) {
    out.push(
      db.prepare(`INSERT INTO purchase_order_lines(po_id, product_id, order_unit, qty_milli, unit_cost) VALUES (${poRef},?,?,?,?)`).bind(poVal, l.productId, l.unit, l.qty, l.cost),
      ...l.links.map((k) =>
        db
          .prepare(`INSERT INTO po_shortage_links(po_line_id, shortage_id, qty_milli) VALUES ((SELECT id FROM purchase_order_lines WHERE po_id = ${poRef} AND product_id = ?), ?, ?)`)
          .bind(poVal, l.productId, k.shortageId, k.qty),
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------- đọc

export async function loadPo(db: D1Database, id: number) {
  const po = await db
    .prepare(
      `SELECT po.*, s.name AS supplier_name, s.code AS supplier_code, s.phone AS supplier_phone, cu.full_name AS created_by_name, au.full_name AS approved_by_name
         FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN users cu ON cu.id = po.created_by LEFT JOIN users au ON au.id = po.approved_by WHERE po.id = ?`,
    )
    .bind(id)
    .first<any>();
  if (!po) throw notFound("po_not_found", "Không tìm thấy đơn đặt NCC");
  return po;
}

const targetQty = (l: any) => l.confirmed_qty_milli ?? l.qty_milli;

export async function poLines(db: D1Database, poId: number) {
  const { results } = await db
    .prepare(
      `SELECT pl.*, p.name AS product_name, p.sku, p.base_unit,
              COALESCE((SELECT factor_milli FROM product_units pu WHERE pu.product_id = pl.product_id AND pu.unit = pl.order_unit), 1000) AS factor
         FROM purchase_order_lines pl JOIN products p ON p.id = pl.product_id WHERE pl.po_id = ? ORDER BY pl.id`,
    )
    .bind(poId)
    .all<any>();
  return results;
}

export function shapePoLine(l: any, cost: boolean) {
  const target = targetQty(l);
  return {
    id: l.id, productId: l.product_id, productName: l.product_name, sku: l.sku, baseUnit: l.base_unit, orderUnit: l.order_unit, factor: l.factor,
    qtyMilli: l.qty_milli, orderQty: l.qty_milli / l.factor,
    proposedQtyMilli: l.proposed_qty_milli, confirmedQtyMilli: l.confirmed_qty_milli, targetMilli: target,
    receivedMilli: l.received_milli, remainingMilli: Math.max(0, target - l.received_milli),
    note: l.line_note, supplierNote: l.supplier_line_note,
    ...(cost ? { unitCost: l.unit_cost, proposedUnitCost: l.proposed_unit_cost, confirmedUnitCost: l.confirmed_unit_cost, lineTotal: lineValue(target, l.confirmed_unit_cost ?? l.unit_cost) } : {}),
  };
}

export function shapePo(po: any, cost: boolean) {
  const today = vnDate();
  const live = ["sent", "supplier_proposed", "confirmed", "partially_received"].includes(po.status);
  return {
    id: po.id, code: po.code, supplierId: po.supplier_id, supplierName: po.supplier_name, supplierCode: po.supplier_code,
    status: po.status, source: po.source, cutoffDay: po.cutoff_day, expectedDate: po.expected_date, proposedExpectedDate: po.proposed_expected_date,
    overdue: live && !!po.expected_date && po.expected_date < today,
    note: po.note, supplierNote: po.supplier_note, rejectReason: po.reject_reason, cancelReason: po.cancel_reason, closeReason: po.close_reason,
    approvalId: po.approval_id, version: po.version,
    createdBy: po.created_by, createdByName: po.created_by_name ?? null, approvedBy: po.approved_by, approvedByName: po.approved_by_name ?? null,
    approvedAt: po.approved_at, sentAt: po.sent_at, confirmedAt: po.confirmed_at, closedAt: po.closed_at, createdAt: po.created_at,
    ...(cost ? { total: po.total } : {}),
  };
}

/** Tổng tiền theo giá đang hiệu lực (đã chốt nếu có, không thì giá đặt) — cập nhật trong cùng batch với thay đổi dòng. */
export const recomputeTotalStmt = (db: D1Database, poId: number) =>
  db
    .prepare(
      `UPDATE purchase_orders SET total = (SELECT COALESCE(SUM((COALESCE(confirmed_qty_milli, qty_milli) * COALESCE(confirmed_unit_cost, unit_cost, 0) + 500) / 1000), 0) FROM purchase_order_lines WHERE po_id = purchase_orders.id) WHERE id = ?`,
    )
    .bind(poId);

// ---------------------------------------------------------------- tạo / sửa nháp tay

export interface PoLineIn {
  productId: number;
  /** số lượng theo đơn vị đặt */
  qty: number;
  unit?: string;
  unitCost?: number | null;
  note?: string | null;
}

async function normalizeLines(db: D1Database, supplierId: number, lines: PoLineIn[]) {
  if (new Set(lines.map((l) => l.productId)).size !== lines.length) throw new AppError(422, "validation_error", "Mặt hàng bị lặp trong PO");
  const out: { productId: number; unit: string; qtyMilli: number; unitCost: number | null; note: string | null }[] = [];
  for (const l of lines) {
    const p = await db.prepare(`SELECT id, base_unit, active FROM products WHERE id = ?`).bind(l.productId).first<{ id: number; base_unit: string; active: number }>();
    if (!p || !p.active) throw new AppError(422, "invalid_product", `Mặt hàng ${l.productId} không tồn tại hoặc đã ngừng`);
    const ps = await db.prepare(`SELECT order_unit FROM product_suppliers WHERE product_id = ? AND supplier_id = ?`).bind(l.productId, supplierId).first<{ order_unit: string | null }>();
    const unit = l.unit ?? ps?.order_unit ?? p.base_unit;
    const f = await unitFactor(db, l.productId, unit);
    const qtyMilli = Math.round(l.qty * f);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng phải lớn hơn 0");
    let cost = l.unitCost ?? null;
    if (cost == null)
      cost = (await db.prepare(`SELECT unit_cost FROM lots WHERE product_id = ? ORDER BY (supplier_id = ?) DESC, received_at DESC, id DESC LIMIT 1`).bind(l.productId, supplierId).first<{ unit_cost: number }>())?.unit_cost ?? null;
    out.push({ productId: l.productId, unit, qtyMilli, unitCost: cost, note: l.note ?? null });
  }
  return out;
}

export async function createManualPo(
  db: D1Database,
  actor: PoActor,
  b: { supplierId: number; expectedDate?: string | null; note?: string | null; lines: PoLineIn[] },
): Promise<number> {
  const sup = await db.prepare(`SELECT id FROM suppliers WHERE id = ? AND active = 1`).bind(b.supplierId).first();
  if (!sup) throw new AppError(422, "invalid_supplier", "Nhà cung cấp không tồn tại");
  const lines = await normalizeLines(db, b.supplierId, b.lines);
  const storeId = (await db.prepare(`SELECT id FROM stores WHERE active = 1 ORDER BY id LIMIT 1`).first<{ id: number }>())?.id ?? 1;
  const code = await nextCode(db, PO_PREFIX);
  const total = lines.reduce((s, l) => s + lineValue(l.qtyMilli, l.unitCost), 0);
  await db.batch([
    db
      .prepare(`INSERT INTO purchase_orders(code, supplier_id, store_id, status, source, expected_date, total, note, created_by) VALUES (?,?,?,'draft','manual',?,?,?,?)`)
      .bind(code, b.supplierId, storeId, b.expectedDate ?? null, total, b.note ?? null, actor.userId),
    ...lines.map((l) =>
      db
        .prepare(`INSERT INTO purchase_order_lines(po_id, product_id, order_unit, qty_milli, unit_cost, line_note) VALUES ((SELECT id FROM purchase_orders WHERE code = ?),?,?,?,?,?)`)
        .bind(code, l.productId, l.unit, l.qtyMilli, l.unitCost, l.note),
    ),
    audit(db, actor, { action: "po.create", entityId: code, after: { supplierId: b.supplierId, lines: lines.length, total } }),
  ]);
  return (await db.prepare(`SELECT id FROM purchase_orders WHERE code = ?`).bind(code).first<{ id: number }>())!.id;
}

/** Sửa PO nháp: thay ghi chú / ngày giao / các dòng (dòng mới, sửa, xoá). */
export async function updateDraftPo(
  db: D1Database,
  actor: PoActor,
  poId: number,
  b: { version?: number; expectedDate?: string | null; note?: string | null; lines?: PoLineIn[] },
) {
  const po = await loadPo(db, poId);
  if (po.status !== "draft") throw conflict("po_not_draft", "Chỉ sửa được PO nháp", { status: po.status });
  if (b.version != null && b.version !== po.version) throw conflict("version_conflict", "PO vừa được người khác thay đổi, vui lòng tải lại", { version: po.version });
  const stmts: D1PreparedStatement[] = [assertStmt(db, "po.update", `SELECT status = 'draft' AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId])];
  if (b.lines) {
    if (!b.lines.length) throw new AppError(422, "validation_error", "PO cần ít nhất một dòng");
    const lines = await normalizeLines(db, po.supplier_id, b.lines);
    const keep = lines.map((l) => l.productId);
    stmts.push(
      db.prepare(`DELETE FROM po_shortage_links WHERE po_line_id IN (SELECT id FROM purchase_order_lines WHERE po_id = ? AND product_id NOT IN (${keep.map(() => "?").join(",")}))`).bind(poId, ...keep),
      db.prepare(`DELETE FROM purchase_order_lines WHERE po_id = ? AND product_id NOT IN (${keep.map(() => "?").join(",")})`).bind(poId, ...keep),
    );
    for (const l of lines)
      stmts.push(
        db
          .prepare(
            `INSERT INTO purchase_order_lines(po_id, product_id, order_unit, qty_milli, unit_cost, line_note) VALUES (?,?,?,?,?,?)
             ON CONFLICT(po_id, product_id) DO UPDATE SET order_unit = excluded.order_unit, qty_milli = excluded.qty_milli, unit_cost = excluded.unit_cost, line_note = excluded.line_note`,
          )
          .bind(poId, l.productId, l.unit, l.qtyMilli, l.unitCost, l.note),
      );
  }
  stmts.push(
    db
      .prepare(`UPDATE purchase_orders SET note = ?, expected_date = ?, version = version + 1 WHERE id = ? AND status = 'draft'`)
      .bind(b.note !== undefined ? b.note : po.note, b.expectedDate !== undefined ? b.expectedDate : po.expected_date, poId),
    recomputeTotalStmt(db, poId),
    audit(db, actor, { action: "po.update", entityId: poId, before: { note: po.note, expectedDate: po.expected_date, total: po.total }, after: { lines: b.lines?.length ?? null, expectedDate: b.expectedDate, note: b.note } }),
  );
  await db.batch(stmts);
}

// ---------------------------------------------------------------- duyệt / gửi / huỷ / đóng

export async function approvePo(db: D1Database, c: Ctx, poId: number, version?: number) {
  const user = c.get("user");
  const po = await loadPo(db, poId);
  if (po.status !== "draft" && po.status !== "pending_approval") throw conflict("invalid_status", `PO đang ở trạng thái ${po.status}`, { status: po.status });
  if (version != null && version !== po.version) throw conflict("version_conflict", "PO vừa được người khác thay đổi, vui lòng tải lại", { version: po.version });
  const lineCount = (await db.prepare(`SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = ?`).bind(poId).first<{ n: number }>())!.n;
  if (!lineCount) throw new AppError(422, "empty_po", "PO chưa có dòng nào");
  const threshold = await getSettingInt(db, "approval.po_vnd", 20_000_000);
  // K-PO3: PO còn dòng chưa có giá (total tính 0) không được lọt ngưỡng — coi như vượt, cần chủ duyệt
  const unpriced = (await db.prepare(`SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = ? AND COALESCE(confirmed_unit_cost, unit_cost) IS NULL`).bind(poId).first<{ n: number }>())!.n;
  const high = (po.total > threshold || unpriced > 0) && !can(user.role, "purchasing.approve_high");
  const a: PoActor = { type: "staff", userId: user.id, role: user.role, c };

  if (po.status === "pending_approval" && high) throw conflict("owner_approval_required", "PO vượt ngưỡng đang chờ chủ duyệt", { approvalId: po.approval_id });
  if (po.status === "draft" && high) {
    await db.batch([
      assertStmt(db, "po.request_approval", `SELECT status = 'draft' AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId]),
      db
        .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('purchase_order.approve','purchase_order',?,?,?,?)`)
        .bind(String(poId), JSON.stringify({ code: po.code, supplierName: po.supplier_name }), unpriced > 0 ? `PO còn ${unpriced} dòng chưa có giá, cần chủ duyệt` : `PO vượt ngưỡng ${threshold.toLocaleString("vi-VN")} đ`, user.id),
      db.prepare(`UPDATE purchase_orders SET status = 'pending_approval', approval_id = (SELECT MAX(id) FROM approvals WHERE type = 'purchase_order.approve' AND ref_id = ? AND status = 'pending'), version = version + 1 WHERE id = ? AND status = 'draft'`).bind(String(poId), poId),
      audit(db, a, { action: "po.request_approval", entityId: poId, before: { status: "draft" }, after: { status: "pending_approval", total: po.total, threshold, unpricedLines: unpriced } }),
    ]);
    return { status: "pending_approval" as const };
  }
  await db.batch([
    assertStmt(db, "po.approve", `SELECT status IN ('draft','pending_approval') AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId]),
    db
      .prepare(`UPDATE purchase_orders SET status = 'sent', approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ? AND status IN ('draft','pending_approval')`)
      .bind(user.id, poId),
    db.prepare(`UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note = 'Duyệt trực tiếp trên PO' WHERE type = 'purchase_order.approve' AND ref_id = ? AND status = 'pending'`).bind(user.id, String(poId)),
    audit(db, a, { action: "po.approve", entityId: poId, before: { status: po.status }, after: { status: "sent", total: po.total } }),
  ]);
  return { status: "sent" as const };
}

/** Duyệt qua luồng duyệt chung (chủ) — gọi từ approval handler, trả statements để gộp batch với việc đánh dấu approval. */
export async function approvalApproveStmts(db: D1Database, c: Ctx, poId: number): Promise<D1PreparedStatement[]> {
  const user = c.get("user");
  const po = await loadPo(db, poId);
  if (po.status !== "pending_approval") throw conflict("invalid_status", "PO không còn ở trạng thái chờ duyệt", { status: po.status });
  return [
    assertStmt(db, "po.approval_approve", `SELECT status = 'pending_approval' AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId]),
    db
      .prepare(`UPDATE purchase_orders SET status = 'sent', approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ? AND status = 'pending_approval'`)
      .bind(user.id, poId),
    audit(db, { type: "staff", userId: user.id, c }, { action: "po.approve", entityId: poId, before: { status: "pending_approval" }, after: { status: "sent", via: "approvals" } }),
  ];
}

export async function approvalRejectStmts(db: D1Database, c: Ctx, poId: number, note?: string): Promise<D1PreparedStatement[]> {
  return [
    db.prepare(`UPDATE purchase_orders SET status = 'draft', approval_id = NULL, reject_reason = ?, version = version + 1 WHERE id = ? AND status = 'pending_approval'`).bind(note ?? null, poId),
    audit(db, { type: "staff", userId: c.get("user").id, c }, { action: "po.approval_rejected", entityId: poId, after: { status: "draft" }, reason: note }),
  ];
}

export async function cancelPo(db: D1Database, actor: PoActor, poId: number, reason: string, version?: number) {
  const po = await loadPo(db, poId);
  if (!["draft", "pending_approval", "sent", "supplier_proposed", "confirmed"].includes(po.status)) throw conflict("invalid_status", `Không huỷ được PO ${po.status}`, { status: po.status });
  if (version != null && version !== po.version) throw conflict("version_conflict", "PO vừa được người khác thay đổi, vui lòng tải lại", { version: po.version });
  await db.batch([
    assertStmt(db, "po.cancel", `SELECT status = ? AND version = ? AND NOT EXISTS (SELECT 1 FROM purchase_order_lines WHERE po_id = ? AND received_milli > 0) FROM purchase_orders WHERE id = ?`, [po.status, po.version, poId, poId]),
    db.prepare(`UPDATE purchase_orders SET status = 'cancelled', cancel_reason = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ? AND status = ?`).bind(reason, poId, po.status),
    db.prepare(`UPDATE approvals SET status = 'rejected', decision_note = 'PO đã huỷ' WHERE type = 'purchase_order.approve' AND ref_id = ? AND status = 'pending'`).bind(String(poId)),
    audit(db, actor, { action: "po.cancel", entityId: poId, before: { status: po.status }, after: { status: "cancelled" }, reason }),
  ]);
}

/** Đóng PO còn thiếu (đã nhận một phần): phần chưa về quay lại nhu cầu cho lần chạy sau. */
export async function closePo(db: D1Database, actor: PoActor, poId: number, reason: string, version?: number) {
  const po = await loadPo(db, poId);
  if (po.status !== "partially_received") throw conflict("invalid_status", "Chỉ đóng được PO đã nhận một phần (PO chưa nhận gì thì huỷ)", { status: po.status });
  if (version != null && version !== po.version) throw conflict("version_conflict", "PO vừa được người khác thay đổi, vui lòng tải lại", { version: po.version });
  await db.batch([
    assertStmt(db, "po.close", `SELECT status = 'partially_received' AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId]),
    db.prepare(`UPDATE purchase_orders SET status = 'closed', close_reason = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ? AND status = 'partially_received'`).bind(reason, poId),
    audit(db, actor, { action: "po.close", entityId: poId, before: { status: po.status }, after: { status: "closed" }, reason }),
  ]);
}

// ---------------------------------------------------------------- phản hồi của NCC

export interface SupplierResponse {
  action: "confirm" | "propose" | "reject";
  /** propose: mỗi dòng đề xuất (khớp theo lineId hoặc productId); dòng không nêu giữ nguyên số đặt */
  lines?: { lineId?: number; productId?: number; qtyMilli?: number; unitCost?: number | null; note?: string | null }[];
  expectedDate?: string | null;
  note?: string | null;
  /** version của PO lúc NCC xem — chống ghi đè khi cửa hàng vừa đổi PO */
  version: number;
}

/** Thông báo trong ERP (+ push cho quản lý/chủ) khi NCC tự phản hồi PO trên cổng — cùng batch với việc đổi trạng thái. Nhân viên ghi nhận hộ thì không cần báo. */
function supplierResponseNotify(db: D1Database, po: any, actor: PoActor, action: SupplierResponse["action"], note: string | null): D1PreparedStatement[] {
  if (actor.type !== "supplier") return [];
  const what = action === "confirm" ? "đã xác nhận" : action === "propose" ? "đề xuất sửa" : "từ chối";
  const title = `NCC ${po.supplier_name} ${what} đơn ${po.code}`;
  const body = action === "reject" ? `Lý do: ${(note ?? "").slice(0, 160)}` : action === "propose" ? "Mở đơn để chấp nhận hoặc từ chối đề xuất." : "Đơn đã chuyển sang trạng thái NCC đã xác nhận.";
  const url = `/purchase-orders?open=${po.id}`;
  return [
    db.prepare(`INSERT INTO notifications(kind, title, body, audience_perm, ref_type, ref_id, url) VALUES (?,?,?,?,?,?,?)`).bind(`po_supplier_${action}`, title, body, "purchasing.approve", "purchase_order", po.id, url),
    enqueueJobStmt(db, "notify.managers", "purchase_order", po.id, { title, body, url }),
  ];
}

/**
 * NCC phản hồi PO đã gửi (docs/PO-NCC.md 4.4). Dùng chung cho: nhân viên ghi nhận hộ (qua điện thoại/Zalo) và cổng NCC (đợt sau).
 *  confirm → confirmed (chốt SL/giá = số đặt); propose → supplier_proposed (kèm SL/giá/ngày giao đề xuất); reject → rejected (bắt buộc lý do).
 */
export async function applySupplierResponse(db: D1Database, poId: number, input: SupplierResponse, actor: PoActor) {
  const po = await loadPo(db, poId);
  if (po.status !== "sent") throw conflict("invalid_status", `PO đang ở trạng thái ${po.status}, không nhận phản hồi`, { status: po.status });
  if (input.version !== po.version) throw conflict("version_conflict", "PO vừa được thay đổi, vui lòng tải lại", { version: po.version });
  const lines = await poLines(db, poId);
  const guard = assertStmt(db, "po.supplier_response", `SELECT status = 'sent' AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId]);
  const noteTxt = input.note?.trim() || null;

  if (input.action === "confirm") {
    await db.batch([
      guard,
      db.prepare(`UPDATE purchase_order_lines SET confirmed_qty_milli = qty_milli, confirmed_unit_cost = unit_cost, proposed_qty_milli = NULL, proposed_unit_cost = NULL WHERE po_id = ?`).bind(poId),
      db
        .prepare(`UPDATE purchase_orders SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), expected_date = COALESCE(?, expected_date), supplier_note = ?, version = version + 1 WHERE id = ? AND status = 'sent'`)
        .bind(input.expectedDate ?? null, noteTxt, poId),
      recomputeTotalStmt(db, poId),
      audit(db, actor, { action: "po.supplier_confirm", entityId: poId, before: { status: "sent" }, after: { status: "confirmed", expectedDate: input.expectedDate ?? po.expected_date }, reason: noteTxt ?? undefined }),
      ...supplierResponseNotify(db, po, actor, "confirm", noteTxt),
    ]);
    return;
  }
  if (input.action === "reject") {
    if (!noteTxt || noteTxt.length < 3) throw new AppError(422, "reason_required", "Từ chối PO cần ghi lý do");
    await db.batch([
      guard,
      db.prepare(`UPDATE purchase_orders SET status = 'rejected', supplier_note = ?, reject_reason = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ? AND status = 'sent'`).bind(noteTxt, noteTxt, poId),
      audit(db, actor, { action: "po.supplier_reject", entityId: poId, before: { status: "sent" }, after: { status: "rejected" }, reason: noteTxt }),
      ...supplierResponseNotify(db, po, actor, "reject", noteTxt),
    ]);
    return;
  }
  // propose
  const stmts: D1PreparedStatement[] = [guard];
  const seen = new Set<number>();
  for (const l of input.lines ?? []) {
    const row = lines.find((x) => (l.lineId != null ? x.id === l.lineId : x.product_id === l.productId));
    if (!row) throw new AppError(422, "line_not_in_po", "Dòng đề xuất không thuộc PO", { lineId: l.lineId, productId: l.productId });
    if (seen.has(row.id)) throw new AppError(422, "validation_error", "Dòng đề xuất bị lặp");
    seen.add(row.id);
    if (l.qtyMilli != null && (!Number.isInteger(l.qtyMilli) || l.qtyMilli < 0)) throw new AppError(422, "invalid_qty", "Số lượng đề xuất không hợp lệ");
    if (l.unitCost != null && (!Number.isInteger(l.unitCost) || l.unitCost < 0)) throw new AppError(422, "invalid_cost", "Giá đề xuất không hợp lệ");
    stmts.push(
      db
        .prepare(`UPDATE purchase_order_lines SET proposed_qty_milli = ?, proposed_unit_cost = ?, supplier_line_note = ? WHERE id = ? AND po_id = ?`)
        .bind(l.qtyMilli ?? row.qty_milli, l.unitCost !== undefined ? l.unitCost : row.unit_cost, l.note ?? null, row.id, poId),
    );
  }
  stmts.push(
    db.prepare(`UPDATE purchase_order_lines SET proposed_qty_milli = qty_milli, proposed_unit_cost = unit_cost WHERE po_id = ? AND proposed_qty_milli IS NULL`).bind(poId),
    db
      .prepare(`UPDATE purchase_orders SET status = 'supplier_proposed', proposed_expected_date = ?, supplier_note = ?, version = version + 1 WHERE id = ? AND status = 'sent'`)
      .bind(input.expectedDate ?? null, noteTxt, poId),
    audit(db, actor, { action: "po.supplier_propose", entityId: poId, before: { status: "sent" }, after: { status: "supplier_proposed", lines: input.lines?.length ?? 0, expectedDate: input.expectedDate ?? null }, reason: noteTxt ?? undefined }),
    ...supplierResponseNotify(db, po, actor, "propose", noteTxt),
  );
  if (!input.lines?.length && !input.expectedDate) throw new AppError(422, "validation_error", "Đề xuất cần ít nhất một thay đổi (số lượng, giá hoặc ngày giao)");
  await db.batch(stmts);
}

/** Cửa hàng chấp nhận / từ chối đề xuất của NCC. */
export async function decideProposal(db: D1Database, actor: PoActor, poId: number, b: { accept: boolean; reason?: string; version?: number }) {
  const po = await loadPo(db, poId);
  if (po.status !== "supplier_proposed") throw conflict("invalid_status", "PO không có đề xuất đang chờ", { status: po.status });
  if (b.version != null && b.version !== po.version) throw conflict("version_conflict", "PO vừa được thay đổi, vui lòng tải lại", { version: po.version });
  const guard = assertStmt(db, "po.proposal", `SELECT status = 'supplier_proposed' AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId]);
  if (b.accept) {
    // K-PO2: đề xuất của NCC làm tổng PO vượt ngưỡng duyệt (và tăng so với lúc duyệt) → cần chủ (purchasing.approve_high) chấp nhận
    if (actor.type === "staff" && actor.role && !can(actor.role, "purchasing.approve_high")) {
      const threshold = await getSettingInt(db, "approval.po_vnd", 20_000_000);
      const ls = await poLines(db, poId);
      const newTotal = ls.reduce((sum, l) => sum + lineValue(l.proposed_qty_milli ?? l.qty_milli, l.proposed_unit_cost ?? l.unit_cost), 0);
      if (newTotal > threshold && newTotal > po.total)
        throw conflict("owner_approval_required", "Đề xuất của NCC làm tổng PO vượt ngưỡng duyệt, cần chủ cửa hàng chấp nhận", { total: po.total, proposedTotal: newTotal, threshold });
    }
    await db.batch([
      guard,
      db.prepare(`UPDATE purchase_order_lines SET confirmed_qty_milli = COALESCE(proposed_qty_milli, qty_milli), confirmed_unit_cost = COALESCE(proposed_unit_cost, unit_cost) WHERE po_id = ?`).bind(poId),
      db
        .prepare(`UPDATE purchase_orders SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), expected_date = COALESCE(proposed_expected_date, expected_date), proposed_expected_date = NULL, version = version + 1 WHERE id = ? AND status = 'supplier_proposed'`)
        .bind(poId),
      recomputeTotalStmt(db, poId),
      audit(db, actor, { action: "po.proposal_accept", entityId: poId, before: { status: "supplier_proposed" }, after: { status: "confirmed" }, reason: b.reason }),
    ]);
    return;
  }
  if (!b.reason || b.reason.trim().length < 3) throw new AppError(422, "reason_required", "Từ chối đề xuất cần ghi lý do");
  await db.batch([
    guard,
    db.prepare(`UPDATE purchase_order_lines SET proposed_qty_milli = NULL, proposed_unit_cost = NULL WHERE po_id = ?`).bind(poId),
    db.prepare(`UPDATE purchase_orders SET status = 'sent', proposed_expected_date = NULL, reject_reason = ?, version = version + 1 WHERE id = ? AND status = 'supplier_proposed'`).bind(b.reason.trim(), poId),
    audit(db, actor, { action: "po.proposal_reject", entityId: poId, before: { status: "supplier_proposed" }, after: { status: "sent" }, reason: b.reason.trim() }),
  ]);
}

// ---------------------------------------------------------------- nhận hàng theo PO

export interface ReceiveInput {
  version?: number;
  locationId?: number;
  supplierRef?: string | null;
  vatAmount?: number;
  note?: string | null;
  lines: { poLineId: number; qtyMilli: number; expiresAt?: string | null; unitCost?: number | null }[];
}

/**
 * Nhận hàng theo PO (docs/PO-NCC.md 4.5). MỘT batch: phiếu nhập posted (po_id) + lô + thẻ kho + received_milli + hoá đơn mua (giá đã chốt;
 * tạm tính nếu chưa có số hoá đơn NCC) + trạng thái PO. Sau đó giữ FEFO cho phần thiếu của SO liên kết.
 */
export async function receivePo(db: D1Database, c: Ctx, poId: number, input: ReceiveInput) {
  const user = c.get("user");
  const po = await loadPo(db, poId);
  if (po.status !== "confirmed" && po.status !== "partially_received") throw conflict("invalid_status", `PO ${po.status} chưa nhận hàng được (cần NCC xác nhận trước)`, { status: po.status });
  if (input.version != null && input.version !== po.version) throw conflict("version_conflict", "PO vừa được thay đổi, vui lòng tải lại", { version: po.version });
  await assertPeriodOpen(db, new Date(), "phiếu nhập kho theo PO");
  if (!input.lines.length) throw new AppError(422, "empty_doc", "Chưa có dòng nhận hàng");
  if (new Set(input.lines.map((l) => l.poLineId)).size !== input.lines.length) throw new AppError(422, "validation_error", "Dòng PO bị lặp");

  const poL = await poLines(db, poId);
  const loc = input.locationId
    ? await db.prepare(`SELECT id, store_id FROM locations WHERE id = ? AND store_id = ?`).bind(input.locationId, po.store_id).first<{ id: number; store_id: number }>()
    : await db.prepare(`SELECT id, store_id FROM locations WHERE store_id = ? AND sellable = 1 ORDER BY id LIMIT 1`).bind(po.store_id).first<{ id: number; store_id: number }>();
  if (!loc) throw new AppError(422, "invalid_location", "Vị trí kho không tồn tại");

  const now = new Date();
  const nowIso = now.toISOString();
  const rows: { pl: any; qty: number; cost: number; expires: string | null }[] = [];
  let typedValue = 0; // giá trị các dòng do người nhận tự nhập giá (PO chưa có giá)
  for (const l of input.lines) {
    const pl = poL.find((x) => x.id === l.poLineId);
    if (!pl) throw new AppError(422, "line_not_in_po", "Dòng nhận không thuộc PO", { poLineId: l.poLineId });
    if (!Number.isInteger(l.qtyMilli) || l.qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng nhận phải lớn hơn 0", { poLineId: l.poLineId });
    const remaining = targetQty(pl) - pl.received_milli;
    if (l.qtyMilli > remaining) throw new AppError(422, "over_receive", "Số nhận vượt phần còn lại của PO", { poLineId: l.poLineId, remainingMilli: remaining });
    // K-PO3: giá đã chốt không bị ghi đè khi nhận (sai giá → hoá đơn mua khác giá B-09); chỉ dòng chưa có giá mới nhập giá nhận
    const fixed: number | null = pl.confirmed_unit_cost ?? pl.unit_cost ?? null;
    if (fixed != null && l.unitCost != null && l.unitCost !== fixed)
      throw new AppError(422, "unit_cost_locked", `Mặt hàng ${pl.product_name} đã có giá chốt ${fixed}, không sửa khi nhận hàng. Nếu NCC tính khác giá, hãy chốt hoá đơn mua khác giá`, { poLineId: l.poLineId, unitCost: fixed });
    const cost = fixed ?? l.unitCost ?? null;
    if (cost == null) throw new AppError(422, "missing_cost", `Mặt hàng ${pl.product_name} chưa có giá chốt, hãy nhập đơn giá`, { poLineId: l.poLineId });
    if (fixed == null) typedValue += lineValue(l.qtyMilli, cost);
    const prod = await db.prepare(`SELECT shelf_life_days FROM products WHERE id = ?`).bind(pl.product_id).first<{ shelf_life_days: number | null }>();
    const expires = l.expiresAt ?? (prod?.shelf_life_days ? new Date(now.getTime() + prod.shelf_life_days * 86400_000).toISOString() : null);
    rows.push({ pl, qty: l.qtyMilli, cost, expires });
  }
  if (typedValue > 0 && !can(user.role, "purchasing.approve_high")) {
    const threshold = await getSettingInt(db, "approval.po_vnd", 20_000_000);
    if (typedValue > threshold)
      throw conflict("owner_approval_required", "Giá nhận cho dòng PO chưa có giá vượt ngưỡng duyệt, cần chủ cửa hàng nhập giá hoặc chốt giá với NCC trước", { value: typedValue, threshold });
  }
  const total = rows.reduce((s, r) => s + lineValue(r.qty, r.cost), 0);
  const vat = input.vatAmount ?? 0;
  if (vat > total) throw new AppError(422, "vat_exceeds_total", "VAT đầu vào không được lớn hơn tổng tiền phiếu nhập", { vatAmount: vat, total });
  const ref = input.supplierRef?.trim() || null;
  const docCode = await nextCode(db, PREFIX.receipt);
  const sup = await db.prepare(`SELECT payment_terms_days d FROM suppliers WHERE id = ?`).bind(po.supplier_id).first<{ d: number | null }>();
  const issue = vnDate();
  const billCode = total > 0 ? await nextCode(db, "CNP") : null;

  // trạng thái PO sau khi nhận
  const afterReceived = new Map(poL.map((l) => [l.id, l.received_milli]));
  for (const r of rows) afterReceived.set(r.pl.id, r.pl.received_milli + r.qty);
  const complete = poL.every((l) => (afterReceived.get(l.id) ?? 0) >= targetQty(l));
  const newStatus = complete ? "received" : "partially_received";

  const docId = `(SELECT id FROM stock_docs WHERE code = ?)`;
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, "po.receive", `SELECT status IN ('confirmed','partially_received') AND version = ? FROM purchase_orders WHERE id = ?`, [po.version, poId]),
    ...rows.map((r) => assertStmt(db, "po.receive_line", `SELECT received_milli = ? FROM purchase_order_lines WHERE id = ?`, [r.pl.received_milli, r.pl.id])),
    db
      .prepare(
        `INSERT INTO stock_docs(code, type, status, store_id, location_id, supplier_id, supplier_ref, reason, note, total_amount, created_by, posted_at, vat_amount, po_id)
         VALUES (?, 'receipt', 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(docCode, loc.store_id, loc.id, po.supplier_id, ref, `Nhận hàng theo ${po.code}`, input.note ?? null, total, user.id, nowIso, vat, poId),
    db.prepare(`INSERT INTO stock_doc_post_guard(doc_id) SELECT id FROM stock_docs WHERE code = ?`).bind(docCode),
  ];
  for (const r of rows) {
    const tmp = `TMP-${crypto.randomUUID()}`;
    const base = r.pl.base_unit as string;
    stmts.push(
      db
        .prepare(`INSERT INTO stock_doc_lines(doc_id, product_id, unit, doc_qty_milli, qty_milli, unit_cost, expires_at, amount) VALUES (${docId},?,?,?,?,?,?,?)`)
        .bind(docCode, r.pl.product_id, base, targetQty(r.pl) - r.pl.received_milli, r.qty, r.cost, r.expires, lineValue(r.qty, r.cost)),
      db
        .prepare(
          `INSERT INTO lots(lot_code, product_id, location_id, supplier_id, receipt_doc_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli)
           VALUES (?,?,?,?,${docId},?,?,?,?,?)`,
        )
        .bind(tmp, r.pl.product_id, loc.id, po.supplier_id, docCode, nowIso, r.expires, r.cost, r.qty, r.qty),
      db
        .prepare(
          `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
           SELECT id, product_id, qty_in_milli, unit_cost, 'receipt', 'stock_doc', ${docId}, ? FROM lots WHERE lot_code = ?`,
        )
        .bind(docCode, user.id, tmp),
      db
        .prepare(`UPDATE stock_doc_lines SET lot_id = (SELECT id FROM lots WHERE lot_code = ?) WHERE doc_id = ${docId} AND product_id = ? AND lot_id IS NULL`)
        .bind(tmp, docCode, r.pl.product_id),
      db.prepare(`UPDATE lots SET lot_code = 'HML' || substr('00000000' || id, -8) WHERE lot_code = ?`).bind(tmp),
      db.prepare(`UPDATE purchase_order_lines SET received_milli = received_milli + ? WHERE id = ? AND po_id = ?`).bind(r.qty, r.pl.id, poId),
    );
  }
  if (billCode)
    stmts.push(
      db
        .prepare(
          `INSERT INTO supplier_bills(code, supplier_id, stock_doc_id, supplier_ref, is_provisional, issue_date, due_date, total, created_by, vat_amount, note)
           VALUES (?,?,${docId},?,?,?,?,?,?,?,?)`,
        )
        .bind(billCode, po.supplier_id, docCode, ref, ref ? 0 : 1, issue, addDays(issue, sup?.d ?? 0), total, user.id, vat, `Theo ${po.code}`),
    );
  stmts.push(
    db.prepare(`UPDATE purchase_orders SET status = ?, version = version + 1${complete ? ", closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ""} WHERE id = ? AND status IN ('confirmed','partially_received') AND version = ?`).bind(newStatus, poId, po.version),
    audit(db, { type: "staff", userId: user.id, c }, {
      action: "po.receive", entityId: poId, before: { status: po.status },
      after: { status: newStatus, doc: docCode, bill: billCode, total, lines: rows.map((r) => ({ poLineId: r.pl.id, productId: r.pl.product_id, qtyMilli: r.qty })) },
    }),
  );
  await db.batch(stmts);

  const filled = await allocateReceivedToShortages(
    db,
    rows.map((r) => ({ poLineId: r.pl.id, productId: r.pl.product_id, qtyMilli: r.qty })),
    user.id,
    po.code,
  );
  const doc = await db.prepare(`SELECT id, code FROM stock_docs WHERE code = ?`).bind(docCode).first<{ id: number; code: string }>();
  const bill = billCode ? await db.prepare(`SELECT id, code, is_provisional FROM supplier_bills WHERE code = ?`).bind(billCode).first<{ id: number; code: string; is_provisional: number }>() : null;
  return { status: newStatus, doc, bill, filled };
}
