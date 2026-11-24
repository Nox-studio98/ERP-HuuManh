/** Binding của Shop Worker (huu-manh-shop). Dùng chung D1/R2/Queue với ERP. */
export interface RateLimiterBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface ShopEnv {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  JOBS?: Queue<{ jobId: number }>;
  APP_ENV: "dev" | "staging" | "demo" | "production";
  TURNSTILE_SECRET?: string;
  /** Workers Rate Limiting: chung (120/phút) và nhóm đăng nhập/đăng ký/quên mật khẩu (10/phút). */
  RATE_LIMITER?: RateLimiterBinding;
  RL_AUTH?: RateLimiterBinding;
  PAYMENT_WEBHOOK_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  /** Tuỳ chọn: origin công khai của website (dùng dựng link trong email). Mặc định lấy từ URL request. */
  SHOP_BASE_URL?: string;
}

/** Tài khoản khách đang đăng nhập (đã nạp từ phiên). */
export interface ShopAccount {
  id: number;
  customerId: number;
  email: string;
  phone: string | null;
  fullName: string;
  kind: "retail" | "b2b";
  b2bStatus: "pending" | "approved" | "rejected" | null;
  marketingOptIn: boolean;
  emailVerified: boolean;
  customerGroupId: number | null;
  customerGroup: string | null;
  sessionId: string;
}

export type ShopBindings = {
  Bindings: ShopEnv;
  Variables: { requestId: string; account: ShopAccount | null };
};
