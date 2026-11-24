import { getApprovalHandler } from "../services/approval-registry";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings, Role } from "../env";
import { requirePerm, can, type Permission } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { hashPassword, randomToken } from "../lib/crypto";
import { approveVoucher } from "../services/vouchers";
import { applyStockDocPost } from "./inventory";
import { activatePrice } from "./prices";

export const adminRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;

async function parseBody<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.infer<T>> {
  return schema.parse(await c.req.json().catch(() => ({})));
}
const lim = (v: string | undefined) => Math.min(Math.max(Number(v) || 50, 1), 200);

// ===================== Duyệt =====================

adminRoutes.get("/approvals", requirePerm("approvals.decide"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.status) { conds.push(`a.status = ?`); params.push(q.status); }
  if (q.type) { conds.push(`a.type = ?`); params.push(q.type); }
  if (q.cursor) { conds.push(`a.id < ?`); params.push(Number(q.cursor)); }
  const limit = lim(q.limit);
  const rows = (
    await c.env.DB
      .prepare(
        `SELECT a.*, u.full_name AS requested_by_name FROM approvals a JOIN users u ON u.id = a.requested_by
          ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`,
      )
      .bind(...params, limit + 1)
      .all<any>()
  ).results;
  const items = rows.slice(0, limit).map(({ payload_json, ...a }) => {
    let payload: unknown = null;
    try { payload = payload_json ? JSON.parse(payload_json) : null; } catch { /* bỏ qua */ }
    return { ...a, payload };
  });
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

const NEEDS: Record<string, Permission> = {
  "cash_voucher.post": "finance.approve",
  "stock_doc.post": "inventory.approve",
  "price.activate": "prices.approve",
};

adminRoutes.post("/approvals/:id/decide", requirePerm("approvals.decide"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(c, z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(500).optional() }));
  const db = c.env.DB;
  const user = c.get("user");
  const a = await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<any>();
  if (!a) throw notFound("approval_not_found", "Không tìm thấy yêu cầu duyệt");
  if (a.status !== "pending") throw conflict("already_decided", "Yêu cầu đã được xử lý");
  const handler = getApprovalHandler(a.type as string);
  const need = handler?.perm ?? NEEDS[a.type as string];
  if (need && !can(user.role, need)) throw new AppError(403, "forbidden", "Bạn không có quyền duyệt loại yêu cầu này");
  if (user.role !== "owner" && a.requested_by === user.id) throw new AppError(403, "self_approval", "Không được tự duyệt yêu cầu của chính mình");
  const refId = Number(a.ref_id);
  const finish = [
    db
      .prepare(`UPDATE approvals SET status=?, decided_by=?, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_note=? WHERE id=? AND status='pending'`)
      .bind(body.decision, user.id, body.note ?? null, id),
    auditStmt(c, { action: `approval.${body.decision}`, entity: "approval", entityId: id, before: { status: "pending", type: a.type }, after: { status: body.decision }, reason: body.note }),
  ];

  if (handler) {
    // Loại duyệt do module Đợt 2+ đăng ký (services/approval-registry.ts)
    const fn = body.decision === "approved" ? handler.onApprove : handler.onReject;
    const extra = (await fn?.(c, a, body.note)) ?? [];
    await db.batch([...extra, ...finish]);
  } else if (body.decision === "rejected") {
    const extra: D1PreparedStatement[] = [];
    if (a.type === "cash_voucher.post") extra.push(db.prepare(`UPDATE cash_vouchers SET status='cancelled' WHERE id=? AND status='pending_approval'`).bind(refId));
    if (a.type === "stock_doc.post") extra.push(db.prepare(`UPDATE stock_docs SET status='cancelled' WHERE id=? AND status='pending_approval'`).bind(refId));
    if (a.type === "price.activate") extra.push(db.prepare(`UPDATE prices SET status='rejected' WHERE id=? AND status='pending'`).bind(refId));
    await db.batch([...extra, ...finish]);
  } else if (a.type === "cash_voucher.post") {
    await approveVoucher(c, refId, body.note); // đồng thời đánh dấu approval = approved
  } else if (a.type === "stock_doc.post") {
    await applyStockDocPost(c, refId);
    await db.batch(finish);
  } else if (a.type === "price.activate") {
    await activatePrice(c, refId, user.id);
    await db.batch(finish);
  } else {
    // order.below_cost / order.discount và loại khác: chỉ đánh dấu đã duyệt (thu ngân gửi lại checkout kèm approvalId)
    await db.batch(finish);
  }
  return c.json(await db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first());
});

// ===================== Người dùng =====================

const USER_COLS = `id, username, full_name, role, store_id, active, must_change_password, created_at`;
const ROLES = ["owner", "manager", "cashier", "warehouse", "accountant", "online_staff", "staff"] as const;
const tempPassword = () => randomToken(9);

adminRoutes.get("/users", requirePerm("users.manage"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT ${USER_COLS} FROM users ORDER BY id`).all();
  return c.json({ items: results });
});

adminRoutes.post("/users", requirePerm("users.manage"), async (c) => {
  const body = await parseBody(
    c,
    z.object({
      username: z.string().trim().min(3).max(50).regex(/^[A-Za-z0-9._-]+$/),
      fullName: z.string().trim().min(1).max(100),
      role: z.enum(ROLES),
      storeId: z.number().int().positive().nullable().optional(),
      tempPassword: z.string().min(8).max(100).optional(),
    }),
  );
  const db = c.env.DB;
  const pw = body.tempPassword ?? tempPassword();
  const dup = await db.prepare(`SELECT id FROM users WHERE username = ?`).bind(body.username).first();
  if (dup) throw conflict("username_taken", "Tên đăng nhập đã tồn tại");
  const hash = await hashPassword(pw);
  const r = await db
    .prepare(`INSERT INTO users(username, full_name, pass_hash, role, store_id, must_change_password) VALUES (?,?,?,?,?,1)`)
    .bind(body.username, body.fullName, hash, body.role, body.storeId ?? c.get("user").storeId ?? null)
    .run();
  const id = r.meta.last_row_id as number;
  await auditStmt(c, { action: "user.create", entity: "user", entityId: id, after: { username: body.username, role: body.role } }).run();
  const u = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first();
  return c.json({ ...u, tempPassword: pw }, 201);
});

adminRoutes.put("/users/:id", requirePerm("users.manage"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await parseBody(
    c,
    z.object({
      fullName: z.string().trim().min(1).max(100).optional(),
      role: z.enum(ROLES).optional(),
      storeId: z.number().int().positive().nullable().optional(),
      active: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
      resetPassword: z.boolean().optional(),
    }),
  );
  const db = c.env.DB;
  const me = c.get("user");
  const before = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first<any>();
  if (!before) throw notFound("user_not_found", "Không tìm thấy người dùng");
  const active = body.active === undefined ? undefined : body.active ? 1 : 0;
  if (id === me.id && (active === 0 || (body.role && body.role !== me.role))) throw conflict("self_change", "Không thể tự khoá hoặc đổi vai trò của chính mình");
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.fullName !== undefined) { sets.push("full_name=?"); params.push(body.fullName); }
  if (body.role !== undefined) { sets.push("role=?"); params.push(body.role as Role); }
  if (body.storeId !== undefined) { sets.push("store_id=?"); params.push(body.storeId); }
  if (active !== undefined) { sets.push("active=?"); params.push(active); }
  let pw: string | undefined;
  if (body.resetPassword) {
    pw = tempPassword();
    sets.push("pass_hash=?", "must_change_password=1", "failed_logins=0", "locked_until=NULL");
    params.push(await hashPassword(pw));
  }
  if (!sets.length) throw new AppError(422, "validation_error", "Không có thay đổi nào");
  const stmts = [db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).bind(...params, id)];
  // EC-39: khoá tài khoản / đổi mật khẩu → thu hồi mọi phiên
  if (active === 0 || pw) {
    stmts.push(db.prepare(`UPDATE sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND revoked_at IS NULL`).bind(id));
  }
  stmts.push(
    auditStmt(c, {
      action: active === 0 ? "user.deactivate" : "user.update",
      entity: "user",
      entityId: id,
      before,
      after: { ...body, resetPassword: undefined, passwordReset: !!pw },
    }),
  );
  await db.batch(stmts);
  const u = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first();
  return c.json(pw ? { ...u, tempPassword: pw } : u);
});

// ===================== Nhật ký & cài đặt =====================

adminRoutes.get("/audit", requirePerm("audit.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.entity) { conds.push(`a.entity = ?`); params.push(q.entity); }
  if (q.entityId) { conds.push(`a.entity_id = ?`); params.push(q.entityId); }
  if (q.action) { conds.push(`a.action = ?`); params.push(q.action); }
  if (q.from) { conds.push(`a.at >= ?`); params.push(q.from); }
  if (q.to) { conds.push(`a.at < ?`); params.push(q.to); }
  if (q.cursor) { conds.push(`a.id < ?`); params.push(Number(q.cursor)); }
  const limit = lim(q.limit);
  const rows = (
    await c.env.DB
      .prepare(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`)
      .bind(...params, limit + 1)
      .all<any>()
  ).results;
  const sens = can(c.get("user").role, "hr.sensitive");
  const items = rows.slice(0, limit).map((r) =>
    !sens && (/^(hr|payroll)\./.test(r.action) || ["employee", "salary_advance"].includes(r.entity) || String(r.entity ?? "").startsWith("payroll"))
      ? { ...r, before_json: r.before_json ? '"***"' : null, after_json: r.after_json ? '"***"' : null }
      : r,
  );
  return c.json({ items, nextCursor: rows.length > limit ? String(items[items.length - 1].id) : null });
});

adminRoutes.get("/settings", requirePerm("users.manage"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT key, value, note FROM settings ORDER BY key`).all();
  return c.json({ items: results });
});

adminRoutes.put("/settings", requirePerm("users.manage"), async (c) => {
  const body = await parseBody(c, z.object({ settings: z.record(z.string().regex(/^[a-z0-9_.]{1,64}$/), z.union([z.string().max(500), z.number()])) }));
  const db = c.env.DB;
  const keys = Object.keys(body.settings);
  if (!keys.length) throw new AppError(422, "validation_error", "Không có cài đặt nào");
  const beforeRows = (await db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys).all<{ key: string; value: string }>()).results;
  const before = Object.fromEntries(beforeRows.map((r) => [r.key, r.value]));
  await db.batch([
    ...keys.map((k) => db.prepare(`INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, String(body.settings[k]))),
    auditStmt(c, { action: "settings.update", entity: "settings", before, after: body.settings }),
  ]);
  const { results } = await db.prepare(`SELECT key, value, note FROM settings ORDER BY key`).all();
  return c.json({ items: results });
});
