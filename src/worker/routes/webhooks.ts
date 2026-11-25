import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppBindings } from "../env";
import { AppError, notFound } from "../lib/errors";
import {
  FRESCO_SOURCE, createFrescoOrder, frescoOrderSchema, frescoPayloadSchema, isFrescoEnabled, verifyFrescoSignature,
} from "../services/fresco";
import { sysAudit } from "../services/sysaudit";
import { ingestTransaction, verifySepayRequest, type SepayTx } from "../services/sepay";
import { z } from "zod";

/** Webhook công khai (mount NGOÀI /api/v1, không có phiên đăng nhập — xác thực bằng chữ ký HMAC). */
export const webhookRoutes = new Hono<AppBindings>();

webhookRoutes.post(
  "/fresco/webhook",
  bodyLimit({ maxSize: 256 * 1024, onError: () => { throw new AppError(422, "payload_too_large", "Nội dung quá lớn"); } }),
  async (c) => {
    const db = c.env.DB;
    if (!(await isFrescoEnabled(db))) throw notFound("not_found", "Không tìm thấy");
    const secret = c.env.FRESCO_WEBHOOK_SECRET;
    if (!secret) throw new AppError(500, "webhook_not_configured", "Chưa cấu hình khoá webhook");

    const raw = await c.req.text();
    try {
      await verifyFrescoSignature(secret, raw, c.req.header("x-fresco-signature"), c.req.header("x-fresco-timestamp"));
    } catch (e) {
      // Chống làm ngập audit_log bằng chữ ký sai: ghi tối đa 1 dòng/phút (còn lại chỉ log)
      const since = new Date(Date.now() - 60_000).toISOString();
      const recent = await db.prepare(`SELECT 1 AS x FROM audit_log WHERE action = 'fresco.webhook_rejected' AND at >= ? LIMIT 1`).bind(since).first();
      if (!recent) await sysAudit(db, { action: "fresco.webhook_rejected", entity: "webhook", after: { reason: (e as AppError).code, ip: c.req.header("cf-connecting-ip") ?? null } });
      else console.warn("[fresco] webhook bị từ chối:", (e as AppError).code);
      throw e;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new AppError(400, "invalid_json", "Nội dung không phải JSON hợp lệ");
    }
    const evt = frescoPayloadSchema.parse(json);

    // Idempotency: ghi sự kiện trước; trùng → trả 200 duplicate
    const ins = await db
      .prepare(`INSERT OR IGNORE INTO webhook_events(source, event_id, payload_json) VALUES (?,?,?)`)
      .bind(FRESCO_SOURCE, evt.eventId, raw)
      .run();
    if (!ins.meta.changes) return c.json({ ok: true, duplicate: true });

    try {
      if (evt.type !== "order.created") {
        await db.prepare(`UPDATE webhook_events SET result=? WHERE source=? AND event_id=?`).bind("ignored", FRESCO_SOURCE, evt.eventId).run();
        return c.json({ ok: true, ignored: true });
      }
      const data = frescoOrderSchema.parse(evt.data);
      const r = await createFrescoOrder(c.env, data);
      await db.prepare(`UPDATE webhook_events SET result=? WHERE source=? AND event_id=?`).bind(JSON.stringify(r), FRESCO_SOURCE, evt.eventId).run();
      return c.json({ ok: true, order: { id: r.orderId, code: r.code, status: r.status, duplicate: r.duplicate, warnings: r.warnings } });
    } catch (e) {
      // xử lý lỗi → xoá dấu idempotency để Fresco gửi lại được
      await db.prepare(`DELETE FROM webhook_events WHERE source=? AND event_id=?`).bind(FRESCO_SOURCE, evt.eventId).run();
      throw e;
    }
  },
);

// ---------------------------------------------------------------- SePay (xác nhận chuyển khoản): POST /api/integrations/sepay/webhook
const sepayPayload = z.object({
  id: z.number().int().positive(),
  gateway: z.string().max(60).optional().default(""),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  accountNumber: z.string().max(40),
  subAccount: z.string().nullish(),
  code: z.string().max(60).nullish(),
  content: z.string().max(1000).nullish(),
  transferType: z.string().max(10),
  description: z.string().max(1000).nullish(),
  transferAmount: z.number().int().nonnegative().max(10_000_000_000),
  accumulated: z.number().optional(),
  referenceCode: z.string().max(100).nullish(),
});

webhookRoutes.post(
  "/sepay/webhook",
  bodyLimit({ maxSize: 64 * 1024, onError: () => { throw new AppError(422, "payload_too_large", "Nội dung quá lớn"); } }),
  async (c) => {
    const raw = await c.req.text(); // chữ ký tính trên bytes gốc, KHÔNG parse rồi serialize lại
    try {
      await verifySepayRequest(c.env.SEPAY_WEBHOOK_SECRET, raw, c.req.header("x-sepay-signature"), c.req.header("x-sepay-timestamp"));
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "sepay_webhook_rejected", code: (e as AppError).code }));
      throw e;
    }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new AppError(400, "invalid_json", "Nội dung không phải JSON hợp lệ"); }
    const p = sepayPayload.parse(json);
    const tx: SepayTx = {
      id: p.id, apiId: null, date: p.transactionDate, account: p.accountNumber, gateway: p.gateway, code: p.code ? p.code : null,
      type: p.transferType, amount: p.transferAmount, ref: p.referenceCode ?? "", content: p.content ?? p.description ?? "",
    };
    const v = await ingestTransaction(c.env, tx, "webhook", raw);
    return c.json({ success: v.success }, 200);
  },
);
