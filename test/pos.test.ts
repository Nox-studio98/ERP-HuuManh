import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { lotQty, seedSales } from "./seed-sales";

beforeAll(async () => {
  await seedBase();
  await seedSales();
});

const line = (productId: number, qty: number, extra: object = {}) => ({ productId, unit: "kg", qty, ...extra });
let orderA: any;
let orderB: any;
let shiftId: number;

describe("POS checkout", () => {
  it("requires an open shift", async () => {
    const r = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-noshift-1", lines: [line(1, 1)], payments: [{ method: "cash", amount: 100000 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("no_open_shift");
  });

  it("opens a shift (once)", async () => {
    const r = await api("cashier", "POST", "/api/v1/shifts/open", { openingCash: 50000 });
    expect(r.status).toBe(201);
    shiftId = r.body.shift.id;
    expect((await api("cashier", "POST", "/api/v1/shifts/open", { openingCash: 1 })).status).toBe(409);
    expect((await api("cashier", "GET", "/api/v1/shifts/current")).body.shift.id).toBe(shiftId);
  });

  it("checks out with split payment cash+qr and returns change", async () => {
    const r = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-A-0001", lines: [line(1, 2)],
      payments: [{ method: "qr", amount: 50000, ref: "FT123" }, { method: "cash", amount: 200000 }],
    });
    expect(r.status).toBe(201);
    orderA = r.body;
    expect(r.body.total).toBe(200000);
    expect(r.body.change).toBe(50000);
    expect(r.body.status).toBe("completed");
    expect(r.body.code).toMatch(/^HD-\d{8}-0001$/);
    const cash = r.body.payments.find((p: any) => p.method === "cash");
    expect(cash.amount).toBe(150000);
    expect(r.body.payments.find((p: any) => p.method === "qr").fund_id).toBe(2);
    expect(r.body.lines[0].lots[0].lot_code).toBe("LOT-TAO-1");
    expect(await lotQty(1)).toBe(18000);
    // cashier không thấy giá vốn
    expect(r.body.lines[0].cost_amount).toBeUndefined();
  });

  it("is idempotent on clientUuid", async () => {
    const r = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-A-0001", lines: [line(1, 2)], payments: [{ method: "cash", amount: 200000 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(orderA.id);
    expect(await lotQty(1)).toBe(18000);
  });

  it("rejects insufficient stock and leaves no stock change", async () => {
    const r = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-big-0001", lines: [line(1, 500)], payments: [{ method: "cash", amount: 50000000 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("insufficient_stock");
    expect(await lotQty(1)).toBe(18000);
  });

  it("converts units (thung = 10 kg) and validates payments", async () => {
    const short = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-unit-0001", lines: [{ productId: 1, unit: "thung", qty: 0.1 }], payments: [{ method: "cash", amount: 99999 }],
    });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe("payment_mismatch");
    const ok = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-unit-0001", lines: [{ productId: 1, unit: "thung", qty: 0.1 }], payments: [{ method: "cash", amount: 100000 }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.lines[0].qty_milli).toBe(1000);
    // hoàn lại bằng void để giữ số liệu các test sau
    expect((await api("manager", "POST", `/api/v1/orders/${ok.body.id}/void`, { reason: "nhập thử" })).status).toBe(200);
    expect(await lotQty(1)).toBe(18000);
  });

  it("requires approval for below-cost sale by cashier, then succeeds with approvalId", async () => {
    const payload = { clientUuid: "uuid-B-0001", lines: [line(2, 1, { unitPriceOverride: 100000 })], payments: [{ method: "cash", amount: 100000 }] };
    const r = await api("cashier", "POST", "/api/v1/pos/orders", payload);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("approval_required");
    const approvalId = r.body.error.details.approvalId;
    expect(approvalId).toBeGreaterThan(0);
    expect(await lotQty(2)).toBe(5000);
    // chưa duyệt → vẫn chặn, không tạo thêm approval
    const again = await api("cashier", "POST", "/api/v1/pos/orders", { ...payload, approvalId });
    expect(again.status).toBe(409);
    expect((await api("cashier", "POST", `/api/v1/approvals/${approvalId}/decide`, { decision: "approved" })).status).toBe(403);
    const d = await api("manager", "POST", `/api/v1/approvals/${approvalId}/decide`, { decision: "approved", note: "ok" });
    expect(d.status).toBe(200);
    const ok = await api("cashier", "POST", "/api/v1/pos/orders", { ...payload, approvalId });
    expect(ok.status).toBe(201);
    orderB = ok.body;
    expect(await lotQty(2)).toBe(4000);
    // approval không dùng lại được cho đơn khác
    const reuse = await api("cashier", "POST", "/api/v1/pos/orders", { ...payload, clientUuid: "uuid-B-0002", approvalId });
    expect(reuse.status).toBe(409);
  });

  it("requires approval for discount over threshold", async () => {
    const r = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-D-0001", lines: [line(1, 1)], discount: 30000, payments: [{ method: "cash", amount: 70000 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("approval_required");
    const ok = await api("cashier", "POST", "/api/v1/pos/orders", {
      clientUuid: "uuid-D-0002", lines: [line(1, 1)], discount: 5000, payments: [{ method: "cash", amount: 95000 }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.total).toBe(95000);
    // trả đơn này để số liệu ca không đổi: dùng void
    await api("manager", "POST", `/api/v1/orders/${ok.body.id}/void`, { reason: "kiểm thử giảm giá" });
  });

  it("masks customer phone for roles without PII permission", async () => {
    await testEnv.DB.prepare(`INSERT INTO customers(id, code, name, phone) VALUES (1,'KH1','Chị Lan','0912345678')`).run();
    const r = await api("cashier", "GET", `/api/v1/orders/${orderA.id}`);
    expect(r.status).toBe(200);
    await testEnv.DB.prepare(`UPDATE orders SET customer_id=1 WHERE id=?`).bind(orderA.id).run();
    const masked = await api("cashier", "GET", `/api/v1/orders/${orderA.id}`);
    expect(masked.body.customer.phone).toBe("091****678");
    const full = await api("manager", "GET", `/api/v1/orders/${orderA.id}`);
    expect(full.body.customer.phone).toBe("0912345678");
  });

  it("lists orders and builds receipt", async () => {
    const l = await api("cashier", "GET", "/api/v1/orders?status=completed&limit=1");
    expect(l.body.items).toHaveLength(1);
    expect(l.body.nextCursor).toBeTruthy();
    const rc = await api("cashier", "GET", `/api/v1/pos/receipt/${orderA.id}`);
    expect(rc.body.total).toBe(200000);
    expect(rc.body.lines[0].name).toBe("Táo Envy");
  });
});

describe("returns, void, shift close", () => {
  it("returns to the original lot (restock) and refunds cash", async () => {
    const lineId = orderA.lines[0].id;
    const r = await api("cashier", "POST", `/api/v1/orders/${orderA.id}/return`, {
      lines: [{ orderLineId: lineId, qty: 1, unit: "kg", restock: true, reason: "Khách đổi ý" }], refundMethod: "cash",
    });
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe("return");
    expect(r.body.total).toBe(100000);
    expect(r.body.code).toMatch(/^TH-/);
    expect(r.body.payments[0].amount).toBe(-100000);
    expect(await lotQty(1)).toBe(19000);
    const mv = await testEnv.DB.prepare(`SELECT lot_id, qty_delta_milli FROM stock_moves WHERE move_type='return' AND ref_id=?`).bind(r.body.id).first<any>();
    expect(mv).toMatchObject({ lot_id: 1, qty_delta_milli: 1000 });
  });

  it("returns without restock (discard) and blocks over-return", async () => {
    const lineId = orderA.lines[0].id;
    const r = await api("cashier", "POST", `/api/v1/orders/${orderA.id}/return`, {
      lines: [{ orderLineId: lineId, qty: 0.5, unit: "kg", restock: false, reason: "Dập nát" }], refundMethod: "cash",
    });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(50000);
    expect(await lotQty(1)).toBe(19000);
    const over = await api("cashier", "POST", `/api/v1/orders/${orderA.id}/return`, {
      lines: [{ orderLineId: lineId, qty: 1, unit: "kg", restock: true, reason: "thừa" }], refundMethod: "cash",
    });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("return_exceeds_sold");
  });

  it("closes the shift: diff requires reason; expected cash is correct", async () => {
    // 50000 + (150000 + 100000 - 100000 - 50000) = 150000
    const r1 = await api("cashier", "POST", `/api/v1/shifts/${shiftId}/close`, { countedCash: 140000 });
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe("diff_reason_required");
    expect(r1.body.error.details.expectedCash).toBe(150000);
    const r2 = await api("cashier", "POST", `/api/v1/shifts/${shiftId}/close`, { countedCash: 140000, diffReason: "Thối nhầm 10k" });
    expect(r2.status).toBe(200);
    expect(r2.body.shift).toMatchObject({ status: "closed", expected_cash: 150000, counted_cash: 140000, diff_cash: -10000 });
    expect(r2.body.report.saleTotal).toBe(300000);
    expect(r2.body.report.returnTotal).toBe(150000);
    expect(r2.body.report.topProducts.length).toBeGreaterThan(0);
    expect((await api("cashier", "GET", "/api/v1/shifts/current")).body.shift).toBeNull();
  });

  it("void: cashier forbidden; manager can void after shift closed and lots are restored", async () => {
    const f = await api("cashier", "POST", `/api/v1/orders/${orderB.id}/void`, { reason: "nhầm" });
    expect(f.status).toBe(403);
    expect(await lotQty(2)).toBe(4000);
    const ok = await api("manager", "POST", `/api/v1/orders/${orderB.id}/void`, { reason: "Khách huỷ đơn" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("cancelled");
    expect(await lotQty(2)).toBe(5000);
    const again = await api("manager", "POST", `/api/v1/orders/${orderB.id}/void`, { reason: "lần hai" });
    expect(again.status).toBe(409);
    const a = await testEnv.DB.prepare(`SELECT before_json, after_json FROM audit_log WHERE action='order.void' AND entity_id=?`).bind(String(orderB.id)).first<any>();
    expect(a.before_json).toContain("completed");
    // đơn đã có phiếu trả không huỷ được
    expect((await api("manager", "POST", `/api/v1/orders/${orderA.id}/void`, { reason: "thử huỷ" })).status).toBe(409);
  });
});
