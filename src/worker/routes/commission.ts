import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { audit, auditStmt } from "../lib/audit";
import { parseBody } from "../services/http";
import { assertStmt } from "../services/guard";
import { loadActiveRules, loadCommissionInputs } from "../services/commission";

/**
 * Quy tắc hoa hồng bán hàng + xem trước (docs/API-dot4.md, "Báo cáo bán hàng & hoa hồng").
 * Xem: hr.sensitive (số tiền lương). Tạo/sửa/ngừng: payroll.approve (chính sách lương, chủ cửa hàng). Không xoá cứng.
 */
export const commissionRoutes = new Hono<AppBindings>();

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString().slice(0, 10) === v, "Ngày không hợp lệ");
const ruleFields = {
  name: z.string().trim().min(1).max(120),
  scope: z.enum(["all", "group", "product"]),
  productGroupId: z.number().int().positive().nullish(),
  productId: z.number().int().positive().nullish(),
  employeeId: z.number().int().positive().nullish(),
  rateBp: z.number().int().min(0).max(10000),
  effectiveFrom: DAY.nullish(),
  effectiveTo: DAY.nullish(),
};
const createBody = z.object(ruleFields).strict();
const patchBody = z.object({
  name: ruleFields.name.optional(), scope: ruleFields.scope.optional(), productGroupId: ruleFields.productGroupId, productId: ruleFields.productId, employeeId: ruleFields.employeeId,
  rateBp: ruleFields.rateBp.optional(), effectiveFrom: ruleFields.effectiveFrom, effectiveTo: ruleFields.effectiveTo,
  active: z.boolean().optional(), version: z.number().int().positive(),
}).strict();

const mapRule = (r: any) => ({
  id: r.id, name: r.name, scope: r.scope, productGroupId: r.product_group_id, productGroupName: r.group_name ?? null,
  productId: r.product_id, productName: r.product_name ?? null, employeeId: r.employee_id, employeeName: r.employee_name ?? null,
  rateBp: r.rate_bp, active: !!r.active, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, version: r.version, createdAt: r.created_at,
});
const SELECT_RULES = `SELECT r.*, g.name AS group_name, p.name AS product_name, e.full_name AS employee_name FROM commission_rules r
  LEFT JOIN product_groups g ON g.id = r.product_group_id LEFT JOIN products p ON p.id = r.product_id LEFT JOIN employees e ON e.id = r.employee_id`;

async function validateRefs(db: D1Database, v: { scope: string; productGroupId?: number | null; productId?: number | null; employeeId?: number | null; effectiveFrom?: string | null; effectiveTo?: string | null }) {
  if (v.scope === "group" && !v.productGroupId) throw new AppError(422, "validation_error", "Quy tắc theo nhóm hàng phải chọn nhóm hàng");
  if (v.scope === "product" && !v.productId) throw new AppError(422, "validation_error", "Quy tắc theo mặt hàng phải chọn mặt hàng");
  if (v.scope === "group" && !(await db.prepare(`SELECT 1 AS x FROM product_groups WHERE id = ?`).bind(v.productGroupId).first())) throw new AppError(422, "validation_error", "Nhóm hàng không tồn tại");
  if (v.scope === "product" && !(await db.prepare(`SELECT 1 AS x FROM products WHERE id = ?`).bind(v.productId).first())) throw new AppError(422, "validation_error", "Mặt hàng không tồn tại");
  if (v.employeeId && !(await db.prepare(`SELECT 1 AS x FROM employees WHERE id = ?`).bind(v.employeeId).first())) throw new AppError(422, "validation_error", "Nhân viên không tồn tại");
  if (v.effectiveFrom && v.effectiveTo && v.effectiveTo < v.effectiveFrom) throw new AppError(422, "validation_error", "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu");
}

commissionRoutes.get("/commission/rules", requirePerm("hr.sensitive"), async (c) => {
  const { results } = await c.env.DB.prepare(`${SELECT_RULES} ORDER BY r.active DESC, r.id DESC`).all<any>();
  return c.json({ items: results.map(mapRule) });
});

commissionRoutes.post("/commission/rules", requirePerm("payroll.approve"), async (c) => {
  const b = await parseBody(c, createBody);
  const db = c.env.DB;
  await validateRefs(db, b);
  const scoped = { group: b.scope === "group" ? b.productGroupId! : null, product: b.scope === "product" ? b.productId! : null };
  const res = await db
    .prepare(`INSERT INTO commission_rules(name, scope, product_group_id, product_id, employee_id, rate_bp, effective_from, effective_to, created_by) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
    .bind(b.name, b.scope, scoped.group, scoped.product, b.employeeId ?? null, b.rateBp, b.effectiveFrom ?? null, b.effectiveTo ?? null, c.get("user").id)
    .first<{ id: number }>();
  await audit(c, { action: "commission.rule.create", entity: "commission_rule", entityId: res!.id, after: { ...b } });
  const row = await db.prepare(`${SELECT_RULES} WHERE r.id = ?`).bind(res!.id).first<any>();
  return c.json(mapRule(row), 201);
});

commissionRoutes.patch("/commission/rules/:id", requirePerm("payroll.approve"), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  const b = await parseBody(c, patchBody);
  const db = c.env.DB;
  const cur = await db.prepare(`SELECT * FROM commission_rules WHERE id = ?`).bind(id).first<any>();
  if (!cur) throw notFound();
  if (cur.version !== b.version) throw conflict("version_conflict", "Quy tắc đã được người khác cập nhật", { currentVersion: cur.version });
  const pick = <T,>(k: keyof typeof b, old: T): T | null => (k in b ? ((b[k] as T | null | undefined) ?? null) : old);
  const next = {
    name: b.name ?? cur.name, scope: (b.scope ?? cur.scope) as string,
    productGroupId: pick<number>("productGroupId", cur.product_group_id), productId: pick<number>("productId", cur.product_id),
    employeeId: pick<number>("employeeId", cur.employee_id), rateBp: b.rateBp ?? cur.rate_bp,
    effectiveFrom: pick<string>("effectiveFrom", cur.effective_from), effectiveTo: pick<string>("effectiveTo", cur.effective_to),
    active: b.active === undefined ? cur.active : b.active ? 1 : 0,
  };
  // đổi phạm vi thì bỏ tham chiếu của phạm vi cũ
  if (next.scope === "all") { next.productGroupId = null; next.productId = null; }
  if (next.scope === "group") next.productId = null;
  if (next.scope === "product") next.productGroupId = null;
  await validateRefs(db, next);
  const res = await db.batch([
    assertStmt(db, "commission.rule.update", `SELECT version = ? FROM commission_rules WHERE id = ?`, [b.version, id]),
    db
      .prepare(
        `UPDATE commission_rules SET name=?, scope=?, product_group_id=?, product_id=?, employee_id=?, rate_bp=?, effective_from=?, effective_to=?, active=?, version = version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND version = ?`,
      )
      .bind(next.name, next.scope, next.productGroupId, next.productId, next.employeeId, next.rateBp, next.effectiveFrom, next.effectiveTo, next.active, id, b.version),
    auditStmt(c, { action: next.active === 0 && cur.active === 1 ? "commission.rule.deactivate" : "commission.rule.update", entity: "commission_rule", entityId: id,
      before: { name: cur.name, scope: cur.scope, rateBp: cur.rate_bp, active: !!cur.active, version: cur.version }, after: { ...next, active: !!next.active } }),
  ]);
  if (res[1].meta.changes === 0) throw conflict("version_conflict", "Quy tắc đã được người khác cập nhật");
  const row = await db.prepare(`${SELECT_RULES} WHERE r.id = ?`).bind(id).first<any>();
  return c.json(mapRule(row));
});

// Xem trước hoa hồng một kỳ — cùng hàm với bảng lương nên số khớp khi tính lương
commissionRoutes.get("/commission/preview", requirePerm("hr.sensitive"), async (c) => {
  const period = c.req.query("period") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError(422, "validation_error", "period phải dạng YYYY-MM");
  const db = c.env.DB;
  const emps = (await db.prepare(`SELECT id, user_id, full_name FROM employees WHERE user_id IS NOT NULL`).all<any>()).results;
  const inp = await loadCommissionInputs(db, period, new Map(emps.map((e) => [e.user_id as number, e.id as number])));
  const legacy = Number((await db.prepare(`SELECT value FROM settings WHERE key = 'hr.sales_bonus_bp'`).first<{ value: string }>())?.value ?? 0) || 0;
  await audit(c, { action: "commission.preview", entity: "commission", entityId: period });
  if (!inp) return c.json({ period, rulesActive: false, legacySalesBonusBp: legacy, rules: [], items: [], total: 0 });
  const users = new Map((await db.prepare(`SELECT id, full_name FROM users`).all<any>()).results.map((u) => [u.id as number, u.full_name as string]));
  const empBy = new Map(emps.map((e) => [e.id as number, e.full_name as string]));
  const items = [...inp.bySeller.values()]
    .map((s) => ({
      userId: s.uid, userName: users.get(s.uid) ?? `#${s.uid}`, employeeId: s.employeeId, employeeName: s.employeeId ? empBy.get(s.employeeId) ?? null : null,
      paid: s.employeeId != null, revenue: s.revenue, uncoveredRevenue: s.uncovered, commission: s.employeeId != null ? s.commission : 0, parts: s.parts,
    }))
    .sort((a, b) => b.revenue - a.revenue);
  const rules = (await loadActiveRules(db, period)).map((r) => ({ id: r.id, name: r.name, scope: r.scope, rateBp: r.rateBp }));
  return c.json({ period, rulesActive: true, legacySalesBonusBp: legacy, rules, items, total: items.reduce((t, i) => t + i.commission, 0) });
});
