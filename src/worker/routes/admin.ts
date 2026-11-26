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
import { DEF_BY_KEY, GROUPS, SETTING_DEFS, isInternalKey, isSensitive, needsConfirmNote, validateSetting } from "../services/settings-registry";
import { misaConfigured } from "../services/einvoice";
import { offboardingBlockers } from "../services/hr-common";

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

// Danh sách gọn người có thể làm phụ trách khách sỉ — không cần quyền quản trị người dùng.
adminRoutes.get("/users/assignable", requirePerm("b2b.write"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, full_name AS fullName FROM users WHERE active = 1 AND role IN ('owner','manager') ORDER BY full_name, id`).all();
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
      /** C-26: vẫn khoá dù người này còn yêu cầu/đơn đang chờ xử lý (ca POS đang mở thì luôn chặn). */
      force: z.boolean().optional(),
    }),
  );
  const db = c.env.DB;
  const me = c.get("user");
  const before = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first<any>();
  if (!before) throw notFound("user_not_found", "Không tìm thấy người dùng");
  const active = body.active === undefined ? undefined : body.active ? 1 : 0;
  if (id === me.id && (active === 0 || (body.role && body.role !== me.role))) throw conflict("self_change", "Không thể tự khoá hoặc đổi vai trò của chính mình");
  // C-26: khoá tài khoản khi còn ca POS đang mở → chặn; còn yêu cầu đang chờ → cần force
  let pendingAtLock: unknown;
  if (active === 0 && before.active) {
    const emp = await db.prepare(`SELECT id FROM employees WHERE user_id = ?`).bind(id).first<{ id: number }>();
    const bl = await offboardingBlockers(db, id, emp?.id ?? null);
    if (bl.openShifts > 0) throw conflict("open_shift", "Tài khoản này còn ca bán hàng đang mở — hãy chốt ca (quản lý đóng thay) trước khi khoá", { openShifts: bl.openShifts });
    if (bl.pendingTotal > 0 && !body.force) throw conflict("pending_requests", `Tài khoản còn ${bl.pendingTotal} yêu cầu/đơn đang chờ xử lý. Xử lý trước, hoặc gửi force=true để vẫn khoá`, bl.pending);
    if (bl.pendingTotal > 0) pendingAtLock = bl.pending;
  }
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
      after: { ...body, resetPassword: undefined, passwordReset: !!pw, pendingAtLock },
    }),
  );
  await db.batch(stmts);
  const u = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first();
  return c.json(pw ? { ...u, tempPassword: pw } : u);
});

// ===================== Nhật ký & cài đặt =====================

adminRoutes.get("/audit/facets", requirePerm("audit.view"), async (c) => {
  const db = c.env.DB;
  const [actions, entities, users] = await Promise.all([
    db.prepare(`SELECT DISTINCT action AS v FROM audit_log ORDER BY action`).all<{ v: string }>(),
    db.prepare(`SELECT DISTINCT entity AS v FROM audit_log WHERE entity IS NOT NULL ORDER BY entity`).all<{ v: string }>(),
    db.prepare(`SELECT id, username, full_name FROM users ORDER BY full_name`).all(),
  ]);
  return c.json({ actions: actions.results.map((r) => r.v), entities: entities.results.map((r) => r.v), users: users.results });
});

adminRoutes.get("/audit", requirePerm("audit.view"), async (c) => {
  const q = c.req.query();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.entity) { conds.push(`a.entity = ?`); params.push(q.entity); }
  if (q.entityId) { conds.push(`a.entity_id = ?`); params.push(q.entityId); }
  if (q.action) { conds.push(`a.action = ?`); params.push(q.action); }
  if (q.userId) { conds.push(`a.user_id = ?`); params.push(Number(q.userId)); }
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

// ----- Cài đặt (registry: services/settings-registry.ts) -----

async function settingsView(c: Ctx) {
  const db = c.env.DB;
  const rows = (await db.prepare(`SELECT key, value, note FROM settings ORDER BY key`).all<{ key: string; value: string; note: string | null }>()).results;
  const conf = new Map(
    (await db.prepare(`SELECT c.key, c.confirmed_at, c.confirmed_by, u.full_name AS by_name FROM settings_confirmations c LEFT JOIN users u ON u.id = c.confirmed_by`).all<any>()).results.map((r) => [r.key as string, r]),
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const mask = (k: string, v: string | null) => (isSensitive(k) ? (v ? "***" : "") : v);
  const groups = GROUPS.map((g) => ({
    group: g,
    items: SETTING_DEFS.filter((d) => d.group === g).map((d) => {
      const r = byKey.get(d.key);
      const cf = conf.get(d.key);
      const needs = needsConfirmNote(r?.note);
      return {
        key: d.key, label: d.label, help: d.help, type: d.type, unit: d.unit ?? null, min: d.min ?? null, max: d.max ?? null,
        options: d.options ?? null, maxLen: d.maxLen ?? null, format: d.format ?? null, sensitive: !!d.sensitive,
        value: r ? mask(d.key, r.value) : null, note: r?.note ?? null,
        needsConfirm: needs, confirmed: !!cf, confirmedAt: cf?.confirmed_at ?? null, confirmedByName: cf?.by_name ?? null,
        pending: needs && !cf,
      };
    }),
  }));
  const unknown = rows.filter((r) => !DEF_BY_KEY.has(r.key) && !isInternalKey(r.key)).map((r) => ({ key: r.key, value: mask(r.key, r.value), note: r.note }));
  return {
    groups,
    unknown,
    pendingCount: groups.reduce((n, g) => n + g.items.filter((i) => i.pending).length, 0),
    canWrite: can(c.get("user").role, "settings.manage"),
    items: rows.filter((r) => !isInternalKey(r.key)).map((r) => ({ key: r.key, value: mask(r.key, r.value), note: r.note })), // tương thích cũ
  };
}

adminRoutes.get("/settings", requirePerm("settings.view"), async (c) => c.json(await settingsView(c)));

adminRoutes.put("/settings", requirePerm("settings.manage"), async (c) => {
  const body = await parseBody(
    c,
    z.object({
      settings: z.record(z.string().regex(/^[a-z0-9_.]{1,64}$/), z.union([z.string().max(2000), z.number(), z.boolean()])).default({}),
      confirm: z.array(z.string().max(64)).max(100).optional(), // xác nhận giữ nguyên giá trị (không đổi)
    }),
  );
  const db = c.env.DB;
  const me = c.get("user");
  const keys = Object.keys(body.settings);
  const confirmKeys = [...new Set(body.confirm ?? [])];
  if (!keys.length && !confirmKeys.length) throw new AppError(422, "validation_error", "Không có cài đặt nào");
  const cur = new Map((await db.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]));
  const errors: Record<string, string> = {};
  const next: Record<string, string> = {};
  for (const k of keys) {
    const def = DEF_BY_KEY.get(k);
    if (!def) { errors[k] = "Khoá cài đặt không tồn tại"; continue; }
    const r = validateSetting(def, body.settings[k]);
    if ("error" in r) { errors[k] = r.error; continue; }
    if (k === "einvoice.provider" && r.value === "misa" && !misaConfigured(c.env)) { errors[k] = "Chưa cấu hình kết nối MISA (secrets)"; continue; }
    next[k] = r.value;
  }
  for (const k of confirmKeys) if (!DEF_BY_KEY.has(k)) errors[k] = "Khoá cài đặt không tồn tại";
  if (Object.keys(errors).length) throw new AppError(422, "validation_error", "Một số giá trị chưa hợp lệ", { fields: errors });

  const changed = Object.keys(next).filter((k) => cur.get(k) !== next[k]);
  const show = (k: string, v: string | undefined) => (isSensitive(k) ? "***" : v ?? null);
  const before = Object.fromEntries(changed.map((k) => [k, show(k, cur.get(k))]));
  const after = Object.fromEntries(changed.map((k) => [k, show(k, next[k])]));
  // Lưu một khoá (kể cả giữ nguyên giá trị) hoặc bấm "Xác nhận" = chủ đã xem và xác nhận khoá đó
  const toConfirm = [...new Set([...keys, ...confirmKeys])];
  const stmts: D1PreparedStatement[] = [
    ...changed.map((k) => db.prepare(`INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, next[k])),
    ...toConfirm.map((k) => db.prepare(`INSERT INTO settings_confirmations(key, confirmed_by) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET confirmed_by = excluded.confirmed_by, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(k, me.id)),
  ];
  if (changed.length) stmts.push(auditStmt(c, { action: "settings.update", entity: "settings", before, after }));
  const onlyConfirmed = toConfirm.filter((k) => !changed.includes(k));
  if (onlyConfirmed.length) stmts.push(auditStmt(c, { action: "settings.confirm", entity: "settings", after: { confirmed: onlyConfirmed } }));
  await db.batch(stmts);
  return c.json(await settingsView(c));
});
