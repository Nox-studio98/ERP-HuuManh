import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDayRangeUtc, vnPeriod, parseDayRange } from "../lib/time";
import { assertStmt, onceStmt } from "../services/guard";
import { assertPeriodOpen } from "../services/period";
import { FUND_ORDER_OK } from "../services/fund-sql";
import { CLEARING_FUND_TYPES } from "../services/finance-reports";
import { guarded, parseBody } from "../services/http";

/**
 * Chuyển tiền giữa các quỹ (tiền mặt → ngân hàng...): MỘT thao tác tạo cặp phiếu liên kết — phiếu chi ở quỹ nguồn + phiếu thu ở quỹ đích —
 * thuộc hai khoản mục có dòng P&L 'transfer' (CHUYEN_QUY_RA / CHUYEN_QUY_VAO) nên không bao giờ vào lãi lỗ.
 * Mọi thứ trong một db.batch kèm audit. Đảo cả cặp bằng POST /fund-transfers/:id/reverse (đảo từng phiếu riêng bị chặn: ref_type != manual).
 */
export const fundTransferRoutes = new Hono<AppBindings>();

const OUT_CAT = 910;
const IN_CAT = 911;

/** Điều kiện SQL "số dư quỹ ?1 (thanh toán đơn + phiếu đã ghi) ≥ ?2"; bind: [fundId, amount] lặp theo thứ tự xuất hiện. */
const BALANCE_OK_SQL = `(COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.fund_id = ? AND p.status='confirmed' AND ${FUND_ORDER_OK}),0)
   + COALESCE((SELECT SUM(CASE WHEN v.direction='in' THEN v.amount ELSE -v.amount END) FROM cash_vouchers v WHERE v.fund_id = ? AND v.status='posted'),0)) >= ?`;

async function fundBalance(db: D1Database, fundId: number) {
  const r = await db
    .prepare(
      `SELECT COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.fund_id = ?1 AND p.status='confirmed' AND ${FUND_ORDER_OK}),0)
            + COALESCE((SELECT SUM(CASE WHEN v.direction='in' THEN v.amount ELSE -v.amount END) FROM cash_vouchers v WHERE v.fund_id = ?1 AND v.status='posted'),0) AS b`,
    )
    .bind(fundId)
    .first<{ b: number }>();
  return r?.b ?? 0;
}

const SEL = `SELECT t.id, t.code, t.from_fund_id AS fromFundId, ff.name AS fromFundName, t.to_fund_id AS toFundId, tf.name AS toFundName,
                    t.amount, t.note, t.period, t.status, t.created_at AS createdAt, t.created_by AS createdBy, u.full_name AS createdByName,
                    t.reversed_at AS reversedAt, t.reverse_reason AS reverseReason,
                    ov.code AS outVoucherCode, iv.code AS inVoucherCode, t.out_voucher_id AS outVoucherId, t.in_voucher_id AS inVoucherId
               FROM fund_transfers t JOIN funds ff ON ff.id = t.from_fund_id JOIN funds tf ON tf.id = t.to_fund_id
               LEFT JOIN users u ON u.id = t.created_by
               LEFT JOIN cash_vouchers ov ON ov.id = t.out_voucher_id LEFT JOIN cash_vouchers iv ON iv.id = t.in_voucher_id`;

fundTransferRoutes.get("/fund-transfers", requirePerm("finance.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.fundId) { conds.push(`(t.from_fund_id = ? OR t.to_fund_id = ?)`); params.push(Number(q.fundId), Number(q.fundId)); }
  if (q.status === "posted" || q.status === "reversed") { conds.push(`t.status = ?`); params.push(q.status); }
  const range = parseDayRange(q.from, q.to);
  if (range) { conds.push(`t.created_at >= ? AND t.created_at < ?`); params.push(vnDayRangeUtc(range.from).from, vnDayRangeUtc(range.to).to); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const cursor = Number(q.cursor) || 0;
  const rows = (await c.env.DB.prepare(`${SEL} ${where}${cursor ? (where ? " AND " : "WHERE ") + "t.id < ?" : ""} ORDER BY t.id DESC LIMIT ?`).bind(...params, ...(cursor ? [cursor] : []), limit + 1).all<any>()).results;
  const items = rows.slice(0, limit);
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

const createBody = z.object({
  fromFundId: z.number().int().positive(),
  toFundId: z.number().int().positive(),
  amount: z.number().int().positive().max(10_000_000_000),
  note: z.string().trim().max(300).optional(),
  /** Khoá chống bấm đúp (client sinh một UUID cho mỗi lần mở form): gửi lại cùng khoá → 409 already_done, không tạo thêm. */
  idempotencyKey: z.string().trim().min(8).max(80).optional(),
});

fundTransferRoutes.post("/fund-transfers", requirePerm("finance.write"), async (c) => {
  const b = await parseBody(c, createBody);
  const db = c.env.DB;
  const user = c.get("user");
  if (b.fromFundId === b.toFundId) throw new AppError(422, "same_fund", "Quỹ nguồn và quỹ đích phải khác nhau");
  const funds = (await db.prepare(`SELECT id, name, type, active FROM funds WHERE id IN (?, ?)`).bind(b.fromFundId, b.toFundId).all<any>()).results;
  const from = funds.find((f) => f.id === b.fromFundId), to = funds.find((f) => f.id === b.toFundId);
  if (!from || !from.active || !to || !to.active) throw new AppError(422, "fund_not_found", "Quỹ không tồn tại hoặc đã ngừng");
  if (CLEARING_FUND_TYPES.includes(from.type) || CLEARING_FUND_TYPES.includes(to.type)) {
    throw new AppError(422, "clearing_fund", "Quỹ chờ đối soát (COD, sàn, thẻ) chuyển bằng luồng đối soát, không dùng chuyển quỹ");
  }
  await assertPeriodOpen(db, new Date(), "phiếu chuyển quỹ");
  const balance = await fundBalance(db, b.fromFundId);
  if (balance < b.amount) throw new AppError(422, "insufficient_fund", `Quỹ "${from.name}" không đủ số dư để chuyển`, { balance, amount: b.amount });

  const code = await nextCode(db, PREFIX.fundTransfer);
  const outCode = await nextCode(db, PREFIX.cashOut);
  const inCode = await nextCode(db, PREFIX.cashIn);
  const period = vnPeriod();
  const note = `Chuyển quỹ ${code}: ${from.name} → ${to.name}${b.note ? ` — ${b.note}` : ""}`;
  const insV = `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by)
                VALUES (?,?,?,?,?,?, 'fund_transfer', (SELECT id FROM fund_transfers WHERE code = ?), 'posted', ?,?,?,?)`;
  await guarded(() =>
    db.batch([
      // Chốt chặn: số dư quỹ nguồn còn đủ tại thời điểm ghi (bấm đồng thời hai lần không rút quá số dư)
      assertStmt(db, "fund_transfer.create", `SELECT ${BALANCE_OK_SQL}`, [b.fromFundId, b.fromFundId, b.amount]),
      ...(b.idempotencyKey ? [onceStmt(db, "fund_transfer", `${user.id}:${b.idempotencyKey}`)] : []),
      db.prepare(`INSERT INTO fund_transfers(code, from_fund_id, to_fund_id, amount, note, period, created_by) VALUES (?,?,?,?,?,?,?)`).bind(code, b.fromFundId, b.toFundId, b.amount, b.note ?? null, period, user.id),
      db.prepare(insV).bind(outCode, "out", b.fromFundId, OUT_CAT, b.amount, to.name, code, period, note, user.id, user.id),
      db.prepare(insV).bind(inCode, "in", b.toFundId, IN_CAT, b.amount, from.name, code, period, note, user.id, user.id),
      db.prepare(`UPDATE fund_transfers SET out_voucher_id = (SELECT id FROM cash_vouchers WHERE code = ?), in_voucher_id = (SELECT id FROM cash_vouchers WHERE code = ?) WHERE code = ?`).bind(outCode, inCode, code),
      auditStmt(c, { action: "fund_transfer.create", entity: "fund_transfer", entityId: code, after: { from: b.fromFundId, to: b.toFundId, amount: b.amount, outVoucher: outCode, inVoucher: inCode, note: b.note ?? null } }),
    ]),
  );
  const row = await db.prepare(`${SEL} WHERE t.code = ?`).bind(code).first();
  return c.json(row, 201);
});

fundTransferRoutes.post("/fund-transfers/:id/reverse", requirePerm("finance.write"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300) }));
  const db = c.env.DB;
  const user = c.get("user");
  const t = await db.prepare(`SELECT * FROM fund_transfers WHERE id = ?`).bind(id).first<any>();
  if (!t) throw notFound("not_found", "Không tìm thấy phiếu chuyển quỹ");
  if (t.status !== "posted") throw conflict("already_reversed", "Phiếu chuyển quỹ đã được đảo");
  await assertPeriodOpen(db, new Date(), "bút toán đảo chuyển quỹ");
  const balance = await fundBalance(db, t.to_fund_id);
  if (balance < t.amount) throw new AppError(422, "insufficient_fund", "Quỹ nhận không còn đủ số dư để hoàn lại khoản đã chuyển", { balance, amount: t.amount });
  const rv = await db.prepare(`SELECT id, code, direction, fund_id, category_id, amount, counterparty FROM cash_vouchers WHERE id IN (?, ?)`).bind(t.out_voucher_id, t.in_voucher_id).all<any>();
  const outV = rv.results.find((v) => v.id === t.out_voucher_id), inV = rv.results.find((v) => v.id === t.in_voucher_id);
  if (!outV || !inV) throw new AppError(500, "transfer_broken", "Thiếu phiếu của lần chuyển quỹ");
  const period = vnPeriod();
  const codeIn = await nextCode(db, PREFIX.cashIn);   // phiếu thu đảo phiếu chi ở quỹ nguồn
  const codeOut = await nextCode(db, PREFIX.cashOut); // phiếu chi đảo phiếu thu ở quỹ đích
  const ins = `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, reverses_id)
               VALUES (?,?,?,?,?,?, 'fund_transfer', ?, 'posted', ?,?,?,?,?)`;
  await guarded(() =>
    db.batch([
      assertStmt(db, "fund_transfer.reverse", `SELECT status = 'posted' FROM fund_transfers WHERE id = ?`, [id]),
      assertStmt(db, "fund_transfer.reverse_balance", `SELECT ${BALANCE_OK_SQL}`, [t.to_fund_id, t.to_fund_id, t.amount]),
      onceStmt(db, "fund_transfer.reverse", id),
      db.prepare(`UPDATE fund_transfers SET status='reversed', reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reversed_by = ?, reverse_reason = ? WHERE id = ? AND status='posted'`).bind(user.id, body.reason, id),
      db.prepare(ins).bind(codeIn, "in", outV.fund_id, outV.category_id, outV.amount, outV.counterparty, id, period, `Đảo phiếu ${outV.code}: ${body.reason}`, user.id, user.id, outV.id),
      db.prepare(ins).bind(codeOut, "out", inV.fund_id, inV.category_id, inV.amount, inV.counterparty, id, period, `Đảo phiếu ${inV.code}: ${body.reason}`, user.id, user.id, inV.id),
      auditStmt(c, { action: "fund_transfer.reverse", entity: "fund_transfer", entityId: t.code, before: { status: "posted", period: t.period }, after: { status: "reversed", reversalVouchers: [codeIn, codeOut] }, reason: body.reason }),
    ]),
  );
  return c.json(await db.prepare(`${SEL} WHERE t.id = ?`).bind(id).first());
});
