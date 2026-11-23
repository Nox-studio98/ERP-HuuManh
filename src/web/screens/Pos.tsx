import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Badge, Banner, Button, Card, DecInput, EmptyState, Input, MoneyInput, NumberPad, QtyStepper, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { Scanner } from "../components/Scanner";
import { Receipt } from "../components/Receipt";
import { toast } from "../components/toast";
import { METHODS, money, qtyText, unitLabel, uuid, withShown } from "../format";
import { enqueue, useQueue, syncQueue } from "../offline";
import { navigate } from "../router";
import { useCan } from "../store";

export type Unit = { unit: string; factorMilli: number; barcode?: string };
export type Product = { id: number; sku: string; name: string; baseUnit: string; sellByWeight: boolean | number; barcode?: string; units?: Unit[]; availableMilli?: number; price?: number | { unitPrice: number } | null; avgCost?: number; [k: string]: any };
export const priceOf = (p: Product) => (typeof p.price === "number" ? p.price : p.price?.unitPrice ?? 0);
const factor = (p: Product, unit: string) => (unit === p.baseUnit ? 1000 : p.units?.find((u) => u.unit === unit)?.factorMilli ?? 1000);
const unitPrice = (p: Product, unit: string) => Math.round((priceOf(p) * factor(p, unit)) / 1000);

type Line = { key: string; product: Product; unit: string; qty: number; discount: number };
let saved = { lines: [] as Line[], cartId: uuid(), discount: 0, note: "" };

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
  return (
    <div style={{ maxWidth: 440, margin: "0 auto" }}>
      <Card title="Mở ca bán hàng">
        <div className="stack">
          <div className="muted">Chưa có ca đang mở. Nhập tiền mặt đầu ca trong két để bắt đầu bán hàng.</div>
          <MoneyInput label="Tiền đầu ca (₫)" value={cash} onChange={setCash} />
          <Button size="lg" block loading={busy} disabled={!allowed} onClick={async () => { setBusy(true); try { await post("/shifts/open", { openingCash: cash }); toast("Đã mở ca", "ok"); onOpened(); } catch {} finally { setBusy(false); } }}>Mở ca</Button>
          {!allowed && <div className="err">Bạn không có quyền mở ca.</div>}
        </div>
      </Card>
    </div>
  );
}

function Sell({ shift }: { shift: any }) {
  const [lines, setLines] = useState<Line[]>(saved.lines);
  const [cartId, setCartId] = useState(saved.cartId);
  const [discount, setDiscount] = useState(saved.discount);
  const [note, setNote] = useState(saved.note);
  useEffect(() => { saved = { lines, cartId, discount, note }; }, [lines, cartId, discount, note]);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const prods = useAsync(() => get("/products", { q: dq, limit: 60, active: 1 }).then((r) => items<Product>(r)), [dq]);
  const [view, setView] = useState<"products" | "cart">("products");
  const [scan, setScan] = useState(false);
  const [weighing, setWeighing] = useState<{ p: Product; unit?: string } | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [receipt, setReceipt] = useState<{ order: any; names: Record<number, string> } | null>(null);
  const queue = useQueue();

  const subtotal = useMemo(() => lines.reduce((s, l) => s + Math.round(l.qty * unitPrice(l.product, l.unit)) - l.discount, 0), [lines]);
  const total = Math.max(0, subtotal - discount);
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

  const reset = () => { setLines([]); setDiscount(0); setNote(""); setCartId(uuid()); setView("products"); };
  const names = Object.fromEntries(lines.map((l) => [l.product.id, l.product.name]));
  const payloadBase = () => ({
    clientUuid: cartId,
    lines: lines.map((l) => ({ productId: l.product.id, unit: l.unit, qty: l.qty, ...(l.discount ? { discount: l.discount } : {}) })),
    ...(discount ? { discount } : {}),
    ...(note ? { note } : {}),
  });

  return (
    <div className={"pos" + (view === "cart" ? " show-cart" : "")}>
      <div className="pos-products stack">
        <div className="row">
          <div className="grow"><Input label="Tìm sản phẩm" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tên hoặc mã…" /></div>
          <Button variant="soft" style={{ alignSelf: "flex-end" }} onClick={() => setScan(true)}>Quét mã</Button>
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
                <MoneyInput label="Giảm giá cả đơn (₫)" value={discount} onChange={setDiscount} />
                <div className="totals">
                  <div><span className="muted">Tạm tính</span><span className="money">{money(subtotal)}</span></div>
                  {discount > 0 && <div><span className="muted">Giảm giá</span><span className="money">-{money(discount)}</span></div>}
                  <div className="grand"><span>Tổng</span><span className="money">{money(total)}</span></div>
                </div>
                <Button size="lg" block disabled={total <= 0} onClick={() => setCheckout(true)}>Thanh toán {money(total)}</Button>
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
        <CheckoutSheet total={total} payloadBase={payloadBase} onClose={() => setCheckout(false)} noteValue={note} onNote={setNote}
          onDone={(order, change) => { setCheckout(false); setReceipt({ order: { ...withShown(order, new Map(lines.map((l) => [l.product.id, l.product]))), change }, names }); reset(); }}
          onQueued={() => { setCheckout(false); reset(); toast("Mất mạng — đã lưu đơn, sẽ đồng bộ sau", "info"); }} />
      )}
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
function CheckoutSheet({ total, payloadBase, onClose, onDone, onQueued, noteValue, onNote }: { total: number; payloadBase: () => any; onClose: () => void; onDone: (o: any, change: number) => void; onQueued: () => void; noteValue: string; onNote: (s: string) => void }) {
  const [pays, setPays] = useState<Pay[]>([{ method: "cash", amount: total }]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ id: number; message: string } | null>(null);
  const [stockErr, setStockErr] = useState("");
  const paid = pays.reduce((s, p) => s + p.amount, 0);
  const cash = pays.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const over = paid - total, remaining = total - paid;
  const change = over > 0 ? over : 0;
  const valid = paid >= total && (over === 0 || cash >= over) && pays.every((p) => p.amount > 0);
  const setAmt = (i: number, n: number) => setPays((ps) => ps.map((p, j) => (j === i ? { ...p, amount: n } : p)));
  const quick = Array.from(new Set([total, ...[50000, 100000, 200000, 500000].map((s) => Math.ceil(total / s) * s)])).filter((v) => v >= total).slice(0, 4);

  const submit = async () => {
    setBusy(true); setStockErr("");
    const payload = { ...payloadBase(), ...(approval ? { approvalId: approval.id } : {}), ...(noteValue ? { note: noteValue } : {}), payments: pays.map((p) => ({ method: p.method, amount: p.amount })) };
    try {
      const order = await post("/pos/orders", payload, { silent: true });
      toast("Thanh toán thành công", "ok");
      onDone(order, order.change ?? change);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "network") { await enqueue(payload); onQueued(); }
        else if (e.code === "approval_required") setApproval({ id: e.details?.approvalId, message: e.message });
        else if (e.code === "insufficient_stock") setStockErr(`${e.message}${e.details?.productName ? " — " + e.details.productName : ""}`);
        else toast(e.message, "error");
      }
    } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Thanh toán" footer={<Button block size="lg" loading={busy} disabled={!valid} onClick={submit}>{approval ? "Thử lại" : "Hoàn tất"} · {money(total)}</Button>}>
      <div className="stack">
        <div className="totals"><div className="grand" style={{ borderTop: 0, marginTop: 0 }}><span>Cần thanh toán</span><span className="money">{money(total)}</span></div></div>
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
