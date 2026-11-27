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
  o: { userId: number | null; fundId: number; amount?: number; ref?: string | null; bankTxnId?: number | null; audit: D1PreparedStatement; system?: boolean; extra?: D1PreparedStatement[] },
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
    ...(o.extra ?? []), // vd. SePay: gắn sự kiện giao dịch vào đúng batch này
  ];
  if (o.bankTxnId) {
    rest.unshift(db.prepare(`UPDATE bank_transactions SET status='matched', matched_type='order', matched_id=? WHERE id=? AND status='unmatched'`).bind(order.id, o.bankTxnId));
    rest.unshift(assertStmt(db, "bank.match", `SELECT status = 'unmatched' FROM bank_transactions WHERE id = ?`, [o.bankTxnId]));
  }
  const paidSet = `payment_status = ?3, paid_total = paid_total + ?4`;
  let stmts: D1PreparedStatement[];
  if (order.status === "awaiting_payment") {
    const t = transitionStmts(db, order.id, "awaiting_payment", "new", o.system ? { type: "system" } : { type: "staff", id: o.userId }, { note: "Đã nhận thanh toán", extraSet: paidSet, extraBinds: ["paid", amount] });
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

/** Số tiền khách đã trả ròng (đã trừ hoàn) và phương thức/quỹ gốc (dòng thu đầu tiên) — chỉ để hiển thị/kiểm tra tổng. */
export async function paidNet(db: D1Database, orderId: number) {
  const s = await db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE order_id=? AND status='confirmed'`).bind(orderId).first<{ s: number }>();
  const first = await db.prepare(`SELECT method, fund_id FROM payments WHERE order_id=? AND status='confirmed' AND amount>0 ORDER BY id LIMIT 1`).bind(orderId).first<{ method: string; fund_id: number | null }>();
  return { net: s?.s ?? 0, method: first?.method ?? "transfer", fundId: first?.fund_id ?? null };
}

export type RefundLine = { method: string; fundId: number | null; amount: number };

/** B-N2: số còn có thể hoàn của TỪNG dòng thu gốc (cùng hình thức + quỹ), theo thứ tự thu; COD chưa thu thì không có dòng nào. */
async function refundableByLine(db: D1Database, orderId: number): Promise<RefundLine[]> {
  const { results } = await db
    .prepare(
      `SELECT method, fund_id, SUM(amount) AS net, MIN(CASE WHEN amount > 0 THEN id END) AS first_id
         FROM payments WHERE order_id = ? AND status = 'confirmed' GROUP BY method, fund_id HAVING SUM(amount) > 0 ORDER BY first_id`,
    )
    .bind(orderId)
    .all<{ method: string; fund_id: number | null; net: number }>();
  return results.map((r) => ({ method: r.method, fundId: r.fund_id, amount: r.net }));
}

/** Chia `amount` cần hoàn lên các dòng thu gốc, mỗi dòng không quá số còn lại của chính nó. */
export async function allocateRefund(db: D1Database, orderId: number, amount: number): Promise<RefundLine[]> {
  let left = amount;
  const out: RefundLine[] = [];
  for (const l of await refundableByLine(db, orderId)) {
    if (left <= 0) break;
    const take = Math.min(l.amount, left);
    out.push({ ...l, amount: take });
    left -= take;
  }
  return out;
}

/**
 * B-N3: hoàn TIỀN MẶT của đơn giao tại quầy (pos_shift_id) → ca nào chịu. Ca tạo đơn còn mở → ca đó (trả NULL, `cashFormula` tự gom);
 * ca tạo đơn đã chốt → ca đang mở của người hoàn; không có ca mở → NULL (kế toán hoàn qua quỹ như luồng A-14, không đụng ca nào).
 */
export async function cashRefundShift(db: D1Database, orderId: number, userId: number): Promise<{ shiftId: number | null; assertShift: number | null }> {
  const o = await db.prepare(`SELECT o.pos_shift_id, s.status FROM orders o LEFT JOIN shifts s ON s.id = o.pos_shift_id WHERE o.id = ?`).bind(orderId).first<{ pos_shift_id: number | null; status: string | null }>();
  if (!o?.pos_shift_id) return { shiftId: null, assertShift: null };
  if (o.status === "open") return { shiftId: null, assertShift: o.pos_shift_id };
  const cur = await db.prepare(`SELECT id FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(userId).first<{ id: number }>();
  return { shiftId: cur?.id ?? null, assertShift: cur?.id ?? null };
}

/** Câu lệnh ghi các dòng hoàn (payments âm, đúng hình thức + quỹ từng dòng gốc) kèm chốt chặn từng dòng. */
export function refundLineStmts(db: D1Database, orderId: number, lines: RefundLine[], ref: string, cashShiftId: number | null): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const l of lines) {
    stmts.push(
      assertStmt(db, "order.refund_line", `SELECT COALESCE(SUM(amount), 0) >= ? FROM payments WHERE order_id = ? AND status = 'confirmed' AND method = ? AND fund_id IS ?`, [l.amount, orderId, l.method, l.fundId]),
      db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id, ref, status, refund_shift_id) VALUES (?,?,?,?,?, 'confirmed', ?)`).bind(orderId, l.method, -l.amount, l.fundId, ref, l.method === "cash" ? cashShiftId : null),
    );
  }
  return stmts;
}

/**
 * A-14: nghĩa vụ hoàn tiền (CHƯA có dòng quỹ): số cần hoàn = tiền đã thu ròng − phần đã ghi nghĩa vụ (`keep`), tối đa `cap`.
 * Huỷ/trả hàng (orders.online.manage) chỉ ghi `orders.refund_due`; tiền ra khỏi quỹ do người có finance.write bấm /refund (refundOrder).
 * Đơn COD chưa thu (không có payments dương) → 0, không cần hoàn.
 */
export async function refundObligation(db: D1Database, orderId: number, keep = 0, cap = Number.POSITIVE_INFINITY) {
  const p = await paidNet(db, orderId);
  return Math.max(0, Math.min(p.net - keep, cap));
}

/** Hoàn tiền: các dòng payments âm theo TỪNG dòng thu gốc + cập nhật payment_status (đặt vào extraSet của transitionStmts, bind từ ?3). */
export async function refundPlan(db: D1Database, orderId: number, total: number, keep = 0, cap = Number.POSITIVE_INFINITY, ref = "refund", userId = 0) {
  const p = await paidNet(db, orderId);
  const amount = Math.max(0, Math.min(p.net - keep, cap));
  if (p.net <= 0 || amount <= 0) return null;
  const lines = await allocateRefund(db, orderId, amount);
  if (lines.reduce((s, l) => s + l.amount, 0) !== amount) return null; // dòng thu không đủ (dữ liệu lệch): không hoàn
  const full = amount >= p.net;
  const sh = await cashRefundShift(db, orderId, userId);
  return {
    amount,
    lines,
    // Chốt chặn (audit #4): tiền còn lại (đã trả − đã hoàn) phải còn đủ tại lúc ghi; hoàn đôi → state_changed 409
    guard: assertStmt(db, "order.refund", `SELECT COALESCE(SUM(amount), 0) >= ? FROM payments WHERE order_id = ? AND status = 'confirmed'`, [p.net, orderId]),
    stmts: [
      ...(sh.assertShift ? [assertStmt(db, "order.refund.shift_open", `SELECT status = 'open' FROM shifts WHERE id = ?`, [sh.assertShift])] : []),
      ...refundLineStmts(db, orderId, lines, ref, sh.shiftId),
    ],
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
