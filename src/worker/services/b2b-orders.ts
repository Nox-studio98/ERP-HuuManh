import type { Context } from "hono";
import type { AppBindings } from "../env";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode } from "../lib/codes";
import { lineAmount } from "../lib/money";
import { vnDate } from "../lib/time";
import { can } from "../lib/rbac";
import { checkCredit, customerDebtStatus, openB2bExposure } from "./debt";
import { assertStmt } from "./guard";
import { planReservations, reserveStmts } from "./reservations";
import { currentAvgCost, resolvePrice } from "./pricing";
import { unitFactor } from "./http";

export type Ctx = Context<AppBindings>;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));

export interface LineIn {
  productId: number;
  unit: string;
  qty: number;
  unitPrice?: number;
}

export interface PricedLine {
  productId: number;
  unit: string;
  qtyMilli: number;
  unitPrice: number;
  lineTotal: number;
  priceListId: number | null;
}

export async function storeIdOf(c: Ctx) {
  const u = c.get("user");
  if (u.storeId) return u.storeId;
  const s = await c.env.DB.prepare(`SELECT id FROM stores WHERE active=1 ORDER BY id LIMIT 1`).first<{ id: number }>();
  return s?.id ?? 1;
}

/** Quy đổi + định giá các dòng đơn sỉ. Có báo giá → giá lấy từ báo giá (dòng ngoài báo giá bị 422). */
export async function priceLines(
  c: Ctx,
  customer: { id: number; customer_group_id: number | null },
  lines: LineIn[],
  quoteLines?: { product_id: number; unit_price: number }[],
): Promise<PricedLine[]> {
  const db = c.env.DB;
  const role = c.get("user").role;
  const out: PricedLine[] = [];
  for (const l of lines) {
    const p = await db.prepare(`SELECT id, active FROM products WHERE id = ?`).bind(l.productId).first<{ id: number; active: number }>();
    if (!p || !p.active) throw new AppError(422, "product_not_found", "Mặt hàng không tồn tại hoặc đã ngừng bán", { productId: l.productId });
    const factor = await unitFactor(db, l.productId, l.unit);
    const qtyMilli = Math.round(l.qty * factor);
    if (qtyMilli <= 0) throw new AppError(422, "invalid_qty", "Số lượng phải lớn hơn 0");
    let unitPrice: number;
    let priceListId: number | null = null;
    if (quoteLines) {
      const ql = quoteLines.find((x) => x.product_id === l.productId);
      if (!ql) throw new AppError(422, "line_not_in_quote", "Mặt hàng không nằm trong báo giá", { productId: l.productId });
      unitPrice = ql.unit_price;
    } else {
      const r = await resolvePrice(db, l.productId, { channel: "b2b", customerGroupId: customer.customer_group_id, customerId: customer.id });
      priceListId = r.priceListId;
      unitPrice = l.unitPrice ?? r.unitPrice;
      if (l.unitPrice != null && l.unitPrice !== r.unitPrice && !can(role, "b2b.approve"))
        throw forbidden("price_override_forbidden", "Đổi giá khác bảng giá cần quyền duyệt");
    }
    out.push({ productId: l.productId, unit: l.unit, qtyMilli, unitPrice, lineTotal: lineAmount(unitPrice, qtyMilli), priceListId });
  }
  return out;
}

export function orderLineInsert(db: D1Database, orderCode: string, l: PricedLine) {
  return db
    .prepare(
      `INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, price_list_id, line_total)
       VALUES ((SELECT id FROM orders WHERE code = ?), ?,?,?,?,?,?)`,
    )
    .bind(orderCode, l.productId, l.unit, l.qtyMilli, l.unitPrice, l.priceListId, l.lineTotal);
}

export async function loadCustomerForOrder(db: D1Database, customerId: number, addressId: number) {
  const cu = await db
    .prepare(`SELECT id, type, active, customer_group_id FROM customers WHERE id = ?`)
    .bind(customerId)
    .first<{ id: number; type: string; active: number; customer_group_id: number | null }>();
  if (!cu || cu.type !== "b2b" || !cu.active) throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng sỉ");
  const ad = await db.prepare(`SELECT id FROM customer_addresses WHERE id = ? AND customer_id = ? AND active = 1`).bind(addressId, customerId).first();
  if (!ad) throw new AppError(422, "address_not_found", "Địa chỉ giao không thuộc khách hàng");
  return cu;
}

export interface CreateOrderInput {
  customerId: number;
  quoteId?: number;
  addressId: number;
  deliveryDate: string;
  note?: string;
  lines: LineIn[];
  clientUuid: string;
  creditOverrideApprovalId?: number;
  recurringTemplateId?: number;
}

/** Tạo đơn sỉ ở trạng thái `new` (chưa giữ tồn). Idempotent theo clientUuid. */
export async function createB2bOrder(c: Ctx, input: CreateOrderInput) {
  const db = c.env.DB;
  const user = c.get("user");
  const existing = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(input.clientUuid).first<{ id: number }>();
  if (existing) return { orderId: existing.id, replay: true, warnings: [] as { productId: number; marginBp: number }[] };

  if (!DATE_RE.test(input.deliveryDate) || input.deliveryDate < vnDate())
    throw new AppError(422, "invalid_delivery_date", "Ngày giao không hợp lệ (phải từ hôm nay trở đi, dạng YYYY-MM-DD)");
  const customer = await loadCustomerForOrder(db, input.customerId, input.addressId);

  let quoteLines: { product_id: number; unit_price: number }[] | undefined;
  if (input.quoteId) {
    const q = await db.prepare(`SELECT * FROM quotes WHERE id = ?`).bind(input.quoteId).first<any>();
    if (!q) throw notFound("quote_not_found", "Không tìm thấy báo giá");
    if (q.customer_id !== input.customerId) throw new AppError(422, "quote_customer_mismatch", "Báo giá không thuộc khách hàng này");
    if (q.status === "expired" || (["draft", "sent"].includes(q.status) && q.valid_until < vnDate())) {
      if (q.status === "sent") await db.prepare(`UPDATE quotes SET status='expired' WHERE id = ? AND status='sent'`).bind(q.id).run();
      throw conflict("quote_expired", "Báo giá đã hết hiệu lực", { quoteId: q.id, validUntil: q.valid_until });
    }
    if (!["draft", "sent"].includes(q.status)) throw conflict("quote_not_valid", `Báo giá đang ở trạng thái ${q.status}`, { status: q.status });
    quoteLines = (await db.prepare(`SELECT product_id, unit_price FROM quote_lines WHERE quote_id = ?`).bind(q.id).all<any>()).results;
  }
  if (input.creditOverrideApprovalId) await assertOverrideUsable(db, input.creditOverrideApprovalId, input.customerId);

  const items = await priceLines(c, customer, input.lines, quoteLines);
  const total = items.reduce((s, i) => s + i.lineTotal, 0);

  const warnings: { productId: number; marginBp: number }[] = [];
  if (input.quoteId)
    for (const it of items) {
      const cost = await currentAvgCost(db, it.productId);
      if (cost != null && it.unitPrice < cost) warnings.push({ productId: it.productId, marginBp: Math.round(((it.unitPrice - cost) * 10000) / Math.max(it.unitPrice, 1)) });
    }

  const code = await nextCode(db, "DS");
  const storeId = await storeIdOf(c);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO orders(code, client_uuid, channel, kind, store_id, customer_id, status, subtotal, total, note, created_by,
                            quote_id, address_id, delivery_date, recurring_template_id, credit_override_approval_id)
         VALUES (?,?,'b2b','sale',?,?,'new',?,?,?,?,?,?,?,?,?)`,
      )
      .bind(code, input.clientUuid, storeId, input.customerId, total, total, input.note ?? null, user.id, input.quoteId ?? null, input.addressId, input.deliveryDate, input.recurringTemplateId ?? null, null),
    ...items.map((i) => orderLineInsert(db, code, i)),
  ];
  if (input.quoteId) stmts.push(db.prepare(`UPDATE quotes SET status='accepted' WHERE id = ? AND status IN ('draft','sent')`).bind(input.quoteId));
  stmts.push(auditStmt(c, { action: "b2b_order.create", entity: "b2b_order", entityId: code, after: { customerId: input.customerId, total, lines: items.length, quoteId: input.quoteId ?? null } }));
  try {
    await db.batch(stmts);
  } catch (e) {
    const again = await db.prepare(`SELECT id FROM orders WHERE client_uuid = ?`).bind(input.clientUuid).first<{ id: number }>();
    if (again) return { orderId: again.id, replay: true, warnings };
    throw e;
  }
  const row = await db.prepare(`SELECT id FROM orders WHERE code = ?`).bind(code).first<{ id: number }>();
  return { orderId: row!.id, replay: false, warnings };
}

/** Approval credit_override dùng được: đã duyệt, đúng khách. */
async function assertOverrideUsable(db: D1Database, approvalId: number, customerId: number) {
  const a = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(approvalId).first<any>();
  let payload: any = {};
  try { payload = JSON.parse(a?.payload_json ?? "{}"); } catch { /* bỏ qua */ }
  if (!a || a.type !== "order.credit_override" || a.status !== "approved" || payload.customerId !== customerId)
    throw conflict("approval_invalid", "Mã duyệt vượt hạn mức không hợp lệ", { approvalId });
}

async function findOverride(db: D1Database, order: { id: number; customer_id: number; total: number }, explicitId?: number | null) {
  const a = explicitId
    ? await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(explicitId).first<any>()
    : await db
        .prepare(`SELECT * FROM approvals WHERE type='order.credit_override' AND ref_type='order' AND ref_id = ? AND status='approved' ORDER BY id DESC LIMIT 1`)
        .bind(String(order.id))
        .first<any>();
  if (!a) {
    if (explicitId) throw conflict("approval_invalid", "Mã duyệt vượt hạn mức không hợp lệ", { approvalId: explicitId });
    return null;
  }
  let payload: any = {};
  try { payload = JSON.parse(a.payload_json ?? "{}"); } catch { /* bỏ qua */ }
  const ok =
    a.type === "order.credit_override" && a.status === "approved" && payload.customerId === order.customer_id &&
    (a.ref_id == null || a.ref_id === String(order.id)) && (payload.total ?? 0) >= order.total;
  if (!ok) {
    if (explicitId) throw conflict("approval_invalid", "Mã duyệt vượt hạn mức không hợp lệ hoặc không đủ cho giá trị đơn", { approvalId: explicitId });
    return null;
  }
  return a.id as number;
}

/**
 * EC-23: kiểm hạn mức TRƯỚC khi giữ tồn. Không đạt (và chưa có duyệt của chủ) → tạo approval + 409 credit_blocked.
 * Đạt → giữ tồn FEFO + status confirmed trong một batch. Thiếu tồn → 409 insufficient_stock (đơn vẫn new).
 */
export async function confirmOrderFlow(c: Ctx, orderId: number, overrideApprovalId?: number | null) {
  const db = c.env.DB;
  const user = c.get("user");
  const o = await db.prepare(`SELECT * FROM orders WHERE id = ? AND channel = 'b2b' AND kind = 'sale'`).bind(orderId).first<any>();
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn sỉ");
  if (o.status !== "new" && o.status !== "delivery_failed") throw conflict("invalid_status", `Đơn đang ở trạng thái ${o.status}`, { status: o.status });

  const chk = await checkCredit(db, o.customer_id, o.total, orderId);
  let override: number | null = null;
  if (!chk.ok) {
    override = await findOverride(db, o, overrideApprovalId);
    if (!override) {
      const pending = await db
        .prepare(`SELECT id FROM approvals WHERE type='order.credit_override' AND ref_type='order' AND ref_id = ? AND status='pending' LIMIT 1`)
        .bind(String(orderId))
        .first<{ id: number }>();
      let approvalId = pending?.id;
      if (!approvalId) {
        const res = await db.batch([
          db
            .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('order.credit_override','order',?,?,?,?)`)
            .bind(String(orderId), JSON.stringify({ customerId: o.customer_id, total: o.total, reasons: chk.reasons, orderCode: o.code }), chk.reasons.join(","), user.id),
          auditStmt(c, { action: "approval.request", entity: "b2b_order", entityId: o.code, after: { type: "order.credit_override", reasons: chk.reasons } }),
        ]);
        approvalId = res[0].meta.last_row_id as number;
      }
      throw conflict("credit_blocked", "Khách vượt hạn mức hoặc có nợ quá hạn, cần chủ cửa hàng duyệt", {
        approvalId, reasons: chk.reasons, status: chk.status, orderId, orderAmount: o.total,
      });
    }
  }

  const lines = (await db.prepare(`SELECT id, product_id, qty_milli FROM order_lines WHERE order_id = ? ORDER BY id`).bind(orderId).all<any>()).results;
  const plans = await planReservations(db, lines.map((l) => ({ orderLineId: l.id, productId: l.product_id, qtyMilli: l.qty_milli })), o.store_id);
  // Chốt chặn đồng thời (audit #7/#9): trạng thái đơn còn như đã đọc; và khi KHÔNG có duyệt vượt hạn mức, tổng các đơn đã
  // cam kết (confirmed/preparing/shipping) của khách chưa đổi so với lúc kiểm hạn mức — hai đơn cùng confirm song song không
  // thể cùng lọt hạn mức (đơn thứ hai nhận 409 state_changed, thử lại sẽ tính lại). Đơn 'new' không đổi bất biến này nên không gây xung đột.
  const committed = override ? null : await openB2bExposure(db, o.customer_id, orderId, ["confirmed", "preparing", "shipping"]);
  try {
    await db.batch([
      assertStmt(db, "b2b.confirm", `SELECT status = ? FROM orders WHERE id = ?`, [o.status, orderId]),
      ...(committed == null
        ? []
        : [
            assertStmt(
              db,
              "b2b.credit",
              `SELECT COALESCE(SUM(o.total), 0) = ? FROM orders o
                WHERE o.customer_id = ? AND o.channel = 'b2b' AND o.kind = 'sale' AND o.status IN ('confirmed','preparing','shipping') AND o.id <> ?
                  AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id AND i.kind = 'sale' AND i.status = 'open')`,
              [committed, o.customer_id, orderId],
            ),
          ]),
      ...reserveStmts(db, orderId, plans),
      db.prepare(`UPDATE orders SET status='confirmed', credit_override_approval_id = COALESCE(?, credit_override_approval_id) WHERE id = ? AND status IN ('new','delivery_failed')`).bind(override, orderId),
      auditStmt(c, { action: "b2b_order.confirm", entity: "b2b_order", entityId: o.code, before: { status: o.status }, after: { status: "confirmed", creditOverrideApprovalId: override } }),
    ]);
  } catch (e) {
    if (isCheckFail(e)) throw conflict("insufficient_stock", "Không đủ tồn khả dụng (tồn vừa thay đổi), vui lòng thử lại");
    throw e;
  }
}

const FACTOR_SQL = `COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = ol.product_id AND pu.unit = ol.unit), 1000)`;

export async function loadOrderDetail(db: D1Database, id: number) {
  const o = await db
    .prepare(
      `SELECT o.*, cu.name AS customer_name, a.label AS address_label, a.address AS address_text
         FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN customer_addresses a ON a.id = o.address_id
        WHERE o.id = ? AND o.channel = 'b2b' AND o.kind = 'sale'`,
    )
    .bind(id)
    .first<any>();
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn sỉ");
  const lines = (
    await db
      .prepare(
        `SELECT ol.*, p.name AS product_name, ${FACTOR_SQL} AS factor,
                COALESCE((SELECT SUM(r.qty_milli) FROM reservations r WHERE r.order_line_id = ol.id AND r.status = 'active'), 0) AS reserved_milli,
                COALESCE((SELECT SUM(dl.delivered_milli) FROM delivery_lines dl WHERE dl.order_line_id = ol.id), 0) AS delivered_milli
           FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`,
      )
      .bind(id)
      .all<any>()
  ).results;
  const deliveries = (await db.prepare(`SELECT id, code, status, shipper, receiver_name, delivered_at, created_at FROM deliveries WHERE order_id = ? ORDER BY id`).bind(id).all<any>()).results;
  const invoices = (
    await db.prepare(`SELECT id, code, kind, issue_date, due_date, total, einvoice_status, einvoice_no FROM invoices WHERE order_id = ? ORDER BY id`).bind(id).all<any>()
  ).results;
  const credit = await customerDebtStatus(db, o.customer_id);
  return {
    id: o.id, code: o.code, customerId: o.customer_id, customerName: o.customer_name, status: o.status,
    deliveryDate: o.delivery_date, subtotal: o.subtotal, total: o.total, note: o.note,
    addressId: o.address_id, addressLabel: o.address_label, address: o.address_text, quoteId: o.quote_id,
    creditOverrideApprovalId: o.credit_override_approval_id, recurringTemplateId: o.recurring_template_id,
    createdAt: o.created_at, completedAt: o.completed_at,
    invoiceId: invoices.find((i) => i.kind === "sale")?.id ?? null,
    lines: lines.map((l) => ({
      id: l.id, productId: l.product_id, productName: l.product_name, unit: l.unit, qty: l.qty_milli / l.factor, qtyMilli: l.qty_milli,
      unitPrice: l.unit_price, lineTotal: l.line_total, reservedMilli: l.reserved_milli, deliveredMilli: l.delivered_milli,
    })),
    deliveries: deliveries.map((d) => ({ id: d.id, code: d.code, status: d.status, shipper: d.shipper, receiverName: d.receiver_name, deliveredAt: d.delivered_at, createdAt: d.created_at })),
    invoices: invoices.map((i) => ({ id: i.id, code: i.code, kind: i.kind, issueDate: i.issue_date, dueDate: i.due_date, total: i.total, einvoiceStatus: i.einvoice_status, einvoiceNo: i.einvoice_no })),
    credit,
  };
}
