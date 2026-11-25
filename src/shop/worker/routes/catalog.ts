import { Hono } from "hono";
import { notFound } from "../../../worker/lib/errors";
import type { ShopBindings } from "../env";
import { cards, queryCards } from "../lib/catalog";
import { optionalAuth } from "../lib/session";
import { escapeLike, escapeXml, baseUrl, imageUrl, parseImages, safeLink } from "../lib/util";
import { normalizeVi } from "../../../worker/services/online-orders";

export const catalogRoutes = new Hono<ShopBindings>();

const PAGE = 24;
/** A-15: giá hiển thị theo nhóm khách / bảng giá riêng của tài khoản đăng nhập (khách vãng lai: giá chung). */
const priceOf = (c: { get(k: "account"): { customerId: number; customerGroupId: number | null } | null }) => {
  const a = c.get("account");
  return a ? { groupId: a.customerGroupId, customerId: a.customerId } : {};
};

catalogRoutes.get("/home", optionalAuth, async (c) => {
  const db = c.env.DB;
  const pc = priceOf(c);
  const now = new Date().toISOString();
  const [banners, featured, all, posts] = await Promise.all([
    db
      .prepare(
        `SELECT id, title, image_key, link_url FROM cms_banners WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?1) AND (ends_at IS NULL OR ends_at > ?1) ORDER BY sort, id LIMIT 10`,
      )
      .bind(now)
      .all<any>(),
    cards(db, { channel: "online", ...pc, where: ["p.featured = 1"], limit: 8 }),
    queryCards(db, { channel: "online", ...pc, limit: 500 }),
    db
      .prepare(`SELECT slug, title, excerpt, cover_key, published_at FROM cms_posts WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT 4`)
      .all<any>(),
  ]);
  const gids = [...new Set(all.map((x) => x.row.group_id).filter((x) => x != null))] as number[];
  const grp = gids.length
    ? (await db.prepare(`SELECT id, name FROM product_groups WHERE id IN (${gids.map(() => "?").join(",")}) ORDER BY name`).bind(...gids).all<any>()).results
    : [];
  return c.json({
    banners: banners.results.map((b) => ({ id: b.id, title: b.title, imageUrl: imageUrl(b.image_key), linkUrl: safeLink(b.link_url) })),
    featured,
    groups: grp.map((g) => ({ id: g.id, name: g.name })),
    posts: posts.results.map((p) => ({ slug: p.slug, title: p.title, excerpt: p.excerpt, coverUrl: imageUrl(p.cover_key), publishedAt: p.published_at })),
  });
});

catalogRoutes.get("/products", optionalAuth, async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const where: string[] = [];
  const binds: unknown[] = [];
  const ph = (v: unknown) => (binds.push(v), `?${4 + binds.length}`);
  if (q.q?.trim()) {
    const s = q.q.trim().slice(0, 60);
    where.push(`(p.name LIKE ${ph("%" + escapeLike(s) + "%")} ESCAPE '\\' OR p.slug LIKE ${ph("%" + escapeLike(normalizeVi(s).replace(/ /g, "-")) + "%")} ESCAPE '\\')`);
  }
  if (q.groupId && /^\d+$/.test(q.groupId)) where.push(`p.group_id = ${ph(Number(q.groupId))}`);
  const order =
    q.sort === "price_asc" ? "p.price ASC, p.id" : q.sort === "price_desc" ? "p.price DESC, p.id" : q.sort === "new" ? "p.id DESC" : "p.featured DESC, p.online_sort ASC, p.id ASC";
  const offset = q.cursor && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
  const rows = await cards(db, { channel: "online", ...priceOf(c), where, binds, order, limit: PAGE + 1, offset });
  return c.json({ items: rows.slice(0, PAGE), nextCursor: rows.length > PAGE ? String(offset + PAGE) : null });
});

catalogRoutes.get("/products/:slug", optionalAuth, async (c) => {
  const db = c.env.DB;
  const pc = priceOf(c);
  const slug = c.req.param("slug").slice(0, 200);
  const [hit] = await queryCards(db, { channel: "online", ...pc, where: ["p.slug = ?5"], binds: [slug], limit: 1 });
  if (!hit) throw notFound("product_not_found", "Không tìm thấy sản phẩm");
  const related = hit.row.group_id
    ? await cards(db, { channel: "online", ...pc, where: ["p.group_id = ?5", "p.id <> ?6"], binds: [hit.row.group_id, hit.row.id], limit: 4 })
    : [];
  return c.json({
    ...hit.card,
    description: hit.row.description ?? "",
    images: parseImages(hit.row.images_json).map((k) => `/img/${k}`),
    groupName: hit.row.group_name ?? null,
    related,
  });
});

catalogRoutes.get("/posts/:slug", async (c) => {
  const p = await c.env.DB.prepare(`SELECT slug, title, excerpt, body_md, cover_key, published_at FROM cms_posts WHERE slug = ? AND status = 'published'`)
    .bind(c.req.param("slug"))
    .first<any>();
  if (!p) throw notFound("post_not_found", "Không tìm thấy bài viết");
  return c.json({ slug: p.slug, title: p.title, excerpt: p.excerpt, bodyMd: p.body_md, coverUrl: imageUrl(p.cover_key), publishedAt: p.published_at });
});

// ===== ảnh R2 =====
const IMG_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif",
};

export const imgRoutes = new Hono<ShopBindings>();
imgRoutes.get("/img/*", async (c) => {
  let key: string;
  try {
    key = decodeURIComponent(c.req.path.slice("/img/".length));
  } catch {
    throw notFound();
  }
  const bad = !key || key.includes("..") || key.includes("\\") || key.includes("\0") || key.startsWith("/") || key.includes("//");
  if (bad || !(key.startsWith("products/") || key.startsWith("cms/"))) throw notFound();
  const type = IMG_TYPES[key.split(".").pop()!.toLowerCase()];
  if (!type) throw notFound();
  const obj = await c.env.FILES.get(key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      ...(obj.httpEtag ? { ETag: obj.httpEtag } : {}),
    },
  });
});

export const seoRoutes = new Hono<ShopBindings>();
seoRoutes.get("/robots.txt", (c) =>
  c.text(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /ncc\nSitemap: ${baseUrl(c)}/sitemap.xml\n`),
);
seoRoutes.get("/sitemap.xml", async (c) => {
  const db = c.env.DB;
  const base = baseUrl(c);
  const prods = await db.prepare(`SELECT slug FROM products WHERE active = 1 AND published_online = 1 AND slug IS NOT NULL AND merged_into IS NULL ORDER BY id LIMIT 5000`).all<{ slug: string }>();
  const posts = await db.prepare(`SELECT slug, published_at FROM cms_posts WHERE status = 'published' ORDER BY id LIMIT 5000`).all<{ slug: string; published_at: string | null }>();
  const url = (loc: string, lastmod?: string | null) => `<url><loc>${escapeXml(base + loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod.slice(0, 10))}</lastmod>` : ""}</url>`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    url("/") +
    prods.results.map((p) => url(`/san-pham/${encodeURIComponent(p.slug)}`)).join("") +
    posts.results.map((p) => url(`/bai-viet/${encodeURIComponent(p.slug)}`, p.published_at)).join("") +
    `</urlset>`;
  return c.body(xml, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
});
