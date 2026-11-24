import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ADDR, call, checkoutBody, lot, login, register, seedShop, testEnv, today, uuid } from "./shop-helpers";
import { hmacHex } from "../src/shop/worker/routes/payments";
import { cancelStaleCodOrders } from "../src/shop/worker/lib/cod-expiry";
import { _resetRateLimitWarn } from "../src/shop/worker/lib/ratelimit";
import { promoStatements, type PromoPlan } from "../src/worker/services/promo-checkout";
import { addDays } from "../src/worker/services/debt";

const db = () => testEnv.DB;
const phoneAddr = (receiverPhone: string) => ({ ...ADDR, receiverPhone });
const cod = (phone: string, over: Record<string, unknown> = {}) => checkoutBody({ address: phoneAddr(phone), ...over });

beforeAll(async () => {
  await seedShop();
  await db().prepare(`UPDATE settings SET value='3' WHERE key='online.max_open_orders_per_phone'`).run();
});
afterEach(() => vi.restoreAllMocks());

describe("1. Rate limiting bindings", () => {
  it("auth dùng RL_AUTH, checkout dùng RATE_LIMITER (khoá theo nhóm + IP)", async () => {
    const auth: string[] = [];
    const gen: string[] = [];
    const RL_AUTH = { limit: async ({ key }: { key: string }) => (auth.push(key), { success: true }) };
    const RATE_LIMITER = { limit: async ({ key }: { key: string }) => (gen.push(key), { success: true }) };
    const h = { "cf-connecting-ip": "5.6.7.8" };
    await call("POST", "/api/auth/forgot", { email: "x@example.com" }, { env: { RL_AUTH, RATE_LIMITER }, headers: h });
    await call("POST", "/api/checkout", {}, { env: { RL_AUTH, RATE_LIMITER }, headers: h });
    await call("POST", "/api/cart/quote", {}, { env: { RL_AUTH, RATE_LIMITER }, headers: h });
    expect(auth).toEqual(["auth:forgot:5.6.7.8"]);
    expect(gen).toEqual(["checkout:5.6.7.8", "quote:5.6.7.8"]);
  });

  it("RL_AUTH từ chối → 429 cho login/register/forgot", async () => {
    const RL_AUTH = { limit: async () => ({ success: false }) };
    for (const p of ["login", "register", "forgot"]) expect((await call("POST", `/api/auth/${p}`, {}, { env: { RL_AUTH } })).status).toBe(429);
  });

  it("thiếu binding ngoài dev: cảnh báo đúng một lần, không hỏng; dev: im lặng", async () => {
    _resetRateLimitWarn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await call("GET", "/api/health", undefined, { env: { APP_ENV: "dev" } })).status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    expect((await call("GET", "/api/health", undefined, { env: { APP_ENV: "staging" } })).status).toBe(200);
    expect((await call("GET", "/api/health", undefined, { env: { APP_ENV: "staging" } })).status).toBe(200);
    expect(warn.mock.calls.filter((a) => String(a[0]).includes("[ratelimit]"))).toHaveLength(1);
  });
});

describe("2. Giữ hàng bằng đơn COD ảo", () => {
  it("tối đa 3 đơn mở (new/awaiting_payment) / SĐT / 24h → 429 too_many_open_orders", async () => {
    const phone = "0933000001";
    for (let i = 0; i < 3; i++) expect((await call("POST", "/api/checkout", cod(phone))).status).toBe(201);
    const r4 = await call("POST", "/api/checkout", cod(phone));
    expect(r4.status).toBe(429);
    expect(r4.body.error.code).toBe("too_many_open_orders");
    // SĐT khác không bị ảnh hưởng; đơn được xác nhận thì không còn tính là "mở"
    expect((await call("POST", "/api/checkout", cod("0933000002"))).status).toBe(201);
    await db().prepare(`UPDATE orders SET status='confirmed' WHERE id=(SELECT MIN(id) FROM orders WHERE receiver_phone=?)`).bind(phone).run();
    expect((await call("POST", "/api/checkout", cod(phone))).status).toBe(201);
  });

  it("cancelStaleCodOrders huỷ đơn COD khách vãng lai chưa xác nhận quá hạn và nhả tồn", async () => {
    const before = await lot(901);
    const r = await call("POST", "/api/checkout", cod("0933000003"));
    expect(r.status).toBe(201);
    expect((await lot(901)).r).toBe(before.r + 3000);
    expect(await cancelStaleCodOrders(testEnv as any)).toBe(0); // mới đặt: chưa hết hạn
    await db().prepare(`UPDATE orders SET created_at=? WHERE code=?`).bind(new Date(Date.now() - 80 * 3600_000).toISOString(), r.body.code).run();
    expect(await cancelStaleCodOrders(testEnv as any)).toBe(1);
    expect(await db().prepare(`SELECT status, cancel_reason FROM orders WHERE code=?`).bind(r.body.code).first()).toMatchObject({ status: "cancelled" });
    expect((await lot(901)).r).toBe(before.r);
  });
});

describe("3. Đăng nhập: không lộ trạng thái khoá, không khoá toàn cục", () => {
  it("ghi audit lần sai; IP khác của chủ tài khoản không bị khoá bởi kẻ tấn công", async () => {
    await register("victim@example.com");
    const bad = { email: "victim@example.com", password: "Sai-mat-khau" };
    const atk = { "cf-connecting-ip": "6.6.6.6" };
    const first = await call("POST", "/api/auth/login", bad, { headers: atk });
    for (let i = 0; i < 6; i++) await call("POST", "/api/auth/login", bad, { headers: atk });
    const lockedRight = await call("POST", "/api/auth/login", { email: "victim@example.com", password: "Matkhau-123" }, { headers: atk });
    expect(lockedRight.status).toBe(401);
    expect(lockedRight.body.error).toEqual(first.body.error); // không phân biệt bị khoá
    expect(JSON.stringify(lockedRight.body)).not.toMatch(/lock|khoá|locked/i);
    const owner = await call("POST", "/api/auth/login", { email: "victim@example.com", password: "Matkhau-123" }, { headers: { "cf-connecting-ip": "7.7.7.7" } });
    expect(owner.status).toBe(200);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='shop.login_failed'`).first<any>()).n).toBeGreaterThanOrEqual(7);
    expect((await db().prepare(`SELECT locked_until FROM shop_accounts WHERE email='victim@example.com'`).first<any>()).locked_until).toBeNull();
  });
});

describe("4. Giới hạn email theo người nhận", () => {
  it("forgot password: thư thứ hai trong 60 giây bị bỏ qua nhưng phản hồi y hệt", async () => {
    await register("mailguard@example.com");
    const a = await call("POST", "/api/auth/forgot", { email: "mailguard@example.com" });
    const b = await call("POST", "/api/auth/forgot", { email: "mailguard@example.com" });
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    const n = await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='notify.email' AND json_extract(payload_json,'$.template')='reset_password' AND json_extract(payload_json,'$.to')='mailguard@example.com'`).first<any>();
    expect(n.n).toBe(1);
  });

  it("tối đa 5 thư/ngày/mẫu dù đã quá cooldown", async () => {
    await register("daily@example.com");
    for (let i = 0; i < 7; i++) {
      await call("POST", "/api/auth/forgot", { email: "daily@example.com" });
      await db().prepare(`UPDATE integration_jobs SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') WHERE type='notify.email' AND json_extract(payload_json,'$.template')='reset_password'`).run();
    }
    const n = await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type='notify.email' AND json_extract(payload_json,'$.template')='reset_password' AND json_extract(payload_json,'$.to')='daily@example.com'`).first<any>();
    expect(n.n).toBe(5);
  });

  it("email xác nhận đơn khách vãng lai bị giới hạn nhưng đơn vẫn được tạo", async () => {
    const mail = "guestmail@example.com";
    const r1 = await call("POST", "/api/checkout", cod("0933000010", { email: mail }));
    const r2 = await call("POST", "/api/checkout", cod("0933000011", { email: mail }));
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const payload = async (code: string) => JSON.parse((await db().prepare(`SELECT payload_json p FROM integration_jobs WHERE type='notify.order_status' AND ref_id=(SELECT id FROM orders WHERE code=?)`).bind(code).first<any>()).p);
    expect((await payload(r1.body.code)).email).toBe(mail);
    expect((await payload(r2.body.code)).email).toBeNull();
  });
});

describe("6. Webhook cổng giả lập", () => {
  const SECRET = "pay-secret";
  const ev = (o: Record<string, unknown>) => ({ eventId: "evt-" + uuid(), orderCode: "DH-X", amount: 1, status: "succeeded", ...o });
  async function hook(payload: object, o: { env?: Record<string, unknown>; legacySig?: boolean } = {}) {
    const raw = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const sig = await hmacHex(SECRET, o.legacySig ? raw : `${ts}.${raw}`);
    return call("POST", "/api/payments/gateway/fake_gateway/webhook", undefined, {
      raw, headers: { "content-type": "application/json", "x-signature": sig, "x-timestamp": String(ts) }, env: { PAYMENT_WEBHOOK_SECRET: SECRET, ...o.env },
    });
  }
  it("timestamp nằm trong chữ ký: chữ ký chỉ ký body bị từ chối", async () => {
    expect((await hook(ev({}), { legacySig: true })).status).toBe(401);
    expect((await hook(ev({}))).status).toBe(409); // chữ ký đúng, chưa có đơn → 409 (cổng gửi lại)
  });
  it("fake_gateway chỉ có ở dev/demo", async () => {
    for (const app of ["production", "staging"]) expect((await hook(ev({}), { env: { APP_ENV: app } })).status).toBe(501);
    expect((await hook(ev({}), { env: { APP_ENV: "demo" } })).status).toBe(409);
  });
  it("sự kiện đến trước khi có intent → 409 và KHÔNG ghi webhook_events", async () => {
    const e = ev({ orderCode: "DH-NOPE-2" });
    expect((await hook(e)).status).toBe(409);
    expect((await db().prepare(`SELECT COUNT(*) n FROM webhook_events WHERE event_id=?`).bind(e.eventId).first<any>()).n).toBe(0);
  });
});

describe("8. Replay clientUuid", () => {
  it("clientUuid < 16 ký tự bị từ chối", async () => {
    expect((await call("POST", "/api/checkout", cod("0933000020", { clientUuid: "short-uuid" }))).status).toBe(422);
  });
  it("khách vãng lai replay: chỉ {code,status} nếu không chứng minh SĐT; có phone4 hoặc đúng SĐT thì đủ", async () => {
    const body = cod("0933000021");
    const r = await call("POST", "/api/checkout", body);
    expect(r.status).toBe(201);
    const anon = await call("POST", "/api/checkout", { ...body, address: phoneAddr("0911111111") });
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ code: r.body.code, status: "new" });
    const wrong = await call("POST", "/api/checkout", { ...body, address: phoneAddr("0911111111"), phone4: "9999" });
    expect(wrong.body).toEqual({ code: r.body.code, status: "new" });
    const withP4 = await call("POST", "/api/checkout", { ...body, address: phoneAddr("0911111111"), phone4: "0021" });
    expect(withP4.body.trackingToken).toBe(r.body.trackingToken);
    const same = await call("POST", "/api/checkout", body); // client retry hợp lệ (cùng địa chỉ/SĐT)
    expect(same.status).toBe(200);
    expect(same.body.trackingToken).toBe(r.body.trackingToken);
  });
});

describe("9. Voucher per_customer_limit cho khách vãng lai", () => {
  it("giới hạn theo SĐT người nhận; chốt chặn trong batch chặn vượt lượt khi đồng thời", async () => {
    const promo = (await db().prepare(
      `INSERT INTO promotions(code, name, kind, channels, value_amount, starts_at, ends_at, requires_voucher, status, created_by)
       VALUES ('KM-SECPH','KM sec','amount','online',10000,'2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',1,'active',1) RETURNING id`).first<{ id: number }>())!.id;
    await db().prepare(`INSERT INTO vouchers(code, promotion_id, max_uses, per_customer_limit) VALUES ('SECPHONE', ?, NULL, 1)`).bind(promo).run();
    const a = await call("POST", "/api/checkout", cod("0933000030", { voucherCode: "SECPHONE" }));
    expect(a.status).toBe(201);
    expect(a.body.discount).toBe(10000);
    const b = await call("POST", "/api/checkout", cod("0933000030", { voucherCode: "SECPHONE" }));
    expect(b.status).toBe(422);
    expect(b.body.error.details.reason).toBe("voucher_customer_limit");
    expect((await call("POST", "/api/checkout", cod("0933000031", { voucherCode: "SECPHONE" }))).status).toBe(201); // SĐT khác dùng được

    // đồng thời: kế hoạch được lập TRƯỚC khi lượt kia ghi → batch phải rollback bằng assertStmt (state_changed)
    const o2 = await call("POST", "/api/checkout", cod("0933000030"));
    const orderId = (await db().prepare(`SELECT id FROM orders WHERE code=?`).bind(o2.body.code).first<any>()).id;
    const voucherId = (await db().prepare(`SELECT id FROM vouchers WHERE code='SECPHONE'`).first<any>()).id;
    const plan = { discounts: [{ promotionId: promo, voucherId, amount: 10000, description: "x", lineShares: [10000], clipped: false }], rejected: [], voucher: { id: voucherId, code: "SECPHONE" }, points: 0, pointsAmount: 0, promoLineDiscounts: [10000], pointsLineDiscounts: [0], lineDiscounts: [10000], promoTotal: 10000 } as PromoPlan;
    const stmts = await promoStatements(db(), { sql: "?", bind: orderId }, { plan, customerId: null, receiverPhone: "0933000030", payableTotal: 0, userId: null, skipEarn: true });
    await expect(db().batch(stmts)).rejects.toThrow(/state_changed/);
    expect((await db().prepare(`SELECT COUNT(*) n FROM voucher_redemptions WHERE voucher_id=?`).bind(voucherId).first<any>()).n).toBe(2);
  });
});

describe("10. Sức chứa khung giờ", () => {
  it("hai checkout đồng thời vào khung còn 1 chỗ: đúng một đơn được tạo", async () => {
    const date = addDays(today(), 5);
    const mk = (phone: string) => call("POST", "/api/checkout", cod(phone, { slotDate: date, slotId: 2 }));
    const [x, y] = await Promise.all([mk("0933000040"), mk("0933000041")]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE slot_date=? AND slot_id=2 AND status<>'cancelled'`).bind(date).first<any>()).n).toBe(1);
    const lose = x.status === 409 ? x : y;
    expect(lose.body.error.code).toBe("slot_full");
  });
});
