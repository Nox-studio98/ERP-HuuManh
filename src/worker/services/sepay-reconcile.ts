/**
 * Đối soát SePay (cron mỗi 30 phút): GET {api_base}/transactions?since_id=<con trỏ> — an toàn khi lỡ webhook.
 * Chỉ chạy khi có secret SEPAY_API_KEY và sepay.enabled = 1. Con trỏ lưu bảng sepay_state (api_cursor, UUID giao dịch cuối đã đọc).
 * Mỗi dòng đi qua đúng `ingestTransaction` như webhook: giao dịch webhook đã xử lý được nhận ra (không xử lý lại).
 * Giới hạn tốc độ API: 3 request/giây → nghỉ giữa các trang, lùi lại khi gặp 429.
 */
import type { Env } from "../env";
import { vnDate } from "../lib/time";
import { ingestTransaction, redriveReceived, sepayConfig, type SepayTx } from "./sepay";

const PER_PAGE = 100;
const MAX_PAGES = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApiRow {
  id: string; transaction_date: string; account_number: string; transfer_type: string; amount_in: number; transaction_content: string | null;
  reference_number: string | null; code: string | null; bank_brand_name?: string | null;
}

export function txFromApi(r: ApiRow): SepayTx {
  return {
    id: null, apiId: r.id, date: r.transaction_date, account: String(r.account_number ?? ""), gateway: r.bank_brand_name ?? "",
    code: r.code ? String(r.code) : null, type: r.transfer_type, amount: Number(r.amount_in) || 0, ref: r.reference_number ?? "", content: r.transaction_content ?? "",
  };
}

export async function reconcileSepay(env: Env, opts: { pauseMs?: number } = {}) {
  const out = { skipped: null as string | null, fetched: 0, processed: 0, duplicates: 0, redriven: 0 };
  const db = env.DB;
  const cfg = await sepayConfig(db);
  if (!env.SEPAY_API_KEY) { out.skipped = "no_api_key"; return out; }
  if (!cfg.enabled) { out.skipped = "disabled"; return out; }
  out.redriven = await redriveReceived(env);
  const pause = opts.pauseMs ?? 400;
  const cursor = (await db.prepare(`SELECT value FROM sepay_state WHERE key = 'api_cursor'`).first<{ value: string }>())?.value ?? null;
  let last = cursor;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page), transaction_date_sort: "asc", transfer_type: "in" });
    if (cursor) q.set("since_id", cursor);
    else q.set("transaction_date_from", `${vnDate(new Date(Date.now() - 2 * 86400_000))} 00:00:00`); // lần đầu: 2 ngày gần nhất
    let res = await fetch(`${cfg.apiBase}/transactions?${q}`, { headers: { authorization: `Bearer ${env.SEPAY_API_KEY}`, accept: "application/json" } });
    if (res.status === 429) { await sleep(pause * 3); res = await fetch(`${cfg.apiBase}/transactions?${q}`, { headers: { authorization: `Bearer ${env.SEPAY_API_KEY}`, accept: "application/json" } }); }
    if (!res.ok) throw new Error(`sepay_api_${res.status}`);
    const body = (await res.json()) as { data?: ApiRow[]; meta?: { pagination?: { has_more?: boolean } } };
    const rows = body.data ?? [];
    for (const r of rows) {
      out.fetched++;
      const tx = txFromApi(r);
      if (tx.type === "in" && tx.amount > 0) {
        const v = await ingestTransaction(env, tx, "reconcile", JSON.stringify(r));
        if (v.duplicate) out.duplicates++; else out.processed++;
      }
      last = r.id;
      // Lưu con trỏ sau MỖI dòng: lỗi giữa chừng không làm đọc lại từ đầu
      await db.prepare(`INSERT INTO sepay_state(key, value) VALUES ('api_cursor', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(last).run();
    }
    if (!rows.length || body.meta?.pagination?.has_more === false || rows.length < PER_PAGE) break;
    await sleep(pause);
  }
  return out;
}
