import { vnDate } from "../lib/time";

/**
 * Mô hình công nợ (nguồn sự thật cho M4/M5/báo cáo):
 *  - Hoá đơn bán `invoices` kind='sale'|'replacement' là khoản phải thu. Hoá đơn kind='adjustment' (tổng âm hoặc dương)
 *    trỏ original_invoice_id và cộng vào khoản gốc — không phải dòng nợ riêng.
 *  - Còn nợ của 1 hoá đơn = total + Σ total các hoá đơn điều chỉnh của nó − Σ debt_allocations.amount
 *    (chỉ allocations của payment/adjustment còn status 'posted' — phiếu đã đảo không còn tác dụng).
 *  - Số dư khách = Σ còn nợ các hoá đơn open − tiền đã trả chưa gạch (số dư có, EC-24).
 *  - Phải trả NCC: tương tự với supplier_bills (không có hoá đơn điều chỉnh; điều chỉnh bằng debt_adjustments).
 * Tất cả là SQL thuần để dùng được trong báo cáo.
 */

/** Biểu thức SQL: số còn nợ của hoá đơn alias `i`. */
export const INVOICE_OUTSTANDING_SQL = `(i.total
  + COALESCE((SELECT SUM(a.total) FROM invoices a WHERE a.original_invoice_id = i.id AND a.kind = 'adjustment' AND a.status = 'open'), 0)
  - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x
               LEFT JOIN debt_payments xp ON xp.id = x.payment_id
               LEFT JOIN debt_adjustments xd ON xd.id = x.adjustment_id
              WHERE x.invoice_id = i.id AND (xp.status = 'posted' OR xd.status = 'posted')), 0))`;

/** Biểu thức SQL: số còn phải trả của hoá đơn mua alias `b`. */
export const BILL_OUTSTANDING_SQL = `(b.total - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x
               LEFT JOIN debt_payments xp ON xp.id = x.payment_id
               LEFT JOIN debt_adjustments xd ON xd.id = x.adjustment_id
              WHERE x.bill_id = b.id AND (xp.status = 'posted' OR xd.status = 'posted')), 0))`;

export interface PartnerDebtStatus {
  balance: number;          // còn nợ ròng (đã trừ tiền trả trước chưa gạch); âm = khách đang có số dư có
  outstanding: number;      // Σ còn nợ các hoá đơn
  unapplied: number;        // tiền đã thu/chi + điều chỉnh chưa gạch vào hoá đơn
  overdueAmount: number;
  overdueCount: number;
  oldestOverdueDays: number;
  creditLimit: number;
  available: number;        // creditLimit − balance (có thể âm)
}

export async function customerDebtStatus(db: D1Database, customerId: number, today = vnDate()): Promise<PartnerDebtStatus> {
  const r = await db
    .prepare(
      `WITH inv AS (
         SELECT i.id, i.due_date, ${INVOICE_OUTSTANDING_SQL} AS os
           FROM invoices i
          WHERE i.customer_id = ?1 AND i.status = 'open' AND i.kind IN ('sale','replacement')
       )
       SELECT
         COALESCE((SELECT SUM(os) FROM inv WHERE os > 0), 0) AS outstanding,
         COALESCE((SELECT SUM(os) FROM inv WHERE os > 0 AND due_date < ?2), 0) AS overdue_amount,
         (SELECT COUNT(*) FROM inv WHERE os > 0 AND due_date < ?2) AS overdue_count,
         COALESCE((SELECT MIN(due_date) FROM inv WHERE os > 0 AND due_date < ?2), NULL) AS oldest_due,
         COALESCE((SELECT SUM(p.amount) - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x JOIN debt_payments p2 ON p2.id = x.payment_id
                                                     WHERE p2.partner_type='customer' AND p2.partner_id=?1 AND p2.direction='in' AND p2.status='posted'), 0)
                     FROM debt_payments p WHERE p.partner_type='customer' AND p.partner_id=?1 AND p.direction='in' AND p.status='posted'), 0) AS unapplied_pay,
         COALESCE((SELECT SUM(d.amount) - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x JOIN debt_adjustments d2 ON d2.id = x.adjustment_id
                                                     WHERE d2.partner_type='customer' AND d2.partner_id=?1 AND d2.status='posted'), 0)
                     FROM debt_adjustments d WHERE d.partner_type='customer' AND d.partner_id=?1 AND d.status='posted'), 0) AS unapplied_adj,
         (SELECT credit_limit FROM customers WHERE id = ?1) AS credit_limit`,
    )
    .bind(customerId, today)
    .first<{ outstanding: number; overdue_amount: number; overdue_count: number; oldest_due: string | null; unapplied_pay: number; unapplied_adj: number; credit_limit: number }>();
  const outstanding = r?.outstanding ?? 0;
  const unapplied = (r?.unapplied_pay ?? 0) + (r?.unapplied_adj ?? 0);
  const balance = outstanding - unapplied;
  const creditLimit = r?.credit_limit ?? 0;
  const oldestOverdueDays = r?.oldest_due ? Math.round((Date.parse(today) - Date.parse(r.oldest_due)) / 86400_000) : 0;
  return {
    balance,
    outstanding,
    unapplied,
    overdueAmount: r?.overdue_amount ?? 0,
    overdueCount: r?.overdue_count ?? 0,
    oldestOverdueDays,
    creditLimit,
    available: creditLimit - balance,
  };
}

/** Trạng thái đơn sỉ đã cam kết hàng/giá nhưng CHƯA lập hoá đơn → chưa nằm trong công nợ nhưng vẫn là rủi ro tín dụng. */
export const OPEN_B2B_STATUSES = ["new", "confirmed", "preparing", "shipping"] as const;

/**
 * Tổng giá trị các đơn sỉ đang mở (chưa có hoá đơn bán) của khách, trừ đơn `excludeOrderId` (đơn đang kiểm tra).
 * Đơn 'new' chỉ tính nếu tạo TRƯỚC đơn đang xét (id nhỏ hơn) — nếu không hai đơn 'new' sẽ chặn lẫn nhau.
 */
export async function openB2bExposure(db: D1Database, customerId: number, excludeOrderId = 0, statuses: readonly string[] = OPEN_B2B_STATUSES) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(o.total), 0) AS s FROM orders o
        WHERE o.customer_id = ? AND o.channel = 'b2b' AND o.kind = 'sale' AND o.status IN (${statuses.map(() => "?").join(",")}) AND o.id <> ?
          AND (o.status <> 'new' OR ? = 0 OR o.id < ?)
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.order_id = o.id AND i.kind = 'sale' AND i.status = 'open')`,
    )
    .bind(customerId, ...statuses, excludeOrderId, excludeOrderId, excludeOrderId)
    .first<{ s: number }>();
  return r?.s ?? 0;
}

/**
 * Kiểm tra hạn mức trước khi tạo/giữ hàng đơn sỉ (EC-23, M4-04, M5-05):
 * chặn nếu có nợ quá hạn hoặc balance + các đơn đang mở chưa xuất hoá đơn + giá trị đơn mới > hạn mức.
 * (Audit #9: trước đây bỏ qua đơn đang mở → nhiều đơn nhỏ cùng vượt hạn mức.) Chỉ chủ (b2b.credit_override) duyệt tay.
 * `exposure` = tổng đơn đang mở (trừ đơn đang xét) đã dùng để so — confirm dùng nó để chốt chặn đồng thời trong batch.
 */
export async function checkCredit(db: D1Database, customerId: number, newOrderAmount: number, excludeOrderId = 0) {
  const s = await customerDebtStatus(db, customerId);
  const exposure = await openB2bExposure(db, customerId, excludeOrderId);
  const reasons: string[] = [];
  if (s.overdueCount > 0) reasons.push("overdue");
  if (s.balance + exposure + newOrderAmount > s.creditLimit) reasons.push("over_limit");
  return { ok: reasons.length === 0, reasons, status: s, openOrders: exposure };
}

export async function supplierDebtStatus(db: D1Database, supplierId: number, today = vnDate()) {
  const r = await db
    .prepare(
      `WITH b AS (SELECT b.id, b.due_date, ${BILL_OUTSTANDING_SQL} AS os FROM supplier_bills b WHERE b.supplier_id = ?1 AND b.status = 'open')
       SELECT COALESCE((SELECT SUM(os) FROM b WHERE os > 0), 0) AS outstanding,
              COALESCE((SELECT SUM(os) FROM b WHERE os > 0 AND due_date < ?2), 0) AS overdue_amount,
              (SELECT COUNT(*) FROM b WHERE os > 0 AND due_date < ?2) AS overdue_count,
              COALESCE((SELECT SUM(p.amount) FROM debt_payments p WHERE p.partner_type='supplier' AND p.partner_id=?1 AND p.direction='out' AND p.status='posted'), 0)
              - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x JOIN debt_payments p ON p.id = x.payment_id
                           WHERE p.partner_type='supplier' AND p.partner_id=?1 AND p.status='posted'), 0) AS unapplied`,
    )
    .bind(supplierId, today)
    .first<{ outstanding: number; overdue_amount: number; overdue_count: number; unapplied: number }>();
  return {
    outstanding: r?.outstanding ?? 0,
    unapplied: r?.unapplied ?? 0,
    balance: (r?.outstanding ?? 0) - (r?.unapplied ?? 0),
    overdueAmount: r?.overdue_amount ?? 0,
    overdueCount: r?.overdue_count ?? 0,
  };
}

/** Cộng N ngày cho chuỗi YYYY-MM-DD. */
export const addDays = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
