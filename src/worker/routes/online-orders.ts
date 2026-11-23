import { Hono } from "hono";
import type { AppBindings } from "../env";

// TODO: hiện thực theo docs/API-dot3.md (phần ERP)
export const onlineOrderRoutes = new Hono<AppBindings>();
