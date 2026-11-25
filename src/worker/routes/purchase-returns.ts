import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { nextCode } from "../lib/codes";
import { toMilli } from "../lib/money";
import { BILL_OUTSTANDING_SQL } from "../services/debt";
import { allocStmt } from "../services/debt-ledger";
import { assertPeriodOpen, isPeriodLocked } from "../services/period";
import { assertStmt } from "../services/guard";
import { moveStatements } from "../services/stock";
import { registerApprovalHandler } from "../services/approval-registry";
import { getSettingInt } from "../services/settings";
import { guarded, parseBody, unitFactor } from "../services/http";
import { ensureAvailable } from "./inventory";

/**
 * B-12 (M2-02 / M5-02 / EC-16): trả hàng nhà cung cấp cho phiếu nhập ĐÃ GHI SỔ.
 *  - Xuất kho theo đúng lô của phiếu nhập (thẻ kho move_type = 'return_supplier'), không vượt tồn còn lại của lô.
 *  - Giảm công nợ phải trả: debit note (debt_adjustments type 'return_credit', partner supplier) gạch vào hoá đơn mua; trả TOÀN BỘ hoá đơn chưa thanh toán
 *    (và kỳ phát hành hoá đơn còn mở) thì huỷ hoá đơn (status 'cancelled', VAT đầu vào tự loại). Phần hoá đơn đã thanh toán → `refund_due` (NCC hoàn tiền).
 *  - Duyệt: người lập không có quyền duyệt kho, hoặc giá trị > approval.purchase_return_vnd mà không có quyền duyệt công nợ → chờ duyệt.
 *  - Khoá sổ: ghi vào kỳ hiện tại (debit note không có phiếu quỹ nên kiểm assertPeriodOpen).
 */
export const purchaseReturnRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;
const PREFIX_RETURN = "TNC";

const createBody = z.object({
  receiptDocId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(300),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        lotId: z.number().int().positive(),
        qty: z.number().positive().max(1_000_000),
        unit: z.string().trim().min(1).optional(),
        reason: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(100),
});

const sel = `SELECT r.*, s.name AS supplier_name, d.code AS receipt_code, b.code AS bill_code, u.full_name AS created_by_name, a.code AS adjustment_code
               FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id JOIN stock_docs d ON d.id = r.receipt_doc_id
               LEFT JOIN supplier_bills b ON b.id = r.bill_id LEFT JOIN users u ON u.id = r.created_by LEFT JOIN debt_adjustments a ON a.id = r.adjustment_id`;

function shape(r: any, cost: boolean) {
  return {
    id: r.id, code: r.code, status: r.status, supplierId: r.supplier_id, supplierName: r.supplier_name, receiptDocId: r.receipt_doc_id, receiptCode: r.receipt_code,
    billId: r.bill_id, billCode: r.bill_code, reason: r.reason, createdBy: r.created_by, createdByName: r.created_by_name, approvedBy: r.approved_by,
    createdAt: r.created_at, postedAt: r.posted_at, approvalId: r.approval_id ?? null, billCancelled: !!r.bill_cancelled, adjustmentCode: r.adjustment_code ?? null,
    ...(cost ? { total: r.total, creditedAmount: r.credited_amount, refundDue: r.refund_due } : {}),
  };
}

async function loadReturn(db: D1Database, id: number) {
  const r = await db.prepare(`${sel} WHERE r.id = ?`).bind(id).first<any>();
  if (!r) throw notFound("not_found", "Không tìm thấy phiếu trả hàng NCC");
  return r;
}

async function loadLines(db: D1Database, id: number, cost: boolean) {
  const { results } = await db
    .prepare(
      `SELECT l.*, p.name AS product_name, p.sku, lot.lot_code FROM purchase_return_lines l JOIN products p ON p.id = l.product_id JOIN lots lot ON lot.id = l.lot_id
        WHERE l.return_id = ? ORDER BY l.id`,
    )
    .bind(id)
    .all<any>();
  return results.map((l) => ({
    id: l.id, lotId: l.lot_id, lotCode: l.lot_code, productId: l.product_id, productName: l.product_name, sku: l.sku, unit: l.unit, qtyMilli: l.qty_milli, reason: l.reason,
    ...(cost ? { unitCost: l.unit_cost, amount: l.amount } : {}),
  }));
}

purchaseReturnRoutes.get("/purchase-returns", requirePerm("inventory.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.status) { conds.push(`r.status = ?`); params.push(q.status); }
  if (q.supplierId) { conds.push(`r.supplier_id = ?`); params.push(Number(q.supplierId)); }
  if (q.receiptDocId) { conds.push(`r.receipt_doc_id = ?`); params.push(Number(q.receiptDocId)); }
  if (q.cursor) { conds.push(`r.id < ?`); params.push(Number(q.cursor)); }
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = (await c.env.DB.prepare(`${sel} ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY r.id DESC LIMIT ?`).bind(...params, limit + 1).all<any>()).results;
  const cost = can(c.get("user").role, "prices.view_cost");
  const items = rows.slice(0, limit).map((r) => shape(r, cost));
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

purchaseReturnRoutes.get("/purchase-returns/:id", requirePerm("inventory.view"), async (c) => {
  const id = Number(c.req.param("id"));
  const cost = can(c.get("user").role, "prices.view_cost");
  const r = await loadReturn(c.env.DB, id);
  return c.json({ ...shape(r, cost), lines: await loadLines(c.env.DB, id, cost) });
});

/** Tạo phiếu (nháp) rồi ghi sổ ngay nếu không cần duyệt; ngược lại chuyển chờ duyệt. */
purchaseReturnRoutes.post("/purchase-returns", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const u = c.get("user");
  const b = await parseBody(c, createBody);
  if (new Set(b.lines.map((l) => l.lotId)).size !== b.lines.length) throw new AppError(422, "validation_error", "Lô bị lặp trong phiếu");
  const doc = await db.prepare(`SELECT * FROM stock_docs WHERE id = ?`).bind(b.receiptDocId).first<any>();
  if (!doc) throw notFound("not_found", "Không tìm thấy phiếu nhập");
  if (doc.type !== "receipt") throw new AppError(422, "not_receipt", "Chỉ trả hàng NCC cho phiếu nhập kho");
  if (doc.status !== "posted") throw conflict("doc_not_posted", "Phiếu nhập chưa ghi sổ: huỷ hoặc xoá dòng ngay trên phiếu nhập");
  if (!doc.supplier_id) throw new AppError(422, "no_supplier", "Phiếu nhập không có nhà cung cấp");
  const bill = await db.prepare(`SELECT id, total, status, is_opening FROM supplier_bills WHERE stock_doc_id = ?`).bind(doc.id).first<any>();
  if (!bill) throw new AppError(422, "no_bill", "Phiếu nhập không có hoá đơn mua để giảm công nợ");
  if (bill.status !== "open") throw conflict("bill_not_open", "Hoá đơn mua của phiếu nhập đã huỷ");
  await assertPeriodOpen(db, new Date(), "phiếu trả hàng NCC");

  const docLots = (await db.prepare(`SELECT id, qty_in_milli, qty_on_hand_milli FROM lots WHERE receipt_doc_id = ?`).bind(doc.id).all<any>()).results;
  const lines: { lotId: number; productId: number; unit: string; qty: number; unitCost: number; amount: number; reason: string | null }[] = [];
  for (const l of b.lines) {
    const lot = await db.prepare(`SELECT l.*, p.base_unit FROM lots l JOIN products p ON p.id = l.product_id WHERE l.id = ?`).bind(l.lotId).first<any>();
    if (!lot || lot.receipt_doc_id !== doc.id) throw new AppError(422, "lot_not_in_receipt", "Lô không thuộc phiếu nhập này", { lotId: l.lotId });
    const unit = l.unit ?? lot.base_unit;
    const qty = toMilli(l.qty, await unitFactor(db, lot.product_id, unit));
    if (qty <= 0) throw new AppError(422, "validation_error", "Số lượng trả phải lớn hơn 0");
    if (qty > lot.qty_on_hand_milli) {
      throw conflict("insufficient_stock", "Số lượng trả vượt tồn còn lại của lô (phần đã bán không trả được)", { lotId: lot.id, requestedMilli: qty, onHandMilli: lot.qty_on_hand_milli });
    }
    lines.push({ lotId: lot.id, productId: lot.product_id, unit, qty, unitCost: lot.unit_cost, amount: Math.round((lot.unit_cost * qty) / 1000), reason: l.reason ?? null });
  }
  let total = lines.reduce((s, l) => s + l.amount, 0);
  // Trả đủ mọi lô của phiếu nhập → giá trị = đúng tổng hoá đơn mua (phần làm tròn đơn giá dồn vào dòng cuối, B-18)
  const full = docLots.every((dl) => lines.some((l) => l.lotId === dl.id && l.qty === dl.qty_in_milli && dl.qty_on_hand_milli === dl.qty_in_milli));
  if (full && total !== bill.total) {
    lines[lines.length - 1].amount += bill.total - total;
    total = bill.total;
  }

  const threshold = await getSettingInt(db, "approval.purchase_return_vnd", 5_000_000);
  const needApproval = !can(u.role, "inventory.approve") || (total > threshold && !can(u.role, "debt.approve"));
  const code = await nextCode(db, PREFIX_RETURN);
  await guarded(() =>
    db.batch([
      db
        .prepare(`INSERT INTO purchase_returns(code, supplier_id, receipt_doc_id, bill_id, status, total, reason, created_by) VALUES (?,?,?,?, 'draft', ?,?,?)`)
        .bind(code, doc.supplier_id, doc.id, bill.id, total, b.reason + (b.note ? ` — ${b.note}` : ""), u.id),
      ...lines.map((l) =>
        db
          .prepare(`INSERT INTO purchase_return_lines(return_id, lot_id, product_id, unit, qty_milli, unit_cost, amount, reason) VALUES ((SELECT id FROM purchase_returns WHERE code = ?),?,?,?,?,?,?,?)`)
          .bind(code, l.lotId, l.productId, l.unit, l.qty, l.unitCost, l.amount, l.reason),
      ),
      auditStmt(c, { action: "purchase_return.create", entity: "purchase_return", entityId: code, reason: b.reason, after: { receiptDocId: doc.id, billId: bill.id, total, lines: lines.map((l) => ({ lotId: l.lotId, qtyMilli: l.qty, amount: l.amount })) } }),
    ]),
  );
  const created = await db.prepare(`SELECT id FROM purchase_returns WHERE code = ?`).bind(code).first<{ id: number }>();
  const id = created!.id;
  if (needApproval) {
    const why = !can(u.role, "inventory.approve") ? "Người lập phiếu không có quyền duyệt trả hàng NCC" : `Trả hàng NCC ${total}đ vượt ngưỡng ${threshold}đ`;
    await guarded(() =>
      db.batch([
        assertStmt(db, "purchase_return.request", `SELECT status = 'draft' FROM purchase_returns WHERE id = ?`, [id]),
        db.prepare(`UPDATE purchase_returns SET status='pending_approval' WHERE id=? AND status='draft'`).bind(id),
        db
          .prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('purchase_return.post','purchase_return',?,?,?,?)`)
          .bind(String(id), JSON.stringify({ code, total, receiptDocId: doc.id, supplierId: doc.supplier_id }), why, u.id),
        db.prepare(`UPDATE purchase_returns SET approval_id = (SELECT MAX(id) FROM approvals WHERE type='purchase_return.post' AND ref_id = ?) WHERE id = ?`).bind(String(id), id),
        auditStmt(c, { action: "purchase_return.request_approval", entity: "purchase_return", entityId: id, reason: why, after: { status: "pending_approval" } }),
      ]),
    );
  } else {
    await guarded(async () => db.batch(await planReturnPost(c, id)));
  }
  const cost = can(u.role, "prices.view_cost");
  return c.json({ ...shape(await loadReturn(db, id), cost), lines: await loadLines(db, id, cost) }, 201);
});

/** Các câu lệnh ghi sổ phiếu trả hàng (một batch: kho + công nợ + trạng thái + nhật ký). Dùng cả khi người duyệt bấm duyệt. */
export async function planReturnPost(c: Ctx, id: number): Promise<D1PreparedStatement[]> {
  const db = c.env.DB;
  const actor = c.get("user");
  const ret = await loadReturn(db, id);
  if (ret.status !== "draft" && ret.status !== "pending_approval") throw conflict("not_pending", "Phiếu trả hàng không ở trạng thái chờ ghi sổ");
  const { results: lines } = await db.prepare(`SELECT * FROM purchase_return_lines WHERE return_id = ? ORDER BY id`).bind(id).all<any>();
  await assertPeriodOpen(db, new Date(), "phiếu trả hàng NCC");
  const bill = await db.prepare(`SELECT b.id, b.total, b.status, b.issue_date, b.is_opening, ${BILL_OUTSTANDING_SQL} AS os FROM supplier_bills b WHERE b.id = ?`).bind(ret.bill_id).first<any>();
  if (!bill || bill.status !== "open") throw conflict("bill_not_open", "Hoá đơn mua đã huỷ, không giảm công nợ được");
  for (const l of lines) await ensureAvailable(db, l.lot_id, l.qty_milli); // nhả phần giữ cho đơn nếu cần; thiếu tồn → 409

  const cancelBill = bill.os === bill.total && ret.total === bill.total && !bill.is_opening && !(await isPeriodLocked(db, bill.issue_date));
  const credited = cancelBill ? ret.total : Math.min(ret.total, Math.max(bill.os, 0));
  const refundDue = ret.total - credited;
  const stmts: D1PreparedStatement[] = [
    assertStmt(db, "purchase_return.post", `SELECT status IN ('draft','pending_approval') FROM purchase_returns WHERE id = ?`, [id]),
    ...lines.map((l) => assertStmt(db, "purchase_return.stock", `SELECT qty_on_hand_milli - qty_reserved_milli >= ? FROM lots WHERE id = ?`, [l.qty_milli, l.lot_id])),
  ];
  for (const l of lines) stmts.push(...moveStatements(db, l.product_id, [{ lotId: l.lot_id, qtyMilli: l.qty_milli, unitCost: l.unit_cost }], -1, "return_supplier", "purchase_return", id, actor.id));

  let adjCode: string | null = null;
  if (cancelBill) {
    stmts.push(
      assertStmt(db, "purchase_return.bill", `SELECT status = 'open' AND ${BILL_OUTSTANDING_SQL} = b.total FROM supplier_bills b WHERE b.id = ?`, [bill.id]),
      db.prepare(`UPDATE supplier_bills SET status='cancelled' WHERE id = ? AND status='open'`).bind(bill.id),
    );
  } else if (credited > 0) {
    adjCode = await nextCode(db, "DCN");
    stmts.push(
      db
        .prepare(`INSERT INTO debt_adjustments(code, type, partner_type, partner_id, amount, status, reason, created_by) VALUES (?, 'return_credit', 'supplier', ?, ?, 'posted', ?, ?)`)
        .bind(adjCode, ret.supplier_id, credited, `Trả hàng NCC ${ret.code}: ${ret.reason}`.slice(0, 300), actor.id),
      allocStmt(db, { kind: "bill", id: bill.id }, credited, { adjustmentCode: adjCode }), // trigger alloc_bill_not_over chặn gạch vượt
    );
  }
  stmts.push(
    db
      .prepare(
        `UPDATE purchase_returns SET status='posted', credited_amount=?, refund_due=?, bill_cancelled=?, approved_by=?, posted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                adjustment_id = ${adjCode ? "(SELECT id FROM debt_adjustments WHERE code = ?)" : "NULL"} WHERE id=? AND status IN ('draft','pending_approval')`,
      )
      .bind(credited, refundDue, cancelBill ? 1 : 0, actor.id, ...(adjCode ? [adjCode] : []), id),
    auditStmt(c, {
      action: "purchase_return.post", entity: "purchase_return", entityId: id, before: { status: ret.status },
      after: { status: "posted", total: ret.total, credited, refundDue, billCancelled: cancelBill, adjustment: adjCode },
    }),
  );
  return stmts;
}

purchaseReturnRoutes.post("/purchase-returns/:id/cancel", requirePerm("inventory.write"), async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const u = c.get("user");
  const r = await loadReturn(db, id);
  if (r.status !== "draft" && r.status !== "pending_approval") throw conflict("not_cancellable", "Chỉ huỷ được phiếu trả hàng đang nháp hoặc chờ duyệt");
  if (r.created_by !== u.id && !can(u.role, "inventory.approve")) throw forbidden();
  await db.batch([
    assertStmt(db, "purchase_return.cancel", `SELECT status IN ('draft','pending_approval') FROM purchase_returns WHERE id = ?`, [id]),
    db.prepare(`UPDATE purchase_returns SET status='cancelled' WHERE id=? AND status IN ('draft','pending_approval')`).bind(id),
    db
      .prepare(`UPDATE approvals SET status='rejected', decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note='Phiếu đã huỷ' WHERE type='purchase_return.post' AND ref_id=? AND status='pending'`)
      .bind(u.id, String(id)),
    auditStmt(c, { action: "purchase_return.cancel", entity: "purchase_return", entityId: id, before: { status: r.status }, after: { status: "cancelled" } }),
  ]);
  const cost = can(u.role, "prices.view_cost");
  return c.json(shape(await loadReturn(db, id), cost));
});

registerApprovalHandler("purchase_return.post", {
  perm: "inventory.approve",
  async onApprove(c, a) {
    const db = c.env.DB;
    const id = Number(a.ref_id);
    const r = await loadReturn(db, id);
    const threshold = await getSettingInt(db, "approval.purchase_return_vnd", 5_000_000);
    if (r.total > threshold && !can(c.get("user").role, "debt.approve")) throw new AppError(403, "forbidden", "Phiếu trả hàng vượt ngưỡng cần người có quyền duyệt công nợ (chủ)");
    return planReturnPost(c, id);
  },
  async onReject(c, a, note) {
    const db = c.env.DB;
    const id = Number(a.ref_id);
    return [
      db.prepare(`UPDATE purchase_returns SET status='rejected' WHERE id = ? AND status = 'pending_approval'`).bind(id),
      auditStmt(c, { action: "purchase_return.rejected", entity: "purchase_return", entityId: id, reason: note }),
    ];
  },
});
