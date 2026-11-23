/** Đọc cài đặt dạng số từ bảng settings (ngưỡng duyệt...). */
export async function getSettingInt(db: D1Database, key: string, fallback: number): Promise<number> {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
