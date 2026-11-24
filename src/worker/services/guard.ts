/**
 * Chốt chặn đồng thời dùng chung (migrations/0008).
 *
 * Trong D1/SQLite, `UPDATE ... WHERE status = 'cũ'` khớp 0 dòng KHÔNG làm batch thất bại — các câu lệnh khác trong batch
 * (cộng/trừ kho, ghi tiền, voucher) vẫn chạy. Mọi thao tác "kiểm tra rồi làm" có tác động tiền/kho phải đặt
 * `assertStmt(...)` làm câu lệnh ĐẦU TIÊN của batch: nếu điều kiện không còn đúng tại thời điểm ghi, trigger RAISE
 * 'state_changed' → toàn bộ batch rollback → onError trả 409 `state_changed`.
 *
 * Ví dụ: huỷ đơn POS
 *   db.batch([
 *     assertStmt(db, "order.void", "SELECT status = 'completed' FROM orders WHERE id = ?", [id]),
 *     ...moveStatements(...),             // chỉ chạy khi đơn vẫn 'completed'
 *     db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").bind(id),
 *   ])
 */
export function assertStmt(db: D1Database, code: string, conditionSql: string, binds: unknown[] = []): D1PreparedStatement {
  // conditionSql phải trả về đúng 1 giá trị (1 = được phép). Không có dòng nào → NULL → coi như sai.
  return db.prepare(`INSERT INTO state_guard(code, ok) VALUES (?, COALESCE((${conditionSql}), 0))`).bind(code, ...binds);
}

/**
 * Khoá một lần (idempotency) trong batch: lần thứ hai cùng (scope, key) vi phạm PRIMARY KEY → batch rollback
 * → onError trả 409 `already_done`. Dùng cho chi lương theo kỳ, hoàn tiền theo đơn, idempotency key client gửi.
 */
export function onceStmt(db: D1Database, scope: string, key: string | number): D1PreparedStatement {
  return db.prepare(`INSERT INTO once_keys(scope, key) VALUES (?, ?)`).bind(scope, String(key));
}

/** Dọn các dòng chốt chặn (gọi định kỳ từ cron; dòng ok=1 vô hại nhưng không cần giữ). */
export function cleanupGuardsStmt(db: D1Database) {
  return db.prepare(`DELETE FROM state_guard`);
}
