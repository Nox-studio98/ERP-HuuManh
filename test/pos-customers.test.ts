import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

beforeAll(async () => {
  await seedBase();
  await testEnv.DB.prepare(`INSERT INTO customers(id, code, type, name, phone, points) VALUES (9601,'KL-T1','retail','Chị Lan','0901234567',120)`).run();
});

describe("POS — khách lẻ & mã khuyến mãi", () => {
  it("cashier can look up by name or phone suffix; phone is masked; short digit fragments do not list customers", async () => {
    const byName = await api("cashier", "GET", "/api/v1/pos/customers?q=Lan");
    expect(byName.status).toBe(200);
    expect(byName.body.items[0]).toMatchObject({ id: 9601, points: 120 });
    expect(byName.body.items[0].phone).not.toBe("0901234567");
    expect((await api("cashier", "GET", "/api/v1/pos/customers?q=4567")).body.items.some((x: any) => x.id === 9601)).toBe(true);
    expect((await api("cashier", "GET", "/api/v1/pos/customers?q=45")).body.items).toEqual([]);
  });

  it("cashier can create a retail customer; duplicate phone returns the existing one", async () => {
    const created = await api("cashier", "POST", "/api/v1/pos/customers", { name: "Anh Minh", phone: "0912 000 111" });
    expect(created.status).toBe(201);
    expect(created.body.type).toBe("retail");
    const dup = await api("cashier", "POST", "/api/v1/pos/customers", { name: "Khác", phone: "0912000111" });
    expect(dup.body).toMatchObject({ id: created.body.id, existing: true });
    expect((await api("warehouse", "POST", "/api/v1/pos/customers", { name: "X" })).status).toBe(403);
  });

  it("promotion code generation skips codes that already exist (e.g. seeded KM-0001)", async () => {
    await testEnv.DB.prepare(`INSERT OR IGNORE INTO promotions(code, name, kind, value_bp, starts_at, ends_at, created_by) VALUES ('KM-0001','seed','percent',500,'2026-01-01','2027-01-01',1)`).run();
    const body = { name: "Giảm 5%", kind: "percent", valueBp: 500, channels: ["pos"], startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2027-01-31T00:00:00.000Z" };
    const r = await api("manager", "POST", "/api/v1/promotions", body);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(r.body.code).not.toBe("KM-0001");
  });
});
