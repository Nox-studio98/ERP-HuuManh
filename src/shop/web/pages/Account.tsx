import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, errMsg, type Address, type Card, type Me, type OrderView } from "../lib/api";
import { DISTRICTS, PROVINCE } from "../lib/geo";
import { fmtDateTime, money } from "../lib/format";
import { Link, match, navigate, usePageMeta } from "../lib/router";
import { announce, cartActions, itemFromCard, LOGGED_FLAG, ls, ss, stepInUnit, useAuth } from "../lib/store";
import { Empty, ErrorBox, Field, Loading, Modal, Notice, useAsync } from "../ui";
import { MyOrderPage } from "./Track";

const STATUS_TONE: Record<string, string> = { completed: "ok", cancelled: "bad", returned: "bad", delivery_failed: "bad", awaiting_payment: "warn", shipping: "info" };

/* ---------- đơn hàng ---------- */
async function reorder(code: string) {
  const r = await api<{ items: { productId: number; slug: string; unit: string; qty: number }[]; unavailable: { name: string }[] }>(`/me/orders/${encodeURIComponent(code)}/reorder`, { body: {} });
  const cards = await Promise.all(r.items.map((i) => api<Card>(`/products/${encodeURIComponent(i.slug)}`).catch(() => null)));
  const items = [];
  const skipped: string[] = r.unavailable.map((u) => u.name);
  for (let k = 0; k < r.items.length; k++) {
    const c = cards[k];
    const i = r.items[k];
    if (!c || (!c.inStock && !c.allowPreorder)) { skipped.push(c?.name ?? i.slug); continue; }
    const base = itemFromCard(c, i.unit);
    const step = stepInUnit(base);
    const q = Math.max(step, Math.round(Math.round(i.qty * 1000) / step) * step);
    items.push({ ...base, qtyMilli: q });
  }
  if (items.length) cartActions.merge(items);
  if (skipped.length) ss.set("hm_reorder_note", `Một số sản phẩm không còn bán hoặc tạm hết hàng nên chưa thêm vào giỏ: ${skipped.join(", ")}.`);
  return items.length;
}

function Orders() {
  usePageMeta("Đơn hàng của tôi");
  const { data, error, loading, reload } = useAsync(() => api<OrderView[]>("/me/orders"), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data.length) return <Empty title="Bạn chưa có đơn hàng nào" art><p>Đơn hàng của bạn sẽ hiện ở đây.</p><Link to="/san-pham" className="btn">Bắt đầu mua sắm</Link></Empty>;
  return (
    <div>
      {err && <Notice kind="err">{err}</Notice>}
      <ul className="orders" data-testid="orders">
        {data.map((o) => (
          <li key={o.code} className="card-box order-card">
            <div className="oc-head">
              <Link to={`/tai-khoan/don-hang/${encodeURIComponent(o.code)}`} className="oc-code">{o.code}</Link>
              <span className={`status ${STATUS_TONE[o.status] ?? "info"}`}>{o.statusLabel}</span>
            </div>
            <p className="muted small">{fmtDateTime(o.createdAt)} · {o.lines.length} sản phẩm</p>
            <p className="oc-items">{o.lines.slice(0, 3).map((l) => l.name).join(", ")}{o.lines.length > 3 ? "…" : ""}</p>
            <div className="oc-foot">
              <strong>{money(o.total)}</strong>
              <span className="row-actions">
                <Link to={`/tai-khoan/don-hang/${encodeURIComponent(o.code)}`} className="btn sm ghost">Chi tiết</Link>
                <button
                  className="btn sm"
                  disabled={busy === o.code}
                  onClick={async () => {
                    setBusy(o.code); setErr(null);
                    try { const n = await reorder(o.code); if (n) navigate("/gio-hang"); else setErr("Các sản phẩm trong đơn này hiện không còn bán hoặc đã hết hàng."); }
                    catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
                  }}
                >Mua lại</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- sổ địa chỉ ---------- */
const EMPTY = { label: "", receiverName: "", receiverPhone: "", addressLine: "", ward: "", district: "", province: PROVINCE, isDefault: false };

function AddressForm({ init, onClose, onSaved }: { init: Address | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(init ? { label: init.label ?? "", receiverName: init.receiverName, receiverPhone: init.receiverPhone, addressLine: init.addressLine, ward: init.ward ?? "", district: init.district, province: init.province, isDefault: init.isDefault } : EMPTY);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string> = {};
    if (!f.receiverName.trim()) v.receiverName = "Vui lòng nhập họ tên người nhận";
    if (!/^(\+?84|0)[\d\s.\-()]{8,12}$/.test(f.receiverPhone.trim())) v.receiverPhone = "Số điện thoại chưa hợp lệ";
    if (!f.addressLine.trim()) v.addressLine = "Vui lòng nhập số nhà, tên đường";
    if (!f.district) v.district = "Vui lòng chọn quận/huyện";
    setErrs(v); setErr(null);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      const body = { label: f.label.trim() || null, receiverName: f.receiverName.trim(), receiverPhone: f.receiverPhone.trim(), addressLine: f.addressLine.trim(), ward: f.ward.trim() || null, district: f.district, province: f.province.trim() || PROVINCE, isDefault: f.isDefault };
      await api(init ? `/me/addresses/${init.id}` : "/me/addresses", { method: init ? "PUT" : "POST", body });
      onSaved();
    } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate className="form-grid">
      <Field id="ad-label" label="Tên gợi nhớ (Nhà, Công ty…)">{(p) => <input {...p} value={f.label} onChange={set("label")} maxLength={50} />}</Field>
      <Field id="ad-name" label="Họ tên người nhận" error={errs.receiverName}>{(p) => <input {...p} autoComplete="name" value={f.receiverName} onChange={set("receiverName")} />}</Field>
      <Field id="ad-phone" label="Số điện thoại" error={errs.receiverPhone}>{(p) => <input {...p} type="tel" autoComplete="tel" value={f.receiverPhone} onChange={set("receiverPhone")} />}</Field>
      <Field id="ad-line" label="Số nhà, tên đường" error={errs.addressLine}>{(p) => <input {...p} value={f.addressLine} onChange={set("addressLine")} />}</Field>
      <Field id="ad-ward" label="Phường/xã">{(p) => <input {...p} value={f.ward} onChange={set("ward")} />}</Field>
      <Field id="ad-district" label="Quận/huyện" error={errs.district}>
        {(p) => <select {...p} value={f.district} onChange={set("district")}><option value="">Chọn quận/huyện…</option>{DISTRICTS.map((d) => <option key={d} value={d}>{d}</option>)}</select>}
      </Field>
      <Field id="ad-prov" label="Tỉnh/thành phố">{(p) => <input {...p} value={f.province} onChange={set("province")} />}</Field>
      <label className="check full"><input type="checkbox" checked={f.isDefault} onChange={(e) => setF((x) => ({ ...x, isDefault: e.target.checked }))} /> Đặt làm địa chỉ mặc định</label>
      {err && <div className="full"><Notice kind="err">{err}</Notice></div>}
      <div className="full row-actions end"><button type="button" className="btn ghost" onClick={onClose}>Huỷ</button><button className="btn" type="submit" disabled={busy}>Lưu địa chỉ</button></div>
    </form>
  );
}

function Addresses() {
  usePageMeta("Sổ địa chỉ");
  const { data, error, loading, reload } = useAsync(() => api<{ items: Address[] }>("/me/addresses"), []);
  const [edit, setEdit] = useState<Address | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} onRetry={reload} />;
  const del = async (a: Address) => {
    setErr(null);
    try { await api(`/me/addresses/${a.id}`, { method: "DELETE" }); announce("Đã xoá địa chỉ"); reload(); } catch (e) { setErr(errMsg(e)); }
  };
  return (
    <div>
      <div className="sec-head"><h2>Sổ địa chỉ</h2><button className="btn sm" onClick={() => setEdit("new")}>Thêm địa chỉ</button></div>
      {err && <Notice kind="err">{err}</Notice>}
      {data.items.length === 0 ? <Empty title="Chưa có địa chỉ nào"><p>Lưu địa chỉ để đặt hàng nhanh hơn.</p></Empty> : (
        <ul className="addr-cards" data-testid="addresses">
          {data.items.map((a) => (
            <li key={a.id} className="card-box">
              <p><strong>{a.label || a.receiverName}</strong>{a.isDefault && <em className="badge soft">Mặc định</em>}</p>
              <p>{a.receiverName} · {a.receiverPhone}</p>
              <p className="muted">{[a.addressLine, a.ward, a.district, a.province].filter(Boolean).join(", ")}</p>
              <p className="row-actions">
                <button className="btn sm ghost" onClick={() => setEdit(a)}>Sửa</button>
                <button className="btn sm ghost danger" onClick={() => del(a)} aria-label={`Xoá địa chỉ ${a.label || a.addressLine}`}>Xoá</button>
              </p>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === "new" ? "Thêm địa chỉ" : "Sửa địa chỉ"}>
        {edit && <AddressForm init={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); announce("Đã lưu địa chỉ"); reload(); }} />}
      </Modal>
    </div>
  );
}

/* ---------- hồ sơ ---------- */
function Profile({ me }: { me: Me }) {
  usePageMeta("Hồ sơ của tôi");
  const { setMe } = useAuth();
  const [name, setName] = useState(me.fullName);
  const [phone, setPhone] = useState(me.phone ?? "");
  const [mk, setMk] = useState(me.marketingOptIn);
  const [msg, setMsg] = useState<{ k: "ok" | "err"; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [pw, setPw] = useState("");
  const [delErr, setDelErr] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try { const m = await api<Me>("/me", { method: "PUT", body: { fullName: name.trim(), phone: phone.trim() || undefined, marketingOptIn: mk } }); setMe(m); setMsg({ k: "ok", t: "Đã lưu thay đổi." }); }
    catch (x) { setMsg({ k: "err", t: errMsg(x) }); } finally { setBusy(false); }
  };
  const logout = async () => {
    try { await api("/auth/logout", { body: {} }); } catch { /* vẫn đăng xuất phía client */ }
    setMe(null); announce("Đã đăng xuất"); navigate("/");
  };
  const remove = async (e: FormEvent) => {
    e.preventDefault();
    setDelErr(null); setBusy(true);
    try {
      await api("/me", { method: "DELETE", body: { password: pw } });
      ls.del(LOGGED_FLAG); setMe(null); setDel(false); announce("Tài khoản đã được xoá"); navigate("/");
    } catch (x) { setDelErr(x instanceof ApiError && x.code === "active_orders" ? "Bạn còn đơn hàng đang xử lý. Vui lòng chờ đơn hoàn tất hoặc huỷ đơn trước khi xoá tài khoản." : errMsg(x)); }
    finally { setBusy(false); }
  };
  return (
    <div className="profile">
      <h2>Thông tin cá nhân</h2>
      <form onSubmit={save} noValidate className="form-grid">
        <Field id="pf-email" label="Email" hint="Email đăng nhập không thể thay đổi.">{(p) => <input {...p} value={me.email} readOnly />}</Field>
        <Field id="pf-name" label="Họ và tên">{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field id="pf-phone" label="Số điện thoại">{(p) => <input {...p} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <label className="check full"><input type="checkbox" checked={mk} onChange={(e) => setMk(e.target.checked)} /> Nhận thông tin khuyến mãi qua email</label>
        {msg && <div className="full"><Notice kind={msg.k}>{msg.t}</Notice></div>}
        <div className="full row-actions"><button className="btn" type="submit" disabled={busy}>Lưu thay đổi</button><button type="button" className="btn ghost" onClick={logout}>Đăng xuất</button></div>
      </form>
      <section className="danger-zone">
        <h3>Xoá tài khoản</h3>
        <p className="muted">Theo Nghị định 13/2023/NĐ-CP, bạn có quyền yêu cầu xoá dữ liệu cá nhân. Tên, email, số điện thoại và địa chỉ đã lưu sẽ được ẩn danh hoá; chứng từ đơn hàng được giữ lại theo quy định kế toán.</p>
        <button className="btn ghost danger" onClick={() => { setDel(true); setPw(""); setDelErr(null); }}>Xoá tài khoản của tôi</button>
      </section>
      <Modal open={del} onClose={() => setDel(false)} title="Xoá tài khoản?">
        <form onSubmit={remove} noValidate>
          <p>Thao tác này không thể hoàn tác. Nhập mật khẩu để xác nhận.</p>
          <Field id="del-pw" label="Mật khẩu">{(p) => <input {...p} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          {delErr && <Notice kind="err">{delErr}</Notice>}
          <div className="row-actions end"><button type="button" className="btn ghost" onClick={() => setDel(false)}>Giữ tài khoản</button><button className="btn danger" type="submit" disabled={busy || !pw}>Xoá vĩnh viễn</button></div>
        </form>
      </Modal>
    </div>
  );
}

export function AccountPage({ path }: { path: string }) {
  const { me, ready } = useAuth();
  usePageMeta("Tài khoản");
  useEffect(() => { if (ready && !me) navigate(`/dang-nhap?next=${encodeURIComponent(path)}`, true); }, [ready, me, path]);
  if (!ready || !me) return <div className="wrap page"><Loading /></div>;
  const m = match("/tai-khoan/don-hang/:code", path);
  const tab = path.startsWith("/tai-khoan/don-hang") ? "orders" : path.startsWith("/tai-khoan/dia-chi") ? "addr" : "profile";
  const tabs = [
    { k: "orders", to: "/tai-khoan/don-hang", t: "Đơn hàng" },
    { k: "addr", to: "/tai-khoan/dia-chi", t: "Địa chỉ" },
    { k: "profile", to: "/tai-khoan", t: "Hồ sơ" },
  ];
  return (
    <div className="wrap page account">
      <div className="acc-head">
        <div className="avatar" aria-hidden="true">{me.fullName.trim().charAt(0).toUpperCase()}</div>
        <div><h1>Xin chào, {me.fullName}</h1><p className="muted">{me.email}{me.kind === "b2b" && me.b2bStatus === "approved" ? " · Khách sỉ" : ""}</p></div>
      </div>
      <nav className="tabs" aria-label="Tài khoản">
        {tabs.map((t) => <Link key={t.k} to={t.to} className={tab === t.k ? "on" : ""} aria-current={tab === t.k ? "page" : undefined}>{t.t}</Link>)}
        <Link to="/si" className="">{me.kind === "b2b" && me.b2bStatus === "approved" ? "Đặt hàng sỉ" : "Mua sỉ"}</Link>
      </nav>
      {m ? <MyOrderPage code={m.code} /> : tab === "orders" ? <Orders /> : tab === "addr" ? <Addresses /> : <Profile me={me} />}
    </div>
  );
}
