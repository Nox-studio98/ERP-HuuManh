import { useRef, useState } from "react";
import { api, type Home as HomeData } from "../lib/api";
import { FruitArt } from "../lib/art";
import { fmtDate } from "../lib/format";
import { Link, usePageMeta } from "../lib/router";
import { ErrorBox, Icon, Img, Loading, ProductCard, useAsync } from "../ui";

function Carousel({ banners }: { banners: HomeData["banners"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const go = (k: number) => {
    const el = ref.current;
    if (!el) return;
    const n = banners.length;
    const t = (k + n) % n;
    el.scrollTo({ left: t * el.clientWidth, behavior: "smooth" });
    setI(t);
  };
  return (
    <section className="carousel" aria-roledescription="carousel" aria-label="Ưu đãi nổi bật">
      <div className="slides" ref={ref} onScroll={(e) => { const el = e.currentTarget; setI(Math.round(el.scrollLeft / el.clientWidth)); }} tabIndex={0}>
        {banners.map((b, k) => {
          const inner = <Img src={b.imageUrl} alt={b.title} seed={b.title} eager={k === 0} className="slide-img" />;
          return (
            <div className="slide" key={b.id} role="group" aria-roledescription="slide" aria-label={`${k + 1} / ${banners.length}`}>
              {b.linkUrl ? <Link to={b.linkUrl} aria-label={b.title}>{inner}</Link> : inner}
              <p className="slide-cap">{b.title}</p>
            </div>
          );
        })}
      </div>
      {banners.length > 1 && (
        <>
          <button className="car-btn prev" onClick={() => go(i - 1)} aria-label="Ưu đãi trước"><Icon n="chevL" /></button>
          <button className="car-btn next" onClick={() => go(i + 1)} aria-label="Ưu đãi tiếp theo"><Icon n="chevR" /></button>
          <div className="dots">
            {banners.map((b, k) => <button key={b.id} className={k === i ? "on" : ""} onClick={() => go(k)} aria-label={`Ưu đãi ${k + 1}`} aria-current={k === i} />)}
          </div>
        </>
      )}
    </section>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="eyebrow">Giao trong ngày tại TP. Hồ Chí Minh</p>
        <h1>Trái cây tươi,<br />chọn kỹ từng ký.</h1>
        <p className="lead">Nhập mới mỗi sáng, rõ nguồn gốc, cân đúng theo yêu cầu. Đặt trước 90 phút là giao đúng khung giờ bạn chọn.</p>
        <div className="hero-cta">
          <Link to="/san-pham" className="btn lg">Mua trái cây ngay</Link>
          <Link to="/si" className="btn lg ghost">Mua sỉ</Link>
        </div>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div className="orb o1"><FruitArt seed="táo" /></div>
        <div className="orb o2"><FruitArt seed="cam sành" /></div>
        <div className="orb o3"><FruitArt seed="nho" /></div>
      </div>
    </section>
  );
}

export function Home() {
  usePageMeta("Trái cây tươi giao tận nhà", "Hữu Mạnh — trái cây tươi nhập mới mỗi ngày, cân đúng, giao đúng khung giờ tại TP. Hồ Chí Minh.");
  const { data, error, loading, reload } = useAsync(() => api<HomeData>("/home"), []);
  if (loading) return <div className="wrap page"><Loading /></div>;
  if (error || !data) return <div className="wrap page"><ErrorBox error={error} onRetry={reload} /></div>;
  return (
    <div className="wrap page home">
      {data.banners.length ? <Carousel banners={data.banners} /> : <Hero />}

      <ul className="usp" aria-label="Cam kết của Hữu Mạnh">
        <li><Icon n="leaf" size={26} /><div><strong>Tươi mỗi ngày</strong><span>Nhập mới, kiểm độ chín</span></div></li>
        <li><Icon n="truck" size={26} /><div><strong>Giao theo khung giờ</strong><span>Chọn ngày, chọn giờ</span></div></li>
        <li><Icon n="box" size={26} /><div><strong>Cân đúng, chốt theo thực tế</strong><span>Hàng cân tính theo ký thật</span></div></li>
      </ul>

      {data.groups.length > 0 && (
        <nav className="chips" aria-label="Nhóm sản phẩm">
          {data.groups.map((g) => <Link key={g.id} to={`/san-pham?groupId=${g.id}`} className="chip">{g.name}</Link>)}
        </nav>
      )}

      <section aria-labelledby="h-feat">
        <div className="sec-head"><h2 id="h-feat">Được yêu thích</h2><Link to="/san-pham" className="more">Xem tất cả <Icon n="chevR" size={16} /></Link></div>
        <div className="grid">{data.featured.map((p, i) => <ProductCard key={p.id} p={p} eager={i < 2} />)}</div>
        {data.featured.length === 0 && <p className="muted">Sản phẩm đang được cập nhật.</p>}
      </section>

      {data.posts.length > 0 && (
        <section aria-labelledby="h-posts">
          <div className="sec-head"><h2 id="h-posts">Góc trái cây</h2></div>
          <div className="posts">
            {data.posts.map((p) => (
              <Link key={p.slug} to={`/bai-viet/${encodeURIComponent(p.slug)}`} className="post">
                <Img src={p.coverUrl} alt="" seed={p.title} className="post-img" />
                <div>
                  <h3>{p.title}</h3>
                  {p.excerpt && <p>{p.excerpt}</p>}
                  {p.publishedAt && <time dateTime={p.publishedAt}>{fmtDate(p.publishedAt)}</time>}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
