import { vnDate } from "../lib/time";

/**
 * Sao kê công nợ phải trả của MỘT nhà cung cấp theo khoảng ngày (ngày VN). Dùng cho cổng NCC (src/shop/worker/routes/ncc.ts).
 * Quy ước như `GET /debts/statements/supplier/:id` của ERP: debit = làm tăng số dư phải trả (hoá đơn mua),
 * credit = làm giảm (thanh toán, chiết khấu, xoá nợ, trả hàng, cấn trừ). Khác ERP: `return_credit` của NCC là bút toán GIẢM nợ
 * (trả hàng NCC gạch vào hoá đơn mua) nên ghi bên credit — số dư cuối khớp `supplierDebtStatus().balance`.
 * Chỉ trả dữ liệu chứng từ (mã, ngày, số tiền, loại) — không có ghi chú/lý do nội bộ, quỹ, người lập.
 */
export type StatementDocType = "bill" | "payment" | "discount" | "write_off" | "return_credit" | "offset" | "opening_balance";
export interface StatementLine { date: string; docType: StatementDocType; docCode: string; debit: number; credit: number; balance: number; method?: string }
export interface SupplierStatement { from: string; to: string; opening: number; lines: StatementLine[]; closing: number; totals: { debit: number; credit: number }; truncated: boolean }

const MAX_LINES = 1000;

export async function supplierStatement(db: D1Database, supplierId: number, from: string, to: string): Promise<SupplierStatement> {
  interface Ev { date: string; ord: number; id: number; docType: StatementDocType; docCode: string; debit: number; credit: number; method?: string }
  const ev: Ev[] = [];
  const bills = (await db.prepare(`SELECT id, code, issue_date, total FROM supplier_bills WHERE supplier_id = ? AND status = 'open'`).bind(supplierId).all<any>()).results;
  for (const r of bills) ev.push({ date: r.issue_date, ord: 0, id: r.id, docType: "bill", docCode: r.code, debit: r.total, credit: 0 });
  const pays = (
    await db.prepare(`SELECT id, code, paid_at, amount, method FROM debt_payments WHERE partner_type = 'supplier' AND partner_id = ? AND direction = 'out' AND status = 'posted'`).bind(supplierId).all<any>()
  ).results;
  for (const r of pays) ev.push({ date: vnDate(new Date(r.paid_at)), ord: 1, id: r.id, docType: "payment", docCode: r.code, debit: 0, credit: r.amount, method: r.method });
  const adjs = (await db.prepare(`SELECT id, code, type, COALESCE(posted_at, created_at) AS created_at, amount FROM debt_adjustments WHERE partner_type = 'supplier' AND partner_id = ? AND status = 'posted'`).bind(supplierId).all<any>()).results;
  for (const r of adjs) ev.push({ date: vnDate(new Date(r.created_at)), ord: 2, id: r.id, docType: r.type, docCode: r.code, debit: 0, credit: r.amount });
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.ord - b.ord || a.id - b.id);

  let opening = 0;
  let bal = 0;
  const all: StatementLine[] = [];
  for (const e of ev) {
    if (e.date > to) continue;
    if (e.date < from) { opening += e.debit - e.credit; bal = opening; continue; }
    bal += e.debit - e.credit;
    all.push({ date: e.date, docType: e.docType, docCode: e.docCode, debit: e.debit, credit: e.credit, balance: bal, ...(e.method ? { method: e.method } : {}) });
  }
  const closing = all.length ? all[all.length - 1].balance : opening;
  const totals = all.reduce((t, l) => ({ debit: t.debit + l.debit, credit: t.credit + l.credit }), { debit: 0, credit: 0 });
  const truncated = all.length > MAX_LINES;
  return { from, to, opening, lines: truncated ? all.slice(-MAX_LINES) : all, closing, totals, truncated };
}
