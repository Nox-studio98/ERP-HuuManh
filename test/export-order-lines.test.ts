import { beforeAll, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { app } from "../src/worker/index";
import { login, seedBase, testEnv } from "./helpers";
import { ORDER_LINES_MAX_ROWS } from "../src/worker/routes/export-order-lines";

async function getLines(role: string, qs = "") {
  const token = await login(role);
  const res = await app.request(`/api/v1/exports/order-lines.xlsx${qs}`, { headers: { authorization: `Bearer ${token}` } }, testEnv);
  return res;
}
/** Đọc sheet1 thành mảng dòng → mảng ô (chuỗi hoặc số), bỏ dòng "Tổng cộng". */
async function table(role: string, qs = "") {
  const res = await getLines(role, qs);
  expect(res.status).toBe(200);
  const z = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const xml = strFromU8(z["xl/worksheets/sheet1.xml"]);
  const rows: Record<string, string | number>[] = [];
  const header: string[] = [];
  for (const m of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/g)) {
    const cells: Record<string, string | number> = {};
    for (const c of m[2].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
      const t = c[2]?.match(/<t[^>]*>(.*?)<\/t>/s);
      const v = c[2]?.match(/<v>(.*?)<\/v>/);
      if (t) cells[c[1]] = t[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      else if (v) cells[c[1]] = Number(v[1]);
    }
    if (m[1] === "1") header.push(...Object.values(cells).map(String));
    else if (cells.A !== "Tổng cộng") rows.push(Object.fromEntries(Object.entries(cells).map(([k, val]) => [header[k.charCodeAt(0) - 65] ?? k, val])));
  }
  return { header, rows };
}

beforeAll(async () => {
  await seedBase();
  const db = testEnv.DB;
  const t = "2026-11-20T03:00:00.000Z";
  await db.batch([
    db.prepare(`INSERT INTO customers(id, code, type, name, phone) VALUES (701,'KH-L1','retail','Chị Lan','0901234567')`),
    db.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (701,'XOAI-L','Xoài =cmd()','kg'),(702,'CAM-L','Cam sành','kg')`),
    db.prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (701,'thùng',10000)`),
    db.prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, customer_id, subtotal, discount, total, charges_total, created_by, created_at, completed_at) VALUES
      (701,'HD-L-1','pos','sale',1,'completed',701,170000,10000,165000,5000,1,?,?),
      (702,'TR-L-1','pos','return',1,'completed',701,40000,0,42000,2000,1,?,?),
      (703,'HD-L-2','online','sale',1,'completed',NULL,60000,0,60000,0,1,'2026-11-21T03:00:00.000Z','2026-11-21T03:00:00.000Z')`).bind(t, t, t, t),
    // 1 thùng xoài (10 kg) giá 150k/thùng → unit_price theo đơn vị chính 15.000/kg; 2 kg cam 10k
    db.prepare(`INSERT INTO order_lines(id, order_id, product_id, unit, qty_milli, unit_price, discount, line_total, cost_amount) VALUES
      (701,701,701,'thùng',10000,15000,10000,140000,100000),
      (702,701,702,'kg',2000,10000,0,20000,12000),
      (703,702,702,'kg',2000,10000,0,40000,24000),
      (704,703,702,'kg',6000,10000,0,60000,36000)`),
    db.prepare(`INSERT INTO order_charges(order_id, name, amount) VALUES (701,'Phí đóng gói',5000)`),
  ]);
});

describe("xuất chi tiết dòng hàng", () => {
  it("cần quyền orders.view và có audit", async () => {
    const res = await app.request("/api/v1/exports/order-lines.xlsx", {}, testEnv);
    expect(res.status).toBe(401);
    const { rows } = await table("owner", "?from=2026-11-20&to=2026-11-21");
    expect(rows.length).toBeGreaterThan(0);
    const a = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export.order_lines'`).first<{ n: number }>();
    expect(a!.n).toBeGreaterThan(0);
  });

  it("mỗi dòng hàng một dòng, đơn vị dòng, trả hàng âm, thu khác riêng, chuỗi công thức không thành công thức", async () => {
    const { header, rows } = await table("owner", "?from=2026-11-20&to=2026-11-20");
    expect(header).toContain("Giá vốn");
    expect(rows.map((r) => `${r["Mã đơn"]}|${r["Tên hàng"]}`)).toEqual([
      "HD-L-1|Xoài =cmd()", "HD-L-1|Cam sành", "HD-L-1|Thu khác: Phí đóng gói", "TR-L-1|Cam sành", "TR-L-1|Hoàn thu khác",
    ]);
    const [xoai, cam, charge, ret, retCharge] = rows;
    expect(xoai).toMatchObject({ "Số lượng": 1, "ĐVT": "thùng", "Đơn giá": 150000, "Giảm giá dòng": 10000, "Thành tiền": 140000, "Giá vốn": 100000, "Lãi gộp": 40000, "Mã hàng": "XOAI-L", "Kênh": "Tại quầy", "Loại": "Bán" });
    expect(cam).toMatchObject({ "Số lượng": 2, "Đơn giá": 10000, "Thành tiền": 20000 });
    expect(charge["Thành tiền"]).toBe(5000);
    expect(charge["Số lượng"]).toBeUndefined();
    expect(ret).toMatchObject({ "Loại": "Trả hàng", "Số lượng": -2, "Thành tiền": -40000, "Giá vốn": -24000, "Lãi gộp": -16000 });
    expect(retCharge["Thành tiền"]).toBe(-2000);
  });

  it("che SĐT khi không có customers.view_pii; ẩn giá vốn khi không có prices.view_cost", async () => {
    const owner = await table("owner", "?from=2026-11-20&to=2026-11-20");
    expect(owner.rows[0]["SĐT"]).toBe("0901234567");
    const cashier = await table("cashier", "?from=2026-11-20&to=2026-11-20");
    expect(cashier.rows[0]["SĐT"]).toBe("090****567");
    expect(cashier.header).not.toContain("Giá vốn");
    expect(cashier.header).not.toContain("Lãi gộp");
    expect(JSON.stringify(cashier.rows)).not.toContain("100000");
    expect(cashier.rows.length).toBe(owner.rows.length);
  });

  it("áp dụng bộ lọc như danh sách đơn", async () => {
    const all = await table("owner", "?from=2026-11-20&to=2026-11-21");
    expect(new Set(all.rows.map((r) => r["Mã đơn"]))).toEqual(new Set(["HD-L-1", "TR-L-1", "HD-L-2"]));
    const online = await table("owner", "?from=2026-11-20&to=2026-11-21&channel=online");
    expect(online.rows.map((r) => r["Mã đơn"])).toEqual(["HD-L-2"]);
    const rets = await table("owner", "?from=2026-11-20&to=2026-11-21&kind=return");
    expect(new Set(rets.rows.map((r) => r["Mã đơn"]))).toEqual(new Set(["TR-L-1"]));
    const q = await table("owner", "?from=2026-11-20&to=2026-11-21&q=HD-L-2");
    expect(q.rows.length).toBe(1);
    const byName = await table("owner", "?from=2026-11-20&to=2026-11-21&q=Cam%20s");
    expect(new Set(byName.rows.map((r) => r["Mã đơn"]))).toEqual(new Set(["HD-L-1", "TR-L-1", "HD-L-2"]));
    const day2 = await table("owner", "?from=2026-11-21&to=2026-11-21");
    expect(day2.rows.map((r) => r["Mã đơn"])).toEqual(["HD-L-2"]);
    expect((await getLines("owner", "?from=2026-11-22&to=2026-11-20")).status).toBe(422);
  });

  it("vượt giới hạn dòng thì báo rõ, không trả file", async () => {
    const db = testEnv.DB;
    await db.prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, created_at) VALUES (799,'HD-BIG','pos','sale',1,'completed',0,'2026-10-01T03:00:00.000Z')`).run();
    await db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
       INSERT INTO order_lines(order_id, product_id, unit, qty_milli, unit_price, line_total) SELECT 799, 702, 'kg', 1000, 1, 1 FROM n`,
    ).bind(ORDER_LINES_MAX_ROWS + 1).run();
    const res = await getLines("owner", "?from=2026-10-01&to=2026-10-01");
    expect(res.status).toBe(422);
    const body: any = await res.json();
    expect(JSON.stringify(body)).toContain("export_too_large");
    expect(JSON.stringify(body)).toContain("thu hẹp");
  }, 60_000);
});
