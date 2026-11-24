import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Badge, Banner, Button, Card, DecInput, EmptyState, Input, MoneyInput, NumberPad, QtyStepper, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { Scanner } from "../components/Scanner";
import { Receipt } from "../components/Receipt";
import { toast } from "../components/toast";
import { METHODS, fmtDate, fmtDateTime, fmtTime, money, qtyText, unitLabel, uuid, withShown } from "../format";
import { enqueue, useQueue, syncQueue } from "../offline";
import { navigate } from "../router";
import { useAuth, useCan } from "../store";
import { reasonText } from "./d4/voucher-text";

export type Unit = { unit: string; factorMilli: number; barcode?: string };
export type Product = { id: number; sku: string; name: string; baseUnit: string; sellByWeight: boolean | number; barcode?: string; units?: Unit[]; availableMilli?: number; price?: number | { unitPrice: number } | null; avgCost?: number; [k: string]: any };
export const priceOf = (p: Product) => (typeof p.price === "number" ? p.price : p.price?.unitPrice ?? 0);
const factor = (p: Product, unit: string) => (unit === p.baseUnit ? 1000 : p.units?.find((u) => u.unit === unit)?.factorMilli ?? 1000);
const unitPrice = (p: Product, unit: string) => Math.round((priceOf(p) * factor(p, unit)) / 1000);

type Line = { key: string; product: Product; unit: string; qty: number; discount: number };
type Cust = { id: number; name: string; phone?: string | null };
let saved = { lines: [] as Line[], cartId: uuid(), discount: 0, note: "", customer: null as Cust | null };

export default function Pos() {
  const can = useCan();
  const shift = useAsync(async () => {
    try { const r = await get("/shifts/current", undefined, { silent: true }); return r?.shift ?? r?.id ? (r.shift ?? r) : null; }
    catch (e) { if (e instanceof ApiError && (e.status === 404 || e.code === "not_found")) return null; throw e; }
  }, []);
  if (shift.loading) return <Spinner />;
  if (shift.err) return <Banner tone="danger">Không tải được thông tin ca. <Button size="sm" variant="ghost" onClick={shift.reload}>Thử lại</Button></Banner>;
  const s = shift.data;
  if (!s || s.status === "closed") return <OpenShift onOpened={shift.reload} allowed={can("pos.shift")} />;
  return <Sell shift={s} />;
}

function OpenShift({ onOpened, allowed }: { onOpened: () => void; allowed: boolean }) {
  const [cash, setCash] = useState(0), [busy, setBusy] = useState(false);
  const auth = useAuth();
  const last = useAsync(async () => { try { return (await get("/shifts/last", undefined, { silent: true }))?.shift ?? null; } catch { return null; } }, []);
  const l = last.data;
  const open = async () => { setBusy(true); try { await post("/shifts/open", { openingCash: cash }); toast("Đã mở ca", "ok"); onOpened(); } catch {} finally { setBusy(false); } };
  return (
    <div className="hero-panel">
      <div className="hero-grid">
        <Card className="hero-main">
          <div className="stack">
            <div>
              <h2 style={{ margin: 0, fontSize: "1.35rem" }}>Mở ca bán hàng</h2>
              <div className="muted">{auth.user?.storeName ? `${auth.user.storeName} · ` : ""}{auth.user?.fullName ?? ""} · {fmtDate(new Date().toISOString())}</div>
            </div>
            <div className="muted">Chưa có ca đang mở. Đếm tiền mặt đầu ca trong két và nhập vào để bắt đầu bán hàng.</div>
            <MoneyInput label="Tiền đầu ca (₫)" value={cash} onChange={setCash} hint={l ? `Gợi ý: ca trước kiểm đếm ${money(l.countedCash)}` : undefined} />
            {l && l.countedCash > 0 && cash !== l.countedCash && <div><Button size="sm" variant="soft" onClick={() => setCash(l.countedCash)}>Dùng số tiền ca trước ({money(l.countedCash)})</Button></div>}
            <Button size="lg" block loading={busy} disabled={!allowed} onClick={open}>Mở ca</Button>
            {!allowed && <div className="err">Bạn không có quyền mở ca.</div>}
          </div>
        </Card>
        <div className="stack">
          <Card title="Ca gần nhất của bạn">
            {last.loading ? <Spinner /> : !l ? <div className="muted">Chưa có ca nào đã chốt. Ca đầu tiên sẽ hiện tổng kết ở đây.</div> : (
              <div className="stack">
                <div className="muted small">Ca #{l.id} · {fmtDateTime(l.openedAt)} → {fmtTime(l.closedAt)}</div>
                <div className="grid2">
                  <div className="kpi"><div className="l">Doanh thu</div><div className="v">{money(l.revenue)}</div><div className="s small muted">{l.orderCount} đơn</div></div>
                  <div className="kpi"><div className="l">Tiền kiểm đếm</div><div className="v">{money(l.countedCash)}</div><div className="s small muted">đầu ca {money(l.openingCash)}</div></div>
                </div>
                <div className={"banner " + (l.diffCash ? "" : "info")}>{l.diffCash ? `Chênh lệch ${l.diffCash > 0 ? "thừa" : "thiếu"} ${money(Math.abs(l.diffCash))}` : "Khớp tiền, không chênh lệch."}</div>
              </div>
            )}
          </Card>
          <Card title="Phím tắt khi bán hàng">
            <div className="kbd-list"><span><kbd>F2</kbd> Tìm sản phẩm</span><span><kbd>F4</kbd> Quét mã</span><span><kbd>F9</kbd> Thanh toán</span><span><kbd>Esc</kbd> Đóng hộp thoại</span></div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Sell({ shift }: { shift: any }) {
  const [lines, setLines] = useState<Line[]>(saved.lines);
  const [cartId, setCartId] = useState(saved.cartId);
  const [discount, setDiscount] = useState(saved.discount);
  const [note, setNote] = useState(saved.note);
  const [customer, setCustomer] = useState<Cust | null>(saved.customer);
  const [pickCustomer, setPickCustomer] = useState(false);
  useEffect(() => { saved = { lines, cartId, discount, note, customer }; }, [lines, cartId, discount, note, customer]);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const prods = useAsync(() => get("/products", { q: dq, limit: 60, active: 1 }).then((r) => items<Product>(r)), [dq]);
  const [view, setView] = useState<"products" | "cart">("products");
  const [scan, setScan] = useState(false);
  const [weighing, setWeighing] = useState<{ p: Product; unit?: string } | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [receipt, setReceipt] = useState<{ order: any; names: Record<number, string> } | null>(null);
  const queue = useQueue();
  const totalRef = useRef(0);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (document.querySelector(".sheet-back")) return;
      if (e.key === "F2") { e.preventDefault(); (document.querySelector("[data-pos-search]") as HTMLInputElement | null)?.focus(); }
      else if (e.key === "F4") { e.preventDefault(); setScan(true); }
      else if (e.key === "F9" && totalRef.current > 0) { e.preventDefault(); setCheckout(true); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const subtotal = useMemo(() => lines.reduce((s, l) => s + Math.round(l.qty * unitPrice(l.product, l.unit)) - l.discount, 0), [lines]);
  const total = Math.max(0, subtotal - discount);
  totalRef.current = total;
  const count = lines.length;

  const add = (p: Product, unit?: string, qty?: number) => {
    const u = unit ?? p.baseUnit;
    if (p.sellByWeight && qty === undefined && u === p.baseUnit) { setWeighing({ p, unit: u }); return; }
    setLines((ls) => {
      const ex = ls.find((l) => l.product.id === p.id && l.unit === u);
      if (ex && !p.sellByWeight) return ls.map((l) => (l === ex ? { ...l, qty: l.qty + (qty ?? 1) } : l));
      if (ex) return ls.map((l) => (l === ex ? { ...l, qty: Math.round((l.qty + (qty ?? 1)) * 1000) / 1000 } : l));
      return [...ls, { key: uuid(), product: p, unit: u, qty: qty ?? 1, discount: 0 }];
    });
  };
  const onScan = async (code: string) => {
    try {
      const r = await get("/products/lookup", { code });
      const p = r.product as Product;
      if (r.lot?.status === "expired") toast("Lô này đã hết hạn — không bán", "error");
      else { add(p, r.unit?.unit ?? undefined); toast(`Đã thêm: ${p.name}`, "ok"); }
    } catch { /* toast từ api */ }
  };

  const reset = () => { setLines([]); setDiscount(0); setNote(""); setCustomer(null); setCartId(uuid()); setView("products"); };
  const names = Object.fromEntries(lines.map((l) => [l.product.id, l.product.name]));
  const payloadBase = () => ({
    clientUuid: cartId,
    lines: lines.map((l) => ({ productId: l.product.id, unit: l.unit, qty: l.qty, ...(l.discount ? { discount: l.discount } : {}) })),
    ...(customer ? { customerId: customer.id } : {}),
    ...(discount ? { discount } : {}),
    ...(note ? { note } : {}),
  });

  return (
    <div className={"pos" + (view === "cart" ? " show-cart" : "")}>
      <div className="pos-products stack">
        <div className="row">
          <div className="grow"><Input label="Tìm sản phẩm" type="search" data-pos-search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tên hoặc mã…  (F2)" /></div>
          <Button variant="soft" style={{ alignSelf: "flex-end" }} onClick={() => setScan(true)}>Quét mã<span className="kbd-hint"> F4</span></Button>
        </div>
        {queue.length > 0 && <div className="banner">Có {queue.length} đơn chờ đồng bộ. <Button size="sm" variant="ghost" onClick={() => syncQueue(true)}>Đồng bộ ngay</Button></div>}
        {prods.loading ? <Spinner /> : !prods.data?.length ? <EmptyState title="Không có sản phẩm" hint="Thử từ khoá khác hoặc quét mã." /> : (
          <div className="pgrid">
            {prods.data.map((p) => (
              <button key={p.id} className="ptile" onClick={() => add(p)} aria-label={`Thêm ${p.name}`}>
                <span className="n">{p.name}</span>
                <span className="small muted">{p.sellByWeight ? "Bán theo cân" : "Bán theo " + unitLabel(p.baseUnit)}{p.availableMilli != null ? ` · tồn ${qtyText(p.availableMilli, p.baseUnit)}` : ""}</span>
                <span className="p">{priceOf(p) ? `${money(priceOf(p))}/${unitLabel(p.baseUnit)}` : "Chưa có giá"}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pos-cart">
        <Card title={`Giỏ hàng${count ? ` (${count})` : ""}`} actions={<div className="row"><Button size="sm" variant="ghost" className="only-mobile" onClick={() => setView("products")}>← Thêm hàng</Button>{count > 0 && <Button size="sm" variant="ghost" onClick={reset}>Xoá giỏ</Button>}</div>}>
          {!count ? <EmptyState title="Giỏ hàng trống" hint="Chọn sản phẩm hoặc quét mã để thêm." /> : (
            <>
              <div>
                {lines.map((l) => {
                  const up = unitPrice(l.product, l.unit);
                  const opts = [l.product.baseUnit, ...(l.product.units ?? []).map((u) => u.unit).filter((u) => u !== l.product.baseUnit)];
                  return (
                    <div className="cartline" key={l.key}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{l.product.name}</div>
                        <div className="small muted num">{money(up)}/{unitLabel(l.unit)}{l.product.availableMilli != null && l.qty * factor(l.product, l.unit) > l.product.availableMilli ? " · " : ""}{l.product.availableMilli != null && l.qty * factor(l.product, l.unit) > l.product.availableMilli && <span style={{ color: "var(--warn)" }}>vượt tồn</span>}</div>
                      </div>
                      <div className="right money" style={{ fontWeight: 700 }}>{money(Math.round(l.qty * up) - l.discount)}</div>
                      <div className="row wrap">
                        <QtyStepper label={`Số lượng ${l.product.name}`} value={l.qty} step={l.product.sellByWeight ? 0.1 : 1} decimal={!!l.product.sellByWeight} onChange={(n) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: n } : x)))} />
                        {opts.length > 1 ? (
                          <select className="input" style={{ width: 90 }} aria-label="Đơn vị" value={l.unit} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unit: e.target.value } : x)))}>{opts.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}</select>
                        ) : <span className="muted">{unitLabel(l.unit)}</span>}
                      </div>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <input className="input num" style={{ width: 96, minHeight: 36, textAlign: "right" }} inputMode="numeric" aria-label={`Giảm giá dòng ${l.product.name}`} placeholder="Giảm ₫" value={l.discount ? new Intl.NumberFormat("vi-VN").format(l.discount) : ""} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, discount: parseInt(e.target.value.replace(/\D/g, "") || "0", 10) } : x)))} />
                        <Button size="sm" variant="ghost" aria-label={`Xoá ${l.product.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="row between" data-testid="pos-customer">
                  {customer ? <span><b>{customer.name}</b>{customer.phone ? <span className="small muted"> · {customer.phone}</span> : null}</span> : <span className="muted">Khách lẻ</span>}
                  <div className="row"><Button size="sm" variant="soft" onClick={() => setPickCustomer(true)}>{customer ? "Đổi khách" : "Gắn khách"}</Button>{customer && <Button size="sm" variant="ghost" aria-label="Bỏ khách" onClick={() => setCustomer(null)}>✕</Button>}</div>
                </div>
                <MoneyInput label="Giảm giá cả đơn (₫)" value={discount} onChange={setDiscount} />
                <div className="totals">
                  <div><span className="muted">Tạm tính</span><span className="money">{money(subtotal)}</span></div>
                  {discount > 0 && <div><span className="muted">Giảm giá</span><span className="money">-{money(discount)}</span></div>}
                  <div className="grand"><span>Tổng</span><span className="money">{money(total)}</span></div>
                </div>
                <Button size="lg" block disabled={total <= 0} onClick={() => setCheckout(true)}>Thanh toán {money(total)}<span className="kbd-hint"> F9</span></Button>
              </div>
            </>
          )}
        </Card>
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="small muted">Ca #{shift.id} · mở {shift.openedAt ? new Date(shift.openedAt).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" }) : ""}</span>
          <Button size="sm" variant="ghost" onClick={() => navigate("/shift-close")}>Chốt ca</Button>
        </div>
      </div>

      {view === "products" && count > 0 && (
        <div className="floatbar only-mobile"><Button size="lg" block onClick={() => setView("cart")}>Xem giỏ ({count}) · {money(total)}</Button></div>
      )}

      <Sheet open={scan} onClose={() => setScan(false)} title="Quét mã sản phẩm"><Scanner onCode={onScan} continuous /><div className="hint" style={{ marginTop: 8 }}>Đã có {count} dòng trong giỏ.</div></Sheet>
      {weighing && <WeightSheet p={weighing.p} unit={weighing.unit ?? weighing.p.baseUnit} onClose={() => setWeighing(null)} onAdd={(n) => { add(weighing.p, weighing.unit, n); setWeighing(null); }} />}
      {checkout && (
        <CheckoutSheet total={total} payloadBase={payloadBase} customer={customer} onClose={() => setCheckout(false)} noteValue={note} onNote={setNote}
          onDone={(order, change) => { setCheckout(false); setReceipt({ order: { ...withShown(order, new Map(lines.map((l) => [l.product.id, l.product]))), change }, names }); reset(); }}
          onQueued={() => { setCheckout(false); reset(); toast("Mất mạng — đã lưu đơn, sẽ đồng bộ sau", "info"); }} />
      )}
      {pickCustomer && <CustomerSheet onClose={() => setPickCustomer(false)} onPick={(c) => { setCustomer(c); setPickCustomer(false); }} />}
      <Sheet open={!!receipt} onClose={() => setReceipt(null)} title="Hoá đơn" footer={<Button block onClick={() => setReceipt(null)}>Đơn mới</Button>}>
        {receipt && <Receipt order={receipt.order} names={receipt.names} />}
      </Sheet>
    </div>
  );
}

function WeightSheet({ p, unit, onAdd, onClose }: { p: Product; unit: string; onAdd: (n: number) => void; onClose: () => void }) {
  const [kg, setKg] = useState<number | "">("");
  const v = typeof kg === "number" ? kg : 0;
  return (
    <Sheet open onClose={onClose} title={p.name} footer={<Button block size="lg" disabled={v <= 0} onClick={() => onAdd(v)}>Thêm {v > 0 ? `${v.toString().replace(".", ",")} ${unitLabel(unit)}` : ""}</Button>}>
      <div className="stack">
        <DecInput label={`Khối lượng (${unitLabel(unit)})`} value={kg} onChange={setKg} autoFocus placeholder="0,0" />
        <div className="chips">{[0.5, 1, 1.5, 2, 3, 5].map((n) => <button key={n} className="chip" onClick={() => setKg(n)}>{String(n).replace(".", ",")} {unitLabel(unit)}</button>)}</div>
        {v > 0 && <div className="muted">Thành tiền: <b className="money">{money(Math.round(v * unitPrice(p, unit)))}</b></div>}
      </div>
    </Sheet>
  );
}

type Pay = { method: string; amount: number };
type Preview = { discounts: { promotionId: number; voucherId: number | null; amount: number; description: string }[]; discount: number; pointsRedeemed: number; pointsAmount: number; rejected: { code: string; reason: string }[] };

function CustomerSheet({ onClose, onPick }: { onClose: () => void; onPick: (c: Cust) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const res = useAsync(async () => {
    if (dq.trim().length < 2) return { list: [] as any[], denied: false };
    try { return { list: items<any>(await get("/pos/customers", { q: dq.trim() }, { silent: true })), denied: false }; }
    catch (e) { if (e instanceof ApiError && e.status === 403) return { list: [], denied: true }; throw e; }
  }, [dq]);
  return (
    <Sheet open onClose={onClose} title="Gắn khách hàng">
      <div className="stack">
        <Input label="Tên, mã hoặc số điện thoại" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
        {res.data?.denied && <div className="banner">Tài khoản này không có quyền tra cứu khách — nhờ quản lý gắn khách.</div>}
        {res.loading ? <Spinner /> : res.data?.list.map((c) => <button key={c.id} className="dt-card" onClick={() => onPick({ id: c.id, name: c.name, phone: c.phone })}><div className="ttl">{c.name}</div><div className="small muted">{c.code}{c.phone ? " · " + c.phone : ""}</div></button>)}
        {!res.loading && dq.trim().length >= 2 && !res.data?.denied && !res.data?.list.length && <div className="muted">Không tìm thấy khách.</div>}
        <QuickCustomer seed={q} onCreated={onPick} />
      </div>
    </Sheet>
  );
}

/** Tạo nhanh khách lẻ tại quầy để tích điểm (tên + SĐT); SĐT đã có → dùng khách cũ. */
function QuickCustomer({ seed, onCreated }: { seed: string; onCreated: (c: Cust) => void }) {
  const [open, setOpen] = useState(false);
  const isPhone = /^[0-9+ ]{8,15}$/.test(seed.trim());
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) return <Button variant="ghost" onClick={() => { setOpen(true); if (isPhone) setPhone(seed.trim()); else setName(seed.trim()); }}>+ Khách mới</Button>;
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <Input label="Tên khách" value={name} onChange={(e) => setName(e.target.value)} />
      <Input label="Số điện thoại" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <Button disabled={busy || !name.trim()} onClick={async () => {
        setBusy(true);
        try {
          const r: any = await post("/pos/customers", { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) });
          onCreated({ id: r.id, name: r.name, phone: r.phone });
        } finally { setBusy(false); }
      }}>Lưu và gắn khách</Button>
    </div>
  );
}

function CheckoutSheet({ total: localTotal, payloadBase, customer, onClose, onDone, onQueued, noteValue, onNote }: { total: number; payloadBase: () => any; customer: Cust | null; onClose: () => void; onDone: (o: any, change: number) => void; onQueued: () => void; noteValue: string; onNote: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ id: number; message: string } | null>(null);
  const [stockErr, setStockErr] = useState("");
  // Đợt 4: khuyến mãi tự động, voucher, đổi điểm — engine tính ở máy chủ (xem trước), đơn thật tính lại trong cùng giao dịch
  const [voucherIn, setVoucherIn] = useState("");
  const [voucher, setVoucher] = useState("");
  const [redeem, setRedeem] = useState(0);
  const [prev, setPrev] = useState<Preview | null>(null);
  const [promoErr, setPromoErr] = useState("");
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const loy = useAsync(() => (customer ? get(`/customers/${customer.id}/loyalty`, undefined, { silent: true }).catch(() => null) : Promise.resolve(null)), [customer?.id]);
  const lbody = payloadBase();
  const lkey = JSON.stringify([lbody.lines, customer?.id, voucher, redeem]);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r: Preview = await post("/promotions/preview", { channel: "pos", lines: lbody.lines.map((l: any) => ({ productId: l.productId, unit: l.unit, qty: l.qty })), ...(customer ? { customerId: customer.id } : {}), ...(voucher ? { voucherCode: voucher } : {}), ...(redeem > 0 ? { redeemPoints: redeem } : {}) }, { silent: true });
        if (live) { setPrev(r); setPromoErr(""); setServerTotal(null); }
      } catch (e) {
        if (!live) return;
        setPrev(null);
        if (e instanceof ApiError && e.code === "redeem_too_high") { setPromoErr(`Chỉ đổi tối đa ${e.details?.maxPoints ?? 0} điểm cho đơn này.`); setRedeem(Math.max(0, e.details?.maxPoints ?? 0)); }
        else if (e instanceof ApiError && e.code === "points_insufficient") { setPromoErr("Khách không đủ điểm để đổi."); setRedeem(0); }
        else if (e instanceof ApiError && e.code !== "network") setPromoErr(e.message);
      }
    })();
    return () => { live = false; };
  }, [lkey]); // eslint-disable-line
  const voucherDiscount = prev?.discounts.find((d) => d.voucherId != null);
  const voucherApplied = !!voucher && !!voucherDiscount;
  const voucherRejected = voucher && prev && !voucherApplied ? prev.rejected.find((r) => r.reason !== "not_best_promotion") ?? prev.rejected[0] : undefined;
  const promoOnly = (prev?.discounts ?? []).filter((d) => d.voucherId == null);
  const total = serverTotal ?? Math.max(0, localTotal - (prev?.discount ?? 0));

  const [pays, setPays] = useState<Pay[]>([{ method: "cash", amount: total }]);
  const [active, setActive] = useState(0);
  useEffect(() => { setPays((ps) => (ps.length === 1 ? [{ ...ps[0], amount: total }] : ps)); }, [total]);
  const paid = pays.reduce((s, p) => s + p.amount, 0);
  const cash = pays.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const over = paid - total, remaining = total - paid;
  const change = over > 0 ? over : 0;
  const valid = paid >= total && (over === 0 || cash >= over) && pays.every((p) => p.amount > 0);
  const setAmt = (i: number, n: number) => setPays((ps) => ps.map((p, j) => (j === i ? { ...p, amount: n } : p)));
  const quick = Array.from(new Set([total, ...[50000, 100000, 200000, 500000].map((s) => Math.ceil(total / s) * s)])).filter((v) => v >= total).slice(0, 4);
  const pointVal = loy.data?.pointValueVnd ?? 0;
  const maxByBalance = loy.data?.points ?? 0;

  const submit = async () => {
    setBusy(true); setStockErr(""); setPromoErr("");
    const payload = { ...payloadBase(), ...(voucherApplied ? { voucherCode: voucher } : {}), ...(redeem > 0 ? { redeemPoints: redeem } : {}), ...(approval ? { approvalId: approval.id } : {}), ...(noteValue ? { note: noteValue } : {}), payments: pays.map((p) => ({ method: p.method, amount: p.amount })) };
    try {
      const order = await post("/pos/orders", payload, { silent: true });
      toast("Thanh toán thành công", "ok");
      onDone(order, order.change ?? change);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "network") { await enqueue(payload); onQueued(); }
        else if (e.code === "approval_required") setApproval({ id: e.details?.approvalId, message: e.message });
        else if (e.code === "insufficient_stock") setStockErr(`${e.message}${e.details?.productName ? " — " + e.details.productName : ""}`);
        else if (e.code === "voucher_exhausted") { setPromoErr("Voucher đã hết lượt sử dụng — đã bỏ voucher khỏi đơn."); setVoucher(""); setVoucherIn(""); }
        else if (e.code === "voucher_invalid") { setPromoErr(`Voucher không áp dụng được: ${reasonText(e.details?.reason ?? "")}.`); setVoucher(""); }
        else if (e.code === "points_insufficient") { setPromoErr("Khách không đủ điểm để đổi — đã bỏ phần đổi điểm."); setRedeem(0); loy.reload(); }
        else if (e.code === "redeem_too_high") { setPromoErr(`Số điểm đổi vượt mức cho phép (tối đa ${e.details?.maxPoints ?? 0} điểm).`); setRedeem(Math.max(0, e.details?.maxPoints ?? 0)); }
        else if (e.code === "payment_mismatch" && e.details?.total != null) { setServerTotal(e.details.total); setPromoErr(`Tổng tiền thực tế là ${money(e.details.total)} — đã cập nhật, kiểm tra lại thanh toán.`); setPays([{ method: "cash", amount: e.details.total }]); }
        else toast(e.message, "error");
      }
    } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Thanh toán" footer={<Button block size="lg" loading={busy} disabled={!valid} onClick={submit}>{approval ? "Thử lại" : "Hoàn tất"} · {money(total)}</Button>}>
      <div className="stack">
        <div className="totals">
          {(prev?.discount ?? 0) > 0 && <div><span className="muted">Tạm tính</span><span className="money">{money(localTotal)}</span></div>}
          {promoOnly.map((d, i) => <div key={i} data-testid="pos-discount"><span>{d.description}</span><span className="money">-{money(d.amount)}</span></div>)}
          {voucherDiscount && <div data-testid="pos-discount"><span>{voucherDiscount.description || `Voucher ${voucher}`}</span><span className="money">-{money(voucherDiscount.amount)}</span></div>}
          {(prev?.pointsAmount ?? 0) > 0 && <div data-testid="pos-discount"><span>Đổi {prev!.pointsRedeemed} điểm</span><span className="money">-{money(prev!.pointsAmount)}</span></div>}
          <div className="grand" style={(prev?.discount ?? 0) > 0 ? undefined : { borderTop: 0, marginTop: 0 }}><span>Cần thanh toán</span><span className="money" data-testid="pos-total">{money(total)}</span></div>
        </div>
        <div className="card flat" style={{ padding: 12 }}>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="grow"><Input label="Mã voucher" value={voucherIn} onChange={(e) => setVoucherIn(e.target.value.toUpperCase())} placeholder="Nhập mã giảm giá" autoCapitalize="characters" /></div>
            {voucher ? <Button variant="ghost" onClick={() => { setVoucher(""); setVoucherIn(""); }}>Bỏ</Button> : <Button variant="soft" disabled={!voucherIn.trim()} onClick={() => setVoucher(voucherIn.trim())}>Áp dụng</Button>}
          </div>
          {voucherApplied && <div className="small" style={{ color: "var(--accent)", marginTop: 6 }}>Đã áp dụng voucher {voucher}.</div>}
          {voucherRejected && <div className="small err" role="alert" style={{ marginTop: 6 }}>Voucher {voucher} không áp dụng: {reasonText(voucherRejected.reason)}.</div>}
          {customer && loy.data?.enabled && (
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="row between"><span>Điểm của {customer.name}</span><b data-testid="pos-points">{(loy.data.points ?? 0).toLocaleString("vi-VN")} điểm</b></div>
              {maxByBalance > 0 && (
                <div className="row" style={{ alignItems: "flex-end" }}>
                  <div className="grow"><Input label={`Đổi điểm (1 điểm = ${money(pointVal)})`} type="number" min={0} max={maxByBalance} value={redeem || ""} onChange={(e) => setRedeem(Math.max(0, Math.min(maxByBalance, Math.floor(Number(e.target.value) || 0))))} /></div>
                  <Button variant="soft" onClick={() => setRedeem(Math.min(maxByBalance, Math.floor((Math.max(0, localTotal - (promoOnly.reduce((s, d) => s + d.amount, 0) + (voucherDiscount?.amount ?? 0))) * 0.5) / (pointVal || 1))))}>Tối đa</Button>
                </div>)}
            </div>
          )}
          {customer && loy.data && !loy.data.enabled && <div className="hint" style={{ marginTop: 6 }}>Chương trình tích điểm đang tắt.</div>}
          {!customer && <div className="hint" style={{ marginTop: 6 }}>Gắn khách hàng ở giỏ hàng để tích / đổi điểm.</div>}
        </div>
        {promoErr && <Banner tone="danger">{promoErr}</Banner>}
        {approval && (
          <div className="banner" role="alert">
            <b>Cần quản lý duyệt</b>
            <div className="small">{approval.message} Mã yêu cầu duyệt: <b>#{approval.id ?? "?"}</b>. Báo quản lý duyệt trong mục “Duyệt”, sau đó bấm <b>Thử lại</b>.</div>
          </div>
        )}
        {stockErr && <Banner tone="danger">{stockErr}. Hãy giảm số lượng hoặc bỏ mặt hàng.</Banner>}
        {pays.map((p, i) => (
          <div key={i} className="card flat" style={{ padding: 12, outline: active === i ? "2px solid var(--accent)" : undefined }} onClick={() => setActive(i)}>
            <div className="row">
              <div className="chips grow" role="radiogroup" aria-label="Hình thức thanh toán">
                {[["cash", "Tiền mặt"], ["transfer", "Chuyển khoản"], ["qr", "QR"], ["card", "Thẻ"]].map(([m, l]) => (
                  <button key={m} className="chip" role="radio" aria-checked={p.method === m} aria-pressed={p.method === m} onClick={() => setPays((ps) => ps.map((x, j) => (j === i ? { ...x, method: m } : x)))}>{l}</button>
                ))}
              </div>
              {pays.length > 1 && <Button size="sm" variant="ghost" aria-label="Bỏ dòng thanh toán" onClick={() => { setPays((ps) => ps.filter((_, j) => j !== i)); setActive(0); }}>✕</Button>}
            </div>
            <div style={{ marginTop: 8 }}><MoneyInput label={`Số tiền (${METHODS[p.method]})`} value={p.amount} onChange={(n) => setAmt(i, n)} /></div>
            {active === i && p.method === "cash" && (
              <div className="stack" style={{ marginTop: 8 }}>
                <div className="chips">{quick.map((v) => <button key={v} className="chip" onClick={() => setAmt(i, v)}>{money(v)}</button>)}</div>
                <NumberPad value={p.amount} onChange={(n) => setAmt(i, n)} />
              </div>
            )}
          </div>
        ))}
        {pays.length < 3 && <Button variant="ghost" onClick={() => { setPays((ps) => [...ps, { method: ps.some((p) => p.method === "qr") ? "transfer" : "qr", amount: Math.max(0, remaining) }]); setActive(pays.length); }}>+ Chia thanh toán</Button>}
        <div className="totals">
          <div><span className="muted">Đã nhận</span><span className="money">{money(paid)}</span></div>
          {remaining > 0 && <div style={{ color: "var(--danger)" }}><span>Còn thiếu</span><span className="money">{money(remaining)}</span></div>}
          {over > 0 && <div style={{ color: valid ? "var(--accent)" : "var(--danger)", fontWeight: 700 }}><span>Tiền thừa trả khách</span><span className="money">{money(over)}</span></div>}
          {over > 0 && cash < over && <div className="err">Chỉ tiền mặt mới được thừa.</div>}
        </div>
        <TextArea label="Ghi chú đơn (không bắt buộc)" value={noteValue} onChange={(e) => onNote(e.target.value)} />
      </div>
    </Sheet>
  );
}
