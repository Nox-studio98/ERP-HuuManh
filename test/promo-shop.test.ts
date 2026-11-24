import { beforeAll, describe, expect, it } from "vitest";
import { call, checkoutBody, lot, seedShop, testEnv } from "./shop-helpers";

const db = () => testEnv.DB;
const item = (qty = 3) => ({ productId: 901, unit: "kg", qty });
let promoId: number;
let seq = 0;

async function mkPromo(o: { kind: string; amount?: number; bp?: number; voucher: boolean; channels?: string }) {
  const r = await db()
    .prepare(
      `INSERT INTO promotions(code, name, kind, channels, value_bp, value_amount, starts_at, ends_at, requires_voucher, status, created_by)
       VALUES (?,?,?,?,?,?, '2020-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z', ?, 'active', 1) RETURNING id`,
    )
    .bind(`KM-SHOP${++seq}`, `Shop KM ${seq}`, o.kind, o.channels ?? "online", o.bp ?? null, o.amount ?? null, o.voucher ? 1 : 0)
    .first<{ id: number }>();
  return r!.id;
}
const mkVoucher = (promotion: number, code: string, maxUses: number | null) =>
  db().prepare(`INSERT INTO vouchers(code, promotion_id, max_uses) VALUES (?,?,?)`).bind(code, promotion, maxUses).run();

beforeAll(async () => {
  await seedShop();
  promoId = await mkPromo({ kind: "amount", amount: 15000, voucher: true });
  await mkVoucher(promoId, "SHOP15", 1);
  await mkVoucher(promoId, "SHOPMANY", null);
});

describe("website: voucher + khuyến mãi", () => {
  it("quote không voucher: không giảm (hành vi cũ)", async () => {
    const q = await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 1" });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ subtotal: 150000, discount: 0, shippingFee: 20000, total: 170000 });
    expect(q.body.discounts).toEqual([]);
    expect(q.body.voucher).toBeUndefined();
  });

  it("quote với voucher hợp lệ: trả discount, total đã trừ; sai mã → applied=false + lý do", async () => {
    const q = await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 1", voucherCode: "shop15" });
    expect(q.body).toMatchObject({ subtotal: 150000, discount: 15000, shippingFee: 20000, total: 155000 });
    expect(q.body.discounts[0]).toMatchObject({ promotionId: promoId, amount: 15000 });
    expect(q.body.voucher).toEqual({ code: "shop15", applied: true });
    expect(q.body.lines[0].discount).toBe(15000);
    const bad = await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 1", voucherCode: "NOPE" });
    expect(bad.status).toBe(200);
    expect(bad.body.discount).toBe(0);
    expect(bad.body.voucher).toEqual({ code: "NOPE", applied: false, reason: "voucher_not_found" });
    // quote không tiêu thụ lượt
    expect((await db().prepare(`SELECT used_count u FROM vouchers WHERE code='SHOP15'`).first<any>()).u).toBe(0);
  });

  it("checkout với voucher: giảm trên tiền hàng, ghi order_discounts / redemption / used_count", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody({ voucherCode: "SHOP15" }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ subtotal: 150000, discount: 15000, shippingFee: 20000, total: 155000, estimatedTotal: 155000 });
    const o = await db().prepare(`SELECT id, discount, total FROM orders WHERE code=?`).bind(r.body.code).first<any>();
    expect(o).toMatchObject({ discount: 15000, total: 155000 });
    const d = await db().prepare(`SELECT promotion_id, voucher_id, amount FROM order_discounts WHERE order_id=?`).bind(o.id).first<any>();
    expect(d).toMatchObject({ promotion_id: promoId, amount: 15000 });
    expect(d.voucher_id).toBeGreaterThan(0);
    const red = await db().prepare(`SELECT status, amount, customer_id FROM voucher_redemptions WHERE order_id=?`).bind(o.id).first<any>();
    expect(red).toMatchObject({ status: "used", amount: 15000 });
    expect(red.customer_id).toBeGreaterThan(0); // khách vãng lai tạo trong cùng batch
    expect((await db().prepare(`SELECT used_count u FROM vouchers WHERE code='SHOP15'`).first<any>()).u).toBe(1);
  });

  it("voucher hết lượt: checkout 409 voucher_exhausted, không giữ tồn; quote báo hết lượt", async () => {
    const before = await lot(901);
    const r = await call("POST", "/api/checkout", checkoutBody({ voucherCode: "SHOP15" }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("voucher_exhausted");
    expect(await lot(901)).toEqual(before);
    const q = await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 1", voucherCode: "SHOP15" });
    expect(q.body.voucher).toMatchObject({ applied: false, reason: "voucher_exhausted" });
  });

  it("voucher không tồn tại → 422 voucher_invalid", async () => {
    const r = await call("POST", "/api/checkout", checkoutBody({ voucherCode: "KHONGCO" }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("voucher_invalid");
  });

  it("hai khách cùng dùng lượt cuối đồng thời → một đơn, một 409", async () => {
    await mkVoucher(promoId, "LASTONE", 1);
    const before = await lot(901);
    const res = await Promise.all([call("POST", "/api/checkout", checkoutBody({ voucherCode: "LASTONE" })), call("POST", "/api/checkout", checkoutBody({ voucherCode: "LASTONE" }))]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(res.find((x) => x.status === 409)!.body.error.code).toBe("voucher_exhausted");
    expect((await db().prepare(`SELECT used_count u FROM vouchers WHERE code='LASTONE'`).first<any>()).u).toBe(1);
    expect((await lot(901)).r).toBe(before.r + 3000); // chỉ một đơn giữ tồn
  });

  it("khuyến mãi tự động kênh online áp khi không có voucher; kênh pos thì không", async () => {
    const auto = await mkPromo({ kind: "percent", bp: 1000, voucher: false, channels: "online" });
    const q = await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 1" });
    expect(q.body.discount).toBe(15000);
    expect(q.body.total).toBe(155000);
    const co = await call("POST", "/api/checkout", checkoutBody());
    expect(co.status).toBe(201);
    expect(co.body.discount).toBe(15000);
    expect(co.body.total).toBe(155000);
    await db().prepare(`UPDATE promotions SET channels='pos' WHERE id=?`).bind(auto).run();
    expect((await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 1" })).body.discount).toBe(0);
    await db().prepare(`UPDATE promotions SET status='ended' WHERE id=?`).bind(auto).run();
  });

  it("EC-08: voucher thua KM tự động tốt hơn thì không bị tiêu thụ lượt", async () => {
    const auto = await mkPromo({ kind: "percent", bp: 2000, voucher: false, channels: "online" });
    const q = await call("POST", "/api/cart/quote", { items: [item()], district: "Quận 1", voucherCode: "SHOPMANY" });
    expect(q.body.discount).toBe(30000);
    expect(q.body.voucher).toMatchObject({ applied: false, reason: "not_best_promotion" });
    const before = (await db().prepare(`SELECT used_count u FROM vouchers WHERE code='SHOPMANY'`).first<any>()).u;
    const co = await call("POST", "/api/checkout", checkoutBody({ voucherCode: "SHOPMANY" }));
    expect(co.status).toBe(201);
    expect(co.body.discount).toBe(30000);
    expect((await db().prepare(`SELECT used_count u FROM vouchers WHERE code='SHOPMANY'`).first<any>()).u).toBe(before);
    await db().prepare(`UPDATE promotions SET status='ended' WHERE id=?`).bind(auto).run();
  });
});
