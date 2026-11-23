import { createContext, useContext, useSyncExternalStore } from "react";
import type { Card, Me } from "./api";
import { qtyText } from "./format";

/* ---------- localStorage an toàn ---------- */
export const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* chế độ riêng tư */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* bỏ qua */ } },
};
export const ss = {
  get(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* bỏ qua */ } },
  del(k: string) { try { sessionStorage.removeItem(k); } catch { /* bỏ qua */ } },
};

/* ---------- thông báo (aria-live + toast) ---------- */
interface LiveState { msg: string; seq: number }
let live: LiveState = { msg: "", seq: 0 };
const liveSubs = new Set<() => void>();
export const announce = (msg: string) => { live = { msg, seq: live.seq + 1 }; liveSubs.forEach((f) => f()); };
export const useLive = () => useSyncExternalStore((f) => { liveSubs.add(f); return () => { liveSubs.delete(f); }; }, () => live);

/* ---------- giỏ hàng ---------- */
export interface CartItem {
  productId: number;
  slug: string;
  name: string;
  imageUrl: string | null;
  baseUnit: string;
  unit: string;
  factorMilli: number;
  qtyMilli: number; // số lượng × 1000, theo đơn vị `unit`
  unitPrice: number; // giá / đơn vị chính (baseUnit) lúc khách xem — gửi làm expectedUnitPrice
  stepMilli: number; // bước đặt, tính theo đơn vị chính (milli)
  sellByWeight: boolean;
  allowPreorder: boolean;
}

const KEY = "hm_shop_cart_v1";
function load(): CartItem[] {
  const raw = ls.get(KEY);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x) => x && typeof x.productId === "number" && typeof x.qtyMilli === "number" && x.qtyMilli > 0) : [];
  } catch { return []; }
}
let cart: CartItem[] = load();
const cartSubs = new Set<() => void>();
const save = (next: CartItem[], msg?: string) => {
  cart = next;
  ls.set(KEY, JSON.stringify(next));
  cartSubs.forEach((f) => f());
  if (msg) announce(msg);
};
window.addEventListener("storage", (e) => { if (e.key === KEY) { cart = load(); cartSubs.forEach((f) => f()); } });
export const useCart = () => useSyncExternalStore((f) => { cartSubs.add(f); return () => { cartSubs.delete(f); }; }, () => cart);

/** Bước đặt theo đơn vị đang chọn (milli của đơn vị đó). */
export function stepInUnit(i: Pick<CartItem, "factorMilli" | "stepMilli">): number {
  const s = (i.stepMilli * 1000) / i.factorMilli;
  if (Number.isInteger(s) && s >= 1 && (s * i.factorMilli) / 1000 % i.stepMilli === 0) return s;
  return 1000;
}
export const baseQtyMilli = (i: CartItem) => Math.round((i.qtyMilli * i.factorMilli) / 1000);
export const unitPriceOf = (i: CartItem) => Math.round((i.unitPrice * i.factorMilli) / 1000);
export const estLine = (i: CartItem) => Math.round((i.unitPrice * baseQtyMilli(i)) / 1000);
export const cartCount = (c: CartItem[]) => c.length;
export const sameLine = (a: CartItem, productId: number, unit: string) => a.productId === productId && a.unit === unit;

export function itemFromCard(c: Card, unit?: string, qtyMilli?: number): CartItem {
  const u = c.units.find((x) => x.unit === unit) ?? c.units[0] ?? { unit: c.baseUnit, factorMilli: 1000 };
  const it: CartItem = {
    productId: c.id, slug: c.slug, name: c.name, imageUrl: c.imageUrl, baseUnit: c.baseUnit, unit: u.unit, factorMilli: u.factorMilli,
    qtyMilli: 0, unitPrice: c.price, stepMilli: c.stepMilli, sellByWeight: c.sellByWeight, allowPreorder: c.allowPreorder,
  };
  it.qtyMilli = qtyMilli ?? stepInUnit(it);
  return it;
}

export const cartActions = {
  add(c: Card, unit?: string, qtyMilli?: number) {
    const n = itemFromCard(c, unit, qtyMilli);
    const ex = cart.find((x) => sameLine(x, n.productId, n.unit));
    if (ex) save(cart.map((x) => (x === ex ? { ...x, ...n, qtyMilli: x.qtyMilli + n.qtyMilli } : x)), `Đã thêm ${c.name} vào giỏ, hiện có ${qtyText((ex.qtyMilli + n.qtyMilli) / 1000, n.unit)}`);
    else save([...cart, n], `Đã thêm ${c.name} vào giỏ hàng`);
  },
  setQty(productId: number, unit: string, qtyMilli: number) {
    const it = cart.find((x) => sameLine(x, productId, unit));
    if (!it) return;
    if (qtyMilli <= 0) return this.remove(productId, unit);
    save(cart.map((x) => (x === it ? { ...x, qtyMilli } : x)), `${it.name}: ${qtyText(qtyMilli / 1000, it.unit)}`);
  },
  remove(productId: number, unit: string) {
    const it = cart.find((x) => sameLine(x, productId, unit));
    if (it) save(cart.filter((x) => x !== it), `Đã bỏ ${it.name} khỏi giỏ hàng`);
  },
  setPrice(productId: number, unitPrice: number) {
    save(cart.map((x) => (x.productId === productId ? { ...x, unitPrice } : x)));
  },
  clear() { save([]); },
  /** Đưa các dòng (đã làm mới từ server) vào giỏ — dùng cho "Mua lại". */
  merge(items: CartItem[]) {
    let next = [...cart];
    for (const n of items) {
      const ex = next.find((x) => sameLine(x, n.productId, n.unit));
      next = ex ? next.map((x) => (x === ex ? { ...x, ...n, qtyMilli: x.qtyMilli + n.qtyMilli } : x)) : [...next, n];
    }
    save(next, `Đã thêm ${items.length} mặt hàng vào giỏ`);
  },
};

/* ---------- tài khoản ---------- */
export interface AuthCtx { me: Me | null; ready: boolean; setMe(m: Me | null): void; refresh(): Promise<Me | null> }
export const AuthContext = createContext<AuthCtx>({ me: null, ready: false, setMe() {}, async refresh() { return null; } });
export const useAuth = () => useContext(AuthContext);
export const LOGGED_FLAG = "hm_shop_in";

/* ---------- vùng giao ---------- */
export const prefs = {
  getDistrict: () => ls.get("hm_shop_district") ?? "",
  setDistrict: (d: string) => ls.set("hm_shop_district", d),
};
