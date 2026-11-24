import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate, vnDayRangeUtc, vnPeriod } from "../src/worker/lib/time";

// Đợt fix 1b: A-02 (đơn trả trước đổi tổng sau cân), A-05 (trả hàng online sau giao = phiếu trả), B-08 (khoá sổ cho huỷ/trả)
const V = "/api/v1";
const db = () => testEnv.DB;
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 0;

async function mkProduct(id: number, qtyMilli: number) {
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id) VALUES (?,?,?,'kg',1,1)`).bind(id, `P${id}`, `Nho ${id}`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (?,?,?,1,?,?,20000,?,?)`).bind(id, `LOT${id}`, id, future(0), future(10), qtyMilli, qtyMilli),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,50000,'2020-01-01T00:00:00Z','active',1)`).bind(id),
  ]);
}
const lot = async (id: number) => (await db().prepare(`SELECT qty_on_hand_milli h FROM lots WHERE id=?`).bind(id).first<any>())!.h as number;
const ord = async (id: number) => (await db().prepare(`SELECT * FROM orders WHERE id=?`).bind(id).first<any>())!;

/** Đơn online đang chuẩn bị, trả trước (chuyển khoản, đã nhận tiền đủ theo tổng ước tính). */
async function mkPrepaid(pid: number, qty: number, o: { method?: string; shipping?: number; status?: string; customerId?: number } = {}) {
  const d = db();
  const n = ++seq;
  const code = `DH-20990202-${String(n).padStart(4, "0")}`;
  const price = 50000, qtyMilli = Math.round(qty * 1000), shipping = o.shipping ?? 0;
  const sub = Math.round((price * qtyMilli) / 1000), total = sub + shipping;
  const method = o.method ?? "transfer";
  const prepaid = method !== "cod";
  const r = await d
    .prepare(
      `INSERT INTO orders(code, channel, kind, store_id, customer_id, status, subtotal, shipping_fee, total, tracking_token, receiver_name, receiver_phone, ship_address, zone_id, slot_date, slot_id,
                          payment_method, payment_status, paid_total, estimated_total)
       VALUES (?, 'online','sale',1,?,?,?,?,?,?, 'Nguyễn Văn A','0901234567','12 Lê Lợi, Quận 1',1,?,1,?,?,?,?) RETURNING id`,
    )
    .bind(code, o.customerId ?? null, o.status ?? "preparing", sub, shipping, total, `tok-${n}-${crypto.randomUUID()}`, vnDate(), method, prepaid ? "paid" : "unpaid", prepaid ? total : 0, total)
    .first<{ id: number }>();
  const line = await d
    .prepare(`INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total, ordered_qty_milli) VALUES (?,?, 'kg',?,?,?,?) RETURNING id`)
    .bind(r!.id, pid, qtyMilli, price, sub, qtyMilli)
    .first<{ id: number }>();
  if (prepaid) await d.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, status) VALUES (?, 'transfer', ?, 2, 'confirmed')`).bind(r!.id, total).run();
  return { id: r!.id, code, lineId: line!.id, total };
}
const post = (role: string, oid: number, action: string, body: unknown = {}) => api(role, "POST", `${V}/online-orders/${oid}/${action}`, body);
const pack = (oid: number, lineId: number, qty: number) => post("online_staff", oid, "pack", { lines: [{ orderLineId: lineId, actualQty: qty }] });
const pnl = async (day: string) => (await api("owner", "GET", `${V}/reports/pnl?from=${day}&to=${day}`)).body;

beforeAll(async () => {
  await seedBase();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`),
    d.prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES (1,'Nội thành','["Quận 1"]',0,NULL,0)`),
    d.prepare(`INSERT INTO delivery_slots(id, label, start_time, end_time, capacity) VALUES (1,'8:00–10:00','08:00','10:00',50)`),
    d.prepare(`INSERT INTO customers(id, code, type, name, phone, points) VALUES (7501,'T1B-KHE','retail','Khách điểm','0933333333',20)`),
  ]);
});

describe("A-02: đơn trả trước đổi tổng sau khi cân", () => {
  it("cân nặng hơn: lưu 'thu thêm', cho giao; giao hàng ghi phiếu COD đúng phần chênh", async () => {
    await mkProduct(701, 50000);
    const o = await mkPrepaid(701, 2); // 100.000 đã chuyển khoản
    expect((await post("online_staff", o.id, "confirm")).status).toBe(409); // đang preparing — guard trạng thái
    const p = await pack(o.id, o.lineId, 2.2); // 110.000, lệch đúng 10% → tự chấp nhận
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ total: 110000, paidTotal: 100000, diffAmount: 10000, diffStatus: "pending", diffKind: "collect", weightAdjustStatus: "auto_accepted" });
    const list = await api("online_staff", "GET", `${V}/online-orders?status=preparing`);
    expect(list.body.items.find((x: any) => x.id === o.id)).toMatchObject({ diffAmount: 10000, diffStatus: "pending" });
    expect((await post("online_staff", o.id, "ship")).status).toBe(200);
    // không được tự "hoàn" khoản thu thêm
    expect((await post("accountant", o.id, "refund-diff")).status).toBe(409);
    const dl = await post("online_staff", o.id, "deliver");
    expect(dl.status, JSON.stringify(dl.body)).toBe(200);
    expect(dl.body).toMatchObject({ status: "completed", diffStatus: "settled", paidTotal: 110000 });
    const pays = (await db().prepare(`SELECT method, amount, fund_id FROM payments WHERE order_id=? ORDER BY id`).bind(o.id).all<any>()).results;
    expect(pays).toEqual([{ method: "transfer", amount: 100000, fund_id: 2 }, { method: "cod", amount: 10000, fund_id: 3 }]);
    expect((await ord(o.id)).total).toBe(110000);
  });

  it("cân nhẹ hơn: không hoàn tất khi chưa hoàn/miễn; hoàn phần dư (cùng quỹ gốc) rồi hoàn tất", async () => {
    await mkProduct(702, 50000);
    const o = await mkPrepaid(702, 2);
    const p = await pack(o.id, o.lineId, 1.8); // 90.000
    expect(p.body).toMatchObject({ total: 90000, diffAmount: -10000, diffStatus: "pending", diffKind: "refund" });
    expect((await post("online_staff", o.id, "ship")).status).toBe(200);
    const blocked = await post("online_staff", o.id, "deliver");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("diff_unsettled");
    expect((await ord(o.id)).status).toBe("shipping");
    expect((await post("online_staff", o.id, "refund-diff")).status).toBe(403); // cần finance.write
    const rf = await post("accountant", o.id, "refund-diff");
    expect(rf.status, JSON.stringify(rf.body)).toBe(200);
    expect(rf.body).toMatchObject({ diffStatus: "settled", paidTotal: 90000, result: { refund: 10000 } });
    expect((await post("accountant", o.id, "refund-diff")).status).toBe(409); // không hoàn đôi
    expect((await db().prepare(`SELECT SUM(amount) s FROM payments WHERE order_id=?`).bind(o.id).first<any>()).s).toBe(90000);
    expect((await db().prepare(`SELECT method, fund_id, amount FROM payments WHERE order_id=? AND amount<0`).bind(o.id).first<any>())).toEqual({ method: "transfer", fund_id: 2, amount: -10000 });
    expect((await post("online_staff", o.id, "deliver")).body.status).toBe("completed");
  });

  it("miễn chênh lệch: chỉ người có quyền duyệt (finance.approve), bắt buộc lý do, có audit", async () => {
    await mkProduct(703, 50000);
    const o = await mkPrepaid(703, 2);
    await pack(o.id, o.lineId, 1.9);
    await post("online_staff", o.id, "ship");
    expect((await post("online_staff", o.id, "waive-diff", { reason: "Khách đồng ý bỏ qua" })).status).toBe(403);
    expect((await post("accountant", o.id, "waive-diff", { reason: "Khách đồng ý bỏ qua" })).status).toBe(403);
    expect((await post("owner", o.id, "waive-diff", {})).status).toBe(422);
    const w = await post("owner", o.id, "waive-diff", { reason: "Khách đồng ý bỏ qua 5.000đ" });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body).toMatchObject({ diffStatus: "waived", diffNote: "Khách đồng ý bỏ qua 5.000đ" });
    expect((await db().prepare(`SELECT reason FROM audit_log WHERE action='online_order.diff_waive' AND entity_id=?`).bind(String(o.id)).first<any>())?.reason).toBe("Khách đồng ý bỏ qua 5.000đ");
    expect((await post("online_staff", o.id, "deliver")).body.status).toBe("completed");
  });

  it("cân đúng ước tính hoặc đơn COD: không phát sinh chênh lệch", async () => {
    await mkProduct(704, 50000);
    const a = await mkPrepaid(704, 2);
    expect((await pack(a.id, a.lineId, 2)).body).toMatchObject({ diffAmount: 0, diffStatus: "none" });
    expect((await post("online_staff", a.id, "ship")).status).toBe(200);
    expect((await post("online_staff", a.id, "deliver")).body.status).toBe("completed");
    const b = await mkPrepaid(704, 2, { method: "cod" });
    expect((await pack(b.id, b.lineId, 2.1)).body).toMatchObject({ diffAmount: 0, diffStatus: "none", total: 105000 });
  });
});

describe("A-05: trả hàng online sau khi giao = phiếu trả hàng", () => {
  it("đơn gốc vẫn 'completed'; phiếu trả dated hôm nay trừ doanh thu ở NGÀY TRẢ; hoàn tiền; trả từng phần; điểm đảo đúng một lần", async () => {
    await mkProduct(710, 20000);
    const o = await mkPrepaid(710, 2, { shipping: 10000, customerId: 7501 }); // 100.000 + 10.000 ship = 110.000
    await db().prepare(`INSERT INTO loyalty_ledger(customer_id, order_id, kind, points, note) VALUES (7501, ?, 'earn', 20, 'tích')`).bind(o.id).run();
    await pack(o.id, o.lineId, 2);
    expect((await post("online_staff", o.id, "ship")).status).toBe(200);
    expect((await post("online_staff", o.id, "deliver")).body.status).toBe("completed");
    // đơn được giao từ 3 ngày trước
    const gave = new Date(Date.now() - 3 * 86400_000);
    await db().prepare(`UPDATE orders SET completed_at=? WHERE id=?`).bind(gave.toISOString(), o.id).run();
    const dayGave = vnDate(gave);
    const pGave = await pnl(dayGave), pToday = await pnl(vnDate());
    expect(pGave.salesTotal).toBeGreaterThanOrEqual(110000);
    expect(await lot(710)).toBe(18000);

    // trả 1 kg (còn tươi)
    const r1 = await post("online_staff", o.id, "return-to-stock", { lines: [{ orderLineId: o.lineId, qty: 1, restock: true, reason: "Khách đổi ý" }] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.status).toBe("completed");
    expect(r1.body.result).toMatchObject({ refund: 50000, fullyReturned: false });
    const ret1 = (await db().prepare(`SELECT * FROM orders WHERE original_order_id=? AND kind='return'`).bind(o.id).all<any>()).results;
    expect(ret1).toHaveLength(1);
    expect(ret1[0]).toMatchObject({ status: "completed", channel: "online", total: 50000, cost_total: 20000, paid_total: 50000 });
    expect(vnDate(new Date(ret1[0].completed_at))).toBe(vnDate());
    expect(await lot(710)).toBe(19000);
    // doanh thu ngày giao không đổi; ngày trả có returnsTotal
    expect((await pnl(dayGave)).salesTotal).toBe(pGave.salesTotal);
    expect((await pnl(dayGave)).returnsTotal).toBe(pGave.returnsTotal);
    expect((await pnl(vnDate())).returnsTotal).toBe(pToday.returnsTotal + 50000);
    const d1 = (await api("online_staff", "GET", `${V}/online-orders/${o.id}`)).body;
    expect(d1).toMatchObject({ status: "completed", returnedTotal: 50000, fullyReturned: false, paymentStatus: "partially_refunded", paidTotal: 60000 });
    expect(d1.returns).toHaveLength(1);
    expect((await db().prepare(`SELECT COALESCE(SUM(points),0) s FROM loyalty_ledger WHERE order_id=? AND kind='reverse'`).bind(o.id).first<any>()).s).toBe(-9); // floor(20 × 50.000/110.000)

    // vượt số còn lại → 409
    expect((await post("online_staff", o.id, "return-to-stock", { lines: [{ orderLineId: o.lineId, qty: 1.5, restock: true, reason: "quá" }] })).status).toBe(409);
    // trả phần còn lại không nhập lại kho (hỏng) → trả hết = hoàn cả phí giao; hao hụt vào P&L
    const r2 = await post("online_staff", o.id, "return-to-stock", { lines: [{ orderLineId: o.lineId, qty: 1, restock: false, reason: "Dập nát" }] });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.result).toMatchObject({ refund: 60000, fullyReturned: true });
    expect(r2.body).toMatchObject({ status: "completed", paymentStatus: "refunded", paidTotal: 0, fullyReturned: true, returnedTotal: 110000 });
    expect(await lot(710)).toBe(19000); // không nhập lại kho
    expect((await db().prepare(`SELECT SUM(amount) s FROM payments WHERE order_id=?`).bind(o.id).first<any>()).s).toBe(0);
    expect((await db().prepare(`SELECT COALESCE(SUM(points),0) s FROM loyalty_ledger WHERE order_id=? AND kind='reverse'`).bind(o.id).first<any>()).s).toBe(-20);
    expect((await db().prepare(`SELECT points FROM customers WHERE id=7501`).first<any>()).points).toBe(0);
    // đã trả hết → không trả nữa, điểm không đảo lần hai
    expect((await post("online_staff", o.id, "return-to-stock", { lines: [] })).status).toBe(409);
    expect((await db().prepare(`SELECT COALESCE(SUM(points),0) s FROM loyalty_ledger WHERE order_id=? AND kind='reverse'`).bind(o.id).first<any>()).s).toBe(-20);
    expect((await ord(o.id)).status).toBe("completed");
  });
});

describe("B-08: đơn online / B2B khi kỳ hiện tại đang khoá", () => {
  it("huỷ đơn, trả hàng sau giao (online) và trả hàng B2B bị chặn 423, không đổi dữ liệu", async () => {
    await mkProduct(720, 20000);
    const a = await mkPrepaid(720, 1); // sẽ huỷ
    const b = await mkPrepaid(720, 1); // đã giao, sẽ trả
    await pack(b.id, b.lineId, 1); await post("online_staff", b.id, "ship"); await post("online_staff", b.id, "deliver");
    const bo = await db().prepare(`INSERT INTO orders(code, channel, kind, store_id, customer_id, status, total) VALUES ('T1B-B2B-1','b2b','sale',1,7501,'completed',100000) RETURNING id`).first<{ id: number }>();
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    try {
      const c1 = await post("online_staff", a.id, "cancel", { reason: "Khách huỷ" });
      expect(c1.status).toBe(423);
      expect(c1.body.error.code).toBe("period_locked");
      expect((await ord(a.id)).status).toBe("preparing");
      const r1 = await post("online_staff", b.id, "return-to-stock", { lines: [] });
      expect(r1.status).toBe(423);
      expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE original_order_id=?`).bind(b.id).first<any>()).n).toBe(0);
      const r2 = await api("owner", "POST", `${V}/b2b/orders/${bo!.id}/returns`, { lines: [{ orderLineId: 1, qty: 1, unit: "kg", restock: true, reason: "trả thử" }] });
      expect(r2.status).toBe(423);
    } finally {
      await db().prepare(`DELETE FROM periods WHERE period=?`).bind(vnPeriod()).run();
    }
    expect((await post("online_staff", a.id, "cancel", { reason: "Khách huỷ" })).status).toBe(200);
  });
});
