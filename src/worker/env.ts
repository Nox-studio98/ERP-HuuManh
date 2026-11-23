export interface Env {
  DB: D1Database;
  FILES: R2Bucket; // hoá đơn PDF, file xuất Excel, bản sao lưu
  ASSETS: Fetcher; // SPA tĩnh
  APP_ENV: "dev" | "staging" | "production";
  // Secret (wrangler secret put BOOTSTRAP_TOKEN): dùng một lần để tạo tài khoản chủ
  BOOTSTRAP_TOKEN?: string;
  // Đợt 2
  JOBS?: Queue<{ jobId: number }>; // outbox → xử lý tích hợp ngoài (MISA, nhắc nợ, Fresco)
  MISA_APP_ID?: string; // secrets hoá đơn điện tử MISA meInvoice
  MISA_TAX_CODE?: string;
  MISA_USERNAME?: string;
  MISA_PASSWORD?: string;
  MISA_BASE_URL?: string; // var: URL API MISA (theo tài liệu MISA cấp cho cửa hàng)
  FRESCO_WEBHOOK_SECRET?: string; // HMAC xác thực webhook sàn Fresco
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
