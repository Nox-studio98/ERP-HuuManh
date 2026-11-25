import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate } from "../src/worker/lib/time";

// Đợt fix 6a — A-28: phí giao khi huỷ đơn online theo giai đoạn (chủ đã chốt)
const V = "/api/v1";
const db = () => testEnv.DB;
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 0;

async function mkOrder(status: string, shipping = 20000) {
  const n = ++seq;
  const total = 100000 + shipping;
  const r = await db()
    .prepare(
      `INSERT INTO orders(code, channel, kind, store_id, status, subtotal, shipping_fee, total, tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id, payment_method, payment_status, paid_total, estimated_total)
       VALUES (?, 'online','sale',1,?,100000,?,?,?, 'A','0901234567','12 Lê Lợi, Quận 1',1,?,1,'transfer','paid',?,?) RETURNING id`,
    )
    .bind(`DH-20990404-${String(n).padStart(4, "0")}`, status, shipping, total, `tok6a-${n}-${crypto.randomUUID()}`, vnDate(), total, total)
    .first<{ id: number }>();
  await db().prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total, ordered_qty_milli) VALUES (?,820,'kg',2000,50000,100000,2000)`).bind(r!.id).run();
  await db().prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'transfer', ?, 2, 'confirmed')`).bind(r!.id, total).run();
  return { id: r!.id, total };
}
const cancel = (id: number) => api("online_staff", "POST", `${V}/online-orders/${id}/cancel`, { reason: "Khách đổi ý" });
const setS = (k: string, v: string) => db().prepare(`UPDATE settings SET value=? WHERE key=?`).bind(v, k).run();

beforeAll(async () => {
  await seedBase();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id) VALUES (820,'P820','Cam','kg',1,1)`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (820,'LOT820',820,1,?,?,20000,20000,20000)`).bind(future(0), future(10)),
    d.prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES (1,'Nội thành','["Quận 1"]',0,NULL,0)`),
    d.prepare(`INSERT INTO delivery_slots(id, label, start_time, end_time, capacity) VALUES (1,'8:00–10:00','08:00','10:00',50)`),
  ]);
});

describe("A-28: phí giao khi huỷ đơn online theo giai đoạn", () => {
  it("mặc định: chưa soạn (mới/đã xác nhận) → miễn phí giao, hoàn đủ", async () => {
    for (const st of ["new", "confirmed"]) {
      const o = await mkOrder(st);
      const r = await cancel(o.id);
      expect(r.status, st).toBe(200);
      expect(r.body.refundDue, st).toBe(o.total);
      expect(r.body.shippingFeePolicy, st).toBe("shop");
    }
  });
  it("mặc định: đã soạn/đóng gói → khách chịu phí giao", async () => {
    const o = await mkOrder("preparing");
    const r = await cancel(o.id);
    expect(r.body).toMatchObject({ status: "cancelled", refundDue: 100000, shippingFeePolicy: "customer" });
  });
  it("đơn đang giao không huỷ trực tiếp; giao thất bại rồi trả hàng → khách chịu phí giao", async () => {
    const sh = await mkOrder("shipping");
    expect((await cancel(sh.id)).status).toBe(409);
    const o = await mkOrder("delivery_failed");
    const ol = await db().prepare(`SELECT id FROM order_lines WHERE order_id=?`).bind(o.id).first<any>();
    await db().prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,820,2000,20000)`).bind(ol.id).run();
    const r = await api("online_staff", "POST", `${V}/online-orders/${o.id}/return-to-stock`, { lines: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "returned", refundDue: 100000, shippingFeePolicy: "customer" });
  });
  it("đổi tham số từng giai đoạn có hiệu lực, đơn không phí giao không bị trừ", async () => {
    await setS("online.cancel_fee_before_prepare", "customer");
    await setS("online.cancel_fee_preparing", "shop");
    await setS("online.cancel_fee_shipping", "shop");
    try {
      expect((await cancel((await mkOrder("new")).id)).body.refundDue).toBe(100000);
      expect((await cancel((await mkOrder("preparing")).id)).body.refundDue).toBe(120000);
      expect((await cancel((await mkOrder("new", 0)).id)).body.refundDue).toBe(100000);
    } finally {
      await setS("online.cancel_fee_before_prepare", "shop");
      await setS("online.cancel_fee_preparing", "customer");
      await setS("online.cancel_fee_shipping", "customer");
    }
  });
  it("kế toán hoàn đúng phần còn lại, phí giao giữ lại", async () => {
    const o = await mkOrder("preparing");
    await cancel(o.id);
    const r = await api("accountant", "POST", `${V}/online-orders/${o.id}/refund`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = await db().prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=?`).bind(o.id).first<any>();
    expect(s.s).toBe(20000);
  });
});
