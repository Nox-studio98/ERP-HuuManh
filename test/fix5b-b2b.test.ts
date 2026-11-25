import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

// Đợt fix 5b — A-27: đơn sỉ giao thiếu → đơn bổ sung cho phần còn lại
const db = () => testEnv.DB;
let seq = 0;

beforeAll(async () => {
  await seedBase();
  const d = db();
  const later = new Date(Date.now() + 20 * 86400_000).toISOString();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (820,'F5B-CAM','Cam','kg')`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (820,'LOT-F5B',820,1,?,?,30000,100000,100000)`).bind(new Date().toISOString(), later),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,820,50000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
});

async function deliverShort(opts: { backorder?: boolean; setting?: string }) {
  if (opts.setting) await db().prepare(`UPDATE settings SET value=? WHERE key='b2b.backorder_on_short'`).bind(opts.setting).run();
  const c = await api("owner", "POST", "/api/v1/customers", {
    name: `KH bổ sung ${++seq}`, type: "b2b", customerGroupId: 1, creditLimit: 100_000_000, paymentTermsDays: 15,
    contacts: [{ name: "N", phone: "0900000001", isReceiver: true }], addresses: [{ label: "Kho", address: "1 Lê Lợi", isDefault: true }],
  });
  const o = await api("manager", "POST", "/api/v1/b2b/orders", { customerId: c.body.id, addressId: c.body.addresses[0].id, deliveryDate: addDays(vnDate(), 1), clientUuid: `f5b-${Date.now()}-${seq}`, lines: [{ productId: 820, unit: "kg", qty: 10 }] });
  expect(o.status).toBe(201);
  const pk = await api("warehouse", "POST", `/api/v1/b2b/orders/${o.body.id}/pick`);
  const did = pk.body.deliveryId;
  await api("warehouse", "POST", `/api/v1/deliveries/${did}/scan`, { code: "LOT-F5B" });
  expect((await api("warehouse", "POST", `/api/v1/deliveries/${did}/ready`, {})).status).toBe(200);
  expect((await api("warehouse", "POST", `/api/v1/deliveries/${did}/ship`, { shipper: "A" })).status).toBe(200);
  const lineId = o.body.lines[0].id;
  const cf = await api("warehouse", "POST", `/api/v1/deliveries/${did}/confirm`, { receiverName: "X", ...(opts.backorder != null ? { backorder: opts.backorder } : {}), lines: [{ orderLineId: lineId, deliveredQty: 6 }] });
  expect(cf.status).toBe(200);
  return { orderId: o.body.id as number, cf, customerId: c.body.id as number };
}
const backorders = (orderId: number) => db().prepare(`SELECT * FROM orders WHERE backorder_of_order_id = ?`).bind(orderId).all<any>();

describe("A-27: giao thiếu đơn sỉ", () => {
  it("mặc định (không tạo): đơn gốc completed, không có đơn bổ sung", async () => {
    const r = await deliverShort({});
    expect((await backorders(r.orderId)).results).toHaveLength(0);
    expect(r.cf.body.backorder).toBeNull();
  });

  it("backorder=true: tạo đơn bổ sung 'new' cho 4kg còn thiếu, cùng giá, gắn đơn gốc; hoá đơn vẫn theo thực giao", async () => {
    const r = await deliverShort({ backorder: true });
    const b = (await backorders(r.orderId)).results;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ status: "new", channel: "b2b", total: 200000, customer_id: r.customerId });
    expect(r.cf.body.backorder.code).toBe(b[0].code);
    expect(r.cf.body.invoice.total).toBe(300000);
    const l = await db().prepare(`SELECT qty_milli, unit_price FROM order_lines WHERE order_id=?`).bind(b[0].id).first<any>();
    expect(l).toEqual({ qty_milli: 4000, unit_price: 50000 });
    // đơn bổ sung xác nhận được như đơn thường (giữ tồn)
    expect((await api("manager", "POST", `/api/v1/b2b/orders/${b[0].id}/confirm`)).status).toBe(200);
  });

  it("hàng bị từ chối không tạo đơn bổ sung; cài đặt b2b.backorder_on_short=1 bật mặc định", async () => {
    const r = await deliverShort({ setting: "1" });
    expect((await backorders(r.orderId)).results).toHaveLength(1);
    const off = await deliverShort({ backorder: false });
    expect((await backorders(off.orderId)).results).toHaveLength(0);
    await db().prepare(`UPDATE settings SET value='0' WHERE key='b2b.backorder_on_short'`).run();
  });
});
