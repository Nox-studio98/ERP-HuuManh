import { Hono } from "hono";
import type { AppBindings } from "../env";

// TODO: hiện thực theo docs/API-dot2.md
export const quoteRoutes = new Hono<AppBindings>();
