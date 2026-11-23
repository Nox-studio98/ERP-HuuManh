import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errMsg, type OrderView, type Transfer } from "../lib/api";
import { fmtDate, fmtDateTime, money, num, unitName } from "../lib/format";
import { QrCode } from "../lib/qr";
import { Link, useQuery, usePageMeta } from "../lib/router";
import { announce, ss, useAuth } from "../lib/store";
import { CopyButton, ErrorBox, Field, Icon, Img, Loading, Modal, Notice } from "../ui";

const BANKS: Record<string, string> = {
  "970436": "Vietcombank", "970415": "VietinBank", "970418": "BIDV", "970405": "Agribank", "970422": "MB Bank", "970407": "Techcombank",
  "970432": "VPBank", "970423": "TPBank", "970416": "ACB", "970403": "Sacombank", "970441": "VIB", "970448": "OCB", "970426": "MSB",
  "970443": "SHB", "970437": "HDBank", "970454": "Viet Capital Bank", "970431": "Eximbank", "970429": "SCB", "970414": "Oceanbank",
};

const STATUS_TONE: Record<string, string> = { completed: "ok", cancelled: "bad", returned: "bad", delivery_failed: "bad", awaiting_payment: "warn", shipping: "info" };
const FINAL = ["completed", "cancelled", "returned"];

function useCountdown(iso: string | null | undefined) {
  const [left, setLeft] = useState<number | null>(iso ? Date.parse(iso) - Date.now() : null);
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setLeft(Date.parse(iso) - Date.now()), 1000);
    setLeft(Date.parse(iso) - Date.now());
    return () => clearInterval(t);
  }, [iso]);
  return left;
}

export function TransferPanel({ t, code }: { t: Transfer; code: string }) {
  const left = useCountdown(t.expiresAt);
  const expired = left != null && left <= 0;
  const mm = left != null && left > 0 ? `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}` : null;
  const bank = BANKS[t.bankBin] ?? `Ngân hàng (mã ${t.bankBin})`;
  return (
    <section className="card-box transfer" aria-labelledby="h-tr" data-testid="transfer">
      <h2 id="h-tr">Chuyển khoản để hoàn tất đơn</h2>
      {expired ? <Notice kind="err">Yêu cầu chuyển khoản đã hết hạn. Nếu đơn bị huỷ, vui lòng đặt lại; nếu bạn đã chuyển, cửa hàng sẽ đối soát và liên hệ.</Notice> : (
        <p className="muted">Quét mã bằng ứng dụng ngân hàng hoặc chuyển thủ công theo thông tin dưới đây.{mm && <> Đơn được giữ trong <strong>{mm}</strong>.</>}</p>
      )}
      <div className="tr-grid">
        <div className="qr-box">
          <QrCode value={t.qrPayload} size={220} label={`Mã VietQR thanh toán đơn ${code}, ${money(t.amount)}`} />
          <small className="muted">VietQR · napas 24/7</small>
        </div>
        <dl className="tr-info">
          <div><dt>Ngân hàng</dt><dd>{bank}</dd></div>
          <div><dt>Số tài khoản</dt><dd><span className="mono" data-testid="acc-no">{t.accountNo}</span><CopyButton text={t.accountNo} what="số tài khoản" /></dd></div>
          <div><dt>Chủ tài khoản</dt><dd>{t.accountName}</dd></div>
          <div><dt>Số tiền</dt><dd><strong className="mono">{money(t.amount)}</strong><CopyButton text={String(t.amount)} what="số tiền" /></dd></div>
          <div><dt>Nội dung</dt><dd><strong className="mono" data-testid="tr-content">{t.content}</strong><CopyButton text={t.content} what="nội dung chuyển khoản" /></dd></div>
        </dl>
      </div>
      <p className="hint">Vui lòng nhập đúng nội dung chuyển khoản để đơn được xác nhận nhanh nhất.</p>
    </section>
  );
}

function PushOptIn() {
  const { me } = useAuth();
  const [state, setState] = useState<"hide" | "ask" | "busy" | "done" | "denied" | "error">("hide");
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    if (!me || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    if (Notification.permission === "denied") return;
    let live = true;
    api<{ publicKey: string | null }>("/push/vapid-public-key").then(async (r) => {
      if (!live || !r.publicKey) return;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (!live) return;
        setKey(r.publicKey);
        setState(sub ? "done" : "ask");
      } catch { /* bỏ qua */ }
    }, () => {});
    return () => { live = false; };
  }, [me]);
  if (state === "hide") return null;
  const enable = async () => {
    setState("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState("denied"); return; }
      const reg = await navigator.serviceWorker.ready;
      const pad = "=".repeat((4 - (key!.length % 4)) % 4);
      const raw = atob((key! + pad).replace(/-/g, "+").replace(/_/g, "/"));
      const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      const j = sub.toJSON();
      await api("/me/push-subscriptions", { body: { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } } });
      setState("done");
      announce("Đã bật thông báo đơn hàng");
    } catch { setState("error"); }
  };
  return (
    <div className="card-box push">
      <Icon n="bell" size={24} />
      <div>
        <strong>Nhận thông báo khi đơn đổi trạng thái</strong>
        <p className="muted small">{state === "done" ? "Đã bật thông báo trên thiết bị này." : state === "denied" ? "Bạn đã chặn thông báo. Hãy bật lại trong cài đặt trình duyệt." : state === "error" ? "Không bật được thông báo, vui lòng thử lại sau." : "Biết ngay khi đơn được xác nhận, đang giao hoặc cần bạn chốt cân nặng."}</p>
      </div>
      {(state === "ask" || state === "busy" || state === "error") && <button className="btn sm" onClick={enable} disabled={state === "busy"}>Bật thông báo</button>}
    </div>
  );
}

function WeightDecision({ o, token, phone4, onDone }: { o: OrderView; token: string; phone4: string; onDone: (v: OrderView) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const decide = async (accept: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const v = await api<OrderView>(`/orders/track/${encodeURIComponent(token)}/weight-decision`, { body: { accept, phone4 } });
      setConfirmReject(false);
      onDone(v);
      announce(accept ? "Đã xác nhận giá theo cân thực tế" : "Đã huỷ đơn hàng");
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card-box warn" aria-labelledby="h-wd" data-testid="weight-decision">
      <h2 id="h-wd">Cần bạn xác nhận khối lượng thực tế</h2>
      <p>Sau khi cân, khối lượng thực tế chênh lệch so với đơn đặt. Tổng tiền mới là <strong>{money(o.total)}</strong> (ban đầu dự kiến {money(o.estimatedTotal)}).</p>
      <ul className="wd-lines">
        {o.lines.filter((l) => Math.abs(l.qty - l.orderedQty) > 0.0005).map((l) => (
          <li key={l.productId}><span>{l.name}</span><span>{num(l.orderedQty)} → <b>{num(l.qty)} {unitName(l.unit)}</b></span></li>
        ))}
      </ul>
      {err && <p className="hint err" role="alert">{err}</p>}
      <div className="row-actions">
        <button className="btn" onClick={() => decide(true)} disabled={busy}>Đồng ý, giao hàng</button>
        <button className="btn ghost danger" onClick={() => setConfirmReject(true)} disabled={busy}>Không đồng ý, huỷ đơn</button>
      </div>
      <Modal open={confirmReject} onClose={() => setConfirmReject(false)} title="Huỷ đơn hàng?" foot={<><button className="btn ghost" onClick={() => setConfirmReject(false)}>Quay lại</button><button className="btn danger" onClick={() => decide(false)} disabled={busy}>Xác nhận huỷ đơn</button></>}>
        <p>Đơn <strong>{o.code}</strong> sẽ bị huỷ và hàng được nhả lại. Thao tác này không thể hoàn tác.</p>
      </Modal>
    </section>
  );
}

export function OrderPanel({ o, token, phone4, onChange, placed, me: meMode, onCancel }: { o: OrderView; token?: string; phone4?: string; onChange: (v: OrderView) => void; placed?: boolean; me?: boolean; onCancel?: () => void }) {
  const tone = STATUS_TONE[o.status] ?? "info";
  const showTransfer = !!o.transfer && o.status === "awaiting_payment";
  return (
    <div className="order">
      {placed && (
        <div className="success" role="status">
          <span className="tick"><Icon n="check" size={28} /></span>
          <div><h1>Đặt hàng thành công!</h1><p>Cảm ơn bạn. Mã đơn của bạn là <strong data-testid="order-code">{o.code}</strong>. {o.paymentMethod === "transfer" ? "Vui lòng chuyển khoản bên dưới để cửa hàng xử lý đơn." : "Cửa hàng sẽ xác nhận và giao đúng khung giờ bạn chọn."}</p></div>
        </div>
      )}
      {!placed && <h1>Đơn {o.code}</h1>}
      <div className="order-head">
        <span className={`status ${tone}`} data-testid="order-status">{o.statusLabel}</span>
        <span className="muted">Đặt lúc {fmtDateTime(o.createdAt)}</span>
      </div>

      {placed && token && !meMode && (
        <p className="muted small">Lưu lại đường dẫn này để theo dõi đơn: <span className="mono wrap-any">{location.origin}/track/{token}</span> (cần 4 số cuối điện thoại người nhận).</p>
      )}

      {o.weightAdjustStatus === "pending_customer" && token && phone4 && <WeightDecision o={o} token={token} phone4={phone4} onDone={onChange} />}
      {o.weightAdjustStatus === "pending_customer" && !(token && phone4) && <Notice kind="warn">Cửa hàng cần bạn xác nhận khối lượng thực tế. Vui lòng mở đơn bằng liên kết tra cứu trong email hoặc tin nhắn để xác nhận.</Notice>}
      {o.weightAdjustStatus === "accepted" && <Notice kind="ok">Bạn đã đồng ý giá theo khối lượng thực tế.</Notice>}
      {o.weightAdjustStatus === "auto_accepted" && <Notice kind="info">Khối lượng thực tế chênh lệch nhỏ, tổng tiền đã được chốt theo cân.</Notice>}

      {showTransfer && <TransferPanel t={o.transfer!} code={o.code} />}
      {placed && <PushOptIn />}

      <div className="order-cols">
        <section className="card-box" aria-labelledby="h-tl">
          <h2 id="h-tl">Tiến trình đơn hàng</h2>
          <ol className="timeline" data-testid="timeline">
            {o.events.map((e, i) => (
              <li key={i} className={i === o.events.length - 1 ? "last" : ""}>
                <span className="dot" aria-hidden="true" />
                <div><strong>{e.statusLabel}</strong>{e.note && <p>{e.note}</p>}<time dateTime={e.at}>{fmtDateTime(e.at)}</time></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="card-box" aria-labelledby="h-info">
          <h2 id="h-info">Giao hàng</h2>
          <dl className="info">
            <div><dt>Người nhận</dt><dd>{o.receiverName} · {o.receiverPhoneMasked}</dd></div>
            <div><dt>Địa chỉ</dt><dd>{o.shipAddress}</dd></div>
            <div><dt>Thời gian giao</dt><dd>{o.slotDate ? `${fmtDate(o.slotDate)}${o.slotLabel ? ", " + o.slotLabel : ""}` : "—"}</dd></div>
            <div><dt>Thanh toán</dt><dd>{o.paymentMethod === "cod" ? "Thanh toán khi nhận hàng" : o.paymentMethod === "transfer" ? "Chuyển khoản" : o.paymentMethod === "credit" ? "Công nợ" : o.paymentMethod ?? "—"} · {o.paymentStatus === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}</dd></div>
          </dl>
        </section>
      </div>

      <section className="card-box" aria-labelledby="h-items">
        <h2 id="h-items">Sản phẩm</h2>
        <ul className="mini-lines big">
          {o.lines.map((l, i) => (
            <li key={i}>
              <Img src={l.imageUrl} alt="" seed={l.name} />
              <div>
                <span className="n">{l.name}</span>
                <small className="muted">{num(l.qty)} {unitName(l.unit)}{Math.abs(l.qty - l.orderedQty) > 0.0005 && <> (đặt {num(l.orderedQty)})</>} × {money(l.unitPrice)}</small>
                {l.preorderMilli > 0 && <small className="stock pre">Đặt trước {num(l.preorderMilli / 1000)}</small>}
              </div>
              <span className="v">{money(l.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <dl className="totals">
          <div><dt>Tạm tính</dt><dd>{money(o.subtotal)}</dd></div>
          {o.discount > 0 && <div><dt>Giảm giá</dt><dd>-{money(o.discount)}</dd></div>}
          <div><dt>Phí giao hàng</dt><dd>{o.shippingFee ? money(o.shippingFee) : "Miễn phí"}</dd></div>
          <div className="grand"><dt>{o.estimated ? "Tổng tạm tính" : "Tổng cộng"}</dt><dd>{money(o.total)}</dd></div>
        </dl>
        {o.estimated && <p className="weight-note"><Icon n="info" size={16} /> Giá tạm tính, chốt theo cân thực tế.</p>}
      </section>

      {meMode && o.canCancel && onCancel && <p><button className="btn ghost danger" onClick={onCancel}>Huỷ đơn hàng</button></p>}
      {!meMode && o.canCancel && <p className="muted small">Cần đổi hoặc huỷ đơn? <Link to="/dang-nhap">Đăng nhập</Link> để huỷ đơn của bạn, hoặc liên hệ cửa hàng.</p>}
    </div>
  );
}

export function TrackPage({ token }: { token: string }) {
  usePageMeta("Theo dõi đơn hàng");
  const qs = useQuery();
  const placed = qs.get("placed") === "1";
  const [phone4, setPhone4] = useState<string>(ss.get(`hm_track_${token}`) ?? "");
  const [input, setInput] = useState("");
  const [o, setO] = useState<OrderView | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: ApiError | null }>({ loading: !!phone4, error: null });

  const load = useCallback(async (p4: string, silent = false) => {
    if (!silent) setState({ loading: true, error: null });
    try {
      const v = await api<OrderView>(`/orders/track/${encodeURIComponent(token)}?phone4=${p4}`);
      setO(v);
      setState({ loading: false, error: null });
    } catch (e) {
      if (!silent) { setO(null); setState({ loading: false, error: e as ApiError }); }
    }
  }, [token]);
  useEffect(() => { if (phone4) void load(phone4); }, [phone4, load]);
  // cập nhật định kỳ khi đơn còn đang xử lý
  useEffect(() => {
    if (!o || !phone4 || FINAL.includes(o.status)) return;
    const t = setInterval(() => { if (!document.hidden) void load(phone4, true); }, 20000);
    return () => clearInterval(t);
  }, [o, phone4, load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}$/.test(input)) { setState({ loading: false, error: new ApiError(0, "x", "Vui lòng nhập đúng 4 chữ số") }); return; }
    ss.set(`hm_track_${token}`, input);
    setPhone4(input);
  };

  if (state.loading) return <div className="wrap page"><Loading label="Đang tải đơn hàng…" /></div>;
  if (!o)
    return (
      <div className="wrap page narrow">
        <h1>Theo dõi đơn hàng</h1>
        <form className="card-box" onSubmit={submit} noValidate>
          <p>Để bảo mật, vui lòng nhập <strong>4 số cuối</strong> điện thoại người nhận.</p>
          <Field id="p4" label="4 số cuối điện thoại" error={state.error ? (state.error.status === 404 ? "Không tìm thấy đơn hàng. Hãy kiểm tra lại 4 số cuối hoặc đường dẫn." : state.error.message) : null}>
            {(p) => <input {...p} inputMode="numeric" maxLength={4} autoComplete="off" pattern="\d{4}" value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))} />}
          </Field>
          <button className="btn block" type="submit">Xem đơn hàng</button>
          <p className="muted small center"><Link to="/dang-nhap">Đăng nhập</Link> để xem tất cả đơn hàng của bạn.</p>
        </form>
      </div>
    );
  return (
    <div className="wrap page narrow-lg">
      <OrderPanel o={o} token={token} phone4={phone4} onChange={setO} placed={placed} />
      {placed && <p className="center"><Link to="/san-pham" className="btn ghost">Tiếp tục mua sắm</Link></p>}
    </div>
  );
}

export function useMyOrder(code: string) {
  const [o, setO] = useState<OrderView | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: unknown }>({ loading: true, error: null });
  useEffect(() => {
    let live = true;
    setState({ loading: true, error: null });
    api<OrderView>(`/me/orders/${encodeURIComponent(code)}`).then((v) => live && (setO(v), setState({ loading: false, error: null })), (e) => live && setState({ loading: false, error: e }));
    return () => { live = false; };
  }, [code]);
  return { o, setO, ...state };
}

export function MyOrderPage({ code }: { code: string }) {
  usePageMeta(`Đơn ${code}`);
  const { o, setO, loading, error } = useMyOrder(code);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (loading) return <Loading />;
  if (error || !o) return <ErrorBox error={error} />;
  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try { setO(await api<OrderView>(`/me/orders/${encodeURIComponent(code)}/cancel`, { body: {} })); setAsk(false); announce("Đã huỷ đơn hàng"); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  let tk: ReactNode = null;
  if (o.trackingToken && o.weightAdjustStatus === "pending_customer") tk = <p><Link to={`/track/${o.trackingToken}`} className="btn">Xác nhận khối lượng thực tế</Link></p>;
  return (
    <div>
      <p><Link to="/tai-khoan/don-hang" className="back"><Icon n="chevL" size={16} /> Tất cả đơn hàng</Link></p>
      <OrderPanel o={o} onChange={setO} me onCancel={() => setAsk(true)} />
      {tk}
      {err && !ask && <Notice kind="err">{err}</Notice>}
      <Modal open={ask} onClose={() => setAsk(false)} title="Huỷ đơn hàng?" foot={<><button className="btn ghost" onClick={() => setAsk(false)}>Giữ đơn</button><button className="btn danger" onClick={cancel} disabled={busy}>Huỷ đơn {o.code}</button></>}>
        <p>Bạn muốn huỷ đơn <strong>{o.code}</strong>? Nếu đã thanh toán, cửa hàng sẽ liên hệ hoàn tiền.</p>
        {err && <p className="hint err" role="alert">{err}</p>}
      </Modal>
    </div>
  );
}

