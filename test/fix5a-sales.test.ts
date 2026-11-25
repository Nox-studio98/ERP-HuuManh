import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { resolvePrice } from "../src/worker/services/pricing";

// Đợt fix 5a: A-09 (bán offline), A-10 (hạn mức nợ), A-21 (voucher POS), A-22 (giá riêng khách ở POS),
// A-23/B-24 (giá hẹn tương lai), A-29 (tự duyệt phải ghi lý do), C-30 (version bảng giá)
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const customerBody = (over: Record<string, unknown> = {}) => ({
  name: "Nhà hàng F5A", type: "b2b", customerGroupId: 1, creditLimit: 10_000_000, paymentTermsDays: 15,
  contacts: [{ name: "Anh Tùng", isReceiver: true }],
  addresses: [{ label: "Kho chính", address: "45 Lê Lợi, Q1", isDefault: true }],
  ...over,
});
const uuid = () => `f5a-${++seq}-${crypto.randomUUID()}`;
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const sell = (role: string, extra: Record<string, unknown>, qty = 1, productId = 1, amount?: number) =>
  api(role, "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [{ productId, unit: "kg", qty }], payments: [{ method: "cash", amount: amount ?? qty * (productId === 1 ? 100000 : 200000) }], ...extra });

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`UPDATE lots SET qty_in_milli=500000, qty_on_hand_milli=500000`),
    db().prepare(`INSERT INTO customers(id, code, type, name, customer_group_id) VALUES (9501,'KH-F5A','retail','Khách F5A',1)`),
  ]);
  for (const r of ["cashier", "manager"]) expect((await api(r, "POST", `${V}/shifts/open`, { openingCash: 0 })).status).toBe(201);
});

describe("A-09: bán offline giữ thời điểm bán, giá đã hiển thị", () => {
  it("completed_at = soldAt (không phải lúc đồng bộ)", async () => {
    const soldAt = ago(36);
    const r = await sell("cashier", { soldAt });
    expect(r.status).toBe(201);
    expect(r.body.completed_at).toBe(soldAt);
  });
  it("quá hạn offline tối đa bị từ chối", async () => {
    const r = await sell("cashier", { soldAt: ago(72) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("offline_too_old");
  });
  it("giá snapshot trong ngưỡng được chấp nhận; ngoài ngưỡng bị từ chối; không có soldAt thì bỏ qua snapshot", async () => {
    const snap = (p: number) => [{ productId: 1, unitPrice: p }];
    const ok = await sell("cashier", { soldAt: ago(1), priceSnapshot: snap(95000) }, 1, 1, 95000);
    expect(ok.status).toBe(201);
    expect(ok.body.total).toBe(95000);
    const bad = await sell("cashier", { soldAt: ago(1), priceSnapshot: snap(50000) }, 1, 1, 50000);
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("offline_price_changed");
    const online = await sell("cashier", { priceSnapshot: snap(95000) }, 1, 1, 95000);
    expect(online.status).toBe(422);
    expect(online.body.error.code).toBe("payment_mismatch");
  });
  it("ghi audit offline", async () => {
    const a = await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='order.checkout' AND after_json LIKE '%"offline"%'`).first<{ n: number }>();
    expect(a!.n).toBeGreaterThan(0);
  });
});

describe("A-10: hạn mức nợ / hạn thanh toán", () => {
  const post = (role: string, over: Record<string, unknown>) => api(role, "POST", `${V}/customers`, customerBody(over));
  it("quản lý tạo khách vượt ngưỡng: cần lý do, tạo với mức trần + yêu cầu duyệt; chủ duyệt mới áp dụng", async () => {
    const noReason = await post("manager", { name: "KS vượt A10", creditLimit: 10_000_000_000 });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe("credit_reason_required");
    const r = await post("manager", { name: "KS vượt A10", creditLimit: 10_000_000_000, creditReason: "Hợp đồng khung" });
    expect(r.status).toBe(201);
    expect(r.body.creditApprovalPending).toBe(true);
    expect(r.body.creditLimit).toBe(50_000_000);
    const ap = await db().prepare(`SELECT id, status, reason FROM approvals WHERE type='customer.credit_change' AND ref_id=?`).bind(String(r.body.id)).first<any>();
    expect(ap).toMatchObject({ status: "pending", reason: "Hợp đồng khung" });
    expect((await api("manager", "POST", `${V}/approvals/${ap.id}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await api("owner", "POST", `${V}/approvals/${ap.id}/decide`, { decision: "approved" })).status).toBe(200);
    expect((await api("owner", "GET", `${V}/customers/${r.body.id}`)).body.creditLimit).toBe(10_000_000_000);
  });
  it("quản lý nâng hạn mức / hạn thanh toán vượt ngưỡng không đổi ngay, chủ đổi trực tiếp (có lý do)", async () => {
    const c = (await post("manager", { name: "KS nâng A10" })).body;
    const noReason = await api("manager", "PUT", `${V}/customers/${c.id}`, { version: c.version, creditLimit: 1e10 });
    expect(noReason.status).toBe(422);
    const m = await api("manager", "PUT", `${V}/customers/${c.id}`, { version: c.version, creditLimit: 1e10, paymentTermsDays: 90, creditReason: "Xin nâng" });
    expect(m.status).toBe(200);
    expect(m.body.creditApprovalPending).toBe(true);
    expect(m.body.creditLimit).toBe(10_000_000);
    expect(m.body.paymentTermsDays).toBe(15);
    const o = await api("owner", "PUT", `${V}/customers/${c.id}`, { version: m.body.version, creditLimit: 2e10, creditReason: "Chủ chốt" });
    expect(o.status).toBe(200);
    expect(o.body.creditApprovalPending).toBeUndefined();
    expect(o.body.creditLimit).toBe(2e10);
    const a = await db().prepare(`SELECT reason FROM audit_log WHERE action='customer.update' AND entity_id=? ORDER BY id DESC`).bind(String(c.id)).first<any>();
    expect(a.reason).toBe("Chủ chốt");
  });
  it("trong ngưỡng, hoặc hạ xuống: quản lý tự đổi được (vẫn cần lý do)", async () => {
    const c = (await post("manager", { name: "KS trong ngưỡng" })).body;
    const r = await api("manager", "PUT", `${V}/customers/${c.id}`, { version: c.version, creditLimit: 40_000_000, creditReason: "Tăng nhẹ" });
    expect(r.status).toBe(200);
    expect(r.body.creditLimit).toBe(40_000_000);
    expect(r.body.creditApprovalPending).toBeUndefined();
  });
});

describe("A-21: voucher không giới hạn tổng lượt bắt buộc chọn khách ở POS", () => {
  it("POS không khách → từ chối; có khách → áp dụng", async () => {
    const p = await db()
      .prepare(`INSERT INTO promotions(code, name, kind, channels, value_amount, starts_at, ends_at, requires_voucher, status, created_by) VALUES ('KM-F5A','Voucher 20k','amount','pos,online',20000,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z',1,'active',1) RETURNING id`)
      .first<{ id: number }>();
    await db().prepare(`INSERT INTO vouchers(code, promotion_id, max_uses, per_customer_limit) VALUES ('F5AFREE',?,NULL,1)`).bind(p!.id).run();
    const anon = await sell("cashier", { voucherCode: "F5AFREE" }, 1, 1, 100000);
    expect(anon.status).toBe(422);
    expect(anon.body.error.code).toBe("voucher_invalid");
    expect(anon.body.error.details.reason).toBe("voucher_customer_required");
    const ok = await sell("cashier", { voucherCode: "F5AFREE", customerId: 9501 }, 1, 1, 100000);
    expect(ok.status).toBe(201);
    expect(ok.body.total).toBe(80000);
  });
});

describe("A-22: giá riêng theo khách ở POS", () => {
  it("bảng giá riêng kind=customer kênh pos áp dụng khi chọn khách; khách lẻ vẫn giá chung", async () => {
    const bad = await api("manager", "POST", `${V}/price-lists`, { name: "Riêng thiếu khách", channel: "pos", kind: "customer", priority: 100 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("customer_required");
    const pl = await api("manager", "POST", `${V}/price-lists`, { name: "Riêng KH-F5A", channel: "pos", kind: "customer", priority: 100, customerId: 9501 });
    expect(pl.status).toBe(201);
    expect(pl.body.customerId).toBe(9501);
    const bulk = await api("owner", "POST", `${V}/prices/bulk`, { priceListId: pl.body.id, items: [{ productId: 2, unitPrice: 170000 }] });
    expect(bulk.status).toBe(201);
    const withCust = await sell("cashier", { customerId: 9501 }, 1, 2, 170000);
    expect(withCust.status).toBe(201);
    expect(withCust.body.total).toBe(170000);
    const anon = await sell("cashier", {}, 1, 2);
    expect(anon.body.total).toBe(200000);
  });
});

describe("A-23 / B-24: đổi giá hàng loạt đóng giá hẹn tương lai", () => {
  it("lần đổi sau hẹn sớm hơn lần trước: giá cũ ở tương lai không đè lên", async () => {
    const pl = (await api("manager", "POST", `${V}/price-lists`, { name: "KM A23", channel: "pos", kind: "promo", priority: 5 })).body;
    const d10 = new Date(Date.now() + 10 * 86400_000).toISOString();
    const d5 = new Date(Date.now() + 5 * 86400_000).toISOString();
    expect((await api("owner", "POST", `${V}/prices/bulk`, { priceListId: pl.id, effectiveFrom: d10, items: [{ productId: 1, unitPrice: 60000 }] })).status).toBe(201);
    expect((await api("owner", "POST", `${V}/prices/bulk`, { priceListId: pl.id, effectiveFrom: d5, items: [{ productId: 1, unitPrice: 55000 }] })).status).toBe(201);
    const at = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
    expect((await resolvePrice(db(), 1, { channel: "pos", at: at(7) })).unitPrice).toBe(55000);
    expect((await resolvePrice(db(), 1, { channel: "pos", at: at(12) })).unitPrice).toBe(55000);
    expect((await resolvePrice(db(), 1, { channel: "pos", at: at(2) })).unitPrice).toBe(100000);
    const old = await db().prepare(`SELECT effective_from f, effective_to t FROM prices WHERE price_list_id=? AND unit_price=60000`).bind(pl.id).first<any>();
    expect(old.t).toBe(old.f); // lịch sử còn, khoảng hiệu lực rỗng
  });
});

describe("A-29: người tự duyệt phải ghi lý do", () => {
  it("quản lý bán dưới giá vốn: thiếu lý do 422; có lý do → ghi audit", async () => {
    const line = { unitPriceOverride: 100000 }; // vốn Nho 150k
    const body = (extra: object) => ({ clientUuid: uuid(), lines: [{ productId: 2, unit: "kg", qty: 1, ...line }], payments: [{ method: "cash", amount: 100000 }], ...extra });
    const no = await api("manager", "POST", `${V}/pos/orders`, body({}));
    expect(no.status).toBe(422);
    expect(no.body.error.code).toBe("override_reason_required");
    const ok = await api("manager", "POST", `${V}/pos/orders`, body({ overrideReason: "Hàng sắp héo, xả kho" }));
    expect(ok.status).toBe(201);
    const a = await db().prepare(`SELECT reason FROM audit_log WHERE action='order.self_approve' AND entity_id=?`).bind(String(ok.body.id)).first<any>();
    expect(a.reason).toBe("Hàng sắp héo, xả kho");
  });
});

describe("C-30: version bảng giá", () => {
  it("sửa với version cũ → 409; version đúng → tăng version", async () => {
    const c = (await api("manager", "POST", `${V}/price-lists`, { name: "Ver C30", channel: "pos", kind: "promo", priority: 3 })).body;
    expect(c.version).toBe(1);
    const body = { name: "Ver C30 b", channel: "pos", kind: "promo", priority: 3, active: true };
    const ok = await api("manager", "PUT", `${V}/price-lists/${c.id}`, { ...body, version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await api("manager", "PUT", `${V}/price-lists/${c.id}`, { ...body, name: "Ghi đè", version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect((await api("manager", "PUT", `${V}/price-lists/${c.id}`, body)).status).toBe(422);
  });
});
