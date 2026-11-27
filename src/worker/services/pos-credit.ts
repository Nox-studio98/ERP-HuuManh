/**
 * POS-KV đợt B1 — bán nợ cho khách lẻ. Dùng lại mô hình công nợ có sẵn (docs/API-dot2.md "Mô hình công nợ"):
 *  - phần ghi nợ của đơn POS = 1 hoá đơn phải thu `invoices(kind='sale', order_id, customer_id)` + 1 dòng `payments(method='credit', fund_id NULL)`;
 *  - trả hàng / huỷ đơn → hoá đơn `adjustment` âm trỏ `original_invoice_id` (hoá đơn đã phát hành không sửa/xoá);
 *  - thu nợ / SePay `HDS` / tuổi nợ / sao kê dùng nguyên route công nợ.
 * File này chỉ dựng câu lệnh cho batch của route POS và đọc thông tin; không ghi riêng lẻ.
 */
import { buildVietQr } from "../../shop/worker/lib/vietqr";
import { vnDate } from "../lib/time";
import { addDays, INVOICE_OUTSTANDING_SQL } from "./debt";
import { ensurePayCode, sepayConfig } from "./sepay";
import { getSettingInt } from "./settings";

export async function creditSettings(db: D1Database) {
  return {
    enabled: (await getSettingInt(db, "pos.retail_credit_enabled", 0)) === 1,
    approvalVnd: await getSettingInt(db, "approval.pos_credit_vnd", 500_000),
    defaultTermsDays: await getSettingInt(db, "pos.retail_credit_default_terms_days", 7),
  };
}

/** Kỳ hạn nợ của khách lẻ: kỳ hạn riêng nếu > 0, không thì mặc định chung. */
export const creditTermsDays = (customerTerms: number | null | undefined, defaultDays: number) => (customerTerms && customerTerms > 0 ? customerTerms : defaultDays);

/** Tổng còn nợ dương của các hoá đơn bán đang mở của khách (cùng cách tính với hạn mức nợ). */
export const OPEN_DEBT_SQL = `COALESCE((SELECT SUM(os) FROM (SELECT ${INVOICE_OUTSTANDING_SQL} AS os FROM invoices i WHERE i.customer_id = ? AND i.status = 'open' AND i.kind IN ('sale','replacement')) WHERE os > 0), 0)`;

export async function openDebtOf(db: D1Database, customerId: number): Promise<number> {
  const r = await db.prepare(`SELECT ${OPEN_DEBT_SQL} AS d`).bind(customerId).first<{ d: number }>();
  return r?.d ?? 0;
}

/** Điều kiện (assertStmt, đặt ĐẦU batch): khách có hạn mức > 0 và nợ đang mở + phần ghi nợ ≤ hạn mức → hai quầy ghi nợ đồng thời chỉ một quầy qua. */
export function creditLimitGuard(customerId: number, amount: number) {
  return {
    sql: `SELECT c.credit_limit > 0 AND ${OPEN_DEBT_SQL} + ? <= c.credit_limit FROM customers c WHERE c.id = ?`,
    binds: [customerId, amount, customerId] as unknown[],
  };
}

/** INSERT hoá đơn ghi nợ của đơn POS (đơn nhận id sau khi tạo nháp nên truyền orderId). Mã hoá đơn do bên gọi cấp bằng nextCode(db, "HDB"). */
export function creditInvoiceStmt(db: D1Database, p: { code: string; orderId: number; customerId: number; customerName: string | null; amount: number; termsDays: number; userId: number; soldDate?: string; note?: string }) {
  const issue = p.soldDate ?? vnDate();
  return db
    .prepare(
      `INSERT INTO invoices(code, kind, customer_id, order_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, einvoice_status, buyer_name, note, created_by)
       VALUES (?, 'sale', ?, ?, ?, ?, ?, 0, 0, ?, 'not_required', ?, ?, ?)`,
    )
    .bind(p.code, p.customerId, p.orderId, issue, addDays(issue, p.termsDays), p.amount, p.amount, p.customerName, p.note ?? "Bán nợ tại quầy", p.userId);
}

/** Hoá đơn điều chỉnh GIẢM nợ (total âm) trỏ hoá đơn gốc — trả hàng/huỷ đơn có ghi nợ. Kế thừa hạn của hoá đơn gốc. */
export function creditAdjustmentStmt(db: D1Database, p: { code: string; original: { id: number; due_date: string }; orderId: number; customerId: number; customerName: string | null; amount: number; userId: number; note: string }) {
  return db
    .prepare(
      `INSERT INTO invoices(code, kind, original_invoice_id, customer_id, order_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, einvoice_status, buyer_name, note, created_by)
       VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?, 0, 0, ?, 'not_required', ?, ?, ?)`,
    )
    .bind(p.code, p.original.id, p.customerId, p.orderId, vnDate(), p.original.due_date, -p.amount, -p.amount, p.customerName, p.note, p.userId);
}

/** Hoá đơn ghi nợ (kind='sale') của một đơn POS, kèm còn nợ hiện tại; null nếu đơn không ghi nợ. */
export async function creditInvoiceOf(db: D1Database, orderId: number) {
  return db
    .prepare(
      `SELECT i.id, i.code, i.customer_id, i.total, i.issue_date, i.due_date, i.status, ${INVOICE_OUTSTANDING_SQL} AS os
         FROM invoices i WHERE i.order_id = ? AND i.kind = 'sale' AND i.status = 'open' ORDER BY i.id LIMIT 1`,
    )
    .bind(orderId)
    .first<{ id: number; code: string; customer_id: number; total: number; issue_date: string; due_date: string; status: string; os: number }>();
}

/**
 * Thông tin ghi nợ để in phiếu: số ghi nợ, còn nợ, hạn, mã thanh toán `HDS…` và chuỗi VietQR (số tiền = còn nợ).
 * Mã QR chỉ có khi đã bật SePay (luồng thu nợ tự gạch) và có tài khoản nhận tiền.
 */
export async function creditReceiptInfo(db: D1Database, orderId: number) {
  const inv = await creditInvoiceOf(db, orderId);
  if (!inv) return null;
  const cfg = await sepayConfig(db);
  const outstanding = Math.max(0, inv.os);
  let payCode: string | null = null;
  let qrPayload: string | null = null;
  if (outstanding > 0 && cfg.enabled && cfg.flow.b2b && cfg.bank.account) {
    payCode = await ensurePayCode(db, "b2b", inv.id);
    qrPayload = buildVietQr({ bankBin: cfg.bank.bin, accountNo: cfg.bank.account, amount: outstanding, content: payCode });
  }
  return { invoiceId: inv.id, invoiceCode: inv.code, amount: inv.total, outstanding, issueDate: inv.issue_date, dueDate: inv.due_date, payCode, qrPayload };
}
