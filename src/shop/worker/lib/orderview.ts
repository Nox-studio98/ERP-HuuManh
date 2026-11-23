import { CUSTOMER_LABEL, type OnlineStatus } from "../../../worker/services/online-orders";
import { buildVietQr } from "./vietqr";
import { imageUrl, last4, maskPhone, parseImages, setting } from "./util";
import type { ShopAccount } from "../env";

export const CANCELLABLE = ["awaiting_payment", "new", "confirmed"];
const label = (s: string) => CUSTOMER_LABEL[s as OnlineStatus] ?? s;

export interface TransferInfo {
  bankBin: string;
  accountNo: string;
  accountName: string;
  amount: number;
  content: string;
  qrPayload: string;
  expiresAt: string | null;
}

/** Thông tin chuyển khoản của đơn: dựa trên payment_intent vietqr đang chờ. null nếu không áp dụng. */
export async function transferInfoFor(db: D1Database, order: { id: number; status: string; payment_status: string }): Promise<TransferInfo | null> {
  if (order.status !== "awaiting_payment" || order.payment_status === "paid") return null;
  const it = await db
    .prepare(`SELECT amount, transfer_content, expires_at FROM payment_intents WHERE order_id = ? AND provider = 'vietqr' AND status = 'pending' ORDER BY id DESC LIMIT 1`)
    .bind(order.id)
    .first<{ amount: number; transfer_content: string; expires_at: string | null }>();
  if (!it) return null;
  const bankBin = await setting(db, "payment.bank_bin", "970436");
  const accountNo = await setting(db, "payment.bank_account", "");
  const accountName = await setting(db, "payment.bank_account_name", "");
  return {
    bankBin, accountNo, accountName, amount: it.amount, content: it.transfer_content,
    qrPayload: buildVietQr({ bankBin, accountNo, amount: it.amount, content: it.transfer_content }),
    expiresAt: it.expires_at,
  };
}

/** Nạp OrderView (không trả internal_note, giá vốn, lô). */
export async function orderView(db: D1Database, o: any) {
  const [lines, events, slot, b2bAddr] = await Promise.all([
    db
      .prepare(
        `SELECT ol.*, p.name AS product_name, p.images_json,
                COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = ol.product_id AND pu.unit = ol.unit), 1000) AS factor
           FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`,
      )
      .bind(o.id)
      .all<any>(),
    db.prepare(`SELECT at, status, note FROM order_events WHERE order_id = ? ORDER BY at, id`).bind(o.id).all<any>(),
    o.slot_id ? db.prepare(`SELECT label FROM delivery_slots WHERE id = ?`).bind(o.slot_id).first<{ label: string }>() : null,
    o.channel === "b2b" && o.address_id
      ? db.prepare(`SELECT address FROM customer_addresses WHERE id = ?`).bind(o.address_id).first<{ address: string }>()
      : null,
  ]);
  const transfer = await transferInfoFor(db, o);
  const hasWeightLine = !!(await db
    .prepare(`SELECT 1 AS x FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? AND p.sell_by_weight = 1 LIMIT 1`)
    .bind(o.id)
    .first());
  const view: Record<string, unknown> = {
    code: o.code,
    trackingToken: o.tracking_token ?? null,
    status: o.status,
    statusLabel: label(o.status),
    createdAt: o.created_at,
    slotDate: o.slot_date ?? o.delivery_date ?? null,
    slotLabel: slot?.label ?? null,
    receiverName: o.receiver_name ?? null,
    receiverPhoneMasked: maskPhone(o.receiver_phone),
    shipAddress: o.ship_address ?? b2bAddr?.address ?? null,
    paymentMethod: o.payment_method ?? (o.channel === "b2b" ? "credit" : null),
    paymentStatus: o.payment_status,
    estimated: hasWeightLine && !["completed", "returned"].includes(o.status) && o.weight_adjust_status === "none",
    estimatedTotal: o.estimated_total ?? o.total,
    subtotal: o.subtotal,
    shippingFee: o.shipping_fee,
    discount: o.discount,
    total: o.total,
    weightAdjustStatus: o.weight_adjust_status,
    lines: lines.results.map((l) => ({
      productId: l.product_id,
      name: l.product_name,
      imageUrl: imageUrl(parseImages(l.images_json)[0]),
      unit: l.unit,
      orderedQty: (l.ordered_qty_milli ?? l.qty_milli) / l.factor,
      qty: l.qty_milli / l.factor,
      unitPrice: l.unit_price,
      lineTotal: l.line_total,
      preorderMilli: l.preorder_milli ?? 0,
    })),
    events: events.results.map((e) => ({ at: e.at, status: e.status, statusLabel: label(e.status), note: e.note })),
    canCancel: o.channel === "online" && CANCELLABLE.includes(o.status),
  };
  if (transfer) view.transfer = transfer;
  return view;
}

const ORDER_COLS = `o.*`;

/** Đơn thuộc về khách đang đăng nhập (đơn online của tài khoản; khách sỉ đã duyệt còn thấy đơn sỉ của hồ sơ khách). */
export function ownedWhere(a: ShopAccount) {
  return {
    sql: `(o.channel = 'online' AND o.shop_account_id = ?1) OR (o.channel = 'b2b' AND ?3 = 'approved' AND o.customer_id = ?2)`,
    binds: [a.id, a.customerId, a.kind === "b2b" ? a.b2bStatus ?? "" : ""] as unknown[],
  };
}

export async function findOwnedOrder(db: D1Database, a: ShopAccount, code: string) {
  const w = ownedWhere(a);
  return db
    .prepare(`SELECT ${ORDER_COLS} FROM orders o WHERE o.code = ?4 AND (${w.sql})`)
    .bind(...w.binds, code)
    .first<any>();
}

/** Tra cứu khách vãng lai: token + 4 số cuối SĐT người nhận. Sai bất kỳ → null (404). */
export async function findByTracking(db: D1Database, token: string, phone4: string | undefined | null) {
  if (!token || token.length > 128 || !phone4 || !/^\d{4}$/.test(phone4)) return null;
  const o = await db.prepare(`SELECT ${ORDER_COLS} FROM orders o WHERE o.tracking_token = ? AND o.channel = 'online'`).bind(token).first<any>();
  if (!o || last4(o.receiver_phone) !== phone4) return null;
  return o;
}
