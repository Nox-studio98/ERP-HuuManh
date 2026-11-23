import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { AppError, onError } from "../../worker/lib/errors";
import type { ShopBindings } from "./env";
import { rateLimit } from "./lib/ratelimit";
import { csrfGuard } from "./lib/session";
import { authRoutes } from "./routes/auth";
import { b2bRoutes } from "./routes/b2b";
import { cartRoutes } from "./routes/cart";
import { catalogRoutes, imgRoutes, seoRoutes } from "./routes/catalog";
import { checkoutRoutes } from "./routes/checkout";
import { meRoutes } from "./routes/me";
import { orderRoutes } from "./routes/orders";
import { paymentRoutes } from "./routes/payments";

const app = new Hono<ShopBindings>();

app.use("*", async (c, next) => {
  c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
  c.set("account", null);
  await next();
});

// CSP như ERP + Turnstile (challenges.cloudflare.com) + ảnh data:/blob:
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://challenges.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://challenges.cloudflare.com"],
      frameSrc: ["https://challenges.cloudflare.com"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    referrerPolicy: "strict-origin-when-cross-origin",
    permissionsPolicy: { camera: [], geolocation: [], microphone: [] },
  }),
);

app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new AppError(422, "payload_too_large", "Dữ liệu quá lớn"); } }));
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
app.use("/api/*", rateLimit);
app.use("/api/*", csrfGuard);

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authRoutes);
app.route("/api", catalogRoutes);
app.route("/api", cartRoutes);
app.route("/api", checkoutRoutes);
app.route("/api", orderRoutes);
app.route("/api", paymentRoutes);
app.route("/api", meRoutes);
app.route("/api", b2bRoutes);
app.route("/", imgRoutes);
app.route("/", seoRoutes);

app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Không tìm thấy" } }, 404));
app.onError(onError);

// Ngoài /api: SPA tĩnh (Workers Static Assets)
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: app.fetch } satisfies ExportedHandler<ShopBindings["Bindings"]>;
export { app };
