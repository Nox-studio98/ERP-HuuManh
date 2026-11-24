#!/usr/bin/env node
/**
 * Khôi phục D1 từ bản sao lưu R2 (services/backup.ts): backups/YYYY-MM-DD/manifest.json + <bảng>.part-NNNN.ndjson.gz.
 * Dùng wrangler (cần đã đăng nhập: `wrangler login` hoặc CLOUDFLARE_API_TOKEN).
 *
 *   node scripts/restore-from-r2.mjs --day 2026-11-24 --db huu-manh-erp [--bucket huu-manh-erp-files] [--local | --remote]
 *        [--env demo] [--from-dir ./thu-muc-da-tai] [--out ./restore-tmp] [--max-file-mb 4] [--dry-run]
 *
 * Cách làm: tải manifest + các phần → kiểm sha256 và số dòng → sinh file SQL `INSERT OR REPLACE` theo thứ tự khoá ngoại
 * → `wrangler d1 execute <db> --file ...` từng file. CSDL đích phải ĐÃ có lược đồ (chạy trước: `wrangler d1 migrations apply <db> --remote`).
 * Lưu ý: cột mật khẩu (users.pass_hash) không nằm trong bản sao lưu → sau khôi phục phải đặt lại mật khẩu (POST /auth/bootstrap hoặc
 * quản trị tạo lại) — phiên đăng nhập (sessions) cũng không được sao lưu.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

function parseArgs(argv) {
  const a = { bucket: "huu-manh-erp-files", out: "./restore-tmp", maxFileMb: 4, remote: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--day") a.day = v();
    else if (k === "--db") a.db = v();
    else if (k === "--bucket") a.bucket = v();
    else if (k === "--env") a.env = v();
    else if (k === "--from-dir") a.fromDir = v();
    else if (k === "--out") a.out = v();
    else if (k === "--max-file-mb") a.maxFileMb = Number(v());
    else if (k === "--local") a.remote = false;
    else if (k === "--remote") a.remote = true;
    else if (k === "--dry-run") a.dryRun = true;
    else throw new Error(`Tham số lạ: ${k}`);
  }
  if (!a.day || !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) throw new Error("Thiếu --day YYYY-MM-DD");
  if (!a.db && !a.dryRun) throw new Error("Thiếu --db <tên D1>");
  return a;
}

function wrangler(args, { json = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")} lỗi:\n${r.stderr || r.stdout}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

const q = (n) => `"${String(n).replaceAll('"', '""')}"`;
function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replaceAll("'", "''")}'`;
}
export function rowToInsert(table, row) {
  const cols = Object.keys(row);
  return `INSERT OR REPLACE INTO ${q(table)}(${cols.map(q).join(",")}) VALUES (${cols.map((c) => sqlValue(row[c])).join(",")});`;
}

/** Sắp bảng theo phụ thuộc khoá ngoại (bảng được tham chiếu trước). edges: [[bảng, bảngThamChiếu], ...] */
export function orderTables(names, edges) {
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const [t, ref] of edges) if (deps.has(t) && deps.has(ref) && t !== ref) deps.get(t).add(ref);
  const out = [];
  const seen = new Set();
  const visit = (n, stack = new Set()) => {
    if (seen.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const d of deps.get(n)) visit(d, stack);
    stack.delete(n);
    seen.add(n);
    out.push(n);
  };
  for (const n of [...names].sort()) visit(n);
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  mkdirSync(a.out, { recursive: true });
  const prefix = `backups/${a.day}`;
  const target = [...(a.remote ? ["--remote"] : ["--local"]), ...(a.env ? ["--env", a.env] : [])];

  const fetchObj = (key) => {
    if (a.fromDir) return readFileSync(join(a.fromDir, key.replace(/^backups\/[^/]+\//, "")));
    const dest = join(a.out, key.replaceAll("/", "__"));
    if (!existsSync(dest)) wrangler(["r2", "object", "get", `${a.bucket}/${key}`, "--file", dest, a.remote ? "--remote" : "--local"]);
    return readFileSync(dest);
  };

  const manifest = JSON.parse(fetchObj(`${prefix}/manifest.json`).toString("utf8"));
  console.log(`Bản sao lưu ${manifest.day} (${manifest.createdAt}): ${manifest.tables.length} bảng, ${manifest.totalRows} dòng`);

  // thứ tự khoá ngoại từ chính CSDL đích (nếu hỏi được)
  let order = manifest.tables.map((t) => t.name);
  if (!a.dryRun) {
    try {
      const res = wrangler(["d1", "execute", a.db, ...target, "--json", "--command",
        `SELECT m.name AS t, f."table" AS ref FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type='table'`], { json: true });
      const edges = (res[0]?.results ?? []).map((r) => [r.t, r.ref]);
      order = orderTables(order, edges);
    } catch (e) {
      console.warn("Không đọc được quan hệ khoá ngoại, dùng thứ tự manifest:", String(e.message).split("\n")[0]);
    }
  }
  const byName = new Map(manifest.tables.map((t) => [t.name, t]));

  const files = [];
  let cur = ["PRAGMA defer_foreign_keys = true;"];
  let curBytes = 0;
  const maxBytes = a.maxFileMb * 1024 * 1024;
  const flush = () => {
    if (cur.length <= 1) return;
    const f = join(a.out, `restore-${String(files.length + 1).padStart(4, "0")}.sql`);
    writeFileSync(f, cur.join("\n") + "\n");
    files.push(f);
    cur = ["PRAGMA defer_foreign_keys = true;"];
    curBytes = 0;
  };
  let total = 0;
  for (const name of order) {
    const t = byName.get(name);
    let rows = 0;
    for (const part of t.parts) {
      const gz = fetchObj(part.key);
      const sha = createHash("sha256").update(gz).digest("hex");
      if (sha !== part.sha256) throw new Error(`Sai checksum: ${part.key}`);
      const lines = gunzipSync(gz).toString("utf8").split("\n").filter(Boolean);
      if (lines.length !== part.rows) throw new Error(`Sai số dòng ${part.key}: ${lines.length} ≠ ${part.rows}`);
      for (const line of lines) {
        const stmt = rowToInsert(name, JSON.parse(line));
        cur.push(stmt);
        curBytes += stmt.length;
        rows++;
        if (curBytes >= maxBytes) flush();
      }
    }
    if (rows !== t.rows) throw new Error(`Bảng ${name}: ${rows} dòng ≠ manifest ${t.rows}`);
    total += rows;
  }
  flush();
  console.log(`Đã kiểm tra ${total} dòng; sinh ${files.length} file SQL trong ${a.out}`);
  if (a.dryRun) return console.log("--dry-run: không ghi vào D1.");
  for (const f of files) {
    console.log(`Nạp ${f} ...`);
    wrangler(["d1", "execute", a.db, ...target, "--file", f]);
  }
  console.log("Xong. Đặt lại mật khẩu người dùng (bản sao lưu không chứa pass_hash) và kiểm tra bằng /api/v1/health.");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
