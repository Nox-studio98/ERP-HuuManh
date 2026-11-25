import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { camel } from "../services/debt-ledger";
import { parseBody, pageParams, likeOf } from "../services/http";
import { assignEvent, ensurePayCode, invoiceState, resolveEvent, sepayConfig } from "../services/sepay";
import { reconcileSepay } from "../services/sepay-reconcile";
import { buildVietQr } from "../../shop/worker/lib/vietqr";
import { bankByBin, bankByGateway } from "../lib/vn-banks";

/** SePay: danh sách giao dịch chưa khớp / chờ hoàn, gán tay, đánh dấu đã hoàn / bỏ qua; mã thanh toán nợ sỉ; QR POS. Webhook công khai nằm ở routes/webhooks.ts. */
export const sepayRoutes = new Hono<AppBindings>();

const STATUSES = ["pending", "unmatched", "refund_pending", "matched", "refunded", "ignored", "pos_unused", "all"] as const;

sepayRoutes.get("/sepay/events", requirePerm("finance.view"), async (c) => {
  const q = c.req.query();
  const { limit, cursor } = pageParams(c);
  const st = (STATUSES as readonly string[]).includes(q.status ?? "") ? q.status! : "pending";
  const conds: string[] = [];
  const params: unknown[] = [];
  if (st === "pending") conds.push(`e.status IN ('unmatched','refund_pending')`);
  else if (st === "pos_unused") conds.push(`e.kind = 'pos' AND e.status = 'matched' AND EXISTS (SELECT 1 FROM pos_qr_requests r WHERE r.event_id = e.id AND r.status = 'paid')`);
  else if (st !== "all") { conds.push(`e.status = ?`); params.push(st); }
  if (q.q?.trim()) {
    conds.push(`(e.code LIKE ? ESCAPE '\\' OR e.reference_code LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\' OR e.ref_code LIKE ? ESCAPE '\\')`);
    params.push(likeOf(q.q), likeOf(q.q), likeOf(q.q), likeOf(q.q));
  }
  if (cursor) { conds.push(`e.id < ?`); params.push(cursor); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const { results } = await c.env.DB
    .prepare(
      `SELECT e.id, e.sepay_id, e.source, e.txn_at, e.account_number, e.gateway, e.code, e.amount, e.reference_code, e.content, e.status, e.reason, e.kind, e.ref_id, e.ref_code,
              e.resolution, e.resolved_at, e.created_at, u.full_name AS resolved_by_name
         FROM sepay_events e LEFT JOIN users u ON u.id = e.resolved_by ${where} ORDER BY e.id DESC LIMIT ?`,
    )
    .bind(...params, limit + 1)
    .all<any>();
  const items = results.slice(0, limit).map((r) => camel({ ...r, account_number: r.account_number ? `***${String(r.account_number).slice(-4)}` : null }));
  const sum = await c.env.DB
    .prepare(`SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM sepay_events WHERE status IN ('unmatched','refund_pending') GROUP BY status`)
    .all<{ status: string; n: number; amount: number }>();
  const by = (s: string) => sum.results.find((r) => r.status === s) ?? { n: 0, amount: 0 };
  return c.json({
    items,
    nextCursor: results.length > limit ? String(items[items.length - 1].id) : null,
    summary: { unmatched: { count: by("unmatched").n, amount: by("unmatched").amount }, refundPending: { count: by("refund_pending").n, amount: by("refund_pending").amount } },
  });
});

sepayRoutes.post("/sepay/events/:id/assign", requirePerm("finance.write"), async (c) => {
  const body = await parseBody(c, z.object({ kind: z.enum(["web", "b2b"]), code: z.string().trim().min(3).max(40), note: z.string().trim().min(3).max(300) }));
  const ref = await assignEvent(c, Number(c.req.param("id")), body, body.note);
  return c.json({ ok: true, ref });
});

sepayRoutes.post("/sepay/events/:id/resolve", requirePerm("finance.write"), async (c) => {
  const body = await parseBody(c, z.object({ action: z.enum(["refunded", "ignored"]), reason: z.string().trim().min(3).max(300) }));
  await resolveEvent(c, Number(c.req.param("id")), body.action, body.reason);
  return c.json({ ok: true });
});

/** Cấu hình hiển thị cho giao diện (không lộ gì ngoài STK cửa hàng đã công khai trên website). */
sepayRoutes.get("/sepay/config", requirePerm("finance.view"), async (c) => {
  const cfg = await sepayConfig(c.env.DB);
  return c.json({ enabled: cfg.enabled, flow: cfg.flow, prefixB2b: cfg.prefixB2b, prefixPos: cfg.prefixPos, bank: cfg.bank, apiKeySet: !!c.env.SEPAY_API_KEY, webhookSecretSet: !!c.env.SEPAY_WEBHOOK_SECRET, bankCheck: await bankCheck(c.env.DB, cfg.bank.bin) });
});

/** Mã thanh toán + VietQR cho một hoá đơn sỉ còn nợ (nhân viên đọc cho khách hoặc gửi khách). */
sepayRoutes.get("/sepay/invoices/:id/pay-info", requirePerm("debt.view"), async (c) => {
  const cfg = await sepayConfig(c.env.DB);
  const inv = await invoiceState(c.env.DB, "i.id = ?", Number(c.req.param("id")));
  if (!inv || !inv.customer_id) throw notFound("invoice_not_found", "Không tìm thấy hoá đơn");
  if (!cfg.enabled || !cfg.flow.b2b) return c.json({ available: false });
  const code = await ensurePayCode(c.env.DB, "b2b", inv.id);
  const amount = Math.max(0, inv.os);
  return c.json({
    available: inv.status === "open" && amount > 0, code, amount, invoiceCode: inv.code, bank: cfg.bank,
    qrPayload: amount > 0 ? buildVietQr({ bankBin: cfg.bank.bin, accountNo: cfg.bank.account, amount, content: code }) : null,
  });
});

sepayRoutes.post("/sepay/reconcile", requirePerm("finance.write"), async (c) => {
  const r = await reconcileSepay(c.env);
  await auditStmt(c, { action: "sepay.reconcile", entity: "sepay", after: r }).run();
  return c.json(r);
});

// ---------------------------------------------------------------- QR tại quầy POS
/** POS chỉ cần biết có dùng QR tự động hay không. */
sepayRoutes.get("/pos/sepay-config", requirePerm("pos.sell"), async (c) => {
  const cfg = await sepayConfig(c.env.DB);
  return c.json({ enabled: cfg.enabled, flow: { pos: cfg.flow.pos } });
});

sepayRoutes.post("/pos/qr-requests", requirePerm("pos.sell"), async (c) => {
  const body = await parseBody(c, z.object({ amount: z.number().int().positive().max(10_000_000_000) }));
  const db = c.env.DB;
  const user = c.get("user");
  const cfg = await sepayConfig(db);
  if (!cfg.enabled || !cfg.flow.pos) throw new AppError(422, "sepay_pos_disabled", "Chưa bật xác nhận QR tự động");
  if (!cfg.bank.account) throw new AppError(422, "no_bank_account", "Chưa cấu hình tài khoản nhận tiền");
  const shift = await db.prepare(`SELECT id FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(user.id).first<{ id: number }>();
  const expires = new Date(Date.now() + cfg.qrTtlMin * 60_000).toISOString();
  // Một thu ngân chỉ có một mã đang chờ cho cùng số tiền: huỷ các mã chờ cũ (đổi số tiền → mã mới, mã cũ không còn nhận tiền)
  await db.prepare(`UPDATE pos_qr_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'`).bind(user.id).run();
  const r = await db.prepare(`INSERT INTO pos_qr_requests(amount, user_id, shift_id, expires_at) VALUES (?,?,?,?)`).bind(body.amount, user.id, shift?.id ?? null, expires).run();
  const id = r.meta.last_row_id as number;
  const code = await ensurePayCode(db, "pos", id);
  return c.json({
    id, code, amount: body.amount, status: "pending", expiresAt: expires, bank: cfg.bank,
    qrPayload: buildVietQr({ bankBin: cfg.bank.bin, accountNo: cfg.bank.account, amount: body.amount, content: code }),
  }, 201);
});

/** Giao diện hỏi ~3 giây/lần; không gọi SePay. Chỉ trả trạng thái + số tiền. */
sepayRoutes.get("/pos/qr-requests/:id", requirePerm("pos.sell"), async (c) => {
  const row = await c.env.DB
    .prepare(`SELECT id, amount, status, expires_at, paid_at, user_id FROM pos_qr_requests WHERE id = ?`)
    .bind(Number(c.req.param("id")))
    .first<any>();
  if (!row || row.user_id !== c.get("user").id) throw notFound("qr_not_found", "Không tìm thấy mã QR");
  const expired = row.status === "pending" && row.expires_at < new Date().toISOString();
  return c.json({ id: row.id, amount: row.amount, status: expired ? "expired" : row.status, expiresAt: row.expires_at, paidAt: row.paid_at });
});

sepayRoutes.post("/pos/qr-requests/:id/cancel", requirePerm("pos.sell"), async (c) => {
  const id = Number(c.req.param("id"));
  const r = await c.env.DB.prepare(`UPDATE pos_qr_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'`).bind(id, c.get("user").id).run();
  return c.json({ ok: true, cancelled: r.meta.changes > 0 });
});

/**
 * Kiểm tra cấu hình ngân hàng nhận tiền: ngân hàng đã chọn có trong danh sách SePay hỗ trợ không, có "chỉ nhận qua VA" không,
 * và có trùng ngân hàng của giao dịch tiền vào SePay gửi gần nhất không (trường `gateway`). Chỉ đọc, không lộ dữ liệu khách.
 */
async function bankCheck(db: D1Database, bin: string) {
  const sel = bankByBin(bin);
  const last = await db.prepare(`SELECT gateway FROM sepay_events WHERE transfer_type = 'in' AND COALESCE(gateway, '') <> '' ORDER BY id DESC LIMIT 1`).first<{ gateway: string }>();
  const seen = last ? bankByGateway(last.gateway) : undefined;
  const mismatch = !!last && (!seen || seen.bin !== bin);
  return {
    selected: sel ? { bin: sel.bin, shortName: sel.shortName, vaOnly: sel.vaOnly ?? null, note: sel.note ?? null } : null,
    supported: !!sel,
    lastGateway: last?.gateway ?? null,
    mismatch,
  };
}
