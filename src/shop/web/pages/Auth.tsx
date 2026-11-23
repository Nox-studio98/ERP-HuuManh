import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, errMsg, type Me } from "../lib/api";
import { Link, navigate, useQuery, usePageMeta } from "../lib/router";
import { announce, useAuth } from "../lib/store";
import { useTurnstile } from "../lib/turnstile";
import { Field, Loading, Notice } from "../ui";

function Shell({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="wrap page auth">
      <div className="auth-card">
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

const safeNext = (n: string | null) => (n && /^\/(?![\/\\])/.test(n) ? n : "/tai-khoan");

export function LoginPage() {
  usePageMeta("Đăng nhập");
  const { setMe, me } = useAuth();
  const qs = useQuery();
  const next = safeNext(qs.get("next"));
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
      const r = await api<{ account: Me }>("/auth/login", { body: { email: email.trim(), password: pw }, turnstile: ts.token });
      setMe(r.account);
      announce("Đăng nhập thành công");
      navigate(next, true);
    } catch (x) { setErr(errMsg(x)); ts.reset(); } finally { setBusy(false); }
  };
  return (
    <Shell title="Đăng nhập" sub="Xem đơn hàng, lưu địa chỉ và mua lại nhanh hơn.">
      <form onSubmit={submit} noValidate>
        <Field id="lg-email" label="Email">{(p) => <input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field id="lg-pw" label="Mật khẩu">{(p) => <input {...p} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        {ts.node}
        {err && <Notice kind="err">{err}</Notice>}
        <button className="btn lg block" type="submit" disabled={busy || !ts.ready}>{busy ? "Đang đăng nhập…" : "Đăng nhập"}</button>
      </form>
      <p className="auth-links"><Link to="/quen-mat-khau">Quên mật khẩu?</Link><span>Chưa có tài khoản? <Link to={`/dang-ky${next !== "/tai-khoan" ? `?next=${encodeURIComponent(next)}` : ""}`}>Đăng ký</Link></span></p>
    </Shell>
  );
}

export function RegisterPage() {
  usePageMeta("Đăng ký tài khoản");
  const qs = useQuery();
  const next = safeNext(qs.get("next"));
  const ts = useTurnstile();
  const [f, setF] = useState({ fullName: "", email: "", phone: "", password: "", marketingOptIn: false });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (!f.fullName.trim()) v.fullName = "Vui lòng nhập họ tên";
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) v.email = "Email chưa hợp lệ";
    if (!/^(\+?84|0)[\d\s.\-()]{8,12}$/.test(f.phone.trim())) v.phone = "Số điện thoại chưa hợp lệ";
    if (f.password.length < 8) v.password = "Mật khẩu tối thiểu 8 ký tự";
    setErrs(v);
    setErr(null);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await api("/auth/register", { body: { fullName: f.fullName.trim(), email: f.email.trim(), phone: f.phone.trim(), password: f.password, marketingOptIn: f.marketingOptIn }, turnstile: ts.token });
      setDone(true);
    } catch (x) { setErr(errMsg(x)); ts.reset(); } finally { setBusy(false); }
  };
  if (done)
    return (
      <Shell title="Kiểm tra email của bạn">
        <Notice kind="ok">Nếu thông tin hợp lệ, chúng tôi đã gửi email xác minh tới <strong>{f.email}</strong>. Bạn có thể đăng nhập ngay bây giờ.</Notice>
        <Link to={`/dang-nhap${next !== "/tai-khoan" ? `?next=${encodeURIComponent(next)}` : ""}`} className="btn lg block">Đăng nhập</Link>
      </Shell>
    );
  return (
    <Shell title="Tạo tài khoản" sub="Miễn phí, chỉ mất một phút.">
      <form onSubmit={submit} noValidate>
        <Field id="rg-name" label="Họ và tên" error={errs.fullName}>{(p) => <input {...p} autoComplete="name" value={f.fullName} onChange={set("fullName")} />}</Field>
        <Field id="rg-email" label="Email" error={errs.email}>{(p) => <input {...p} type="email" autoComplete="email" value={f.email} onChange={set("email")} />}</Field>
        <Field id="rg-phone" label="Số điện thoại" error={errs.phone}>{(p) => <input {...p} type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set("phone")} />}</Field>
        <Field id="rg-pw" label="Mật khẩu" hint="Tối thiểu 8 ký tự." error={errs.password}>{(p) => <input {...p} type="password" autoComplete="new-password" value={f.password} onChange={set("password")} />}</Field>
        <label className="check"><input type="checkbox" checked={f.marketingOptIn} onChange={(e) => setF((x) => ({ ...x, marketingOptIn: e.target.checked }))} /> Nhận thông tin khuyến mãi qua email</label>
        {ts.node}
        {err && <Notice kind="err">{err}</Notice>}
        <button className="btn lg block" type="submit" disabled={busy || !ts.ready}>{busy ? "Đang tạo tài khoản…" : "Đăng ký"}</button>
      </form>
      <p className="auth-links"><span>Đã có tài khoản? <Link to="/dang-nhap">Đăng nhập</Link></span></p>
    </Shell>
  );
}

export function ForgotPage() {
  usePageMeta("Quên mật khẩu");
  const ts = useTurnstile();
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setErr("Email chưa hợp lệ"); return; }
    setBusy(true);
    try { const r = await api<{ message: string }>("/auth/forgot", { body: { email: email.trim() }, turnstile: ts.token }); setMsg(r.message); }
    catch (x) { setErr(errMsg(x)); ts.reset(); } finally { setBusy(false); }
  };
  return (
    <Shell title="Quên mật khẩu" sub="Nhập email đăng ký, chúng tôi sẽ gửi liên kết đặt lại mật khẩu.">
      {msg ? <Notice kind="ok">{msg}</Notice> : (
        <form onSubmit={submit} noValidate>
          <Field id="fg-email" label="Email">{(p) => <input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          {ts.node}
          {err && <Notice kind="err">{err}</Notice>}
          <button className="btn lg block" type="submit" disabled={busy || !ts.ready}>Gửi liên kết</button>
        </form>
      )}
      <p className="auth-links"><Link to="/dang-nhap">Quay lại đăng nhập</Link></p>
    </Shell>
  );
}

export function ResetPage() {
  usePageMeta("Đặt lại mật khẩu");
  const token = useQuery().get("token") ?? "";
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (pw.length < 8) { setErr("Mật khẩu tối thiểu 8 ký tự"); return; }
    if (pw !== pw2) { setErr("Mật khẩu nhập lại không khớp"); return; }
    setBusy(true);
    try { await api("/auth/reset", { body: { token, password: pw } }); setOk(true); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  if (!token) return <Shell title="Đặt lại mật khẩu"><Notice kind="err">Liên kết không hợp lệ. Vui lòng yêu cầu gửi lại email.</Notice><Link to="/quen-mat-khau" className="btn block">Gửi lại liên kết</Link></Shell>;
  return (
    <Shell title="Đặt mật khẩu mới">
      {ok ? <><Notice kind="ok">Đã đặt lại mật khẩu. Vui lòng đăng nhập bằng mật khẩu mới.</Notice><Link to="/dang-nhap" className="btn lg block">Đăng nhập</Link></> : (
        <form onSubmit={submit} noValidate>
          <Field id="rs-pw" label="Mật khẩu mới" hint="Tối thiểu 8 ký tự.">{(p) => <input {...p} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          <Field id="rs-pw2" label="Nhập lại mật khẩu mới">{(p) => <input {...p} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
          {err && <Notice kind="err">{err}</Notice>}
          <button className="btn lg block" type="submit" disabled={busy}>Đặt lại mật khẩu</button>
        </form>
      )}
    </Shell>
  );
}

export function VerifyEmailPage() {
  usePageMeta("Xác minh email");
  const token = useQuery().get("token") ?? "";
  const [st, setSt] = useState<"loading" | "ok" | "err">(token ? "loading" : "err");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!token) return;
    api("/auth/verify-email", { body: { token } }).then(() => setSt("ok"), (e) => { setMsg(errMsg(e)); setSt("err"); });
  }, [token]);
  return (
    <Shell title="Xác minh email">
      {st === "loading" ? <Loading label="Đang xác minh…" /> : st === "ok" ? <><Notice kind="ok">Email của bạn đã được xác minh. Cảm ơn bạn!</Notice><Link to="/tai-khoan" className="btn lg block">Vào tài khoản</Link></> : <Notice kind="err">{msg || "Liên kết không hợp lệ hoặc đã hết hạn."}</Notice>}
    </Shell>
  );
}
