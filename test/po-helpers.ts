import { api, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

export const db = () => testEnv.DB;
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 0;

/** Sản phẩm + (tuỳ chọn) lô + giá bán + NCC ưu tiên. */
export async function mkProduct(id: number, opts: { stockMilli?: number; cost?: number; price?: number; supplierId?: number; leadDays?: number; orderUnit?: string | null; minOrderMilli?: number; preorder?: boolean } = {}) {
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, group_id, allow_preorder) VALUES (?,?,?,'kg',1,?)`).bind(id, `PO${id}`, `Hàng PO ${id}`, opts.preorder ? 1 : 0),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,?,'2020-01-01T00:00:00Z','active',1)`).bind(id, opts.price ?? 50000),
    ...(opts.stockMilli
      ? [d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,1,?,?,?,?,?)`).bind(id, `LOT-PO${id}`, id, future(0), future(10), opts.cost ?? 30000, opts.stockMilli, opts.stockMilli)]
      : []),
    ...(opts.supplierId
      ? [d.prepare(`INSERT INTO product_suppliers(product_id, supplier_id, lead_time_days, order_unit, min_order_milli, preferred) VALUES (?,?,?,?,?,1)`).bind(id, opts.supplierId, opts.leadDays ?? 1, opts.orderUnit ?? null, opts.minOrderMilli ?? 0)]
      : []),
  ]);
}

export async function mkSupplier(id: number, name: string, termsDays = 0) {
  await db().prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (?,?,?,?)`).bind(id, `NCC${id}`, name, termsDays).run();
}

export async function mkCustomer(name = "KH sỉ PO", credit = 1_000_000_000) {
  const c = await api("owner", "POST", "/api/v1/customers", {
    name: `${name} ${++seq}`, type: "b2b", customerGroupId: 1, creditLimit: credit, paymentTermsDays: 15,
    contacts: [{ name: "N", phone: "0900000001", isReceiver: true }], addresses: [{ label: "Kho", address: "1 Lê Lợi", isDefault: true }],
  });
  return { id: c.body.id as number, addressId: c.body.addresses[0].id as number };
}

/** Tạo đơn sỉ (tự xác nhận). */
export async function mkB2bOrder(cust: { id: number; addressId: number }, lines: { productId: number; qty: number }[], deliveryDate = addDays(vnDate(), 1)) {
  return api("manager", "POST", "/api/v1/b2b/orders", {
    customerId: cust.id, addressId: cust.addressId, deliveryDate, clientUuid: `po-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2)}`,
    lines: lines.map((l) => ({ productId: l.productId, unit: "kg", qty: l.qty })),
  });
}

export const shortRows = async (orderId: number) =>
  (await db().prepare(`SELECT * FROM so_shortages WHERE order_id = ? ORDER BY id`).bind(orderId).all<any>()).results;
export const lotOf = async (id: number) => (await db().prepare(`SELECT qty_on_hand_milli AS h, qty_reserved_milli AS r FROM lots WHERE id = ?`).bind(id).first<{ h: number; r: number }>())!;
export const reservedFor = async (orderId: number) =>
  (await db().prepare(`SELECT COALESCE(SUM(qty_milli),0) AS q FROM reservations WHERE order_id = ? AND status = 'active'`).bind(orderId).first<{ q: number }>())!.q;
