import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

beforeAll(seedBase);

const body = (sku: string, extra: any = {}) => ({
  sku, name: `Hàng ${sku}`, baseUnit: "kg", sellByWeight: true, groupId: 1,
  units: [{ unit: "thung", factorMilli: 10000, barcode: `U-${sku}` }], ...extra,
});

describe("products", () => {
  it("creates product with units and auto internal barcode", async () => {
    const r = await api("manager", "POST", "/api/v1/products", body("CAM-UC"));
    expect(r.status).toBe(201);
    expect(r.body.barcode).toBe(`HMP${String(r.body.id).padStart(8, "0")}`);
    const units = r.body.units.map((u: any) => [u.unit, u.factorMilli]);
    expect(units).toContainEqual(["kg", 1000]); // đơn vị chính tự thêm
    expect(units).toContainEqual(["thung", 10000]);
    const dup = await api("manager", "POST", "/api/v1/products", body("CAM-UC"));
    expect(dup.status).toBe(409);
    const own = await api("manager", "POST", "/api/v1/products", body("NHO-MY", { barcode: "8931234567890", units: [] }));
    expect(own.body.barcode).toBe("8931234567890");
  });

  it("rejects invalid input and forbids cashier from writing", async () => {
    expect((await api("manager", "POST", "/api/v1/products", { sku: "" })).status).toBe(422);
    expect((await api("cashier", "POST", "/api/v1/products", body("X1"))).status).toBe(403);
    expect((await api("cashier", "GET", "/api/v1/products")).status).toBe(200);
  });

  it("looks up by product barcode, unit barcode, lot code and logs scan events", async () => {
    const p = await api("manager", "POST", "/api/v1/products", body("XOAI-CAT"));
    const byUnit = await api("cashier", "GET", "/api/v1/products/lookup?code=U-XOAI-CAT");
    expect(byUnit.status).toBe(200);
    expect(byUnit.body.product.id).toBe(p.body.id);
    expect(byUnit.body.unit).toMatchObject({ unit: "thung", factorMilli: 10000 });
    const byBarcode = await api("cashier", "GET", `/api/v1/products/lookup?code=${p.body.barcode}`);
    expect(byBarcode.body.product.sku).toBe("XOAI-CAT");

    const past = new Date(Date.now() - 86400_000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES ('HML-OLD',?,1,?,?,1000,1000,1000)`,
    ).bind(p.body.id, past, past).run();
    const lot = await api("manager", "GET", "/api/v1/products/lookup?code=HML-OLD");
    expect(lot.body.lot.expired).toBe(true);
    expect((await api("cashier", "GET", "/api/v1/products/lookup?code=HML-OLD")).body.lot.unitCost).toBeUndefined();

    const unk = await api("cashier", "GET", "/api/v1/products/lookup?code=NOPE");
    expect(unk.status).toBe(404);
    expect(unk.body.error.code).toBe("unknown_code");
    const ev = await testEnv.DB.prepare(`SELECT result FROM scan_events ORDER BY id`).all<{ result: string }>();
    expect(ev.results.map((e) => e.result)).toContain("unknown");
    expect(ev.results.map((e) => e.result)).toContain("expired");
  });

  it("uses optimistic locking on PUT", async () => {
    const p = await api("manager", "POST", "/api/v1/products", body("DUA-HAU"));
    const upd = { ...body("DUA-HAU", { name: "Dưa hấu ruột đỏ" }), version: p.body.version };
    const ok = await api("manager", "PUT", `/api/v1/products/${p.body.id}`, upd);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(p.body.version + 1);
    expect(ok.body.name).toBe("Dưa hấu ruột đỏ");
    const stale = await api("manager", "PUT", `/api/v1/products/${p.body.id}`, upd);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });

  it("lists products with availability, hides cost for cashier", async () => {
    const p = await api("manager", "POST", "/api/v1/products", body("LE-HUONG"));
    const exp = new Date(Date.now() + 5 * 86400_000).toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO lots(lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli, qty_reserved_milli) VALUES ('HML-LE',?,1,?,?,40000,5000,5000,1000)`,
    ).bind(p.body.id, exp, exp).run();
    const m = await api("manager", "GET", "/api/v1/products?q=LE-HUONG");
    expect(m.body.items[0].availableMilli).toBe(4000);
    expect(m.body.items[0].avgCost).toBe(40000);
    const c = await api("cashier", "GET", "/api/v1/products?q=LE-HUONG");
    expect(c.body.items[0].avgCost).toBeUndefined();
    const detail = await api("manager", "GET", `/api/v1/products/${p.body.id}`);
    expect(detail.body.lots).toHaveLength(1);
  });

  it("manages groups, suppliers, locations", async () => {
    expect((await api("manager", "POST", "/api/v1/product-groups", { name: "Trái cây sấy" })).status).toBe(201);
    expect((await api("cashier", "POST", "/api/v1/product-groups", { name: "Z" })).status).toBe(403);
    const s = await api("warehouse", "POST", "/api/v1/suppliers", { name: "Vườn Ông Ba" });
    expect(s.status).toBe(201);
    expect(s.body.code).toMatch(/^NCC-/);
    const u = await api("warehouse", "PUT", `/api/v1/suppliers/${s.body.id}`, { name: "Vườn Ông Ba 2", paymentTermsDays: 7 });
    expect(u.body.paymentTermsDays).toBe(7);
    expect((await api("cashier", "GET", "/api/v1/locations")).body.items).toHaveLength(2);
  });
});
