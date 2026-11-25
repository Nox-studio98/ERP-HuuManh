import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase, testEnv } from "./helpers";
import { vnDate } from "../src/worker/lib/time";
import { addDays } from "../src/worker/services/debt";
import { db, lotOf, mkB2bOrder, mkCustomer, mkProduct, reservedFor, shortRows } from "./po-helpers";

// PO tự động — bước 1: xác nhận SO thiếu hàng giữ phần có tồn + ghi phần thiếu (docs/PO-NCC.md 4.1)
const future = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

beforeAll(async () => {
  await seedBase();
  await db().batch([
    db().prepare(`INSERT INTO funds(id, store_id, code, name, type) VALUES (3,1,'COD-CH1','Chờ đối soát COD','cod_clearing')`),
    db().prepare(`INSERT INTO delivery_zones(id, name, districts_json, fee, free_over, min_order) VALUES (1,'Nội thành','["Quận 1"]',15000,500000,0)`),
    db().prepare(`INSERT INTO delivery_slots(id, label, start_time, end_time, capacity) VALUES (1,'8:00–10:00','08:00','10:00',50)`),
  ]);
});

describe("đơn sỉ: xác nhận khi thiếu hàng", () => {
  it("giữ phần có tồn, ghi phần thiếu, đơn vẫn confirmed; chi tiết + danh sách báo 'chờ hàng'", async () => {
    await mkProduct(9101, { stockMilli: 10_000 });
    const c = await mkCustomer();
    const o = await mkB2bOrder(c, [{ productId: 9101, qty: 15 }]);
    expect(o.status).toBe(201);
    expect(o.body.status).toBe("confirmed");
    expect(await reservedFor(o.body.id)).toBe(10_000);
    const sh = await shortRows(o.body.id);
    expect(sh).toHaveLength(1);
    expect(sh[0]).toMatchObject({ qty_milli: 5000, initial_milli: 5000, status: "open", need_by: addDays(vnDate(), 1), product_id: 9101 });
    expect(o.body.awaitingStock).toBe(true);
    expect(o.body.shortMilli).toBe(5000);
    expect(o.body.lines[0]).toMatchObject({ qtyMilli: 15_000, reservedMilli: 10_000, shortMilli: 5000 });
    const list = await api("manager", "GET", `/api/v1/b2b/orders?customerId=${c.id}`);
    expect(list.body.items[0]).toMatchObject({ awaitingStock: true, shortMilli: 5000 });
  });

  it("hết sạch tồn: confirmed với 0 giữ + thiếu toàn bộ", async () => {
    await mkProduct(9102, {});
    const o = await mkB2bOrder(await mkCustomer(), [{ productId: 9102, qty: 4 }]);
    expect(o.body.status).toBe("confirmed");
    expect(await reservedFor(o.body.id)).toBe(0);
    expect((await shortRows(o.body.id))[0].qty_milli).toBe(4000);
  });

  it("hai người xác nhận đồng thời không bán quá tồn (EC-02): tổng giữ ≤ tồn, thiếu bù đúng", async () => {
    await mkProduct(9103, { stockMilli: 10_000 });
    const [a, b] = await Promise.all([
      mkB2bOrder(await mkCustomer(), [{ productId: 9103, qty: 8 }]),
      mkB2bOrder(await mkCustomer(), [{ productId: 9103, qty: 8 }]),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const lot = await lotOf(9103);
    expect(lot.r).toBeLessThanOrEqual(lot.h);
    expect(lot.r).toBe(10_000);
    const ra = await reservedFor(a.body.id), rb = await reservedFor(b.body.id);
    expect(ra + rb).toBe(10_000);
    const sa = (await shortRows(a.body.id))[0]?.qty_milli ?? 0, sb = (await shortRows(b.body.id))[0]?.qty_milli ?? 0;
    expect(sa + sb).toBe(6000);
    expect(ra + sa).toBe(8000);
    expect(rb + sb).toBe(8000);
  });

  it("hạn mức nợ tính trên TOÀN BỘ giá trị đơn (không chỉ phần có hàng)", async () => {
    await mkProduct(9104, { stockMilli: 10_000, price: 50_000 });
    const c = await mkCustomer("KH hạn mức", 600_000); // 10kg = 500k (đủ hạn mức), 15kg = 750k (vượt)
    const o = await mkB2bOrder(c, [{ productId: 9104, qty: 15 }]);
    expect(o.status).toBe(409);
    expect(o.body.error.code).toBe("credit_blocked");
    const list = await api("manager", "GET", `/api/v1/b2b/orders?customerId=${c.id}`);
    expect(list.body.items[0].status).toBe("new");
    expect(await lotOf(9104)).toEqual({ h: 10_000, r: 0 });
    const n = await db().prepare(`SELECT COUNT(*) AS n FROM so_shortages WHERE order_id = ?`).bind(list.body.items[0].id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("po.allow_short_confirm = 0: chặn 409 như cũ", async () => {
    await mkProduct(9105, { stockMilli: 2000 });
    await db().prepare(`UPDATE settings SET value='0' WHERE key='po.allow_short_confirm'`).run();
    const o = await mkB2bOrder(await mkCustomer(), [{ productId: 9105, qty: 5 }]);
    await db().prepare(`UPDATE settings SET value='1' WHERE key='po.allow_short_confirm'`).run();
    expect(o.status).toBe(409);
    expect(o.body.error.code).toBe("insufficient_stock");
  });

  it("huỷ SO đóng phần thiếu và nhả giữ; sửa dòng SO tính lại phần thiếu", async () => {
    await mkProduct(9106, { stockMilli: 3000 });
    const c = await mkCustomer();
    const o = await mkB2bOrder(c, [{ productId: 9106, qty: 5 }]);
    expect((await shortRows(o.body.id))[0].qty_milli).toBe(2000);
    // sửa thành 2kg → đủ hàng, không còn thiếu
    const edit = await api("manager", "PUT", `/api/v1/b2b/orders/${o.body.id}`, { lines: [{ productId: 9106, unit: "kg", qty: 2 }] });
    expect(edit.status).toBe(200);
    expect(edit.body.status).toBe("confirmed");
    expect(await shortRows(o.body.id)).toHaveLength(0);
    expect(await reservedFor(o.body.id)).toBe(2000);
    // sửa lên 6kg → thiếu 3kg
    await api("manager", "PUT", `/api/v1/b2b/orders/${o.body.id}`, { lines: [{ productId: 9106, unit: "kg", qty: 6 }] });
    expect((await shortRows(o.body.id))[0]).toMatchObject({ qty_milli: 3000, status: "open" });
    const cancel = await api("manager", "POST", `/api/v1/b2b/orders/${o.body.id}/cancel`, { reason: "Khách huỷ đơn" });
    expect(cancel.status).toBe(200);
    expect((await shortRows(o.body.id))[0]).toMatchObject({ status: "cancelled" });
    expect((await lotOf(9106)).r).toBe(0);
  });

  it("giao: chỉ giao phần đã giữ, phần chờ hàng bị chặn; giao xong đóng phần thiếu", async () => {
    await mkProduct(9107, { stockMilli: 4000 });
    const o = await mkB2bOrder(await mkCustomer(), [{ productId: 9107, qty: 6 }]);
    const lineId = o.body.lines[0].id;
    const pk = await api("warehouse", "POST", `/api/v1/b2b/orders/${o.body.id}/pick`);
    expect(pk.status).toBe(201);
    const did = pk.body.deliveryId;
    await api("warehouse", "POST", `/api/v1/deliveries/${did}/scan`, { code: "LOT-PO9107" });
    expect((await api("warehouse", "POST", `/api/v1/deliveries/${did}/ready`, { reason: "Chỉ soạn phần có hàng" })).status).toBe(200);
    expect((await api("warehouse", "POST", `/api/v1/deliveries/${did}/ship`, { shipper: "A" })).status).toBe(200);
    const over = await api("warehouse", "POST", `/api/v1/deliveries/${did}/confirm`, { receiverName: "X", lines: [{ orderLineId: lineId, deliveredQty: 6 }] });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("awaiting_stock");
    const ok = await api("warehouse", "POST", `/api/v1/deliveries/${did}/confirm`, { receiverName: "X", lines: [{ orderLineId: lineId, deliveredQty: 4 }] });
    expect(ok.status).toBe(200);
    expect((await shortRows(o.body.id))[0].status).toBe("cancelled");
    expect(await lotOf(9107)).toEqual({ h: 0, r: 0 });
  });
});

describe("đơn online đặt trước", () => {
  const base = { receiverName: "Chị Lan", receiverPhone: "0988000111", addressLine: "5 Nguyễn Huệ", district: "quan 1", province: "TP.HCM", paymentMethod: "cod", acceptPreorder: true };
  const mkOrder = (pid: number, qty: number, slotDate: string) =>
    api("online_staff", "POST", "/api/v1/online-orders", { ...base, items: [{ productId: pid, unit: "kg", qty }], slotDate, slotId: 1 });

  it("giao ngày sau: xác nhận giữ phần có tồn + ghi thiếu; chặn soạn tới khi đủ hàng", async () => {
    await mkProduct(9111, { stockMilli: 2000, preorder: true });
    const r = await mkOrder(9111, 5, addDays(vnDate(), 1));
    expect(r.status).toBe(201);
    expect(r.body.lines[0]).toMatchObject({ qtyMilli: 5000, preorderMilli: 3000 });
    const ok = await api("online_staff", "POST", `/api/v1/online-orders/${r.body.id}/confirm`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("confirmed");
    expect(ok.body.awaitingStock).toBe(true);
    expect(ok.body.lines[0]).toMatchObject({ preorderMilli: 0, shortMilli: 3000 });
    expect(await reservedFor(r.body.id)).toBe(5000 - 3000 + 0); // 2kg có tồn
    const sh = (await shortRows(r.body.id))[0];
    expect(sh).toMatchObject({ qty_milli: 3000, need_by: addDays(vnDate(), 1) });
    const prep = await api("online_staff", "POST", `/api/v1/online-orders/${r.body.id}/prepare`);
    expect(prep.status).toBe(409);
    expect(prep.body.error.code).toBe("awaiting_stock");
    const list = await api("online_staff", "GET", "/api/v1/online-orders?status=confirmed");
    expect(list.body.items.find((x: any) => x.id === r.body.id)).toMatchObject({ awaitingStock: true, shortMilli: 3000 });
  });

  it("giao trong ngày: vẫn chặn thiếu như cũ (preorder_not_ready)", async () => {
    await mkProduct(9112, { stockMilli: 1000, preorder: true });
    const r = await mkOrder(9112, 3, vnDate());
    expect(r.status).toBe(201);
    const c = await api("online_staff", "POST", `/api/v1/online-orders/${r.body.id}/confirm`);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("preorder_not_ready");
    expect(await shortRows(r.body.id)).toHaveLength(0);
  });

  it("tắt po.allow_short_confirm: đơn giao ngày sau cũng bị chặn", async () => {
    await mkProduct(9113, { stockMilli: 1000, preorder: true });
    const r = await mkOrder(9113, 3, addDays(vnDate(), 1));
    await db().prepare(`UPDATE settings SET value='0' WHERE key='po.allow_short_confirm'`).run();
    const c = await api("online_staff", "POST", `/api/v1/online-orders/${r.body.id}/confirm`);
    await db().prepare(`UPDATE settings SET value='1' WHERE key='po.allow_short_confirm'`).run();
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("preorder_not_ready");
  });

  it("huỷ đơn online đóng phần thiếu", async () => {
    await mkProduct(9114, { stockMilli: 1000, preorder: true });
    const r = await mkOrder(9114, 3, addDays(vnDate(), 1));
    await api("online_staff", "POST", `/api/v1/online-orders/${r.body.id}/confirm`);
    expect((await shortRows(r.body.id))[0].status).toBe("open");
    const x = await api("online_staff", "POST", `/api/v1/online-orders/${r.body.id}/cancel`, { reason: "Khách đổi ý" });
    expect(x.status).toBe(200);
    expect((await shortRows(r.body.id))[0].status).toBe("cancelled");
  });
});
void testEnv; void future;
