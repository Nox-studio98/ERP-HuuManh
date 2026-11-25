import { beforeAll, describe, expect, it } from "vitest";
import { api, seedBase } from "./helpers";
import { vnDate, vnPeriod } from "../src/worker/lib/time";
import { addDays } from "../src/worker/services/debt";
import { runPoCutoff } from "../src/worker/services/po";
import { db, lotOf, mkB2bOrder, mkCustomer, mkProduct, mkSupplier, reservedFor, shortRows } from "./po-helpers";

// PO tự động — bước 3: nhận hàng theo PO nguyên tử, giữ hàng cho SO chờ đúng thứ tự (docs/PO-NCC.md 4.5)
const sys = { type: "system" as const, userId: null };
const V = "/api/v1/purchase-orders";

beforeAll(async () => {
  await seedBase();
  await mkSupplier(9401, "NCC Cam Sành", 10);
});

/** Tạo PO đã xác nhận cho 1 sản phẩm: các SO thiếu → chốt ngay → duyệt → NCC xác nhận. */
async function confirmedPo(pid: number, orders: { qty: number; delivery?: string }[], stock = 0, cost = 30000) {
  await mkSupplier(pid, `NCC riêng ${pid}`, 10); // mỗi PO một NCC riêng: PO nháp tự động gom theo NCC
  await mkProduct(pid, { stockMilli: stock, cost, supplierId: pid });
  const made = [];
  for (const o of orders) made.push((await mkB2bOrder(await mkCustomer(), [{ productId: pid, qty: o.qty }], o.delivery)).body);
  await runPoCutoff(db(), { mode: "now", actor: sys });
  const po = (await db().prepare(`SELECT p.* FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id = p.id WHERE l.product_id = ? AND p.status = 'draft'`).bind(pid).first<any>())!;
  // chưa có lô nhập trước đó → PO nháp chưa có giá: người lập điền giá (PUT) trước khi duyệt
  const draft = (await api("warehouse", "GET", `${V}/${po.id}`)).body;
  expect(draft.lines[0].unitCost).toBeNull();
  const put = await api("warehouse", "PUT", `${V}/${po.id}`, { version: draft.version, lines: [{ productId: pid, qty: draft.lines[0].qtyMilli / 1000, unitCost: cost }] });
  expect(put.status).toBe(200);
  expect(put.body.total).toBe(Math.round((draft.lines[0].qtyMilli * cost) / 1000));
  const sent = await api("manager", "POST", `${V}/${po.id}/approve`, {});
  expect(sent.body.status).toBe("sent");
  const conf = await api("manager", "POST", `${V}/${po.id}/supplier-response`, { action: "confirm", version: sent.body.version });
  expect(conf.body.status).toBe("confirmed");
  return { po: conf.body as any, orders: made as any[], lineId: conf.body.lines[0].id as number };
}

const docCount = async (poId: number) => (await db().prepare(`SELECT COUNT(*) AS n FROM stock_docs WHERE po_id = ?`).bind(poId).first<{ n: number }>())!.n;

describe("nhận hàng theo PO", () => {
  it("nhận đủ: một batch tạo phiếu nhập posted + lô + thẻ kho + hoá đơn mua tạm tính; giữ hàng cho SO chờ; PO received", async () => {
    const { po, orders, lineId } = await confirmedPo(9411, [{ qty: 6 }, { qty: 4 }]);
    expect(po.lines[0].targetMilli).toBe(10_000);
    const r = await api("warehouse", "POST", `${V}/${po.id}/receive`, { version: po.version, lines: [{ poLineId: lineId, qtyMilli: 10_000 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe("received");
    expect(r.body.result.stockDoc.code).toMatch(/^PN-/);
    const doc = await db().prepare(`SELECT * FROM stock_docs WHERE po_id = ?`).bind(po.id).first<any>();
    expect(doc).toMatchObject({ type: "receipt", status: "posted", supplier_id: 9411, total_amount: 300_000 });
    const lot = await db().prepare(`SELECT * FROM lots WHERE receipt_doc_id = ?`).bind(doc.id).first<any>();
    expect(lot).toMatchObject({ product_id: 9411, qty_in_milli: 10_000, unit_cost: 30000, supplier_id: 9411 });
    expect(lot.lot_code).toMatch(/^HML\d{8}$/);
    const mv = await db().prepare(`SELECT * FROM stock_moves WHERE lot_id = ?`).bind(lot.id).all<any>();
    expect(mv.results.filter((m) => m.move_type === "receipt")).toHaveLength(1);
    const bill = await db().prepare(`SELECT * FROM supplier_bills WHERE stock_doc_id = ?`).bind(doc.id).first<any>();
    expect(bill).toMatchObject({ total: 300_000, is_provisional: 1, supplier_id: 9411, due_date: addDays(vnDate(), 10) });
    expect((await db().prepare(`SELECT received_milli FROM purchase_order_lines WHERE id = ?`).bind(lineId).first<any>()).received_milli).toBe(10_000);
    // SO đã đủ hàng
    for (const o of orders) {
      expect(await reservedFor(o.id)).toBe(o.lines[0].qtyMilli);
      expect((await shortRows(o.id))[0]).toMatchObject({ status: "filled", qty_milli: 0 });
    }
    expect(await lotOf(lot.id)).toEqual({ h: 10_000, r: 10_000 });
    expect(r.body.result.filledShortages).toHaveLength(2);
    const noti = await db().prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'so_filled' AND ref_id IN (?, ?)`).bind(orders[0].id, orders[1].id).first<{ n: number }>();
    expect(noti!.n).toBe(2);
    const detail = await api("manager", "GET", `${V}/${po.id}`);
    expect(detail.body.stockDocs).toHaveLength(1);
    expect(detail.body.bills[0]).toMatchObject({ total: 300_000, provisional: true });
    // đơn sỉ đã soạn giao được: chi tiết đơn hết "chờ hàng"
    const od = await api("manager", "GET", `/api/v1/b2b/orders/${orders[0].id}`);
    expect(od.body.awaitingStock).toBe(false);
  });

  it("nhận một phần theo thứ tự ngày giao rồi thời điểm tạo; đóng PO thiếu → closed", async () => {
    const d1 = addDays(vnDate(), 1), d0 = vnDate();
    // SO A tạo trước (giao ngày mai, 5kg), SO B tạo sau nhưng giao sớm hơn (hôm nay, 4kg)
    const { po, orders, lineId } = await confirmedPo(9421, [{ qty: 5, delivery: d1 }, { qty: 4, delivery: d0 }]);
    const [a, b] = orders;
    const r1 = await api("warehouse", "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 5000 }], supplierRef: "HD-NCC-001" });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe("partially_received");
    // B (giao sớm) được giữ đủ 4, A chỉ 1
    expect(await reservedFor(b.id)).toBe(4000);
    expect(await reservedFor(a.id)).toBe(1000);
    expect((await shortRows(b.id))[0]).toMatchObject({ status: "filled" });
    expect((await shortRows(a.id))[0]).toMatchObject({ status: "open", qty_milli: 4000 });
    // có số hoá đơn NCC → không tạm tính
    const bill = await db().prepare(`SELECT is_provisional, supplier_ref FROM supplier_bills WHERE stock_doc_id = (SELECT id FROM stock_docs WHERE po_id = ?)`).bind(po.id).first<any>();
    expect(bill).toEqual({ is_provisional: 0, supplier_ref: "HD-NCC-001" });
    // đóng PO thiếu: phần thiếu của A quay lại nhu cầu cho lần chạy sau
    const cur = (await api("manager", "GET", `${V}/${po.id}`)).body;
    expect(cur.lines[0]).toMatchObject({ receivedMilli: 5000, remainingMilli: 4000 });
    const closed = await api("manager", "POST", `${V}/${po.id}/close`, { reason: "NCC hết hàng", version: cur.version });
    expect(closed.body.status).toBe("closed");
    expect((await api("warehouse", "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 100 }] })).status).toBe(409);
    const re = await runPoCutoff(db(), { mode: "recalc", actor: sys });
    expect(re.created.length + re.updated.length).toBeGreaterThanOrEqual(1);
    const need = (await db().prepare(`SELECT l.qty_milli FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.product_id = 9421 AND p.status = 'draft'`).first<any>())!;
    expect(need.qty_milli).toBe(4000);
  });

  it("nhận nhiều lần cộng dồn; nhận vượt phần còn lại bị 422; thiếu giá chốt bị 422", async () => {
    const { po, lineId } = await confirmedPo(9431, [{ qty: 9 }]);
    const over = await api("warehouse", "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 9001 }] });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("over_receive");
    expect((await api("warehouse", "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 3000 }] })).body.status).toBe("partially_received");
    expect((await api("warehouse", "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 6000 }] })).body.status).toBe("received");
    expect(await docCount(po.id)).toBe(2);
    // PO chưa NCC xác nhận không nhận được
    await mkProduct(9432, { stockMilli: 0, supplierId: 9401 });
    const d = (await api("warehouse", "POST", V, { supplierId: 9401, lines: [{ productId: 9432, qty: 2, unitCost: 1000 }] })).body;
    const sent = (await api("manager", "POST", `${V}/${d.id}/approve`, {})).body;
    expect((await api("warehouse", "POST", `${V}/${d.id}/receive`, { lines: [{ poLineId: sent.lines[0].id, qtyMilli: 1000 }] })).status).toBe(409);
  });

  it("nguyên tử: phiên bản cũ / nhận trùng không tạo phiếu thứ hai; kỳ đã khoá chặn hẳn", async () => {
    const { po, lineId } = await confirmedPo(9441, [{ qty: 4 }]);
    const [x, y] = await Promise.all([
      api("warehouse", "POST", `${V}/${po.id}/receive`, { version: po.version, lines: [{ poLineId: lineId, qtyMilli: 4000 }] }),
      api("warehouse", "POST", `${V}/${po.id}/receive`, { version: po.version, lines: [{ poLineId: lineId, qtyMilli: 4000 }] }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await docCount(po.id)).toBe(1);
    const lots = (await db().prepare(`SELECT COUNT(*) AS n FROM lots WHERE product_id = 9441`).first<{ n: number }>())!.n;
    expect(lots).toBe(1);
    const bills = (await db().prepare(`SELECT COUNT(*) AS n FROM supplier_bills WHERE stock_doc_id IN (SELECT id FROM stock_docs WHERE po_id = ?)`).bind(po.id).first<{ n: number }>())!.n;
    expect(bills).toBe(1);

    // khoá sổ kỳ hiện tại → 423, không ghi gì
    const p2 = await confirmedPo(9442, [{ qty: 3 }]);
    await db().prepare(`INSERT INTO periods(period, locked_at, locked_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).bind(vnPeriod()).run();
    const locked = await api("warehouse", "POST", `${V}/${p2.po.id}/receive`, { lines: [{ poLineId: p2.lineId, qtyMilli: 3000 }] });
    await db().prepare(`DELETE FROM periods WHERE period = ?`).bind(vnPeriod()).run();
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("period_locked");
    expect(await docCount(p2.po.id)).toBe(0);
    expect((await db().prepare(`SELECT status FROM purchase_orders WHERE id = ?`).bind(p2.po.id).first<any>()).status).toBe("confirmed");
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM lots WHERE product_id = 9442`).first<{ n: number }>())!.n).toBe(0);
  });

  it("phân quyền nhận hàng: cần purchasing.write + inventory.write", async () => {
    const { po, lineId } = await confirmedPo(9451, [{ qty: 2 }]);
    for (const role of ["cashier", "online_staff", "accountant"])
      expect((await api(role, "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 1000 }] })).status).toBe(403);
    expect((await api("manager", "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 1000 }] })).status).toBe(201);
  });

  it("SO đã huỷ trước khi hàng về: không giữ hàng cho SO đó, hàng thành tồn bán lẻ", async () => {
    const { po, orders, lineId } = await confirmedPo(9461, [{ qty: 3 }, { qty: 2 }]);
    await api("manager", "POST", `/api/v1/b2b/orders/${orders[0].id}/cancel`, { reason: "Khách huỷ đơn" });
    const det = (await api("manager", "GET", `${V}/${po.id}`)).body;
    expect(det.sourceCancelled).toBe(true);
    const r = await api("warehouse", "POST", `${V}/${po.id}/receive`, { lines: [{ poLineId: lineId, qtyMilli: 5000 }] });
    expect(r.status).toBe(201);
    expect(await reservedFor(orders[0].id)).toBe(0);
    expect(await reservedFor(orders[1].id)).toBe(2000);
    const lot = await db().prepare(`SELECT qty_on_hand_milli AS h, qty_reserved_milli AS r FROM lots WHERE product_id = 9461`).first<any>();
    expect(lot).toEqual({ h: 5000, r: 2000 });
  });
});
