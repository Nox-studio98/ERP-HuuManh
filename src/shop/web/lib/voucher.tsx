import { useState } from "react";
import type { Quote } from "./api";
import { money } from "./format";
import { ss } from "./store";

const KEY = "hm_voucher";
/** Mã voucher giữ trong phiên (giỏ → thanh toán). */
export const voucherStore = {
  get: () => ss.get(KEY) ?? "",
  set: (v: string) => (v ? ss.set(KEY, v) : ss.del(KEY)),
};
export function useVoucher() {
  const [code, setCode] = useState(voucherStore.get());
  return { code, set: (v: string) => { voucherStore.set(v); setCode(v); } };
}

const REASON: Record<string, string> = {
  voucher_not_found: "Không tìm thấy mã này", voucher_inactive: "Mã đã bị khoá", voucher_exhausted: "Mã đã hết lượt sử dụng", voucher_wrong_customer: "Mã dành cho khách khác",
  voucher_customer_limit: "Bạn đã dùng hết lượt của mã này", promotion_inactive: "Chương trình chưa hoặc không còn hiệu lực", channel_not_allowed: "Mã không áp dụng cho đơn online",
  min_order: "Đơn chưa đạt giá trị tối thiểu để dùng mã", not_applicable: "Giỏ hàng chưa có sản phẩm áp dụng mã", combo_incomplete: "Giỏ hàng chưa đủ sản phẩm của combo", no_discount: "Mã không giảm thêm cho đơn này",
  not_best_promotion: "Đang áp dụng ưu đãi tốt hơn cho đơn này",
};
export const voucherReason = (r?: string) => (r ? REASON[r] ?? "Mã không áp dụng được" : "Mã không áp dụng được");

/** Ô nhập voucher + trạng thái áp dụng (dùng ở giỏ hàng và thanh toán). */
export function VoucherBox({ code, onChange, quote, loading, idSuffix = "" }: { code: string; onChange: (v: string) => void; quote: Quote | null; loading: boolean; idSuffix?: string }) {
  const [txt, setTxt] = useState(code);
  const v = quote?.voucher;
  const id = "voucher" + idSuffix;
  return (
    <div className="field" data-testid="voucher-box">
      <label htmlFor={id}>Mã giảm giá</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input id={id} value={txt} onChange={(e) => setTxt(e.target.value.toUpperCase())} placeholder="Nhập mã voucher" autoCapitalize="characters" autoComplete="off" disabled={!!code} style={{ flex: 1, minWidth: 0 }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (!code && txt.trim()) onChange(txt.trim()); } }} />
        {code ? <button type="button" className="btn ghost" onClick={() => { onChange(""); setTxt(""); }}>Bỏ mã</button> : <button type="button" className="btn" disabled={!txt.trim()} onClick={() => onChange(txt.trim())}>Áp dụng</button>}
      </div>
      {code && loading && !v && <p className="hint">Đang kiểm tra mã…</p>}
      {code && v && v.applied && <p className="hint" style={{ color: "var(--brand-deep)", fontWeight: 600 }} data-testid="voucher-ok">Đã áp dụng mã {v.code}{quote && quote.discount > 0 ? `: giảm ${money(quote.discount)}` : ""}</p>}
      {code && v && !v.applied && <p className="hint err" role="alert" data-testid="voucher-bad">Mã {v.code} không áp dụng được: {voucherReason(v.reason)}.</p>}
    </div>
  );
}

/** Các dòng giảm giá trong bảng tổng (dt/dd). */
export function DiscountRows({ quote }: { quote: Quote | null }) {
  if (!quote || !(quote.discount > 0)) return null;
  const ds = quote.discounts?.length ? quote.discounts : [{ promotionId: 0, amount: quote.discount, description: "Giảm giá" }];
  return <>{ds.map((d, i) => <div key={i} data-testid="discount-row"><dt>{d.description || "Khuyến mãi"}</dt><dd style={{ color: "var(--brand-deep)" }}>-{money(d.amount)}</dd></div>)}</>;
}
