import { useEffect, useMemo } from "react";
import { DistrictOptions } from "../lib/geo";
import { money, num, unitName } from "../lib/format";
import { Link, navigate, usePageMeta } from "../lib/router";
import { announce, cartActions, estLine, prefs, ss, unitPriceOf, useCart } from "../lib/store";
import { cartSubtotalEst, useDelivery, useQuote } from "../lib/quote";
import { Empty, Icon, Img, Notice, Stepper } from "../ui";
import { DiscountRows, VoucherBox, useVoucher } from "../lib/voucher";
import { useState } from "react";

export function DistrictSelect({ value, onChange, id = "district", label = "Giao đến quận/huyện" }: { value: string; onChange: (v: string) => void; id?: string; label?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Chọn quận/huyện…</option>
        <DistrictOptions />
      </select>
    </div>
  );
}

export function CartPage() {
  usePageMeta("Giỏ hàng");
  const cart = useCart();
  const [reNote] = useState(() => { const n = ss.get("hm_reorder_note"); if (n) ss.del("hm_reorder_note"); return n; });
  const [district, setDistrict] = useState(prefs.getDistrict());
  const dl = useDelivery(district);
  const vc = useVoucher();
  const { quote, loading, error } = useQuote(cart, { district, voucherCode: vc.code || undefined });
  const byId = useMemo(() => new Map(quote?.lines.map((l) => [l.productId, l])), [quote]);
  const changed = useMemo(() => cart.filter((c) => { const l = byId.get(c.productId); return l && l.unitPrice !== c.unitPrice; }), [cart, byId]);

  // Đồng bộ giá mới từ server vào giỏ (khách được báo rõ bên dưới)
  const [priceNote, setPriceNote] = useState<string[]>([]);
  useEffect(() => {
    if (!changed.length) return;
    setPriceNote(changed.map((c) => `${c.name}: ${money(unitPriceOf(c))} → ${money(Math.round(((byId.get(c.productId)!.unitPrice) * c.factorMilli) / 1000))}`));
    announce("Giá một số sản phẩm đã được cập nhật");
    for (const c of changed) cartActions.setPrice(c.productId, byId.get(c.productId)!.unitPrice);
  }, [changed, byId]);

  if (!cart.length)
    return (
      <div className="wrap page narrow">
        <h1>Giỏ hàng</h1>
        <Empty title="Giỏ hàng đang trống" art><p>Chọn vài loại trái cây tươi cho hôm nay nhé.</p><Link to="/san-pham" className="btn">Xem sản phẩm</Link></Empty>
      </div>
    );

  const subtotal = quote?.subtotal ?? cartSubtotalEst(cart);
  const hasWeight = cart.some((c) => c.sellByWeight);
  const issueFor = (id: number) => quote?.issues.filter((i) => i.productId === id) ?? [];
  const cartIssues = quote?.issues.filter((i) => i.productId === null) ?? [];
  const blocked = !!quote?.issues.some((i) => i.code === "unpublished");
  const freeLeft = dl.zone?.freeOver != null ? Math.max(0, dl.zone.freeOver - subtotal) : null;

  return (
    <div className="wrap page cart">
      <h1>Giỏ hàng <small>({cart.length} mặt hàng)</small></h1>
      {reNote && <Notice kind="warn">{reNote}</Notice>}
      <div className="cart-grid">
        <ul className="lines" aria-label="Sản phẩm trong giỏ">
          {cart.map((it) => {
            const l = byId.get(it.productId);
            const issues = issueFor(it.productId);
            return (
              <li key={`${it.productId}-${it.unit}`} className="line">
                <Link to={`/san-pham/${encodeURIComponent(it.slug)}`} className="line-img" aria-label={it.name}><Img src={it.imageUrl} alt="" seed={it.name} /></Link>
                <div className="line-main">
                  <Link to={`/san-pham/${encodeURIComponent(it.slug)}`} className="line-name">{it.name}</Link>
                  <p className="muted small">{money(unitPriceOf(it))}/{unitName(it.unit)}</p>
                  {it.sellByWeight && <p className="weight-note sm">Giá tạm tính, chốt theo cân thực tế</p>}
                  {l && l.preorderMilli > 0 && <p className="stock pre sm">Phần thiếu {num(l.preorderMilli / 1000)} {unitName(it.baseUnit)} sẽ giao khi hàng về (đặt trước)</p>}
                  {issues.map((i) => <p key={i.code} className="hint err">{i.message}</p>)}
                  <div className="line-ctl">
                    <Stepper allowRemove item={it} onChange={(m) => cartActions.setQty(it.productId, it.unit, m)} compact />
                    <button className="btn sm ghost danger" onClick={() => cartActions.remove(it.productId, it.unit)} aria-label={`Bỏ ${it.name} khỏi giỏ`}><Icon n="trash" size={16} /><span className="hide-s"> Bỏ</span></button>
                  </div>
                </div>
                <p className="line-total" aria-label={`Thành tiền ${money(l?.lineTotal ?? estLine(it))}`}>{money(l?.lineTotal ?? estLine(it))}{it.sellByWeight && <span className="tilde">tạm tính</span>}</p>
              </li>
            );
          })}
        </ul>

        <aside className="summary" aria-label="Tóm tắt đơn hàng">
          <h2>Tóm tắt</h2>
          {priceNote.length > 0 && <Notice kind="warn">Giá đã được cập nhật:<ul>{priceNote.map((n) => <li key={n}>{n}</li>)}</ul></Notice>}
          <div className="field">
            <label htmlFor="district">Giao đến quận/huyện</label>
            <select id="district" value={district} onChange={(e) => { setDistrict(e.target.value); prefs.setDistrict(e.target.value); }}>
              <option value="">Chọn quận/huyện…</option>
              <DistrictOptions />
            </select>
          </div>
          <VoucherBox code={vc.code} onChange={vc.set} quote={quote} loading={loading} />
          <dl className="totals" aria-live="polite">
            <div><dt>Tạm tính</dt><dd>{money(subtotal)}</dd></div>
            <DiscountRows quote={quote} />
            <div><dt>Phí giao hàng{quote?.zone ? ` (${quote.zone.name})` : ""}</dt><dd data-testid="ship-fee">{!district ? "Chọn khu vực" : quote?.zone ? (quote.shippingFee === 0 ? "Miễn phí" : money(quote.shippingFee)) : loading ? "…" : "Chưa hỗ trợ"}</dd></div>
            <div className="grand"><dt>Tổng cộng</dt><dd data-testid="grand-total">{money(quote?.total ?? subtotal)}</dd></div>
          </dl>
          {hasWeight && <p className="weight-note"><Icon n="info" size={16} /> Giá tạm tính, chốt theo cân thực tế. Cửa hàng sẽ báo nếu chênh lệch lớn.</p>}
          {district && quote && !quote.zone && !loading && <p className="hint err" role="alert">Chưa hỗ trợ giao hàng tới {district}.</p>}
          {freeLeft != null && freeLeft > 0 && quote?.zone && <p className="hint">Mua thêm {money(freeLeft)} để được miễn phí giao hàng.</p>}
          {dl.zone && dl.zone.minOrder > 0 && <p className="hint">Đơn tối thiểu {money(dl.zone.minOrder)} cho khu vực này.</p>}
          {cartIssues.map((i) => <p key={i.code} className="hint err" role="alert">{i.message}</p>)}
          {error && <p className="hint err" role="alert">{error.message}</p>}
          <button className="btn lg block" disabled={blocked || !!error} onClick={() => navigate("/thanh-toan")}>Tiến hành đặt hàng</button>
          <Link to="/san-pham" className="btn ghost block">Tiếp tục mua sắm</Link>
        </aside>
      </div>
    </div>
  );
}
