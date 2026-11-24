import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate } from "../src/worker/lib/time";

// Đợt fix 4a — A-14: huỷ/trả hàng online chỉ tạo NGHĨA VỤ hoàn tiền; ghi quỹ khi finance.write bấm /refund
const V = "/api/v1";
const db = () => testEnv.DB;
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 0;

async function mkOrder(pid: number, o: { method?: string; status?: string; paid?: boolean; shipping?: number } = {}) {
  const d = db();
  const n = ++seq;
  const method = o.method ?? "transfer";
  const shipping = o.shipping ?? 0;
  const total = 100000 + shipping;
  const r = await d
    .prepare(
      `INSERT INTO orders(code, channel, kind, store_id, status, subtotal, shipping_fee, total, tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id, payment_method, payment_status, paid_total, estimated_total)
       VALUES (?, 'online','sale',1,?,100000,?,?,?, 'A','0901234567','12 Lê Lợi, Quận 1',1,?,1,?,?,?,?) RETURNING id`,
    )
    .bind(`DH-20990303-${String(n).padStart(4, "0")}`, o.status ?? "preparing", shipping, total, `tok4a-${n}-${crypto.randomUUID()}`, vnDate(), method, o.paid ? "paid" : "unpaid", o.paid ? total : 0, total)
    .first<{ id: number }>();
  await d.prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total, ordered_qty_milli) VALUES (?,?, 'kg',2000,50000,100000,2000)`).bind(r!.id, pid).run();
  if (o.paid) await d.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, ?, ?, 2, 'confirmed')`).bind(r!.id, method === "cod" ? "cod" : "transfer", total).run();
  return { id: r!.id, total };
}
const post = (role: string, oid: number, action: string, body: unknown = {}) => api(role, "POST", `${V}/online-orders/${oid}/${action}`, body);
const sumPay = async (id: number) => (await db().prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=?`).bind(id).first<any>()).s as number;

beforeAll(async () => {
  await seedBase();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id) VALUES (810,'P810','Nho','kg',1,1)`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (810,'LOT810',810,1,?,?,20000,20000,20000)`).bind(future(0), future(10)),
    d.prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES (1,'Nội thành','["Quận 1"]',0,NULL,0)`),
    d.prepare(`INSERT INTO delivery_slots(id, label, start_time, end_time, capacity) VALUES (1,'8:00–10:00','08:00','10:00',50)`),
  ]);
});

describe("A-14: nghĩa vụ hoàn tiền tách quyền", () => {
  it("huỷ đơn đã thanh toán: online_staff không ghi quỹ, chỉ tạo refund_due; kế toán hoàn một lần", async () => {
    const o = await mkOrder(810, { paid: true });
    const c = await post("online_staff", o.id, "cancel", { reason: "Khách đổi ý" });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "cancelled", paymentStatus: "paid", refundDue: o.total, result: { refund: 0, refundDue: o.total } });
    expect(await sumPay(o.id)).toBe(o.total); // chưa có dòng quỹ âm
    const list = await api("manager", "GET", `${V}/online-orders?q=DH-20990303`);
    expect(list.body.items.find((x: any) => x.id === o.id)).toMatchObject({ needsRefund: true, refundDue: o.total });
    expect((await post("online_staff", o.id, "refund")).status).toBe(403);
    const r = await post("accountant", o.id, "refund");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paymentStatus: "refunded", paidTotal: 0, refundDue: 0, result: { refund: o.total } });
    expect(await sumPay(o.id)).toBe(0);
    expect((await post("accountant", o.id, "refund")).status).toBe(409); // không hoàn đôi
    const a = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='online_order.refund' AND entity_id=?`).bind(String(o.id)).first<any>();
    expect(a.n).toBe(1);
  });

  it("hoàn đồng thời chỉ ghi một lần", async () => {
    const o = await mkOrder(810, { paid: true });
    await post("online_staff", o.id, "cancel", { reason: "Khách đổi ý" });
    const res = await Promise.all([post("accountant", o.id, "refund"), post("accountant", o.id, "refund")]);
    expect(res.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await sumPay(o.id)).toBe(0);
  });

  it("COD chưa thu tiền: huỷ không phát sinh nghĩa vụ hoàn", async () => {
    const o = await mkOrder(810, { method: "cod" });
    const c = await post("online_staff", o.id, "cancel", { reason: "Khách không nghe máy" });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "cancelled", refundDue: 0 });
    expect((await post("accountant", o.id, "refund")).status).toBe(409);
  });

  it("chính sách phí giao do khách chịu: nghĩa vụ hoàn trừ phí giao", async () => {
    await db().prepare(`UPDATE settings SET value='customer' WHERE key='online.cancel_fee_policy'`).run();
    const o = await mkOrder(810, { paid: true, shipping: 20000 });
    const c = await post("online_staff", o.id, "cancel", { reason: "Khách đổi ý" });
    await db().prepare(`UPDATE settings SET value='shop' WHERE key='online.cancel_fee_policy'`).run();
    expect(c.body).toMatchObject({ refundDue: 100000 });
    const r = await post("accountant", o.id, "refund");
    expect(r.body).toMatchObject({ paymentStatus: "partially_refunded", result: { refund: 100000 } });
    expect(await sumPay(o.id)).toBe(20000);
  });

  it("đơn đã giao rồi trả: tạo phiếu trả + nghĩa vụ hoàn, quỹ chưa đổi tới khi kế toán hoàn", async () => {
    const o = await mkOrder(810, { paid: true, status: "completed" });
    const ol = await db().prepare(`SELECT id FROM order_lines WHERE order_id=?`).bind(o.id).first<any>();
    await db().prepare(`INSERT INTO order_line_lots(order_line_id, lot_id, qty_milli, unit_cost) VALUES (?,810,2000,20000)`).bind(ol.id).run();
    const r = await post("online_staff", o.id, "return-to-stock", { lines: [{ orderLineId: ol.id, qty: 2, restock: true, reason: "Khách trả" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "completed", refundDue: o.total, paidTotal: o.total });
    expect(await sumPay(o.id)).toBe(o.total);
    expect((await post("online_staff", o.id, "refund")).status).toBe(403);
    expect((await post("accountant", o.id, "refund")).body).toMatchObject({ paymentStatus: "refunded", paidTotal: 0, refundDue: 0 });
    expect(await sumPay(o.id)).toBe(0);
  });
});
