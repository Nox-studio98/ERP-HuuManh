import { beforeAll, describe, expect, it } from "vitest";
import { api, login, seedBase, testEnv } from "./helpers";
import { app } from "../src/worker/index";
import { FONT_KEYS } from "../src/worker/services/pdf";
import regularFont from "@expo-google-fonts/be-vietnam-pro/400Regular/BeVietnamPro_400Regular.ttf?inline";
import boldFont from "@expo-google-fonts/be-vietnam-pro/700Bold/BeVietnamPro_700Bold.ttf?inline";
import { vnDate } from "../src/worker/lib/time";
import { addDays } from "../src/worker/services/debt";
import { cutoffWindowDay, roundOrderQty, runPoCutoff, runPoCutoffIfDue, shapePo, shapePoLine } from "../src/worker/services/po";
import { notifyApproval } from "../src/worker/services/notify-approval";
import { db, mkB2bOrder, mkCustomer, mkProduct, mkSupplier } from "./po-helpers";

// PO tự động — bước 2: job chốt đêm, duyệt/gửi, phản hồi NCC, phân quyền (docs/PO-NCC.md 4.2–4.4)
const today = vnDate();
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`);
const sys = { type: "system" as const, userId: null };
const poRows = async (where = "1=1", ...b: unknown[]) => (await db().prepare(`SELECT * FROM purchase_orders WHERE ${where} ORDER BY id`).bind(...b).all<any>()).results;
const lineRows = async (poId: number) => (await db().prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY id`).bind(poId).all<any>()).results;

const fromDataUri = (u: string) => Uint8Array.from(atob(u.slice(u.indexOf(",") + 1)), (c) => c.charCodeAt(0));

beforeAll(async () => {
  await seedBase();
  await testEnv.FILES.put(FONT_KEYS.regular, fromDataUri(regularFont));
  await testEnv.FILES.put(FONT_KEYS.bold, fromDataUri(boldFont));
  await mkSupplier(9201, "NCC Cam Vĩnh Long", 7);
  await mkSupplier(9202, "NCC Xoài Cao Lãnh");
  await mkSupplier(9203, "NCC Nho Ninh Thuận");
});

describe("hàm thuần: ngày chốt + làm tròn", () => {
  it("ngày chốt qua nửa đêm: đơn nhập tối 25 đến trước 03:00 sáng 26 thuộc ngày 25", () => {
    const cm = 180;
    expect(cutoffWindowDay(at("2026-11-25", "22:30"), cm)).toBe("2026-11-25");
    expect(cutoffWindowDay(at("2026-11-26", "00:30"), cm)).toBe("2026-11-25");
    expect(cutoffWindowDay(at("2026-11-26", "02:59"), cm)).toBe("2026-11-25");
    expect(cutoffWindowDay(at("2026-11-26", "03:00"), cm)).toBe("2026-11-26");
    expect(cutoffWindowDay(at("2026-11-26", "10:00"), cm)).toBe("2026-11-26");
  });
  it("làm tròn lên theo đơn vị đặt và tối thiểu (logic M2-11)", () => {
    expect(roundOrderQty(23_000, 10_000, 0)).toBe(30_000);
    expect(roundOrderQty(23_000, 1000, 0)).toBe(23_000);
    expect(roundOrderQty(3000, 1000, 10_000)).toBe(10_000);
    expect(roundOrderQty(0, 10_000, 5000)).toBe(0);
  });
  it("giá vốn / tổng tiền bị ẩn với người không có prices.view_cost", () => {
    const po = { id: 1, code: "PO-X", status: "draft", total: 123456, supplier_id: 1, version: 1 };
    expect(shapePo(po, false)).not.toHaveProperty("total");
    expect(shapePo(po, true)).toHaveProperty("total", 123456);
    const l = { id: 1, product_id: 1, qty_milli: 1000, unit_cost: 777, confirmed_unit_cost: 888, proposed_unit_cost: 999, received_milli: 0, factor: 1000, order_unit: "kg" };
    const hidden = JSON.stringify(shapePoLine(l, false));
    expect(hidden).not.toMatch(/777|888|999|unitCost|lineTotal/);
  });
});

describe("job chốt đêm", () => {
  it("gom phần thiếu theo NCC ưu tiên, làm tròn theo thùng, ghi liên kết SO; sản phẩm không có NCC vào 'thiếu chưa có NCC'", async () => {
    await mkProduct(9211, { stockMilli: 2000, cost: 28000, supplierId: 9201, orderUnit: "thùng" }); // 1 thùng = 10kg
    await db().prepare(`INSERT INTO product_units(product_id, unit, factor_milli) VALUES (9211,'thùng',10000)`).run();
    await mkProduct(9212, { stockMilli: 0, cost: 40000, supplierId: 9202, leadDays: 2 });
    await mkProduct(9213, {}); // không NCC
    const c = await mkCustomer();
    const o1 = await mkB2bOrder(c, [{ productId: 9211, qty: 15 }, { productId: 9213, qty: 3 }]); // 9211: tồn 2 → thiếu 13
    const o2 = await mkB2bOrder(await mkCustomer(), [{ productId: 9211, qty: 5 }, { productId: 9212, qty: 7 }]); // 9211 thiếu 5; 9212 thiếu 7
    expect(o1.body.awaitingStock && o2.body.awaitingStock).toBe(true);

    const r = await runPoCutoff(db(), { mode: "now", actor: sys });
    expect(r.created).toHaveLength(2);
    expect(r.noSupplier).toEqual([{ productId: 9213, name: "Hàng PO 9213", qtyMilli: 3000 }]);
    const p1 = (await poRows("supplier_id = 9201"))[0];
    const p2 = (await poRows("supplier_id = 9202"))[0];
    expect(p1).toMatchObject({ status: "draft", source: "nightly", cutoff_day: r.cutoffDay });
    const l1 = (await lineRows(p1.id))[0];
    // thiếu 13 + 5 = 18kg → làm tròn lên 2 thùng = 20kg
    expect(l1).toMatchObject({ product_id: 9211, order_unit: "thùng", qty_milli: 20_000, unit_cost: 28000 });
    expect(p1.total).toBe(20 * 28000);
    expect((await lineRows(p2.id))[0]).toMatchObject({ product_id: 9212, qty_milli: 7000 });
    const links = (await db().prepare(`SELECT l.qty_milli, o.code FROM po_shortage_links l JOIN so_shortages s ON s.id = l.shortage_id JOIN orders o ON o.id = s.order_id WHERE l.po_line_id = ? ORDER BY l.shortage_id`).bind(l1.id).all<any>()).results;
    expect(links.map((x) => x.qty_milli)).toEqual([13000, 5000]);
    expect(p2.expected_date).toBe(addDays(today, 2));
    // API: danh sách + chi tiết (nguồn SO) + tab phần thiếu
    const detail = await api("manager", "GET", `/api/v1/purchase-orders/${p1.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.lines[0].sources.map((s: any) => s.qtyMilli)).toEqual([13000, 5000]);
    expect(detail.body.lines[0].orderUnit).toBe("thùng");
    expect(detail.body.lines[0].orderQty).toBe(2);
    const tab = await api("manager", "GET", "/api/v1/purchase-orders/shortages");
    expect(tab.status).toBe(200);
    expect(tab.body.noSupplier.map((x: any) => x.productId)).toContain(9213);
    const row = tab.body.items.find((x: any) => x.productId === 9211);
    expect(row).toMatchObject({ totalMilli: 18000, coveredMilli: 20000 > 18000 ? 18000 : 0, uncoveredMilli: 0 });
    void o1; void o2;
  });

  it("idempotent: chạy lại / Chốt ngay + job 03:00 không tạo trùng PO nháp", async () => {
    await mkProduct(9221, { stockMilli: 0, supplierId: 9201 });
    await mkB2bOrder(await mkCustomer(), [{ productId: 9221, qty: 4 }]);
    const now = new Date();
    const first = await runPoCutoff(db(), { mode: "now", actor: sys, now });
    const day = first.cutoffDay;
    const before = (await poRows("supplier_id = 9201 AND cutoff_day = ? AND status = 'draft'", day)).length;
    expect(before).toBe(1);
    const again = await runPoCutoff(db(), { mode: "recalc", actor: sys, now });
    expect(again.created).toHaveLength(0);
    // job tự động của đúng ngày chốt đó (chạy sau giờ chốt kế tiếp): cập nhật nháp, không tạo mới
    const auto = new Date(at(addDays(day, 1), "03:10"));
    const a1 = await runPoCutoff(db(), { mode: "auto", actor: sys, now: auto });
    expect(a1.cutoffDay).toBe(day);
    expect(a1.skipped).toBeUndefined();
    expect(a1.created).toHaveLength(0);
    const a2 = await runPoCutoff(db(), { mode: "auto", actor: sys, now: auto });
    expect(a2.skipped).toBe("already_done");
    expect((await poRows("supplier_id = 9201 AND cutoff_day = ? AND status = 'draft'", day)).length).toBe(1);
    // cron: không chạy lại khi ngày chốt đã xong
    expect(await runPoCutoffIfDue(db(), auto)).toBeNull();
  });

  it("job tự động trước giờ chốt không chốt ngày đang mở (02:00 vẫn thuộc ngày trước)", async () => {
    const day = addDays(today, 40);
    const r = await runPoCutoff(db(), { mode: "auto", actor: sys, now: at(addDays(day, 1), "02:00") });
    expect(r.cutoffDay).toBe(addDays(day, -1)); // 02:00 ngày D+1 → cửa sổ đang mở là D, nên chốt cửa sổ D-1
    const r2 = await runPoCutoff(db(), { mode: "auto", actor: sys, now: at(addDays(day, 1), "03:05") });
    expect(r2.cutoffDay).toBe(day);
  });

  it("trừ hàng sắp về: PO đã gửi phủ hết thì không đặt thêm; thiếu thêm chỉ đặt phần chênh", async () => {
    await mkProduct(9231, { stockMilli: 0, supplierId: 9202 });
    await mkB2bOrder(await mkCustomer(), [{ productId: 9231, qty: 10 }]);
    await runPoCutoff(db(), { mode: "now", actor: sys });
    const po = (await db().prepare(`SELECT po.* FROM purchase_orders po JOIN purchase_order_lines l ON l.po_id = po.id WHERE l.product_id = 9231`).first<any>())!;
    expect((await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/approve`, {})).status).toBe(200);
    // đã gửi: chạy lại không tạo PO mới cho 9231
    const again = await runPoCutoff(db(), { mode: "recalc", actor: sys });
    expect(JSON.stringify(again.created)).not.toContain(`"supplierId":0`);
    const forProd = (await db().prepare(`SELECT COUNT(*) AS n FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.product_id = 9231 AND p.status NOT IN ('cancelled')`).first<{ n: number }>())!.n;
    expect(forProd).toBe(1);
    // thiếu thêm 6 → PO nháp mới chỉ đặt 6
    await mkB2bOrder(await mkCustomer(), [{ productId: 9231, qty: 6 }]);
    await runPoCutoff(db(), { mode: "recalc", actor: sys });
    const drafts = (await db().prepare(`SELECT l.qty_milli FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id WHERE l.product_id = 9231 AND p.status = 'draft'`).all<any>()).results;
    expect(drafts.map((x) => x.qty_milli)).toEqual([6000]);
  });

  it("tính lại không đụng PO đã gửi và huỷ nháp khi hết nhu cầu", async () => {
    await mkProduct(9241, { stockMilli: 0, supplierId: 9203 });
    const o = await mkB2bOrder(await mkCustomer(), [{ productId: 9241, qty: 3 }]);
    await runPoCutoff(db(), { mode: "now", actor: sys });
    const draft = (await db().prepare(`SELECT p.* FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id = p.id WHERE l.product_id = 9241`).first<any>())!;
    expect(draft.status).toBe("draft");
    await api("manager", "POST", `/api/v1/b2b/orders/${o.body.id}/cancel`, { reason: "Khách huỷ đơn" });
    const r = await runPoCutoff(db(), { mode: "recalc", actor: sys });
    expect(r.cancelled.map((x) => x.id)).toContain(draft.id);
    expect((await poRows("id = ?", draft.id))[0]).toMatchObject({ status: "cancelled" });
  });

  it("đơn giao ngoài chân trời (po.horizon_days) chưa vào PO", async () => {
    await mkProduct(9251, { stockMilli: 0, supplierId: 9202 });
    await mkB2bOrder(await mkCustomer(), [{ productId: 9251, qty: 3 }], addDays(today, 10));
    await runPoCutoff(db(), { mode: "recalc", actor: sys });
    const n = (await db().prepare(`SELECT COUNT(*) AS n FROM purchase_order_lines WHERE product_id = 9251`).first<{ n: number }>())!.n;
    expect(n).toBe(0);
    await db().prepare(`UPDATE settings SET value='12' WHERE key='po.horizon_days'`).run();
    await runPoCutoff(db(), { mode: "recalc", actor: sys });
    await db().prepare(`UPDATE settings SET value='2' WHERE key='po.horizon_days'`).run();
    expect((await db().prepare(`SELECT COUNT(*) AS n FROM purchase_order_lines WHERE product_id = 9251`).first<{ n: number }>())!.n).toBe(1);
  });
});

describe("duyệt / ngưỡng / thông báo", () => {
  async function newDraft(pid: number, qty = 10, cost = 30000) {
    await mkProduct(pid, { stockMilli: 0, cost, supplierId: 9201 });
    const r = await api("warehouse", "POST", "/api/v1/purchase-orders", { supplierId: 9201, lines: [{ productId: pid, qty, unitCost: cost }] });
    expect(r.status).toBe(201);
    return r.body as any;
  }

  it("thủ kho tạo nháp được nhưng không duyệt; quản lý duyệt PO nhỏ → sent", async () => {
    const po = await newDraft(9301);
    expect(po.status).toBe("draft");
    expect(po.total).toBe(300000);
    expect((await api("warehouse", "POST", `/api/v1/purchase-orders/${po.id}/approve`, {})).status).toBe(403);
    const ok = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/approve`, { version: po.version });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("sent");
    expect(ok.body.approvedBy).toBeTruthy();
    expect(ok.body.sentAt).toBeTruthy();
    // sửa PO đã gửi bị chặn
    expect((await api("warehouse", "PUT", `/api/v1/purchase-orders/${po.id}`, { note: "x" })).status).toBe(409);
  });

  it("vượt approval.po_vnd: quản lý chỉ gửi yêu cầu duyệt (có thông báo); chủ duyệt qua /approvals → sent; từ chối → về nháp", async () => {
    await db().prepare(`UPDATE settings SET value='1000000' WHERE key='approval.po_vnd'`).run();
    const po = await newDraft(9302, 100, 30000); // 3.000.000
    const req = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/approve`, {});
    expect(req.status).toBe(200);
    expect(req.body.status).toBe("pending_approval");
    expect(req.body.approvalId).toBeTruthy();
    const job = await db().prepare(`SELECT * FROM integration_jobs WHERE type='notify.approval' AND ref_type='approvals' AND ref_id = ?`).bind(req.body.approvalId).first<any>();
    expect(job).toBeTruthy(); // C-27: thông báo duyệt đi qua luồng duyệt chung
    // xử lý job: chỉ chủ (có purchasing.approve_high) nhận thông báo, không có số tiền trong nội dung
    await notifyApproval(testEnv, job);
    const notes = (await db().prepare(`SELECT target_user_id, title, body FROM notifications WHERE ref_type = 'approvals' AND ref_id = ?`).bind(req.body.approvalId).all<any>()).results;
    expect(notes.map((n) => n.target_user_id)).toEqual([1]); // owner = user id 1 (seedBase)
    expect(notes[0].title).toBe("Đơn đặt NCC vượt ngưỡng chờ duyệt");
    expect(notes[0].body).not.toMatch(/\d{4,}/);
    // quản lý không duyệt được loại này
    expect((await api("manager", "POST", `/api/v1/approvals/${req.body.approvalId}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/approve`, {})).status).toBe(409);
    const done = await api("owner", "POST", `/api/v1/approvals/${req.body.approvalId}/decide`, { decision: "approved" });
    expect(done.status).toBe(200);
    expect((await poRows("id = ?", po.id))[0]).toMatchObject({ status: "sent" });

    const po2 = await newDraft(9303, 100, 30000);
    const req2 = await api("manager", "POST", `/api/v1/purchase-orders/${po2.id}/approve`, {});
    expect((await api("owner", "POST", `/api/v1/approvals/${req2.body.approvalId}/decide`, { decision: "rejected", note: "Giá cao" })).status).toBe(200);
    expect((await poRows("id = ?", po2.id))[0]).toMatchObject({ status: "draft", approval_id: null });
    // chủ duyệt trực tiếp trên PO
    const po3 = await newDraft(9304, 100, 30000);
    const direct = await api("owner", "POST", `/api/v1/purchase-orders/${po3.id}/approve`, {});
    expect(direct.body.status).toBe("sent");
    await db().prepare(`UPDATE settings SET value='20000000' WHERE key='approval.po_vnd'`).run();
  });

  it("NCC phản hồi: xác nhận / đề xuất → chấp nhận | từ chối / từ chối PO; version chống ghi đè", async () => {
    const mkSent = async (pid: number) => {
      const po = await newDraft(pid, 10, 30000);
      const s = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/approve`, {});
      return s.body as any;
    };
    // xác nhận nguyên PO
    let po = await mkSent(9311);
    const stale = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, { action: "confirm", version: po.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    const conf = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, { action: "confirm", version: po.version, expectedDate: addDays(today, 1) });
    expect(conf.status).toBe(200);
    expect(conf.body).toMatchObject({ status: "confirmed", expectedDate: addDays(today, 1) });
    expect(conf.body.lines[0]).toMatchObject({ confirmedQtyMilli: 10000, confirmedUnitCost: 30000 });
    // đã confirmed: không phản hồi lần nữa
    expect((await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, { action: "confirm", version: conf.body.version })).status).toBe(409);

    // đề xuất sửa SL/giá → chấp nhận
    po = await mkSent(9312);
    const prop = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, {
      action: "propose", version: po.version, expectedDate: addDays(today, 2), note: "Hết hàng loại 1",
      lines: [{ productId: 9312, qtyMilli: 6000, unitCost: 33000 }],
    });
    expect(prop.status).toBe(200);
    expect(prop.body).toMatchObject({ status: "supplier_proposed", proposedExpectedDate: addDays(today, 2) });
    expect(prop.body.lines[0]).toMatchObject({ proposedQtyMilli: 6000, proposedUnitCost: 33000 });
    const acc = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/proposal/accept`, { version: prop.body.version });
    expect(acc.status).toBe(200);
    expect(acc.body).toMatchObject({ status: "confirmed", expectedDate: addDays(today, 2), total: 6 * 33000 });
    expect(acc.body.lines[0]).toMatchObject({ confirmedQtyMilli: 6000, confirmedUnitCost: 33000 });

    // đề xuất → từ chối đề xuất (về sent, bắt buộc lý do)
    po = await mkSent(9313);
    const p2 = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, { action: "propose", version: po.version, lines: [{ productId: 9313, unitCost: 50000 }] });
    expect(p2.body.status).toBe("supplier_proposed");
    expect((await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/proposal/reject`, { version: p2.body.version })).status).toBe(422);
    const rej = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/proposal/reject`, { version: p2.body.version, reason: "Giá quá cao" });
    expect(rej.body.status).toBe("sent");
    expect(rej.body.lines[0].proposedQtyMilli).toBeNull();

    // NCC từ chối PO: bắt buộc lý do; phần thiếu quay lại nhu cầu
    po = await mkSent(9314);
    expect((await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, { action: "reject", version: po.version })).status).toBe(422);
    const rj = await api("manager", "POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, { action: "reject", version: po.version, note: "Hết hàng cả mùa" });
    expect(rj.body).toMatchObject({ status: "rejected", rejectReason: "Hết hàng cả mùa" });
    // nhật ký trạng thái ghi audit bất biến
    const hist = (await api("manager", "GET", `/api/v1/purchase-orders/${po.id}`)).body.history.map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(["po.create", "po.approve", "po.supplier_reject"]));
  });

  it("huỷ: nháp huỷ được bởi người lập; PO đã gửi cần quyền duyệt", async () => {
    const a = await newDraft(9321);
    expect((await api("warehouse", "POST", `/api/v1/purchase-orders/${a.id}/cancel`, { reason: "Nhập nhầm" })).body.status).toBe("cancelled");
    const b = await newDraft(9322);
    await api("manager", "POST", `/api/v1/purchase-orders/${b.id}/approve`, {});
    expect((await api("warehouse", "POST", `/api/v1/purchase-orders/${b.id}/cancel`, { reason: "Đổi ý" })).status).toBe(403);
    expect((await api("manager", "POST", `/api/v1/purchase-orders/${b.id}/cancel`, { reason: "Đổi ý" })).body.status).toBe("cancelled");
  });
});

describe("phân quyền từng route", () => {
  it("mặc định từ chối: vai trò không có quyền bị 403", async () => {
    const po = (await api("warehouse", "POST", "/api/v1/purchase-orders", { supplierId: 9201, lines: [{ productId: 9211, qty: 1, unitCost: 1000 }] })).body as any;
    const reqs: [string, string, unknown?][] = [
      ["GET", "/api/v1/purchase-orders"], ["GET", "/api/v1/purchase-orders/shortages"], ["GET", `/api/v1/purchase-orders/${po.id}`], ["GET", `/api/v1/purchase-orders/${po.id}/pdf`],
      ["POST", "/api/v1/purchase-orders", { supplierId: 9201, lines: [{ productId: 9211, qty: 1 }] }], ["PUT", `/api/v1/purchase-orders/${po.id}`, { note: "x" }],
      ["POST", "/api/v1/purchase-orders/cutoff-now"], ["POST", "/api/v1/purchase-orders/recalculate"],
      ["POST", `/api/v1/purchase-orders/${po.id}/approve`], ["POST", `/api/v1/purchase-orders/${po.id}/cancel`, { reason: "abc" }], ["POST", `/api/v1/purchase-orders/${po.id}/close`, { reason: "abc" }],
      ["POST", `/api/v1/purchase-orders/${po.id}/supplier-response`, { action: "confirm", version: 1 }], ["POST", `/api/v1/purchase-orders/${po.id}/proposal/accept`, {}],
      ["POST", `/api/v1/purchase-orders/${po.id}/receive`, { lines: [{ poLineId: 1, qtyMilli: 1 }] }],
    ];
    for (const role of ["cashier", "online_staff", "accountant"]) {
      for (const [m, p, body] of reqs) {
        const r = await api(role, m, p, body);
        expect(r.status, `${role} ${m} ${p}`).toBe(403);
      }
    }
    // thủ kho: có write, không có approve
    for (const [m, p, body] of reqs.filter((x) => /approve|close|supplier-response|proposal/.test(x[1]))) {
      expect((await api("warehouse", m, p, body)).status, `warehouse ${m} ${p}`).toBe(403);
    }
    expect((await api("warehouse", "GET", "/api/v1/purchase-orders")).status).toBe(200);
  });

  it("PDF PO trả application/pdf (nháp có dòng giá)", async () => {
    const po = (await api("warehouse", "POST", "/api/v1/purchase-orders", { supplierId: 9201, lines: [{ productId: 9211, qty: 2, unitCost: 28000 }] })).body as any;
    const token = await login("manager");
    const res = await app.request(`/api/v1/purchase-orders/${po.id}/pdf`, { headers: { authorization: `Bearer ${token}` } }, testEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder("latin1").decode(buf.slice(0, 5))).toBe("%PDF-");
  });
});
