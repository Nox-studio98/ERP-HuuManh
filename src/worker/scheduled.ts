import type { Env } from "./env";
import { vnDay } from "./lib/time";

/**
 * Cron Triggers (wrangler.jsonc → triggers.crons):
 *  - "0 17 * * *"  (00:00 giờ VN): đánh dấu lô hết hạn, sao lưu logic ra R2.
 *  - "*\/30 * * * *": dọn phiên hết hạn.
 * D1 Time Travel đã cho khôi phục điểm thời gian 30 ngày; bản xuất R2 là lớp sao lưu thứ hai (yêu cầu chung mục 12).
 */
export async function runScheduled(event: ScheduledController, env: Env) {
  const now = new Date().toISOString();
  if (event.cron === "*/30 * * * *") {
    await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL`).bind(now).run();
    return;
  }
  // Hằng ngày
  await env.DB.prepare(
    `UPDATE lots SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`,
  )
    .bind(now)
    .run();
  await backupToR2(env);
}

const BACKUP_TABLES = [
  "stores", "locations", "users", "product_groups", "products", "product_units", "suppliers", "lots",
  "stock_docs", "stock_doc_lines", "stock_moves", "customer_groups", "price_lists", "prices", "customers",
  "shifts", "orders", "order_lines", "order_line_lots", "payments", "funds", "cash_categories", "cash_vouchers",
  "periods", "approvals", "settings", "audit_log",
];

async function backupToR2(env: Env) {
  const day = vnDay();
  for (const t of BACKUP_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    // users: bỏ pass_hash khỏi bản sao lưu
    const rows = t === "users" ? results.map(({ pass_hash: _p, ...r }) => r) : results;
    await env.FILES.put(`backups/${day}/${t}.ndjson`, rows.map((r) => JSON.stringify(r)).join("\n"), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  }
}
