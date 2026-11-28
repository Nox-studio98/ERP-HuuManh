import { Hono } from "hono";
import { z } from "zod";
import { AppError, conflict, notFound } from "../../../worker/lib/errors";
import { transitionStmts } from "../../../worker/services/online-orders";
import { cancelSettlement } from "../../../worker/services/online-ops";
import { releaseOrderStmts } from "../../../worker/services/reservations";
import { sysAuditStmt } from "../../../worker/services/sysaudit";
import { kickJobs } from "../../../worker/services/outbox";
import { cards } from "../lib/catalog";
import { CANCELLABLE, findByTracking, findOwnedOrder, orderView, ownedWhere, transferInfoFor } from "../lib/orderview";
import { loadAccount, requireAccount, sessionTokenOf } from "../lib/session";
import { baseUrl, enqueueByRef, parseBody } from "../lib/util";
import type { ShopBindings } from "../env";

export const orderRoutes = new Hono<ShopBindings>();

const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));

orderRoutes.get("/orders/track/:token", async (c) => {
  const o = await findByTracking(c.env.DB, c.req.param("token"), c.req.query("phone4"));
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  return c.json(await orderView(c.env.DB, o));
});

orderRoutes.post("/orders/track/:token/weight-decision", async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, z.object({ accept: z.boolean(), phone4: z.string().regex(/^\d{4}$/).optional() }));
  const o = await findByTracking(db, c.req.param("token"), b.phone4 ?? c.req.query("phone4"));
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (o.weight_adjust_status !== "pending_customer") throw conflict("no_pending_decision", "Đơn không có yêu cầu xác nhận khối lượng");
  const actor = { type: "customer" as const, id: o.shop_account_id ?? null };
  try {
    if (b.accept) {
      await db.batch([
        db.prepare(`UPDATE orders SET weight_adjust_status = 'accepted' WHERE id = ? AND weight_adjust_status = 'pending_customer'`).bind(o.id),
        db
          .prepare(`INSERT INTO order_events(order_id, status, note, actor_type, actor_id) VALUES (?, ?, 'Khách đồng ý giá theo khối lượng thực tế', 'customer', ?)`)
          .bind(o.id, o.status, actor.id),
        enqueueByRef(db, "notify.staff_new_order", "order", o.code, { orderCode: o.code, event: "weight_accepted" }),
      ]);
    } else {
      // S-4: dùng chung logic huỷ của ERP (đóng so_shortages, xoá chênh lệch cân, phí giao A-28, refund_due)
      const st = await cancelSettlement(db, o);
      await db.batch([
        ...(await releaseOrderStmts(db, o.id)),
        ...transitionStmts(db, o.id, o.status, "cancelled", actor, {
          note: "Khách không đồng ý giá theo khối lượng thực tế, đơn đã huỷ",
          extraSet: ["weight_adjust_status = 'rejected'", "cancel_reason = ?3", ...st.extraSet].join(", "),
          extraBinds: ["Khách từ chối chênh lệch khối lượng", ...st.extraBinds],
        }),
        st.closeShortages,
        db.prepare(`UPDATE payment_intents SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).bind(o.id),
        enqueueByRef(db, "notify.order_status", "order", o.code, { orderCode: o.code, status: "cancelled", accountId: o.shop_account_id ?? null, link: `${baseUrl(c)}/track/${o.tracking_token}` }),
      ]);
    }
  } catch (e) {
    if (isCheckFail(e)) throw conflict("invalid_transition", "Đơn vừa thay đổi trạng thái, vui lòng tải lại");
    throw e;
  }
  const fresh = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(o.id).first<any>();
  try { await kickJobs(c.env as never, "order", o.id); } catch { /* cron quét lại */ }
  return c.json(await orderView(db, fresh));
});

// ===== khách đăng nhập =====
orderRoutes.get("/me/orders", requireAccount, async (c) => {
  const a = c.get("account")!;
  const w = ownedWhere(a);
  const { results } = await c.env.DB.prepare(`SELECT o.* FROM orders o WHERE (${w.sql}) ORDER BY o.id DESC LIMIT 100`).bind(...w.binds).all<any>();
  return c.json(await Promise.all(results.map((o) => orderView(c.env.DB, o))));
});

orderRoutes.get("/me/orders/:code", requireAccount, async (c) => {
  const o = await findOwnedOrder(c.env.DB, c.get("account")!, c.req.param("code"));
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  return c.json(await orderView(c.env.DB, o));
});

orderRoutes.post("/me/orders/:code/cancel", requireAccount, async (c) => {
  const db = c.env.DB;
  const a = c.get("account")!;
  const o = await findOwnedOrder(db, a, c.req.param("code"));
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (o.channel !== "online" || !CANCELLABLE.includes(o.status))
    throw conflict("not_cancellable", "Đơn không thể huỷ ở trạng thái hiện tại, vui lòng liên hệ cửa hàng", { status: o.status });
  const paid = o.payment_status === "paid" || o.payment_status === "partially_refunded";
  const st = await cancelSettlement(db, o); // S-4: dùng chung logic huỷ của ERP
  try {
    await db.batch([
      ...(await releaseOrderStmts(db, o.id)),
      ...transitionStmts(db, o.id, o.status, "cancelled", { type: "customer", id: a.id }, {
        note: "Khách huỷ đơn",
        internalNote: paid ? "Đơn đã thanh toán trước khi khách huỷ: cần hoàn tiền cho khách" : undefined,
        extraSet: ["cancel_reason = ?3", ...st.extraSet].join(", "),
        extraBinds: ["Khách tự huỷ", ...st.extraBinds],
      }),
      st.closeShortages,
      db.prepare(`UPDATE payment_intents SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'`).bind(o.id),
      ...(paid ? [sysAuditStmt(db, { action: "shop.order_cancel_refund_needed", entity: "order", entityId: o.code, after: { paymentStatus: o.payment_status, total: o.total } })] : []),
      enqueueByRef(db, "notify.order_status", "order", o.code, { orderCode: o.code, status: "cancelled", accountId: a.id, link: `${baseUrl(c)}/track/${o.tracking_token}` }),
    ]);
  } catch (e) {
    if (isCheckFail(e)) throw conflict("invalid_transition", "Đơn vừa thay đổi trạng thái, vui lòng tải lại");
    throw e;
  }
  try { await kickJobs(c.env as never, "order", o.id); } catch { /* cron quét lại */ }
  const fresh = await db.prepare(`SELECT * FROM orders WHERE id = ?`).bind(o.id).first<any>();
  return c.json(await orderView(db, fresh));
});

/** M8-07: trả các dòng của đơn cũ theo giá/tồn hiện tại để đưa vào giỏ. */
orderRoutes.post("/me/orders/:code/reorder", requireAccount, async (c) => {
  const db = c.env.DB;
  const o = await findOwnedOrder(db, c.get("account")!, c.req.param("code"));
  if (!o) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  const lines = (
    await db
      .prepare(
        `SELECT ol.product_id, ol.unit, COALESCE(ol.ordered_qty_milli, ol.qty_milli) AS q,
                COALESCE((SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = ol.product_id AND pu.unit = ol.unit), 1000) AS factor, p.name
           FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`,
      )
      .bind(o.id)
      .all<any>()
  ).results;
  const ids = [...new Set(lines.map((l) => l.product_id))];
  const live = ids.length ? await cards(db, { channel: "online", groupId: c.get("account")!.customerGroupId, customerId: c.get("account")!.customerId, where: [`p.id IN (${ids.map((_, i) => `?${5 + i}`).join(",")})`], binds: ids }) : [];
  const byId = new Map(live.map((p) => [p.id, p]));
  const items: unknown[] = [];
  const unavailable: unknown[] = [];
  for (const l of lines) {
    const p = byId.get(l.product_id);
    if (!p) {
      unavailable.push({ productId: l.product_id, name: l.name });
      continue;
    }
    items.push({ productId: p.id, slug: p.slug, name: p.name, unit: l.unit, qty: l.q / l.factor, unitPrice: p.price, imageUrl: p.imageUrl, inStock: p.inStock, stepMilli: p.stepMilli });
  }
  return c.json({ items, unavailable });
});

// ===== thanh toán chuyển khoản =====
orderRoutes.get("/payments/:orderCode/transfer", async (c) => {
  const db = c.env.DB;
  const code = c.req.param("orderCode");
  const o = await db.prepare(`SELECT * FROM orders WHERE code = ? AND channel = 'online'`).bind(code).first<any>();
  let allowed = false;
  const token = c.req.query("token");
  if (o && token && o.tracking_token && token.length === o.tracking_token.length) allowed = token === o.tracking_token;
  if (o && !allowed) {
    const t = sessionTokenOf(c);
    const a = t ? await loadAccount(c.env, t) : null;
    allowed = !!a && o.shop_account_id === a.id;
  }
  if (!o || !allowed) throw notFound("order_not_found", "Không tìm thấy đơn hàng");
  if (o.payment_status === "paid") throw conflict("already_paid", "Đơn đã được thanh toán");
  const info = await transferInfoFor(db, o);
  if (!info) throw conflict("no_pending_transfer", "Đơn không có yêu cầu chuyển khoản đang chờ");
  if (info.expiresAt && info.expiresAt < new Date().toISOString()) throw conflict("intent_expired", "Yêu cầu chuyển khoản đã hết hạn");
  if (!info.accountNo) throw new AppError(409, "payment_method_unavailable", "Chuyển khoản tạm thời chưa khả dụng");
  return c.json(info);
});
