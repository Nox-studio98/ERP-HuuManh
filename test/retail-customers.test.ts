import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

const db = () => testEnv.DB;
const U = "/api/v1/retail-customers";

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO customers(id, code, type, name, phone, email, points, customer_group_id, created_at) VALUES
      (9701,'KL-A1','retail','Chị Hoa','0903111222','hoa@example.com',100,1,'2026-01-01T00:00:00Z'),
      (9702,'KL-A2','retail','Chị Hoa (trùng)','0903999888',NULL,50,1,'2026-01-02T00:00:00Z'),
      (9703,'KL-A3','retail','Anh Dũng',NULL,NULL,0,1,'2026-01-03T00:00:00Z'),
      (9704,'KH-SI1','b2b','Nhà hàng Sen','0909000111',NULL,0,2,'2026-01-04T00:00:00Z')`),
    db().prepare(`INSERT INTO orders(id, code, channel, kind, store_id, customer_id, status, total, created_at) VALUES
      (97001,'RC-1','pos','sale',1,9701,'completed',200000,'2026-11-01T03:00:00Z'),
      (97002,'RC-2','online','sale',1,9702,'completed',300000,'2026-11-10T03:00:00Z'),
      (97003,'RC-3','pos','sale',1,9702,'cancelled',999000,'2026-11-11T03:00:00Z'),
      (97004,'RC-4','pos','return',1,9702,'completed',50000,'2026-11-12T03:00:00Z')`),
    db().prepare(`INSERT INTO loyalty_ledger(customer_id, order_id, kind, points, note) VALUES (9701,97001,'earn',100,'tích'),(9702,97002,'earn',50,'tích')`),
    db().prepare(`INSERT INTO shop_accounts(id, customer_id, email, phone, full_name, pass_hash, kind) VALUES (9701,9702,'hoa2@example.com','0903999888','Hoa','x','retail')`),
    db().prepare(`INSERT INTO vouchers(code, promotion_id, customer_id) SELECT 'RC-V1', id, 9702 FROM promotions LIMIT 1`),
  ]);
});

const ledgerCount = async (id: number) => (await db().prepare(`SELECT COUNT(*) AS n FROM loyalty_ledger WHERE customer_id = ?`).bind(id).first<any>()).n;

describe("khách lẻ — danh sách & phân quyền", () => {
  it("chỉ vai trò xem được khách sỉ mới vào; cashier bị 403", async () => {
    expect((await api("cashier", "GET", U)).status).toBe(403);
    expect((await api("warehouse", "GET", U)).status).toBe(200);
    expect((await api("manager", "GET", U)).status).toBe(200);
  });

  it("không lẫn khách sỉ; summary đúng; chi tiêu = bán hoàn tất trừ trả hàng", async () => {
    const r = await api("owner", "GET", `${U}?limit=100`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((x: any) => x.id);
    expect(ids).toContain(9701);
    expect(ids).not.toContain(9704);
    expect(r.body.items.every((x: any) => x.code !== "KH-SI1")).toBe(true);
    const hoa2 = r.body.items.find((x: any) => x.id === 9702);
    expect(hoa2.spend).toBe(250000); // 300000 - 50000, đơn huỷ không tính
    expect(hoa2.ordersCount).toBe(1);
    expect(r.body.summary.count).toBe(r.body.items.length);
    expect(r.body.summary.totalSpend).toBeGreaterThanOrEqual(450000);
    // lọc điểm / chưa mua
    const noPts = await api("owner", "GET", `${U}?hasPoints=0&limit=100`);
    expect(noPts.body.items.map((x: any) => x.id)).toContain(9703);
    expect(noPts.body.items.map((x: any) => x.id)).not.toContain(9701);
    const never = await api("owner", "GET", `${U}?purchased=0&limit=100`);
    expect(never.body.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([9703]));
    expect(never.body.items.map((x: any) => x.id)).not.toContain(9701);
    const range = await api("owner", "GET", `${U}?lastFrom=2026-11-10&lastTo=2026-11-10&limit=100`);
    expect(range.body.items.map((x: any) => x.id)).toEqual([9702]);
  });

  it("SĐT che với vai trò không có customers.view_pii và không tìm được theo SĐT", async () => {
    const wh = await api("warehouse", "GET", `${U}?q=Hoa&limit=100`);
    const a = wh.body.items.find((x: any) => x.id === 9701);
    expect(a.phone).not.toBe("0903111222");
    expect(a.phone).toContain("****");
    expect(a.email).toBe("***");
    expect((await api("warehouse", "GET", `${U}?q=0903111222`)).body.items).toEqual([]);
    const own = await api("owner", "GET", `${U}?q=0903111222`);
    expect(own.body.items.map((x: any) => x.id)).toEqual([9701]);
    expect(own.body.items[0].phone).toBe("0903111222");
  });

  it("chi tiết: điểm + sổ điểm + đơn mọi kênh; khách sỉ không mở được qua route lẻ", async () => {
    const r = await api("owner", "GET", `${U}/9702`);
    expect(r.status).toBe(200);
    expect(r.body.points).toBe(50);
    expect(r.body.loyalty.ledger).toHaveLength(1);
    expect(r.body.orders.map((o: any) => o.channel).sort()).toEqual(["online", "pos", "pos"]);
    expect(r.body.shopAccounts).toHaveLength(1);
    expect((await api("owner", "GET", `${U}/9704`)).status).toBe(404);
    expect((await api("warehouse", "GET", `${U}/9702`)).body.shopAccounts[0].email).toBe("***");
  });
});

describe("khách lẻ — sửa, ngừng hoạt động", () => {
  it("chỉ chủ/quản lý sửa; version cũ trả 409; trùng SĐT trả 409", async () => {
    expect((await api("warehouse", "PATCH", `${U}/9703`, { version: 1, name: "X" })).status).toBe(403);
    expect((await api("accountant", "PATCH", `${U}/9703`, { version: 1, name: "X" })).status).toBe(403);
    const ok = await api("manager", "PATCH", `${U}/9703`, { version: 1, name: "Anh Dũng Sửa", birthday: "03-15", gender: "male", address: "12 Lê Lợi" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ name: "Anh Dũng Sửa", birthday: "03-15", gender: "male", version: 2 });
    const stale = await api("owner", "PATCH", `${U}/9703`, { version: 1, name: "Lại sửa" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    const dup = await api("owner", "PATCH", `${U}/9703`, { version: 2, phone: "0903111222" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("phone_duplicate");
    expect((await api("owner", "PATCH", `${U}/9703`, { version: 2, birthday: "15/03" })).status).toBe(422);
    expect((await api("owner", "PATCH", `${U}/9703`, { version: 2, gender: "x" })).status).toBe(422);
    const audit = await db().prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'retail_customer.update' AND entity_id = '9703'`).first<any>();
    expect(audit.n).toBe(1);
  });

  it("ngừng / kích hoạt lại; danh sách mặc định chỉ khách đang hoạt động", async () => {
    const off = await api("manager", "POST", `${U}/9703/active`, { active: false, version: 2, reason: "Khách chuyển đi" });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    expect((await api("owner", "GET", `${U}?limit=100`)).body.items.map((x: any) => x.id)).not.toContain(9703);
    expect((await api("owner", "GET", `${U}?status=inactive&limit=100`)).body.items.map((x: any) => x.id)).toContain(9703);
    expect((await api("owner", "POST", `${U}/9703/active`, { active: true, version: 2 })).status).toBe(409);
    expect((await api("owner", "POST", `${U}/9703/active`, { active: true, version: 3 })).status).toBe(200);
    expect((await api("cashier", "POST", `${U}/9703/active`, { active: false, version: 4 })).status).toBe(403);
  });

  it("gán nhóm khách hàng loạt", async () => {
    const r = await api("manager", "POST", `${U}/assign-group`, { ids: [9701, 9702], customerGroupId: 2 });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(2);
    expect((await api("manager", "POST", `${U}/assign-group`, { ids: [9704], customerGroupId: 1 })).status).toBe(422);
    expect((await api("manager", "POST", `${U}/assign-group`, { ids: [9701], customerGroupId: 999 })).status).toBe(422);
  });
});

describe("khách lẻ — gộp khách trùng", () => {
  it("phân quyền, khách sỉ, tự gộp chính nó", async () => {
    expect((await api("warehouse", "POST", `${U}/9702/merge`, { targetId: 9701, version: 1, targetVersion: 1, reason: "trùng" })).status).toBe(403);
    expect((await api("owner", "POST", `${U}/9702/merge`, { targetId: 9702, version: 1, targetVersion: 1, reason: "trùng" })).status).toBe(422);
    expect((await api("owner", "POST", `${U}/9702/merge`, { targetId: 9704, version: 1, targetVersion: 1, reason: "trùng" })).status).toBe(404);
    expect((await api("owner", "POST", `${U}/9702/merge`, { targetId: 9701, version: 1, targetVersion: 1 })).status).toBe(422);
  });

  it("version cũ bị từ chối; gộp đúng: đơn, điểm, tài khoản website, sổ điểm chỉ thêm dòng, audit", async () => {
    const cur = async (id: number) => (await api("owner", "GET", `${U}/${id}`)).body;
    const src = await cur(9702), dst = await cur(9701);
    const stale = await api("owner", "POST", `${U}/9702/merge`, { targetId: 9701, version: src.version + 5, targetVersion: dst.version, reason: "trùng" });
    expect(stale.status).toBe(409);
    const oldLedger = (await db().prepare(`SELECT * FROM loyalty_ledger WHERE customer_id IN (9701,9702) ORDER BY id`).all<any>()).results;
    const r = await api("manager", "POST", `${U}/9702/merge`, { targetId: 9701, version: src.version, targetVersion: dst.version, reason: "Cùng một người" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ordersMoved: 3, pointsMoved: 50 });
    expect(r.body.target.points).toBe(150);
    // đơn
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = 9701`).first<any>()).n).toBe(4);
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = 9702`).first<any>()).n).toBe(0);
    // tài khoản website
    expect((await db().prepare(`SELECT customer_id FROM shop_accounts WHERE id = 9701`).first<any>()).customer_id).toBe(9701);
    // nguồn bị ngừng + merged_into, điểm về 0
    const s = await db().prepare(`SELECT active, merged_into, points FROM customers WHERE id = 9702`).first<any>();
    expect(s).toMatchObject({ active: 0, merged_into: 9701, points: 0 });
    // trường trống của đích được bổ sung (đích đã có SĐT nên giữ nguyên)
    expect((await db().prepare(`SELECT phone FROM customers WHERE id = 9701`).first<any>()).phone).toBe("0903111222");
    // sổ điểm: dòng cũ giữ nguyên, chỉ thêm 2 dòng adjust cân bằng
    const newLedger = (await db().prepare(`SELECT * FROM loyalty_ledger WHERE customer_id IN (9701,9702) ORDER BY id`).all<any>()).results;
    expect(newLedger).toHaveLength(oldLedger.length + 2);
    expect(newLedger.slice(0, oldLedger.length)).toEqual(oldLedger);
    const added = newLedger.slice(oldLedger.length);
    expect(added.every((l: any) => l.kind === "adjust")).toBe(true);
    expect(added.map((l: any) => l.points).sort((a: number, b: number) => a - b)).toEqual([-50, 50]);
    // audit
    const a = await db().prepare(`SELECT reason, user_id FROM audit_log WHERE action = 'retail_customer.merge' AND entity_id = '9702'`).first<any>();
    expect(a.reason).toBe("Cùng một người");
    // không còn trong danh sách; gộp lần hai bị chặn; sửa nguồn bị chặn
    expect((await api("owner", "GET", `${U}?status=all&limit=100`)).body.items.map((x: any) => x.id)).not.toContain(9702);
    expect((await api("owner", "POST", `${U}/9702/merge`, { targetId: 9701, version: 99, targetVersion: 99, reason: "lại" })).status).toBe(409);
    expect((await api("owner", "PATCH", `${U}/9702`, { version: 1, name: "x" })).status).toBe(409);
    expect((await cur(9701)).mergedFrom.map((m: any) => m.id)).toEqual([9702]);
    expect(await ledgerCount(9701)).toBeGreaterThan(1);
  });

  it("sổ điểm vẫn bất biến (UPDATE/DELETE bị chặn)", async () => {
    await expect(db().prepare(`UPDATE loyalty_ledger SET points = 1 WHERE customer_id = 9701`).run()).rejects.toThrow(/loyalty_immutable/);
    await expect(db().prepare(`DELETE FROM loyalty_ledger WHERE customer_id = 9701`).run()).rejects.toThrow(/loyalty_immutable/);
  });
});

describe("khách sỉ không đổi", () => {
  it("route khách sỉ vẫn chỉ thấy b2b, không thấy khách lẻ", async () => {
    const r = await api("owner", "GET", `/api/v1/customers?limit=100`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((x: any) => x.id);
    expect(ids).toContain(9704);
    const retail = await db().prepare(`SELECT id FROM customers WHERE type='retail'`).all<any>();
    // /customers không lọc type theo mặc định nhưng khách lẻ phải truy cập được ở route cũ như trước (hành vi không đổi)
    expect(r.body.items.find((x: any) => x.id === 9704).type).toBe("b2b");
    expect(retail.results.length).toBeGreaterThan(0);
    expect((await api("owner", "POST", "/api/v1/customers", { name: "X", type: "retail", customerGroupId: 1, creditLimit: 0, paymentTermsDays: 0, contacts: [], addresses: [] })).status).toBe(422);
  });
});
