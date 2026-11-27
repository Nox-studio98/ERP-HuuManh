/**
 * SePay: xác nhận tiền chuyển khoản vào tài khoản cửa hàng (xem docs/SEPAY.md).
 *
 * Quy tắc (skill sepay › integration-design / webhook):
 *  - Khoá chống trùng là `id` của payload (sepay_id UNIQUE, insert-ignore). Đối soát có UUID riêng (api_id); hai loại id KHÔNG so với nhau,
 *    chỉ nhận ra "cùng một giao dịch" bằng tài khoản + số tiền + thời điểm + mã (+ mã tham chiếu khi cả hai đều có).
 *  - Phán quyết (`success`) quyết định ngay trong request và lưu trên dòng sự kiện; gửi lại cùng `id` trả đúng phán quyết cũ.
 *  - Khớp bằng `code` SePay nhận diện (không tự tách mã từ `content`), không phân biệt hoa/thường; KHÔNG khớp theo số tiền + thời gian.
 *  - Chuyển trạng thái có điều kiện trong MỘT db.batch (assertStmt + dòng sự kiện cùng batch) → hai giao dịch song song cho một đơn chỉ có một thắng.
 *  - Sai số tiền / mã lạ / sai tài khoản → unmatched; đơn đã huỷ/quá hạn/đã trả → refund_pending (chờ hoàn); luôn success:false.
 *  - Log chỉ chứa id, mã, số tiền, trạng thái, 4 số cuối tài khoản — không memo, tên, header, secret.
 */
import type { Context } from "hono";
import type { AppBindings, Env, SessionUser } from "../env";
import { auditStmt } from "../lib/audit";
import { AppError } from "../lib/errors";
import { timingSafeEqual } from "../lib/crypto";
import { assertStmt } from "./guard";
import { bankFundId, markOrderPaid } from "./online-payments";
import { createPayment } from "./debt-ledger";
import { INVOICE_OUTSTANDING_SQL } from "./debt";
import { sysAuditStmt } from "./sysaudit";
import { holdInStmts, holdOutStmts, NO_LEDGER_REASONS, ignoreCategory, incomeStmt } from "./sepay-ledger";

type Ctx = Context<AppBindings>;

export const SEPAY_SYSTEM_USER_ID = 900;
export const PAY_CODE_DIGITS = 8;
export const WEB_PREFIX = "DH"; // mã đơn website = DH + 12 chữ số (xem nextOnlineCode)
export const WEB_CODE_RE = /^DH\d{12}$/;
const TOLERANCE_S = 300;

export type EventStatus = "received" | "matched" | "unmatched" | "refund_pending" | "refunded" | "ignored";
export type Flow = "web" | "b2b" | "pos";

export interface SepayTx {
  id: number | null; // id payload webhook
  apiId: string | null; // UUID API v2
  date: string; // YYYY-MM-DD HH:mm:ss giờ VN
  account: string;
  gateway: string;
  code: string | null;
  type: string;
  amount: number;
  ref: string;
  content: string;
}

export interface Verdict {
  eventId: number;
  success: boolean;
  status: EventStatus;
  reason: string | null;
  duplicate: boolean;
}

const mask4 = (s: string | null | undefined) => (s ? `***${s.slice(-4)}` : "");
const log = (msg: string, f: Record<string, unknown>) => console.log(JSON.stringify({ level: "info", msg, ...f }));

// ------------------------------------------------------------------ cấu hình
export async function sepayConfig(db: D1Database) {
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'sepay.%' OR key IN ('payment.bank_account','payment.bank_bin','payment.bank_account_name')`).all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  const g = (k: string, d = "") => m.get(k) ?? d;
  const accRaw = g("sepay.account_numbers").trim() || g("payment.bank_account").trim();
  return {
    enabled: g("sepay.enabled") === "1",
    accounts: accRaw.split(",").map((x) => x.trim()).filter(Boolean),
    flow: { web: g("sepay.flow_web", "1") === "1", b2b: g("sepay.flow_b2b", "1") === "1", pos: g("sepay.flow_pos", "1") === "1" } as Record<Flow, boolean>,
    prefixB2b: (g("sepay.prefix_b2b", "HDS").trim() || "HDS").toUpperCase(),
    prefixPos: (g("sepay.prefix_pos", "POS").trim() || "POS").toUpperCase(),
    qrTtlMin: Math.max(1, Number(g("sepay.pos_qr_ttl_min", "15")) || 15),
    apiBase: g("sepay.api_base", "https://userapi.sepay.vn/v2").trim().replace(/\/+$/, ""),
    bank: { bin: g("payment.bank_bin", "970436"), account: g("payment.bank_account"), name: g("payment.bank_account_name") },
  };
}

// ------------------------------------------------------------------ xác thực HMAC
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function sepaySign(secret: string, timestamp: string | number, raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`)));
}

/** Ném AppError(401/503) nếu không hợp lệ. Secret rỗng → từ chối tất cả (fail closed). */
export async function verifySepayRequest(secret: string | undefined, raw: string, signature: string | undefined, timestamp: string | undefined) {
  if (!secret) throw new AppError(503, "webhook_not_configured", "Chưa cấu hình khoá webhook");
  const ts = Number(timestamp);
  if (!timestamp || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) throw new AppError(401, "bad_timestamp", "Request quá hạn hoặc thiếu timestamp");
  const enc = new TextEncoder();
  const want = enc.encode(await sepaySign(secret, timestamp, raw));
  if (!signature || !timingSafeEqual(enc.encode(signature.trim()), want)) throw new AppError(401, "bad_signature", "Chữ ký không hợp lệ");
}

// ------------------------------------------------------------------ mã thanh toán nợ sỉ / POS
const randDigits = (n: number) => {
  const b = crypto.getRandomValues(new Uint32Array(n));
  return [...b].map((x) => String(x % 10)).join("");
};

/** Mã thanh toán của hoá đơn sỉ / yêu cầu QR POS: tạo một lần (UNIQUE(kind, ref_id)), thử lại khi trùng mã. */
export async function ensurePayCode(db: D1Database, kind: "b2b" | "pos", refId: number): Promise<string> {
  const cfg = await sepayConfig(db);
  const prefix = kind === "b2b" ? cfg.prefixB2b : cfg.prefixPos;
  for (let i = 0; i < 8; i++) {
    const have = await db.prepare(`SELECT code FROM pay_codes WHERE kind = ? AND ref_id = ?`).bind(kind, refId).first<{ code: string }>();
    if (have) return have.code;
    await db.prepare(`INSERT OR IGNORE INTO pay_codes(code, kind, ref_id) VALUES (?,?,?)`).bind(prefix + randDigits(PAY_CODE_DIGITS), kind, refId).run();
  }
  throw new AppError(500, "pay_code_failed", "Không tạo được mã thanh toán");
}

// ------------------------------------------------------------------ chuẩn hoá giao dịch
export const vnToUtcIso = (vn: string): string => {
  const d = new Date(vn.trim().replace(" ", "T") + "+07:00");
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

export function txFromRow(r: any): SepayTx {
  return { id: r.sepay_id, apiId: r.api_id, date: "", account: r.account_number ?? "", gateway: r.gateway ?? "", code: r.code, type: r.transfer_type ?? "", amount: r.amount, ref: r.reference_code ?? "", content: r.content ?? "" };
}

// ------------------------------------------------------------------ Context hệ thống (webhook / cron không có phiên đăng nhập)
export function systemCtx(env: Env, requestId = crypto.randomUUID()): Ctx {
  const user: SessionUser = { id: SEPAY_SYSTEM_USER_ID, username: "he-thong-sepay", fullName: "Hệ thống (SePay)", role: "accountant", storeId: 1, sessionId: "sepay", deviceId: null };
  return { env, get: (k: string) => (k === "user" ? user : k === "requestId" ? requestId : undefined), req: { header: () => undefined } } as unknown as Ctx;
}

// ------------------------------------------------------------------ ghi sự kiện (chống trùng)
interface EventRow {
  id: number; sepay_id: number | null; api_id: string | null; source: string; txn_at: string | null; account_number: string | null; gateway: string | null; code: string | null;
  transfer_type: string | null; amount: number; reference_code: string | null; content: string | null; status: EventStatus; verdict: number | null; reason: string | null;
  kind: string | null; ref_id: number | null; ref_code: string | null; created_at: string;
  hold_in_voucher_id: number | null; hold_out_voucher_id: number | null;
}

const verdictOf = (r: EventRow, duplicate: boolean): Verdict => ({ eventId: r.id, success: r.verdict === 1, status: r.status, reason: r.reason, duplicate });

/** Tìm sự kiện trùng khác nguồn (webhook ↔ đối soát) theo tài khoản + số tiền + thời điểm + mã (+ mã tham chiếu khi cả hai có). */
async function findTwin(db: D1Database, tx: SepayTx, txnAt: string): Promise<EventRow | null> {
  const fromWebhook = tx.id != null; // webhook tìm dòng do đối soát tạo (chưa có sepay_id) và ngược lại
  return db
    .prepare(
      `SELECT * FROM sepay_events
        WHERE ${fromWebhook ? "sepay_id IS NULL AND api_id IS NOT NULL" : "sepay_id IS NOT NULL AND api_id IS NULL"}
          AND account_number = ?1 AND amount = ?2 AND txn_at = ?3 AND COALESCE(UPPER(code), '') = ?4
          AND (COALESCE(reference_code, '') = '' OR ?5 = '' OR reference_code = ?5)
        ORDER BY id LIMIT 1`,
    )
    .bind(tx.account, tx.amount, txnAt, (tx.code ?? "").toUpperCase(), tx.ref)
    .first<EventRow>();
}

/**
 * Nhận một giao dịch (webhook hoặc đối soát): lưu theo khoá chống trùng rồi xử lý. Trả phán quyết (lưu trên dòng sự kiện).
 * Ném lỗi (→ 5xx) chỉ khi chưa lưu được sự kiện hoặc lỗi hạ tầng khi xử lý (dòng còn 'received' để cron xử lý lại).
 */
export async function ingestTransaction(env: Env, tx: SepayTx, source: "webhook" | "reconcile", payloadJson: string): Promise<Verdict> {
  const db = env.DB;
  const txnAt = vnToUtcIso(tx.date);
  const code = tx.code ? tx.code.toUpperCase() : null;
  const twin = await findTwin(db, tx, txnAt);
  if (twin) {
    // cùng một giao dịch đã có từ nguồn kia: gắn id còn thiếu, không xử lý lại
    if (tx.id != null) await db.prepare(`UPDATE sepay_events SET sepay_id = ? WHERE id = ? AND sepay_id IS NULL`).bind(tx.id, twin.id).run().catch(() => {});
    else if (tx.apiId) await db.prepare(`UPDATE sepay_events SET api_id = ? WHERE id = ? AND api_id IS NULL`).bind(tx.apiId, twin.id).run().catch(() => {});
    const cur = (await db.prepare(`SELECT * FROM sepay_events WHERE id = ?`).bind(twin.id).first<EventRow>())!;
    if (cur.verdict != null) return verdictOf(cur, true);
    return processEvent(env, cur.id);
  }
  const ins = await db
    .prepare(
      `INSERT OR IGNORE INTO sepay_events(sepay_id, api_id, source, txn_at, account_number, gateway, code, transfer_type, amount, reference_code, content, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(tx.id, tx.apiId, source, txnAt, tx.account, tx.gateway, code, tx.type, tx.amount, tx.ref || null, tx.content || null, payloadJson)
    .run();
  const row = await db
    .prepare(tx.id != null ? `SELECT * FROM sepay_events WHERE sepay_id = ?` : `SELECT * FROM sepay_events WHERE api_id = ?`)
    .bind(tx.id ?? tx.apiId)
    .first<EventRow>();
  if (!row) throw new AppError(500, "event_not_stored", "Không lưu được sự kiện");
  if (!ins.meta.changes) {
    if (row.verdict != null) return verdictOf(row, true); // gửi lại: trả đúng phán quyết cũ
    return { ...(await processEvent(env, row.id)), duplicate: true };
  }
  return processEvent(env, row.id);
}

// ------------------------------------------------------------------ quyết định
type Outcome =
  | { act: "pay"; kind: Flow; refId: number; refCode: string; run: (finalize: D1PreparedStatement[]) => Promise<void> }
  | { act: "park"; status: "unmatched" | "refund_pending"; reason: string; kind?: Flow; refId?: number; refCode?: string };

const park = (status: "unmatched" | "refund_pending", reason: string, extra: { kind?: Flow; refId?: number; refCode?: string } = {}): Outcome => ({ act: "park", status, reason, ...extra });

/** Câu lệnh gắn kết quả vào dòng sự kiện (chỉ đổi được khi còn ở trạng thái cho phép → hai bên xử lý song song chỉ một thắng). */
function claimStmts(db: D1Database, ev: { id: number }, from: EventStatus[], to: { status: EventStatus; verdict: 0 | 1; reason: string | null; kind?: string; refId?: number; refCode?: string; resolution?: string; resolvedBy?: number }) {
  const list = from.map((s) => `'${s}'`).join(",");
  return [
    assertStmt(db, "sepay.claim", `SELECT status IN (${list}) FROM sepay_events WHERE id = ?`, [ev.id]),
    db
      .prepare(
        `UPDATE sepay_events SET status = ?, verdict = ?, reason = COALESCE(?, reason), kind = COALESCE(?, kind), ref_id = COALESCE(?, ref_id), ref_code = COALESCE(?, ref_code),
                resolution = COALESCE(?, resolution), resolved_by = COALESCE(?, resolved_by), resolved_at = CASE WHEN ? IS NULL THEN resolved_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
                processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status IN (${list})`,
      )
      .bind(to.status, to.verdict, to.reason, to.kind ?? null, to.refId ?? null, to.refCode ?? null, to.resolution ?? null, to.resolvedBy ?? null, to.resolution ?? null, ev.id),
  ];
}

async function decide(env: Env, ev: EventRow): Promise<Outcome> {
  const db = env.DB;
  const cfg = await sepayConfig(db);
  if (!cfg.enabled) return park("unmatched", "sepay_disabled");
  if ((ev.transfer_type ?? "") !== "in") return park("unmatched", "not_money_in");
  if (ev.amount <= 0) return park("unmatched", "invalid_amount");
  if (!cfg.accounts.length) return park("unmatched", "account_not_configured");
  if (!cfg.accounts.includes((ev.account_number ?? "").trim())) return park("unmatched", "wrong_account");
  const code = (ev.code ?? "").trim().toUpperCase();
  if (!code) return park("unmatched", "no_code");

  if (WEB_CODE_RE.test(code)) return decideWeb(env, ev, code, cfg);
  const pc = await db.prepare(`SELECT kind, ref_id FROM pay_codes WHERE code = ?`).bind(code).first<{ kind: "b2b" | "pos"; ref_id: number }>();
  if (!pc) return park("unmatched", "unknown_code");
  return pc.kind === "b2b" ? decideB2b(env, ev, code, pc.ref_id, cfg) : decidePos(env, ev, code, pc.ref_id, cfg);
}

type Cfg = Awaited<ReturnType<typeof sepayConfig>>;

// ---- đơn website
export interface WebPlan { order: any; expected: number }

/** Kiểm tra đơn website có nhận được khoản tiền này không; trả null nếu được, ngược lại lý do. */
export async function webOrderCheck(db: D1Database, code: string, amount: number): Promise<{ order?: any; expected?: number; park?: Outcome }> {
  const o = await db
    .prepare(`SELECT id, code, status, total, payment_status, payment_method FROM orders WHERE code = ? AND channel IN ('online','social') AND kind = 'sale'`)
    .bind(code)
    .first<any>();
  if (!o) return { park: park("unmatched", "unknown_code") };
  const ref = { kind: "web" as const, refId: o.id as number, refCode: o.code as string };
  if (o.payment_method !== "transfer" && o.payment_method !== "gateway") return { park: park("unmatched", "not_prepaid", ref) };
  if (o.payment_status === "paid") return { park: park("refund_pending", "already_paid", ref) };
  if (!["awaiting_payment", "new", "confirmed", "preparing"].includes(o.status)) return { park: park("refund_pending", "order_closed", ref) };
  let expected = o.total as number;
  if (o.status === "awaiting_payment") {
    const it = await db.prepare(`SELECT amount FROM payment_intents WHERE order_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).bind(o.id).first<{ amount: number }>();
    if (!it) return { park: park("refund_pending", "order_expired", ref) };
    expected = it.amount;
  }
  if (amount !== expected) return { park: park("unmatched", "amount_mismatch", ref) };
  return { order: o, expected };
}

async function decideWeb(env: Env, ev: EventRow, code: string, cfg: Cfg): Promise<Outcome> {
  if (!cfg.flow.web) return park("unmatched", "flow_disabled");
  const chk = await webOrderCheck(env.DB, code, ev.amount);
  if (chk.park) return chk.park;
  const o = chk.order;
  return {
    act: "pay", kind: "web", refId: o.id, refCode: o.code,
    run: async (finalize) => {
      await markOrderPaid(env, o, {
        userId: null, system: true, fundId: await bankFundId(env.DB), amount: ev.amount, ref: `SEPAY:${ev.sepay_id ?? ev.api_id}`,
        audit: sysAuditStmt(env.DB, { action: "sepay.order_paid", entity: "order", entityId: o.code, after: { eventId: ev.id, amount: ev.amount, reference: ev.reference_code } }),
        extra: finalize,
      });
    },
  };
}

// ---- nợ sỉ
export async function invoiceState(db: D1Database, where: string, bind: unknown) {
  return db
    .prepare(`SELECT i.id, i.code, i.customer_id, i.status, i.kind, ${INVOICE_OUTSTANDING_SQL} AS os FROM invoices i WHERE ${where}`)
    .bind(bind)
    .first<{ id: number; code: string; customer_id: number | null; status: string; kind: string; os: number }>();
}

async function decideB2b(env: Env, ev: EventRow, code: string, invoiceId: number, cfg: Cfg): Promise<Outcome> {
  if (!cfg.flow.b2b) return park("unmatched", "flow_disabled");
  const inv = await invoiceState(env.DB, "i.id = ?", invoiceId);
  if (!inv || !inv.customer_id) return park("unmatched", "unknown_code");
  const ref = { kind: "b2b" as const, refId: inv.id, refCode: inv.code };
  if (inv.status !== "open") return park("refund_pending", "invoice_closed", ref);
  if (inv.os <= 0) return park("refund_pending", "already_paid", ref);
  if (ev.amount !== inv.os) return park("unmatched", "amount_mismatch", ref);
  return { act: "pay", kind: "b2b", refId: inv.id, refCode: inv.code, run: (finalize) => payInvoice(systemCtx(env), ev, inv, ev.amount, finalize) };
}

async function payInvoice(c: Ctx, ev: EventRow, inv: { id: number; customer_id: number | null; code: string }, amount: number, finalize: D1PreparedStatement[]) {
  const fundId = await bankFundId(c.env.DB);
  const alloc = Math.min(amount, Math.max(0, (await invoiceState(c.env.DB, "i.id = ?", inv.id))?.os ?? 0));
  await createPayment(c, {
    direction: "in", partnerType: "customer", partnerId: inv.customer_id!, fundId, amount, method: "transfer",
    ref: `SEPAY:${ev.sepay_id ?? ev.api_id}`, note: `SePay: chuyển khoản hoá đơn ${inv.code}`,
    allocations: alloc > 0 ? [{ invoiceId: inv.id, amount: alloc }] : undefined,
    extra: finalize,
  });
}

// ---- QR tại quầy POS
async function decidePos(env: Env, ev: EventRow, code: string, requestId: number, cfg: Cfg): Promise<Outcome> {
  if (!cfg.flow.pos) return park("unmatched", "flow_disabled");
  const db = env.DB;
  const q = await db.prepare(`SELECT id, amount, status, expires_at FROM pos_qr_requests WHERE id = ?`).bind(requestId).first<any>();
  if (!q) return park("unmatched", "unknown_code");
  const ref = { kind: "pos" as const, refId: q.id as number, refCode: code };
  if (q.status === "paid" || q.status === "used") return park("refund_pending", "already_paid", ref);
  if (q.status === "cancelled") return park("refund_pending", "qr_cancelled", ref);
  if (q.status === "expired" || (ev.txn_at && ev.txn_at > q.expires_at)) return park("refund_pending", "qr_expired", ref);
  if (ev.amount !== q.amount) return park("unmatched", "amount_mismatch", ref);
  return {
    act: "pay", kind: "pos", refId: q.id, refCode: code,
    run: async (finalize) => {
      const hold = await holdInStmts(db, ev); // tiền QR đã về tài khoản: vào khoản chờ cho tới khi thu ngân hoàn tất đơn bằng QR này
      await db.batch([
        assertStmt(db, "sepay.pos_qr", `SELECT status = 'pending' FROM pos_qr_requests WHERE id = ?`, [q.id]),
        db.prepare(`UPDATE pos_qr_requests SET status = 'paid', event_id = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'`).bind(ev.id, q.id),
        sysAuditStmt(db, { action: "sepay.pos_qr_paid", entity: "pos_qr", entityId: q.id, after: { eventId: ev.id, amount: ev.amount } }),
        ...finalize,
        ...hold,
      ]);
    },
  };
}

// ------------------------------------------------------------------ xử lý một sự kiện đã lưu
export async function processEvent(env: Env, eventId: number): Promise<Verdict> {
  const db = env.DB;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ev = await db.prepare(`SELECT * FROM sepay_events WHERE id = ?`).bind(eventId).first<EventRow>();
    if (!ev) throw new AppError(404, "event_not_found", "Không thấy sự kiện");
    if (ev.verdict != null) return verdictOf(ev, true);
    const out = await decide(env, ev);
    try {
      if (out.act === "park") {
        const hold = NO_LEDGER_REASONS.includes(out.reason) || ev.transfer_type !== "in" ? [] : await holdInStmts(db, ev); // tiền vào chưa khớp → khoản chờ xử lý
        await db.batch([
          ...claimStmts(db, ev, ["received"], { status: out.status, verdict: 0, reason: out.reason, kind: out.kind, refId: out.refId, refCode: out.refCode }),
          ...hold,
          sysAuditStmt(db, { action: `sepay.${out.status}`, entity: "sepay_event", entityId: ev.id, after: { reason: out.reason, amount: ev.amount, code: ev.code, kind: out.kind ?? null } }),
        ]);
      } else {
        await out.run(claimStmts(db, ev, ["received"], { status: "matched", verdict: 1, reason: null, kind: out.kind, refId: out.refId, refCode: out.refCode }));
      }
    } catch (e) {
      // Thua cuộc đua (đơn/hoá đơn/QR vừa được xử lý ở nơi khác, hoặc cùng sự kiện đang xử lý song song): đọc lại và quyết định lại
      const msg = String((e as Error)?.message ?? "") + (e instanceof AppError ? " " + e.code : "");
      const isRace = /state_changed|overallocated|CHECK constraint|UNIQUE|order_changed|already_paid|not_payable|nothing_to_allocate|exceed|allocation_invalid|outstanding/i.test(msg);
      if (isRace && attempt < 2) continue;
      if (!(e instanceof AppError) && !isRace) throw e; // lỗi hạ tầng: 5xx, dòng còn 'received' để cron xử lý lại
      const why = (e instanceof AppError ? e.code : "conflict").slice(0, 50);
      const parkRows = (hold: D1PreparedStatement[]) => [
        ...claimStmts(db, ev, ["received"], { status: "unmatched" as const, verdict: 0 as const, reason: `error:${why}`, kind: out.act === "pay" ? out.kind : undefined, refId: out.act === "pay" ? out.refId : undefined, refCode: out.act === "pay" ? out.refCode : undefined }),
        ...hold,
        sysAuditStmt(db, { action: "sepay.unmatched", entity: "sepay_event", entityId: ev.id, after: { reason: `error:${why}`, amount: ev.amount } }),
      ];
      // Có lỗi xử lý: vẫn phải đưa tiền vào khoản chờ; nếu chính phiếu chờ làm batch hỏng (vd. kỳ vừa khoá) thì lưu sự kiện không phiếu (ghi sau bằng thao tác "ghi giao dịch chờ cũ")
      const canHold = out.act === "pay" || !NO_LEDGER_REASONS.includes(out.reason);
      const withHold = canHold && ev.transfer_type === "in" ? await holdInStmts(db, ev) : [];
      await db.batch(parkRows(withHold)).catch(() => (withHold.length ? db.batch(parkRows([])).catch(() => {}) : undefined));
      continue;
    }
    const done = (await db.prepare(`SELECT * FROM sepay_events WHERE id = ?`).bind(eventId).first<EventRow>())!;
    log("sepay_event", { eventId: done.id, sepayId: done.sepay_id, code: done.code, amount: done.amount, status: done.status, reason: done.reason, account: mask4(done.account_number) });
    return verdictOf(done, false);
  }
  const last = (await db.prepare(`SELECT * FROM sepay_events WHERE id = ?`).bind(eventId).first<EventRow>())!;
  if (last.verdict == null) throw new AppError(500, "event_unresolved", "Chưa xử lý xong sự kiện");
  return verdictOf(last, true);
}

/** Cron: xử lý lại các sự kiện kẹt ở 'received' (crash giữa lúc lưu và xử lý). */
export async function redriveReceived(env: Env, olderThanMs = 120_000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const { results } = await env.DB.prepare(`SELECT id FROM sepay_events WHERE status = 'received' AND created_at <= ? ORDER BY id LIMIT 50`).bind(cutoff).all<{ id: number }>();
  let n = 0;
  for (const r of results) {
    try { await processEvent(env, r.id); n++; } catch (e) { console.error(JSON.stringify({ level: "error", msg: "sepay_redrive", eventId: r.id, err: String((e as Error)?.message).slice(0, 120) })); }
  }
  return n;
}

// ------------------------------------------------------------------ xử lý tay (route ERP)
export async function assignEvent(c: Ctx, eventId: number, target: { kind: "web"; code: string } | { kind: "b2b"; code: string }, note: string) {
  const db = c.env.DB;
  const user = c.get("user");
  const ev = await db.prepare(`SELECT * FROM sepay_events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!ev) throw new AppError(404, "event_not_found", "Không tìm thấy giao dịch");
  if (ev.status !== "unmatched" && ev.status !== "refund_pending") throw new AppError(409, "not_pending", "Giao dịch đã được xử lý");
  if (ev.transfer_type !== "in") throw new AppError(422, "not_money_in", "Chỉ gán được giao dịch tiền vào");
  const from: EventStatus[] = ["unmatched", "refund_pending"];
  const code = target.code.trim().toUpperCase();
  if (target.kind === "web") {
    const chk = await webOrderCheck(db, code, ev.amount);
    if (!chk.order) {
      const p = chk.park as Extract<Outcome, { act: "park" }>;
      throw new AppError(422, p.reason, MANUAL_MSG[p.reason] ?? "Không gán được vào đơn này", { reason: p.reason });
    }
    const o = chk.order;
    // Tiền đã nằm ở khoản chờ xử lý → phiếu chi chuyển ra CÙNG batch với payments của đơn (ròng quỹ không đổi lần hai)
    const rel = await holdOutStmts(db, ev, { userId: user.id, note: `Gán giao dịch SePay #${ev.id} vào đơn ${o.code}`, state: { i: ev.hold_in_voucher_id, o: ev.hold_out_voucher_id } });
    await markOrderPaid(c.env, o, {
      userId: user.id, fundId: await bankFundId(db), amount: ev.amount, ref: `SEPAY:${ev.sepay_id ?? ev.api_id}`,
      audit: auditStmt(c, { action: "sepay.assign", entity: "sepay_event", entityId: ev.id, after: { kind: "web", order: o.code, amount: ev.amount, holdRelease: rel.code }, reason: note }),
      extra: [...claimStmts(db, ev, from, { status: "matched", verdict: 1, reason: "manual", kind: "web", refId: o.id, refCode: o.code, resolution: note, resolvedBy: user.id }), ...rel.stmts],
    });
    return o.code as string;
  }
  const inv = await invoiceState(db, "UPPER(i.code) = ?", code);
  if (!inv || !inv.customer_id) throw new AppError(422, "unknown_code", MANUAL_MSG.unknown_code);
  if (inv.status !== "open" || inv.kind === "adjustment") throw new AppError(422, "invoice_closed", MANUAL_MSG.invoice_closed);
  if (inv.os <= 0) throw new AppError(422, "already_paid", MANUAL_MSG.already_paid);
  const rel = await holdOutStmts(db, ev, { userId: user.id, note: `Gán giao dịch SePay #${ev.id} vào hoá đơn ${inv.code}`, state: { i: ev.hold_in_voucher_id, o: ev.hold_out_voucher_id } });
  await payInvoice(
    c, ev, inv, ev.amount,
    [
      ...claimStmts(db, ev, from, { status: "matched", verdict: 1, reason: "manual", kind: "b2b", refId: inv.id, refCode: inv.code, resolution: note, resolvedBy: user.id }),
      ...rel.stmts,
      auditStmt(c, { action: "sepay.assign", entity: "sepay_event", entityId: ev.id, after: { kind: "b2b", invoice: inv.code, amount: ev.amount, holdRelease: rel.code }, reason: note }),
    ],
  );
  return inv.code;
}

const MANUAL_MSG: Record<string, string> = {
  unknown_code: "Không tìm thấy đơn/hoá đơn với mã này",
  not_prepaid: "Đơn này thanh toán khi nhận hàng (COD), không nhận chuyển khoản",
  already_paid: "Đơn/hoá đơn này đã được thanh toán đủ",
  order_closed: "Đơn đã huỷ hoặc đã đóng, không ghi nhận thanh toán được",
  order_expired: "Đơn đã hết hạn thanh toán",
  amount_mismatch: "Số tiền khác tổng đơn — đơn website chỉ nhận đúng số tiền",
  invoice_closed: "Hoá đơn đã huỷ hoặc không phải hoá đơn bán",
};

export async function resolveEvent(c: Ctx, eventId: number, action: "refunded" | "ignored", reason: string, opt: { categoryId?: number; keepInHold?: boolean; refundRef?: string } = {}) {
  const db = c.env.DB;
  const user = c.get("user");
  const ev = await db.prepare(`SELECT * FROM sepay_events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!ev) throw new AppError(404, "event_not_found", "Không tìm thấy giao dịch");
  if (ev.status !== "unmatched" && ev.status !== "refund_pending") throw new AppError(409, "not_pending", "Giao dịch đã được xử lý");
  const state = { i: ev.hold_in_voucher_id, o: ev.hold_out_voucher_id };
  const money: D1PreparedStatement[] = [];
  let note: Record<string, unknown> = {};
  if (action === "refunded") {
    // Đã hoàn tiền cho khách: tiền ra khỏi tài khoản → phiếu chi từ khoản chờ (chưa từng vào quỹ thì không có gì để chi)
    const rel = await holdOutStmts(db, ev, { userId: user.id, state, note: `Hoàn tiền cho khách (giao dịch SePay #${ev.id}${ev.reference_code ? `, tham chiếu ${ev.reference_code}` : ""})${opt.refundRef ? ` · mã hoàn ${opt.refundRef}` : ""}: ${reason}` });
    money.push(...rel.stmts);
    note = { voucher: rel.code, refundRef: opt.refundRef ?? null };
  } else if (state.i && !state.o) {
    // Bỏ qua: tiền vẫn nằm trong quỹ → bắt buộc chọn khoản mục thu thật, hoặc giữ ở khoản chờ (ghi lý do) để kế toán xử lý sau
    if (opt.categoryId) {
      const cat = await ignoreCategory(db, opt.categoryId);
      const rel = await holdOutStmts(db, ev, { userId: user.id, state, note: `Chuyển sang ${cat.code} (bỏ qua giao dịch SePay #${ev.id}): ${reason}` });
      money.push(...rel.stmts, ...(await incomeStmt(db, ev, { userId: user.id, categoryId: cat.id, note: `Giao dịch SePay #${ev.id} đã bỏ qua: ${reason}`, fundId: (await db.prepare(`SELECT fund_id FROM cash_vouchers WHERE id = ?`).bind(state.i).first<{ fund_id: number }>())!.fund_id })));
      note = { category: cat.code, voucher: rel.code };
    } else if (opt.keepInHold) {
      money.push(assertStmt(db, "sepay.hold_state", `SELECT hold_in_voucher_id IS ? AND hold_out_voucher_id IS ? FROM sepay_events WHERE id = ?`, [state.i, state.o, ev.id]));
      note = { keepInHold: true };
    } else throw new AppError(422, "category_required", "Giao dịch đã vào quỹ: chọn khoản mục thu, hoặc giữ ở “Chuyển khoản chờ xử lý” (kèm lý do)");
  } else if (opt.categoryId && !state.i && ev.transfer_type === "in" && !NO_LEDGER_REASONS.includes(ev.reason ?? "")) {
    // Sự kiện cũ chưa từng vào sổ mà được chọn khoản mục thu: ghi thẳng vào khoản mục đó
    const cat = await ignoreCategory(db, opt.categoryId);
    money.push(assertStmt(db, "sepay.hold_state", `SELECT hold_in_voucher_id IS NULL FROM sepay_events WHERE id = ?`, [ev.id]), ...(await incomeStmt(db, ev, { userId: user.id, categoryId: cat.id, note: `Giao dịch SePay #${ev.id} đã bỏ qua: ${reason}` })));
    note = { category: cat.code, direct: true };
  }
  await db.batch([
    ...claimStmts(db, ev, ["unmatched", "refund_pending"], { status: action, verdict: 0, reason: null, resolution: reason, resolvedBy: user.id }),
    ...money,
    auditStmt(c, { action: `sepay.${action}`, entity: "sepay_event", entityId: eventId, before: { status: ev.status }, after: { status: action, ...note }, reason }),
  ]);
}
