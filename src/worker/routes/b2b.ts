import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm, can } from "../lib/rbac";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { lineAmount } from "../lib/money";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDate, parseDayRange } from "../lib/time";
import { INVOICE_OUTSTANDING_SQL } from "../services/debt";
import { releaseOrderStmts, consumeForDeliveryStmts } from "../services/reservations";
import { allocateFefo, allocationCost, moveStatements, type LotAllocation } from "../services/stock";
import { kickJobs } from "../services/outbox";
import { registerApprovalHandler } from "../services/approval-registry";
import { getSettingInt } from "../services/settings";
import { assertStmt } from "../services/guard";
import { addVnRange, likeOf, pageParams } from "../services/http";
import {
  confirmOrderFlow, createB2bOrder, loadCustomerForOrder, loadOrderDetail, orderLineInsert, priceLines, storeIdOf, isCheckFail, DATE_RE, type LineIn,
} from "../services/b2b-orders";
import { enqueueJobByInvoiceCode, invoiceStmts } from "../services/b2b-invoice";
import { assertPeriodOpen } from "../services/period";
import { closeOrderShortagesStmt, deleteOrderShortagesStmts, fillShortagesFromStock, linkCoveredShortages, openShortByLine, openShortLinesFor } from "../services/shortages";

export const b2bRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const parse = async <T extends z.ZodTypeAny>(c: Ctx, s: T): Promise<z.infer<T>> => s.parse(await c.req.json().catch(() => ({})));
const id = (c: Ctx, name = "id") => Number(c.req.param(name));

// Duyệt vượt hạn mức (EC-23): chỉ đánh dấu đã duyệt; người tạo gọi /confirm để giữ hàng.
registerApprovalHandler("order.credit_override", { perm: "b2b.credit_override", onApprove: async () => [], onReject: async () => [] });

const lineIn = z.object({
  productId: z.number().int().positive(),
  unit: z.string().min(1).max(20),
  qty: z.number().positive().max(1_000_000),
  unitPrice: z.number().int().min(0).max(10_000_000_000).optional(),
});

async function orderRow(db: D1Database, oid: number) {
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ? AND channel = 'b2b' AND kind = 'sale'`).bind(oid).first<any>();
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn sỉ");
  return o;
}

/** Tạo (hoặc phát lại) rồi chạy luồng kiểm hạn mức → giữ tồn. */
async function createAndConfirm(c: Ctx, input: Parameters<typeof createB2bOrder>[1]) {
  const res = await createB2bOrder(c, input);
  const st = (await c.env.DB.prepare(`SELECT status FROM orders WHERE id = ?`).bind(res.orderId).first<{ status: string }>())?.status;
  if (st === "new") await confirmOrderFlow(c, res.orderId, input.creditOverrideApprovalId);
  return res;
}

// ===================== Đơn sỉ =====================

b2bRoutes.get("/b2b/orders", requirePerm("b2b.view"), async (c) => {
  const { limit, cursor } = pageParams(c);
  const q = c.req.query();
  const where = [`o.channel = 'b2b'`, `o.kind = 'sale'`];
  const binds: unknown[] = [];
  if (q.status) (where.push("o.status = ?"), binds.push(q.status));
  if (q.customerId) (where.push("o.customer_id = ?"), binds.push(Number(q.customerId)));
  if (q.deliveryDate) (where.push("o.delivery_date = ?"), binds.push(q.deliveryDate));
  if (q.q?.trim()) (where.push(`(o.code LIKE ? ESCAPE '\\' OR cu.name LIKE ? ESCAPE '\\')`), binds.push(likeOf(q.q), likeOf(q.q)));
  addVnRange(q, "o.created_at", where, binds);
  const sumRows = (
    await c.env.DB
      .prepare(`SELECT o.status AS st, COUNT(*) AS n, COALESCE(SUM(o.total),0) AS s FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id WHERE ${where.join(" AND ")} GROUP BY o.status`)
      .bind(...binds)
      .all<{ st: string; n: number; s: number }>()
  ).results;
  const byStatus: Record<string, { count: number; total: number }> = {};
  for (const r of sumRows) byStatus[r.st] = { count: r.n, total: r.s };
  const summary = { count: sumRows.reduce((a, r) => a + r.n, 0), total: sumRows.filter((r) => r.st !== "cancelled").reduce((a, r) => a + r.s, 0), byStatus };
  if (cursor) (where.push("o.id < ?"), binds.push(cursor));
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT o.id, o.code, o.customer_id, cu.name AS customer_name, o.status, o.delivery_date, o.total, a.label AS address_label, o.created_at,
                (SELECT MAX(i.id) FROM invoices i WHERE i.order_id = o.id AND i.kind = 'sale') AS invoice_id,
                (SELECT COALESCE(SUM(s.qty_milli), 0) FROM so_shortages s WHERE s.order_id = o.id AND s.status = 'open') AS short_milli
           FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN customer_addresses a ON a.id = o.address_id
          WHERE ${where.join(" AND ")} ORDER BY o.id DESC LIMIT ?`,
      )
      .bind(...binds, limit + 1)
      .all<any>()
  ).results;
  const page = rows.slice(0, limit);
  const shorts = await openShortLinesFor(c.env.DB, page.map((r) => r.id));
  return c.json({
    items: page.map((r) => ({
      id: r.id, code: r.code, customerId: r.customer_id, customerName: r.customer_name, status: r.status, deliveryDate: r.delivery_date,
      total: r.total, addressLabel: r.address_label, createdAt: r.created_at, invoiceId: r.invoice_id,
      awaitingStock: r.short_milli > 0, shortMilli: r.short_milli, shortLines: shorts.get(r.id) ?? [],
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    summary,
  });
});

b2bRoutes.get("/b2b/orders/:id", requirePerm("b2b.view"), async (c) => c.json(await loadOrderDetail(c.env.DB, id(c))));

const createSchema = z.object({
  customerId: z.number().int().positive(),
  quoteId: z.number().int().positive().optional(),
  addressId: z.number().int().positive(),
  deliveryDate: z.string().regex(DATE_RE),
  note: z.string().trim().max(500).optional(),
  lines: z.array(lineIn).min(1).max(200),
  clientUuid: z.string().min(8).max(64),
  creditOverrideApprovalId: z.number().int().positive().optional(),
});

b2bRoutes.post("/b2b/orders", requirePerm("b2b.write"), async (c) => {
  const b = await parse(c, createSchema);
  const res = await createAndConfirm(c, b);
  return c.json({ ...(await loadOrderDetail(c.env.DB, res.orderId)), warnings: res.warnings }, res.replay ? 200 : 201);
});

b2bRoutes.post("/b2b/orders/:id/confirm", requirePerm("b2b.write"), async (c) => {
  const oid = id(c);
  const b = await parse(c, z.object({ creditOverrideApprovalId: z.number().int().positive().optional() }));
  await orderRow(c.env.DB, oid);
  await confirmOrderFlow(c, oid, b.creditOverrideApprovalId);
  return c.json(await loadOrderDetail(c.env.DB, oid));
});

b2bRoutes.put("/b2b/orders/:id", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const oid = id(c);
  const b = await parse(c, z.object({
    addressId: z.number().int().positive().optional(),
    deliveryDate: z.string().regex(DATE_RE).optional(),
    note: z.string().trim().max(500).optional(),
    lines: z.array(lineIn).min(1).max(200).optional(),
  }));
  const o = await orderRow(db, oid);
  const editable = o.status === "new" || o.status === "confirmed";
  if (!editable && o.status !== "preparing") throw conflict("order_not_editable", `Không sửa được đơn ${o.status}`, { status: o.status });
  if (!editable && b.lines) throw conflict("order_not_editable", "Đơn đã vào soạn hàng, không đổi dòng hàng được", { status: o.status });
  if (b.deliveryDate && (b.deliveryDate < vnDate())) throw new AppError(422, "invalid_delivery_date", "Ngày giao không hợp lệ");
  const addressChanged = b.addressId != null && b.addressId !== o.address_id;
  if (addressChanged && o.status === "preparing" && !can(c.get("user").role, "b2b.approve")) throw forbidden("forbidden", "Đổi địa chỉ sau khi đã soạn hàng cần quyền duyệt (EC-27)");
  const cust = await loadCustomerForOrder(db, o.customer_id, b.addressId ?? o.address_id);
  const stmts: D1PreparedStatement[] = [];
  let total = o.total;
  if (b.lines) {
    const ql = o.quote_id ? (await db.prepare(`SELECT product_id, unit_price FROM quote_lines WHERE quote_id = ?`).bind(o.quote_id).all<any>()).results : undefined;
    const items = await priceLines(c, cust, b.lines as LineIn[], ql);
    total = items.reduce((s, i) => s + i.lineTotal, 0);
    // nhả giữ cũ, bỏ dòng cũ (lịch sử nằm ở audit), thêm dòng mới; đơn quay về `new` để kiểm hạn mức + giữ lại
    stmts.push(
      ...(await releaseOrderStmts(db, oid)),
      db.prepare(`DELETE FROM reservations WHERE order_id = ?`).bind(oid),
      ...deleteOrderShortagesStmts(db, oid), // phần thiếu của dòng cũ (khoá ngoại order_line_id) — đơn xác nhận lại sẽ ghi lại
      db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).bind(oid),
      ...items.map((i) => orderLineInsert(db, o.code, i)),
    );
  }
  stmts.unshift(assertStmt(db, "b2b.update", `SELECT status = ? FROM orders WHERE id = ?`, [o.status, oid]));
  stmts.push(
    db
      .prepare(`UPDATE orders SET address_id=?, delivery_date=?, note=?, subtotal=?, total=?, status=? WHERE id=?`)
      .bind(b.addressId ?? o.address_id, b.deliveryDate ?? o.delivery_date, b.note ?? o.note, total, total, b.lines ? "new" : o.status, oid),
  );
  if (addressChanged) stmts.push(db.prepare(`UPDATE deliveries SET address_id=? WHERE order_id=? AND status IN ('picking','ready')`).bind(b.addressId, oid));
  stmts.push(auditStmt(c, {
    action: "b2b_order.update", entity: "b2b_order", entityId: o.code,
    before: { addressId: o.address_id, deliveryDate: o.delivery_date, total: o.total, status: o.status },
    after: { addressId: b.addressId ?? o.address_id, deliveryDate: b.deliveryDate ?? o.delivery_date, total, relines: !!b.lines },
  }));
  await db.batch(stmts);
  if (b.lines && o.status === "confirmed") {
    await confirmOrderFlow(c, oid);
    // K-PO1: dòng thiếu mới nối lại với PO đang chạy (liên kết cũ bị xoá cùng dòng cũ), ưu tiên ngày giao sớm
    await linkCoveredShortages(db, c.get("user").id, b.lines.map((l) => l.productId));
  }
  return c.json(await loadOrderDetail(db, oid));
});

b2bRoutes.post("/b2b/orders/:id/cancel", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const oid = id(c);
  const b = await parse(c, z.object({ reason: z.string().trim().min(3).max(300) }));
  const o = await orderRow(db, oid);
  if (!["new", "confirmed", "preparing", "delivery_failed"].includes(o.status)) throw conflict("order_not_cancellable", `Không huỷ được đơn ${o.status}`, { status: o.status });
  await db.batch([
    // Chốt chặn (audit #7): huỷ đồng thời / huỷ song song với giao hàng — đơn phải còn đúng trạng thái đã đọc
    assertStmt(db, "b2b.cancel", `SELECT status = ? FROM orders WHERE id = ?`, [o.status, oid]),
    ...(await releaseOrderStmts(db, oid)),
    closeOrderShortagesStmt(db, oid), // PO: phần thiếu của đơn đóng lại (PO đã đặt vẫn giữ, hàng về thành tồn bán lẻ)
    db.prepare(`UPDATE deliveries SET status='cancelled' WHERE order_id=? AND status IN ('picking','ready')`).bind(oid),
    db.prepare(`UPDATE orders SET status='cancelled', voided_by=?, void_reason=? WHERE id=? AND status = ?`).bind(c.get("user").id, b.reason, oid, o.status),
    db.prepare(`UPDATE approvals SET status='rejected', decision_note='Đơn bị huỷ' WHERE type='order.credit_override' AND ref_type='order' AND ref_id=? AND status='pending'`).bind(String(oid)),
    auditStmt(c, { action: "b2b_order.cancel", entity: "b2b_order", entityId: o.code, before: { status: o.status }, after: { status: "cancelled" }, reason: b.reason }),
  ]);
  return c.json(await loadOrderDetail(db, oid));
});

// ===================== Soạn hàng / giao =====================

const FACTOR = `COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = ol.product_id AND pu.unit = ol.unit), 1000)`;

async function loadDelivery(db: D1Database, did: number) {
  const d = await db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(did).first<any>();
  if (!d) throw notFound("delivery_not_found", "Không tìm thấy phiếu giao");
  const lines = (
    await db
      .prepare(
        `SELECT dl.*, ol.product_id, ol.unit, ol.qty_milli AS ordered_milli, p.name AS product_name, ${FACTOR} AS factor
           FROM delivery_lines dl JOIN order_lines ol ON ol.id = dl.order_line_id JOIN products p ON p.id = ol.product_id
          WHERE dl.delivery_id = ? ORDER BY dl.id`,
      )
      .bind(did)
      .all<any>()
  ).results;
  const lots = (
    await db
      .prepare(
        `SELECT r.order_line_id, r.lot_id, l.lot_code, l.expires_at, SUM(r.qty_milli) AS qty_milli
           FROM reservations r JOIN lots l ON l.id = r.lot_id WHERE r.order_id = ? AND r.status = 'active' GROUP BY r.order_line_id, r.lot_id
          ORDER BY (l.expires_at IS NULL), l.expires_at, l.id`,
      )
      .bind(d.order_id)
      .all<any>()
  ).results;
  return {
    id: d.id, code: d.code, orderId: d.order_id, addressId: d.address_id, status: d.status, shipper: d.shipper, receiverName: d.receiver_name,
    deliveredAt: d.delivered_at, note: d.note, createdAt: d.created_at,
    backorderDefault: (await getSettingInt(db, "b2b.backorder_on_short", 0)) === 1, // A-27: mặc định ô "Tạo đơn bổ sung" ở màn xác nhận giao
    lines: lines.map((l) => ({
      orderLineId: l.order_line_id, productId: l.product_id, productName: l.product_name, unit: l.unit,
      qty: l.ordered_milli / l.factor, qtyMilli: l.ordered_milli, pickedMilli: l.picked_milli, deliveredMilli: l.delivered_milli,
      rejectedMilli: l.rejected_milli, rejectReason: l.reject_reason,
      lots: lots.filter((x) => x.order_line_id === l.order_line_id).map((x) => ({ lotId: x.lot_id, lotCode: x.lot_code, expiresAt: x.expires_at, qtyMilli: x.qty_milli })),
    })),
  };
}

b2bRoutes.get("/deliveries/:id", requirePerm("b2b.view"), async (c) => c.json(await loadDelivery(c.env.DB, id(c))));

b2bRoutes.post("/b2b/orders/:id/pick", requirePerm("b2b.deliver"), async (c) => {
  const db = c.env.DB;
  const oid = id(c);
  await fillShortagesFromStock(db, { orderId: oid, actorUserId: c.get("user").id }); // K-PO1b: tồn tự do phủ phần thiếu thì giữ trước khi soạn
  const o = await orderRow(db, oid);
  if (o.status !== "confirmed") throw conflict("invalid_status", "Chỉ soạn hàng cho đơn đã xác nhận (đã giữ tồn)", { status: o.status });
  const open = await db.prepare(`SELECT id FROM deliveries WHERE order_id = ? AND status IN ('picking','ready','shipping')`).bind(oid).first<{ id: number }>();
  if (open) throw conflict("delivery_exists", "Đơn đã có phiếu giao đang xử lý", { deliveryId: open.id });
  const code = await nextCode(db, "GH");
  const lines = (await db.prepare(`SELECT id FROM order_lines WHERE order_id = ? ORDER BY id`).bind(oid).all<{ id: number }>()).results;
  await db.batch([
    assertStmt(db, "b2b.pick", `SELECT (SELECT status FROM orders WHERE id = ?) = 'confirmed' AND NOT EXISTS (SELECT 1 FROM deliveries WHERE order_id = ? AND status IN ('picking','ready','shipping'))`, [oid, oid]),
    db.prepare(`INSERT INTO deliveries(code, order_id, address_id, status, picked_by) VALUES (?,?,?,'picking',?)`).bind(code, oid, o.address_id, c.get("user").id),
    ...lines.map((l) => db.prepare(`INSERT INTO delivery_lines(delivery_id, order_line_id) VALUES ((SELECT id FROM deliveries WHERE code = ?), ?)`).bind(code, l.id)),
    db.prepare(`UPDATE orders SET status='preparing' WHERE id = ? AND status='confirmed'`).bind(oid),
    auditStmt(c, { action: "delivery.pick", entity: "delivery", entityId: code, after: { orderId: oid } }),
  ]);
  const d = await db.prepare(`SELECT id FROM deliveries WHERE code = ?`).bind(code).first<{ id: number }>();
  const det = await loadDelivery(db, d!.id);
  return c.json({ deliveryId: d!.id, ...det }, 201);
});

const scanBody = z.object({
  code: z.string().trim().min(1).max(100),
  qty: z.number().positive().max(1_000_000).optional(),
  unit: z.string().trim().min(1).optional(),
});

b2bRoutes.post("/deliveries/:id/scan", requirePerm("b2b.deliver"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const did = id(c);
  const b = await parse(c, scanBody);
  const d = await db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(did).first<any>();
  if (!d) throw notFound("delivery_not_found", "Không tìm thấy phiếu giao");
  if (d.status !== "picking") throw conflict("invalid_status", "Phiếu giao không còn ở bước soạn hàng", { status: d.status });
  const context = `delivery:${did}`;
  const log = (result: string, message: string | null) =>
    db.prepare(`INSERT INTO scan_events(user_id, device_id, code, context, result, message) VALUES (?,?,?,?,?,?)`).bind(user.id, user.deviceId ?? c.req.header("x-device-id") ?? null, b.code, context, result, message);
  const fail = async (result: string, code: string, message: string, details?: unknown): Promise<never> => {
    await log(result, message).run();
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
  const lines = (
    await db
      .prepare(
        `SELECT dl.id AS dl_id, dl.picked_milli, ol.id AS order_line_id, ol.qty_milli, ol.unit
           FROM delivery_lines dl JOIN order_lines ol ON ol.id = dl.order_line_id WHERE dl.delivery_id = ? AND ol.product_id = ? ORDER BY dl.id`,
      )
      .bind(did, productId)
      .all<any>()
  ).results;
  if (!lines.length) return fail("not_in_doc", "not_in_doc", "Mặt hàng không thuộc đơn này", { productId });

  const line = lines.find((l) => l.picked_milli < l.qty_milli) ?? lines[0];
  let reservedOnLot = 0;
  if (lot) {
    const r = await db
      .prepare(`SELECT COALESCE(SUM(qty_milli),0) AS q FROM reservations WHERE order_id = ? AND lot_id = ? AND status = 'active' AND order_line_id = ?`)
      .bind(d.order_id, lot.id, line.order_line_id)
      .first<{ q: number }>();
    reservedOnLot = r!.q;
    if (!reservedOnLot) return fail("wrong_lot", "wrong_lot", "Lô này không được giữ cho đơn, hãy lấy đúng lô theo phiếu soạn", { lotId: lot.id });
    const allowDup = (await getSettingInt(db, "b2b.allow_duplicate_lot_scan", 0)) === 1;
    if (!allowDup) {
      const dup = await db.prepare(`SELECT id FROM scan_events WHERE context = ? AND code = ? AND result = 'ok' LIMIT 1`).bind(context, b.code).first();
      if (dup) return fail("duplicate", "duplicate_scan", "Lô này đã được quét cho phiếu giao", { lotId: lot.id });
    }
  }
  const remaining = line.qty_milli - line.picked_milli;
  let qtyMilli: number;
  if (b.qty != null) {
    const unit = b.unit ?? matchedUnit ?? line.unit;
    const f = (await db.prepare(`SELECT COALESCE((SELECT factor_milli FROM product_units WHERE product_id = ? AND unit = ?), CASE WHEN (SELECT base_unit FROM products WHERE id = ?) = ? THEN 1000 END) AS f`).bind(productId, unit, productId, unit).first<{ f: number | null }>())?.f;
    if (!f) return fail("unknown", "unknown_unit", `Đơn vị "${unit}" không hợp lệ`, { unit });
    qtyMilli = Math.round(b.qty * f);
  } else {
    qtyMilli = lot ? Math.min(reservedOnLot, remaining) : 1000;
  }
  if (qtyMilli <= 0 || qtyMilli > remaining) return fail("over_pick", "over_pick", "Số lượng soạn vượt số lượng đặt", { remainingMilli: remaining, qtyMilli });
  await db.batch([
    db.prepare(`UPDATE delivery_lines SET picked_milli = picked_milli + ? WHERE id = ?`).bind(qtyMilli, line.dl_id),
    log("ok", null),
    auditStmt(c, { action: "delivery.scan", entity: "delivery", entityId: d.code, after: { code: b.code, qtyMilli } }),
  ]);
  return c.json(await loadDelivery(db, did), 201);
});

b2bRoutes.post("/deliveries/:id/ready", requirePerm("b2b.deliver"), async (c) => {
  const db = c.env.DB;
  const did = id(c);
  const b = await parse(c, z.object({ reason: z.string().trim().min(3).max(300).optional() }));
  const d = await db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(did).first<any>();
  if (!d) throw notFound("delivery_not_found", "Không tìm thấy phiếu giao");
  if (d.status !== "picking") throw conflict("invalid_status", "Phiếu giao không ở bước soạn hàng", { status: d.status });
  const diffs = (
    await db
      .prepare(`SELECT dl.order_line_id, dl.picked_milli, ol.qty_milli FROM delivery_lines dl JOIN order_lines ol ON ol.id = dl.order_line_id WHERE dl.delivery_id = ? AND dl.picked_milli <> ol.qty_milli`)
      .bind(did)
      .all<any>()
  ).results;
  if (diffs.length && !b.reason) throw new AppError(422, "reason_required", "Số soạn lệch so với đơn, cần nhập lý do", { lines: diffs.map((x) => ({ orderLineId: x.order_line_id, pickedMilli: x.picked_milli, orderedMilli: x.qty_milli })) });
  await db.batch([
    assertStmt(db, "delivery.ready", `SELECT status = 'picking' FROM deliveries WHERE id = ?`, [did]),
    db.prepare(`UPDATE deliveries SET status='ready', note=COALESCE(?, note) WHERE id=? AND status='picking'`).bind(b.reason ?? null, did),
    auditStmt(c, { action: "delivery.ready", entity: "delivery", entityId: d.code, after: { diffLines: diffs.length }, reason: b.reason }),
  ]);
  return c.json(await loadDelivery(db, did));
});

b2bRoutes.post("/deliveries/:id/ship", requirePerm("b2b.deliver"), async (c) => {
  const db = c.env.DB;
  const did = id(c);
  const b = await parse(c, z.object({ shipper: z.string().trim().max(100).optional() }));
  const d = await db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(did).first<any>();
  if (!d) throw notFound("delivery_not_found", "Không tìm thấy phiếu giao");
  if (d.status !== "ready") throw conflict("invalid_status", "Phiếu giao chưa soạn xong", { status: d.status });
  await db.batch([
    assertStmt(db, "delivery.ship", `SELECT status = 'ready' FROM deliveries WHERE id = ?`, [did]),
    db.prepare(`UPDATE deliveries SET status='shipping', shipper=? WHERE id=? AND status='ready'`).bind(b.shipper ?? null, did),
    db.prepare(`UPDATE orders SET status='shipping' WHERE id=? AND status='preparing'`).bind(d.order_id),
    auditStmt(c, { action: "delivery.ship", entity: "delivery", entityId: d.code, after: { shipper: b.shipper ?? null } }),
  ]);
  return c.json(await loadDelivery(db, did));
});

const confirmSchema = z.object({
  receiverName: z.string().trim().min(1).max(100),
  /** A-27: tạo đơn bổ sung cho phần giao thiếu (không gồm hàng bị từ chối). Bỏ trống → theo Cài đặt b2b.backorder_on_short. */
  backorder: z.boolean().optional(),
  lines: z.array(z.object({
    orderLineId: z.number().int().positive(),
    deliveredQty: z.number().min(0).max(1_000_000),
    rejectedQty: z.number().min(0).max(1_000_000).optional(),
    rejectReason: z.enum(["hong", "sai_quy_cach", "thua", "khac"]).optional(),
  })).min(1),
});

b2bRoutes.post("/deliveries/:id/confirm", requirePerm("b2b.deliver"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const did = id(c);
  const b = await parse(c, confirmSchema);
  const d = await db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(did).first<any>();
  if (!d) throw notFound("delivery_not_found", "Không tìm thấy phiếu giao");
  if (d.status !== "shipping" && d.status !== "ready") throw conflict("invalid_status", "Phiếu giao chưa ở bước giao hàng", { status: d.status });
  const order = await orderRow(db, d.order_id);
  const olines = (
    await db
      .prepare(`SELECT ol.*, p.name AS product_name, p.base_unit, ${FACTOR} AS factor FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`)
      .bind(order.id)
      .all<any>()
  ).results;
  for (const x of b.lines) if (!olines.some((l) => l.id === x.orderLineId)) throw new AppError(422, "line_not_in_order", "Dòng không thuộc đơn", { orderLineId: x.orderLineId });
  // PO: phần chưa có hàng (so_shortages còn mở) không giao được — chỉ giao phần đã giữ, không lấy trộm tồn tự do của đơn khác
  // K-PO1b: nếu kho đã có tồn tự do phủ phần thiếu (nhập thường, đơn khác huỷ...) thì giữ luôn cho đơn trước khi kiểm
  await fillShortagesFromStock(db, { orderId: order.id, actorUserId: user.id });
  const awaiting = await openShortByLine(db, order.id);

  const per = olines.map((l) => {
    const e = b.lines.find((x) => x.orderLineId === l.id);
    const delivered = e ? Math.round(e.deliveredQty * l.factor) : 0;
    const rejected = e?.rejectedQty ? Math.round(e.rejectedQty * l.factor) : 0;
    if (delivered + rejected > l.qty_milli) throw new AppError(422, "over_delivery", "Số giao + từ chối vượt số đặt", { orderLineId: l.id });
    const awaitingMilli = awaiting.get(l.id) ?? 0;
    if (awaitingMilli > 0 && delivered + rejected > l.qty_milli - awaitingMilli)
      throw conflict("awaiting_stock", "Phần chưa có hàng (chờ hàng về) không giao được, chỉ giao phần đã giữ", { orderLineId: l.id, awaitingMilli, deliverableMilli: l.qty_milli - awaitingMilli });
    if (rejected > 0 && !e?.rejectReason) throw new AppError(422, "reject_reason_required", "Hàng bị từ chối cần ghi lý do", { orderLineId: l.id });
    return { line: l, delivered, rejected, reason: e?.rejectReason ?? null };
  });

  // Xuất kho theo số thực giao; hàng từ chối / giao thiếu được nhả giữ (EC-26)
  const res = await consumeForDeliveryStmts(db, order.id, new Map(per.map((x) => [x.line.id, x.delivered])), "delivery", did, user.id);
  // Chốt chặn (audit #7): hai lần xác nhận giao đồng thời không được cùng xuất kho / lập hoá đơn
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, "delivery.confirm", `SELECT d.status IN ('ready','shipping') AND o.status IN ('preparing','shipping') FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.id = ?`, [did]),
    ...res.stmts,
  ];
  const allocByLine = new Map<number, LotAllocation[]>(res.allocByLine);
  // Giữ thiếu → phân bổ thêm FEFO từ tồn tự do (gộp theo sản phẩm để hai dòng không giữ trùng)
  const shortByProduct = new Map<number, { lineId: number; qty: number }[]>();
  for (const [lineId, qty] of res.shortByLine) {
    const l = olines.find((x) => x.id === lineId)!;
    shortByProduct.set(l.product_id, [...(shortByProduct.get(l.product_id) ?? []), { lineId, qty }]);
  }
  const storeId = order.store_id ?? (await storeIdOf(c));
  for (const [productId, parts] of shortByProduct) {
    const alloc = await allocateFefo(db, productId, parts.reduce((s, x) => s + x.qty, 0), storeId);
    stmts.push(...moveStatements(db, productId, alloc, -1, "sale", "delivery", did, user.id));
    const pool = alloc.map((a) => ({ ...a }));
    for (const part of parts) {
      let need = part.qty;
      for (const a of pool) {
        if (need <= 0) break;
        const take = Math.min(a.qtyMilli, need);
        if (take <= 0) continue;
        a.qtyMilli -= take;
        need -= take;
        allocByLine.set(part.lineId, [...(allocByLine.get(part.lineId) ?? []), { lotId: a.lotId, unitCost: a.unitCost, qtyMilli: take }]);
      }
    }
  }

  let subtotal = 0;
  let costTotal = 0;
  const invLines = [];
  for (const x of per) {
    const l = x.line;
    const alloc = allocByLine.get(l.id) ?? [];
    const amount = lineAmount(l.unit_price, x.delivered);
    const cost = allocationCost(alloc);
    subtotal += amount;
    costTotal += cost;
    for (const a of alloc) stmts.push(db.prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,?,?,?)`).bind(l.id, a.lotId, a.qtyMilli, a.unitCost));
    stmts.push(
      db.prepare(`UPDATE order_lines SET line_total = ?, cost_amount = ? WHERE id = ?`).bind(amount, cost, l.id),
      db.prepare(`UPDATE delivery_lines SET delivered_milli = ?, rejected_milli = ?, reject_reason = ? WHERE delivery_id = ? AND order_line_id = ?`).bind(x.delivered, x.rejected, x.reason, did, l.id),
    );
    if (x.delivered > 0)
      invLines.push({ orderLineId: l.id, productId: l.product_id, description: l.product_name, unit: l.base_unit, qtyMilli: x.delivered, unitPrice: l.unit_price, amount });
  }
  // A-27: giao thiếu → đơn bổ sung (trạng thái new, chưa giữ tồn/kiểm hạn mức — xác nhận như đơn thường), cùng giá đã chốt
  const shortLines = per.filter((x) => x.line.qty_milli - x.delivered - x.rejected > 0);
  const wantBackorder = b.backorder ?? (await getSettingInt(db, "b2b.backorder_on_short", 0)) === 1;
  let backorderCode: string | null = null;
  if (wantBackorder && shortLines.length) {
    backorderCode = await nextCode(db, "DS");
    const bl = shortLines.map((x) => ({ productId: x.line.product_id, unit: x.line.unit, qtyMilli: x.line.qty_milli - x.delivered - x.rejected, unitPrice: x.line.unit_price, priceListId: x.line.price_list_id ?? null }));
    const bTotal = bl.reduce((s, l) => s + lineAmount(l.unitPrice, l.qtyMilli), 0);
    const when = order.delivery_date && order.delivery_date >= vnDate() ? order.delivery_date : vnDate();
    stmts.push(
      db
        .prepare(`INSERT INTO orders(code, channel, kind, store_id, customer_id, status, subtotal, total, note, created_by, quote_id, address_id, delivery_date, backorder_of_order_id) VALUES (?,'b2b','sale',?,?,'new',?,?,?,?,?,?,?,?)`)
        .bind(backorderCode, order.store_id, order.customer_id, bTotal, bTotal, `Giao bổ sung phần còn thiếu của ${order.code}`, user.id, order.quote_id ?? null, order.address_id, when, order.id),
      ...bl.map((l) => orderLineInsert(db, backorderCode!, { ...l, lineTotal: lineAmount(l.unitPrice, l.qtyMilli) })),
    );
  }
  stmts.push(
    closeOrderShortagesStmt(db, order.id), // đơn hoàn tất: phần chưa giao (nếu có) thành đơn bổ sung, không còn chờ hàng
    db.prepare(`UPDATE deliveries SET status='delivered', delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), receiver_name=? WHERE id=? AND status IN ('ready','shipping')`).bind(b.receiverName, did),
    db.prepare(`UPDATE orders SET status='completed', subtotal=?, total=?, cost_total=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).bind(subtotal, subtotal, costTotal, order.id),
  );
  let inv: Awaited<ReturnType<typeof invoiceStmts>> | null = null;
  if (invLines.length) {
    inv = await invoiceStmts(c, { kind: "sale", customerId: order.customer_id, orderId: order.id, deliveryId: did, lines: invLines });
    stmts.push(...inv.stmts);
  }
  stmts.push(auditStmt(c, {
    action: "delivery.confirm", entity: "delivery", entityId: d.code,
    after: { receiverName: b.receiverName, subtotal, rejected: per.filter((x) => x.rejected > 0).map((x) => ({ orderLineId: x.line.id, rejectedMilli: x.rejected, reason: x.reason })), invoice: inv?.code ?? null, backorder: backorderCode },
  }));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn để xuất (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
  let invoice: any = null;
  if (inv) {
    invoice = await db.prepare(`SELECT id, code, issue_date, due_date, subtotal, total, einvoice_status FROM invoices WHERE code = ?`).bind(inv.code).first<any>();
    try { await kickJobs(c.env, "invoice", invoice.id); } catch { /* cron sẽ quét lại */ }
  }
  return c.json({
    deliveryId: did, status: "delivered", orderStatus: "completed", backorder: backorderCode ? { code: backorderCode } : null,
    invoice: invoice && { id: invoice.id, code: invoice.code, issueDate: invoice.issue_date, dueDate: invoice.due_date, subtotal: invoice.subtotal, total: invoice.total, einvoiceStatus: invoice.einvoice_status },
  });
});

b2bRoutes.post("/deliveries/:id/fail", requirePerm("b2b.deliver"), async (c) => {
  const db = c.env.DB;
  const did = id(c);
  const b = await parse(c, z.object({ reason: z.string().trim().min(3).max(300) }));
  const d = await db.prepare(`SELECT * FROM deliveries WHERE id = ?`).bind(did).first<any>();
  if (!d) throw notFound("delivery_not_found", "Không tìm thấy phiếu giao");
  if (!["picking", "ready", "shipping"].includes(d.status)) throw conflict("invalid_status", "Phiếu giao không thể đánh dấu thất bại", { status: d.status });
  await db.batch([
    assertStmt(db, "delivery.fail", `SELECT status IN ('picking','ready','shipping') FROM deliveries WHERE id = ?`, [did]),
    ...(await releaseOrderStmts(db, d.order_id)),
    db.prepare(`UPDATE deliveries SET status='failed', note=? WHERE id=? AND status IN ('picking','ready','shipping')`).bind(b.reason, did),
    db.prepare(`UPDATE orders SET status='delivery_failed' WHERE id=?`).bind(d.order_id),
    auditStmt(c, { action: "delivery.fail", entity: "delivery", entityId: d.code, after: { orderId: d.order_id }, reason: b.reason }),
  ]);
  return c.json(await loadDelivery(db, did));
});

// ===================== Trả hàng sau hoá đơn (EC-25) =====================

b2bRoutes.post("/b2b/orders/:id/returns", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const oid = id(c);
  const b = await parse(c, z.object({
    lines: z.array(z.object({
      orderLineId: z.number().int().positive(),
      qty: z.number().positive().max(1_000_000),
      unit: z.string().min(1),
      restock: z.boolean(),
      reason: z.string().trim().min(2).max(200),
    })).min(1).max(100),
  }));
  const o = await orderRow(db, oid);
  if (o.status !== "completed") throw conflict("not_returnable", "Chỉ trả hàng cho đơn đã giao", { status: o.status });
  // B-08/EC-33: phiếu trả + hoá đơn điều chỉnh lập ngày hôm nay (không sửa số quá khứ); hôm nay thuộc kỳ khoá thì chặn
  await assertPeriodOpen(db, new Date(), "phiếu trả hàng / hoá đơn điều chỉnh");
  const orig = await db.prepare(`SELECT * FROM invoices WHERE order_id = ? AND kind = 'sale' AND status = 'open' ORDER BY id LIMIT 1`).bind(oid).first<any>();
  if (!orig) throw conflict("not_invoiced", "Đơn chưa có hoá đơn, không cần hoá đơn điều chỉnh");

  const stmts: D1PreparedStatement[] = [];
  const invLines = [];
  let restockedCost = 0;
  const lotCapUsed = new Map<number, number>(); // đã dùng trong yêu cầu này
  const moveSpecs: { lotId: number; productId: number; qty: number; unitCost: number }[] = [];
  // Mỗi dòng trả → 1 dòng của đơn kind='return' (cùng cách POS biểu diễn trả hàng) để /reports/pnl trừ doanh thu & giá vốn
  const retLines: { l: any; qtyMilli: number; amount: number; cost: number; lots: { lotId: number; qty: number; unitCost: number }[] }[] = [];
  const claimed = new Map<number, number>();
  for (const rl of b.lines) {
    const l = await db
      .prepare(`SELECT ol.*, p.name AS product_name, p.base_unit FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.id = ? AND ol.order_id = ?`)
      .bind(rl.orderLineId, oid)
      .first<any>();
    if (!l) throw new AppError(422, "line_not_in_order", "Dòng không thuộc đơn", { orderLineId: rl.orderLineId });
    const fu = await db.prepare(`SELECT COALESCE((SELECT factor_milli FROM product_units WHERE product_id = ? AND unit = ?), CASE WHEN ? = ? THEN 1000 END) AS f`).bind(l.product_id, rl.unit, l.base_unit, rl.unit).first<{ f: number | null }>();
    if (!fu?.f) throw new AppError(422, "unknown_unit", `Đơn vị "${rl.unit}" không hợp lệ`);
    const qtyMilli = Math.round(rl.qty * fu.f);
    const delivered = (await db.prepare(`SELECT COALESCE(SUM(delivered_milli),0) AS q FROM delivery_lines WHERE order_line_id = ?`).bind(l.id).first<{ q: number }>())!.q;
    const returned = (await db.prepare(
      `SELECT COALESCE(-SUM(il.qty_milli),0) AS q FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.order_line_id = ? AND i.kind = 'adjustment' AND i.status = 'open'`,
    ).bind(l.id).first<{ q: number }>())!.q;
    const inReq = claimed.get(l.id) ?? 0;
    claimed.set(l.id, inReq + qtyMilli);
    if (qtyMilli + inReq > delivered - returned) throw new AppError(422, "over_return", "Số trả vượt số đã giao còn lại", { orderLineId: l.id, returnableMilli: delivered - returned });
    const rline = { l, qtyMilli, amount: lineAmount(l.unit_price, qtyMilli), cost: 0, lots: [] as { lotId: number; qty: number; unitCost: number }[] };
    retLines.push(rline);
    invLines.push({ orderLineId: l.id, productId: l.product_id, description: `Trả hàng: ${l.product_name} (${rl.reason})`, unit: l.base_unit, qtyMilli: -qtyMilli, unitPrice: l.unit_price, amount: -lineAmount(l.unit_price, qtyMilli) });
    if (rl.restock) {
      // cộng kho đúng lô gốc (order_line_lots), trừ phần đã trả trước đó
      const lots = (await db.prepare(`SELECT lot_id, SUM(qty_milli) AS q, MAX(unit_cost) AS unit_cost FROM order_line_lots WHERE order_line_id = ? GROUP BY lot_id ORDER BY MIN(id) DESC`).bind(l.id).all<any>()).results;
      let need = qtyMilli;
      for (const lot of lots) {
        if (need <= 0) break;
        const back = (await db.prepare(
          `SELECT COALESCE(SUM(m.qty_delta_milli),0) AS q FROM stock_moves m JOIN invoices i ON i.id = m.ref_id AND m.ref_type = 'b2b_return'
            WHERE m.lot_id = ? AND i.order_id = ? AND i.kind = 'adjustment' AND m.product_id = ?`,
        ).bind(lot.lot_id, oid, l.product_id).first<{ q: number }>())!.q;
        const cap = lot.q - back - (lotCapUsed.get(lot.lot_id) ?? 0);
        const take = Math.min(cap, need);
        if (take <= 0) continue;
        lotCapUsed.set(lot.lot_id, (lotCapUsed.get(lot.lot_id) ?? 0) + take);
        need -= take;
        moveSpecs.push({ lotId: lot.lot_id, productId: l.product_id, qty: take, unitCost: lot.unit_cost });
        rline.lots.push({ lotId: lot.lot_id, qty: take, unitCost: lot.unit_cost });
        rline.cost += Math.round((lot.unit_cost * take) / 1000);
        restockedCost += Math.round((lot.unit_cost * take) / 1000);
      }
      if (need > 0) throw new AppError(422, "restock_lot_missing", "Không xác định được lô gốc để cộng kho", { orderLineId: l.id });
    } else {
      // không nhập lại kho: giá vốn theo bình quân của dòng gốc → P&L tính vào hao hụt (như POS trả không nhập kho)
      rline.cost = delivered > 0 ? Math.round((l.cost_amount * qtyMilli) / delivered) : 0;
    }
  }
  const inv = await invoiceStmts(c, { kind: "adjustment", customerId: o.customer_id, orderId: oid, originalInvoiceId: orig.id, dueDate: orig.due_date, lines: invLines, note: b.lines.map((x) => x.reason).join("; ") });
  // Chốt chặn (audit #14/#2): trả đồng thời không được vượt số đã giao; đơn phải còn 'completed'
  stmts.push(assertStmt(db, "b2b.return.status", `SELECT status = 'completed' FROM orders WHERE id = ?`, [oid]));
  for (const [olId, q] of claimed) {
    stmts.push(
      assertStmt(
        db,
        "b2b.return.qty",
        `SELECT (SELECT COALESCE(SUM(delivered_milli),0) FROM delivery_lines WHERE order_line_id = ?)
                - COALESCE((SELECT -SUM(il.qty_milli) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.order_line_id = ? AND i.kind = 'adjustment' AND i.status = 'open'), 0) >= ?`,
        [olId, olId, q],
      ),
    );
  }
  stmts.push(...inv.stmts);
  const retCode = await nextCode(db, PREFIX.return);
  const retTotal = retLines.reduce((s, x) => s + x.amount, 0);
  const retCost = retLines.reduce((s, x) => s + x.cost, 0);
  stmts.push(
    db
      .prepare(
        `INSERT INTO orders(code, channel, kind, original_order_id, store_id, customer_id, status, subtotal, total, cost_total, paid_total, note, created_by, completed_at)
         VALUES (?, 'b2b', 'return', ?, ?, ?, 'completed', ?, ?, ?, 0, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .bind(retCode, oid, o.store_id, o.customer_id, retTotal, retTotal, retCost, `Trả hàng sau HĐ ${inv.code}: ${b.lines.map((x) => x.reason).join("; ")}`.slice(0, 500), user.id),
  );
  for (const x of retLines) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, discount, line_total, cost_amount, original_line_id)
           VALUES ((SELECT id FROM orders WHERE code = ?), ?,?,?,?,?,0,?,?,?)`,
        )
        .bind(retCode, x.l.product_id, x.l.unit, x.qtyMilli, x.l.unit_price, x.l.price_list_id, x.amount, x.cost, x.l.id),
    );
    for (const lot of x.lots)
      stmts.push(
        db
          .prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES ((SELECT MAX(id) FROM order_lines WHERE order_id = (SELECT id FROM orders WHERE code = ?)), ?,?,?)`)
          .bind(retCode, lot.lotId, lot.qty, lot.unitCost),
      );
  }
  for (const m of moveSpecs)
    stmts.push(
      db.prepare(`UPDATE lots SET qty_on_hand_milli = qty_on_hand_milli + ? WHERE id = ?`).bind(m.qty, m.lotId),
      db
        .prepare(
          `INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
           VALUES (?,?,?,?,'return','b2b_return',(SELECT id FROM invoices WHERE code = ?),?)`,
        )
        .bind(m.lotId, m.productId, m.qty, m.unitCost, inv.code, user.id),
    );
  stmts.push(auditStmt(c, { action: "b2b_order.return", entity: "b2b_order", entityId: o.code, after: { adjustmentInvoice: inv.code, returnOrder: retCode, total: inv.total, lines: b.lines } }));
  await db.batch(stmts);
  const row = await db.prepare(`SELECT id, code, kind, original_invoice_id, issue_date, due_date, subtotal, total, einvoice_status FROM invoices WHERE code = ?`).bind(inv.code).first<any>();
  try { await kickJobs(c.env, "invoice", row.id); } catch { /* cron quét lại */ }
  return c.json({ invoice: { id: row.id, code: row.code, kind: row.kind, originalInvoiceId: row.original_invoice_id, issueDate: row.issue_date, dueDate: row.due_date, subtotal: row.subtotal, total: row.total, einvoiceStatus: row.einvoice_status } }, 201);
});

// ===================== Đơn lặp (M4-08) =====================

const recurSchema = z.object({
  customerId: z.number().int().positive(),
  addressId: z.number().int().positive(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  lines: z.array(z.object({ productId: z.number().int().positive(), unit: z.string().min(1), qty: z.number().positive().max(1_000_000) })).min(1).max(100),
  active: z.boolean().optional(),
});

const recurShape = (r: any) => ({
  id: r.id, customerId: r.customer_id, customerName: r.customer_name ?? undefined, addressId: r.address_id,
  weekdays: String(r.weekdays).split(",").map(Number), lines: JSON.parse(r.lines_json), active: !!r.active, lastGeneratedFor: r.last_generated_for,
});

b2bRoutes.get("/b2b/recurring", requirePerm("b2b.write"), async (c) => {
  const rows = (await c.env.DB.prepare(`SELECT r.*, cu.name AS customer_name FROM recurring_orders r JOIN customers cu ON cu.id = r.customer_id ORDER BY r.id DESC`).all<any>()).results;
  const shaped = rows.map(recurShape);
  const ids = [...new Set(shaped.flatMap((r) => r.lines.map((l: any) => Number(l.productId))))];
  const names = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const res = await c.env.DB.prepare(`SELECT id, name FROM products WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: number; name: string }>();
    for (const p of res.results) names.set(p.id, p.name);
  }
  for (const r of shaped) for (const l of r.lines) l.productName = names.get(Number(l.productId)) ?? null;
  return c.json({ items: shaped, nextCursor: null });
});

b2bRoutes.post("/b2b/recurring", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const b = await parse(c, recurSchema);
  await loadCustomerForOrder(db, b.customerId, b.addressId);
  const [res] = await db.batch([
    db.prepare(`INSERT INTO recurring_orders(customer_id, address_id, weekdays, lines_json, active, created_by) VALUES (?,?,?,?,?,?)`)
      .bind(b.customerId, b.addressId, [...new Set(b.weekdays)].sort().join(","), JSON.stringify(b.lines), b.active === false ? 0 : 1, c.get("user").id),
    auditStmt(c, { action: "b2b_recurring.create", entity: "recurring_order", entityId: b.customerId, after: b }),
  ]);
  const r = await db.prepare(`SELECT * FROM recurring_orders WHERE id = ?`).bind(res.meta.last_row_id).first<any>();
  return c.json(recurShape(r), 201);
});

b2bRoutes.put("/b2b/recurring/:id", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const rid = id(c);
  const cur = await db.prepare(`SELECT * FROM recurring_orders WHERE id = ?`).bind(rid).first<any>();
  if (!cur) throw notFound("recurring_not_found", "Không tìm thấy mẫu đơn lặp");
  const b = await parse(c, recurSchema.partial().omit({ customerId: true }));
  const addressId = b.addressId ?? cur.address_id;
  await loadCustomerForOrder(db, cur.customer_id, addressId);
  await db.batch([
    db.prepare(`UPDATE recurring_orders SET address_id=?, weekdays=?, lines_json=?, active=? WHERE id=?`).bind(
      addressId, b.weekdays ? [...new Set(b.weekdays)].sort().join(",") : cur.weekdays, b.lines ? JSON.stringify(b.lines) : cur.lines_json, b.active !== undefined ? (b.active ? 1 : 0) : cur.active, rid,
    ),
    auditStmt(c, { action: "b2b_recurring.update", entity: "recurring_order", entityId: rid, before: recurShape(cur), after: b }),
  ]);
  return c.json(recurShape((await db.prepare(`SELECT * FROM recurring_orders WHERE id = ?`).bind(rid).first<any>())!));
});

b2bRoutes.post("/b2b/recurring/:id/generate", requirePerm("b2b.write"), async (c) => {
  const db = c.env.DB;
  const rid = id(c);
  const b = await parse(c, z.object({ deliveryDate: z.string().regex(DATE_RE) }));
  const r = await db.prepare(`SELECT * FROM recurring_orders WHERE id = ?`).bind(rid).first<any>();
  if (!r) throw notFound("recurring_not_found", "Không tìm thấy mẫu đơn lặp");
  if (!r.active) throw conflict("recurring_inactive", "Mẫu đơn lặp đang tắt");
  const res = await createAndConfirm(c, {
    customerId: r.customer_id, addressId: r.address_id, deliveryDate: b.deliveryDate, lines: JSON.parse(r.lines_json),
    clientUuid: `recurring:${rid}:${b.deliveryDate}`, recurringTemplateId: rid,
  });
  await db.prepare(`UPDATE recurring_orders SET last_generated_for = ? WHERE id = ?`).bind(b.deliveryDate, rid).run();
  return c.json({ ...(await loadOrderDetail(db, res.orderId)), warnings: res.warnings }, res.replay ? 200 : 201);
});

// ===================== Hoá đơn =====================

const OS = INVOICE_OUTSTANDING_SQL;

b2bRoutes.get("/invoices", requirePerm("debt.view"), async (c) => {
  const db = c.env.DB;
  const { limit, cursor } = pageParams(c);
  const q = c.req.query();
  const today = vnDate();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.customerId) (where.push("x.customer_id = ?"), binds.push(Number(q.customerId)));
  if (q.status === "open") where.push(`x.kind <> 'adjustment' AND x.status = 'open' AND x.outstanding > 0`);
  if (q.overdue === "1") (where.push(`x.kind <> 'adjustment' AND x.status = 'open' AND x.outstanding > 0 AND x.due_date < ?`), binds.push(today));
  const range = parseDayRange(q.from, q.to);
  if (range) (where.push("x.issue_date >= ? AND x.issue_date <= ?"), binds.push(range.from, range.to));
  const term = q.q?.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    where.push(`(x.code LIKE ? ESCAPE '\\' OR x.customer_name LIKE ? ESCAPE '\\' OR COALESCE(x.einvoice_no,'') LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like);
  }
  const baseWhere = where.length ? "WHERE " + where.join(" AND ") : "";
  const baseBinds = [...binds];
  if (cursor) (where.push("x.id < ?"), binds.push(cursor));
  const inner = `SELECT i.id, i.code, i.kind, i.customer_id, cu.name AS customer_name, i.issue_date, i.due_date, i.total, i.status, i.einvoice_status, i.einvoice_no,
                  COALESCE((SELECT SUM(a.amount) FROM debt_allocations a
                             LEFT JOIN debt_payments ap ON ap.id = a.payment_id LEFT JOIN debt_adjustments ad ON ad.id = a.adjustment_id
                            WHERE a.invoice_id = i.id AND (ap.status = 'posted' OR ad.status = 'posted')), 0) AS paid,
                  CASE WHEN i.kind = 'adjustment' THEN 0 ELSE ${OS} END AS outstanding
             FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id`;
  const rows = (
    await db
      .prepare(`SELECT * FROM (${inner}) x ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY x.id DESC LIMIT ?`)
      .bind(...binds, limit + 1)
      .all<any>()
  ).results;
  // Tổng hợp trên TOÀN BỘ kết quả lọc (không theo trang): số HĐ, tổng tiền, còn nợ, quá hạn
  const s = await db
    .prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(x.total),0) AS total,
                     COALESCE(SUM(CASE WHEN x.kind <> 'adjustment' AND x.status = 'open' THEN x.outstanding ELSE 0 END),0) AS outstanding,
                     COALESCE(SUM(CASE WHEN x.kind <> 'adjustment' AND x.status = 'open' AND x.outstanding > 0 AND x.due_date < ? THEN x.outstanding ELSE 0 END),0) AS overdue
                FROM (${inner}) x ${baseWhere}`)
    .bind(today, ...baseBinds)
    .first<any>();
  const page = rows.slice(0, limit);
  return c.json({
    items: page.map((r) => ({
      id: r.id, code: r.code, kind: r.kind, customerId: r.customer_id, customerName: r.customer_name, issueDate: r.issue_date, dueDate: r.due_date,
      total: r.total, paid: r.paid, outstanding: r.outstanding,
      overdueDays: r.outstanding > 0 && r.due_date < today ? Math.round((Date.parse(today) - Date.parse(r.due_date)) / 86400_000) : 0,
      einvoiceStatus: r.einvoice_status, einvoiceNo: r.einvoice_no,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    summary: { count: s?.cnt ?? 0, total: s?.total ?? 0, outstanding: s?.outstanding ?? 0, overdue: s?.overdue ?? 0 },
  });
});

async function invoiceDetail(db: D1Database, iid: number) {
  const i = await db
    .prepare(`SELECT i.*, cu.name AS customer_name, CASE WHEN i.kind = 'adjustment' THEN 0 ELSE ${OS} END AS outstanding FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id WHERE i.id = ?`)
    .bind(iid)
    .first<any>();
  if (!i) throw notFound("invoice_not_found", "Không tìm thấy hoá đơn");
  const lines = (await db.prepare(`SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id`).bind(iid).all<any>()).results;
  const allocations = (
    await db
      .prepare(
        `SELECT a.id, a.amount, a.created_at, p.code AS payment_code, j.code AS adjustment_code FROM debt_allocations a
           LEFT JOIN debt_payments p ON p.id = a.payment_id LEFT JOIN debt_adjustments j ON j.id = a.adjustment_id WHERE a.invoice_id = ? ORDER BY a.id`,
      )
      .bind(iid)
      .all<any>()
  ).results;
  const adjustments = (await db.prepare(`SELECT id, code, issue_date, total, einvoice_status FROM invoices WHERE original_invoice_id = ? AND kind = 'adjustment' ORDER BY id`).bind(iid).all<any>()).results;
  return {
    id: i.id, code: i.code, kind: i.kind, originalInvoiceId: i.original_invoice_id, customerId: i.customer_id, customerName: i.customer_name, orderId: i.order_id,
    deliveryId: i.delivery_id, issueDate: i.issue_date, dueDate: i.due_date, subtotal: i.subtotal, vatRateBp: i.vat_rate_bp, vatAmount: i.vat_amount, total: i.total,
    status: i.status, outstanding: i.outstanding, einvoiceStatus: i.einvoice_status, einvoiceNo: i.einvoice_no, einvoiceSeries: i.einvoice_series,
    einvoiceLookupCode: i.einvoice_lookup_code, einvoiceError: i.einvoice_error,
    buyer: { name: i.buyer_name, taxCode: i.buyer_tax_code, address: i.buyer_address, email: i.buyer_email }, note: i.note, createdAt: i.created_at,
    lines: lines.map((l) => ({ id: l.id, orderLineId: l.order_line_id, productId: l.product_id, description: l.description, unit: l.unit, qtyMilli: l.qty_milli, unitPrice: l.unit_price, amount: l.amount })),
    allocations: allocations.map((a) => ({ id: a.id, amount: a.amount, paymentCode: a.payment_code, adjustmentCode: a.adjustment_code, createdAt: a.created_at })),
    adjustments: adjustments.map((a) => ({ id: a.id, code: a.code, issueDate: a.issue_date, total: a.total, einvoiceStatus: a.einvoice_status })),
  };
}

b2bRoutes.get("/invoices/:id", requirePerm("debt.view"), async (c) => c.json(await invoiceDetail(c.env.DB, id(c))));

b2bRoutes.post("/invoices/:id/einvoice", requirePerm("invoices.issue"), async (c) => {
  const db = c.env.DB;
  const iid = id(c);
  const i = await db.prepare(`SELECT id, code, kind, einvoice_status, status FROM invoices WHERE id = ?`).bind(iid).first<any>();
  if (!i) throw notFound("invoice_not_found", "Không tìm thấy hoá đơn");
  if (i.status !== "open") throw conflict("invoice_cancelled", "Hoá đơn đã huỷ");
  if (i.einvoice_status === "issued") throw conflict("already_issued", "Hoá đơn đã phát hành điện tử");
  const pending = await db.prepare(`SELECT id FROM integration_jobs WHERE ref_type='invoice' AND ref_id=? AND type IN ('einvoice.issue','einvoice.adjust') AND status IN ('queued','running')`).bind(iid).first();
  const stmts: D1PreparedStatement[] = [db.prepare(`UPDATE invoices SET einvoice_status='queued', einvoice_error=NULL WHERE id=? AND einvoice_status <> 'issued'`).bind(iid)];
  if (!pending) stmts.push(enqueueJobByInvoiceCode(db, i.kind === "adjustment" ? "einvoice.adjust" : "einvoice.issue", i.code));
  stmts.push(auditStmt(c, { action: "invoice.einvoice_request", entity: "invoice", entityId: i.code, before: { einvoiceStatus: i.einvoice_status }, after: { einvoiceStatus: "queued" } }));
  await db.batch(stmts);
  try { await kickJobs(c.env, "invoice", iid); } catch { /* cron quét lại */ }
  return c.json(await invoiceDetail(db, iid), 202);
});

b2bRoutes.get("/invoices/:id/pdf", requirePerm("debt.view"), async (c) => {
  // @ts-ignore — services/pdf do Agent C cung cấp
  const mod: any = await import("../services/pdf").catch(() => null);
  if (!mod?.renderInvoicePdf) throw new AppError(501 as any, "pdf_unavailable", "Chức năng xuất PDF chưa sẵn sàng");
  const iid = id(c);
  const i = await c.env.DB.prepare(`SELECT code FROM invoices WHERE id = ?`).bind(iid).first<{ code: string }>();
  if (!i) throw notFound("invoice_not_found", "Không tìm thấy hoá đơn");
  const bytes: Uint8Array = await mod.renderInvoicePdf(c.env, iid);
  return new Response(bytes as unknown as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${i.code}.pdf"` } });
});

