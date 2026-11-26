/**
 * Báo cáo theo hình thức thanh toán, thu/chi quỹ và chi tiết ca — dùng chung cho Báo cáo cuối ngày, tổng kết/lịch sử ca và phiếu bàn giao.
 * Chỉ ĐỌC. Tiền số nguyên VND. Không bao giờ trả giá vốn/lãi gộp ở đây (báo cáo ngày tự thêm khi có quyền prices.view_cost).
 * `where` là điều kiện SQL trên bảng orders (alias o), chỉ tính đơn status='completed'.
 */
import { salesSummary } from "./salesreport";

export const PAY_ORDER = ["cash", "transfer", "qr", "card", "ewallet", "points", "voucher", "credit", "cod", "marketplace"] as const;
/** Hình thức luôn hiện (kể cả bằng 0) để thu ngân đối chiếu; cod/marketplace chỉ hiện khi có phát sinh. */
const ALWAYS = new Set(["cash", "transfer", "qr", "card", "ewallet", "points", "voucher", "credit"]);

export type PayRow = { method: string; sold: number; refunded: number; net: number; kind: "payment" | "discount" };

/**
 * Bán/hoàn theo hình thức: `sold` = tiền thu trên đơn bán, `refunded` = tiền hoàn trên phiếu trả (payments âm), `net` = sold − refunded.
 * `points` / `voucher` là phần giảm trừ không thu tiền (điểm tích luỹ đã đổi, voucher đã dùng) của đơn bán — không phải dòng tiền.
 */
export async function paymentBreakdown(db: D1Database, where: string, params: unknown[]): Promise<PayRow[]> {
  const base = `o.status = 'completed' AND (${where})`;
  const pay = (
    await db
      .prepare(
        `SELECT p.method,
                COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END),0) AS sold,
                COALESCE(SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END),0) AS refunded
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.status = 'confirmed' AND ${base} GROUP BY p.method`,
      )
      .bind(...params)
      .all<{ method: string; sold: number; refunded: number }>()
  ).results;
  const disc = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN d.points_redeemed > 0 THEN d.amount ELSE 0 END),0) AS points,
              COALESCE(SUM(CASE WHEN d.voucher_id IS NOT NULL THEN d.amount ELSE 0 END),0) AS voucher
         FROM order_discounts d JOIN orders o ON o.id = d.order_id
        WHERE o.kind = 'sale' AND ${base}`,
    )
    .bind(...params)
    .first<{ points: number; voucher: number }>();
  const map = new Map<string, PayRow>();
  for (const m of PAY_ORDER) map.set(m, { method: m, sold: 0, refunded: 0, net: 0, kind: m === "points" || m === "voucher" ? "discount" : "payment" });
  for (const r of pay) {
    const row = map.get(r.method) ?? { method: r.method, sold: 0, refunded: 0, net: 0, kind: "payment" as const };
    row.sold = r.sold; row.refunded = r.refunded; map.set(r.method, row);
  }
  map.get("points")!.sold = disc?.points ?? 0;
  map.get("voucher")!.sold = disc?.voucher ?? 0;
  const rows = [...map.values()].map((r) => ({ ...r, net: r.sold - r.refunded }));
  return rows.filter((r) => ALWAYS.has(r.method) || r.sold || r.refunded);
}

/** Phiếu thu/chi đã ghi sổ trong khoảng [from, to) UTC, tính ròng: phiếu đảo trừ vào đúng chiều của phiếu gốc. Tổng thu/chi không gồm chuyển quỹ nội bộ (`transfers`). */
export async function cashFlow(db: D1Database, from: string, to: string) {
  const rows = (
    await db
      .prepare(
        `SELECT CASE WHEN v.reverses_id IS NULL THEN v.direction WHEN v.direction = 'in' THEN 'out' ELSE 'in' END AS direction,
                COALESCE(cc.name, 'Khác') AS category,
                CASE WHEN cc.pnl_line = 'transfer' THEN 1 ELSE 0 END AS transfer,
                COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN v.reverses_id IS NULL THEN v.amount ELSE -v.amount END),0) AS amount
           FROM cash_vouchers v LEFT JOIN cash_categories cc ON cc.id = v.category_id
          WHERE v.status = 'posted' AND v.created_at >= ? AND v.created_at < ?
          GROUP BY 1, 2, 3 ORDER BY 1, amount DESC`,
      )
      .bind(from, to)
      .all<{ direction: "in" | "out"; category: string; transfer: number; count: number; amount: number }>()
  ).results;
  // Chuyển tiền giữa các quỹ (khoản mục dòng P&L 'transfer') không phải thu/chi của cửa hàng → không cộng vào tổng, báo riêng
  const sum = (d: string) => rows.filter((r) => r.direction === d && !r.transfer).reduce((s, r) => s + r.amount, 0);
  const transfers = rows.filter((r) => r.transfer && r.direction === "out").reduce((s, r) => s + r.amount, 0);
  return { in: sum("in"), out: sum("out"), transfers, byCategory: rows.map((r) => ({ ...r, transfer: !!r.transfer })) };
}

/** Huỷ đơn trong khoảng [from, to) UTC (theo thời điểm huỷ trong nhật ký, không theo ngày tạo đơn). */
export async function cancelledOrders(db: D1Database, from: string, to: string) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(before_json, '$.total') AS INTEGER)),0) AS total
         FROM audit_log WHERE action = 'order.void' AND at >= ? AND at < ?`,
    )
    .bind(from, to)
    .first<{ n: number; total: number }>();
  return { count: r?.n ?? 0, total: r?.total ?? 0 };
}

type ShiftRow = { id: number; user_id: number; fund_id: number; opened_at: string; opening_cash: number; closed_at: string | null; expected_cash: number | null; counted_cash: number | null; diff_cash: number | null; diff_reason: string | null; status: string };

/** Công thức tiền mặt dự kiến của ca (nguồn duy nhất — routes/pos.ts dùng khi chốt ca). */
export async function cashFormula(db: D1Database, s: ShiftRow) {
  const sales = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END),0) AS sold, COALESCE(SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END),0) AS refunded
         FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.shift_id = ? AND o.status = 'completed' AND p.method = 'cash' AND p.status = 'confirmed'`,
    )
    .bind(s.id)
    .first<{ sold: number; refunded: number }>();
  const dep = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS s FROM cash_vouchers
        WHERE status='posted' AND ref_type='order_deposit' AND fund_id = ? AND created_by = ? AND created_at >= ? AND (? IS NULL OR created_at <= ?)`,
    )
    .bind(s.fund_id, s.user_id, s.opened_at, s.closed_at, s.closed_at)
    .first<{ s: number }>();
  const voidRef = await db
    .prepare(`SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.refund_shift_id = ? AND p.method = 'cash' AND p.status = 'refunded'`)
    .bind(s.id)
    .first<{ s: number }>();
  const cashSold = sales?.sold ?? 0, cashRefunded = sales?.refunded ?? 0, deposits = dep?.s ?? 0, voidRefunds = voidRef?.s ?? 0;
  return { opening: s.opening_cash, cashSold, cashRefunded, deposits, voidRefunds, expected: s.opening_cash + cashSold - cashRefunded + deposits - voidRefunds };
}

const SHIFT_COLS = `s.id, s.user_id, s.fund_id, s.opened_at, s.opening_cash, s.closed_at, s.expected_cash, s.counted_cash, s.diff_cash, s.diff_reason, s.status`;

/** Chi tiết một ca (đang mở hoặc đã chốt). Trả null nếu không có ca. */
export async function shiftSummary(db: D1Database, id: number) {
  const s = await db
    .prepare(`SELECT ${SHIFT_COLS}, u.full_name AS cashier_name, st.name AS store_name FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN stores st ON st.id = s.store_id WHERE s.id = ?`)
    .bind(id)
    .first<ShiftRow & { cashier_name: string; store_name: string | null }>();
  if (!s) return null;
  const sales = await salesSummary(db, `o.shift_id = ?`, [id]);
  const byPayment = await paymentBreakdown(db, `o.shift_id = ?`, [id]);
  const formula = await cashFormula(db, s);
  const to = s.closed_at ?? new Date().toISOString();
  const vouchers = (
    await db
      .prepare(
        `SELECT v.code, v.direction, v.amount, v.ref_type, v.note, v.created_at, COALESCE(cc.name,'Khác') AS category
           FROM cash_vouchers v LEFT JOIN cash_categories cc ON cc.id = v.category_id
          WHERE v.status = 'posted' AND v.fund_id = ? AND v.created_by = ? AND v.created_at >= ? AND v.created_at <= ? ORDER BY v.id LIMIT 100`,
      )
      .bind(s.fund_id, s.user_id, s.opened_at, to)
      .all<any>()
  ).results.map((v) => ({ code: v.code, direction: v.direction, amount: v.amount, category: v.category, note: v.note, createdAt: v.created_at, inExpected: v.ref_type === "order_deposit" }));
  const returns = (
    await db
      .prepare(
        `SELECT o.code, o.total, o.completed_at,
                (SELECT GROUP_CONCAT(DISTINCT p.method) FROM payments p WHERE p.order_id = o.id AND p.status = 'confirmed') AS methods
           FROM orders o WHERE o.shift_id = ? AND o.kind = 'return' AND o.status = 'completed' ORDER BY o.id LIMIT 100`,
      )
      .bind(id)
      .all<any>()
  ).results.map((r) => ({ code: r.code, total: r.total, completedAt: r.completed_at, methods: r.methods ? String(r.methods).split(",") : [] }));
  const voided = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM orders WHERE refund_shift_id = ? AND status = 'cancelled'`)
    .bind(id)
    .first<{ n: number; total: number }>();
  return {
    shift: {
      id: s.id, status: s.status, cashierId: s.user_id, cashierName: s.cashier_name, storeName: s.store_name,
      openedAt: s.opened_at, closedAt: s.closed_at, openingCash: s.opening_cash,
      expectedCash: s.status === "closed" ? s.expected_cash : formula.expected,
      countedCash: s.counted_cash, diffCash: s.diff_cash, diffReason: s.diff_reason,
    },
    sales: { saleCount: sales.saleCount, saleTotal: sales.saleTotal, returnCount: sales.returnCount, returnTotal: sales.returnTotal, revenue: sales.revenue },
    byChannel: sales.byChannel,
    byPayment,
    cashFormula: formula,
    vouchers: { in: vouchers.filter((v) => v.direction === "in").reduce((a, v) => a + v.amount, 0), out: vouchers.filter((v) => v.direction === "out").reduce((a, v) => a + v.amount, 0), items: vouchers },
    returns,
    voided: { count: voided?.n ?? 0, total: voided?.total ?? 0 },
  };
}
