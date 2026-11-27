import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { lotQty, seedSales } from "./seed-sales";
import { vnPeriod } from "../src/worker/lib/time";

// POS-KV đợt B3: bán giao hàng tại quầy (docs/POS-KV-B.md)
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
let shiftId = 0;
const body = (over: Record<string, unknown> = {}) => ({
  clientUuid: `pkb3-${++seq}-${crypto.randomUUID()}`,
  receiver: { name: "Chị Lan", phone: "0901234567", address: "12 Lê Lợi, Quận 1" },
  lines: [{ productId: 1, unit: "kg", qty: 2 }], // 2kg Táo × 100.000 = 200.000
  shippingFee: 20000,
  deliverer: { userId: 3 },
  prepay: [] as any[],
  cod: 220000,
  ...over,
});
const create = (role: string, b: unknown) => api(role, "POST", `${V}/pos/delivery-orders`, b);
const act = (id: number, path: string, b?: unknown) => api("online_staff", "POST", `${V}/online-orders/${id}/${path}`, b ?? {});

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`),
    db().prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES (1,'Nội thành','["Quận 1"]',20000,NULL,0)`),
  ]);
  shiftId = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 500000 })).body.shift.id;
});

describe("POST /pos/delivery-orders", () => {
  it("không ca đang mở → 409; thủ kho 403; thu ngân tạo được", async () => {
    expect((await create("warehouse", body())).status).toBe(403);
    expect((await create("manager", body())).body.error.code).toBe("no_open_shift");
  });

  it("COD toàn bộ: đơn sang 'Đang giao', giữ hàng → trừ kho đúng lô, COD vào quỹ chờ khi giao, doanh thu chỉ khi hoàn tất", async () => {
    const before = await lotQty(1);
    const r = await create("cashier", body());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "shipping", total: 220000, cod: 220000, prepay: 0 });
    const o = (await db().prepare(`SELECT * FROM orders WHERE id=?`).bind(r.body.id).first<any>())!;
    expect(o).toMatchObject({ channel: "social", source: "pos", pos_shift_id: shiftId, deliverer_user_id: 3, shipping_fee: 20000, total: 220000, paid_total: 0, payment_method: "cod", status: "shipping" });
    expect(o.carrier).toContain("Test cashier");
    expect(o.shift_id).toBeNull();
    // kho trừ đúng lô FEFO (lô 1) khi chuyển sang Đang giao; còn giữ hàng = 0
    expect(await lotQty(1)).toBe(before - 2000);
    const lots = (await db().prepare(`SELECT oll.lot_id, oll.qty_milli FROM order_line_lots oll JOIN order_lines ol ON ol.id=oll.order_line_id WHERE ol.order_id=?`).bind(r.body.id).all<any>()).results;
    expect(lots).toEqual([{ lot_id: 1, qty_milli: 2000 }]);
    expect((await db().prepare(`SELECT COALESCE(SUM(qty_milli),0) q FROM reservations WHERE order_id=? AND status='active'`).bind(r.body.id).first<any>()).q).toBe(0);
    // chưa giao: chưa có doanh thu, chưa có tiền
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=?`).bind(r.body.id).first<any>()).n).toBe(0);
    const rev0 = await api("manager", "GET", `${V}/online-orders?source=pos&status=completed`);
    expect(rev0.body.summary.revenue).toBe(0);
    // giao xong → COD vào quỹ chờ đối soát
    const d = await act(r.body.id, "deliver");
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("completed");
    const pay = (await db().prepare(`SELECT method, amount, fund_id FROM payments WHERE order_id=?`).bind(r.body.id).all<any>()).results;
    expect(pay).toEqual([{ method: "cod", amount: 220000, fund_id: 3 }]);
    const list = await api("manager", "GET", `${V}/online-orders?source=pos`);
    expect(list.body.items.every((x: any) => x.source === "pos")).toBe(true);
    expect(list.body.summary.revenue).toBe(220000);
    const detail = await api("manager", "GET", `${V}/online-orders/${r.body.id}`);
    expect(detail.body).toMatchObject({ source: "pos", delivererUserId: 3, posShiftId: shiftId });
    expect((await api("online_staff", "GET", `${V}/online-orders/${r.body.id}`)).body).not.toHaveProperty("costTotal");
  });

  it("trả trước tiền mặt vào két ca (có trong tiền mặt dự kiến) + COD phần còn lại; xe ngoài ghi mã vận đơn", async () => {
    const r = await create("cashier", body({ prepay: [{ method: "cash", amount: 100000 }], cod: 120000, deliverer: { carrier: "Grab Express", trackingNo: "GRB123" } }));
    expect(r.status).toBe(201);
    const o = (await db().prepare(`SELECT * FROM orders WHERE id=?`).bind(r.body.id).first<any>())!;
    expect(o).toMatchObject({ paid_total: 100000, carrier: "Grab Express", carrier_tracking_no: "GRB123", deliverer_user_id: null, status: "shipping" });
    const pay = (await db().prepare(`SELECT method, amount, fund_id FROM payments WHERE order_id=?`).bind(r.body.id).all<any>()).results;
    expect(pay).toEqual([{ method: "cash", amount: 100000, fund_id: 1 }]);
    const s = await api("cashier", "GET", `${V}/shifts/${shiftId}/summary`);
    expect(s.status).toBe(200);
    const exp = s.body.cashFormula.expected;
    // đầu ca 500.000 + 100.000 trả trước (đơn COD thứ nhất chưa có tiền mặt)
    expect(exp).toBe(600000);
    // giao xong: COD chỉ thu phần còn lại
    expect((await act(r.body.id, "deliver")).status).toBe(200);
    const pay2 = (await db().prepare(`SELECT method, amount FROM payments WHERE order_id=? ORDER BY id`).bind(r.body.id).all<any>()).results;
    expect(pay2).toEqual([{ method: "cash", amount: 100000 }, { method: "cod", amount: 120000 }]);
    expect((await db().prepare(`SELECT paid_total, payment_status FROM orders WHERE id=?`).bind(r.body.id).first<any>())).toEqual({ paid_total: 220000, payment_status: "paid" });
  });

  it("trả trước chuyển khoản đủ → vào quỹ ngân hàng, không COD", async () => {
    const r = await create("cashier", body({ prepay: [{ method: "transfer", amount: 220000 }], cod: 0 }));
    expect(r.status).toBe(201);
    expect((await db().prepare(`SELECT fund_id FROM payments WHERE order_id=?`).bind(r.body.id).first<any>()).fund_id).toBe(2);
    expect((await act(r.body.id, "deliver")).status).toBe(200);
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=?`).bind(r.body.id).first<any>()).n).toBe(1);
  });

  it("prepay + cod ≠ tổng → 422, không tạo gì, không trừ giữ hàng", async () => {
    const n0 = (await db().prepare(`SELECT COUNT(*) n FROM orders WHERE source='pos'`).first<any>())!.n;
    const r = await create("cashier", body({ prepay: [{ method: "cash", amount: 100000 }], cod: 100000 }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("payment_mismatch");
    expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE source='pos'`).first<any>())!.n).toBe(n0);
  });

  it("thiếu hàng → 409, không ghi gì", async () => {
    const n0 = (await db().prepare(`SELECT COUNT(*) n FROM orders WHERE source='pos' AND status <> 'cancelled'`).first<any>())!.n;
    const total = 50 * 200000 + 20000; // gửi đúng tổng để chạm vào kiểm tồn (chỉ còn 5kg)
    const r2 = await create("cashier", body({ lines: [{ productId: 2, unit: "kg", qty: 50 }], cod: total }));
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe("insufficient_stock");
    expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE source='pos' AND status <> 'cancelled'`).first<any>())!.n).toBe(n0);
  });

  it("giao thất bại → trả hàng nhập lại kho đúng lô", async () => {
    const r = await create("cashier", body({ lines: [{ productId: 2, unit: "kg", qty: 1 }], shippingFee: 0, cod: 200000 }));
    expect(r.status).toBe(201);
    const q1 = await lotQty(2);
    expect((await act(r.body.id, "fail", { reason: "Khách không nhận" })).body.status).toBe("delivery_failed");
    const lines = (await db().prepare(`SELECT id FROM order_lines WHERE order_id=?`).bind(r.body.id).all<any>()).results;
    const rt = await act(r.body.id, "return-to-stock", { lines: [{ orderLineId: lines[0].id, qty: 1, restock: true, reason: "Hàng còn nguyên" }] });
    expect(rt.status).toBe(200);
    expect(await lotQty(2)).toBe(q1 + 1000);
    // chưa từng hoàn tất → không có doanh thu
    expect((await db().prepare(`SELECT status FROM orders WHERE id=?`).bind(r.body.id).first<any>()).status).not.toBe("completed");
  });

  it("validate: thiếu người giao / SĐT sai → 422", async () => {
    expect((await create("cashier", body({ deliverer: {} }))).status).toBe(422);
    expect((await create("cashier", body({ receiver: { name: "A", phone: "abc", address: "địa chỉ dài" } }))).status).toBe(422);
    expect((await create("cashier", body({ deliverer: { userId: 9999 } }))).status).toBe(422);
  });

  it("idempotent theo clientUuid; danh mục khu vực/nhân viên cho thu ngân", async () => {
    const b = body();
    const a = await create("cashier", b);
    const again = await create("cashier", b);
    expect(again.body.id).toBe(a.body.id);
    expect(again.body.created).toBe(false);
    const z = await api("cashier", "GET", `${V}/pos/delivery-zones`);
    expect(z.body.items[0]).toMatchObject({ id: 1, fee: 20000 });
    expect((await api("cashier", "GET", `${V}/pos/deliverers`)).body.items.length).toBeGreaterThan(0);
    expect((await api("warehouse", "GET", `${V}/pos/deliverers`)).status).toBe(403);
    const q = await api("cashier", "POST", `${V}/pos/delivery-quote`, { lines: [{ productId: 1, unit: "kg", qty: 3 }] });
    expect(q.body.subtotal).toBe(300000);
    expect((await api("warehouse", "POST", `${V}/pos/delivery-quote`, { lines: [{ productId: 1, unit: "kg", qty: 3 }] })).status).toBe(403);
  });

  it("kỳ khoá sổ → 423, không ghi gì", async () => {
    const n0 = (await db().prepare(`SELECT COUNT(*) n FROM orders WHERE source='pos'`).first<any>())!.n;
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    const r = await create("cashier", body());
    expect(r.status).toBe(423);
    expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE source='pos'`).first<any>())!.n).toBe(n0);
  });
});
