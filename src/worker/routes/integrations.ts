import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { audit, auditStmt } from "../lib/audit";
import { pageParams, parseBody, unitFactor } from "../services/http";
import { misaConfigured } from "../services/einvoice";
import { csvToFrescoOrders, createFrescoOrder, FRESCO_SOURCE } from "../services/fresco";

export const integrationRoutes = new Hono<AppBindings>();

const JOB_STATUSES = ["queued", "running", "done", "failed", "dead"];

const jobDto = (j: any) => ({
  id: j.id,
  type: j.type,
  refType: j.ref_type,
  refId: j.ref_id,
  status: j.status,
  attempts: j.attempts,
  nextRunAt: j.next_run_at,
  lastError: j.last_error,
  result: j.result_json ? safeJson(j.result_json) : null,
  createdAt: j.created_at,
  updatedAt: j.updated_at,
});
function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

integrationRoutes.get("/integrations/jobs", requirePerm("integrations.manage"), async (c) => {
  const status = c.req.query("status");
  const type = c.req.query("type");
  if (status && !JOB_STATUSES.includes(status)) throw new AppError(422, "validation_error", "status không hợp lệ");
  const { limit, cursor } = pageParams(c);
  const where: string[] = [];
  const args: unknown[] = [];
  if (status) (where.push("status = ?"), args.push(status));
  if (type) (where.push("type = ?"), args.push(type));
  if (cursor > 0) (where.push("id < ?"), args.push(cursor));
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM integration_jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .bind(...args, limit + 1)
    .all<any>();
  const page = results.slice(0, limit);
  return c.json({ items: page.map(jobDto), nextCursor: results.length > limit ? page[page.length - 1].id : null });
});

integrationRoutes.post("/integrations/jobs/:id/retry", requirePerm("integrations.manage"), async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const job = await db.prepare(`SELECT * FROM integration_jobs WHERE id = ?`).bind(id).first<any>();
  if (!job) throw notFound("job_not_found", "Không tìm thấy job");
  const upd = await db
    .prepare(`UPDATE integration_jobs SET status='queued', attempts=0, next_run_at=?, updated_at=? WHERE id=? AND status IN ('failed','dead')`)
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run();
  if (!upd.meta.changes) throw conflict("job_not_retryable", "Chỉ chạy lại được job đã lỗi hoặc đã dừng");
  if (job.type.startsWith("einvoice.") && job.ref_type === "invoice" && job.ref_id) {
    await db.prepare(`UPDATE invoices SET einvoice_status='queued' WHERE id=? AND einvoice_status='failed'`).bind(job.ref_id).run();
  }
  await audit(c, { action: "integration.job_retry", entity: "integration_job", entityId: id, before: { status: job.status, attempts: job.attempts } });
  try {
    await c.env.JOBS?.send({ jobId: id });
  } catch {
    /* cron mỗi 5 phút sẽ quét lại */
  }
  const fresh = await db.prepare(`SELECT * FROM integration_jobs WHERE id = ?`).bind(id).first<any>();
  return c.json(jobDto(fresh));
});

// ===== Cài đặt tích hợp (không bao giờ trả secret) =====
async function readSettings(c: { env: AppBindings["Bindings"] }) {
  const { results } = await c.env.DB
    .prepare(`SELECT key, value FROM settings WHERE key IN ('fresco.enabled','einvoice.provider','einvoice.auto_issue_b2b','remind.days_before_due')`)
    .all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  return {
    frescoEnabled: m.get("fresco.enabled") === "1",
    einvoiceProvider: (m.get("einvoice.provider") ?? "fake") as "fake" | "misa",
    einvoiceAutoIssueB2b: m.get("einvoice.auto_issue_b2b") !== "0",
    remindDaysBeforeDue: Number(m.get("remind.days_before_due") ?? 3),
    misaConfigured: misaConfigured(c.env),
    frescoWebhookConfigured: Boolean(c.env.FRESCO_WEBHOOK_SECRET),
  };
}

integrationRoutes.get("/integrations/settings", requirePerm("integrations.manage"), async (c) => c.json(await readSettings(c)));

integrationRoutes.put("/integrations/settings", requirePerm("integrations.manage"), async (c) => {
  const b = await parseBody(
    c,
    z.object({
      frescoEnabled: z.boolean().optional(),
      einvoiceProvider: z.enum(["fake", "misa"]).optional(),
      einvoiceAutoIssueB2b: z.boolean().optional(),
      remindDaysBeforeDue: z.number().int().min(0).max(60).optional(),
    }).strict(),
  );
  if (b.einvoiceProvider === "misa" && !misaConfigured(c.env)) throw new AppError(422, "misa_not_configured", "Chưa cấu hình thông tin kết nối MISA (secrets/biến môi trường)");
  const before = await readSettings(c);
  const sets: [string, string][] = [];
  if (b.frescoEnabled !== undefined) sets.push(["fresco.enabled", b.frescoEnabled ? "1" : "0"]);
  if (b.einvoiceProvider !== undefined) sets.push(["einvoice.provider", b.einvoiceProvider]);
  if (b.einvoiceAutoIssueB2b !== undefined) sets.push(["einvoice.auto_issue_b2b", b.einvoiceAutoIssueB2b ? "1" : "0"]);
  if (b.remindDaysBeforeDue !== undefined) sets.push(["remind.days_before_due", String(b.remindDaysBeforeDue)]);
  if (sets.length) {
    const db = c.env.DB;
    await db.batch([
      ...sets.map(([k, v]) => db.prepare(`INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v)),
      auditStmt(c, { action: "integration.settings_update", entity: "settings", before, after: b }),
    ]);
  }
  return c.json(await readSettings(c));
});

// ===== Ghép SKU sàn ↔ sản phẩm =====
integrationRoutes.get("/fresco/products", requirePerm("integrations.manage"), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT ep.external_sku, ep.product_id, ep.unit, p.sku, p.name FROM external_products ep JOIN products p ON p.id = ep.product_id
        WHERE ep.source = ? ORDER BY ep.external_sku`,
    )
    .bind(FRESCO_SOURCE)
    .all<any>();
  return c.json({ items: results.map((r) => ({ externalSku: r.external_sku, productId: r.product_id, productSku: r.sku, productName: r.name, unit: r.unit })), nextCursor: null });
});

integrationRoutes.put("/fresco/products", requirePerm("integrations.manage"), async (c) => {
  const b = await parseBody(
    c,
    z.object({
      mappings: z.array(z.object({ externalSku: z.string().min(1).max(100), productId: z.number().int().positive(), unit: z.string().min(1).max(30) })).max(500).default([]),
      remove: z.array(z.string().min(1).max(100)).max(500).default([]),
    }),
  );
  const db = c.env.DB;
  for (const m of b.mappings) {
    const p = await db.prepare(`SELECT id FROM products WHERE id=?`).bind(m.productId).first();
    if (!p) throw new AppError(422, "invalid_reference", `Sản phẩm ${m.productId} không tồn tại`);
    await unitFactor(db, m.productId, m.unit); // 422 nếu đơn vị lạ
  }
  await db.batch([
    ...b.mappings.map((m) =>
      db
        .prepare(`INSERT INTO external_products(source, external_sku, product_id, unit) VALUES (?,?,?,?) ON CONFLICT(source, external_sku) DO UPDATE SET product_id=excluded.product_id, unit=excluded.unit`)
        .bind(FRESCO_SOURCE, m.externalSku, m.productId, m.unit),
    ),
    ...b.remove.map((s) => db.prepare(`DELETE FROM external_products WHERE source=? AND external_sku=?`).bind(FRESCO_SOURCE, s)),
    auditStmt(c, { action: "fresco.products_update", entity: "external_products", after: { upserted: b.mappings, removed: b.remove } }),
  ]);
  return c.json({ ok: true, upserted: b.mappings.length, removed: b.remove.length });
});

// ===== Import CSV đơn Fresco (cùng lõi với webhook) =====
integrationRoutes.post("/fresco/orders/import", requirePerm("orders.online.manage"), async (c) => {
  const ct = c.req.header("content-type") ?? "";
  let text: string;
  if (ct.includes("application/json")) {
    const b = await parseBody(c, z.object({ csv: z.string().min(1).max(900_000) }));
    text = b.csv;
  } else text = await c.req.text();
  const { orders, errors } = csvToFrescoOrders(text);
  if (orders.length > 200) throw new AppError(422, "too_many_orders", "Tối đa 200 đơn mỗi lần nhập");
  const user = c.get("user");
  const results: unknown[] = [];
  for (const o of orders) {
    try {
      const r = await createFrescoOrder(c.env, o, { userId: user.id });
      results.push({ externalId: o.orderId, ...r });
    } catch (e) {
      results.push({ externalId: o.orderId, error: e instanceof AppError ? e.message : "Lỗi xử lý đơn" });
    }
  }
  await audit(c, { action: "fresco.import", entity: "orders", after: { orders: orders.length, errors: errors.length } });
  return c.json({ imported: results.filter((r: any) => !r.error && !r.duplicate).length, items: results, errors });
});
