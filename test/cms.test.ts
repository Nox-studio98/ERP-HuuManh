import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/worker/index";
import { api, login, seedBase, testEnv } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

async function upload(role: string, path: string, bytes: Uint8Array | string, name: string, field = "file") {
  const form = new FormData();
  form.append(field, new File([bytes as BlobPart], name, { type: "image/png" }));
  const res = await app.request(path, { method: "POST", headers: { authorization: `Bearer ${await login(role)}` }, body: form }, testEnv);
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await seedBase();
  const d = testEnv.DB;
  await d.batch([
    d.prepare(`INSERT INTO products(id, sku, name, base_unit) VALUES (701,'CSC1','Cam sành Cao Phong','kg'),(702,'CSC2','Cam sành Cao Phong','kg'),(703,'XOAI','Xoài Cát Hoà Lộc','kg')`),
  ]);
});

describe("sản phẩm online (M8-01)", () => {
  it("slug is generated from the name (no accents, kebab) and kept unique", async () => {
    const a = await api("manager", "PUT", "/api/v1/products/701/online", { publishedOnline: true, featured: true, description: "Cam ngọt", onlineStepMilli: 500 });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ slug: "cam-sanh-cao-phong", publishedOnline: true, featured: true, allowPreorder: false, onlineStepMilli: 500, description: "Cam ngọt", hasOnlinePrice: false, images: [] });
    const b = await api("manager", "PUT", "/api/v1/products/702/online", {});
    expect(b.body.slug).toBe("cam-sanh-cao-phong-2");
    const again = await api("manager", "PUT", "/api/v1/products/701/online", { allowPreorder: true });
    expect(again.body).toMatchObject({ slug: "cam-sanh-cao-phong", allowPreorder: true, publishedOnline: true });
    const x = await api("manager", "PUT", "/api/v1/products/703/online", { slug: "xoai-cat" });
    expect(x.body.slug).toBe("xoai-cat");
    expect((await api("manager", "PUT", "/api/v1/products/703/online", { slug: "cam-sanh-cao-phong" })).status).toBe(409);
    expect((await api("manager", "PUT", "/api/v1/products/703/online", { slug: "Xoài Cát!" })).status).toBe(422);
    expect((await api("manager", "GET", "/api/v1/products/701/online")).body.slug).toBe("cam-sanh-cao-phong");
    expect((await api("cashier", "GET", "/api/v1/products/701/online")).status).toBe(403);
    expect((await api("manager", "GET", "/api/v1/products/99999/online")).status).toBe(404);
  });
});

describe("tải ảnh (magic bytes, ≤ 2MB)", () => {
  it("accepts jpg/png/webp, stores in R2 with content type and a products/<id>/<uuid>.<ext> key", async () => {
    const r = await upload("manager", "/api/v1/products/701/images", PNG, "cam.png");
    expect(r.status).toBe(201);
    const key = r.body.images[0].key as string;
    expect(key).toMatch(/^products\/701\/[0-9a-f-]{36}\.png$/);
    expect(r.body.images[0].url).toBe(`/img/${key}`);
    const obj = await testEnv.FILES.get(key);
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
    expect((await upload("manager", "/api/v1/products/701/images", JPG, "a.JPEG")).status).toBe(201);
    const w = await upload("manager", "/api/v1/products/701/images", WEBP, "a.webp");
    expect(w.body.images.map((i: any) => i.key.split(".").pop())).toEqual(["png", "jpg", "webp"]);
    expect((await testEnv.FILES.get(w.body.images[1].key))?.httpMetadata?.contentType).toBe("image/jpeg");
  });

  it("rejects fake extension, mismatched type, empty and oversize files", async () => {
    const fake = await upload("manager", "/api/v1/products/702/images", "<html><script>alert(1)</script></html>", "evil.jpg");
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe("bad_image");
    expect((await upload("manager", "/api/v1/products/702/images", PNG, "x.jpg")).body.error.code).toBe("bad_image"); // png giả đuôi jpg
    expect((await upload("manager", "/api/v1/products/702/images", PNG, "x.svg")).status).toBe(422);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    const o = await upload("manager", "/api/v1/products/702/images", big, "big.png");
    expect(o.status).toBe(422);
    expect(["file_too_large", "payload_too_large"]).toContain(o.body.error.code);
    expect((await upload("manager", "/api/v1/products/702/images", new Uint8Array(), "e.png")).status).toBe(422);
    expect((await upload("cashier", "/api/v1/products/702/images", PNG, "c.png")).status).toBe(403);
    const none = await api("manager", "POST", "/api/v1/products/702/images", {});
    expect(none.status).toBe(422);
    expect((await api("manager", "GET", "/api/v1/products/702/online")).body.images).toEqual([]);
  });

  it("reorders and deletes images (R2 object removed)", async () => {
    const before = (await api("manager", "GET", "/api/v1/products/701/online")).body.images.map((i: any) => i.key) as string[];
    expect((await api("manager", "PUT", "/api/v1/products/701/images/order", { order: [0, 0, 1] })).status).toBe(422);
    const re = await api("manager", "PUT", "/api/v1/products/701/images/order", { order: [2, 0, 1] });
    expect(re.body.images.map((i: any) => i.key)).toEqual([before[2], before[0], before[1]]);
    const del = await api("manager", "DELETE", "/api/v1/products/701/images/0");
    expect(del.body.images.map((i: any) => i.key)).toEqual([before[0], before[1]]);
    expect(await testEnv.FILES.get(before[2])).toBeNull();
    expect((await api("manager", "DELETE", "/api/v1/products/701/images/9")).status).toBe(404);
  });
});

describe("CMS banner + bài viết (M8-10)", () => {
  it("banner: link_url must be an internal path; image must be a cms/ key", async () => {
    const up = await upload("manager", "/api/v1/cms/images", JPG, "banner.jpg");
    expect(up.status).toBe(201);
    expect(up.body.key).toMatch(/^cms\/[0-9a-f-]{36}\.jpg$/);
    const ok = await api("manager", "POST", "/api/v1/cms/banners", { title: "Khuyến mãi", imageKey: up.body.key, linkUrl: "/khuyen-mai", sort: 1 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: "Khuyến mãi", linkUrl: "/khuyen-mai", imageUrl: `/img/${up.body.key}`, active: true });
    for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)", "/\\evil.com", "evil", "/a\nb"]) {
      const r = await api("manager", "POST", "/api/v1/cms/banners", { title: "x", imageKey: up.body.key, linkUrl: bad });
      expect(r.status, bad).toBe(422);
    }
    expect((await api("manager", "POST", "/api/v1/cms/banners", { title: "x", imageKey: "products/701/a.png" })).status).toBe(422);
    const upd = await api("manager", "PUT", `/api/v1/cms/banners/${ok.body.id}`, { title: "KM 2", imageKey: up.body.key, linkUrl: null, active: false });
    expect(upd.body).toMatchObject({ title: "KM 2", linkUrl: null, active: false });
    expect((await api("manager", "GET", "/api/v1/cms/banners")).body.items).toHaveLength(1);
    expect((await api("online_staff", "GET", "/api/v1/cms/banners")).status).toBe(403);
    expect((await api("manager", "DELETE", `/api/v1/cms/banners/${ok.body.id}`)).status).toBe(200);
    expect(await testEnv.FILES.get(up.body.key)).toBeNull();
    expect((await api("manager", "DELETE", `/api/v1/cms/banners/${ok.body.id}`)).status).toBe(404);
  });

  it("posts: auto slug, unique suffix, publish timestamp, CRUD", async () => {
    const a = await api("manager", "POST", "/api/v1/cms/posts", { title: "Cách chọn cam ngon", bodyMd: "# Cam\n\n**ngọt**", excerpt: "Mẹo", status: "draft" });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ slug: "cach-chon-cam-ngon", status: "draft", publishedAt: null, bodyMd: "# Cam\n\n**ngọt**" });
    const b = await api("manager", "POST", "/api/v1/cms/posts", { title: "Cách chọn cam ngon", bodyMd: "x", status: "published" });
    expect(b.body.slug).toBe("cach-chon-cam-ngon-2");
    expect(b.body.publishedAt).toBeTruthy();
    expect((await api("manager", "POST", "/api/v1/cms/posts", { slug: "cach-chon-cam-ngon", title: "t", bodyMd: "x" })).status).toBe(409);
    const pub = await api("manager", "PUT", `/api/v1/cms/posts/${a.body.id}`, { title: "Cách chọn cam ngon nhất", bodyMd: "mới", status: "published" });
    expect(pub.body).toMatchObject({ slug: "cach-chon-cam-ngon", title: "Cách chọn cam ngon nhất", status: "published" });
    expect(pub.body.publishedAt).toBeTruthy();
    expect((await api("manager", "GET", "/api/v1/cms/posts")).body.items[0].bodyMd).toBeUndefined();
    expect((await api("manager", "GET", `/api/v1/cms/posts/${a.body.id}`)).body.bodyMd).toBe("mới");
    expect((await api("manager", "DELETE", `/api/v1/cms/posts/${a.body.id}`)).status).toBe(200);
    expect((await api("manager", "GET", `/api/v1/cms/posts/${a.body.id}`)).status).toBe(404);
  });
});

describe("ERP /img route", () => {
  it("serves product images and blocks other prefixes / traversal", async () => {
    const { testEnv } = await import("./helpers");
    const { app } = await import("../src/worker/index");
    await testEnv.FILES.put("products/1/x.png", new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: "image/png" } });
    await testEnv.FILES.put("backups/secret.ndjson", "secret");
    expect((await app.request("/img/products/1/x.png", {}, testEnv)).status).toBe(200);
    expect((await app.request("/img/backups/secret.ndjson", {}, testEnv)).status).toBe(404);
    expect((await app.request("/img/products/../backups/secret.ndjson", {}, testEnv)).status).toBe(404);
  });
});
