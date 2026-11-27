import { Hono } from "hono";
import type { AppBindings } from "../env";
import { can, maskPhone, requirePerm } from "../lib/rbac";
import { AppError } from "../lib/errors";
import { audit } from "../lib/audit";
import { vnDate } from "../lib/time";
import { buildXlsx, XLSX_MIME, type XlsxColumn } from "../services/xlsx";
import { buildOrderFilter } from "../services/order-filter";

/** Xuất Excel chi tiết từng dòng hàng của danh sách đơn đang lọc (POS-KV đợt B, mục 5). */
export const exportOrderLinesRoutes = new Hono<AppBindings>();

export const ORDER_LINES_MAX_ROWS = 20_000;
const CHANNEL: Record<string, string> = { pos: "Tại quầy", online: "Online", b2b: "Đơn sỉ", fresco: "Fresco", social: "Mạng xã hội" };
const STATUS: Record<string, string> = {
  new: "Mới", confirmed: "Đã xác nhận", preparing: "Đang chuẩn bị", shipping: "Đang giao", completed: "Hoàn tất", cancelled: "Đã huỷ",
  delivery_failed: "Giao thất bại", returned: "Đã trả", awaiting_payment: "Chờ thanh toán",
};

exportOrderLinesRoutes.get("/exports/order-lines.xlsx", requirePerm("orders.view"), async (c) => {
  const role = c.get("user").role;
  const pii = can(role, "customers.view_pii");
  const cost = can(role, "prices.view_cost");
  const { where, params } = buildOrderFilter(c.req.query(), pii);
  const base = `FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id ${where}`;
  const sql = `
    WITH f AS (SELECT o.id ${base})
    SELECT x.*, o.code, o.created_at, o.channel, o.kind, o.status, COALESCE(cu.name, o.receiver_name) AS customer, COALESCE(cu.phone, o.receiver_phone) AS phone,
           u.full_name AS cashier, COALESCE(sl.full_name, u.full_name) AS seller FROM (
      SELECT ol.order_id AS oid, 0 AS part, ol.id AS rid, p.sku AS sku, p.name AS pname, ol.unit AS unit,
             COALESCE(CASE WHEN ol.unit = p.base_unit THEN 1000 ELSE (SELECT pu.factor_milli FROM product_units pu WHERE pu.product_id = ol.product_id AND pu.unit = ol.unit) END, 1000) AS factor,
             ol.qty_milli AS qty_milli, ol.unit_price AS unit_price, ol.discount AS discount, ol.line_total AS amount, ol.cost_amount AS cost
        FROM order_lines ol JOIN f ON f.id = ol.order_id JOIN products p ON p.id = ol.product_id
      UNION ALL
      SELECT oc.order_id, 1, oc.id, '', 'Thu khác: ' || oc.name, '', 1000, 0, 0, 0, oc.amount, 0
        FROM order_charges oc JOIN f ON f.id = oc.order_id JOIN orders oo ON oo.id = oc.order_id WHERE oo.kind = 'sale'
      UNION ALL
      SELECT oo.id, 1, 0, '', 'Hoàn thu khác', '', 1000, 0, 0, 0, oo.charges_total, 0
        FROM orders oo JOIN f ON f.id = oo.id WHERE oo.kind = 'return' AND oo.charges_total > 0
    ) x
    JOIN orders o ON o.id = x.oid
    LEFT JOIN users u ON u.id = o.created_by LEFT JOIN users sl ON sl.id = o.seller_id LEFT JOIN customers cu ON cu.id = o.customer_id
    ORDER BY x.oid, x.part, x.rid LIMIT ?`;
  const { results } = await c.env.DB
    .prepare(
      sql,
    )
    .bind(...params, ORDER_LINES_MAX_ROWS + 1)
    .all<any>();
  if (results.length > ORDER_LINES_MAX_ROWS)
    throw new AppError(422, "export_too_large", `Kết quả vượt ${ORDER_LINES_MAX_ROWS.toLocaleString("vi-VN")} dòng hàng. Hãy thu hẹp bộ lọc (khoảng ngày, kênh, người bán...) rồi xuất lại.`, { max: ORDER_LINES_MAX_ROWS });

  const columns: XlsxColumn[] = [
    { header: "Mã đơn" }, { header: "Ngày giờ", type: "datetime" }, { header: "Kênh" }, { header: "Loại" }, { header: "Trạng thái" },
    { header: "Khách hàng", width: 24 }, { header: "SĐT" }, { header: "Thu ngân" }, { header: "Người bán" },
    { header: "Mã hàng" }, { header: "Tên hàng", width: 30 }, { header: "ĐVT" },
    { header: "Số lượng", type: "qty" }, { header: "Đơn giá", type: "money" }, { header: "Giảm giá dòng", type: "money" }, { header: "Thành tiền", type: "money" },
  ];
  if (cost) columns.push({ header: "Giá vốn", type: "money" }, { header: "Lãi gộp", type: "money" });
  const rows = results.map((r) => {
    const s = r.kind === "return" ? -1 : 1; // phiếu trả mang dấu âm
    const isLine = r.part === 0;
    const amount = s * r.amount;
    const row: unknown[] = [
      r.code, r.created_at, CHANNEL[r.channel] ?? r.channel, r.kind === "return" ? "Trả hàng" : "Bán", STATUS[r.status] ?? r.status,
      r.customer ?? "Khách lẻ", maskPhone(r.phone, role) ?? "", r.cashier ?? "", r.seller ?? "",
      r.sku, r.pname, r.unit,
      isLine ? (s * r.qty_milli) / r.factor : null,
      isLine ? Math.round((r.unit_price * r.factor) / 1000) : null,
      isLine ? s * r.discount : null,
      amount,
    ];
    if (cost) row.push(isLine ? s * r.cost : null, isLine ? amount - s * r.cost : amount);
    return row;
  });
  const totalCols = [14, 15, ...(cost ? [16, 17] : [])];
  const bytes = buildXlsx([{ name: "Chi tiết dòng hàng", columns, rows, totalCols }]);
  await audit(c, { action: "export.order_lines", entity: "export", entityId: "order-lines", after: { filter: c.req.query(), rows: rows.length, cost } });
  const day = vnDate();
  return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": XLSX_MIME, "content-disposition": `attachment; filename="chi-tiet-dong-hang_${day}.xlsx"` } });
});
