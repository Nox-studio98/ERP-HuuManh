import { beforeAll, describe, expect, it } from "vitest";
import { call, lot, register, seedShop, testEnv, tomorrow, uuid } from "./shop-helpers";

const db = () => testEnv.DB;
let b2bCustomer = 0;
let b2bAddr = 0;
let poorCustomer = 0;
let poorAddr = 0;

async function makeB2bCustomer(code: string, name: string, creditLimit: number) {
  const r = await db().prepare(`INSERT INTO customers(code, type, name, customer_group_id, credit_limit, payment_terms_days, created_at) VALUES (?, 'b2b', ?, 2, ?, 15, ?)`).bind(code, name, creditLimit, new Date().toISOString()).run();
  const id = r.meta.last_row_id as number;
  const a = await db().prepare(`INSERT INTO customer_addresses(customer_id, label, address, is_default) VALUES (?, 'Kho', '1 Lê Lợi, Quận 1', 1)`).bind(id).run();
  return { id, addr: a.meta.last_row_id as number };
}

beforeAll(async () => {
  await seedShop();
  await db().batch([
    db().prepare(`INSERT INTO price_lists(id, name, channel, kind, priority, customer_group_id) VALUES (20,'Sỉ cấp 1','b2b','group',10,2)`),
    db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (20,901,40000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
  const rich = await makeB2bCustomer("B2B-SHOP-1", "Công ty Trái Cây A", 100_000_000);
  b2bCustomer = rich.id;
  b2bAddr = rich.addr;
  const poor = await makeB2bCustomer("B2B-SHOP-2", "Cửa hàng B", 0);
  poorCustomer = poor.id;
  poorAddr = poor.addr;
});

const approve = (accountId: number, customerId: number) =>
  db().prepare(`UPDATE shop_accounts SET customer_id=?, kind='b2b', b2b_status='approved' WHERE id=?`).bind(customerId, accountId).run();

const order = (headers: Record<string, string>, over: Record<string, unknown> = {}) =>
  call("POST", "/api/b2b/orders", { clientUuid: uuid(), addressId: b2bAddr, deliveryDate: tomorrow(), lines: [{ productId: 901, unit: "thung", qty: 2 }], ...over }, { headers });

describe("B2B from the shop", () => {
  it("rejects retail, pending and rejected accounts with 403", async () => {
    const s = await register("retail-b2b@example.com", "Matkhau-123", "0910000001");
    for (const [m, p] of [["GET", "/api/b2b/catalog"], ["POST", "/api/b2b/orders"], ["GET", "/api/b2b/addresses"]] as const)
      expect((await call(m, p, m === "POST" ? {} : undefined, { headers: s.headers })).status).toBe(403);
    expect((await call("GET", "/api/b2b/catalog")).status).toBe(401);
    await db().prepare(`UPDATE shop_accounts SET kind='b2b', b2b_status='pending' WHERE id=?`).bind(s.account.id).run();
    expect((await call("GET", "/api/b2b/catalog", undefined, { headers: s.headers })).status).toBe(403);
    await db().prepare(`UPDATE shop_accounts SET b2b_status='rejected' WHERE id=?`).bind(s.account.id).run();
    expect((await order(s.headers)).status).toBe(403);
  });

  it("link-request sets pending and files an approval for the ERP; cannot repeat", async () => {
    const s = await register("link@example.com", "Matkhau-123", "0910000002");
    const r = await call("POST", "/api/b2b/link-request", { companyName: "Công ty Z", taxCode: "0312345678", note: "Khách cũ" }, { headers: s.headers });
    expect(r.status).toBe(201);
    expect((await call("GET", "/api/me", undefined, { headers: s.headers })).body.b2bStatus).toBe("pending");
    const ap = await db().prepare(`SELECT type, ref_type, ref_id, status, payload_json FROM approvals WHERE type='shop.b2b_link' AND ref_id=?`).bind(String(s.account.id)).first<any>();
    expect(ap).toMatchObject({ ref_type: "shop_account", status: "pending" });
    expect(JSON.parse(ap.payload_json)).toMatchObject({ accountId: s.account.id, companyName: "Công ty Z", taxCode: "0312345678" });
    const again = await call("POST", "/api/b2b/link-request", { companyName: "Công ty Z", taxCode: "0312345678" }, { headers: s.headers });
    expect(again.status).toBe(409);
    expect((await call("POST", "/api/b2b/link-request", { companyName: "", taxCode: "1" }, { headers: s.headers })).status).toBe(422);
  });

  it("approved account sees the b2b catalog with b2b prices, masked stock and credit status", async () => {
    const s = await register("catalog-b2b@example.com", "Matkhau-123", "0910000003");
    await approve(s.account.id, b2bCustomer);
    const r = await call("GET", "/api/b2b/catalog", undefined, { headers: s.headers });
    expect(r.status).toBe(200);
    const cam = r.body.items.find((p: any) => p.id === 901);
    expect(cam).toMatchObject({ price: 40000, availableMilli: 99000, slug: "cam-sanh" });
    expect(r.body.items.find((p: any) => p.id === 902).price).toBe(200000); // không có giá sỉ riêng → giá chung
    expect(r.body.creditStatus).toMatchObject({ creditLimit: 100_000_000, balance: 0, available: 100_000_000, overdue: false });
    expect((await call("GET", "/api/products/cam-sanh")).body.price).toBe(50000); // catalog công khai vẫn là giá online
    const addrs = await call("GET", "/api/b2b/addresses", undefined, { headers: s.headers });
    expect(addrs.body.items[0]).toMatchObject({ id: b2bAddr, isDefault: true });
  });

  it("places a quick order via createB2bOrder + confirmOrderFlow, idempotent, visible in /me/orders", async () => {
    const s = await register("order-b2b@example.com", "Matkhau-123", "0910000004");
    await approve(s.account.id, b2bCustomer);
    const before = await lot(901);
    const body = { clientUuid: uuid(), addressId: b2bAddr, deliveryDate: tomorrow(), lines: [{ productId: 901, unit: "thung", qty: 2 }], note: "Giao sớm" };
    const r = await call("POST", "/api/b2b/orders", body, { headers: s.headers });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^DS-\d{8}-\d{4}$/);
    expect(r.body).toMatchObject({ status: "confirmed", subtotal: 800000, total: 800000, slotDate: tomorrow(), shipAddress: "1 Lê Lợi, Quận 1", paymentMethod: "credit", canCancel: false });
    expect(r.body.lines[0]).toMatchObject({ productId: 901, unit: "thung", orderedQty: 2, unitPrice: 40000, lineTotal: 800000 });
    expect((await lot(901)).r).toBe(before.r + 20000);
    const row = await db().prepare(`SELECT channel, customer_id, created_by FROM orders WHERE code=?`).bind(r.body.code).first<any>();
    expect(row).toMatchObject({ channel: "b2b", customer_id: b2bCustomer, created_by: 1 });
    const replay = await call("POST", "/api/b2b/orders", body, { headers: s.headers });
    expect(replay.status).toBe(200);
    expect(replay.body.code).toBe(r.body.code);
    expect((await lot(901)).r).toBe(before.r + 20000);
    const mine = await call("GET", "/api/me/orders", undefined, { headers: s.headers });
    expect(mine.body.map((o: any) => o.code)).toContain(r.body.code);
    expect((await call("GET", `/api/me/orders/${r.body.code}`, undefined, { headers: s.headers })).status).toBe(200);
    // khách thường không thấy đơn sỉ; shop không cho huỷ đơn sỉ
    const other = await register("order-other@example.com", "Matkhau-123", "0910000005");
    expect((await call("GET", `/api/me/orders/${r.body.code}`, undefined, { headers: other.headers })).status).toBe(404);
    expect((await call("POST", `/api/me/orders/${r.body.code}/cancel`, undefined, { headers: s.headers })).status).toBe(409);
    // người khác không thể phát lại bằng clientUuid của đơn này
    const s2 = await register("order-b2b2@example.com", "Matkhau-123", "0910000006");
    await approve(s2.account.id, poorCustomer);
    expect((await call("POST", "/api/b2b/orders", { ...body, addressId: poorAddr }, { headers: s2.headers })).status).toBe(409);
  });

  it("cannot override credit from the shop: over-limit gives 409 credit_blocked and an approval, no reservation", async () => {
    const s = await register("poor-b2b@example.com", "Matkhau-123", "0910000007");
    await approve(s.account.id, poorCustomer);
    const before = await lot(901);
    const r = await call("POST", "/api/b2b/orders", { clientUuid: uuid(), addressId: poorAddr, deliveryDate: tomorrow(), lines: [{ productId: 901, unit: "kg", qty: 5 }], creditOverrideApprovalId: 1, unitPrice: 1 }, { headers: s.headers });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("credit_blocked");
    expect(r.body.error.details.reasons).toContain("over_limit");
    expect((await lot(901)).r).toBe(before.r);
    const ord = await db().prepare(`SELECT status, total, credit_override_approval_id FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 1`).bind(poorCustomer).first<any>();
    expect(ord).toMatchObject({ status: "new", total: 200000, credit_override_approval_id: null }); // vẫn giá sỉ 40000 × 5, không bị đổi giá
    // địa chỉ của khách khác bị từ chối
    expect((await order(s.headers, { addressId: b2bAddr })).status).toBe(422);
  });
});
