import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, checkoutBody, seedShop, testEnv, uuid } from "./shop-helpers";
import { hmacHex } from "../src/shop/worker/routes/payments";

const SECRET = "whsec_test";
const db = () => testEnv.DB;

beforeAll(async () => {
  await seedShop();
  await db().prepare(`UPDATE settings SET value='cod,transfer,gateway' WHERE key='payment.methods'`).run();
});
afterAll(async () => {
  await db().prepare(`UPDATE settings SET value='cod,transfer' WHERE key='payment.methods'`).run();
});

async function hook(payload: Record<string, unknown>, o: { secret?: string; ts?: number; sig?: string; env?: Record<string, unknown> } = {}) {
  const raw = JSON.stringify(payload);
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const sig = o.sig ?? (await hmacHex(o.secret ?? SECRET, `${ts}.${raw}`));
  return call("POST", "/api/payments/gateway/fake_gateway/webhook", undefined, {
    raw,
    headers: { "content-type": "application/json", "x-signature": sig, "x-timestamp": String(ts) },
    env: { PAYMENT_WEBHOOK_SECRET: SECRET, ...o.env },
  });
}

async function gatewayOrder() {
  const r = await call("POST", "/api/checkout", checkoutBody({ paymentMethod: "gateway" }));
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending" });
  return r.body;
}

describe("fake gateway webhook", () => {
  it("verifies HMAC + timestamp, marks order paid → new, creates payment, and is idempotent", async () => {
    const o = await gatewayOrder();
    const intent = await db().prepare(`SELECT provider, provider_ref, status FROM payment_intents WHERE order_id=(SELECT id FROM orders WHERE code=?)`).bind(o.code).first<any>();
    expect(intent).toMatchObject({ provider: "fake_gateway", provider_ref: o.code, status: "pending" });
    const ev = { eventId: "evt-" + uuid(), orderCode: o.code, amount: 170000, status: "succeeded" };

    expect((await hook(ev, { sig: "00".repeat(32) })).status).toBe(401);
    expect((await hook(ev, { secret: "other" })).status).toBe(401);
    expect((await hook(ev, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await hook(ev, { env: { PAYMENT_WEBHOOK_SECRET: undefined } })).status).toBe(503);
    expect((await db().prepare(`SELECT status FROM orders WHERE code=?`).bind(o.code).first<any>()).status).toBe("awaiting_payment");

    const r = await hook(ev);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, result: "processed" });
    const row = await db().prepare(`SELECT id, status, payment_status, paid_total FROM orders WHERE code=?`).bind(o.code).first<any>();
    expect(row).toMatchObject({ status: "new", payment_status: "paid", paid_total: 170000 });
    const pay = await db().prepare(`SELECT p.method, p.amount, p.status, f.type AS ftype FROM payments p JOIN funds f ON f.id=p.fund_id WHERE p.order_id=?`).bind(row.id).all<any>();
    expect(pay.results).toEqual([{ method: "transfer", amount: 170000, status: "confirmed", ftype: "bank" }]);
    expect((await db().prepare(`SELECT status FROM payment_intents WHERE order_id=?`).bind(row.id).first<any>()).status).toBe("succeeded");
    const evs = await db().prepare(`SELECT status, actor_type FROM order_events WHERE order_id=? ORDER BY id`).bind(row.id).all<any>();
    expect(evs.results.at(-1)).toEqual({ status: "new", actor_type: "system" });
    expect((await db().prepare(`SELECT COUNT(*) n FROM webhook_events WHERE source='payment:fake_gateway' AND event_id=?`).bind(ev.eventId).first<any>()).n).toBe(1);

    const dup = await hook(ev);
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=?`).bind(row.id).first<any>()).n).toBe(1);
    // sự kiện khác cho cùng đơn đã thanh toán → bỏ qua, không tạo payment thứ hai
    const late = await hook({ ...ev, eventId: "evt-" + uuid() });
    expect(late.body.result).toBe("ignored:not_pending");
    expect((await db().prepare(`SELECT COUNT(*) n FROM payments WHERE order_id=?`).bind(row.id).first<any>()).n).toBe(1);
  });

  it("ignores amount mismatch, handles failed events, unknown orders and unsupported providers", async () => {
    const o = await gatewayOrder();
    const bad = await hook({ eventId: "evt-" + uuid(), orderCode: o.code, amount: 1000, status: "succeeded" });
    expect(bad.body.result).toBe("ignored:amount_mismatch");
    expect((await db().prepare(`SELECT status, payment_status FROM orders WHERE code=?`).bind(o.code).first<any>())).toMatchObject({ status: "awaiting_payment", payment_status: "pending" });
    const failed = await hook({ eventId: "evt-" + uuid(), orderCode: o.code, amount: 170000, status: "failed" });
    expect(failed.body.result).toBe("failed");
    // sự kiện đến trước khi đơn/intent tồn tại → 409 để cổng gửi lại (không ghi 'ignored' làm mất tiền)
    const early = await hook({ eventId: "evt-" + uuid(), orderCode: "DH-NOPE", amount: 1, status: "succeeded" });
    expect(early.status).toBe(409);
    expect((await call("POST", "/api/payments/gateway/vnpay/webhook", {})).status).toBe(501);
  });

  it("return endpoint only reports status for the order's token", async () => {
    const o = await gatewayOrder();
    const r = await call("GET", `/api/payments/gateway/fake_gateway/return?order=${o.code}&token=${o.trackingToken}`);
    expect(r.body).toEqual({ orderCode: o.code, paymentStatus: "pending", status: "awaiting_payment" });
    expect((await call("GET", `/api/payments/gateway/fake_gateway/return?order=${o.code}&token=bad`)).status).toBe(404);
  });
});

