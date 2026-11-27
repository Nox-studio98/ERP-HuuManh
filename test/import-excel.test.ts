import { beforeAll, describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { login, seedBase, testEnv } from "./helpers";
import { app } from "../src/worker/index";
import { buildXlsx } from "../src/worker/services/xlsx";
import { parseImportFile } from "../src/worker/services/import-parse";

// Đợt 8 — nhập Excel/CSV hàng loạt: hàng hoá, khách sỉ, nhà cung cấp (xem trước → xác nhận ghi).
const V = "/api/v1";
const db = () => testEnv.DB;
beforeAll(seedBase);

const xlsx = (header: string[], rows: string[][]) =>
  buildXlsx([{ name: "Dữ liệu", columns: header.map((h) => ({ header: h, type: "text" as const })), rows }]);

async function upload(role: string, kind: string, step: "preview" | "commit", bytes: Uint8Array | string, name: string, mode?: string) {
  const fd = new FormData();
  fd.set("file", new File([bytes as BlobPart], name));
  if (mode) fd.set("mode", mode);
  const res = await app.request(`${V}/imports/${kind}/${step}`, { method: "POST", headers: { authorization: `Bearer ${await login(role)}` }, body: fd }, testEnv);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function get(role: string, path: string) {
  return app.request(`${V}${path}`, { headers: { authorization: `Bearer ${await login(role)}` } }, testEnv);
}

const PH = ["Mã hàng", "Tên hàng", "Đơn vị chính", "Nhóm hàng", "Bán theo cân", "Mã vạch", "Đơn vị quy đổi", "Hệ số quy đổi", "Mã vạch đơn vị quy đổi", "Giá bán chung", "Hạn dùng (ngày)", "Xuất xứ", "Tồn tối thiểu"];
const prow = (o: Partial<Record<string, string>>) => PH.map((h) => o[h] ?? "");

describe("Phân tích file", () => {
  it("đọc xlsx do chính hệ thống sinh và CSV (BOM, dấu ; , ngoặc kép, xuống dòng trong ô)", () => {
    const x = parseImportFile(xlsx(["A", "B"], [["1", "Xin chào"], ["2", "Tiếng Việt"]]), "a.xlsx");
    expect(x.header).toEqual(["A", "B"]);
    expect(x.rows.map((r) => r.cells)).toEqual([["1", "Xin chào"], ["2", "Tiếng Việt"]]);
    const csv = "﻿Mã;Tên\r\nM1;\"Có; dấu chấm phẩy\"\r\nM2;\"Hai\ndòng\"\r\nM3;Ba\r\n";
    const c = parseImportFile(strToU8(csv), "a.csv");
    expect(c.header).toEqual(["Mã", "Tên"]);
    expect(c.rows.map((r) => r.cells[1])).toEqual(["Có; dấu chấm phẩy", "Hai\ndòng", "Ba"]);
    expect(c.rows.map((r) => r.line)).toEqual([2, 3, 5]);
  });

  it("từ chối: quá lớn, quá nhiều dòng, không phải UTF-8, sai đuôi, .xls", async () => {
    expect(() => parseImportFile(new Uint8Array(3 * 1024 * 1024), "a.csv")).toThrow(/quá lớn/);
    const many = "A\n" + Array.from({ length: 1001 }, (_, i) => String(i)).join("\n");
    expect(() => parseImportFile(strToU8(many), "a.csv")).toThrow(/tối đa 1000/);
    expect(() => parseImportFile(new Uint8Array([0x4d, 0xe3, 0x20, 0xff]), "a.csv")).toThrow(/UTF-8/);
    expect(() => parseImportFile(strToU8("a"), "a.pdf")).toThrow(/xlsx hoặc .csv/);
    expect(() => parseImportFile(strToU8("a"), "a.xls")).toThrow(/xlsx/);
  });
});

describe("File mẫu", () => {
  it("tải được xlsx (2 trang: Dữ liệu + Hướng dẫn) và csv cho cả ba loại; mẫu đọc lại được", async () => {
    for (const kind of ["products", "customers", "suppliers"]) {
      const r = await get("owner", `/imports/${kind}/template.xlsx`);
      expect(r.status).toBe(200);
      const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
      expect(Object.keys(files).filter((k) => k.startsWith("xl/worksheets/"))).toHaveLength(2);
      const csv = await get("owner", `/imports/${kind}/template.csv`);
      expect(csv.status).toBe(200);
      const sheet = parseImportFile(new Uint8Array(await csv.arrayBuffer()), "mau.csv");
      expect(sheet.header.length).toBeGreaterThan(3);
      expect(sheet.rows.length).toBeGreaterThan(0);
      const info = await get("owner", `/imports/${kind}`);
      expect((await info.json() as any).columns.some((c: any) => c.required)).toBe(true);
    }
  });

  it("file mẫu hàng hoá tải xuống dùng thẳng để xem trước: không có lỗi", async () => {
    const t = new Uint8Array(await (await get("owner", "/imports/products/template.xlsx")).arrayBuffer());
    const p = await upload("owner", "products", "preview", t, "mau.xlsx");
    expect(p.status).toBe(200);
    expect(p.body.summary.error).toBe(0);
    expect(p.body.summary.create).toBe(2);
  });
});

describe("Quyền", () => {
  it("mỗi loại theo quyền tạo danh mục tương ứng", async () => {
    const t = (kind: string) => get("cashier", `/imports/${kind}/template.csv`);
    for (const k of ["products", "customers", "suppliers"]) expect((await t(k)).status).toBe(403);
    expect((await get("warehouse", "/imports/suppliers/template.csv")).status).toBe(200);
    expect((await get("warehouse", "/imports/products/template.csv")).status).toBe(403);
    expect((await get("warehouse", "/imports/customers/template.csv")).status).toBe(403);
    expect((await get("accountant", "/imports/customers/template.csv")).status).toBe(403);
    expect((await get("manager", "/imports/customers/template.csv")).status).toBe(200);
    expect((await get("owner", "/imports/nope/template.csv")).status).toBe(404);
    expect((await upload("cashier", "products", "preview", xlsx(PH, [prow({ "Mã hàng": "X" })]), "a.xlsx")).status).toBe(403);
  });
});

describe("Hàng hoá", () => {
  it("xem trước báo đúng: tạo mới / trùng / lỗi (thiếu tên, giá sai, mã vạch trùng, công thức, đơn vị)", async () => {
    // mã đã có để thử trùng
    const exist = await upload("owner", "products", "commit", xlsx(PH, [prow({ "Mã hàng": "IMP-EXIST", "Tên hàng": "Cam cũ", "Đơn vị chính": "kg", "Mã vạch": "8930000000011" })]), "e.xlsx");
    expect(exist.status).toBe(201);
    const file = xlsx(PH, [
      prow({ "Mã hàng": "IMP-NEW1", "Tên hàng": "Táo Envy", "Đơn vị chính": "kg", "Nhóm hàng": "Nhóm Excel mới", "Bán theo cân": "Có", "Giá bán chung": "120.000", "Đơn vị quy đổi": "thùng", "Hệ số quy đổi": "10" }),
      prow({ "Mã hàng": "IMP-NEW1", "Đơn vị quy đổi": "khay", "Hệ số quy đổi": "2,5" }),
      prow({ "Mã hàng": "imp-exist", "Tên hàng": "Cam mới", "Đơn vị chính": "kg" }),
      prow({ "Mã hàng": "IMP-BAD1", "Tên hàng": "", "Đơn vị chính": "kg" }),
      prow({ "Mã hàng": "IMP-BAD2", "Tên hàng": "Giá sai", "Đơn vị chính": "kg", "Giá bán chung": "abc" }),
      prow({ "Mã hàng": "IMP-BAD3", "Tên hàng": "Trùng mã vạch", "Đơn vị chính": "kg", "Mã vạch": "8930000000011" }),
      prow({ "Mã hàng": "IMP-BAD4", "Tên hàng": "=HYPERLINK(\"http://x\")", "Đơn vị chính": "kg" }),
      prow({ "Mã hàng": "IMP-BAD5", "Tên hàng": "Đơn vị trùng", "Đơn vị chính": "kg", "Đơn vị quy đổi": "kg", "Hệ số quy đổi": "1" }),
      prow({ "Mã hàng": "IMP-BAD6", "Tên hàng": "Quy đổi thiếu hệ số", "Đơn vị chính": "kg", "Đơn vị quy đổi": "thùng" }),
      prow({ "Mã hàng": "IMP-NEW1", "Tên hàng": "Lặp tên", "Đơn vị chính": "kg" }),
    ]);
    const r = await upload("manager", "products", "preview", file, "p.xlsx");
    expect(r.status).toBe(200);
    const by = (sku: string) => r.body.rows.filter((x: any) => x.key === sku || x.fields.sku === sku);
    expect(by("IMP-NEW1")[0]).toMatchObject({ status: "create", errors: [] });
    expect(by("IMP-NEW1")[0].warnings.join()).toContain("nhóm hàng mới");
    expect(by("IMP-NEW1")[1]).toMatchObject({ status: "merged", errors: [] });
    expect(by("IMP-NEW1")[2].errors.join()).toContain("Trùng mã hàng");
    expect(r.body.rows.find((x: any) => x.fields.sku === "imp-exist").status).toBe("exists");
    expect(r.body.rows.find((x: any) => x.fields.sku === "imp-exist").changes.join()).toContain("Cam cũ");
    expect(by("IMP-BAD1")[0].errors.join()).toContain("Thiếu Tên hàng");
    expect(by("IMP-BAD2")[0].errors.join()).toContain("Giá bán");
    expect(by("IMP-BAD3")[0].errors.join()).toContain("Mã vạch");
    expect(by("IMP-BAD4")[0].errors.join()).toContain("công thức");
    expect(by("IMP-BAD5")[0].errors.join()).toContain("trùng đơn vị chính");
    expect(by("IMP-BAD6")[0].errors.join()).toContain("Hệ số");
    expect(r.body.summary).toMatchObject({ lines: 10, create: 1, exists: 1, merged: 1, error: 7 });
    // xem trước không ghi gì
    expect(await db().prepare(`SELECT 1 FROM products WHERE sku = 'IMP-NEW1'`).first()).toBeNull();
    expect(await db().prepare(`SELECT 1 FROM product_groups WHERE name = 'Nhóm Excel mới'`).first()).toBeNull();
  });

  it("xác nhận ghi: tạo hàng + nhóm + đơn vị + mã vạch nội bộ + giá; bỏ qua dòng lỗi; audit; không đụng tồn kho", async () => {
    const lots0 = (await db().prepare(`SELECT COUNT(*) n FROM lots`).first<any>()).n;
    const moves0 = (await db().prepare(`SELECT COUNT(*) n FROM stock_moves`).first<any>()).n;
    const file = xlsx(PH, [
      prow({ "Mã hàng": "IMP-OK1", "Tên hàng": "Nho đỏ", "Đơn vị chính": "kg", "Nhóm hàng": "Nhóm Excel mới", "Bán theo cân": "x", "Giá bán chung": "180000", "Đơn vị quy đổi": "thùng", "Hệ số quy đổi": "8", "Hạn dùng (ngày)": "7", "Xuất xứ": "Chile", "Tồn tối thiểu": "20" }),
      prow({ "Mã hàng": "IMP-OK1", "Đơn vị quy đổi": "khay", "Hệ số quy đổi": "0,5", "Mã vạch đơn vị quy đổi": "8930000000099" }),
      prow({ "Mã hàng": "IMP-OK2", "Tên hàng": "Kiwi", "Đơn vị chính": "quả", "Mã vạch": "8930000000028" }),
      prow({ "Mã hàng": "IMP-ERR", "Tên hàng": "", "Đơn vị chính": "kg" }),
    ]);
    const r = await upload("manager", "products", "commit", file, "ok.xlsx", "skip");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: 2, updated: 0, skipped: 0, errors: 1 });
    const p = (await db().prepare(`SELECT p.*, g.name AS gname FROM products p LEFT JOIN product_groups g ON g.id = p.group_id WHERE p.sku = 'IMP-OK1'`).first<any>())!;
    expect(p).toMatchObject({ name: "Nho đỏ", base_unit: "kg", sell_by_weight: 1, origin: "Chile", shelf_life_days: 7, min_stock_milli: 20000, gname: "Nhóm Excel mới", active: 1 });
    expect(p.barcode).toBe("HMP" + String(p.id).padStart(8, "0"));
    const units = (await db().prepare(`SELECT unit, factor_milli, barcode FROM product_units WHERE product_id = ? ORDER BY factor_milli`).bind(p.id).all<any>()).results;
    expect(units).toEqual([{ unit: "khay", factor_milli: 500, barcode: "8930000000099" }, { unit: "kg", factor_milli: 1000, barcode: null }, { unit: "thùng", factor_milli: 8000, barcode: null }]);
    const price = (await db().prepare(`SELECT unit_price, status FROM prices WHERE product_id = ?`).bind(p.id).all<any>()).results;
    expect(price).toEqual([{ unit_price: 180000, status: "active" }]);
    expect((await db().prepare(`SELECT barcode FROM products WHERE sku = 'IMP-OK2'`).first<any>()).barcode).toBe("8930000000028");
    expect(await db().prepare(`SELECT 1 FROM products WHERE sku = 'IMP-ERR'`).first()).toBeNull();
    // không đụng tồn kho
    expect((await db().prepare(`SELECT COUNT(*) n FROM lots`).first<any>()).n).toBe(lots0);
    expect((await db().prepare(`SELECT COUNT(*) n FROM stock_moves`).first<any>()).n).toBe(moves0);
    const a = await db().prepare(`SELECT action, after_json FROM audit_log WHERE action = 'import.products' ORDER BY id DESC`).first<any>();
    expect(JSON.parse(a.after_json)).toMatchObject({ created: 2, mode: "skip" });
    // API hàng hoá thấy hàng mới
    const lk = await (await get("manager", "/products?q=IMP-OK1")).json() as any;
    expect(lk.items.some((x: any) => x.sku === "IMP-OK1")).toBe(true);
  });

  it("ghi lại cùng file (bấm hai lần) → 409 already_done, không nhân đôi", async () => {
    const file = xlsx(PH, [prow({ "Mã hàng": "IMP-ONCE", "Tên hàng": "Một lần", "Đơn vị chính": "kg" })]);
    const a = await upload("owner", "products", "commit", file, "o.xlsx");
    const b = await upload("owner", "products", "commit", file, "o.xlsx");
    expect(a.status).toBe(201);
    expect([409, 422]).toContain(b.status); // lần hai: hàng đã có và đang chọn bỏ qua → nothing_to_import
    expect((await db().prepare(`SELECT COUNT(*) n FROM products WHERE sku = 'IMP-ONCE'`).first<any>()).n).toBe(1);
    // hai lệnh song song cùng file
    const f2 = xlsx(PH, [prow({ "Mã hàng": "IMP-PAR", "Tên hàng": "Song song", "Đơn vị chính": "kg" })]);
    const rs = await Promise.all([1, 2].map(() => upload("owner", "products", "commit", f2, "p.xlsx")));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await db().prepare(`SELECT COUNT(*) n FROM products WHERE sku = 'IMP-PAR'`).first<any>()).n).toBe(1);
  });

  it("trùng mã: chọn 'bỏ qua' giữ nguyên; chọn 'cập nhật' sửa tên/giá/đơn vị, đổi đơn vị chính bị chặn", async () => {
    const mk = (name: string, extra: Record<string, string> = {}) => xlsx(PH, [prow({ "Mã hàng": "IMP-UPD", "Tên hàng": name, "Đơn vị chính": "kg", ...extra })]);
    expect((await upload("owner", "products", "commit", mk("Bản đầu", { "Giá bán chung": "50000" }), "u1.xlsx")).status).toBe(201);
    const skip = await upload("owner", "products", "commit", mk("Bản hai", { "Giá bán chung": "60000" }), "u2.xlsx", "skip");
    expect(skip.status).toBe(422);
    expect(skip.body.error.code).toBe("nothing_to_import");
    expect((await db().prepare(`SELECT name FROM products WHERE sku = 'IMP-UPD'`).first<any>()).name).toBe("Bản đầu");
    const prev = await upload("owner", "products", "preview", mk("Bản hai", { "Giá bán chung": "60000" }), "u2.xlsx");
    expect(prev.body.rows[0].changes).toEqual(expect.arrayContaining([expect.stringContaining("Giá bán"), expect.stringContaining("Tên")]));
    const upd = await upload("owner", "products", "commit", mk("Bản hai", { "Giá bán chung": "60000", "Đơn vị quy đổi": "thùng", "Hệ số quy đổi": "5" }), "u3.xlsx", "update");
    expect(upd.status).toBe(201);
    expect(upd.body).toMatchObject({ created: 0, updated: 1 });
    const p = (await db().prepare(`SELECT id, name, version FROM products WHERE sku = 'IMP-UPD'`).first<any>())!;
    expect(p).toMatchObject({ name: "Bản hai", version: 2 });
    const prices = (await db().prepare(`SELECT unit_price, effective_to FROM prices WHERE product_id = ? ORDER BY id`).bind(p.id).all<any>()).results;
    expect(prices.map((x) => x.unit_price)).toEqual([50000, 60000]);
    expect(prices[0].effective_to).not.toBeNull();
    expect(prices[1].effective_to).toBeNull();
    expect((await db().prepare(`SELECT factor_milli FROM product_units WHERE product_id = ? AND unit = 'thùng'`).bind(p.id).first<any>()).factor_milli).toBe(5000);
    const bad = await upload("owner", "products", "preview", xlsx(PH, [prow({ "Mã hàng": "IMP-UPD", "Tên hàng": "X", "Đơn vị chính": "thùng" })]), "u4.xlsx");
    expect(bad.body.rows[0].errors.join()).toContain("Đơn vị chính khác");
  });

  it("chống chèn công thức: ô có <f> trong xlsx và ô chữ bắt đầu bằng = + @ đều bị báo lỗi, không ghi", async () => {
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Mã hàng</t></is></c><c r="B1" t="inlineStr"><is><t>Tên hàng</t></is></c><c r="C1" t="inlineStr"><is><t>Đơn vị chính</t></is></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>IMP-F1</t></is></c><c r="B2" t="str"><f>CONCATENATE("a","b")</f><v>ab</v></c><c r="C2" t="inlineStr"><is><t>kg</t></is></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>IMP-F2</t></is></c><c r="B3" t="inlineStr"><is><t>+cmd|calc</t></is></c><c r="C3" t="inlineStr"><is><t>kg</t></is></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>IMP-F3</t></is></c><c r="B4" t="inlineStr"><is><t>@SUM(1)</t></is></c><c r="C4" t="inlineStr"><is><t>kg</t></is></c></row>
    </sheetData></worksheet>`;
    const bytes = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet) });
    const r = await upload("owner", "products", "preview", bytes, "f.xlsx");
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ create: 0, error: 3 });
    expect(r.body.rows.every((x: any) => x.errors.join().includes("công thức") || x.errors.join().includes("= + - @"))).toBe(true);
    const c = await upload("owner", "products", "commit", bytes, "f.xlsx");
    expect(c.status).toBe(422);
    expect(await db().prepare(`SELECT 1 FROM products WHERE sku LIKE 'IMP-F%'`).first()).toBeNull();
    const csv = await upload("owner", "products", "preview", "Mã hàng,Tên hàng,Đơn vị chính\r\nIMP-C1,=1+1,kg\r\nIMP-C2,\"-2+3\",kg\r\n", "f.csv");
    expect(csv.body.summary.error).toBe(2);
  });

  it("lỗi file: thiếu cột bắt buộc, sai định dạng", async () => {
    const miss = await upload("owner", "products", "preview", "Mã hàng,Tên hàng\r\nA,B\r\n", "m.csv");
    expect(miss.status).toBe(422);
    expect(miss.body.error.code).toBe("missing_columns");
    expect(miss.body.error.message).toContain("Đơn vị chính");
    const bad = await upload("owner", "products", "preview", "không phải zip", "x.xlsx");
    expect(bad.status).toBe(422);
    const none = await app.request(`${V}/imports/products/preview`, { method: "POST", headers: { authorization: `Bearer ${await login("owner")}` }, body: new FormData() }, testEnv);
    expect(none.status).toBe(422);
  });

  it("CSV UTF-8 có BOM dấu chấm phẩy; cột lạ bị bỏ qua và được báo", async () => {
    const csv = "﻿Mã hàng;Tên hàng;Đơn vị chính;Cột lạ\r\nIMP-CSV;Bưởi da xanh;trái;abc\r\n";
    const r = await upload("owner", "products", "commit", strToU8(csv), "p.csv");
    expect(r.status).toBe(201);
    const p = await db().prepare(`SELECT name, base_unit FROM products WHERE sku = 'IMP-CSV'`).first<any>();
    expect(p).toEqual({ name: "Bưởi da xanh", base_unit: "trái" });
    const pv = await upload("owner", "products", "preview", strToU8(csv), "p.csv");
    expect(pv.body.ignoredColumns).toEqual(["Cột lạ"]);
  });

  it("nạp 400 mặt hàng trong một lần (một batch)", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => prow({ "Mã hàng": `BULK-${i}`, "Tên hàng": `Hàng ${i}`, "Đơn vị chính": "kg", "Nhóm hàng": `Nhóm ${i % 7}`, "Giá bán chung": String(10000 + i), "Đơn vị quy đổi": "thùng", "Hệ số quy đổi": "10" }));
    const r = await upload("owner", "products", "commit", xlsx(PH, rows), "bulk.xlsx");
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(400);
    expect((await db().prepare(`SELECT COUNT(*) n FROM products WHERE sku LIKE 'BULK-%'`).first<any>()).n).toBe(400);
    expect((await db().prepare(`SELECT COUNT(*) n FROM product_groups WHERE name LIKE 'Nhóm _'`).first<any>()).n).toBeGreaterThanOrEqual(7);
  });
});

const CH = ["Mã khách", "Tên khách", "Nhóm khách", "SĐT", "Email", "Mã số thuế", "Địa chỉ giao hàng", "Người nhận", "SĐT người nhận", "Hạn mức nợ", "Hạn thanh toán (ngày)", "Ghi chú"];
const crow = (o: Partial<Record<string, string>>) => CH.map((h) => o[h] ?? "");

describe("Khách sỉ", () => {
  it("tạo khách sỉ: mã tự sinh, liên hệ nhận hàng + địa chỉ mặc định, nhóm theo tên hoặc mã", async () => {
    const file = xlsx(CH, [
      crow({ "Tên khách": "Nhà hàng Biển Xanh", "Nhóm khách": "Sỉ cấp 1", "SĐT": "0901111222", "Địa chỉ giao hàng": "12 Nguyễn Huệ", "Người nhận": "Chị Lan", "Hạn mức nợ": "20000000", "Hạn thanh toán (ngày)": "15" }),
      crow({ "Tên khách": "Quán Ban Mai", "Nhóm khách": "si_1", "SĐT": "0902222333", "Địa chỉ giao hàng": "45 Lê Lợi" }),
      crow({ "Tên khách": "Thiếu địa chỉ", "Nhóm khách": "Sỉ cấp 1" }),
      crow({ "Tên khách": "Nhóm sai", "Nhóm khách": "Không có", "Địa chỉ giao hàng": "x y z" }),
      crow({ "Tên khách": "Vượt ngưỡng", "Nhóm khách": "Sỉ cấp 1", "Địa chỉ giao hàng": "x y z", "Hạn mức nợ": "999999999" }),
    ]);
    const pv = await upload("manager", "customers", "preview", file, "c.xlsx");
    expect(pv.body.summary).toMatchObject({ create: 2, error: 3 });
    expect(pv.body.rows[4].errors.join()).toContain("ngưỡng");
    const r = await upload("manager", "customers", "commit", file, "c.xlsx");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ created: 2, errors: 3 });
    const c1 = (await db().prepare(`SELECT * FROM customers WHERE name = 'Nhà hàng Biển Xanh'`).first<any>())!;
    expect(c1).toMatchObject({ type: "b2b", credit_limit: 20000000, payment_terms_days: 15, phone: "0901111222" });
    expect(c1.code).toMatch(/^KH-\d{4}$/);
    const ct = await db().prepare(`SELECT name, is_receiver FROM customer_contacts WHERE customer_id = ?`).bind(c1.id).all<any>();
    expect(ct.results).toEqual([{ name: "Chị Lan", is_receiver: 1 }]);
    const ad = await db().prepare(`SELECT address, is_default, receiver_contact_id FROM customer_addresses WHERE customer_id = ?`).bind(c1.id).all<any>();
    expect(ad.results).toHaveLength(1);
    expect(ad.results[0]).toMatchObject({ address: "12 Nguyễn Huệ", is_default: 1 });
    expect(ad.results[0].receiver_contact_id).toBeTruthy();
    const c2 = await db().prepare(`SELECT code FROM customers WHERE name = 'Quán Ban Mai'`).first<any>();
    expect(c2.code).not.toBe(c1.code);
    // khách mới tạo bằng API sau đó vẫn sinh mã không trùng
    const api2 = await app.request(`${V}/customers`, { method: "POST", headers: { authorization: `Bearer ${await login("manager")}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Sau nhập", customerGroupId: 2, creditLimit: 0, paymentTermsDays: 0, contacts: [{ name: "A", isReceiver: true }], addresses: [{ label: "Kho", address: "abc xyz" }] }) }, testEnv);
    expect(api2.status).toBe(201);
    expect(((await api2.json()) as any).code).not.toBe(c2.code);
    // chủ nhập được hạn mức vượt ngưỡng
    const big = xlsx(CH, [crow({ "Tên khách": "Khách lớn", "Nhóm khách": "Sỉ cấp 1", "Địa chỉ giao hàng": "x y z", "Hạn mức nợ": "999999999" })]);
    expect((await upload("owner", "customers", "commit", big, "b.xlsx")).status).toBe(201);
    expect((await db().prepare(`SELECT credit_limit FROM customers WHERE name = 'Khách lớn'`).first<any>()).credit_limit).toBe(999999999);
  });

  it("trùng mã/SĐT: skip giữ nguyên, update cập nhật; quản lý không đổi được hạn mức khách đã có", async () => {
    const existing = (await db().prepare(`SELECT code FROM customers WHERE name = 'Quán Ban Mai'`).first<any>())!;
    const upd = xlsx(CH, [crow({ "Mã khách": existing.code, "Tên khách": "Quán Ban Mai 2", "Nhóm khách": "Sỉ cấp 1", "Email": "a@b.vn", "Hạn mức nợ": "5000000" })]);
    const pv = await upload("manager", "customers", "preview", upd, "u.xlsx");
    expect(pv.body.rows[0]).toMatchObject({ status: "exists" });
    expect(pv.body.rows[0].warnings.join()).toContain("chủ cửa hàng");
    expect((await upload("manager", "customers", "commit", upd, "u.xlsx", "skip")).status).toBe(422);
    expect((await upload("manager", "customers", "commit", upd, "u.xlsx", "update")).body).toMatchObject({ updated: 1, created: 0 });
    const c = (await db().prepare(`SELECT name, email, credit_limit, version FROM customers WHERE code = ?`).bind(existing.code).first<any>())!;
    expect(c).toMatchObject({ name: "Quán Ban Mai 2", email: "a@b.vn", credit_limit: 0, version: 2 });
    // trùng theo SĐT khi để trống mã
    const byPhone = xlsx(CH, [crow({ "Tên khách": "Ban Mai (đổi tên)", "Nhóm khách": "Sỉ cấp 1", "SĐT": "0902222333", "Địa chỉ giao hàng": "abc xyz" })]);
    expect((await upload("manager", "customers", "preview", byPhone, "p.xlsx")).body.rows[0].status).toBe("exists");
  });
});

const SH = ["Mã NCC", "Tên nhà cung cấp", "SĐT", "Địa chỉ", "Mã số thuế", "Hạn thanh toán (ngày)"];
const srow = (o: Partial<Record<string, string>>) => SH.map((h) => o[h] ?? "");

describe("Nhà cung cấp", () => {
  it("tạo mới, trùng tên → cập nhật theo lựa chọn; thủ kho nhập được", async () => {
    const file = xlsx(SH, [srow({ "Tên nhà cung cấp": "Vựa Ba Tư", "SĐT": "0987654321", "Hạn thanh toán (ngày)": "7" }), srow({ "Tên nhà cung cấp": "Fresh Việt", "Mã số thuế": "0301234567" }), srow({ "Tên nhà cung cấp": "", "SĐT": "0911" }), srow({ "Tên nhà cung cấp": "vựa ba tư" })]);
    const pv = await upload("warehouse", "suppliers", "preview", file, "s.xlsx");
    expect(pv.body.summary).toMatchObject({ create: 2, error: 2 });
    const r = await upload("warehouse", "suppliers", "commit", file, "s.xlsx");
    expect(r.body).toMatchObject({ created: 2, errors: 2 });
    const s = (await db().prepare(`SELECT * FROM suppliers WHERE name = 'Vựa Ba Tư'`).first<any>())!;
    expect(s).toMatchObject({ phone: "0987654321", payment_terms_days: 7, active: 1 });
    expect(s.code).toMatch(/^NCC-\d{8}-\d{4}$/);
    const again = xlsx(SH, [srow({ "Tên nhà cung cấp": "VỰA BA TƯ", "Địa chỉ": "Chợ Thủ Đức", "Hạn thanh toán (ngày)": "14" })]);
    expect((await upload("warehouse", "suppliers", "preview", again, "a.xlsx")).body.rows[0].status).toBe("exists");
    expect((await upload("warehouse", "suppliers", "commit", again, "a.xlsx", "update")).body).toMatchObject({ updated: 1 });
    expect(await db().prepare(`SELECT address, payment_terms_days FROM suppliers WHERE id = ?`).bind(s.id).first()).toEqual({ address: "Chợ Thủ Đức", payment_terms_days: 14 });
    // NCC tạo bằng API sau đó vẫn sinh mã không trùng
    const r2 = await app.request(`${V}/suppliers`, { method: "POST", headers: { authorization: `Bearer ${await login("manager")}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Sau nhập NCC" }) }, testEnv);
    expect(r2.status).toBe(201);
  });
});
