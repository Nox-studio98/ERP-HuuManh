import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/worker/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, BOOTSTRAP_TOKEN: "test-bootstrap-token", APP_ENV: "dev", ATTENDANCE_QR_SECRET: "" }, // không phụ thuộc .dev.vars
        },
      }),
    ],
    // testTimeout: một số test gọi nhiều API liên tiếp, máy bận có thể vượt mặc định 5 giây
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"], testTimeout: 20000, hookTimeout: 30000 },
  };
});
