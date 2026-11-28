/**
 * Kiểm thử đối chiếu chéo (audit vòng 2): dựng một "ngày làm việc" mô phỏng hoàn toàn qua API thật
 * (chỉ chèn SQL cho dữ liệu gốc: danh mục, sản phẩm, khách, NCC, khuyến mãi, tham số) và sau MỖI giai đoạn
 * kiểm các bất biến toàn hệ thống:
 *  1. Quỹ: số dư /funds = Σ phiếu đã ghi + Σ payments xác nhận (quy tắc FUND_ORDER_OK) = số cuối kỳ /reports/cash-flow.
 *  2. Kho: tồn lô = Σ thẻ kho; giữ hàng hợp lệ; các cột /reports/inventory cân; giá trị tồn = Σ lô × giá vốn.
 *  3. Công nợ: phải thu/phải trả theo đối tác = Σ chứng từ − Σ thanh toán; tuổi nợ = tổng công nợ.
 *  4. Lãi lỗ: doanh thu /reports/pnl = theo kênh = theo người bán (+ thu khác) = báo cáo cuối ngày; giá vốn = Σ cost dòng bán − trả = thẻ kho;
 *     tổng đơn hoàn tất = Σ thanh toán + phần ghi nợ; đơn sỉ = hoá đơn.
 *  5. Ca: tiền mặt dự kiến = đầu ca + thu − chi tiền mặt của ca (đối chiếu sổ quỹ tiền mặt trong khoảng ca);
 *     5b. quỹ tiền mặt = Σ tiền các ca + phiếu/thu chi ngoài ca (mỗi đồng thuộc đúng một ca hoặc rõ ràng ngoài ca).
 *  6. Điểm khách = Σ sổ điểm; voucher used_count = số lượt dùng hiệu lực.
 *  7. SePay: khoản chờ = Σ phiếu thu chờ − Σ phiếu chi khỏi chờ = Σ sự kiện còn treo; tiền báo về − hoàn = tăng quỹ ngân hàng.
 *  8. Audit: mỗi chứng từ ghi có dòng audit_log (lấy mẫu theo bảng chứng từ).
 * Bất biến sai do lỗi ứng dụng được tách thành `it.fails` kèm mã phát hiện (R2-INV-xx) — bỏ `.fails` khi đã sửa.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { api, testEnv } from "./helpers";
import { seedShop, call, checkoutBody } from "./shop-helpers";
import { enableSepay, hook, tx } from "./sepay-helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

const V = "/api/v1";
const db = () => testEnv.DB;
const TODAY = vnDate();
const ALL = `from=2020-01-01&to=2099-12-31`;
const DAY = `from=${TODAY}&to=${TODAY}`;
let seq = 0;
const uid = () => `inv-${Date.now()}-${++seq}-${crypto.randomUUID().slice(0, 8)}`;

/** Gọi API và bắt buộc đúng mã trạng thái (in kèm body khi sai để dễ dò). */
async function must<T = any>(role: string, method: string, path: string, body?: unknown, status: number | number[] = [200, 201]) {
  const r = await api<T>(role, method, path, body);
  const ok = Array.isArray(status) ? status.includes(r.status) : r.status === status;
  if (!ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as any;
}
const one = async <T = any>(sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<T>())!;
const all = async <T = any>(sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).all<T>()).results;
const set = (k: string, v: string) => db().prepare(`INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(k, v).run();

// ------------------------------------------------------------------ dữ liệu gốc
const P_TAO = 1, P_NHO = 2, P_CAM = 3; // Táo 100k/kg, Nho 200k/kg, Cam 50k/kg (B2B / PO)
const SUP_A = 1, SUP_B = 2;
const C_CREDIT = 501, C_POINTS = 502;
const FUND_CASH = 1, FUND_BANK = 2, FUND_COD = 3;
let catId: Record<string, number> = {};

async function seedDay() {
  await seedShop();
  await enableSepay();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`),
    d.prepare(`INSERT OR IGNORE INTO cash_categories(code, name, direction, pnl_line) VALUES ('THU_KHAC','Thu khác','in','other')`),
    d.prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id) VALUES (1,'TAO','Táo Envy','kg',1,1),(2,'NHO','Nho Mỹ','kg',1,1),(3,'CAM','Cam sành sỉ','kg',0,2)`),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,1,100000,'2020-01-01T00:00:00Z','active',1),(1,2,200000,'2020-01-01T00:00:00Z','active',1),(1,3,50000,'2020-01-01T00:00:00Z','active',1)`),
    d.prepare(`INSERT INTO suppliers(id, code, name, payment_terms_days) VALUES (1,'NCC-A','NCC Táo Nho',10),(2,'NCC-B','NCC Cam',7)`),
    d.prepare(`INSERT INTO product_suppliers(product_id, supplier_id, lead_time_days, preferred) VALUES (3,2,1,1)`),
    d.prepare(`INSERT INTO customers(id, code, type, name, phone, customer_group_id, credit_limit, payment_terms_days) VALUES (501,'KL-NO','retail','Khách nợ','0900000501',1,1000000,7),(502,'KL-DIEM','retail','Khách điểm','0900000502',1,0,0)`),
    d.prepare(`INSERT INTO promotions(id, code, name, kind, channels, value_amount, starts_at, ends_at, requires_voucher, status, created_by) VALUES (901,'KM-INV','Voucher 20k','amount','pos,online',20000,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z',1,'active',1)`),
    d.prepare(`INSERT INTO vouchers(id, code, promotion_id, max_uses, per_customer_limit) VALUES (901,'INV20K',901,10,5)`),
  ]);
  // Lô của seedShop không có thẻ kho → ghi dòng "tồn đầu" (ngày cũ) để Σ thẻ kho = tồn lô (dữ liệu gốc)
  await d.prepare(
    `INSERT INTO stock_moves(at, lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id)
     SELECT '2020-01-01T00:00:00.000Z', id, product_id, qty_on_hand_milli, unit_cost, 'receipt', 'seed', id, 1 FROM lots WHERE NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.lot_id = lots.id)`,
  ).run();
  await set("pos.retail_credit_enabled", "1");
  await set("loyalty.enabled", "1");
  catId = Object.fromEntries((await all<{ code: string; id: number }>(`SELECT code, id FROM cash_categories`)).map((r) => [r.code, r.id]));
}

// ------------------------------------------------------------------ bất biến
const FUND_RULE = `(o.status = 'completed' OR (o.channel IN ('online','social') AND o.kind = 'sale' AND o.status IN ('new','confirmed','preparing','shipping','delivery_failed','cancelled','returned')))`;

/** Bất biến 1 — quỹ. */
async function invFunds() {
  const funds = (await must("owner", "GET", `${V}/funds`)).items as any[];
  const cfAll = await must("owner", "GET", `${V}/reports/cash-flow?${ALL}`);
  const cfDay = await must("owner", "GET", `${V}/reports/cash-flow?${DAY}`);
  for (const f of funds) {
    const led = await one<{ v: number; p: number }>(
      `SELECT COALESCE((SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END) FROM cash_vouchers WHERE fund_id=?1 AND status='posted'),0) AS v,
              COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.fund_id=?1 AND p.status='confirmed' AND ${FUND_RULE}),0) AS p`,
      f.id,
    );
    expect(f.balance, `quỹ ${f.code}: /funds ≠ Σ phiếu + Σ payments`).toBe(led.v + led.p);
    const own = (await must("owner", "GET", `${V}/reports/cash-flow?${ALL}&fundId=${f.id}`)).byFund[0];
    expect(own.closing, `quỹ ${f.code}: cash-flow (riêng quỹ) cuối kỳ ≠ số dư`).toBe(f.balance);
    const a = cfAll.byFund.find((x: any) => x.fundId === f.id);
    if (a.counted) expect(a.closing, `quỹ ${f.code}: cash-flow tổng cuối kỳ ≠ số dư`).toBe(f.balance);
    const dd = cfDay.byFund.find((x: any) => x.fundId === f.id);
    if (dd.counted) {
      expect(dd.opening + dd.inflow - dd.outflow, `quỹ ${f.code}: đầu + thu − chi ≠ cuối (hôm nay)`).toBe(dd.closing);
      expect(dd.closing, `quỹ ${f.code}: cash-flow hôm nay cuối kỳ ≠ số dư`).toBe(f.balance);
    }
  }
  expect(cfDay.opening + cfDay.totalInflow - cfDay.totalOutflow + cfDay.transfers.inflow - cfDay.transfers.outflow, "cash-flow tổng không cân").toBe(cfDay.closing);
  // Tiền đã xác nhận mà quỹ không thấy (đơn không thuộc FUND_ORDER_OK) — phải rỗng
  const hidden = await all(
    `SELECT p.id, p.method, p.amount, o.code, o.channel, o.kind, o.status FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.status='confirmed' AND p.fund_id IS NOT NULL AND NOT ${FUND_RULE}`,
  );
  expect(hidden, "payments xác nhận nằm ngoài số dư quỹ").toEqual([]);
}

/** Bất biến 2 — kho. */
async function invStock() {
  const lotDiff = await all(
    `SELECT l.id, l.lot_code, l.qty_on_hand_milli AS onHand, COALESCE((SELECT SUM(m.qty_delta_milli) FROM stock_moves m WHERE m.lot_id=l.id),0) AS moves
       FROM lots l WHERE l.qty_on_hand_milli <> COALESCE((SELECT SUM(m.qty_delta_milli) FROM stock_moves m WHERE m.lot_id=l.id),0)`,
  );
  expect(lotDiff, "tồn lô ≠ Σ thẻ kho").toEqual([]);
  const bad = await all(`SELECT id, lot_code, qty_on_hand_milli h, qty_reserved_milli r FROM lots WHERE qty_on_hand_milli < 0 OR qty_reserved_milli < 0 OR qty_reserved_milli > qty_on_hand_milli`);
  expect(bad, "giữ hàng/tồn âm hoặc giữ > tồn").toEqual([]);
  const resDiff = await all(
    `SELECT l.id, l.qty_reserved_milli r, COALESCE((SELECT SUM(x.qty_milli) FROM reservations x WHERE x.lot_id=l.id AND x.status='active'),0) AS act
       FROM lots l WHERE l.qty_reserved_milli <> COALESCE((SELECT SUM(x.qty_milli) FROM reservations x WHERE x.lot_id=l.id AND x.status='active'),0)`,
  );
  expect(resDiff, "qty_reserved ≠ Σ giữ hàng đang hiệu lực").toEqual([]);
  const rep = (await must("owner", "GET", `${V}/reports/inventory?from=${TODAY}&asOf=${TODAY}`)).items as any[];
  for (const r of rep) {
    const calc = r.openingMilli + r.inMilli - r.soldMilli + r.returnedMilli - r.wasteMilli - r.internalUseMilli + r.assembleMilli + r.adjustMilli;
    expect(calc, `báo cáo tồn ${r.sku}: các cột không cân`).toBe(r.onHandMilli);
    const lot = await one<{ q: number }>(`SELECT COALESCE(SUM(qty_on_hand_milli),0) q FROM lots WHERE product_id=?`, r.productId);
    expect(r.onHandMilli, `báo cáo tồn ${r.sku} ≠ Σ tồn lô`).toBe(lot.q);
  }
  const val = await one<{ v: number }>(`SELECT COALESCE(SUM(CAST(ROUND(qty_on_hand_milli * unit_cost / 1000.0) AS INTEGER)),0) v FROM lots`);
  expect(rep.reduce((s, r) => s + r.stockValue, 0), "Σ giá trị tồn báo cáo ≠ Σ tồn lô × giá vốn").toBe(val.v);
}

/** Bất biến 3 — công nợ phải thu/phải trả. */
async function invDebts() {
  const rec = await must("owner", "GET", `${V}/debts/receivables`);
  for (const it of rec.items as any[]) {
    const led = await one<{ inv: number; pin: number; pout: number; adj: number }>(
      `SELECT COALESCE((SELECT SUM(total) FROM invoices WHERE customer_id=?1 AND status<>'cancelled' AND kind IN ('sale','replacement','adjustment')),0) AS inv,
              COALESCE((SELECT SUM(amount) FROM debt_payments WHERE partner_type='customer' AND partner_id=?1 AND direction='in' AND status='posted'),0) AS pin,
              COALESCE((SELECT SUM(amount) FROM debt_payments WHERE partner_type='customer' AND partner_id=?1 AND direction='out' AND status='posted'),0) AS pout,
              COALESCE((SELECT SUM(amount) FROM debt_adjustments WHERE partner_type='customer' AND partner_id=?1 AND status='posted'),0) AS adj`,
      it.customerId,
    );
    expect(it.balance, `phải thu KH ${it.customerCode}: balance ≠ Σ hoá đơn − Σ thu + Σ hoàn`).toBe(led.inv - led.pin + led.pout - led.adj);
    expect(it.outstanding - it.unapplied - it.invoiceCredit, `phải thu KH ${it.customerCode}: các cột không cân`).toBe(it.balance);
    const docs = await one<{ os: number }>(
      `SELECT COALESCE(SUM(os),0) os FROM (SELECT (i.total + COALESCE((SELECT SUM(a.total) FROM invoices a WHERE a.original_invoice_id=i.id AND a.kind='adjustment' AND a.status='open'),0)
         - COALESCE((SELECT SUM(x.amount) FROM debt_allocations x LEFT JOIN debt_payments xp ON xp.id=x.payment_id LEFT JOIN debt_adjustments xd ON xd.id=x.adjustment_id
                      WHERE x.invoice_id=i.id AND (xp.status='posted' OR xd.status='posted')),0)) AS os
         FROM invoices i WHERE i.customer_id=? AND i.status='open' AND i.kind IN ('sale','replacement')) WHERE os > 0`,
      it.customerId,
    );
    expect(it.outstanding, `phải thu KH ${it.customerCode}: còn nợ ≠ Σ hoá đơn − Σ phân bổ`).toBe(docs.os);
  }
  const agR = await must("owner", "GET", `${V}/debts/aging?side=receivable`);
  const sumB = (b: Record<string, number>) => Object.values(b).reduce((s, x) => s + x, 0);
  expect(sumB(agR.totals), "tuổi nợ phải thu ≠ tổng còn nợ").toBe(rec.totals.outstanding);
  expect(agR.items.reduce((s: number, x: any) => s + x.outstanding, 0)).toBe(rec.totals.outstanding);

  const pay = await must("owner", "GET", `${V}/debts/payables`);
  for (const it of pay.items as any[]) {
    const led = await one<{ b: number; pout: number; pin: number; adj: number }>(
      `SELECT COALESCE((SELECT SUM(total) FROM supplier_bills WHERE supplier_id=?1 AND status<>'cancelled'),0) AS b,
              COALESCE((SELECT SUM(amount) FROM debt_payments WHERE partner_type='supplier' AND partner_id=?1 AND direction='out' AND status='posted'),0) AS pout,
              COALESCE((SELECT SUM(amount) FROM debt_payments WHERE partner_type='supplier' AND partner_id=?1 AND direction='in' AND status='posted'),0) AS pin,
              COALESCE((SELECT SUM(amount) FROM debt_adjustments WHERE partner_type='supplier' AND partner_id=?1 AND status='posted'),0) AS adj`,
      it.supplierId,
    );
    expect(it.balance, `phải trả NCC ${it.supplierCode}: balance ≠ Σ hoá đơn mua − Σ trả`).toBe(led.b - led.pout + led.pin - led.adj);
    expect(it.bills.reduce((s: number, b: any) => s + b.outstanding, 0)).toBe(it.outstanding);
  }
  const agP = await must("owner", "GET", `${V}/debts/aging?side=payable`);
  expect(sumB(agP.totals), "tuổi nợ phải trả ≠ tổng còn nợ").toBe(pay.totals.outstanding);
}

/** Bất biến 4 — doanh thu / giá vốn. */
async function invPnl() {
  const p = await must("owner", "GET", `${V}/reports/pnl?${DAY}`);
  const ch = await must("owner", "GET", `${V}/reports/pnl-by-channel?${DAY}`);
  const se = await must("owner", "GET", `${V}/reports/sales/sellers?${DAY}`);
  const daily = await must("owner", "GET", `${V}/reports/daily?day=${TODAY}`);
  expect(ch.totals.revenue, "doanh thu theo kênh ≠ lãi lỗ").toBe(p.revenue);
  expect(se.totals.revenue + se.totals.otherCharges, "doanh thu theo người bán (+thu khác) ≠ lãi lỗ").toBe(p.revenue);
  expect(daily.revenue, "báo cáo cuối ngày ≠ lãi lỗ").toBe(p.revenue);
  expect(ch.totals.cogs, "giá vốn theo kênh ≠ lãi lỗ").toBe(p.cogs);
  expect(se.totals.cogs, "giá vốn theo người bán ≠ lãi lỗ").toBe(p.cogs);
  expect(daily.cogs, "giá vốn cuối ngày ≠ lãi lỗ").toBe(p.cogs);
  const W = `o.status='completed' AND date(datetime(o.completed_at,'+7 hours')) = ?`;
  const ind = await one<{ rev: number; cogs: number }>(
    `SELECT COALESCE((SELECT SUM(CASE WHEN o.kind='sale' THEN o.total ELSE -o.total END) FROM orders o WHERE ${W}),0) AS rev,
            COALESCE((SELECT SUM(CASE WHEN o.kind='sale' THEN ol.cost_amount ELSE -ol.cost_amount END) FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE ${W}),0) AS cogs`,
    TODAY, TODAY,
  );
  expect(p.revenue).toBe(ind.rev);
  expect(p.cogs, "giá vốn ≠ Σ cost dòng bán − trả").toBe(ind.cogs);
  // giá vốn dòng = Σ phân bổ lô × giá vốn lô; orders.cost_total = Σ cost dòng
  const lineDiff = await all(
    `SELECT ol.id, o.code, ol.cost_amount, (SELECT SUM(CAST(ROUND(x.qty_milli * l.unit_cost / 1000.0) AS INTEGER)) FROM order_line_lots x JOIN lots l ON l.id=x.lot_id WHERE x.order_line_id=ol.id) AS lots
       FROM order_lines ol JOIN orders o ON o.id=ol.order_id
      WHERE o.status='completed' AND EXISTS (SELECT 1 FROM order_line_lots x WHERE x.order_line_id=ol.id)
        AND ol.cost_amount <> (SELECT SUM(CAST(ROUND(x.qty_milli * l.unit_cost / 1000.0) AS INTEGER)) FROM order_line_lots x JOIN lots l ON l.id=x.lot_id WHERE x.order_line_id=ol.id)`,
  );
  expect(lineDiff, "cost dòng ≠ Σ lô × giá vốn").toEqual([]);
  const totDiff = await all(`SELECT o.code, o.cost_total, (SELECT COALESCE(SUM(cost_amount),0) FROM order_lines WHERE order_id=o.id) s FROM orders o WHERE o.status='completed' AND o.cost_total <> (SELECT COALESCE(SUM(cost_amount),0) FROM order_lines WHERE order_id=o.id)`);
  expect(totDiff, "orders.cost_total ≠ Σ cost dòng").toEqual([]);
  // đơn bán đã hoàn tất xuất kho theo đơn: |Σ thẻ kho| = giá vốn đơn
  const mvDiff = await all(
    `SELECT o.code, o.kind, (SELECT COALESCE(SUM(ol.cost_amount),0) FROM order_lines ol WHERE ol.order_id=o.id AND EXISTS (SELECT 1 FROM order_line_lots x WHERE x.order_line_id=ol.id)) AS cost,
            (SELECT COALESCE(SUM(CAST(ROUND(m.qty_delta_milli * m.unit_cost / 1000.0) AS INTEGER)),0) FROM stock_moves m WHERE m.ref_type='order' AND m.ref_id=o.id) AS mv
       FROM orders o WHERE o.status='completed' AND o.channel <> 'b2b'
        AND ABS((SELECT COALESCE(SUM(CAST(ROUND(m.qty_delta_milli * m.unit_cost / 1000.0) AS INTEGER)),0) FROM stock_moves m WHERE m.ref_type='order' AND m.ref_id=o.id))
            <> (SELECT COALESCE(SUM(ol.cost_amount),0) FROM order_lines ol WHERE ol.order_id=o.id AND EXISTS (SELECT 1 FROM order_line_lots x WHERE x.order_line_id=ol.id))`,
  );
  expect(mvDiff, "giá vốn đơn ≠ thẻ kho của đơn").toEqual([]);
  // giá vốn lãi lỗ (+ phần trả không nhập kho) = giá trị xuất kho thực của các đơn/phiếu giao đã hoàn tất hôm nay
  const mv = await one<{ v: number }>(
    `SELECT COALESCE(SUM(CAST(ROUND(m.qty_delta_milli * m.unit_cost / 1000.0) AS INTEGER) * 1),0) v FROM stock_moves m
      WHERE m.move_type IN ('sale','return') AND (
        (m.ref_type='order' AND EXISTS (SELECT 1 FROM orders o WHERE o.id=m.ref_id AND ${W}))
     OR (m.ref_type='delivery' AND EXISTS (SELECT 1 FROM deliveries d JOIN orders o ON o.id=d.order_id WHERE d.id=m.ref_id AND ${W}))
     OR (m.ref_type='b2b_return' AND date(datetime(m.at,'+7 hours')) = ?))`,
    TODAY, TODAY, TODAY,
  );
  const disc = await one<{ d: number }>(
    `SELECT COALESCE(SUM(ol.cost_amount),0) d FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE ${W} AND o.kind='return' AND NOT EXISTS (SELECT 1 FROM order_line_lots x WHERE x.order_line_id=ol.id)`,
    TODAY,
  );
  expect(p.cogs + disc.d, "giá vốn lãi lỗ ≠ giá trị xuất kho thực (thẻ kho) của đơn hoàn tất").toBe(0 - mv.v || 0);
  // tiền của đơn: đơn bán hoàn tất = Σ thanh toán xác nhận + phần ghi nợ (hoá đơn của đơn); đơn trả = −(Σ hoàn + phần trừ nợ)
  const unsettled = await all(
    `SELECT o.code, o.kind, o.channel, o.total,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed' AND p.method<>'credit'),0) AS paid,
            COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.order_id=o.id AND i.status<>'cancelled'),0) AS inv
       FROM orders o WHERE o.status='completed' AND o.channel <> 'b2b'
        AND (CASE WHEN o.kind='sale' THEN o.total ELSE -o.total END)
            <> COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed' AND p.method<>'credit'),0) + COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.order_id=o.id AND i.status<>'cancelled'),0)`,
  );
  expect(unsettled, "đơn hoàn tất: tổng đơn ≠ Σ thanh toán + ghi nợ").toEqual([]);
  // đơn B2B hoàn tất: tổng đơn = hoá đơn
  const b2b = await all(`SELECT o.code, o.total, (SELECT SUM(i.total) FROM invoices i WHERE i.order_id=o.id AND i.kind='sale' AND i.status<>'cancelled') it FROM orders o WHERE o.channel='b2b' AND o.kind='sale' AND o.status='completed' AND COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.order_id=o.id AND i.kind='sale' AND i.status<>'cancelled'),-1) <> o.total`);
  expect(b2b, "đơn sỉ hoàn tất: tổng đơn ≠ hoá đơn").toEqual([]);
}

/** Bất biến 5 — ca: công thức dự kiến khớp sổ quỹ tiền mặt trong khoảng ca (tiền của ca). */
async function invShift(shiftId: number) {
  const s = await one<any>(`SELECT * FROM shifts WHERE id=?`, shiftId);
  const sum = await must("owner", "GET", `${V}/shifts/${shiftId}/summary`);
  const exp = s.status === "closed" ? s.expected_cash : sum.cashFormula.expected;
  const to = s.closed_at ?? "9999";
  // sổ quỹ tiền mặt của ca: payments tiền mặt của đơn thuộc ca (đơn tại quầy theo shift_id; đơn giao từ quầy theo pos_shift_id)
  // + phiếu thu/chi tiền mặt do người mở ca lập trong khoảng ca (trừ chuyển quỹ, chi phí do kế toán lập)
  const pay = await one<{ s: number }>(
    `SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.fund_id=?1 AND p.method='cash' AND (
        -- đơn tại quầy của ca; đơn huỷ sau khi ca chốt: tiền đã nằm trong két lúc chốt, tiền hoàn ra từ két ca khác (refund_shift_id)
        (o.shift_id=?2 AND ((p.status='confirmed' AND ${FUND_RULE}) OR (p.status='refunded' AND o.refund_shift_id IS NOT NULL AND o.refund_shift_id <> ?2)))
        -- đơn giao từ quầy của ca: tiền trả trước; tiền hoàn khi ca còn mở hoặc ghi đích danh ca này
     OR (o.pos_shift_id=?2 AND p.status='confirmed' AND (p.amount > 0 OR p.refund_shift_id=?2 OR (p.refund_shift_id IS NULL AND p.created_at <= ?3)))
        -- đơn giao của ca khác, hoàn tiền mặt từ két ca này (B-N3)
     OR (COALESCE(o.pos_shift_id,0)<>?2 AND p.status='confirmed' AND p.amount < 0 AND p.refund_shift_id=?2))`,
    s.fund_id, shiftId, s.closed_at ?? "9999",
  );
  const vou = await one<{ s: number }>(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) s FROM cash_vouchers
      WHERE fund_id=? AND status='posted' AND created_by=? AND created_at >= ? AND created_at <= ? AND COALESCE(ref_type,'') NOT IN ('fund_transfer','manual')`,
    s.fund_id, s.user_id, s.opened_at, to,
  );
  // huỷ đơn của ca đã chốt: tiền mặt hoàn lấy từ két ca đang mở của người huỷ (refund_shift_id)
  const voidOut = await one<{ s: number }>(
    `SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.refund_shift_id=? AND p.method='cash' AND p.status='refunded'`, shiftId,
  );
  expect(exp, `ca #${shiftId}: dự kiến ≠ đầu ca + sổ quỹ tiền mặt của ca`).toBe(s.opening_cash + pay.s + vou.s - voidOut.s);
}

/**
 * Bất biến 5b — phân rã quỹ tiền mặt: số dư quỹ = Σ (dự kiến − đầu ca) của mọi ca + phiếu tiền mặt ngoài công thức ca
 * + payments tiền mặt không thuộc ca nào. Mỗi đồng vào/ra két phải thuộc đúng một ca hoặc rõ ràng nằm ngoài ca.
 */
async function invCashPartition() {
  const fund = ((await must("owner", "GET", `${V}/funds`)).items as any[]).find((f) => f.id === FUND_CASH).balance as number;
  let shifts = 0;
  for (const s of await all<any>(`SELECT * FROM shifts WHERE fund_id=?`, FUND_CASH)) {
    const exp = s.status === "closed" ? s.expected_cash : (await must("owner", "GET", `${V}/shifts/${s.id}/summary`)).cashFormula.expected;
    shifts += exp - s.opening_cash;
  }
  const inShift = `EXISTS (SELECT 1 FROM shifts s WHERE s.fund_id=v.fund_id AND s.user_id=v.created_by AND v.created_at >= s.opened_at AND v.created_at <= COALESCE(s.closed_at,'9999'))
    AND (v.ref_type='order_deposit' OR (v.ref_type='debt_payment' AND EXISTS (SELECT 1 FROM debt_payments dp WHERE dp.id=v.ref_id AND dp.partner_type='customer')))`;
  const vOut = await one<{ s: number }>(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) s FROM cash_vouchers v WHERE v.fund_id=? AND v.status='posted' AND NOT (${inShift})`, FUND_CASH);
  const pOut = await one<{ s: number }>(
    `SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.fund_id=? AND p.status='confirmed' AND ${FUND_RULE} AND o.shift_id IS NULL AND o.pos_shift_id IS NULL AND p.refund_shift_id IS NULL`,
    FUND_CASH,
  );
  expect(shifts + vOut.s + pOut.s, "quỹ tiền mặt ≠ Σ tiền của các ca + phiếu ngoài ca + thu/chi ngoài ca").toBe(fund);
}

/** Bất biến 6 — điểm & voucher. */
async function invLoyalty() {
  const pts = await all(`SELECT c.id, c.points, COALESCE((SELECT SUM(points) FROM loyalty_ledger l WHERE l.customer_id=c.id),0) AS led FROM customers c WHERE c.points <> COALESCE((SELECT SUM(points) FROM loyalty_ledger l WHERE l.customer_id=c.id),0)`);
  expect(pts, "điểm khách ≠ Σ sổ điểm").toEqual([]);
  const neg = await all(`SELECT id, points FROM customers WHERE points < 0`);
  const leftover = await all(`SELECT o.code, SUM(l.points) p FROM loyalty_ledger l JOIN orders o ON o.id=l.order_id WHERE o.status='cancelled' GROUP BY o.id HAVING SUM(l.points) <> 0`);
  expect(leftover, "điểm của đơn đã huỷ chưa hoàn lại").toEqual([]);
  expect(neg).toEqual([]);
  const vc = await all(
    `SELECT v.code, v.used_count, (SELECT COUNT(*) FROM voucher_redemptions r JOIN orders o ON o.id=r.order_id WHERE r.voucher_id=v.id AND r.status='used') AS used,
            (SELECT COUNT(*) FROM voucher_redemptions r JOIN orders o ON o.id=r.order_id WHERE r.voucher_id=v.id AND r.status='used' AND o.status='cancelled') AS onCancelled
       FROM vouchers v`,
  );
  for (const v of vc) {
    expect(v.used_count, `voucher ${v.code}: used_count ≠ số lượt dùng hiệu lực`).toBe(v.used);
    expect(v.onCancelled, `voucher ${v.code}: lượt dùng còn hiệu lực trên đơn đã huỷ`).toBe(0);
  }
}

/** Bất biến 7 — khoản chờ SePay. */
async function invSepay() {
  const hold = (await must("owner", "GET", `${V}/sepay/hold`)).summary;
  const led = await one<{ i: number; o: number }>(
    `SELECT COALESCE(SUM(CASE WHEN cc.code='CK_CHO_XL' THEN v.amount END),0) i, COALESCE(SUM(CASE WHEN cc.code='CK_CHO_XL_RA' THEN v.amount END),0) o
       FROM cash_vouchers v JOIN cash_categories cc ON cc.id=v.category_id WHERE v.status='posted'`,
  );
  expect(hold.balance, "khoản chờ ≠ Σ phiếu thu chờ − Σ phiếu chi khỏi chờ").toBe(led.i - led.o);
  const open = await one<{ s: number; n: number }>(
    `SELECT COALESCE(SUM(v.amount),0) s, COUNT(*) n FROM sepay_events e JOIN cash_vouchers v ON v.id=e.hold_in_voucher_id WHERE e.hold_out_voucher_id IS NULL`,
  );
  expect(hold.balance, "khoản chờ ≠ Σ sự kiện SePay còn treo").toBe(open.s);
  expect(hold.openCount).toBe(open.n);
}

/** Bất biến 8 — audit: mỗi chứng từ do API tạo có dòng audit_log (entity_id = id hoặc mã). */
async function invAudit() {
  const miss: string[] = [];
  const chk = async (entity: string, sql: string) => {
    const ents = entity.split("|");
    for (const r of await all<{ id: number; code: string }>(sql)) {
      const a = await one<{ n: number }>(`SELECT COUNT(*) n FROM audit_log WHERE entity IN (${ents.map(() => "?").join(",")}) AND entity_id IN (?, ?)`, ...ents, String(r.id), String(r.code ?? ""));
      if (!a.n) miss.push(`${ents[0]} ${r.code ?? r.id}`);
    }
  };
  // đơn do người dùng ERP lập (đơn web do khách tự đặt ở site bán hàng không có người dùng ERP → bỏ qua)
  // (phiếu trả B2B: audit "b2b_order.return" trên đơn gốc, after chứa mã phiếu trả)
  for (const o of await all<any>(`SELECT id, code FROM orders WHERE created_by IS NOT NULL`)) {
    const a = await one<{ n: number }>(`SELECT COUNT(*) n FROM audit_log WHERE (entity IN ('order','b2b_order') AND entity_id IN (?, ?)) OR (entity IN ('order','b2b_order') AND after_json LIKE ?)`, String(o.id), o.code, `%"${o.code}"%`);
    if (!a.n) miss.push(`order ${o.code}`);
  }
  await chk("stock_doc", `SELECT id, code FROM stock_docs WHERE po_id IS NULL`);
  // phiếu nhập sinh từ nhận hàng PO: audit "po.receive" của PO ghi mã phiếu
  for (const d of await all<any>(`SELECT code, po_id FROM stock_docs WHERE po_id IS NOT NULL`)) {
    const a = await one<{ n: number }>(`SELECT COUNT(*) n FROM audit_log WHERE action='po.receive' AND entity_id=? AND after_json LIKE ?`, String(d.po_id), `%${d.code}%`);
    if (!a.n) miss.push(`stock_doc ${d.code} (PO)`);
  }
  await chk("cash_voucher", `SELECT id, code FROM cash_vouchers WHERE COALESCE(ref_type,'manual')='manual' AND reverses_id IS NULL`);
  // phiếu đảo: audit "voucher.reverse" ghi trên phiếu gốc, after chứa mã phiếu đảo
  for (const v of await all<any>(`SELECT code, reverses_id FROM cash_vouchers WHERE reverses_id IS NOT NULL AND COALESCE(ref_type,'manual')='manual'`)) {
    const a = await one<{ n: number }>(`SELECT COUNT(*) n FROM audit_log WHERE action='voucher.reverse' AND entity_id=? AND after_json LIKE ?`, String(v.reverses_id), `%${v.code}%`);
    if (!a.n) miss.push(`cash_voucher ${v.code} (đảo)`);
  }
  await chk("debt_payment", `SELECT id, code FROM debt_payments`);
  await chk("fund_transfer", `SELECT id, code FROM fund_transfers`);
  await chk("settlement", `SELECT id, external_ref AS code FROM settlements`);
  await chk("purchase_order", `SELECT id, code FROM purchase_orders`);
  await chk("quote", `SELECT id, code FROM quotes`);
  await chk("shift", `SELECT id, NULL AS code FROM shifts`);
  await chk("delivery", `SELECT id, code FROM deliveries`);
  // sự kiện SePay: audit theo sự kiện (chưa khớp/gán/hoàn), theo mã QR quầy, hoặc theo đơn được trả (khớp ngay)
  for (const e of await all<any>(`SELECT id, ref_id, ref_code FROM sepay_events`)) {
    const a = await one<{ n: number }>(
      `SELECT COUNT(*) n FROM audit_log WHERE (entity='sepay_event' AND entity_id=?) OR (entity='pos_qr' AND entity_id=?) OR (entity='order' AND action LIKE 'sepay.%' AND entity_id=?)`,
      String(e.id), String(e.ref_id ?? ""), String(e.ref_code ?? ""),
    );
    if (!a.n) miss.push(`sepay_event ${e.id}`);
  }
  expect(miss, "chứng từ thiếu audit_log").toEqual([]);
}

async function checkAll(opts: { shifts?: number[] } = {}) {
  await invFunds();
  await invStock();
  await invDebts();
  await invPnl();
  for (const s of opts.shifts ?? []) await invShift(s);
  await invCashPartition();
  await invLoyalty();
  await invSepay();
  await invAudit();
}

// ------------------------------------------------------------------ trạng thái kịch bản
let cashierShift = 0, managerShift = 0;
let closedShiftSnapshot: { expected: number; voidedOrder: number } | null = null;
const bankBal = async () => ((await must("owner", "GET", `${V}/funds`)).items as any[]).find((f) => f.id === FUND_BANK).balance as number;
const lotsOf = async (pid: number) => all<any>(`SELECT * FROM lots WHERE product_id=? ORDER BY id`, pid);
const sale = (role: string, body: Record<string, unknown>) => must(role, "POST", `${V}/pos/orders`, { clientUuid: uid(), payments: [], ...body }, 201);
const kg = (productId: number, qty: number) => ({ productId, unit: "kg", qty });
const orderOf = (code: string) => one<any>(`SELECT * FROM orders WHERE code=?`, code);
const linesOf = (orderId: number) => all<any>(`SELECT * FROM order_lines WHERE order_id=? ORDER BY id`, orderId);
const posOrders: Record<string, any> = {};

/** Bất biến 7b: một bước SePay (webhook + xử lý) làm quỹ ngân hàng tăng đúng số tiền báo về − hoàn. */
async function sepayStep(net: number, fn: () => Promise<void>) {
  const b0 = await bankBal();
  await fn();
  expect((await bankBal()) - b0, "SePay: tiền báo về − hoàn ≠ mức tăng quỹ ngân hàng").toBe(net);
}

/** Cashier: trả hàng cần quản lý duyệt (A-16) → gửi, duyệt, gửi lại. */
async function withApproval(role: string, path: string, body: Record<string, unknown>) {
  const first = await api(role, "POST", path, body);
  if (first.status === 409 && first.body?.error?.code === "approval_required") {
    const aid = first.body.error.details.approvalId;
    await must("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" });
    return must(role, "POST", path, { ...body, approvalId: aid });
  }
  if (first.status >= 300) throw new Error(`${path} → ${first.status} ${JSON.stringify(first.body)}`);
  return first.body;
}

beforeAll(async () => {
  await seedDay();
});

describe("Ngày làm việc mô phỏng — đối chiếu chéo toàn hệ thống", () => {
  it("0. dữ liệu gốc: bất biến đúng ngay từ đầu", async () => {
    await checkAll();
  });

  it("1. nhập hàng nhiều lô (2 phiếu nhập có NCC → hoá đơn mua)", async () => {
    const exp = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();
    const r1 = await must("warehouse", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId: SUP_A, supplierRef: "HD-A-001" });
    await must("warehouse", "POST", `${V}/stock-docs/${r1.id}/lines`, { productId: P_TAO, unit: "kg", qty: 30, unitCost: 60000, expiresAt: exp(5) });
    await must("warehouse", "POST", `${V}/stock-docs/${r1.id}/lines`, { productId: P_NHO, unit: "kg", qty: 10, unitCost: 150000, expiresAt: exp(7) });
    await must("manager", "POST", `${V}/stock-docs/${r1.id}/post`);
    const r2 = await must("warehouse", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId: SUP_A, supplierRef: "HD-A-002" });
    await must("warehouse", "POST", `${V}/stock-docs/${r2.id}/lines`, { productId: P_TAO, unit: "kg", qty: 20, unitCost: 70000, expiresAt: exp(12) });
    await must("warehouse", "POST", `${V}/stock-docs/${r2.id}/lines`, { productId: P_CAM, unit: "kg", qty: 20, unitCost: 30000, expiresAt: exp(9) });
    await must("manager", "POST", `${V}/stock-docs/${r2.id}/post`);
    expect((await lotsOf(P_TAO)).length).toBe(2);
    const bills = await all(`SELECT total FROM supplier_bills WHERE supplier_id=? ORDER BY id`, SUP_A);
    expect(bills.map((b: any) => b.total)).toEqual([30 * 60000 + 10 * 150000, 20 * 70000 + 20 * 30000]);
    await checkAll();
  });

  it("2. bán POS: tiền mặt, QR, chia thanh toán, ghi nợ khách lẻ, thu khác, voucher, đổi điểm", async () => {
    cashierShift = (await must("cashier", "POST", `${V}/shifts/open`, { openingCash: 500000 })).shift.id;
    managerShift = (await must("manager", "POST", `${V}/shifts/open`, { openingCash: 200000 })).shift.id;
    posOrders.cash = await sale("cashier", { lines: [kg(P_TAO, 3)], payments: [{ method: "cash", amount: 300000 }] });
    // QR qua SePay: tạo mã → ngân hàng báo về → thanh toán đơn bằng mã. Quỹ ngân hàng tăng đúng 200k.
    await sepayStep(200000, async () => {
      const q = await must("cashier", "POST", `${V}/pos/qr-requests`, { amount: 200000 });
      expect((await hook(tx(q.code, 200000))).body).toEqual({ success: true });
      posOrders.qr = await sale("cashier", { lines: [kg(P_NHO, 1)], payments: [{ method: "qr", amount: 200000, qrRequestId: q.id }] });
    });
    posOrders.split = await sale("cashier", { lines: [kg(P_TAO, 1), kg(P_NHO, 1)], payments: [{ method: "cash", amount: 150000 }, { method: "transfer", amount: 150000, ref: "FTCK001" }] });
    expect(posOrders.split.total).toBe(300000);
    // ghi nợ khách lẻ (quản lý có pos.credit): 200k, trả 50k tiền mặt, nợ 150k
    posOrders.credit = await sale("manager", { customerId: C_CREDIT, lines: [kg(P_TAO, 2)], payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } });
    expect(await one(`SELECT total FROM invoices WHERE order_id=? AND kind='sale'`, posOrders.credit.id)).toEqual({ total: 150000 });
    // thu khác: phí giỏ quà 30k
    posOrders.charge = await sale("cashier", { lines: [kg(P_TAO, 1)], charges: [{ chargeTypeId: 903, amount: 30000 }], payments: [{ method: "cash", amount: 130000 }] });
    expect(posOrders.charge.total).toBe(130000);
    // voucher 20k + tích điểm cho khách điểm
    posOrders.voucher = await sale("cashier", { customerId: C_POINTS, voucherCode: "INV20K", lines: [kg(P_TAO, 2)], payments: [{ method: "cash", amount: 180000 }] });
    expect(posOrders.voucher.total).toBe(180000);
    // đổi điểm (khách có điểm từ đơn trên + điều chỉnh tặng)
    await must("manager", "POST", `${V}/customers/${C_POINTS}/loyalty/adjust`, { points: 500, note: "Tặng điểm khai trương" });
    const before = await one<{ p: number }>(`SELECT points p FROM customers WHERE id=?`, C_POINTS);
    posOrders.points = await sale("cashier", { customerId: C_POINTS, redeemPoints: 100, lines: [kg(P_NHO, 1)], payments: [{ method: "cash", amount: 200000 }] });
    expect(posOrders.points.total).toBeLessThan(200000);
    const after = await one<{ p: number }>(`SELECT points p FROM customers WHERE id=?`, C_POINTS);
    expect(after.p).toBeLessThan(before.p);
    await checkAll({ shifts: [cashierShift, managerShift] });
  });
  it("3. sau bán: trả hàng, trả hàng nhanh, sửa hoá đơn, đổi hàng, huỷ đơn, thu nợ tại quầy", async () => {
    // trả 1 kg của đơn tiền mặt (thu ngân → cần duyệt), nhập lại kho
    const cashLines = await linesOf(posOrders.cash.id);
    await withApproval("cashier", `${V}/orders/${posOrders.cash.id}/return`, { lines: [{ orderLineId: cashLines[0].id, qty: 1, unit: "kg", restock: true, reason: "khách đổi ý" }], refundMethod: "cash" });
    // trả 1 kg của đơn chia thanh toán, KHÔNG nhập lại (hàng hỏng) — quản lý
    const splitLines = await linesOf(posOrders.split.id);
    await withApproval("manager", `${V}/orders/${posOrders.split.id}/return`, { lines: [{ orderLineId: splitLines[0].id, qty: 1, unit: "kg", restock: false, reason: "hàng dập" }], refundMethod: "cash" });
    // trả hàng nhanh không hoá đơn
    await withApproval("manager", `${V}/pos/quick-return`, { clientUuid: uid(), lines: [{ productId: P_TAO, unit: "kg", qty: 1, restock: true }], reason: "khách trả không hoá đơn", refundMethod: "cash" });
    // sửa hoá đơn: đơn thu khác (1 kg Táo + giỏ quà) → 2 kg Táo, khách trả thêm
    const corr = await withApproval("manager", `${V}/orders/${posOrders.charge.id}/correct`, { clientUuid: uid(), reason: "nhập nhầm số lượng", lines: [kg(P_TAO, 2)], refundMethod: "cash", payments: [{ method: "cash", amount: 100000 }] });
    posOrders.corrected = corr.sale ?? corr;
    // đổi hàng: trả 1 kg Táo của đơn voucher, lấy 1 kg Nho, trả thêm tiền mặt
    const vLines = await linesOf(posOrders.voucher.id);
    await withApproval("manager", `${V}/orders/${posOrders.voucher.id}/exchange`, {
      clientUuid: uid(), returnLines: [{ orderLineId: vLines[0].id, qty: 1, unit: "kg", restock: true, reason: "khách đổi loại" }],
      newLines: [kg(P_NHO, 1)], refundMethod: "cash", payments: [{ method: "cash", amount: 200000 }],
    });
    // huỷ đơn: bán rồi huỷ ngay (quản lý)
    const v = await sale("cashier", { lines: [kg(P_NHO, 1)], payments: [{ method: "cash", amount: 200000 }] });
    await must("manager", "POST", `${V}/orders/${v.id}/void`, { reason: "khách đổi ý không mua" });
    posOrders.voided = v;
    // thu nợ tại quầy: khách nợ trả 100k tiền mặt (còn nợ 50k)
    await must("manager", "POST", `${V}/pos/debt-payments`, { customerId: C_CREDIT, amount: 100000, method: "cash", idempotencyKey: uid() });
    await checkAll({ shifts: [cashierShift, managerShift] });
    // trả 1 kg (100k) của đơn ghi nợ: trừ hết 50k nợ còn lại, hoàn 50k tiền mặt
    const crLines = await linesOf(posOrders.credit.id);
    await withApproval("manager", `${V}/orders/${posOrders.credit.id}/return`, { lines: [{ orderLineId: crLines[0].id, qty: 1, unit: "kg", restock: true, reason: "khách trả bớt" }], refundMethod: "cash" });
    await checkAll({ shifts: [cashierShift, managerShift] });
  });
  it("4. đơn online: COD, chuyển khoản SePay khớp, không khớp → gán, huỷ + hoàn; SePay lạ → hoàn; QR huỷ → chờ hoàn", async () => {
    const web = async (paymentMethod: "cod" | "transfer") => {
      const r = await call("POST", "/api/checkout", checkoutBody({ paymentMethod }));
      if (r.status !== 201) throw new Error("checkout " + r.status + r.text);
      return orderOf(r.body.code);
    };
    const run = async (o: any) => {
      const st = (await orderOf(o.code)).status;
      if (st === "new") await must("online_staff", "POST", `${V}/online-orders/${o.id}/confirm`);
      await must("online_staff", "POST", `${V}/online-orders/${o.id}/prepare`);
      const ls = await linesOf(o.id);
      await must("online_staff", "POST", `${V}/online-orders/${o.id}/pack`, { lines: ls.map((l: any) => ({ orderLineId: l.id, actualQty: l.qty_milli / 1000 })) });
      await must("online_staff", "POST", `${V}/online-orders/${o.id}/ship`, {});
      await must("online_staff", "POST", `${V}/online-orders/${o.id}/deliver`);
    };
    posOrders.webCod = await web("cod");
    await run(posOrders.webCod);
    await checkAll();
    // chuyển khoản đúng mã
    const b = await web("transfer");
    await sepayStep(b.total, async () => { expect((await hook(tx(b.code, b.total))).body).toEqual({ success: true }); });
    await run(b);
    await checkAll();
    // chuyển khoản sai mã → khoản chờ → gán đơn
    const cOrd = await web("transfer");
    await sepayStep(cOrd.total, async () => {
      const t = tx("DH000000099999", cOrd.total);
      expect((await hook(t)).body).toEqual({ success: false });
      await invSepay();
      const ev = await one<any>(`SELECT id FROM sepay_events WHERE sepay_id=?`, t.id);
      await must("accountant", "POST", `${V}/sepay/events/${ev.id}/assign`, { kind: "web", code: cOrd.code, note: "khách ghi nhầm mã" });
    });
    await checkAll();
    // huỷ đơn đã trả tiền → hoàn tiền: quỹ ngân hàng giảm đúng số hoàn
    await sepayStep(-cOrd.total, async () => {
      await must("online_staff", "POST", `${V}/online-orders/${cOrd.id}/cancel`, { reason: "khách đổi ý" });
      await must("accountant", "POST", `${V}/online-orders/${cOrd.id}/refund`);
    });
    await checkAll();
    // tiền lạ → khoản chờ → đã hoàn
    await sepayStep(0, async () => {
      const t = tx("DH000000077777", 333000);
      await hook(t);
      const ev = await one<any>(`SELECT id FROM sepay_events WHERE sepay_id=?`, t.id);
      await must("accountant", "POST", `${V}/sepay/events/${ev.id}/resolve`, { action: "refunded", reason: "Đã hoàn qua Internet Banking", refundRef: "FTHOAN1" });
    });
    // mã QR quầy bị thay → tiền về mã cũ → chờ hoàn (vẫn là tiền trong tài khoản)
    await sepayStep(50000, async () => {
      const q1 = await must("cashier", "POST", `${V}/pos/qr-requests`, { amount: 50000 });
      await must("cashier", "POST", `${V}/pos/qr-requests`, { amount: 60000 }); // mã mới thay mã cũ
      expect((await hook(tx(q1.code, 50000))).body).toEqual({ success: false });
    });
    await checkAll({ shifts: [cashierShift, managerShift] });
  });
  it("5. đơn giao từ quầy: trả trước + COD giao xong; COD giao thất bại → nhập lại kho", async () => {
    const body = (over: Record<string, unknown>) => ({
      clientUuid: uid(), receiver: { name: "Chị Lan", phone: "0901234567", address: "12 Lê Lợi, Quận 1" },
      lines: [kg(P_TAO, 2)], shippingFee: 20000, deliverer: { userId: 3 }, prepay: [], cod: 220000, ...over,
    });
    const a = await must("cashier", "POST", `${V}/pos/delivery-orders`, body({ prepay: [{ method: "cash", amount: 100000 }], cod: 120000 }), 201);
    await invShift(cashierShift);
    await must("online_staff", "POST", `${V}/online-orders/${a.id}/deliver`);
    posOrders.delivA = a;
    await checkAll({ shifts: [cashierShift] });
    const f = await must("cashier", "POST", `${V}/pos/delivery-orders`, body({ lines: [kg(P_NHO, 1)], shippingFee: 0, cod: 200000 }), 201);
    await must("online_staff", "POST", `${V}/online-orders/${f.id}/fail`, { reason: "Khách không nhận" });
    const ls = await linesOf(f.id);
    await must("online_staff", "POST", `${V}/online-orders/${f.id}/return-to-stock`, { lines: [{ orderLineId: ls[0].id, qty: 1, restock: true, reason: "Hàng còn nguyên" }] });
    // trả trước rồi giao thất bại → hoàn tiền mặt
    const g = await must("cashier", "POST", `${V}/pos/delivery-orders`, body({ lines: [kg(P_TAO, 1)], shippingFee: 0, prepay: [{ method: "cash", amount: 100000 }], cod: 0 }), 201);
    await must("online_staff", "POST", `${V}/online-orders/${g.id}/fail`, { reason: "Sai địa chỉ" });
    const gl = await linesOf(g.id);
    await must("online_staff", "POST", `${V}/online-orders/${g.id}/return-to-stock`, { lines: [{ orderLineId: gl[0].id, qty: 1, restock: true, reason: "Hàng còn nguyên" }] });
    expect((await api("accountant", "POST", `${V}/online-orders/${g.id}/refund`)).status).toBe(200);
    posOrders.delivG = g;
    await checkAll({ shifts: [cashierShift, managerShift] });
  });
  it("6. B2B: báo giá → đơn → soạn thiếu, giao thiếu → hoá đơn → thu nợ một phần", async () => {
    const c = await must("owner", "POST", `${V}/customers`, {
      name: "Nhà hàng Sen", type: "b2b", customerGroupId: 2, creditLimit: 50_000_000, paymentTermsDays: 15,
      contacts: [{ name: "Anh Tùng", phone: "0900000701", isReceiver: true }], addresses: [{ label: "Bếp", address: "5 Hai Bà Trưng", isDefault: true }],
    });
    posOrders.b2bCust = c.id;
    const q = await must("manager", "POST", `${V}/quotes`, { customerId: c.id, lines: [{ productId: P_CAM, unit: "kg", qty: 15 }] }, 201);
    await must("manager", "POST", `${V}/quotes/${q.id}/send`);
    const o = await must("manager", "POST", `${V}/quotes/${q.id}/convert`, { addressId: c.addresses[0].id, deliveryDate: addDays(TODAY, 1) }, 201);
    await checkAll();
    const pk = await must("warehouse", "POST", `${V}/b2b/orders/${o.id}/pick`, undefined, 201);
    await must("warehouse", "POST", `${V}/deliveries/${pk.deliveryId}/scan`, { code: "CAM", qty: 12 }, 201);
    await must("warehouse", "POST", `${V}/deliveries/${pk.deliveryId}/ready`, { reason: "Thiếu hàng đẹp, giao 12 kg" });
    await must("warehouse", "POST", `${V}/deliveries/${pk.deliveryId}/ship`, { shipper: "Anh Ba" });
    await checkAll();
    const ol = (await must("manager", "GET", `${V}/b2b/orders/${o.id}`)).lines;
    const cf = await must("warehouse", "POST", `${V}/deliveries/${pk.deliveryId}/confirm`, { receiverName: "Anh Tùng", lines: [{ orderLineId: ol[0].id, deliveredQty: 11, rejectedQty: 1, rejectReason: "hong" }] });
    expect(cf.invoice.total).toBe(11 * 50000);
    await checkAll();
    await must("accountant", "POST", `${V}/debts/payments`, {
      direction: "in", partnerType: "customer", partnerId: c.id, fundId: FUND_BANK, amount: 300000, method: "transfer", ref: "FTB2B01",
      allocations: [{ invoiceId: cf.invoice.id, amount: 300000 }], idempotencyKey: uid(),
    }, 201);
    // trả trước chưa gạch (khách chuyển dư) — số dư công nợ phải trừ
    await must("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: c.id, fundId: FUND_CASH, amount: 50000, method: "cash", idempotencyKey: uid() }, 201);
    // khách lẻ ghi nợ trả qua kế toán (chuyển khoản)
    await must("accountant", "POST", `${V}/debts/payments`, { direction: "in", partnerType: "customer", partnerId: C_CREDIT, fundId: FUND_BANK, amount: 20000, method: "transfer", ref: "FTKL01", idempotencyKey: uid() }, 201);
    // trả NCC một phần
    const bill = await one<any>(`SELECT id, total FROM supplier_bills WHERE supplier_id=? ORDER BY id LIMIT 1`, SUP_A);
    await must("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: SUP_A, fundId: FUND_BANK, amount: 1_000_000, method: "transfer", ref: "UNC01", allocations: [{ billId: bill.id, amount: 1_000_000 }], idempotencyKey: uid() }, [201, 202]);
    await checkAll();
  });

  it("7. PO: đơn sỉ thiếu hàng → PO → nhận thiếu → đóng PO", async () => {
    const { runPoCutoff } = await import("../src/worker/services/po");
    const c = posOrders.b2bCust;
    const addr = (await must("manager", "GET", `${V}/customers/${c}`)).addresses[0].id;
    const so = await must("manager", "POST", `${V}/b2b/orders`, { customerId: c, addressId: addr, deliveryDate: addDays(TODAY, 2), clientUuid: uid(), lines: [{ productId: P_CAM, unit: "kg", qty: 20 }] }, [200, 201]);
    await checkAll();
    await runPoCutoff(db(), { mode: "now", actor: { type: "system", userId: null } as any });
    const po0 = await one<any>(`SELECT p.* FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id=p.id WHERE l.product_id=? AND p.status='draft'`, P_CAM);
    expect(po0, "chưa sinh PO nháp cho phần thiếu").toBeTruthy();
    let po = await must("warehouse", "GET", `${V}/purchase-orders/${po0.id}`);
    if (po.lines[0].unitCost == null) po = await must("warehouse", "PUT", `${V}/purchase-orders/${po.id}`, { version: po.version, lines: [{ productId: P_CAM, qty: po.lines[0].qtyMilli / 1000, unitCost: 32000 }] });
    const sent = await must("manager", "POST", `${V}/purchase-orders/${po.id}/approve`, {});
    const conf = await must("manager", "POST", `${V}/purchase-orders/${po.id}/supplier-response`, { action: "confirm", version: sent.version });
    const need = conf.lines[0].qtyMilli;
    await must("warehouse", "POST", `${V}/purchase-orders/${po.id}/receive`, { lines: [{ poLineId: conf.lines[0].id, qtyMilli: need - 2000 }], supplierRef: "HD-B-001" }, [200, 201]);
    await checkAll();
    const cur = await must("manager", "GET", `${V}/purchase-orders/${po.id}`);
    await must("manager", "POST", `${V}/purchase-orders/${po.id}/close`, { reason: "NCC hết hàng", version: cur.version });
    posOrders.soShort = so;
    await checkAll();
  });
  it("8. kho: kiểm kê lệch, hao hụt, xuất dùng nội bộ, chuyển kho 2 bước", async () => {
    const tao = await lotsOf(P_TAO);
    const lot1 = tao.find((l: any) => l.qty_on_hand_milli > 3000)!;
    const cnt = await must("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 }, 201);
    await must("manager", "POST", `${V}/stock-docs/${cnt.id}/lines`, { lotId: lot1.id, countedQty: lot1.qty_on_hand_milli / 1000 - 1, unit: "kg" }, 201);
    await must("manager", "POST", `${V}/stock-docs/${cnt.id}/post`);
    await checkAll();
    const nho = (await lotsOf(P_NHO)).find((l: any) => l.qty_on_hand_milli - l.qty_reserved_milli >= 1000 && l.location_id === 1)!;
    const w = await must("manager", "POST", `${V}/stock-docs`, { type: "waste", locationId: 1 }, 201);
    await must("manager", "POST", `${V}/stock-docs/${w.id}/lines`, { lotId: nho.id, qty: 1, unit: "kg", reason: "heo" }, 201);
    await must("manager", "POST", `${V}/stock-docs/${w.id}/post`);
    const iu = await must("manager", "POST", `${V}/stock-docs`, { type: "internal_use", locationId: 1, reason: "Làm mẫu thử cho khách" }, 201);
    await must("manager", "POST", `${V}/stock-docs/${iu.id}/lines`, { productId: P_TAO, unit: "kg", qty: 1 }, 201);
    await must("manager", "POST", `${V}/stock-docs/${iu.id}/post`);
    await checkAll();
    const lot2 = (await lotsOf(P_TAO)).find((l: any) => l.qty_on_hand_milli - l.qty_reserved_milli >= 2000 && l.location_id === 1)!;
    const tr = await must("manager", "POST", `${V}/stock-docs`, { type: "transfer", locationId: 1, toLocationId: 2 }, 201);
    await must("manager", "POST", `${V}/stock-docs/${tr.id}/lines`, { lotId: lot2.id, qty: 2, unit: "kg" }, 201);
    await must("manager", "POST", `${V}/stock-docs/${tr.id}/post`);
    await checkAll(); // hàng đang đi đường
    await must("manager", "POST", `${V}/stock-docs/${tr.id}/receive`, {});
    await checkAll();
  });

  it("8b. biên: kiểm kê/hao hụt lô đang giữ hàng; trả hàng B2B sau hoá đơn; huỷ đơn ghi nợ; đổi sang hàng rẻ hơn", async () => {
    // lô Cam đang giữ cho đơn sỉ thiếu hàng: kiểm kê thấp hơn số giữ → hoặc bị chặn, hoặc giữ hàng phải điều chỉnh theo
    const cam = (await lotsOf(P_CAM)).find((l: any) => l.qty_reserved_milli > 0);
    expect(cam, "phải có lô Cam đang giữ hàng").toBeTruthy();
    const cnt = await must("manager", "POST", `${V}/stock-docs`, { type: "count", locationId: 1 }, 201);
    const cl = await api("manager", "POST", `${V}/stock-docs/${cnt.id}/lines`, { lotId: cam.id, countedQty: Math.max(0, cam.qty_reserved_milli - 2000) / 1000, unit: "kg" });
    if (cl.status === 201) await api("manager", "POST", `${V}/stock-docs/${cnt.id}/post`);
    // hiện hành: chặn 409 insufficient_stock (gợi ý cách ly lô), phiếu giữ ở nháp — bất biến giữ ≤ tồn vẫn đúng
    expect(["draft", "posted"]).toContain((await one<any>(`SELECT status FROM stock_docs WHERE id=?`, cnt.id)).status);
    await checkAll();
    const cam2 = await one<any>(`SELECT * FROM lots WHERE id=?`, cam.id);
    const w = await must("manager", "POST", `${V}/stock-docs`, { type: "waste", locationId: 1 }, 201);
    const wl = await api("manager", "POST", `${V}/stock-docs/${w.id}/lines`, { lotId: cam.id, qty: Math.max(1, cam2.qty_on_hand_milli / 1000), unit: "kg", reason: "heo" });
    if (wl.status === 201) await api("manager", "POST", `${V}/stock-docs/${w.id}/post`);
    expect(["draft", "posted"]).toContain((await one<any>(`SELECT status FROM stock_docs WHERE id=?`, w.id)).status);
    await checkAll();
    // trả hàng B2B sau khi đã xuất hoá đơn (2 kg, nhập lại kho)
    const b2bOrder = await one<any>(`SELECT id FROM orders WHERE channel='b2b' AND status='completed' ORDER BY id LIMIT 1`);
    const bl = await linesOf(b2bOrder.id);
    await must("manager", "POST", `${V}/b2b/orders/${b2bOrder.id}/returns`, { lines: [{ orderLineId: bl[0].id, qty: 2, unit: "kg", restock: true, reason: "Khách trả dư" }] }, [200, 201]);
    await checkAll();
    // huỷ đơn ghi nợ chưa thu đồng nào → hoá đơn điều chỉnh toàn bộ
    const cr = await sale("manager", { customerId: C_CREDIT, lines: [kg(P_TAO, 1)], payments: [], credit: { amount: 100000 } });
    await checkAll({ shifts: [managerShift] });
    await must("manager", "POST", `${V}/orders/${cr.id}/void`, { reason: "khách không lấy nữa" });
    await checkAll({ shifts: [managerShift] });
    // đổi 1 kg Nho (200k) lấy 1 kg Táo (100k): hoàn chênh tiền mặt
    const n = await sale("cashier", { lines: [kg(P_NHO, 1)], payments: [{ method: "cash", amount: 200000 }] });
    const nl = await linesOf(n.id);
    await withApproval("manager", `${V}/orders/${n.id}/exchange`, { clientUuid: uid(), returnLines: [{ orderLineId: nl[0].id, qty: 1, unit: "kg", restock: true, reason: "khách đổi loại" }], newLines: [kg(P_TAO, 1)], refundMethod: "cash" });
    // đổi điểm rồi trả hàng: điểm đã đổi/tích phải cân với sổ điểm
    const pv = await sale("cashier", { customerId: C_POINTS, redeemPoints: 50, lines: [kg(P_TAO, 2)], payments: [{ method: "cash", amount: 200000 }] });
    const pl = await linesOf(pv.id);
    await withApproval("cashier", `${V}/orders/${pv.id}/return`, { lines: [{ orderLineId: pl[0].id, qty: 2, unit: "kg", restock: true, reason: "khách trả hết" }], refundMethod: "cash" });
    await checkAll({ shifts: [cashierShift, managerShift] });
  });

  it("9. quỹ: phiếu thu/chi (có duyệt, có đảo), chuyển quỹ, đối soát COD; huỷ đơn có voucher", async () => {
    await must("accountant", "POST", `${V}/vouchers`, { direction: "out", fundId: FUND_CASH, categoryId: catId.DIEN_NUOC, amount: 300000, counterparty: "EVN", note: "Tiền điện" }, 201);
    await must("accountant", "POST", `${V}/vouchers`, { direction: "in", fundId: FUND_CASH, categoryId: catId.THU_KHAC, amount: 50000, note: "Bán thùng carton" }, 201);
    const big = await must("accountant", "POST", `${V}/vouchers`, { direction: "out", fundId: FUND_BANK, categoryId: catId.MAT_BANG, amount: 6_000_000, counterparty: "Chủ nhà", note: "Tiền thuê tháng" }, 201);
    await checkAll(); // phiếu chờ duyệt chưa đổi quỹ
    const bigId = big.id ?? big.voucher?.id;
    await must("owner", "POST", `${V}/vouchers/${bigId}/approve`, {});
    await checkAll();
    const wrong = await must("accountant", "POST", `${V}/vouchers`, { direction: "out", fundId: FUND_CASH, categoryId: catId.VAN_CHUYEN, amount: 40000, note: "Ghi nhầm" }, 201);
    await must("accountant", "POST", `${V}/vouchers/${wrong.id ?? wrong.voucher?.id}/reverse`, { reason: "Ghi nhầm khoản mục" });
    await must("accountant", "POST", `${V}/fund-transfers`, { fromFundId: FUND_CASH, toFundId: FUND_BANK, amount: 200000, note: "Nộp tiền mặt" }, 201);
    await checkAll();
    // đối soát COD: đơn web COD (170k, phí 5k) + đơn giao từ quầy (COD 120k)
    const st = await must("accountant", "POST", `${V}/settlements`, {
      source: "cod", externalRef: "COD-DOISOAT-01", fundId: FUND_BANK,
      lines: [
        { orderId: posOrders.webCod.id, expectedAmount: 170000, receivedAmount: 165000, feeAmount: 5000 },
        { orderId: posOrders.delivA.id, expectedAmount: 120000, receivedAmount: 120000 },
      ],
    }, 201);
    await must("accountant", "POST", `${V}/settlements/${st.id}/confirm`);
    const cod = ((await must("owner", "GET", `${V}/funds`)).items as any[]).find((f) => f.id === FUND_COD);
    expect(cod.balance, "quỹ chờ COD phải về 0 sau đối soát hết").toBe(0);
    // voucher trên đơn bị huỷ → trả lượt
    const vo = await sale("cashier", { customerId: C_POINTS, voucherCode: "INV20K", lines: [kg(P_TAO, 1)], payments: [{ method: "cash", amount: 80000 }] });
    await must("manager", "POST", `${V}/orders/${vo.id}/void`, { reason: "nhầm khách hàng" });
    await checkAll({ shifts: [cashierShift, managerShift] });
  });

  it("10. chốt ca (một ca lệch có lý do), huỷ/trả đơn của ca đã chốt từ két ca khác, chốt ca còn lại + bất biến cuối ngày", async () => {
    const lastCash = await sale("cashier", { lines: [kg(P_TAO, 1)], payments: [{ method: "cash", amount: 100000 }] });
    const lastCash2 = await sale("cashier", { lines: [kg(P_TAO, 2)], payments: [{ method: "cash", amount: 200000 }] });
    const dlv = await must("cashier", "POST", `${V}/pos/delivery-orders`, { clientUuid: uid(), receiver: { name: "Anh Minh", phone: "0901234568", address: "3 Lý Tự Trọng, Quận 1" }, lines: [kg(P_TAO, 1)], shippingFee: 0, deliverer: { userId: 3 }, prepay: [{ method: "cash", amount: 100000 }], cod: 0 }, 201);
    const e1 = (await must("cashier", "GET", `${V}/shifts/${cashierShift}/summary`)).cashFormula.expected;
    await must("cashier", "POST", `${V}/shifts/${cashierShift}/close`, { countedCash: e1 - 10000, diffReason: "Thiếu tiền lẻ" });
    await checkAll({ shifts: [cashierShift, managerShift] });
    const closed = await one<any>(`SELECT expected_cash FROM shifts WHERE id=?`, cashierShift);
    // quản lý huỷ một đơn của ca đã chốt: hoàn tiền mặt từ két ca quản lý; ca đã chốt giữ nguyên số
    await must("manager", "POST", `${V}/orders/${lastCash.id}/void`, { reason: "khách quay lại trả hàng nguyên đơn" });
    // quản lý trả 1 kg của đơn khác thuộc ca đã chốt
    const l2 = await linesOf(lastCash2.id);
    await withApproval("manager", `${V}/orders/${lastCash2.id}/return`, { lines: [{ orderLineId: l2[0].id, qty: 1, unit: "kg", restock: true, reason: "khách trả bớt" }], refundMethod: "cash" });
    // đơn giao từ quầy của ca đã chốt giao thất bại → quản lý hoàn tiền mặt từ két ca của mình (B-N3)
    await must("online_staff", "POST", `${V}/online-orders/${dlv.id}/fail`, { reason: "Khách huỷ" });
    const dl = await linesOf(dlv.id);
    await must("online_staff", "POST", `${V}/online-orders/${dlv.id}/return-to-stock`, { lines: [{ orderLineId: dl[0].id, qty: 1, restock: true, reason: "Hàng còn nguyên" }] });
    const ownerShift = (await must("owner", "POST", `${V}/shifts/open`, { openingCash: 300000 })).shift.id;
    await must("owner", "POST", `${V}/online-orders/${dlv.id}/refund`);
    expect((await one<any>(`SELECT refund_shift_id r FROM payments WHERE order_id=? AND amount<0`, dlv.id)).r).toBe(ownerShift);
    await checkAll({ shifts: [cashierShift, managerShift, ownerShift] });
    const e3 = (await must("owner", "GET", `${V}/shifts/${ownerShift}/summary`)).cashFormula.expected;
    expect(e3).toBe(300000 - 100000);
    await must("owner", "POST", `${V}/shifts/${ownerShift}/close`, { countedCash: e3 });
    await invShift(ownerShift);
    expect((await one<any>(`SELECT expected_cash FROM shifts WHERE id=?`, cashierShift)).expected_cash).toBe(closed.expected_cash);
    closedShiftSnapshot = { expected: closed.expected_cash, voidedOrder: lastCash.id };
    await checkAll({ shifts: [cashierShift, managerShift] });
    const e2 = (await must("manager", "GET", `${V}/shifts/${managerShift}/summary`)).cashFormula.expected;
    await must("manager", "POST", `${V}/shifts/${managerShift}/close`, { countedCash: e2 });
    await checkAll({ shifts: [cashierShift, managerShift] });
    // tổng kết: doanh thu ngày > 0, có đủ các kênh
    const ch = await must("owner", "GET", `${V}/reports/pnl-by-channel?${DAY}`);
    const rev = Object.fromEntries(ch.channels.map((x: any) => [x.channel, x.revenue]));
    expect(rev.pos).toBeGreaterThan(0);
    expect(rev.online).toBeGreaterThan(0);
    expect(rev.social).toBeGreaterThan(0);
    expect(rev.b2b).toBe(11 * 50000 - 2 * 50000); // giao 11 kg, khách trả 2 kg
  });
  /**
   * R2-INV-01 (Trung bình): ca đã chốt bị "tính lại hồi tố". Sau khi quản lý huỷ một đơn tiền mặt của ca đã chốt (A-06: tiền hoàn
   * lấy từ két ca đang mở), GET /shifts/:id/summary của ca ĐÃ CHỐT tính lại cashFormula/sales từ dữ liệu hiện tại
   * (services/shift-report.ts cashFormula: chỉ đơn o.status='completed'; salesSummary theo shift_id) → bảng công thức
   * (đầu ca + bán tiền mặt − hoàn …) không còn cộng ra expectedCash đã lưu, phiếu bàn giao in lại lệch với số đã chốt/đếm.
   * Bỏ it.fails khi đã sửa.
   */
  it.fails("10b. [R2-INV-01] phiếu bàn giao của ca đã chốt giữ nguyên công thức tiền mặt sau khi huỷ đơn ở ca khác", async () => {
    expect(closedShiftSnapshot).toBeTruthy();
    const sum = await must("owner", "GET", `${V}/shifts/${cashierShift}/summary`);
    expect(sum.shift.expectedCash).toBe(closedShiftSnapshot!.expected);
    expect(sum.cashFormula.expected, "ca đã chốt: công thức tiền mặt tính lại ≠ số đã chốt").toBe(closedShiftSnapshot!.expected);
  });
});
