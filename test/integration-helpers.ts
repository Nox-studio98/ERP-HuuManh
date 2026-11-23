import { testEnv } from "./helpers";

/** Chèn trực tiếp hoá đơn + 1 dòng (hoá đơn do Agent A tạo ở luồng thật). */
let seq = 0;

export async function insertInvoice(o: { kind?: string; original?: number | null; customerId?: number | null; due?: string; total?: number; einvoice?: string } = {}) {
  const n = ++seq + Math.floor(Math.random() * 1e6);
  const code = `HDB-T-${n}`;
  const total = o.total ?? 100000;
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(`INSERT INTO invoices(code, kind, original_invoice_id, customer_id, issue_date, due_date, subtotal, total, einvoice_status, buyer_name) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(code, o.kind ?? "sale", o.original ?? null, o.customerId ?? null, "2026-11-20", o.due ?? "2026-12-20", total, total, o.einvoice ?? "none", "Công ty Test"),
    testEnv.DB.prepare(`INSERT INTO invoice_lines(invoice_id, description, unit, qty_milli, unit_price, amount) SELECT id, 'Cam sành', 'kg', 2000, ?, ? FROM invoices WHERE code=?`).bind(total / 2, total, code),
  ]);
  return (await testEnv.DB.prepare(`SELECT id FROM invoices WHERE code=?`).bind(code).first<{ id: number }>())!.id;
}

