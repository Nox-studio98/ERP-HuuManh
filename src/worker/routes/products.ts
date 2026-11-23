import { Hono } from "hono";
import type { AppBindings } from "../env";

// TODO: hiện thực theo docs/API.md
export const productRoutes = new Hono<AppBindings>();
