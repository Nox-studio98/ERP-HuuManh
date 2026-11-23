import { Hono } from "hono";
import type { AppBindings } from "../env";

// TODO: hiện thực theo docs/API-dot4.md
export const purchasingRoutes = new Hono<AppBindings>();
