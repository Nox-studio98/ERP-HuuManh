import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import { app } from "../src/worker/index";
import { api, login, seedBase, testEnv } from "./helpers";
import { buildXlsx, colRef, dateSerial, datetimeSerial } from "../src/worker/services/xlsx";
import { insertInvoice } from "./integration-helpers";
import { vnDate } from "../src/worker/lib/time";

async function getXlsx(role: string, name: string, qs = "") {
  const token = await login(role);
  const res = await app.request(`/api/v1/exports/${name}.xlsx${qs}`, { headers: { authorization: `Bearer ${token}` } }, testEnv);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}
const sheet = (z: Record<string, Uint8Array>, n = 1) => strFromU8(z[`xl/worksheets/sheet${n}.xml`]);

beforeAll(async () => {
  await seedBase();
  const db = testEnv.DB;
  const today = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO customers(code, type, name) VALUES ('KH-X1','b2b','Quán Cà Phê <A&B>')`),
    db.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (601,'XOAI','Xoài cát','kg')`),
    db.prepare(`INSERT INTO lots(id, lot_code, product_id, location_id, received_at, unit_cost, qty_in_milli, qty_on_hand_milli) VALUES (601,'L-XOAI',601,1,?,20000,10000,8000)`).bind(today),
    db.prepare(`INSERT INTO stock_moves(lot_id, product_id, qty_delta_milli, unit_cost, move_type, ref_type, ref_id, user_id) VALUES (601,601,10000,20000,'receipt','test',1,1),(601,601,-2000,20000,'sale','test',1,1)`),
    db.prepare(`INSERT INTO orders(code, channel, kind, store_id, status, subtotal, discount, total, completed_at) VALUES ('HD-X-1','pos','sale',1,'completed',150000,10000,140000,?)`).bind(today),
    db.prepare(`INSERT INTO payments(order_id, method, amount, fund_id) SELECT id,'cash',140000,1 FROM orders WHERE code='HD-X-1'`),
    db.prepare(`INSERT INTO cash_vouchers(code, direction, fund_id, category_id, amount, counterparty, period, created_by) VALUES ('PC-X-1','out',1,(SELECT id FROM cash_categories WHERE code='TIEN_HANG'),40000,'Mua túi',?,1)`).bind(vnDate().slice(0, 7)),
  ]);
  const cid = (await db.prepare(`SELECT id FROM customers WHERE code='KH-X1'`).first<{ id: number }>())!.id;
  await insertInvoice({ customerId: cid, due: "2026-01-01", total: 1234567 });
  await db.prepare(`INSERT INTO suppliers(id, code, name) VALUES (601,'NCC-X','NCC Xoài')`).run();
  await db.prepare(`INSERT INTO supplier_bills(code, supplier_id, issue_date, due_date, total) VALUES ('CNP-X-1',601,?,?,900000)`).bind(vnDate(), vnDate()).run();
});

describe("xlsx writer", () => {
  it("builds a valid OOXML package", () => {
    const bytes = buildXlsx([{ name: "Test/[x]", columns: [{ header: "Tên" }, { header: "Tiền", type: "money" }, { header: "Ngày", type: "date" }, { header: "Giờ", type: "datetime" }, { header: "SL", type: "qty" }], rows: [["A & <B>", 1234567, "2026-11-23", "2026-11-23T05:00:00Z", 1.5], ["=cmd()", null, null, null, null]], totalCols: [1] }]);
    const z = unzipSync(bytes);
    expect(Object.keys(z).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const s = sheet(z);
    expect(s).toContain('<pane ySplit="1"');
    expect(s).toContain("A &amp; &lt;B&gt;");
    expect(s).toContain('<c r="B2" s="2"><v>1234567</v></c>'); // định dạng #,##0
    expect(s).toContain(`<v>${dateSerial("2026-11-23")}</v>`);
    expect(dateSerial("2026-11-23")).toBe(46349);
    expect(datetimeSerial("2026-11-23T05:00:00Z")).toBeCloseTo(46349.5, 5); // 12:00 giờ VN
    expect(s).toContain('t="inlineStr"><is><t xml:space="preserve">=cmd()</t>'); // chuỗi, không phải công thức
    expect(s).toContain("<cols>");
    expect(s).toContain("Tổng cộng");
    expect(strFromU8(z["xl/styles.xml"])).toContain('formatCode="#,##0"');
    expect(strFromU8(z["xl/styles.xml"])).toContain("<b/>");
    expect(strFromU8(z["xl/workbook.xml"])).toContain('name="Test  x"');
    expect(colRef(0)).toBe("A");
    expect(colRef(26)).toBe("AA");
  });
});

describe("exports API", () => {
  it("requires reports.view", async () => {
    expect((await getXlsx("cashier", "so-ban-hang")).res.status).toBe(403);
    expect((await getXlsx("owner", "khong-co")).res.status).toBe(404);
    expect((await getXlsx("owner", "so-ban-hang", "?from=bad")).res.status).toBe(422);
    const token = await login("owner");
    expect((await app.request("/api/v1/exports/so-ban-hang.csv", { headers: { authorization: `Bearer ${token}` } }, testEnv)).status).toBe(404);
  });

  it("so-ban-hang: Vietnamese headers, rows, audit", async () => {
    const { res, bytes } = await getXlsx("accountant", "so-ban-hang", `?from=${vnDate()}&to=${vnDate()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain(".xlsx");
    const s = sheet(unzipSync(bytes));
    expect(s).toContain("Số chứng từ");
    expect(s).toContain("HD-X-1");
    expect(s).toContain("<v>140000</v>");
    const a = await testEnv.DB.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action='export.so-ban-hang'`).first<{ n: number }>();
    expect(a!.n).toBe(1);
  });

  it("so-quy: one sheet per fund with running balance", async () => {
    const { res, bytes } = await getXlsx("owner", "so-quy", `?from=${vnDate()}&to=${vnDate()}`);
    expect(res.status).toBe(200);
    const z = unzipSync(bytes);
    const wb = strFromU8(z["xl/workbook.xml"]);
    expect(wb).toContain("TM-CH1");
    expect(wb).toContain("NH-VCB");
    const s = sheet(z, 1);
    expect(s).toContain("Số dư đầu kỳ");
    expect(s).toContain("Mua túi");
    expect(s).toContain("<v>100000</v>"); // 140000 - 40000
    expect((await getXlsx("owner", "so-quy", "?fundId=999")).res.status).toBe(404);
  });

  it("cong-no-phai-thu / phai-tra / nhap-xuat-ton / hoa-don-ban", async () => {
    let r = await getXlsx("accountant", "cong-no-phai-thu");
    let z = unzipSync(r.bytes);
    expect(strFromU8(z["xl/workbook.xml"])).toContain("Tổng hợp theo khách");
    expect(sheet(z)).toContain("Quán Cà Phê &lt;A&amp;B&gt;");
    expect(sheet(z)).toContain("<v>1234567</v>");
    expect(sheet(z, 2)).toContain("<v>1234567</v>");

    r = await getXlsx("accountant", "cong-no-phai-tra");
    expect(sheet(unzipSync(r.bytes))).toContain("NCC Xoài");
    expect(sheet(unzipSync(r.bytes))).toContain("<v>900000</v>");

    r = await getXlsx("owner", "nhap-xuat-ton", `?from=${vnDate()}&to=${vnDate()}`);
    const s = sheet(unzipSync(r.bytes));
    expect(s).toContain("Xoài cát");
    expect(s).toContain("<v>8</v>"); // tồn cuối 8 kg

    r = await getXlsx("owner", "hoa-don-ban", "?from=2026-11-01&to=2026-11-30");
    expect(sheet(unzipSync(r.bytes))).toContain("Công ty Test");
  });
});

// ===== PDF =====
// Font thật lấy từ gói npm devDependency (không commit file font): nạp bằng ?inline (data URI base64).
import regularFont from "@expo-google-fonts/be-vietnam-pro/400Regular/BeVietnamPro_400Regular.ttf?inline";
import boldFont from "@expo-google-fonts/be-vietnam-pro/700Bold/BeVietnamPro_700Bold.ttf?inline";
import { renderInvoicePdf, renderQuotePdf, fmtVnd, FONT_KEYS } from "../src/worker/services/pdf";

const fromDataUri = (u: string) => Uint8Array.from(atob(u.slice(u.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const ascii = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("pdf", () => {
  let invoiceId = 0;
  let quoteId = 0;
  beforeAll(async () => {
    invoiceId = await insertInvoice({ customerId: null, total: 2500000 });
    const db = testEnv.DB;
    const cid = (await db.prepare(`SELECT id FROM customers WHERE code='KH-X1'`).first<{ id: number }>())!.id;
    await db.batch([
      db.prepare(`INSERT INTO quotes(code, customer_id, valid_from, valid_until, subtotal, created_by) VALUES ('BG-X-1',?,'2026-11-23','2026-11-30',300000,1)`).bind(cid),
      db.prepare(`INSERT INTO quote_lines(quote_id, product_id, unit, qty_milli, list_price, unit_price) SELECT id,601,'kg',10000,32000,30000 FROM quotes WHERE code='BG-X-1'`),
    ]);
    quoteId = (await db.prepare(`SELECT id FROM quotes WHERE code='BG-X-1'`).first<{ id: number }>())!.id;
  });

  it("formats VND with dots", () => {
    expect(fmtVnd(1234567)).toBe("1.234.567");
    expect(fmtVnd(-5000)).toBe("-5.000");
    expect(fmtVnd(0)).toBe("0");
  });

  it("throws 501 pdf_font_missing when fonts are not in R2", async () => {
    await testEnv.FILES.delete([FONT_KEYS.regular, FONT_KEYS.bold]);
    for (const f of [() => renderInvoicePdf(testEnv, invoiceId), () => renderQuotePdf(testEnv, quoteId)]) {
      const e = await f().catch((x) => x);
      expect(e.status).toBe(501);
      expect(e.code).toBe("pdf_font_missing");
      expect(e.message).toContain("fonts/");
    }
  });

  it("renders invoice and quote PDFs with Vietnamese glyphs when fonts exist", async () => {
    await testEnv.FILES.put(FONT_KEYS.regular, fromDataUri(regularFont));
    await testEnv.FILES.put(FONT_KEYS.bold, fromDataUri(boldFont));
    const inv = await renderInvoicePdf(testEnv, invoiceId);
    expect(ascii(inv.slice(0, 5))).toBe("%PDF-");
    expect(inv.length).toBeGreaterThan(5000);
    const q = await renderQuotePdf(testEnv, quoteId);
    expect(ascii(q.slice(0, 5))).toBe("%PDF-");
    await expect(renderInvoicePdf(testEnv, 999999)).rejects.toMatchObject({ status: 404 });
    await expect(renderQuotePdf(testEnv, 999999)).rejects.toMatchObject({ status: 404 });
  });

  it("renders many lines across pages", async () => {
    const db = testEnv.DB;
    await db.prepare(`INSERT INTO invoice_lines(invoice_id, description, unit, qty_milli, unit_price, amount) VALUES ${Array(60).fill("(?,'Cam sành loại 1 rất ngon, giao tận nơi, đóng thùng cẩn thận theo yêu cầu của khách hàng','kg',1500,20000,30000)").join(",")}`).bind(...Array(60).fill(invoiceId)).run();
    const pdf = await renderInvoicePdf(testEnv, invoiceId);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(2);
  });
});
