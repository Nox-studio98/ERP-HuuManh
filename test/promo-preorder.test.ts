import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { vnDate } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
const BUNDLE = 41;
const tomorrow = () => vnDate(new Date(Date.now() + 86400_000));
const body = (extra: object = {}, qty = 2, deposit = 150000) => ({
  customer: { name: "Chị Lan", phone: "0987654321" }, pickupDate: tomorrow(),
  lines: [{ productId: BUNDLE, unit: "hop", qty }], deposit: { amount: deposit, method: "cash" }, ...extra,
});
const fundBalance = async (id: number) => (await api("manager", "GET", `${V}/funds`)).body.items.find((f: any) => f.id === id).balance;
const deposits = async (orderId: number) => (await db().prepare(`SELECT * FROM order_deposits WHERE order_id=?`).bind(orderId).first<any>());
let shiftId: number;

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (41,'GIOQUA-TET','Giỏ quà Trung thu','hop',1)`),
    db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,41,250000,'2020-01-01T00:00:00Z','active',1)`),
    db().prepare(`INSERT INTO bundle_components(bundle_product_id, component_product_id, qty_milli) VALUES (41,1,1000),(41,2,500)`),
  ]);
  shiftId = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 100000 })).body.shift.id;
});

describe("đặt trước giỏ quà + đặt cọc (M1-12)", () => {
  let po: any;

  it("cọc tối thiểu 30%; cọc > tổng bị từ chối; cần khách và ca", async () => {
    const low = await api("cashier", "POST", `${V}/pos/preorders`, body({}, 2, 100000));
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe("deposit_too_low");
    expect(low.body.error.details.minDeposit).toBe(150000);
    expect((await api("cashier", "POST", `${V}/pos/preorders`, body({}, 2, 600000))).body.error.code).toBe("deposit_too_high");
    expect((await api("cashier", "POST", `${V}/pos/preorders`, body({ customer: undefined }))).body.error.code).toBe("customer_required");
    expect((await api("cashier", "POST", `${V}/pos/preorders`, body({ pickupDate: "2020-01-01" }))).body.error.code).toBe("invalid_pickup_date");
    expect((await api("manager", "POST", `${V}/pos/preorders`, body())).body.error.code).toBe("no_open_shift");
    expect((await api("warehouse", "POST", `${V}/pos/preorders`, body())).status).toBe(403);
  });

  it("tạo đơn đặt trước: confirmed, is_preorder, phiếu thu cọc trên quỹ của ca, chưa ghi nhận doanh thu", async () => {
    const r = await api("cashier", "POST", `${V}/pos/preorders`, body({ clientUuid: "preorder-uuid-0001" }));
    expect(r.status).toBe(201);
    po = r.body;
    expect(po).toMatchObject({ status: "confirmed", total: 500000, paidTotal: 150000, remaining: 350000, pickupDate: tomorrow(), reservedMilli: 0 });
    expect(po.deposit).toMatchObject({ amount: 150000, method: "cash", fundId: 1, status: "held" });
    const o = await db().prepare(`SELECT is_preorder, shift_id, customer_id FROM orders WHERE id=?`).bind(po.id).first<any>();
    expect(o).toMatchObject({ is_preorder: 1, shift_id: shiftId });
    const cu = await db().prepare(`SELECT name, phone FROM customers WHERE id=?`).bind(o.customer_id).first<any>();
    expect(cu).toMatchObject({ name: "Chị Lan", phone: "0987654321" });
    const v = await db().prepare(`SELECT * FROM cash_vouchers WHERE id=?`).bind(po.deposit.cashVoucherId).first<any>();
    expect(v).toMatchObject({ direction: "in", fund_id: 1, amount: 150000, status: "posted", ref_type: "order_deposit", ref_id: po.id });
    expect(await fundBalance(1)).toBe(150000);
    // chưa giao → chưa là doanh thu
    const pnl = await api("manager", "GET", `${V}/reports/pnl?from=${vnDate()}&to=${vnDate()}`);
    expect(pnl.body.revenue).toBe(0);
    // idempotent theo clientUuid
    const again = await api("cashier", "POST", `${V}/pos/preorders`, body({ clientUuid: "preorder-uuid-0001" }));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(po.id);
    // khách theo SĐT được dùng lại
    const second = await api("cashier", "POST", `${V}/pos/preorders`, body({ clientUuid: "preorder-uuid-0002" }, 1, 100000));
    expect(second.status).toBe(201);
    expect(second.body.customer.id).toBe(po.customer.id);
    await api("cashier", "POST", `${V}/pos/preorders/${second.body.id}/cancel`, { refundDeposit: true, reason: "thử" });
  });

  it("đóng giỏ rồi giao: trừ cọc, thu phần còn lại, doanh thu ghi nhận khi hoàn tất", async () => {
    expect((await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 3, unit: "hop", extraCost: 30000 })).status).toBe(201);
    const short = await api("cashier", "POST", `${V}/pos/preorders/${po.id}/fulfill`, { payments: [{ method: "cash", amount: 300000 }] });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe("payment_mismatch");
    const r = await api("cashier", "POST", `${V}/pos/preorders/${po.id}/fulfill`, { payments: [{ method: "cash", amount: 400000 }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("completed");
    expect(r.body.paidTotal).toBe(500000);
    expect(r.body.change).toBe(50000);
    expect(r.body.deposit.status).toBe("applied");
    const pays = (await db().prepare(`SELECT method, amount FROM payments WHERE order_id=?`).bind(po.id).all<any>()).results;
    expect(pays).toEqual([{ method: "cash", amount: 350000 }]); // cọc không ghi lần nữa
    const lots = (await db().prepare(`SELECT SUM(oll.qty_milli) q FROM order_line_lots oll JOIN order_lines ol ON ol.id=oll.order_line_id WHERE ol.order_id=?`).bind(po.id).first<any>());
    expect(lots.q).toBe(2000);
    const cost = await db().prepare(`SELECT cost_total FROM orders WHERE id=?`).bind(po.id).first<any>();
    expect(cost.cost_total).toBeGreaterThan(0);
    // quỹ tiền mặt: cọc 150k + 350k = 500k, không đếm đôi
    expect(await fundBalance(1)).toBe(500000);
    const pnl = await api("manager", "GET", `${V}/reports/pnl?from=${vnDate()}&to=${vnDate()}`);
    expect(pnl.body.revenue).toBe(500000);
    // không giao hai lần
    expect((await api("cashier", "POST", `${V}/pos/preorders/${po.id}/fulfill`, { payments: [{ method: "cash", amount: 350000 }] })).status).toBe(409);
  });

  it("có hàng sẵn: giữ tồn khi đặt; huỷ + hoàn cọc → phiếu chi, nhả giữ tồn", async () => {
    const r = await api("cashier", "POST", `${V}/pos/preorders`, body({}, 1, 100000));
    expect(r.status).toBe(201);
    expect(r.body.reservedMilli).toBe(1000);
    const lotId = (await db().prepare(`SELECT lot_id FROM reservations WHERE order_id=?`).bind(r.body.id).first<any>()).lot_id;
    const reservedBefore = (await db().prepare(`SELECT qty_reserved_milli q FROM lots WHERE id=?`).bind(lotId).first<any>()).q;
    expect(reservedBefore).toBe(1000);
    const bal = await fundBalance(1);
    const c = await api("cashier", "POST", `${V}/pos/preorders/${r.body.id}/cancel`, { refundDeposit: true, reason: "khách đổi ý" });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("cancelled");
    expect(c.body.deposit.status).toBe("refunded");
    expect((await db().prepare(`SELECT qty_reserved_milli q FROM lots WHERE id=?`).bind(lotId).first<any>()).q).toBe(0);
    const out = await db().prepare(`SELECT direction, amount, fund_id FROM cash_vouchers WHERE ref_type='order_deposit' AND ref_id=? AND direction='out'`).bind(r.body.id).first<any>();
    expect(out).toMatchObject({ direction: "out", amount: 100000, fund_id: 1 });
    expect(await fundBalance(1)).toBe(bal - 100000);
    expect((await api("cashier", "POST", `${V}/pos/preorders/${r.body.id}/cancel`, { refundDeposit: true, reason: "lần hai" })).status).toBe(409);
  });

  it("không hoàn cọc: thu ngân cần duyệt; quản lý duyệt → huỷ + cọc bị giữ (forfeited)", async () => {
    const r = await api("cashier", "POST", `${V}/pos/preorders`, body({}, 1, 100000));
    const req = await api("cashier", "POST", `${V}/pos/preorders/${r.body.id}/cancel`, { refundDeposit: false, reason: "khách bỏ cọc" });
    expect(req.status).toBe(409);
    expect(req.body.error.code).toBe("approval_required");
    const approvalId = req.body.error.details.approvalId;
    expect((await api("cashier", "GET", `${V}/pos/preorders/${r.body.id}`)).body.status).toBe("confirmed");
    // gửi lại không tạo trùng approval
    expect((await api("cashier", "POST", `${V}/pos/preorders/${r.body.id}/cancel`, { refundDeposit: false, reason: "khách bỏ cọc" })).body.error.details.approvalId).toBe(approvalId);
    const bal = await fundBalance(1);
    const d = await api("manager", "POST", `${V}/approvals/${approvalId}/decide`, { decision: "approved" });
    expect(d.status).toBe(200);
    const after = await api("cashier", "GET", `${V}/pos/preorders/${r.body.id}`);
    expect(after.body.status).toBe("cancelled");
    expect(after.body.deposit.status).toBe("forfeited");
    expect(after.body.reservedMilli).toBe(0);
    expect(await fundBalance(1)).toBe(bal); // tiền cọc ở lại quỹ
    // quản lý huỷ trực tiếp, không cần duyệt
    const r2 = await api("cashier", "POST", `${V}/pos/preorders`, body({}, 1, 100000));
    const direct = await api("manager", "POST", `${V}/pos/preorders/${r2.body.id}/cancel`, { refundDeposit: false, reason: "quá hạn lấy hàng" });
    expect(direct.status).toBe(200);
    expect(direct.body.deposit.status).toBe("forfeited");
  });

  it("danh sách đặt trước theo trạng thái / ngày hẹn", async () => {
    const l = await api("cashier", "GET", `${V}/pos/preorders?status=cancelled`);
    expect(l.body.items.length).toBeGreaterThanOrEqual(3);
    expect(l.body.items.every((x: any) => x.status === "cancelled")).toBe(true);
    const all = await api("cashier", "GET", `${V}/pos/preorders`);
    expect(all.body.items.find((x: any) => x.id === po.id)).toMatchObject({ status: "completed", depositStatus: "applied", depositAmount: 150000 });
  });

  it("chốt ca: tiền mặt dự kiến gồm cọc nhận, trừ cọc đã hoàn", async () => {
    // mở 100k + cọc nhận (150k + 100k + 100k + 100k + 100k) − hoàn (100k + 100k) + thu phần còn lại 350k
    const close = await api("cashier", "POST", `${V}/shifts/${shiftId}/close`, { countedCash: 0 });
    expect(close.status).toBe(422);
    const dep = await db().prepare(`SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END),0) s FROM cash_vouchers WHERE ref_type='order_deposit'`).first<any>();
    expect(close.body.error.details.expectedCash).toBe(100000 + 350000 + dep.s);
    const ok = await api("cashier", "POST", `${V}/shifts/${shiftId}/close`, { countedCash: close.body.error.details.expectedCash });
    expect(ok.status).toBe(200);
    expect(ok.body.shift.diff_cash).toBe(0);
  });
});
