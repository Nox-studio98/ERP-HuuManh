import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { evaluatePromotions, type EngineLine } from "../src/worker/services/promotions";

const db = () => testEnv.DB;
const NOW = "2026-11-23T05:00:00.000Z"; // 12:00 giờ VN
const FAR = { starts: "2020-01-01T00:00:00.000Z", ends: "2099-01-01T00:00:00.000Z" };

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`INSERT OR IGNORE INTO customers(id, code, type, name, customer_group_id) VALUES (1,'KH-T1','retail','A',1),(2,'KH-T2','retail','B',1)`),
  ]);
});

beforeEach(async () => {
  await db().batch([
    db().prepare(`UPDATE promotions SET status='cancelled'`),
    db().prepare(`UPDATE settings SET value='0' WHERE key='promo.allow_stacking'`),
  ]);
});

interface P { kind: string; channels?: string; bp?: number; amount?: number; min?: number; max?: number; daily?: [string, string]; voucher?: boolean; stack?: boolean; prio?: number; items?: { product?: number; group?: number; qty?: number }[]; starts?: string; ends?: string; name?: string }
let seq = 0;
async function promo(p: P) {
  const code = `KM-E${++seq}`;
  const r = await db()
    .prepare(
      `INSERT INTO promotions(code, name, kind, channels, value_bp, value_amount, min_order, max_discount, starts_at, ends_at, daily_start, daily_end, requires_voucher, stackable, priority, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1) RETURNING id`,
    )
    .bind(code, p.name ?? code, p.kind, p.channels ?? "pos,online", p.bp ?? null, p.amount ?? null, p.min ?? 0, p.max ?? null, p.starts ?? FAR.starts, p.ends ?? FAR.ends,
      p.daily?.[0] ?? null, p.daily?.[1] ?? null, p.voucher ? 1 : 0, p.stack ? 1 : 0, p.prio ?? 0)
    .first<{ id: number }>();
  for (const it of p.items ?? [])
    await db().prepare(`INSERT INTO promotion_items(promotion_id, product_id, product_group_id, qty_milli) VALUES (?,?,?,?)`).bind(r!.id, it.product ?? null, it.group ?? null, it.qty ?? null).run();
  return r!.id;
}
async function voucher(promotionId: number, o: { code: string; maxUses?: number; perCustomer?: number; customerId?: number; used?: number }) {
  await db()
    .prepare(`INSERT INTO vouchers(code, promotion_id, max_uses, per_customer_limit, customer_id, used_count) VALUES (?,?,?,?,?,?)`)
    .bind(o.code, promotionId, o.maxUses ?? null, o.perCustomer ?? 1, o.customerId ?? null, o.used ?? 0)
    .run();
}

const tao = (kg: number): EngineLine => ({ productId: 1, groupId: 1, qtyMilli: kg * 1000, unitPrice: 100000, lineTotal: kg * 100000 });
const nho = (kg: number): EngineLine => ({ productId: 2, groupId: 1, qtyMilli: kg * 1000, unitPrice: 200000, lineTotal: kg * 200000 });
const ev = (lines: EngineLine[], extra: object = {}) =>
  evaluatePromotions(db(), { channel: "pos", lines, subtotal: lines.reduce((s, l) => s + l.lineTotal, 0), at: NOW, ...extra });

describe("engine khuyến mãi", () => {
  it("không có khuyến mãi → không giảm", async () => {
    const r = await ev([tao(2)]);
    expect(r.discounts).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("percent có trần max_discount", async () => {
    await promo({ kind: "percent", bp: 2000, items: [{ product: 1 }] });
    expect((await ev([tao(2)])).total).toBe(40000);
    await db().prepare(`UPDATE promotions SET status='cancelled'`).run();
    await promo({ kind: "percent", bp: 2000, max: 25000 });
    const r = await ev([tao(2)]);
    expect(r.total).toBe(25000);
    expect(r.lineDiscounts).toEqual([25000]);
  });

  it("percent chỉ tính phần hàng trong phạm vi sản phẩm/nhóm", async () => {
    await promo({ kind: "percent", bp: 1000, items: [{ product: 2 }] });
    const r = await ev([tao(1), nho(1)]);
    expect(r.total).toBe(20000);
    expect(r.lineDiscounts).toEqual([0, 20000]);
    await db().prepare(`UPDATE promotions SET status='cancelled'`).run();
    await promo({ kind: "percent", bp: 1000, items: [{ group: 1 }] });
    expect((await ev([tao(1), nho(1)])).total).toBe(30000);
  });

  it("amount: giảm số tiền khi đạt đơn tối thiểu", async () => {
    await promo({ kind: "amount", amount: 30000, min: 150000 });
    expect((await ev([tao(1)])).total).toBe(0);
    const r = await ev([tao(2)]);
    expect(r.total).toBe(30000);
    expect(r.discounts[0].amount).toBe(30000);
  });

  it("fixed_price: đơn giá cố định cho sản phẩm trong phạm vi", async () => {
    await promo({ kind: "fixed_price", amount: 80000, items: [{ product: 1 }] });
    const r = await ev([tao(3), nho(1)]);
    expect(r.total).toBe(60000); // 3kg × (100k − 80k)
    expect(r.lineDiscounts).toEqual([60000, 0]);
  });

  it("combo: phải đủ MỌI thành phần; nhiều bộ nhân giá", async () => {
    await promo({ kind: "combo", amount: 250000, items: [{ product: 1, qty: 1000 }, { product: 2, qty: 1000 }] });
    expect((await ev([tao(2)])).total).toBe(0); // thiếu Nho
    const one = await ev([tao(1), nho(1)]);
    expect(one.total).toBe(50000); // 300k − 250k
    const two = await ev([tao(2), nho(2)]);
    expect(two.total).toBe(100000);
    const mixed = await ev([tao(3), nho(2)]); // chỉ 2 bộ đủ
    expect(mixed.total).toBe(100000);
  });

  it("end_of_day: chỉ áp trong khung giờ theo giờ Việt Nam", async () => {
    await promo({ kind: "end_of_day", bp: 3000, daily: ["19:00", "22:00"], items: [{ product: 1 }] });
    expect((await ev([tao(1)], { at: "2026-11-23T10:00:00.000Z" })).total).toBe(0); // 17:00 VN
    expect((await ev([tao(1)], { at: "2026-11-23T13:00:00.000Z" })).total).toBe(30000); // 20:00 VN
    expect((await ev([tao(1)], { at: "2026-11-23T15:00:00.000Z" })).total).toBe(0); // 22:00 VN: ngoài khung (nửa mở)
    expect((await ev([tao(1)], { at: "2026-11-23T12:00:00.000Z" })).total).toBe(30000); // 19:00 VN: biên đầu
  });

  it("khung giờ qua nửa đêm (22:00–02:00)", async () => {
    await promo({ kind: "percent", bp: 1000, daily: ["22:00", "02:00"] });
    expect((await ev([tao(1)], { at: "2026-11-23T16:00:00.000Z" })).total).toBe(10000); // 23:00 VN
    expect((await ev([tao(1)], { at: "2026-11-23T18:30:00.000Z" })).total).toBe(10000); // 01:30 VN
    expect((await ev([tao(1)], { at: "2026-11-23T06:00:00.000Z" })).total).toBe(0);
  });

  it("lọc theo kênh, thời gian hiệu lực và trạng thái", async () => {
    await promo({ kind: "percent", bp: 1000, channels: "online" });
    expect((await ev([tao(1)])).total).toBe(0);
    expect((await ev([tao(1)], { channel: "online" })).total).toBe(10000);
    await db().prepare(`UPDATE promotions SET status='cancelled'`).run();
    await promo({ kind: "percent", bp: 1000, starts: "2027-01-01T00:00:00.000Z", ends: "2027-02-01T00:00:00.000Z" });
    expect((await ev([tao(1)])).total).toBe(0);
    await promo({ kind: "percent", bp: 1000, ends: "2026-11-01T00:00:00.000Z" });
    expect((await ev([tao(1)])).total).toBe(0);
  });

  it("voucher: KM requires_voucher chỉ áp khi có mã hợp lệ (không phân biệt hoa thường)", async () => {
    const id = await promo({ kind: "amount", amount: 20000, voucher: true });
    await voucher(id, { code: "ABC123", maxUses: 2 });
    expect((await ev([tao(1)])).total).toBe(0);
    const ok = await ev([tao(1)], { voucherCode: " abc123 " });
    expect(ok.total).toBe(20000);
    expect(ok.discounts[0].voucherId).toBeGreaterThan(0);
    const bad = await ev([tao(1)], { voucherCode: "NOPE" });
    expect(bad.total).toBe(0);
    expect(bad.rejected).toEqual([{ code: "NOPE", reason: "voucher_not_found" }]);
  });

  it("voucher: hết lượt, vô hiệu, voucher cá nhân, giới hạn mỗi khách", async () => {
    const id = await promo({ kind: "amount", amount: 20000, voucher: true });
    await voucher(id, { code: "FULL", maxUses: 1, used: 1 });
    await voucher(id, { code: "PERS", customerId: 1 });
    await voucher(id, { code: "ONCE", maxUses: 10, perCustomer: 1 });
    await voucher(id, { code: "OFF" });
    await db().prepare(`UPDATE vouchers SET active=0 WHERE code='OFF'`).run();
    const reason = async (code: string, customerId?: number) => (await ev([tao(1)], { voucherCode: code, customerId })).rejected[0]?.reason;
    expect(await reason("FULL")).toBe("voucher_exhausted");
    expect(await reason("OFF")).toBe("voucher_inactive");
    expect(await reason("PERS")).toBe("voucher_wrong_customer");
    expect(await reason("PERS", 2)).toBe("voucher_wrong_customer");
    expect((await ev([tao(1)], { voucherCode: "PERS", customerId: 1 })).total).toBe(20000);
    // khách 1 đã dùng ONCE một lần → hết lượt riêng, khách 2 vẫn dùng được
    const vid = (await db().prepare(`SELECT id FROM vouchers WHERE code='ONCE'`).first<{ id: number }>())!.id;
    await db().prepare(`INSERT INTO orders(id, code, channel, store_id, status) VALUES (9001,'HD-ENG-1','pos',1,'completed')`).run().catch(() => {});
    await db().prepare(`INSERT INTO voucher_redemptions(voucher_id, order_id, customer_id, amount) VALUES (?,9001,1,20000)`).bind(vid).run();
    expect(await reason("ONCE", 1)).toBe("voucher_customer_limit");
    expect((await ev([tao(1)], { voucherCode: "ONCE", customerId: 2 })).total).toBe(20000);
  });

  it("voucher: đơn dưới mức tối thiểu của KM bị từ chối kèm lý do", async () => {
    const id = await promo({ kind: "amount", amount: 20000, voucher: true, min: 500000 });
    await voucher(id, { code: "MINV" });
    const r = await ev([tao(1)], { voucherCode: "MINV", customerId: 1 });
    expect(r.total).toBe(0);
    expect(r.rejected).toEqual([{ code: "MINV", reason: "min_order" }]);
  });

  it("EC-08: mặc định chỉ chọn MỘT khuyến mãi lợi nhất; bật stacking mới cộng dồn KM stackable", async () => {
    await promo({ kind: "percent", bp: 1000, stack: true, name: "10%" });
    await promo({ kind: "percent", bp: 500, stack: true, name: "5%" });
    await promo({ kind: "amount", amount: 5000, name: "5k" });
    const one = await ev([nho(1)]);
    expect(one.discounts).toHaveLength(1);
    expect(one.total).toBe(20000);
    await db().prepare(`UPDATE settings SET value='1' WHERE key='promo.allow_stacking'`).run();
    const both = await ev([nho(1)]);
    expect(both.discounts).toHaveLength(2);
    expect(both.total).toBe(20000 + 9000); // 10% rồi 5% trên phần còn lại
    expect(both.lineDiscounts).toEqual([29000]);
  });

  it("EC-08: voucher thua KM tự động tốt hơn → không dùng voucher (not_best_promotion)", async () => {
    await promo({ kind: "percent", bp: 2000 });
    const id = await promo({ kind: "amount", amount: 5000, voucher: true });
    await voucher(id, { code: "SMALL" });
    const r = await ev([nho(1)], { voucherCode: "SMALL", customerId: 1 });
    expect(r.total).toBe(40000);
    expect(r.discounts.every((d) => d.voucherId == null)).toBe(true);
    expect(r.rejected).toEqual([{ code: "SMALL", reason: "not_best_promotion" }]);
  });

  it("không bao giờ đưa giá dòng dưới giá vốn hiện tại: cắt phần vượt và ghi lý do", async () => {
    // Táo vốn 60k/kg → 2kg sàn 120k; giảm 50% (100k) bị cắt còn 80k
    await promo({ kind: "percent", bp: 5000, items: [{ product: 1 }] });
    const r = await ev([tao(2)]);
    expect(r.total).toBe(80000);
    expect(r.discounts[0].clipped).toBe(true);
    expect(r.discounts[0].description).toContain("giá vốn");
    expect(r.lineDiscounts).toEqual([80000]);
    await db().prepare(`UPDATE promotions SET status='cancelled'`).run();
    await promo({ kind: "fixed_price", amount: 10000, items: [{ product: 1 }] });
    expect((await ev([tao(2)])).total).toBe(80000); // giá cố định 10k < vốn 60k → chỉ giảm tới vốn
  });
});
