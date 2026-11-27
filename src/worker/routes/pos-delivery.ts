import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { AppError, conflict } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { lineAmount, toMilli } from "../lib/money";
import { assertStmt } from "../services/guard";
import { assertPeriodOpen } from "../services/period";
import { resolvePrice } from "../services/pricing";
import { unitFactor } from "../services/http";
import { cancelOrder, confirmOrder, createSocialOrder, packOrder, prepareOrder, shipOrder } from "../services/online-ops";

/**
 * POS-KV đợt B3: bán giao hàng tại quầy (docs/POS-KV-B.md).
 * Tạo đơn online `source='pos'` rồi chạy ĐÚNG các bước chuyển trạng thái sẵn có (tạo + giữ hàng FEFO → xác nhận → chuẩn bị →
 * đóng gói theo khối lượng thực → "Đang giao"); tiền trả trước ghi cùng batch với bước "Đang giao". Không có đường tắt UPDATE status.
 */
export const posDeliveryRoutes = new Hono<AppBindings>();

const MAX_VND = 10_000_000_000;
const METHODS = ["cash", "transfer", "qr", "card", "ewallet"] as const;
const phone = z.string().trim().regex(/^[0-9+ ().-]{8,16}$/, "Số điện thoại không hợp lệ");

const deliverySchema = z.object({
  clientUuid: z.string().min(8).max(64).optional(),
  customerId: z.number().int().positive().nullish(),
  receiver: z.object({
    name: z.string().trim().min(1).max(120),
    phone,
    address: z.string().trim().min(3).max(300),
    district: z.string().trim().max(80).optional(),
    zoneId: z.number().int().positive().nullish(),
  }),
  lines: z.array(z.object({
    productId: z.number().int().positive(),
    unit: z.string().min(1).max(20),
    qty: z.number().positive().max(1_000_000),
  })).min(1).max(100),
  shippingFee: z.number().int().min(0).max(10_000_000),
  deliverer: z.union([
    z.object({ userId: z.number().int().positive() }),
    z.object({ carrier: z.string().trim().min(1).max(60), trackingNo: z.string().trim().max(60).optional() }),
  ]),
  prepay: z.array(z.object({ method: z.enum(METHODS), amount: z.number().int().positive().max(MAX_VND), ref: z.string().trim().max(100).optional() })).max(5).default([]),
  cod: z.number().int().min(0).max(MAX_VND).default(0),
  note: z.string().trim().max(500).nullish(),
});

/** Quỹ theo hình thức: tiền mặt → quỹ của ca; còn lại → quỹ ngân hàng/ví (cùng quy tắc POS bán thường). */
async function fundFor(db: D1Database, storeId: number, method: string, shift: { fund_id: number }) {
  if (method === "cash") return shift.fund_id;
  for (const t of method === "ewallet" ? ["ewallet", "bank"] : ["bank"]) {
    const f = await db.prepare(`SELECT id FROM funds WHERE type = ? AND active=1 ORDER BY (store_id IS ?) DESC, id LIMIT 1`).bind(t, storeId).first<{ id: number }>();
    if (f) return f.id;
  }
  throw new AppError(422, "no_fund", "Chưa cấu hình quỹ ngân hàng cho hình thức thanh toán này");
}

/** Tạm tính theo bảng giá kênh online (đúng như createSocialOrder sẽ tính). */
async function quoteSubtotal(db: D1Database, customerId: number | null, lines: { productId: number; unit: string; qty: number }[]) {
  const group = customerId ? (await db.prepare(`SELECT customer_group_id FROM customers WHERE id = ?`).bind(customerId).first<{ customer_group_id: number | null }>())?.customer_group_id ?? null : null;
  let subtotal = 0;
  for (const l of lines) {
    const factor = await unitFactor(db, l.productId, l.unit);
    const price = await resolvePrice(db, l.productId, { channel: "online", customerGroupId: group, customerId });
    subtotal += lineAmount(price.unitPrice, toMilli(l.qty, factor));
  }
  return subtotal;
}

posDeliveryRoutes.post("/pos/delivery-quote", requirePerm("pos.sell"), async (c) => {
  const b = z.object({ customerId: z.number().int().positive().nullish(), lines: deliverySchema.shape.lines }).parse(await c.req.json().catch(() => ({})));
  return c.json({ subtotal: await quoteSubtotal(c.env.DB, b.customerId ?? null, b.lines) });
});

posDeliveryRoutes.post("/pos/delivery-orders", requirePerm("pos.sell"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const b = deliverySchema.parse(await c.req.json().catch(() => ({})));
  const storeId = user.storeId ?? 1;

  const shift = await db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(user.id).first<any>();
  if (!shift) throw conflict("no_open_shift", "Cần mở ca trước khi bán giao hàng");
  await assertPeriodOpen(db, new Date(), "bán giao hàng");

  // Idempotent theo clientUuid: gửi lại cùng mã thì trả đơn đã tạo
  if (b.clientUuid) {
    const ex = await db.prepare(`SELECT id, code, tracking_token, status FROM orders WHERE client_uuid = ?`).bind(b.clientUuid).first<any>();
    if (ex && ex.status !== "draft") return c.json({ id: ex.id, code: ex.code, status: ex.status, trackingToken: ex.tracking_token, trackingUrl: `/track/${ex.tracking_token}`, created: false });
  }

  // Người giao
  let delivererUserId: number | null = null;
  let carrier: string;
  let trackingNo: string | undefined;
  if ("userId" in b.deliverer) {
    const du = await db.prepare(`SELECT id, full_name FROM users WHERE id = ? AND active = 1`).bind(b.deliverer.userId).first<{ id: number; full_name: string }>();
    if (!du) throw new AppError(422, "deliverer_not_found", "Không tìm thấy nhân viên giao hàng");
    delivererUserId = du.id;
    carrier = `Nhân viên: ${du.full_name}`;
  } else {
    carrier = b.deliverer.carrier;
    trackingNo = b.deliverer.trackingNo || undefined;
  }
  if (b.customerId && !(await db.prepare(`SELECT 1 AS x FROM customers WHERE id = ? AND active = 1`).bind(b.customerId).first())) {
    throw new AppError(422, "customer_not_found", "Không tìm thấy khách hàng");
  }
  if (b.receiver.zoneId && !(await db.prepare(`SELECT 1 AS x FROM delivery_zones WHERE id = ? AND active = 1`).bind(b.receiver.zoneId).first())) {
    throw new AppError(422, "zone_not_found", "Khu vực giao không tồn tại");
  }

  // Tổng dự tính (cùng cách tính với createSocialOrder) để chặn sai lệch thanh toán TRƯỚC khi giữ hàng
  const subtotal = await quoteSubtotal(db, b.customerId ?? null, b.lines);
  const total = subtotal + b.shippingFee;
  const prepayTotal = b.prepay.reduce((s, p) => s + p.amount, 0);
  if (prepayTotal + b.cod !== total) {
    throw new AppError(422, "payment_mismatch", "Trả trước + thu hộ COD phải bằng tổng đơn", { total, prepay: prepayTotal, cod: b.cod });
  }
  const payFunds = new Map<string, number>();
  for (const p of b.prepay) if (!payFunds.has(p.method)) payFunds.set(p.method, await fundFor(db, storeId, p.method, shift));
  if (b.cod > 0 && !(await db.prepare(`SELECT 1 AS x FROM funds WHERE type='cod_clearing' AND active=1 LIMIT 1`).first())) {
    throw new AppError(422, "no_fund", "Chưa cấu hình quỹ chờ đối soát COD (cod_clearing)");
  }

  // 1) Tạo đơn + giữ hàng FEFO (thiếu tồn → 409 insufficient_stock, chưa có gì được ghi)
  const created = await createSocialOrder(c, {
    clientUuid: b.clientUuid,
    customerId: b.customerId ?? null,
    receiverName: b.receiver.name,
    receiverPhone: b.receiver.phone,
    addressLine: b.receiver.address,
    district: b.receiver.district ?? "",
    items: b.lines,
    paymentMethod: "cod",
    note: b.note ?? null,
    shippingFee: b.shippingFee,
    pos: { shiftId: shift.id, delivererUserId, zoneId: b.receiver.zoneId ?? null },
  });
  const id = created.id;
  if (!created.created) {
    const ex = await db.prepare(`SELECT code, status, tracking_token FROM orders WHERE id = ?`).bind(id).first<any>();
    return c.json({ id, code: ex.code, status: ex.status, trackingToken: ex.tracking_token, trackingUrl: `/track/${ex.tracking_token}`, created: false });
  }

  // 2) Các bước chuyển trạng thái sẵn có. Lỗi giữa chừng → huỷ đơn (nhả giữ hàng), chưa có tiền nào được ghi.
  try {
    await confirmOrder(c, id);
    await prepareOrder(c, id);
    const lines = (await db.prepare(`SELECT id FROM order_lines WHERE order_id = ? ORDER BY id`).bind(id).all<{ id: number }>()).results;
    // Hàng đã cân tại quầy: khối lượng thực = số lượng thu ngân đã nhập (dòng đơn được tạo theo đúng thứ tự b.lines)
    await packOrder(c, id, { lines: lines.map((l, i) => ({ orderLineId: l.id, actualQty: b.lines[i].qty })), note: "Đã cân và đóng gói tại quầy" });
    const o = await db.prepare(`SELECT code, total FROM orders WHERE id = ?`).bind(id).first<{ code: string; total: number }>();
    if (!o || o.total !== total) throw conflict("total_changed", "Tổng đơn thay đổi khi đóng gói, vui lòng tạo lại đơn");
    const pay: D1PreparedStatement[] = [
      assertStmt(db, "pos_delivery.shift_open", `SELECT status = 'open' FROM shifts WHERE id = ?`, [shift.id]),
      assertStmt(db, "pos_delivery.total", `SELECT total = ? FROM orders WHERE id = ?`, [total, id]),
      ...b.prepay.map((p) =>
        db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(id, p.method, p.amount, payFunds.get(p.method)!, p.ref ?? null),
      ),
      db.prepare(`UPDATE orders SET paid_total = ?, payment_status = ? WHERE id = ?`).bind(prepayTotal, b.cod === 0 ? "paid" : "unpaid", id),
      auditStmt(c, {
        action: "pos_delivery.create", entity: "order", entityId: id,
        after: { code: o.code, total, prepay: b.prepay.map((p) => ({ method: p.method, amount: p.amount })), cod: b.cod, shiftId: shift.id, deliverer: delivererUserId ?? carrier, trackingNo: trackingNo ?? null },
      }),
    ];
    // 3) → "Đang giao": xuất kho đúng lô (FEFO) + ghi tiền trả trước vào két ca, cùng một batch
    await shipOrder(c, id, { carrier, trackingNo, extra: pay });
  } catch (e) {
    await cancelOrder(c, id, "Tạo đơn giao từ quầy không hoàn tất, tự huỷ").catch(() => undefined);
    throw e;
  }
  const row = await db.prepare(`SELECT code, status, tracking_token FROM orders WHERE id = ?`).bind(id).first<any>();
  return c.json({ id, code: row.code, status: row.status, total, prepay: prepayTotal, cod: b.cod, trackingToken: row.tracking_token, trackingUrl: `/track/${row.tracking_token}`, created: true }, 201);
});

// Danh mục cho sheet giao hàng ở POS (thu ngân không có orders.online.manage)
posDeliveryRoutes.get("/pos/delivery-zones", requirePerm("pos.sell"), async (c) => {
  const rows = (await c.env.DB.prepare(`SELECT id, name, districts_json, fee, free_over, min_order FROM delivery_zones WHERE active = 1 ORDER BY id`).all<any>()).results;
  return c.json({ items: rows.map((z) => ({ id: z.id, name: z.name, districts: JSON.parse(z.districts_json) as string[], fee: z.fee, freeOver: z.free_over, minOrder: z.min_order })) });
});

posDeliveryRoutes.get("/pos/deliverers", requirePerm("pos.sell"), async (c) => {
  const rows = (await c.env.DB.prepare(`SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name`).all<{ id: number; full_name: string }>()).results;
  return c.json({ items: rows.map((u) => ({ id: u.id, fullName: u.full_name })) });
});

/** Gợi ý địa chỉ giao của khách: địa chỉ khách lẻ + sổ địa chỉ khách sỉ. */
posDeliveryRoutes.get("/pos/delivery-addresses", requirePerm("pos.sell"), async (c) => {
  const cid = Number(c.req.query("customerId"));
  if (!Number.isInteger(cid) || cid <= 0) throw new AppError(422, "validation_error", "customerId không hợp lệ");
  const db = c.env.DB;
  const cu = await db.prepare(`SELECT name, phone, address FROM customers WHERE id = ?`).bind(cid).first<any>();
  const book = (await db.prepare(`SELECT label, address FROM customer_addresses WHERE customer_id = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 10`).bind(cid).all<any>()).results;
  const items = [...(cu?.address ? [{ label: "Địa chỉ khách", address: cu.address as string }] : []), ...book];
  // thu ngân không thấy SĐT đầy đủ (customers.view_pii): tự nhập
  const receiverPhone = can(c.get("user").role, "customers.view_pii") ? cu?.phone ?? null : null;
  return c.json({ receiverName: cu?.name ?? null, receiverPhone, items });
});
