import { beforeAll, describe, expect, it } from "vitest";
import { api, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { vnDate } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uid = () => `uuid-chg-${Date.now()}-${++seq}`;
const line = (qty: number) => ({ productId: 1, unit: "kg", qty }); // Táo 100.000đ/kg
const sell = (role: string, body: any) => api(role, "POST", `${V}/pos/orders`, { clientUuid: uid(), lines: [line(2)], ...body });
let cashierShift: number;

beforeAll(async () => {
  const { seedBase } = await import("./helpers");
  await seedBase();
  await seedSales();
  await db().prepare(`UPDATE lots SET qty_in_milli = 500000, qty_on_hand_milli = 500000 WHERE id = 1`).run();
  cashierShift = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift.id;
  await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 });
});

describe("B2: loại thu khác", () => {
  it("có sẵn 3 loại mặc định; thu ngân xem được, chỉ chủ sửa", async () => {
    const list = await api("cashier", "GET", `${V}/charge-types`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: any) => x.code)).toEqual(["PHI_DONG_GOI", "PHI_GIAO_HANG", "PHI_GIO_QUA"]);
    expect((await api("cashier", "POST", `${V}/charge-types`, { code: "PHI_X", name: "X" })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/charge-types`, { code: "PHI_X", name: "X" })).status).toBe(403);
    const c = await api("owner", "POST", `${V}/charge-types`, { code: "phi_tem", name: "Phí tem nhãn", defaultAmount: 2000 });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: "PHI_TEM", name: "Phí tem nhãn", defaultAmount: 2000, active: true, version: 1 });
    expect((await api("owner", "POST", `${V}/charge-types`, { code: "PHI_TEM", name: "Trùng" })).body.error.code).toBe("code_duplicate");
    const p = await api("owner", "PATCH", `${V}/charge-types/${c.body.id}`, { version: 1, defaultAmount: 3000, active: false });
    expect(p.body).toMatchObject({ defaultAmount: 3000, active: false, version: 2 });
    expect((await api("owner", "PATCH", `${V}/charge-types/${c.body.id}`, { version: 1, name: "cũ" })).body.error.code).toBe("version_conflict");
    expect((await api("cashier", "GET", `${V}/charge-types`)).body.items.some((x: any) => x.code === "PHI_TEM")).toBe(false); // đã ngừng → ẩn
    expect((await api("owner", "GET", `${V}/charge-types?all=1`)).body.items.some((x: any) => x.code === "PHI_TEM")).toBe(true);
  });
});

describe("B2: thu khác trên đơn", () => {
  it("tổng đơn = hàng − giảm giá + thu khác; thanh toán phải đủ cả phần thu khác", async () => {
    const short = await sell("cashier", { charges: [{ chargeTypeId: 901, amount: 5000 }], payments: [{ method: "cash", amount: 200000 }] });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe("payment_mismatch");
    expect(short.body.error.details.total).toBe(205000);
    const r = await sell("cashier", { charges: [{ chargeTypeId: 901, amount: 5000 }, { chargeTypeId: 903, amount: 30000 }], payments: [{ method: "cash", amount: 240000 }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ subtotal: 200000, discount: 0, total: 235000, charges_total: 35000, paid_total: 235000, change: 5000 });
    expect(r.body.charges.map((x: any) => [x.name, x.amount, x.refunded_amount])).toEqual([["Phí đóng gói", 5000, 0], ["Phí giỏ quà", 30000, 0]]);
    const rc = await api("cashier", "GET", `${V}/pos/receipt/${r.body.id}`);
    expect(rc.body.charges).toEqual([{ name: "Phí đóng gói", amount: 5000 }, { name: "Phí giỏ quà", amount: 30000 }]);
    expect(rc.body.total).toBe(235000);
  });

  it("không bị giảm giá cả đơn / điểm: giảm giá chỉ tính trên hàng, không tích điểm trên thu khác", async () => {
    await db().prepare(`UPDATE settings SET value='1' WHERE key='loyalty.enabled'`).run();
    await db().prepare(`UPDATE settings SET value='1000' WHERE key='loyalty.earn_per_vnd'`).run();
    const cu = (await db().prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id) VALUES ('KL-C1','retail','Khách tích điểm','0911111111',1) RETURNING id`).first<{ id: number }>())!.id;
    const r = await sell("manager", { customerId: cu, discount: 10000, overrideReason: "khách quen", charges: [{ chargeTypeId: 902, amount: 20000 }], payments: [{ method: "cash", amount: 210000 }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ subtotal: 200000, discount: 10000, total: 210000, charges_total: 20000 });
    expect(r.body.discounts).toEqual([]); // không có khuyến mãi/voucher/điểm nào áp lên thu khác
    // tích điểm theo tiền HÀNG sau giảm (190.000 → 190 điểm), không theo 210.000
    expect((await db().prepare(`SELECT points FROM customers WHERE id = ?`).bind(cu).first<any>()).points).toBe(190);
  });

  it("nhập tay cần quyền pos.other_charge; sửa số tiền loại có mặc định cũng vậy; loại ngừng/không có bị từ chối", async () => {
    const a = await sell("cashier", { charges: [{ name: "Phí lạ", amount: 7000 }], payments: [{ method: "cash", amount: 207000 }] });
    expect(a.status).toBe(403);
    const b = await sell("cashier", { charges: [{ chargeTypeId: 901, amount: 9000 }], payments: [{ method: "cash", amount: 209000 }] });
    expect(b.status).toBe(403);
    const c = await sell("manager", { charges: [{ name: "Phí lạ", amount: 7000 }, { chargeTypeId: 901, amount: 9000 }], payments: [{ method: "cash", amount: 216000 }] });
    expect(c.status).toBe(201);
    expect(c.body.charges.map((x: any) => x.name)).toEqual(["Phí lạ", "Phí đóng gói"]);
    expect((await sell("manager", { charges: [{ chargeTypeId: 99999, amount: 1000 }], payments: [{ method: "cash", amount: 201000 }] })).body.error.code).toBe("charge_type_not_found");
    expect((await sell("manager", { charges: [{ amount: 1000 }], payments: [{ method: "cash", amount: 201000 }] })).body.error.code).toBe("charge_name_required");
  });
});

describe("B2: báo cáo tách dòng Thu khác", () => {
  it("báo cáo cuối ngày + lãi lỗ: Thu khác nằm trong doanh thu và tách riêng, tổng breakdown = doanh thu", async () => {
    const shiftSum = (await api("cashier", "GET", `${V}/shifts/${cashierShift}/summary`)).body;
    const expectCharges = (await db().prepare(`SELECT COALESCE(SUM(charges_total),0) s FROM orders WHERE status='completed' AND kind='sale'`).first<{ s: number }>())!.s;
    expect(expectCharges).toBeGreaterThanOrEqual(35000);
    expect(shiftSum.sales.otherCharges).toBeGreaterThanOrEqual(35000);
    const daily = (await api("manager", "GET", `${V}/reports/daily`)).body;
    expect(daily.otherCharges).toBe(expectCharges);
    const day = vnDate();
    for (const groupBy of ["group", "channel", "day"]) {
      const p = (await api("owner", "GET", `${V}/reports/pnl?from=${day}&to=${day}&groupBy=${groupBy}`)).body;
      expect(p.otherCharges).toBe(expectCharges);
      expect(p.breakdown.reduce((s: number, r: any) => s + r.revenue, 0)).toBe(p.revenue);
      if (groupBy === "group") expect(p.breakdown.find((r: any) => r.key === "Thu khác")).toMatchObject({ revenue: expectCharges, cogs: 0 });
      else expect(p.breakdown.reduce((s: number, r: any) => s + (r.otherCharges ?? 0), 0)).toBe(expectCharges);
    }
  });
});

describe("B2: trả hàng có / không hoàn thu khác", () => {
  async function orderWithCharge() {
    const r = await sell("cashier", { charges: [{ chargeTypeId: 901, amount: 5000 }], payments: [{ method: "cash", amount: 205000 }] });
    expect(r.status).toBe(201);
    return r.body;
  }
  const ret = (o: any, qty: number, extra: object = {}) =>
    api("cashier", "POST", `${V}/orders/${o.id}/return`, { refundMethod: "cash", lines: [{ orderLineId: o.lines[0].id, qty, unit: "kg", restock: true, reason: "khách trả" }], ...extra });

  it("trả một phần: không hoàn thu khác (mặc định)", async () => {
    const o = await orderWithCharge();
    const r = await ret(o, 1);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ total: 100000, charges_total: 0 });
    expect(r.body.payments.map((p: any) => p.amount)).toEqual([-100000]);
    expect((await db().prepare(`SELECT refunded_amount r FROM order_charges WHERE order_id = ?`).bind(o.id).first<any>()).r).toBe(0);
  });

  it("trả toàn bộ nhưng không chọn hoàn: giữ phí; chọn hoàn nhưng thiếu lý do → 422; trả một phần mà chọn hoàn → 422", async () => {
    const o = await orderWithCharge();
    expect((await ret(o, 1, { refundCharges: true, chargesReason: "khách phàn nàn" })).body.error.code).toBe("charges_refund_partial");
    const full0 = await ret(o, 2, { refundCharges: true });
    expect(full0.status).toBe(422);
    expect(full0.body.error.code).toBe("charges_reason_required");
    const keep = await ret(o, 2);
    expect(keep.status).toBe(201);
    expect(keep.body).toMatchObject({ total: 200000, charges_total: 0 });
  });

  it("trả toàn bộ + hoàn thu khác (có lý do): hoàn đủ hàng + thu khác, đánh dấu đã hoàn, báo cáo trừ đúng", async () => {
    const o = await orderWithCharge();
    const before = (await api("manager", "GET", `${V}/reports/daily`)).body.otherCharges;
    const r = await ret(o, 2, { refundCharges: true, chargesReason: "phí đóng gói tính nhầm" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ subtotal: 200000, total: 205000, charges_total: 5000 });
    expect(r.body.payments.map((p: any) => [p.method, p.amount])).toEqual([["cash", -205000]]);
    expect((await db().prepare(`SELECT refunded_amount r FROM order_charges WHERE order_id = ?`).bind(o.id).first<any>()).r).toBe(5000);
    const after = (await api("manager", "GET", `${V}/reports/daily`)).body.otherCharges;
    expect(after).toBe(before - 5000);
    // hoàn nữa → vượt (đã trả hết hàng)
    expect((await ret(o, 1, { refundCharges: true, chargesReason: "lại" })).status).toBe(409);
  });

  it("trả làm hai lần: phần thu khác chỉ hoàn ở lần trả nốt toàn bộ", async () => {
    const o = await orderWithCharge();
    expect((await ret(o, 1)).status).toBe(201);
    const last = await ret(o, 1, { refundCharges: true, chargesReason: "trả nốt, hoàn phí" });
    expect(last.status).toBe(201);
    expect(last.body).toMatchObject({ total: 105000, charges_total: 5000 });
  });

  it("huỷ đơn có thu khác: hoàn toàn bộ tiền đã thu, doanh thu không còn thu khác", async () => {
    const o = await orderWithCharge();
    const v = await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "nhập nhầm" });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe("cancelled");
    expect(v.body.payments.every((p: any) => p.status === "refunded")).toBe(true);
  });
});
