import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { vnDate } from "../src/worker/lib/time";

// Báo cáo cuối ngày + tổng kết/lịch sử ca + phiếu bàn giao: số liệu theo hình thức thanh toán khớp đơn/phiếu, phân quyền, phân trang
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uuid = () => `dsr-${++seq}-${crypto.randomUUID()}`;
const sell = async (role: string, lines: { productId: number; qty: number }[], payments: { method: string; amount: number }[]) => {
  const r = await api(role, "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: lines.map((l) => ({ ...l, unit: "kg" })), payments });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const money = (m: any[], k: string) => m.find((x) => x.method === k) ?? { sold: 0, refunded: 0, net: 0 };

let cashierShift: any, managerShift: any, orderA: any;
beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().prepare(`UPDATE lots SET qty_in_milli=500000, qty_on_hand_milli=500000`).run();
  await db().batch([
    db().prepare(`INSERT OR IGNORE INTO funds(id, store_id, code, name, type) VALUES (3,1,'THE','Máy thẻ','card_clearing'),(4,1,'VI','Ví điện tử','ewallet')`),
  ]);
  cashierShift = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 500000 })).body.shift;
  managerShift = (await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift;
  orderA = await sell("cashier", [{ productId: 1, qty: 2 }], [{ method: "cash", amount: 200000 }]); // 200k tiền mặt
  await sell("cashier", [{ productId: 2, qty: 1 }], [{ method: "transfer", amount: 200000 }]); // 200k chuyển khoản
  await sell("cashier", [{ productId: 1, qty: 1 }], [{ method: "cash", amount: 40000 }, { method: "transfer", amount: 60000 }]); // chia
  await sell("cashier", [{ productId: 1, qty: 1 }], [{ method: "card", amount: 100000 }]);
  await sell("manager", [{ productId: 1, qty: 1 }], [{ method: "cash", amount: 100000 }]);
  const ret = await api("cashier", "POST", `${V}/orders/${orderA.id}/return`, { lines: [{ orderLineId: orderA.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "khách trả" }], refundMethod: "cash" });
  expect(ret.status, JSON.stringify(ret.body)).toBe(201);
  // điểm đã đổi (giảm trừ không thu tiền) gắn vào một đơn của ca
  await db().prepare(`INSERT INTO order_discounts(order_id, points_redeemed, amount, description) VALUES (?, 10, 5000, 'Đổi điểm')`).bind(orderA.id).run();
});

describe("Tổng kết ca theo hình thức thanh toán", () => {
  it("khớp đơn/phiếu: bán, hoàn, ròng từng hình thức; công thức tiền mặt", async () => {
    const r = await api("cashier", "GET", `${V}/shifts/${cashierShift.id}/summary`);
    expect(r.status).toBe(200);
    const bp = r.body.byPayment;
    expect(money(bp, "cash")).toMatchObject({ sold: 240000, refunded: 100000, net: 140000 });
    expect(money(bp, "transfer")).toMatchObject({ sold: 260000, refunded: 0, net: 260000 });
    expect(money(bp, "card")).toMatchObject({ sold: 100000, net: 100000 });
    expect(money(bp, "points")).toMatchObject({ sold: 5000 });
    // luôn hiện đủ các hình thức chính (kể cả bằng 0)
    for (const m of ["cash", "transfer", "qr", "card", "ewallet", "points", "voucher", "credit"]) expect(bp.some((x: any) => x.method === m)).toBe(true);
    // đối chiếu trực tiếp với bảng payments
    const sql = await db().prepare(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.shift_id=? AND o.status='completed' AND p.method='cash' AND p.status='confirmed'`).bind(cashierShift.id).first<any>();
    expect(sql.s).toBe(140000);
    expect(r.body.cashFormula).toMatchObject({ opening: 500000, cashSold: 240000, cashRefunded: 100000, expected: 640000 });
    expect(r.body.shift).toMatchObject({ openingCash: 500000, expectedCash: 640000, status: "open", cashierName: "Test cashier" });
    expect(r.body.sales).toMatchObject({ saleCount: 4, saleTotal: 600000, returnCount: 1, returnTotal: 100000, revenue: 500000 });
    expect(r.body.returns).toHaveLength(1);
    expect(r.body.returns[0]).toMatchObject({ total: 100000, methods: ["cash"] });
  });

  it("tiền mặt dự kiến sau khi chốt ca = công thức cũ, phiếu bàn giao có chênh lệch + lý do", async () => {
    const before = (await api("cashier", "GET", `${V}/shifts/${cashierShift.id}/summary`)).body;
    const close = await api("cashier", "POST", `${V}/shifts/${cashierShift.id}/close`, { countedCash: 630000, diffReason: "thiếu tiền lẻ" });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    const after = (await api("cashier", "GET", `${V}/shifts/${cashierShift.id}/summary`)).body;
    expect(after.shift).toMatchObject({ status: "closed", expectedCash: before.cashFormula.expected, countedCash: 630000, diffCash: -10000, diffReason: "thiếu tiền lẻ" });
    expect(after.shift.closedAt).toBeTruthy();
    expect(after.cashFormula.expected).toBe(after.shift.expectedCash);
  });

  it("không lộ giá vốn/lãi gộp trong tổng kết ca", async () => {
    const r = await api("cashier", "GET", `${V}/shifts/${cashierShift.id}/summary`);
    expect(JSON.stringify(r.body)).not.toMatch(/cogs|grossProfit|unit_cost|cost_amount|"cost/i);
  });
});

describe("Lịch sử ca: phân quyền + phân trang", () => {
  beforeAll(async () => {
    // thêm 4 ca đã chốt của quản lý để thử phân trang
    for (let i = 0; i < 4; i++) {
      await db().prepare(`INSERT INTO shifts(store_id, user_id, fund_id, opening_cash, closed_at, expected_cash, counted_cash, diff_cash, status) VALUES (1,2,1,100000,strftime('%Y-%m-%dT%H:%M:%fZ','now'),100000,100000,0,'closed')`).run();
    }
  });

  it("thu ngân chỉ thấy ca của mình; quản lý thấy mọi ca và lọc theo người", async () => {
    const c = await api("cashier", "GET", `${V}/shifts/history`);
    expect(c.status).toBe(200);
    expect(c.body.items.length).toBeGreaterThan(0);
    expect(c.body.items.every((s: any) => s.cashierName === "Test cashier")).toBe(true);
    // thu ngân cố lọc theo người khác vẫn chỉ thấy ca mình
    const c2 = await api("cashier", "GET", `${V}/shifts/history?userId=2`);
    expect(c2.body.items.every((s: any) => s.cashierName === "Test cashier")).toBe(true);
    const m = await api("manager", "GET", `${V}/shifts/history?limit=200`);
    expect(new Set(m.body.items.map((s: any) => s.cashierName))).toEqual(new Set(["Test cashier", "Test manager"]));
    const mu = await api("manager", "GET", `${V}/shifts/history?userId=3&limit=200`);
    expect(mu.body.items.length).toBe(1);
    expect(mu.body.items[0]).toMatchObject({ id: cashierShift.id, status: "closed", saleCount: 4, saleTotal: 600000, returnTotal: 100000, revenue: 500000, diffCash: -10000 });
    // kế toán (reports.view) cũng thấy mọi ca
    expect((await api("accountant", "GET", `${V}/shifts/history?limit=200`)).body.items.length).toBe(m.body.items.length);
  });

  it("thu ngân không xem được chi tiết ca người khác (404); vai trò không liên quan bị chặn (403)", async () => {
    expect((await api("cashier", "GET", `${V}/shifts/${managerShift.id}/summary`)).status).toBe(404);
    expect((await api("manager", "GET", `${V}/shifts/${cashierShift.id}/summary`)).status).toBe(200);
    expect((await api("accountant", "GET", `${V}/shifts/${cashierShift.id}/summary`)).status).toBe(200);
    expect((await api("warehouse", "GET", `${V}/shifts/history`)).status).toBe(403);
    expect((await api("online_staff", "GET", `${V}/shifts/${cashierShift.id}/summary`)).status).toBe(403);
    expect((await api("manager", "GET", `${V}/shifts/999999/summary`)).status).toBe(404);
  });

  it("phân trang {items,nextCursor} không trùng/sót; lọc ngày; kiểm tra tham số", async () => {
    const all = (await api("manager", "GET", `${V}/shifts/history?limit=200`)).body.items.map((s: any) => s.id);
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r: any = await api("manager", "GET", `${V}/shifts/history?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.items.map((s: any) => s.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    const today = vnDate();
    expect((await api("manager", "GET", `${V}/shifts/history?from=${today}&to=${today}&limit=200`)).body.items.length).toBe(all.length);
    expect((await api("manager", "GET", `${V}/shifts/history?from=2020-01-01&to=2020-01-02`)).body.items).toEqual([]);
    expect((await api("manager", "GET", `${V}/shifts/history?from=abc`)).status).toBe(422);
    expect((await api("manager", "GET", `${V}/shifts/history?from=2026-02-01&to=2026-01-01`)).status).toBe(422);
    expect((await api("manager", "GET", `${V}/shifts/history?limit=0`)).status).toBe(422);
  });
});

describe("Báo cáo cuối ngày", () => {
  it("theo hình thức thanh toán, trả hàng, huỷ, thu/chi quỹ; khớp đơn/phiếu", async () => {
    const o = await sell("manager", [{ productId: 1, qty: 1 }], [{ method: "cash", amount: 100000 }]);
    expect((await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "khách đổi ý" })).status).toBe(200);
    const cat = (await db().prepare(`SELECT id FROM cash_categories WHERE code='DIEN_NUOC'`).first<any>()).id;
    expect((await api("accountant", "POST", `${V}/vouchers`, { direction: "out", fundId: 1, categoryId: cat, amount: 300000, note: "Tiền điện" })).status).toBe(201);

    const r = await api("manager", "GET", `${V}/reports/daily?day=${vnDate()}`);
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.saleCount).toBe(5);
    expect(b.saleTotal).toBe(700000);
    expect(b.returnTotal).toBe(100000);
    expect(b.revenue).toBe(600000);
    expect(money(b.byPayment, "cash")).toMatchObject({ sold: 340000, refunded: 100000, net: 240000 });
    expect(money(b.byPayment, "transfer").net).toBe(260000);
    expect(money(b.byPayment, "card").net).toBe(100000);
    // tổng tiền các hình thức (không tính điểm/voucher) = doanh thu thuần
    expect(b.byPayment.filter((p: any) => p.kind === "payment").reduce((s: number, p: any) => s + p.net, 0)).toBe(b.revenue);
    expect(b.returns).toMatchObject({ count: 1, total: 100000, byMethod: [{ method: "cash", amount: 100000 }] });
    expect(b.cancelled).toMatchObject({ count: 1, total: 100000 });
    expect(b.cashFlow.out).toBe(300000);
    expect(b.cashFlow.byCategory.find((x: any) => x.direction === "out").category).toBe("Điện nước");
    expect(b.shifts.length).toBeGreaterThanOrEqual(2);
    // quản lý (có prices.view_cost) thấy giá vốn; tính từ dòng đơn
    expect(typeof b.cogs).toBe("number");
    expect(b.grossProfit).toBe(b.revenue - b.cogs);
  });

  it("phân quyền: thu ngân không xem được báo cáo toàn cửa hàng; ngày sai → 422", async () => {
    expect((await api("cashier", "GET", `${V}/reports/daily`)).status).toBe(403);
    expect((await api("warehouse", "GET", `${V}/reports/daily`)).status).toBe(403);
    expect((await api("accountant", "GET", `${V}/reports/daily`)).status).toBe(200);
    expect((await api("manager", "GET", `${V}/reports/daily?day=2026-13-40`)).status).toBe(422);
    const none = await api("manager", "GET", `${V}/reports/daily?day=2020-01-01`);
    expect(none.body.saleCount).toBe(0);
    expect(none.body.byPayment.every((p: any) => p.sold === 0)).toBe(true);
  });
});
