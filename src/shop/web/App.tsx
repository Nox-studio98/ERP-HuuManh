import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Me } from "./lib/api";
import { LogoMark } from "./lib/art";
import { Link, match, navigate, useLocation, useQuery, usePageMeta } from "./lib/router";
import { AuthContext, LOGGED_FLAG, ls, useAuth, useCart, useLive } from "./lib/store";
import { Icon } from "./ui";
import { Home } from "./pages/Home";
import { Catalog } from "./pages/Catalog";
import { ProductPage } from "./pages/Product";
import { CartPage } from "./pages/Cart";
import { CheckoutPage } from "./pages/Checkout";
import { TrackPage } from "./pages/Track";
import { AccountPage } from "./pages/Account";
import { ForgotPage, LoginPage, RegisterPage, ResetPage, VerifyEmailPage } from "./pages/Auth";
import { B2bPage } from "./pages/B2b";
import { PostPage } from "./pages/Post";

function Header() {
  const cart = useCart();
  const { me } = useAuth();
  const q = useQuery();
  const loc = useLocation();
  const [term, setTerm] = useState(q.get("q") ?? "");
  useEffect(() => { if (!loc.startsWith("/san-pham")) setTerm(""); }, [loc]);
  const count = cart.length;
  return (
    <header className="top">
      <div className="wrap top-in">
        <Link to="/" className="brand" aria-label="Hữu Mạnh — trang chủ">
          <LogoMark size={34} />
          <span className="brand-name">Hữu Mạnh<small>Trái cây tươi</small></span>
        </Link>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); navigate(`/san-pham${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ""}`); }}>
          <Icon n="search" size={20} className="search-ic" />
          <input type="search" aria-label="Tìm trái cây" placeholder="Tìm táo, cam, sầu riêng…" value={term} onChange={(e) => setTerm(e.target.value)} enterKeyHint="search" />
        </form>
        <nav className="top-nav" aria-label="Điều hướng chính">
          <Link to="/san-pham" className="nl">Sản phẩm</Link>
          <Link to="/si" className="nl">Mua sỉ</Link>
          <Link to={me ? "/tai-khoan" : "/dang-nhap"} className="icon-link" aria-label={me ? "Tài khoản của tôi" : "Đăng nhập"}><Icon n="user" /><span className="lbl">{me ? me.fullName.split(" ").slice(-1)[0] : "Đăng nhập"}</span></Link>
          <Link to="/gio-hang" className="icon-link cart-link" aria-label={`Giỏ hàng, ${count} mặt hàng`}>
            <Icon n="cart" />
            {count > 0 && <span className="count" aria-hidden="true">{count}</span>}
            <span className="lbl">Giỏ hàng</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

function TabBar() {
  const loc = useLocation();
  const cart = useCart();
  const path = loc.split("?")[0];
  const tabs = [
    { to: "/", n: "home", t: "Trang chủ", on: path === "/" },
    { to: "/san-pham", n: "grid", t: "Sản phẩm", on: path.startsWith("/san-pham") },
    { to: "/gio-hang", n: "cart", t: "Giỏ hàng", on: path === "/gio-hang" || path === "/thanh-toan", badge: cart.length },
    { to: "/tai-khoan", n: "user", t: "Tài khoản", on: path.startsWith("/tai-khoan") || path === "/dang-nhap" || path === "/dang-ky" },
  ];
  return (
    <nav className="tabbar" aria-label="Điều hướng nhanh">
      {tabs.map((t) => (
        <Link key={t.to} to={t.to} className={t.on ? "on" : ""} aria-current={t.on ? "page" : undefined}>
          <span className="ti"><Icon n={t.n} size={24} />{!!t.badge && <span className="count" aria-hidden="true">{t.badge}</span>}</span>
          <span>{t.t}</span>
        </Link>
      ))}
    </nav>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <div>
          <div className="brand sm"><LogoMark size={28} /><span className="brand-name">Hữu Mạnh</span></div>
          <p>Trái cây tươi chọn lọc mỗi ngày, giao tận nhà tại TP. Hồ Chí Minh. Rõ nguồn gốc, cân đúng, đổi trả nếu không hài lòng.</p>
        </div>
        <ul>
          <li><Link to="/san-pham">Tất cả sản phẩm</Link></li>
          <li><Link to="/si">Mua sỉ cho nhà hàng, quán</Link></li>
          <li><Link to="/tai-khoan/don-hang">Đơn hàng của tôi</Link></li>
          <li><Link to="/bai-viet/cach-chon-sau-rieng-ngon">Mẹo chọn trái cây</Link></li>
        </ul>
      </div>
    </footer>
  );
}

function LiveRegion() {
  const l = useLive();
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" key={l.seq}>{l.msg}</div>;
}

function NotFound() {
  usePageMeta("Không tìm thấy trang");
  return (
    <div className="wrap page"><div className="state"><h1>Không tìm thấy trang</h1><p>Đường dẫn này không tồn tại hoặc đã được di chuyển.</p><Link to="/" className="btn">Về trang chủ</Link></div></div>
  );
}

function Routes(): ReactNode {
  const loc = useLocation();
  const path = (loc.split("?")[0].replace(/\/+$/, "") || "/");
  let m: Record<string, string> | null;
  if (path === "/") return <Home />;
  if (path === "/san-pham") return <Catalog />;
  if ((m = match("/san-pham/:slug", path))) return <ProductPage key={m.slug} slug={m.slug} />;
  if (path === "/gio-hang") return <CartPage />;
  if (path === "/thanh-toan") return <CheckoutPage />;
  if ((m = match("/track/:token", path))) return <TrackPage key={m.token} token={m.token} />;
  if (path === "/dang-nhap") return <LoginPage />;
  if (path === "/dang-ky") return <RegisterPage />;
  if (path === "/quen-mat-khau") return <ForgotPage />;
  if (path === "/reset-password") return <ResetPage />;
  if (path === "/verify-email") return <VerifyEmailPage />;
  if (path === "/si") return <B2bPage />;
  if ((m = match("/bai-viet/:slug", path))) return <PostPage key={m.slug} slug={m.slug} />;
  if (path === "/tai-khoan" || path.startsWith("/tai-khoan/")) return <AccountPage path={path} />;
  return <NotFound />;
}

export function App() {
  const [me, setMeState] = useState<Me | null>(null);
  const [ready, setReady] = useState(!ls.get(LOGGED_FLAG));
  const setMe = useCallback((m: Me | null) => { setMeState(m); if (m) ls.set(LOGGED_FLAG, "1"); else ls.del(LOGGED_FLAG); setReady(true); }, []);
  const refresh = useCallback(async () => {
    try { const m = await api<Me>("/me"); setMe(m); return m; } catch { setMe(null); return null; }
  }, [setMe]);
  useEffect(() => { if (ls.get(LOGGED_FLAG)) void refresh(); }, [refresh]);
  const ctx = useMemo(() => ({ me, ready, setMe, refresh }), [me, ready, setMe, refresh]);
  return (
    <AuthContext.Provider value={ctx}>
      <a href="#main" className="skip">Bỏ qua điều hướng</a>
      <Header />
      <main id="main" tabIndex={-1}><Routes /></main>
      <Footer />
      <TabBar />
      <LiveRegion />
    </AuthContext.Provider>
  );
}
