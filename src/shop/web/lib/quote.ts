import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Quote, type Slot, type Zone } from "./api";
import { baseQtyMilli, type CartItem } from "./store";

export interface QuoteState { quote: Quote | null; loading: boolean; error: ApiError | null }

/** Báo giá server (debounce). Giá/phí luôn do server tính. */
export function useQuote(items: CartItem[], opts: { district?: string; addressId?: number | null; slotDate?: string; slotId?: number }): QuoteState & { reload(): void } {
  const [st, setSt] = useState<QuoteState>({ quote: null, loading: items.length > 0, error: null });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const key = JSON.stringify([items.map((i) => [i.productId, i.unit, i.qtyMilli]), opts.district, opts.addressId, opts.slotDate, opts.slotId, tick]);
  useEffect(() => {
    if (!items.length) { setSt({ quote: null, loading: false, error: null }); return; }
    const my = ++seq.current;
    setSt((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      try {
        const body: Record<string, unknown> = { items: items.map((i) => ({ productId: i.productId, unit: i.unit, qty: i.qtyMilli / 1000 })) };
        if (opts.addressId) body.addressId = opts.addressId;
        else if (opts.district) body.district = opts.district;
        if (opts.slotDate && opts.slotId) { body.slotDate = opts.slotDate; body.slotId = opts.slotId; }
        const q = await api<Quote>("/cart/quote", { body });
        if (my === seq.current) setSt({ quote: q, loading: false, error: null });
      } catch (e) {
        if (my === seq.current) setSt({ quote: null, loading: false, error: e as ApiError });
      }
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ...st, reload: () => setTick((t) => t + 1) };
}

/** Thông tin vùng giao + các khung giờ 7 ngày tới theo quận/huyện. */
export function useDelivery(district: string, refreshKey = 0) {
  const [st, setSt] = useState<{ zone: Zone | null; slots: Slot[]; loading: boolean; error: ApiError | null }>({ zone: null, slots: [], loading: false, error: null });
  useEffect(() => {
    let live = true;
    setSt((s) => ({ ...s, loading: true }));
    api<{ zone: Zone | null; slots: Slot[] }>(`/delivery/slots${district ? `?district=${encodeURIComponent(district)}` : ""}`).then(
      (r) => live && setSt({ zone: r.zone, slots: r.slots, loading: false, error: null }),
      (e) => live && setSt({ zone: null, slots: [], loading: false, error: e }),
    );
    return () => { live = false; };
  }, [district, refreshKey]);
  return st;
}

export const cartSubtotalEst = (items: CartItem[]) => items.reduce((s, i) => s + Math.round((i.unitPrice * baseQtyMilli(i)) / 1000), 0);
