import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";

// Đơn giao từ quầy nhận giảm giá tay (docs/POS-KV-B.md B3 + A-29): giảm dòng / cả đơn, ngưỡng duyệt, bán dưới vốn.
const V = "/api/v1";
const db = () => testEnv.DB;
let seq = 0;
const body = (over: Record<string, unknown> = {}) => ({
  clientUuid: `pkd-${++seq}-${crypto.randomUUID()}`,
  receiver: { name: "Chị Lan", phone: "0901234567", address: "12 Lê Lợi, Quận 1" },
  lines: [{ productId: 1, unit: "kg", qty: 2 }], // 2kg Táo × 100.000 = 200.000
  shippingFee: 20000,
  deliverer: { userId: 3 },
  prepay: [] as any[],
  cod: 200000,
  ...over,
});
const create = (role: string, b: unknown) => api(role, "POST", `${V}/pos/delivery-orders`, b);
const act = (id: number, path: string, b?: unknown) => api("online_staff", "POST", `${V}/online-orders/${id}/${path}`, b ?? {});

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`),
  ]);
  await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 500000 });
  await api("manager", "POST", `${V}/shifts/open`, { openingCash: 100000 });
});

describe("Đơn giao từ quầy có giảm giá tay", () => {
  it("báo giá trả giảm giá; giảm dòng + cả đơn trong ngưỡng: lưu đúng trên đơn, doanh thu = tổng sau giảm", async () => {
    const q = await api("cashier", "POST", `${V}/pos/delivery-quote`, { lines: [{ productId: 1, unit: "kg", qty: 2, discount: 10000 }], discount: 10000 });
    expect(q.body).toEqual({ subtotal: 200000, discount: 20000, net: 180000 });
    // 20.000 / 200.000 = 10% = đúng ngưỡng (chỉ vượt khi > 10%) → thu ngân tự làm được
    const r = await create("cashier", body({ lines: [{ productId: 1, unit: "kg", qty: 2, discount: 10000 }], discount: 10000, cod: 200000 }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "shipping", total: 200000, cod: 200000 });
    const o = (await db().prepare(`SELECT subtotal, discount, shipping_fee, total FROM orders WHERE id=?`).bind(r.body.id).first<any>())!;
    expect(o).toEqual({ subtotal: 200000, discount: 20000, shipping_fee: 20000, total: 200000 });
    const l = (await db().prepare(`SELECT discount, line_total FROM order_lines WHERE order_id=?`).bind(r.body.id).all<any>()).results;
    expect(l).toEqual([{ discount: 20000, line_total: 180000 }]);
    // Kiểm cân/đóng gói đã chạy trong luồng tạo đơn mà không làm mất giảm giá tay; giao xong → doanh thu = tổng sau giảm
    const before = (await api("manager", "GET", `${V}/online-orders?source=pos&status=completed`)).body.summary.revenue;
    expect((await act(r.body.id, "deliver")).status).toBe(200);
    const after = (await api("manager", "GET", `${V}/online-orders?source=pos&status=completed`)).body.summary.revenue;
    expect(after - before).toBe(200000);
    expect((await db().prepare(`SELECT amount FROM payments WHERE order_id=?`).bind(r.body.id).first<any>()).amount).toBe(200000);
    const detail = await api("manager", "GET", `${V}/online-orders/${r.body.id}`);
    expect(detail.body.discount).toBe(20000);
    expect((await api("online_staff", "GET", `${V}/online-orders/${r.body.id}`)).body).not.toHaveProperty("costTotal");
  });

  it("tổng không khớp (quên trừ giảm giá) → 422 payment_mismatch; giảm quá giá trị đơn → 422", async () => {
    const r = await create("cashier", body({ discount: 10000, cod: 220000 }));
    expect(r.body.error.code).toBe("payment_mismatch");
    expect(r.body.error.details.total).toBe(210000);
    const big = await create("cashier", body({ discount: 300000, cod: 0 }));
    expect(big.body.error.code).toBe("discount_too_large");
  });

  it("giảm vượt ngưỡng: thu ngân cần duyệt (409) → quản lý duyệt → thử lại cùng clientUuid thành công, phiếu dùng một lần", async () => {
    const b = body({ discount: 50000, cod: 170000 }); // 25% > 10%
    const r1 = await create("cashier", b);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe("approval_required");
    const aid = r1.body.error.details.approvalId;
    expect((await create("cashier", { ...b, approvalId: aid })).body.error.code).toBe("approval_required"); // còn chờ
    expect((await api("manager", "POST", `${V}/approvals/${aid}/decide`, { decision: "approved" })).status).toBe(200);
    // sửa giỏ sau khi duyệt → phiếu không còn khớp
    expect((await create("cashier", { ...b, discount: 60000, cod: 160000, approvalId: aid })).body.error.code).toBe("approval_invalid");
    const ok = await create("cashier", { ...b, approvalId: aid });
    expect(ok.status).toBe(201);
    const ap = (await db().prepare(`SELECT status, ref_type, ref_id FROM approvals WHERE id=?`).bind(aid).first<any>())!;
    expect(ap).toEqual({ status: "approved", ref_type: "order", ref_id: String(ok.body.id) });
    expect((await db().prepare(`SELECT total, discount FROM orders WHERE id=?`).bind(ok.body.id).first<any>())).toEqual({ total: 170000, discount: 50000 });
    // dùng lại phiếu cho đơn khác → từ chối
    expect((await create("cashier", { ...b, clientUuid: `x-${crypto.randomUUID()}`, approvalId: aid })).body.error.code).toBe("approval_invalid");
  });

  it("bán dưới giá vốn: quản lý tự duyệt phải ghi lý do (audit); thu ngân bị chặn; không lộ giá vốn", async () => {
    // Nho 1kg giá 200.000, vốn 150.000; giảm 60.000 → 140.000 < vốn
    const b = body({ lines: [{ productId: 2, unit: "kg", qty: 1, discount: 60000 }], shippingFee: 0, cod: 140000 });
    const c = await create("cashier", b);
    expect(c.body.error.code).toBe("approval_required");
    expect(c.body.error.details.reasons).toContain("below_cost");
    expect(JSON.stringify(c.body)).not.toMatch(/150000/);
    const noReason = await create("manager", b);
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe("override_reason_required");
    const ok = await create("manager", { ...b, overrideReason: "Hàng sắp úa, xả cho khách quen" });
    expect(ok.status).toBe(201);
    const au = (await db().prepare(`SELECT reason FROM audit_log WHERE action='order.self_approve' AND entity_id=?`).bind(String(ok.body.id)).first<any>())!;
    expect(au.reason).toContain("xả cho khách");
    expect((await db().prepare(`SELECT discount, line_total FROM order_lines WHERE order_id=?`).bind(ok.body.id).first<any>())).toEqual({ discount: 60000, line_total: 140000 });
  });

  it("không giảm giá: hành vi cũ giữ nguyên (không cần duyệt)", async () => {
    const r = await create("cashier", body({ cod: 220000 }));
    expect(r.status).toBe(201);
    expect((await db().prepare(`SELECT discount FROM orders WHERE id=?`).bind(r.body.id).first<any>()).discount).toBe(0);
  });
});
