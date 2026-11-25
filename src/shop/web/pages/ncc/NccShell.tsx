import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, errMsg } from "../../lib/api";
import { LogoMark } from "../../lib/art";
import { Link, match, navigate, useLocation, usePageMeta } from "../../lib/router";
import { NccAuthContext, nccApi, useNcc, useNoIndex, type NccMe } from "../../lib/ncc";
import { announce } from "../../lib/store";
import { useTurnstile } from "../../lib/turnstile";
import { Field, Icon, Loading, Notice } from "../../ui";
import { NccOrderDetailPage, NccOrdersPage } from "./NccOrders";
import { NccDebtPage, NccPaymentsPage } from "./NccMoney";
import { NccAccountPage } from "./NccAccount";

/** Cổng nhà cung cấp /ncc — vỏ ứng dụng, đăng nhập, đặt mật khẩu từ link mời. Phiên riêng (cookie __Host-ncc), không dùng chung phiên khách. */

const TABS = [
  { to: "/ncc", n: "box", t: "Đơn đặt hàng", on: (p: string) => p === "/ncc" || p.startsWith("/ncc/don") },
  { to: "/ncc/cong-no", n: "receipt", t: "Công nợ", on: (p: string) => p.startsWith("/ncc/cong-no") },
  { to: "/ncc/thanh-toan", n: "card", t: "Thanh toán", on: (p: string) => p.startsWith("/ncc/thanh-toan") },
  { to: "/ncc/tai-khoan", n: "user", t: "Tài khoản", on: (p: string) => p.startsWith("/ncc/tai-khoan") },
];

const safeNext = (n: string | null) => (n && /^\/ncc(\/|$|\?)/.test(n) && !/^\/ncc\/(dang-nhap|dat-mat-khau)/.test(n) ? n : "/ncc");

function Brand({ sub }: { sub?: string }) {
  return (
    <Link to="/ncc" className="brand" aria-label="Hữu Mạnh — cổng nhà cung cấp">
      <LogoMark size={34} />
      <span className="brand-name">Hữu Mạnh<small>{sub ?? "Cổng nhà cung cấp"}</small></span>
    </Link>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { me, setMe } = useNcc();
  const path = useLocation().split("?")[0].replace(/\/+$/, "") || "/ncc";
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    setBusy(true);
    try { await api("/ncc/auth/logout", { body: {} }); } catch { /* vẫn thoát ở máy này */ }
    setMe(null);
    navigate("/ncc/dang-nhap", true);
  };
  return (
    <div className="ncc">
      <header className="top ncc-top">
        <div className="wrap ncc-top-in">
          <Brand />
          <nav className="ncc-nav" aria-label="Điều hướng cổng nhà cung cấp">
            {TABS.map((t) => <Link key={t.to} to={t.to} className={t.on(path) ? "on" : ""} aria-current={t.on(path) ? "page" : undefined}>{t.t}</Link>)}
          </nav>
          <div className="ncc-who">
            <span className="ncc-who-name"><strong>{me?.supplier.name}</strong><small>{me?.fullName}</small></span>
            <button className="btn sm ghost" onClick={logout} disabled={busy} aria-label="Đăng xuất"><Icon n="logout" size={18} /><span className="lbl">Đăng xuất</span></button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="wrap page ncc-main">{children}</main>
      <nav className="tabbar" aria-label="Điều hướng nhanh">
        {TABS.map((t) => (
          <Link key={t.to} to={t.to} className={t.on(path) ? "on" : ""} aria-current={t.on(path) ? "page" : undefined}>
            <span className="ti"><Icon n={t.n} size={24} /></span><span>{t.t}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

function AuthShell({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="ncc ncc-auth">
      <div className="wrap ncc-auth-in">
        <Brand />
        <div className="auth-card">
          <h1>{title}</h1>
          {sub && <p className="muted">{sub}</p>}
          {children}
        </div>
        <p className="ncc-auth-foot muted small">Cổng dành riêng cho nhà cung cấp của Hữu Mạnh. Chưa có tài khoản? Vui lòng liên hệ cửa hàng để được mời.</p>
      </div>
    </div>
  );
}

function LoginPage() {
  usePageMeta("Đăng nhập nhà cung cấp");
  const { setMe, me } = useNcc();
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const ts = useTurnstile();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (me) navigate(next, true); }, [me, next]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!email.trim() || !pw) { setErr("Vui lòng nhập email và mật khẩu."); return; }
    setBusy(true);
    try {
      const r = await api<{ account: NccMe }>("/ncc/auth/login", { body: { email: email.trim(), password: pw }, turnstile: ts.token });
      setMe(r.account);
      announce("Đăng nhập thành công");
      navigate(next, true);
    } catch (x) { setErr(errMsg(x)); ts.reset(); } finally { setBusy(false); }
  };
  return (
    <AuthShell title="Đăng nhập" sub="Xem đơn đặt hàng, công nợ và thanh toán với Hữu Mạnh.">
      <form onSubmit={submit} noValidate>
        <Field id="ncc-email" label="Email">{(p) => <input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field id="ncc-pw" label="Mật khẩu">{(p) => <input {...p} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        {ts.node}
        {err && <Notice kind="err">{err}</Notice>}
        <button className="btn lg block" type="submit" disabled={busy || !ts.ready}>{busy ? "Đang đăng nhập…" : "Đăng nhập"}</button>
      </form>
      <p className="auth-links"><span className="muted">Quên mật khẩu? Liên hệ cửa hàng để nhận link đặt lại.</span></p>
    </AuthShell>
  );
}

function SetPasswordPage() {
  usePageMeta("Đặt mật khẩu nhà cung cấp");
  const { setMe } = useNcc();
  const ts = useTurnstile();
  // token nằm ở phần #fragment (không gửi lên máy chủ / Referer); đọc xong xoá khỏi thanh địa chỉ
  const [token] = useState(() => {
    const t = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (t) history.replaceState({}, "", location.pathname);
    return t;
  });
  const [info, setInfo] = useState<{ fullName: string; email: string; supplierName: string; firstTime: boolean } | null>(null);
  const [bad, setBad] = useState<string | null>(token ? null : "Liên kết không đầy đủ. Hãy mở lại đúng đường dẫn cửa hàng đã gửi cho bạn.");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    api<typeof info>("/ncc/auth/invite", { body: { token } }).then(setInfo, (e) => setBad(errMsg(e)));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (pw.length < 10) { setErr("Mật khẩu tối thiểu 10 ký tự."); return; }
    if (pw !== pw2) { setErr("Hai mật khẩu chưa giống nhau."); return; }
    setBusy(true);
    try {
      const r = await api<{ account: NccMe }>("/ncc/auth/accept", { body: { token, password: pw }, turnstile: ts.token });
      setMe(r.account);
      announce("Đã đặt mật khẩu");
      navigate("/ncc", true);
    } catch (x) { setErr(errMsg(x)); ts.reset(); } finally { setBusy(false); }
  };
  if (bad) return <AuthShell title="Liên kết không dùng được"><Notice kind="err">{bad}</Notice><Link to="/ncc/dang-nhap" className="btn lg block ghost">Về trang đăng nhập</Link></AuthShell>;
  if (!info) return <AuthShell title="Đang kiểm tra liên kết…"><Loading /></AuthShell>;
  return (
    <AuthShell title={info.firstTime ? "Chào mừng bạn" : "Đặt lại mật khẩu"} sub={`${info.fullName} · ${info.supplierName}`}>
      <p className="small muted">Tên đăng nhập của bạn là <strong className="wrap-any">{info.email}</strong>.</p>
      <form onSubmit={submit} noValidate>
        <Field id="sp-pw" label="Mật khẩu mới" hint="Tối thiểu 10 ký tự.">{(p) => <input {...p} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        <Field id="sp-pw2" label="Nhập lại mật khẩu">{(p) => <input {...p} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
        {ts.node}
        {err && <Notice kind="err">{err}</Notice>}
        <button className="btn lg block" type="submit" disabled={busy || !ts.ready}>{busy ? "Đang lưu…" : info.firstTime ? "Đặt mật khẩu và vào cổng" : "Lưu mật khẩu mới"}</button>
      </form>
    </AuthShell>
  );
}

function NotFound() {
  usePageMeta("Không tìm thấy trang");
  return <div className="state"><h1>Không tìm thấy trang</h1><Link to="/ncc" className="btn">Về đơn đặt hàng</Link></div>;
}

export default function NccApp() {
  useNoIndex();
  const loc = useLocation();
  const path = loc.split("?")[0].replace(/\/+$/, "") || "/ncc";
  const [me, setMeState] = useState<NccMe | null>(null);
  const [ready, setReady] = useState(false);
  const setMe = useCallback((m: NccMe | null) => { setMeState(m); setReady(true); }, []);
  useEffect(() => {
    nccApi<{ account: NccMe }>("/me").then((r) => setMe(r.account), () => setMe(null));
  }, [setMe]);
  useEffect(() => {
    const f = () => setMe(null);
    window.addEventListener("ncc:unauth", f);
    return () => window.removeEventListener("ncc:unauth", f);
  }, [setMe]);
  const ctx = useMemo(() => ({ me, ready, setMe }), [me, ready, setMe]);
  const isAuthPage = path === "/ncc/dang-nhap" || path === "/ncc/dat-mat-khau";
  // chưa đăng nhập → về trang đăng nhập (giữ đường dẫn để quay lại)
  useEffect(() => {
    if (ready && !me && !isAuthPage) navigate(`/ncc/dang-nhap?next=${encodeURIComponent(loc)}`, true);
  }, [ready, me, isAuthPage, loc]);

  let body: ReactNode;
  let m: Record<string, string> | null;
  if (path === "/ncc/dat-mat-khau") body = <SetPasswordPage />;
  else if (path === "/ncc/dang-nhap") body = <LoginPage />;
  else if (!ready) body = <div className="ncc"><Loading /></div>;
  else if (!me) body = <div className="ncc"><Loading /></div>;
  else {
    let page: ReactNode;
    if (path === "/ncc") page = <NccOrdersPage />;
    else if ((m = match("/ncc/don/:id", path))) page = <NccOrderDetailPage key={m.id} id={Number(m.id)} />;
    else if (path === "/ncc/cong-no") page = <NccDebtPage />;
    else if (path === "/ncc/thanh-toan") page = <NccPaymentsPage />;
    else if (path === "/ncc/tai-khoan") page = <NccAccountPage />;
    else page = <NotFound />;
    body = <Frame>{page}</Frame>;
  }
  return <NccAuthContext.Provider value={ctx}>{body}</NccAuthContext.Provider>;
}
