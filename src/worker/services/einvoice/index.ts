import type { Env } from "../../env";
import { AppError } from "../../lib/errors";
import { FakeProvider } from "./fake";
import { MisaProvider, misaConfigFromEnv } from "./misa";
import type { EInvoiceDoc, EInvoiceProvider } from "./types";

export * from "./types";
export { FakeProvider } from "./fake";
export { MisaProvider, buildMisaPayload, misaConfigFromEnv } from "./misa";

export const misaConfigured = (env: Env) => misaConfigFromEnv(env) !== null;

/** Chọn nhà cung cấp theo setting `einvoice.provider` (fake | misa). */
export async function getProvider(env: Env): Promise<EInvoiceProvider> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='einvoice.provider'`).first<{ value: string }>();
  const name = row?.value ?? "fake";
  if (name === "misa") {
    const cfg = misaConfigFromEnv(env);
    if (!cfg) throw new AppError(422, "misa_not_configured", "Chưa cấu hình thông tin kết nối MISA");
    return new MisaProvider(cfg);
  }
  return new FakeProvider();
}

/** Đọc hoá đơn + dòng thành EInvoiceDoc. */
export async function loadInvoiceDoc(db: D1Database, invoiceId: number): Promise<(EInvoiceDoc & { status: string; einvoiceStatus: string; originalInvoiceId: number | null }) | null> {
  const i = await db.prepare(`SELECT * FROM invoices WHERE id = ?`).bind(invoiceId).first<any>();
  if (!i) return null;
  const { results } = await db.prepare(`SELECT description, unit, qty_milli, unit_price, amount FROM invoice_lines WHERE invoice_id = ? ORDER BY id`).bind(invoiceId).all<any>();
  return {
    id: i.id, code: i.code, kind: i.kind, issueDate: i.issue_date, subtotal: i.subtotal, vatRateBp: i.vat_rate_bp, vatAmount: i.vat_amount, total: i.total,
    buyerName: i.buyer_name, buyerTaxCode: i.buyer_tax_code, buyerAddress: i.buyer_address, buyerEmail: i.buyer_email, note: i.note,
    einvoiceNo: i.einvoice_no, einvoiceSeries: i.einvoice_series,
    lines: results.map((l) => ({ description: l.description, unit: l.unit, qtyMilli: l.qty_milli, unitPrice: l.unit_price, amount: l.amount })),
    status: i.status, einvoiceStatus: i.einvoice_status, originalInvoiceId: i.original_invoice_id,
  };
}
