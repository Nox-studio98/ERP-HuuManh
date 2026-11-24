import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { vnDate } from "../src/worker/lib/time";

// Đợt fix 4a: A-06 (void ca đã chốt), A-07 (void đơn đặt trước đã giao), A-16 (trả hàng POS giới hạn + duyệt)
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const sell = async (role: string, qty: number, method = "cash") => {
  const r = await api(role, "POST", `${V}/pos/orders`, { clientUuid: `f4a-${++seq}-${crypto.randomUUID()}`, lines: [{ productId: 1, unit: "kg", qty }], payments: [{ method, amount: qty * 100000 }] });
  expect(r.status).toBe(201);
  return r.body;
};
const openShift = async (role: string, opening: number) => (await api(role, "POST", `${V}/shifts/open`, { openingCash: opening })).body.shift;
const closeShift = (role: string, id: number, counted: number, diffReason?: string) => api(role, "POST", `${V}/shifts/${id}/close`, { countedCash: counted, diffReason });
const retBody = (o: any, qty: number, restock = true, method = "cash") => ({ lines: [{ orderLineId: o.lines[0].id, qty, unit: "kg", restock, reason: "khách trả" }], refundMethod: method });
const BUNDLE = 41;
const tomorrow = () => vnDate(new Date(Date.now() + 86400_000));

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (41,'GIOQUA-TET','Giỏ quà','hop',1)`),
    db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,41,250000,'2020-01-01T00:00:00Z','active',1)`),
    db().prepare(`INSERT INTO bundle_components(bundle_product_id, component_product_id, qty_milli) VALUES (41,1,1000),(41,2,500)`),
  ]);
});

describe("A-06: huỷ đơn của ca đã chốt", () => {
  it("tiền mặt hoàn tính vào ca ĐANG MỞ; ca đã chốt giữ nguyên; thu ngân không huỷ được", async () => {
    const s1 = await openShift("cashier", 100000);
    const o = await sell("cashier", 1); // 100.000 tiền mặt
    const c1 = await closeShift("cashier", s1.id, 200000);
    expect(c1.status).toBe(200);
    expect(c1.body.shift.expected_cash).toBe(200000);
    expect((await api("cashier", "POST", `${V}/orders/${o.id}/void`, { reason: "nhầm" })).status).toBe(403);
    // quản lý chưa mở ca → không có két để hoàn
    const none = await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "khách trả lại" });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("no_open_shift");
    const s2 = await openShift("manager", 300000);
    const v = await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "khách trả lại" });
    expect(v.status).toBe(200);
    const row = await db().prepare(`SELECT refund_shift_id FROM orders WHERE id=?`).bind(o.id).first<any>();
    expect(row.refund_shift_id).toBe(s2.id);
    // ca cũ không đổi
    const old = await db().prepare(`SELECT expected_cash, counted_cash, diff_cash FROM shifts WHERE id=?`).bind(s1.id).first<any>();
    expect(old).toMatchObject({ expected_cash: 200000, counted_cash: 200000, diff_cash: 0 });
    // ca hiện tại: dự kiến = đầu ca 300.000 − 100.000 hoàn khách
    const c2 = await closeShift("manager", s2.id, 200000);
    expect(c2.status).toBe(200);
    expect(c2.body.shift.expected_cash).toBe(200000);
    expect(c2.body.shift.diff_cash).toBe(0);
    // không huỷ hai lần
    expect((await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "lần hai" })).status).toBe(409);
  });

  it("đơn thanh toán chuyển khoản của ca đã chốt: huỷ được không cần ca mở", async () => {
    const s = await openShift("cashier", 0);
    const o = await sell("cashier", 1, "qr");
    expect((await closeShift("cashier", s.id, 0)).status).toBe(200);
    const v = await api("manager", "POST", `${V}/orders/${o.id}/void`, { reason: "hoàn QR" });
    expect(v.status).toBe(200);
    expect((await db().prepare(`SELECT refund_shift_id FROM orders WHERE id=?`).bind(o.id).first<any>()).refund_shift_id).toBeNull();
  });
});

describe("A-07: huỷ đơn đặt trước đã giao", () => {
  it("bị chặn (cọc đã áp dụng) — dùng Trả hàng hoàn đủ cả cọc", async () => {
    const s = await openShift("cashier", 0);
    const po = await api("cashier", "POST", `${V}/pos/preorders`, {
      customer: { name: "Chị Lan", phone: "0987654399" }, pickupDate: tomorrow(), lines: [{ productId: BUNDLE, unit: "hop", qty: 1 }], deposit: { amount: 100000, method: "cash" },
    });
    expect(po.status).toBe(201);
    expect((await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 2, unit: "hop", extraCost: 0 })).status).toBe(201);
    const f = await api("cashier", "POST", `${V}/pos/preorders/${po.body.id}/fulfill`, { payments: [{ method: "cash", amount: 150000 }] });
    expect(f.status).toBe(200);
    expect(f.body.deposit.status).toBe("applied");
    const v = await api("manager", "POST", `${V}/orders/${po.body.id}/void`, { reason: "nhầm" });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe("preorder_void_blocked");
    expect((await db().prepare(`SELECT status FROM orders WHERE id=?`).bind(po.body.id).first<any>()).status).toBe("completed");
    // Trả hàng bởi quản lý hoàn đủ 250.000 (gồm cọc)
    const full = (await api("manager", "GET", `${V}/orders/${po.body.id}`)).body;
    await openShift("manager", 0);
    const r = await api("manager", "POST", `${V}/orders/${po.body.id}/return`, { lines: [{ orderLineId: full.lines[0].id, qty: 1, unit: "hop", restock: true, reason: "khách trả" }], refundMethod: "cash" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.total).toBe(250000);
    await closeShift("cashier", s.id, 1_000_000_000, "test");
  });
});

describe("A-16: trả hàng POS có giới hạn", () => {
  let shift: any;
  beforeAll(async () => {
    shift = await openShift("cashier", 0);
    await openShift("manager", 0);
  });

  it("đơn ca đang mở, nhỏ, nhập lại kho: thu ngân tự trả", async () => {
    const o = await sell("cashier", 1);
    const r = await api("cashier", "POST", `${V}/orders/${o.id}/return`, retBody(o, 1));
    expect(r.status).toBe(201);
  });

  it("restock=false (hao hụt) của thu ngân cần duyệt; duyệt xong dùng một lần; không tự duyệt", async () => {
    const o = await sell("cashier", 2);
    const body = retBody(o, 1, false);
    const first = await api("cashier", "POST", `${V}/orders/${o.id}/return`, body);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe("approval_required");
    expect(first.body.error.details.reasons).toContain("no_restock");
    const aid = first.body.error.details.approvalId;
    // gọi lại → cùng yêu cầu pending
    expect((await api("cashier", "POST", `${V}/orders/${o.id}/return`, body)).body.error.details.approvalId).toBe(aid);
    expect((await api("cashier", "POST", `${V}/orders/${o.id}/return`, { ...body, approvalId: aid })).body.error.code).toBe("approval_required");
    expect((await api("cashier", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    // duyệt gắn với yêu cầu: đổi số lượng → không dùng được
    const other = await api("cashier", "POST", `${V}/orders/${o.id}/return`, { ...retBody(o, 2, false), approvalId: aid });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("approval_invalid");
    const ok = await api("cashier", "POST", `${V}/orders/${o.id}/return`, { ...body, approvalId: aid });
    expect(ok.status).toBe(201);
    const a = await db().prepare(`SELECT ref_type, ref_id FROM approvals WHERE id=?`).bind(aid).first<any>();
    expect(a).toMatchObject({ ref_type: "order", ref_id: String(ok.body.id) });
    // dùng lại mã duyệt → từ chối
    const reuse = await api("cashier", "POST", `${V}/orders/${o.id}/return`, { ...body, approvalId: aid });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("approval_invalid");
  });

  it("quản lý tự trả restock=false không cần duyệt", async () => {
    const o = await sell("cashier", 1);
    expect((await api("manager", "POST", `${V}/orders/${o.id}/return`, retBody(o, 1, false))).status).toBe(201);
  });

  it("giá trị từ ngưỡng approval.pos_return_vnd trở lên cần duyệt", async () => {
    const o = await sell("cashier", 6); // 600.000 ≥ 500.000
    const r = await api("cashier", "POST", `${V}/orders/${o.id}/return`, retBody(o, 6));
    expect(r.status).toBe(409);
    expect(r.body.error.details.reasons).toEqual(["high_value"]);
    await db().prepare(`UPDATE settings SET value='700000' WHERE key='approval.pos_return_vnd'`).run();
    expect((await api("cashier", "POST", `${V}/orders/${o.id}/return`, retBody(o, 6))).status).toBe(201);
    await db().prepare(`UPDATE settings SET value='500000' WHERE key='approval.pos_return_vnd'`).run();
  });

  it("đơn của ca đã chốt: thu ngân cần duyệt (ca khác)", async () => {
    // đơn ca cũ của thu ngân: chốt ca hiện tại, mở ca mới
    const o = await sell("cashier", 1);
    expect((await closeShift("cashier", shift.id, 1_000_000_000, "test")).status).toBe(200);
    await openShift("cashier", 0);
    const r = await api("cashier", "POST", `${V}/orders/${o.id}/return`, retBody(o, 1));
    expect(r.status).toBe(409);
    expect(r.body.error.details.reasons).toContain("other_shift");
    // quản lý trả bình thường và tiền hoàn nằm trong ca của người trả
    expect((await api("manager", "POST", `${V}/orders/${o.id}/return`, retBody(o, 1))).status).toBe(201);
  });
});
