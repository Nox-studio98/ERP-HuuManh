import { lineAmount } from "../lib/money";
import { currentAvgCost } from "./pricing";
import { getSettingInt } from "./settings";

/**
 * Engine khuyến mãi dùng chung POS + website + đơn online (M1-08, M3-08, M8-11).
 * Chỉ ĐỌC DB (không ghi) và xác định (cùng đầu vào + cùng dữ liệu → cùng kết quả).
 * Việc ghi (order_discounts, voucher_redemptions, used_count...) do bên gọi đưa vào cùng batch với đơn (xem promo-checkout.ts).
 */

export type PromoChannel = "pos" | "online" | "b2b";

export interface EngineLine {
  productId: number;
  groupId: number | null;
  qtyMilli: number;
  unitPrice: number;
  lineTotal: number;
}

export interface EngineInput {
  channel: PromoChannel;
  customerId?: number | null;
  lines: EngineLine[];
  subtotal: number;
  voucherCode?: string | null;
  at?: string;
}

export interface AppliedDiscount {
  promotionId: number;
  voucherId?: number;
  amount: number;
  description: string;
  /** Phần giảm phân bổ theo từng dòng (cùng thứ tự `lines` đầu vào) — để ghi order_lines.discount. */
  lineShares: number[];
  /** Có bị cắt để không thấp hơn giá vốn hiện tại không. */
  clipped?: boolean;
}

export interface EngineResult {
  discounts: AppliedDiscount[];
  total: number;
  rejected: { code: string; reason: string }[];
  /** Tổng giảm theo từng dòng (cùng thứ tự `lines`). */
  lineDiscounts: number[];
}

interface PromoRow {
  id: number;
  code: string;
  name: string;
  kind: "percent" | "amount" | "fixed_price" | "combo" | "end_of_day";
  channels: string;
  value_bp: number | null;
  value_amount: number | null;
  min_order: number;
  max_discount: number | null;
  starts_at: string;
  ends_at: string;
  daily_start: string | null;
  daily_end: string | null;
  requires_voucher: number;
  stackable: number;
  priority: number;
  status: string;
}

interface ItemRow {
  promotion_id: number;
  product_id: number | null;
  product_group_id: number | null;
  qty_milli: number | null;
}

interface VoucherRow {
  id: number;
  code: string;
  promotion_id: number;
  max_uses: number | null;
  per_customer_limit: number;
  used_count: number;
  customer_id: number | null;
  active: number;
}

const VN_OFFSET_MS = 7 * 3600_000;

const hhmm = (s: string | null) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Khung giờ trong ngày theo giờ Việt Nam; hỗ trợ khung qua nửa đêm (22:00–02:00). */
export function inDailyWindow(p: Pick<PromoRow, "daily_start" | "daily_end">, atMs: number) {
  const s = hhmm(p.daily_start);
  const e = hhmm(p.daily_end);
  if (s == null || e == null) return true;
  const d = new Date(atMs + VN_OFFSET_MS);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

export const normalizeVoucherCode = (c: string) => c.trim().toUpperCase();

/** Chia `total` theo trọng số, phần dư dồn vào dòng có trọng số cuối cùng. */
export function allocate(total: number, weights: number[]): number[] {
  const out = weights.map(() => 0);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || sum <= 0) return out;
  let last = -1;
  weights.forEach((w, i) => (w > 0 ? (last = i) : 0));
  let given = 0;
  weights.forEach((w, i) => {
    if (w <= 0) return;
    const share = i === last ? total - given : Math.floor((total * w) / sum);
    out[i] = share;
    given += share;
  });
  return out;
}

/** Sàn giá vốn từng dòng: lineAmount(giá vốn bình quân hiện tại, số lượng); chưa có tồn/giá vốn → 0. */
export async function costFloors(db: D1Database, lines: Pick<EngineLine, "productId" | "qtyMilli">[]): Promise<number[]> {
  const cache = new Map<number, number | null>();
  const out: number[] = [];
  for (const l of lines) {
    if (!cache.has(l.productId)) cache.set(l.productId, await currentAvgCost(db, l.productId));
    const c = cache.get(l.productId);
    out.push(c == null ? 0 : lineAmount(c, l.qtyMilli));
  }
  return out;
}

interface Computed {
  shares: number[];
  reason?: string;
}

function matches(it: ItemRow, l: EngineLine) {
  return (it.product_id != null && it.product_id === l.productId) || (it.product_group_id != null && it.product_group_id === l.groupId);
}

/** Tính phần giảm thô (chưa cắt sàn giá vốn) của một khuyến mãi trên số tiền còn lại `remaining` của từng dòng. */
function computeShares(p: PromoRow, items: ItemRow[], lines: EngineLine[], remaining: number[], subtotal: number): Computed {
  const n = lines.length;
  const zero = () => lines.map(() => 0);
  if (subtotal < p.min_order) return { shares: zero(), reason: "min_order" };
  const scoped = items.length > 0;
  const applicable = lines.map((l) => !scoped || items.some((it) => matches(it, l)));
  if (!applicable.some(Boolean)) return { shares: zero(), reason: "not_applicable" };

  if (p.kind === "percent" || p.kind === "end_of_day") {
    const bp = p.value_bp ?? 0;
    const base = remaining.reduce((s, r, i) => s + (applicable[i] ? r : 0), 0);
    let d = Math.floor((base * bp) / 10000);
    if (p.max_discount != null) d = Math.min(d, p.max_discount);
    return { shares: allocate(d, remaining.map((r, i) => (applicable[i] ? r : 0))) };
  }
  if (p.kind === "amount") {
    const base = remaining.reduce((s, r, i) => s + (applicable[i] ? r : 0), 0);
    const d = Math.min(p.value_amount ?? 0, base);
    return { shares: allocate(d, remaining.map((r, i) => (applicable[i] ? r : 0))) };
  }
  if (p.kind === "fixed_price") {
    // value_amount = đơn giá cố định / đơn vị chính cho sản phẩm trong phạm vi
    const shares = lines.map((l, i) => {
      if (!applicable[i]) return 0;
      const target = lineAmount(p.value_amount ?? 0, l.qtyMilli);
      return Math.max(0, remaining[i] - target);
    });
    return { shares };
  }
  // combo: cần đủ MỌI thành phần; số bộ = min(có / cần); giá combo = value_amount cho mỗi bộ
  const comps = items.filter((it) => (it.qty_milli ?? 0) > 0);
  if (!comps.length) return { shares: zero(), reason: "not_applicable" };
  let sets = Infinity;
  for (const it of comps) {
    const have = lines.reduce((s, l) => s + (matches(it, l) ? l.qtyMilli : 0), 0);
    sets = Math.min(sets, Math.floor(have / it.qty_milli!));
  }
  if (!Number.isFinite(sets) || sets < 1) return { shares: zero(), reason: "combo_incomplete" };
  const parts = new Array<number>(n).fill(0);
  for (const it of comps) {
    let need = it.qty_milli! * sets;
    for (let i = 0; i < n && need > 0; i++) {
      if (!matches(it, lines[i])) continue;
      const take = Math.min(need, lines[i].qtyMilli);
      // phần giá trị của dòng thuộc thành phần này, theo số tiền còn lại của dòng
      parts[i] += Math.min(remaining[i], Math.round((remaining[i] * take) / Math.max(lines[i].qtyMilli, 1)));
      need -= take;
    }
  }
  const value = parts.reduce((s, x) => s + x, 0);
  const d = Math.max(0, value - (p.value_amount ?? 0) * sets);
  return { shares: allocate(d, parts) };
}

/** Cắt phần giảm để dòng không thấp hơn sàn giá vốn. */
function clip(shares: number[], remaining: number[], floors: number[]) {
  let clipped = false;
  const out = shares.map((s, i) => {
    const cap = Math.max(0, remaining[i] - floors[i]);
    if (s > cap) {
      clipped = true;
      return cap;
    }
    return s;
  });
  return { shares: out, clipped };
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

export async function evaluatePromotions(db: D1Database, input: EngineInput): Promise<EngineResult> {
  const at = input.at ?? new Date().toISOString();
  const atMs = Date.parse(at);
  const lines = input.lines;
  const rejected: EngineResult["rejected"] = [];
  const empty: EngineResult = { discounts: [], total: 0, rejected, lineDiscounts: lines.map(() => 0) };
  if (!lines.length) return empty;

  const all = (await db.prepare(`SELECT * FROM promotions WHERE status = 'active'`).all<PromoRow>()).results;
  const timeOk = (p: PromoRow) => Date.parse(p.starts_at) <= atMs && atMs < Date.parse(p.ends_at) && inDailyWindow(p, atMs);
  const channelOk = (p: PromoRow) => p.channels.split(",").map((x) => x.trim()).includes(input.channel);

  // --- voucher ---
  let voucher: VoucherRow | null = null;
  let voucherPromo: PromoRow | null = null;
  const code = input.voucherCode ? normalizeVoucherCode(input.voucherCode) : "";
  if (code) {
    const v = await db.prepare(`SELECT * FROM vouchers WHERE code = ?`).bind(code).first<VoucherRow>();
    const fail = (reason: string) => void rejected.push({ code, reason });
    if (!v) fail("voucher_not_found");
    else if (!v.active) fail("voucher_inactive");
    else if (v.max_uses != null && v.used_count >= v.max_uses) fail("voucher_exhausted");
    else if (v.customer_id != null && v.customer_id !== (input.customerId ?? null)) fail("voucher_wrong_customer");
    else {
      let limited = false;
      if (input.customerId) {
        const used = await db
          .prepare(`SELECT COUNT(*) AS n FROM voucher_redemptions WHERE voucher_id = ? AND customer_id = ? AND status = 'used'`)
          .bind(v.id, input.customerId)
          .first<{ n: number }>();
        limited = (used?.n ?? 0) >= v.per_customer_limit;
      }
      if (limited) fail("voucher_customer_limit");
      else {
        const p = (await db.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(v.promotion_id).first<PromoRow>()) ?? null;
        if (!p || p.status !== "active" || !timeOk(p)) fail("promotion_inactive");
        else if (!channelOk(p)) fail("channel_not_allowed");
        else {
          voucher = v;
          voucherPromo = p;
        }
      }
    }
  }

  // --- ứng viên ---
  const cands: PromoRow[] = all.filter((p) => !p.requires_voucher && timeOk(p) && channelOk(p) && p.id !== voucherPromo?.id);
  if (voucherPromo) cands.push(voucherPromo);
  if (!cands.length) return empty;
  const itemRows = (await db.prepare(`SELECT * FROM promotion_items WHERE promotion_id IN (${cands.map(() => "?").join(",")})`).bind(...cands.map((c) => c.id)).all<ItemRow>()).results;
  const floors = await costFloors(db, lines);
  const base = lines.map((l) => l.lineTotal);

  const evalOne = (p: PromoRow, remaining: number[]) => {
    const items = itemRows.filter((i) => i.promotion_id === p.id);
    const raw = computeShares(p, items, lines, remaining, input.subtotal);
    const c = clip(raw.shares, remaining, floors);
    return { p, amount: sum(c.shares), shares: c.shares, clipped: c.clipped, reason: raw.reason };
  };
  const order = (a: { p: PromoRow }, b: { p: PromoRow }) => b.p.priority - a.p.priority || a.p.id - b.p.id;
  const better = (a: { p: PromoRow; amount: number }, b: { p: PromoRow; amount: number }) => b.amount - a.amount || order(a, b);

  const evaluated = cands.map((p) => evalOne(p, base));
  const voucherEval = voucherPromo ? evaluated.find((e) => e.p.id === voucherPromo!.id)! : null;
  if (voucher && voucherEval && voucherEval.amount === 0) {
    rejected.push({ code: voucher.code, reason: voucherEval.reason ?? "no_discount" });
    voucher = null;
  }
  const live = evaluated.filter((e) => e.amount > 0 && (e.p.id !== voucherPromo?.id || voucher));

  const toApplied = (e: { p: PromoRow; amount: number; shares: number[]; clipped: boolean }): AppliedDiscount => ({
    promotionId: e.p.id,
    ...(voucher && voucherPromo && e.p.id === voucherPromo.id ? { voucherId: voucher.id } : {}),
    amount: e.amount,
    description: e.p.name + (e.clipped ? " (đã giới hạn để không thấp hơn giá vốn)" : ""),
    lineShares: e.shares,
    clipped: e.clipped,
  });

  let chosen: ReturnType<typeof toApplied>[] = [];
  if (live.length) {
    const best = [...live].sort(better)[0];
    chosen = [toApplied(best)];
    const stacking = (await getSettingInt(db, "promo.allow_stacking", 0)) === 1;
    if (stacking) {
      const stackable = live.filter((e) => e.p.stackable).sort(order);
      if (stackable.length > 1) {
        // cộng dồn tuần tự trên số tiền còn lại, mỗi bước vẫn cắt theo giá vốn
        const rem = [...base];
        const seq: AppliedDiscount[] = [];
        for (const s of stackable) {
          const e = evalOne(s.p, rem);
          if (e.amount <= 0) continue;
          e.shares.forEach((x, i) => (rem[i] -= x));
          seq.push(toApplied(e));
        }
        if (seq.reduce((t, d) => t + d.amount, 0) > chosen[0].amount) chosen = seq;
      }
    }
  }
  if (voucher && voucherPromo && !chosen.some((d) => d.voucherId === voucher!.id)) {
    rejected.push({ code: voucher.code, reason: "not_best_promotion" });
  }

  const lineDiscounts = lines.map((_, i) => chosen.reduce((s, d) => s + d.lineShares[i], 0));
  return { discounts: chosen, total: sum(lineDiscounts), rejected, lineDiscounts };
}
