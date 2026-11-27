import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";

beforeAll(seedBase);

const mk = (sku: string) => api("manager", "POST", "/api/v1/products", { sku, name: `Hàng ${sku}`, baseUnit: "kg", sellByWeight: false, groupId: 1, units: [] });

describe("GET /products — trường bổ sung cho màn POS", () => {
  it("trả groupId và imageUrl (ảnh đầu tiên; chưa có ảnh → null)", async () => {
    const a = await mk("POSFE-A");
    const b = await mk("POSFE-B");
    await testEnv.DB.prepare(`UPDATE products SET images_json = ? WHERE id = ?`).bind(JSON.stringify(["products/1/a.webp", "products/1/b.webp"]), a.body.id).run();
    await testEnv.DB.prepare(`UPDATE products SET images_json = ? WHERE id = ?`).bind("không phải json", b.body.id).run();
    const r = await api("cashier", "GET", "/api/v1/products?q=POSFE-");
    const ia = r.body.items.find((x: any) => x.id === a.body.id), ib = r.body.items.find((x: any) => x.id === b.body.id);
    expect(ia.imageUrl).toBe("/img/products/1/a.webp");
    expect(ia.groupId).toBe(1);
    expect(ib.imageUrl).toBeNull();
  });

  it("ids= chỉ lấy đúng các mã yêu cầu; ids rỗng/sai → không có kết quả; không có ids → như cũ", async () => {
    const a = await mk("POSFE-C");
    await mk("POSFE-D");
    const r = await api("cashier", "GET", `/api/v1/products?ids=${a.body.id}`);
    expect(r.body.items.map((x: any) => x.id)).toEqual([a.body.id]);
    expect((await api("cashier", "GET", "/api/v1/products?ids=abc")).body.items).toEqual([]);
    expect((await api("cashier", "GET", "/api/v1/products?q=POSFE-")).body.items.length).toBeGreaterThanOrEqual(2);
  });
});
