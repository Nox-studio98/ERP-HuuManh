import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
let cust = 0;
let addr = 0;

beforeAll(async () => {
  await seedBase();
  const d = db();
  const exp = new Date(Date.now() + 20 * 86400_000).toISOString();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (830,'Q830','Cam sành','kg')`),
    d.prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (830,'thung',10000)`),
    d.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (830,'LOT-Q830',830,1,?,?,40000,100000,100000)`).bind(new Date().toISOString(), exp),
    d.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,830,50000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
  const c = await api("owner", "POST", "/api/v1/customers", {
    name: "Khách báo giá", type: "b2b", customerGroupId: 1, creditLimit: 100_000_000, paymentTermsDays: 15,
    contacts: [{ name: "A", isReceiver: true }], addresses: [{ label: "Kho", address: "1 Trần Hưng Đạo", isDefault: true }],
  });
  cust = c.body.id;
  addr = c.body.addresses[0].id;
});

const mk = (lines: any[], extra: any = {}) => api("manager", "POST", "/api/v1/quotes", { customerId: cust, lines, ...extra });

describe("quotes", () => {
  it("creates a draft quote with list price default and margin visible to roles with cost permission", async () => {
    const r = await mk([{ productId: 830, unit: "thung", qty: 2 }]);
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^BG-\d{8}-\d{4}$/);
    expect(r.body.status).toBe("draft");
    expect(r.body.validUntil).toBe(addDays(vnDate(), 7));
    const l = r.body.lines[0];
    expect(l).toMatchObject({ qty: 2, qtyMilli: 20000, listPrice: 50000, unitPrice: 50000, costAtQuote: 40000, marginBp: 2000 });
    expect(r.body.subtotal).toBe(1_000_000);
    const wh = await api("warehouse", "GET", `/api/v1/quotes/${r.body.id}`);
    expect(wh.status).toBe(200);
    expect(wh.body.lines[0].costAtQuote).toBeDefined(); // thủ kho có prices.view_cost
    const ac = await api("online_staff", "GET", `/api/v1/quotes/${r.body.id}`);
    expect(ac.body.lines[0].costAtQuote).toBeUndefined();
    expect((await api("cashier", "GET", "/api/v1/quotes")).status).toBe(403);
  });

  it("deep discount by an approver is auto-approved; a non-approver's request goes to pending_approval and is decided via /approvals", async () => {
    const r = await mk([{ productId: 830, unit: "kg", qty: 10, unitPrice: 30000 }]);
    expect(r.body.status).toBe("draft"); // quản lý có b2b.approve
    const row = await db().prepare(`SELECT approved_by FROM quotes WHERE id=?`).bind(r.body.id).first<any>();
    expect(row.approved_by).toBe(2);
    // người không có b2b.approve: mô phỏng bằng bản ghi pending + approval như route tạo ra
    const mkPending = async (code: string) => {
      const q = await db().prepare(`INSERT INTO quotes(code, customer_id, status, valid_from, valid_until, subtotal, created_by) VALUES (?,?, 'pending_approval', ?, ?, 0, 3)`)
        .bind(code, cust, vnDate(), addDays(vnDate(), 7)).run();
      const a = await db().prepare(`INSERT INTO approvals(type, ref_type, ref_id, payload_json, reason, requested_by) VALUES ('quote.approve','quote',?, '{}','discount',3)`)
        .bind(String(q.meta.last_row_id)).run();
      return { quoteId: q.meta.last_row_id as number, approvalId: a.meta.last_row_id as number };
    };
    const p1 = await mkPending("BG-T-1");
    expect((await api("manager", "POST", `/api/v1/quotes/${p1.quoteId}/send`)).status).toBe(409);
    const dec = await api("manager", "POST", `/api/v1/approvals/${p1.approvalId}/decide`, { decision: "approved" });
    expect(dec.status).toBe(200);
    expect((await api("manager", "GET", `/api/v1/quotes/${p1.quoteId}`)).body.status).toBe("draft");
    const p2 = await mkPending("BG-T-2");
    await api("manager", "POST", `/api/v1/approvals/${p2.approvalId}/decide`, { decision: "rejected" });
    expect((await api("manager", "GET", `/api/v1/quotes/${p2.quoteId}`)).body.status).toBe("cancelled");
  });

  it("sends a draft quote, shows expired once past validUntil and rejects convert with 409 quote_expired", async () => {
    const q = (await mk([{ productId: 830, unit: "kg", qty: 5 }])).body;
    const sent = await api("manager", "POST", `/api/v1/quotes/${q.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("sent");
    await db().prepare(`UPDATE quotes SET valid_until=? WHERE id=?`).bind(addDays(vnDate(), -1), q.id).run();
    const got = await api("manager", "GET", `/api/v1/quotes/${q.id}`);
    expect(got.body.status).toBe("expired");
    const list = await api("manager", "GET", `/api/v1/quotes?customerId=${cust}&status=expired`);
    expect(list.body.items.map((x: any) => x.id)).toContain(q.id);
    const conv = await api("manager", "POST", `/api/v1/quotes/${q.id}/convert`, { addressId: addr, deliveryDate: addDays(vnDate(), 1) });
    expect(conv.status).toBe(409);
    expect(conv.body.error.code).toBe("quote_expired");
  });

  it("extends an expired quote (reason required) and then converts it to a confirmed order with margin warnings (EC-12)", async () => {
    const q = (await mk([{ productId: 830, unit: "kg", qty: 5 }, { productId: 830, unit: "thung", qty: 1, unitPrice: 50000 }])).body;
    await api("manager", "POST", `/api/v1/quotes/${q.id}/send`);
    await db().prepare(`UPDATE quotes SET valid_until=? WHERE id=?`).bind(addDays(vnDate(), -2), q.id).run();
    expect((await api("manager", "POST", `/api/v1/quotes/${q.id}/extend`, { days: 5 })).status).toBe(422);
    const ext = await api("manager", "POST", `/api/v1/quotes/${q.id}/extend`, { days: 5, reason: "Khách xin thêm thời gian" });
    expect(ext.status).toBe(200);
    expect(ext.body.status).toBe("sent");
    expect(ext.body.validUntil).toBe(addDays(vnDate(), 5));
    // giá vốn tăng sau khi báo giá → biên âm, vẫn giữ giá báo nhưng cảnh báo
    await db().prepare(`UPDATE lots SET unit_cost = 60000 WHERE id = 830`).run();
    const conv = await api("manager", "POST", `/api/v1/quotes/${q.id}/convert`, { addressId: addr, deliveryDate: addDays(vnDate(), 1) });
    await db().prepare(`UPDATE lots SET unit_cost = 40000 WHERE id = 830`).run();
    expect(conv.status).toBe(201);
    expect(conv.body.status).toBe("confirmed");
    expect(conv.body.warnings[0]).toMatchObject({ productId: 830 });
    expect(conv.body.warnings[0].marginBp).toBeLessThan(0);
    expect(conv.body.lines[0].unitPrice).toBe(50000);
    expect((await api("manager", "GET", `/api/v1/quotes/${q.id}`)).body.status).toBe("accepted");
    // chuyển lần nữa (cùng clientUuid mặc định) là idempotent
    const again = await api("manager", "POST", `/api/v1/quotes/${q.id}/convert`, { addressId: addr, deliveryDate: addDays(vnDate(), 1) });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(conv.body.id);
  });

  it("order lines outside the quote are rejected with 422 and a quote can be cancelled", async () => {
    await db().prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (831,'Q831','Bưởi da xanh','kg')`).run();
    await db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,831,30000,'2020-01-01T00:00:00Z','active',1)`).run();
    const q = (await mk([{ productId: 830, unit: "kg", qty: 1 }])).body;
    const o = await api("manager", "POST", "/api/v1/b2b/orders", {
      customerId: cust, quoteId: q.id, addressId: addr, deliveryDate: addDays(vnDate(), 1), clientUuid: "quote-line-outside-1",
      lines: [{ productId: 831, unit: "kg", qty: 1 }],
    });
    expect(o.status).toBe(422);
    expect(o.body.error.code).toBe("line_not_in_quote");
    const c = await api("manager", "POST", `/api/v1/quotes/${q.id}/cancel`, { reason: "Khách huỷ" });
    expect(c.body.status).toBe("cancelled");
    expect((await api("manager", "PUT", `/api/v1/quotes/${q.id}`, { note: "x" })).status).toBe(409);
  });

  it("edits only draft quotes and re-prices lines", async () => {
    const q = (await mk([{ productId: 830, unit: "kg", qty: 1 }])).body;
    const u = await api("manager", "PUT", `/api/v1/quotes/${q.id}`, { lines: [{ productId: 830, unit: "kg", qty: 4 }] });
    expect(u.status).toBe(200);
    expect(u.body.subtotal).toBe(200000);
    expect(u.body.lines).toHaveLength(1);
  });
});
