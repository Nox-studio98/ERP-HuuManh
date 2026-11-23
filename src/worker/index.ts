import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import type { AppBindings, Env } from "./env";
import { onError, AppError } from "./lib/errors";
import { requireAuth } from "./lib/auth";
import { authRoutes } from "./routes/auth";
import { registerModuleRoutes } from "./routes";
import { runScheduled } from "./scheduled";
import { webhookRoutes } from "./routes/webhooks";
import { processJob } from "./services/jobs";

const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
  await next();
});

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    referrerPolicy: "strict-origin-when-cross-origin",
    permissionsPolicy: { camera: ["self"], geolocation: ["self"], microphone: [] },
  }),
);

// Giới hạn body: 1 MB mặc định; riêng upload ảnh (sản phẩm, CMS) 2,5 MB — route tự kiểm ≤ 2 MB + magic bytes.
const UPLOAD_PATH = /^\/api\/v1\/(products\/\d+\/images|cms\/images)$/;
const limitDefault = bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new AppError(422, "payload_too_large"); } });
const limitUpload = bodyLimit({ maxSize: 2.5 * 1024 * 1024, onError: () => { throw new AppError(422, "payload_too_large"); } });
app.use("/api/*", (c, next) => (UPLOAD_PATH.test(c.req.path) ? limitUpload(c, next) : limitDefault(c, next)));
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

app.get("/api/health", (c) => c.json({ ok: true, env: c.env.APP_ENV }));
app.route("/api/auth", authRoutes);
// Webhook công khai (xác thực bằng chữ ký HMAC) — NGOÀI router /api/v1 có đăng nhập, TRƯỚC 404 của /api/*
app.route("/api/integrations", webhookRoutes);

// Mọi route nghiệp vụ dưới /api/v1 đều yêu cầu đăng nhập; quyền chi tiết khai báo từng route bằng requirePerm()
const v1 = new Hono<AppBindings>();
v1.use("*", requireAuth);
registerModuleRoutes(v1);
app.route("/api/v1", v1);

app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Không tìm thấy" } }, 404));
app.onError(onError);

// Ngoài /api: trả SPA tĩnh (Workers Static Assets, not_found_handling = single-page-application)
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runScheduled(event, env)),
  // Queue consumer (outbox integration_jobs): ack khi xong / bỏ qua; retry có trì hoãn khi job thất bại
  async queue(batch: MessageBatch<unknown>, env: Env) {
    for (const msg of batch.messages) {
      try {
        const o = await processJob(env, Number((msg.body as { jobId?: number })?.jobId));
        if (o.status === "failed") msg.retry({ delaySeconds: o.delaySeconds });
        else msg.ack();
      } catch (e) {
        console.error(JSON.stringify({ level: "error", msg: "queue_job_error", jobId: (msg.body as { jobId?: number })?.jobId, err: String((e as Error)?.message).slice(0, 200) }));
        msg.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env>;

export { app };
