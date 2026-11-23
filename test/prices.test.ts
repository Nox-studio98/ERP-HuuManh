import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { ROLE_PERMS } from "../src/worker/lib/rbac";
import { activatePrice, rejectPrice } from "../src/worker/routes/prices";

beforeAll(seedBase);
const V = "/api/v1";

async function mkProduct(sku: string) {
  const r = await api("manager", "POST", `${V}/products`, { sku, name: sku, baseUnit: "kg", sellByWeight: true });
  return r.body.id as number;
}
const ctx = (userId: number) =>
  ({ env: testEnv, get: (k: string) => (k === "user" ? { id: userId, role: "manager", deviceId: null } : "r"), req: { header: () => undefined } }) as any;

describe("price lists & bulk", () => {
  it("bulk update keeps history: old row gets effective_to, new row active", async () => {
    const pid = await mkProduct("GIA-1");
    const first = await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: pid, unitPrice: 50000 }] });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("active");
    await new Promise((r) => setTimeout(r, 5));
    const second = await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: pid, unitPrice: 55000 }], note: "Tăng giá" });
    expect(second.body.priceIds).toHaveLength(1);
    const rows = await testEnv.DB.prepare(`SELECT unit_price, effective_from, effective_to, status FROM prices WHERE product_id=? ORDER BY id`).bind(pid).all<any>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].unit_price).toBe(50000); // giá cũ không bị sửa
    expect(rows.results[0].effective_to).toBe(rows.results[1].effective_from);
    expect(rows.results[1].effective_to).toBeNull();
    const cur = await api("cashier", "GET", `${V}/prices?productId=${pid}&priceListId=1`);
    expect(cur.body.items.map((p: any) => p.unitPrice)).toEqual([55000]);
    const hist = await api("manager", "GET", `${V}/prices/history?productId=${pid}`);
    expect(hist.body.sell).toHaveLength(2);
    expect(hist.body.purchases).toEqual([]);
    expect((await api("cashier", "GET", `${V}/prices/history?productId=${pid}`)).body.purchases).toBeUndefined();
  });

  it("creates pending prices + approvals when creator lacks prices.approve; approve activates", async () => {
    const pid = await mkProduct("GIA-2");
    await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: pid, unitPrice: 30000 }] });
    // Ma trận quyền hiện không có vai trò nào có prices.write mà thiếu prices.approve -> cấp tạm cho kế toán trong test
    (ROLE_PERMS.accountant as Set<string>).add("prices.write");
    let res;
    try {
      res = await api("accountant", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: pid, unitPrice: 33000 }], note: "Giá mới" });
    } finally {
      (ROLE_PERMS.accountant as Set<string>).delete("prices.write");
    }
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    const priceId = res.body.priceIds[0];
    const ap = await testEnv.DB.prepare(`SELECT * FROM approvals WHERE type='price.activate' AND ref_id=?`).bind(String(priceId)).first<any>();
    expect(ap).toMatchObject({ ref_type: "price", status: "pending" });
    // chưa hiệu lực
    expect((await api("cashier", "GET", `${V}/prices/quote?productId=${pid}`)).body.unitPrice).toBe(30000);
    expect((await api("cashier", "GET", `${V}/prices?status=pending`)).body.items.some((p: any) => p.id === priceId)).toBe(true);
    const ok = await api("manager", "POST", `${V}/prices/${priceId}/approve`, {});
    expect(ok.body.status).toBe("active");
    const ap2 = await testEnv.DB.prepare(`SELECT status FROM approvals WHERE id=?`).bind(ap.id).first<any>();
    expect(ap2.status).toBe("approved");
    expect((await api("cashier", "GET", `${V}/prices/quote?productId=${pid}`)).body.unitPrice).toBe(33000);
  });

  it("approve/reject endpoints and exported activatePrice/rejectPrice", async () => {
    const pid = await mkProduct("GIA-3");
    await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: pid, unitPrice: 20000 }] });
    const db = testEnv.DB;
    const from = new Date(Date.now() + 1000).toISOString();
    const ins = await db.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,25000,?,'pending',3)`).bind(pid, from).run();
    const priceId = ins.meta.last_row_id as number;
    const ap = await api("manager", "POST", `${V}/prices/${priceId}/approve`, {});
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe("active");
    const old = await db.prepare(`SELECT effective_to FROM prices WHERE product_id=? ORDER BY id LIMIT 1`).bind(pid).first<any>();
    expect(old.effective_to).toBeTruthy();
    // đã duyệt thì không duyệt lại
    expect((await api("manager", "POST", `${V}/prices/${priceId}/approve`, {})).status).toBe(409);
    expect((await api("cashier", "POST", `${V}/prices/${priceId}/approve`, {})).status).toBe(403);

    const ins2 = await db.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,99,?,'pending',3)`).bind(pid, from).run();
    const rej = await rejectPrice(ctx(2), ins2.meta.last_row_id as number, 2, "sai giá");
    expect((rej as any).status).toBe("rejected");
    const ins3 = await db.prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,?,27000,?,'pending',3)`).bind(pid, from).run();
    const act = await activatePrice(ctx(2), ins3.meta.last_row_id as number, 2);
    expect((act as any).status).toBe("active");
  });

  it("flags below-cost prices and lists suggested price from avg cost", async () => {
    const pid = await mkProduct("GIA-4");
    const exp = new Date(Date.now() + 5 * 86400_000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES ('HML-G4',?,1,?,?,40000,1000,1000)`,
    ).bind(pid, exp, exp).run();
    const r = await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: pid, unitPrice: 35000 }] });
    expect(r.body.belowCost).toEqual([pid]);
    const sug = await api("manager", "GET", `${V}/prices/suggested`);
    const item = sug.body.items.find((i: any) => i.productId === pid);
    expect(item).toMatchObject({ avgCost: 40000, targetMarginBp: 3000, suggestedPrice: 52000, currentPrice: 35000 });
    expect((await api("cashier", "GET", `${V}/prices/suggested`)).status).toBe(403);
  });

  it("quote picks the higher-priority list, respects channel and customer group", async () => {
    const pid = await mkProduct("GIA-5");
    await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: pid, unitPrice: 60000 }] });
    const promo = await api("manager", "POST", `${V}/price-lists`, { name: "KM cuối tuần", channel: "pos", kind: "promo", priority: 20 });
    const si = await api("manager", "POST", `${V}/price-lists`, { name: "Sỉ 1", channel: "all", kind: "group", priority: 10, customerGroupId: 2 });
    expect(promo.status).toBe(201);
    await api("manager", "POST", `${V}/prices/bulk`, { priceListId: si.body.id, items: [{ productId: pid, unitPrice: 50000 }] });
    const q1 = await api("cashier", "GET", `${V}/prices/quote?productId=${pid}&channel=pos`);
    expect(q1.body).toMatchObject({ unitPrice: 60000, priceListId: 1 });
    const q2 = await api("cashier", "GET", `${V}/prices/quote?productId=${pid}&channel=pos&customerGroupId=2`);
    expect(q2.body).toMatchObject({ unitPrice: 50000, priceListId: si.body.id });
    await api("manager", "POST", `${V}/prices/bulk`, { priceListId: promo.body.id, items: [{ productId: pid, unitPrice: 45000 }] });
    const q3 = await api("cashier", "GET", `${V}/prices/quote?productId=${pid}&channel=pos&customerGroupId=2`);
    expect(q3.body).toMatchObject({ unitPrice: 45000, priceListId: promo.body.id });
    const q4 = await api("cashier", "GET", `${V}/prices/quote?productId=${pid}&channel=online`);
    expect(q4.body.unitPrice).toBe(60000); // KM chỉ kênh pos
    const lists = await api("cashier", "GET", `${V}/price-lists`);
    expect(lists.body.items[0].priority).toBe(20);
  });

  it("validates bulk input and permissions", async () => {
    expect((await api("cashier", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: 1, unitPrice: 1 }] })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [] })).status).toBe(422);
    expect((await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 999, items: [{ productId: 1, unitPrice: 5 }] })).status).toBe(422);
    expect((await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: 99999, unitPrice: 5 }] })).status).toBe(422);
    expect((await api("manager", "POST", `${V}/prices/bulk`, { priceListId: 1, items: [{ productId: 1, unitPrice: -5 }] })).status).toBe(422);
  });
});
