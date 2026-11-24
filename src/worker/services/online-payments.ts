import type { Context } from "hono";
import type { AppBindings, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError, conflict } from "../lib/errors";
import { enqueueJobStmt, kickJobs } from "./outbox";
import { transitionStmts } from "./online-orders";
import { releaseOrderStmts } from "./reservations";
import { sysAuditStmt } from "./sysaudit";
import { assertStmt } from "./guard";

/** Chuẩn hoá để so khớp nội dung chuyển khoản: bỏ ký tự không phải chữ/số, in hoa. */
export const normTransfer = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const isCheckFail = (e: unknown) => /CHECK constraint failed/i.test(String((e as Error)?.message ?? ""));

/** Guard dùng chung cho thao tác ghi trên đơn không đổi trạng thái (pack...): rollback nếu trạng thái đã đổi. */
export function guardStmts(db: D1Database, orderId: number, status: string): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db.prepare(`INSERT INTO order_transition_guard(order_id, ok) SELECT ?1, CASE WHEN status = ?2 THEN 1 ELSE 0 END FROM orders WHERE id = ?1`).bind(orderId, status),
    db.prepare(`DELETE FROM order_transition_guard WHERE order_id = ?`).bind(orderId),
  ];
}

export const notifyJob = (db: D1Database, orderId: number, payload: Record<string, unknown>) =>
  enqueueJobStmt(db, "notify.order_status", "order", orderId, payload);

/** Chạy batch; CHECK của guard / tồn kho → 409 order_changed nếu trạng thái đã đổi giữa lúc đọc và ghi. */
export async function runOrderBatch(db: D1Database, orderId: number, expectedFrom: string, stmts: D1PreparedStatement[]) {
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isCheckFail(e)) {
      const cur = await db.prepare(`SELECT status FROM orders WHERE id=?`).bind(orderId).first<{ status: string }>();
      if (cur && cur.status !== expectedFrom) throw conflict("order_changed", "Đơn vừa được người khác thay đổi, vui lòng tải lại", { status: cur.status });
      throw conflict("insufficient_stock", "Tồn kho vừa thay đổi, vui lòng thử lại");
    }
    throw e;
  }
}

interface PaidOrder { id: number; code: string; status: string; total: number; payment_status: string; payment_method: string | null }

export async function bankFundId(db: D1Database, storeId = 1) {
  const f = await db.prepare(`SELECT id FROM funds WHERE type='bank' AND active=1 ORDER BY (store_id IS ?) DESC, id LIMIT 1`).bind(storeId).first<{ id: number }>();
  if (!f) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ ngân hàng");
  return f.id;
}

/**
 * EC-05: xác nhận tiền về → payments (quỹ ngân hàng) + intent succeeded + (awaiting_payment → new), gói trong MỘT batch.
 * Dùng chung cho /online-orders/:id/mark-paid và tự khớp sao kê. `audit` do người gọi dựng (user hoặc hệ thống).
 */
export async function markOrderPaid(
  env: Env,
  order: PaidOrder,
  o: { userId: number | null; fundId: number; amount?: number; ref?: string | null; bankTxnId?: number | null; audit: D1PreparedStatement },
) {
  const db = env.DB;
  if (order.payment_status === "paid") throw conflict("already_paid", "Đơn đã được ghi nhận thanh toán");
  if (order.payment_method !== "transfer" && order.payment_method !== "gateway") throw conflict("not_prepaid", "Đơn không thanh toán trước (COD)");
  if (!["awaiting_payment", "new", "confirmed", "preparing"].includes(order.status)) throw conflict("not_payable", "Đơn đã huỷ/đã giao, không ghi nhận thanh toán");
  const amount = o.amount ?? order.total;
  // Chốt chặn (audit #4): hai lần ghi nhận tiền đồng thời không được cộng paid_total hai lần
  const notPaidYet = assertStmt(db, "order.mark_paid", `SELECT payment_status <> 'paid' AND status = ? FROM orders WHERE id = ?`, [order.status, order.id]);
  const payIns = db
    .prepare(
      `INSERT INTO payments(order_id, method, amount, fund_id, ref, status)
       SELECT id, ?2, ?3, ?4, ?5, 'confirmed' FROM orders WHERE id = ?1 AND payment_status <> 'paid'`,
    )
    .bind(order.id, order.payment_method === "gateway" ? "ewallet" : "transfer", amount, o.fundId, o.ref ?? null);
  const rest: D1PreparedStatement[] = [
    db.prepare(`UPDATE payment_intents SET status='succeeded', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE order_id=? AND status='pending'`).bind(order.id),
    notifyJob(db, order.id, { status: "new", event: "paid" }),
    o.audit,
  ];
  if (o.bankTxnId) {
    rest.unshift(db.prepare(`UPDATE bank_transactions SET status='matched', matched_type='order', matched_id=? WHERE id=? AND status='unmatched'`).bind(order.id, o.bankTxnId));
    rest.unshift(assertStmt(db, "bank.match", `SELECT status = 'unmatched' FROM bank_transactions WHERE id = ?`, [o.bankTxnId]));
  }
  const paidSet = `payment_status = ?3, paid_total = paid_total + ?4`;
  let stmts: D1PreparedStatement[];
  if (order.status === "awaiting_payment") {
    const t = transitionStmts(db, order.id, "awaiting_payment", "new", { type: "staff", id: o.userId }, { note: "Đã nhận thanh toán", extraSet: paidSet, extraBinds: ["paid", amount] });
    stmts = [notPaidYet, t[0], payIns, ...t.slice(1), ...rest];
  } else {
    stmts = [
      notPaidYet,
      ...guardStmts(db, order.id, order.status).slice(0, 1),
      payIns,
      db.prepare(`UPDATE orders SET payment_status='paid', paid_total = paid_total + ?2 WHERE id=?1`).bind(order.id, amount),
      db.prepare(`DELETE FROM order_transition_guard WHERE order_id = ?`).bind(order.id),
      ...rest,
    ];
  }
  await runOrderBatch(db, order.id, order.status, stmts);
  await kickJobs(env, "order", order.id);
}

/**
 * Nhập sao kê: nội dung chứa mã đơn (DH-20261123-0001 hoặc DH202611230001, hoặc nội dung CK của intent) và số tiền ĐÚNG
 * bằng intent pending → ghi nhận thanh toán. Khớp 0 hoặc >1 đơn → false (để người xử lý tay).
 */
export async function matchOnlineOrder(c: Context<AppBindings>, txn: { id: number; fund_id: number; amount: number; description: string; bank_ref: string }): Promise<boolean> {
  const db = c.env.DB;
  if (txn.amount <= 0 || !/DH/i.test(txn.description ?? "")) return false;
  const desc = normTransfer(txn.description);
  const { results } = await db
    .prepare(
      `SELECT o.id, o.code, o.status, o.total, o.payment_status, o.payment_method, pi.transfer_content AS tc
         FROM payment_intents pi JOIN orders o ON o.id = pi.order_id
        WHERE pi.status='pending' AND pi.amount = ?1 AND o.status='awaiting_payment' AND o.payment_status <> 'paid'`,
    )
    .bind(txn.amount)
    .all<PaidOrder & { tc: string | null }>();
  const hits = results.filter((r) => desc.includes(normTransfer(r.code)) || (r.tc && normTransfer(r.tc).length >= 8 && desc.includes(normTransfer(r.tc))));
  const uniq = [...new Map(hits.map((h) => [h.id, h])).values()];
  if (uniq.length !== 1) return false;
  const ord = uniq[0];
  try {
    await markOrderPaid(c.env, ord, {
      userId: c.get("user")?.id ?? null,
      fundId: txn.fund_id,
      amount: txn.amount,
      ref: txn.bank_ref,
      bankTxnId: txn.id,
      audit: auditStmt(c, { action: "online_order.paid_by_bank_match", entity: "order", entityId: ord.id, after: { code: ord.code, amount: txn.amount, bankTxnId: txn.id } }),
    });
    return true;
  } catch {
    return false;
  }
}

/** Số tiền khách đã trả ròng (đã trừ hoàn) và phương thức/quỹ gốc để hoàn. */
export async function paidNet(db: D1Database, orderId: number) {
  const s = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE order_id=? AND status='confirmed'`).bind(orderId).first<{ s: number }>();
  const first = await db.prepare(`SELECT method, fund_id FROM payments WHERE order_id=? AND status='confirmed' AND amount>0 ORDER BY id LIMIT 1`).bind(orderId).first<{ method: string; fund_id: number | null }>();
  return { net: s?.s ?? 0, method: first?.method ?? "transfer", fundId: first?.fund_id ?? null };
}

/** Hoàn tiền: dòng payments âm cùng phương thức/quỹ + cập nhật payment_status (đặt vào extraSet của transitionStmts, bind từ ?3). */
export async function refundPlan(db: D1Database, orderId: number, total: number, keep = 0) {
  const p = await paidNet(db, orderId);
  const amount = Math.max(0, Math.min(p.net, p.net - keep));
  if (p.net <= 0 || amount <= 0) return null;
  const full = amount >= p.net;
  return {
    amount,
    // Chốt chặn (audit #4): tiền còn lại (đã trả − đã hoàn) phải còn đủ tại lúc ghi; hoàn đôi → state_changed 409
    guard: assertStmt(db, "order.refund", `SELECT COALESCE(SUM(amount), 0) >= ? FROM payments WHERE order_id = ? AND status = 'confirmed'`, [p.net, orderId]),
    stmt: db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status) VALUES (?,?,?,?,?, 'confirmed')`).bind(orderId, p.method, -amount, p.fundId, "refund"),
    status: full ? "refunded" : "partially_refunded",
    totalRef: total,
  };
}

/** Cron mỗi 5 phút: huỷ đơn awaiting_payment quá hạn giữ (online.hold_minutes_transfer hoặc intent hết hạn), nhả tồn, thông báo. */
export async function cancelExpiredAwaitingPayment(env: Env, now = new Date()) {
  const db = env.DB;
  const hold = Number((await db.prepare(`SELECT value FROM settings WHERE key='online.hold_minutes_transfer'`).first<{ value: string }>())?.value);
  const cutoff = new Date(now.getTime() - (Number.isFinite(hold) && hold > 0 ? hold : 30) * 60_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT o.id, o.code FROM orders o
        WHERE o.channel IN ('online','social') AND o.status='awaiting_payment'
          AND (o.created_at <= ?1 OR EXISTS (SELECT 1 FROM payment_intents pi WHERE pi.order_id=o.id AND pi.status='pending' AND pi.expires_at IS NOT NULL AND pi.expires_at <= ?2))
        LIMIT 100`,
    )
    .bind(cutoff, now.toISOString())
    .all<{ id: number; code: string }>();
  let cancelled = 0;
  for (const o of results) {
    try {
      const release = await releaseOrderStmts(db, o.id);
      await db.batch([
        ...transitionStmts(db, o.id, "awaiting_payment", "cancelled", { type: "system", id: null }, {
          note: "Đơn tự huỷ do quá hạn thanh toán",
          extraSet: "cancel_reason = ?3",
          extraBinds: ["Quá hạn thanh toán"],
        }),
        ...release,
        db.prepare(`UPDATE payment_intents SET status='expired' WHERE order_id=? AND status='pending'`).bind(o.id),
        notifyJob(db, o.id, { status: "cancelled" }),
        sysAuditStmt(db, { action: "online_order.expired", entity: "order", entityId: o.id, after: { code: o.code } }),
      ]);
      cancelled++;
      await kickJobs(env, "order", o.id);
    } catch {
      /* đơn vừa được thanh toán/huỷ ở nơi khác: guard rollback, bỏ qua */
    }
  }
  return cancelled;
}
