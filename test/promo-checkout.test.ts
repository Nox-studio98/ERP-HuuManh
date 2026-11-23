import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { lotQty, seedSales } from "./seed-sales";
import { ROLE_PERMS } from "../src/worker/lib/rbac";

const V = "/api/v1";
const db = () => testEnv.DB;
const line = (productId: number, qty: number) => ({ productId, unit: "kg", qty });
let n = 0;
const uuid = () => `promo-co-${Date.now()}-${++n}`;
const pts = async (id: number) => (await db().prepare(`SELECT points p FROM customers WHERE id=?`).bind(id).first<{ p: number }>())!.p;
const used = async (code: string) => (await db().prepare(`SELECT used_count u FROM vouchers WHERE code=?`).bind(code).first<{ u: number }>())!.u;

/** Tạo KM qua API (quản lý) và kích hoạt; trả id. */
async function activePromo(body: object) {
  const c = await api("manager", "POST", `${V}/promotions`, { startsAt: "2020-01-01", endsAt: "2099-12-31", ...body });
  expect(c.status).toBe(201);
  const s = await api("manager", "POST", `${V}/promotions/${c.body.id}/submit`);
  expect(s.status).toBe(200);
  expect(s.body.status).toBe("active");
  return c.body.id as number;
}
async function genVouchers(id: number, body: object) {
  const r = await api("manager", "POST", `${V}/promotions/${id}/vouchers`, body);
  expect(r.status).toBe(201);
  return r.body.codes as string[];
}

beforeAll(async () => {
  await seedBase();
  await seedSales();
  await db().batch([
    db().prepare(`INSERT INTO customers(id, code, type, name, customer_group_id, points) VALUES (11,'KH-P1','retail','Khách tích điểm',1,0),(12,'KH-P2','retail','Khách khác',1,0)`),
    db().prepare(`UPDATE settings SET value='1' WHERE key='loyalty.enabled'`),
    // lô dư để các đơn thử không hết hàng
    db().prepare(`UPDATE lots SET qty_in_milli=200000, qty_on_hand_milli=200000 WHERE id=1`),
  ]);
  await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 });
});

describe("voucher tại POS", () => {
  let promoId: number;
  let codes: string[];

  it("sinh voucher ngẫu nhiên base32 10 ký tự, không trùng", async () => {
    promoId = await activePromo({ name: "Giảm 20k bằng mã", kind: "amount", valueAmount: 20000, requiresVoucher: true, channels: ["pos", "online"] });
    codes = await genVouchers(promoId, { count: 6, maxUses: 1 });
    expect(codes).toHaveLength(6);
    expect(new Set(codes).size).toBe(6);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{10}$/);
    const list = await api("manager", "GET", `${V}/promotions/${promoId}/vouchers`);
    expect(list.body.items).toHaveLength(6);
    expect(list.body.items[0].usedCount).toBe(0);
    const pre = await genVouchers(promoId, { count: 1, prefix: "tet", maxUses: 5 });
    expect(pre[0]).toMatch(/^TET[A-Z2-7]{10}$/);
    // thu ngân không sinh được voucher
    expect((await api("cashier", "POST", `${V}/promotions/${promoId}/vouchers`, { count: 1 })).status).toBe(403);
  });

  it("preview tính giảm giá; mã sai trả rejected", async () => {
    const ok = await api("cashier", "POST", `${V}/promotions/preview`, { lines: [line(1, 2)], voucherCode: codes[0] });
    expect(ok.status).toBe(200);
    expect(ok.body.subtotal).toBe(200000);
    expect(ok.body.discount).toBe(20000);
    expect(ok.body.total).toBe(180000);
    const bad = await api("cashier", "POST", `${V}/promotions/preview`, { lines: [line(1, 2)], voucherCode: "KHONGCO" });
    expect(bad.body.discount).toBe(0);
    expect(bad.body.rejected[0].reason).toBe("voucher_not_found");
  });

  it("checkout với voucher: order_discounts + redemption + used_count trong cùng batch", async () => {
    const r = await api("cashier", "POST", `${V}/pos/orders`, {
      clientUuid: uuid(), lines: [line(1, 2)], voucherCode: codes[0].toLowerCase(), payments: [{ method: "cash", amount: 180000 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(180000);
    expect(r.body.discount).toBe(20000);
    expect(r.body.lines[0].discount).toBe(20000);
    expect(r.body.discounts).toHaveLength(1);
    expect(r.body.discounts[0].amount).toBe(20000);
    expect(await used(codes[0])).toBe(1);
    const red = await db().prepare(`SELECT status, amount FROM voucher_redemptions WHERE order_id=?`).bind(r.body.id).first<any>();
    expect(red).toMatchObject({ status: "used", amount: 20000 });
  });

  it("voucher đã hết lượt → 409 voucher_exhausted, không trừ kho", async () => {
    const before = await lotQty(1);
    const r = await api("cashier", "POST", `${V}/pos/orders`, {
      clientUuid: uuid(), lines: [line(1, 1)], voucherCode: codes[0], payments: [{ method: "cash", amount: 100000 }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("voucher_exhausted");
    expect(await lotQty(1)).toBe(before);
  });

  it("mã không tồn tại → 422 voucher_invalid", async () => {
    const r = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(1, 1)], voucherCode: "ZZZZZZZZZZ", payments: [{ method: "cash", amount: 100000 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("voucher_invalid");
  });

  it("hai máy cùng dùng lượt cuối của voucher → đúng một đơn thành công, một 409", async () => {
    const before = await lotQty(1);
    const mk = () => api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(1, 1)], voucherCode: codes[1], payments: [{ method: "cash", amount: 100000 }] });
    const res = await Promise.all([mk(), mk()]);
    const st = res.map((x) => x.status).sort();
    expect(st).toEqual([201, 409]);
    const lose = res.find((x) => x.status === 409)!;
    expect(lose.body.error.code).toBe("voucher_exhausted");
    expect(await used(codes[1])).toBe(1);
    expect(await lotQty(1)).toBe(before - 1000);
    // đơn thua không để lại đơn completed
    const completed = await db().prepare(`SELECT COUNT(*) c FROM voucher_redemptions WHERE voucher_id=(SELECT id FROM vouchers WHERE code=?)`).bind(codes[1]).first<{ c: number }>();
    expect(completed!.c).toBe(1);
  });

  it("trả hàng toàn bộ hoàn lượt voucher; voucher dùng lại được", async () => {
    const o = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(1, 2)], voucherCode: codes[2], payments: [{ method: "cash", amount: 180000 }] });
    expect(o.status).toBe(201);
    expect(await used(codes[2])).toBe(1);
    // trả một phần: voucher vẫn tính đã dùng
    const part = await api("cashier", "POST", `${V}/orders/${o.body.id}/return`, {
      lines: [{ orderLineId: o.body.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "đổi ý" }], refundMethod: "cash",
    });
    expect(part.status).toBe(201);
    expect(part.body.total).toBe(90000); // 1kg × (100k − 10k phân bổ voucher)
    expect(await used(codes[2])).toBe(1);
    const rest = await api("cashier", "POST", `${V}/orders/${o.body.id}/return`, {
      lines: [{ orderLineId: o.body.lines[0].id, qty: 1, unit: "kg", restock: true, reason: "đổi ý" }], refundMethod: "cash",
    });
    expect(rest.status).toBe(201);
    expect(await used(codes[2])).toBe(0);
    expect((await db().prepare(`SELECT status s FROM voucher_redemptions WHERE order_id=?`).bind(o.body.id).first<any>()).s).toBe("reversed");
    const again = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(1, 1)], voucherCode: codes[2], payments: [{ method: "cash", amount: 100000 }] });
    expect(again.status).toBe(201);
  });

  it("huỷ đơn hoàn lượt voucher", async () => {
    const o = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(1, 1)], voucherCode: codes[3], payments: [{ method: "cash", amount: 100000 }] });
    expect(o.status).toBe(201);
    expect(await used(codes[3])).toBe(1);
    const v = await api("manager", "POST", `${V}/orders/${o.body.id}/void`, { reason: "nhập nhầm" });
    expect(v.status).toBe(200);
    expect(await used(codes[3])).toBe(0);
  });

  it("không gửi voucher/điểm: hành vi cũ (không có order_discounts)", async () => {
    const r = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(1, 1)], payments: [{ method: "cash", amount: 100000 }] });
    expect(r.status).toBe(201);
    expect(r.body.discount).toBe(0);
    expect(r.body.discounts).toEqual([]);
  });
});

describe("khuyến mãi tự động và phê duyệt", () => {
  it("KM tự động áp ở POS; ghi order_discounts; không kích hoạt duyệt giảm giá >10%", async () => {
    const id = await activePromo({ name: "Nho giảm 20%", kind: "percent", valueBp: 2000, items: [{ productId: 2 }] });
    const r = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(2, 1)], payments: [{ method: "cash", amount: 160000 }] });
    expect(r.status).toBe(201);
    expect(r.body.total).toBe(160000);
    expect(r.body.discounts[0].promotion_id).toBe(id);
    await api("manager", "POST", `${V}/promotions/${id}/end`);
    const after = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: uuid(), lines: [line(2, 1)], payments: [{ method: "cash", amount: 200000 }] });
    expect(after.body.total).toBe(200000);
  });

  describe("luồng duyệt promotion.activate", () => {
    afterAll(() => (ROLE_PERMS.accountant as Set<string>).delete("promotions.write"));
    it("người không có promotions.approve gửi duyệt → pending_approval + approval; quản lý duyệt → active", async () => {
      (ROLE_PERMS.accountant as Set<string>).add("promotions.write");
      const c = await api("accountant", "POST", `${V}/promotions`, { name: "KM chờ duyệt", kind: "percent", valueBp: 500, startsAt: "2020-01-01", endsAt: "2099-12-31" });
      expect(c.status).toBe(201);
      expect(c.body.status).toBe("draft");
      const s = await api("accountant", "POST", `${V}/promotions/${c.body.id}/submit`);
      expect(s.status).toBe(200);
      expect(s.body.status).toBe("pending_approval");
      expect(s.body.approvalId).toBeGreaterThan(0);
      // chưa active nên chưa giảm giá
      const pre = await api("cashier", "POST", `${V}/promotions/preview`, { lines: [line(1, 1)] });
      expect(pre.body.discount).toBe(0);
      const d = await api("manager", "POST", `${V}/approvals/${s.body.approvalId}/decide`, { decision: "approved" });
      expect(d.status).toBe(200);
      const after = await api("manager", "GET", `${V}/promotions/${c.body.id}`);
      expect(after.body.status).toBe("active");
      expect(after.body.approvedBy).toBe(2);
      expect((await api("cashier", "POST", `${V}/promotions/preview`, { lines: [line(1, 1)] })).body.discount).toBe(5000);
      await api("manager", "POST", `${V}/promotions/${c.body.id}/end`);
    });

    it("từ chối → quay về draft", async () => {
      (ROLE_PERMS.accountant as Set<string>).add("promotions.write");
      const c = await api("accountant", "POST", `${V}/promotions`, { name: "KM bị từ chối", kind: "amount", valueAmount: 1000, startsAt: "2020-01-01", endsAt: "2099-12-31" });
      const s = await api("accountant", "POST", `${V}/promotions/${c.body.id}/submit`);
      await api("owner", "POST", `${V}/approvals/${s.body.approvalId}/decide`, { decision: "rejected", note: "không phù hợp" });
      expect((await api("manager", "GET", `${V}/promotions/${c.body.id}`)).body.status).toBe("draft");
    });

    it("chỉ sửa được khi ở nháp; validate theo loại", async () => {
      const bad = await api("manager", "POST", `${V}/promotions`, { name: "Thiếu giá trị", kind: "percent", startsAt: "2020-01-01", endsAt: "2099-12-31" });
      expect(bad.status).toBe(422);
      const combo = await api("manager", "POST", `${V}/promotions`, { name: "Combo trống", kind: "combo", valueAmount: 1000, startsAt: "2020-01-01", endsAt: "2099-12-31" });
      expect(combo.status).toBe(422);
      const id = await activePromo({ name: "Đang chạy", kind: "amount", valueAmount: 1000 });
      const put = await api("manager", "PUT", `${V}/promotions/${id}`, { name: "Sửa", kind: "amount", valueAmount: 2000, startsAt: "2020-01-01", endsAt: "2099-12-31" });
      expect(put.status).toBe(409);
      await api("manager", "POST", `${V}/promotions/${id}/end`);
    });
  });
});
