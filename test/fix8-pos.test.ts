import { beforeAll, describe, expect, it } from "vitest";
import { api, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { seedShop } from "./shop-helpers";
import { vnPeriod } from "../src/worker/lib/time";

// Hồi quy fix8-pos: PA-6, PA-2, C2-04, C2-07, C2-06, C2-01 + các nghi ngờ (ca mở, chốt ca 2 lần, pay-info)
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const uid = () => `uuid-fix8-${Date.now()}-${++seq}`;
const set = (k: string, v: string) => db().prepare(`INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`).bind(k, v).run();
const line = (qty: number) => ({ productId: 1, unit: "kg", qty }); // 100.000đ/kg
let cseq = 0;
async function retail(limit = 1_000_000) {
  const n = ++cseq;
  return (await db()
    .prepare(`INSERT INTO customers(code, type, name, phone, customer_group_id, credit_limit, payment_terms_days) VALUES (?, 'retail', ?, ?, 1, ?, 0) RETURNING id`)
    .bind(`KL-F8${n}`, `Khách fix8 ${n}`, `09300000${String(n).padStart(2, "0")}`, limit)
    .first<{ id: number }>())!.id;
}
const sell = (role: string, body: any) => api(role, "POST", `${V}/pos/orders`, { clientUuid: uid(), lines: [line(2)], payments: [], ...body });
let cashierShift: number;

beforeAll(async () => {
  await seedShop();
  await seedSales();
  await db().prepare(`UPDATE lots SET qty_in_milli = 900000, qty_on_hand_milli = 900000 WHERE id = 1`).run();
  await set("pos.retail_credit_enabled", "1");
  await db().prepare(`INSERT INTO charge_types(id, code, name, default_amount) VALUES (950, 'PHI_TUY_Y', 'Phí tuỳ ý', 0)`).run();
  cashierShift = (await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 100000 })).body.shift.id;
  await api("manager", "POST", `${V}/shifts/open`, { openingCash: 0 });
});

describe("PA-6: ngưỡng duyệt trả hàng tính cả thu khác được hoàn", () => {
  it("đơn hàng 100.000 + thu khác 600.000, trả toàn bộ hoàn thu khác 700.000 → thu ngân cần duyệt", async () => {
    const o = await api("manager", "POST", `${V}/pos/orders`, {
      clientUuid: uid(), lines: [line(1)], charges: [{ name: "Phí trang trí", amount: 600000 }], payments: [{ method: "card", amount: 700000 }],
    });
    expect(o.status).toBe(201);
    const r = await api("cashier", "POST", `${V}/orders/${o.body.id}/return`, {
      refundMethod: "cash", refundCharges: true, chargesReason: "khách không lấy",
      lines: [{ orderLineId: o.body.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "khách đổi ý" }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("approval_required");
    // không hoàn thu khác → chỉ 100.000 < ngưỡng → thu ngân tự trả được
    const o2 = await api("manager", "POST", `${V}/pos/orders`, {
      clientUuid: uid(), lines: [line(1)], charges: [{ name: "Phí trang trí", amount: 600000 }], payments: [{ method: "card", amount: 700000 }],
    });
    const r2 = await api("cashier", "POST", `${V}/orders/${o2.body.id}/return`, {
      refundMethod: "cash", lines: [{ orderLineId: o2.body.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "khách đổi ý" }],
    });
    expect(r2.status).toBe(201);
  });

  it("loại thu khác mặc định 0: thu ngân không tự nhập số tiền; quản lý (pos.other_charge) được", async () => {
    const cash = (n: number) => [{ method: "cash", amount: n }];
    const c = await sell("cashier", { lines: [line(1)], charges: [{ chargeTypeId: 950, amount: 5000 }], payments: cash(105000) });
    expect(c.status).toBe(403);
    const m = await sell("manager", { lines: [line(1)], charges: [{ chargeTypeId: 950, amount: 5000 }], payments: cash(105000) });
    expect(m.status).toBe(201);
  });
});

describe("PA-2 + C2-04: phiếu duyệt ghi nợ gắn lý do và dư nợ lúc duyệt", () => {
  it("duyệt vượt hạn mức 50.000; trước khi dùng phiếu có thêm nợ 100.000 → phiếu hết hiệu lực (409), dư nợ không vượt", async () => {
    const cu = await retail(100000);
    const body = { clientUuid: uid(), customerId: cu, lines: [line(2)], payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } };
    const r1 = await api("cashier", "POST", `${V}/pos/orders`, body);
    expect(r1.body.error.code).toBe("approval_required");
    const aid = r1.body.error.details.approvalId;
    const ap = await db().prepare(`SELECT payload_json FROM approvals WHERE id = ?`).bind(aid).first<any>();
    expect(JSON.parse(ap.payload_json)).toMatchObject({ outstanding: 0, creditAmount: 150000, creditLimit: 100000, reasons: ["credit_limit"] });
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    expect((await sell("cashier", { customerId: cu, lines: [line(1)], credit: { amount: 100000 } })).status).toBe(201);
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { ...body, approvalId: aid });
    expect(ok.status).toBe(409);
    expect((await api("cashier", "GET", `${V}/pos/customers/${cu}/debts`)).body.outstanding).toBe(100000);
  });

  it("phiếu còn đúng dư nợ lúc duyệt vẫn dùng được", async () => {
    const cu = await retail(100000);
    const body = { clientUuid: uid(), customerId: cu, lines: [line(2)], payments: [{ method: "cash", amount: 50000 }], credit: { amount: 150000 } };
    const aid = (await api("cashier", "POST", `${V}/pos/orders`, body)).body.error.details.approvalId;
    await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" });
    expect((await api("cashier", "POST", `${V}/pos/orders`, { ...body, approvalId: aid })).status).toBe(201);
  });

  it("C2-04: phiếu duyệt 'vượt ngưỡng' (credit) không dùng được khi giờ là 'vượt hạn mức'", async () => {
    const cu = await retail(1_000_000);
    const body = { clientUuid: uid(), customerId: cu, lines: [line(6)], payments: [], credit: { amount: 600000 } };
    const r1 = await api("cashier", "POST", `${V}/pos/orders`, body);
    expect(r1.body.error.code).toBe("approval_required");
    expect(r1.body.error.details.reasons).toEqual(["credit"]);
    const aid = r1.body.error.details.approvalId;
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    expect((await sell("cashier", { customerId: cu, lines: [line(5)], credit: { amount: 500000 } })).status).toBe(201);
    const r2 = await api("cashier", "POST", `${V}/pos/orders`, { ...body, approvalId: aid });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe("approval_invalid");
    expect((await api("cashier", "GET", `${V}/pos/customers/${cu}/debts`)).body.outstanding).toBe(500000);
  });
});

describe("C2-07: thu nợ tại quầy bằng chuyển khoản tự khai", () => {
  it("thu ngân → 403; tiền mặt vẫn được; chủ/quản lý/kế toán (debt.write) ghi được", async () => {
    const cu = await retail();
    expect((await sell("cashier", { customerId: cu, credit: { amount: 200000 } })).status).toBe(201);
    const tf = await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 80000, method: "transfer", idempotencyKey: uid() });
    expect(tf.status).toBe(403);
    expect((await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 50000, method: "cash", idempotencyKey: uid() })).status).toBe(201);
    expect((await api("owner", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 80000, method: "transfer", idempotencyKey: uid() })).status).toBe(201);
    // quản lý có debt.write (như thu nợ ở màn Công nợ) → ghi được chuyển khoản thủ công
    expect((await api("manager", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 20000, method: "transfer", idempotencyKey: uid() })).status).toBe(201);
  });
});

describe("C2-06: đổi người bán khi kỳ lương đã duyệt", () => {
  const period = vnPeriod();
  const setPeriod = (status: string) =>
    db().prepare(`INSERT INTO payroll_periods(period, status) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET status = ?`).bind(period, status, status).run();
  it("kỳ đã duyệt/đã chi → 409 payroll_locked (đơn lẻ và bulk); kỳ chỉ mới tính → được; ghi chú vẫn sửa được", async () => {
    const a = (await sell("cashier", { payments: [{ method: "cash", amount: 200000 }] })).body.id;
    const b = (await sell("cashier", { payments: [{ method: "cash", amount: 200000 }] })).body.id;
    await setPeriod("approved");
    const r = await api("manager", "PATCH", `${V}/orders/${a}/meta`, { sellerId: 2 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("payroll_locked");
    const bulk = await api("manager", "POST", `${V}/orders/meta/bulk`, { ids: [a, b], sellerId: 2 });
    expect(bulk.status).toBe(409);
    expect((await api("manager", "PATCH", `${V}/orders/${a}/meta`, { note: "ghi chú mới" })).status).toBe(200);
    await setPeriod("paid");
    expect((await api("manager", "PATCH", `${V}/orders/${a}/meta`, { sellerId: 2 })).status).toBe(409);
    await setPeriod("calculated");
    const ok = await api("manager", "PATCH", `${V}/orders/${a}/meta`, { sellerId: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.seller_id).toBe(2);
    await db().prepare(`DELETE FROM payroll_periods WHERE period = ?`).bind(period).run();
  });
});

describe("C2-01: chi tiết đơn che SĐT / địa chỉ người nhận", () => {
  it("thủ kho thấy đã che; chủ thấy đủ", async () => {
    const o = (await sell("cashier", { payments: [{ method: "cash", amount: 200000 }] })).body.id;
    await db().prepare(`UPDATE orders SET receiver_phone = '0987654321', ship_address = '88 Đường Kín Đáo, Quận 1' WHERE id = ?`).bind(o).run();
    for (const role of ["warehouse", "cashier"]) {
      const d = await api(role, "GET", `${V}/orders/${o}`);
      expect(d.status).toBe(200);
      expect(d.body.receiver_phone).toBe("098****321");
      expect(d.body.ship_address).toBe("***");
    }
    const f = await api("owner", "GET", `${V}/orders/${o}`);
    expect(f.body.receiver_phone).toBe("0987654321");
    expect(f.body.ship_address).toContain("Kín Đáo");
  });
});

describe("Nghi ngờ: chốt ca, pay-info", () => {
  it("chốt ca hai lần song song → một lần thành công, lần kia 409; chỉ một audit shift.close", async () => {
    const s = (await api("owner", "POST", `${V}/shifts/open`, { openingCash: 0 })).body?.shift?.id;
    expect(s).toBeTruthy();
    const close = () => api("owner", "POST", `${V}/shifts/${s}/close`, { countedCash: 0 });
    const [x, y] = await Promise.all([close(), close()]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const n = (await db().prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'shift.close' AND entity_id = ?`).bind(String(s)).first<{ n: number }>())!.n;
    expect(n).toBe(1);
  });

  it("pay-info: GET không còn; POST chỉ hoá đơn khách lẻ còn nợ; trả hết → 404", async () => {
    const cu = await retail();
    expect((await sell("cashier", { customerId: cu, credit: { amount: 200000 } })).status).toBe(201);
    const inv = await db().prepare(`SELECT id FROM invoices WHERE customer_id = ? AND kind = 'sale'`).bind(cu).first<{ id: number }>();
    expect((await api("cashier", "GET", `${V}/pos/invoices/${inv!.id}/pay-info`)).status).toBe(404);
    const before = (await db().prepare(`SELECT COUNT(*) AS n FROM pay_codes`).first<{ n: number }>())!.n;
    expect((await api("cashier", "POST", `${V}/pos/invoices/${inv!.id}/pay-info`, {})).status).toBe(200);
    // khách sỉ / hoá đơn không tồn tại → 404
    expect((await api("cashier", "POST", `${V}/pos/invoices/99999999/pay-info`, {})).status).toBe(404);
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM pay_codes`).first<{ n: number }>())!.n).toBe(before); // sepay tắt → không phát hành mã
    expect((await api("cashier", "POST", `${V}/pos/debt-payments`, { customerId: cu, amount: 200000, method: "cash", idempotencyKey: uid() })).status).toBe(201);
    expect((await api("cashier", "POST", `${V}/pos/invoices/${inv!.id}/pay-info`, {})).status).toBe(404);
  });
});
