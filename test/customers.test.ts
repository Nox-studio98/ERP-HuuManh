import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

const db = () => testEnv.DB;

export const customerBody = (over: Record<string, unknown> = {}) => ({
  name: "Nhà hàng Hoa Sen",
  type: "b2b",
  taxCode: "0312345678",
  phone: "0901234567",
  email: "hoasen@example.com",
  billingAddress: "12 Nguyễn Huệ, Q1",
  customerGroupId: 1,
  creditLimit: 10_000_000,
  paymentTermsDays: 15,
  contacts: [
    { name: "Chị Lan", phone: "0911222333", role: "người đặt", isReceiver: false },
    { name: "Anh Tùng", phone: "0922333444", role: "thủ kho", isReceiver: true },
  ],
  addresses: [{ label: "Kho chính", address: "45 Lê Lợi, Q1", isDefault: true }],
  ...over,
});

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (820,'P820','Bưởi','kg'),(821,'P821','Xoài','kg')`),
    db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,820,50000,'2020-01-01T00:00:00Z','active',1),(1,821,50000,'2020-01-01T00:00:00Z','active',1)`),
    db().prepare(`INSERT INTO price_lists(id, name, channel, customer_group_id, kind, priority) VALUES (20,'Sỉ cấp 1','b2b',2,'group',50)`),
    db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (20,820,45000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
});

describe("customers", () => {
  it("requires at least one address and one receiver", async () => {
    const noAddr = await api("manager", "POST", "/api/v1/customers", customerBody({ addresses: [] }));
    expect(noAddr.status).toBe(422);
    expect(noAddr.body.error.code).toBe("address_required");
    const noRecv = await api("manager", "POST", "/api/v1/customers", customerBody({ contacts: [{ name: "Chị Lan", isReceiver: false }] }));
    expect(noRecv.status).toBe(422);
    expect(noRecv.body.error.code).toBe("receiver_required");
  });

  it("creates a customer with generated code, contacts and address linked to the receiver", async () => {
    const r = await api("manager", "POST", "/api/v1/customers", customerBody());
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^KH-\d{4}$/);
    expect(r.body.contacts).toHaveLength(2);
    expect(r.body.addresses).toHaveLength(1);
    const receiver = r.body.contacts.find((c: any) => c.isReceiver);
    expect(r.body.addresses[0].receiverContactId).toBe(receiver.id);
    expect(r.body.debt.balance).toBe(0);
    const r2 = await api("owner", "POST", "/api/v1/customers", customerBody({ name: "Quán Cà Phê B" }));
    expect(Number(r2.body.code.slice(3))).toBe(Number(r.body.code.slice(3)) + 1);
  });

  it("masks PII for warehouse but not manager", async () => {
    const created = await api("manager", "POST", "/api/v1/customers", customerBody({ name: "Khách PII" }));
    const id = created.body.id;
    const wh = await api("warehouse", "GET", `/api/v1/customers/${id}`);
    expect(wh.status).toBe(200);
    expect(wh.body.phone).toBe("090****567");
    expect(wh.body.email).toBe("***");
    expect(wh.body.contacts[1].phone).toBe("092****444");
    const mg = await api("manager", "GET", `/api/v1/customers/${id}`);
    expect(mg.body.phone).toBe("0901234567");
    const list = await api("warehouse", "GET", "/api/v1/customers?type=b2b&q=PII");
    expect(list.body.items[0].phone).toBe("090****567");
    expect(list.body.items[0].debt).toEqual({ balance: 0, overdueAmount: 0 });
    expect((await api("cashier", "GET", "/api/v1/customers")).status).toBe(403);
  });

  it("updates with optimistic locking and audits credit limit changes", async () => {
    const c = (await api("manager", "POST", "/api/v1/customers", customerBody({ name: "Khách sửa" }))).body;
    const ok = await api("manager", "PUT", `/api/v1/customers/${c.id}`, { version: c.version, creditLimit: 20_000_000, creditReason: "Khách tăng đơn đều" });
    expect(ok.status).toBe(200);
    expect(ok.body.creditLimit).toBe(20_000_000);
    expect(ok.body.version).toBe(c.version + 1);
    const stale = await api("manager", "PUT", `/api/v1/customers/${c.id}`, { version: c.version, name: "X" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    const a = await db().prepare(`SELECT before_json b, after_json a FROM audit_log WHERE action='customer.update' AND entity_id=?`).bind(String(c.id)).first<any>();
    expect(JSON.parse(a.b).credit_limit).toBe(10_000_000);
    expect(JSON.parse(a.a).credit_limit).toBe(20_000_000);
  });

  it("cannot remove the last address or last receiver", async () => {
    const c = (await api("manager", "POST", "/api/v1/customers", customerBody({ name: "Khách ràng buộc" }))).body;
    const r = await api("manager", "PUT", `/api/v1/customers/${c.id}/addresses/${c.addresses[0].id}`, { active: false });
    expect(r.status).toBe(422);
    const recv = c.contacts.find((x: any) => x.isReceiver);
    const r2 = await api("manager", "PUT", `/api/v1/customers/${c.id}/contacts/${recv.id}`, { isReceiver: false });
    expect(r2.status).toBe(422);
    const add = await api("manager", "POST", `/api/v1/customers/${c.id}/addresses`, { label: "Kho 2", address: "99 Pasteur", isDefault: true });
    expect(add.status).toBe(201);
    expect(add.body.addresses.filter((a: any) => a.isDefault)).toHaveLength(1);
  });

  it("customer-specific price beats group price (EC-13)", async () => {
    const c = (await api("manager", "POST", "/api/v1/customers", customerBody({ name: "Khách giá riêng", customerGroupId: 2 }))).body;
    const quote = (price?: number) => api("manager", "POST", "/api/v1/quotes", { customerId: c.id, lines: [{ productId: 820, unit: "kg", qty: 10 }] }).then((r) => r.body.lines[0]);
    expect((await quote()).listPrice).toBe(45000); // giá nhóm > giá chung
    const put = await api("manager", "PUT", `/api/v1/customers/${c.id}/prices`, { items: [{ productId: 820, unitPrice: 40000 }] });
    expect(put.status).toBe(200);
    expect((await quote()).listPrice).toBe(40000); // giá riêng > giá nhóm
    const detail = await api("manager", "GET", `/api/v1/customers/${c.id}`);
    expect(detail.body.priceListId).toBe(put.body.priceListId);
    // đổi giá lần nữa giữ lịch sử
    await api("manager", "PUT", `/api/v1/customers/${c.id}/prices`, { items: [{ productId: 820, unitPrice: 38000 }] });
    expect((await quote()).listPrice).toBe(38000);
    const hist = await db().prepare(`SELECT COUNT(*) n FROM prices WHERE price_list_id=? AND product_id=820`).bind(put.body.priceListId).first<{ n: number }>();
    expect(hist!.n).toBe(2);
    // khách khác cùng nhóm không bị ảnh hưởng
    const other = (await api("manager", "POST", "/api/v1/customers", customerBody({ name: "Khách nhóm", customerGroupId: 2 }))).body;
    const q2 = await api("manager", "POST", "/api/v1/quotes", { customerId: other.id, lines: [{ productId: 820, unit: "kg", qty: 1 }] });
    expect(q2.body.lines[0].listPrice).toBe(45000);
  });

  it("returns history with monthly revenue and debt", async () => {
    const c = (await api("manager", "POST", "/api/v1/customers", customerBody({ name: "Khách lịch sử" }))).body;
    await db().prepare(`INSERT INTO invoices(code, customer_id, issue_date, due_date, subtotal, total) VALUES ('HIST-1',?,?,?,1000000,1000000),('HIST-2',?,?,?,500000,500000)`)
      .bind(c.id, "2026-10-05", "2026-10-20", c.id, "2026-11-05", "2026-11-20").run();
    const h = await api("manager", "GET", `/api/v1/customers/${c.id}/history`);
    expect(h.status).toBe(200);
    expect(h.body.revenueByMonth).toEqual([{ month: "2026-10", revenue: 1000000 }, { month: "2026-11", revenue: 500000 }]);
    expect(h.body.invoices).toHaveLength(2);
    expect(h.body.debt.outstanding).toBe(1500000);
  });
});

describe("customer groups + customer price quote", () => {
  it("lists customer groups and quotes the customer-specific price", async () => {
    const { api, testEnv } = await import("./helpers");
    const g = await api("manager", "GET", "/api/v1/customer-groups");
    expect(g.status).toBe(200);
    expect(g.body.items.length).toBeGreaterThan(0);
    const db = testEnv.DB;
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO products(id, sku, name, base_unit) VALUES (9100,'QT-1','Quote test','kg')`),
      db.prepare(`INSERT OR IGNORE INTO customers(id, code, type, name) VALUES (9100,'KH-Q','b2b','Quote KH')`),
      db.prepare(`INSERT INTO price_lists(id, name, channel, kind, priority, customer_id) VALUES (9100,'Riêng KH-Q','b2b','customer',100,9100)`),
      db.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, created_by) VALUES (1,9100,50000,'2020-01-01T00:00:00Z',1),(9100,9100,42000,'2020-01-01T00:00:00Z',1)`),
    ]);
    const a = await api("manager", "GET", "/api/v1/prices/quote?productId=9100&channel=b2b");
    const b = await api("manager", "GET", "/api/v1/prices/quote?productId=9100&channel=b2b&customerId=9100");
    expect(a.body.unitPrice).toBe(50000);
    expect(b.body.unitPrice).toBe(42000);
  });
});
