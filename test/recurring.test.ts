import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";
import { generateRecurringOrders } from "../src/worker/services/recurring-cron";

const db = () => testEnv.DB;
const tomorrow = () => addDays(vnDate(), 1);
const wdOf = (d: string) => new Date(d + "T00:00:00Z").getUTCDay() || 7;
const orders = async (tpl: number) =>
  (await db().prepare(`SELECT * FROM orders WHERE recurring_template_id=? ORDER BY id`).bind(tpl).all<any>()).results;
const lot = async (id: number) => (await db().prepare(`SELECT qty_on_hand_milli h, qty_reserved_milli r FROM lots WHERE id=?`).bind(id).first<{ h: number; r: number }>())!;

async function customer(name: string, creditLimit: number) {
  const r = await api("owner", "POST", "/api/v1/customers", {
    name, type: "b2b", customerGroupId: 1, creditLimit, paymentTermsDays: 15,
    contacts: [{ name: "Người nhận", phone: "0900000002", isReceiver: true }],
    addresses: [{ label: "Kho", address: "2 Lê Lợi", isDefault: true }],
  });
  expect(r.status).toBe(201);
  return { id: r.body.id as number, addressId: r.body.addresses[0].id as number };
}
async function template(c: { id: number; addressId: number }, weekdays: number[], active = true) {
  const r = await api("manager", "POST", "/api/v1/b2b/recurring", { customerId: c.id, addressId: c.addressId, weekdays, lines: [{ productId: 820, unit: "kg", qty: 10 }], active });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

beforeAll(async () => {
  await seedBase();
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 20 * 86400_000).toISOString();
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (820,'CAMLAP','Cam lặp','kg')`),
    db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (820,'LOT-LAP',820,1,?,?,30000,500000,500000)`).bind(now, later),
    db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,820,50000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
});

describe("đơn sỉ lặp tự động (M4-08)", () => {
  it("tạo đơn cho ngày mai đúng một lần (idempotent), xác nhận và giữ tồn", async () => {
    const c = await customer("KH lặp 1", 100_000_000);
    const tpl = await template(c, [wdOf(tomorrow())]);
    const before = await lot(820);
    await generateRecurringOrders(testEnv);
    let os = await orders(tpl);
    expect(os).toHaveLength(1);
    expect(os[0]).toMatchObject({ channel: "b2b", status: "confirmed", delivery_date: tomorrow(), total: 500000, customer_id: c.id, address_id: c.addressId });
    expect(os[0].client_uuid).toBe(`recurring:${tpl}:${tomorrow()}`);
    expect((await lot(820)).r).toBe(before.r + 10000);
    expect((await db().prepare(`SELECT last_generated_for l FROM recurring_orders WHERE id=?`).bind(tpl).first<any>()).l).toBe(tomorrow());
    // chạy lại (cron lặp / chạy tay) không sinh thêm
    await generateRecurringOrders(testEnv);
    await generateRecurringOrders(testEnv);
    os = await orders(tpl);
    expect(os).toHaveLength(1);
    expect((await lot(820)).r).toBe(before.r + 10000);
    const n = await db().prepare(`SELECT COUNT(*) n FROM orders WHERE client_uuid=?`).bind(`recurring:${tpl}:${tomorrow()}`).first<any>();
    expect(n.n).toBe(1);
  });

  it("bỏ qua mẫu sai thứ trong tuần hoặc đã tắt", async () => {
    const c = await customer("KH lặp 2", 100_000_000);
    const other = (wdOf(tomorrow()) % 7) + 1;
    const wrongDay = await template(c, [other]);
    const off = await template(c, [wdOf(tomorrow())], false);
    await generateRecurringOrders(testEnv);
    expect(await orders(wrongDay)).toHaveLength(0);
    expect(await orders(off)).toHaveLength(0);
  });

  it("mẫu nhiều thứ: sinh khi ngày mai nằm trong danh sách", async () => {
    const c = await customer("KH lặp 3", 100_000_000);
    const tpl = await template(c, [1, 2, 3, 4, 5, 6, 7]);
    await generateRecurringOrders(testEnv);
    expect(await orders(tpl)).toHaveLength(1);
  });

  it("vượt hạn mức: KHÔNG vượt quyền — đơn ở trạng thái new kèm yêu cầu duyệt, không giữ tồn", async () => {
    const c = await customer("KH hạn mức thấp", 100_000);
    const tpl = await template(c, [wdOf(tomorrow())]);
    const before = await lot(820);
    await generateRecurringOrders(testEnv);
    const os = await orders(tpl);
    expect(os).toHaveLength(1);
    expect(os[0].status).toBe("new");
    expect((await lot(820)).r).toBe(before.r);
    const ap = await db().prepare(`SELECT status, type FROM approvals WHERE type='order.credit_override' AND ref_id=?`).bind(String(os[0].id)).first<any>();
    expect(ap).toMatchObject({ type: "order.credit_override", status: "pending" });
    await generateRecurringOrders(testEnv); // không tạo trùng đơn / approval
    expect(await orders(tpl)).toHaveLength(1);
  });

  it("tắt recurring.auto_generate thì không sinh đơn", async () => {
    const c = await customer("KH lặp 4", 100_000_000);
    const tpl = await template(c, [wdOf(tomorrow())]);
    await db().prepare(`UPDATE settings SET value='0' WHERE key='recurring.auto_generate'`).run();
    await generateRecurringOrders(testEnv);
    expect(await orders(tpl)).toHaveLength(0);
    await db().prepare(`UPDATE settings SET value='1' WHERE key='recurring.auto_generate'`).run();
    await generateRecurringOrders(testEnv);
    expect(await orders(tpl)).toHaveLength(1);
  });

  it("một mẫu lỗi (sản phẩm bị ngừng) không chặn các mẫu khác", async () => {
    const c = await customer("KH lặp 5", 100_000_000);
    const good = await template(c, [wdOf(tomorrow())]);
    await db().prepare(`INSERT INTO products(id, sku, name, base_unit, active) VALUES (821,'NGUNG','Hàng ngừng bán','kg',0)`).run();
    const bad = (await api("manager", "POST", "/api/v1/b2b/recurring", { customerId: c.id, addressId: c.addressId, weekdays: [wdOf(tomorrow())], lines: [{ productId: 820, unit: "kg", qty: 1 }] })).body.id;
    await db().prepare(`UPDATE recurring_orders SET lines_json=? WHERE id=?`).bind(JSON.stringify([{ productId: 821, unit: "kg", qty: 1 }]), bad).run();
    await generateRecurringOrders(testEnv);
    expect(await orders(good)).toHaveLength(1);
    expect(await orders(bad)).toHaveLength(0);
    expect((await db().prepare(`SELECT last_generated_for l FROM recurring_orders WHERE id=?`).bind(bad).first<any>()).l).toBeNull();
  });
});
