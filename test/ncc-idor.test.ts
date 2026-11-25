import { beforeAll, describe, expect, it } from "vitest";
import { api, call, db, mkNcc, mkProduct, mkSentPo, mkSupplier, ncc, seedBase, V, type NccSession, NCC_PW, NCC_PW_NEW, NCC_PW_NEW_B } from "./ncc-helpers";
import { seedShop, testEnv } from "./shop-helpers";
import { FONT_KEYS } from "../src/worker/services/pdf";
import regularFont from "@expo-google-fonts/be-vietnam-pro/400Regular/BeVietnamPro_400Regular.ttf?inline";
import boldFont from "@expo-google-fonts/be-vietnam-pro/700Bold/BeVietnamPro_700Bold.ttf?inline";
import { vnDate } from "../src/worker/lib/time";

// Cổng NCC — IDOR: NCC A không xem/sửa được PO, hoá đơn, sao kê, thanh toán, PDF của NCC B, kể cả đoán id (docs/PO-NCC.md mục 5)
const fromDataUri = (u: string) => Uint8Array.from(atob(u.slice(u.indexOf(",") + 1)), (c) => c.charCodeAt(0));
let A: NccSession, B: NccSession;
let poA: any, poB: any, draftB: any;
let billB = "", payB = "";

async function receipt(supplierId: number, productId: number, qty: number, unitCost: number, ref: string) {
  const d = await api("manager", "POST", `${V}/stock-docs`, { type: "receipt", locationId: 1, supplierId, supplierRef: ref });
  await api("manager", "POST", `${V}/stock-docs/${d.body.id}/lines`, { productId, unit: "kg", qty, unitCost });
  await api("manager", "POST", `${V}/stock-docs/${d.body.id}/post`);
  return (await db().prepare(`SELECT * FROM supplier_bills WHERE stock_doc_id = ?`).bind(d.body.id).first<any>())!;
}

beforeAll(async () => {
  await seedShop();
  await seedBase();
  await testEnv.FILES.put(FONT_KEYS.regular, fromDataUri(regularFont));
  await testEnv.FILES.put(FONT_KEYS.bold, fromDataUri(boldFont));
  await mkSupplier(9901, "NCC IDOR A");
  await mkSupplier(9902, "NCC IDOR B");
  for (const id of [9911, 9912]) await mkProduct(id, { stockMilli: 1000, cost: 20000 });
  A = await mkNcc(9901, "idor-a@example.com");
  B = await mkNcc(9902, "idor-b@example.com");
  poA = await mkSentPo(9901, [{ productId: 9911, qty: 3, unitCost: 11111 }]);
  poB = await mkSentPo(9902, [{ productId: 9912, qty: 4, unitCost: 22222 }]);
  draftB = (await api("manager", "POST", `${V}/purchase-orders`, { supplierId: 9902, lines: [{ productId: 9912, qty: 1, unitCost: 1 }] })).body;
  const bB = await receipt(9902, 9912, 10, 12_345, "HD-IDOR-B");
  billB = bB.code;
  await receipt(9901, 9911, 5, 10_000, "HD-IDOR-A");
  const pay = await api("accountant", "POST", `${V}/debts/payments`, { direction: "out", partnerType: "supplier", partnerId: 9902, fundId: 1, amount: 30_000, method: "cash" });
  payB = pay.body.payment.code;
});

describe("IDOR theo từng route /api/ncc", () => {
  it("GET /orders: chỉ PO của NCC mình, bỏ qua mọi tham số supplierId / id cố ý chèn", async () => {
    for (const qs of ["", `?supplierId=9902`, `?supplier_id=9902`, `?q=${poB.code}`, `?status=sent,confirmed&supplierId=9902`]) {
      const r = await ncc(A, "GET", `/orders${qs}`);
      expect(r.status).toBe(200);
      const ids = r.body.items.map((x: any) => x.id);
      if (qs === "" || qs.includes("status") || qs.includes("supplier")) expect(ids, qs).toContain(poA.id);
      if (qs.startsWith("?q=")) expect(ids, qs).toEqual([]); // tìm theo mã PO của NCC khác → không ra gì
      expect(ids, qs).not.toContain(poB.id);
      expect(JSON.stringify(r.body), qs).not.toContain(poB.code);
    }
    expect((await ncc(B, "GET", "/orders")).body.items.map((x: any) => x.id)).not.toContain(poA.id);
    expect((await ncc(B, "GET", "/orders")).body.items.map((x: any) => x.id)).not.toContain(draftB.id); // B cũng không thấy PO nháp của mình
  });

  it("GET /orders/:id, /pdf, POST /respond với id của NCC khác (và id không tồn tại, id rác, nháp) → 404 giống hệt nhau; PO của B không bị đổi", async () => {
    const probe = async (m: string, path: (id: any) => string, body?: unknown) => {
      const ids = [poB.id, draftB.id, 99999999, 0, -1, "abc", "1e3"];
      const res = await Promise.all(ids.map((id) => ncc(A, m, path(id), body)));
      for (const r of res) expect(r.status, `${m} ${path("?")}`).toBe(404);
      for (const r of res) expect(r.body.error.code).toBe("po_not_found");
      for (const r of res) expect(r.body.error.message).toBe(res[0].body.error.message);
    };
    await probe("GET", (id) => `/orders/${id}`);
    await probe("GET", (id) => `/orders/${id}/pdf`);
    await probe("POST", (id) => `/orders/${id}/respond`, { action: "reject", version: poB.version, note: "tấn công IDOR" });
    await probe("POST", (id) => `/orders/${id}/respond`, { action: "confirm", version: poB.version });
    const cur = (await api("manager", "GET", `${V}/purchase-orders/${poB.id}`)).body;
    expect(cur.status).toBe("sent");
    expect(cur.version).toBe(poB.version);
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'po.supplier_%' AND entity_id = ?`).bind(String(poB.id)).first<any>()).n).toBe(0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM notifications WHERE ref_type = 'purchase_order' AND ref_id = ?`).bind(poB.id).first<any>()).n).toBe(0);
    // chiều ngược lại
    expect((await ncc(B, "GET", `/orders/${poA.id}`)).status).toBe(404);
  });

  it("respond trên PO của mình nhưng lineId của PO NCC khác → 422 line_not_in_po, không ghi gì vào PO B", async () => {
    const r = await ncc(A, "POST", `/orders/${poA.id}/respond`, { action: "propose", version: poA.version, lines: [{ lineId: poB.lines[0].id, qtyMilli: 1, unitCost: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("line_not_in_po");
    const l = await db().prepare(`SELECT proposed_qty_milli, proposed_unit_cost, supplier_line_note FROM purchase_order_lines WHERE id = ?`).bind(poB.lines[0].id).first<any>();
    expect(l).toEqual({ proposed_qty_milli: null, proposed_unit_cost: null, supplier_line_note: null });
    expect((await api("manager", "GET", `${V}/purchase-orders/${poA.id}`)).body.status).toBe("sent");
  });

  it("GET /debt, /statement, /payments, /users: chỉ dữ liệu NCC mình; không có tham số nào đổi được NCC", async () => {
    const dA = await ncc(A, "GET", "/debt?supplierId=9902");
    expect(dA.body.summary.balance).toBe(50_000);
    expect(JSON.stringify(dA.body)).not.toContain(billB);
    expect(JSON.stringify(dA.body)).not.toContain("HD-IDOR-B");
    const dB = await ncc(B, "GET", "/debt");
    expect(dB.body.summary.balance).toBe(123_450 - 30_000);
    expect(dB.body.bills.map((b: any) => b.code)).toEqual([billB]);
    const stA = await ncc(A, "GET", `/statement?supplierId=9902&partnerId=9902&from=${vnDate()}&to=${vnDate()}`);
    expect(stA.body.closing).toBe(50_000);
    expect(JSON.stringify(stA.body)).not.toContain(billB);
    expect(JSON.stringify(stA.body)).not.toContain(payB);
    const pA = await ncc(A, "GET", "/payments?supplierId=9902&partnerId=9902");
    expect(pA.body.items).toEqual([]);
    expect(JSON.stringify(pA.body)).not.toContain(payB);
    expect((await ncc(B, "GET", "/payments")).body.items.map((p: any) => p.code)).toEqual([payB]);
    const uA = await ncc(A, "GET", "/users?supplierId=9902");
    expect(uA.body.items.map((u: any) => u.email)).toEqual(["idor-a@example.com"]);
  });

  it("chi tiết PO của mình không chứa mã/ID của NCC khác; không có route nhận supplier id từ client", async () => {
    const r = await ncc(A, "GET", `/orders/${poA.id}`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/NCC IDOR B|9902|idor-b/);
    expect(r.body).not.toHaveProperty("supplierId");
    // mọi route đã đăng ký nằm dưới /api/ncc; không có route /api/ncc/suppliers/:id hay /api/ncc/bills/:id
    for (const p of ["/suppliers/9902", "/bills/1", "/bills/9902", "/accounts/1", "/orders/1/lines", "/po/1"]) {
      const x = await ncc(A, "GET", p);
      expect(x.status, p).toBe(404);
    }
  });

  it("phiên NCC A không thao tác được tài khoản NCC B (đổi mật khẩu chỉ ảnh hưởng chính mình); mời/khoá chỉ có ở ERP", async () => {
    const r = await ncc(A, "POST", "/me/password", { currentPassword: NCC_PW, newPassword: NCC_PW_NEW_B, accountId: B.account.id });
    expect(r.status).toBe(200);
    // B vẫn đăng nhập được bằng mật khẩu cũ
    expect((await call("POST", "/api/ncc/auth/login", { email: "idor-b@example.com", password: NCC_PW })).status).toBe(200);
    // các route quản lý tài khoản của ERP không tồn tại ở cổng; cũng không dùng phiên NCC để gọi ERP
    for (const p of ["/api/ncc/invites", "/api/ncc/portal", "/api/ncc/users/1/lock"]) expect((await call("POST", p, {}, { headers: A.headers })).status, p).toBe(404);
    const tok = A.headers.cookie.split("=")[1];
    const { app } = await import("../src/worker/index");
    const erp = await app.request(`${V}/purchase-orders/${poB.id}`, { headers: { authorization: `Bearer ${tok}`, cookie: A.headers.cookie } }, testEnv as any);
    expect(erp.status).toBe(401);
  });

  it("thông tin phiên: /me chỉ trả tài khoản + tên/mã NCC của chính mình", async () => {
    const r = await ncc(A, "GET", "/me");
    expect(r.body.account.supplier).toEqual({ name: "NCC IDOR A", code: "NCC9901" });
    expect(Object.keys(r.body.account).sort()).toEqual(["email", "fullName", "id", "phone", "supplier"]);
  });
});
