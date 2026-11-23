import { beforeAll, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { planReservations, reserveStmts, consumeForDeliveryStmts, releaseOrderStmts, swapBadReservations } from "../src/worker/services/reservations";
import { customerDebtStatus, checkCredit } from "../src/worker/services/debt";

const db = () => testEnv.DB;
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

beforeAll(async () => {
  await seedBase();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (500,'CAM','Cam','kg')`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES
      (501,'R1',500,1,?1,?2,20000,3000,3000),(502,'R2',500,1,?1,?3,22000,5000,5000)`).bind(future(0), future(2), future(6)),
    d.prepare(`INSERT INTO customers(id, code, type, name, credit_limit, payment_terms_days) VALUES (900,'KH900','b2b','Nhà hàng A',1000000,15)`),
    d.prepare(`INSERT INTO orders(id, code, channel, store_id, customer_id, status) VALUES (700,'DS-1','b2b',1,900,'confirmed')`),
    d.prepare(`INSERT INTO order_lines(id, order_id, product_id, unit, qty_milli, unit_price, line_total) VALUES
      (7001,700,500,'kg',2000,30000,60000),(7002,700,500,'kg',2500,30000,75000)`),
  ]);
});

describe("reservations", () => {
  it("two lines of the same product do not double-reserve and follow FEFO", async () => {
    const plans = await planReservations(db(), [
      { orderLineId: 7001, productId: 500, qtyMilli: 2000 },
      { orderLineId: 7002, productId: 500, qtyMilli: 2500 },
    ], 1);
    expect(plans[0].alloc).toEqual([{ lotId: 501, unitCost: 20000, qtyMilli: 2000 }]);
    expect(plans[1].alloc).toEqual([
      { lotId: 501, unitCost: 20000, qtyMilli: 1000 },
      { lotId: 502, unitCost: 22000, qtyMilli: 1500 },
    ]);
    await db().batch(reserveStmts(db(), 700, plans));
    const l = await db().prepare(`SELECT id, qty_reserved_milli r FROM lots WHERE product_id=500 ORDER BY id`).all<{ id: number; r: number }>();
    expect(l.results.map((x) => x.r)).toEqual([3000, 1500]);
    // tồn khả dụng còn 3500 → giữ thêm 4000 phải lỗi
    await expect(planReservations(db(), [{ orderLineId: 7001, productId: 500, qtyMilli: 4000 }], 1)).rejects.toMatchObject({ code: "insufficient_stock" });
  });

  it("delivery consumes reserved lots and releases the rest (partial delivery EC-26)", async () => {
    const res = await consumeForDeliveryStmts(db(), 700, new Map([[7001, 2000], [7002, 1000]]), "delivery", 1, 1);
    await db().batch(res.stmts);
    const l = await db().prepare(`SELECT qty_on_hand_milli h, qty_reserved_milli r FROM lots WHERE product_id=500 ORDER BY id`).all<{ h: number; r: number }>();
    // lô 501: giao 2000 (dòng 1) + 1000 (dòng 2) = 3000; lô 502: chỉ nhả giữ
    expect(l.results).toEqual([{ h: 0, r: 0 }, { h: 5000, r: 0 }]);
    expect(res.shortByLine.size).toBe(0);
    const active = await db().prepare(`SELECT COUNT(*) n FROM reservations WHERE order_id=700 AND status='active'`).first<{ n: number }>();
    expect(active!.n).toBe(0);
    expect(await releaseOrderStmts(db(), 700)).toEqual([]);
  });

  it("swaps reservations away from an expired lot (EC-15)", async () => {
    const d = db();
    await d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (503,'R3',500,1,?,?,21000,1000,1000)`)
      .bind(future(0), future(1)).run();
    await d.batch(reserveStmts(d, 700, [{ orderLineId: 7001, productId: 500, alloc: [{ lotId: 503, unitCost: 21000, qtyMilli: 1000 }] }]));
    await d.prepare(`UPDATE lots SET status='quarantine' WHERE id=503`).run();
    const r = await swapBadReservations(d, 1);
    expect(r.swapped).toContain(700);
    const lots = await d.prepare(`SELECT id, qty_reserved_milli r FROM lots WHERE id IN (502,503) ORDER BY id`).all<{ id: number; r: number }>();
    expect(lots.results).toEqual([{ id: 502, r: 1000 }, { id: 503, r: 0 }]);
  });
});

describe("debt status", () => {
  it("computes balance, overdue and credit check with adjustments and unapplied payments", async () => {
    const d = db();
    await d.batch([
      d.prepare(`INSERT INTO invoices(id, code, customer_id, issue_date, due_date, subtotal, total) VALUES
        (1,'I1',900,'2026-01-01','2026-01-15',500000,500000),(2,'I2',900,'2099-01-01','2099-01-15',300000,300000)`),
      d.prepare(`INSERT INTO invoices(id, code, kind, original_invoice_id, customer_id, issue_date, due_date, subtotal, total) VALUES
        (3,'I3','adjustment',1,900,'2026-01-02','2026-01-15',-100000,-100000)`),
      d.prepare(`INSERT INTO debt_payments(id, code, direction, partner_type, partner_id, fund_id, amount, method, paid_at, created_by) VALUES
        (1,'P1','in','customer',900,2,450000,'transfer','2026-01-10',1)`),
      d.prepare(`INSERT INTO debt_allocations(payment_id, invoice_id, amount) VALUES (1,1,350000)`),
    ]);
    const s = await customerDebtStatus(d, 900, "2026-06-01");
    // I1: 500k −100k −350k = 50k (quá hạn); I2: 300k; payment dư 100k chưa gạch
    expect(s).toMatchObject({ outstanding: 350000, unapplied: 100000, balance: 250000, overdueAmount: 50000, overdueCount: 1, available: 750000 });
    const chk = await checkCredit(d, 900, 100000);
    expect(chk.ok).toBe(false);
    expect(chk.reasons).toContain("overdue");
  });
});
