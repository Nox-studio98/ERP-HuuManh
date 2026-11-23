import { auditStmt } from "../lib/audit";
import { nextCode } from "../lib/codes";
import { vnDate } from "../lib/time";
import { addDays } from "./debt";
import { getSettingInt } from "./settings";
import type { Ctx } from "./b2b-orders";

export interface InvoiceLineIn {
  orderLineId: number;
  productId: number;
  description: string;
  unit: string; // đơn vị chính (qtyMilli tính theo đơn vị này)
  qtyMilli: number; // âm với hoá đơn điều chỉnh giảm
  unitPrice: number;
  amount: number; // âm với hoá đơn điều chỉnh giảm
}

/** Job outbox theo mã hoá đơn (hoá đơn chưa có id khi dựng batch). Cùng bảng/định dạng với outbox.enqueueJobStmt. */
export function enqueueJobByInvoiceCode(db: D1Database, type: "einvoice.issue" | "einvoice.adjust", invoiceCode: string) {
  return db
    .prepare(`INSERT INTO integration_jobs(type, ref_type, ref_id, payload_json) SELECT ?, 'invoice', id, '{}' FROM invoices WHERE code = ?`)
    .bind(type, invoiceCode);
}

/**
 * Dựng statements tạo hoá đơn bán / điều chỉnh (kèm dòng, job HĐĐT, audit). Gộp vào batch của nghiệp vụ gọi.
 * Hoá đơn gốc: due_date = issue_date + payment_terms_days của khách. Điều chỉnh: kế thừa hạn của hoá đơn gốc.
 */
export async function invoiceStmts(
  c: Ctx,
  p: {
    kind: "sale" | "adjustment";
    customerId: number;
    orderId: number;
    deliveryId?: number | null;
    originalInvoiceId?: number | null;
    dueDate?: string;
    lines: InvoiceLineIn[];
    note?: string;
  },
) {
  const db = c.env.DB;
  const user = c.get("user");
  const cu = await db.prepare(`SELECT name, tax_code, email, billing_address, payment_terms_days FROM customers WHERE id = ?`).bind(p.customerId).first<any>();
  const addr = !cu?.billing_address
    ? await db.prepare(`SELECT a.address FROM orders o JOIN customer_addresses a ON a.id = o.address_id WHERE o.id = ?`).bind(p.orderId).first<{ address: string }>()
    : null;
  const vatBp = await getSettingInt(db, "invoice.vat_rate_bp", 0);
  const auto = (await getSettingInt(db, "einvoice.auto_issue_b2b", 1)) === 1;
  const issueDate = vnDate();
  const dueDate = p.dueDate ?? addDays(issueDate, cu?.payment_terms_days ?? 0);
  const subtotal = p.lines.reduce((s, l) => s + l.amount, 0);
  const vat = Math.round((subtotal * vatBp) / 10000);
  const total = subtotal + vat;
  const code = await nextCode(db, "HDB");
  const jobType = p.kind === "adjustment" ? "einvoice.adjust" : "einvoice.issue";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO invoices(code, kind, original_invoice_id, customer_id, order_id, delivery_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total,
                              einvoice_status, buyer_name, buyer_tax_code, buyer_address, buyer_email, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        code, p.kind, p.originalInvoiceId ?? null, p.customerId, p.orderId, p.deliveryId ?? null, issueDate, dueDate, subtotal, vatBp, vat, total,
        auto ? "queued" : "none", cu?.name ?? null, cu?.tax_code ?? null, cu?.billing_address ?? addr?.address ?? null, cu?.email ?? null, p.note ?? null, user.id,
      ),
    ...p.lines.map((l) =>
      db
        .prepare(
          `INSERT INTO invoice_lines(invoice_id, order_line_id, product_id, description, unit, qty_milli, unit_price, amount)
           VALUES ((SELECT id FROM invoices WHERE code = ?), ?,?,?,?,?,?,?)`,
        )
        .bind(code, l.orderLineId, l.productId, l.description, l.unit, l.qtyMilli, l.unitPrice, l.amount),
    ),
  ];
  if (auto) stmts.push(enqueueJobByInvoiceCode(db, jobType, code));
  stmts.push(auditStmt(c, { action: p.kind === "adjustment" ? "invoice.adjustment" : "invoice.create", entity: "invoice", entityId: code, after: { total, orderId: p.orderId, dueDate } }));
  return { code, stmts, subtotal, vat, total, dueDate, issueDate };
}
