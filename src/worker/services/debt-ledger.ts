import type { Context } from "hono";
import type { AppBindings } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError, notFound } from "../lib/errors";
import { nextCode, PREFIX } from "../lib/codes";
import { vnPeriod } from "../lib/time";
import { BILL_OUTSTANDING_SQL, INVOICE_OUTSTANDING_SQL } from "./debt";

type Ctx = Context<AppBindings>;
export type PartnerType = "customer" | "supplier";

export interface OpenDoc {
  kind: "invoice" | "bill";
  id: number;
  code: string;
  issueDate: string;
  dueDate: string;
  total: number;
  outstanding: number;
}

/** snake_case → camelCase cho cả hàng dữ liệu (hợp đồng Đợt 2). */
export function camel<T = any>(row: any): T {
  if (row == null || typeof row !== "object") return row;
  const out: any = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = v;
  return out;
}

/** Các hoá đơn/phiếu còn mở của đối tác, cũ nhất (due_date, id) trước. */
export async function openDocs(db: D1Database, partnerType: PartnerType, partnerId: number, includeSettled = false): Promise<OpenDoc[]> {
  const sql =
    partnerType === "customer"
      ? `SELECT 'invoice' AS kind, i.id, i.code, i.issue_date, i.due_date, i.total, ${INVOICE_OUTSTANDING_SQL} AS os
           FROM invoices i WHERE i.customer_id = ? AND i.status = 'open' AND i.kind IN ('sale','replacement') ORDER BY i.due_date, i.id`
      : `SELECT 'bill' AS kind, b.id, b.code, b.issue_date, b.due_date, b.total, ${BILL_OUTSTANDING_SQL} AS os
           FROM supplier_bills b WHERE b.supplier_id = ? AND b.status = 'open' ORDER BY b.due_date, b.id`;
  const { results } = await db.prepare(sql).bind(partnerId).all<any>();
  return results
    .filter((r) => includeSettled || r.os > 0)
    .map((r) => ({ kind: r.kind, id: r.id, code: r.code, issueDate: r.issue_date, dueDate: r.due_date, total: r.total, outstanding: r.os }));
}

export interface AllocInput {
  invoiceId?: number;
  billId?: number;
  amount: number;
}
export interface PlannedAlloc {
  doc: OpenDoc;
  amount: number;
}

/** Cũ nhất trước: gạch tối đa `amount`, phần dư trả về `leftover`. */
export function planOldestFirst(docs: OpenDoc[], amount: number) {
  let left = amount;
  const allocs: PlannedAlloc[] = [];
  for (const d of docs) {
    if (left <= 0) break;
    if (d.outstanding <= 0) continue;
    const a = Math.min(left, d.outstanding);
    allocs.push({ doc: d, amount: a });
    left -= a;
  }
  return { allocs, leftover: left };
}

/** Gạch theo chỉ định của client; không vượt còn nợ, không vượt tổng cần gạch. */
export function planExplicit(docs: OpenDoc[], items: AllocInput[], maxTotal: number) {
  const by = new Map<string, number>();
  for (const it of items) {
    if ((it.invoiceId == null) === (it.billId == null)) throw new AppError(422, "allocation_invalid", "Mỗi dòng gạch nợ phải có đúng một invoiceId hoặc billId");
    const key = it.invoiceId != null ? `invoice:${it.invoiceId}` : `bill:${it.billId}`;
    by.set(key, (by.get(key) ?? 0) + it.amount);
  }
  const allocs: PlannedAlloc[] = [];
  let sum = 0;
  for (const [key, amount] of by) {
    const doc = docs.find((d) => `${d.kind}:${d.id}` === key);
    if (!doc) throw new AppError(422, "allocation_invalid", "Hoá đơn không thuộc đối tác này hoặc đã huỷ", { target: key });
    if (amount > doc.outstanding) throw new AppError(422, "allocation_exceeds_outstanding", `Số gạch vượt số còn nợ của ${doc.code} (${doc.outstanding}đ)`, { target: key, outstanding: doc.outstanding });
    allocs.push({ doc, amount });
    sum += amount;
  }
  if (sum > maxTotal) throw new AppError(422, "allocation_exceeds_payment", `Tổng gạch ${sum}đ vượt số tiền có thể gạch (${maxTotal}đ)`);
  return { allocs, leftover: maxTotal - sum };
}

export function allocStmt(db: D1Database, doc: { kind: "invoice" | "bill"; id: number }, amount: number, by: { paymentCode?: string; paymentId?: number; adjustmentCode?: string; adjustmentId?: number }) {
  const inv = doc.kind === "invoice" ? doc.id : null;
  const bill = doc.kind === "bill" ? doc.id : null;
  if (by.paymentCode != null || by.paymentId != null) {
    return db
      .prepare(
        `INSERT INTO debt_allocations(payment_id, adjustment_id, invoice_id, bill_id, amount)
         VALUES (${by.paymentId != null ? "?" : "(SELECT id FROM debt_payments WHERE code = ?)"}, NULL, ?, ?, ?)`,
      )
      .bind(by.paymentId ?? by.paymentCode, inv, bill, amount);
  }
  return db
    .prepare(
      `INSERT INTO debt_allocations(payment_id, adjustment_id, invoice_id, bill_id, amount)
       VALUES (NULL, ${by.adjustmentId != null ? "?" : "(SELECT id FROM debt_adjustments WHERE code = ?)"}, ?, ?, ?)`,
    )
    .bind(by.adjustmentId ?? by.adjustmentCode, inv, bill, amount);
}

export async function categoryId(db: D1Database, codes: string[], direction: "in" | "out"): Promise<number> {
  for (const code of codes) {
    const r = await db.prepare(`SELECT id FROM cash_categories WHERE code = ? AND direction = ?`).bind(code, direction).first<{ id: number }>();
    if (r) return r.id;
  }
  throw new AppError(422, "category_not_found", `Chưa có khoản mục thu/chi ${codes[0]} trong danh mục`);
}

export function voucherStmt(
  db: D1Database,
  v: { code: string; direction: "in" | "out"; fundId: number; categoryId: number; amount: number; counterparty?: string | null; refType?: string | null; refId?: number | null; note?: string | null; userId: number; reversesId?: number | null },
) {
  return db
    .prepare(
      `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, reverses_id)
       VALUES (?,?,?,?,?,?,?,?, 'posted', ?,?,?,?,?)`,
    )
    .bind(v.code, v.direction, v.fundId, v.categoryId, v.amount, v.counterparty ?? null, v.refType ?? null, v.refId ?? null, vnPeriod(), v.note ?? null, v.userId, v.userId, v.reversesId ?? null);
}

export async function partnerInfo(db: D1Database, partnerType: PartnerType, partnerId: number) {
  const r = await db
    .prepare(partnerType === "customer" ? `SELECT id, code, name, linked_supplier_id FROM customers WHERE id = ?` : `SELECT id, code, name FROM suppliers WHERE id = ?`)
    .bind(partnerId)
    .first<{ id: number; code: string; name: string; linked_supplier_id?: number | null }>();
  if (!r) throw notFound("partner_not_found", partnerType === "customer" ? "Không tìm thấy khách hàng" : "Không tìm thấy nhà cung cấp");
  return r;
}

export interface PaymentInput {
  direction: "in" | "out";
  partnerType: PartnerType;
  partnerId: number;
  fundId: number;
  amount: number;
  method: "cash" | "transfer";
  ref?: string | null;
  paidAt?: string | null;
  note?: string | null;
  allocations?: AllocInput[];
  bankTxnId?: number | null;
}

export async function paymentResult(db: D1Database, paymentId: number) {
  const p = await db.prepare(`SELECT * FROM debt_payments WHERE id = ?`).bind(paymentId).first<any>();
  const { results } = await db.prepare(`SELECT id, invoice_id, bill_id, amount FROM debt_allocations WHERE payment_id = ? ORDER BY id`).bind(paymentId).all<any>();
  const allocated = results.reduce((s, r) => s + r.amount, 0);
  return { payment: camel(p), allocations: results.map(camel), unapplied: p.status === "posted" ? p.amount - allocated : 0 };
}

/** Thu/chi công nợ: debt_payments + cash_vouchers + debt_allocations + audit trong MỘT batch. Kỳ khoá → 423 (trigger). */
export async function createPayment(c: Ctx, input: PaymentInput) {
  const db = c.env.DB;
  const user = c.get("user");
  if ((input.direction === "in") !== (input.partnerType === "customer"))
    throw new AppError(422, "direction_mismatch", "Thu tiền áp dụng cho khách hàng, chi tiền áp dụng cho nhà cung cấp");
  const partner = await partnerInfo(db, input.partnerType, input.partnerId);
  const fund = await db.prepare(`SELECT id FROM funds WHERE id = ? AND active = 1`).bind(input.fundId).first();
  if (!fund) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại hoặc đã ngừng");
  const catId = await categoryId(db, input.direction === "in" ? ["THU_NO_KH", "BAN_HANG"] : ["TIEN_HANG"], input.direction);

  const docs = await openDocs(db, input.partnerType, input.partnerId, true);
  const plan = input.allocations?.length ? planExplicit(docs, input.allocations, input.amount) : planOldestFirst(docs.filter((d) => d.outstanding > 0), input.amount);

  const vCode = await nextCode(db, input.direction === "in" ? PREFIX.cashIn : PREFIX.cashOut);
  const pCode = await nextCode(db, input.direction === "in" ? "TNK" : "TTN");
  const paidAt = input.paidAt || new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    voucherStmt(db, {
      code: vCode, direction: input.direction, fundId: input.fundId, categoryId: catId, amount: input.amount, counterparty: partner.name,
      refType: "debt_payment", note: input.note ?? (input.direction === "in" ? `Thu nợ ${partner.name}` : `Trả nợ ${partner.name}`), userId: user.id,
    }),
    db
      .prepare(
        `INSERT INTO debt_payments(code, direction, partner_type, partner_id, fund_id, amount, method, ref, paid_at, cash_voucher_id, bank_txn_id, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?, (SELECT id FROM cash_vouchers WHERE code = ?), ?,?,?)`,
      )
      .bind(pCode, input.direction, input.partnerType, input.partnerId, input.fundId, input.amount, input.method, input.ref ?? null, paidAt, vCode, input.bankTxnId ?? null, input.note ?? null, user.id),
    db.prepare(`UPDATE cash_vouchers SET ref_id = (SELECT id FROM debt_payments WHERE code = ?) WHERE code = ?`).bind(pCode, vCode),
    ...plan.allocs.map((a) => allocStmt(db, a.doc, a.amount, { paymentCode: pCode })),
  ];
  if (input.bankTxnId)
    stmts.push(
      db
        .prepare(`UPDATE bank_transactions SET status='matched', matched_type=?, matched_id=? WHERE id = ? AND status = 'unmatched'`)
        .bind(input.partnerType, input.partnerId, input.bankTxnId),
    );
  stmts.push(
    auditStmt(c, {
      action: input.direction === "in" ? "debt.payment_in" : "debt.payment_out",
      entity: "debt_payment",
      entityId: pCode,
      after: { partnerType: input.partnerType, partnerId: input.partnerId, amount: input.amount, voucher: vCode, allocations: plan.allocs.map((a) => ({ [a.doc.kind]: a.doc.id, amount: a.amount })), unapplied: plan.leftover },
    }),
  );
  await db.batch(stmts);
  const row = await db.prepare(`SELECT id FROM debt_payments WHERE code = ?`).bind(pCode).first<{ id: number }>();
  return paymentResult(db, row!.id);
}

// ---------------------------------------------------------------- CSV
/** Tách CSV có ngoặc kép, BOM, CRLF; tự nhận dấu phân cách , ; hoặc tab. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [[",", 0], [";", 0], ["\t", 0]];
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ) for (const e of counts) if (e[0] === ch) e[1]++;
  }
  const delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

export const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function normDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

export function parseAmount(s: string): number | null {
  const neg = /^\s*[-(]/.test(s);
  const digits = s.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return neg ? -n : n;
}
