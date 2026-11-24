import type { Env } from "../env";
import { vnDate } from "../lib/time";
import { getProvider, loadInvoiceDoc } from "./einvoice";
import { INVOICE_OUTSTANDING_SQL, addDays } from "./debt";
import { enqueueJobStmt } from "./outbox";
import { sysAudit, sysAuditStmt } from "./sysaudit";
import { notifyEmail, notifyManagers, notifyOrderStatus, notifyStaffNewOrder } from "./notify";

/** Backoff sau lần thất bại thứ n (1-based): 1 phút, 5 phút, 30 phút, 2 giờ, 12 giờ. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];
export const MAX_ATTEMPTS = 5;
/** Job 'running' quá lâu (worker chết giữa chừng) được trả về 'failed' để chạy lại. */
const STUCK_MS = 10 * 60_000;

export interface JobRow {
  id: number;
  type: string;
  ref_type: string | null;
  ref_id: number | null;
  payload_json: string;
  status: string;
  attempts: number;
  next_run_at: string;
  last_error: string | null;
  result_json: string | null;
}

export type ProcessOutcome =
  | { status: "done"; result: unknown }
  | { status: "failed"; delaySeconds: number; error: string }
  | { status: "dead"; error: string }
  | { status: "skipped" }; // không giành được khoá (đang chạy / đã xong / chưa đến hạn)

/** Che secret + cắt 500 ký tự trước khi lưu last_error. */
export function sanitizeError(e: unknown, env: Env): string {
  let m = String((e as Error)?.message ?? e ?? "Lỗi không xác định");
  for (const s of [env.MISA_PASSWORD, env.MISA_USERNAME, env.MISA_APP_ID, env.MISA_TAX_CODE, env.FRESCO_WEBHOOK_SECRET, env.BOOTSTRAP_TOKEN, env.VAPID_PRIVATE_KEY]) {
    if (s && s.length >= 4) m = m.split(s).join("***");
  }
  m = m.replace(/\bbearer\s+\S+/gi, "Bearer ***").replace(/(authorization|password|token)\s*[:=]\s*\S+/gi, "$1=***");
  return m.slice(0, 500);
}

export async function processJob(env: Env, jobId: number, now = new Date()): Promise<ProcessOutcome> {
  const db = env.DB;
  const nowIso = now.toISOString();
  const claim = await db
    .prepare(
      `UPDATE integration_jobs SET status='running', attempts=attempts+1, updated_at=?1
        WHERE id=?2 AND status IN ('queued','failed') AND next_run_at<=?1`,
    )
    .bind(nowIso, jobId)
    .run();
  if (!claim.meta.changes) return { status: "skipped" };
  const job = (await db.prepare(`SELECT * FROM integration_jobs WHERE id=?`).bind(jobId).first<JobRow>())!;

  try {
    const result = await dispatch(env, job);
    await db
      .prepare(`UPDATE integration_jobs SET status='done', result_json=?, last_error=NULL, updated_at=? WHERE id=?`)
      .bind(JSON.stringify(result ?? null), new Date().toISOString(), jobId)
      .run();
    return { status: "done", result };
  } catch (e) {
    const error = sanitizeError(e, env);
    const dead = job.attempts >= MAX_ATTEMPTS;
    const delay = BACKOFF_MS[Math.min(job.attempts, BACKOFF_MS.length) - 1];
    const stmts = [
      db
        .prepare(`UPDATE integration_jobs SET status=?, last_error=?, next_run_at=?, updated_at=? WHERE id=?`)
        .bind(dead ? "dead" : "failed", error, new Date(now.getTime() + (dead ? 0 : delay)).toISOString(), new Date().toISOString(), jobId),
    ];
    if (dead) stmts.push(sysAuditStmt(db, { action: "job.dead", entity: "integration_job", entityId: jobId, after: { type: job.type, refType: job.ref_type, refId: job.ref_id, attempts: job.attempts }, reason: error }));
    await db.batch(stmts);
    if (job.type.startsWith("einvoice.") && job.ref_type === "invoice" && job.ref_id) {
      await db
        .prepare(`UPDATE invoices SET einvoice_status='failed', einvoice_error=? WHERE id=? AND einvoice_status <> 'issued'`)
        .bind(error, job.ref_id)
        .run();
    }
    return dead ? { status: "dead", error } : { status: "failed", delaySeconds: Math.round(delay / 1000), error };
  }
}

async function dispatch(env: Env, job: JobRow): Promise<unknown> {
  switch (job.type) {
    case "einvoice.issue":
      return einvoiceIssue(env, job);
    case "einvoice.adjust":
      return einvoiceAdjust(env, job);
    case "einvoice.cancel":
      return einvoiceCancel(env, job);
    case "debt.remind":
      return debtRemind(env, job);
    case "fresco.ack":
      return { noop: true }; // TODO: gọi API xác nhận đơn của Fresco khi có tài liệu API
    case "notify.order_status":
      return notifyOrderStatus(env, orderRef(job), JSON.parse(job.payload_json || "{}"));
    case "notify.staff_new_order":
      return notifyStaffNewOrder(env, orderRef(job));
    case "notify.email":
      return notifyEmail(env, JSON.parse(job.payload_json || "{}"));
    case "notify.managers":
      return notifyManagers(env, JSON.parse(job.payload_json || "{}"));
    default:
      throw new Error(`Loại job không hỗ trợ: ${job.type}`);
  }
}

function orderRef(job: JobRow) {
  if (job.ref_type !== "order" || !job.ref_id) throw new Error("Job thiếu tham chiếu đơn hàng");
  return job.ref_id;
}

function invoiceIdOf(job: JobRow) {
  if (job.ref_type !== "invoice" || !job.ref_id) throw new Error("Job thiếu tham chiếu hoá đơn");
  return job.ref_id;
}

async function markIssued(env: Env, invoiceId: number, r: { einvoiceNo: string; series: string; lookupCode: string }) {
  await env.DB.batch([
    env.DB
      .prepare(`UPDATE invoices SET einvoice_status='issued', einvoice_no=?, einvoice_series=?, einvoice_lookup_code=?, einvoice_error=NULL WHERE id=?`)
      .bind(r.einvoiceNo, r.series, r.lookupCode, invoiceId),
    sysAuditStmt(env.DB, { action: "einvoice.issued", entity: "invoice", entityId: invoiceId, after: r }),
  ]);
}

async function einvoiceIssue(env: Env, job: JobRow) {
  const id = invoiceIdOf(job);
  const inv = await loadInvoiceDoc(env.DB, id);
  if (!inv) throw new Error("Không tìm thấy hoá đơn");
  if (inv.einvoiceStatus === "issued") return { skipped: "already_issued", einvoiceNo: inv.einvoiceNo }; // idempotent
  if (inv.status === "cancelled") throw new Error("Hoá đơn đã huỷ, không phát hành HĐĐT");
  const r = await (await getProvider(env)).issue(inv);
  await markIssued(env, id, r);
  return r;
}

async function einvoiceAdjust(env: Env, job: JobRow) {
  const id = invoiceIdOf(job);
  const inv = await loadInvoiceDoc(env.DB, id);
  if (!inv) throw new Error("Không tìm thấy hoá đơn điều chỉnh");
  if (inv.einvoiceStatus === "issued") return { skipped: "already_issued", einvoiceNo: inv.einvoiceNo };
  if (!inv.originalInvoiceId) throw new Error("Hoá đơn điều chỉnh thiếu hoá đơn gốc");
  const orig = await loadInvoiceDoc(env.DB, inv.originalInvoiceId);
  if (!orig || orig.einvoiceStatus !== "issued" || !orig.einvoiceNo) throw new Error("Hoá đơn gốc chưa được phát hành HĐĐT");
  const r = await (await getProvider(env)).adjust(inv, orig);
  await markIssued(env, id, r);
  return r;
}

async function einvoiceCancel(env: Env, job: JobRow) {
  const id = invoiceIdOf(job);
  const inv = await loadInvoiceDoc(env.DB, id);
  if (!inv) throw new Error("Không tìm thấy hoá đơn");
  if (inv.einvoiceStatus !== "issued") return { skipped: "not_issued" }; // idempotent: chưa phát hành / đã huỷ
  const reason = String((JSON.parse(job.payload_json || "{}") as { reason?: string }).reason ?? "Huỷ hoá đơn");
  await (await getProvider(env)).cancel(inv, reason);
  await env.DB.batch([
    // Sau khi huỷ, trạng thái HĐĐT về 'none' (có thể phát hành lại hoá đơn thay thế); số cũ giữ lại ở audit.
    env.DB.prepare(`UPDATE invoices SET einvoice_status='none', einvoice_error=? WHERE id=?`).bind(`Đã huỷ HĐĐT số ${inv.einvoiceNo}: ${reason}`.slice(0, 500), id),
    sysAuditStmt(env.DB, { action: "einvoice.cancelled", entity: "invoice", entityId: id, before: { einvoiceNo: inv.einvoiceNo }, reason }),
  ]);
  return { cancelled: inv.einvoiceNo };
}

/** Nhắc nợ: hiện chỉ ghi nhận danh sách người nhận (audit + result_json). TODO: gửi email thật bằng Cloudflare Email Service. */
async function debtRemind(env: Env, job: JobRow) {
  const payload = JSON.parse(job.payload_json || "{}") as { customerIds?: number[]; daysBeforeDue?: number };
  const ids = payload.customerIds?.length ? payload.customerIds : job.ref_type === "customer" && job.ref_id ? [job.ref_id] : [];
  if (!ids.length) throw new Error("Job nhắc nợ thiếu khách hàng");
  const days = payload.daysBeforeDue ?? (await remindDays(env.DB));
  const horizon = addDays(vnDate(), days);
  const recipients: unknown[] = [];
  for (const cid of ids) {
    const c = await env.DB.prepare(`SELECT id, code, name, email FROM customers WHERE id=?`).bind(cid).first<{ id: number; code: string; name: string; email: string | null }>();
    if (!c) continue;
    const { results } = await env.DB
      .prepare(
        `SELECT i.id, i.code, i.due_date, ${INVOICE_OUTSTANDING_SQL} AS outstanding FROM invoices i
          WHERE i.customer_id = ? AND i.status='open' AND i.kind IN ('sale','replacement') AND i.due_date <= ?
          ORDER BY i.due_date, i.id`,
      )
      .bind(cid, horizon)
      .all<{ id: number; code: string; due_date: string; outstanding: number }>();
    const open = results.filter((r) => r.outstanding > 0);
    if (!open.length) continue;
    recipients.push({
      customerId: c.id, customerCode: c.code, name: c.name, email: c.email,
      invoices: open.map((r) => ({ id: r.id, code: r.code, dueDate: r.due_date, outstanding: r.outstanding })),
      totalOutstanding: open.reduce((s, r) => s + r.outstanding, 0),
    });
  }
  await sysAudit(env.DB, { action: "debt.remind", entity: "integration_job", entityId: job.id, after: { recipients: recipients.length, sent: false } });
  return { recipients, delivery: "not_sent_email_todo" };
}

async function remindDays(db: D1Database) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key='remind.days_before_due'`).first<{ value: string }>();
  const n = Number(r?.value);
  return Number.isFinite(n) ? n : 3;
}

/**
 * Cron mỗi 5 phút: trả 'running' bị kẹt về 'failed', rồi đẩy job đến hạn lên Queue (hoặc xử lý trực tiếp nếu không có Queue / Queue lỗi / opts.inline).
 */
export async function sweepJobs(env: Env, opts: { inline?: boolean; limit?: number; now?: Date } = {}) {
  const db = env.DB;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  await db
    .prepare(`UPDATE integration_jobs SET status='failed', last_error='Job bị kẹt (running quá lâu), chạy lại', updated_at=?1 WHERE status='running' AND updated_at < ?2`)
    .bind(nowIso, new Date(now.getTime() - STUCK_MS).toISOString())
    .run();
  const { results } = await db
    .prepare(`SELECT id FROM integration_jobs WHERE status IN ('queued','failed') AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?`)
    .bind(nowIso, opts.limit ?? 50)
    .all<{ id: number }>();
  let processed = 0;
  let queued = 0;
  if (env.JOBS && !opts.inline && results.length) {
    try {
      await env.JOBS.sendBatch(results.map((r) => ({ body: { jobId: r.id } })));
      queued = results.length;
      return { found: results.length, queued, processed };
    } catch {
      /* Queue lỗi → xử lý trực tiếp */
    }
  }
  for (const r of results) {
    const o = await processJob(env, r.id, now);
    if (o.status !== "skipped") processed++;
  }
  return { found: results.length, queued, processed };
}

/**
 * Cron hằng ngày: mỗi khách có hoá đơn quá hạn / đến hạn trong `remind.days_before_due` ngày → 1 job debt.remind/ngày/khách.
 */
export async function enqueueDebtReminders(env: Env, today = vnDate()) {
  const db = env.DB;
  const horizon = addDays(today, await remindDays(db));
  const { results } = await db
    .prepare(
      `SELECT DISTINCT i.customer_id AS id FROM invoices i
        WHERE i.customer_id IS NOT NULL AND i.status='open' AND i.kind IN ('sale','replacement') AND i.due_date <= ?1
          AND ${INVOICE_OUTSTANDING_SQL} > 0
          AND NOT EXISTS (SELECT 1 FROM integration_jobs j WHERE j.type='debt.remind' AND j.ref_type='customer' AND j.ref_id=i.customer_id
                           AND json_extract(j.payload_json,'$.day') = ?2)`,
    )
    .bind(horizon, today)
    .all<{ id: number }>();
  if (!results.length) return 0;
  await db.batch(results.map((r) => enqueueJobStmt(db, "debt.remind", "customer", r.id, { day: today })));
  return results.length;
}
