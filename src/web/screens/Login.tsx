import { useState } from "react";
import { Button, Input } from "../components/ui";
import { changePassword, login, logout } from "../store";
import { deviceId } from "../api";
import { toast } from "../components/toast";

export default function Login() {
  const [u, setU] = useState(""), [p, setP] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await login(u.trim(), p, deviceId()); } catch { /* toast đã hiện */ } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit} aria-labelledby="lt">
        <div className="stack" style={{ alignItems: "center", textAlign: "center", gap: 8 }}>
          <img className="logo" src="/icon.svg" alt="" />
          <h1 id="lt">Hữu Mạnh ERP</h1>
          <div className="muted small">Đăng nhập để bắt đầu ca làm việc</div>
        </div>
        <Input label="Tên đăng nhập" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoCapitalize="none" required />
        <Input label="Mật khẩu" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required />
        <Button type="submit" size="lg" block loading={busy} disabled={!u || !p}>Đăng nhập</Button>
      </form>
    </div>
  );
}

export function ChangePassword() {
  const [cur, setCur] = useState(""), [n1, setN1] = useState(""), [n2, setN2] = useState(""), [busy, setBusy] = useState(false);
  const err = n1 && n1.length < 10 ? "Mật khẩu mới tối thiểu 10 ký tự" : n2 && n1 !== n2 ? "Mật khẩu nhập lại chưa khớp" : "";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (err) return; setBusy(true);
    try { await changePassword(cur, n1); toast("Đã đổi mật khẩu", "ok"); } catch {} finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <h1>Đổi mật khẩu</h1>
        <div className="banner info">Đây là lần đăng nhập đầu hoặc mật khẩu tạm. Vui lòng đặt mật khẩu mới để tiếp tục.</div>
        <Input label="Mật khẩu hiện tại" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
        <Input label="Mật khẩu mới" type="password" value={n1} onChange={(e) => setN1(e.target.value)} autoComplete="new-password" required />
        <Input label="Nhập lại mật khẩu mới" type="password" value={n2} onChange={(e) => setN2(e.target.value)} autoComplete="new-password" error={err} required />
        <Button type="submit" size="lg" block loading={busy} disabled={!cur || !n1 || !n2 || !!err}>Đổi mật khẩu</Button>
        <Button variant="ghost" block onClick={logout}>Đăng xuất</Button>
      </form>
    </div>
  );
}
