import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Address, type OrderView } from "../lib/api";
import { DistrictOptions, PROVINCE } from "../lib/geo";
import { dayMonth, money, num, todayVN, unitName, uuid, weekdayOf } from "../lib/format";
import { cartSubtotalEst, useDelivery, useQuote } from "../lib/quote";
import { Link, navigate, usePageMeta } from "../lib/router";
import { announce, cartActions, prefs, ss, unitPriceOf, useAuth, useCart } from "../lib/store";
import { useTurnstile } from "../lib/turnstile";
import { Empty, Field, Icon, Img, Loading, Modal, Notice } from "../ui";

const PAY = [
  { v: "cod", t: "Thanh toán khi nhận hàng (COD)", d: "Trả tiền mặt cho nhân viên giao hàng." },
  { v: "transfer", t: "Chuyển khoản ngân hàng (VietQR)", d: "Quét mã QR sau khi đặt hàng; đơn được giữ trong thời gian ngắn." },
];

interface PriceChange { productId: number; oldPrice: number; newPrice: number }

export function CheckoutPage() {
  usePageMeta("Thanh toán");
  const cart = useCart();
  const { me, ready } = useAuth();
  const ts = useTurnstile();

  const [addrs, setAddrs] = useState<Address[]>([]);
  const [addrId, setAddrId] = useState<number | "new">("new");
  const [f, setF] = useState({ receiverName: "", receiverPhone: "", addressLine: "", ward: "", district: prefs.getDistrict(), province: PROVINCE, email: "", note: "" });
  const [slotKey, setSlotKey] = useState<{ date: string; id: number } | null>(null);
  const [date, setDate] = useState("");
  const [pay, setPay] = useState("cod");
  const [accept, setAccept] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [priceChange, setPriceChange] = useState<PriceChange[] | null>(null);
  const [stockProblem, setStockProblem] = useState<{ productId: number; availableMilli: number } | null>(null);
  const [slotTick, setSlotTick] = useState(0);
  const uid = useRef<string | null>(null);
  const submitRef = useRef<() => void>(() => {});
  const prefilled = useRef(false);

  // địa chỉ đã lưu
  useEffect(() => {
    if (!me) return;
    api<{ items: Address[] }>("/me/addresses").then((r) => {
      setAddrs(r.items);
      const d = r.items.find((a) => a.isDefault) ?? r.items[0];
      if (d) setAddrId(d.id);
    }, () => {});
  }, [me]);
  useEffect(() => {
    if (me && !prefilled.current) {
      prefilled.current = true;
      setF((x) => ({ ...x, receiverName: x.receiverName || me.fullName, receiverPhone: x.receiverPhone || me.phone || "", email: me.email }));
    }
  }, [me]);

  const saved = addrId === "new" ? null : addrs.find((a) => a.id === addrId) ?? null;
  const district = saved ? saved.district : f.district;
  const dl = useDelivery(district, slotTick);
  const dates = useMemo(() => [...new Set(dl.slots.map((s) => s.date))].sort(), [dl.slots]);
  useEffect(() => {
    if (!dates.length) return;
    if (!date || !dates.includes(date)) {
      const firstOk = dates.find((d) => dl.slots.some((s) => s.date === d && s.available)) ?? dates[0];
      setDate(firstOk);
    }
  }, [dates, dl.slots, date]);
  const daySlots = dl.slots.filter((s) => s.date === date);
  // bỏ chọn khung nếu không còn khả dụng
  useEffect(() => {
    if (slotKey && dl.slots.length && !dl.slots.some((s) => s.date === slotKey.date && s.id === slotKey.id && s.available)) setSlotKey(null);
  }, [dl.slots, slotKey]);

  const { quote, loading: ql } = useQuote(cart, { district: saved ? undefined : district, addressId: saved?.id ?? null, slotDate: slotKey?.date, slotId: slotKey?.id });
  const preLines = quote?.lines.filter((l) => l.preorderMilli > 0) ?? [];
  const needAccept = preLines.length > 0;
  const subtotal = quote?.subtotal ?? cartSubtotalEst(cart);
  const hasWeight = cart.some((c) => c.sellByWeight);

  if (!ready) return <div className="wrap page"><Loading /></div>;
  if (!cart.length)
    return (
      <div className="wrap page narrow"><h1>Thanh toán</h1><Empty title="Giỏ hàng đang trống" art><Link to="/san-pham" className="btn">Xem sản phẩm</Link></Empty></div>
    );

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setErrs((x) => { if (!x[k]) return x; const { [k]: _drop, ...rest } = x; return rest; });
    if (k === "district") prefs.setDistrict(e.target.value);
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!saved) {
      if (!f.receiverName.trim()) e.receiverName = "Vui lòng nhập họ tên người nhận";
      if (!/^(\+?84|0)[\d\s.\-()]{8,12}$/.test(f.receiverPhone.trim())) e.receiverPhone = "Số điện thoại chưa hợp lệ";
      if (!f.addressLine.trim()) e.addressLine = "Vui lòng nhập số nhà, tên đường";
      if (!f.district) e.district = "Vui lòng chọn quận/huyện";
      if (!me && f.email.trim() && !/^\S+@\S+\.\S+$/.test(f.email.trim())) e.email = "Email chưa hợp lệ";
    }
    if (!slotKey) e.slot = "Vui lòng chọn ngày và khung giờ giao";
    if (needAccept && !accept) e.accept = "Vui lòng xác nhận đồng ý đặt trước";
    return e;
  };

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    const e = validate();
    setErrs(e);
    setFormErr(null);
    if (Object.keys(e).length) {
      announce("Vui lòng kiểm tra lại thông tin đặt hàng");
      setTimeout(() => document.querySelector<HTMLElement>("[aria-invalid=true], #slot-e, .hint.err")?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
      return;
    }
    if (!me && ts.required && !ts.token) { setFormErr("Vui lòng hoàn tất ô xác minh chống robot."); return; }
    setBusy(true);
    uid.current ??= uuid();
    const body = {
      clientUuid: uid.current,
      items: cart.map((c) => ({ productId: c.productId, unit: c.unit, qty: c.qtyMilli / 1000, expectedUnitPrice: c.unitPrice })),
      address: saved
        ? { addressId: saved.id }
        : { receiverName: f.receiverName.trim(), receiverPhone: f.receiverPhone.trim(), addressLine: f.addressLine.trim(), ward: f.ward.trim() || undefined, district: f.district, province: f.province.trim() || PROVINCE },
      slotDate: slotKey!.date, slotId: slotKey!.id, paymentMethod: pay, note: f.note.trim() || undefined,
      acceptPreorder: needAccept ? accept : undefined, email: !me && f.email.trim() ? f.email.trim() : undefined,
    };
    try {
      const o = await api<OrderView>("/checkout", { body, turnstile: me ? null : ts.token });
      const phone = (saved?.receiverPhone ?? f.receiverPhone).replace(/\D/g, "");
      if (o.trackingToken) ss.set(`hm_track_${o.trackingToken}`, phone.slice(-4));
      cartActions.clear();
      uid.current = null;
      navigate(`/track/${o.trackingToken}?placed=1`);
    } catch (err) {
      const a = err as ApiError;
      if (a.network || a.status >= 500) {
        setFormErr(a.message + " Đơn chưa bị mất — bạn có thể bấm đặt hàng lại.");
      } else {
        uid.current = null;
        if (a.code === "price_changed") setPriceChange(a.details?.lines ?? []);
        else if (a.code === "insufficient_stock") setStockProblem(a.details?.productId ? { productId: a.details.productId, availableMilli: a.details.availableMilli ?? 0 } : null);
        else if (a.code === "slot_full" || a.code === "slot_cutoff") { setSlotKey(null); setSlotTick((t) => t + 1); setFormErr(a.message); }
        else setFormErr(a.message);
        if (!me) ts.reset();
      }
      announce(a.message);
    } finally {
      setBusy(false);
    }
  };

  submitRef.current = () => void submit();
  const confirmPrices = () => {
    for (const p of priceChange ?? []) cartActions.setPrice(p.productId, p.newPrice);
    setPriceChange(null);
    setTimeout(() => submitRef.current(), 80);
  };
  const stockItem = stockProblem ? cart.find((c) => c.productId === stockProblem.productId) : null;
  const fixStock = () => {
    if (!stockItem || !stockProblem) return;
    const availUnit = (stockProblem.availableMilli * 1000) / stockItem.factorMilli;
    const step = Math.max(1, (stockItem.stepMilli * 1000) / stockItem.factorMilli);
    const q = Math.floor(availUnit / step) * step;
    if (q > 0) cartActions.setQty(stockItem.productId, stockItem.unit, q);
    else cartActions.remove(stockItem.productId, stockItem.unit);
    setStockProblem(null);
  };

  return (
    <div className="wrap page checkout">
      <h1>Thanh toán</h1>
      {!me && <p className="muted guest-hint">Bạn đang đặt hàng không cần tài khoản. <Link to="/dang-nhap?next=/thanh-toan">Đăng nhập</Link> để dùng sổ địa chỉ và xem lịch sử đơn.</p>}
      <form className="co-grid" onSubmit={submit} noValidate>
        <div className="co-main">
          <section className="card-box" aria-labelledby="h-addr">
            <h2 id="h-addr"><span className="step">1</span> Địa chỉ giao hàng</h2>
            {addrs.length > 0 && (
              <div className="addr-list" role="radiogroup" aria-label="Địa chỉ đã lưu">
                {addrs.map((a) => (
                  <label key={a.id} className={`addr-opt ${addrId === a.id ? "on" : ""}`}>
                    <input type="radio" name="addr" checked={addrId === a.id} onChange={() => setAddrId(a.id)} />
                    <span>
                      <strong>{a.receiverName}</strong> · {a.receiverPhone}
                      {a.isDefault && <em className="badge soft">Mặc định</em>}
                      <br />
                      {[a.addressLine, a.ward, a.district, a.province].filter(Boolean).join(", ")}
                    </span>
                  </label>
                ))}
                <label className={`addr-opt ${addrId === "new" ? "on" : ""}`}>
                  <input type="radio" name="addr" checked={addrId === "new"} onChange={() => setAddrId("new")} />
                  <span><strong>Giao đến địa chỉ khác</strong></span>
                </label>
              </div>
            )}
            {!saved && (
              <div className="form-grid">
                <Field id="co-name" label="Họ tên người nhận" error={errs.receiverName}>{(p) => <input {...p} autoComplete="name" value={f.receiverName} onChange={set("receiverName")} />}</Field>
                <Field id="co-phone" label="Số điện thoại" error={errs.receiverPhone}>{(p) => <input {...p} type="tel" inputMode="tel" autoComplete="tel" value={f.receiverPhone} onChange={set("receiverPhone")} />}</Field>
                <Field id="co-line" label="Số nhà, tên đường" error={errs.addressLine}>{(p) => <input {...p} autoComplete="street-address" value={f.addressLine} onChange={set("addressLine")} />}</Field>
                <Field id="co-ward" label="Phường/xã (không bắt buộc)">{(p) => <input {...p} value={f.ward} onChange={set("ward")} />}</Field>
                <Field id="co-district" label="Quận/huyện" error={errs.district}>
                  {(p) => (
                    <select {...p} value={f.district} onChange={set("district")}>
                      <option value="">Chọn quận/huyện…</option>
                      <DistrictOptions />
                    </select>
                  )}
                </Field>
                <Field id="co-prov" label="Tỉnh/thành phố">{(p) => <input {...p} value={f.province} onChange={set("province")} />}</Field>
                {!me && (
                  <Field id="co-email" label="Email nhận thông báo (không bắt buộc)" error={errs.email} hint="Chúng tôi gửi xác nhận và cập nhật đơn qua email này.">
                    {(p) => <input {...p} type="email" autoComplete="email" value={f.email} onChange={set("email")} />}
                  </Field>
                )}
              </div>
            )}
            {district && !dl.loading && !dl.zone && <Notice kind="err">Chưa hỗ trợ giao hàng tới {district}. Vui lòng chọn khu vực khác.</Notice>}
          </section>

          <section className="card-box" aria-labelledby="h-slot">
            <h2 id="h-slot"><span className="step">2</span> Ngày và giờ giao</h2>
            {!district ? <p className="muted">Chọn quận/huyện để xem các khung giờ giao.</p> : dl.loading && !dl.slots.length ? <Loading /> : (
              <>
                <div className="dates" role="group" aria-label="Chọn ngày giao">
                  {dates.map((d) => {
                    const ok = dl.slots.some((s) => s.date === d && s.available);
                    return (
                      <button type="button" key={d} className={`date ${d === date ? "on" : ""}`} aria-pressed={d === date} disabled={!ok} onClick={() => setDate(d)} aria-label={`${weekdayOf(d)} ${dayMonth(d)}${ok ? "" : ", hết khung giờ"}`}>
                        <span>{d === todayVN() ? "Hôm nay" : weekdayOf(d)}</span><strong>{dayMonth(d)}</strong>
                      </button>
                    );
                  })}
                </div>
                <div className="slots" role="radiogroup" aria-label="Chọn khung giờ">
                  {daySlots.map((s) => {
                    const on = slotKey?.date === s.date && slotKey.id === s.id;
                    return (
                      <label key={s.id} className={`slot ${on ? "on" : ""} ${s.available ? "" : "off"}`}>
                        <input type="radio" name="slot" disabled={!s.available} checked={on} onChange={() => { setSlotKey({ date: s.date, id: s.id }); setErrs((x) => { const { slot: _s, ...rest } = x; return rest; }); }} />
                        <strong>{s.label}</strong>
                        {!s.available && <small>{s.reason === "full" ? "Hết chỗ" : "Đã quá giờ chốt"}</small>}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
            {errs.slot && <p className="hint err" id="slot-e" role="alert">{errs.slot}</p>}
          </section>

          <section className="card-box" aria-labelledby="h-pay">
            <h2 id="h-pay"><span className="step">3</span> Thanh toán</h2>
            <div className="addr-list" role="radiogroup" aria-label="Hình thức thanh toán">
              {PAY.map((o) => (
                <label key={o.v} className={`addr-opt ${pay === o.v ? "on" : ""}`}>
                  <input type="radio" name="pay" checked={pay === o.v} onChange={() => setPay(o.v)} />
                  <span><strong>{o.t}</strong><br /><small className="muted">{o.d}</small></span>
                </label>
              ))}
            </div>
            <Field id="co-note" label="Ghi chú cho cửa hàng (không bắt buộc)">
              {(p) => <textarea {...p} rows={2} maxLength={500} value={f.note} onChange={set("note")} placeholder="Ví dụ: chọn trái chín vừa, gọi trước khi giao…" />}
            </Field>
          </section>

          {needAccept && (
            <section className="card-box warn" aria-labelledby="h-pre">
              <h2 id="h-pre">Hàng đặt trước</h2>
              <ul>
                {preLines.map((l) => (
                  <li key={l.productId}><strong>{l.name}</strong>: thiếu {num(l.preorderMilli / 1000)} {unitName(cart.find((c) => c.productId === l.productId)?.baseUnit ?? "")} — sẽ giao khi hàng về, cửa hàng liên hệ xác nhận.</li>
                ))}
              </ul>
              <label className="check"><input type="checkbox" checked={accept} aria-invalid={errs.accept ? true : undefined} onChange={(e) => { setAccept(e.target.checked); setErrs((x) => { const { accept: _a, ...rest } = x; return rest; }); }} /> Tôi đồng ý đặt trước phần hàng còn thiếu</label>
              {errs.accept && <p className="hint err" role="alert">{errs.accept}</p>}
            </section>
          )}
        </div>

        <aside className="summary" aria-label="Đơn hàng của bạn">
          <h2>Đơn hàng ({cart.length})</h2>
          <ul className="mini-lines">
            {cart.map((c) => {
              const l = quote?.lines.find((x) => x.productId === c.productId);
              return (
                <li key={`${c.productId}-${c.unit}`}>
                  <Img src={c.imageUrl} alt="" seed={c.name} />
                  <div><span className="n">{c.name}</span><small className="muted">{num(c.qtyMilli / 1000)} {unitName(c.unit)} × {money(unitPriceOf(c))}</small></div>
                  <span className="v">{money(l?.lineTotal ?? Math.round((unitPriceOf(c) * c.qtyMilli) / 1000))}</span>
                </li>
              );
            })}
          </ul>
          <dl className="totals" aria-live="polite">
            <div><dt>Tạm tính</dt><dd>{money(subtotal)}</dd></div>
            <div><dt>Phí giao hàng{quote?.zone ? ` (${quote.zone.name})` : ""}</dt><dd data-testid="ship-fee">{!district ? "—" : quote?.zone ? (quote.shippingFee === 0 ? "Miễn phí" : money(quote.shippingFee)) : ql ? "…" : "—"}</dd></div>
            <div className="grand"><dt>Tổng cộng</dt><dd data-testid="grand-total">{money(quote?.total ?? subtotal)}</dd></div>
          </dl>
          {hasWeight && <p className="weight-note"><Icon n="info" size={16} /> Giá tạm tính, chốt theo cân thực tế.</p>}
          {quote?.issues.map((i, k) => <p key={k} className={`hint ${i.code === "insufficient" || i.code === "out_of_stock" ? "" : "err"}`}>{i.message}</p>)}
          {!me && ts.node}
          {formErr && <Notice kind="err">{formErr}</Notice>}
          <button className="btn lg block" type="submit" disabled={busy || (!me && !ts.ready)}>{busy ? "Đang đặt hàng…" : `Đặt hàng · ${money(quote?.total ?? subtotal)}`}</button>
          <p className="muted small center">Bằng việc đặt hàng, bạn đồng ý để Hữu Mạnh liên hệ giao hàng theo thông tin trên.</p>
        </aside>
      </form>

      <Modal
        open={!!priceChange}
        onClose={() => setPriceChange(null)}
        title="Giá đã thay đổi"
        foot={<><button className="btn ghost" onClick={() => { setPriceChange(null); navigate("/gio-hang"); }}>Xem lại giỏ hàng</button><button className="btn" onClick={confirmPrices}>Đồng ý giá mới và đặt hàng</button></>}
      >
        <p>Giá một số sản phẩm vừa được cập nhật. Vui lòng xác nhận trước khi đặt hàng:</p>
        <ul className="price-diff">
          {priceChange?.map((p) => {
            const c = cart.find((x) => x.productId === p.productId);
            const conv = (v: number) => (c ? Math.round((v * c.factorMilli) / 1000) : v);
            return (
              <li key={p.productId}>
                <strong>{c?.name ?? `Sản phẩm #${p.productId}`}</strong>
                <span><del>{money(conv(p.oldPrice))}</del> → <b className={p.newPrice > p.oldPrice ? "up" : "down"}>{money(conv(p.newPrice))}</b>/{unitName(c?.unit ?? "")}</span>
              </li>
            );
          })}
        </ul>
      </Modal>
      <Modal
        open={!!stockProblem}
        onClose={() => setStockProblem(null)}
        title="Không đủ hàng"
        foot={<><button className="btn ghost" onClick={() => setStockProblem(null)}>Để sau</button><button className="btn" onClick={fixStock}>{stockProblem && stockProblem.availableMilli > 0 ? "Giảm theo số còn lại" : "Bỏ khỏi giỏ"}</button></>}
      >
        <p>
          <strong>{stockItem?.name ?? "Một sản phẩm"}</strong>{" "}
          {stockProblem && stockProblem.availableMilli > 0 ? <>hiện chỉ còn khoảng <b>{num(stockProblem.availableMilli / 1000)} {unitName(stockItem?.baseUnit ?? "")}</b></> : "hiện đã hết hàng"}, không đủ số lượng bạn chọn.
        </p>
      </Modal>
    </div>
  );
}
