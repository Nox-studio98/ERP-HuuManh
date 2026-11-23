export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
  get network() {
    return this.status === 0;
  }
}

export interface Unit { unit: string; factorMilli: number }
export interface Card {
  id: number; slug: string; name: string; origin: string | null; baseUnit: string; unitLabel: string; price: number;
  imageUrl: string | null; inStock: boolean; availableMilli: number; allowPreorder: boolean; stepMilli: number;
  sellByWeight: boolean; units: Unit[];
}
export interface ProductDetail extends Card { description: string; images: string[]; groupName: string | null; related: Card[] }
export interface PostCard { slug: string; title: string; excerpt: string | null; coverUrl: string | null; publishedAt: string | null }
export interface Home { banners: { id: number; title: string; imageUrl: string | null; linkUrl: string | null }[]; featured: Card[]; groups: { id: number; name: string }[]; posts: PostCard[] }
export interface QuoteLine { productId: number; name: string; unit: string; qty: number; qtyMilli: number; unitPrice: number; lineTotal: number; available: boolean; preorderMilli: number; sellByWeight: boolean }
export interface Issue { productId: number | null; code: string; message: string }
export interface Quote { lines: QuoteLine[]; subtotal: number; shippingFee: number; zone: { id: number; name: string } | null; total: number; estimated: boolean; issues: Issue[] }
export interface Slot { date: string; id: number; label: string; startTime: string; endTime: string; available: boolean; reason?: string }
export interface Zone { id: number; name: string; fee: number; freeOver: number | null; minOrder: number }
export interface Transfer { bankBin: string; accountNo: string; accountName: string; amount: number; content: string; qrPayload: string; expiresAt: string | null }
export interface OrderLine { productId: number; name: string; imageUrl: string | null; unit: string; orderedQty: number; qty: number; unitPrice: number; lineTotal: number; preorderMilli: number }
export interface OrderView {
  code: string; trackingToken: string | null; status: string; statusLabel: string; createdAt: string; slotDate: string | null; slotLabel: string | null;
  receiverName: string | null; receiverPhoneMasked: string; shipAddress: string | null; paymentMethod: string | null; paymentStatus: string;
  estimated: boolean; estimatedTotal: number; subtotal: number; shippingFee: number; discount: number; total: number; weightAdjustStatus: string;
  lines: OrderLine[]; events: { at: string; status: string; statusLabel: string; note: string | null }[]; canCancel: boolean; transfer?: Transfer;
}
export interface Me { id: number; fullName: string; email: string; phone: string | null; kind: "retail" | "b2b"; b2bStatus: "pending" | "approved" | "rejected" | null; customerGroup: string | null; marketingOptIn: boolean }
export interface Address { id: number; label: string | null; receiverName: string; receiverPhone: string; addressLine: string; ward: string | null; district: string; province: string; zoneId: number | null; isDefault: boolean }

interface Opts { method?: string; body?: unknown; turnstile?: string | null; signal?: AbortSignal }

export async function api<T = any>(path: string, o: Opts = {}): Promise<T> {
  const method = o.method ?? (o.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Requested-With"] = "hm-shop";
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.turnstile) headers["X-Turnstile-Token"] = o.turnstile;
  let res: Response;
  try {
    res = await fetch("/api" + path, { method, headers, credentials: "same-origin", body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: o.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "network", "Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.");
  }
  let data: any = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? (res.status >= 500 ? "Hệ thống đang bận, vui lòng thử lại sau." : "Có lỗi xảy ra"), e?.details);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Có lỗi xảy ra, vui lòng thử lại.");
