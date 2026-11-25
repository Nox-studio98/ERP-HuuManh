import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales, lotQty } from "./seed-sales";

// Đợt fix 6a — A-13: Đổi hàng tại quầy (trả một phần + bán mới trong MỘT batch, tiền chênh vào ca đang mở)
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uuid = () => `f6a-${++seq}-${crypto.randomUUID()}`;
const sell = async (role: string, qty: number, productId = 1) => {
  const r = await api(role, "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [{ productId, unit: "kg", qty }], payments: [{ method: "cash", amount: qty * (productId === 1 ? 100000 : 200000) }] });
  expect(r.status).toBe(201);
  return r.body;
};
const exch = (role: string, o: any, over: Record<string, unknown> = {}) =>
  api(role, "POST", `${V}/orders/${o.id}/exchange`, {
    clientUuid: uuid(),
    returnLines: [{ orderLineId: o.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "khách đổi loại" }],
    newLines: [{ productId: 2, unit: "kg", qty: 1 }],
    refundMethod: "cash",
    payments: [{ method: "cash", amount: 100000 }],
    ...over,
  });
const shiftCash = async (shiftId: number) =>
  (await db().prepare(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.shift_id=? AND o.status='completed' AND p.method='cash' AND p.status='confirmed'`).bind(shiftId).first<any>()).s as number;
const orderCount = async () => (await db().prepare(`SELECT COUNT(*) n FROM orders WHERE status='completed'`).first<any>()).n as number;

let cashierShift: any;
beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().prepare(`UPDATE lots SET qty_in_milli=500000, qty_on_hand_milli=500000`).run();
  cashierShift = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift;
  expect((await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 })).status).toBe(201);
});

describe("A-13: đổi hàng — chênh lệch, tồn, ca", () => {
  it("khách trả thêm: nhập lại đúng lô, xuất hàng mới, liên kết đơn gốc, tiền vào ca đang mở", async () => {
    const o = await sell("cashier", 2); // 200k
    const t0 = await lotQty(1), n0 = await lotQty(2);
    const cash0 = await shiftCash(cashierShift.id);
    const r = await exch("cashier", o); // trả 1kg táo 100k, lấy 1kg nho 200k → khách trả thêm 100k
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ net: 100000, change: 0, returnTotal: 100000, newTotal: 200000 });
    expect(r.body.sale).toMatchObject({ kind: "sale", status: "completed", total: 200000, paid_total: 200000, exchange_of_order_id: o.id, shift_id: cashierShift.id });
    expect(r.body.return).toMatchObject({ kind: "return", status: "completed", total: 100000, original_order_id: o.id });
    expect(r.body.sale.exchange_return_order_id).toBe(r.body.return.id);
    expect(r.body.sale.exchange).toMatchObject({ role: "new_sale", linkedId: o.id });
    expect(r.body.return.exchange).toMatchObject({ role: "return", linkedId: r.body.sale.id });
    expect(await lotQty(1)).toBe(t0 + 1000); // trả về đúng lô táo
    expect(await lotQty(2)).toBe(n0 - 1000);
    const back = await db().prepare(`SELECT lot_id, qty_milli FROM order_line_lots WHERE order_line_id = ?`).bind(r.body.return.lines[0].id).all<any>();
    expect(back.results).toEqual([{ lot_id: 1, qty_milli: 1000 }]);
    expect(await shiftCash(cashierShift.id)).toBe(cash0 + 100000); // chỉ phần chênh vào két
    const a = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action IN ('order.exchange','order.return') AND entity_id IN (?,?)`).bind(String(r.body.sale.id), String(r.body.return.id)).first<any>();
    expect(a.n).toBe(2);
  });

  it("thối tiền mặt khi khách đưa dư; hoàn lại khách khi hàng mới rẻ hơn", async () => {
    const o = await sell("cashier", 2);
    const cash0 = await shiftCash(cashierShift.id);
    const change = await exch("cashier", o, { payments: [{ method: "cash", amount: 150000 }] });
    expect(change.status).toBe(201);
    expect(change.body).toMatchObject({ net: 100000, change: 50000 });
    expect(await shiftCash(cashierShift.id)).toBe(cash0 + 100000);
    // trả 2kg táo (200k) lấy 1kg táo (100k) → hoàn 100k
    const o2 = await sell("cashier", 2);
    const cash1 = await shiftCash(cashierShift.id);
    const down = await exch("cashier", o2, {
      returnLines: [{ orderLineId: o2.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "đổi cỡ" }],
      newLines: [{ productId: 1, unit: "kg", qty: 0.5 }],
      payments: [],
    });
    expect(down.status).toBe(201);
    expect(down.body).toMatchObject({ net: -50000, returnTotal: 100000, newTotal: 50000 });
    expect(await shiftCash(cashierShift.id)).toBe(cash1 - 50000); // hoàn 50k từ két ca đang mở
    const extra = await exch("cashier", o2, { newLines: [{ productId: 1, unit: "kg", qty: 0.5 }], payments: [{ method: "cash", amount: 1 }] });
    expect(extra.body.error.code).toBe("payment_not_needed");
  });
});

describe("A-13: đổi hàng — kiểm tra đầu vào và nguyên tử", () => {
  it("khách chưa trả đủ chênh lệch: 422, không ghi gì", async () => {
    const o = await sell("cashier", 2);
    const t0 = await lotQty(1), n0 = await lotQty(2), c0 = await orderCount();
    const r = await exch("cashier", o, { payments: [{ method: "cash", amount: 50000 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("payment_mismatch");
    expect(await lotQty(1)).toBe(t0);
    expect(await lotQty(2)).toBe(n0);
    expect(await orderCount()).toBe(c0);
  });

  it("hàng mới không đủ tồn: cả đổi hàng thất bại, phần trả không được nhập kho, không còn phiếu trả hoàn tất", async () => {
    const o = await sell("cashier", 2);
    await db().prepare(`UPDATE lots SET qty_on_hand_milli=300 WHERE id=2`).run();
    const t0 = await lotQty(1), c0 = await orderCount();
    const r = await exch("cashier", o, { newLines: [{ productId: 2, unit: "kg", qty: 1 }] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await lotQty(1)).toBe(t0);
    expect(await orderCount()).toBe(c0);
    const ret = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE original_order_id=? AND kind='return' AND status='completed'`).bind(o.id).first<any>();
    expect(ret.n).toBe(0);
    await db().prepare(`UPDATE lots SET qty_on_hand_milli=500000 WHERE id=2`).run();
  });

  it("trả vượt số đã mua bị chặn; clientUuid lặp lại trả lại đúng đơn cũ, không nhân đôi", async () => {
    const o = await sell("cashier", 2);
    const bad = await exch("cashier", o, { returnLines: [{ orderLineId: o.lines[0].id, qty: 3, unit: "kg", restock: true, reason: "thử" }] });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("return_exceeds_sold");
    const id = uuid();
    const t0 = await lotQty(1);
    const a = await exch("cashier", o, { clientUuid: id });
    const b = await exch("cashier", o, { clientUuid: id });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.sale.id).toBe(a.body.sale.id);
    expect(await lotQty(1)).toBe(t0 + 1000);
  });

  it("hai lần đổi đồng thời cùng một dòng (trả hết): chỉ một lần thành công, tồn chỉ đổi một lần", async () => {
    const o = await sell("cashier", 1);
    const t0 = await lotQty(1);
    const mk = () =>
      exch("cashier", o, {
        returnLines: [{ orderLineId: o.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "trùng" }],
        newLines: [{ productId: 1, unit: "kg", qty: 1 }],
        payments: [],
      });
    const res = await Promise.all([mk(), mk()]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    // trả 1kg táo (về +1000) và bán 1kg táo mới (-1000): tồn táo ròng không đổi; chỉ một phiếu trả
    expect(await lotQty(1)).toBe(t0);
    const ret = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE original_order_id=? AND kind='return' AND status='completed'`).bind(o.id).first<any>();
    expect(ret.n).toBe(1);
  });

  it("không có ca đang mở: 409 no_open_shift", async () => {
    const o = await sell("cashier", 1);
    const r = await exch("owner", o);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("no_open_shift");
  });

  it("quyền: kế toán/kho không đổi hàng được; đơn không phải POS bị từ chối", async () => {
    const o = await sell("cashier", 1);
    expect((await exch("accountant", o)).status).toBe(403);
    expect((await exch("warehouse", o)).status).toBe(403);
    await db().prepare(`UPDATE orders SET channel='online' WHERE id=?`).bind(o.id).run();
    const r = await exch("cashier", o);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("wrong_channel");
    await db().prepare(`UPDATE orders SET channel='pos' WHERE id=?`).bind(o.id).run();
  });

  it("giá vốn không lộ cho thu ngân trong phản hồi", async () => {
    const o = await sell("cashier", 1);
    const r = await exch("cashier", o);
    expect(r.status).toBe(201);
    expect(r.body.sale.cost_total).toBeUndefined();
    expect(r.body.sale.lines[0].cost_amount).toBeUndefined();
  });
});

describe("A-13: đổi hàng — ngưỡng duyệt như trả hàng (A-16)", () => {
  it("không nhập lại kho: thu ngân cần duyệt; duyệt gắn đúng hàng mới, dùng một lần; quản lý tự làm", async () => {
    const o = await sell("cashier", 2);
    const noRestock = { returnLines: [{ orderLineId: o.lines[0].id, qty: 1, unit: "kg", restock: false, reason: "dập nát" }] };
    const first = await exch("cashier", o, noRestock);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe("approval_required");
    expect(first.body.error.details.reasons).toContain("no_restock");
    const aid = first.body.error.details.approvalId;
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    // duyệt gắn với giỏ hàng mới: đổi sang hàng khác thì không dùng được
    const other = await exch("cashier", o, { ...noRestock, newLines: [{ productId: 2, unit: "kg", qty: 2 }], payments: [{ method: "cash", amount: 300000 }], approvalId: aid });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("approval_invalid");
    const t0 = await lotQty(1);
    const ok = await exch("cashier", o, { ...noRestock, approvalId: aid });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await lotQty(1)).toBe(t0); // không nhập lại kho
    const reuse = await exch("cashier", o, { ...noRestock, approvalId: aid });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("approval_invalid");
    // quản lý tự đổi hàng không nhập lại kho, không cần duyệt
    const o2 = await sell("manager", 1);
    expect((await exch("manager", o2, { returnLines: [{ orderLineId: o2.lines[0].id, qty: 1, unit: "kg", restock: false, reason: "hỏng" }] })).status).toBe(201);
  });

  it("giá trị trả từ ngưỡng cần duyệt; đơn của ca đã chốt cần duyệt, quản lý đổi được và tiền vào ca đang mở của quản lý", async () => {
    const big = await sell("cashier", 6); // 600k ≥ 500k
    const r = await exch("cashier", big, { returnLines: [{ orderLineId: big.lines[0].id, qty: 6, unit: "kg", restock: true, reason: "đổi hết" }], newLines: [{ productId: 1, unit: "kg", qty: 6 }], payments: [] });
    expect(r.status).toBe(409);
    expect(r.body.error.details.reasons).toContain("high_value");
    // đơn của ca cũ: chốt ca thu ngân, mở ca mới
    const old = await sell("cashier", 1);
    expect((await api("cashier", "POST", `${V}/shifts/${cashierShift.id}/close`, { countedCash: 1_000_000_000, diffReason: "test" })).status).toBe(200);
    const ns = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift;
    const c = await exch("cashier", old);
    expect(c.status).toBe(409);
    expect(c.body.error.details.reasons).toContain("other_shift");
    const mgrShift = (await api("manager", "GET", `${V}/shifts/current`)).body.shift;
    const cash0 = await shiftCash(mgrShift.id);
    const m = await exch("manager", old);
    expect(m.status).toBe(201);
    expect(m.body.sale.shift_id).toBe(mgrShift.id);
    expect(await shiftCash(mgrShift.id)).toBe(cash0 + 100000);
    expect(await shiftCash(ns.id)).toBe(0); // ca mới của thu ngân không bị ảnh hưởng
  });
});
