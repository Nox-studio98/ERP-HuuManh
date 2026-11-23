import { useEffect, useState } from "react";
import { api, type ProductDetail } from "../lib/api";
import { money, num, unitName } from "../lib/format";
import { Markdown } from "../lib/md";
import { Link, navigate, usePageMeta } from "../lib/router";
import { cartActions, stepInUnit, unitPriceOf, useCart, itemFromCard } from "../lib/store";
import { Empty, ErrorBox, Icon, Img, Loading, Notice, ProductCard, Stepper, useAsync } from "../ui";

function Gallery({ images, name }: { images: string[]; name: string }) {
  const [i, setI] = useState(0);
  const list = images.length ? images : [null];
  return (
    <div className="gallery">
      <Img src={list[i]} alt={images.length ? `${name} — ảnh ${i + 1}` : name} seed={name} className="gal-main" eager />
      {list.length > 1 && (
        <div className="thumbs" role="group" aria-label="Ảnh sản phẩm">
          {list.map((src, k) => (
            <button key={k} className={k === i ? "on" : ""} onClick={() => setI(k)} aria-label={`Xem ảnh ${k + 1}`} aria-pressed={k === i}>
              <Img src={src} alt="" seed={name} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProductPage({ slug }: { slug: string }) {
  const { data: p, error, loading, reload } = useAsync(() => api<ProductDetail>(`/products/${encodeURIComponent(slug)}`), [slug]);
  usePageMeta(p?.name ?? "Sản phẩm", p ? `${p.name}${p.origin ? " — " + p.origin : ""}. ${money(p.price)}/${unitName(p.baseUnit)}. Giao tận nhà tại TP. Hồ Chí Minh.` : undefined);
  const cart = useCart();
  const [unit, setUnit] = useState<string>("");
  const [qty, setQty] = useState<number | null>(null);
  useEffect(() => { if (p) { setUnit(p.units[0]?.unit ?? p.baseUnit); setQty(null); } }, [p]);
  if (loading) return <div className="wrap page"><Loading /></div>;
  if (error || !p) {
    const nf = (error as { status?: number })?.status === 404;
    return <div className="wrap page">{nf ? <Empty title="Không tìm thấy sản phẩm" art><p>Sản phẩm có thể đã ngừng bán.</p><Link to="/san-pham" className="btn">Xem sản phẩm khác</Link></Empty> : <ErrorBox error={error} onRetry={reload} />}</div>;
  }
  const base = itemFromCard(p, unit);
  const step = stepInUnit(base);
  const q = qty ?? step;
  const item = { ...base, qtyMilli: q };
  const inCart = cart.find((c) => c.productId === p.id && c.unit === unit);
  const soldOut = !p.inStock && !p.allowPreorder;
  const pricePer = unitPriceOf(base);
  const total = Math.round((pricePer * q) / 1000);
  return (
    <div className="wrap page product">
      <nav className="crumbs" aria-label="Đường dẫn">
        <Link to="/">Trang chủ</Link><span aria-hidden="true">/</span><Link to="/san-pham">Sản phẩm</Link>
        {p.groupName && <><span aria-hidden="true">/</span><span>{p.groupName}</span></>}
      </nav>
      <div className="pd-grid">
        <Gallery images={p.images} name={p.name} />
        <div className="pd-info">
          {p.groupName && <p className="eyebrow">{p.groupName}</p>}
          <h1>{p.name}</h1>
          {p.origin && <p className="origin"><Icon n="pin" size={16} /> Xuất xứ: {p.origin}</p>}
          <p className="pd-price"><strong>{money(pricePer)}</strong><span>/{unitName(unit)}</span></p>
          {p.sellByWeight && <p className="weight-note"><Icon n="info" size={16} /> Giá tạm tính, chốt theo cân thực tế khi đóng gói.</p>}

          {p.inStock ? <p className="stock ok"><Icon n="check" size={16} /> Còn hàng{p.availableMilli < 99000 ? ` (còn khoảng ${num(p.availableMilli / 1000)} ${unitName(p.baseUnit)})` : ""}</p>
            : p.allowPreorder ? <p className="stock pre"><Icon n="clock" size={16} /> Tạm hết — nhận đặt trước, giao khi hàng về</p>
            : <p className="stock out"><Icon n="alert" size={16} /> Tạm hết hàng</p>}

          {p.units.length > 1 && (
            <div className="unit-pick" role="radiogroup" aria-label="Đơn vị mua">
              {p.units.map((u) => (
                <label key={u.unit} className={u.unit === unit ? "on" : ""}>
                  <input type="radio" name="unit" checked={u.unit === unit} onChange={() => { setUnit(u.unit); setQty(null); }} />{unitName(u.unit)}
                </label>
              ))}
            </div>
          )}

          <div className="buy">
            <Stepper item={item} onChange={(m) => setQty(Math.max(step, m))} />
            <p className="buy-total">Tạm tính <strong>{money(total)}</strong></p>
          </div>
          <div className="buy-actions">
            <button className="btn lg" disabled={soldOut} onClick={() => cartActions.add(p, unit, q)}>
              <Icon n="cart" size={20} /> {inCart ? "Thêm nữa vào giỏ" : "Thêm vào giỏ"}
            </button>
            <button className="btn lg ghost" disabled={soldOut} onClick={() => { if (!inCart) cartActions.add(p, unit, q); navigate("/gio-hang"); }}>Mua ngay</button>
          </div>
          {inCart && <p className="muted small" role="status">Trong giỏ: {num(inCart.qtyMilli / 1000)} {unitName(inCart.unit)}</p>}
          {!p.inStock && p.allowPreorder && <Notice kind="info">Đây là hàng đặt trước. Bạn sẽ xác nhận đồng ý ở bước thanh toán; cửa hàng liên hệ khi hàng về.</Notice>}

          <ul className="perks">
            <li><Icon n="truck" size={18} /> Giao theo khung giờ bạn chọn</li>
            <li><Icon n="leaf" size={18} /> Chọn kỹ, đổi trả nếu không hài lòng</li>
          </ul>
        </div>
      </div>

      {p.description && (
        <section className="desc" aria-labelledby="h-desc">
          <h2 id="h-desc">Mô tả sản phẩm</h2>
          <Markdown source={p.description} />
        </section>
      )}

      {p.related.length > 0 && (
        <section aria-labelledby="h-rel">
          <div className="sec-head"><h2 id="h-rel">Có thể bạn thích</h2></div>
          <div className="grid">{p.related.map((r) => <ProductCard key={r.id} p={r} />)}</div>
        </section>
      )}
    </div>
  );
}
