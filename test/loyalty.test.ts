import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { lotQty, seedSales } from "./seed-sales";

const V = "/api/v1";
const db = () => testEnv.DB;
const line = (productId: number, qty: number) => ({ productId, unit: "kg", qty });
let n = 0;
const uuid = () => `loy-${Date.now()}-${++n}`;
const pts = async (id: number) => (await db().prepare(`SELECT points p FROM customers WHERE id=?`).bind(id).first<{ p: number }>())!.p;
const setPoints = async (id: number, target: number) => {
  const d = target - (await pts(id));
  if (d) expect((await api("manager", "POST", `${V}/customers/${id}/loyalty/adjust`, { points: d, note: "đặt số dư thử nghiệm" })).status).toBe(200);
};
const ledger = async (id: number) => (await api("manager", "GET", `${V}/customers/${id}/loyalty`)).body;

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`INSERT INTO customers(id, code, type, name, customer_group_id) VALUES (21,'KH-L1','retail','Khách điểm',1)`),
    db().prepare(`UPDATE lots SET qty_in_milli=200000, qty_on_hand_milli=200000 WHERE id=1`),
  ]);
  await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 });
});

describe("tích điểm / đổi điểm", () => {
  it("tắt tích điểm: không tích, không đổi được", async () => {
    const r = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, lines: [line(1, 2)], payments: [{ method: "cash", amount: 200000 }] });
    expect(r.status).toBe(201);
    expect(await pts(21)).toBe(0);
    const red = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, redeemPoints: 10, lines: [line(1, 1)], payments: [{ method: "cash", amount: 100000 }] });
    expect(red.status).toBe(422);
    expect(red.body.error.code).toBe("loyalty_disabled");
  });

  it("điều chỉnh điểm: cần quyền loyalty.adjust, không cho âm", async () => {
    await db().prepare(`UPDATE settings SET value='1' WHERE key='loyalty.enabled'`).run();
    expect((await api("cashier", "POST", `${V}/customers/21/loyalty/adjust`, { points: 100, note: "thử" })).status).toBe(403);
    const a = await api("manager", "POST", `${V}/customers/21/loyalty/adjust`, { points: 1000, note: "Tặng điểm khai trương" });
    expect(a.status).toBe(200);
    expect(a.body.points).toBe(1000);
    const neg = await api("manager", "POST", `${V}/customers/21/loyalty/adjust`, { points: -5000, note: "trừ quá" });
    expect(neg.status).toBe(409);
    expect(neg.body.error.code).toBe("points_insufficient");
    const l = await ledger(21);
    expect(l.points).toBe(1000);
    expect(l.ledger[0]).toMatchObject({ kind: "adjust", points: 1000 });
  });

  it("tích điểm theo tiền thực trả (1 điểm / 10.000đ)", async () => {
    const r = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, lines: [line(1, 2)], payments: [{ method: "cash", amount: 200000 }] });
    expect(r.status).toBe(201);
    expect(await pts(21)).toBe(1020); // +20 điểm
    const l = await ledger(21);
    expect(l.ledger[0]).toMatchObject({ kind: "earn", points: 20, orderId: r.body.id });
  });

  it("đổi điểm: trừ vào đơn, ghi sổ, rồi tích điểm theo phần còn lại; thu ngân thấy số dư", async () => {
    const r = await api("cashier", "POST", `${V}/pos/orders`, {
      clientUuid: uuid(), customerId: 21, redeemPoints: 500, lines: [line(1, 2)], payments: [{ method: "cash", amount: 150000 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(150000); // 500 điểm × 100đ = 50.000đ
    expect(r.body.discount).toBe(50000);
    expect(r.body.discounts.find((d: any) => d.points_redeemed)).toMatchObject({ points_redeemed: 500, amount: 50000 });
    // 1020 − 500 + floor(150000/10000)=15
    expect(await pts(21)).toBe(535);
    const l = await ledger(21);
    expect(l.ledger.slice(0, 2).map((x: any) => [x.kind, x.points])).toEqual([["earn", 15], ["redeem", -500]]);
    expect((await api("cashier", "GET", `${V}/customers/21/loyalty`)).status).toBe(200);
    expect((await api("warehouse", "GET", `${V}/customers/21/loyalty`)).status).toBe(200); // có b2b.view
    expect((await api("online_staff", "GET", `${V}/customers/21/loyalty`)).status).toBe(200);
    expect((await api("accountant", "GET", `${V}/customers/21/loyalty`)).status).toBe(200);
  });

  it("giới hạn đổi tối đa 50% giá trị đơn; không đủ điểm → 409", async () => {
    const tooHigh = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, redeemPoints: 1001, lines: [line(1, 2)], payments: [{ method: "cash", amount: 100000 }] });
    expect(tooHigh.status).toBe(422);
    expect(tooHigh.body.error.code).toBe("redeem_too_high");
    expect(tooHigh.body.error.details.maxPoints).toBe(800); // 50% = 1000 điểm nhưng sàn giá vốn (Táo vốn 60k) chỉ cho giảm tối đa 80.000đ
    await setPoints(21, 35);
    const before = await lotQty(1);
    const poor = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, redeemPoints: 400, lines: [line(1, 2)], payments: [{ method: "cash", amount: 160000 }] });
    expect(poor.status).toBe(409);
    expect(poor.body.error.code).toBe("points_insufficient");
    expect(await lotQty(1)).toBe(before);
    expect(await pts(21)).toBe(35);
    const noCustomer = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), redeemPoints: 10, lines: [line(1, 1)], payments: [{ method: "cash", amount: 100000 }] });
    expect(noCustomer.status).toBe(422);
    expect(noCustomer.body.error.code).toBe("customer_required");
  });

  it("hai đơn đổi điểm đồng thời: trigger chặn âm → một đơn 409 points_insufficient", async () => {
    await setPoints(21, 500);
    const mk = () => api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, redeemPoints: 400, lines: [line(1, 2)], payments: [{ method: "cash", amount: 160000 }] });
    const res = await Promise.all([mk(), mk()]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(res.find((x) => x.status === 409)!.body.error.code).toBe("points_insufficient");
    // 500 − 400 + floor(160000/10000)=16
    expect(await pts(21)).toBe(116);
  });

  it("trả hàng: thu hồi điểm tích theo tỉ lệ; trả hết → hoàn điểm đã đổi", async () => {
    await setPoints(21, 500);
    const o = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, redeemPoints: 100, lines: [line(1, 4)], payments: [{ method: "cash", amount: 390000 }] });
    expect(o.status).toBe(201);
    // 500 − 100 + 39
    expect(await pts(21)).toBe(439);
    const half = await api("cashier", "POST", `${V}/orders/${o.body.id}/return`, {
      lines: [{ orderLineId: o.body.lines[0].id, qty: 2, unit: "kg", restock: true, reason: "dư" }], refundMethod: "cash",
    });
    expect(half.status).toBe(201);
    expect(half.body.total).toBe(195000);
    // thu hồi floor(39 × 195000/390000) = 19 điểm; chưa hoàn điểm đã đổi
    expect(await pts(21)).toBe(420);
    const rest = await api("cashier", "POST", `${V}/orders/${o.body.id}/return`, {
      lines: [{ orderLineId: o.body.lines[0].id, qty: 2, unit: "kg", restock: true, reason: "dư" }], refundMethod: "cash",
    });
    expect(rest.status).toBe(201);
    // thu hồi nốt 20 điểm, hoàn 100 điểm đã đổi → về 500
    expect(await pts(21)).toBe(500);
    const kinds = (await ledger(21)).ledger.filter((x: any) => x.orderId === o.body.id).map((x: any) => [x.kind, x.points]);
    expect(kinds).toEqual(expect.arrayContaining([["earn", 39], ["redeem", -100], ["reverse", -19], ["reverse", -20], ["reverse", 100]]));
  });

  it("huỷ đơn: thu hồi điểm tích, hoàn điểm đã đổi; sổ điểm bất biến", async () => {
    const before = await pts(21);
    const o = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), customerId: 21, redeemPoints: 50, lines: [line(1, 2)], payments: [{ method: "cash", amount: 200000 }] });
    expect(o.status).toBe(201);
    expect(await pts(21)).toBe(before - 50 + 19);
    const v = await api("manager", "POST", `${V}/orders/${o.body.id}/void`, { reason: "khách đổi ý" });
    expect(v.status).toBe(200);
    expect(await pts(21)).toBe(before);
    await expect(db().prepare(`UPDATE loyalty_ledger SET points = 0`).run()).rejects.toThrow();
    await expect(db().prepare(`DELETE FROM loyalty_ledger`).run()).rejects.toThrow();
  });
});
