import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, errMsg, type Card, type OrderView } from "../lib/api";
import { money, parseDec, todayVN, unitName, uuid } from "../lib/format";
import { Link, usePageMeta } from "../lib/router";
import { announce, useAuth } from "../lib/store";
import { Empty, ErrorBox, Field, Icon, Loading, Notice, useAsync } from "../ui";

interface Credit { creditLimit: number; balance: number; available: number; overdueAmount: number; overdue: boolean }
interface B2bAddr { id: number; label: string | null; address: string; isDefault: boolean }

function LinkRequest() {
  const { refresh } = useAuth();
  const [f, setF] = useState({ companyName: "", taxCode: "", note: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!f.companyName.trim()) { setErr("Vui lòng nhập tên công ty / cửa hàng."); return; }
    if (!/^[0-9-]{8,20}$/.test(f.taxCode.trim())) { setErr("Mã số thuế chưa hợp lệ (8–20 chữ số)."); return; }
    setBusy(true);
    try { await api("/b2b/link-request", { body: { companyName: f.companyName.trim(), taxCode: f.taxCode.trim(), note: f.note.trim() || undefined } }); announce("Đã gửi yêu cầu liên kết khách sỉ"); await refresh(); }
    catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <form className="card-box" onSubmit={submit} noValidate>
      <h2>Đăng ký tài khoản mua sỉ</h2>
      <p className="muted">Dành cho nhà hàng, quán cà phê, cửa hàng. Gửi thông tin để cửa hàng liên kết tài khoản với hồ sơ khách sỉ và áp bảng giá sỉ.</p>
      <Field id="b2b-co" label="Tên công ty / cửa hàng">{(p) => <input {...p} autoComplete="organization" value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} />}</Field>
      <Field id="b2b-tax" label="Mã số thuế">{(p) => <input {...p} inputMode="numeric" value={f.taxCode} onChange={(e) => setF({ ...f, taxCode: e.target.value })} />}</Field>
      <Field id="b2b-note" label="Ghi chú (không bắt buộc)">{(p) => <textarea {...p} rows={2} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}</Field>
      {err && <Notice kind="err">{err}</Notice>}
      <button className="btn lg block" type="submit" disabled={busy}>Gửi yêu cầu</button>
    </form>
  );
}

function QuickOrder() {
  const [q, setQ] = useState("");
  const cat = useAsync(() => api<{ items: Card[]; nextCursor: string | null; creditStatus: Credit }>(`/b2b/catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`), [q]);
  const addrs = useAsync(() => api<{ items: B2bAddr[] }>("/b2b/addresses"), []);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [addr, setAddr] = useState<number | "">("");
  const [date, setDate] = useState(todayVN(1));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; blocked?: boolean } | null>(null);
  const [done, setDone] = useState<OrderView | null>(null);
  const [uid, setUid] = useState(uuid());
  useEffect(() => { if (addr === "" && addrs.data?.items.length) setAddr((addrs.data.items.find((a) => a.isDefault) ?? addrs.data.items[0]).id); }, [addrs.data, addr]);

  const lines = useMemo(() => {
    const out: { c: Card; qty: number }[] = [];
    for (const c of cat.data?.items ?? []) { const v = parseDec(qty[c.id] ?? ""); if (v > 0) out.push({ c, qty: v }); }
    return out;
  }, [cat.data, qty]);
  const total = lines.reduce((s, l) => s + Math.round(l.c.price * l.qty), 0);
  const credit = cat.data?.creditStatus;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!lines.length) { setErr({ msg: "Vui lòng nhập số lượng cho ít nhất một mặt hàng." }); return; }
    if (addr === "") { setErr({ msg: "Vui lòng chọn địa chỉ giao hàng." }); return; }
    setBusy(true);
    try {
      const o = await api<OrderView>("/b2b/orders", { body: { clientUuid: uid, addressId: addr, deliveryDate: date, note: note.trim() || undefined, lines: lines.map((l) => ({ productId: l.c.id, unit: l.c.baseUnit, qty: l.qty })) } });
      setDone(o); setQty({}); setUid(uuid()); announce(`Đã tạo đơn ${o.code}`); cat.reload();
    } catch (x) {
      const a = x as ApiError;
      if (a.status !== 0 && a.status < 500) setUid(uuid());
      setErr({ msg: a.code === "credit_blocked" ? `Đơn bị chặn do công nợ: ${a.message}` : a.message, blocked: a.code === "credit_blocked" });
      cat.reload();
    } finally { setBusy(false); }
  };

  return (
    <div className="b2b">
      {credit && (
        <section className={`card-box credit ${credit.overdue ? "warn" : ""}`} aria-labelledby="h-credit" data-testid="credit">
          <h2 id="h-credit">Công nợ của bạn</h2>
          <dl className="credit-grid">
            <div><dt>Hạn mức</dt><dd>{money(credit.creditLimit)}</dd></div>
            <div><dt>Dư nợ hiện tại</dt><dd>{money(credit.balance)}</dd></div>
            <div><dt>Còn có thể đặt</dt><dd className={credit.available <= 0 ? "bad" : "good"}>{money(Math.max(0, credit.available))}</dd></div>
            {credit.overdue && <div><dt>Quá hạn</dt><dd className="bad">{money(credit.overdueAmount)}</dd></div>}
          </dl>
          {credit.overdue && <p className="hint err">Bạn có công nợ quá hạn; đơn mới có thể bị chặn đến khi thanh toán.</p>}
        </section>
      )}
      {done && <Notice kind="ok">Đã tạo đơn <strong>{done.code}</strong> ({money(done.total)}). <Link to={`/tai-khoan/don-hang/${encodeURIComponent(done.code)}`}>Xem đơn hàng</Link></Notice>}
      <form onSubmit={submit} noValidate>
        <div className="b2b-bar">
          <label className="sr-only" htmlFor="b2b-q">Tìm hàng</label>
          <input id="b2b-q" type="search" placeholder="Tìm mặt hàng…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {cat.loading && !cat.data ? <Loading /> : cat.error ? <ErrorBox error={cat.error} onRetry={cat.reload} /> : (
          <div className="table-wrap">
            <table className="qo">
              <caption className="sr-only">Bảng đặt hàng nhanh theo giá sỉ</caption>
              <thead><tr><th scope="col">Mặt hàng</th><th scope="col" className="r">Giá sỉ</th><th scope="col" className="r">Số lượng</th><th scope="col" className="r">Thành tiền</th></tr></thead>
              <tbody>
                {cat.data!.items.map((c) => {
                  const v = parseDec(qty[c.id] ?? "");
                  return (
                    <tr key={c.id}>
                      <th scope="row"><span className="n">{c.name}</span>{c.origin && <small className="muted">{c.origin}</small>}</th>
                      <td className="r">{money(c.price)}<small>/{unitName(c.baseUnit)}</small></td>
                      <td className="r"><input aria-label={`Số lượng ${c.name} (${unitName(c.baseUnit)})`} inputMode="decimal" className="qty-in" value={qty[c.id] ?? ""} onChange={(e) => setQty({ ...qty, [c.id]: e.target.value })} placeholder="0" /></td>
                      <td className="r">{v > 0 ? money(Math.round(c.price * v)) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {cat.data!.items.length === 0 && <Empty title="Không có mặt hàng phù hợp" />}
          </div>
        )}
        <div className="card-box">
          <div className="form-grid">
            <Field id="b2b-addr" label="Địa chỉ giao hàng">
              {(p) => (
                <select {...p} value={addr} onChange={(e) => setAddr(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">Chọn địa chỉ…</option>
                  {addrs.data?.items.map((a) => <option key={a.id} value={a.id}>{a.label ? `${a.label} — ` : ""}{a.address}</option>)}
                </select>
              )}
            </Field>
            <Field id="b2b-date" label="Ngày giao">{(p) => <input {...p} type="date" min={todayVN(0)} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
            <div className="full"><Field id="b2b-n" label="Ghi chú">{(p) => <input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field></div>
          </div>
          {addrs.data && addrs.data.items.length === 0 && <Notice kind="warn">Hồ sơ của bạn chưa có địa chỉ giao hàng. Vui lòng liên hệ cửa hàng để bổ sung.</Notice>}
          {err && <Notice kind="err">{err.msg}</Notice>}
          <div className="b2b-foot"><span>{lines.length} mặt hàng · <strong>{money(total)}</strong></span><button className="btn lg" type="submit" disabled={busy}>{busy ? "Đang gửi…" : "Đặt hàng sỉ"}</button></div>
        </div>
      </form>
    </div>
  );
}

export function B2bPage() {
  usePageMeta("Mua sỉ", "Đặt hàng sỉ trái cây cho nhà hàng, quán cà phê, cửa hàng — giá sỉ, giao đúng ngày, công nợ linh hoạt.");
  const { me, ready } = useAuth();
  if (!ready) return <div className="wrap page"><Loading /></div>;
  return (
    <div className="wrap page narrow-lg">
      <h1>Mua sỉ</h1>
      {!me ? (
        <div className="card-box">
          <p className="lead-sm"><Icon n="box" size={22} /> Giá sỉ, công nợ và đặt nhanh theo bảng dành cho nhà hàng, quán, cửa hàng.</p>
          <p>Đăng nhập (hoặc tạo tài khoản) để gửi yêu cầu liên kết khách sỉ.</p>
          <div className="row-actions"><Link to="/dang-nhap?next=/si" className="btn">Đăng nhập</Link><Link to="/dang-ky?next=/si" className="btn ghost">Tạo tài khoản</Link></div>
        </div>
      ) : me.kind === "b2b" && me.b2bStatus === "approved" ? <QuickOrder /> : me.b2bStatus === "pending" ? (
        <Notice kind="info">Yêu cầu liên kết khách sỉ của bạn đang chờ cửa hàng duyệt. Chúng tôi sẽ liên hệ khi có kết quả.</Notice>
      ) : (
        <>
          {me.b2bStatus === "rejected" && <Notice kind="warn">Yêu cầu trước đó chưa được duyệt. Bạn có thể gửi lại với thông tin chính xác hơn.</Notice>}
          <LinkRequest />
        </>
      )}
    </div>
  );
}
