/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Site key công khai của Cloudflare Turnstile (hoặc đặt <meta name="turnstile-site-key" content="..."> khi triển khai). */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
