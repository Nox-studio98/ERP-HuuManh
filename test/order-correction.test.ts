import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales, lotQty } from "./seed-sales";
import { cashFormula } from "../src/worker/services/shift-report";
import { salesSummary } from "../src/worker/services/salesreport";
import { loadCommissionLines } from "../src/worker/services/commission";
import { vnPeriod } from "../src/worker/lib/time";

// G9 Việc 2 — Sửa chi tiết hoá đơn POS đã lập: phiếu trả toàn bộ + đơn mới trong MỘT batch, khoản đã thu chuyển sang đơn mới
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uuid = () => `oc-${++seq}-${crypto.randomUUID()}`;
const sell = async (role: string, lines: { productId: number; qty: number }[], extra: Record<string, unknown> = {}) => {
  const total = lines.reduce((s, l) => s + l.qty * (l.productId === 1 ? 100000 : 200000), 0);
  const r = await api(role, "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: lines.map((l) => ({ ...l, unit: "kg" })), payments: [{ method: "cash", amount: total }], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const fix = (role: string, o: any, over: Record<string, unknown> = {}) =>
  api(role, "POST", `${V}/orders/${o.id}/correct`, { clientUuid: uuid(), reason: "nhập nhầm số lượng", lines: [{ productId: 1, unit: "kg", qty: 1 }], refundMethod: "cash", ...over });
const shiftRow = async (id: number) => (await db().prepare(`SELECT * FROM shifts WHERE id = ?`).bind(id).first<any>())!;
const expected = async (id: number) => (await cashFormula(db(), await shiftRow(id))).expected;

let cs: any, ms: any;
beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().prepare(`UPDATE lots SET qty_in_milli=500000, qty_on_hand_milli=500000`).run();
  cs = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift;
  ms = (await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift;
});

describe("Sửa hoá đơn đã lập", () => {
  it("quyền: thu ngân (không orders.edit) bị chặn; đơn không tồn tại → 404", async () => {
    const o = await sell("cashier", [{ productId: 1, qty: 2 }]);
    expect((await fix("cashier", o)).status).toBe(403);
    expect((await fix("manager", { id: 999999 })).status).toBe(404);
  });

  it("đơn mới đắt hơn: trả toàn bộ đơn cũ, bán đơn mới, khách trả thêm phần chênh vào két ca đang mở", async () => {
    const o = await sell("cashier", [{ productId: 1, qty: 2 }]); // 200k, ca của thu ngân
    const t0 = await lotQty(1), n0 = await lotQty(2);
    const e0 = await expected(ms.id), ec0 = await expected(cs.id);
    const r = await fix("manager", o, { lines: [{ productId: 1, unit: "kg", qty: 2, originalLineId: o.lines[0].id }, { productId: 2, unit: "kg", qty: 1 }], payments: [{ method: "cash", amount: 200000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ oldTotal: 200000, newTotal: 400000, refundAmount: 0, extraDue: 200000 });
    expect(r.body.sale).toMatchObject({ kind: "sale", status: "completed", total: 400000, paid_total: 400000, corrected_from_order_id: o.id, shift_id: ms.id });
    expect(r.body.sale.correction).toMatchObject({ role: "replacement", linkedId: o.id });
    expect(r.body.return).toMatchObject({ kind: "return", status: "completed", total: 200000, original_order_id: o.id });
    expect(r.body.sale.seller_id ?? null).not.toBeNull();
    expect(await lotQty(1)).toBe(t0); // trả 2kg rồi bán lại 2kg đúng lô
    expect(await lotQty(2)).toBe(n0 - 1000);
    expect(await expected(ms.id)).toBe(e0 + 200000); // chỉ phần chênh vào két hiện tại
    expect(await expected(cs.id)).toBe(ec0); // ca cũ không đổi
    const sum = await salesSummary(db(), `o.id IN (?,?,?)`, [o.id, r.body.sale.id, r.body.return.id]);
    expect(sum.revenue).toBe(400000); // 200k + 400k − 200k
    const det = await api("manager", "GET", `${V}/orders/${o.id}`);
    expect(det.body.correction).toMatchObject({ role: "replaced", linkedId: r.body.sale.id });
    // bấm 2 lần: cùng clientUuid → trả lại kết quả cũ, không làm lần hai
    const cu = r.body.sale.client_uuid;
    const dup = await api("manager", "POST", `${V}/orders/${o.id}/correct`, { clientUuid: cu, reason: "nhập nhầm số lượng", lines: [{ productId: 1, unit: "kg", qty: 1 }] });
    expect(dup.status).toBe(200);
    expect(dup.body.sale.id).toBe(r.body.sale.id);
    // clientUuid khác: đơn đã được sửa → chặn
    const again = await fix("manager", o);
    expect(again.status).toBe(409);
    expect(await lotQty(2)).toBe(n0 - 1000);
    expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE corrected_from_order_id = ?`).bind(o.id).first<any>()).n).toBe(1);
    // đơn mới có thể sửa tiếp (chuỗi sửa)
    const chain = await fix("manager", r.body.sale, { lines: [{ productId: 2, unit: "kg", qty: 1 }], payments: [] });
    expect(chain.status, JSON.stringify(chain.body)).toBe(201);
    expect(chain.body.refundAmount).toBe(200000);
  });

  it("đơn mới rẻ hơn: khoản đã thu chuyển sang đơn mới, hoàn phần chênh từ két ca đang mở; nhập lại đúng lô", async () => {
    const o = await sell("manager", [{ productId: 1, qty: 3 }]); // 300k trong ca quản lý
    const t0 = await lotQty(1);
    const e0 = await expected(ms.id);
    const r = await fix("manager", o, { lines: [{ productId: 1, unit: "kg", qty: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ oldTotal: 300000, newTotal: 100000, refundAmount: 200000, extraDue: 0 });
    expect(await lotQty(1)).toBe(t0 + 2000);
    expect(await expected(ms.id)).toBe(e0 - 200000); // hoàn 200k, phần 100k chuyển sang đơn mới không ra tiền
    const pays = (await db().prepare(`SELECT order_id, method, amount FROM payments WHERE order_id IN (?,?) ORDER BY id`).bind(r.body.sale.id, r.body.return.id).all<any>()).results;
    expect(pays.filter((p) => p.order_id === r.body.sale.id).reduce((s, p) => s + p.amount, 0)).toBe(100000);
    expect(pays.filter((p) => p.order_id === r.body.return.id).reduce((s, p) => s + p.amount, 0)).toBe(-300000);
    const back = await db().prepare(`SELECT lot_id, qty_milli FROM order_line_lots WHERE order_line_id = ?`).bind(r.body.return.lines[0].id).all<any>();
    expect(back.results).toEqual([{ lot_id: 1, qty_milli: 3000 }]);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action IN ('order.correct','order.return') AND entity_id IN (?,?)`).bind(String(r.body.sale.id), String(r.body.return.id)).first<any>()).n).toBe(2);
    // hoàn bằng chuyển khoản: két không đổi
    const o2 = await sell("manager", [{ productId: 1, qty: 2 }]);
    const e1 = await expected(ms.id);
    const r2 = await fix("manager", o2, { lines: [{ productId: 1, unit: "kg", qty: 1 }], refundMethod: "transfer" });
    expect(r2.status).toBe(201);
    expect(await expected(ms.id)).toBe(e1);
  });

  it("giá: dòng giữ nguyên giữ giá cũ; dòng mới theo giá hiện hành; không được cao hơn; dòng mới không có giá vốn lộ ra thu ngân", async () => {
    const o = await sell("manager", [{ productId: 1, qty: 1 }]);
    const o2 = await sell("manager", [{ productId: 1, qty: 1 }]);
    await db().prepare(`UPDATE prices SET unit_price = 120000 WHERE product_id = 1`).run();
    try {
      const keep = await fix("manager", o, { lines: [{ productId: 1, unit: "kg", qty: 2, originalLineId: o.lines[0].id }, { productId: 1, unit: "kg", qty: 1 }], payments: [{ method: "cash", amount: 320000 }] });
      expect(keep.status, JSON.stringify(keep.body)).toBe(201);
      const prices = keep.body.sale.lines.map((l: any) => l.unit_price);
      expect(prices).toEqual([100000, 120000]); // giữ giá cũ / giá hiện hành
      expect(keep.body.sale.total).toBe(320000);
      const hi = await fix("manager", o2, { lines: [{ productId: 1, unit: "kg", qty: 1, unitPrice: 120001 }] });
      expect(hi.status).toBe(422);
      expect(hi.body.error.code).toBe("price_above_current");
      const mismatch = await fix("manager", o2, { lines: [{ productId: 2, unit: "kg", qty: 1, originalLineId: o2.lines[0].id }] });
      expect(mismatch.body.error.code).toBe("line_mismatch");
      const lower = await fix("manager", o2, { lines: [{ productId: 1, unit: "kg", qty: 1, unitPrice: 90000 }], refundMethod: "cash" });
      expect(lower.status).toBe(201);
      expect(lower.body.sale.total).toBe(90000);
      expect(lower.body.refundAmount).toBe(10000);
      expect(lower.body.sale.lines[0].discount).toBe(0);
    } finally {
      await db().prepare(`UPDATE prices SET unit_price = 100000 WHERE product_id = 1`).run();
    }
  });

  it("tồn không đủ → 409 và không đổi gì; thanh toán thiếu → 422", async () => {
    const o = await sell("manager", [{ productId: 2, qty: 1 }]);
    const n0 = await lotQty(2);
    const cnt = async () => (await db().prepare(`SELECT COUNT(*) n FROM orders WHERE status = 'completed'`).first<any>()).n as number;
    const c0 = await cnt();
    const big = await fix("manager", o, { lines: [{ productId: 2, unit: "kg", qty: 600 }], payments: [{ method: "cash", amount: 600 * 200000 }] });
    expect(big.status).toBe(409);
    expect(big.body.error.code).toBe("insufficient_stock");
    expect(await lotQty(2)).toBe(n0);
    expect(await cnt()).toBe(c0);
    const short = await fix("manager", o, { lines: [{ productId: 2, unit: "kg", qty: 2 }], payments: [{ method: "cash", amount: 1000 }] });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe("payment_mismatch");
    const extra = await fix("manager", o, { lines: [{ productId: 2, unit: "kg", qty: 1 }], payments: [{ method: "cash", amount: 1000 }] });
    expect(extra.body.error.code).toBe("payment_not_needed");
  });

  it("chặn: đơn có khuyến mãi/điểm, đã có phiếu trả, đơn ghi nợ; thu khác được mang sang đơn mới", async () => {
    const o = await sell("manager", [{ productId: 1, qty: 1 }]);
    await db().prepare(`INSERT INTO order_discounts(order_id, amount, description) VALUES (?, 1000, 'test')`).bind(o.id).run();
    expect((await fix("manager", o)).body.error.code).toBe("promo_order_no_correct");

    const r = await sell("manager", [{ productId: 1, qty: 2 }]);
    const ret = await api("manager", "POST", `${V}/orders/${r.id}/return`, { lines: [{ orderLineId: r.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "trả bớt" }], refundMethod: "cash" });
    expect(ret.status).toBe(201);
    expect((await fix("manager", r)).body.error.code).toBe("not_correctable");

    const withCharge = await api("manager", "POST", `${V}/pos/orders`, {
      clientUuid: uuid(), lines: [{ productId: 1, unit: "kg", qty: 1 }], charges: [{ name: "Phí đóng gói", amount: 5000 }], payments: [{ method: "cash", amount: 105000 }],
    });
    expect(withCharge.status, JSON.stringify(withCharge.body)).toBe(201);
    const fx = await fix("manager", withCharge.body, { lines: [{ productId: 1, unit: "kg", qty: 2 }], payments: [{ method: "cash", amount: 100000 }] });
    expect(fx.status, JSON.stringify(fx.body)).toBe(201);
    expect(fx.body.sale.total).toBe(205000); // 200k hàng + 5k thu khác mang sang
    expect(fx.body.sale.charges.map((x: any) => x.amount)).toEqual([5000]);
    expect(fx.body.return.total).toBe(105000);
    expect(fx.body.sale.charges_total).toBe(5000);
    expect(fx.body.return.charges_total).toBe(5000);
  });

  it("đơn ghi nợ không sửa được; hoa hồng: hoàn trừ người bán gốc, đơn mới ghi cho người bán gốc", async () => {
    const o = await sell("cashier", [{ productId: 1, qty: 1 }]);
    const r = await fix("manager", o, { lines: [{ productId: 1, unit: "kg", qty: 2 }], payments: [{ method: "cash", amount: 100000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sale.seller_id).toBe(3); // thu ngân (người bán gốc) giữ doanh số
    const lines = (await loadCommissionLines(db(), vnPeriod())).filter((l) => l.uid === 3 && l.productId === 1);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBeGreaterThanOrEqual(100000); // +100k (đơn gốc) −100k (trả) +200k (đơn mới) cùng người
    // đơn ghi nợ → chặn
    const c = await sell("manager", [{ productId: 1, qty: 1 }]);
    await db().prepare(`INSERT INTO customers(id, code, name, phone, type, customer_group_id) VALUES (902,'KH902','Khách nợ','0900000902','retail',1)`).run();
    await db().prepare(`INSERT INTO invoices(code, kind, customer_id, order_id, issue_date, due_date, subtotal, vat_rate_bp, vat_amount, total, einvoice_status) VALUES ('HDB-T902','sale',902,?, '2026-01-01','2099-01-01',1000,0,0,1000,'not_required')`).bind(c.id).run();
    const blocked = await fix("manager", c);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("credit_order_no_correct");
  });

  it("kỳ đã khoá → 423 và không đổi gì", async () => {
    const o = await sell("manager", [{ productId: 1, qty: 1 }]);
    const q0 = await lotQty(1);
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    try {
      const x = await fix("manager", o);
      expect(x.status).toBe(423);
    } finally {
      await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    }
    expect(await lotQty(1)).toBe(q0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM orders WHERE corrected_from_order_id = ?`).bind(o.id).first<any>()).n).toBe(0);
  });
});
