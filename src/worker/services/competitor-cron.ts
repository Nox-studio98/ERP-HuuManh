import type { Env } from "../env";
import { crawlSource } from "./competitor-crawler";

const MAX_SOURCES_PER_RUN = 2;

/**
 * M7-02/07 chạy thu thập giá các nguồn đến hạn (tối đa 2 nguồn mỗi lần, cron "*\/30"). Không bao giờ throw.
 * Đến hạn: chưa chạy bao giờ, hoặc last_run_at + frequency × hệ số lùi (2^lỗi liên tiếp, tối đa 8).
 */
export async function runDueCompetitorCrawls(env: Env, now = new Date()): Promise<void> {
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT s.id, s.last_run_at, s.frequency_minutes, s.consecutive_failures
           FROM competitor_sources s JOIN competitors c ON c.id = s.competitor_id
          WHERE s.active = 1 AND c.active = 1 AND s.kind <> 'manual' AND s.parser <> 'manual' AND s.url IS NOT NULL
          ORDER BY s.last_run_at IS NOT NULL, s.last_run_at, s.id LIMIT 50`,
      )
      .all<{ id: number; last_run_at: string | null; frequency_minutes: number; consecutive_failures: number }>();
    const due = results.filter((s) => {
      if (!s.last_run_at) return true;
      const backoff = Math.min(2 ** Math.min(s.consecutive_failures, 3), 8);
      return Date.parse(s.last_run_at) + s.frequency_minutes * backoff * 60_000 <= now.getTime();
    });
    for (const s of due.slice(0, MAX_SOURCES_PER_RUN)) {
      try {
        await crawlSource(env, s.id, { now });
      } catch (e) {
        console.error(JSON.stringify({ level: "error", msg: "competitor_crawl", sourceId: s.id, err: String((e as Error)?.message).slice(0, 200) }));
        try {
          await env.DB
            .prepare(`INSERT INTO crawl_runs(source_id, started_at, finished_at, status, error) VALUES (?,?,?, 'failed', ?)`)
            .bind(s.id, now.toISOString(), new Date().toISOString(), String((e as Error)?.message).slice(0, 200))
            .run();
        } catch {
          /* bỏ qua */
        }
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "competitor_cron", err: String((e as Error)?.message).slice(0, 200) }));
  }
}
