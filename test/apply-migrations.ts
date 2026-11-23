import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Chạy migrations trước mỗi file test (idempotent).
await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
