import { beforeAll, describe, expect, it } from "vitest";
import { api } from "./helpers";
import { call, checkoutBody, register, seedShop, testEnv } from "./shop-helpers";

const db = () => testEnv.DB;
let n = 0;
const cart = [{ productId: 901, unit: "kg", qty: 3 }]; // 150.000 + phí giao 20.000; giá vốn 30.000/kg → trần theo giá vốn 60.000đ
const quoteBody = (extra: Record<string, unknown> = {}) => ({ items: cart, district: "Quận 1", ...extra });

/** Tài khoản bán lẻ có sẵn `points` điểm (ghi sổ điều chỉnh như ERP). */
async function member(points: number) {
  const email = `loy${++n}-${Date.now()}@example.com`;
  const s = await register(email);
  const row = (await db().prepare(`SELECT customer_id id FROM shop_accounts WHERE email=?`).bind(email).first<{ id: number }>())!;
  if (points)
    await db().batch([
      db().prepare(`INSERT INTO loyalty_ledger(customer_id, kind, points, note) VALUES (?, 'adjust', ?, 'seed')`).bind(row.id, points),
      db().prepare(`UPDATE customers SET points = points + ? WHERE id = ?`).bind(points, row.id),
    ]);
  return { ...s, customerId: row.id };
}
const bal = async (id: number) => (await db().prepare(`SELECT points p FROM customers WHERE id=?`).bind(id).first<{ p: number }>())!.p;
const ledger = async (orderCode: string) =>
  (await db().prepare(`SELECT kind, points FROM loyalty_ledger WHERE order_id=(SELECT id FROM orders WHERE code=?) ORDER BY id`).bind(orderCode).all<{ kind: string; points: number }>()).results;
const orderId = async (code: string) => (await db().prepare(`SELECT id FROM orders WHERE code=?`).bind(code).first<{ id: number }>())!.id;
const post = (oid: number, action: string, body: unknown = {}) => api("owner", "POST", `/api/v1/online-orders/${oid}/${action}`, body);
const setLoyalty = (v: string) => db().prepare(`UPDATE settings SET value=? WHERE key='loyalty.enabled'`).bind(v).run();

beforeAll(async () => {
  await seedShop();
  await db().prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-LY','Chờ đối soát COD','cod_clearing')`).run();
  await setLoyalty("1");
});

describe("website: đổi điểm", () => {
  it("/api/me trả points + pointValueVnd khi bật tích điểm, ẩn khi tắt", async () => {
    const m = await member(250);
    const r = await call("GET", "/api/me", undefined, { headers: m.headers });
    expect(r.body).toMatchObject({ points: 250, pointValueVnd: 100 });
    await setLoyalty("0");
    const off = await call("GET", "/api/me", undefined, { headers: m.headers });
    await setLoyalty("1");
    expect(off.body.points).toBeUndefined();
  });

  it("khách vãng lai gửi redeemPoints → 422 login_required (quote và checkout)", async () => {
    const q = await call("POST", "/api/cart/quote", quoteBody({ redeemPoints: 10 }));
    expect(q.status).toBe(422);
    expect(q.body.error.code).toBe("login_required");
    const c = await call("POST", "/api/checkout", checkoutBody({ redeemPoints: 10 }));
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe("login_required");
  });

  it("quote: trả pointsRedeemed/pointsAmount, tổng đã trừ; pointsMax kẹp theo giá vốn (600 điểm)", async () => {
    const m = await member(1000);
    const q = await call("POST", "/api/cart/quote", quoteBody({ redeemPoints: 100 }), { headers: m.headers });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ subtotal: 150000, pointsRedeemed: 100, pointsAmount: 10000, shippingFee: 20000, total: 160000, pointsMax: 600, pointsBalance: 1000 });
    expect(await bal(m.customerId)).toBe(1000); // quote không trừ điểm
    const none = await call("POST", "/api/cart/quote", quoteBody(), { headers: m.headers });
    expect(none.body).toMatchObject({ pointsRedeemed: 0, pointsAmount: 0, total: 170000 });
  });

  it("vượt trần (giá vốn / %) → 422 redeem_too_high; vượt số dư → 409 points_insufficient", async () => {
    const m = await member(1000);
    const hi = await call("POST", "/api/cart/quote", quoteBody({ redeemPoints: 601 }), { headers: m.headers });
    expect(hi.status).toBe(422);
    expect(hi.body.error.code).toBe("redeem_too_high");
    const poor = await member(50);
    const q = await call("POST", "/api/cart/quote", quoteBody({ redeemPoints: 100 }), { headers: poor.headers });
    expect(q.status).toBe(409);
    expect(q.body.error.code).toBe("points_insufficient");
    const c = await call("POST", "/api/checkout", checkoutBody({ redeemPoints: 100 }), { headers: poor.headers });
    expect(c.status).toBe(409);
    expect(await bal(poor.customerId)).toBe(50);
  });

  it("tài khoản sỉ không đổi điểm; tắt tích điểm → 422 loyalty_disabled", async () => {
    const m = await member(500);
    await setLoyalty("0");
    const r = await call("POST", "/api/cart/quote", quoteBody({ redeemPoints: 10 }), { headers: m.headers });
    await setLoyalty("1");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("loyalty_disabled");
  });

  it("checkout: ghi sổ redeem + trừ số dư cùng batch với đơn, giảm vào đơn, OrderView có pointsRedeemed", async () => {
    const m = await member(1000);
    const r = await call("POST", "/api/checkout", checkoutBody({ redeemPoints: 100 }), { headers: m.headers });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ subtotal: 150000, discount: 10000, shippingFee: 20000, total: 160000, pointsRedeemed: 100, pointsAmount: 10000, pointsEarned: 0 });
    expect(r.body.pointsEarnable).toBe(14); // (160000-20000)/10000, sẽ tích khi hoàn tất
    expect(await bal(m.customerId)).toBe(900);
    expect(await ledger(r.body.code)).toEqual([{ kind: "redeem", points: -100 }]);
    const d = await db().prepare(`SELECT points_redeemed p, amount a FROM order_discounts WHERE order_id=? AND points_redeemed IS NOT NULL`).bind(await orderId(r.body.code)).first<any>();
    expect(d).toEqual({ p: 100, a: 10000 });
  });

  it("đồng thời: hai checkout cùng đổi 100 điểm khi chỉ có 150 → đúng một đơn thành công, số dư không âm", async () => {
    const m = await member(150);
    const [a, b] = await Promise.all([
      call("POST", "/api/checkout", checkoutBody({ redeemPoints: 100 }), { headers: m.headers }),
      call("POST", "/api/checkout", checkoutBody({ redeemPoints: 100 }), { headers: m.headers }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const bad = a.status === 409 ? a : b;
    expect(bad.body.error.code).toBe("points_insufficient");
    expect(await bal(m.customerId)).toBe(50);
    const rows = await db().prepare(`SELECT COUNT(*) n FROM loyalty_ledger WHERE customer_id=? AND kind='redeem'`).bind(m.customerId).first<any>();
    expect(rows.n).toBe(1);
    const orders = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE customer_id=?`).bind(m.customerId).first<any>();
    expect(orders.n).toBe(1); // đơn thất bại đã rollback hoàn toàn
  });
});

describe("website: tích điểm khi hoàn tất, hoàn/thu hồi khi huỷ/trả", () => {
  const flow = async (oid: number) => {
    for (const a of ["confirm", "prepare", "ship"]) expect((await post(oid, a)).status).toBe(200);
  };

  it("chỉ tích khi giao xong (không tích lúc checkout): theo tiền thực trả, không tính phí giao", async () => {
    const m = await member(1000);
    const r = await call("POST", "/api/checkout", checkoutBody({ redeemPoints: 100 }), { headers: m.headers });
    const oid = await orderId(r.body.code);
    await flow(oid);
    expect(await bal(m.customerId)).toBe(900); // chưa tích
    const dl = await post(oid, "deliver"); expect(dl.body?.error, JSON.stringify(dl.body)).toBeUndefined();
    expect(await ledger(r.body.code)).toEqual([{ kind: "redeem", points: -100 }, { kind: "earn", points: 14 }]);
    expect(await bal(m.customerId)).toBe(914);
    const v = await call("GET", `/api/me/orders/${r.body.code}`, undefined, { headers: m.headers });
    expect(v.body).toMatchObject({ pointsEarned: 14, pointsRedeemed: 100, pointsEarnable: 0 });
  });

  it("khách vãng lai không được tích điểm khi giao", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody());
    const oid = await orderId(r.body.code);
    await flow(oid);
    await post(oid, "deliver");
    expect(await ledger(r.body.code)).toEqual([]);
  });

  it("khách tự huỷ đơn chưa giao → hoàn điểm đã đổi (idempotent theo sổ)", async () => {
    const m = await member(500);
    const r = await call("POST", "/api/checkout", checkoutBody({ redeemPoints: 200 }), { headers: m.headers });
    expect(await bal(m.customerId)).toBe(300);
    const c = await call("POST", `/api/me/orders/${r.body.code}/cancel`, {}, { headers: m.headers });
    expect(c.status).toBe(200);
    expect(await bal(m.customerId)).toBe(500);
    expect(await ledger(r.body.code)).toEqual([{ kind: "redeem", points: -200 }, { kind: "reverse", points: 200 }]);
  });

  it("NV huỷ đơn đang chuẩn bị → hoàn điểm đã đổi", async () => {
    const m = await member(500);
    const r = await call("POST", "/api/checkout", checkoutBody({ redeemPoints: 100 }), { headers: m.headers });
    const oid = await orderId(r.body.code);
    await post(oid, "confirm");
    expect((await post(oid, "cancel", { reason: "Hết hàng" })).status).toBe(200);
    expect(await bal(m.customerId)).toBe(500);
  });

  it("trả hàng sau khi giao → hoàn điểm đã đổi và thu hồi điểm đã tích", async () => {
    const m = await member(1000);
    const r = await call("POST", "/api/checkout", checkoutBody({ redeemPoints: 100 }), { headers: m.headers });
    const oid = await orderId(r.body.code);
    await flow(oid);
    await post(oid, "deliver");
    expect(await bal(m.customerId)).toBe(914);
    expect((await post(oid, "return-to-stock", { lines: [] })).status).toBe(200);
    expect(await bal(m.customerId)).toBe(1000);
    expect(await ledger(r.body.code)).toEqual([
      { kind: "redeem", points: -100 }, { kind: "earn", points: 14 }, { kind: "reverse", points: 100 }, { kind: "reverse", points: -14 },
    ]);
  });

  it("thu hồi điểm tích bị kẹp theo số dư hiện có (không âm)", async () => {
    const m = await member(0);
    const r = await call("POST", "/api/checkout", checkoutBody(), { headers: m.headers });
    const oid = await orderId(r.body.code);
    await flow(oid);
    await post(oid, "deliver");
    expect(await bal(m.customerId)).toBe(15); // (170000-20000)/10000
    await db().batch([
      db().prepare(`INSERT INTO loyalty_ledger(customer_id, kind, points, note) VALUES (?, 'adjust', -10, 'đã tiêu')`).bind(m.customerId),
      db().prepare(`UPDATE customers SET points = points - 10 WHERE id = ?`).bind(m.customerId),
    ]);
    expect((await post(oid, "return-to-stock", { lines: [] })).status).toBe(200);
    expect(await bal(m.customerId)).toBe(0);
    expect((await ledger(r.body.code)).at(-1)).toEqual({ kind: "reverse", points: -5 });
  });
});
