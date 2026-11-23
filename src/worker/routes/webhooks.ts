import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppBindings } from "../env";
import { AppError, notFound } from "../lib/errors";
import {
  FRESCO_SOURCE, createFrescoOrder, frescoOrderSchema, frescoPayloadSchema, isFrescoEnabled, verifyFrescoSignature,
} from "../services/fresco";
import { sysAudit } from "../services/sysaudit";

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
      await sysAudit(db, { action: "fresco.webhook_rejected", entity: "webhook", after: { reason: (e as AppError).code, ip: c.req.header("cf-connecting-ip") ?? null } });
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
