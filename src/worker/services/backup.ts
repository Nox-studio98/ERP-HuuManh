import type { Env } from "../env";
import { vnDay } from "../lib/time";
import { getSettingInt } from "./settings";
import { sysAudit } from "./sysaudit";

/**
 * Sao lưu logic D1 → R2 (yêu cầu chung mục 12; audit C-06).
 *  - Danh sách bảng tự sinh từ sqlite_master (mọi bảng nghiệp vụ), trừ bảng hệ thống/tạm: sqlite_*, _cf_*, d1_*, state_guard, sessions, bảng ảo + bảng bóng của chúng.
 *  - Đọc phân trang theo rowid (không SELECT * cả bảng vào RAM); mỗi phần ≤ PART_ROWS dòng, nén gzip → NDJSON gz.
 *  - Khoá: backups/YYYY-MM-DD/<bảng>.part-NNNN.ndjson.gz + backups/YYYY-MM-DD/manifest.json (số dòng + sha256 từng phần).
 *    Manifest được ghi CUỐI CÙNG: có manifest = bản sao lưu đủ.
 *  - Giữ N ngày (settings backup.retention_days, mặc định 90); xoá các thư mục ngày cũ hơn.
 *  - Cột mật khẩu (pass_hash...) bị bỏ khỏi bản sao lưu.
 * Khôi phục: scripts/restore-from-r2.mjs (xem README).
 */
export const PAGE_ROWS = 1000;
export const PART_ROWS = 5000;
const SECRET_COLUMNS = new Set(["pass_hash", "password_hash"]);

export interface BackupPart { key: string; rows: number; bytes: number; sha256: string }
export interface BackupManifest {
  day: string;
  createdAt: string;
  retentionDays: number;
  tables: { name: string; rows: number; parts: BackupPart[] }[];
  totalRows: number;
}

export async function listBackupTables(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name`).all<{ name: string; sql: string | null }>();
  const virtual = results.filter((r) => /^\s*CREATE\s+VIRTUAL/i.test(r.sql ?? "")).map((r) => r.name);
  return results
    .map((r) => r.name)
    .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_") && !n.startsWith("d1_") && n !== "state_guard" && n !== "sessions")
    .filter((n) => !virtual.some((v) => n === v || n.startsWith(v + "_")));
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}
async function sha256Hex(b: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const qi = (n: string) => `"${n.replaceAll('"', '""')}"`;

/** Đọc từng trang của một bảng (theo rowid; bảng WITHOUT ROWID thì phân trang LIMIT/OFFSET). */
async function* readPages(db: D1Database, table: string): AsyncGenerator<Record<string, unknown>[]> {
  let last = 0;
  let useRowid = true;
  let offset = 0;
  for (;;) {
    let rows: Record<string, unknown>[];
    if (useRowid) {
      try {
        const r = await db.prepare(`SELECT rowid AS __rid, * FROM ${qi(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(last, PAGE_ROWS).all<Record<string, unknown>>();
        rows = r.results;
        if (rows.length) last = Number(rows[rows.length - 1].__rid);
        rows = rows.map(({ __rid: _r, ...rest }) => rest);
      } catch {
        useRowid = false;
        continue;
      }
    } else {
      rows = (await db.prepare(`SELECT * FROM ${qi(table)} LIMIT ? OFFSET ?`).bind(PAGE_ROWS, offset).all<Record<string, unknown>>()).results;
      offset += rows.length;
    }
    if (!rows.length) return;
    yield rows;
    if (rows.length < PAGE_ROWS) return;
  }
}

export async function backupToR2(env: Env, day: string = vnDay()): Promise<BackupManifest> {
  const prefix = `backups/${day}/`;
  const tables = await listBackupTables(env.DB);
  const manifest: BackupManifest = { day, createdAt: new Date().toISOString(), retentionDays: await getSettingInt(env.DB, "backup.retention_days", 90), tables: [], totalRows: 0 };
  for (const name of tables) {
    const entry = { name, rows: 0, parts: [] as BackupPart[] };
    let buf: string[] = [];
    const flush = async () => {
      if (!buf.length) return;
      const gz = await gzip(buf.join("\n") + "\n");
      const key = `${prefix}${name}.part-${String(entry.parts.length + 1).padStart(4, "0")}.ndjson.gz`;
      await env.FILES.put(key, gz, { httpMetadata: { contentType: "application/gzip" } });
      entry.parts.push({ key, rows: buf.length, bytes: gz.byteLength, sha256: await sha256Hex(gz) });
      buf = [];
    };
    for await (const page of readPages(env.DB, name)) {
      for (const row of page) {
        for (const col of SECRET_COLUMNS) delete row[col];
        buf.push(JSON.stringify(row));
        entry.rows++;
        if (buf.length >= PART_ROWS) await flush();
      }
    }
    await flush();
    manifest.tables.push(entry);
    manifest.totalRows += entry.rows;
  }
  await env.FILES.put(`${prefix}manifest.json`, JSON.stringify(manifest, null, 1), { httpMetadata: { contentType: "application/json" } });
  const pruned = await pruneBackups(env, day, manifest.retentionDays);
  if (pruned.length) await sysAudit(env.DB, { action: "retention.backup_prune", entity: "backup", after: { removedDays: pruned.length, keepDays: manifest.retentionDays } }).catch(() => {});
  return manifest;
}

/** Xoá thư mục sao lưu cũ hơn `keepDays` ngày (tính từ `today`). */
export async function pruneBackups(env: Env, today: string, keepDays: number): Promise<string[]> {
  if (!(keepDays >= 1)) return [];
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - (keepDays - 1) * 86400_000).toISOString().slice(0, 10);
  const removed: string[] = [];
  let cursor: string | undefined;
  const old = new Set<string>();
  do {
    const l = await env.FILES.list({ prefix: "backups/", delimiter: "/", cursor });
    for (const p of l.delimitedPrefixes) {
      const m = /^backups\/(\d{4}-\d{2}-\d{2})\/$/.exec(p);
      if (m && m[1] < cutoff) old.add(p);
    }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  for (const p of old) {
    let c2: string | undefined;
    do {
      const l = await env.FILES.list({ prefix: p, cursor: c2 });
      if (l.objects.length) await env.FILES.delete(l.objects.map((o) => o.key));
      c2 = l.truncated ? l.cursor : undefined;
    } while (c2);
    removed.push(p);
  }
  return removed;
}
