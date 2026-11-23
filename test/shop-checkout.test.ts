import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ADDR, call, checkoutBody, lot, register, seedShop, testEnv, today, tomorrow } from "./shop-helpers";
import { crc16ccitt } from "../src/shop/worker/lib/vietqr";

beforeAll(seedShop);
afterEach(() => vi.restoreAllMocks());

const db = () => testEnv.DB;
const orderRow = (code: string) => db().prepare(`SELECT * FROM orders WHERE code = ?`).bind(code).first<any>();
const jobs = async (code: string) =>
  (await db().prepare(`SELECT type, payload_json FROM integration_jobs WHERE ref_type='order' AND ref_id=(SELECT id FROM orders WHERE code=?) ORDER BY id`).bind(code).all<any>()).results;

describe("checkout COD", () => {
  it("creates order, reserves FEFO stock, events, jobs and returns OrderView", async () => {
    const before = await lot(901);
    const r = await call("POST", "/api/checkout", checkoutBody());
    expect(r.status).toBe(201);
    const v = r.body;
    expect(v.code).toMatch(/^DH-\d{8}-\d{4}$/);
    expect(v).toMatchObject({
      status: "new", statusLabel: "Chờ xác nhận", slotDate: tomorrow(), slotLabel: "8:00–10:00", receiverName: ADDR.receiverName,
      receiverPhoneMasked: "******4567", paymentMethod: "cod", paymentStatus: "unpaid", subtotal: 150000, shippingFee: 20000, discount: 0, total: 170000,
      estimatedTotal: 170000, weightAdjustStatus: "none", canCancel: true, estimated: false,
    });
    expect(v.shipAddress).toBe("12 Lê Lợi, Bến Nghé, Quận 1, TP.HCM");
    expect(v.trackingToken.length).toBeGreaterThanOrEqual(30);
    expect(v.lines[0]).toMatchObject({ productId: 901, name: "Cam sành", unit: "kg", orderedQty: 3, qty: 3, unitPrice: 50000, lineTotal: 150000, preorderMilli: 0 });
    expect(v.events).toHaveLength(1);
    expect(v.events[0]).toMatchObject({ status: "new", statusLabel: "Chờ xác nhận" });
    expect(JSON.stringify(v)).not.toContain("internal");
    expect((await lot(901)).r).toBe(before.r + 3000);
    const o = await orderRow(v.code);
    expect(o).toMatchObject({ channel: "online", zone_id: 1, slot_id: 1, shop_account_id: null, is_preorder: 0 });
    const resv = await db().prepare(`SELECT SUM(qty_milli) q, COUNT(DISTINCT order_line_id) n FROM reservations WHERE order_id=? AND status='active'`).bind(o.id).first<any>();
    expect(resv).toMatchObject({ q: 3000, n: 1 });
    const ol = await db().prepare(`SELECT ordered_qty_milli, qty_milli FROM order_lines WHERE order_id=?`).bind(o.id).first<any>();
    expect(ol).toMatchObject({ ordered_qty_milli: 3000, qty_milli: 3000 });
    const cu = await db().prepare(`SELECT code, type FROM customers WHERE id=?`).bind(o.customer_id).first<any>();
    expect(cu.code).toMatch(/^KL-/);
    expect(cu.type).toBe("retail");
    expect((await jobs(v.code)).map((j: any) => j.type)).toEqual(["notify.order_status", "notify.staff_new_order"]);
  });

  it("is idempotent on clientUuid", async () => {
    const body = checkoutBody();
    const a = await call("POST", "/api/checkout", body);
    const before = await lot(901);
    const b = await call("POST", "/api/checkout", body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.code).toBe(a.body.code);
    expect((await lot(901)).r).toBe(before.r);
    const n = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE client_uuid=?`).bind(body.clientUuid).first<any>();
    expect(n.n).toBe(1);
  });

  it("auto-confirms COD orders when online.auto_confirm=1 and nothing is preordered", async () => {
    await db().prepare(`UPDATE settings SET value='1' WHERE key='online.auto_confirm'`).run();
    const r = await call("POST", "/api/checkout", checkoutBody());
    await db().prepare(`UPDATE settings SET value='0' WHERE key='online.auto_confirm'`).run();
    expect(r.body.status).toBe("confirmed");
    expect(r.body.events.map((e: any) => e.status)).toEqual(["new", "confirmed"]);
  });

  it("rejects unsupported zone, min order, unavailable payment and invalid slot", async () => {
    expect((await call("POST", "/api/checkout", checkoutBody({ address: { ...ADDR, district: "Quận 12" } }))).body.error.code).toBe("zone_unsupported");
    const m = await call("POST", "/api/checkout", checkoutBody({ items: [{ productId: 901, unit: "kg", qty: 1, expectedUnitPrice: 50000 }] }));
    expect(m.status).toBe(422);
    expect(m.body.error.code).toBe("min_order");
    expect((await call("POST", "/api/checkout", checkoutBody({ paymentMethod: "gateway" }))).body.error.code).toBe("payment_method_unavailable");
    expect((await call("POST", "/api/checkout", checkoutBody({ slotId: 99 }))).body.error.code).toBe("invalid_slot");
    expect((await call("POST", "/api/checkout", checkoutBody({ items: [{ productId: 903, unit: "kg", qty: 3, expectedUnitPrice: 10000 }] }))).body.error.code).toBe("product_unavailable");
  });

  it("returns 409 price_changed (EC-11) and creates nothing", async () => {
    const body = checkoutBody({ items: [{ productId: 901, unit: "kg", qty: 3, expectedUnitPrice: 45000 }] });
    const r = await call("POST", "/api/checkout", body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("price_changed");
    expect(r.body.error.details.lines).toEqual([{ productId: 901, oldPrice: 45000, newPrice: 50000 }]);
    expect(await orderRow("x")).toBeNull();
    expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE client_uuid=?`).bind(body.clientUuid).first<any>()).n).toBe(0);
  });
});

describe("stock, preorder and slots", () => {
  const dau = (qty: number) => [{ productId: 902, unit: "kg", qty, expectedUnitPrice: 200000 }];

  it("insufficient stock → 409 with masked availability; acceptPreorder → partial reservation", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody({ items: [{ productId: 906, unit: "kg", qty: 6, expectedUnitPrice: 20000 }] }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("insufficient_stock");
    expect(r.body.error.details).toEqual({ productId: 906, availableMilli: 0 });

    const noAccept = await call("POST", "/api/checkout", checkoutBody({ items: dau(3) }));
    expect(noAccept.status).toBe(409);
    expect(noAccept.body.error.details).toEqual({ productId: 902, availableMilli: 2000 });

    const before = await lot(902);
    const p = await call("POST", "/api/checkout", checkoutBody({ items: dau(3), acceptPreorder: true }));
    expect(p.status).toBe(201);
    expect(p.body.lines[0]).toMatchObject({ orderedQty: 3, qty: 3, preorderMilli: 1000 });
    expect((await lot(902)).r).toBe(before.r + 2000); // chỉ giữ phần có hàng
    const o = await orderRow(p.body.code);
    expect(o.is_preorder).toBe(1);
    // đơn preorder không tự xác nhận
    await db().prepare(`UPDATE settings SET value='1' WHERE key='online.auto_confirm'`).run();
    const p2 = await call("POST", "/api/checkout", checkoutBody({ items: dau(1), acceptPreorder: true }));
    await db().prepare(`UPDATE settings SET value='0' WHERE key='online.auto_confirm'`).run();
    expect(p2.status).toBe(201); // phần còn lại của lô 902 đã hết → toàn bộ là preorder
    expect(p2.body.status).toBe("new");
    expect(p2.body.lines[0].preorderMilli).toBe(1000);
    // trả lại tồn cho các test sau
    await db().prepare(`UPDATE lots SET qty_reserved_milli=0 WHERE id=902`).run();
    await db().prepare(`UPDATE reservations SET status='released' WHERE lot_id=902`).run();
  });

  it("slot_full when capacity is reached", async () => {
    const a = await call("POST", "/api/checkout", checkoutBody({ slotId: 2 }));
    expect(a.status).toBe(201);
    const b = await call("POST", "/api/checkout", checkoutBody({ slotId: 2 }));
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("slot_full");
    // đơn huỷ không chiếm chỗ
    await db().prepare(`UPDATE orders SET status='cancelled' WHERE code=?`).bind(a.body.code).run();
    expect((await call("POST", "/api/checkout", checkoutBody({ slotId: 2 }))).status).toBe(201);
  });

  it("refuses slots past their cutoff", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody({ slotId: 3, slotDate: today() }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("slot_cutoff");
  });

  it("gives 409 insufficient_stock when only closed lots remain", async () => {
    // lô 905 đóng, lô 950 đã giữ hết → không còn tồn khả dụng
    await db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, unit_cost, qty_in_milli, qty_on_hand_milli, qty_reserved_milli) VALUES (950,'SL-950',905,1,?,1,3000,3000,3000)`).bind(new Date().toISOString()).run();
    await db().prepare(`UPDATE lots SET qty_on_hand_milli=0, qty_reserved_milli=0, status='closed' WHERE id=905`).run();
    const r = await call("POST", "/api/checkout", checkoutBody({ items: [{ productId: 905, unit: "kg", qty: 1, expectedUnitPrice: 150000 }] }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("insufficient_stock");
  });
});

describe("transfer payment", () => {
  it("creates awaiting_payment order + intent and a valid VietQR payload", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody({ paymentMethod: "transfer" }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending", paymentMethod: "transfer" });
    const t = r.body.transfer;
    expect(t).toMatchObject({ bankBin: "970436", accountNo: "0123456789", accountName: "HUU MANH", amount: 170000 });
    expect(t.content).toBe(`HM ${r.body.code.replaceAll("-", "")}`);
    expect(t.qrPayload.slice(-8, -4)).toBe("6304");
    expect(t.qrPayload.slice(-4)).toBe(crc16ccitt(t.qrPayload.slice(0, -4)));
    expect(t.qrPayload).toContain("5406170000");
    expect(t.qrPayload).toContain("A000000727");
    const it = await db().prepare(`SELECT * FROM payment_intents WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(r.body.code).first<any>();
    expect(it).toMatchObject({ provider: "vietqr", status: "pending", amount: 170000 });
    const mins = (Date.parse(it.expires_at) - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(28);
    expect(mins).toBeLessThanOrEqual(30);
    // GET /payments/:code/transfer: cần token hoặc phiên khách
    const g = await call("GET", `/api/payments/${r.body.code}/transfer?token=${r.body.trackingToken}`);
    expect(g.status).toBe(200);
    expect(g.body.qrPayload).toBe(t.qrPayload);
    expect((await call("GET", `/api/payments/${r.body.code}/transfer`)).status).toBe(404);
    expect((await call("GET", `/api/payments/${r.body.code}/transfer?token=wrong`)).status).toBe(404);
  });
});

describe("tracking and ownership", () => {
  it("guest tracking needs the token and the correct last 4 phone digits", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody());
    const tok = r.body.trackingToken;
    expect((await call("GET", `/api/orders/track/${tok}?phone4=4567`)).body.code).toBe(r.body.code);
    expect((await call("GET", `/api/orders/track/${tok}?phone4=0000`)).status).toBe(404);
    expect((await call("GET", `/api/orders/track/${tok}`)).status).toBe(404);
    expect((await call("GET", `/api/orders/track/not-a-token?phone4=4567`)).status).toBe(404);
  });

  it("logged-in customer sees only their own orders (404 for others')", async () => {
    const a = await register("a-own@example.com", "Matkhau-123", "0911111111");
    const b = await register("b-own@example.com", "Matkhau-123", "0922222222");
    const oa = await call("POST", "/api/checkout", checkoutBody({ address: { addressId: 0 } }), { headers: a.headers });
    expect(oa.status).toBe(422); // addressId không hợp lệ (0)
    const o1 = await call("POST", "/api/checkout", checkoutBody(), { headers: a.headers });
    expect(o1.status).toBe(201);
    const row = await orderRow(o1.body.code);
    expect(row.shop_account_id).toBe(a.account.id);
    expect((await call("GET", `/api/me/orders/${o1.body.code}`, undefined, { headers: a.headers })).status).toBe(200);
    expect((await call("GET", `/api/me/orders/${o1.body.code}`, undefined, { headers: b.headers })).status).toBe(404);
    expect((await call("POST", `/api/me/orders/${o1.body.code}/cancel`, undefined, { headers: b.headers })).status).toBe(404);
    const list = await call("GET", "/api/me/orders", undefined, { headers: a.headers });
    expect(list.body.map((o: any) => o.code)).toEqual([o1.body.code]);
    expect((await call("GET", "/api/me/orders", undefined, { headers: b.headers })).body).toEqual([]);
    expect((await call("GET", "/api/me/orders")).status).toBe(401);
    // idempotent replay thuộc về chủ đơn: người khác dùng cùng clientUuid bị từ chối
    const steal = await call("POST", "/api/checkout", { ...checkoutBody(), clientUuid: row.client_uuid }, { headers: b.headers });
    expect(steal.status).toBe(409);
  });

  it("logged-in checkout can use a saved address and reorder returns current prices", async () => {
    const a = await register("addr@example.com", "Matkhau-123", "0933333333");
    const ad = await call("POST", "/api/me/addresses", { ...ADDR, label: "Nhà" }, { headers: a.headers });
    expect(ad.status).toBe(201);
    expect(ad.body).toMatchObject({ zoneId: 1, isDefault: true });
    const r = await call("POST", "/api/checkout", checkoutBody({ address: { addressId: ad.body.id } }), { headers: a.headers });
    expect(r.status).toBe(201);
    await db().prepare(`UPDATE prices SET unit_price = 52000 WHERE product_id = 901`).run();
    const re = await call("POST", `/api/me/orders/${r.body.code}/reorder`, undefined, { headers: a.headers });
    await db().prepare(`UPDATE prices SET unit_price = 50000 WHERE product_id = 901`).run();
    expect(re.status).toBe(200);
    expect(re.body.items[0]).toMatchObject({ productId: 901, unit: "kg", qty: 3, unitPrice: 52000 });
  });
});

describe("cancel and weight decision", () => {
  it("customer cancel releases reservations; blocked once past confirmed", async () => {
    const a = await register("cancel@example.com", "Matkhau-123", "0944444444");
    const before = await lot(901);
    const r = await call("POST", "/api/checkout", checkoutBody({ paymentMethod: "transfer" }), { headers: a.headers });
    expect((await lot(901)).r).toBe(before.r + 3000);
    const c = await call("POST", `/api/me/orders/${r.body.code}/cancel`, undefined, { headers: a.headers });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "cancelled", canCancel: false });
    expect(c.body.events.at(-1)).toMatchObject({ status: "cancelled", note: "Khách huỷ đơn" });
    expect((await lot(901)).r).toBe(before.r);
    const o = await orderRow(r.body.code);
    expect(o.cancel_reason).toBe("Khách tự huỷ");
    const it = await db().prepare(`SELECT status FROM payment_intents WHERE order_id=?`).bind(o.id).first<any>();
    expect(it.status).toBe("cancelled");
    expect((await call("POST", `/api/me/orders/${r.body.code}/cancel`, undefined, { headers: a.headers })).status).toBe(409);

    const r2 = await call("POST", "/api/checkout", checkoutBody(), { headers: a.headers });
    await db().prepare(`UPDATE orders SET status='preparing' WHERE code=?`).bind(r2.body.code).run();
    const bad = await call("POST", `/api/me/orders/${r2.body.code}/cancel`, undefined, { headers: a.headers });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("not_cancellable");
  });

  it("paid order cancel keeps payment_status and leaves a refund audit trail", async () => {
    const a = await register("paid@example.com", "Matkhau-123", "0955555555");
    const r = await call("POST", "/api/checkout", checkoutBody(), { headers: a.headers });
    await db().prepare(`UPDATE orders SET payment_status='paid' WHERE code=?`).bind(r.body.code).run();
    const c = await call("POST", `/api/me/orders/${r.body.code}/cancel`, undefined, { headers: a.headers });
    expect(c.body.paymentStatus).toBe("paid");
    const ev = await db().prepare(`SELECT internal_note FROM order_events WHERE order_id=(SELECT id FROM orders WHERE code=?) AND status='cancelled'`).bind(r.body.code).first<any>();
    expect(ev.internal_note).toContain("hoàn tiền");
    expect(JSON.stringify(c.body)).not.toContain("hoàn tiền"); // internal_note không lộ cho khách
  });

  it("EC-03 weight decision: accept continues, reject cancels and releases stock", async () => {
    const mk = async () => {
      const r = await call("POST", "/api/checkout", checkoutBody());
      await db().prepare(`UPDATE orders SET status='preparing', weight_adjust_status='pending_customer' WHERE code=?`).bind(r.body.code).run();
      return r.body;
    };
    const o1 = await mk();
    expect((await call("POST", `/api/orders/track/${o1.trackingToken}/weight-decision`, { accept: true })).status).toBe(404); // thiếu phone4
    const acc = await call("POST", `/api/orders/track/${o1.trackingToken}/weight-decision`, { accept: true, phone4: "4567" });
    expect(acc.status).toBe(200);
    expect(acc.body).toMatchObject({ status: "preparing", weightAdjustStatus: "accepted" });
    expect((await call("POST", `/api/orders/track/${o1.trackingToken}/weight-decision`, { accept: false, phone4: "4567" })).status).toBe(409);

    const before = await lot(901);
    const o2 = await mk();
    expect((await lot(901)).r).toBe(before.r + 3000);
    const rej = await call("POST", `/api/orders/track/${o2.trackingToken}/weight-decision?phone4=4567`, { accept: false });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: "cancelled", weightAdjustStatus: "rejected" });
    expect((await lot(901)).r).toBe(before.r);
  });
});

describe("Turnstile on guest checkout", () => {
  const prod = (over: Record<string, unknown> = {}) => ({ env: { APP_ENV: "production", ...over } });
  const mockVerify = (success: boolean | Error) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (success instanceof Error) throw success;
      return new Response(JSON.stringify({ success }), { status: 200 });
    });

  it("production without secret → 503; with secret but missing/failed token → 403; valid → ok; logged-in skips", async () => {
    expect((await call("POST", "/api/checkout", checkoutBody(), prod())).status).toBe(503);
    const secret = prod({ TURNSTILE_SECRET: "s3cret" });
    expect((await call("POST", "/api/checkout", checkoutBody(), secret)).status).toBe(403); // thiếu token
    const spy = mockVerify(false);
    const f = await call("POST", "/api/checkout", checkoutBody(), { env: secret.env, headers: { "x-turnstile-token": "tok" } });
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe("turnstile_failed");
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    vi.restoreAllMocks();
    mockVerify(new Error("network"));
    expect((await call("POST", "/api/checkout", checkoutBody(), { env: secret.env, headers: { "x-turnstile-token": "tok" } })).status).toBe(403);
    vi.restoreAllMocks();
    mockVerify(true);
    const ok = await call("POST", "/api/checkout", checkoutBody(), { env: secret.env, headers: { "x-turnstile-token": "tok" } });
    expect(ok.status).toBe(201);
  });
});
