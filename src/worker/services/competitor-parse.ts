import { normalizeVi } from "./online-orders";

/** Parser giá + quy cách + trang đối thủ (M7-02/04). Hàm thuần, không I/O. */

// ---------------------------------------------------------------- giá tiền
/** "125.000đ", "125,000 ₫", "1.250.000 VND", "125000.00", "99k" → số đồng nguyên; không đọc được → null. */
export function parseVnPrice(text: unknown): number | null {
  if (typeof text === "number") return Number.isFinite(text) && text > 0 ? Math.round(text) : null;
  if (typeof text !== "string") return null;
  const t = text.replace(/ /g, " ");
  const k = /(\d+(?:[.,]\d+)?)\s*k\b/i.exec(t);
  if (k && !/\d[.,]\d{3}/.test(t)) {
    const v = Math.round(parseFloat(k[1].replace(",", ".")) * 1000);
    return v > 0 ? v : null;
  }
  const m = /\d[\d.,]*/.exec(t);
  if (!m) return null;
  let s = m[0].replace(/[.,]+$/, "");
  const frac = /[.,](\d{1,2})$/.exec(s);
  if (frac) s = s.slice(0, s.length - frac[0].length).replace(/[.,]/g, "") + "." + frac[1];
  else s = s.replace(/[.,]/g, "");
  const n = Math.round(Number(s));
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000) return null;
  return n;
}

// ---------------------------------------------------------------- quy cách
export interface Pack {
  qtyMilli: number; // milli kg (1 kg = 1000) hoặc milli trái (1 trái = 1000)
  unit: "kg" | "trai";
}

const num = (s: string) => (/^\d{1,3}(\.\d{3})+$/.test(s) ? Number(s.replace(/\./g, "")) : Number(s.replace(",", ".")));

/** "500g", "1kg", "1,5 kg", "hộp 250g", "3 trái", "túi 2kg", "3 x 500g" → quy cách chuẩn; không nhận ra → null. */
export function parsePack(text: string | null | undefined): Pack | null {
  if (!text) return null;
  const t = normalizeVi(text);
  const w = /(?:(\d+)\s*[x*]\s*)?(\d+(?:[.,]\d+)*)\s*(kg|kgs|kilogam|kilogram|g|gr|gam|gram)\b/.exec(t);
  if (w) {
    const mult = w[1] ? Number(w[1]) : 1;
    const q = num(w[2]) * mult;
    const kg = /^k/.test(w[3]) ? q : q / 1000;
    const milli = Math.round(kg * 1000);
    if (milli > 0) return { qtyMilli: milli, unit: "kg" };
  }
  const c = /(?:(\d+)\s*[x*]\s*)?(\d+(?:[.,]\d+)?)\s*(trai|qua|cu|cai)\b/.exec(t);
  if (c) {
    const mult = c[1] ? Number(c[1]) : 1;
    const milli = Math.round(num(c[2]) * mult * 1000);
    if (milli > 0) return { qtyMilli: milli, unit: "trai" };
  }
  return null;
}

/** Đơn giá chuẩn hoá: VND / kg hoặc / trái. */
export const unitPriceOf = (price: number, packQtyMilli: number | null | undefined) =>
  packQtyMilli && packQtyMilli > 0 ? Math.round((price * 1000) / packQtyMilli) : null;

/** Đơn vị chính của SP cửa hàng có so sánh được với quy cách chuẩn không (kg-kg, trái-trái). */
export function unitsCompatible(baseUnit: string, packUnit: string | null | undefined): boolean {
  if (!packUnit) return false;
  const b = normalizeVi(baseUnit);
  if (packUnit === "kg") return b === "kg";
  if (packUnit === "trai") return b === "trai" || b === "qua";
  return false;
}

// ---------------------------------------------------------------- thống kê / tên
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Chuẩn hoá tên để so khớp: bỏ dấu, bỏ quy cách/số, bỏ từ bao bì. */
export function matchName(name: string) {
  return normalizeVi(name)
    .replace(/\d+(?:[.,]\d+)*\s*(kg|g|gr|gam|gram|trai|qua|cai|cu|hop|tui|khay)?\b/g, " ")
    .replace(/\b(hop|tui|khay|thung|goi|loai)\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Độ giống tên 0-100 (Jaccard trigram, nâng điểm khi tên ngắn nằm trọn trong tên dài). */
export function nameScore(a: string, b: string): number {
  const na = matchName(a), nb = matchName(b);
  if (!na || !nb) return 0;
  const A = trigrams(na), B = trigrams(nb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const jac = inter / (A.size + B.size - inter);
  let score = jac * 100;
  const ta = na.split(" "), tb = nb.split(" ");
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.every((t) => long.includes(t))) score = Math.max(score, 70 + 30 * jac);
  return Math.round(Math.min(100, score));
}

// ---------------------------------------------------------------- trang HTML
export interface ParsedItem {
  externalId: string;
  url: string | null;
  name: string;
  price: number;
  inStock: boolean | null;
  packText: string | null;
  promoText: string | null;
}

export interface CssConfig {
  itemSelector: string;
  nameSelector: string;
  priceSelector: string;
  linkSelector?: string;
  packSelector?: string;
  promoSelector?: string;
  soldOutSelector?: string;
  pageParam?: string; // vd "page": trang 2.. thêm ?page=N
}

export function absUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const isType = (n: any, t: string) => (Array.isArray(n["@type"]) ? n["@type"].includes(t) : n["@type"] === t);

function offerOf(node: any): { price: number | null; inStock: boolean | null } {
  const raw = node.offers;
  const offers: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const o of offers) {
    if (!o || typeof o !== "object") continue;
    const cur = o.priceCurrency ?? o.priceSpecification?.priceCurrency;
    if (cur && String(cur).toUpperCase() !== "VND") continue;
    const price = parseVnPrice(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
    if (price == null) continue;
    const av = String(o.availability ?? "");
    const inStock = /InStock|PreOrder|LimitedAvailability/i.test(av) ? true : /OutOfStock|SoldOut|Discontinued/i.test(av) ? false : null;
    return { price, inStock };
  }
  return { price: null, inStock: null };
}

function weightText(node: any): string | null {
  const w = node.weight;
  if (!w || typeof w !== "object" || w.value == null) return null;
  const code = String(w.unitCode ?? w.unitText ?? "").toLowerCase();
  if (code === "kgm" || code === "kg") return `${w.value}kg`;
  if (code === "grm" || code === "g") return `${w.value}g`;
  return null;
}

/** schema.org Product/Offer trong <script type="application/ld+json"> (kể cả @graph, ItemList). */
export function parseJsonLd(html: string, pageUrl: string): ParsedItem[] {
  const out = new Map<string, ParsedItem>();
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  const walk = (n: any, depth: number) => {
    if (!n || typeof n !== "object" || depth > 8) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    if (isType(n, "Product") && typeof n.name === "string") {
      const { price, inStock } = offerOf(n);
      if (price != null) {
        const url = absUrl(typeof n.url === "string" ? n.url : null, pageUrl);
        const externalId = url ?? (n.sku ? `sku:${n.sku}` : `name:${normalizeVi(n.name)}`);
        if (!out.has(externalId)) out.set(externalId, { externalId, url, name: n.name.trim(), price, inStock, packText: weightText(n), promoText: null });
      }
    }
    for (const k of ["@graph", "itemListElement", "item", "mainEntity", "hasPart", "hasVariant"]) if (n[k]) walk(n[k], depth + 1);
  };
  for (const m of html.matchAll(re)) {
    try {
      walk(JSON.parse(m[1].trim()), 0);
    } catch {
      /* JSON-LD hỏng: bỏ qua khối này */
    }
  }
  return [...out.values()];
}

interface Raw { name: string; price: string; pack: string; promo: string; link: string | null; soldOut: boolean; seen: Set<string> }

const splitSel = (s: string): [string, string | null] => {
  const i = s.lastIndexOf("@");
  if (i > 0 && /^[a-zA-Z][\w-]*$/.test(s.slice(i + 1))) return [s.slice(0, i), s.slice(i + 1)];
  return [s, null];
};

/** Parser theo CSS selector bằng HTMLRewriter. Selector có thể kết thúc bằng "@thuộc-tính" để lấy attribute. */
export async function parseCss(html: string, pageUrl: string, cfg: CssConfig): Promise<ParsedItem[]> {
  const items: Raw[] = [];
  let cur: Raw | null = null;
  const rw = new HTMLRewriter().on(cfg.itemSelector, {
    element(el) {
      cur = { name: "", price: "", pack: "", promo: "", link: null, soldOut: false, seen: new Set() };
      items.push(cur);
      if (el.tagName === "a" && !cfg.linkSelector) cur.link = el.getAttribute("href");
    },
  });
  const field = (sel: string | undefined, key: "name" | "price" | "pack" | "promo") => {
    if (!sel) return;
    const [s, attr] = splitSel(sel);
    let active = false;
    rw.on(s, {
      element(el) {
        const it = cur;
        if (!it || it.seen.has(key)) {
          active = false;
          return;
        }
        it.seen.add(key);
        active = !attr;
        if (attr) it[key] = el.getAttribute(attr) ?? "";
      },
      text(t) {
        if (active && cur) cur[key] += t.text;
      },
    });
  };
  field(cfg.nameSelector, "name");
  field(cfg.priceSelector, "price");
  field(cfg.packSelector, "pack");
  field(cfg.promoSelector, "promo");
  if (cfg.linkSelector) {
    const [s, attr] = splitSel(cfg.linkSelector);
    rw.on(s, {
      element(el) {
        if (cur && cur.link == null) cur.link = el.getAttribute(attr ?? "href");
      },
    });
  }
  if (cfg.soldOutSelector) {
    rw.on(cfg.soldOutSelector, {
      element() {
        if (cur) cur.soldOut = true;
      },
    });
  }
  await rw.transform(new Response(html)).text();

  const out = new Map<string, ParsedItem>();
  for (const r of items) {
    const name = r.name.replace(/\s+/g, " ").trim();
    const price = parseVnPrice(r.price);
    if (!name || price == null) continue;
    const url = absUrl(r.link, pageUrl);
    const externalId = url ?? `name:${normalizeVi(name)}`;
    if (out.has(externalId)) continue;
    out.set(externalId, {
      externalId, url, name, price,
      inStock: cfg.soldOutSelector ? !r.soldOut : null,
      packText: r.pack.replace(/\s+/g, " ").trim() || null,
      promoText: r.promo.replace(/\s+/g, " ").trim() || null,
    });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- robots.txt
export interface RobotsRules {
  rules: { allow: boolean; pattern: string }[];
  crawlDelaySec: number | null;
}

/** Phân tích robots.txt cho user-agent của ta (nhóm khớp dài nhất, không có thì nhóm "*"). */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = userAgent.split(/[\/\s]/)[0].toLowerCase();
  type G = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null };
  const groups: G[] = [];
  let g: G | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === "user-agent") {
      if (!g || !lastWasAgent) groups.push((g = { agents: [], rules: [], delay: null }));
      g.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!g) continue;
    if (k === "disallow") g.rules.push({ allow: false, pattern: v });
    else if (k === "allow") g.rules.push({ allow: true, pattern: v });
    else if (k === "crawl-delay") g.delay = Number(v) || null;
  }
  let best: G | null = null;
  let bestLen = -1;
  for (const gr of groups) {
    for (const a of gr.agents) {
      if (a === "*") {
        if (bestLen < 0) {
          best = gr;
          bestLen = 0;
        }
      } else if (token.includes(a) && a.length > bestLen) {
        best = gr;
        bestLen = a.length;
      }
    }
  }
  return { rules: best?.rules.filter((r) => r.pattern !== "") ?? [], crawlDelaySec: best?.delay ?? null };
}

function patternMatches(pattern: string, path: string) {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/** Quy tắc khớp dài nhất thắng; hoà thì Allow. */
export function robotsAllows(r: RobotsRules, pathAndQuery: string): boolean {
  let bestLen = -1;
  let allow = true;
  for (const rule of r.rules) {
    if (patternMatches(rule.pattern, pathAndQuery)) {
      const len = rule.pattern.length;
      if (len > bestLen || (len === bestLen && rule.allow)) {
        bestLen = len;
        allow = rule.allow;
      }
    }
  }
  return allow;
}
