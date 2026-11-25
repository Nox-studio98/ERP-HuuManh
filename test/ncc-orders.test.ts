import { beforeAll, describe, expect, it } from "vitest";
import { api, call, db, mkDraftPo, mkNcc, mkProduct, mkSentPo, mkSupplier, ncc, seedBase, V, type NccSession } from "./ncc-helpers";
import { seedShop } from "./shop-helpers";
import { FONT_KEYS } from "../src/worker/services/pdf";
import regularFont from "@expo-google-fonts/be-vietnam-pro/400Regular/BeVietnamPro_400Regular.ttf?inline";
import boldFont from "@expo-google-fonts/be-vietnam-pro/700Bold/BeVietnamPro_700Bold.ttf?inline";
import { testEnv } from "./helpers";
import { runPoCutoff } from "../src/worker/services/po";
import { addDays } from "../src/worker/services/debt";
import { vnDate } from "../src/worker/lib/time";
import { mkB2bOrder, mkCustomer } from "./po-helpers";

// Cổng NCC — bước 4: đơn đặt hàng trên cổng (xem, xác nhận, đề xuất, từ chối, PDF), thông báo ERP, audit (docs/PO-NCC.md 4.4, 5)
const fromDataUri = (u: string) => Uint8Array.from(atob(u.slice(u.indexOf(",") + 1)), (c) => c.charCodeAt(0));
let A: NccSession;
const po = async (id: number) => (await api("manager", "GET", `${V}/purchase-orders/${id}`)).body as any;

beforeAll(async () => {
  await seedShop();
  await seedBase();
  await testEnv.FILES.put(FONT_KEYS.regular, fromDataUri(regularFont));
  await testEnv.FILES.put(FONT_KEYS.bold, fromDataUri(boldFont));
  await mkSupplier(9701, "NCC Cam Đơn");
  await mkSupplier(9702, "NCC Khác Đơn");
  for (const id of [9711, 9712, 9713]) await mkProduct(id, { stockMilli: 5000, cost: 30000 });
  A = await mkNcc(9701, "don-a@example.com");
});

describe("PO nào NCC được thấy", () => {
  it("PO nháp / chờ chủ duyệt KHÔNG hiện: không trong danh sách, chi tiết 404, phản hồi 404, PDF 404", async () => {
    const draft = await mkDraftPo(9701, 9711);
    expect(draft.status).toBe("draft");
    // chờ chủ duyệt: tổng vượt ngưỡng → pending_approval
    const big = await api("manager", "POST", `${V}/purchase-orders`, { supplierId: 9701, lines: [{ productId: 9712, qty: 1000, unitCost: 50000 }] });
    const ap = await api("manager", "POST", `${V}/purchase-orders/${big.body.id}/approve`, {});
    expect(ap.body.result ?? ap.body.status).toBe("pending_approval");
    const list = await ncc(A, "GET", "/orders");
    expect(list.status).toBe(200);
    const ids = list.body.items.map((x: any) => x.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(big.body.id);
    for (const id of [draft.id, big.body.id]) {
      expect((await ncc(A, "GET", `/orders/${id}`)).status).toBe(404);
      expect((await ncc(A, "POST", `/orders/${id}/respond`, { action: "confirm", version: 1 })).status).toBe(404);
      expect((await ncc(A, "GET", `/orders/${id}/pdf`)).status).toBe(404);
    }
    // PO nháp huỷ (chưa từng gửi) cũng không hiện; PO đã gửi rồi bị huỷ thì hiện (NCC cần biết)
    await api("manager", "POST", `${V}/purchase-orders/${draft.id}/cancel`, { reason: "bỏ" });
    expect((await ncc(A, "GET", `/orders/${draft.id}`)).status).toBe(404);
    const sent = await mkSentPo(9701, [{ productId: 9711, qty: 3 }]);
    expect((await api("manager", "POST", `${V}/purchase-orders/${sent.id}/cancel`, { reason: "Đổi kế hoạch nội bộ - mật" })).status).toBe(200);
    const seen = await ncc(A, "GET", `/orders/${sent.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.status).toBe("cancelled");
    expect(JSON.stringify(seen.body)).not.toContain("mật"); // lý do huỷ nội bộ không lộ
  });

  it("danh sách + lọc: trạng thái, ngày gửi, mã; counts/summary; phân trang", async () => {
    const p1 = await mkSentPo(9701, [{ productId: 9711, qty: 2 }]);
    const p2 = await mkSentPo(9701, [{ productId: 9712, qty: 4 }]);
    await api("manager", "POST", `${V}/purchase-orders/${p2.id}/supplier-response`, { action: "confirm", version: p2.version });
    const all = await ncc(A, "GET", "/orders");
    expect(all.body.items[0].id).toBeGreaterThan(all.body.items[1].id); // mới nhất trước
    expect(all.body.counts.sent).toBeGreaterThanOrEqual(1);
    expect(all.body.summary.awaitingYou).toBe(all.body.counts.sent);
    const sentOnly = await ncc(A, "GET", "/orders?status=sent");
    expect(sentOnly.body.items.every((x: any) => x.status === "sent")).toBe(true);
    expect(sentOnly.body.items.map((x: any) => x.id)).toContain(p1.id);
    expect(sentOnly.body.items.map((x: any) => x.id)).not.toContain(p2.id);
    expect((await ncc(A, "GET", `/orders?q=${p1.code}`)).body.items.map((x: any) => x.id)).toEqual([p1.id]);
    expect((await ncc(A, "GET", `/orders?q=%25`)).body.items).toHaveLength(0); // ký tự % được escape
    const today = vnDate();
    expect((await ncc(A, "GET", `/orders?from=${today}&to=${today}`)).body.items.map((x: any) => x.id)).toContain(p1.id);
    expect((await ncc(A, "GET", `/orders?from=${addDays(today, 1)}`)).body.items).toHaveLength(0);
    const pg = await ncc(A, "GET", "/orders?limit=2");
    expect(pg.body.items).toHaveLength(2);
    expect(pg.body.nextCursor).toBeTruthy();
    const pg2 = await ncc(A, "GET", `/orders?limit=2&cursor=${pg.body.nextCursor}`);
    expect(pg2.body.items.every((x: any) => x.id < Number(pg.body.nextCursor))).toBe(true);
  });

  it("chi tiết: chỉ giá trên PO của NCC; không có giá bán, khách/SO nguồn, tồn kho, giá vốn lô, nhân viên, SKU, ghi chú dòng nội bộ", async () => {
    await mkSupplier(9703, "NCC Có Nguồn");
    await mkProduct(9721, { stockMilli: 0, cost: 28000, supplierId: 9703, price: 99999 });
    const cust = await mkCustomer("KH Bí Mật Tuyệt Đối");
    const so = await mkB2bOrder(cust, [{ productId: 9721, qty: 7 }]);
    await runPoCutoff(db(), { mode: "now", actor: { type: "system", userId: null } });
    const draft = (await db().prepare(`SELECT p.* FROM purchase_orders p JOIN purchase_order_lines l ON l.po_id = p.id WHERE l.product_id = 9721 AND p.status = 'draft'`).first<any>())!;
    const d = await po(draft.id);
    const put = await api("manager", "PUT", `${V}/purchase-orders/${draft.id}`, { version: d.version, note: "Giao trước 6h sáng", lines: [{ productId: 9721, qty: 7, unitCost: 41000, note: "GHI CHÚ NỘI BỘ DÒNG" }] });
    expect(put.status).toBe(200);
    await api("manager", "POST", `${V}/purchase-orders/${draft.id}/approve`, {});
    const N = await mkNcc(9703, "co-nguon@example.com");
    const r = await ncc(N, "GET", `/orders/${draft.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ code: draft.code, status: "sent", canRespond: true, note: "Giao trước 6h sáng", total: 287_000 });
    expect(r.body.lines[0]).toMatchObject({ productName: "Hàng PO 9721", qtyMilli: 7000, unitCost: 41000, lineTotal: 287_000, receivedMilli: 0 });
    const txt = JSON.stringify(r.body);
    for (const leak of ["Bí Mật", so.body.code, "99999", "GHI CHÚ NỘI BỘ", "PO9721", "28000", "sources", "shortage", "Test manager", "createdBy", "approvedBy", "approval", "cutoff", "nightly", "customer"])
      expect(txt, leak).not.toContain(leak);
    // chuỗi trả về cho danh sách cũng không có
    expect(JSON.stringify((await ncc(N, "GET", "/orders")).body)).not.toMatch(/Bí Mật|PO9721|nightly|createdBy/);
  });
});

describe("xác nhận / đề xuất / từ chối", () => {
  it("xác nhận nguyên PO → confirmed (chốt SL/giá = số đặt); thông báo ERP cho người có purchasing.approve; audit actor NCC", async () => {
    const p = await mkSentPo(9701, [{ productId: 9711, qty: 5, unitCost: 32000 }]);
    const before = (await db().prepare(`SELECT COUNT(*) n FROM notifications`).first<any>()).n;
    const r = await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "confirm", version: p.version, expectedDate: addDays(vnDate(), 2), note: "Giao 6h sáng" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "confirmed", expectedDate: addDays(vnDate(), 2), supplierNote: "Giao 6h sáng", canRespond: false });
    expect(r.body.lines[0]).toMatchObject({ confirmedQtyMilli: 5000, confirmedUnitCost: 32000 });
    const cur = await po(p.id);
    expect(cur.status).toBe("confirmed");
    // thông báo ERP
    const n = await db().prepare(`SELECT * FROM notifications WHERE ref_type = 'purchase_order' AND ref_id = ? ORDER BY id DESC`).bind(p.id).first<any>();
    expect(n).toMatchObject({ kind: "po_supplier_confirm", audience_perm: "purchasing.approve", url: `/purchase-orders?open=${p.id}` });
    expect(n.title).toContain("NCC Cam Đơn");
    expect(n.title).toContain(p.code);
    expect((await db().prepare(`SELECT COUNT(*) n FROM notifications`).first<any>()).n).toBe(before + 1);
    expect((await db().prepare(`SELECT COUNT(*) n FROM integration_jobs WHERE type = 'notify.managers' AND ref_type = 'purchase_order' AND ref_id = ?`).bind(p.id).first<any>()).n).toBe(1);
    // người có purchasing.approve thấy trong chuông; thu ngân thì không
    const mgr = await api("manager", "GET", `${V}/notifications`);
    expect(mgr.body.items.some((x: any) => x.title.includes(p.code))).toBe(true);
    const owner = await api("owner", "GET", `${V}/notifications`);
    expect(owner.body.items.some((x: any) => x.title.includes(p.code))).toBe(true);
    const wh = await api("warehouse", "GET", `${V}/notifications`);
    expect(wh.body.items.some((x: any) => x.title.includes(p.code))).toBe(false);
    // audit
    const aud = await db().prepare(`SELECT * FROM audit_log WHERE action = 'po.supplier_confirm' AND entity_id = ?`).bind(String(p.id)).first<any>();
    expect(aud).toMatchObject({ actor: `supplier_account:${A.account.id}`, user_id: null });
    expect(aud.ip).toBeTruthy();
    // đã xác nhận rồi: phản hồi lần hai 409 invalid_status
    const again = await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "reject", version: cur.version, note: "đổi ý" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("invalid_status");
    // lịch sử trên cổng
    expect(r.body.history.map((h: any) => h.label)).toEqual(expect.arrayContaining(["Cửa hàng gửi đơn đặt hàng", "Bạn xác nhận đơn"]));
  });

  it("version cũ → 409 version_conflict, PO không đổi", async () => {
    const p = await mkSentPo(9701, [{ productId: 9712, qty: 2 }]);
    const r = await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "confirm", version: p.version - 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("version_conflict");
    expect((await po(p.id)).status).toBe("sent");
    // cửa hàng sửa trước (huỷ) rồi NCC phản hồi bằng version cũ → từ chối
    expect((await api("manager", "POST", `${V}/purchase-orders/${p.id}/cancel`, { reason: "Huỷ đơn" })).status).toBe(200);
    expect((await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "confirm", version: p.version })).status).toBe(409);
  });

  it("đề xuất sửa (SL, giá, ngày giao, ghi chú dòng) → supplier_proposed; cửa hàng chấp nhận → confirmed theo đề xuất; NCC thấy kết quả", async () => {
    const p = await mkSentPo(9701, [{ productId: 9711, qty: 10, unitCost: 30000 }, { productId: 9712, qty: 6, unitCost: 20000 }]);
    const [l1, l2] = p.lines;
    const exp = addDays(vnDate(), 3);
    const r = await ncc(A, "POST", `/orders/${p.id}/respond`, {
      action: "propose", version: p.version, expectedDate: exp, note: "Thiếu hàng đợt này",
      lines: [{ lineId: l1.id, qtyMilli: 8000, unitCost: 33000, note: "Chỉ còn 8kg" }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "supplier_proposed", proposedExpectedDate: exp, supplierNote: "Thiếu hàng đợt này", canRespond: false });
    expect(r.body.lines[0]).toMatchObject({ proposedQtyMilli: 8000, proposedUnitCost: 33000, supplierNote: "Chỉ còn 8kg" });
    expect(r.body.lines[1]).toMatchObject({ proposedQtyMilli: 6000, proposedUnitCost: 20000 }); // dòng không nêu giữ nguyên
    const n = await db().prepare(`SELECT kind FROM notifications WHERE ref_type = 'purchase_order' AND ref_id = ?`).bind(p.id).first<any>();
    expect(n.kind).toBe("po_supplier_propose");
    // cổng NCC không cho phản hồi tiếp khi đang chờ cửa hàng
    expect((await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "confirm", version: r.body.version })).status).toBe(409);
    const acc = await api("manager", "POST", `${V}/purchase-orders/${p.id}/proposal/accept`, { version: (await po(p.id)).version });
    expect(acc.status).toBe(200);
    const seen = await ncc(A, "GET", `/orders/${p.id}`);
    expect(seen.body).toMatchObject({ status: "confirmed", expectedDate: exp });
    expect(seen.body.lines[0]).toMatchObject({ confirmedQtyMilli: 8000, confirmedUnitCost: 33000, lineTotal: 264_000 });
    expect(seen.body.history.map((h: any) => h.label)).toEqual(expect.arrayContaining(["Bạn đề xuất sửa đơn", "Cửa hàng chấp nhận đề xuất của bạn"]));
  });

  it("cửa hàng từ chối đề xuất → PO về sent kèm lời đáp (storeReply) và NCC phản hồi lại được", async () => {
    const p = await mkSentPo(9701, [{ productId: 9713, qty: 4, unitCost: 30000 }]);
    const r = await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "propose", version: p.version, lines: [{ lineId: p.lines[0].id, unitCost: 45000 }] });
    expect(r.body.status).toBe("supplier_proposed");
    const rej = await api("manager", "POST", `${V}/purchase-orders/${p.id}/proposal/reject`, { version: (await po(p.id)).version, reason: "Giá cao hơn thị trường" });
    expect(rej.status).toBe(200);
    const seen = await ncc(A, "GET", `/orders/${p.id}`);
    expect(seen.body).toMatchObject({ status: "sent", canRespond: true, storeReply: "Giá cao hơn thị trường" });
    expect(seen.body.history.find((h: any) => h.label === "Cửa hàng không chấp nhận đề xuất").note).toBe("Giá cao hơn thị trường");
    const ok = await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "confirm", version: seen.body.version });
    expect(ok.body.status).toBe("confirmed");
    expect(ok.body.storeReply).toBeNull();
  });

  it("từ chối: bắt buộc lý do; thành công → rejected + thông báo ERP; storeReply là null", async () => {
    const p = await mkSentPo(9701, [{ productId: 9711, qty: 1 }]);
    expect((await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "reject", version: p.version })).status).toBe(422);
    expect((await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "reject", version: p.version, note: "  " })).status).toBe(422);
    expect((await po(p.id)).status).toBe("sent");
    const r = await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "reject", version: p.version, note: "Hết hàng mùa này" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "rejected", supplierNote: "Hết hàng mùa này" });
    const n = await db().prepare(`SELECT title, body FROM notifications WHERE ref_type = 'purchase_order' AND ref_id = ?`).bind(p.id).first<any>();
    expect(n.title).toContain("từ chối");
    expect(n.body).toContain("Hết hàng mùa này");
  });

  it("dữ liệu sai: dòng không thuộc PO, SL âm, giá không nguyên, ngày giao quá khứ / quá xa, action lạ, đề xuất rỗng, JSON hỏng", async () => {
    const p = await mkSentPo(9701, [{ productId: 9711, qty: 3 }]);
    const other = await mkSentPo(9701, [{ productId: 9712, qty: 3 }]);
    const send = (body: unknown) => ncc(A, "POST", `/orders/${p.id}/respond`, body);
    expect((await send({ action: "propose", version: p.version, lines: [{ lineId: other.lines[0].id, qtyMilli: 1000 }] })).body.error.code).toBe("line_not_in_po");
    expect((await send({ action: "propose", version: p.version, lines: [{ lineId: p.lines[0].id, qtyMilli: -1 }] })).status).toBe(422);
    expect((await send({ action: "propose", version: p.version, lines: [{ lineId: p.lines[0].id, unitCost: 1.5 }] })).status).toBe(422);
    expect((await send({ action: "confirm", version: p.version, expectedDate: addDays(vnDate(), -1) })).body.error.code).toBe("invalid_date");
    expect((await send({ action: "confirm", version: p.version, expectedDate: addDays(vnDate(), 400) })).body.error.code).toBe("invalid_date");
    expect((await send({ action: "huy", version: p.version })).status).toBe(422);
    expect((await send({ action: "propose", version: p.version })).status).toBe(422);
    expect((await ncc(A, "POST", `/orders/${p.id}/respond`, {})).status).toBe(422);
    expect((await call("POST", `/api/ncc/orders/${p.id}/respond`, undefined, { headers: A.headers, raw: "{hong" })).status).toBe(400);
    expect((await po(p.id)).status).toBe("sent");
    expect((await po(other.id)).status).toBe("sent");
  });

  it("hai tài khoản cùng NCC phản hồi đồng thời: chỉ một thành công", async () => {
    const A2 = await mkNcc(9701, "don-a2@example.com");
    const p = await mkSentPo(9701, [{ productId: 9713, qty: 2 }]);
    const rs = await Promise.all([
      ncc(A, "POST", `/orders/${p.id}/respond`, { action: "confirm", version: p.version }),
      ncc(A2, "POST", `/orders/${p.id}/respond`, { action: "reject", version: p.version, note: "không giao được" }),
    ]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(1);
    expect((await db().prepare(`SELECT COUNT(*) n FROM notifications WHERE ref_type = 'purchase_order' AND ref_id = ?`).bind(p.id).first<any>()).n).toBe(1);
  });
});

describe("PDF + nhận hàng hiện trên cổng", () => {
  it("PDF PO của chính NCC: application/pdf, có đơn giá (giá PO của họ); audit tải PDF", async () => {
    const p = await mkSentPo(9701, [{ productId: 9711, qty: 3, unitCost: 36000 }]);
    const r = await ncc(A, "GET", `/orders/${p.id}/pdf`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toBe("application/pdf");
    expect(r.res.headers.get("content-disposition")).toContain(`${p.code}.pdf`);
    expect(r.text.startsWith("%PDF")).toBe(true);
    expect((await db().prepare(`SELECT actor FROM audit_log WHERE action = 'ncc.po_pdf' AND entity_id = ?`).bind(String(p.id)).first<any>()).actor).toBe(`supplier_account:${A.account.id}`);
  });

  it("luồng đủ: đề xuất → cửa hàng chấp nhận → nhận hàng → NCC thấy partially_received/received và hoá đơn mua", async () => {
    const p = await mkSentPo(9701, [{ productId: 9712, qty: 10, unitCost: 25000 }]);
    await ncc(A, "POST", `/orders/${p.id}/respond`, { action: "propose", version: p.version, lines: [{ lineId: p.lines[0].id, qtyMilli: 9000 }] });
    await api("manager", "POST", `${V}/purchase-orders/${p.id}/proposal/accept`, {});
    const cur = await po(p.id);
    const r1 = await api("warehouse", "POST", `${V}/purchase-orders/${p.id}/receive`, { version: cur.version, supplierRef: "HD-NCC-777", lines: [{ poLineId: cur.lines[0].id, qtyMilli: 5000 }] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const s1 = await ncc(A, "GET", `/orders/${p.id}`);
    expect(s1.body.status).toBe("partially_received");
    expect(s1.body.lines[0]).toMatchObject({ receivedMilli: 5000, remainingMilli: 4000 });
    expect(s1.body.bills).toEqual([{ code: expect.stringMatching(/^CNP-/), issueDate: vnDate(), total: 125_000, provisional: false }]);
    const r2 = await api("warehouse", "POST", `${V}/purchase-orders/${p.id}/receive`, { lines: [{ poLineId: cur.lines[0].id, qtyMilli: 4000 }] });
    expect(r2.body.status).toBe("received");
    expect((await ncc(A, "GET", `/orders/${p.id}`)).body.status).toBe("received");
    // danh sách "nhận đủ"
    expect((await ncc(A, "GET", "/orders?status=received")).body.items.map((x: any) => x.id)).toContain(p.id);
  });
});
