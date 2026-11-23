import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { requirePerm } from "../lib/rbac";
import { AppError, conflict, notFound } from "../lib/errors";
import { auditStmt } from "../lib/audit";
import { guarded, parseBody } from "../services/http";
import { normalizeVi } from "../services/online-orders";
import { resolvePrice } from "../services/pricing";
import { imageUrl, uniqueSlug, uploadImage } from "../services/online-media";

export const cmsRoutes = new Hono<AppBindings>();
type Ctx = Context<AppBindings>;
const id = (c: Ctx, name = "id") => Number(c.req.param(name));
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "Thời điểm phải dạng ISO");

// ====================================================================== sản phẩm hiển thị online (M8-01, M8-10)

const imagesOf = (p: any): string[] => {
  try { return p.images_json ? (JSON.parse(p.images_json) as string[]) : []; } catch { return []; }
};

async function productOnline(c: Ctx, pid: number) {
  const db = c.env.DB;
  const p = await db.prepare(`SELECT id, name, active, slug, description, images_json, published_online, featured, allow_preorder, online_sort, online_step_milli FROM products WHERE id=?`).bind(pid).first<any>();
  if (!p) throw notFound("product_not_found", "Không tìm thấy sản phẩm");
  const hasPrice = await resolvePrice(db, pid, { channel: "online" }).then(() => true, () => false);
  return {
    id: p.id,
    name: p.name,
    active: !!p.active,
    slug: p.slug,
    description: p.description,
    publishedOnline: !!p.published_online,
    featured: !!p.featured,
    allowPreorder: !!p.allow_preorder,
    onlineSort: p.online_sort,
    onlineStepMilli: p.online_step_milli,
    hasOnlinePrice: hasPrice,
    images: imagesOf(p).map((key) => ({ key, url: imageUrl(key) })),
  };
}

cmsRoutes.get("/products/:id/online", requirePerm("products.write"), async (c) => c.json(await productOnline(c, id(c))));

const onlineBody = z.object({
  slug: z.string().trim().max(100).nullish(),
  description: z.string().max(20000).nullish(),
  publishedOnline: z.boolean().optional(),
  featured: z.boolean().optional(),
  allowPreorder: z.boolean().optional(),
  onlineSort: z.number().int().min(-100000).max(100000).optional(),
  onlineStepMilli: z.number().int().min(1).max(1_000_000).nullish(),
});

cmsRoutes.put("/products/:id/online", requirePerm("products.write"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, onlineBody);
  const db = c.env.DB;
  const p = await db.prepare(`SELECT * FROM products WHERE id=?`).bind(pid).first<any>();
  if (!p) throw notFound("product_not_found", "Không tìm thấy sản phẩm");
  let slug: string | null = p.slug;
  const wanted = b.slug === undefined ? p.slug : b.slug?.trim() || null;
  if (wanted) {
    if (!SLUG.test(wanted)) throw new AppError(422, "validation_error", "slug chỉ gồm chữ thường, số và dấu gạch ngang");
    if (await db.prepare(`SELECT 1 AS x FROM products WHERE slug=? AND id<>?`).bind(wanted, pid).first()) throw conflict("duplicate_slug", "Slug đã được dùng");
    slug = wanted;
  } else {
    // slug trống → tự sinh từ tên (bỏ dấu, kebab, thêm -2, -3 nếu trùng)
    slug = await uniqueSlug(p.name, async (s) => !!(await db.prepare(`SELECT 1 AS x FROM products WHERE slug=? AND id<>?`).bind(s, pid).first()), normalizeVi);
  }
  await guarded(() =>
    db.batch([
      db
        .prepare(
          `UPDATE products SET slug=?, description=?, published_online=?, featured=?, allow_preorder=?, online_sort=?, online_step_milli=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        )
        .bind(
          slug,
          b.description === undefined ? p.description : b.description,
          b.publishedOnline === undefined ? p.published_online : b.publishedOnline ? 1 : 0,
          b.featured === undefined ? p.featured : b.featured ? 1 : 0,
          b.allowPreorder === undefined ? p.allow_preorder : b.allowPreorder ? 1 : 0,
          b.onlineSort ?? p.online_sort,
          b.onlineStepMilli === undefined ? p.online_step_milli : b.onlineStepMilli,
          pid,
        ),
      auditStmt(c, { action: "product.online_update", entity: "product", entityId: pid, before: { slug: p.slug, published: p.published_online }, after: { slug, ...b, description: undefined } }),
    ]),
  );
  return c.json(await productOnline(c, pid));
});

cmsRoutes.post("/products/:id/images", requirePerm("products.write"), async (c) => {
  const pid = id(c);
  const db = c.env.DB;
  const p = await db.prepare(`SELECT id, images_json FROM products WHERE id=?`).bind(pid).first<any>();
  if (!p) throw notFound("product_not_found", "Không tìm thấy sản phẩm");
  if (imagesOf(p).length >= 10) throw conflict("too_many_images", "Tối đa 10 ảnh cho mỗi sản phẩm");
  const up = await uploadImage(c, `products/${pid}`);
  // đọc lại ngay trước khi ghi để giảm xung đột khi hai người cùng tải ảnh
  const cur = imagesOf(await db.prepare(`SELECT images_json FROM products WHERE id=?`).bind(pid).first<any>());
  await db.batch([
    db.prepare(`UPDATE products SET images_json=? WHERE id=?`).bind(JSON.stringify([...cur, up.key]), pid),
    auditStmt(c, { action: "product.image_add", entity: "product", entityId: pid, after: { key: up.key, size: up.size } }),
  ]);
  return c.json(await productOnline(c, pid), 201);
});

cmsRoutes.put("/products/:id/images/order", requirePerm("products.write"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, z.object({ order: z.array(z.number().int().min(0)).max(10) }));
  const p = await c.env.DB.prepare(`SELECT id, images_json FROM products WHERE id=?`).bind(pid).first<any>();
  if (!p) throw notFound("product_not_found", "Không tìm thấy sản phẩm");
  const cur = imagesOf(p);
  const sorted = [...b.order].sort((x, y) => x - y);
  if (b.order.length !== cur.length || sorted.some((v, i) => v !== i)) throw new AppError(422, "validation_error", "order phải là hoán vị của các chỉ số ảnh hiện có");
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE products SET images_json=? WHERE id=?`).bind(JSON.stringify(b.order.map((i) => cur[i])), pid),
    auditStmt(c, { action: "product.image_reorder", entity: "product", entityId: pid, after: { order: b.order } }),
  ]);
  return c.json(await productOnline(c, pid));
});

cmsRoutes.delete("/products/:id/images/:idx", requirePerm("products.write"), async (c) => {
  const pid = id(c);
  const idx = id(c, "idx");
  const p = await c.env.DB.prepare(`SELECT id, images_json FROM products WHERE id=?`).bind(pid).first<any>();
  if (!p) throw notFound("product_not_found", "Không tìm thấy sản phẩm");
  const cur = imagesOf(p);
  if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) throw notFound("image_not_found", "Không tìm thấy ảnh");
  const [gone] = cur.splice(idx, 1);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE products SET images_json=? WHERE id=?`).bind(JSON.stringify(cur), pid),
    auditStmt(c, { action: "product.image_delete", entity: "product", entityId: pid, before: { key: gone } }),
  ]);
  if (gone.startsWith(`products/${pid}/`)) await c.env.FILES.delete(gone).catch(() => undefined);
  return c.json(await productOnline(c, pid));
});

// ====================================================================== CMS: ảnh, banner, bài viết (M8-10)

cmsRoutes.post("/cms/images", requirePerm("products.write"), async (c) => {
  const up = await uploadImage(c, "cms");
  await auditStmt(c, { action: "cms.image_upload", entity: "cms_image", entityId: up.key, after: { size: up.size } }).run();
  return c.json({ key: up.key, url: imageUrl(up.key) }, 201);
});

const cmsKey = z.string().regex(/^cms\/[0-9a-f-]{36}\.(jpg|png|webp)$/, "imageKey phải là khoá ảnh trong cms/ do /cms/images trả về");
/** Chỉ đường dẫn nội bộ: bắt đầu "/", không "//", không "\", không ký tự điều khiển (chống open redirect). */
const linkUrl = z
  .string()
  .max(300)
  .refine((u) => u.startsWith("/") && !u.startsWith("//") && !u.includes("\\") && !/[\u0000-\u001f\u007f]/.test(u), "link_url chỉ nhận đường dẫn nội bộ bắt đầu bằng /");

const bannerBody = z.object({
  title: z.string().trim().min(1).max(200),
  imageKey: cmsKey,
  linkUrl: linkUrl.nullish(),
  sort: z.number().int().min(-100000).max(100000).default(0),
  startsAt: ISO.nullish(),
  endsAt: ISO.nullish(),
  active: z.boolean().default(true),
});
const bannerView = (b: any) => ({ id: b.id, title: b.title, imageKey: b.image_key, imageUrl: imageUrl(b.image_key), linkUrl: b.link_url, sort: b.sort, startsAt: b.starts_at, endsAt: b.ends_at, active: !!b.active });

cmsRoutes.get("/cms/banners", requirePerm("products.write"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM cms_banners ORDER BY sort, id`).all<any>();
  return c.json({ items: results.map(bannerView) });
});
cmsRoutes.post("/cms/banners", requirePerm("products.write"), async (c) => {
  const b = await parseBody(c, bannerBody);
  const r = await c.env.DB.prepare(`INSERT INTO cms_banners(title, image_key, link_url, sort, starts_at, ends_at, active) VALUES (?,?,?,?,?,?,?) RETURNING *`)
    .bind(b.title, b.imageKey, b.linkUrl ?? null, b.sort, b.startsAt ?? null, b.endsAt ?? null, b.active ? 1 : 0).first<any>();
  await auditStmt(c, { action: "cms.banner_create", entity: "cms_banner", entityId: r.id, after: b }).run();
  return c.json(bannerView(r), 201);
});
cmsRoutes.put("/cms/banners/:id", requirePerm("products.write"), async (c) => {
  const bid = id(c);
  const b = await parseBody(c, bannerBody);
  const before = await c.env.DB.prepare(`SELECT * FROM cms_banners WHERE id=?`).bind(bid).first<any>();
  if (!before) throw notFound("banner_not_found", "Không tìm thấy banner");
  const r = await c.env.DB.prepare(`UPDATE cms_banners SET title=?, image_key=?, link_url=?, sort=?, starts_at=?, ends_at=?, active=? WHERE id=? RETURNING *`)
    .bind(b.title, b.imageKey, b.linkUrl ?? null, b.sort, b.startsAt ?? null, b.endsAt ?? null, b.active ? 1 : 0, bid).first<any>();
  await auditStmt(c, { action: "cms.banner_update", entity: "cms_banner", entityId: bid, before: bannerView(before), after: b }).run();
  if (before.image_key !== b.imageKey) await c.env.FILES.delete(before.image_key).catch(() => undefined);
  return c.json(bannerView(r));
});
cmsRoutes.delete("/cms/banners/:id", requirePerm("products.write"), async (c) => {
  const bid = id(c);
  const before = await c.env.DB.prepare(`SELECT * FROM cms_banners WHERE id=?`).bind(bid).first<any>();
  if (!before) throw notFound("banner_not_found", "Không tìm thấy banner");
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM cms_banners WHERE id=?`).bind(bid),
    auditStmt(c, { action: "cms.banner_delete", entity: "cms_banner", entityId: bid, before: bannerView(before) }),
  ]);
  if (before.image_key.startsWith("cms/")) await c.env.FILES.delete(before.image_key).catch(() => undefined);
  return c.json({ ok: true });
});

const postBody = z.object({
  slug: z.string().trim().max(120).nullish(),
  title: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().max(500).nullish(),
  bodyMd: z.string().min(1).max(100_000),
  coverKey: cmsKey.nullish(),
  status: z.enum(["draft", "published"]).default("draft"),
});
const postView = (p: any, full = true) => ({
  id: p.id, slug: p.slug, title: p.title, excerpt: p.excerpt, coverKey: p.cover_key, coverUrl: imageUrl(p.cover_key), status: p.status,
  publishedAt: p.published_at, updatedAt: p.updated_at, ...(full ? { bodyMd: p.body_md } : {}),
});

async function postSlug(db: D1Database, wanted: string | null | undefined, title: string, selfId: number | null) {
  const exists = async (s: string) => !!(await db.prepare(`SELECT 1 AS x FROM cms_posts WHERE slug=? AND id<>?`).bind(s, selfId ?? 0).first());
  if (wanted) {
    if (!SLUG.test(wanted)) throw new AppError(422, "validation_error", "slug chỉ gồm chữ thường, số và dấu gạch ngang");
    if (await exists(wanted)) throw conflict("duplicate_slug", "Slug đã được dùng");
    return wanted;
  }
  return uniqueSlug(title, exists, normalizeVi);
}

cmsRoutes.get("/cms/posts", requirePerm("products.write"), async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM cms_posts ORDER BY id DESC LIMIT 200`).all<any>();
  return c.json({ items: results.map((p) => postView(p, false)) });
});
cmsRoutes.get("/cms/posts/:id", requirePerm("products.write"), async (c) => {
  const p = await c.env.DB.prepare(`SELECT * FROM cms_posts WHERE id=?`).bind(id(c)).first<any>();
  if (!p) throw notFound("post_not_found", "Không tìm thấy bài viết");
  return c.json(postView(p));
});
cmsRoutes.post("/cms/posts", requirePerm("products.write"), async (c) => {
  const b = await parseBody(c, postBody);
  const db = c.env.DB;
  const slug = await postSlug(db, b.slug?.trim() || null, b.title, null);
  const now = new Date().toISOString();
  const r = await guarded(() =>
    db.prepare(`INSERT INTO cms_posts(slug, title, excerpt, body_md, cover_key, status, published_at, created_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`)
      .bind(slug, b.title, b.excerpt ?? null, b.bodyMd, b.coverKey ?? null, b.status, b.status === "published" ? now : null, c.get("user").id, now).first<any>(),
  );
  await auditStmt(c, { action: "cms.post_create", entity: "cms_post", entityId: r.id, after: { slug, status: b.status } }).run();
  return c.json(postView(r), 201);
});
cmsRoutes.put("/cms/posts/:id", requirePerm("products.write"), async (c) => {
  const pid = id(c);
  const b = await parseBody(c, postBody);
  const db = c.env.DB;
  const before = await db.prepare(`SELECT * FROM cms_posts WHERE id=?`).bind(pid).first<any>();
  if (!before) throw notFound("post_not_found", "Không tìm thấy bài viết");
  const slug = b.slug?.trim() ? await postSlug(db, b.slug.trim(), b.title, pid) : before.slug;
  const now = new Date().toISOString();
  const publishedAt = b.status === "published" ? before.published_at ?? now : before.published_at;
  const r = await guarded(() =>
    db.prepare(`UPDATE cms_posts SET slug=?, title=?, excerpt=?, body_md=?, cover_key=?, status=?, published_at=?, updated_at=? WHERE id=? RETURNING *`)
      .bind(slug, b.title, b.excerpt ?? null, b.bodyMd, b.coverKey ?? null, b.status, publishedAt, now, pid).first<any>(),
  );
  await auditStmt(c, { action: "cms.post_update", entity: "cms_post", entityId: pid, before: { slug: before.slug, status: before.status }, after: { slug, status: b.status } }).run();
  if (before.cover_key && before.cover_key !== (b.coverKey ?? null)) await c.env.FILES.delete(before.cover_key).catch(() => undefined);
  return c.json(postView(r));
});
cmsRoutes.delete("/cms/posts/:id", requirePerm("products.write"), async (c) => {
  const pid = id(c);
  const before = await c.env.DB.prepare(`SELECT * FROM cms_posts WHERE id=?`).bind(pid).first<any>();
  if (!before) throw notFound("post_not_found", "Không tìm thấy bài viết");
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM cms_posts WHERE id=?`).bind(pid),
    auditStmt(c, { action: "cms.post_delete", entity: "cms_post", entityId: pid, before: { slug: before.slug, title: before.title } }),
  ]);
  if (before.cover_key?.startsWith("cms/")) await c.env.FILES.delete(before.cover_key).catch(() => undefined);
  return c.json({ ok: true });
});
