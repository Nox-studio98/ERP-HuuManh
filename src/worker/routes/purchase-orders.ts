import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { can, requirePerm } from "../lib/rbac";
import { AppError, forbidden } from "../lib/errors";
import { vnDate } from "../lib/time";
import { addVnRange, likeOf, parseBody } from "../services/http";
import { registerApprovalHandler } from "../services/approval-registry";
import {
  applySupplierResponse, approvalApproveStmts, approvalRejectStmts, approvePo, cancelPo, closePo, createManualPo, cutoffMinutes, cutoffWindowDay, decideProposal,
  IN_FLIGHT, loadPo, poLines, receivePo, runPoCutoff, shapePo, shapePoLine, updateDraftPo, type PoActor,
} from "../services/po";
import { renderPoPdf } from "../services/po-pdf";

/**
 * Đơn đặt NCC (PO) tự động từ phần thiếu SO — docs/PO-NCC.md, hợp đồng API: docs/API-po.md.
 * Quyền: purchasing.view (xem), purchasing.write (nháp, chốt đêm, nhận hàng), purchasing.approve (duyệt/gửi, xử lý phản hồi NCC),
 * purchasing.approve_high (chủ: PO vượt approval.po_vnd). Giá vốn (đơn giá, tổng tiền) chỉ trả cho người có prices.view_cost.
 */
export const purchaseOrderRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

const id = (c: Ctx) => {
  const n = Number(c.req.param("id"));
  if (!Number.isInteger(n) || n <= 0) throw new AppError(404, "not_found", "Không tìm thấy");
  return n;
};
const costOf = (c: Ctx) => can(c.get("user").role, "prices.view_cost");
const actorOf = (c: Ctx): PoActor => ({ type: "staff", userId: c.get("user").id, role: c.get("user").role, c });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const version = z.number().int().positive().optional();

// ---------------------------------------------------------------- danh sách + KPI

const STATUS_ALL = ["draft", "pending_approval", "sent", "supplier_proposed", "confirmed", "partially_received", "received", "rejected", "cancelled", "closed"];

purchaseOrderRoutes.get("/purchase-orders", requirePerm("purchasing.view"), async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const cost = costOf(c);
  const base: string[] = [];
  const bp: unknown[] = [];
  if (q.supplierId) (base.push("po.supplier_id = ?"), bp.push(Number(q.supplierId)));
  if (q.q?.trim()) (base.push(`(po.code LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')`), bp.push(likeOf(q.q), likeOf(q.q)));
  addVnRange(q, "po.created_at", base, bp);
  const where = [...base];
  const params = [...bp];
  if (q.status) {
    const st = q.status.split(",").filter(Boolean);
    if (st.some((x) => !STATUS_ALL.includes(x))) throw new AppError(422, "validation_error", "status không hợp lệ");
    where.push(`po.status IN (${st.map(() => "?").join(",")})`);
    params.push(...st);
  }
  if (q.receivable === "1") where.push(`po.status IN ('confirmed','partially_received')`);
  if (q.cursor) (where.push("po.id < ?"), params.push(Number(q.cursor)));
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = (
    await db
      .prepare(
        `SELECT po.*, s.name AS supplier_name, s.code AS supplier_code, (SELECT COUNT(*) FROM purchase_order_lines pl WHERE pl.po_id = po.id) AS line_count,
                (SELECT COUNT(*) FROM po_shortage_links l JOIN purchase_order_lines pl ON pl.id = l.po_line_id WHERE pl.po_id = po.id) AS source_count
           FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
          ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY po.id DESC LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<any>()
  ).results;
  const page = rows.slice(0, limit);
  const cnt = (
    await db
      .prepare(`SELECT po.status, COUNT(*) AS n, COALESCE(SUM(po.total),0) AS t FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${base.length ? "WHERE " + base.join(" AND ") : ""} GROUP BY po.status`)
      .bind(...bp)
      .all<{ status: string; n: number; t: number }>()
  ).results;
  const counts: Record<string, number> = Object.fromEntries(STATUS_ALL.map((s) => [s, 0]));
  for (const r of cnt) counts[r.status] = r.n;
  const overdue = (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM purchase_orders po WHERE po.status IN ('sent','supplier_proposed','confirmed','partially_received') AND po.expected_date IS NOT NULL AND po.expected_date < ?`)
      .bind(vnDate())
      .first<{ n: number }>()
  )!.n;
  return c.json({
    items: page.map((r) => ({ ...shapePo(r, cost), lineCount: r.line_count, sourceCount: r.source_count })),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
    counts,
    summary: {
      draft: counts.draft, pendingApproval: counts.pending_approval, awaitingSupplier: counts.sent, supplierProposed: counts.supplier_proposed, overdue,
      receivable: counts.confirmed + counts.partially_received,
      ...(cost ? { openValue: cnt.filter((r) => ["sent", "supplier_proposed", "confirmed", "partially_received"].includes(r.status)).reduce((a, r) => a + r.t, 0) } : {}),
    },
  });
});

// ---------------------------------------------------------------- phần thiếu (tab) + trạng thái chốt đêm

purchaseOrderRoutes.get("/purchase-orders/shortages", requirePerm("purchasing.view"), async (c) => {
  const db = c.env.DB;
  const rows = (
    await db
      .prepare(
        `SELECT s.id, s.order_id, s.product_id, s.initial_milli, s.qty_milli, s.need_by, s.created_at, o.code AS order_code, o.channel, o.status AS order_status,
                COALESCE(cu.name, o.receiver_name) AS customer_name, p.name AS product_name, p.sku, p.base_unit
           FROM so_shortages s JOIN orders o ON o.id = s.order_id JOIN products p ON p.id = s.product_id LEFT JOIN customers cu ON cu.id = o.customer_id
          WHERE s.status = 'open' AND s.qty_milli > 0 AND o.status IN ('confirmed','preparing','shipping','delivery_failed')
          ORDER BY p.name, (s.need_by IS NULL), s.need_by, s.created_at, s.id`,
      )
      .all<any>()
  ).results;
  const links = (
    await db
      .prepare(
        `SELECT l.shortage_id, l.qty_milli, po.code, po.status, po.id AS po_id FROM po_shortage_links l JOIN purchase_order_lines pl ON pl.id = l.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
          WHERE po.status NOT IN ('cancelled','rejected','closed') ORDER BY po.id`,
      )
      .all<any>()
  ).results;
  const incoming = new Map(
    (
      await db
        .prepare(
          `SELECT pl.product_id, SUM(MAX(COALESCE(pl.confirmed_qty_milli, pl.qty_milli) - pl.received_milli, 0)) AS q FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
            WHERE po.status IN ('draft',${IN_FLIGHT.map((s) => `'${s}'`).join(",")}) GROUP BY pl.product_id`,
        )
        .all<{ product_id: number; q: number }>()
    ).results.map((r) => [r.product_id, r.q ?? 0]),
  );
  const sup = (
    await db
      .prepare(
        `SELECT ps.product_id, ps.supplier_id, s.name, ps.lead_time_days FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id AND s.active = 1 ORDER BY ps.product_id, ps.preferred DESC, ps.lead_time_days, ps.supplier_id`,
      )
      .all<{ product_id: number; supplier_id: number; name: string; lead_time_days: number }>()
  ).results;
  const supOf = new Map<number, { supplierId: number; supplierName: string; leadTimeDays: number }>();
  for (const r of sup) if (!supOf.has(r.product_id)) supOf.set(r.product_id, { supplierId: r.supplier_id, supplierName: r.name, leadTimeDays: r.lead_time_days });

  const today = vnDate();
  const products = new Map<number, any>();
  for (const r of rows) {
    const p = products.get(r.product_id) ?? { productId: r.product_id, name: r.product_name, sku: r.sku, baseUnit: r.base_unit, totalMilli: 0, lines: [] as any[] };
    const ls = links.filter((l) => l.shortage_id === r.id);
    p.totalMilli += r.qty_milli;
    p.lines.push({
      shortageId: r.id, orderId: r.order_id, orderCode: r.order_code, channel: r.channel, customerName: r.customer_name, needBy: r.need_by,
      qtyMilli: r.qty_milli, initialMilli: r.initial_milli, createdAt: r.created_at, overdue: !!r.need_by && r.need_by < today,
      po: ls.map((l) => ({ id: l.po_id, code: l.code, status: l.status })),
    });
    products.set(r.product_id, p);
  }
  const items = [...products.values()].map((p) => {
    const covered = Math.min(p.totalMilli, incoming.get(p.productId) ?? 0);
    const s = supOf.get(p.productId) ?? null;
    return { ...p, coveredMilli: covered, uncoveredMilli: p.totalMilli - covered, supplier: s, noSupplier: !s };
  });
  const cm = await cutoffMinutes(db);
  const now = new Date();
  return c.json({
    items,
    noSupplier: items.filter((x) => x.noSupplier).map((x) => ({ productId: x.productId, name: x.name, qtyMilli: x.uncoveredMilli })),
    cutoff: {
      time: `${String(Math.floor(cm / 60)).padStart(2, "0")}:${String(cm % 60).padStart(2, "0")}`,
      windowDay: cutoffWindowDay(now, cm),
      autoDone: !!(await db.prepare(`SELECT 1 AS x FROM once_keys WHERE scope = 'po.cutoff' AND key = ?`).bind(cutoffWindowDay(new Date(now.getTime() - 86400_000), cm)).first()),
    },
    summary: { products: items.length, lines: rows.length, totalLines: rows.length, uncoveredProducts: items.filter((x) => x.uncoveredMilli > 0).length },
  });
});

const cutoffRoute = (path: string, mode: "now" | "recalc") =>
  purchaseOrderRoutes.post(path, requirePerm("purchasing.write"), async (c) => {
    const r = await runPoCutoff(c.env.DB, { mode, actor: actorOf(c) });
    return c.json(r);
  });
cutoffRoute("/purchase-orders/cutoff-now", "now");
cutoffRoute("/purchase-orders/recalculate", "recalc");

// ---------------------------------------------------------------- tạo / xem / sửa

const lineIn = z.object({
  productId: z.number().int().positive(),
  qty: z.number().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(30).optional(),
  unitCost: z.number().int().min(0).max(1_000_000_000).nullish(),
  note: z.string().trim().max(200).nullish(),
});
const dateOrNull = z.string().regex(DAY).nullish();

purchaseOrderRoutes.post("/purchase-orders", requirePerm("purchasing.write"), async (c) => {
  const b = await parseBody(c, z.object({ supplierId: z.number().int().positive(), expectedDate: dateOrNull, note: z.string().trim().max(500).nullish(), lines: z.array(lineIn).min(1).max(100) }));
  const newId = await createManualPo(c.env.DB, actorOf(c), b);
  return c.json(await detail(c, newId), 201);
});

async function detail(c: Ctx, poId: number) {
  const db = c.env.DB;
  const cost = costOf(c);
  const po = await loadPo(db, poId);
  const lines = await poLines(db, poId);
  const sources = (
    await db
      .prepare(
        `SELECT l.po_line_id, l.shortage_id, l.qty_milli AS link_qty, s.status AS s_status, s.qty_milli AS s_qty, s.initial_milli, s.need_by,
                o.id AS order_id, o.code AS order_code, o.channel, o.status AS order_status, COALESCE(cu.name, o.receiver_name) AS customer_name
           FROM po_shortage_links l JOIN so_shortages s ON s.id = l.shortage_id JOIN orders o ON o.id = s.order_id LEFT JOIN customers cu ON cu.id = o.customer_id
          WHERE l.po_line_id IN (SELECT id FROM purchase_order_lines WHERE po_id = ?) ORDER BY (s.need_by IS NULL), s.need_by, s.id`,
      )
      .bind(poId)
      .all<any>()
  ).results;
  const docs = (await db.prepare(`SELECT id, code, status, posted_at, total_amount FROM stock_docs WHERE po_id = ? ORDER BY id`).bind(poId).all<any>()).results;
  const bills = cost
    ? (await db.prepare(`SELECT b.id, b.code, b.total, b.is_provisional, b.status, b.supplier_ref FROM supplier_bills b WHERE b.stock_doc_id IN (SELECT id FROM stock_docs WHERE po_id = ?) ORDER BY b.id`).bind(poId).all<any>()).results
    : [];
  const history = (
    await db
      .prepare(`SELECT a.at, a.action, a.reason, a.after_json, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'purchase_order' AND a.entity_id IN (?, ?) ORDER BY a.id`)
      .bind(String(poId), po.code)
      .all<any>()
  ).results;
  return {
    ...shapePo(po, cost),
    supplierPhone: po.supplier_phone,
    lines: lines.map((l) => ({
      ...shapePoLine(l, cost),
      sources: sources.filter((s) => s.po_line_id === l.id).map((s) => ({
        shortageId: s.shortage_id, orderId: s.order_id, orderCode: s.order_code, channel: s.channel, customerName: s.customer_name, needBy: s.need_by,
        qtyMilli: s.link_qty, shortageStatus: s.s_status, stillMissingMilli: s.s_qty, sourceCancelled: s.s_status === "cancelled" || ["cancelled", "returned"].includes(s.order_status),
      })),
    })),
    stockDocs: docs.map((d) => ({ id: d.id, code: d.code, status: d.status, postedAt: d.posted_at, ...(cost ? { totalAmount: d.total_amount } : {}) })),
    bills: bills.map((b) => ({ id: b.id, code: b.code, total: b.total, provisional: !!b.is_provisional, status: b.status, supplierRef: b.supplier_ref })),
    sourceCancelled: sources.some((s) => s.s_status === "cancelled" || ["cancelled", "returned"].includes(s.order_status)),
    history: history.map((h) => ({ at: h.at, action: h.action, by: h.user_name ?? null, reason: h.reason })),
  };
}

purchaseOrderRoutes.get("/purchase-orders/:id", requirePerm("purchasing.view"), async (c) => c.json(await detail(c, id(c))));

purchaseOrderRoutes.put("/purchase-orders/:id", requirePerm("purchasing.write"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, z.object({ version, expectedDate: dateOrNull, note: z.string().trim().max(500).nullish(), lines: z.array(lineIn).min(1).max(100).optional() }));
  await updateDraftPo(c.env.DB, actorOf(c), pid, b);
  return c.json(await detail(c, pid));
});

// ---------------------------------------------------------------- duyệt / gửi / huỷ / đóng

purchaseOrderRoutes.post("/purchase-orders/:id/approve", requirePerm("purchasing.approve"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, z.object({ version }));
  const r = await approvePo(c.env.DB, c, pid, b.version);
  return c.json({ ...(await detail(c, pid)), result: r.status });
});

purchaseOrderRoutes.post("/purchase-orders/:id/cancel", requirePerm("purchasing.write"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300), version }));
  const po = await loadPo(c.env.DB, pid);
  // PO đã gửi NCC chỉ người có quyền duyệt mới huỷ được (nháp: người lập/thủ kho huỷ được)
  if (po.status !== "draft" && !can(c.get("user").role, "purchasing.approve")) throw forbidden();
  await cancelPo(c.env.DB, actorOf(c), pid, b.reason, b.version);
  return c.json(await detail(c, pid));
});

purchaseOrderRoutes.post("/purchase-orders/:id/close", requirePerm("purchasing.approve"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, z.object({ reason: z.string().trim().min(3).max(300), version }));
  await closePo(c.env.DB, actorOf(c), pid, b.reason, b.version);
  return c.json(await detail(c, pid));
});

// ---------------------------------------------------------------- phản hồi NCC (ghi nhận hộ) + xử lý đề xuất

purchaseOrderRoutes.post("/purchase-orders/:id/supplier-response", requirePerm("purchasing.approve"), async (c) => {
  const pid = id(c);
  const b = await parseBody(
    c,
    z.object({
      action: z.enum(["confirm", "propose", "reject"]),
      version: z.number().int().positive(),
      expectedDate: dateOrNull,
      note: z.string().trim().max(500).nullish(),
      lines: z
        .array(z.object({ lineId: z.number().int().positive().optional(), productId: z.number().int().positive().optional(), qtyMilli: z.number().int().min(0).optional(), unitCost: z.number().int().min(0).nullish(), note: z.string().trim().max(200).nullish() })
          .refine((l) => l.lineId != null || l.productId != null, { message: "Cần lineId hoặc productId" }))
        .max(100)
        .optional(),
    }),
  );
  await applySupplierResponse(c.env.DB, pid, b, { ...actorOf(c), id: c.get("user").id });
  return c.json(await detail(c, pid));
});

purchaseOrderRoutes.post("/purchase-orders/:id/proposal/accept", requirePerm("purchasing.approve"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, z.object({ version, note: z.string().trim().max(300).optional() }));
  await decideProposal(c.env.DB, actorOf(c), pid, { accept: true, version: b.version, reason: b.note });
  return c.json(await detail(c, pid));
});

purchaseOrderRoutes.post("/purchase-orders/:id/proposal/reject", requirePerm("purchasing.approve"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, z.object({ version, reason: z.string().trim().min(3).max(300) }));
  await decideProposal(c.env.DB, actorOf(c), pid, { accept: false, version: b.version, reason: b.reason });
  return c.json(await detail(c, pid));
});

// ---------------------------------------------------------------- nhận hàng theo PO

purchaseOrderRoutes.post("/purchase-orders/:id/receive", requirePerm("purchasing.write", "inventory.write"), async (c) => {
  const pid = id(c);
  const b = await parseBody(
    c,
    z.object({
      version,
      locationId: z.number().int().positive().optional(),
      supplierRef: z.string().trim().max(60).nullish(),
      vatAmount: z.number().int().min(0).max(10_000_000_000).optional(),
      note: z.string().trim().max(500).nullish(),
      lines: z
        .array(z.object({ poLineId: z.number().int().positive(), qtyMilli: z.number().int().positive().max(1_000_000_000), expiresAt: z.string().datetime().nullish(), unitCost: z.number().int().min(0).max(1_000_000_000).nullish() }))
        .min(1)
        .max(100),
    }),
  );
  const r = await receivePo(c.env.DB, c, pid, b);
  return c.json({ ...(await detail(c, pid)), result: { status: r.status, stockDoc: r.doc, bill: r.bill, filledShortages: r.filled } }, 201);
});

// ---------------------------------------------------------------- PDF

purchaseOrderRoutes.get("/purchase-orders/:id/pdf", requirePerm("purchasing.view"), async (c) => {
  const pid = id(c);
  const po = await loadPo(c.env.DB, pid);
  const bytes = await renderPoPdf(c.env, po, await poLines(c.env.DB, pid), costOf(c));
  return new Response(bytes as BodyInit, { status: 200, headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${po.code}.pdf"`, "cache-control": "no-store" } });
});

// ---------------------------------------------------------------- duyệt PO vượt ngưỡng qua luồng duyệt chung (C-27: có thông báo)

registerApprovalHandler("purchase_order.approve", {
  perm: "purchasing.approve_high",
  async onApprove(c, a) {
    return approvalApproveStmts(c.env.DB, c, Number(a.ref_id));
  },
  async onReject(c, a, note) {
    return approvalRejectStmts(c.env.DB, c, Number(a.ref_id), note);
  },
});
