import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { auditStmt } from "../lib/audit";
import { AppError, conflict, notFound } from "../lib/errors";
import { getSettingInt } from "../services/settings";
import { guarded, pageParams, parseBody } from "../services/http";
import { currentAvgCost, resolvePrice } from "../services/pricing";
import { applyBulkPrices } from "./prices";
import { crawlSource, deviationBp, isPublicHttpUrl, referencePrices } from "../services/competitor-crawler";
import { suggestMatches } from "../services/competitor-matcher";
import { unitPriceOf, unitsCompatible } from "../services/competitor-parse";
import { normalizeVi } from "../services/online-orders";

export const competitorRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;
const view = requirePerm("competitors.view");
const write = requirePerm("competitors.write");
const id = (c: Ctx, p = "id") => {
  const n = Number(c.req.param(p));
  if (!Number.isInteger(n) || n <= 0) throw new AppError(422, "validation_error", "Mã không hợp lệ");
  return n;
};
const vErr = (m: string) => new AppError(422, "validation_error", m);

/** Chuẩn hoá thời điểm quan sát: ISO hoặc YYYY-MM-DD (giờ VN). */
function obsTime(s?: string | null): string {
  if (!s) return new Date().toISOString();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00+07:00` : s);
  if (Number.isNaN(t)) throw vErr("observedAt không hợp lệ");
  return new Date(t).toISOString();
}

// ================================================================= Đối thủ & nguồn (M7-01)
competitorRoutes.get("/competitors", view, async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT c.id, c.name, c.website, c.note, c.active, (SELECT COUNT(*) FROM competitor_sources s WHERE s.competitor_id = c.id) AS sourceCount
         FROM competitors c ORDER BY c.name`,
    )
    .all<any>();
  return c.json({ items: results.map((r) => ({ ...r, active: !!r.active })), nextCursor: null });
});

const compBody = z.object({
  name: z.string().trim().min(1).max(100),
  website: z.string().trim().max(300).nullish(),
  note: z.string().trim().max(500).nullish(),
  active: z.boolean().optional(),
});

competitorRoutes.post("/competitors", write, async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, compBody);
  const [res] = await guarded(
    () => db.batch([db.prepare(`INSERT INTO competitors(name, website, note, active) VALUES (?,?,?,?)`).bind(b.name, b.website ?? null, b.note ?? null, b.active === false ? 0 : 1), auditStmt(c, { action: "competitor.create", entity: "competitor", entityId: b.name, after: b })]),
    "Tên đối thủ đã tồn tại",
  );
  const row = await db.prepare(`SELECT id, name, website, note, active FROM competitors WHERE id = ?`).bind(res.meta.last_row_id).first<any>();
  return c.json({ ...row, active: !!row.active, sourceCount: 0 }, 201);
});

competitorRoutes.put("/competitors/:id", write, async (c) => {
  const db = c.env.DB;
  const cid = id(c);
  const cur = await db.prepare(`SELECT * FROM competitors WHERE id = ?`).bind(cid).first<any>();
  if (!cur) throw notFound();
  const b = await parseBody(c, compBody.partial());
  const n = { name: b.name ?? cur.name, website: b.website === undefined ? cur.website : b.website, note: b.note === undefined ? cur.note : b.note, active: b.active === undefined ? cur.active : b.active ? 1 : 0 };
  await guarded(
    () => db.batch([db.prepare(`UPDATE competitors SET name=?, website=?, note=?, active=? WHERE id=?`).bind(n.name, n.website, n.note, n.active, cid), auditStmt(c, { action: "competitor.update", entity: "competitor", entityId: cid, before: cur, after: n })]),
    "Tên đối thủ đã tồn tại",
  );
  return c.json({ id: cid, ...n, active: !!n.active });
});

const sourceShape = (s: any) => ({
  id: s.id, competitorId: s.competitor_id, kind: s.kind, url: s.url, parser: s.parser,
  parserConfig: s.parser_config_json ? safeJson(s.parser_config_json) : null,
  frequencyMinutes: s.frequency_minutes, minDelayMs: s.min_delay_ms, maxPages: s.max_pages,
  robotsAllowed: s.robots_allowed == null ? null : !!s.robots_allowed,
  lastRunAt: s.last_run_at, lastStatus: s.last_status, consecutiveFailures: s.consecutive_failures, active: !!s.active,
});
const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

const cssCfg = z.object({
  itemSelector: z.string().trim().min(1).max(200),
  nameSelector: z.string().trim().min(1).max(200),
  priceSelector: z.string().trim().min(1).max(200),
  linkSelector: z.string().trim().max(200).optional(),
  packSelector: z.string().trim().max(200).optional(),
  promoSelector: z.string().trim().max(200).optional(),
  soldOutSelector: z.string().trim().max(200).optional(),
  pageParam: z.string().trim().max(30).regex(/^[\w-]+$/).optional(),
});
const sourceBody = z.object({
  kind: z.enum(["website", "marketplace", "manual"]),
  url: z.string().trim().max(500).nullish(),
  parser: z.enum(["jsonld", "css", "manual"]).default("jsonld"),
  parserConfig: z.record(z.string(), z.unknown()).nullish(),
  frequencyMinutes: z.number().int().min(30).max(10080).default(720),
  minDelayMs: z.number().int().min(500).max(60000).default(3000),
  maxPages: z.number().int().min(1).max(50).default(20),
  active: z.boolean().default(true),
});

function checkSource(b: z.infer<typeof sourceBody>) {
  if (b.kind === "manual") {
    return { ...b, parser: "manual" as const, url: null, parserConfig: null };
  }
  if (!b.url || !isPublicHttpUrl(b.url)) throw vErr("url phải là địa chỉ http(s) công khai");
  if (b.parser === "manual") throw vErr("Nguồn website/marketplace cần parser jsonld hoặc css");
  let cfg: unknown = null;
  if (b.parser === "css") {
    const r = cssCfg.safeParse(b.parserConfig);
    if (!r.success) throw new AppError(422, "validation_error", "parserConfig css thiếu itemSelector/nameSelector/priceSelector", r.error.issues);
    cfg = r.data;
  }
  return { ...b, parserConfig: cfg as Record<string, unknown> | null };
}

competitorRoutes.get("/competitors/:id/sources", view, async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM competitor_sources WHERE competitor_id = ? ORDER BY id`).bind(id(c)).all<any>();
  return c.json({ items: results.map(sourceShape), nextCursor: null });
});

competitorRoutes.post("/competitors/:id/sources", write, async (c) => {
  const db = c.env.DB;
  const cid = id(c);
  if (!(await db.prepare(`SELECT id FROM competitors WHERE id = ?`).bind(cid).first())) throw notFound();
  const b = checkSource(await parseBody(c, sourceBody));
  const [res] = await db.batch([
    db
      .prepare(`INSERT INTO competitor_sources(competitor_id, kind, url, parser, parser_config_json, frequency_minutes, min_delay_ms, max_pages, active) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(cid, b.kind, b.url, b.parser, b.parserConfig ? JSON.stringify(b.parserConfig) : null, b.frequencyMinutes, b.minDelayMs, b.maxPages, b.active ? 1 : 0),
    auditStmt(c, { action: "competitor_source.create", entity: "competitor", entityId: cid, after: b }),
  ]);
  return c.json(sourceShape(await db.prepare(`SELECT * FROM competitor_sources WHERE id = ?`).bind(res.meta.last_row_id).first<any>()), 201);
});

async function updateSource(c: Ctx, sid: number) {
  const db = c.env.DB;
  const cur = await db.prepare(`SELECT * FROM competitor_sources WHERE id = ?`).bind(sid).first<any>();
  if (!cur) throw notFound();
  const patch = await parseBody(c, sourceBody.partial());
  const merged = checkSource(
    sourceBody.parse({
      kind: patch.kind ?? cur.kind,
      url: patch.url === undefined ? cur.url : patch.url,
      parser: patch.parser ?? cur.parser,
      parserConfig: patch.parserConfig === undefined ? safeJson(cur.parser_config_json ?? "null") : patch.parserConfig,
      frequencyMinutes: patch.frequencyMinutes ?? cur.frequency_minutes,
      minDelayMs: patch.minDelayMs ?? cur.min_delay_ms,
      maxPages: patch.maxPages ?? cur.max_pages,
      active: patch.active ?? !!cur.active,
    }),
  );
  const urlChanged = merged.url !== cur.url;
  await db.batch([
    db
      .prepare(`UPDATE competitor_sources SET kind=?, url=?, parser=?, parser_config_json=?, frequency_minutes=?, min_delay_ms=?, max_pages=?, active=?${urlChanged ? ", robots_allowed=NULL" : ""} WHERE id=?`)
      .bind(merged.kind, merged.url, merged.parser, merged.parserConfig ? JSON.stringify(merged.parserConfig) : null, merged.frequencyMinutes, merged.minDelayMs, merged.maxPages, merged.active ? 1 : 0, sid),
    auditStmt(c, { action: "competitor_source.update", entity: "competitor_source", entityId: sid, before: sourceShape(cur), after: merged }),
  ]);
  return c.json(sourceShape(await db.prepare(`SELECT * FROM competitor_sources WHERE id = ?`).bind(sid).first<any>()));
}
competitorRoutes.put("/competitor-sources/:id", write, (c) => updateSource(c, id(c)));
competitorRoutes.put("/competitors/:id/sources/:sourceId", write, (c) => updateSource(c, id(c, "sourceId")));

competitorRoutes.post("/competitor-sources/:id/run", write, async (c) => {
  const db = c.env.DB;
  const sid = id(c);
  const src = await db.prepare(`SELECT id, kind, active FROM competitor_sources WHERE id = ?`).bind(sid).first<any>();
  if (!src) throw notFound();
  if (src.kind === "manual") throw new AppError(422, "manual_source", "Nguồn nhập tay không thu thập tự động");
  const running = await db
    .prepare(`SELECT id FROM crawl_runs WHERE source_id = ? AND status = 'running' AND started_at > ?`)
    .bind(sid, new Date(Date.now() - 10 * 60_000).toISOString())
    .first();
  if (running) throw conflict("crawl_running", "Nguồn đang được thu thập");
  const r = await crawlSource(c.env, sid, { maxPages: 5 }); // chạy tay: giới hạn 5 trang
  await db.batch([auditStmt(c, { action: "competitor_source.run", entity: "competitor_source", entityId: sid, after: r })]);
  return c.json(r);
});

competitorRoutes.get("/competitor-sources/:id/runs", view, async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id, source_id AS sourceId, started_at AS startedAt, finished_at AS finishedAt, status, pages, items, error FROM crawl_runs WHERE source_id = ? ORDER BY id DESC LIMIT 50`)
    .bind(id(c))
    .all();
  return c.json({ items: results, nextCursor: null });
});

// ================================================================= Sản phẩm đối thủ & quy cách (M7-04)
const cpSel = `SELECT cp.*, s.competitor_id, c.name AS competitor_name,
   (SELECT o.unit_price FROM competitor_price_obs o WHERE o.competitor_product_id = cp.id AND o.status IN ('ok','approved_outlier') ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) AS last_unit_price,
   (SELECT GROUP_CONCAT(m.product_id) FROM product_matches m WHERE m.competitor_product_id = cp.id AND m.status = 'approved') AS matched_ids
   FROM competitor_products cp JOIN competitor_sources s ON s.id = cp.source_id JOIN competitors c ON c.id = s.competitor_id`;
const cpShape = (r: any) => ({
  id: r.id, sourceId: r.source_id, competitorId: r.competitor_id, competitorName: r.competitor_name, externalId: r.external_id, url: r.url, name: r.name,
  packText: r.pack_text, packQtyMilli: r.pack_qty_milli, packUnit: r.pack_unit, packKnown: r.pack_qty_milli != null,
  lastPrice: r.last_price, lastUnitPrice: r.last_unit_price, lastInStock: r.last_in_stock == null ? null : !!r.last_in_stock, lastSeenAt: r.last_seen_at,
  matchedProductIds: r.matched_ids ? String(r.matched_ids).split(",").map(Number) : [],
});

competitorRoutes.get("/competitor-products", view, async (c) => {
  const { limit, cursor } = pageParams(c);
  const { sourceId, q, unmatched } = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (sourceId) (where.push("cp.source_id = ?"), binds.push(Number(sourceId)));
  if (q) (where.push("cp.name LIKE ?"), binds.push(`%${q.replace(/[%_]/g, "")}%`));
  if (unmatched === "1") where.push("NOT EXISTS (SELECT 1 FROM product_matches m WHERE m.competitor_product_id = cp.id AND m.status = 'approved')");
  if (cursor) (where.push("cp.id < ?"), binds.push(cursor));
  const { results } = await c.env.DB
    .prepare(`${cpSel} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY cp.id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<any>();
  return c.json({ items: results.slice(0, limit).map(cpShape), nextCursor: results.length > limit ? results[limit - 1].id : null });
});

const packBody = z.object({
  packQtyMilli: z.number().int().positive().max(100_000_000),
  packUnit: z.enum(["kg", "trai"]),
  packText: z.string().trim().max(100).nullish(),
});

competitorRoutes.put("/competitor-products/:id", write, async (c) => {
  const db = c.env.DB;
  const pid = id(c);
  const cur = await db.prepare(`SELECT * FROM competitor_products WHERE id = ?`).bind(pid).first<any>();
  if (!cur) throw notFound();
  const b = await parseBody(c, packBody);
  await db.batch([
    db.prepare(`UPDATE competitor_products SET pack_qty_milli = ?, pack_unit = ?, pack_text = COALESCE(?, pack_text) WHERE id = ?`).bind(b.packQtyMilli, b.packUnit, b.packText ?? null, pid),
    // tính lại đơn giá chuẩn hoá của mọi quan sát (quy cách trước đó sai/thiếu)
    db.prepare(`UPDATE competitor_price_obs SET unit_price = CAST(ROUND(price * 1000.0 / ?) AS INTEGER) WHERE competitor_product_id = ?`).bind(b.packQtyMilli, pid),
    auditStmt(c, { action: "competitor_product.pack", entity: "competitor_product", entityId: pid, before: { packQtyMilli: cur.pack_qty_milli, packUnit: cur.pack_unit }, after: b }),
  ]);
  return c.json(cpShape(await db.prepare(`${cpSel} WHERE cp.id = ?`).bind(pid).first<any>()));
});

// ================================================================= Nhập giá tay / CSV (M7-06)
async function manualSourceId(db: D1Database, competitorId: number): Promise<number> {
  const s = await db.prepare(`SELECT id FROM competitor_sources WHERE competitor_id = ? AND kind = 'manual' ORDER BY id LIMIT 1`).bind(competitorId).first<{ id: number }>();
  if (s) return s.id;
  const r = await db.prepare(`INSERT INTO competitor_sources(competitor_id, kind, parser) VALUES (?, 'manual', 'manual') RETURNING id`).bind(competitorId).first<{ id: number }>();
  return r!.id;
}

interface ManualObs {
  competitorId: number; name: string; packText?: string | null; packQtyMilli: number; packUnit: "kg" | "trai";
  price: number; inStock?: boolean | null; observedAt?: string | null; productId?: number | null; source: "manual" | "import";
}

async function recordManual(c: Ctx, m: ManualObs) {
  const db = c.env.DB;
  const comp = await db.prepare(`SELECT id FROM competitors WHERE id = ?`).bind(m.competitorId).first();
  if (!comp) throw new AppError(422, "invalid_competitor", "Đối thủ không tồn tại");
  if (m.productId && !(await db.prepare(`SELECT id FROM products WHERE id = ?`).bind(m.productId).first())) throw new AppError(422, "invalid_product", "Mặt hàng không tồn tại");
  const at = obsTime(m.observedAt);
  const sid = await manualSourceId(db, m.competitorId);
  const ext = `manual:${normalizeVi(m.name)}|${m.packQtyMilli}${m.packUnit}`;
  const flag = m.inStock == null ? null : m.inStock ? 1 : 0;
  const cp = await db
    .prepare(
      `INSERT INTO competitor_products(source_id, external_id, name, pack_text, pack_qty_milli, pack_unit, last_price, last_in_stock, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_id, external_id) DO UPDATE SET name = excluded.name,
         last_price = CASE WHEN competitor_products.last_seen_at IS NULL OR competitor_products.last_seen_at <= excluded.last_seen_at THEN excluded.last_price ELSE competitor_products.last_price END,
         last_in_stock = CASE WHEN competitor_products.last_seen_at IS NULL OR competitor_products.last_seen_at <= excluded.last_seen_at THEN excluded.last_in_stock ELSE competitor_products.last_in_stock END,
         last_seen_at = MAX(COALESCE(competitor_products.last_seen_at, ''), excluded.last_seen_at)
       RETURNING id`,
    )
    .bind(sid, ext, m.name, m.packText ?? null, m.packQtyMilli, m.packUnit, m.price, flag, at)
    .first<{ id: number }>();
  const stmts = [
    db
      .prepare(`INSERT INTO competitor_price_obs(competitor_product_id, observed_at, price, unit_price, in_stock, source, status, created_by) VALUES (?,?,?,?,?,?, 'ok', ?)`)
      .bind(cp!.id, at, m.price, unitPriceOf(m.price, m.packQtyMilli), flag, m.source, c.get("user").id),
    auditStmt(c, { action: `competitor_price.${m.source}`, entity: "competitor_product", entityId: cp!.id, after: { name: m.name, price: m.price, observedAt: at } }),
  ];
  if (m.productId) {
    stmts.push(
      db
        .prepare(`INSERT INTO product_matches(product_id, competitor_product_id, score, status, decided_by, decided_at) VALUES (?,?,100,'approved',?,?)
                  ON CONFLICT(product_id, competitor_product_id) DO UPDATE SET status='approved', decided_by=excluded.decided_by, decided_at=excluded.decided_at`)
        .bind(m.productId, cp!.id, c.get("user").id, new Date().toISOString()),
    );
  }
  const res = await db.batch(stmts);
  return { competitorProductId: cp!.id, obsId: res[0].meta.last_row_id as number, observedAt: at, unitPrice: unitPriceOf(m.price, m.packQtyMilli) };
}

competitorRoutes.post("/competitor-prices/manual", write, async (c) => {
  const b = await parseBody(
    c,
    z.object({
      competitorId: z.number().int().positive(),
      name: z.string().trim().min(1).max(200),
      packText: z.string().trim().max(100).nullish(),
      packQtyMilli: z.number().int().positive().max(100_000_000),
      packUnit: z.enum(["kg", "trai"]),
      price: z.number().int().positive().max(1_000_000_000),
      inStock: z.boolean().nullish(),
      observedAt: z.string().nullish(),
      productId: z.number().int().positive().nullish(),
    }),
  );
  return c.json(await recordManual(c, { ...b, source: "manual" }), 201);
});

/** CSV có hỗ trợ ngoặc kép. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"', i++);
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === "," || ch === ";") (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

competitorRoutes.post("/competitor-prices/import", write, async (c) => {
  const db = c.env.DB;
  let text: string;
  if ((c.req.header("content-type") ?? "").includes("json")) text = z.object({ csv: z.string().min(1) }).parse(await c.req.json().catch(() => ({}))).csv;
  else text = await c.req.text();
  if (text.length > 1_000_000) throw vErr("File CSV quá lớn");
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length && rows[0][0].trim().toLowerCase() === "competitor") rows.shift();
  if (!rows.length) throw vErr("CSV rỗng");
  if (rows.length > 500) throw vErr("Tối đa 500 dòng mỗi lần nhập");
  const comps = new Map((await db.prepare(`SELECT id, name FROM competitors`).all<{ id: number; name: string }>()).results.map((r) => [normalizeVi(r.name), r.id]));
  const errors: { line: number; message: string }[] = [];
  let imported = 0;
  for (let i = 0; i < rows.length; i++) {
    const [comp, name, qtyS, unitS, priceS, stockS, atS, sku] = rows[i].map((x) => x.trim());
    const line = i + 1;
    try {
      const cid = comps.get(normalizeVi(comp ?? ""));
      if (!cid) throw new Error(`Không có đối thủ "${comp}"`);
      if (!name) throw new Error("Thiếu tên");
      const qty = Number((qtyS ?? "").replace(",", "."));
      const u = normalizeVi(unitS ?? "");
      if (!(qty > 0)) throw new Error("pack_qty không hợp lệ");
      let packUnit: "kg" | "trai", milli: number;
      if (u === "kg") (packUnit = "kg", (milli = Math.round(qty * 1000)));
      else if (u === "g") (packUnit = "kg", (milli = Math.round(qty)));
      else if (u === "trai" || u === "qua") (packUnit = "trai", (milli = Math.round(qty * 1000)));
      else throw new Error("pack_unit phải là kg, g hoặc trai");
      const price = Math.round(Number((priceS ?? "").replace(/[.,\s]/g, "")));
      if (!(price > 0)) throw new Error("price không hợp lệ");
      let productId: number | null = null;
      if (sku) {
        const p = await db.prepare(`SELECT id FROM products WHERE sku = ?`).bind(sku).first<{ id: number }>();
        if (!p) throw new Error(`Không có SKU ${sku}`);
        productId = p.id;
      }
      const st = normalizeVi(stockS ?? "");
      const inStock = ["1", "true", "yes", "co", "con"].includes(st) ? true : ["0", "false", "no", "khong", "het"].includes(st) ? false : null;
      await recordManual(c, { competitorId: cid, name, packQtyMilli: milli, packUnit, packText: `${qtyS} ${unitS}`, price, inStock, observedAt: atS || null, productId, source: "import" });
      imported++;
    } catch (e) {
      errors.push({ line, message: String((e as Error).message ?? e) });
    }
  }
  return c.json({ imported, errors }, errors.length && !imported ? 422 : 201);
});

// ================================================================= Ghép sản phẩm (M7-03, EC-37)
const matchSel = `SELECT m.id, m.product_id, p.name AS product_name, m.competitor_product_id, c.name AS competitor_name, cp.name AS cp_name, cp.pack_text, m.score, m.status
  FROM product_matches m JOIN products p ON p.id = m.product_id JOIN competitor_products cp ON cp.id = m.competitor_product_id
  JOIN competitor_sources s ON s.id = cp.source_id JOIN competitors c ON c.id = s.competitor_id`;
const matchShape = (r: any) => ({
  id: r.id, productId: r.product_id, productName: r.product_name, competitorProductId: r.competitor_product_id,
  competitorName: r.competitor_name, competitorProductName: r.cp_name, packText: r.pack_text, score: r.score, status: r.status,
});

competitorRoutes.get("/product-matches", view, async (c) => {
  const { limit, cursor } = pageParams(c);
  const status = c.req.query("status") ?? "suggested";
  if (!["suggested", "approved", "rejected"].includes(status)) throw vErr("status không hợp lệ");
  const where = ["m.status = ?"];
  const binds: unknown[] = [status];
  const productId = Number(c.req.query("productId"));
  if (productId) (where.push("m.product_id = ?"), binds.push(productId));
  if (cursor) (where.push("m.id < ?"), binds.push(cursor));
  const { results } = await c.env.DB.prepare(`${matchSel} WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`).bind(...binds, limit + 1).all<any>();
  return c.json({ items: results.slice(0, limit).map(matchShape), nextCursor: results.length > limit ? results[limit - 1].id : null });
});

competitorRoutes.post("/product-matches/suggest", write, async (c) => {
  const b = z.object({ productId: z.number().int().positive().optional() }).parse(await c.req.json().catch(() => ({})));
  const created = await suggestMatches(c.env.DB, b.productId);
  await c.env.DB.batch([auditStmt(c, { action: "product_match.suggest", entity: "product_match", after: { created, productId: b.productId ?? null } })]);
  return c.json({ created });
});

competitorRoutes.post("/product-matches/:id/decide", write, async (c) => {
  const db = c.env.DB;
  const mid = id(c);
  const { decision } = await parseBody(c, z.object({ decision: z.enum(["approved", "rejected"]) }));
  const cur = await db.prepare(`SELECT * FROM product_matches WHERE id = ?`).bind(mid).first<any>();
  if (!cur) throw notFound();
  await db.batch([
    db.prepare(`UPDATE product_matches SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`).bind(decision, c.get("user").id, new Date().toISOString(), mid),
    auditStmt(c, { action: "product_match.decide", entity: "product_match", entityId: mid, before: { status: cur.status }, after: { status: decision } }),
  ]);
  return c.json(matchShape(await db.prepare(`${matchSel} WHERE m.id = ?`).bind(mid).first<any>()));
});

competitorRoutes.post("/product-matches", write, async (c) => {
  const db = c.env.DB;
  const b = await parseBody(c, z.object({ productId: z.number().int().positive(), competitorProductId: z.number().int().positive() }));
  const now = new Date().toISOString();
  const res = await guarded(() =>
    db.batch([
      db
        .prepare(`INSERT INTO product_matches(product_id, competitor_product_id, score, status, decided_by, decided_at) VALUES (?,?,NULL,'approved',?,?)
                  ON CONFLICT(product_id, competitor_product_id) DO UPDATE SET status='approved', decided_by=excluded.decided_by, decided_at=excluded.decided_at RETURNING id`)
        .bind(b.productId, b.competitorProductId, c.get("user").id, now),
      auditStmt(c, { action: "product_match.manual", entity: "product_match", entityId: `${b.productId}:${b.competitorProductId}`, after: b }),
    ]),
  );
  const mid = (res[0].results[0] as any).id;
  return c.json(matchShape(await db.prepare(`${matchSel} WHERE m.id = ?`).bind(mid).first<any>()), 201);
});

// ================================================================= So sánh giá (M7-05)
const FRESH_DAYS = 7;

async function comparison(db: D1Database, opts: { groupId?: number; productId?: number; includeOutOfStock?: boolean } = {}) {
  const includeOutOfStock = opts.includeOutOfStock ?? false;
  const since = new Date(Date.now() - FRESH_DAYS * 86400_000).toISOString();
  const where = ["m.status = 'approved'", "p.active = 1", "co.active = 1"];
  const binds: unknown[] = [since];
  if (opts.groupId) (where.push("p.group_id = ?"), binds.push(opts.groupId));
  if (opts.productId) (where.push("p.id = ?"), binds.push(opts.productId));
  const { results } = await db
    .prepare(
      `SELECT p.id AS product_id, p.name, p.base_unit, cp.id AS cpid, cp.name AS cp_name, cp.pack_unit, co.name AS competitor_name,
              o.unit_price, o.in_stock, o.promo_text, o.observed_at
         FROM product_matches m
         JOIN products p ON p.id = m.product_id
         JOIN competitor_products cp ON cp.id = m.competitor_product_id
         JOIN competitor_sources s ON s.id = cp.source_id
         JOIN competitors co ON co.id = s.competitor_id
         JOIN competitor_price_obs o ON o.id = (SELECT o2.id FROM competitor_price_obs o2 WHERE o2.competitor_product_id = cp.id
                AND o2.status IN ('ok','approved_outlier') AND o2.observed_at >= ?1 ORDER BY o2.observed_at DESC, o2.id DESC LIMIT 1)
        WHERE ${where.join(" AND ")} AND o.unit_price IS NOT NULL
        ORDER BY p.name, co.name`,
    )
    .bind(...binds)
    .all<any>();
  const byProduct = new Map<number, any>();
  for (const r of results) {
    if (!unitsCompatible(r.base_unit, r.pack_unit)) continue; // quy cách/đơn vị không so sánh được
    const it = byProduct.get(r.product_id) ?? { productId: r.product_id, name: r.name, baseUnit: r.base_unit, rows: [] };
    it.rows.push(r);
    byProduct.set(r.product_id, it);
  }
  const items: any[] = [];
  for (const it of byProduct.values()) {
    const ours = await resolvePrice(db, it.productId, { channel: "pos" }).then((r) => r.unitPrice, () => null);
    // B-15 / EC-36: quan sát "hết hàng" (in_stock = 0) vẫn hiện trong danh sách nhưng KHÔNG tính vào min/avg thị trường và gợi ý giá (giá cũ không còn mua được)
    const prices: number[] = it.rows.filter((r: any) => r.in_stock !== 0).map((r: any) => r.unit_price);
    if (!prices.length && !includeOutOfStock) continue;
    const min = prices.length ? Math.min(...prices) : null;
    const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
    const diff = (x: number | null) => (ours == null || x == null ? null : Math.round(((ours - x) * 10000) / x)); // dương = ta đắt hơn thị trường
    items.push({
      productId: it.productId, name: it.name, baseUnit: it.baseUnit, ourPrice: ours, marketMin: min, marketAvg: avg,
      inStockCount: prices.length, outOfStockCount: it.rows.length - prices.length,
      diffMinBp: diff(min), diffAvgBp: diff(avg),
      latestObservedAt: it.rows.reduce((a: string, r: any) => (r.observed_at > a ? r.observed_at : a), ""),
      competitors: it.rows.map((r: any) => ({
        competitorProductId: r.cpid, competitorName: r.competitor_name, productName: r.cp_name, unitPrice: r.unit_price,
        inStock: r.in_stock == null ? null : !!r.in_stock, promoText: r.promo_text, observedAt: r.observed_at,
      })),
    });
  }
  return items;
}

competitorRoutes.get("/price-comparison", view, async (c) => {
  const groupId = Number(c.req.query("groupId")) || undefined;
  // Bảng so sánh vẫn hiện mặt hàng mà mọi đối thủ đều hết hàng (marketMin = null) để người xem biết; gợi ý giá thì bỏ qua
  let items = await comparison(c.env.DB, { groupId, includeOutOfStock: true });
  if (c.req.query("onlyCheaper") === "1") items = items.filter((i) => i.ourPrice != null && i.marketMin != null && i.marketMin < i.ourPrice);
  return c.json({ items, nextCursor: null });
});

// ================================================================= Lịch sử (M7-08)
competitorRoutes.get("/competitor-prices/history", view, async (c) => {
  const db = c.env.DB;
  const productId = Number(c.req.query("productId"));
  const cpId = Number(c.req.query("competitorProductId"));
  if (!productId && !cpId) throw vErr("Thiếu productId hoặc competitorProductId");
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { results: cps } = await db
    .prepare(
      `SELECT cp.id, cp.name, cp.pack_unit, co.name AS competitor_name FROM competitor_products cp
         JOIN competitor_sources s ON s.id = cp.source_id JOIN competitors co ON co.id = s.competitor_id
        WHERE ${cpId ? "cp.id = ?" : "cp.id IN (SELECT competitor_product_id FROM product_matches WHERE product_id = ? AND status = 'approved')"}`,
    )
    .bind(cpId || productId)
    .all<any>();
  const series = [];
  for (const cp of cps) {
    const { results } = await db
      .prepare(`SELECT observed_at AS observedAt, price, unit_price AS unitPrice, in_stock AS inStock, promo_text AS promoText, status, source FROM competitor_price_obs WHERE competitor_product_id = ? AND observed_at >= ? AND status <> 'rejected' ORDER BY observed_at, id LIMIT 1000`)
      .bind(cp.id, since)
      .all<any>();
    series.push({ competitorProductId: cp.id, competitorName: cp.competitor_name, name: cp.name, packUnit: cp.pack_unit, points: results.map((r) => ({ ...r, inStock: r.inStock == null ? null : !!r.inStock })) });
  }
  let ours: unknown[] = [];
  if (productId) {
    ours = (
      await db
        .prepare(`SELECT p.effective_from AS effectiveFrom, p.unit_price AS unitPrice FROM prices p JOIN price_lists pl ON pl.id = p.price_list_id WHERE p.product_id = ? AND pl.kind = 'base' AND p.status = 'active' AND p.effective_from >= ? ORDER BY p.effective_from`)
        .bind(productId, since)
        .all()
    ).results;
  }
  return c.json({ productId: productId || null, days, series, ours });
});

// ================================================================= Giá bất thường (EC-36)
competitorRoutes.get("/competitor-prices/outliers", write, async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT o.id, o.competitor_product_id, o.observed_at, o.price, o.unit_price, cp.name, co.name AS competitor_name
         FROM competitor_price_obs o JOIN competitor_products cp ON cp.id = o.competitor_product_id
         JOIN competitor_sources s ON s.id = cp.source_id JOIN competitors co ON co.id = s.competitor_id
        WHERE o.status = 'outlier' ORDER BY o.id DESC LIMIT 100`,
    )
    .all<any>();
  const items = [];
  for (const r of results) {
    const refs = (await referencePrices(db, r.competitor_product_id, r.unit_price != null, r.id)).sort((a, b) => a - b);
    const med = refs.length ? refs[Math.floor(refs.length / 2)] : null;
    const v = r.unit_price ?? r.price;
    items.push({
      obsId: r.id, competitorProductId: r.competitor_product_id, competitorName: r.competitor_name, name: r.name, price: r.price, unitPrice: r.unit_price,
      observedAt: r.observed_at, medianUnitPrice: med, deviationBp: med ? deviationBp(v, med) : null,
    });
  }
  return c.json({ items, nextCursor: null });
});

competitorRoutes.post("/competitor-prices/:obsId/decide", write, async (c) => {
  const db = c.env.DB;
  const oid = id(c, "obsId");
  const { decision } = await parseBody(c, z.object({ decision: z.enum(["approved", "rejected"]) }));
  const o = await db.prepare(`SELECT * FROM competitor_price_obs WHERE id = ?`).bind(oid).first<any>();
  if (!o) throw notFound();
  if (o.status !== "outlier") throw conflict("not_outlier", "Quan sát không ở trạng thái chờ duyệt bất thường");
  const next = decision === "approved" ? "approved_outlier" : "rejected";
  const stmts = [
    db.prepare(`UPDATE competitor_price_obs SET status = ? WHERE id = ? AND status = 'outlier'`).bind(next, oid),
    auditStmt(c, { action: "competitor_price.decide", entity: "competitor_price_obs", entityId: oid, before: { status: "outlier" }, after: { status: next } }),
  ];
  if (decision === "approved") {
    stmts.push(
      db
        .prepare(`UPDATE competitor_products SET last_price = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM competitor_price_obs WHERE competitor_product_id = ? AND observed_at > ? AND status IN ('ok','approved_outlier'))`)
        .bind(o.price, o.competitor_product_id, o.competitor_product_id, o.observed_at),
    );
  }
  await db.batch(stmts);
  return c.json({ obsId: oid, status: next });
});

// ================================================================= Cảnh báo (M7-09)
competitorRoutes.get("/price-alerts", view, async (c) => {
  const acked = c.req.query("acked");
  const where: string[] = [];
  if (acked === "0") where.push("a.acked_at IS NULL");
  else if (acked === "1") where.push("a.acked_at IS NOT NULL");
  const { results } = await c.env.DB
    .prepare(
      `SELECT a.id, a.kind, a.message, a.product_id AS productId, p.name AS productName, a.competitor_product_id AS competitorProductId, a.source_id AS sourceId,
              a.created_at AS createdAt, a.acked_by AS ackedBy, a.acked_at AS ackedAt
         FROM price_alerts a LEFT JOIN products p ON p.id = a.product_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT 200`,
    )
    .all();
  return c.json({ items: results, nextCursor: null });
});

competitorRoutes.post("/price-alerts/:id/ack", write, async (c) => {
  const db = c.env.DB;
  const aid = id(c);
  const a = await db.prepare(`SELECT id, acked_at FROM price_alerts WHERE id = ?`).bind(aid).first<any>();
  if (!a) throw notFound();
  if (!a.acked_at) {
    await db.batch([
      db.prepare(`UPDATE price_alerts SET acked_by = ?, acked_at = ? WHERE id = ? AND acked_at IS NULL`).bind(c.get("user").id, new Date().toISOString(), aid),
      auditStmt(c, { action: "price_alert.ack", entity: "price_alert", entityId: aid }),
    ]);
  }
  return c.json({ id: aid, acked: true });
});

// ================================================================= Gợi ý giá (M7-10)
const roundTo500 = (n: number) => Math.round(n / 500) * 500;
const ceilTo500 = (n: number) => Math.ceil(n / 500) * 500;

/** Giá sàn = giá vốn bình quân × (1 + biên mục tiêu nhóm). Null nếu chưa có giá vốn. */
export async function priceFloor(db: D1Database, productId: number): Promise<number | null> {
  const cost = await currentAvgCost(db, productId);
  if (cost == null) return null;
  const g = await db.prepare(`SELECT g.target_margin_bp AS bp FROM products p LEFT JOIN product_groups g ON g.id = p.group_id WHERE p.id = ?`).bind(productId).first<{ bp: number | null }>();
  return Math.ceil(cost * (1 + (g?.bp ?? 3000) / 10000));
}

const sugSel = `SELECT s.*, p.name AS product_name FROM price_suggestions s JOIN products p ON p.id = s.product_id`;
const sugShape = (r: any) => ({
  id: r.id, productId: r.product_id, productName: r.product_name, priceListId: r.price_list_id, currentPrice: r.current_price, suggestedPrice: r.suggested_price,
  marketMin: r.market_min, marketAvg: r.market_avg, reason: r.reason, status: r.status, priceId: r.price_id, createdAt: r.created_at, decidedAt: r.decided_at,
});

competitorRoutes.get("/price-suggestions", view, async (c) => {
  const status = c.req.query("status") ?? "pending";
  const where = status === "all" ? "" : "WHERE s.status = ?";
  const { results } = await c.env.DB
    .prepare(`${sugSel} ${where} ORDER BY s.id DESC LIMIT 200`)
    .bind(...(status === "all" ? [] : [status]))
    .all<any>();
  return c.json({ items: results.map(sugShape), nextCursor: null });
});

competitorRoutes.post("/price-suggestions/generate", write, async (c) => {
  const db = c.env.DB;
  const band = await getSettingInt(db, "competitor.suggest_band_bp", 1000);
  const list = await db.prepare(`SELECT id FROM price_lists WHERE kind = 'base' AND active = 1 ORDER BY id LIMIT 1`).first<{ id: number }>();
  if (!list) throw new AppError(422, "no_base_list", "Chưa có bảng giá cơ bản");
  const now = new Date().toISOString();
  const created: number[] = [];
  for (const it of await comparison(db)) {
    const cur = await db
      .prepare(`SELECT unit_price FROM prices WHERE price_list_id = ? AND product_id = ? AND status = 'active' AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?) ORDER BY effective_from DESC, id DESC LIMIT 1`)
      .bind(list.id, it.productId, now, now)
      .first<{ unit_price: number }>();
    if (!cur) continue;
    const floor = await priceFloor(db, it.productId);
    if (floor == null) continue; // không biết giá vốn → không thể bảo đảm không bán dưới vốn
    const floorR = ceilTo500(floor);
    const ours = cur.unit_price;
    let target: number | null = null;
    let reason = "";
    if (ours > it.marketAvg * (1 + band / 10000)) {
      target = Math.max(roundTo500(it.marketAvg), floorR);
      reason = `Giá ta ${ours}đ cao hơn trung bình thị trường ${it.marketAvg}đ quá ${band / 100}%; đề xuất về mức thị trường (không dưới giá sàn ${floorR}đ = vốn + biên mục tiêu)`;
      if (target >= ours) target = null;
    } else if (ours < it.marketMin * (1 - band / 10000)) {
      target = Math.max(roundTo500(it.marketMin), floorR);
      reason = `Giá ta ${ours}đ thấp hơn mức thấp nhất thị trường ${it.marketMin}đ quá ${band / 100}%; có thể tăng giá`;
      if (target <= ours) target = null;
    }
    if (target == null) continue;
    const dup = await db.prepare(`SELECT id FROM price_suggestions WHERE product_id = ? AND price_list_id = ? AND status = 'pending'`).bind(it.productId, list.id).first();
    if (dup) continue;
    const r = await db
      .prepare(`INSERT INTO price_suggestions(product_id, price_list_id, current_price, suggested_price, market_min, market_avg, reason) VALUES (?,?,?,?,?,?,?) RETURNING id`)
      .bind(it.productId, list.id, ours, target, it.marketMin, it.marketAvg, reason)
      .first<{ id: number }>();
    created.push(r!.id);
  }
  await db.batch([auditStmt(c, { action: "price_suggestion.generate", entity: "price_suggestion", after: { created } })]);
  const { results } = created.length
    ? await db.prepare(`${sugSel} WHERE s.id IN (${created.map(() => "?").join(",")}) ORDER BY s.id`).bind(...created).all<any>()
    : { results: [] as any[] };
  return c.json({ created: created.length, items: results.map(sugShape) });
});

competitorRoutes.post("/price-suggestions/:id/accept", requirePerm("prices.write"), async (c) => {
  const db = c.env.DB;
  const sid = id(c);
  const s = await db.prepare(`SELECT * FROM price_suggestions WHERE id = ?`).bind(sid).first<any>();
  if (!s) throw notFound();
  if (s.status !== "pending") throw conflict("suggestion_not_pending", "Gợi ý đã được xử lý");
  const floor = await priceFloor(db, s.product_id);
  if (floor != null && s.suggested_price < floor) throw new AppError(422, "below_cost_floor", `Giá gợi ý thấp hơn giá sàn ${floor}đ (vốn + biên mục tiêu)`, { floor });
  const claim = await db
    .prepare(`UPDATE price_suggestions SET status = 'accepted', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(c.get("user").id, new Date().toISOString(), sid)
    .run();
  if (!claim.meta.changes) throw conflict("suggestion_not_pending", "Gợi ý đã được xử lý");
  try {
    // Luồng M3 hiện có: lịch sử giá, duyệt nếu thiếu prices.approve — M7 không tự đổi giá.
    const r = await applyBulkPrices(c, { priceListId: s.price_list_id, items: [{ productId: s.product_id, unitPrice: s.suggested_price }], note: `Theo gợi ý giá đối thủ #${sid}` });
    await db.batch([
      db.prepare(`UPDATE price_suggestions SET price_id = ? WHERE id = ?`).bind(r.priceIds[0] ?? null, sid),
      auditStmt(c, { action: "price_suggestion.accept", entity: "price_suggestion", entityId: sid, after: { priceId: r.priceIds[0], status: r.status } }),
    ]);
    return c.json({ id: sid, status: "accepted", priceStatus: r.status, priceId: r.priceIds[0] ?? null, effectiveFrom: r.effectiveFrom }, r.status === "active" ? 201 : 202);
  } catch (e) {
    await db.prepare(`UPDATE price_suggestions SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ?`).bind(sid).run();
    throw e;
  }
});

competitorRoutes.post("/price-suggestions/:id/dismiss", write, async (c) => {
  const db = c.env.DB;
  const sid = id(c);
  const s = await db.prepare(`SELECT status FROM price_suggestions WHERE id = ?`).bind(sid).first<any>();
  if (!s) throw notFound();
  if (s.status !== "pending") throw conflict("suggestion_not_pending", "Gợi ý đã được xử lý");
  await db.batch([
    db.prepare(`UPDATE price_suggestions SET status = 'dismissed', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`).bind(c.get("user").id, new Date().toISOString(), sid),
    auditStmt(c, { action: "price_suggestion.dismiss", entity: "price_suggestion", entityId: sid }),
  ]);
  return c.json({ id: sid, status: "dismissed" });
});
