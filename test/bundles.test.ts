import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { lotQty, seedSales } from "./seed-sales";

const V = "/api/v1";
const db = () => testEnv.DB;
const BUNDLE = 31;

beforeAll(async () => {
  await seedBase();
  await seedSales();
  const exp3 = new Date(Date.now() + 3 * 86400_000).toISOString();
  const exp10 = new Date(Date.now() + 10 * 86400_000).toISOString();
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (31,'GIOQUA1','Giỏ quà Tết A','hop',1)`),
    // lô Táo thứ hai hết hạn sớm hơn lô 1 (FEFO phải lấy trước), lô Nho lô 2 giữ nguyên
    db().prepare(`UPDATE lots SET expires_at=? WHERE id IN (1,2)`).bind(exp10),
    db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (3,'LOT-TAO-2',1,1,?,?,70000,2000,2000)`).bind(new Date().toISOString(), exp3),
    db().prepare(`INSERT INTO prices(price_list_id, product_id, unit_price, effective_from, status, created_by) VALUES (1,31,250000,'2020-01-01T00:00:00Z','active',1)`),
  ]);
});

describe("thành phần giỏ quà", () => {
  it("chỉ người có products.write mới đặt được; GET trả danh sách thành phần", async () => {
    expect((await api("cashier", "PUT", `${V}/bundles/${BUNDLE}/components`, { components: [] })).status).toBe(403);
    const r = await api("manager", "PUT", `${V}/bundles/${BUNDLE}/components`, { components: [{ productId: 1, qty: 1.5 }, { productId: 2, qtyMilli: 500 }] });
    expect(r.status).toBe(200);
    expect(r.body.components).toHaveLength(2);
    const g = await api("manager", "GET", `${V}/bundles/${BUNDLE}/components`);
    expect(g.body.components.map((c: any) => [c.productId, c.qtyMilli])).toEqual([[1, 1500], [2, 500]]);
  });

  it("từ chối thành phần trùng, chính nó, hoặc không tồn tại", async () => {
    expect((await api("manager", "PUT", `${V}/bundles/${BUNDLE}/components`, { components: [{ productId: BUNDLE, qty: 1 }] })).status).toBe(422);
    expect((await api("manager", "PUT", `${V}/bundles/${BUNDLE}/components`, { components: [{ productId: 1, qty: 1 }, { productId: 1, qty: 2 }] })).status).toBe(422);
    expect((await api("manager", "PUT", `${V}/bundles/${BUNDLE}/components`, { components: [{ productId: 99999, qty: 1 }] })).status).toBe(404);
    expect((await api("manager", "GET", `${V}/bundles/${BUNDLE}/components`)).body.components).toHaveLength(2); // lỗi không làm mất dữ liệu cũ
  });
});

describe("đóng giỏ quà (assembly)", () => {
  let asm: any;

  it("thiếu thành phần → 409 insufficient_stock, không đổi tồn, không để lệnh posted", async () => {
    const t1 = await lotQty(1);
    const r = await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 1000, unit: "hop" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("insufficient_stock");
    expect(await lotQty(1)).toBe(t1);
    const n = await db().prepare(`SELECT COUNT(*) c FROM assembly_orders WHERE status='posted'`).first<{ c: number }>();
    expect(n!.c).toBe(0);
  });

  it("đóng 4 giỏ: FEFO thành phần, lô giỏ quà, giá vốn = Σ thành phần + chi phí phụ", async () => {
    const r = await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 4, unit: "hop", extraCost: 40000 });
    expect(r.status).toBe(201);
    asm = r.body;
    expect(asm.code).toMatch(/^LR-\d{8}-0001$/);
    expect(asm.status).toBe("posted");
    // cần 6kg Táo: 2kg lô hết hạn sớm (70k) + 4kg lô 1 (60k) = 380k; 2kg Nho × 150k = 300k; + 40k phụ = 720k / 4 giỏ
    expect(asm.unitCost).toBe(180000);
    expect(asm.qtyMilli).toBe(4000);
    expect(await lotQty(3)).toBe(0);
    expect(await lotQty(1)).toBe(20000 - 4000);
    expect(await lotQty(2)).toBe(5000 - 2000);
    expect(asm.components.map((c: any) => [c.lotId, c.qtyMilli, c.unitCost])).toEqual([[3, 2000, 70000], [1, 4000, 60000], [2, 2000, 150000]]);
    const lot = await db().prepare(`SELECT * FROM lots WHERE id=?`).bind(asm.lotId).first<any>();
    expect(lot).toMatchObject({ product_id: BUNDLE, unit_cost: 180000, qty_in_milli: 4000, qty_on_hand_milli: 4000, status: "active" });
    expect(lot.lot_code).toBe(`HML${String(lot.id).padStart(8, "0")}`);
    // hạn dùng giỏ = hạn sớm nhất của thành phần đã dùng (lô Táo hết hạn sau 3 ngày)
    expect(Date.parse(lot.expires_at)).toBeLessThan(Date.now() + 4 * 86400_000);
    const moves = (await db().prepare(`SELECT move_type, qty_delta_milli q FROM stock_moves WHERE ref_type='assembly_order' AND ref_id=? ORDER BY id`).bind(asm.id).all<any>()).results;
    expect(moves.map((m) => m.move_type)).toEqual(["assemble_out", "assemble_out", "assemble_out", "assemble_in"]);
    expect(moves.reduce((s, m) => s + m.q, 0)).toBe(-8000 + 4000);
    // giá trị tồn kho cân: giá vốn thành phần đã xuất + chi phí phụ = giá trị lô giỏ quà
    expect(lot.unit_cost * 4).toBe(380000 + 300000 + 40000);
  });

  it("bán giỏ quà như hàng thường: FEFO lô giỏ, giá vốn 180.000/giỏ", async () => {
    await api("cashier", "POST", `${V}/shifts/open`, { openingCash: 0 });
    const ok = await api("cashier", "POST", `${V}/pos/orders`, { clientUuid: "bundle-sale-0001", lines: [{ productId: BUNDLE, unit: "hop", qty: 1 }], payments: [{ method: "cash", amount: 250000 }] });
    expect(ok.status).toBe(201);
    const ol = await db().prepare(`SELECT cost_amount c FROM order_lines WHERE order_id=?`).bind(ok.body.id).first<{ c: number }>();
    expect(ol!.c).toBe(180000);
    expect(await lotQty(asm.lotId)).toBe(3000);
  });

  it("danh sách / chi tiết lệnh; quyền: thu ngân không tạo được", async () => {
    expect((await api("cashier", "POST", `${V}/assembly-orders`, { bundleProductId: BUNDLE, qty: 1, unit: "hop" })).status).toBe(403);
    const l = await api("warehouse", "GET", `${V}/assembly-orders`);
    expect(l.body.items).toHaveLength(1);
    expect((await api("warehouse", "GET", `${V}/assembly-orders/${asm.id}`)).body.components).toHaveLength(3);
  });

  it("giỏ chưa khai báo thành phần → 422", async () => {
    await db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (32,'GIOQUA2','Giỏ trống','hop',1)`).run();
    const r = await api("warehouse", "POST", `${V}/assembly-orders`, { bundleProductId: 32, qty: 1, unit: "hop" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("no_components");
  });
});
