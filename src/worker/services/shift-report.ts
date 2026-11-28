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
export async function paymentBreakdown(db: D1Database, where: string, params: unknown[], opts: { closedAt?: string | null } = {}): Promise<PayRow[]> {
  // R2-INV-01: ca đã chốt tính theo trạng thái lúc chốt (đơn huỷ sau khi chốt vẫn nằm trong ca gốc)
  const snap = !!opts.closedAt;
  const base = snap ? `(o.status = 'completed' OR (o.status = 'cancelled' AND o.voided_at > ?)) AND (${where})` : `o.status = 'completed' AND (${where})`;
  if (snap) params = [opts.closedAt, ...params];
  const payOk = snap ? `(p.status = 'confirmed' OR (p.status = 'refunded' AND o.status = 'cancelled'))` : `p.status = 'confirmed'`;
  const pay = (
    await db
      .prepare(
        `SELECT p.method,
                COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END),0) AS sold,
                COALESCE(SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END),0) AS refunded
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE ${payOk} AND ${base} GROUP BY p.method`,
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
export async function cashFlow(db: D1Database, from: string, to: string, opts: { sensitive?: boolean } = {}) {
  const rows = (
    await db
      .prepare(
        `SELECT CASE WHEN v.reverses_id IS NULL THEN v.direction WHEN v.direction = 'in' THEN 'out' ELSE 'in' END AS direction,
                COALESCE(cc.name, 'Khác') AS category,
                CASE WHEN cc.pnl_line = 'transfer' THEN 1 ELSE 0 END AS transfer,
                CASE WHEN COALESCE(v.ref_type,'') IN ('payroll_item','salary_advance','payroll') OR cc.pnl_line = 'payroll' OR cc.code = 'LUONG' THEN 1 ELSE 0 END AS payroll,
                COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN v.reverses_id IS NULL THEN v.amount ELSE -v.amount END),0) AS amount
           FROM cash_vouchers v LEFT JOIN cash_categories cc ON cc.id = v.category_id
          WHERE v.status = 'posted' AND v.created_at >= ? AND v.created_at < ?
          GROUP BY 1, 2, 3, 4 ORDER BY 1, amount DESC`,
      )
      .bind(from, to)
      .all<{ direction: "in" | "out"; category: string; transfer: number; payroll: number; count: number; amount: number }>()
  ).results;
  // C2-08: người không có hr.sensitive không thấy số phiếu/số tiền lương, tạm ứng từng người → gộp một dòng "Chi lương (tổng)" mỗi chiều, không kèm số phiếu
  if (!opts.sensitive) {
    const merged: typeof rows = [];
    for (const r of rows) {
      if (!r.payroll) { merged.push(r); continue; }
      const g = merged.find((m) => m.payroll && m.direction === r.direction);
      if (g) g.amount += r.amount;
      else merged.push({ ...r, category: "Chi lương (tổng)", count: 0 });
    }
    rows.splice(0, rows.length, ...merged.sort((a, b) => (a.direction === b.direction ? b.amount - a.amount : a.direction < b.direction ? -1 : 1)));
  }
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

export type ShiftRow = { id: number; user_id: number; fund_id: number; opened_at: string; opening_cash: number; closed_at: string | null; expected_cash: number | null; counted_cash: number | null; diff_cash: number | null; diff_reason: string | null; status: string };

/** Điều kiện "created_at nằm trong thời gian ca" (ca đang mở: không có cận trên). */
const inShift = (col: string) => `${col} >= ?  AND (? IS NULL OR ${col} <= ?)`;

/**
 * Tổng phiếu quỹ (thu − chi) thuộc ca theo `ref_type`. PA-5: phiếu ĐẢO (reverses_id) tính theo phiếu GỐC — phiếu gốc do người mở ca lập trong ca
 * thì phiếu đảo (do bất kỳ ai lập, trong ca) trừ ngược khỏi tiền mặt dự kiến; không tính theo người lập phiếu đảo.
 */
async function shiftVoucherSum(db: D1Database, s: ShiftRow, refType: string, extra = "") {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN v.direction='in' THEN v.amount ELSE -v.amount END),0) AS s
         FROM cash_vouchers v LEFT JOIN cash_vouchers v0 ON v0.id = v.reverses_id
        WHERE v.status='posted' AND v.ref_type = ? AND v.fund_id = ? ${extra}
          AND ( (v.reverses_id IS NULL AND v.created_by = ? AND ${inShift("v.created_at")})
             OR (v.reverses_id IS NOT NULL AND v0.created_by = ? AND ${inShift("v0.created_at")} AND ${inShift("v.created_at")}) )`,
    )
    .bind(refType, s.fund_id, s.user_id, s.opened_at, s.closed_at, s.closed_at, s.user_id, s.opened_at, s.closed_at, s.closed_at, s.opened_at, s.closed_at, s.closed_at)
    .first<{ s: number }>();
  return r?.s ?? 0;
}

/**
 * Tiền thu/hoàn của đơn GIAO TỪ QUẦY (POS-KV B3) theo hình thức, tính vào ca (không gồm COD — người giao thu, không qua két/quầy).
 * Thu: theo ca tạo đơn. Hoàn: tiền mặt → `refund_shift_id` (B-N3) hoặc, khi không có, ca tạo đơn nếu hoàn trong thời gian ca; hình thức khác → ca tạo đơn nếu hoàn trong thời gian ca.
 */
async function deliveryPayments(db: D1Database, s: ShiftRow) {
  const { results } = await db
    .prepare(
      `SELECT p.method,
              COALESCE(SUM(CASE WHEN p.amount > 0 AND o.pos_shift_id = ?1 THEN p.amount ELSE 0 END),0) AS sold,
              COALESCE(SUM(CASE WHEN p.amount < 0 AND (p.refund_shift_id = ?1
                     OR (p.refund_shift_id IS NULL AND o.pos_shift_id = ?1 AND p.created_at >= ?2 AND (?3 IS NULL OR p.created_at <= ?3))) THEN -p.amount ELSE 0 END),0) AS refunded
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.status = 'confirmed' AND p.method <> 'cod' AND (o.pos_shift_id = ?1 OR p.refund_shift_id = ?1)
        GROUP BY p.method`,
    )
    .bind(s.id, s.opened_at, s.closed_at)
    .all<{ method: string; sold: number; refunded: number }>();
  return results;
}

/** Công thức tiền mặt dự kiến của ca (nguồn duy nhất — routes/pos.ts dùng khi chốt ca, routes/finance.ts cho ca đang mở). */
export async function cashFormula(db: D1Database, s: ShiftRow) {
  // R2-INV-01: ca đã chốt → tính đơn theo trạng thái lúc chốt (đơn huỷ sau chốt vẫn tính; khoản hoàn thuộc ca hoàn — refund_shift_id)
  const closedAt = s.status === "closed" ? s.closed_at : null;
  const sales = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END),0) AS sold, COALESCE(SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END),0) AS refunded
         FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.shift_id = ?
          AND ${closedAt ? `(o.status = 'completed' OR (o.status = 'cancelled' AND o.voided_at > ?)) AND (p.status = 'confirmed' OR (p.status = 'refunded' AND o.status = 'cancelled'))` : `o.status = 'completed' AND p.status = 'confirmed'`}
          AND p.method = 'cash'`,
    )
    .bind(...(closedAt ? [s.id, closedAt] : [s.id]))
    .first<{ sold: number; refunded: number }>();
  const deposits = await shiftVoucherSum(db, s, "order_deposit");
  // B1: thu nợ khách lẻ tại quầy (phiếu thu công nợ của người mở ca, vào quỹ của ca = tiền mặt). PA-5: phiếu đảo trừ ngược theo phiếu gốc.
  const debtCollected = await shiftVoucherSum(db, s, "debt_payment", `AND EXISTS (SELECT 1 FROM debt_payments dp WHERE dp.id = v.ref_id AND dp.partner_type = 'customer')`);
  const voidRef = await db
    .prepare(`SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.refund_shift_id = ? AND p.method = 'cash' AND p.status = 'refunded'`)
    .bind(s.id)
    .first<{ s: number }>();
  // Đơn giao từ quầy (POS-KV B3): tiền mặt khách trả trước nằm trong két ca ngay lúc tạo đơn (đơn chưa hoàn tất vẫn tính); hoàn tiền mặt trừ vào ca chịu hoàn (B-N3)
  const cash = (await deliveryPayments(db, s)).find((d) => d.method === "cash");
  const cashSold = (sales?.sold ?? 0) + (cash?.sold ?? 0), cashRefunded = (sales?.refunded ?? 0) + (cash?.refunded ?? 0), voidRefunds = voidRef?.s ?? 0;
  const computed = s.opening_cash + cashSold - cashRefunded + deposits + debtCollected - voidRefunds;
  // Ca đã chốt: số dự kiến là số ĐÃ LƯU lúc chốt (nguồn sự thật cho phiếu bàn giao in lại)
  return { opening: s.opening_cash, cashSold, cashRefunded, deposits, debtCollected, voidRefunds, expected: closedAt && s.expected_cash != null ? s.expected_cash : computed };
}

const SHIFT_COLS = `s.id, s.user_id, s.fund_id, s.opened_at, s.opening_cash, s.closed_at, s.expected_cash, s.counted_cash, s.diff_cash, s.diff_reason, s.status`;

/** Chi tiết một ca (đang mở hoặc đã chốt). Trả null nếu không có ca. */
export async function shiftSummary(db: D1Database, id: number, opts: { sensitive?: boolean } = {}) {
  const s = await db
    .prepare(`SELECT ${SHIFT_COLS}, u.full_name AS cashier_name, st.name AS store_name FROM shifts s JOIN users u ON u.id = s.user_id LEFT JOIN stores st ON st.id = s.store_id WHERE s.id = ?`)
    .bind(id)
    .first<ShiftRow & { cashier_name: string; store_name: string | null }>();
  if (!s) return null;
  const closedAt = s.status === "closed" ? s.closed_at : null;
  const sales = await salesSummary(db, `o.shift_id = ?`, [id], { closedAt });
  const byPayment = await paymentBreakdown(db, `o.shift_id = ?`, [id], { closedAt });
  // Trả trước/hoàn của đơn giao từ quầy cũng là tiền của ca: cộng vào bảng hình thức để khớp tiền mặt dự kiến
  for (const d of await deliveryPayments(db, s)) {
    if (!d.sold && !d.refunded) continue;
    const row = byPayment.find((r) => r.method === d.method);
    if (row) { row.sold += d.sold; row.refunded += d.refunded; row.net = row.sold - row.refunded; }
    else byPayment.push({ method: d.method, sold: d.sold, refunded: d.refunded, net: d.sold - d.refunded, kind: "payment" });
  }
  const formula = await cashFormula(db, s);
  const to = s.closed_at ?? new Date().toISOString();
  const vouchers = (
    await db
      .prepare(
        `SELECT v.code, v.direction, v.amount, v.ref_type, v.note, v.created_at, COALESCE(cc.name,'Khác') AS category,
                CASE WHEN COALESCE(v.ref_type,'') IN ('payroll_item','salary_advance','payroll') OR cc.pnl_line = 'payroll' OR cc.code = 'LUONG' THEN 1 ELSE 0 END AS payroll,
                CASE WHEN v.ref_type = 'debt_payment' AND EXISTS (SELECT 1 FROM debt_payments dp WHERE dp.id = v.ref_id AND dp.partner_type = 'customer') THEN 1 ELSE 0 END AS counterparty_customer
           FROM cash_vouchers v LEFT JOIN cash_categories cc ON cc.id = v.category_id
          WHERE v.status = 'posted' AND COALESCE(v.ref_type,'') <> 'shift' AND v.fund_id = ? AND v.created_by = ? AND v.created_at >= ? AND v.created_at <= ? ORDER BY v.id LIMIT 100`,
      )
      .bind(s.fund_id, s.user_id, s.opened_at, to)
      .all<any>()
  ).results.map((v) => ({ code: v.code as string, direction: v.direction as string, amount: v.amount as number, category: v.category as string, note: v.note as string | null, createdAt: v.created_at as string, payroll: v.payroll === 1, inExpected: v.ref_type === "order_deposit" || (v.ref_type === "debt_payment" && v.counterparty_customer === 1) }));
  // C2-03: không có hr.sensitive → lương/tạm ứng từng người (mã NV, lý do) gộp thành "Chi lương (tổng)" mỗi chiều, không kèm mã phiếu
  const shownVouchers = opts.sensitive ? vouchers : vouchers.reduce<typeof vouchers>((out, v) => {
    if (!v.payroll) { out.push(v); return out; }
    const g = out.find((x) => x.payroll && x.direction === v.direction);
    if (g) { g.amount += v.amount; if (v.createdAt > g.createdAt) g.createdAt = v.createdAt; }
    else out.push({ ...v, code: "", category: "Chi lương (tổng)", note: null });
    return out;
  }, []);
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
    sales: { saleCount: sales.saleCount, saleTotal: sales.saleTotal, returnCount: sales.returnCount, returnTotal: sales.returnTotal, revenue: sales.revenue, otherCharges: sales.otherCharges },
    byChannel: sales.byChannel,
    byPayment,
    cashFormula: formula,
    vouchers: { in: vouchers.filter((v) => v.direction === "in").reduce((a, v) => a + v.amount, 0), out: vouchers.filter((v) => v.direction === "out").reduce((a, v) => a + v.amount, 0), items: shownVouchers.map(({ payroll, ...v }) => v) },
    returns,
    voided: { count: voided?.n ?? 0, total: voided?.total ?? 0 },
  };
}
