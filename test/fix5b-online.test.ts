import { beforeAll, describe, expect, it } from "vitest";
import { ADDR, call, checkoutBody, register, seedShop, testEnv, today, tomorrow } from "./shop-helpers";
import { api } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { reserveStmts } from "../src/worker/services/reservations";
import { runScheduled } from "../src/worker/scheduled";

// Đợt fix 5b — đơn online: A-08, A-11, A-15, A-17, A-18, A-19, A-20, A-24
const V = "/api/v1";
const db = () => testEnv.DB;
const iso = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
let seq = 0;
const orderRow = (code: string) => db().prepare(`SELECT * FROM orders WHERE code=?`).bind(code).first<any>();
const post = (role: string, oid: number, action: string, body: unknown = {}) => api(role, "POST", `${V}/online-orders/${oid}/${action}`, body);
async function mkPromo(amount: number, minOrder: number, voucher: string, maxUses: number | null = null) {
  const p = await db()
    .prepare(`INSERT INTO promotions(code, name, kind, channels, value_amount, min_order, starts_at, ends_at, requires_voucher, status, created_by) VALUES (?,?, 'amount','online',?,?, '2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z', 1,'active',1) RETURNING id`)
    .bind(`KM-F5B${++seq}`, `F5B ${seq}`, amount, minOrder)
    .first<{ id: number }>();
  await db().prepare(`INSERT INTO vouchers(code, promotion_id, max_uses) VALUES (?,?,?)`).bind(voucher, p!.id, maxUses).run();
}
/** Đặt đơn COD qua web → xác nhận → chuẩn bị. */
async function readyOrder(body: Record<string, unknown> = {}, headers?: Record<string, string>) {
  const r = await call("POST", "/api/checkout", checkoutBody(body), { headers });
  expect(r.status).toBe(201);
  const o = await orderRow(r.body.code);
  expect((await post("online_staff", o.id, "confirm")).status).toBe(200);
  expect((await post("online_staff", o.id, "prepare")).status).toBe(200);
  return o.id as number;
}
const lineOf = async (oid: number) => (await db().prepare(`SELECT * FROM order_lines WHERE order_id=?`).bind(oid).first<any>())!;

beforeAll(async () => {
  await seedShop();
  await db().prepare(`INSERT OR IGNORE INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`).run();
  await mkPromo(15000, 0, "F5BV15");
  await mkPromo(15000, 140000, "F5BMIN");
});

describe("A-15: website dùng giá nhóm khách của tài khoản đăng nhập", () => {
  it("catalog + quote + checkout theo giá nhóm; vãng lai giữ giá chung", async () => {
    const d = db();
    await d.batch([
      d.prepare(`INSERT INTO customer_groups(id, code, name) VALUES (950,'than_thiet','Thân thiết')`),
      d.prepare(`INSERT INTO price_lists(id, name, channel, customer_group_id, kind, priority) VALUES (950,'TT online','online',950,'group',10)`),
      d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (950,901,40000,'2020-01-01T00:00:00Z','active',1)`),
    ]);
    const s = await register("a15@example.com", "Matkhau-123", "0912000015");
    await d.prepare(`UPDATE customers SET customer_group_id = 950 WHERE id = ?`).bind(s.account.customerId ?? (await d.prepare(`SELECT customer_id FROM shop_accounts WHERE email='a15@example.com'`).first<any>()).customer_id).run();
    const guest = await call("GET", "/api/products/cam-sanh");
    const mine = await call("GET", "/api/products/cam-sanh", undefined, { headers: s.headers });
    expect(guest.body.price).toBe(50000);
    expect(mine.body.price).toBe(40000);
    const q = await call("POST", "/api/cart/quote", { items: [{ productId: 901, unit: "kg", qty: 3 }], district: "Quận 1" }, { headers: s.headers });
    expect(q.body.lines[0].unitPrice).toBe(40000);
    const stale = await call("POST", "/api/checkout", checkoutBody(), { headers: s.headers });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("price_changed");
    const ok = await call("POST", "/api/checkout", checkoutBody({ items: [{ productId: 901, unit: "kg", qty: 3, expectedUnitPrice: 40000 }] }), { headers: s.headers });
    expect(ok.status).toBe(201);
    expect(ok.body.subtotal).toBe(120000);
    expect((await lineOf((await orderRow(ok.body.code)).id)).unit_price).toBe(40000);
    await d.prepare(`UPDATE price_lists SET active = 0 WHERE id = 950`).run();
  });
});

describe("A-24: khách vãng lai cùng SĐT dùng lại hồ sơ khách", () => {
  it("hai đơn cùng SĐT → một customers", async () => {
    const a = { ...ADDR, receiverPhone: "0987000124" };
    const r1 = await call("POST", "/api/checkout", checkoutBody({ address: a }));
    const r2 = await call("POST", "/api/checkout", checkoutBody({ address: { ...a, receiverPhone: "+84 987 000 124" } }));
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const o1 = await orderRow(r1.body.code), o2 = await orderRow(r2.body.code);
    expect(o2.customer_id).toBe(o1.customer_id);
    const n = await db().prepare(`SELECT COUNT(*) n FROM customers WHERE phone = '0987000124'`).first<any>();
    expect(n.n).toBe(1);
  });
});

describe("A-08: dòng đơn online mang giảm giá; báo cáo theo dòng khớp doanh thu", () => {
  it("voucher ghi order_lines.discount/line_total; P&L theo kênh = tổng doanh thu", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody({ voucherCode: "F5BV15" }));
    expect(r.status).toBe(201);
    const o = await orderRow(r.body.code);
    const l = await lineOf(o.id);
    expect(l).toMatchObject({ discount: 15000, line_total: 135000 });
    expect(l.line_total + o.shipping_fee).toBe(o.total);
    const oid = o.id;
    for (const a of ["confirm", "prepare"]) expect((await post("online_staff", oid, a)).status).toBe(200);
    expect((await post("online_staff", oid, "pack", { lines: [{ orderLineId: l.id, actualQty: 3 }] })).status).toBe(200);
    expect((await post("online_staff", oid, "ship", {})).status).toBe(200);
    expect((await post("online_staff", oid, "deliver")).status).toBe(200);
    const p = await api("manager", "GET", `${V}/reports/pnl?from=${today()}&to=${today()}&groupBy=channel`);
    expect(p.status).toBe(200);
    const online = p.body.breakdown.find((x: any) => x.key === "online");
    const exp = await db().prepare(`SELECT SUM(total) t FROM orders WHERE channel='online' AND kind='sale' AND status='completed'`).first<any>();
    expect(online.revenue).toBe(exp.t);
    expect(online.shipping).toBeGreaterThan(0);
    const sumRows = p.body.breakdown.reduce((s: number, x: any) => s + x.revenue, 0);
    expect(sumRows).toBe(p.body.revenue);
  });
});

describe("A-19 + A-20: tính lại sau cân; nhân viên ghi nhận khách đồng ý", () => {
  it("voucher min_order không còn đủ sau cân → bỏ giảm, hoàn lượt; staff override có lý do + audit", async () => {
    const oid = await readyOrder({ voucherCode: "F5BMIN" });
    const l = await lineOf(oid);
    expect(l.discount).toBe(15000);
    const used = async () => (await db().prepare(`SELECT used_count u FROM vouchers WHERE code='F5BMIN'`).first<any>()).u;
    expect(await used()).toBe(1);
    const pk = await post("online_staff", oid, "pack", { lines: [{ orderLineId: l.id, actualQty: 2 }] });
    expect(pk.status).toBe(200);
    const o = await db().prepare(`SELECT * FROM orders WHERE id=?`).bind(oid).first<any>();
    expect(o).toMatchObject({ subtotal: 100000, discount: 0, total: 120000, weight_adjust_status: "pending_customer" });
    expect(await lineOf(oid)).toMatchObject({ discount: 0, line_total: 100000 });
    expect(await used()).toBe(0);
    expect((await db().prepare(`SELECT status FROM voucher_redemptions WHERE order_id=?`).bind(oid).first<any>()).status).toBe("reversed");
    // A-20
    expect((await post("online_staff", oid, "ship", {})).status).toBe(409); // chưa được khách xác nhận
    expect((await post("online_staff", oid, "weight-override", { reason: "ok" })).status).toBe(422);
    const ov = await post("online_staff", oid, "weight-override", { reason: "Khách gọi điện đồng ý, SĐT 0901234567" });
    expect(ov.status).toBe(200);
    expect(ov.body).toMatchObject({ weightAdjustStatus: "accepted" });
    expect(await db().prepare(`SELECT weight_override_by b, weight_override_reason r FROM orders WHERE id=?`).bind(oid).first<any>()).toMatchObject({ r: "Khách gọi điện đồng ý, SĐT 0901234567" });
    const au = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='online_order.weight_override' AND entity_id=?`).bind(String(oid)).first<any>();
    expect(au.n).toBe(1);
    expect((await post("online_staff", oid, "weight-override", { reason: "lần hai ghi nhận" })).status).toBe(409);
    expect((await post("online_staff", oid, "ship", {})).status).toBe(200);
  });

  it("ngưỡng miễn phí giao xét lại theo tiền hàng thực; tắt cài đặt thì giữ nguyên", async () => {
    const oid = await readyOrder({ items: [{ productId: 901, unit: "kg", qty: 6, expectedUnitPrice: 50000 }] });
    expect((await db().prepare(`SELECT shipping_fee f FROM orders WHERE id=?`).bind(oid).first<any>()).f).toBe(0);
    const l = await lineOf(oid);
    const pk = await post("online_staff", oid, "pack", { lines: [{ orderLineId: l.id, actualQty: 5.5 }] });
    expect(pk.status).toBe(200);
    expect(await db().prepare(`SELECT shipping_fee f, total t, weight_adjust_status w FROM orders WHERE id=?`).bind(oid).first<any>()).toMatchObject({ f: 20000, t: 295000, w: "auto_accepted" });

    await db().prepare(`UPDATE settings SET value='0' WHERE key='online.pack_recalc_shipping'`).run();
    const oid2 = await readyOrder({ items: [{ productId: 901, unit: "kg", qty: 6, expectedUnitPrice: 50000 }] });
    await post("online_staff", oid2, "pack", { lines: [{ orderLineId: (await lineOf(oid2)).id, actualQty: 5.5 }] });
    expect(await db().prepare(`SELECT shipping_fee f, total t FROM orders WHERE id=?`).bind(oid2).first<any>()).toMatchObject({ f: 0, t: 275000 });
    await db().prepare(`UPDATE settings SET value='1' WHERE key='online.pack_recalc_shipping'`).run();
  });
});

describe("A-18: một cách đếm sức chứa khung giờ; giao lại kiểm sức chứa", () => {
  it("đơn đã trả không chiếm chỗ; redeliver vào khung đầy → 409", async () => {
    const day = addDays(tomorrow(), 3);
    const first = await call("POST", "/api/checkout", checkoutBody({ slotDate: day, slotId: 2 }));
    expect(first.status).toBe(201);
    const full = await call("POST", "/api/checkout", checkoutBody({ slotDate: day, slotId: 2 }));
    expect(full.status).toBe(409);
    // đơn đầu bị trả → khung được giải phóng (trước đây web vẫn tính đơn 'returned')
    await db().prepare(`UPDATE orders SET status='returned' WHERE code=?`).bind(first.body.code).run();
    const again = await call("POST", "/api/checkout", checkoutBody({ slotDate: day, slotId: 2 }));
    expect(again.status).toBe(201);
    // giao lại một đơn giao thất bại vào khung đã đầy
    const b = await call("POST", "/api/checkout", checkoutBody({ slotDate: addDays(tomorrow(), 4), slotId: 1 }));
    const bo = await orderRow(b.body.code);
    await db().prepare(`UPDATE orders SET status='delivery_failed' WHERE id=?`).bind(bo.id).run();
    const r = await post("online_staff", bo.id, "redeliver", { slotDate: day, slotId: 2 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("slot_full");
    const okr = await post("online_staff", bo.id, "redeliver", { slotDate: addDays(tomorrow(), 5), slotId: 2 });
    expect(okr.status).toBe(200);
    // đã quá giờ chốt (hôm nay, khung 00:00)
    await db().prepare(`UPDATE orders SET status='delivery_failed' WHERE id=?`).bind(bo.id).run();
    const late = await post("online_staff", bo.id, "redeliver", { slotDate: today(), slotId: 3 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("slot_cutoff");
  });
});

describe("A-11: số dư quỹ gồm tiền đơn trả trước chưa hoàn tất", () => {
  it("mark-paid → quỹ tăng ngay; huỷ + hoàn → về lại", async () => {
    const bal = async () => (await api("accountant", "GET", `${V}/funds`)).body.items.reduce((s: number, f: any) => s + f.balance, 0) as number;
    const base = await bal();
    const r = await call("POST", "/api/checkout", checkoutBody({ paymentMethod: "transfer" }));
    expect(r.status).toBe(201);
    const o = await orderRow(r.body.code);
    const mp = await api("accountant", "POST", `${V}/online-orders/${o.id}/mark-paid`, { ref: "F5B-REF-1" });
    expect(mp.status).toBe(200);
    expect((await orderRow(r.body.code)).status).not.toBe("completed");
    expect(await bal()).toBe(base + o.total);
    expect((await post("online_staff", o.id, "cancel", { reason: "Khách đổi ý" })).status).toBe(200);
    expect(await bal()).toBe(base + o.total); // chờ hoàn
    expect((await post("accountant", o.id, "refund")).status).toBe(200);
    expect(await bal()).toBe(base);
  });
});

describe("A-17: cron 00:00 đổi lô giữ tồn vừa hết hạn ngay", () => {
  it("reservation trên lô hết hạn được chuyển sang lô tốt sau cron nửa đêm", async () => {
    const d = db();
    await d.batch([
      d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight) VALUES (960,'F5B960','Nho 960','kg',0)`),
      d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (9601,'F960A',960,1,?,?,1000,5000,5000),(9602,'F960B',960,1,?,?,1000,5000,5000)`).bind(iso(-3), iso(1), iso(-3), iso(30)),
      d.prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (9601,'DS-F960','b2b',1,'confirmed')`),
      d.prepare(`INSERT INTO order_lines(id, order_id, product_id, unit, qty_milli, unit_price, line_total) VALUES (9601,9601,960,'kg',3000,1,0)`),
    ]);
    await d.batch(reserveStmts(d, 9601, [{ orderLineId: 9601, productId: 960, alloc: [{ lotId: 9601, unitCost: 1000, qtyMilli: 3000 }] }]));
    await d.prepare(`UPDATE lots SET expires_at = ? WHERE id = 9601`).bind(iso(-0.001)).run(); // hết hạn lúc nửa đêm
    await runScheduled({ cron: "0 17 * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, testEnv);
    const act = await d.prepare(`SELECT lot_id, SUM(qty_milli) q FROM reservations WHERE order_id=9601 AND status='active' GROUP BY lot_id`).all<any>();
    expect(act.results).toEqual([{ lot_id: 9602, q: 3000 }]);
  });
});

describe("A-12: trả hàng online một phần theo dòng/số lượng", () => {
  it("trả 1 trong 3 kg: phiếu return đúng phần, không hoàn phí giao, đơn gốc vẫn completed", async () => {
    const oid = await readyOrder({ items: [{ productId: 901, unit: "kg", qty: 2, expectedUnitPrice: 50000 }, { productId: 905, unit: "kg", qty: 1, expectedUnitPrice: 150000 }] });
    const lines = (await db().prepare(`SELECT * FROM order_lines WHERE order_id=? ORDER BY id`).bind(oid).all<any>()).results;
    expect((await post("online_staff", oid, "pack", { lines: lines.map((l) => ({ orderLineId: l.id, actualQty: l.qty_milli / 1000 })) })).status).toBe(200);
    expect((await post("online_staff", oid, "ship", {})).status).toBe(200);
    expect((await post("online_staff", oid, "deliver")).status).toBe(200);
    const before = (await db().prepare(`SELECT total, shipping_fee FROM orders WHERE id=?`).bind(oid).first<any>())!;
    const r = await post("online_staff", oid, "return-to-stock", { lines: [{ orderLineId: lines[0].id, qty: 1, restock: true, reason: "Khách trả bớt 1kg" }] });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ returnTotal: 50000, fullyReturned: false, refundDue: 50000 });
    expect(r.body.status).toBe("completed");
    const ret = await db().prepare(`SELECT total, shipping_fee, kind FROM orders WHERE original_order_id=? AND kind='return'`).bind(oid).first<any>();
    expect(ret).toMatchObject({ total: 50000, kind: "return" });
    expect(before.shipping_fee).toBeGreaterThanOrEqual(0);
    expect((await db().prepare(`SELECT total FROM orders WHERE id=?`).bind(oid).first<any>()).total).toBe(before.total);
  });
});
