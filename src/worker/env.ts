export interface Env {
  DB: D1Database;
  FILES: R2Bucket; // hoá đơn PDF, file xuất Excel, bản sao lưu
  ASSETS: Fetcher; // SPA tĩnh
  APP_ENV: "dev" | "staging" | "production";
  // Secret (wrangler secret put BOOTSTRAP_TOKEN): dùng một lần để tạo tài khoản chủ
  BOOTSTRAP_TOKEN?: string;
}

export type Role = "owner" | "manager" | "cashier" | "warehouse" | "accountant" | "online_staff";

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  storeId: number | null;
  sessionId: string;
  deviceId: string | null;
}

export type AppBindings = { Bindings: Env; Variables: { user: SessionUser; requestId: string } };
