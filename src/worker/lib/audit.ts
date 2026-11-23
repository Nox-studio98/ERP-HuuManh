import type { Context } from "hono";
import type { AppBindings } from "../env";

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Trả về statement để gộp vào cùng D1 batch với thay đổi nghiệp vụ (cùng commit / cùng rollback). */
export function auditStmt(c: Context<AppBindings>, e: AuditEntry, userId?: number | null): D1PreparedStatement {
  const u = c.get("user");
  return c.env.DB.prepare(
    `INSERT INTO audit_log(user_id, action, entity, entity_id, before_json, after_json, reason, ip, device_id, request_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    userId ?? u?.id ?? null,
    e.action,
    e.entity ?? null,
    e.entityId != null ? String(e.entityId) : null,
    e.before !== undefined ? JSON.stringify(e.before) : null,
    e.after !== undefined ? JSON.stringify(e.after) : null,
    e.reason ?? null,
    c.req.header("cf-connecting-ip") ?? null,
    u?.deviceId ?? c.req.header("x-device-id") ?? null,
    c.get("requestId") ?? null,
  );
}

export async function audit(c: Context<AppBindings>, e: AuditEntry, userId?: number | null) {
  await auditStmt(c, e, userId).run();
}
