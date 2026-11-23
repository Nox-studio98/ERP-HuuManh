/** Ghi audit_log từ job nền / cron / webhook (không có ngữ cảnh request, user_id = NULL hoặc người chỉ định). */
export interface SysAuditEntry {
  action: string;
  entity?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export function sysAuditStmt(db: D1Database, e: SysAuditEntry, userId: number | null = null): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log(user_id, action, entity, entity_id, before_json, after_json, reason) VALUES (?,?,?,?,?,?,?)`)
    .bind(
      userId,
      e.action,
      e.entity ?? null,
      e.entityId != null ? String(e.entityId) : null,
      e.before !== undefined ? JSON.stringify(e.before) : null,
      e.after !== undefined ? JSON.stringify(e.after) : null,
      e.reason ?? null,
    );
}

export async function sysAudit(db: D1Database, e: SysAuditEntry, userId: number | null = null) {
  await sysAuditStmt(db, e, userId).run();
}
