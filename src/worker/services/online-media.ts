import type { Context } from "hono";
import type { AppBindings } from "../env";
import { AppError } from "../lib/errors";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Nhận diện ảnh theo magic bytes (không tin phần mở rộng/Content-Type do client gửi). */
export function sniffImage(b: Uint8Array): { ext: "jpg" | "png" | "webp"; type: string } | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { ext: "png", type: "image/png" };
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

/** Đọc file ảnh từ multipart (field `file` hoặc `image`), kiểm tra rồi ghi R2. Trả khoá R2. */
export async function uploadImage(c: Context<AppBindings>, prefix: string): Promise<{ key: string; size: number; type: string }> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) throw new AppError(422, "validation_error", "Cần gửi multipart/form-data với trường file");
  let form: Record<string, string | File | (string | File)[]>;
  try {
    form = await c.req.parseBody();
  } catch {
    throw new AppError(422, "validation_error", "Không đọc được dữ liệu tải lên");
  }
  const f = (form.file ?? form.image) as unknown;
  if (!(f instanceof File)) throw new AppError(422, "validation_error", "Thiếu tệp ảnh (trường file)");
  if (f.size > MAX_IMAGE_BYTES) throw new AppError(422, "file_too_large", "Ảnh tối đa 2 MB", { maxBytes: MAX_IMAGE_BYTES });
  if (f.size === 0) throw new AppError(422, "bad_image", "Tệp ảnh rỗng");
  const bytes = new Uint8Array(await f.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new AppError(422, "bad_image", "Chỉ nhận ảnh JPG, PNG hoặc WebP hợp lệ");
  const declared = f.name.split(".").pop()?.toLowerCase();
  const okExt = kind.ext === "jpg" ? ["jpg", "jpeg"] : [kind.ext];
  if (declared && !okExt.includes(declared)) throw new AppError(422, "bad_image", "Phần mở rộng tệp không khớp nội dung ảnh");
  const key = `${prefix}/${crypto.randomUUID()}.${kind.ext}`;
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: kind.type, cacheControl: "public, max-age=86400" } });
  return { key, size: bytes.length, type: kind.type };
}

export const imageUrl = (key: string | null | undefined) => (key ? `/img/${key}` : null);

/** Slug kebab-case không dấu, duy nhất theo `exists`. */
export async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>, normalize: (s: string) => string) {
  const root = normalize(base).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "muc";
  let slug = root;
  for (let n = 2; await exists(slug); n++) slug = `${root}-${n}`;
  return slug;
}
