import { beforeAll, describe, expect, it } from "vitest";
import { ADDR, call, checkoutBody, lot, register, seedShop, testEnv } from "./shop-helpers";
import { api } from "./helpers";
import { cancelStaleCodOrders } from "../src/shop/worker/lib/cod-expiry";

// Đợt 10 fix website: S-1..S-6 + các điểm chủ đã chốt
const db = () => testEnv.DB;
const addr = (receiverPhone: string) => ({ ...ADDR, receiverPhone });
const cod = (phone: string, over: Record<string, unknown> = {}) => checkoutBody({ address: addr(phone), ...over });
const PROD = { APP_ENV: "production", TURNSTILE_SECRET: "x" };

beforeAll(async () => {
  await seedShop();
  await db().prepare(`UPDATE settings SET value='3' WHERE key='online.max_open_orders_per_phone'`).run();
});

describe("S-1 tài khoản đăng nhập áp giới hạn như khách vãng lai", () => {
  it("trần đơn COD mở theo tài khoản và theo SĐT; cron tự huỷ cả đơn tài khoản", async () => {
    const s = await register("s1a@example.com", "Matkhau-123", "0944100001");
    const codeOf: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/api/checkout", cod("0944100001"), { headers: s.headers });
      expect(r.status).toBe(201);
      codeOf.push(r.body.code);
    }
    const r4 = await call("POST", "/api/checkout", cod("0944100001"), { headers: s.headers });
    expect(r4.status).toBe(429);
    expect(r4.body.error.code).toBe("too_many_open_orders");
    // cùng tài khoản, SĐT người nhận khác: vẫn bị trần theo tài khoản
    expect((await call("POST", "/api/checkout", cod("0944100002"), { headers: s.headers })).status).toBe(429);
    // tài khoản khác nhưng cùng SĐT: bị trần theo SĐT
    const s2 = await register("s1b@example.com", "Matkhau-123", "0944100009");
    expect((await call("POST", "/api/checkout", cod("0944100001"), { headers: s2.headers })).status).toBe(429);
    // cron huỷ đơn COD quá hạn của tài khoản
    await db().prepare(`UPDATE orders SET created_at=? WHERE code IN (?,?,?)`).bind(new Date(Date.now() - 80 * 3600_000).toISOString(), ...codeOf).run();
    expect(await cancelStaleCodOrders(testEnv as any)).toBeGreaterThanOrEqual(3);
    expect((await db().prepare(`SELECT status FROM orders WHERE code=?`).bind(codeOf[0]).first<any>())!.status).toBe("cancelled");
  });

  it("tài khoản chưa xác minh email đặt COD phải qua Turnstile", async () => {
    const s = await register("s1c@example.com", "Matkhau-123", "0944100003");
    const r = await call("POST", "/api/checkout", cod("0944100003"), { headers: s.headers, env: PROD });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("turnstile_failed");
    await db().prepare(`UPDATE shop_accounts SET email_verified_at=? WHERE email='s1c@example.com'`).bind(new Date().toISOString()).run();
    expect((await call("POST", "/api/checkout", cod("0944100003"), { headers: s.headers, env: PROD })).status).toBe(201);
  });
});

describe("S-2 email người mua nằm trên đơn", () => {
  it("đơn vãng lai gắn hồ sơ cũ: thông báo tới email trên đơn, không tới hồ sơ cũ", async () => {
    await db().prepare(`INSERT INTO customers(code, type, name, phone, email) VALUES ('KL-F10S2','retail','Chủ cũ','0944200001','victim@old-owner.example')`).run();
    const r = await call("POST", "/api/checkout", cod("0944200001", { email: "buyer@new-buyer.example" }));
    expect(r.status).toBe(201);
    const o = (await db().prepare(`SELECT id, contact_email, customer_id FROM orders WHERE code=?`).bind(r.body.code).first<any>())!;
    expect(o.contact_email).toBe("buyer@new-buyer.example");
    const { notifyOrderStatus } = await import("../src/worker/services/notify");
    const out = await notifyOrderStatus(testEnv as any, o.id, { status: "confirmed" });
    expect(out.email).toBeTruthy();
    const audits = (await db().prepare(`SELECT after_json FROM audit_log WHERE after_json LIKE '%old-owner%' OR after_json LIKE '%buyer@%' OR after_json LIKE '%by***@new-buyer%'`).all<any>()).results;
    expect(JSON.stringify(audits)).not.toContain("vi***@old-owner");
    // khách vãng lai không để email: không gửi tới hồ sơ cũ
    const r2 = await call("POST", "/api/checkout", cod("0944200001"));
    const o2 = (await db().prepare(`SELECT id, contact_email FROM orders WHERE code=?`).bind(r2.body.code).first<any>())!;
    expect(o2.contact_email).toBe("");
    expect((await notifyOrderStatus(testEnv as any, o2.id, { status: "confirmed" })).email).toBe("no_recipient");
  });
});

describe("S-3 xoá tài khoản (NĐ13) + chặn khi còn khoản hoàn", () => {
  it("ẩn danh cả hồ sơ khách lẻ lúc đăng ký sau khi liên kết sỉ; hồ sơ sỉ không đụng", async () => {
    const s = await register("s3@example.com", "Matkhau-123", "0944300001");
    const acc = (await db().prepare(`SELECT id, customer_id FROM shop_accounts WHERE email='s3@example.com'`).first<any>())!;
    const b2b = await db().prepare(`INSERT INTO customers(code, type, name, phone) VALUES ('B2B-F10S3','b2b','Công ty X','0287000111')`).run();
    const link = await api("manager", "POST", `/api/v1/shop-accounts/${acc.id}/b2b-link`, { customerId: b2b.meta.last_row_id });
    expect(link.status).toBe(200);
    const del = await call("DELETE", "/api/me", { password: "Matkhau-123" }, { headers: s.headers });
    expect(del.status).toBe(200);
    const retail = (await db().prepare(`SELECT phone, email, active FROM customers WHERE id=?`).bind(acc.customer_id).first<any>())!;
    expect(retail).toMatchObject({ phone: null, email: null, active: 0 });
    expect((await db().prepare(`SELECT name, phone, active FROM customers WHERE id=?`).bind(b2b.meta.last_row_id).first<any>())).toMatchObject({ name: "Công ty X", phone: "0287000111", active: 1 });
  });

  it("còn refund_due > 0 → 409 refund_pending", async () => {
    const s = await register("s3b@example.com", "Matkhau-123", "0944300002");
    const r = await call("POST", "/api/checkout", cod("0944300002"), { headers: s.headers });
    await call("POST", `/api/me/orders/${r.body.code}/cancel`, {}, { headers: s.headers });
    await db().prepare(`UPDATE orders SET refund_due = 5000 WHERE code=?`).bind(r.body.code).run();
    const del = await call("DELETE", "/api/me", { password: "Matkhau-123" }, { headers: s.headers });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("refund_pending");
  });
});

describe("S-4 huỷ ở shop dùng chung logic ERP", () => {
  it("từ chối cân lại khi đang soạn: đóng so_shortages, xoá chênh lệch, khách chịu phí giao (A-28)", async () => {
    const r = await call("POST", "/api/checkout", cod("0944400001"));
    const o = (await db().prepare(`SELECT id, tracking_token FROM orders WHERE code=?`).bind(r.body.code).first<any>())!;
    const line = (await db().prepare(`SELECT id, product_id FROM order_lines WHERE order_id=?`).bind(o.id).first<any>())!;
    await db().prepare(`INSERT INTO so_shortages(order_id, order_line_id, product_id, initial_milli, qty_milli, need_by) VALUES (?,?,?,1000,1000,'2030-01-01')`).bind(o.id, line.id, line.product_id).run();
    await db().prepare(`UPDATE orders SET status='preparing', weight_adjust_status='pending_customer', diff_status='pending', diff_amount=-15000, shipping_fee=20000, payment_method='transfer', payment_status='paid', paid_total=170000 WHERE id=?`).bind(o.id).run();
    await db().prepare(`INSERT INTO payments(order_id, method, amount, status) VALUES (?, 'transfer', 170000, 'confirmed')`).bind(o.id).run().catch(() => {});
    const d = await call("POST", `/api/orders/track/${o.tracking_token}/weight-decision`, { accept: false, phone4: "0001" });
    expect(d.status).toBe(200);
    const after = (await db().prepare(`SELECT status, diff_status, diff_amount, shipping_fee_policy FROM orders WHERE id=?`).bind(o.id).first<any>())!;
    expect(after).toMatchObject({ status: "cancelled", diff_status: "none", diff_amount: 0, shipping_fee_policy: "customer" });
    expect((await db().prepare(`SELECT status FROM so_shortages WHERE order_id=?`).bind(o.id).first<any>())!.status).toBe("cancelled");
  });

  it("khách tự huỷ: phí giao theo online.cancel_fee_before_prepare", async () => {
    await db().prepare(`INSERT INTO settings(key,value) VALUES ('online.cancel_fee_before_prepare','customer') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    const s = await register("s4@example.com", "Matkhau-123", "0944400002");
    const r = await call("POST", "/api/checkout", cod("0944400002"), { headers: s.headers });
    const c = await call("POST", `/api/me/orders/${r.body.code}/cancel`, {}, { headers: s.headers });
    expect(c.status).toBe(200);
    expect((await db().prepare(`SELECT shipping_fee_policy p FROM orders WHERE code=?`).bind(r.body.code).first<any>())!.p).toBe("customer");
    await db().prepare(`UPDATE settings SET value='shop' WHERE key='online.cancel_fee_before_prepare'`).run();
  });
});

describe("S-5 / S-6", () => {
  it("checkout dùng binding RL_CHECKOUT riêng", async () => {
    const keys: string[] = [];
    const RL_CHECKOUT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    await call("POST", "/api/checkout", {}, { env: { RL_CHECKOUT }, headers: { "cf-connecting-ip": "9.9.9.9" } });
    expect(keys).toEqual(["checkout:9.9.9.9"]);
    const deny = { limit: async () => ({ success: false }) };
    expect((await call("POST", "/api/checkout", {}, { env: { RL_CHECKOUT: deny } })).status).toBe(429);
  });

  it("tham số đã khai báo trong registry", async () => {
    const { DEF_BY_KEY } = await import("../src/worker/services/settings-registry");
    for (const k of ["online.max_open_orders_per_phone", "online.cod_unconfirmed_hours", "hr.bonus_max_vnd"]) expect(DEF_BY_KEY.has(k)).toBe(true);
  });
});

let seq = 0;
async function mkVoucher(code: string, amount: number) {
  const p = (await db()
    .prepare(
      `INSERT INTO promotions(code, name, kind, channels, value_amount, starts_at, ends_at, requires_voucher, status, created_by)
       VALUES (?,?, 'amount','online',?, '2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z', 1, 'active', 1) RETURNING id`,
    )
    .bind(`KM-F10-${++seq}`, `F10 KM ${seq}`, amount)
    .first<{ id: number }>())!;
  await db().prepare(`INSERT INTO vouchers(code, promotion_id, max_uses) VALUES (?,?,NULL)`).bind(code, p.id).run();
}

describe("Ngưỡng miễn phí giao tính sau giảm giá", () => {
  it("giỏ 350k có voucher 60k → còn 290k < ngưỡng 300k → thu phí giao 20k (quote và checkout)", async () => {
    await mkVoucher("F10SHIP", 60000);
    const items = [{ productId: 901, unit: "kg", qty: 7 }];
    const q0 = await call("POST", "/api/cart/quote", { items, district: "Quận 1" });
    expect(q0.body).toMatchObject({ subtotal: 350000, shippingFee: 0, total: 350000 });
    const q = await call("POST", "/api/cart/quote", { items, district: "Quận 1", voucherCode: "F10SHIP" });
    expect(q.body).toMatchObject({ subtotal: 350000, discount: 60000, shippingFee: 20000, total: 310000 });
    const r = await call("POST", "/api/checkout", cod("0944500001", { items: [{ ...items[0], expectedUnitPrice: 50000 }], voucherCode: "F10SHIP" }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ shippingFee: 20000, total: 310000 });
  });
});

describe("Voucher giới hạn theo khách: đơn vãng lai tính theo hồ sơ khách", () => {
  it("lượt dùng ghi customer_id của hồ sơ cũ cùng SĐT", async () => {
    await mkVoucher("F10CUST", 10000);
    const cust = (await db().prepare(`INSERT INTO customers(code, type, name, phone) VALUES ('KL-F10V','retail','Khách V','0944600001')`).run()).meta.last_row_id;
    const r = await call("POST", "/api/checkout", cod("0944600001", { voucherCode: "F10CUST" }));
    expect(r.status).toBe(201);
    const red = (await db().prepare(`SELECT customer_id FROM voucher_redemptions WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(r.body.code).first<any>())!;
    expect(red.customer_id).toBe(cust);
  });
});
