import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales, lotQty } from "./seed-sales";
import { cashFormula } from "../src/worker/services/shift-report";
import { salesSummary } from "../src/worker/services/salesreport";
import { loadCommissionLines } from "../src/worker/services/commission";
import { vnPeriod } from "../src/worker/lib/time";

// G9 Việc 1 — Trả hàng nhanh không cần hoá đơn gốc: giá hiện hành (chỉ giảm), bắt buộc lý do, thu ngân cần duyệt (một lần, đúng nội dung)
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uuid = () => `qr-${++seq}-${crypto.randomUUID()}`;
const qr = (role: string, over: Record<string, unknown> = {}) =>
  api(role, "POST", `${V}/pos/quick-return`, {
    clientUuid: uuid(), lines: [{ productId: 1, unit: "kg", qty: 1, restock: true }], reason: "khách trả hàng không hoá đơn", refundMethod: "cash", ...over,
  });
const shiftRow = async (id: number) => (await db().prepare(`SELECT * FROM shifts WHERE id = ?`).bind(id).first<any>())!;
const orderCount = async () => (await db().prepare(`SELECT COUNT(*) n FROM orders`).first<any>()).n as number;

let cs: any, ms: any;
beforeAll(async () => {
  await seedBase();
  await seedSales();
  cs = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 1_000_000 })).body.shift;
  ms = (await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 })).body.shift;
});

describe("Trả hàng nhanh", () => {
  it("bắt buộc lý do; không ca → 409; giá không được cao hơn giá hiện hành", async () => {
    expect((await qr("cashier", { reason: "" })).status).toBe(422);
    expect((await qr("cashier", { reason: undefined })).status).toBe(422);
    const hi = await qr("cashier", { lines: [{ productId: 1, unit: "kg", qty: 1, unitPrice: 100001, restock: true }] });
    expect(hi.status).toBe(422);
    expect(hi.body.error.code).toBe("price_above_current");
    expect((await qr("accountant")).status).toBe(403);
    const n0 = await orderCount();
    expect((await qr("warehouse")).status).toBe(403);
    expect(await orderCount()).toBe(n0);
  });

  it("thu ngân: cần duyệt → duyệt → hoàn tất một lần, nhập kho, tiền từ két ca đang mở", async () => {
    const q0 = await lotQty(1);
    const f0 = await cashFormula(db(), await shiftRow(cs.id));
    const cu = uuid();
    const r1 = await qr("cashier", { clientUuid: cu, lines: [{ productId: 1, unit: "kg", qty: 2, restock: true }] });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe("approval_required");
    const aid = r1.body.error.details.approvalId;
    expect(await lotQty(1)).toBe(q0); // chưa duyệt: không đụng kho/tiền
    // gửi lại khi còn chờ vẫn chờ (không tạo thêm phiếu)
    const again = await qr("cashier", { clientUuid: cu, lines: [{ productId: 1, unit: "kg", qty: 2, restock: true }] });
    expect(again.body.error.details.approvalId).toBe(aid);
    // người yêu cầu không tự duyệt; dùng phiếu chưa duyệt → chờ
    expect((await api("cashier", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(403);
    const pend = await qr("cashier", { clientUuid: cu, lines: [{ productId: 1, unit: "kg", qty: 2, restock: true }], approvalId: aid });
    expect(pend.body.error.code).toBe("approval_required");
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    // đổi nội dung (số lượng) sau khi duyệt → phiếu không khớp
    const tamper = await qr("cashier", { clientUuid: uuid(), lines: [{ productId: 1, unit: "kg", qty: 3, restock: true }], approvalId: aid });
    expect(tamper.status).toBe(409);
    expect(tamper.body.error.code).toBe("approval_invalid");
    const ok = await qr("cashier", { clientUuid: cu, lines: [{ productId: 1, unit: "kg", qty: 2, restock: true }], approvalId: aid });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ kind: "return", channel: "pos", status: "completed", original_order_id: null, total: 200000, shift_id: cs.id });
    expect(ok.body.lines[0]).toMatchObject({ unit_price: 100000, line_total: 200000 });
    expect(await lotQty(1)).toBe(q0 + 2000); // nhập lại lô FEFO gần nhất
    const f1 = await cashFormula(db(), await shiftRow(cs.id));
    expect(f1.expected).toBe(f0.expected - 200000); // hoàn từ két ca đang mở
    expect(ok.body.payments[0]).toMatchObject({ method: "cash", amount: -200000, status: "confirmed" });
    const ap = await db().prepare(`SELECT status, ref_type, ref_id FROM approvals WHERE id = ?`).bind(aid).first<any>();
    expect(ap).toMatchObject({ status: "approved", ref_type: "order", ref_id: String(ok.body.id) });
    // bấm 2 lần: cùng clientUuid → trả lại đúng phiếu; phiếu duyệt dùng lại cho clientUuid khác → chặn
    const dup = await qr("cashier", { clientUuid: cu, lines: [{ productId: 1, unit: "kg", qty: 2, restock: true }], approvalId: aid });
    expect(dup.status).toBe(200);
    expect(dup.body.id).toBe(ok.body.id);
    expect(await lotQty(1)).toBe(q0 + 2000);
    const reuse = await qr("cashier", { clientUuid: uuid(), lines: [{ productId: 1, unit: "kg", qty: 2, restock: true }], approvalId: aid });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("approval_invalid");
    expect((await db().prepare(`SELECT COUNT(*) n FROM stock_moves WHERE move_type='return' AND ref_type='order' AND ref_id=?`).bind(ok.body.id).first<any>()).n).toBe(1);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='order.quick_return' AND entity_id=?`).bind(String(ok.body.id)).first<any>()).n).toBe(1);
  });

  it("báo cáo: doanh thu ca trừ phiếu, hoa hồng/thưởng trừ vào người lập, không lộ giá vốn cho thu ngân", async () => {
    const sum = await salesSummary(db(), `o.shift_id = ?`, [cs.id]);
    expect(sum.returnTotal).toBe(200000);
    expect(sum.revenue).toBe(-200000);
    const lines = await loadCommissionLines(db(), vnPeriod());
    const mine = lines.filter((l) => l.uid === 3 && l.productId === 1); // cashier = user 3
    expect(mine.reduce((s, l) => s + l.amount, 0)).toBe(-200000);
    const full = await api("cashier", "GET", `${V}/orders?kind=return`);
    expect(full.status).toBe(200);
    const o = await db().prepare(`SELECT id FROM orders WHERE kind='return' AND original_order_id IS NULL ORDER BY id DESC LIMIT 1`).first<any>();
    const det = await api("cashier", "GET", `${V}/orders/${o.id}`);
    expect(JSON.stringify(det.body)).not.toContain("cost_amount");
    expect(det.body.cost_total).toBeUndefined();
    const adm = await api("manager", "GET", `${V}/orders/${o.id}`);
    expect(adm.body.cost_total).toBeGreaterThan(0);
  });

  it("giảm giá hoàn được (giá thấp hơn hiện hành); hao hụt không nhập kho; hoàn bằng chuyển khoản không vào két", async () => {
    const q0 = await lotQty(1);
    const f0 = await cashFormula(db(), await shiftRow(ms.id));
    const r = await qr("manager", { lines: [{ productId: 1, unit: "kg", qty: 1, unitPrice: 80000, restock: false }], refundMethod: "transfer" });
    expect(r.status, JSON.stringify(r.body)).toBe(201); // quản lý tự lập (vẫn bắt buộc lý do)
    expect(r.body.total).toBe(80000);
    expect(r.body.lines[0]).toMatchObject({ unit_price: 80000, discount: 20000 });
    expect(await lotQty(1)).toBe(q0); // hao hụt: không nhập kho
    expect((await db().prepare(`SELECT COUNT(*) n FROM order_line_lots WHERE order_line_id = ?`).bind(r.body.lines[0].id).first<any>()).n).toBe(0);
    expect((await cashFormula(db(), await shiftRow(ms.id))).expected).toBe(f0.expected); // chuyển khoản: không ra két
    expect(r.body.payments[0]).toMatchObject({ method: "transfer", amount: -80000 });
  });

  it("sản phẩm chưa có lô nhận được → tạo lô mới trong cùng batch; khách được gắn vào phiếu", async () => {
    await db().prepare(`INSERT INTO products(id, sku, name, base_unit, sell_by_weight, group_id) VALUES (9,'CAM','Cam','kg',1,1)`).run();
    await db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,9,50000,'2020-01-01T00:00:00Z','active',1)`).run();
    await db().prepare(`INSERT INTO customers(id, code, name, phone, type, customer_group_id) VALUES (901,'KH901','Khách trả','0900000901','retail',1)`).run();
    const r = await qr("manager", { customerId: 901, lines: [{ productId: 9, unit: "kg", qty: 3, restock: true }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.customer_id).toBe(901);
    const lot = await db().prepare(`SELECT qty_on_hand_milli q, unit_cost c FROM lots WHERE product_id = 9`).first<any>();
    expect(lot).toMatchObject({ q: 3000, c: 0 });
    expect((await db().prepare(`SELECT COUNT(*) n FROM stock_moves WHERE product_id = 9 AND move_type='return'`).first<any>()).n).toBe(1);
  });

  it("kỳ đã khoá → 423; không ca → 409", async () => {
    const n0 = await orderCount();
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    const r = await qr("manager");
    expect(r.status).toBe(423);
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    expect(await orderCount()).toBe(n0);
    await api("manager", "POST", `${V}/shifts/${ms.id}/close`, { countedCash: 1_000_000_000, diffReason: "test" });
    const noShift = await qr("manager");
    expect(noShift.status).toBe(409);
    expect(noShift.body.error.code).toBe("no_open_shift");
  });
});
