import { FUND_ORDER_OK } from "./fund-sql";
import { valueSql } from "../lib/sqlmoney";
import { allocate } from "./promotions";

/** Báo cáo tài chính bổ sung (M6-06/07/08/10). Dùng cùng điều kiện với /reports/pnl để số liệu đối chiếu được. */

const W = `o.status='completed' AND o.completed_at >= ? AND o.completed_at < ?`;

/** Chi phí sổ quỹ theo (kênh, khoản mục) — cùng quy tắc /reports/pnl: phiếu chi trừ phiếu đảo, bỏ nhóm cogs/revenue. */
export async function voucherCosts(db: D1Database, fromIso: string, toIso: string) {
  return (
    await db
      .prepare(
        `SELECT v.channel AS channel, v.category_id AS categoryId, cc.name AS category, COALESCE(cc.pnl_line,'other') AS line,
                SUM(CASE WHEN v.direction='out' THEN v.amount WHEN v.reverses_id IS NOT NULL THEN -v.amount ELSE 0 END) AS amount
           FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id
          WHERE v.status='posted' AND v.created_at >= ? AND v.created_at < ?
            AND cc.direction = 'out' AND COALESCE(cc.pnl_line,'other') NOT IN ('cogs','revenue','transfer','other_income')
          GROUP BY v.channel, v.category_id`,
      )
      .bind(fromIso, toIso)
      .all<{ channel: string | null; categoryId: number; category: string; line: string; amount: number }>()
  ).results.filter((r) => r.amount);
}

/** Hao hụt = xuất hao hụt theo giá vốn + hàng trả không nhập lại kho (khớp /reports/pnl). */
export async function shrinkage(db: D1Database, fromIso: string, toIso: string) {
  const waste = await db
    .prepare(`SELECT COALESCE(SUM(-${valueSql('qty_delta_milli','unit_cost')}),0) AS v FROM stock_moves WHERE move_type='waste' AND at >= ? AND at < ?`)
    .bind(fromIso, toIso)
    .first<{ v: number }>();
  const disc = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN o.kind='return' AND NOT EXISTS (SELECT 1 FROM order_line_lots x WHERE x.order_line_id = ol.id) THEN ol.cost_amount ELSE 0 END),0) AS d
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ${W}`,
    )
    .bind(fromIso, toIso)
    .first<{ d: number }>();
  return Math.round(waste!.v) + disc!.d;
}

/**
 * Các khoản P&L không đi qua đơn hàng / phiếu chi thường (A-04, B-06, B-13) — dùng chung /reports/pnl và pnl-by-channel:
 *  - badDebt: xoá nợ khách hàng (debt_adjustments.write_off, đã posted) → chi phí "Xoá nợ khó đòi"
 *  - paymentDiscount: chiết khấu thanh toán trên công nợ phải thu → giảm trừ doanh thu
 *  - payableIncome: chiết khấu / xoá nợ phải trả NCC → thu khác
 *  - forfeitedDeposits: cọc đặt trước không hoàn → thu khác
 *  - stockCount: chênh lệch kiểm kê/điều chỉnh tồn (move_type='adjust') theo giá vốn lô; giảm = chi phí (+), tăng = giảm chi phí (−). Hao hụt (waste) đã tính riêng.
 *  - internalUse: xuất dùng nội bộ (move_type='internal_use') theo giá vốn lô → chi phí "Xuất dùng nội bộ"
 *  - voucherIncome: phiếu thu có dòng P&L other_income (vd chênh lệch đối soát thừa), trừ phiếu đảo
 *  - purchaseVariance: chênh lệch giá mua (B-09) của phần đã bán khi chốt hoá đơn tạm khác giá, tính vào ngày chốt
 *  - otherReceipts: phiếu thu các khoản mục còn lại có dòng P&L (vd THU_KHAC 'other'), trừ phiếu đảo (B-11); khoản mục transfer/revenue/cogs bị loại
 * return_credit / offset / opening_balance không đi vào P&L. Điều chỉnh công nợ theo ngày ghi sổ posted_at (ngày duyệt; dòng cũ thiếu thì created_at); các mục khác theo created_at (UTC) đã quy đổi qua fromIso/toIso của ngày VN.
 */
export async function pnlAdjustments(db: D1Database, fromIso: string, toIso: string) {
  const adj = (
    await db
      .prepare(
        `SELECT type, partner_type AS pt, COALESCE(SUM(amount),0) AS s FROM debt_adjustments
          WHERE status='posted' AND type IN ('write_off','discount') AND COALESCE(posted_at, created_at) >= ? AND COALESCE(posted_at, created_at) < ? GROUP BY type, partner_type`,
      )
      .bind(fromIso, toIso)
      .all<{ type: string; pt: string; s: number }>()
  ).results;
  const pick = (type: string, pt: string) => adj.find((r) => r.type === type && r.pt === pt)?.s ?? 0;
  const forfeited = await db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM order_deposits WHERE status='forfeited' AND settled_at >= ? AND settled_at < ?`)
    .bind(fromIso, toIso)
    .first<{ s: number }>();
  const stock = await db
    .prepare(`SELECT COALESCE(SUM(-${valueSql('qty_delta_milli','unit_cost')}),0) AS v FROM stock_moves WHERE move_type='adjust' AND at >= ? AND at < ?`)
    .bind(fromIso, toIso)
    .first<{ v: number }>();
  // Xuất dùng nội bộ (move_type='internal_use'): chi phí theo giá vốn lô, dòng riêng trên lãi lỗ
  const iu = await db
    .prepare(`SELECT COALESCE(SUM(-${valueSql('qty_delta_milli','unit_cost')}),0) AS v FROM stock_moves WHERE move_type='internal_use' AND at >= ? AND at < ?`)
    .bind(fromIso, toIso)
    .first<{ v: number }>();
  // B-11: phiếu thu của khoản mục có dòng P&L (other_income, other...) là thu nhập; phiếu đảo (cùng khoản mục, ngược chiều) trừ lại đúng dòng của phiếu gốc
  const vi = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN cc.pnl_line='other_income' THEN CASE WHEN v.direction='in' AND v.reverses_id IS NULL THEN v.amount WHEN v.direction='out' AND v.reverses_id IS NOT NULL THEN -v.amount ELSE 0 END ELSE 0 END),0) AS surplus,
              COALESCE(SUM(CASE WHEN COALESCE(cc.pnl_line,'other')<>'other_income' THEN CASE WHEN v.direction='in' AND v.reverses_id IS NULL THEN v.amount WHEN v.direction='out' AND v.reverses_id IS NOT NULL THEN -v.amount ELSE 0 END ELSE 0 END),0) AS other
         FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id
        WHERE v.status='posted' AND cc.direction='in' AND COALESCE(cc.pnl_line,'other') NOT IN ('revenue','cogs','transfer')
          AND v.created_at >= ? AND v.created_at < ?`,
    )
    .bind(fromIso, toIso)
    .first<{ surplus: number; other: number }>();
  // B-09: chênh lệch giá mua của lô đã bán khi chốt hoá đơn tạm khác giá (dương = mua đắt hơn tạm tính = chi phí)
  const pv = await db
    .prepare(`SELECT COALESCE(SUM(cogs_amount),0) AS s FROM purchase_cost_adjustments WHERE created_at >= ? AND created_at < ?`)
    .bind(fromIso, toIso)
    .first<{ s: number }>();
  return {
    purchaseVariance: pv!.s,
    badDebt: pick("write_off", "customer"),
    paymentDiscount: pick("discount", "customer"),
    payableIncome: pick("discount", "supplier") + pick("write_off", "supplier"),
    forfeitedDeposits: forfeited!.s,
    stockCount: Math.round(stock!.v),
    internalUse: Math.round(iu!.v),
    voucherIncome: vi!.surplus,
    otherReceipts: vi!.other,
  };
}

export async function revenueByChannel(db: D1Database, fromIso: string, toIso: string) {
  const rev = (
    await db
      .prepare(`SELECT o.channel, SUM(CASE WHEN o.kind='sale' THEN o.total ELSE -o.total END) AS revenue FROM orders o WHERE ${W} GROUP BY o.channel`)
      .bind(fromIso, toIso)
      .all<{ channel: string; revenue: number }>()
  ).results;
  const cogs = (
    await db
      .prepare(
        `SELECT o.channel, SUM(CASE WHEN o.kind='sale' THEN ol.cost_amount ELSE -ol.cost_amount END) AS cogs
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ${W} GROUP BY o.channel`,
      )
      .bind(fromIso, toIso)
      .all<{ channel: string; cogs: number }>()
  ).results;
  return { rev, cogs };
}

export async function pnlByChannel(db: D1Database, from: string, to: string, fromIso: string, toIso: string) {
  const { rev, cogs } = await revenueByChannel(db, fromIso, toIso);
  const costs = await voucherCosts(db, fromIso, toIso);
  const shrink = await shrinkage(db, fromIso, toIso);

  const channels = new Map<string, { channel: string; revenue: number; cogs: number; directCosts: number; allocatedCosts: number }>();
  const ch = (k: string) => {
    if (!channels.has(k)) channels.set(k, { channel: k, revenue: 0, cogs: 0, directCosts: 0, allocatedCosts: 0 });
    return channels.get(k)!;
  };
  for (const k of ["pos", "online", "b2b"]) ch(k);
  for (const r of rev) ch(r.channel).revenue += r.revenue ?? 0;
  for (const r of cogs) ch(r.channel).cogs += r.cogs ?? 0;
  for (const r of costs) if (r.channel) ch(r.channel).directCosts += r.amount;

  const rules = (await db.prepare(`SELECT r.*, cc.name AS category FROM cost_allocation_rules r JOIN cash_categories cc ON cc.id = r.category_id WHERE r.active = 1`).all<any>()).results;
  const names = [...channels.keys()];
  const allocations: { categoryId: number; category: string; method: string; amount: number; byChannel: Record<string, number> }[] = [];
  const unallocated: { categoryId: number | null; category: string; amount: number; reason: string }[] = [];
  for (const g of costs.filter((x) => !x.channel)) {
    const rule = rules.find((r) => r.category_id === g.categoryId);
    let weights: number[] | null = null;
    if (rule?.method === "revenue_share") weights = names.map((k) => Math.max(0, channels.get(k)!.revenue));
    else if (rule?.method === "fixed_bp") {
      let w: Record<string, number> = {};
      try { w = JSON.parse(rule.weights_json ?? "{}"); } catch { /* bỏ qua */ }
      weights = names.map((k) => Math.max(0, Number(w[k]) || 0));
    }
    if (!rule || !weights || weights.every((x) => x === 0)) {
      unallocated.push({ categoryId: g.categoryId, category: g.category, amount: g.amount, reason: rule ? "no_weights" : "no_rule" });
      continue;
    }
    const parts = allocate(Math.abs(g.amount), weights).map((x) => (g.amount < 0 ? -x : x));
    const byChannel: Record<string, number> = {};
    names.forEach((k, i) => {
      channels.get(k)!.allocatedCosts += parts[i];
      byChannel[k] = parts[i];
    });
    allocations.push({ categoryId: g.categoryId, category: g.category, method: rule.method, amount: g.amount, byChannel });
  }
  if (shrink) unallocated.push({ categoryId: null, category: "Hao hụt", amount: shrink, reason: "not_attributable" });
  const adj = await pnlAdjustments(db, fromIso, toIso);
  if (adj.badDebt) unallocated.push({ categoryId: null, category: "Xoá nợ khó đòi", amount: adj.badDebt, reason: "not_attributable" });
  if (adj.stockCount) unallocated.push({ categoryId: null, category: "Chênh lệch kiểm kê", amount: adj.stockCount, reason: "not_attributable" });
  if (adj.internalUse) unallocated.push({ categoryId: null, category: "Xuất dùng nội bộ", amount: adj.internalUse, reason: "not_attributable" });
  if (adj.purchaseVariance) unallocated.push({ categoryId: null, category: "Chênh lệch giá mua", amount: adj.purchaseVariance, reason: "not_attributable" });

  const rows = [...channels.values()].map((c) => ({
    ...c, grossProfit: c.revenue - c.cogs, netProfit: c.revenue - c.cogs - c.directCosts - c.allocatedCosts,
  }));
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const unallocatedTotal = unallocated.reduce((s, x) => s + x.amount, 0);
  const totals = {
    revenue: sum((r) => r.revenue), cogs: sum((r) => r.cogs), grossProfit: sum((r) => r.grossProfit),
    directCosts: sum((r) => r.directCosts), allocatedCosts: sum((r) => r.allocatedCosts), unallocatedCosts: unallocatedTotal,
    totalExpenses: sum((r) => r.directCosts + r.allocatedCosts) + unallocatedTotal,
    netProfit: sum((r) => r.grossProfit) - sum((r) => r.directCosts + r.allocatedCosts) - unallocatedTotal,
  };
  const otherIncomeTotal = adj.forfeitedDeposits + adj.payableIncome + adj.voucherIncome + adj.otherReceipts;
  const deductions = adj.paymentDiscount;
  totals.netProfit = totals.netProfit - deductions + otherIncomeTotal;
  return {
    from, to, channels: rows, allocations, unallocated, totals: { ...totals, revenueDeductions: deductions, otherIncome: otherIncomeTotal },
    revenueDeductions: { paymentDiscount: adj.paymentDiscount },
    otherIncome: { forfeitedDeposits: adj.forfeitedDeposits, payableDiscounts: adj.payableIncome, settlementSurplus: adj.voucherIncome, otherReceipts: adj.otherReceipts, total: otherIncomeTotal },
  };
}

/** Quỹ "chờ đối soát": tiền COD/sàn/thẻ đã ghi nhận nhưng chưa về tay — không phải tiền thật nên không tính vào tổng dòng tiền. */
export const CLEARING_FUND_TYPES = ["cod_clearing", "marketplace_clearing", "card_clearing"];

/**
 * Dòng tiền (audit #11). Quỹ chờ đối soát được liệt kê trong byFund (`counted:false`) nhưng LOẠI khỏi các tổng và danh mục thu/chi:
 * tiền COD vào quỹ chờ lúc giao hàng, rồi được chuyển ra khi đối soát và ghi VÀO quỹ thật theo số thực nhận —
 * nếu tính cả hai sẽ đếm đôi doanh thu COD. Chọn đích danh một quỹ chờ (fundId) thì vẫn xem được dòng tiền riêng của quỹ đó.
 */
export async function cashFlow(db: D1Database, fromIso: string, toIso: string, fundId: number | null) {
  const funds = (await db.prepare(`SELECT id, code, name, type FROM funds ${fundId ? "WHERE id = ?" : ""} ORDER BY id`).bind(...(fundId ? [fundId] : [])).all<any>()).results;
  const allFunds = funds;
  const counted = (f: { id: number; type: string }) => !!fundId || !CLEARING_FUND_TYPES.includes(f.type);
  const fundIds = funds.filter(counted).map((f) => f.id);
  if (!fundIds.length) {
    return { opening: 0, inflows: [], outflows: [], totalInflow: 0, totalOutflow: 0, closing: 0, transfers: { inflow: 0, outflow: 0, label: "Chuyển giữa các quỹ" }, byFund: allFunds.map((f) => ({ fundId: f.id, code: f.code, name: f.name, type: f.type, opening: 0, inflow: 0, outflow: 0, transferIn: 0, transferOut: 0, closing: 0, counted: false })) };
  }
  const inList = fundIds.map(() => "?").join(",");
  const PAY = `p.status='confirmed' AND ${FUND_ORDER_OK} AND p.fund_id IN (${inList})`;

  const open = new Map<number, number>(fundIds.map((i) => [i, 0]));
  const addOpen = (rows: { fund_id: number; s: number }[]) => rows.forEach((r) => open.set(r.fund_id, (open.get(r.fund_id) ?? 0) + (r.s ?? 0)));
  addOpen((await db.prepare(`SELECT p.fund_id, SUM(p.amount) AS s FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${PAY} AND p.created_at < ? GROUP BY p.fund_id`).bind(...fundIds, fromIso).all<any>()).results);
  addOpen((await db.prepare(`SELECT v.fund_id, SUM(CASE WHEN v.direction='in' THEN v.amount ELSE -v.amount END) AS s FROM cash_vouchers v WHERE v.status='posted' AND v.fund_id IN (${inList}) AND v.created_at < ? GROUP BY v.fund_id`).bind(...fundIds, fromIso).all<any>()).results);

  const flows = new Map<string, { dir: "in" | "out"; category: string; amount: number }>();
  const inflowFund = new Map<number, number>();
  const outflowFund = new Map<number, number>();
  const add = (dir: "in" | "out", category: string, fund: number, amount: number) => {
    if (!amount) return;
    const k = dir + "|" + category;
    flows.set(k, { dir, category, amount: (flows.get(k)?.amount ?? 0) + amount });
    const m = dir === "in" ? inflowFund : outflowFund;
    m.set(fund, (m.get(fund) ?? 0) + amount);
  };
  const pay = (await db
    .prepare(
      `SELECT p.fund_id, SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END) AS inn, SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END) AS outt
         FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${PAY} AND p.created_at >= ? AND p.created_at < ? GROUP BY p.fund_id`,
    )
    .bind(...fundIds, fromIso, toIso)
    .all<any>()).results;
  for (const r of pay) {
    add("in", "Thu bán hàng", r.fund_id, r.inn);
    add("out", "Hoàn tiền trả hàng", r.fund_id, r.outt);
  }
  // phiếu thu/chi; phiếu gắn gạch nợ (debt_payments) gộp nhóm theo công nợ để không đếm trùng với khoản mục
  const vs = (await db
    .prepare(
      `SELECT v.fund_id, v.direction AS dir,
              CASE WHEN dp.id IS NOT NULL THEN (CASE WHEN dp.direction='in' THEN 'Thu công nợ khách hàng' ELSE 'Trả công nợ nhà cung cấp' END) ELSE cc.name END AS category,
              CASE WHEN v.ref_type = 'fund_transfer' THEN 1 ELSE 0 END AS is_transfer, SUM(v.amount) AS amount
         FROM cash_vouchers v JOIN cash_categories cc ON cc.id = v.category_id LEFT JOIN debt_payments dp ON dp.cash_voucher_id = v.id
        WHERE v.status='posted' AND v.fund_id IN (${inList}) AND v.created_at >= ? AND v.created_at < ? GROUP BY v.fund_id, v.direction, category, is_transfer`,
    )
    .bind(...fundIds, fromIso, toIso)
    .all<any>()).results;
  // PA-4: chuyển quỹ nội bộ không phải thu/chi của cửa hàng → báo riêng ("Chuyển giữa các quỹ"), không cộng vào tổng thu/chi;
  // từng quỹ vẫn thấy vào/ra (inflowFund/outflowFund) để số dư khớp.
  const transferIn = new Map<number, number>(), transferOut = new Map<number, number>();
  for (const r of vs) {
    if (r.is_transfer) {
      const m = r.dir === "in" ? transferIn : transferOut, mf = r.dir === "in" ? inflowFund : outflowFund;
      m.set(r.fund_id, (m.get(r.fund_id) ?? 0) + r.amount);
      mf.set(r.fund_id, (mf.get(r.fund_id) ?? 0) + r.amount);
    } else add(r.dir, r.category, r.fund_id, r.amount);
  }

  const inflows = [...flows.values()].filter((f) => f.dir === "in").map((f) => ({ category: f.category, amount: f.amount }));
  const outflows = [...flows.values()].filter((f) => f.dir === "out").map((f) => ({ category: f.category, amount: f.amount }));
  const byFund = allFunds.map((f) => {
    const o = open.get(f.id) ?? 0, i = inflowFund.get(f.id) ?? 0, x = outflowFund.get(f.id) ?? 0;
    return { fundId: f.id, code: f.code, name: f.name, type: f.type, opening: o, inflow: i, outflow: x, transferIn: transferIn.get(f.id) ?? 0, transferOut: transferOut.get(f.id) ?? 0, closing: o + i - x, counted: counted(f) };
  });
  const sum = (k: "opening" | "inflow" | "outflow" | "closing" | "transferIn" | "transferOut") => byFund.filter((f) => f.counted).reduce((s, f) => s + f[k], 0);
  const tIn = sum("transferIn"), tOut = sum("transferOut");
  return {
    opening: sum("opening"), inflows, outflows, totalInflow: sum("inflow") - tIn, totalOutflow: sum("outflow") - tOut, closing: sum("closing"), byFund,
    transfers: { inflow: tIn, outflow: tOut, label: "Chuyển giữa các quỹ" },
  };
}
