/**
 * POS-KV đợt B — route phụ cho quầy bán hàng:
 *  - B1 thu nợ khách lẻ tại quầy (`/pos/customers/:id/debts`, `/pos/debt-payments`, `/pos/invoices/:id/pay-info`);
 *  - B2 danh mục loại thu khác (`/charge-types`).
 * Việc ghi tiền công nợ đi qua `createPayment` (services/debt-ledger.ts) — cùng một batch phiếu thu M6 + debt_payments + gạch nợ + audit.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, maskPhone, requirePerm } from "../lib/rbac";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { vnDate } from "../lib/time";
import { INVOICE_OUTSTANDING_SQL } from "../services/debt";
import { registerApprovalHandler } from "../services/approval-registry";
import { createPayment } from "../services/debt-ledger";
import { creditSettings } from "../services/pos-credit";
import { assertStmt } from "../services/guard";
import { guarded, parseBody } from "../services/http";
import { ensurePayCode, sepayConfig } from "../services/sepay";
import { buildVietQr } from "../../shop/worker/lib/vietqr";

export const posCreditRoutes = new Hono<AppBindings>();

// Duyệt ghi nợ khách lẻ vượt ngưỡng / vượt hạn mức: người duyệt cần pos.credit (chủ, quản lý); thu ngân gửi lại đơn kèm approvalId
registerApprovalHandler("order.credit", { perm: "pos.credit" });

const idParam = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(422, "validation_error", "Mã không hợp lệ");
  return n;
};

async function retailCustomer(db: D1Database, id: number) {
  const r = await db
    .prepare(`SELECT id, code, name, phone, credit_limit, payment_terms_days, active FROM customers WHERE id = ? AND type = 'retail'`)
    .bind(id)
    .first<{ id: number; code: string; name: string; phone: string | null; credit_limit: number; payment_terms_days: number; active: number }>();
  if (!r) throw notFound("customer_not_found", "Không tìm thấy khách lẻ");
  return r;
}

async function openInvoices(db: D1Database, customerId: number) {
  const today = vnDate();
  const rows = (
    await db
      .prepare(
        `SELECT i.id, i.code, i.issue_date, i.due_date, i.total, ${INVOICE_OUTSTANDING_SQL} AS os, (SELECT o.code FROM orders o WHERE o.id = i.order_id) AS order_code
           FROM invoices i WHERE i.customer_id = ? AND i.status = 'open' AND i.kind IN ('sale','replacement') ORDER BY i.due_date, i.id`,
      )
      .bind(customerId)
      .all<{ id: number; code: string; issue_date: string; due_date: string; total: number; os: number; order_code: string | null }>()
  ).results.filter((r) => r.os > 0);
  return rows.map((r) => ({
    id: r.id, code: r.code, orderCode: r.order_code, issueDate: r.issue_date, dueDate: r.due_date, total: r.total, outstanding: r.os,
    overdueDays: Math.max(0, Math.round((Date.parse(today) - Date.parse(r.due_date)) / 86400_000)),
  }));
}

/** Quầy chỉ cần biết có cho bán nợ không và ngưỡng nào cần quản lý duyệt. */
posCreditRoutes.get("/pos/credit-config", requirePerm("pos.sell"), async (c) => {
  const cs = await creditSettings(c.env.DB);
  return c.json({ enabled: cs.enabled, approvalVnd: cs.approvalVnd, canOverride: can(c.get("user").role, "pos.credit") });
});

// ---------------------------------------------------------------- B1: nợ của một khách lẻ (cho nút "Thu nợ")
posCreditRoutes.get("/pos/customers/:id/debts", requirePerm("pos.sell"), async (c) => {
  const db = c.env.DB;
  const cu = await retailCustomer(db, idParam(c.req.param("id")));
  const invoices = await openInvoices(db, cu.id);
  const outstanding = invoices.reduce((s, i) => s + i.outstanding, 0);
  const unapplied = (
    await db
      .prepare(
        `SELECT COALESCE(SUM(p.amount - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x WHERE x.payment_id = p.id), 0)), 0) AS u
           FROM debt_payments p WHERE p.partner_type = 'customer' AND p.partner_id = ? AND p.direction = 'in' AND p.status = 'posted'`,
      )
      .bind(cu.id)
      .first<{ u: number }>()
  )?.u ?? 0;
  return c.json({
    customer: { id: cu.id, code: cu.code, name: cu.name, phone: can(c.get("user").role, "customers.view_pii") ? cu.phone : maskPhone(cu.phone, "warehouse"), creditLimit: cu.credit_limit },
    outstanding, unapplied,
    overdueAmount: invoices.filter((i) => i.overdueDays > 0).reduce((s, i) => s + i.outstanding, 0),
    available: Math.max(0, cu.credit_limit - outstanding),
    invoices,
  });
});

// ---------------------------------------------------------------- B1: thu nợ tại quầy
const debtPaySchema = z.object({
  customerId: z.number().int().positive(),
  amount: z.number().int().positive().max(10_000_000_000),
  method: z.enum(["cash", "transfer"]),
  invoiceId: z.number().int().positive().optional(), // không chọn → gạch hoá đơn cũ nhất trước
  ref: z.string().trim().max(100).optional(),
  idempotencyKey: z.string().trim().min(8).max(100),
});

/**
 * Thu nợ khách lẻ: tiền mặt vào quỹ của ca (nên có trong tiền mặt dự kiến khi chốt ca). Gọi lại cùng idempotencyKey → 409 already_done.
 * Chuyển khoản "tự khai" KHÔNG phải việc của thu ngân (không có giao dịch thật đối chiếu): thu ngân chỉ dùng tiền mặt hoặc quét mã QR HDS (SePay tự xác nhận);
 * ghi nhận chuyển khoản thủ công cần quyền `finance.write`.
 */
posCreditRoutes.post("/pos/debt-payments", requirePerm("pos.sell"), async (c) => {
  const body = await parseBody(c, debtPaySchema);
  const db = c.env.DB;
  const user = c.get("user");
  if (body.method === "transfer" && !can(user.role, "finance.write"))
    throw forbidden("forbidden", "Ghi nhận chuyển khoản thủ công cần quyền kế toán. Khách chuyển khoản: cho quét mã QR thu nợ để hệ thống tự xác nhận.");
  const cu = await retailCustomer(db, body.customerId);
  const invoices = await openInvoices(db, cu.id);
  const owed = invoices.reduce((s, i) => s + i.outstanding, 0);
  if (!invoices.length) throw new AppError(422, "no_open_documents", "Khách không có hoá đơn còn nợ");
  const target = body.invoiceId ? invoices.find((i) => i.id === body.invoiceId) : null;
  if (body.invoiceId && !target) throw new AppError(422, "allocation_invalid", "Hoá đơn không thuộc khách này hoặc đã hết nợ");
  const cap = target ? target.outstanding : owed;
  if (body.amount > cap) throw new AppError(422, "amount_exceeds_debt", `Số thu vượt số còn nợ (${cap}đ)`, { outstanding: cap });

  let fundId: number;
  let shiftId: number | null = null;
  if (body.method === "cash") {
    const shift = await db.prepare(`SELECT id, fund_id FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(user.id).first<{ id: number; fund_id: number }>();
    if (!shift) throw conflict("no_open_shift", "Cần mở ca để thu tiền mặt");
    fundId = shift.fund_id;
    shiftId = shift.id;
  } else {
    const f = await db.prepare(`SELECT id FROM funds WHERE type = 'bank' AND active = 1 ORDER BY id LIMIT 1`).first<{ id: number }>();
    if (!f) throw new AppError(422, "no_fund", "Chưa cấu hình quỹ ngân hàng");
    fundId = f.id;
  }
  let res;
  try {
    res = await createPayment(c, {
      direction: "in", partnerType: "customer", partnerId: cu.id, fundId, amount: body.amount, method: body.method,
      ref: body.ref ?? null, note: `Thu nợ tại quầy — ${cu.name}`, idempotencyKey: body.idempotencyKey,
      allocations: target ? [{ invoiceId: target.id, amount: body.amount }] : undefined,
      // Tiền mặt: ca phải CÒN MỞ lúc ghi (chốt ca chạy song song → phiếu thu không rơi ra ngoài mọi ca) — kiểm trong cùng batch
      extra: shiftId ? [assertStmt(db, "pos.debt_shift_open", `SELECT status = 'open' FROM shifts WHERE id = ?`, [shiftId])] : undefined,
    });
  } catch (e) {
    if (shiftId && /state_changed/.test(String((e as Error)?.message)) && !(await db.prepare(`SELECT 1 AS x FROM shifts WHERE id = ? AND status = 'open'`).bind(shiftId).first()))
      throw conflict("shift_closed", "Ca vừa được chốt, không thu tiền mặt vào ca này được");
    throw e;
  }
  return c.json({ ...res, debt: { outstanding: owed - body.amount + Math.max(0, res.unapplied) } }, 201);
});

// ---------------------------------------------------------------- B1: mã QR thu nợ của một hoá đơn nợ khách lẻ (không cần quyền debt.view)
// POST (không phải GET): lần đầu có thể phát hành mã thanh toán (ghi `pay_codes`) — việc xem không được ghi dữ liệu.
// Chỉ trả hoá đơn bán của khách lẻ ĐANG CÓ NỢ; hoá đơn khác (đã trả hết, của khách sỉ, điều chỉnh) trả 404 để thu ngân không dò được theo id.
posCreditRoutes.post("/pos/invoices/:id/pay-info", requirePerm("pos.sell"), async (c) => {
  const db = c.env.DB;
  const id = idParam(c.req.param("id"));
  const inv = await db
    .prepare(`SELECT i.id, i.code, i.status, i.kind, i.customer_id, ${INVOICE_OUTSTANDING_SQL} AS os FROM invoices i JOIN customers cu ON cu.id = i.customer_id AND cu.type = 'retail' WHERE i.id = ?`)
    .bind(id)
    .first<{ id: number; code: string; status: string; kind: string; customer_id: number; os: number }>();
  if (!inv || inv.kind === "adjustment" || inv.status !== "open" || !(inv.os > 0)) throw notFound("invoice_not_found", "Không tìm thấy hoá đơn nợ");
  const cfg = await sepayConfig(db);
  if (!cfg.enabled || !cfg.flow.b2b || !cfg.bank.account) return c.json({ available: false });
  const amount = inv.os;
  const code = await ensurePayCode(db, "b2b", inv.id);
  return c.json({
    available: true, code, amount, invoiceCode: inv.code,
    qrPayload: buildVietQr({ bankBin: cfg.bank.bin, accountNo: cfg.bank.account, amount, content: code }),
  });
});

// ---------------------------------------------------------------- B2: loại thu khác
const chargeShape = (r: any) => ({ id: r.id, code: r.code, name: r.name, defaultAmount: r.default_amount, active: !!r.active, version: r.version });

posCreditRoutes.get("/charge-types", requirePerm("pos.sell"), async (c) => {
  const all = c.req.query("all") === "1" && can(c.get("user").role, "settings.manage");
  const { results } = await c.env.DB.prepare(`SELECT * FROM charge_types ${all ? "" : "WHERE active = 1"} ORDER BY id`).all<any>();
  return c.json({ items: results.map(chargeShape) });
});

const codeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/, "Mã gồm chữ in hoa, số, gạch dưới (2–30 ký tự)");
const amountSchema = z.number().int().min(0).max(100_000_000);

posCreditRoutes.post("/charge-types", requirePerm("settings.manage"), async (c) => {
  const b = await parseBody(c, z.object({ code: codeSchema, name: z.string().trim().min(1).max(100), defaultAmount: amountSchema.default(0) }));
  const db = c.env.DB;
  if (await db.prepare(`SELECT 1 AS x FROM charge_types WHERE code = ?`).bind(b.code).first()) throw conflict("code_duplicate", "Mã loại thu khác đã tồn tại");
  const r = await db.batch([
    db.prepare(`INSERT INTO charge_types(code, name, default_amount) VALUES (?,?,?) RETURNING *`).bind(b.code, b.name, b.defaultAmount),
    auditStmt(c, { action: "charge_type.create", entity: "charge_type", entityId: b.code, after: { name: b.name, defaultAmount: b.defaultAmount } }),
  ]);
  return c.json(chargeShape(r[0].results[0]), 201);
});

posCreditRoutes.patch("/charge-types/:id", requirePerm("settings.manage"), async (c) => {
  const id = idParam(c.req.param("id"));
  const b = await parseBody(c, z.object({ version: z.number().int().positive(), name: z.string().trim().min(1).max(100).optional(), defaultAmount: amountSchema.optional(), active: z.boolean().optional() }));
  const db = c.env.DB;
  const cur = await db.prepare(`SELECT * FROM charge_types WHERE id = ?`).bind(id).first<any>();
  if (!cur) throw notFound("charge_type_not_found", "Không tìm thấy loại thu khác");
  if (cur.version !== b.version) throw conflict("version_conflict", "Loại thu khác vừa được người khác sửa — hãy tải lại", { version: cur.version });
  const next = { name: b.name ?? cur.name, default_amount: b.defaultAmount ?? cur.default_amount, active: b.active === undefined ? cur.active : b.active ? 1 : 0 };
  await guarded(() =>
    db.batch([
      assertStmt(db, "charge_type.update", `SELECT version = ? FROM charge_types WHERE id = ?`, [b.version, id]),
      db.prepare(`UPDATE charge_types SET name = ?, default_amount = ?, active = ?, version = version + 1 WHERE id = ?`).bind(next.name, next.default_amount, next.active, id),
      auditStmt(c, { action: "charge_type.update", entity: "charge_type", entityId: id, before: { name: cur.name, defaultAmount: cur.default_amount, active: !!cur.active }, after: { name: next.name, defaultAmount: next.default_amount, active: !!next.active } }),
    ]),
  );
  return c.json(chargeShape(await db.prepare(`SELECT * FROM charge_types WHERE id = ?`).bind(id).first()));
});
