/**
 * Hoa hồng bán hàng theo quy tắc (commission_rules, migrations/0036).
 * - Người bán của đơn = COALESCE(orders.seller_id, orders.created_by) (migrations/0033).
 * - Chỉ đơn kênh POS đã hoàn tất, giống cách tính thưởng doanh số cũ; doanh thu = line_total của dòng hàng (đã gồm giảm giá phân bổ).
 * - Huỷ đơn của kỳ lương đã duyệt: thu hồi vào kỳ có ngày huỷ (loadVoidedLines).
 * - Trả hàng trừ lại cho người bán của ĐƠN GỐC, theo đúng mặt hàng đã trả, vào kỳ có ngày hoàn tất phiếu trả.
 * - Quy tắc cụ thể nhất thắng: phạm vi (sản phẩm > nhóm > tất cả), rồi quy tắc riêng nhân viên > chung, rồi quy tắc tạo sau (id lớn hơn).
 * Hàm tính là hàm thuần (resolveRule/computeCommission) để test; phần đọc DB ở loadCommissionLines/loadActiveRules.
 */
import { vnDayRangeUtc } from "../lib/time";

export interface CommissionRule {
  id: number; name: string; scope: "all" | "group" | "product";
  productGroupId: number | null; productId: number | null; employeeId: number | null;
  rateBp: number; effectiveFrom: string | null; effectiveTo: string | null; version: number;
}
export interface CommissionLine { uid: number; productId: number; groupId: number | null; date: string; amount: number }
export interface CommissionPart { ruleId: number; name: string; rateBp: number; revenue: number; amount: number }
export interface SellerCommission { uid: number; employeeId: number | null; revenue: number; uncovered: number; parts: CommissionPart[]; commission: number }

const RULE_COLS = `id, name, scope, product_group_id AS productGroupId, product_id AS productId, employee_id AS employeeId, rate_bp AS rateBp,
  effective_from AS effectiveFrom, effective_to AS effectiveTo, version`;

export const periodBounds = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(dim).padStart(2, "0")}` };
};

/** Quy tắc đang bật có hiệu lực giao với kỳ (YYYY-MM). */
export async function loadActiveRules(db: D1Database, period: string): Promise<CommissionRule[]> {
  const { first, last } = periodBounds(period);
  return (
    await db
      .prepare(`SELECT ${RULE_COLS} FROM commission_rules WHERE active = 1 AND (effective_from IS NULL OR effective_from <= ?) AND (effective_to IS NULL OR effective_to >= ?) ORDER BY id`)
      .bind(last, first)
      .all<CommissionRule>()
  ).results;
}

/**
 * Doanh thu thuần dòng hàng theo (người bán, mặt hàng, ngày VN) trong kỳ: bán dương, trả hàng âm (người bán của đơn gốc).
 */
export async function loadCommissionLines(db: D1Database, period: string): Promise<CommissionLine[]> {
  const { first, last } = periodBounds(period);
  const fromIso = vnDayRangeUtc(first).from, toIso = vnDayRangeUtc(last).to;
  const rows = (
    await db
      .prepare(
        `SELECT CASE WHEN o.kind = 'sale' THEN COALESCE(o.seller_id, o.created_by) ELSE COALESCE(so.seller_id, so.created_by, o.seller_id, o.created_by) END AS uid,
                ol.product_id AS productId, pr.group_id AS groupId, substr(datetime(o.completed_at, '+7 hours'), 1, 10) AS date,
                SUM(CASE WHEN o.kind = 'sale' THEN ol.line_total ELSE -ol.line_total END) AS amount
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products pr ON pr.id = ol.product_id
           LEFT JOIN orders so ON so.id = o.original_order_id
          WHERE o.status = 'completed' AND o.completed_at >= ? AND o.completed_at < ?
            AND ((o.kind = 'sale' AND o.channel = 'pos') OR (o.kind = 'return' AND COALESCE(so.channel, o.channel) = 'pos'))
          GROUP BY uid, ol.product_id, date HAVING uid IS NOT NULL ORDER BY uid, ol.product_id, date`,
      )
      .bind(fromIso, toIso)
      .all<CommissionLine>()
  ).results;
  for (const v of await loadVoidedLines(db, fromIso, toIso)) rows.push({ ...v, amount: -v.amount });
  return rows;
}

/**
 * C2-05: đơn POS đã hoàn tất ở kỳ lương ĐÃ DUYỆT/CHI rồi bị huỷ (void) ở kỳ khác → phần doanh thu dòng hàng bị thu hồi vào kỳ có ngày huỷ
 * (người bán của đơn gốc, giống trả hàng). Kỳ gốc chưa duyệt thì đơn huỷ đơn giản biến mất khỏi kỳ đó (đã lọc status='completed'), không thu hồi.
 * Trả về số DƯƠNG (phần cần trừ).
 */
export async function loadVoidedLines(db: D1Database, fromIso: string, toIso: string) {
  return (
    await db
      .prepare(
        `SELECT COALESCE(o.seller_id, o.created_by) AS uid, ol.product_id AS productId, pr.group_id AS groupId,
                substr(datetime(o.voided_at, '+7 hours'), 1, 10) AS date, SUM(ol.line_total) AS amount
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products pr ON pr.id = ol.product_id
          WHERE o.status = 'cancelled' AND o.kind = 'sale' AND o.channel = 'pos' AND o.completed_at IS NOT NULL
            AND o.voided_at >= ? AND o.voided_at < ?
            AND substr(datetime(o.completed_at, '+7 hours'), 1, 7) <> substr(datetime(o.voided_at, '+7 hours'), 1, 7)
            AND EXISTS (SELECT 1 FROM payroll_periods pp WHERE pp.period = substr(datetime(o.completed_at, '+7 hours'), 1, 7) AND pp.status IN ('approved','paid'))
          GROUP BY uid, ol.product_id, date HAVING uid IS NOT NULL ORDER BY uid, ol.product_id, date`,
      )
      .bind(fromIso, toIso)
      .all<CommissionLine>()
  ).results;
}

/** Chọn quy tắc áp dụng cho một dòng; null = không có quy tắc nào khớp (không có hoa hồng). */
export function resolveRule(rules: CommissionRule[], l: CommissionLine, employeeId: number | null): CommissionRule | null {
  let best: CommissionRule | null = null, bestScore = -1;
  for (const r of rules) {
    if (r.effectiveFrom && l.date < r.effectiveFrom) continue;
    if (r.effectiveTo && l.date > r.effectiveTo) continue;
    if (r.employeeId != null && r.employeeId !== employeeId) continue;
    if (r.scope === "product" && r.productId !== l.productId) continue;
    if (r.scope === "group" && (r.productGroupId == null || r.productGroupId !== l.groupId)) continue;
    const score = (r.scope === "product" ? 3 : r.scope === "group" ? 2 : 1) * 2 + (r.employeeId != null ? 1 : 0);
    if (score > bestScore || (score === bestScore && best && r.id > best.id)) { best = r; bestScore = score; }
  }
  return best;
}

/** Tính hoa hồng từng người bán. `userToEmployee`: users.id → employees.id (người không có hồ sơ nhân viên chỉ được báo, không nhận hoa hồng). */
export function computeCommission(rules: CommissionRule[], lines: CommissionLine[], userToEmployee: Map<number, number>): Map<number, SellerCommission> {
  const out = new Map<number, SellerCommission>();
  const acc = new Map<string, number>(); // `${uid}:${ruleId}` → doanh thu
  for (const l of lines) {
    const empId = userToEmployee.get(l.uid) ?? null;
    let s = out.get(l.uid);
    if (!s) out.set(l.uid, (s = { uid: l.uid, employeeId: empId, revenue: 0, uncovered: 0, parts: [], commission: 0 }));
    s.revenue += l.amount;
    const r = resolveRule(rules, l, empId);
    if (!r) { s.uncovered += l.amount; continue; }
    acc.set(`${l.uid}:${r.id}`, (acc.get(`${l.uid}:${r.id}`) ?? 0) + l.amount);
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const [k, revenue] of acc) {
    const [uid, rid] = k.split(":").map(Number);
    const r = byId.get(rid)!;
    out.get(uid)!.parts.push({ ruleId: r.id, name: r.name, rateBp: r.rateBp, revenue, amount: Math.round((revenue * r.rateBp) / 10000) });
  }
  for (const s of out.values()) {
    s.parts.sort((a, b) => a.ruleId - b.ruleId);
    // Trả hàng nhiều hơn bán trong kỳ → tổng âm: không trừ vào lương (giống thưởng doanh số cũ, tối thiểu 0)
    s.commission = Math.max(0, s.parts.reduce((t, p) => t + p.amount, 0));
  }
  return out;
}

export interface CommissionInputs { rules: CommissionRule[]; bySeller: Map<number, SellerCommission>; hashData: unknown }

/** Đầu vào hoa hồng cho một kỳ lương; null nếu KHÔNG có quy tắc nào đang hiệu lực (→ dùng thưởng doanh số cũ). */
export async function loadCommissionInputs(db: D1Database, period: string, userToEmployee: Map<number, number>): Promise<CommissionInputs | null> {
  const rules = await loadActiveRules(db, period);
  if (!rules.length) return null;
  const bySeller = computeCommission(rules, await loadCommissionLines(db, period), userToEmployee);
  return { rules, bySeller, hashData: [rules, [...bySeller.values()].map((s) => [s.uid, s.employeeId, s.revenue, s.parts])] };
}
