import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("./src/shop/web"),
  plugins: [react(), cloudflare({ configPath: here("./wrangler.shop.jsonc") })],
  build: { outDir: here("./dist-shop"), emptyOutDir: true },
});
