import { beforeAll, describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { api, login, seedBase, testEnv } from "./helpers";
import { seedSales } from "./seed-sales";
import { app } from "../src/worker/index";
import { buildXlsx } from "../src/worker/services/xlsx";

// Nhập kết quả kiểm kho từ Excel/CSV vào phiếu kiểm kê nháp (docs/KIOTVIET-KHOANG-TRONG.md #7)
const V = "/api/v1";
const db = () => testEnv.DB;
const H = ["Mã lô", "Mã hàng", "Đơn vị", "Số đếm"];
const xlsx = (rows: string[][], header = H) => buildXlsx([{ name: "K", columns: header.map((h) => ({ header: h, type: "text" as const })), rows }]);

async function up(role: string, docId: number, step: "preview" | "commit", bytes: Uint8Array | string, name = "kk.xlsx") {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name));
  const res = await app.request(`${V}/stock-docs/${docId}/count-import/${step}`, { method: "POST", headers: { authorization: `Bearer ${await login(role)}` }, body: fd }, testEnv);
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const newCount = async (locationId = 1, role = "warehouse") => (await api(role, "POST", `${V}/stock-docs`, { type: "count", locationId })).body.id as number;
const lines = async (id: number) => (await db().prepare(`SELECT * FROM stock_doc_lines WHERE doc_id=? ORDER BY lot_id`).bind(id).all<any>()).results;

beforeAll(async () => {
  await seedBase();
  await seedSales();
  const now = new Date().toISOString();
  await db().batch([
    db().prepare(`INSERT INTO products(id, sku, name, base_unit, group_id) VALUES (3,'CAM','Cam sành','kg',1)`),
    // Táo có thêm lô 3 (quầy) và lô 4 (khu hỏng); Cam: lô cách ly + lô hết hạn
    db().prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, expires_at, unit_cost, qty_in_milli, qty_on_hand_milli, status) VALUES
      (3,'LOT-TAO-2',1,1,?1,NULL,60000,4000,4000,'active'),
      (4,'LOT-TAO-H',1,2,?1,NULL,60000,1000,1000,'active'),
      (5,'LOT-CAM-Q',3,1,?1,NULL,40000,3000,3000,'quarantine'),
      (6,'LOT-NHO-OLD',2,1,?1,'2020-01-01T00:00:00Z',150000,2000,2000,'active')`).bind(now),
  ]);
});

describe("Nhập kết quả kiểm kho", () => {
  it("mẫu tải về = danh sách lô tại vị trí; chỉ phiếu kiểm kê nháp; cần quyền inventory.write", async () => {
    const id = await newCount();
    const csv = await app.request(`${V}/stock-docs/${id}/count-import/template.csv`, { headers: { authorization: `Bearer ${await login("warehouse")}` } }, testEnv);
    expect(csv.status).toBe(200);
    const t = await csv.text();
    expect(t).toContain("LOT-TAO-1");
    expect(t).toContain("LOT-TAO-2");
    expect(t).not.toContain("LOT-TAO-H"); // lô ở vị trí khác
    const x = await app.request(`${V}/stock-docs/${id}/count-import/template.xlsx`, { headers: { authorization: `Bearer ${await login("warehouse")}` } }, testEnv);
    expect(x.status).toBe(200);
    expect((await up("cashier", id, "preview", xlsx([["LOT-TAO-1", "", "kg", "1"]]))).status).toBe(403);
    const rec = (await api("warehouse", "POST", `${V}/stock-docs`, { type: "waste", locationId: 1 })).body.id;
    expect((await up("warehouse", rec, "preview", xlsx([["LOT-TAO-1", "", "kg", "1"]]))).body.error.code).toBe("not_count_doc");
  });

  it("xem trước: khớp theo lô/mã hàng, lỗi dòng, cảnh báo cách ly/hết hạn, chênh lệch; chưa ghi gì", async () => {
    const id = await newCount();
    const r = await up("warehouse", id, "preview", xlsx([
      ["LOT-TAO-1", "", "kg", "19"],        // ok, lệch -1
      ["", "NHO", "kg", "5"],               // Nho có 2 lô (LOT-NHO-1 + hết hạn) → lỗi yêu cầu mã lô
      ["", "CAM", "", "3"],                 // một lô duy nhất (cách ly) → khớp + cảnh báo
      ["LOT-NHO-OLD", "", "kg", "2"],       // hết hạn → cảnh báo
      ["LOT-TAO-H", "", "kg", "1"],         // lô ở vị trí khác → lỗi
      ["LOT-TAO-2", "NHO", "kg", "1"],      // sai mặt hàng → lỗi
      ["LOT-TAO-2", "", "thung", "0,2"],    // 0,2 thùng = 2kg (lệch -2kg)
      ["LOT-TAO-2", "", "kg", "1"],         // trùng lô → lỗi
      ["LOT-NHO-1", "", "kg", "abc"],       // số sai → lỗi
      ["LOT-NHO-1", "", "kg", ""],          // chưa đếm → bỏ qua
      ["LOT-NHO-1", "", "xe", "1"],         // đơn vị lạ → lỗi
      ["LOT-KHONG", "", "kg", "1"],         // không có lô → lỗi
    ]));
    expect(r.status).toBe(200);
    const by = (l: number) => r.body.rows.find((x: any) => x.line === l);
    expect(by(2)).toMatchObject({ status: "ok", systemQty: 20, countedQty: 19, diffQty: -1 });
    expect(by(3).errors[0]).toContain("2 lô");
    expect(by(4)).toMatchObject({ status: "ok", lotCode: "LOT-CAM-Q" });
    expect(by(4).warnings.join()).toContain("cách ly");
    expect(by(5).warnings.join()).toContain("hết hạn");
    expect(by(6).errors[0]).toContain("không thuộc vị trí");
    expect(by(7).errors[0]).toContain("mặt hàng khác");
    expect(by(8)).toMatchObject({ status: "ok", systemQty: 0.4, countedQty: 0.2, diffQty: -0.2, unit: "thung" });
    expect(by(9).errors[0]).toContain("Trùng lô");
    expect(by(10).errors[0]).toContain("không hợp lệ");
    expect(by(11).status).toBe("skip");
    expect(by(12).errors[0]).toContain("Đơn vị");
    expect(by(13).errors[0]).toContain("Không có lô");
    expect(r.body.summary).toMatchObject({ ok: 4, error: 7, skip: 1 });
    expect(await lines(id)).toHaveLength(0);
  });

  it("chống công thức (xlsx và CSV) và cột bắt buộc", async () => {
    const id = await newCount();
    const f = await up("warehouse", id, "preview", strToU8("﻿Mã lô,Mã hàng,Đơn vị,Số đếm\r\n=1+1,,kg,3\r\nLOT-TAO-1,,kg,@SUM(A1)\r\n"), "a.csv");
    expect(f.body.rows.every((x: any) => x.status === "error")).toBe(true);
    expect(f.body.rows[0].errors.join()).toContain("công thức");
    const bad = await up("warehouse", id, "preview", xlsx([["a"]], ["Cột lạ"]));
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("missing_columns");
  });

  it("xác nhận: ghi dòng vào phiếu nháp với tồn lúc đếm; không ghi sổ; ghi đè lô đã có; audit; nhập lại file chỉ ghi đè", async () => {
    const id = await newCount(1, "owner");
    // có sẵn một dòng đếm tay cho LOT-TAO-1
    await api("owner", "POST", `${V}/stock-docs/${id}/lines`, { lotId: 1, countedQty: 10, unit: "kg" });
    const file = xlsx([["LOT-TAO-1", "", "kg", "19"], ["LOT-TAO-2", "", "kg", "4"], ["LOT-NHO-1", "", "kg", "x"]]);
    const c = await up("owner", id, "commit", file);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ added: 1, overwritten: 1, errors: 1 });
    const ls = await lines(id);
    expect(ls.map((l: any) => [l.lot_id, l.qty_milli, l.doc_qty_milli])).toEqual([[1, 19000, 20000], [3, 4000, 4000]]);
    expect((await db().prepare(`SELECT status FROM stock_docs WHERE id=?`).bind(id).first<any>())!.status).toBe("draft");
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=1`).first<any>())!.q).toBe(20000); // chưa ghi sổ
    expect((await db().prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='import.count' AND entity_id=?`).bind(String(id)).first<any>())!.n).toBe(1);
    const again = await up("owner", id, "commit", file); // nhập lại cùng file: chỉ ghi đè cùng số, không tạo thêm dòng
    expect(again.body).toMatchObject({ added: 0, overwritten: 2 });
    expect(await lines(id)).toHaveLength(2);
    // vẫn đi theo luồng ghi sổ kiểm kê hiện có
    const post = await api("owner", "POST", `${V}/stock-docs/${id}/post`, {});
    expect([200, 201]).toContain(post.status);
    expect((await db().prepare(`SELECT qty_on_hand_milli q FROM lots WHERE id=1`).first<any>())!.q).toBe(19000);
  });

  it("phiếu không còn nháp → 409; không có dòng hợp lệ → 422", async () => {
    const id = await newCount();
    expect((await up("warehouse", id, "commit", xlsx([["LOT-KHONG", "", "kg", "1"]]))).body.error.code).toBe("nothing_to_import");
    await api("warehouse", "POST", `${V}/stock-docs/${id}/cancel`, {});
    expect((await up("warehouse", id, "preview", xlsx([["LOT-TAO-1", "", "kg", "1"]]))).body.error.code).toBe("doc_not_draft");
  });
});
