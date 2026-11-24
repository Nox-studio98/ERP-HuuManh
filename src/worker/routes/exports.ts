import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, notFound } from "../lib/errors";
import { audit } from "../lib/audit";
import { vnDate, vnDayRangeUtc } from "../lib/time";
import { BILL_OUTSTANDING_SQL, INVOICE_OUTSTANDING_SQL } from "../services/debt";
import { buildXlsx, XLSX_MIME, type XlsxSheet } from "../services/xlsx";

/**
 * Xuất Excel (M6-05). Định dạng cột bám tinh thần sổ kế toán hộ kinh doanh (Thông tư 88/2021)
 * [Cần xác nhận mẫu kế toán đang dùng] — hiện là bảng phẳng tiếng Việt, chưa theo biểu mẫu S1/S2... chính thức.
 */
export const exportRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function range(c: Ctx) {
  const today = vnDate();
  const from = c.req.query("from") ?? today;
  const to = c.req.query("to") ?? from;
  for (const [n, v] of [["from", from], ["to", to]] as const) if (!DAY_RE.test(v) || Number.isNaN(Date.parse(v))) throw new AppError(422, "validation_error", `${n} phải có dạng YYYY-MM-DD`);
  if (to < from) throw new AppError(422, "validation_error", "to phải sau hoặc bằng from");
  return { from, to, fromIso: vnDayRangeUtc(from).from, toIso: vnDayRangeUtc(to).to };
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

type R = ReturnType<typeof range>;
type Builder = (c: Ctx, r: R) => Promise<XlsxSheet[]>;

const builders: Record<string, Builder> = {
  "so-ban-hang": async (c, r) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT o.completed_at, o.code, o.kind, o.channel, COALESCE(cu.name, 'Khách lẻ') AS customer, o.subtotal, o.discount, o.shipping_fee, o.total
           FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id
          WHERE o.status='completed' AND o.completed_at >= ? AND o.completed_at < ? ORDER BY o.completed_at, o.id`,
      )
      .bind(r.fromIso, r.toIso)
      .all<any>();
    return [{
      name: "Sổ bán hàng",
      columns: [
        { header: "Ngày giờ", type: "datetime" }, { header: "Số chứng từ" }, { header: "Loại" }, { header: "Kênh" }, { header: "Khách hàng", width: 28 },
        { header: "Tiền hàng", type: "money" }, { header: "Giảm giá", type: "money" }, { header: "Phí vận chuyển", type: "money" }, { header: "Doanh thu", type: "money" },
      ],
      rows: results.map((o) => {
        const s = o.kind === "return" ? -1 : 1;
        return [o.completed_at, o.code, o.kind === "return" ? "Trả hàng" : "Bán hàng", o.channel, o.customer, s * o.subtotal, s * o.discount, o.shipping_fee, s * o.total];
      }),
      totalCols: [5, 6, 7, 8],
    }];
  },

  "so-quy": async (c, r) => {
    const db = c.env.DB;
    const fundId = c.req.query("fundId") ? Number(c.req.query("fundId")) : null;
    const funds = (
      await db.prepare(`SELECT id, code, name FROM funds WHERE active=1 ${fundId ? "AND id = ?" : ""} ORDER BY id`).bind(...(fundId ? [fundId] : [])).all<{ id: number; code: string; name: string }>()
    ).results;
    if (fundId && !funds.length) throw notFound("fund_not_found", "Không tìm thấy quỹ");
    const U = `SELECT created_at AS at, code, COALESCE(NULLIF(counterparty,''), NULLIF(note,''), CASE direction WHEN 'in' THEN 'Phiếu thu' ELSE 'Phiếu chi' END) AS descr,
                      CASE direction WHEN 'in' THEN amount ELSE -amount END AS amt
                 FROM cash_vouchers WHERE fund_id = ?1 AND status = 'posted'
               UNION ALL
               SELECT p.created_at, o.code, 'Thu bán hàng (' || p.method || ')', p.amount
                 FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.fund_id = ?1 AND p.status = 'confirmed'`;
    const sheets: XlsxSheet[] = [];
    for (const f of funds) {
      const opening = (await db.prepare(`SELECT COALESCE(SUM(amt),0) AS v FROM (${U}) WHERE at < ?2`).bind(f.id, r.fromIso).first<{ v: number }>())!.v;
      const { results } = await db.prepare(`SELECT * FROM (${U}) WHERE at >= ?2 AND at < ?3 ORDER BY at, code`).bind(f.id, r.fromIso, r.toIso).all<any>();
      let bal = opening;
      const rows: unknown[][] = [[null, "", "Số dư đầu kỳ", null, null, opening]];
      for (const e of results) {
        bal += e.amt;
        rows.push([e.at, e.code, e.descr, e.amt > 0 ? e.amt : null, e.amt < 0 ? -e.amt : null, bal]);
      }
      sheets.push({
        name: f.code,
        columns: [{ header: "Ngày giờ", type: "datetime" }, { header: "Số chứng từ" }, { header: "Diễn giải", width: 36 }, { header: "Thu", type: "money" }, { header: "Chi", type: "money" }, { header: "Tồn quỹ", type: "money" }],
        rows,
        totalCols: [3, 4],
      });
    }
    if (!sheets.length) sheets.push({ name: "Sổ quỹ", columns: [{ header: "Ngày giờ" }], rows: [] });
    return sheets;
  },

  "cong-no-phai-thu": async (c, r) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT cu.code AS cust_code, cu.name AS cust_name, i.code, i.issue_date, i.due_date, i.total, ${INVOICE_OUTSTANDING_SQL} AS outstanding,
                i.total + COALESCE((SELECT SUM(a.total) FROM invoices a WHERE a.original_invoice_id = i.id AND a.kind='adjustment' AND a.status='open'),0) AS gross
           FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id
          WHERE i.status='open' AND i.kind IN ('sale','replacement') AND i.issue_date <= ?1 AND ${INVOICE_OUTSTANDING_SQL} > 0
          ORDER BY cu.name, i.due_date, i.id`,
      )
      .bind(r.to)
      .all<any>();
    const detail = results.map((x) => [x.cust_code ?? "", x.cust_name ?? "Khách lẻ", x.code, x.issue_date, x.due_date, x.gross, x.gross - x.outstanding, x.outstanding, Math.max(0, daysBetween(x.due_date, r.to))]);
    const byCust = new Map<string, { code: string; total: number; paid: number; os: number; overdue: number }>();
    for (const x of results) {
      const k = x.cust_name ?? "Khách lẻ";
      const a = byCust.get(k) ?? { code: x.cust_code ?? "", total: 0, paid: 0, os: 0, overdue: 0 };
      a.total += x.gross; a.paid += x.gross - x.outstanding; a.os += x.outstanding;
      if (x.due_date < r.to) a.overdue += x.outstanding;
      byCust.set(k, a);
    }
    return [
      {
        name: "Chi tiết theo hoá đơn",
        columns: [{ header: "Mã KH" }, { header: "Khách hàng", width: 28 }, { header: "Số hoá đơn" }, { header: "Ngày HĐ", type: "date" }, { header: "Hạn thanh toán", type: "date" }, { header: "Giá trị HĐ", type: "money" }, { header: "Đã thu/gạch", type: "money" }, { header: "Còn nợ", type: "money" }, { header: "Quá hạn (ngày)", type: "int" }],
        rows: detail,
        totalCols: [5, 6, 7],
      },
      {
        name: "Tổng hợp theo khách",
        columns: [{ header: "Mã KH" }, { header: "Khách hàng", width: 28 }, { header: "Giá trị HĐ", type: "money" }, { header: "Đã thu/gạch", type: "money" }, { header: "Còn nợ", type: "money" }, { header: "Trong đó quá hạn", type: "money" }],
        rows: [...byCust].map(([n, a]) => [a.code, n, a.total, a.paid, a.os, a.overdue]),
        totalCols: [2, 3, 4, 5],
      },
    ];
  },

  "cong-no-phai-tra": async (c, r) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT s.code AS sup_code, s.name AS sup_name, b.code, b.supplier_ref, b.is_provisional, b.issue_date, b.due_date, b.total, ${BILL_OUTSTANDING_SQL} AS outstanding
           FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
          WHERE b.status='open' AND b.issue_date <= ?1 AND ${BILL_OUTSTANDING_SQL} > 0 ORDER BY s.name, b.due_date, b.id`,
      )
      .bind(r.to)
      .all<any>();
    return [{
      name: "Công nợ phải trả",
      columns: [{ header: "Mã NCC" }, { header: "Nhà cung cấp", width: 28 }, { header: "Số phiếu" }, { header: "Số HĐ NCC" }, { header: "Giá tạm" }, { header: "Ngày HĐ", type: "date" }, { header: "Hạn thanh toán", type: "date" }, { header: "Giá trị", type: "money" }, { header: "Đã trả", type: "money" }, { header: "Còn phải trả", type: "money" }, { header: "Quá hạn (ngày)", type: "int" }],
      rows: results.map((x) => [x.sup_code, x.sup_name, x.code, x.supplier_ref ?? "", x.is_provisional ? "Có" : "", x.issue_date, x.due_date, x.total, x.total - x.outstanding, x.outstanding, Math.max(0, daysBetween(x.due_date, r.to))]),
      totalCols: [7, 8, 9],
    }];
  },

  "nhap-xuat-ton": async (c, r) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT p.sku, p.name, p.base_unit,
           COALESCE(SUM(CASE WHEN m.at < ?1 THEN m.qty_delta_milli END),0) AS opening,
           COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type IN ('receipt','transfer_in') THEN m.qty_delta_milli END),0) AS qin,
           COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type='sale' THEN -m.qty_delta_milli END),0) AS sold,
           COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type='return' THEN m.qty_delta_milli END),0) AS returned,
           COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type='waste' THEN -m.qty_delta_milli END),0) AS waste,
           COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type IN ('assemble_in','assemble_out') THEN m.qty_delta_milli END),0) AS asm,
           COALESCE(SUM(CASE WHEN m.at >= ?1 AND m.move_type NOT IN ('receipt','transfer_in','sale','return','waste','assemble_in','assemble_out') THEN m.qty_delta_milli END),0) AS adj,
           COALESCE(SUM(m.qty_delta_milli),0) AS closing,
           COALESCE(SUM(m.qty_delta_milli * m.unit_cost / 1000),0) AS value
           FROM products p JOIN stock_moves m ON (m.product_id = p.id OR m.product_id IN (SELECT id FROM products WHERE merged_into = p.id)) AND m.at < ?2
          WHERE p.merged_into IS NULL GROUP BY p.id ORDER BY p.name`,
      )
      .bind(r.fromIso, r.toIso)
      .all<any>();
    const q = (v: number) => v / 1000;
    return [{
      name: "Nhập xuất tồn",
      columns: [{ header: "Mã hàng" }, { header: "Tên hàng", width: 30 }, { header: "ĐVT" }, { header: "Tồn đầu kỳ", type: "qty" }, { header: "Nhập", type: "qty" }, { header: "Bán", type: "qty" }, { header: "Khách trả lại", type: "qty" }, { header: "Hao hụt", type: "qty" }, { header: "Lắp/tháo giỏ quà", type: "qty" }, { header: "Điều chỉnh/kiểm kê/chuyển", type: "qty" }, { header: "Tồn cuối kỳ", type: "qty" }, { header: "Giá trị tồn cuối", type: "money" }],
      rows: results.map((x) => [x.sku, x.name, x.base_unit, q(x.opening), q(x.qin), q(x.sold), q(x.returned), q(x.waste), q(x.asm), q(x.adj), q(x.closing), Math.round(x.value)]),
      totalCols: [11],
    }];
  },

  "hoa-don-ban": async (c, r) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT i.*, cu.name AS cust_name FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id
          WHERE i.issue_date >= ? AND i.issue_date <= ? ORDER BY i.issue_date, i.id`,
      )
      .bind(r.from, r.to)
      .all<any>();
    const kind: Record<string, string> = { sale: "Bán hàng", adjustment: "Điều chỉnh", replacement: "Thay thế" };
    const es: Record<string, string> = { none: "Chưa phát hành", queued: "Đang chờ", issued: "Đã phát hành", failed: "Lỗi", not_required: "Không cần" };
    return [{
      name: "Hoá đơn bán",
      columns: [{ header: "Ngày HĐ", type: "date" }, { header: "Số HĐ nội bộ" }, { header: "Loại" }, { header: "Khách hàng", width: 28 }, { header: "Mã số thuế" }, { header: "Tiền hàng", type: "money" }, { header: "Thuế GTGT", type: "money" }, { header: "Tổng cộng", type: "money" }, { header: "Trạng thái HĐĐT" }, { header: "Số HĐĐT" }, { header: "Ký hiệu" }, { header: "Mã tra cứu" }],
      rows: results.map((i) => [i.issue_date, i.code, kind[i.kind] ?? i.kind, i.buyer_name ?? i.cust_name ?? "Khách lẻ", i.buyer_tax_code ?? "", i.subtotal, i.vat_amount, i.total, i.status === "cancelled" ? "Đã huỷ" : es[i.einvoice_status] ?? i.einvoice_status, i.einvoice_no ?? "", i.einvoice_series ?? "", i.einvoice_lookup_code ?? ""]),
      totalCols: [5, 6, 7],
    }];
  },
};

exportRoutes.get("/exports/:file", requirePerm("reports.view"), async (c) => {
  const file = c.req.param("file");
  if (!file.endsWith(".xlsx")) throw notFound();
  const name = file.slice(0, -5);
  const build = Object.hasOwn(builders, name) ? builders[name] : null;
  if (!build) throw notFound("export_not_found", "Không có báo cáo xuất Excel này");
  const r = range(c);
  const sheets = await build(c, r);
  const bytes = buildXlsx(sheets);
  await audit(c, { action: `export.${name}`, entity: "export", entityId: name, after: { from: r.from, to: r.to, rows: sheets.reduce((s, x) => s + x.rows.length, 0) } });
  return new Response(bytes as BodyInit, { status: 200, headers: {
    "content-type": XLSX_MIME,
    "content-disposition": `attachment; filename="${name}_${r.from}_${r.to}.xlsx"`,
  } });
});
