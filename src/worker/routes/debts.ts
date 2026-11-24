import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDate } from "../lib/time";
import { addDays, BILL_OUTSTANDING_SQL, INVOICE_OUTSTANDING_SQL } from "../services/debt";
import { enqueueJobStmt, kickJobs } from "../services/outbox";
import { registerApprovalHandler } from "../services/approval-registry";
import { matchOnlineOrder } from "../services/online-payments";
import { assertStmt } from "../services/guard";
import { getSettingInt } from "../services/settings";
import { guarded, parseBody } from "../services/http";
import {
  allocStmt, camel, categoryId, createPayment, normDate, openDocs, parseAmount, parseCsv, partnerInfo, paymentResult,
  planExplicit, planOldestFirst, toCsv, voucherStmt, type PartnerType,
} from "../services/debt-ledger";

export const debtRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const money = z.number().int().positive().max(10_000_000_000);
const allocItem = z.object({ invoiceId: z.number().int().positive().optional(), billId: z.number().int().positive().optional(), amount: money });
const partnerTypeEnum = z.enum(["customer", "supplier"]);
const lim = (c: Ctx) => Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

async function agingBounds(db: D1Database): Promise<[number, number, number]> {
  const r = await db.prepare(`SELECT value FROM settings WHERE key='debt.aging_buckets'`).first<{ value: string }>();
  const n = (r?.value ?? "30,60,90").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
  return [n[0] ?? 30, n[1] ?? 60, n[2] ?? 90];
}
type Buckets = { current: number; d1_30: number; d31_60: number; d61_90: number; over90: number };
const emptyBuckets = (): Buckets => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0 });
function bucketOf(overdueDays: number, b: [number, number, number]): keyof Buckets {
  if (overdueDays <= 0) return "current";
  if (overdueDays <= b[0]) return "d1_30";
  if (overdueDays <= b[1]) return "d31_60";
  if (overdueDays <= b[2]) return "d61_90";
  return "over90";
}

// ---------------------------------------------------------------- tổng hợp công nợ
interface DocRow { pid: number; id: number; code: string; issue_date: string; due_date: string; total: number; os: number }

async function allOpenDocs(db: D1Database, side: "receivable" | "payable"): Promise<DocRow[]> {
  const sql =
    side === "receivable"
      ? `SELECT i.customer_id pid, i.id, i.code, i.issue_date, i.due_date, i.total, ${INVOICE_OUTSTANDING_SQL} AS os
           FROM invoices i WHERE i.status='open' AND i.kind IN ('sale','replacement') AND i.customer_id IS NOT NULL ORDER BY i.due_date, i.id`
      : `SELECT b.supplier_id pid, b.id, b.code, b.issue_date, b.due_date, b.total, ${BILL_OUTSTANDING_SQL} AS os
           FROM supplier_bills b WHERE b.status='open' ORDER BY b.due_date, b.id`;
  return (await db.prepare(sql).all<DocRow>()).results.filter((r) => r.os > 0);
}

async function unappliedMap(db: D1Database, side: "receivable" | "payable") {
  const pt = side === "receivable" ? "customer" : "supplier";
  const m = new Map<number, number>();
  const pay = await db
    .prepare(
      `SELECT p.partner_id pid, SUM(p.amount - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x WHERE x.payment_id = p.id), 0)) u
         FROM debt_payments p WHERE p.partner_type = ? AND p.status = 'posted' GROUP BY p.partner_id`,
    )
    .bind(pt)
    .all<{ pid: number; u: number }>();
  for (const r of pay.results) m.set(r.pid, (m.get(r.pid) ?? 0) + r.u);
  if (side === "receivable") {
    const adj = await db
      .prepare(
        `SELECT d.partner_id pid, SUM(d.amount - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x WHERE x.adjustment_id = d.id), 0)) u
           FROM debt_adjustments d WHERE d.partner_type = 'customer' AND d.status = 'posted' GROUP BY d.partner_id`,
      )
      .all<{ pid: number; u: number }>();
    for (const r of adj.results) m.set(r.pid, (m.get(r.pid) ?? 0) + r.u);
  }
  return m;
}

async function summarize(c: Ctx, side: "receivable" | "payable") {
  const db = c.env.DB;
  const today = vnDate();
  const bounds = await agingBounds(db);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const overdueOnly = c.req.query("overdueOnly") === "1" || c.req.query("overdueOnly") === "true";
  const docs = await allOpenDocs(db, side);
  const un = await unappliedMap(db, side);
  const partners = (
    await db
      .prepare(side === "receivable" ? `SELECT id, code, name, credit_limit FROM customers` : `SELECT id, code, name FROM suppliers`)
      .all<{ id: number; code: string; name: string; credit_limit?: number }>()
  ).results;
  const items: any[] = [];
  const totals = { outstanding: 0, unapplied: 0, balance: 0, overdueAmount: 0 };
  for (const p of partners) {
    if (q && !`${p.name} ${p.code}`.toLowerCase().includes(q)) continue;
    const mine = docs.filter((d) => d.pid === p.id);
    const unapplied = un.get(p.id) ?? 0;
    if (!mine.length && !unapplied) continue;
    const buckets = emptyBuckets();
    let outstanding = 0, overdueAmount = 0, oldest = 0;
    for (const d of mine) {
      const od = daysBetween(d.due_date, today);
      outstanding += d.os;
      buckets[bucketOf(od, bounds)] += d.os;
      if (od > 0) { overdueAmount += d.os; oldest = Math.max(oldest, od); }
    }
    if (overdueOnly && overdueAmount <= 0) continue;
    const base: any = { outstanding, unapplied, balance: outstanding - unapplied, overdueAmount, oldestOverdueDays: oldest, buckets };
    totals.outstanding += outstanding; totals.unapplied += unapplied; totals.balance += base.balance; totals.overdueAmount += overdueAmount;
    if (side === "receivable") items.push({ customerId: p.id, customerCode: p.code, customerName: p.name, ...base, creditLimit: p.credit_limit ?? 0 });
    else
      items.push({
        supplierId: p.id, supplierCode: p.code, supplierName: p.name, ...base,
        bills: mine.map((d) => ({ id: d.id, code: d.code, issueDate: d.issue_date, dueDate: d.due_date, total: d.total, outstanding: d.os, overdueDays: Math.max(0, daysBetween(d.due_date, today)) })),
      });
  }
  items.sort((a, b) => b.balance - a.balance);
  return { items, nextCursor: null, totals };
}

debtRoutes.get("/debts/receivables", requirePerm("debt.view"), async (c) => c.json(await summarize(c, "receivable")));
debtRoutes.get("/debts/payables", requirePerm("debt.view"), async (c) => c.json(await summarize(c, "payable")));

debtRoutes.get("/debts/aging", requirePerm("debt.view"), async (c) => {
  const side = c.req.query("side") === "payable" ? "payable" : "receivable";
  const asOf = c.req.query("asOf") && /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("asOf")!) ? c.req.query("asOf")! : vnDate();
  const db = c.env.DB;
  const bounds = await agingBounds(db);
  const docs = await allOpenDocs(db, side);
  const names = new Map<number, string>(
    (await db.prepare(side === "receivable" ? `SELECT id, name FROM customers` : `SELECT id, name FROM suppliers`).all<{ id: number; name: string }>()).results.map((r) => [r.id, r.name]),
  );
  const totals = emptyBuckets();
  const items = docs
    .filter((d) => d.issue_date <= asOf)
    .map((d) => {
      const overdueDays = Math.max(0, daysBetween(d.due_date, asOf));
      const bucket = bucketOf(daysBetween(d.due_date, asOf), bounds);
      totals[bucket] += d.os;
      return { docType: side === "receivable" ? "invoice" : "bill", docId: d.id, docCode: d.code, partnerId: d.pid, partnerName: names.get(d.pid) ?? "", issueDate: d.issue_date, dueDate: d.due_date, total: d.total, outstanding: d.os, overdueDays, bucket };
    });
  return c.json({ side, asOf, items, nextCursor: null, totals, bounds });
});

// ---------------------------------------------------------------- hoá đơn mua (phải trả)
debtRoutes.get("/suppliers/:id/bills", requirePerm("debt.view"), async (c) => {
  const id = Number(c.req.param("id"));
  const cursor = Number(c.req.query("cursor")) || 0;
  const limit = lim(c);
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT b.*, ${BILL_OUTSTANDING_SQL} AS outstanding FROM supplier_bills b
          WHERE b.supplier_id = ?1 AND (?2 = 0 OR b.id < ?2) ORDER BY b.id DESC LIMIT ?3`,
      )
      .bind(id, cursor, limit + 1)
      .all<any>()
  ).results;
  const items = rows.slice(0, limit).map(camel);
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

debtRoutes.get("/bills/:id", requirePerm("debt.view"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const b = await db
    .prepare(`SELECT b.*, s.name AS supplier_name, d.code AS stock_doc_code, ${BILL_OUTSTANDING_SQL} AS outstanding FROM supplier_bills b
                JOIN suppliers s ON s.id = b.supplier_id LEFT JOIN stock_docs d ON d.id = b.stock_doc_id WHERE b.id = ?`)
    .bind(id)
    .first<any>();
  if (!b) throw notFound("bill_not_found", "Không tìm thấy hoá đơn mua");
  const { results } = await db
    .prepare(
      `SELECT x.id, x.amount, x.payment_id, x.adjustment_id, x.created_at, COALESCE(p.status, d.status) AS source_status, COALESCE(p.code, d.code) AS source_code
         FROM debt_allocations x LEFT JOIN debt_payments p ON p.id = x.payment_id LEFT JOIN debt_adjustments d ON d.id = x.adjustment_id
        WHERE x.bill_id = ? ORDER BY x.id`,
    )
    .bind(id)
    .all<any>();
  return c.json({ ...camel(b), allocations: results.map(camel) });
});

debtRoutes.post("/bills/:id/finalize", requirePerm("debt.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ supplierRef: z.string().trim().min(1).max(100), total: z.number().int().positive().optional(), vatAmount: z.number().int().min(0).max(10_000_000_000).optional(), reason: z.string().trim().max(300).optional() }));
  const db = c.env.DB;
  const b = await db.prepare(`SELECT * FROM supplier_bills WHERE id = ?`).bind(id).first<any>();
  if (!b) throw notFound("bill_not_found", "Không tìm thấy hoá đơn mua");
  if (!b.is_provisional) throw conflict("not_provisional", "Hoá đơn đã được chốt");
  if (b.status !== "open") throw conflict("bill_cancelled", "Hoá đơn đã huỷ");
  const newTotal = body.total ?? b.total;
  if (newTotal !== b.total && !body.reason) throw new AppError(422, "reason_required", "Chênh lệch giá khi chốt hoá đơn phải ghi lý do");
  const paid = await db.prepare(`SELECT COALESCE(SUM(x.amount),0) s FROM debt_allocations x LEFT JOIN debt_payments p ON p.id=x.payment_id LEFT JOIN debt_adjustments d ON d.id=x.adjustment_id
                                  WHERE x.bill_id = ? AND (p.status='posted' OR d.status='posted')`).bind(id).first<{ s: number }>();
  if (newTotal < (paid?.s ?? 0)) throw new AppError(422, "total_below_paid", "Tổng chốt nhỏ hơn số đã thanh toán");
  const newVat = body.vatAmount ?? b.vat_amount ?? 0; // B-07: VAT đầu vào, không vượt tổng hoá đơn
  if (newVat > newTotal) throw new AppError(422, "vat_exceeds_total", "VAT đầu vào không được lớn hơn tổng hoá đơn", { vatAmount: newVat, total: newTotal });
  const r = await db.batch([
    db.prepare(`UPDATE supplier_bills SET supplier_ref = ?, total = ?, vat_amount = ?, is_provisional = 0 WHERE id = ? AND is_provisional = 1`).bind(body.supplierRef, newTotal, newVat, id),
    auditStmt(c, { action: "bill.finalize", entity: "supplier_bill", entityId: id, before: { total: b.total, vat: b.vat_amount ?? 0, supplierRef: b.supplier_ref, provisional: true }, after: { total: newTotal, vat: newVat, supplierRef: body.supplierRef, provisional: false }, reason: body.reason }),
  ]);
  if (!r[0].meta.changes) throw conflict("not_provisional", "Hoá đơn đã được chốt");
  return c.json(camel(await db.prepare(`SELECT * FROM supplier_bills WHERE id = ?`).bind(id).first()));
});

// ---------------------------------------------------------------- thu / chi công nợ
const paymentSchema = z.object({
  direction: z.enum(["in", "out"]),
  partnerType: partnerTypeEnum,
  partnerId: z.number().int().positive(),
  fundId: z.number().int().positive(),
  amount: money,
  method: z.enum(["cash", "transfer"]),
  ref: z.string().max(100).optional(),
  paidAt: z.string().max(40).optional(),
  note: z.string().max(300).optional(),
  allocations: z.array(allocItem).max(200).optional(),
  bankTxnId: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

debtRoutes.post("/debts/payments", requirePerm("debt.write"), async (c) => {
  const body = await parseBody(c, paymentSchema);
  return c.json(await createPayment(c, body), 201);
});

debtRoutes.post("/debts/payments/:id/allocate", requirePerm("debt.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ allocations: z.array(allocItem).max(200).optional() }));
  const db = c.env.DB;
  const p = await db.prepare(`SELECT * FROM debt_payments WHERE id = ?`).bind(id).first<any>();
  if (!p) throw notFound("payment_not_found", "Không tìm thấy phiếu thu/chi công nợ");
  if (p.status !== "posted") throw conflict("payment_reversed", "Phiếu đã bị đảo");
  const cur = await paymentResult(db, id);
  if (cur.unapplied <= 0) throw conflict("nothing_to_allocate", "Phiếu đã gạch hết");
  const docs = await openDocs(db, p.partner_type, p.partner_id, true);
  const plan = body.allocations?.length ? planExplicit(docs, body.allocations, cur.unapplied) : planOldestFirst(docs.filter((d) => d.outstanding > 0), cur.unapplied);
  if (!plan.allocs.length) throw new AppError(422, "no_open_documents", "Không có hoá đơn còn nợ để gạch");
  const planned = plan.allocs.reduce((s, a) => s + a.amount, 0);
  await db.batch([
    // Chốt chặn (audit #5): phiếu còn 'posted' và số chưa gạch còn đủ — hai lần gạch đồng thời không vượt số tiền phiếu
    assertStmt(
      db,
      "debt.allocate",
      `SELECT status = 'posted' AND amount - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x WHERE x.payment_id = debt_payments.id), 0) >= ? FROM debt_payments WHERE id = ?`,
      [planned, id],
    ),
    ...plan.allocs.map((a) => allocStmt(db, a.doc, a.amount, { paymentId: id })),
    auditStmt(c, { action: "debt.allocate", entity: "debt_payment", entityId: id, after: { allocations: plan.allocs.map((a) => ({ [a.doc.kind]: a.doc.id, amount: a.amount })) } }),
  ]);
  return c.json(await paymentResult(db, id));
});

debtRoutes.post("/debts/payments/:id/reverse", requirePerm("debt.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }));
  const db = c.env.DB;
  const user = c.get("user");
  const p = await db.prepare(`SELECT * FROM debt_payments WHERE id = ?`).bind(id).first<any>();
  if (!p) throw notFound("payment_not_found", "Không tìm thấy phiếu thu/chi công nợ");
  if (p.status !== "posted") throw conflict("already_reversed", "Phiếu đã được đảo");
  // Chốt chặn (audit #6): đảo đồng thời — chỉ một request qua; phiếu thu/chi gốc cũng chỉ được đảo một lần (unique reverses_id → 409)
  const stmts: D1PreparedStatement[] = [assertStmt(db, "debt.reverse", `SELECT status = 'posted' FROM debt_payments WHERE id = ?`, [id])];
  if (p.cash_voucher_id) {
    const v = await db.prepare(`SELECT * FROM cash_vouchers WHERE id = ?`).bind(p.cash_voucher_id).first<any>();
    if (v && v.status === "posted") {
      const dir = v.direction === "in" ? "out" : "in";
      const code = await nextCode(db, dir === "in" ? PREFIX.cashIn : PREFIX.cashOut);
      stmts.push(voucherStmt(db, { code, direction: dir, fundId: v.fund_id, categoryId: v.category_id, amount: v.amount, counterparty: v.counterparty, refType: "debt_payment", refId: id, note: `Đảo phiếu ${v.code}: ${body.reason}`, userId: user.id, reversesId: v.id }));
    }
  }
  stmts.push(
    db.prepare(`UPDATE debt_payments SET status='reversed' WHERE id = ? AND status='posted'`).bind(id),
    db.prepare(`UPDATE bank_transactions SET status='unmatched', matched_type=NULL, matched_id=NULL WHERE id = ?`).bind(p.bank_txn_id ?? 0),
    auditStmt(c, { action: "debt.payment_reverse", entity: "debt_payment", entityId: id, before: { status: "posted" }, after: { status: "reversed" }, reason: body.reason }),
  );
  await db.batch(stmts); // kỳ khoá → trigger period_locked → 423, toàn bộ rollback
  return c.json(await paymentResult(db, id));
});

debtRoutes.get("/debts/payments", requirePerm("debt.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.partnerType === "customer" || q.partnerType === "supplier") { conds.push(`p.partner_type = ?`); params.push(q.partnerType); }
  if (q.partnerId) { conds.push(`p.partner_id = ?`); params.push(Number(q.partnerId)); }
  if (q.direction === "in" || q.direction === "out") { conds.push(`p.direction = ?`); params.push(q.direction); }
  if (q.status === "posted" || q.status === "reversed") { conds.push(`p.status = ?`); params.push(q.status); }
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { conds.push(`substr(p.paid_at,1,10) >= ?`); params.push(q.from); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { conds.push(`substr(p.paid_at,1,10) <= ?`); params.push(q.to); }
  if (q.cursor) { conds.push(`p.id < ?`); params.push(Number(q.cursor)); }
  const limit = lim(c);
  const rows = (await c.env.DB.prepare(
    `SELECT p.*, CASE p.partner_type WHEN 'customer' THEN (SELECT name FROM customers WHERE id = p.partner_id) ELSE (SELECT name FROM suppliers WHERE id = p.partner_id) END AS partner_name
     FROM debt_payments p ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY p.id DESC LIMIT ?`,
  ).bind(...params, limit + 1).all<any>()).results;
  const items = rows.slice(0, limit).map(camel);
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

// ---------------------------------------------------------------- điều chỉnh: chiết khấu, xoá nợ, cấn trừ
const adjSchema = z.object({
  type: z.enum(["discount", "write_off", "offset"]),
  partnerType: partnerTypeEnum,
  partnerId: z.number().int().positive(),
  amount: money,
  reason: z.string().trim().min(3).max(300),
  invoiceId: z.number().int().positive().optional(),
  billId: z.number().int().positive().optional(),
});

async function adjDocs(db: D1Database, partnerType: PartnerType, partnerId: number, invoiceId?: number, billId?: number) {
  const docs = (await openDocs(db, partnerType, partnerId)).filter((d) => d.outstanding > 0);
  if (invoiceId != null || billId != null) {
    const t = docs.find((d) => (invoiceId != null ? d.kind === "invoice" && d.id === invoiceId : d.kind === "bill" && d.id === billId));
    if (!t) throw new AppError(422, "allocation_invalid", "Hoá đơn không thuộc đối tác này hoặc đã hết nợ");
    return [t];
  }
  return docs;
}

debtRoutes.post("/debts/adjustments", requirePerm("debt.write"), async (c) => {
  const body = await parseBody(c, adjSchema);
  const db = c.env.DB;
  const user = c.get("user");
  const partner = await partnerInfo(db, body.partnerType, body.partnerId);

  if (body.type === "offset") {
    // M5-09: cấn trừ khách ↔ NCC cùng đối tác
    let customerId: number, supplierId: number;
    if (body.partnerType === "customer") {
      if (!partner.linked_supplier_id) throw new AppError(422, "no_linked_supplier", "Khách hàng chưa liên kết nhà cung cấp để cấn trừ");
      customerId = body.partnerId; supplierId = partner.linked_supplier_id;
    } else {
      const cu = await db.prepare(`SELECT id FROM customers WHERE linked_supplier_id = ?`).bind(body.partnerId).first<{ id: number }>();
      if (!cu) throw new AppError(422, "no_linked_customer", "Nhà cung cấp chưa liên kết khách hàng để cấn trừ");
      customerId = cu.id; supplierId = body.partnerId;
    }
    const cDocs = await openDocs(db, "customer", customerId);
    const sDocs = await openDocs(db, "supplier", supplierId);
    const cOut = cDocs.reduce((s, d) => s + d.outstanding, 0);
    const sOut = sDocs.reduce((s, d) => s + d.outstanding, 0);
    if (body.amount > Math.min(cOut, sOut)) throw new AppError(422, "offset_exceeds_outstanding", `Số cấn trừ vượt công nợ của một bên (phải thu ${cOut}đ, phải trả ${sOut}đ)`, { receivable: cOut, payable: sOut });
    const cPlan = planOldestFirst(cDocs, body.amount);
    const sPlan = planOldestFirst(sDocs, body.amount);
    const cCode = await nextCode(db, "DCN");
    const sCode = await nextCode(db, "DCN");
    const ins = (code: string, pt: PartnerType, pid: number) =>
      db.prepare(`INSERT INTO debt_adjustments(code, type, partner_type, partner_id, amount, status, reason, created_by) VALUES (?, 'offset', ?, ?, ?, 'posted', ?, ?)`).bind(code, pt, pid, body.amount, body.reason, user.id);
    await db.batch([
      ins(cCode, "customer", customerId),
      ins(sCode, "supplier", supplierId),
      ...cPlan.allocs.map((a) => allocStmt(db, a.doc, a.amount, { adjustmentCode: cCode })),
      ...sPlan.allocs.map((a) => allocStmt(db, a.doc, a.amount, { adjustmentCode: sCode })),
      auditStmt(c, { action: "debt.offset", entity: "debt_adjustment", entityId: cCode, after: { customerId, supplierId, amount: body.amount, supplierAdjustment: sCode }, reason: body.reason }),
    ]);
    const { results } = await db.prepare(`SELECT * FROM debt_adjustments WHERE code IN (?, ?) ORDER BY id`).bind(cCode, sCode).all<any>();
    return c.json({ adjustments: results.map(camel), status: "posted" }, 201);
  }

  // discount / write_off
  const docs = await adjDocs(db, body.partnerType, body.partnerId, body.invoiceId, body.billId);
  const total = docs.reduce((s, d) => s + d.outstanding, 0);
  if (body.amount > total) throw new AppError(422, "adjustment_exceeds_outstanding", `Số điều chỉnh vượt số còn nợ (${total}đ)`, { outstanding: total });
  const threshold = await getSettingInt(db, "approval.writeoff_vnd", 0);
  const needApproval = body.amount > threshold && !can(user.role, "debt.approve");
  const code = await nextCode(db, "DCN");
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO debt_adjustments(code, type, partner_type, partner_id, amount, status, reason, created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(code, body.type, body.partnerType, body.partnerId, body.amount, needApproval ? "pending_approval" : "posted", body.reason, user.id),
  ];
  if (needApproval) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by)
           VALUES ('debt_adjustment.post','debt_adjustment', CAST((SELECT id FROM debt_adjustments WHERE code = ?) AS TEXT), ?, ?, ?)`,
        )
        .bind(code, JSON.stringify({ code, type: body.type, partnerType: body.partnerType, partnerId: body.partnerId, amount: body.amount, invoiceId: body.invoiceId ?? null, billId: body.billId ?? null }), `${body.type === "write_off" ? "Xoá nợ" : "Chiết khấu"} ${body.amount}đ ${partner.name}: ${body.reason}`, user.id),
      db.prepare(`UPDATE debt_adjustments SET approval_id = (SELECT MAX(id) FROM approvals WHERE type='debt_adjustment.post' AND ref_id = CAST(debt_adjustments.id AS TEXT)) WHERE code = ?`).bind(code),
    );
  } else {
    const plan = planOldestFirst(docs, body.amount);
    stmts.push(...plan.allocs.map((a) => allocStmt(db, a.doc, a.amount, { adjustmentCode: code })));
  }
  stmts.push(auditStmt(c, { action: `debt.${body.type}`, entity: "debt_adjustment", entityId: code, after: { amount: body.amount, partnerType: body.partnerType, partnerId: body.partnerId, pending: needApproval }, reason: body.reason }));
  await db.batch(stmts);
  const adj = await db.prepare(`SELECT * FROM debt_adjustments WHERE code = ?`).bind(code).first<any>();
  return c.json({ adjustment: camel(adj), status: adj.status, approvalId: adj.approval_id ?? null }, 201);
});

registerApprovalHandler("debt_adjustment.post", {
  perm: "debt.approve",
  async onApprove(c, a) {
    const db = c.env.DB;
    const adjId = Number(a.ref_id);
    const adj = await db.prepare(`SELECT * FROM debt_adjustments WHERE id = ?`).bind(adjId).first<any>();
    if (!adj) throw notFound("adjustment_not_found", "Không tìm thấy điều chỉnh");
    if (adj.status !== "pending_approval") throw conflict("not_pending", "Điều chỉnh không còn chờ duyệt");
    let payload: any = {};
    try { payload = a.payload_json ? JSON.parse(a.payload_json) : {}; } catch { /* bỏ qua */ }
    const docs = await adjDocs(db, adj.partner_type, adj.partner_id, payload.invoiceId ?? undefined, payload.billId ?? undefined);
    const plan = planOldestFirst(docs, adj.amount);
    if (plan.leftover > 0) throw conflict("outstanding_changed", "Số còn nợ đã thay đổi, nhỏ hơn số điều chỉnh — hãy từ chối và lập lại");
    return [
      assertStmt(db, "debt.adj_approve", `SELECT status = 'pending_approval' FROM debt_adjustments WHERE id = ?`, [adjId]),
      db.prepare(`UPDATE debt_adjustments SET status='posted' WHERE id = ? AND status='pending_approval'`).bind(adjId),
      ...plan.allocs.map((x) => allocStmt(db, x.doc, x.amount, { adjustmentId: adjId })),
      auditStmt(c, { action: "debt.adjustment_approved", entity: "debt_adjustment", entityId: adjId, before: { status: "pending_approval" }, after: { status: "posted" } }),
    ];
  },
  async onReject(c, a) {
    const db = c.env.DB;
    return [
      db.prepare(`UPDATE debt_adjustments SET status='rejected' WHERE id = ? AND status='pending_approval'`).bind(Number(a.ref_id)),
      auditStmt(c, { action: "debt.adjustment_rejected", entity: "debt_adjustment", entityId: a.ref_id ?? "" }),
    ];
  },
});

debtRoutes.get("/debts/adjustments", requirePerm("debt.view"), async (c) => {
  const status = c.req.query("status");
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM debt_adjustments ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 200`)
    .bind(...(status ? [status] : []))
    .all<any>();
  return c.json({ items: results.map(camel), nextCursor: null });
});

// ---------------------------------------------------------------- số dư đầu kỳ
async function readOpeningRows(c: Ctx): Promise<any[]> {
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("json")) {
    const raw: any = await c.req.json().catch(() => null);
    const arr = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(arr)) throw new AppError(422, "validation_error", "Cần mảng [{partnerType, partnerCode, amount, dueDate}]");
    return arr;
  }
  const rows = parseCsv(await c.req.text());
  const head = rows.shift()?.map((h) => h.toLowerCase().replace(/[^a-z]/g, "")) ?? [];
  const idx = (n: string) => head.indexOf(n);
  return rows.map((r) => ({ partnerType: r[idx("partnertype")], partnerCode: r[idx("partnercode")], amount: parseAmount(r[idx("amount")] ?? ""), dueDate: r[idx("duedate")] }));
}

const openingRow = z.object({ partnerType: partnerTypeEnum, partnerCode: z.string().trim().min(1), amount: money, dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

debtRoutes.post("/debts/opening-balances", requirePerm("debt.write"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  if (await db.prepare(`SELECT 1 FROM opening_balances_lock`).first()) throw new AppError(423, "opening_locked", "Số dư đầu kỳ đã khoá, không nhập thêm được");
  const raw = await readOpeningRows(c);
  if (!raw.length || raw.length > 500) throw new AppError(422, "validation_error", "Cần từ 1 đến 500 dòng số dư đầu kỳ");
  const rows = raw.map((r) => openingRow.parse(r));
  const stmts: D1PreparedStatement[] = [];
  const errors: { row: number; message: string }[] = [];
  const today = vnDate();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const issue = r.issueDate ?? today;
    if (r.partnerType === "customer") {
      const cu = await db.prepare(`SELECT id, name FROM customers WHERE code = ?`).bind(r.partnerCode).first<{ id: number; name: string }>();
      if (!cu) { errors.push({ row: i + 1, message: `Không tìm thấy khách ${r.partnerCode}` }); continue; }
      stmts.push(
        db
          .prepare(`INSERT INTO invoices(code, kind, customer_id, issue_date, due_date, subtotal, total, einvoice_status, note, buyer_name, created_by) VALUES (?, 'sale', ?, ?, ?, ?, ?, 'not_required', 'Số dư đầu kỳ', ?, ?)`)
          .bind(await nextCode(db, "HDB"), cu.id, issue, r.dueDate, r.amount, r.amount, cu.name, user.id),
      );
    } else {
      const su = await db.prepare(`SELECT id FROM suppliers WHERE code = ?`).bind(r.partnerCode).first<{ id: number }>();
      if (!su) { errors.push({ row: i + 1, message: `Không tìm thấy NCC ${r.partnerCode}` }); continue; }
      stmts.push(
        db
          .prepare(`INSERT INTO supplier_bills(code, supplier_id, issue_date, due_date, total, note, created_by) VALUES (?,?,?,?,?, 'Số dư đầu kỳ', ?)`)
          .bind(await nextCode(db, "CNP"), su.id, issue, r.dueDate, r.amount, user.id),
      );
    }
  }
  if (errors.length) throw new AppError(422, "opening_invalid", "Có dòng không hợp lệ, chưa ghi gì", errors);
  stmts.push(auditStmt(c, { action: "debt.opening_import", entity: "debt", after: { rows: rows.length, total: rows.reduce((s, r) => s + r.amount, 0) } }));
  // Chặn đua với /lock: chèn có điều kiện thông qua kiểm tra lại trước batch
  if (await db.prepare(`SELECT 1 FROM opening_balances_lock`).first()) throw new AppError(423, "opening_locked", "Số dư đầu kỳ đã khoá, không nhập thêm được");
  await db.batch(stmts);
  return c.json({ created: rows.length, total: rows.reduce((s, r) => s + r.amount, 0) }, 201);
});

debtRoutes.post("/debts/opening-balances/lock", requirePerm("debt.approve"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  if (await db.prepare(`SELECT 1 FROM opening_balances_lock`).first()) throw conflict("already_locked", "Số dư đầu kỳ đã khoá");
  await db.batch([
    db.prepare(`INSERT INTO opening_balances_lock(id, locked_at, locked_by) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`).bind(user.id),
    auditStmt(c, { action: "debt.opening_lock", entity: "debt", after: { locked: true } }),
  ]);
  return c.json({ locked: true });
});

debtRoutes.get("/debts/opening-balances/status", requirePerm("debt.view"), async (c) => {
  const r = await c.env.DB.prepare(`SELECT locked_at, locked_by FROM opening_balances_lock`).first<any>();
  return c.json({ locked: !!r, lockedAt: r?.locked_at ?? null, lockedBy: r?.locked_by ?? null });
});

// ---------------------------------------------------------------- sao kê
debtRoutes.get("/debts/statements/:partnerType/:partnerId", requirePerm("debt.view"), async (c) => {
  const pt = partnerTypeEnum.parse(c.req.param("partnerType"));
  const pid = Number(c.req.param("partnerId"));
  const db = c.env.DB;
  const partner = await partnerInfo(db, pt, pid);
  const from = c.req.query("from") && /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from")!) ? c.req.query("from")! : "0000-01-01";
  const to = c.req.query("to") && /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to")!) ? c.req.query("to")! : "9999-12-31";

  // Quy ước: debit = phát sinh làm tăng số dư nợ (hoá đơn bán / hoá đơn mua); credit = làm giảm (thu/chi, điều chỉnh, hoá đơn điều chỉnh giảm)
  interface Ev { date: string; ord: number; id: number; docType: string; docCode: string; debit: number; credit: number }
  const ev: Ev[] = [];
  if (pt === "customer") {
    const inv = (await db.prepare(`SELECT id, code, kind, issue_date, total FROM invoices WHERE customer_id = ? AND status='open'`).bind(pid).all<any>()).results;
    for (const r of inv) ev.push({ date: r.issue_date, ord: 0, id: r.id, docType: r.kind === "adjustment" ? "invoice_adjustment" : "invoice", docCode: r.code, debit: Math.max(r.total, 0), credit: Math.max(-r.total, 0) });
  } else {
    const bills = (await db.prepare(`SELECT id, code, issue_date, total FROM supplier_bills WHERE supplier_id = ? AND status='open'`).bind(pid).all<any>()).results;
    for (const r of bills) ev.push({ date: r.issue_date, ord: 0, id: r.id, docType: "bill", docCode: r.code, debit: r.total, credit: 0 });
  }
  const pays = (await db.prepare(`SELECT id, code, paid_at, amount FROM debt_payments WHERE partner_type=? AND partner_id=? AND status='posted'`).bind(pt, pid).all<any>()).results;
  for (const r of pays) ev.push({ date: vnDate(new Date(r.paid_at)), ord: 1, id: r.id, docType: "payment", docCode: r.code, debit: 0, credit: r.amount });
  const adjs = (await db.prepare(`SELECT id, code, type, created_at, amount FROM debt_adjustments WHERE partner_type=? AND partner_id=? AND status='posted'`).bind(pt, pid).all<any>()).results;
  for (const r of adjs) ev.push({ date: vnDate(new Date(r.created_at)), ord: 2, id: r.id, docType: r.type, docCode: r.code, debit: 0, credit: r.amount });
  ev.sort((a, b) => a.date.localeCompare(b.date) || a.ord - b.ord || a.id - b.id);

  let opening = 0;
  let bal = 0;
  const lines: any[] = [];
  for (const e of ev) {
    if (e.date > to) continue;
    if (e.date < from) { opening += e.debit - e.credit; bal = opening; continue; }
    bal += e.debit - e.credit;
    lines.push({ date: e.date, docType: e.docType, docCode: e.docCode, debit: e.debit, credit: e.credit, balance: bal });
  }
  const closing = lines.length ? lines[lines.length - 1].balance : opening;
  if (c.req.query("format") === "csv") {
    const csv = toCsv([
      ["Sao kê công nợ", partner.name, partner.code, `${from} → ${to}`],
      ["Ngày", "Loại chứng từ", "Số chứng từ", "Phát sinh tăng", "Phát sinh giảm", "Số dư"],
      ["", "Số dư đầu kỳ", "", "", "", opening],
      ...lines.map((l) => [l.date, l.docType, l.docCode, l.debit, l.credit, l.balance]),
      ["", "Số dư cuối kỳ", "", "", "", closing],
    ]);
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="sao-ke-${partner.code}.csv"`, "cache-control": "no-store" } });
  }
  return c.json({ partnerType: pt, partnerId: pid, partnerName: partner.name, from, to, opening, lines, closing });
});

// ---------------------------------------------------------------- nhắc nợ
debtRoutes.get("/debts/reminders", requirePerm("debt.view"), async (c) => {
  const db = c.env.DB;
  const days = Number(c.req.query("days")) || (await getSettingInt(db, "remind.days_before_due", 3));
  const today = vnDate();
  const limitDate = addDays(today, days);
  const docs = (await allOpenDocs(db, "receivable")).filter((d) => d.due_date <= limitDate);
  const byCust = new Map<number, DocRow[]>();
  for (const d of docs) byCust.set(d.pid, [...(byCust.get(d.pid) ?? []), d]);
  const items: any[] = [];
  for (const [cid, ds] of byCust) {
    const cu = await db.prepare(`SELECT id, code, name, phone FROM customers WHERE id = ?`).bind(cid).first<any>();
    const overdue = ds.filter((d) => d.due_date < today);
    items.push({
      customerId: cid, customerCode: cu?.code, customerName: cu?.name,
      total: ds.reduce((s, d) => s + d.os, 0),
      overdueAmount: overdue.reduce((s, d) => s + d.os, 0),
      invoices: ds.map((d) => ({ id: d.id, code: d.code, dueDate: d.due_date, outstanding: d.os, overdueDays: Math.max(0, daysBetween(d.due_date, today)) })),
    });
  }
  items.sort((a, b) => b.overdueAmount - a.overdueAmount);
  return c.json({ days, items, nextCursor: null });
});

debtRoutes.post("/debts/reminders/send", requirePerm("debt.write"), async (c) => {
  const body = await parseBody(c, z.object({ customerIds: z.array(z.number().int().positive()).min(1).max(200) }));
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  for (const id of body.customerIds) {
    if (!(await db.prepare(`SELECT 1 FROM customers WHERE id = ?`).bind(id).first())) throw new AppError(422, "partner_not_found", `Không tìm thấy khách ${id}`);
    stmts.push(enqueueJobStmt(db, "debt.remind", "customer", id, { customerId: id, at: vnDate() }));
  }
  stmts.push(auditStmt(c, { action: "debt.remind", entity: "customer", after: { customerIds: body.customerIds } }));
  await db.batch(stmts);
  for (const id of body.customerIds) await kickJobs(c.env, "customer", id);
  return c.json({ queued: body.customerIds.length });
});

// ---------------------------------------------------------------- giao dịch ngân hàng (EC-24)
const bankRow = (r: any) => camel(r);

/** Mã phải đứng riêng: không dính chữ/số ngay trước, và không có chữ số ngay sau (KH-0001 không khớp trong KH-00012). */
export function containsCode(text: string, code: string) {
  const t = text.toUpperCase();
  const k = code.toUpperCase();
  if (!k) return false;
  for (let i = t.indexOf(k); i >= 0; i = t.indexOf(k, i + 1)) {
    const before = i === 0 ? "" : t[i - 1];
    const after = t[i + k.length] ?? "";
    if (!/[A-Z0-9]/.test(before) && !/[0-9]/.test(after)) return true;
  }
  return false;
}

async function autoMatch(c: Ctx, txn: { id: number; fund_id: number; amount: number; description: string; bank_ref: string }): Promise<boolean> {
  const db = c.env.DB;
  if (txn.amount <= 0 || !txn.description) return false;
  if (await matchOnlineOrder(c, txn)) return true; // Đợt 3: nội dung chứa mã đơn online DH... + đúng số tiền intent pending
  const inv = {
    results: (
      await db
        .prepare(`SELECT id, customer_id, code FROM invoices WHERE customer_id IS NOT NULL AND status='open' AND instr(upper(?1), upper(code)) > 0`)
        .bind(txn.description)
        .all<{ id: number; customer_id: number; code: string }>()
    ).results.filter((r) => containsCode(txn.description, r.code)),
  };
  let customerId: number | null = null;
  let allocations: { invoiceId: number; amount: number }[] | undefined;
  const custs = new Set(inv.results.map((r) => r.customer_id));
  if (custs.size === 1) {
    customerId = [...custs][0];
    const docs = await openDocs(db, "customer", customerId);
    let left = txn.amount;
    allocations = [];
    for (const r of inv.results) {
      const d = docs.find((x) => x.id === r.id);
      if (!d || left <= 0) continue;
      const a = Math.min(left, d.outstanding);
      allocations.push({ invoiceId: d.id, amount: a });
      left -= a;
    }
    if (left > 0) {
      // phần còn lại gạch cũ nhất trước (các hoá đơn khác)
      const rest = planOldestFirst(docs.map((d) => ({ ...d, outstanding: d.outstanding - (allocations!.find((x) => x.invoiceId === d.id)?.amount ?? 0) })), left);
      for (const a of rest.allocs) allocations.push({ invoiceId: a.doc.id, amount: a.amount });
    }
  } else if (custs.size === 0) {
    const cu = (
      await db
        .prepare(`SELECT id, code FROM customers WHERE code != '' AND instr(upper(?1), upper(code)) > 0`)
        .bind(txn.description)
        .all<{ id: number; code: string }>()
    ).results.filter((r) => containsCode(txn.description, r.code));
    if (cu.length === 1) customerId = cu[0].id;
  }
  if (customerId == null) return false;
  try {
    await createPayment(c, { direction: "in", partnerType: "customer", partnerId: customerId, fundId: txn.fund_id, amount: txn.amount, method: "transfer", ref: txn.bank_ref, allocations: allocations?.length ? allocations : undefined, bankTxnId: txn.id });
    return true;
  } catch {
    return false; // kỳ khoá / thiếu khoản mục → giữ unmatched để xử lý tay
  }
}

debtRoutes.post("/bank-transactions/import", requirePerm("debt.write"), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  let fundId: number;
  let csv: string;
  if ((c.req.header("content-type") ?? "").includes("json")) {
    const b = await parseBody(c, z.object({ fundId: z.number().int().positive(), csv: z.string().min(1).max(900_000) }));
    fundId = b.fundId; csv = b.csv;
  } else {
    fundId = Number(c.req.query("fundId"));
    csv = await c.req.text();
  }
  const fund = await db.prepare(`SELECT id FROM funds WHERE id = ? AND active = 1`).bind(fundId).first();
  if (!fund) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại hoặc đã ngừng");
  const rows = parseCsv(csv);
  const head = (rows.shift() ?? []).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const col = (names: string[]) => head.findIndex((h) => names.includes(h));
  const iDate = col(["date", "ngay"]), iAmt = col(["amount", "sotien"]), iDesc = col(["description", "noidung", "desc"]), iRef = col(["ref", "reference", "sogd", "magd"]);
  if (iDate < 0 || iAmt < 0) throw new AppError(422, "csv_invalid", "CSV cần các cột date, amount, description, ref");
  if (rows.length > 1000) throw new AppError(422, "csv_too_large", "Tối đa 1000 dòng mỗi lần nhập");
  let imported = 0, duplicates = 0, matched = 0, invalid = 0;
  const out: any[] = [];
  for (const r of rows) {
    const date = normDate(r[iDate] ?? "");
    const amount = parseAmount(r[iAmt] ?? "");
    if (!date || amount == null || amount === 0) { invalid++; continue; }
    const desc = iDesc >= 0 ? r[iDesc] ?? "" : "";
    const ref = (iRef >= 0 ? r[iRef] : "") || `${date}|${amount}|${desc}`;
    const ins = await db
      .prepare(`INSERT OR IGNORE INTO bank_transactions(fund_id, txn_date, amount, description, bank_ref, imported_by) VALUES (?,?,?,?,?,?)`)
      .bind(fundId, date, amount, desc, ref, user.id)
      .run();
    if (!ins.meta.changes) { duplicates++; continue; }
    imported++;
    const id = ins.meta.last_row_id as number;
    const ok = await autoMatch(c, { id, fund_id: fundId, amount, description: desc, bank_ref: ref });
    if (ok) matched++;
    out.push({ id, date, amount, description: desc, ref, status: ok ? "matched" : "unmatched" });
  }
  await auditStmt(c, { action: "bank.import", entity: "fund", entityId: fundId, after: { imported, duplicates, matched, invalid } }).run();
  return c.json({ imported, duplicates, matched, unmatched: imported - matched, invalid, items: out }, 201);
});

debtRoutes.get("/bank-transactions", requirePerm("debt.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.status) { conds.push(`status = ?`); params.push(q.status); }
  if (q.fundId) { conds.push(`fund_id = ?`); params.push(Number(q.fundId)); }
  if (q.cursor) { conds.push(`id < ?`); params.push(Number(q.cursor)); }
  const limit = lim(c);
  const rows = (await c.env.DB.prepare(`SELECT * FROM bank_transactions ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).bind(...params, limit + 1).all<any>()).results;
  const items = rows.slice(0, limit).map(bankRow);
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

debtRoutes.post("/bank-transactions/:id/match", requirePerm("debt.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(
    c,
    z.union([
      z.object({ ignore: z.literal(true), reason: z.string().trim().min(3).max(300) }),
      z.object({ partnerType: partnerTypeEnum, partnerId: z.number().int().positive(), allocations: z.array(allocItem).max(200).optional() }),
    ]),
  );
  const db = c.env.DB;
  const t = await db.prepare(`SELECT * FROM bank_transactions WHERE id = ?`).bind(id).first<any>();
  if (!t) throw notFound("bank_txn_not_found", "Không tìm thấy giao dịch ngân hàng");
  if (t.status !== "unmatched") throw conflict("not_unmatched", "Giao dịch đã được xử lý");
  if ("ignore" in body) {
    await db.batch([
      assertStmt(db, "bank.ignore", `SELECT status = 'unmatched' FROM bank_transactions WHERE id = ?`, [id]),
      db.prepare(`UPDATE bank_transactions SET status='ignored' WHERE id = ? AND status='unmatched'`).bind(id),
      auditStmt(c, { action: "bank.ignore", entity: "bank_transaction", entityId: id, reason: body.reason }),
    ]);
    return c.json(bankRow(await db.prepare(`SELECT * FROM bank_transactions WHERE id = ?`).bind(id).first()));
  }
  const direction = t.amount > 0 ? "in" : "out";
  if ((direction === "in") !== (body.partnerType === "customer")) throw new AppError(422, "direction_mismatch", "Tiền vào ứng với khách hàng, tiền ra ứng với nhà cung cấp");
  const res = await createPayment(c, { direction, partnerType: body.partnerType, partnerId: body.partnerId, fundId: t.fund_id, amount: Math.abs(t.amount), method: "transfer", ref: t.bank_ref, allocations: body.allocations, bankTxnId: id });
  return c.json({ ...res, bankTransaction: bankRow(await db.prepare(`SELECT * FROM bank_transactions WHERE id = ?`).bind(id).first()) });
});

// ---------------------------------------------------------------- đối soát COD / sàn (M6-03)
const settlementSchema = z.object({
  source: z.string().trim().min(1).max(40),
  externalRef: z.string().trim().min(1).max(100),
  fundId: z.number().int().positive(),
  periodFrom: z.string().optional(),
  periodTo: z.string().optional(),
  diffReason: z.string().trim().max(300).optional(),
  lines: z
    .array(
      z.object({
        orderId: z.number().int().positive().optional(),
        externalOrderId: z.string().max(100).optional(),
        expectedAmount: z.number().int().min(0).max(10_000_000_000),
        receivedAmount: z.number().int().min(0).max(10_000_000_000),
        feeAmount: z.number().int().min(0).max(10_000_000_000).default(0),
        note: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(500),
});

debtRoutes.get("/settlements", requirePerm("finance.write"), async (c) => {
  const limit = lim(c);
  const cursor = Number(c.req.query("cursor")) || 0;
  const rows = (await c.env.DB.prepare(`SELECT * FROM settlements WHERE (?1 = 0 OR id < ?1) ORDER BY id DESC LIMIT ?2`).bind(cursor, limit + 1).all<any>()).results;
  const items = rows.slice(0, limit).map(camel);
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

debtRoutes.get("/settlements/:id", requirePerm("finance.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const s = await c.env.DB.prepare(`SELECT * FROM settlements WHERE id = ?`).bind(id).first<any>();
  if (!s) throw notFound("settlement_not_found", "Không tìm thấy đợt đối soát");
  const { results } = await c.env.DB.prepare(`SELECT * FROM settlement_lines WHERE settlement_id = ? ORDER BY id`).bind(id).all<any>();
  return c.json({ ...camel(s), lines: results.map(camel) });
});

debtRoutes.post("/settlements", requirePerm("finance.write"), async (c) => {
  const body = await parseBody(c, settlementSchema);
  const db = c.env.DB;
  const user = c.get("user");
  if (!(await db.prepare(`SELECT 1 FROM funds WHERE id = ? AND active = 1`).bind(body.fundId).first())) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại hoặc đã ngừng");
  if (!(await isRealFund(db, body.fundId))) throw new AppError(422, "fund_is_clearing", "Quỹ nhận tiền đối soát phải là quỹ thật (tiền mặt/ngân hàng/ví), không phải quỹ chờ đối soát");
  for (const l of body.lines) if (l.orderId == null && !l.externalOrderId) throw new AppError(422, "validation_error", "Mỗi dòng cần orderId hoặc externalOrderId");
  const expected = body.lines.reduce((s, l) => s + l.expectedAmount, 0);
  const received = body.lines.reduce((s, l) => s + l.receivedAmount, 0);
  const fee = body.lines.reduce((s, l) => s + l.feeAmount, 0);
  // received = tiền thực nhận; kỳ vọng thực nhận = expected − fee. diff > 0: nhận dư, < 0: nhận thiếu.
  const diff = received - (expected - fee);
  if (diff !== 0 && !body.diffReason) throw new AppError(422, "diff_reason_required", `Chênh lệch ${diff}đ, bắt buộc ghi lý do chênh lệch`, { diff });
  const code = await nextCode(db, "DS");
  await guarded(
    () =>
      db.batch([
        db
          .prepare(`INSERT INTO settlements(code, source, external_ref, period_from, period_to, fund_id, expected_amount, received_amount, fee_amount, diff_amount, diff_reason, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(code, body.source, body.externalRef, body.periodFrom ?? null, body.periodTo ?? null, body.fundId, expected, received, fee, diff, body.diffReason ?? null, user.id),
        ...body.lines.map((l) =>
          db
            .prepare(`INSERT INTO settlement_lines(settlement_id, order_id, external_order_id, expected_amount, received_amount, fee_amount, note) VALUES ((SELECT id FROM settlements WHERE code = ?),?,?,?,?,?,?)`)
            .bind(code, l.orderId ?? null, l.externalOrderId ?? null, l.expectedAmount, l.receivedAmount, l.feeAmount, l.note ?? null),
        ),
        auditStmt(c, { action: "settlement.create", entity: "settlement", entityId: code, after: { source: body.source, expected, received, fee, diff }, reason: body.diffReason }),
      ]),
    "Đợt đối soát này đã tồn tại (trùng nguồn và mã tham chiếu), hoặc có đơn đã nằm trong đợt đối soát khác",
  );
  const s = await db.prepare(`SELECT * FROM settlements WHERE code = ?`).bind(code).first<any>();
  return c.json(camel(s), 201);
});

debtRoutes.post("/settlements/:id/confirm", requirePerm("finance.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const user = c.get("user");
  const s = await db.prepare(`SELECT * FROM settlements WHERE id = ?`).bind(id).first<any>();
  if (!s) throw notFound("settlement_not_found", "Không tìm thấy đợt đối soát");
  if (s.status !== "draft") throw conflict("already_confirmed", "Đợt đối soát đã xác nhận");
  if (!(await isRealFund(db, s.fund_id))) throw new AppError(422, "fund_is_clearing", "Quỹ nhận tiền đối soát phải là quỹ thật (tiền mặt/ngân hàng/ví), không phải quỹ chờ đối soát");
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, "settlement.confirm", `SELECT status = 'draft' FROM settlements WHERE id = ?`, [id]),
    db.prepare(`UPDATE settlements SET status='confirmed' WHERE id = ? AND status='draft'`).bind(id),
  ];
  const note = `Đối soát ${s.source} ${s.code}${s.external_ref ? " / " + s.external_ref : ""}`;
  const mk = async (direction: "in" | "out", fundId: number, amount: number, cat: string, label: string) => {
    if (amount <= 0) return;
    const catId = await categoryId(db, [cat], direction);
    const code = await nextCode(db, direction === "in" ? PREFIX.cashIn : PREFIX.cashOut);
    stmts.push(voucherStmt(db, { code, direction, fundId, categoryId: catId, amount, counterparty: s.source, refType: "settlement", refId: id, note: `${label}: ${note}`, userId: user.id }));
  };
  // Hạch toán (A-03/B-05, B-13): `received` là tiền THỰC NHẬN (đã trừ phí) về quỹ thật.
  //   quỹ thật  : +received (chuyển nội bộ DOI_SOAT)
  //   quỹ chờ   : −received (chuyển DOI_SOAT_RA) − phí (chi phí PHI_DOI_SOAT) − thiếu (CHENH_LECH_DOI_SOAT) + thừa (THU_CHENH_LECH_DOI_SOAT)
  // Tổng ra khỏi quỹ chờ = expected nên quỹ chờ về 0; phí và chênh lệch là chi phí/thu khác của P&L và không bao giờ chạm quỹ thật.
  const clearing = new Map<number, number>();
  const rows = (
    await db
      .prepare(
        `SELECT p.fund_id AS fundId, SUM(p.amount) AS amt
           FROM payments p JOIN funds f ON f.id = p.fund_id
          WHERE p.status = 'confirmed' AND f.type IN ('cod_clearing','marketplace_clearing')
            AND p.order_id IN (SELECT order_id FROM settlement_lines WHERE settlement_id = ? AND order_id IS NOT NULL)
          GROUP BY p.fund_id HAVING SUM(p.amount) > 0`,
      )
      .bind(id)
      .all<{ fundId: number; amt: number }>()
  ).results;
  for (const r of rows) clearing.set(r.fundId, (clearing.get(r.fundId) ?? 0) + r.amt);
  // dòng chỉ có mã đơn sàn (không map đơn nội bộ): không có payment để truy → rút phần expected khỏi quỹ chờ mặc định của nguồn
  const ext = await db.prepare(`SELECT COALESCE(SUM(expected_amount),0) AS s FROM settlement_lines WHERE settlement_id = ? AND order_id IS NULL`).bind(id).first<{ s: number }>();
  const defaultClearing = await db
    .prepare(`SELECT id FROM funds WHERE active = 1 AND type IN ('cod_clearing','marketplace_clearing') ORDER BY (type = ?) DESC, id LIMIT 1`)
    .bind(s.source === "cod" ? "cod_clearing" : "marketplace_clearing")
    .first<{ id: number }>();
  if (!defaultClearing && !clearing.size) throw new AppError(422, "no_clearing_fund", "Chưa có quỹ chờ đối soát để ghi phí/chênh lệch của đợt này");
  if (ext!.s > 0) clearing.set(defaultClearing!.id, (clearing.get(defaultClearing!.id) ?? 0) + ext!.s);
  if (!clearing.size) clearing.set(defaultClearing!.id, 0);

  const fee = s.fee_amount as number;
  const diff = s.diff_amount as number;
  let feeLeft = fee, shortLeft = diff < 0 ? -diff : 0;
  const entries = [...clearing.entries()];
  await mk("in", s.fund_id, s.received_amount, "DOI_SOAT", "Tiền đối soát về quỹ");
  for (const [i, [fundId, cap]] of entries.entries()) {
    let left = cap + (i === 0 && diff > 0 ? diff : 0);
    const last = i === entries.length - 1;
    const f = last ? feeLeft : Math.min(feeLeft, left);
    left -= f; feeLeft -= f;
    const sh = last ? shortLeft : Math.min(shortLeft, Math.max(0, left));
    left -= sh; shortLeft -= sh;
    if (i === 0 && diff > 0) await mk("in", fundId, diff, "THU_CHENH_LECH_DOI_SOAT", "Chênh lệch đối soát (thừa)");
    await mk("out", fundId, Math.max(0, left), "DOI_SOAT_RA", "Chuyển khỏi quỹ chờ đối soát");
    await mk("out", fundId, f, "PHI_DOI_SOAT", "Phí sàn/vận chuyển thu hộ");
    await mk("out", fundId, sh, "CHENH_LECH_DOI_SOAT", "Chênh lệch đối soát (thiếu)");
  }
  stmts.push(auditStmt(c, { action: "settlement.confirm", entity: "settlement", entityId: id, before: { status: "draft" }, after: { status: "confirmed", received: s.received_amount, fee: s.fee_amount, diff } }));
  await db.batch(stmts);
  const { results } = await db.prepare(`SELECT * FROM cash_vouchers WHERE ref_type='settlement' AND ref_id = ? ORDER BY id`).bind(id).all<any>();
  return c.json({ ...camel(await db.prepare(`SELECT * FROM settlements WHERE id = ?`).bind(id).first()), vouchers: results.map(camel) });
});

async function isRealFund(db: D1Database, fundId: number) {
  const f = await db.prepare(`SELECT type FROM funds WHERE id = ?`).bind(fundId).first<{ type: string }>();
  return !!f && ["cash", "bank", "ewallet"].includes(f.type);
}

