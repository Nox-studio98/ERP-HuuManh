/**
 * SePay × sổ quỹ (xem docs/SEPAY.md "Sổ quỹ và khoản chờ xử lý").
 *
 * Bất biến: Σ tiền SePay báo về (đúng tài khoản cửa hàng) − Σ đã hoàn = mức tăng số dư quỹ ngân hàng.
 *  - Khớp ngay (đơn web DH, hoá đơn sỉ HDS): ghi thẳng chứng từ thật (payments / phiếu thu công nợ), không qua khoản chờ.
 *  - Tiền vào chưa khớp / chờ hoàn / QR quầy đã nhận: phiếu thu `CK_CHO_XL` (pnl_line = transfer, KHÔNG vào lãi lỗ) cùng batch với việc lưu sự kiện.
 *  - Gán đơn / hoá đơn, dùng QR để hoàn tất đơn POS, đã hoàn, bỏ qua có chọn khoản mục: phiếu chi `CK_CHO_XL_RA` cùng batch với chứng từ thật
 *    (ròng quỹ không đổi lần hai, khoản chờ về 0).
 *  - Dòng sao kê trùng giao dịch SePay đã ghi quỹ: đánh dấu liên kết, không tạo phiếu thu lần nữa.
 */
import type { Context } from "hono";
import type { AppBindings } from "../env";
import { AppError } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { nextCode, PREFIX } from "../lib/codes";
import { vnDate, vnPeriod } from "../lib/time";
import { assertStmt, onceStmt } from "./guard";
import { bankFundId } from "./online-payments";
import { isPeriodLocked } from "./period";
import { sepayConfig, SEPAY_SYSTEM_USER_ID } from "./sepay";

type Ctx = Context<AppBindings>;

export const HOLD_IN = "CK_CHO_XL";
export const HOLD_OUT = "CK_CHO_XL_RA";
/** Lý do chưa khớp mà tiền KHÔNG phải tiền vào tài khoản cửa hàng (hoặc SePay chưa bật) → không lập phiếu quỹ. */
export const NO_LEDGER_REASONS = ["sepay_disabled", "not_money_in", "invalid_amount", "account_not_configured", "wrong_account"];

export interface LedgerEvent {
  id: number; amount: number; txn_at: string | null; code: string | null; reference_code: string | null;
  hold_in_voucher_id?: number | null; hold_out_voucher_id?: number | null;
}

async function catId(db: D1Database, code: string) {
  const r = await db.prepare(`SELECT id FROM cash_categories WHERE code = ?`).bind(code).first<{ id: number }>();
  if (!r) throw new AppError(500, "category_missing", `Thiếu khoản mục ${code}`);
  return r.id;
}

/** Ngày ghi phiếu thu chờ: thời điểm giao dịch; kỳ đã khoá → hôm nay (kèm ghi chú); hôm nay cũng khoá → null (chưa ghi được, để thao tác "ghi các giao dịch chờ cũ"). */
export async function holdDate(db: D1Database, txnAt: string | null) {
  const now = new Date();
  const at = txnAt && !Number.isNaN(Date.parse(txnAt)) ? new Date(txnAt) : now;
  if (at.getTime() > now.getTime()) return { createdAt: now.toISOString(), period: vnPeriod(now), shifted: false };
  if (!(await isPeriodLocked(db, at))) return { createdAt: at.toISOString(), period: vnPeriod(at), shifted: false };
  if (await isPeriodLocked(db, now)) return null;
  return { createdAt: now.toISOString(), period: vnPeriod(now), shifted: true };
}

const voucherSql = `INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, ref_type, ref_id, status, period, note, created_by, approved_by, created_at)
  VALUES (?,?,?,?,?,?, 'sepay_event', ?, 'posted', ?,?,?,?,?)`;

/** Phiếu thu vào khoản chờ xử lý + gắn vào sự kiện. Trả [] nếu chưa ghi được (không có quỹ / kỳ khoá cả hôm nay) — không bao giờ ném lỗi. */
export async function holdInStmts(db: D1Database, ev: LedgerEvent): Promise<D1PreparedStatement[]> {
  try {
    const d = await holdDate(db, ev.txn_at);
    if (!d) return [];
    const fundId = await bankFundId(db);
    const cat = await catId(db, HOLD_IN);
    const code = await nextCode(db, PREFIX.cashIn);
    const note = `SePay chưa xử lý${ev.code ? ` · mã ${ev.code}` : ""}${ev.reference_code ? ` · tham chiếu ${ev.reference_code}` : ""}${d.shifted ? " · kỳ giao dịch đã khoá sổ, ghi vào ngày hiện tại" : ""}`;
    return [
      onceStmt(db, "sepay.hold_in", ev.id),
      db.prepare(voucherSql).bind(code, "in", fundId, cat, ev.amount, null, ev.id, d.period, note, SEPAY_SYSTEM_USER_ID, SEPAY_SYSTEM_USER_ID, d.createdAt),
      db.prepare(`UPDATE sepay_events SET hold_in_voucher_id = (SELECT id FROM cash_vouchers WHERE code = ?) WHERE id = ? AND hold_in_voucher_id IS NULL`).bind(code, ev.id),
    ];
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "sepay_hold_in_skipped", eventId: ev.id, err: String((e as Error)?.message).slice(0, 100) }));
    return [];
  }
}

/** Lấy lại trạng thái phiếu chờ của sự kiện lúc thao tác (để chốt chặn đồng thời). */
export async function holdState(db: D1Database, eventId: number) {
  return (await db.prepare(`SELECT hold_in_voucher_id AS i, hold_out_voucher_id AS o FROM sepay_events WHERE id = ?`).bind(eventId).first<{ i: number | null; o: number | null }>()) ?? { i: null, o: null };
}

/**
 * Phiếu chi chuyển khỏi khoản chờ (cùng quỹ với phiếu thu chờ), kèm chốt chặn "trạng thái phiếu chờ không đổi từ lúc đọc".
 * Sự kiện chưa có phiếu chờ (dữ liệu cũ chưa ghi vào sổ) → chỉ có chốt chặn, không có phiếu chi: tiền chưa từng vào quỹ nên không cần rút ra.
 * Gọi `assertPeriodOpen` khi có phiếu chi (ghi vào hôm nay).
 */
export async function holdOutStmts(db: D1Database, ev: LedgerEvent, o: { userId: number; note: string; state: { i: number | null; o: number | null } }): Promise<{ stmts: D1PreparedStatement[]; code: string | null }> {
  const guard = assertStmt(db, "sepay.hold_state", `SELECT hold_in_voucher_id IS ? AND hold_out_voucher_id IS ? FROM sepay_events WHERE id = ?`, [o.state.i, o.state.o, ev.id]);
  if (!o.state.i || o.state.o) return { stmts: [guard], code: null };
  if (await isPeriodLocked(db, new Date())) throw new AppError(423, "period_locked", `Kỳ ${vnPeriod()} đã khoá sổ, không chuyển khoản chờ xử lý ra được — hãy mở khoá hoặc lập bút toán ở kỳ sau`, { period: vnPeriod() });
  const fund = await db.prepare(`SELECT fund_id FROM cash_vouchers WHERE id = ?`).bind(o.state.i).first<{ fund_id: number }>();
  const cat = await catId(db, HOLD_OUT);
  const code = await nextCode(db, PREFIX.cashOut);
  return {
    code,
    stmts: [
      guard,
      db.prepare(voucherSql).bind(code, "out", fund!.fund_id, cat, ev.amount, null, ev.id, vnPeriod(), o.note.slice(0, 480), o.userId, o.userId, new Date().toISOString()),
      db.prepare(`UPDATE sepay_events SET hold_out_voucher_id = (SELECT id FROM cash_vouchers WHERE code = ?) WHERE id = ? AND hold_out_voucher_id IS NULL`).bind(code, ev.id),
    ],
  };
}

/** Phiếu thu vào khoản mục thật (bỏ qua có chọn khoản mục; cũng dùng khi sự kiện cũ chưa có phiếu chờ). */
export async function incomeStmt(db: D1Database, ev: LedgerEvent, o: { userId: number; categoryId: number; note: string; fundId?: number }) {
  const fundId = o.fundId ?? (await bankFundId(db));
  const code = await nextCode(db, PREFIX.cashIn);
  return [db.prepare(voucherSql).bind(code, "in", fundId, o.categoryId, ev.amount, null, ev.id, vnPeriod(), o.note.slice(0, 480), o.userId, o.userId, new Date().toISOString())];
}

/** Khoản mục thu được chọn khi "Bỏ qua": thu, không phải khoản chờ, không phải chuyển quỹ/số dư đầu kỳ. */
export async function ignoreCategory(db: D1Database, categoryId: number) {
  const c = await db.prepare(`SELECT id, code, direction, pnl_line FROM cash_categories WHERE id = ?`).bind(categoryId).first<{ id: number; code: string; direction: string; pnl_line: string | null }>();
  if (!c) throw new AppError(422, "category_not_found", "Khoản mục không tồn tại");
  if (c.direction !== "in" || c.code === HOLD_IN || c.pnl_line === "transfer") throw new AppError(422, "category_invalid", "Chọn khoản mục thu thật (không phải khoản chờ xử lý / chuyển quỹ)");
  return c;
}

// ------------------------------------------------------------------ số dư khoản chờ
export async function holdSummary(db: D1Database) {
  const bal = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN v.direction='in' THEN v.amount ELSE -v.amount END),0) AS balance FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id
        WHERE v.status='posted' AND cc.code IN ('${HOLD_IN}','${HOLD_OUT}')`,
    )
    .first<{ balance: number }>();
  const open = await db
    .prepare(`SELECT COUNT(*) AS n FROM sepay_events WHERE hold_in_voucher_id IS NOT NULL AND hold_out_voucher_id IS NULL`)
    .first<{ n: number }>();
  const legacy = await legacyCandidates(db);
  return { balance: bal?.balance ?? 0, openCount: open?.n ?? 0, legacy: { count: legacy.length, amount: legacy.reduce((s, r) => s + r.amount, 0) } };
}

// ------------------------------------------------------------------ dữ liệu cũ chưa ghi vào sổ
interface LegacyRow extends LedgerEvent { status: string; reason: string | null; account_number: string | null }

/** Sự kiện cần ghi vào khoản chờ nhưng chưa có phiếu (trước migration 0045, hoặc kỳ khoá lúc đó). */
export async function legacyCandidates(db: D1Database): Promise<LegacyRow[]> {
  const cfg = await sepayConfig(db);
  const { results } = await db
    .prepare(
      `SELECT e.id, e.amount, e.txn_at, e.code, e.reference_code, e.status, e.reason, e.account_number FROM sepay_events e
        WHERE e.hold_in_voucher_id IS NULL AND e.transfer_type = 'in' AND e.amount > 0
          AND (e.status IN ('unmatched','refund_pending')
               OR (e.kind = 'pos' AND e.status = 'matched' AND EXISTS (SELECT 1 FROM pos_qr_requests r WHERE r.event_id = e.id AND r.status = 'paid')))
          AND COALESCE(e.reason, '') NOT IN (${NO_LEDGER_REASONS.map((r) => `'${r}'`).join(",")})
        ORDER BY e.id`,
    )
    .all<LegacyRow>();
  return results.filter((r) => cfg.accounts.includes((r.account_number ?? "").trim()));
}

export async function legacyPreview(db: D1Database) {
  const rows = await legacyCandidates(db);
  return { count: rows.length, amount: rows.reduce((s, r) => s + r.amount, 0), items: rows.slice(0, 50).map((r) => ({ id: r.id, amount: r.amount, txnAt: r.txn_at, code: r.code, status: r.status, reason: r.reason })) };
}

/** Ghi một lần các giao dịch chờ cũ vào sổ: mỗi sự kiện một batch (khoá một lần + audit). `expected` phải khớp bản xem trước. */
export async function legacyPost(c: Ctx, expected: { count: number; amount: number }) {
  const db = c.env.DB;
  const rows = await legacyCandidates(db);
  const amount = rows.reduce((s, r) => s + r.amount, 0);
  if (rows.length !== expected.count || amount !== expected.amount) throw new AppError(409, "preview_changed", "Danh sách giao dịch chờ đã thay đổi so với bản xem trước — hãy xem lại", { count: rows.length, amount });
  let posted = 0, skipped = 0, postedAmount = 0;
  for (const ev of rows) {
    const hold = await holdInStmts(db, ev);
    if (!hold.length) { skipped++; continue; }
    try {
      await db.batch([
        assertStmt(db, "sepay.legacy_hold", `SELECT hold_in_voucher_id IS NULL FROM sepay_events WHERE id = ?`, [ev.id]),
        ...hold,
        auditStmt(c, { action: "sepay.ledger_backfill", entity: "sepay_event", entityId: ev.id, after: { amount: ev.amount, status: ev.status } }),
      ]);
      posted++; postedAmount += ev.amount;
    } catch (e) {
      if (/state_changed|UNIQUE|already_done/i.test(String((e as Error)?.message) + (e instanceof AppError ? e.code : ""))) { skipped++; continue; } // vừa được ghi ở nơi khác
      throw e;
    }
  }
  return { posted, skipped, amount: postedAmount };
}

// ------------------------------------------------------------------ sao kê ngân hàng ↔ giao dịch SePay
const normRef = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const refsAgree = (a: string | null | undefined, b: string | null | undefined) => {
  const x = normRef(a), y = normRef(b);
  if (!x || !y || (b ?? "").includes("|")) return true; // thiếu mã (hoặc mã sao kê do hệ thống tự ghép) → không dùng để loại
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)));
};

/**
 * Giao dịch SePay đã ghi vào quỹ ngân hàng mà dòng sao kê này có thể trùng: cùng quỹ, cùng số tiền, cùng ngày VN,
 * mã tham chiếu cùng khi cả hai có; chưa gắn dòng sao kê nào. Trả danh sách id (≥2 = không tự quyết).
 */
export async function sepayCandidates(db: D1Database, txn: { fund_id: number; amount: number; txn_date: string; bank_ref: string | null }): Promise<number[]> {
  if (txn.amount <= 0) return [];
  let fundId: number;
  try { fundId = await bankFundId(db); } catch { return []; }
  if (fundId !== txn.fund_id) return [];
  const day = txn.txn_date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > vnDate(new Date(Date.now() + 86400_000))) return [];
  const { results } = await db
    .prepare(
      `SELECT e.id, e.reference_code FROM sepay_events e
        WHERE e.transfer_type = 'in' AND e.amount = ?1 AND date(e.txn_at, '+7 hours') = ?2
          AND (e.status = 'matched' OR e.hold_in_voucher_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.sepay_event_id = e.id)
        ORDER BY e.id`,
    )
    .bind(txn.amount, day)
    .all<{ id: number; reference_code: string | null }>();
  return results.filter((r) => refsAgree(r.reference_code, txn.bank_ref)).map((r) => r.id);
}

/** Gắn dòng sao kê với giao dịch SePay đã ghi quỹ (không phiếu thu mới). */
export async function linkBankToSepay(c: Ctx, bankTxnId: number, eventId: number, how: "auto" | "manual") {
  const db = c.env.DB;
  await db.batch([
    assertStmt(db, "bank.match", `SELECT status = 'unmatched' FROM bank_transactions WHERE id = ?`, [bankTxnId]),
    assertStmt(db, "bank.sepay_link", `SELECT NOT EXISTS (SELECT 1 FROM bank_transactions WHERE sepay_event_id = ?)`, [eventId]),
    db.prepare(`UPDATE bank_transactions SET status='matched', matched_type='sepay', matched_id=?1, sepay_event_id=?1 WHERE id = ?2 AND status='unmatched'`).bind(eventId, bankTxnId),
    auditStmt(c, { action: `bank.sepay_link_${how}`, entity: "bank_transaction", entityId: bankTxnId, after: { sepayEventId: eventId } }),
  ]);
}
