/**
 * G9 — Trả hàng nhanh (không cần hoá đơn gốc) và Sửa chi tiết hoá đơn POS đã lập (docs/API.md cuối tệp).
 *
 * Trả hàng nhanh: phiếu `orders(kind='return')` KHÔNG có original_order_id, kênh pos; hoàn theo GIÁ BÁN HIỆN HÀNH (chỉ được sửa giảm),
 *   bắt buộc lý do, thu ngân cần quản lý duyệt (phiếu một lần, gắn đúng hàng + số tiền), hoàn tiền từ két ca đang mở / quỹ khác.
 * Sửa hoá đơn: không sửa chứng từ cũ — MỘT batch lập phiếu trả toàn bộ đơn cũ (nhập lại đúng lô) + đơn bán mới đã sửa, chuyển các khoản
 *   đã thanh toán sang đơn mới (không ra tiền), chênh lệch thu thêm / hoàn qua két ca đang mở.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { lineAmount } from "../lib/money";
import { vnPeriod } from "../lib/time";
import { allocateFefo, allocationCost, LOT_NOT_LOCKED_SQL, moveStatements, type LotAllocation } from "../services/stock";
import { resolvePrice } from "../services/pricing";
import { assertStmt, onceStmt } from "../services/guard";
import { assertPeriodOpen } from "../services/period";
import { retireStaleDraft } from "../services/online-ops";
import { promoStatements, type PromoPlan } from "../services/promo-checkout";
import { chargeStmts, type ResolvedCharge } from "../services/order-charges";
import { creditInvoiceOf } from "../services/pos-credit";
import { parseBody } from "../services/http";
import {
  fundFor, getOrderFull, insertReturnLines, isCheckFail, MAX_QTY, MAX_VND, METHODS, openShiftOf, prepareReturnLines, returnApprovalReasons,
  returnEffectStmts, returnGuardStmts, splitAlloc, unitFactor, type Ctx,
} from "./pos";

export const posReturnRoutes = new Hono<AppBindings>();

type Method = (typeof METHODS)[number];

/** Băm SHA-256 của nội dung chuẩn hoá — gắn phiếu duyệt với đúng yêu cầu (hàng, số lượng, giá, số tiền). */
async function sha256(canon: unknown) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canon)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Phiếu duyệt dùng chung cho trả hàng nhanh (`order.quick_return`) và sửa hoá đơn (`order.correct`): trả approvalId đã duyệt còn hiệu lực
 * (đúng người yêu cầu, đúng băm, chưa dùng), hoặc tạo/tái dùng phiếu chờ rồi ném 409 approval_required. Không tự duyệt.
 */
async function requireDocApproval(c: Ctx, type: string, approvalId: number | undefined, hash: string, reasons: string[], payload: object, label: string): Promise<number> {
  const db = c.env.DB;
  const user = c.get("user");
  if (approvalId) {
    const a = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(approvalId).first<any>();
    const match = a && a.type === type && a.requested_by === user.id && (() => { try { return JSON.parse(a.payload_json ?? "{}").hash === hash; } catch { return false; } })();
    if (match) {
      if (a.status === "approved" && !a.ref_id) return a.id;
      if (a.status === "rejected") throw new AppError(403, "approval_rejected", `Yêu cầu duyệt ${label} đã bị từ chối`, { approvalId: a.id });
      if (a.status === "pending") throw conflict("approval_required", `Đang chờ quản lý duyệt ${label}`, { approvalId: a.id, reasons });
    }
    throw conflict("approval_invalid", "Mã duyệt không hợp lệ, không khớp nội dung hoặc đã được sử dụng", { approvalId });
  }
  const pending = await db
    .prepare(`SELECT id FROM approvals WHERE type=? AND status='pending' AND requested_by=? AND json_extract(payload_json,'$.hash')=?`)
    .bind(type, user.id, hash)
    .first<{ id: number }>();
  let id = pending?.id;
  if (!id) {
    const r = await db
      .prepare(`INSERT INTO approvals(type, ref_type, payload_json, reason, requested_by) VALUES (?,?,?,?,?)`)
      .bind(type, "order_return_draft", JSON.stringify({ hash, reasons, ...payload }), reasons.join(","), user.id)
      .run();
    id = r.meta.last_row_id as number;
    await auditStmt(c, { action: "approval.request", entity: "approval", entityId: id, after: { type, reasons, ...payload } }).run();
  }
  throw conflict("approval_required", `Cần quản lý duyệt ${label}`, { approvalId: id, reasons });
}

// ===================== Trả hàng nhanh (không cần hoá đơn gốc) =====================

const quickSchema = z.object({
  clientUuid: z.string().min(8).max(64),
  customerId: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        unit: z.string().min(1).max(20),
        qty: z.number().positive().max(MAX_QTY),
        unitPrice: z.number().int().min(0).max(MAX_VND).optional(), // VND / đơn vị chính, chỉ được GIẢM so với giá hiện hành
        restock: z.boolean(), // true: nhập lại kho; false: hao hụt (không nhập)
      }),
    )
    .min(1)
    .max(100),
  reason: z.string().trim().min(3).max(300),
  refundMethod: z.enum(METHODS).default("cash"),
  approvalId: z.number().int().positive().optional(),
});

/** Lô nhận hàng trả: lô FEFO gần nhất (đang bán được ở cửa hàng); không có thì null → tạo lô mới. */
async function nearestLot(db: D1Database, productId: number, storeId: number) {
  return db
    .prepare(
      `SELECT l.id, l.unit_cost FROM lots l JOIN locations loc ON loc.id = l.location_id
        WHERE l.product_id = ? AND loc.store_id = ? AND loc.sellable = 1 AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > ?) AND ${LOT_NOT_LOCKED_SQL}
        ORDER BY (l.expires_at IS NULL), l.expires_at, l.received_at, l.id LIMIT 1`,
    )
    .bind(productId, storeId, new Date().toISOString())
    .first<{ id: number; unit_cost: number }>();
}

posReturnRoutes.post("/pos/quick-return", requirePerm("pos.return"), async (c) => {
  const body = await parseBody(c, quickSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const done = async (id: number, status: 200 | 201) => c.json(await getOrderFull(c, id), status);

  let existing = await db.prepare(`SELECT id, status, created_at FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number; status: string; created_at: string }>();
  if (existing && existing.status === "draft" && Date.parse(existing.created_at) < Date.now() - 120_000) {
    await retireStaleDraft(db, existing.id);
    existing = null;
  }
  if (existing && existing.status === "completed") return done(existing.id, 200);
  if (existing) throw conflict("order_in_progress", "Phiếu đang xử lý hoặc đã huỷ, vui lòng tạo phiếu mới với clientUuid khác");

  const shift = await openShiftOf(db, user.id);
  if (!shift) throw conflict("no_open_shift", "Cần mở ca để trả hàng (tiền hoàn đi qua két của ca)");
  const storeId = shift.store_id as number;
  await assertPeriodOpen(db, new Date(), "trả hàng");

  const customer = body.customerId ? await db.prepare(`SELECT id, customer_group_id FROM customers WHERE id = ? AND active = 1`).bind(body.customerId).first<any>() : null;
  if (body.customerId && !customer) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");

  // Giá hoàn = giá bán HIỆN HÀNH (nhóm giá của khách); thu ngân chỉ được sửa giảm
  type Item = { productId: number; unit: string; qtyMilli: number; unitPrice: number; priceListId: number; listGross: number; lineTotal: number; restock: boolean; lotId: number | null; unitCost: number; cost: number };
  const items: Item[] = [];
  for (const l of body.lines) {
    const { factor } = await unitFactor(db, l.productId, l.unit);
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    const cur = await resolvePrice(db, l.productId, { channel: "pos", customerGroupId: customer?.customer_group_id, customerId: customer?.id });
    if (l.unitPrice != null && l.unitPrice > cur.unitPrice)
      throw new AppError(422, "price_above_current", "Giá hoàn không được cao hơn giá bán hiện hành", { productId: l.productId, current: cur.unitPrice, requested: l.unitPrice });
    const price = l.unitPrice ?? cur.unitPrice;
    const lot = await nearestLot(db, l.productId, storeId);
    // Giá vốn tham chiếu: lô nhận hàng; chưa có lô nào thì lấy lô nhập gần nhất (mọi trạng thái), cuối cùng 0
    const unitCost = lot?.unit_cost ?? (await db.prepare(`SELECT unit_cost FROM lots WHERE product_id = ? ORDER BY received_at DESC, id DESC LIMIT 1`).bind(l.productId).first<{ unit_cost: number }>())?.unit_cost ?? 0;
    items.push({
      productId: l.productId, unit: l.unit, qtyMilli, unitPrice: price, priceListId: cur.priceListId, listGross: lineAmount(cur.unitPrice, qtyMilli),
      lineTotal: lineAmount(price, qtyMilli), restock: l.restock, lotId: l.restock ? lot?.id ?? null : null, unitCost,
      cost: allocationCost([{ lotId: lot?.id ?? 0, qtyMilli, unitCost }]),
    });
  }
  const total = items.reduce((s, i) => s + i.lineTotal, 0);
  const costTotal = items.reduce((s, i) => s + i.cost, 0);
  if (total <= 0) throw new AppError(422, "invalid_amount", "Giá trị hàng trả phải lớn hơn 0");
  if (total > MAX_VND) throw new AppError(422, "invalid_amount", "Giá trị hàng trả quá lớn");
  const fundId = await fundFor(db, storeId, body.refundMethod, shift);

  // Mọi phiếu trả nhanh đều cần quản lý duyệt (quản lý/chủ có approvals.decide tự lập, vẫn bắt buộc lý do + ghi nhật ký)
  let approvalUsed: number | null = null;
  if (!can(user.role, "approvals.decide")) {
    const hash = await sha256({
      k: "quick_return", c: body.customerId ?? null, m: body.refundMethod, r: body.reason, t: total,
      l: items.map((i) => [i.productId, i.unit, i.qtyMilli, i.unitPrice, i.restock]).sort((a, b) => Number(a[0]) - Number(b[0]) || String(a[1]).localeCompare(String(b[1])) || Number(a[2]) - Number(b[2])),
    });
    approvalUsed = await requireDocApproval(c, "order.quick_return", body.approvalId, hash, ["quick_return"], { total, customerId: body.customerId ?? null, reason: body.reason, lines: items.length }, "trả hàng nhanh");
  }

  const code = await nextCode(db, PREFIX.return);
  const note = `Trả hàng nhanh: ${body.reason}`.slice(0, 500);
  let retId: number;
  try {
    const r = await db
      .prepare(`INSERT INTO orders(code, client_uuid, channel, kind, store_id, shift_id, customer_id, status, note, created_by) VALUES (?,?,?,'return',?,?,?,'draft',?,?)`)
      .bind(code, body.clientUuid, "pos", storeId, shift.id, body.customerId ?? null, note, user.id)
      .run();
    retId = r.meta.last_row_id as number;
  } catch (e) {
    const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number }>();
    if (again) return done(again.id, 200);
    throw e;
  }
  const nowIso = new Date().toISOString();
  try {
    const stmts: D1PreparedStatement[] = [
      assertStmt(db, "order.quick_return.shift", `SELECT status = 'open' FROM shifts WHERE id = ?`, [shift.id]),
      assertStmt(db, "order.quick_return.period", `SELECT NOT EXISTS (SELECT 1 FROM periods WHERE period = ? AND locked_at IS NOT NULL)`, [vnPeriod(new Date())]),
      onceStmt(db, "order.quick_return", retId),
      ...(approvalUsed
        ? [assertStmt(db, "order.quick_return.approval", `SELECT status = 'approved' AND ref_id IS NULL FROM approvals WHERE id = ?`, [approvalUsed]), onceStmt(db, "order.quick_return.approval", approvalUsed)]
        : []),
    ];
    let lotSeq = 0;
    for (const it of items) {
      const row = await db
        .prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, cost_amount) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
        .bind(retId, it.productId, it.unit, it.qtyMilli, it.unitPrice, it.priceListId, Math.max(0, it.listGross - it.lineTotal), it.lineTotal, it.cost)
        .first<{ id: number }>();
      const lineId = row!.id;
      if (!it.restock) continue; // hao hụt: không nhập kho (báo cáo ghi vào hao hụt theo giá vốn dòng)
      if (it.lotId) {
        stmts.push(
          assertStmt(db, "order.quick_return.lot", `SELECT status = 'active' FROM lots WHERE id = ?`, [it.lotId]),
          db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(lineId, it.lotId, it.qtyMilli, it.unitCost),
          ...moveStatements(db, it.productId, [{ lotId: it.lotId, qtyMilli: it.qtyMilli, unitCost: it.unitCost }], 1, "return", "order", retId, user.id),
        );
      } else {
        // Chưa có lô nào nhận được: tạo lô mới (cùng batch) ở vị trí bán được đầu tiên của cửa hàng
        const loc = await db.prepare(`SELECT id FROM locations WHERE store_id = ? AND sellable = 1 ORDER BY id LIMIT 1`).bind(storeId).first<{ id: number }>();
        if (!loc) throw new AppError(422, "no_location", "Chưa có vị trí kho bán được để nhập lại hàng trả");
        const lotCode = `TH-${code}-${++lotSeq}`;
        stmts.push(
          db.prepare(`INSERT INTO lots(lot_code, product_id, location_id, received_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,?,?,?,?)`).bind(lotCode, it.productId, loc.id, nowIso, it.unitCost, it.qtyMilli, it.qtyMilli),
          db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) SELECT ?, id, ?, ? FROM lots WHERE lot_code = ?`).bind(lineId, it.qtyMilli, it.unitCost, lotCode),
          db
            .prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id) SELECT id, ?, ?, ?, 'return', 'order', ?, ? FROM lots WHERE lot_code = ?`)
            .bind(it.productId, it.qtyMilli, it.unitCost, retId, user.id, lotCode),
        );
      }
    }
    stmts.push(
      db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(retId, body.refundMethod, -total, fundId, "quick_return"),
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, total=?, cost_total=?, paid_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(total, total, costTotal, total, retId),
      ...(approvalUsed ? [db.prepare(`UPDATE approvals SET ref_type='order', ref_id=? WHERE id=? AND ref_id IS NULL`).bind(String(retId), approvalUsed)] : []),
      auditStmt(c, {
        action: "order.quick_return", entity: "order", entityId: retId,
        after: { code, total, refundMethod: body.refundMethod, customerId: body.customerId ?? null, approvalId: approvalUsed, shiftId: shift.id, lines: items.map((i) => ({ productId: i.productId, qtyMilli: i.qtyMilli, unitPrice: i.unitPrice, restock: i.restock })) },
        reason: body.reason,
      }),
    );
    await db.batch(stmts);
  } catch (e) {
    await db.prepare(`DELETE FROM order_lines WHERE order_id = ? AND (SELECT status FROM orders WHERE id = ?) = 'draft'`).bind(retId, retId).run();
    await db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(retId).run();
    if (/state_changed/.test(String((e as Error)?.message))) {
      if (!(await db.prepare(`SELECT 1 AS x FROM shifts WHERE id = ? AND status = 'open'`).bind(shift.id).first())) throw conflict("shift_closed", "Ca bán hàng vừa được chốt — mở ca mới để trả hàng");
      throw conflict("state_changed", "Dữ liệu vừa thay đổi (phiếu duyệt đã dùng, lô không còn hoạt động hoặc kỳ vừa khoá) — thử lại");
    }
    if (/already_done|UNIQUE constraint failed: once_keys/.test(String((e as Error)?.message))) throw conflict("already_done", "Phiếu duyệt đã được dùng cho một phiếu trả khác");
    throw e;
  }
  return done(retId, 201);
});

// ===================== Sửa chi tiết hoá đơn đã lập =====================

const correctSchema = z.object({
  clientUuid: z.string().min(8).max(64),
  reason: z.string().trim().min(3).max(300),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        unit: z.string().min(1).max(20),
        qty: z.number().positive().max(MAX_QTY),
        originalLineId: z.number().int().positive().optional(), // dòng của đơn cũ: giữ giá (và giảm giá theo tỷ lệ) của dòng đó
        unitPrice: z.number().int().min(0).max(MAX_VND).optional(), // chỉ được GIẢM so với giá cơ sở của dòng
      }),
    )
    .min(1)
    .max(200),
  refundMethod: z.enum(METHODS).default("cash"), // hình thức hoàn phần chênh khi đơn mới rẻ hơn
  payments: z.array(z.object({ method: z.enum(METHODS), amount: z.number().int().positive().max(MAX_VND), ref: z.string().max(100).optional() })).max(10).default([]), // khách trả thêm
  approvalId: z.number().int().positive().optional(),
});

posReturnRoutes.post("/orders/:id/correct", requirePerm("orders.edit", "pos.sell", "pos.return"), async (c) => {
  const origId = Number(c.req.param("id"));
  if (!Number.isInteger(origId) || origId <= 0) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  const body = await parseBody(c, correctSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const done = async (saleId: number, status: 200 | 201, extra: object = {}) => {
    const sale = await getOrderFull(c, saleId);
    const ret = await db.prepare(`SELECT id FROM orders WHERE original_order_id = ? AND kind = 'return' AND status = 'completed' ORDER BY id DESC LIMIT 1`).bind(sale.corrected_from_order_id ?? origId).first<{ id: number }>();
    return c.json({ sale, return: ret ? await getOrderFull(c, ret.id) : null, ...extra }, status);
  };

  let existing = await db.prepare(`SELECT id, status, created_at FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number; status: string; created_at: string }>();
  if (existing && existing.status === "draft" && Date.parse(existing.created_at) < Date.now() - 120_000) {
    await retireStaleDraft(db, existing.id);
    existing = null;
  }
  if (existing && existing.status === "completed") return done(existing.id, 200);
  if (existing) throw conflict("order_in_progress", "Đơn đang xử lý hoặc đã huỷ, vui lòng tạo lại với clientUuid khác");

  const orig = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(origId).first<any>();
  if (!orig) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (orig.kind !== "sale" || orig.status !== "completed") throw conflict("not_correctable", "Chỉ sửa được đơn bán đã hoàn tất");
  if (orig.channel !== "pos" || orig.source || orig.pos_shift_id) throw conflict("not_correctable", "Chỉ sửa hoá đơn bán tại quầy POS (đơn giao hàng/online/sỉ có luồng riêng)");
  if (await db.prepare(`SELECT 1 AS x FROM orders WHERE original_order_id = ? AND kind = 'return' AND status = 'completed' LIMIT 1`).bind(origId).first())
    throw conflict("not_correctable", "Đơn đã có phiếu trả hàng hoặc đã được sửa — không sửa tiếp được");
  if (await creditInvoiceOf(db, origId)) throw conflict("credit_order_no_correct", "Đơn có ghi nợ không sửa được — dùng Trả hàng (trừ vào nợ) rồi bán đơn mới");
  if (await db.prepare(`SELECT 1 AS x FROM order_discounts WHERE order_id = ? LIMIT 1`).bind(origId).first())
    throw conflict("promo_order_no_correct", "Đơn có khuyến mãi / voucher / điểm đổi không sửa được — dùng Trả hàng rồi bán đơn mới");
  if (await db.prepare(`SELECT 1 AS x FROM order_deposits WHERE order_id = ? LIMIT 1`).bind(origId).first())
    throw conflict("preorder_no_correct", "Đơn đặt trước (có cọc) không sửa được — dùng Trả hàng để hoàn đủ tiền");
  // Kỳ của đơn cũ (cùng ngày hoặc kỳ chưa khoá) và kỳ hiện tại đều phải mở
  const origWhen = orig.completed_at ?? orig.created_at;
  await assertPeriodOpen(db, origWhen, "sửa hoá đơn");
  await assertPeriodOpen(db, new Date(), "sửa hoá đơn");
  const shift = await openShiftOf(db, user.id);
  if (!shift) throw conflict("no_open_shift", "Cần mở ca để sửa hoá đơn (tiền chênh lệch đi qua két của ca)");
  const storeId = shift.store_id as number;

  // 1) Phiếu trả toàn bộ đơn cũ (đúng lô gốc), kèm hoàn thu khác để đơn mới tự mang lại
  const origLines = (await db.prepare(`SELECT ol.*, p.base_unit FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`).bind(origId).all<any>()).results;
  const { prepared, claimed, total: goodsReturn, costTotal: returnCost } = await prepareReturnLines(
    db, origId, origLines.map((l) => ({ orderLineId: l.id, qty: l.qty_milli / 1000, unit: l.base_unit, restock: true, reason: body.reason })),
  );
  const oldCharges = (await db.prepare(`SELECT charge_type_id, name, amount, refunded_amount FROM order_charges WHERE order_id = ? ORDER BY id`).bind(origId).all<any>()).results;
  const chargesRefund = oldCharges.reduce((s, x) => s + (x.amount - x.refunded_amount), 0);
  const returnTotal = goodsReturn + chargesRefund;
  if (returnTotal !== orig.total) throw conflict("not_correctable", "Dữ liệu đơn không khớp (đã có điều chỉnh) — không sửa tự động được");
  const carriedCharges: ResolvedCharge[] = oldCharges.map((x) => ({ chargeTypeId: x.charge_type_id, name: x.name, amount: x.amount }));
  const chargesTotal = carriedCharges.reduce((s, x) => s + x.amount, 0);

  // 2) Đơn bán mới: dòng giữ nguyên → giữ giá cũ (+ giảm giá theo tỷ lệ); dòng mới → giá hiện hành; chỉ được sửa GIẢM
  const customer = orig.customer_id ? await db.prepare(`SELECT id, customer_group_id FROM customers WHERE id = ?`).bind(orig.customer_id).first<any>() : null;
  type Item = { productId: number; unit: string; qtyMilli: number; unitPrice: number; priceListId: number | null; discount: number; lineTotal: number };
  const items: Item[] = [];
  for (const l of body.lines) {
    const { factor } = await unitFactor(db, l.productId, l.unit);
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng không hợp lệ");
    let basePrice: number;
    let priceListId: number | null;
    let keptDiscount = 0;
    if (l.originalLineId) {
      const ol = origLines.find((x) => x.id === l.originalLineId);
      if (!ol || ol.product_id !== l.productId) throw new AppError(422, "line_mismatch", "Dòng giữ giá không thuộc đơn cũ hoặc khác mặt hàng", { originalLineId: l.originalLineId });
      basePrice = ol.unit_price;
      priceListId = ol.price_list_id;
      keptDiscount = Math.round((ol.discount * qtyMilli) / ol.qty_milli);
    } else {
      const cur = await resolvePrice(db, l.productId, { channel: "pos", customerGroupId: customer?.customer_group_id, customerId: customer?.id });
      basePrice = cur.unitPrice;
      priceListId = cur.priceListId;
    }
    if (l.unitPrice != null && l.unitPrice > basePrice)
      throw new AppError(422, "price_above_current", "Giá không được cao hơn giá hiện hành (hoặc giá cũ của dòng giữ nguyên)", { productId: l.productId, base: basePrice, requested: l.unitPrice });
    const price = l.unitPrice ?? basePrice;
    const gross = lineAmount(price, qtyMilli);
    const discount = Math.min(keptDiscount, gross);
    items.push({ productId: l.productId, unit: l.unit, qtyMilli, unitPrice: price, priceListId, discount, lineTotal: gross - discount });
  }
  const goodsTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const subtotal = items.reduce((s, i) => s + i.lineTotal + i.discount, 0);
  const newTotal = goodsTotal + chargesTotal;

  // 3) Dòng tiền: các khoản đã thanh toán chuyển sang đơn mới (không ra tiền); chênh lệch thu thêm / hoàn qua ca đang mở
  const oldPays = (await db.prepare(`SELECT method, amount, fund_id FROM payments WHERE order_id = ? AND status = 'confirmed' AND amount > 0 ORDER BY id`).bind(origId).all<any>()).results;
  if (oldPays.some((p) => !(METHODS as readonly string[]).includes(p.method))) throw conflict("not_correctable", "Đơn có hình thức thanh toán không sửa tự động được (COD/công nợ)");
  const oldPaid = oldPays.reduce((s, p) => s + p.amount, 0);
  if (oldPaid !== orig.total) throw conflict("not_correctable", "Đơn chưa thu đủ hoặc có điều chỉnh tiền — không sửa tự động được");
  const carryTotal = Math.min(newTotal, oldPaid);
  let left = carryTotal;
  const carries: { method: Method; fund_id: number | null; amount: number }[] = [];
  for (const p of oldPays) {
    const take = Math.min(p.amount, left);
    if (take > 0) carries.push({ method: p.method, fund_id: p.fund_id, amount: take });
    left -= take;
  }
  const refundAmount = oldPaid - carryTotal; // đơn mới rẻ hơn: hoàn khách
  const extraDue = newTotal - oldPaid; // đơn mới đắt hơn: khách trả thêm
  let recorded: { method: Method; amount: number; ref?: string }[] = [];
  let change = 0;
  if (extraDue > 0) {
    const paid = body.payments.reduce((s, p) => s + p.amount, 0);
    if (paid < extraDue) throw new AppError(422, "payment_mismatch", "Khách chưa trả đủ phần chênh lệch", { extraDue, paid });
    const cashTotal = body.payments.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
    change = paid - extraDue;
    if (change > cashTotal) throw new AppError(422, "payment_mismatch", "Thanh toán vượt phần chênh lệch (chỉ tiền mặt được thối lại)", { extraDue, paid });
    recorded = body.payments.map((p) => ({ ...p }));
    let toCut = change;
    for (let i = recorded.length - 1; i >= 0 && toCut > 0; i--) {
      if (recorded[i].method !== "cash") continue;
      const cut = Math.min(recorded[i].amount, toCut);
      recorded[i].amount -= cut;
      toCut -= cut;
    }
  } else if (body.payments.length) throw new AppError(422, "payment_not_needed", "Không có phần chênh lệch khách phải trả, không nhập thanh toán", { extraDue });
  const payFunds = new Map<string, number>();
  for (const p of recorded) if (!payFunds.has(p.method)) payFunds.set(p.method, await fundFor(db, storeId, p.method, shift));
  const refundFund = refundAmount > 0 ? await fundFor(db, storeId, body.refundMethod, shift) : null;

  // 4) Quyền + ngưỡng duyệt như Trả hàng (đơn ca khác đã chốt / giá trị ≥ ngưỡng). Quản lý/chủ (approvals.decide) tự làm.
  let approvalUsed: number | null = null;
  if (!can(user.role, "approvals.decide")) {
    const reasons = await returnApprovalReasons(db, orig, shift, prepared, returnTotal);
    if (reasons.length) {
      const hash = await sha256({
        k: "correct", o: origId, m: body.refundMethod, r: body.reason, t: newTotal,
        l: items.map((i) => [i.productId, i.unit, i.qtyMilli, i.unitPrice, i.discount]).sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[2]) - Number(b[2])),
      });
      approvalUsed = await requireDocApproval(c, "order.correct", body.approvalId, hash, reasons, { originalOrderId: origId, oldTotal: orig.total, total: newTotal, newTotal, reason: body.reason }, "sửa hoá đơn");
    }
  }

  // 5) Tồn: hàng mới ưu tiên dùng lại đúng lô vừa nhập lại từ đơn cũ (cùng mặt hàng), phần còn thiếu lấy FEFO
  const plan = async () => {
    const byProduct = new Map<number, number[]>();
    items.forEach((it, i) => byProduct.set(it.productId, [...(byProduct.get(it.productId) ?? []), i]));
    const lineAllocs: LotAllocation[][] = new Array(items.length);
    const productAllocs = new Map<number, LotAllocation[]>();
    for (const [pid, idxs] of byProduct) {
      const need = idxs.reduce((s, i) => s + items[i].qtyMilli, 0);
      const alloc: LotAllocation[] = [];
      let remaining = need;
      for (const x of prepared.filter((q) => q.orig.product_id === pid))
        for (const a of x.alloc) {
          if (remaining <= 0) break;
          const take = Math.min(a.qtyMilli, remaining);
          alloc.push({ lotId: a.lotId, unitCost: a.unitCost, qtyMilli: take });
          remaining -= take;
        }
      if (remaining > 0) alloc.push(...(await allocateFefo(db, pid, remaining, storeId)));
      productAllocs.set(pid, alloc);
      splitAlloc(alloc, idxs.map((i) => items[i].qtyMilli)).forEach((a, k) => (lineAllocs[idxs[k]] = a));
    }
    const costs = lineAllocs.map((a) => allocationCost(a));
    if (items.some((it, i) => it.lineTotal < costs[i]) && !can(user.role, "approvals.decide"))
      throw new AppError(422, "correct_below_cost", "Giá dòng mới thấp hơn giá vốn — nhờ quản lý thực hiện");
    return { lineAllocs, productAllocs, costs };
  };
  let p = await plan();

  // 6) Hai chứng từ nháp (trả + bán mới), rồi MỘT batch hoàn tất
  const retCode = await nextCode(db, PREFIX.return);
  const saleCode = await nextCode(db, PREFIX.order);
  const retNote = `Sửa hoá đơn ${orig.code}: ${body.reason}`.slice(0, 500);
  const retRes = await db
    .prepare(`INSERT INTO orders(code, channel, kind, original_order_id, store_id, shift_id, customer_id, status, note, created_by) VALUES (?,?,'return',?,?,?,?,'draft',?,?)`)
    .bind(retCode, "pos", origId, orig.store_id, shift.id, orig.customer_id, retNote, user.id)
    .run();
  const retId = retRes.meta.last_row_id as number;
  let saleId: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, shift_id, customer_id, status, note, created_by, seller_id, corrected_from_order_id)
         VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?)`,
      )
      .bind(saleCode, body.clientUuid, "pos", "sale", storeId, shift.id, orig.customer_id, orig.note ?? null, user.id, orig.seller_id ?? orig.created_by ?? null, origId)
      .run();
    saleId = r.meta.last_row_id as number;
  } catch (e) {
    await db.prepare(`UPDATE orders SET status='cancelled' WHERE id=? AND status='draft'`).bind(retId).run();
    const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(body.clientUuid).first<{ id: number }>();
    if (again) return done(again.id, 200);
    if (/corrected_from/.test(String((e as Error)?.message))) throw conflict("not_correctable", "Đơn này đã được sửa rồi");
    throw e;
  }
  const cancelDrafts = () => db.prepare(`UPDATE orders SET status='cancelled' WHERE id IN (?,?) AND status='draft'`).bind(retId, saleId).run();
  const emptyPlan = { discounts: [], rejected: [], voucher: null, points: 0, pointsAmount: 0, promoLineDiscounts: [], pointsLineDiscounts: [], lineDiscounts: [], promoTotal: 0 } as PromoPlan;

  const commit = async () => {
    await db.prepare(`DELETE FROM order_lines WHERE order_id IN (?,?)`).bind(retId, saleId).run();
    const retLineIds = await insertReturnLines(db, retId, prepared);
    const saleLineIds: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const row = await db
        .prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, cost_amount) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
        .bind(saleId, it.productId, it.unit, it.qtyMilli, it.unitPrice, it.priceListId, it.discount, it.lineTotal, p.costs[i])
        .first<{ id: number }>();
      saleLineIds.push(row!.id);
    }
    const saleCost = p.costs.reduce((s, x) => s + x, 0);
    const stmts: D1PreparedStatement[] = [
      assertStmt(db, "order.correct.shift", `SELECT status = 'open' FROM shifts WHERE id = ?`, [shift.id]),
      assertStmt(db, "order.correct.period", `SELECT NOT EXISTS (SELECT 1 FROM periods WHERE period IN (?,?) AND locked_at IS NOT NULL)`, [vnPeriod(new Date(origWhen)), vnPeriod(new Date())]),
      onceStmt(db, "order.correct", origId),
      ...(approvalUsed ? [onceStmt(db, "order.correct.approval", approvalUsed)] : []),
      ...returnGuardStmts(db, origId, approvalUsed, claimed, returnTotal),
      ...(await returnEffectStmts(db, orig, origId, retId, retCode, prepared, retLineIds, goodsReturn, user.id)),
    ];
    if (chargesRefund > 0)
      stmts.push(
        assertStmt(db, "order.correct.charges", `SELECT COALESCE(SUM(amount - refunded_amount),0) = ? FROM order_charges WHERE order_id = ?`, [chargesRefund, origId]),
        db.prepare(`UPDATE order_charges SET refunded_amount = amount WHERE order_id = ?`).bind(origId),
      );
    items.forEach((_, i) => {
      for (const a of p.lineAllocs[i]) stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(saleLineIds[i], a.lotId, a.qtyMilli, a.unitCost));
    });
    for (const [pid, alloc] of p.productAllocs) stmts.push(...moveStatements(db, pid, alloc, -1, "sale", "order", saleId, user.id));
    // Tiền: phiếu trả đảo đúng các khoản đã thu (phần chuyển sang đơn mới giữ nguyên hình thức/quỹ) + phần hoàn khách; đơn mới nhận phần chuyển + phần thu thêm
    const pay = (orderId: number, method: string, amount: number, fund: number | null, ref: string | null) =>
      db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(orderId, method, amount, fund, ref);
    for (const cr of carries) {
      stmts.push(pay(retId, cr.method, -cr.amount, cr.fund_id, `correct:${saleCode}`), pay(saleId, cr.method, cr.amount, cr.fund_id, `correct:${retCode}`));
    }
    if (refundAmount > 0) stmts.push(pay(retId, body.refundMethod, -refundAmount, refundFund, `correct-refund:${saleCode}`));
    for (const r of recorded) if (r.amount > 0) stmts.push(pay(saleId, r.method, r.amount, payFunds.get(r.method)!, r.ref ?? null));
    stmts.push(...chargeStmts(db, saleId, carriedCharges));
    stmts.push(...(await promoStatements(db, { sql: "?", bind: saleId }, { plan: emptyPlan, customerId: orig.customer_id, payableTotal: goodsTotal, userId: user.id })));
    stmts.push(
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, total=?, cost_total=?, paid_total=?, charges_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(goodsReturn, returnTotal, returnCost, returnTotal, chargesRefund, retId),
      db
        .prepare(`UPDATE orders SET status='completed', subtotal=?, discount=?, total=?, cost_total=?, paid_total=?, charges_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='draft'`)
        .bind(subtotal, subtotal - goodsTotal, newTotal, saleCost, newTotal, chargesTotal, saleId),
      ...(approvalUsed ? [db.prepare(`UPDATE approvals SET ref_type='order', ref_id=? WHERE id=? AND ref_id IS NULL`).bind(String(saleId), approvalUsed)] : []),
      auditStmt(c, {
        action: "order.return", entity: "order", entityId: retId,
        after: { code: retCode, originalOrderId: origId, total: returnTotal, correctionOrderId: saleId, approvalId: approvalUsed, lines: prepared.map((x) => ({ orderLineId: x.orig.id, qtyMilli: x.qtyMilli, restock: true })) },
        reason: retNote,
      }),
      auditStmt(c, {
        action: "order.correct", entity: "order", entityId: saleId,
        before: { orderId: origId, code: orig.code, total: orig.total },
        after: { code: saleCode, originalOrderId: origId, returnOrderId: retId, oldTotal: orig.total, newTotal, refundAmount, extraDue: Math.max(0, extraDue), change, refundMethod: body.refundMethod, approvalId: approvalUsed, shiftId: shift.id },
        reason: body.reason,
      }),
    );
    await db.batch(stmts);
  };

  try {
    try {
      await commit();
    } catch (e) {
      if (!isCheckFail(e)) throw e;
      p = await plan(); // tồn vừa đổi: phân bổ lại 1 lần
      await commit();
    }
  } catch (e) {
    await cancelDrafts();
    const msg = String((e as Error)?.message ?? "");
    if (/state_changed/.test(msg)) {
      if (!(await db.prepare(`SELECT 1 AS x FROM shifts WHERE id = ? AND status = 'open'`).bind(shift.id).first())) throw conflict("shift_closed", "Ca bán hàng vừa được chốt — mở ca mới để sửa hoá đơn");
      throw conflict("state_changed", "Đơn vừa được trả/sửa bởi thao tác khác, hoặc kỳ vừa khoá — tải lại và thử lại");
    }
    if (/UNIQUE constraint failed: once_keys/.test(msg)) throw conflict("already_done", "Đơn này (hoặc phiếu duyệt) đã được xử lý");
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  return done(saleId, 201, { oldTotal: orig.total, newTotal, refundAmount, extraDue: Math.max(0, extraDue), change });
});
