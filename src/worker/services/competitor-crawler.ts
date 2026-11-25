import type { Env } from "../env";
import { getSettingInt } from "./settings";
import { resolvePrice } from "./pricing";
import {
  median, parseCss, parseJsonLd, parsePack, parseRobots, robotsAllows, unitPriceOf, unitsCompatible,
  type CssConfig, type ParsedItem, type RobotsRules,
} from "./competitor-parse";

/**
 * Thu thập giá đối thủ (M7-02). Quy tắc cứng: chỉ trang công khai, tôn trọng robots.txt (cache 24h),
 * giãn cách min_delay_ms, tối đa max_pages, User-Agent theo setting, KHÔNG đăng nhập / vượt captcha.
 *
 * Cache robots: kết quả boolean ở competitor_sources.robots_allowed; thời điểm kiểm ở settings
 * key `competitor.robots_at.<sourceId>` (ISO) vì bảng nguồn không có cột riêng.
 */
export type SourceStatus = "ok" | "blocked" | "layout_changed" | "error" | "robots_disallow";
export interface CrawlResult {
  runId: number;
  status: "ok" | "partial" | "failed" | "skipped";
  sourceStatus: SourceStatus;
  pages: number;
  items: number;
  error?: string;
}

const ROBOTS_TTL_MS = 24 * 3600_000;
const MAX_BODY = 3_000_000;
const CAPTCHA_RE = /captcha|cf-challenge|g-recaptcha|h-captcha|hcaptcha|verify you are (a )?human|attention required|access denied/i;
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

class Blocked extends Error {}

const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal", "kubernetes.default.svc"]);

function ipv4Private(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // 0/8, 10/8, loopback, multicast/reserved
    (a === 169 && b === 254) || // link-local + metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** SSRF / đường nội bộ: chỉ http(s) tới tên miền công khai, cổng 80/443 (hoặc mặc định). Mọi IP literal đều bị từ chối. */
export function isPublicHttpUrl(u: string): boolean {
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return false;
    if (p.username || p.password) return false;
    if (p.port && p.port !== "80" && p.port !== "443") return false;
    const h = p.hostname.toLowerCase().replace(/\.+$/, ""); // bỏ dấu chấm cuối: "localhost." == "localhost"
    if (!h || BLOCKED_HOSTS.has(h)) return false;
    if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa") || !h.includes(".")) return false;
    if (h.includes(":") || h.startsWith("[")) return false; // IPv6 literal (::1, fc00::/7, fe80::/10, ::ffff:...)
    if (/^[\d.]+$/.test(h) || /^0x[0-9a-f.]+$/i.test(h)) return false; // IPv4 (kể cả dạng rút gọn/thập lục) — kiểm thêm bên dưới
    if (ipv4Private(h)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Đọc body theo luồng, dừng ở maxBytes (không nạp cả phản hồi khổng lồ vào bộ nhớ). */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        total += room;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch { /* đã đóng */ }
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    all.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

// ---------------------------------------------------------------- dùng chung với route
export async function insertAlert(
  db: D1Database,
  a: { kind: "competitor_cheaper" | "big_change" | "source_failed" | "outlier"; message: string; productId?: number | null; competitorProductId?: number | null; sourceId?: number | null },
) {
  if (a.kind === "source_failed" || a.kind === "competitor_cheaper") {
    const col = a.kind === "source_failed" ? "source_id" : "competitor_product_id";
    const id = a.kind === "source_failed" ? a.sourceId : a.competitorProductId;
    const dup = await db.prepare(`SELECT id FROM price_alerts WHERE kind = ? AND ${col} = ? AND acked_at IS NULL LIMIT 1`).bind(a.kind, id ?? null).first();
    if (dup) return;
  }
  await db
    .prepare(`INSERT INTO price_alerts(product_id, competitor_product_id, source_id, kind, message) VALUES (?,?,?,?,?)`)
    .bind(a.productId ?? null, a.competitorProductId ?? null, a.sourceId ?? null, a.kind, a.message)
    .run();
}

/** Giá tham chiếu (EC-36): đơn giá các quan sát đã duyệt gần đây của nhóm SP đối thủ cùng ghép một SP cửa hàng (hoặc chính nó). */
export async function referencePrices(db: D1Database, cpId: number, useUnit: boolean, excludeObsId = 0, now = new Date()): Promise<number[]> {
  const col = useUnit ? "o.unit_price" : "o.price";
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT ${col} AS v FROM competitor_price_obs o
        WHERE o.status IN ('ok','approved_outlier') AND o.observed_at >= ?1 AND o.id <> ?3 AND ${col} IS NOT NULL
          AND (o.competitor_product_id = ?2 OR o.competitor_product_id IN (
                 SELECT m2.competitor_product_id FROM product_matches m1 JOIN product_matches m2 ON m2.product_id = m1.product_id AND m2.status = 'approved'
                  WHERE m1.competitor_product_id = ?2 AND m1.status = 'approved'))
        ORDER BY o.observed_at DESC LIMIT 20`,
    )
    .bind(since, cpId, excludeObsId)
    .all<{ v: number }>();
  return results.map((r) => r.v);
}

export const deviationBp = (v: number, med: number) => Math.round((Math.abs(v - med) * 10000) / med);

// ---------------------------------------------------------------- robots
async function checkRobots(env: Env, src: any, ua: string, throttle: () => Promise<void>, now: Date): Promise<{ allowed: boolean; delayMs: number; fresh: boolean }> {
  const db = env.DB;
  const at = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(`competitor.robots_at.${src.id}`).first<{ value: string }>();
  if (src.robots_allowed != null && at && now.getTime() - Date.parse(at.value) < ROBOTS_TTL_MS) {
    return { allowed: !!src.robots_allowed, delayMs: 0, fresh: false };
  }
  const origin = new URL(src.url).origin;
  await throttle();
  let res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": ua, accept: "text/plain,*/*;q=0.5" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  // chuyển hướng robots.txt: chỉ theo (tối đa 3 bước) khi vẫn cùng origin và là URL công khai
  for (let hop = 0; res.status >= 300 && res.status < 400 && hop < 3; hop++) {
    const loc = res.headers.get("location");
    const next = loc ? new URL(loc, `${origin}/robots.txt`).toString() : null;
    if (!next || !isPublicHttpUrl(next) || new URL(next).origin !== origin) throw new Error("robots.txt chuyển hướng ra ngoài nguồn, bỏ qua");
    res = await fetch(next, { headers: { "user-agent": ua, accept: "text/plain,*/*;q=0.5" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  }
  let allowed = true;
  let delayMs = 0;
  if (res.status >= 500 || res.status === 429) throw new Error(`robots.txt lỗi ${res.status}`); // không đoán: thử lại lần sau
  if (res.status === 401 || res.status === 403) allowed = false;
  else if (res.status === 200) {
    const text = await readBodyCapped(res, 500_000);
    const rules: RobotsRules = parseRobots(text, ua);
    const u = new URL(src.url);
    allowed = robotsAllows(rules, u.pathname + u.search);
    delayMs = Math.min((rules.crawlDelaySec ?? 0) * 1000, 10_000);
  }
  await db.batch([
    db.prepare(`UPDATE competitor_sources SET robots_allowed = ? WHERE id = ?`).bind(allowed ? 1 : 0, src.id),
    db.prepare(`INSERT INTO settings(key, value, note) VALUES (?,?, 'Thời điểm kiểm robots.txt gần nhất (cache 24h)') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(`competitor.robots_at.${src.id}`, now.toISOString()),
  ]);
  return { allowed, delayMs, fresh: true };
}

// ---------------------------------------------------------------- một trang
async function fetchPage(url: string, ua: string, throttle: () => Promise<void>): Promise<string> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    await throttle();
    const res = await fetch(cur, { headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml,application/json;q=0.8", "accept-language": "vi,en;q=0.5" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      const next = loc ? new URL(loc, cur).toString() : null;
      if (!next || !isPublicHttpUrl(next) || new URL(next).origin !== new URL(url).origin) throw new Error("chuyển hướng ra ngoài nguồn, bỏ qua");
      cur = next;
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new Blocked(`HTTP ${res.status}`);
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const body = await readBodyCapped(res, MAX_BODY);
    if (CAPTCHA_RE.test(body.slice(0, 20000)) && !/application\/ld\+json/i.test(body)) throw new Blocked("trang yêu cầu captcha/xác minh");
    return body;
  }
  throw new Error("quá nhiều chuyển hướng");
}

function pageUrl(base: string, n: number, cfg: Partial<CssConfig>) {
  if (n === 1) return base;
  const u = new URL(base);
  u.searchParams.set(cfg.pageParam ?? "page", String(n));
  return u.toString();
}

const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Lưu các quan sát một trang. Trả về số mục đã ghi. */
async function savePage(env: Env, src: any, items: ParsedItem[], now: Date, band: number, changeBp: number): Promise<number> {
  const db = env.DB;
  const nowIso = now.toISOString();
  const capped = items.slice(0, 200);
  await db.batch(
    capped.map((it) => {
      const pk = parsePack(it.packText) ?? parsePack(it.name);
      return db
        .prepare(
          `INSERT INTO competitor_products(source_id, external_id, url, name, pack_text, pack_qty_milli, pack_unit, last_seen_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(source_id, external_id) DO UPDATE SET url = excluded.url, name = excluded.name, last_seen_at = excluded.last_seen_at,
             pack_text = COALESCE(competitor_products.pack_text, excluded.pack_text),
             pack_qty_milli = COALESCE(competitor_products.pack_qty_milli, excluded.pack_qty_milli),
             pack_unit = COALESCE(competitor_products.pack_unit, excluded.pack_unit)`,
        )
        .bind(src.id, it.externalId, it.url, it.name, it.packText ?? (pk ? it.name : null), pk?.qtyMilli ?? null, pk?.unit ?? null, nowIso);
    }),
  );
  const rows = new Map<string, any>();
  for (const part of chunk(capped.map((i) => i.externalId), 80)) {
    const { results } = await db
      .prepare(`SELECT id, external_id, pack_qty_milli, pack_unit, last_price FROM competitor_products WHERE source_id = ? AND external_id IN (${part.map(() => "?").join(",")})`)
      .bind(src.id, ...part)
      .all<any>();
    for (const r of results) rows.set(r.external_id, r);
  }
  const stmts: D1PreparedStatement[] = [];
  const alerts: Parameters<typeof insertAlert>[1][] = [];
  for (const it of capped) {
    const cp = rows.get(it.externalId);
    if (!cp) continue;
    const unit = unitPriceOf(it.price, cp.pack_qty_milli);
    const refs = await referencePrices(db, cp.id, unit != null, 0, now);
    const basis = unit ?? it.price;
    const match = await db.prepare(`SELECT m.product_id FROM product_matches m WHERE m.competitor_product_id = ? AND m.status = 'approved' LIMIT 1`).bind(cp.id).first<{ product_id: number }>();
    let med = refs.length >= 3 ? median(refs) : null;
    let refLabel = "trung vị";
    // B-15: quan sát đầu tiên / ít dữ liệu (<3 giá tham chiếu) → so với GIÁ BÁN CỦA TA của mặt hàng đã ghép (cùng đơn vị), cùng ngưỡng lệch
    if (med == null && match && unit != null) {
      const p = await db.prepare(`SELECT base_unit FROM products WHERE id = ?`).bind(match.product_id).first<{ base_unit: string }>();
      if (p && unitsCompatible(p.base_unit, cp.pack_unit)) {
        const ours = await resolvePrice(db, match.product_id, { channel: "pos" }).then((r) => r.unitPrice, () => null);
        if (ours != null && ours > 0) { med = ours; refLabel = "giá bán của cửa hàng"; }
      }
    }
    const isOutlier = med != null && med > 0 && deviationBp(basis, med) > band;
    stmts.push(
      db
        .prepare(`INSERT INTO competitor_price_obs(competitor_product_id, observed_at, price, unit_price, in_stock, promo_text, source, status) VALUES (?,?,?,?,?,?, 'crawl', ?)`)
        .bind(cp.id, nowIso, it.price, unit, it.inStock == null ? null : it.inStock ? 1 : 0, it.promoText, isOutlier ? "outlier" : "ok"),
    );
    if (isOutlier) {
      alerts.push({ kind: "outlier", productId: match?.product_id, competitorProductId: cp.id, sourceId: src.id, message: `Giá "${it.name}" ${it.price}đ lệch ${Math.round(deviationBp(basis, med!) / 100)}% so với ${refLabel} ${med} — chờ duyệt (EC-36)` });
      stmts.push(db.prepare(`UPDATE competitor_products SET last_in_stock = ? WHERE id = ?`).bind(it.inStock == null ? null : it.inStock ? 1 : 0, cp.id));
      continue;
    }
    stmts.push(db.prepare(`UPDATE competitor_products SET last_price = ?, last_in_stock = ? WHERE id = ?`).bind(it.price, it.inStock == null ? null : it.inStock ? 1 : 0, cp.id));
    if (cp.last_price && cp.last_price !== it.price && deviationBp(it.price, cp.last_price) >= changeBp) {
      alerts.push({ kind: "big_change", productId: match?.product_id, competitorProductId: cp.id, sourceId: src.id, message: `"${it.name}" đổi giá ${cp.last_price}đ → ${it.price}đ` });
    }
    if (match && unit != null) {
      const p = await db.prepare(`SELECT name, base_unit FROM products WHERE id = ?`).bind(match.product_id).first<{ name: string; base_unit: string }>();
      if (p && unitsCompatible(p.base_unit, cp.pack_unit)) {
        const ours = await resolvePrice(db, match.product_id, { channel: "pos" }).then((r) => r.unitPrice, () => null);
        if (ours != null && unit < ours) {
          alerts.push({ kind: "competitor_cheaper", productId: match.product_id, competitorProductId: cp.id, sourceId: src.id, message: `Đối thủ bán "${p.name}" ${unit}đ/${cp.pack_unit}, rẻ hơn giá ta ${ours}đ` });
        }
      }
    }
  }
  for (const part of chunk(stmts, 90)) await db.batch(part);
  for (const a of alerts) await insertAlert(db, a);
  return capped.length;
}

// ---------------------------------------------------------------- chạy một nguồn
export async function crawlSource(env: Env, sourceId: number, opts: { now?: Date; maxPages?: number } = {}): Promise<CrawlResult> {
  const db = env.DB;
  const now = opts.now ?? new Date();
  const src = await db.prepare(`SELECT s.*, c.active AS c_active FROM competitor_sources s JOIN competitors c ON c.id = s.competitor_id WHERE s.id = ?`).bind(sourceId).first<any>();
  if (!src) throw new Error("source_not_found");
  const run = await db.prepare(`INSERT INTO crawl_runs(source_id, started_at) VALUES (?,?) RETURNING id`).bind(sourceId, now.toISOString()).first<{ id: number }>();
  const runId = run!.id;
  let pages = 0, items = 0, itemsTotalBefore = 0;
  let status: CrawlResult["status"] = "ok";
  let srcStatus: SourceStatus = "ok";
  let error: string | undefined;

  const finish = async (): Promise<CrawlResult> => {
    const failed = srcStatus !== "ok";
    const countsAsFailure = srcStatus !== "robots_disallow" && failed;
    await db.batch([
      db.prepare(`UPDATE crawl_runs SET finished_at = ?, status = ?, pages = ?, items = ?, error = ? WHERE id = ?`).bind(new Date().toISOString(), status, pages, items, error ?? null, runId),
      db
        .prepare(`UPDATE competitor_sources SET last_run_at = ?, last_status = ?, consecutive_failures = ${countsAsFailure ? "consecutive_failures + 1" : failed ? "consecutive_failures" : "0"} WHERE id = ?`)
        .bind(now.toISOString(), srcStatus, sourceId),
    ]);
    if (failed) {
      const cf = await db.prepare(`SELECT consecutive_failures AS n FROM competitor_sources WHERE id = ?`).bind(sourceId).first<{ n: number }>();
      if (srcStatus !== "error" || (cf?.n ?? 0) >= 3) {
        await insertAlert(db, { kind: "source_failed", sourceId, message: `Nguồn #${sourceId} (${src.url}) lỗi: ${srcStatus}${error ? " — " + error : ""}. Dữ liệu cũ được giữ nguyên.` });
      }
    }
    return { runId, status, sourceStatus: srcStatus, pages, items, error };
  };

  try {
    if (src.kind === "manual" || src.parser === "manual" || !src.url) {
      status = "skipped";
      srcStatus = "error";
      error = "Nguồn nhập tay, không thu thập tự động";
      await db.batch([db.prepare(`UPDATE crawl_runs SET finished_at = ?, status = 'skipped', error = ? WHERE id = ?`).bind(now.toISOString(), error, runId)]);
      return { runId, status, sourceStatus: srcStatus, pages, items, error };
    }
    if (!isPublicHttpUrl(src.url)) {
      status = "failed";
      srcStatus = "error";
      error = "URL nguồn không hợp lệ (chỉ http/https công khai)";
      return await finish();
    }
    const ua = (await db.prepare(`SELECT value FROM settings WHERE key = 'competitor.user_agent'`).first<{ value: string }>())?.value ?? "HuuManhPriceBot/1.0";
    const band = await getSettingInt(db, "competitor.outlier_band_bp", 5000);
    const changeBp = await getSettingInt(db, "competitor.alert_change_bp", 1000);
    let delay = Math.max(0, src.min_delay_ms ?? 3000);
    let lastReq = 0;
    const throttle = async () => {
      if (lastReq) await sleep(Math.max(0, lastReq + delay - Date.now()));
      lastReq = Date.now();
    };
    const cfg: Partial<CssConfig> = src.parser_config_json ? JSON.parse(src.parser_config_json) : {};
    itemsTotalBefore = (await db.prepare(`SELECT COUNT(*) n FROM competitor_products WHERE source_id = ?`).bind(sourceId).first<{ n: number }>())!.n;

    // 1) robots.txt
    const rb = await checkRobots(env, src, ua, throttle, now);
    delay = Math.max(delay, rb.delayMs);
    if (!rb.allowed) {
      status = "skipped";
      srcStatus = "robots_disallow";
      error = "robots.txt không cho phép thu thập trang này";
      return await finish();
    }

    // 2) các trang
    const maxPages = Math.max(1, Math.min(opts.maxPages ?? src.max_pages ?? 20, src.max_pages ?? 20));
    const seen = new Set<string>();
    for (let n = 1; n <= maxPages; n++) {
      if (n > 1 && !cfg.pageParam) break; // không cấu hình phân trang: chỉ 1 trang
      const url = pageUrl(src.url, n, cfg);
      let html: string;
      try {
        html = await fetchPage(url, ua, throttle);
      } catch (e) {
        if (e instanceof Blocked) {
          srcStatus = "blocked";
          error = e.message;
        } else {
          srcStatus = "error";
          error = String((e as Error).message ?? e).slice(0, 200);
        }
        status = items > 0 ? "partial" : "failed";
        return await finish();
      }
      pages++;
      let parsed: ParsedItem[];
      if (src.parser === "css") {
        if (!cfg.itemSelector || !cfg.nameSelector || !cfg.priceSelector) throw new Error("Thiếu cấu hình selector (itemSelector, nameSelector, priceSelector)");
        parsed = await parseCss(html, url, cfg as CssConfig);
      } else parsed = parseJsonLd(html, url);
      parsed = parsed.filter((p) => !seen.has(p.externalId));
      parsed.forEach((p) => seen.add(p.externalId));
      if (!parsed.length) {
        if (n === 1) {
          status = "failed";
          if (itemsTotalBefore > 0) {
            srcStatus = "layout_changed";
            error = "Không đọc được sản phẩm nào trên trang đã từng có sản phẩm (nghi đổi giao diện) — giữ dữ liệu cũ";
          } else {
            srcStatus = "error";
            error = "Không đọc được sản phẩm nào trên trang";
          }
          return await finish();
        }
        break; // hết trang
      }
      items += await savePage(env, src, parsed, now, band, changeBp);
    }
    return await finish();
  } catch (e) {
    status = "failed";
    srcStatus = "error";
    error = String((e as Error)?.message ?? e).slice(0, 200);
    try {
      return await finish();
    } catch {
      return { runId, status, sourceStatus: srcStatus, pages, items, error };
    }
  }
}
