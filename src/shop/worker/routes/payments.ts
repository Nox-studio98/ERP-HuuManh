import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../../../worker/lib/errors";
import { timingSafeEqual } from "../../../worker/lib/crypto";
import { transitionStmts } from "../../../worker/services/online-orders";
import { kickJobs } from "../../../worker/services/outbox";
import { sysAuditStmt } from "../../../worker/services/sysaudit";
import type { ShopBindings } from "../env";
import { enqueueByRef, httpError } from "../lib/util";

export const paymentRoutes = new Hono<ShopBindings>();

/**
 * Khung tích hợp cổng thanh toán thật.
 * TODO [Cần xác nhận]: chọn cổng (VNPay / MoMo / PayOS / ...), chữ ký, định dạng callback, đối soát — chưa triển khai.
 * Mỗi cổng hiện thực GatewayAdapter rồi đăng ký vào GATEWAYS; route bên dưới dùng chung quy trình idempotent.
 */
export interface GatewayEvent {
  eventId: string;
  orderCode: string;
  amount: number;
  status: "succeeded" | "failed";
}
export interface GatewayAdapter {
  provider: string;
  /** Xác thực chữ ký/timestamp của request webhook; ném AppError nếu không hợp lệ. Trả sự kiện đã chuẩn hoá. */
  verifyWebhook(rawBody: string, headers: Headers, env: ShopBindingsEnv): Promise<GatewayEvent>;
}
type ShopBindingsEnv = ShopBindings["Bindings"];

const FAKE = "fake_gateway";
const TOLERANCE_S = 300;

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => (/^[0-9a-f]+$/i.test(h) && h.length % 2 === 0 ? Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))) : new Uint8Array());

export async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

const FakeEventSchema = z.object({
  eventId: z.string().min(1).max(100),
  orderCode: z.string().min(1).max(40),
  amount: z.number().int().nonnegative(),
  status: z.enum(["succeeded", "failed"]),
});

/** Cổng giả lập cho dev/staging: HMAC-SHA256 (hex) của body thô bằng PAYMENT_WEBHOOK_SECRET; header x-signature + x-timestamp (giây). */
const fakeGateway: GatewayAdapter = {
  provider: FAKE,
  async verifyWebhook(raw, headers, env) {
    if (!env.PAYMENT_WEBHOOK_SECRET) throw httpError(503, "webhook_not_configured", "Chưa cấu hình PAYMENT_WEBHOOK_SECRET");
    const ts = Number(headers.get("x-timestamp"));
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) throw httpError(401, "bad_timestamp", "Timestamp webhook không hợp lệ hoặc quá hạn");
    const sig = fromHex((headers.get("x-signature") ?? "").trim());
    const want = fromHex(await hmacHex(env.PAYMENT_WEBHOOK_SECRET, raw));
    if (!sig.length || !timingSafeEqual(sig, want)) throw httpError(401, "bad_signature", "Chữ ký webhook không hợp lệ");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new AppError(400, "invalid_json", "Body webhook không phải JSON");
    }
    return FakeEventSchema.parse(json);
  },
};

const GATEWAYS: Record<string, GatewayAdapter> = { [FAKE]: fakeGateway };

paymentRoutes.post("/payments/gateway/:provider/webhook", async (c) => {
  const adapter = GATEWAYS[c.req.param("provider")];
  if (!adapter) throw new AppError(501, "gateway_not_supported", "Cổng thanh toán chưa được hỗ trợ");
  const db = c.env.DB;
  const raw = await c.req.text();
  const ev = await adapter.verifyWebhook(raw, c.req.raw.headers, c.env);
  const source = `payment:${adapter.provider}`;

  const dup = await db.prepare(`SELECT id FROM webhook_events WHERE source = ? AND event_id = ?`).bind(source, ev.eventId).first();
  if (dup) return c.json({ ok: true, duplicate: true });

  const record = (result: string) =>
    db.prepare(`INSERT INTO webhook_events(source, event_id, payload_json, result) VALUES (?,?,?,?)`).bind(source, ev.eventId, JSON.stringify({ orderCode: ev.orderCode, amount: ev.amount, status: ev.status }), result);

  const o = await db.prepare(`SELECT id, code, status, total, shop_account_id, tracking_token FROM orders WHERE code = ? AND channel = 'online'`).bind(ev.orderCode).first<any>();
  const intent = o
    ? await db.prepare(`SELECT id, amount, status FROM payment_intents WHERE order_id = ? AND provider = ? ORDER BY id DESC LIMIT 1`).bind(o.id, adapter.provider).first<any>()
    : null;
  let result = "processed";
  const stmts: D1PreparedStatement[] = [];
  if (!o || !intent) result = "ignored:no_intent";
  else if (intent.status !== "pending" || o.status !== "awaiting_payment") {
    result = "ignored:not_pending";
    stmts.push(sysAuditStmt(db, { action: "shop.payment_late", entity: "order", entityId: o.code, after: { eventId: ev.eventId, orderStatus: o.status, intentStatus: intent.status, amount: ev.amount } }));
  } else if (ev.status === "failed") {
    result = "failed";
    stmts.push(db.prepare(`UPDATE payment_intents SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'pending'`).bind(new Date().toISOString(), intent.id));
  } else if (ev.amount !== intent.amount) {
    result = "ignored:amount_mismatch";
    stmts.push(sysAuditStmt(db, { action: "shop.payment_amount_mismatch", entity: "order", entityId: o.code, after: { eventId: ev.eventId, expected: intent.amount, got: ev.amount } }));
  } else {
    const fund = await db.prepare(`SELECT id FROM funds WHERE type = 'bank' AND active = 1 ORDER BY id LIMIT 1`).first<{ id: number }>();
    const now = new Date().toISOString();
    stmts.push(
      db.prepare(`UPDATE payment_intents SET status = 'succeeded', completed_at = ? WHERE id = ? AND status = 'pending'`).bind(now, intent.id),
      db
        .prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?, 'transfer', ?, ?, ?, 'confirmed')`)
        .bind(o.id, ev.amount, fund?.id ?? null, `${adapter.provider}:${ev.eventId}`),
      ...transitionStmts(db, o.id, "awaiting_payment", "new", { type: "system" }, {
        note: "Đã nhận thanh toán",
        extraSet: "payment_status = 'paid', paid_total = ?3",
        extraBinds: [ev.amount],
      }),
      enqueueByRef(db, "notify.order_status", "order", o.code, { orderCode: o.code, status: "new", accountId: o.shop_account_id ?? null }),
      enqueueByRef(db, "notify.staff_new_order", "order", o.code, { orderCode: o.code, total: o.total, paid: true }),
    );
  }
  try {
    await db.batch([record(result), ...stmts]);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as Error)?.message))) return c.json({ ok: true, duplicate: true });
    throw e;
  }
  if (result === "processed" && o) {
    try { await kickJobs(c.env as never, "order", o.id); } catch { /* cron quét lại */ }
  }
  return c.json({ ok: true, result });
});

/** Người dùng quay lại từ cổng: chỉ báo trạng thái (không đổi gì); trạng thái thật do webhook quyết định. */
paymentRoutes.all("/payments/gateway/:provider/return", async (c) => {
  if (!GATEWAYS[c.req.param("provider")]) throw new AppError(501, "gateway_not_supported", "Cổng thanh toán chưa được hỗ trợ");
  const code = c.req.query("order") ?? "";
  const token = c.req.query("token") ?? "";
  const o = await c.env.DB.prepare(`SELECT code, payment_status, status FROM orders WHERE code = ? AND tracking_token = ? AND channel = 'online'`).bind(code, token).first<any>();
  if (!o) throw new AppError(404, "order_not_found", "Không tìm thấy đơn hàng");
  return c.json({ orderCode: o.code, paymentStatus: o.payment_status, status: o.status });
});

