import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { planReservations, reserveStmts } from "../src/worker/services/reservations";
import { cancelExpiredAwaitingPayment } from "../src/worker/services/online-payments";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 0;

/** Sản phẩm riêng cho từng nhóm test để số tồn kho kiểm tra chính xác. */
async function mkProduct(id: number, qtyMilli: number, cost = 20000, price = 50000, extra = "") {
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id ${extra ? ", allow_preorder" : ""}) VALUES (?,?,?,'kg',1,1 ${extra ? ", 1" : ""})`).bind(id, `P${id}`, `Cam ${id}`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,1,?,?,?,?,?)`).bind(id, `LOT${id}`, id, future(0), future(10), cost, qtyMilli, qtyMilli),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,?,'2020-01-01T00:00:00Z','active',1)`).bind(id, price),
  ]);
}
const lot = async (id: number) => (await db().prepare(`SELECT qty_on_hand_milli h, qty_reserved_milli r FROM lots WHERE id=?`).bind(id).first<{ h: number; r: number }>())!;
const order = async (id: number) => (await db().prepare(`SELECT * FROM orders WHERE id=?`).bind(id).first<any>())!;

interface Mk { status?: string; method?: string; pay?: string; lines: { pid: number; qty: number; price?: number }[]; shipping?: number; reserve?: boolean; created?: string; intent?: boolean; channel?: string }
async function mk(o: Mk) {
  const d = db();
  const n = ++seq;
  const code = `DH-20990101-${String(n).padStart(4, "0")}`;
  const lines = o.lines.map((l) => ({ ...l, price: l.price ?? 50000, qtyMilli: Math.round(l.qty * 1000) }));
  const subtotal = lines.reduce((s, l) => s + Math.round((l.price * l.qtyMilli) / 1000), 0);
  const shipping = o.shipping ?? 15000;
  const r = await d
    .prepare(
      `INSERT INTO orders(code, channel, kind, store_id, status, subtotal, shipping_fee, total, tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id,
                          payment_method, payment_status, estimated_total, created_at)
       VALUES (?,?, 'sale',1,?,?,?,?,?,?,?,?,1,?,1,?,?,?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) RETURNING id`,
    )
    .bind(code, o.channel ?? "online", o.status ?? "new", subtotal, shipping, subtotal + shipping, `tok-${n}-${crypto.randomUUID()}`, "Nguyễn Văn A", "0901234567", "12 Lê Lợi, Phường 1, Quận 1, TP.HCM",
      vnDate(), o.method ?? "cod", o.pay ?? "unpaid", subtotal + shipping, o.created ?? null)
    .first<{ id: number }>();
  const oid = r!.id;
  const ids: number[] = [];
  for (const l of lines) {
    const x = await d
      .prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total, ordered_qty_milli) VALUES (?,?, 'kg',?,?,?,?) RETURNING id`)
      .bind(oid, l.pid, l.qtyMilli, l.price, Math.round((l.price * l.qtyMilli) / 1000), l.qtyMilli)
      .first<{ id: number }>();
    ids.push(x!.id);
  }
  if (o.reserve !== false) {
    const plans = await planReservations(d, lines.map((l, i) => ({ orderLineId: ids[i], productId: l.pid, qtyMilli: l.qtyMilli })), 1);
    await d.batch(reserveStmts(d, oid, plans));
  }
  if (o.intent) {
    await d.prepare(`INSERT INTO payment_intents(order_id, provider, amount, transfer_content, expires_at) VALUES (?, 'vietqr', ?, ?, ?)`)
      .bind(oid, subtotal + shipping, code, future(0.01)).run();
  }
  return { id: oid, code, lineIds: ids, total: subtotal + shipping };
}
const post = (role: string, oid: number, action: string, body: unknown = {}) => api(role, "POST", `/api/v1/online-orders/${oid}/${action}`, body);

beforeAll(async () => {
  await seedBase();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`),
    d.prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES (1,'Nội thành','["Quận 1","Quận 3"]',15000,500000,0)`),
    d.prepare(`INSERT INTO delivery_slots(id, label, start_time, end_time, capacity) VALUES (1,'8:00–10:00','08:00','10:00',3),(2,'10:00–12:00','10:00','12:00',20)`),
    d.prepare(`INSERT INTO customers(id, code, type, name, phone, email) VALUES (901,'KHSI1','b2b','Nhà hàng Sỉ','0911111111',NULL),(902,'KHLE1','retail','Khách lẻ','0922222222',NULL)`),
  ]);
});

describe("danh sách + chi tiết (M1-05)", () => {
  it("lists online/social/fresco orders with counts and filters; cashier is forbidden", async () => {
    await mkProduct(601, 50000);
    const a = await mk({ status: "new", lines: [{ pid: 601, qty: 1 }] });
    await mk({ status: "confirmed", lines: [{ pid: 601, qty: 1 }], channel: "social" });
    await mk({ status: "awaiting_payment", method: "transfer", lines: [{ pid: 601, qty: 1 }], reserve: false });
    const all = await api("online_staff", "GET", "/api/v1/online-orders?slotDate=" + vnDate());
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(3);
    expect(all.body.counts.new).toBeGreaterThanOrEqual(1);
    expect(all.body.counts.awaiting_payment).toBeGreaterThanOrEqual(1);
    expect(all.body.counts.all).toBe(all.body.items.length);
    const item = all.body.items.find((x: any) => x.id === a.id);
    expect(item).toMatchObject({ code: a.code, channel: "online", status: "new", statusLabel: "Chờ xác nhận", paymentMethod: "cod", paymentStatus: "unpaid", slotLabel: "8:00–10:00", receiverName: "Nguyễn Văn A", district: "Quận 1", total: a.total, estimated: true, weightAdjustStatus: "none", isPreorder: false });
    const onlyNew = await api("manager", "GET", "/api/v1/online-orders?status=new&channel=online");
    expect(onlyNew.body.items.every((x: any) => x.status === "new" && x.channel === "online")).toBe(true);
    expect((await api("manager", "GET", `/api/v1/online-orders?q=${a.code}`)).body.items.map((x: any) => x.id)).toEqual([a.id]);
    expect((await api("cashier", "GET", "/api/v1/online-orders")).status).toBe(403);
    expect((await api("cashier", "POST", `/api/v1/online-orders/${a.id}/confirm`)).status).toBe(403);
  });

  it("detail shows reserved lots, internal notes; hides cost without prices.view_cost", async () => {
    await mkProduct(602, 10000);
    const o = await mk({ status: "new", lines: [{ pid: 602, qty: 2 }] });
    await post("online_staff", o.id, "confirm");
    const d1 = await api("online_staff", "GET", `/api/v1/online-orders/${o.id}`);
    expect(d1.status).toBe(200);
    expect(d1.body.costTotal).toBeUndefined();
    expect(d1.body.lines[0].costAmount).toBeUndefined();
    expect(d1.body.lines[0].lots).toEqual([{ lotId: 602, lotCode: "LOT602", qtyMilli: 2000, kind: "reserved" }]);
    expect(d1.body.events[0]).toMatchObject({ status: "confirmed", actorType: "staff" });
    const d2 = await api("manager", "GET", `/api/v1/online-orders/${o.id}`);
    expect(d2.body.lines[0].lots[0].unitCost).toBe(20000);
    expect(d2.body).toHaveProperty("costTotal");
    expect((await api("manager", "GET", "/api/v1/online-orders/999999")).status).toBe(404);
  });
});

describe("luồng xử lý + cân hàng EC-03", () => {
  it("confirm → prepare → pack within tolerance is auto_accepted; totals recomputed, ordered qty kept", async () => {
    await mkProduct(603, 20000);
    const o = await mk({ status: "new", lines: [{ pid: 603, qty: 2 }] }); // 100.000 + ship 15.000
    expect((await post("online_staff", o.id, "confirm")).body.status).toBe("confirmed");
    expect((await post("online_staff", o.id, "prepare")).body.status).toBe("preparing");
    const r = await post("online_staff", o.id, "pack", { lines: [{ orderLineId: o.lineIds[0], actualQty: 2.1 }] });
    expect(r.status).toBe(200);
    expect(r.body.weightAdjustStatus).toBe("auto_accepted");
    expect(r.body.subtotal).toBe(105000);
    expect(r.body.total).toBe(120000);
    expect(r.body.lines[0]).toMatchObject({ qtyMilli: 2100, orderedQtyMilli: 2000, lineTotal: 105000 });
    expect((await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE ref_type='order' AND ref_id=? AND type='notify.order_status'`).bind(o.id).first<any>()).n).toBe(3);
  });

  it("pack over tolerance → pending_customer and ship is blocked with 409; accepted lets it ship", async () => {
    await mkProduct(604, 20000);
    const o = await mk({ status: "preparing", lines: [{ pid: 604, qty: 2 }] });
    const r = await post("online_staff", o.id, "pack", { lines: [{ orderLineId: o.lineIds[0], actualQty: 3 }] });
    expect(r.body.weightAdjustStatus).toBe("pending_customer");
    expect(r.body.events.at(-1).note).toMatch(/xác nhận lại/);
    const s = await post("online_staff", o.id, "ship");
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe("weight_not_accepted");
    await db().prepare(`UPDATE orders SET weight_adjust_status='accepted' WHERE id=?`).bind(o.id).run();
    expect((await post("online_staff", o.id, "ship")).status).toBe(200);
  });

  it("EC-05: transfer order unpaid cannot ship", async () => {
    await mkProduct(605, 20000);
    const o = await mk({ status: "preparing", method: "transfer", pay: "unpaid", lines: [{ pid: 605, qty: 1 }] });
    const s = await post("online_staff", o.id, "ship");
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe("payment_required");
    expect((await lot(605)).h).toBe(20000);
  });

  it("mark-paid (finance.write) records payment, succeeds intent, awaiting_payment → new; second call 409", async () => {
    await mkProduct(606, 20000);
    const o = await mk({ status: "awaiting_payment", method: "transfer", lines: [{ pid: 606, qty: 1 }], intent: true });
    expect((await post("online_staff", o.id, "mark-paid", { ref: "FT123456" })).status).toBe(403);
    expect((await post("accountant", o.id, "mark-paid", {})).status).toBe(422);
    const r = await post("accountant", o.id, "mark-paid", { ref: "FT123456" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "new", paymentStatus: "paid", paidTotal: o.total });
    expect(r.body.payments).toMatchObject([{ method: "transfer", amount: o.total, ref: "FT123456", status: "confirmed" }]);
    expect(r.body.paymentIntents[0].status).toBe("succeeded");
    expect((await post("accountant", o.id, "mark-paid", { ref: "FT123456" })).status).toBe(409);
  });
});

describe("xuất kho theo số thực cân + giao hàng", () => {
  it("ship consumes the reserved lot by actual weight (lower), writes order_line_lots and cost", async () => {
    await mkProduct(607, 10000, 30000);
    const o = await mk({ status: "preparing", lines: [{ pid: 607, qty: 3 }] });
    expect(await lot(607)).toEqual({ h: 10000, r: 3000 });
    await post("online_staff", o.id, "pack", { lines: [{ orderLineId: o.lineIds[0], actualQty: 2.8 }] });
    const s = await post("manager", o.id, "ship", { carrier: "GHN", trackingNo: "GHN1" });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: "shipping", carrier: "GHN", carrierTrackingNo: "GHN1", costTotal: 84000 });
    expect(await lot(607)).toEqual({ h: 7200, r: 0 });
    expect(s.body.lines[0]).toMatchObject({ qtyMilli: 2800, costAmount: 84000 });
    expect(s.body.lines[0].lots).toEqual([{ lotId: 607, lotCode: "LOT607", qtyMilli: 2800, kind: "shipped", unitCost: 30000 }]);
    const moves = await db().prepare(`SELECT qty_delta_milli q, move_type t FROM stock_moves WHERE ref_type='order' AND ref_id=?`).bind(o.id).all<any>();
    expect(moves.results).toEqual([{ q: -2800, t: "sale" }]);
  });

  it("ship with actual weight above the reserved amount takes the extra from free stock FEFO", async () => {
    await mkProduct(608, 10000, 30000);
    const o = await mk({ status: "preparing", lines: [{ pid: 608, qty: 2 }] });
    await post("online_staff", o.id, "pack", { lines: [{ orderLineId: o.lineIds[0], actualQty: 2.4 }] });
    await db().prepare(`UPDATE orders SET weight_adjust_status='accepted' WHERE id=?`).bind(o.id).run();
    expect((await post("online_staff", o.id, "ship")).status).toBe(200);
    expect(await lot(608)).toEqual({ h: 7600, r: 0 });
    const ll = await db().prepare(`SELECT SUM(qty_milli) q FROM order_line_lots WHERE order_line_id=?`).bind(o.lineIds[0]).first<any>();
    expect(ll.q).toBe(2400);
    expect((await order(o.id)).cost_total).toBe(72000);
  });

  it("deliver COD creates a cod payment in cod_clearing and P&L includes the online order", async () => {
    await mkProduct(609, 10000, 20000);
    const o = await mk({ status: "preparing", lines: [{ pid: 609, qty: 2 }] }); // 100.000 + 15.000
    await post("online_staff", o.id, "ship");
    const d = await post("online_staff", o.id, "deliver");
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: "completed", paymentStatus: "paid", paidTotal: 115000 });
    expect(d.body.payments).toMatchObject([{ method: "cod", amount: 115000, fundId: 3, status: "confirmed" }]);
    const today = vnDate();
    const pnl = await api("owner", "GET", `/api/v1/reports/pnl?from=${today}&to=${today}&groupBy=channel`);
    expect(pnl.status).toBe(200);
    const row = pnl.body.breakdown.find((b: any) => b.key === "online");
    const expected = (await db().prepare(`SELECT COALESCE(SUM(ol.line_total),0) + (SELECT COALESCE(SUM(shipping_fee),0) FROM orders WHERE channel='online' AND kind='sale' AND status='completed') s, COALESCE(SUM(ol.cost_amount),0) c FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE o.channel='online' AND o.status='completed'`).first<any>())!;
    expect(row.revenue).toBe(expected.s);
    expect(row.cogs).toBe(expected.c);
    expect(row.revenue).toBeGreaterThanOrEqual(100000);
    expect(pnl.body.salesTotal).toBeGreaterThanOrEqual(115000);
    // đối soát quỹ COD
    const funds = await api("owner", "GET", "/api/v1/funds");
    expect(funds.body.items.find((f: any) => f.id === 3).payments_total).toBeGreaterThanOrEqual(115000);
  });

  it("fail → redeliver does not deduct stock twice; deliver afterwards", async () => {
    await mkProduct(610, 10000, 20000);
    const o = await mk({ status: "preparing", lines: [{ pid: 610, qty: 2 }] });
    await post("online_staff", o.id, "ship");
    expect((await lot(610)).h).toBe(8000);
    expect((await post("online_staff", o.id, "fail", { reason: "Khách không nghe máy" })).body.status).toBe("delivery_failed");
    const rd = await post("online_staff", o.id, "redeliver", { slotDate: new Date(Date.now() + 86400_000 + 7 * 3600_000).toISOString().slice(0, 10), slotId: 2 });
    expect(rd.status).toBe(200);
    expect(rd.body).toMatchObject({ status: "confirmed", slot: { id: 2 } });
    expect((await post("online_staff", o.id, "redeliver", { slotDate: new Date(Date.now() + 86400_000 + 7 * 3600_000).toISOString().slice(0, 10), slotId: 2 })).status).toBe(409);
    await post("online_staff", o.id, "prepare");
    expect((await post("online_staff", o.id, "pack", { lines: [{ orderLineId: o.lineIds[0], actualQty: 2 }] })).status).toBe(409); // đã xuất kho
    expect((await post("online_staff", o.id, "ship")).status).toBe(200);
    expect((await lot(610)).h).toBe(8000); // không trừ lần hai
    expect((await post("online_staff", o.id, "deliver")).body.status).toBe("completed");
  });

  it("return-to-stock restocks the exact lot; restock=false is recorded as waste; paid order is refunded", async () => {
    await mkProduct(611, 4000, 20000);
    // thêm lô thứ hai để kiểm tra đúng lô: đơn lấy lô 611 (hết hạn sớm hơn)
    await db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (6112,'LOT611B',611,1,?,?,25000,5000,5000)`).bind(future(0), future(20)).run();
    const o = await mk({ status: "preparing", method: "transfer", pay: "paid", lines: [{ pid: 611, qty: 6 }] }); // 4000 lô A + 2000 lô B
    await db().prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'transfer', ?, 2, 'confirmed')`).bind(o.id, o.total).run();
    await db().prepare(`UPDATE orders SET paid_total=? WHERE id=?`).bind(o.total, o.id).run();
    await post("online_staff", o.id, "ship");
    expect(await lot(611)).toEqual({ h: 0, r: 0 });
    expect(await lot(6112)).toEqual({ h: 3000, r: 0 });
    await post("online_staff", o.id, "fail", { reason: "Khách từ chối nhận" });
    const r = await post("online_staff", o.id, "return-to-stock", { lines: [{ orderLineId: o.lineIds[0], qty: 6, restock: true, reason: "Hàng còn tươi" }] });
    expect(r.status).toBe(200);
    // A-14: online_staff chỉ tạo nghĩa vụ hoàn tiền, quỹ chưa đổi
    expect(r.body).toMatchObject({ status: "returned", paymentStatus: "paid", refundDue: o.total, result: { refund: 0, refundDue: o.total } });
    expect(await lot(611)).toEqual({ h: 4000, r: 0 });
    expect(await lot(6112)).toEqual({ h: 5000, r: 0 });
    expect(r.body.payments.map((p: any) => p.amount)).toEqual([o.total]);
    expect((await post("online_staff", o.id, "refund")).status).toBe(403);
    const rf = await post("accountant", o.id, "refund");
    expect(rf.status).toBe(200);
    expect(rf.body).toMatchObject({ paymentStatus: "refunded", refundDue: 0 });
    expect(rf.body.payments.map((p: any) => p.amount)).toEqual([o.total, -o.total]);

    // restock=false → không cộng kho, ghi hao hụt
    await mkProduct(612, 5000, 20000);
    const w = await mk({ status: "preparing", lines: [{ pid: 612, qty: 2 }] });
    await post("online_staff", w.id, "ship");
    await post("online_staff", w.id, "fail", { reason: "Giao lỗi" });
    const rw = await post("online_staff", w.id, "return-to-stock", { lines: [{ orderLineId: w.lineIds[0], qty: 2, restock: false, reason: "Hàng dập nát" }] });
    expect(rw.status).toBe(200);
    expect((await lot(612)).h).toBe(3000);
    const wm = await db().prepare(`SELECT move_type t, qty_delta_milli q FROM stock_moves WHERE ref_type='order_return' AND ref_id=? ORDER BY id`).bind(w.id).all<any>();
    expect(wm.results).toEqual([{ t: "return", q: 2000 }, { t: "waste", q: -2000 }]);
  });
});

describe("huỷ đơn EC-06 + hết hạn thanh toán", () => {
  it("cancel after prepare restores reservations; pending intent cancelled; paid transfer is refunded", async () => {
    await mkProduct(613, 10000);
    const o = await mk({ status: "preparing", method: "transfer", pay: "paid", lines: [{ pid: 613, qty: 3 }], intent: true });
    await db().prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'transfer', ?, 2, 'confirmed')`).bind(o.id, o.total).run();
    expect(await lot(613)).toEqual({ h: 10000, r: 3000 });
    expect((await post("online_staff", o.id, "cancel", { reason: "x" })).status).toBe(422);
    const r = await post("online_staff", o.id, "cancel", { reason: "Khách đổi ý" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "cancelled", cancelReason: "Khách đổi ý", paymentStatus: "paid", refundDue: o.total });
    expect(r.body.payments.map((p: any) => p.amount)).toEqual([o.total]); // A-14: chưa ghi quỹ
    expect(await lot(613)).toEqual({ h: 10000, r: 0 });
    expect(r.body.paymentIntents[0].status).toBe("cancelled");
    expect((await db().prepare(`SELECT COUNT(*) n FROM reservations WHERE order_id=? AND status='active'`).bind(o.id).first<any>()).n).toBe(0);
    expect((await post("online_staff", o.id, "cancel", { reason: "lần hai" })).status).toBe(409);
  });

  it("refund endpoint settles a customer-cancelled paid order", async () => {
    await mkProduct(614, 5000);
    const o = await mk({ status: "cancelled", method: "transfer", pay: "paid", lines: [{ pid: 614, qty: 1 }], reserve: false });
    await db().prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'transfer', ?, 2, 'confirmed')`).bind(o.id, o.total).run();
    await db().prepare(`UPDATE orders SET refund_due=? WHERE id=?`).bind(o.total, o.id).run();
    const list = await api("manager", "GET", `/api/v1/online-orders?q=${o.code}`);
    expect(list.body.items[0].needsRefund).toBe(true);
    expect((await post("online_staff", o.id, "refund")).status).toBe(403);
    const r = await post("accountant", o.id, "refund");
    expect(r.status).toBe(200);
    expect(r.body.paymentStatus).toBe("refunded");
    expect((await post("accountant", o.id, "refund")).status).toBe(409);
  });

  it("scheduled: expired awaiting_payment orders are cancelled and stock released; fresh ones stay", async () => {
    await mkProduct(615, 10000);
    const old = await mk({ status: "awaiting_payment", method: "transfer", lines: [{ pid: 615, qty: 2 }], intent: true, created: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const fresh = await mk({ status: "awaiting_payment", method: "transfer", lines: [{ pid: 615, qty: 1 }], intent: true });
    expect(await lot(615)).toEqual({ h: 10000, r: 3000 });
    const n = await cancelExpiredAwaitingPayment(testEnv);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await order(old.id)).status).toBe("cancelled");
    expect((await order(fresh.id)).status).toBe("awaiting_payment");
    expect(await lot(615)).toEqual({ h: 10000, r: 1000 });
    expect((await db().prepare(`SELECT status FROM payment_intents WHERE order_id=?`).bind(old.id).first<any>()).status).toBe("expired");
    expect((await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE ref_type='order' AND ref_id=? AND type='notify.order_status'`).bind(old.id).first<any>()).n).toBe(1);
    expect(await cancelExpiredAwaitingPayment(testEnv)).toBe(0);
  });
});

describe("đồng thời", () => {
  it("two simultaneous ships: one wins, the other gets 409 and stock is deducted once", async () => {
    await mkProduct(616, 10000);
    const o = await mk({ status: "preparing", lines: [{ pid: 616, qty: 2 }] });
    const [a, b] = await Promise.all([post("online_staff", o.id, "ship"), post("manager", o.id, "ship")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lose = a.status === 409 ? a : b;
    expect(["order_changed", "invalid_transition"]).toContain(lose.body.error.code);
    expect(await lot(616)).toEqual({ h: 8000, r: 0 });
    expect((await order(o.id)).status).toBe("shipping");
  });

  it("confirm vs cancel race: loser gets 409, never 500", async () => {
    await mkProduct(617, 10000);
    const o = await mk({ status: "new", lines: [{ pid: 617, qty: 2 }] });
    const [a, b] = await Promise.all([post("online_staff", o.id, "confirm"), post("manager", o.id, "cancel", { reason: "Hết nhu cầu" })]);
    expect(a.status === 200 || b.status === 200).toBe(true);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    const st = (await order(o.id)).status;
    const r = await lot(617);
    expect(r.r).toBe(st === "cancelled" ? 0 : 2000);
  });
});

describe("khớp sao kê tự động", () => {
  it("bank import matches an order code with the exact amount and marks the order paid", async () => {
    await mkProduct(618, 10000);
    const o = await mk({ status: "awaiting_payment", method: "transfer", lines: [{ pid: 618, qty: 1 }], intent: true });
    const wrong = await mk({ status: "awaiting_payment", method: "transfer", lines: [{ pid: 618, qty: 1 }], intent: true });
    const csv = [
      "date,amount,description,ref",
      `2026-11-23,${o.total},CK ${o.code} thanh toan,BANK-ORD-1`,
      `2026-11-23,${wrong.total - 1000},${wrong.code},BANK-ORD-2`,
    ].join("\n");
    const r = await api("owner", "POST", "/api/v1/bank-transactions/import", { fundId: 2, csv });
    expect(r.status).toBe(201);
    expect(r.body.matched).toBe(1);
    expect(r.body.items.map((i: any) => i.status)).toEqual(["matched", "unmatched"]);
    const od = await order(o.id);
    expect(od).toMatchObject({ status: "new", payment_status: "paid", paid_total: o.total });
    expect((await order(wrong.id)).status).toBe("awaiting_payment");
    const p = await db().prepare(`SELECT method, amount, fund_id, ref FROM payments WHERE order_id=?`).bind(o.id).all<any>();
    expect(p.results).toEqual([{ method: "transfer", amount: o.total, fund_id: 2, ref: "BANK-ORD-1" }]);
    const t = await db().prepare(`SELECT status, matched_type, matched_id FROM bank_transactions WHERE bank_ref='BANK-ORD-1'`).first<any>();
    expect(t).toEqual({ status: "matched", matched_type: "order", matched_id: o.id });
  });
});

describe("đơn mạng xã hội + đặt trước", () => {
  const base = { receiverName: "Chị Lan", receiverPhone: "0988000111", addressLine: "5 Nguyễn Huệ", district: "quan 1", province: "TP.HCM" };

  it("creates transfer order awaiting payment with intent + reservation; cod → new; idempotent; zone fee; stock check", async () => {
    await mkProduct(619, 10000, 20000, 100000);
    const uuid = crypto.randomUUID();
    const r = await api("online_staff", "POST", "/api/v1/online-orders", { ...base, clientUuid: uuid, items: [{ productId: 619, unit: "kg", qty: 2 }], paymentMethod: "transfer", slotDate: vnDate(), slotId: 2 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ channel: "social", status: "awaiting_payment", paymentMethod: "transfer", subtotal: 200000, shippingFee: 15000, total: 215000, zone: { id: 1 } });
    expect(r.body.code).toMatch(/^DH\d{12}$/);
    expect(r.body.paymentIntents[0]).toMatchObject({ provider: "vietqr", amount: 215000, status: "pending" });
    expect(r.body.lines[0]).toMatchObject({ unitPrice: 100000, orderedQtyMilli: 2000 });
    expect(await lot(619)).toEqual({ h: 10000, r: 2000 });
    const again = await api("online_staff", "POST", "/api/v1/online-orders", { ...base, clientUuid: uuid, items: [{ productId: 619, unit: "kg", qty: 2 }], paymentMethod: "transfer" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(r.body.id);
    expect(await lot(619)).toEqual({ h: 10000, r: 2000 });
    const cod = await api("manager", "POST", "/api/v1/online-orders", { ...base, items: [{ productId: 619, unit: "kg", qty: 5 }], paymentMethod: "cod" });
    expect(cod.body).toMatchObject({ status: "new", shippingFee: 0 }); // 500.000 ≥ free_over
    const over = await api("manager", "POST", "/api/v1/online-orders", { ...base, items: [{ productId: 619, unit: "kg", qty: 4 }], paymentMethod: "cod" });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("insufficient_stock");
    expect(await lot(619)).toEqual({ h: 10000, r: 7000 });
    expect((await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='notify.staff_new_order' AND ref_id=?`).bind(r.body.id).first<any>()).n).toBe(1);
    expect((await api("cashier", "POST", "/api/v1/online-orders", { ...base, items: [{ productId: 619, unit: "kg", qty: 1 }], paymentMethod: "cod" })).status).toBe(403);
  });

  it("slot capacity is enforced (slot 1 capacity 3)", async () => {
    await mkProduct(620, 50000, 20000, 20000);
    const body = { ...base, items: [{ productId: 620, unit: "kg", qty: 1 }], paymentMethod: "cod", slotDate: "2099-01-01", slotId: 1 };
    for (let i = 0; i < 3; i++) expect((await api("online_staff", "POST", "/api/v1/online-orders", body)).status).toBe(201);
    const full = await api("online_staff", "POST", "/api/v1/online-orders", body);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("slot_full");
  });

  it("preorder: shortage becomes preorder_milli; confirm needs stock, then reserves and clears it", async () => {
    await mkProduct(621, 1000, 20000, 80000, "preorder");
    const noAccept = await api("online_staff", "POST", "/api/v1/online-orders", { ...base, items: [{ productId: 621, unit: "kg", qty: 3 }], paymentMethod: "cod" });
    expect(noAccept.status).toBe(409);
    const r = await api("online_staff", "POST", "/api/v1/online-orders", { ...base, items: [{ productId: 621, unit: "kg", qty: 3 }], paymentMethod: "cod", acceptPreorder: true });
    expect(r.status).toBe(201);
    expect(r.body.isPreorder).toBe(true);
    expect(r.body.lines[0]).toMatchObject({ qtyMilli: 3000, preorderMilli: 2000 });
    expect(await lot(621)).toEqual({ h: 1000, r: 1000 });
    const early = await post("online_staff", r.body.id, "confirm");
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("preorder_not_ready");
    expect((await order(r.body.id)).status).toBe("new");
    await db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (6212,'LOT621B',621,1,?,?,21000,5000,5000)`).bind(future(0), future(9)).run();
    const ok = await post("online_staff", r.body.id, "confirm");
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("confirmed");
    expect(ok.body.lines[0].preorderMilli).toBe(0);
    const reserved = (await db().prepare(`SELECT SUM(qty_milli) q FROM reservations WHERE order_id=? AND status='active'`).bind(r.body.id).first<any>()).q;
    expect(reserved).toBe(3000);
  });
});

describe("khu vực + khung giờ, tài khoản shop, liên kết sỉ", () => {
  it("zones/slots: read for online staff, write needs approvals.decide", async () => {
    expect((await api("online_staff", "GET", "/api/v1/delivery-zones")).body.items[0]).toMatchObject({ name: "Nội thành", districts: ["Quận 1", "Quận 3"], fee: 15000, freeOver: 500000, active: true });
    const body = { name: "Ngoại thành", districts: ["Thủ Đức"], fee: 30000, minOrder: 100000 };
    expect((await api("online_staff", "POST", "/api/v1/delivery-zones", body)).status).toBe(403);
    const z = await api("manager", "POST", "/api/v1/delivery-zones", body);
    expect(z.status).toBe(201);
    expect((await api("manager", "PUT", `/api/v1/delivery-zones/${z.body.id}`, { ...body, fee: 35000 })).body.fee).toBe(35000);
    const s = await api("manager", "POST", "/api/v1/delivery-slots", { label: "14:00–16:00", startTime: "14:00", endTime: "16:00", weekdays: [1, 2, 3] });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ cutoffMinutes: 90, capacity: 20, weekdays: [1, 2, 3] });
    expect((await api("manager", "POST", "/api/v1/delivery-slots", { label: "x", startTime: "16:00", endTime: "14:00" })).status).toBe(422);
    expect((await api("online_staff", "GET", "/api/v1/delivery-slots")).body.items.length).toBeGreaterThanOrEqual(3);
  });

  async function mkAccount(id: number, email: string) {
    await db().prepare(`INSERT INTO shop_accounts(id, customer_id, email, phone, full_name, pass_hash, kind, b2b_status) VALUES (?,?,?,?,?, 'x', 'retail', 'pending')`).bind(id, 902, email, "0900000000", "Chủ quán").run();
    const r = await db().prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('shop.b2b_link','shop_account',?,?,?,1) RETURNING id`).bind(String(id), JSON.stringify({ companyName: "Nhà hàng Sỉ", taxCode: "0312345678" }), "Yêu cầu liên kết").first<{ id: number }>();
    return r!.id;
  }

  it("b2b link: direct endpoint needs b2b.approve and closes the pending approval", async () => {
    const appr = await mkAccount(31, "a@example.com");
    expect((await api("accountant", "POST", "/api/v1/shop-accounts/31/b2b-link", { customerId: 901 })).status).toBe(403);
    expect((await api("manager", "POST", "/api/v1/shop-accounts/31/b2b-link", { customerId: 902 })).status).toBe(422); // khách lẻ
    const list = await api("manager", "GET", "/api/v1/shop-accounts?b2bStatus=pending");
    expect(list.body.items.find((a: any) => a.id === 31)).toMatchObject({ email: "a@example.com", b2bStatus: "pending", approvalId: appr, b2bRequest: { taxCode: "0312345678" } });
    expect(list.body.items[0].passHash).toBeUndefined();
    const r = await api("manager", "POST", "/api/v1/shop-accounts/31/b2b-link", { customerId: 901 });
    expect(r.body).toEqual({ id: 31, customerId: 901, kind: "b2b", b2bStatus: "approved" });
    expect((await db().prepare(`SELECT status FROM approvals WHERE id=?`).bind(appr).first<any>()).status).toBe("approved");
  });

  it("approval decide approved → 422 use_b2b_link_endpoint; rejection sets rejected", async () => {
    const appr = await mkAccount(32, "b@example.com");
    const ok = await api("manager", "POST", `/api/v1/approvals/${appr}/decide`, { decision: "approved" });
    expect(ok.status).toBe(422);
    expect(ok.body.error.code).toBe("use_b2b_link_endpoint");
    expect((await db().prepare(`SELECT status FROM approvals WHERE id=?`).bind(appr).first<any>()).status).toBe("pending");
    const appr2 = await mkAccount(33, "c@example.com");
    expect((await api("manager", "POST", `/api/v1/approvals/${appr2}/decide`, { decision: "rejected", note: "Không đúng" })).status).toBe(200);
    expect(await db().prepare(`SELECT kind, b2b_status FROM shop_accounts WHERE id=33`).first()).toEqual({ kind: "retail", b2b_status: "rejected" });
    expect((await api("cashier", "GET", "/api/v1/shop-accounts")).status).toBe(403);
  });
});
