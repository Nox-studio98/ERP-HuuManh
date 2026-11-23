import { app } from "../src/worker/index";
import { hashPassword } from "../src/worker/lib/crypto";
import type { Env } from "../src/worker/env";
import { login, PASSWORD, testEnv } from "./helpers";

/** Gọi API với vai trò, tuỳ chọn ghi đè bindings (vd ATTENDANCE_QR_SECRET) và header. */
export async function call<T = any>(role: string, method: string, path: string, body?: unknown, opts: { env?: Partial<Env>; headers?: Record<string, string> } = {}) {
  const token = await login(role);
  const res = await app.request(
    path,
    { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...opts.headers }, body: body === undefined ? undefined : JSON.stringify(body) },
    { ...testEnv, ...opts.env } as Env,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Tạo user + nhân viên liên kết (NV chấm công). */
export async function seedStaff(o: { userId: number; username: string; employeeId: number; role?: string; storeId?: number; exempt?: boolean }) {
  const db = testEnv.DB;
  const hash = await hashPassword(PASSWORD);
  await db.batch([
    db.prepare(`INSERT INTO users(id, username, full_name, pass_hash, role, store_id) VALUES (?,?,?,?,?,?)`).bind(o.userId, o.username, `NV ${o.username}`, hash, o.role ?? "staff", o.storeId ?? 1),
    db.prepare(`INSERT INTO employees(id, code, user_id, full_name, position, store_id, hire_date, location_exempt) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(o.employeeId, `NV-T${o.employeeId}`, o.userId, `NV ${o.username}`, "bán hàng", o.storeId ?? 1, "2026-01-01", o.exempt ? 1 : 0),
  ]);
}
