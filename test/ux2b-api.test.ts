import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate } from "../src/worker/lib/time";

const db = () => testEnv.DB;
const today = vnDate();
const yday = vnDate(new Date(Date.now() - 86400_000));
let custA = 0, custB = 0;

beforeAll(async () => {
  await seedBase();
  const d = db();
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (950,'U950','Ổi','kg')`),
    d.prepare(`INSERT INTO customers(id, code, name, type, customer_group_id) VALUES (951,'KH951','Quán Ánh','b2b',1),(952,'KH952','Nhà hàng Bình','b2b',1)`),
  ]);
  custA = 951; custB = 952;
  const old = new Date(Date.now() - 3 * 86400_000).toISOString();
  await d.batch([
    d.prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, customer_id, delivery_date) VALUES (9501,'DS-UX-1','b2b','sale',1,'new',100000,951,?)`).bind(today),
    d.prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, customer_id, delivery_date, created_at) VALUES (9502,'DS-UX-2','b2b','sale',1,'confirmed',250000,952,?,?)`).bind(today, old),
    d.prepare(`INSERT INTO orders(id, code, channel, kind, store_id, status, total, customer_id, delivery_date) VALUES (9503,'DS-UX-3','b2b','sale',1,'cancelled',70000,951,?)`).bind(today),
    d.prepare(`INSERT INTO orders(id, code, channel, store_id, status, total, receiver_name, receiver_phone) VALUES (9511,'ON-UX-1','online',1,'completed',300000,'Chị Lan','0900000001')`),
    d.prepare(`INSERT INTO orders(id, code, channel, store_id, status, total, receiver_name, receiver_phone, created_at) VALUES (9512,'ON-UX-2','online',1,'new',120000,'Anh Hùng','0900000002',?)`).bind(old),
    d.prepare(`INSERT INTO orders(id, code, channel, store_id, status, total, receiver_name, receiver_phone) VALUES (9513,'ON-UX-3','fresco',1,'cancelled',50000,'Cô Mai','0900000003')`),
    d.prepare(`INSERT INTO quotes(id, code, customer_id, status, valid_from, valid_until, subtotal, created_by) VALUES (9521,'BG-UX-1',951,'sent',?,?,500000,1),(9522,'BG-UX-2',952,'draft',?,?,200000,1)`).bind(today, "2099-01-01", today, "2099-01-01"),
    d.prepare(`INSERT INTO quotes(id, code, customer_id, status, valid_from, valid_until, subtotal, created_by, created_at) VALUES (9523,'BG-UX-3',951,'accepted',?,?,900000,1,?)`).bind(yday, "2099-01-01", old),
    d.prepare(`INSERT INTO stock_docs(id, code, type, status, store_id, location_id, created_by, created_at) VALUES (9531,'PN-UX-1','receipt','posted',1,1,1,?),(9532,'PX-UX-2','waste','posted',1,1,1,?)`).bind(new Date().toISOString(), old),
  ]);
});

describe("ux2b: /b2b/orders filters + summary", () => {
  it("filters by q (code or customer name), from/to and keeps old params", async () => {
    const all = await api("manager", "GET", "/api/v1/b2b/orders?q=DS-UX");
    expect(all.status).toBe(200);
    expect(all.body.items.map((x: any) => x.code).sort()).toEqual(["DS-UX-1", "DS-UX-2", "DS-UX-3"]);
    expect(all.body.summary.count).toBe(3);
    expect(all.body.summary.total).toBe(350000); // không tính đơn huỷ
    expect(all.body.summary.byStatus.cancelled.count).toBe(1);
    const byName = await api("manager", "GET", "/api/v1/b2b/orders?q=" + encodeURIComponent("Nhà hàng Bình"));
    expect(byName.body.items.map((x: any) => x.code)).toEqual(["DS-UX-2"]);
    const rng = await api("manager", "GET", `/api/v1/b2b/orders?q=DS-UX&from=${yday}&to=${today}`);
    expect(rng.body.items.map((x: any) => x.code).sort()).toEqual(["DS-UX-1", "DS-UX-3"]);
    expect(rng.body.summary.count).toBe(2);
    const legacy = await api("manager", "GET", `/api/v1/b2b/orders?customerId=${custA}&status=new`);
    expect(legacy.body.items.map((x: any) => x.code)).toEqual(["DS-UX-1"]);
  });
  it("rejects bad dates", async () => {
    expect((await api("manager", "GET", "/api/v1/b2b/orders?from=abc")).status).toBe(422);
    expect((await api("manager", "GET", `/api/v1/b2b/orders?from=${today}&to=2000-01-01`)).status).toBe(422);
  });
});

describe("ux2b: /quotes filters + summary", () => {
  it("q, customer, range, summary independent of cursor", async () => {
    const r = await api("manager", "GET", "/api/v1/quotes?q=BG-UX&limit=1");
    expect(r.body.items.length).toBe(1);
    expect(r.body.nextCursor).not.toBeNull();
    expect(r.body.summary.count).toBe(3);
    expect(r.body.summary.total).toBe(1_600_000);
    expect(r.body.summary.byStatus.draft.count).toBe(1);
    const c = await api("manager", "GET", `/api/v1/quotes?q=BG-UX&customerId=${custA}&from=${today}&to=${today}`);
    expect(c.body.items.map((x: any) => x.code)).toEqual(["BG-UX-1"]);
    const n = await api("manager", "GET", "/api/v1/quotes?q=" + encodeURIComponent("Quán Ánh"));
    expect(n.body.items.length).toBe(2);
  });
});

describe("ux2b: /online-orders from/to + summary", () => {
  it("filters by date and reports summary", async () => {
    const r = await api("owner", "GET", `/api/v1/online-orders?q=ON-UX&from=${today}&to=${today}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.code).sort()).toEqual(["ON-UX-1", "ON-UX-3"]);
    expect(r.body.summary).toMatchObject({ count: 2, revenue: 300000, cancelled: 1 });
    expect(r.body.counts.all).toBe(2);
    const all = await api("owner", "GET", "/api/v1/online-orders?q=ON-UX");
    expect(all.body.summary.count).toBe(3);
    expect(all.body.summary.pipelineTotal).toBe(120000);
    const st = await api("owner", "GET", `/api/v1/online-orders?q=ON-UX&status=new`);
    expect(st.body.items.length).toBe(1);
    expect(st.body.summary.count).toBe(3); // tổng hợp không phụ thuộc trạng thái chọn
  });
});

describe("ux2b: /stock-docs q + range", () => {
  it("filters by code and date range, day param still works", async () => {
    const a = await api("warehouse", "GET", "/api/v1/stock-docs?q=UX");
    expect(a.body.items.length).toBe(2);
    const b = await api("warehouse", "GET", `/api/v1/stock-docs?q=UX&from=${today}&to=${today}`);
    expect(b.body.items.map((x: any) => x.code)).toEqual(["PN-UX-1"]);
    const d = await api("warehouse", "GET", `/api/v1/stock-docs?day=${today}`);
    expect(d.body.items.some((x: any) => x.code === "PN-UX-1")).toBe(true);
  });
});

describe("ux2b: /shifts/last", () => {
  it("returns null before any closed shift, then the last closed one with totals", async () => {
    const none = await api("cashier", "GET", "/api/v1/shifts/last");
    expect(none.status).toBe(200);
    expect(none.body.shift).toBeNull();
    const o = await api("cashier", "POST", "/api/v1/shifts/open", { openingCash: 500000 });
    expect(o.status).toBe(201);
    const cl = await api("cashier", "POST", `/api/v1/shifts/${o.body.shift.id}/close`, { countedCash: 500000 });
    expect(cl.status).toBe(200);
    const last = await api("cashier", "GET", "/api/v1/shifts/last");
    expect(last.body.shift).toMatchObject({ id: o.body.shift.id, openingCash: 500000, countedCash: 500000, diffCash: 0, orderCount: 0, revenue: 0 });
    const denied = await api("online_staff", "GET", "/api/v1/shifts/last");
    expect(denied.status).toBe(403);
  });
});
