import { useState, type FormEvent } from "react";
import { errMsg } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import { nccApi, useNcc } from "../../lib/ncc";
import { usePageMeta } from "../../lib/router";
import { announce } from "../../lib/store";
import { ErrorBox, Field, Loading, Notice, useAsync } from "../../ui";

interface U { id: number; fullName: string; email: string; phone: string | null; status: "invited" | "active" | "locked"; lastLoginAt: string | null; isMe: boolean }
const U_LABEL = { invited: "Chưa đặt mật khẩu", active: "Đang hoạt động", locked: "Tạm khoá" };

export function NccAccountPage() {
  usePageMeta("Tài khoản");
  const { me } = useNcc();
  const users = useAsync(() => nccApi<{ items: U[] }>("/users"), []);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setOk(false);
    if (pw.length < 10) { setErr("Mật khẩu mới tối thiểu 10 ký tự."); return; }
    if (pw !== pw2) { setErr("Hai mật khẩu mới chưa giống nhau."); return; }
    setBusy(true);
    try {
      await nccApi("/me/password", { body: { currentPassword: cur, newPassword: pw } });
      setOk(true); setCur(""); setPw(""); setPw2(""); announce("Đã đổi mật khẩu");
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  if (!me) return <Loading />;
  return (
    <div className="ncc-page">
      <div className="ncc-head"><div><h1>Tài khoản</h1><p className="muted">Thông tin đăng nhập và người dùng của {me.supplier.name}.</p></div></div>
      <div className="order-cols">
        <div>
          <section className="card-box" aria-labelledby="h-me">
            <h2 id="h-me">Thông tin của bạn</h2>
            <div className="acc-head"><span className="avatar" aria-hidden="true">{me.fullName.trim().split(/\s+/).slice(-1)[0]?.[0]?.toUpperCase() ?? "?"}</span><div><strong>{me.fullName}</strong><div className="muted small wrap-any">{me.email}</div></div></div>
            <dl className="info">
              <div><dt>Nhà cung cấp</dt><dd>{me.supplier.name} <span className="muted">({me.supplier.code})</span></dd></div>
              {me.phone && <div><dt>Số điện thoại</dt><dd>{me.phone}</dd></div>}
            </dl>
          </section>
          <section className="card-box" aria-labelledby="h-pw">
            <h2 id="h-pw">Đổi mật khẩu</h2>
            <form onSubmit={submit} noValidate>
              <Field id="pw-cur" label="Mật khẩu hiện tại">{(p) => <input {...p} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />}</Field>
              <Field id="pw-new" label="Mật khẩu mới" hint="Tối thiểu 10 ký tự. Đổi mật khẩu sẽ đăng xuất các thiết bị khác.">{(p) => <input {...p} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
              <Field id="pw-new2" label="Nhập lại mật khẩu mới">{(p) => <input {...p} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
              {err && <Notice kind="err">{err}</Notice>}
              {ok && <Notice kind="ok">Đã đổi mật khẩu.</Notice>}
              <button className="btn" disabled={busy || !cur || !pw} type="submit">{busy ? "Đang lưu…" : "Đổi mật khẩu"}</button>
            </form>
          </section>
        </div>
        <div>
          <section className="card-box" aria-labelledby="h-users">
            <h2 id="h-users">Người dùng của nhà cung cấp</h2>
            <p className="muted small">Chỉ xem. Muốn thêm hoặc khoá người dùng, vui lòng liên hệ cửa hàng.</p>
            {users.loading && !users.data ? <Loading /> : users.error || !users.data ? <ErrorBox error={users.error} onRetry={users.reload} /> : (
              <ul className="ncc-users">
                {users.data.items.map((u) => (
                  <li key={u.id}>
                    <div><strong>{u.fullName}</strong>{u.isMe && <span className="status ok ncc-late">Bạn</span>}<div className="muted small wrap-any">{u.email}{u.phone ? ` · ${u.phone}` : ""}</div></div>
                    <div className="ncc-u-st"><span className={`status ${u.status === "active" ? "ok" : u.status === "locked" ? "bad" : "warn"}`}>{U_LABEL[u.status]}</span>{u.lastLoginAt && <small className="muted">Vào lần cuối {fmtDateTime(u.lastLoginAt)}</small>}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
