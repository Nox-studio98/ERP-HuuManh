import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Badge, Banner, Button, Card, DecInput, EmptyState, Input, MoneyInput, NumberPad, QtyStepper, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { Scanner } from "../components/Scanner";
import { Receipt } from "../components/Receipt";
import { toast } from "../components/toast";
import { METHODS, fmtDate, fmtDateTime, fmtTime, money, qtyText, unitLabel, uuid, withShown } from "../format";
import { enqueue, useQueue, syncQueue } from "../offline";
import { navigate, setQuery } from "../router";
import { createScanDetector, loadScannerSettings, saveScannerSettings, type ScannerSettings } from "../scanner";
import { QrImage } from "../components/QrImage";
import { PosDeliverySheet } from "../components/PosDeliverySheet";
import { PosDebtSheet } from "../components/PosDebtSheet";
import { PosQuickReturnSheet } from "../components/PosQuickReturnSheet";
import { useAuth, useCan } from "../store";
import { reasonText } from "./d4/voucher-text";

export type Unit = { unit: string; factorMilli: number; barcode?: string };
export type Product = { id: number; sku: string; name: string; baseUnit: string; sellByWeight: boolean | number; barcode?: string; units?: Unit[]; availableMilli?: number; price?: number | { unitPrice: number } | null; avgCost?: number; [k: string]: any };
export const priceOf = (p: Product) => (typeof p.price === "number" ? p.price : p.price?.unitPrice ?? 0);
const factor = (p: Product, unit: string) => (unit === p.baseUnit ? 1000 : p.units?.find((u) => u.unit === unit)?.factorMilli ?? 1000);
const unitPrice = (p: Product, unit: string) => Math.round((priceOf(p) * factor(p, unit)) / 1000);

type Line = { key: string; product: Product; unit: string; qty: number; discount: number };
type Cust = { id: number; name: string; phone?: string | null };
/** Một hoá đơn đang lập (tab). `cartId` là clientUuid khi gửi đơn — mỗi tab một mã riêng nên hàng đợi offline đúng từng tab. */
/** POS-KV B2: khoản thu khác (phí đóng gói, giỏ quà...) — cộng vào tổng đơn, không bị giảm giá / voucher / điểm. */
type Charge = { key: string; chargeTypeId?: number; name: string; amount: number };
type Cart = { id: string; lines: Line[]; cartId: string; discount: number; note: string; customer: Cust | null; sellerId: number | null; charges: Charge[] };
const MAX_TABS = 10;
const TABS_KEY = "hm_pos_tabs";
const newCart = (): Cart => ({ id: uuid(), lines: [], cartId: uuid(), discount: 0, note: "", customer: null, sellerId: null, charges: [] });
function loadTabs(): { tabs: Cart[]; active: string } {
  try {
    const j = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
    const tabs: Cart[] = (Array.isArray(j?.tabs) ? j.tabs : []).filter((t: any) => t && typeof t.id === "string" && typeof t.cartId === "string" && Array.isArray(t.lines)).slice(0, MAX_TABS)
      .map((t: any) => ({ id: t.id, cartId: t.cartId, lines: t.lines, discount: Number(t.discount) || 0, note: typeof t.note === "string" ? t.note : "", customer: t.customer ?? null, sellerId: typeof t.sellerId === "number" ? t.sellerId : null,
        charges: (Array.isArray(t.charges) ? t.charges : []).filter((x: any) => x && typeof x.key === "string" && typeof x.name === "string" && Number.isInteger(x.amount) && x.amount > 0) }));
    if (tabs.length) return { tabs, active: tabs.some((t) => t.id === j.active) ? j.active : tabs[0].id };
  } catch { /* hỏng hoặc bị chặn → chạy với 1 tab trống */ }
  const c = newCart();
  return { tabs: [c], active: c.id };
}
let saved = loadTabs();
const VIEW_KEY = "hm_pos_view";
const loadView = (): "list" | "grid" => { try { return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list"; } catch { return "list"; } };

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
  const open = async () => { setBusy(true); try { await post("/shifts/open", { openingCash: cash }); toast("Đã mở ca", "ok"); window.dispatchEvent(new Event("hm:shift")); onOpened(); } catch {} finally { setBusy(false); } };
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
            <div className="kbd-list"><span><kbd>F2</kbd> Tìm sản phẩm</span><span><kbd>F3</kbd> Hoá đơn mới</span><span><kbd>Ctrl</kbd>+<kbd>1…9</kbd> Chuyển hoá đơn</span><span><kbd>F4</kbd> Quét mã</span><span><kbd>F9</kbd> Thanh toán</span><span><kbd>Esc</kbd> Đóng hộp thoại</span></div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Sell({ shift }: { shift: any }) {
  const auth = useAuth();
  const can = useCan();
  const [tabs, setTabs] = useState<Cart[]>(saved.tabs);
  const [activeId, setActiveId] = useState(saved.active);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const { lines, cartId, discount, note, customer, sellerId, charges } = tab;
  const patch = (f: (t: Cart) => Partial<Cart>) => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, ...f(t) } : t)));
  const setLines = (u: Line[] | ((l: Line[]) => Line[])) => patch((t) => ({ lines: typeof u === "function" ? u(t.lines) : u }));
  const setDiscount = (n: number) => patch(() => ({ discount: n }));
  const setNote = (v: string) => patch(() => ({ note: v }));
  const setCustomer = (c: Cust | null) => patch(() => ({ customer: c }));
  const setSellerId = (id: number | null) => patch(() => ({ sellerId: id }));
  const setCharges = (u: Charge[] | ((c: Charge[]) => Charge[])) => patch((t) => ({ charges: typeof u === "function" ? u(t.charges) : u }));
  useEffect(() => {
    saved = { tabs, active: tab.id };
    try { localStorage.setItem(TABS_KEY, JSON.stringify(saved)); } catch { /* đầy bộ nhớ / chế độ riêng tư */ }
  }, [tabs, tab.id]);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [chargeSheet, setChargeSheet] = useState(false);
  const [debtSheet, setDebtSheet] = useState(false);
  const [quickReturn, setQuickReturn] = useState(false);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [groupId, setGroupId] = useState(0);
  const [pview, setPview] = useState<"list" | "grid">(loadView);
  const chooseView = (v: "list" | "grid") => { setPview(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* bỏ qua */ } };
  const groups = useAsync(() => get("/product-groups", undefined, { silent: true }).then((r) => items<{ id: number; name: string }>(r)).catch(() => [] as { id: number; name: string }[]), []);
  const prods = useAsync(() => get("/products", { q: dq, limit: 60, active: 1, ...(groupId ? { groupId } : {}) }).then((r) => items<Product>(r)), [dq, groupId]);
  const [view, setView] = useState<"products" | "cart">("products");
  const [scan, setScan] = useState(false);
  const [weighing, setWeighing] = useState<{ p: Product; unit?: string } | null>(null);
  const [asking, setAsking] = useState<{ p: Product; unit?: string } | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [delivery, setDelivery] = useState(false); // B3: bán giao hàng tại quầy
  const [receipt, setReceipt] = useState<{ order: any; names: Record<number, string> } | null>(null);
  const [settings, setSettings] = useState(false);
  const [scanCfg, setScanCfg] = useState<ScannerSettings>(loadScannerSettings);
  const queue = useQueue();
  const totalRef = useRef(0);

  // A4: danh sách người bán; endpoint chưa có (404) hoặc lỗi → ẩn ô chọn, không gửi sellerId
  const sellers = useAsync(() => get("/pos/sellers", undefined, { silent: true }).then((r) => items<{ id: number; name: string }>(r)).catch(() => null), []);

  // A1: thao tác trên tab
  const live = useRef({ tabs, tab }); live.current = { tabs, tab };
  const addTab = () => {
    if (live.current.tabs.length >= MAX_TABS) { toast(`Tối đa ${MAX_TABS} hoá đơn cùng lúc`, "info"); return; }
    const c = newCart(); setTabs((ts) => [...ts, c]); setActiveId(c.id); setView("products");
  };
  const gotoTab = (i: number) => { const t = live.current.tabs[i]; if (t) { setActiveId(t.id); setView("products"); } };
  const closeTab = (id: string) => {
    const ts = live.current.tabs, t = ts.find((x) => x.id === id);
    if (!t) return;
    if (t.lines.length && !confirm("Hoá đơn này còn hàng trong giỏ. Đóng và bỏ giỏ?")) return;
    if (ts.length <= 1) { const c = newCart(); setTabs([c]); setActiveId(c.id); return; }
    const i = ts.findIndex((x) => x.id === id), rest = ts.filter((x) => x.id !== id);
    setTabs(rest);
    if (id === live.current.tab.id) setActiveId(rest[Math.min(i, rest.length - 1)].id);
  };
  /** Sau khi thanh toán: tab trống lại nếu là tab duy nhất, còn nhiều tab thì đóng tab vừa bán. */
  const finishTab = (id: string) => {
    const ts = live.current.tabs;
    if (ts.length <= 1) { const c = newCart(); setTabs([c]); setActiveId(c.id); return; }
    const i = ts.findIndex((x) => x.id === id), rest = ts.filter((x) => x.id !== id);
    setTabs(rest);
    if (id === live.current.tab.id) setActiveId(rest[Math.min(i, rest.length - 1)].id);
  };
  const keyApi = useRef({ addTab, gotoTab }); keyApi.current = { addTab, gotoTab };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (document.querySelector(".sheet-back")) return;
      if (e.key === "F2") { e.preventDefault(); (document.querySelector("[data-pos-search]") as HTMLInputElement | null)?.focus(); }
      else if (e.key === "F3") { e.preventDefault(); keyApi.current.addTab(); }
      else if (e.key === "F4") { e.preventDefault(); setScan(true); }
      else if (e.key === "F9" && totalRef.current > 0) { e.preventDefault(); setCheckout(true); }
      else if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); keyApi.current.gotoTab(Number(e.key) - 1); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  // A-22: có khách → lấy giá riêng của khách (bảng giá kind=customer, kênh pos/all) từ máy chủ; không lấy được thì giữ giá hiển thị
  const [custPrices, setCustPrices] = useState<Record<number, number>>({});
  const prodKey = lines.map((l) => l.product.id).join(",");
  useEffect(() => {
    if (!customer) { setCustPrices({}); return; }
    let live = true;
    (async () => {
      const out: Record<number, number> = {};
      await Promise.all([...new Set(lines.map((l) => l.product.id))].map(async (id) => {
        try { const r = await get("/prices/quote", { productId: id, channel: "pos", customerId: customer.id }, { silent: true }); if (typeof r?.unitPrice === "number") out[id] = r.unitPrice; } catch { /* giữ giá hiển thị */ }
      }));
      if (live) setCustPrices(out);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id, prodKey]);
  const shown = useMemo(() => lines.map((l) => (custPrices[l.product.id] != null ? { ...l, product: { ...l.product, price: custPrices[l.product.id] } } : l)), [lines, custPrices]);
  const subtotal = useMemo(() => shown.reduce((s, l) => s + Math.round(l.qty * unitPrice(l.product, l.unit)) - l.discount, 0), [shown]);
  const chargesTotal = charges.reduce((s, c) => s + c.amount, 0);
  const total = Math.max(0, subtotal - discount) + chargesTotal;
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

  // A3: tra mã từ máy quét USB/Bluetooth — barcode hàng hoặc barcode đơn vị quy đổi (thêm đúng đơn vị)
  const onHardwareScan = async (code: string) => {
    let r: any;
    try { r = await get("/products/lookup", { code, context: "pos" }, { silent: true }); }
    catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.code === "unknown_code")) toast(`Không có hàng với mã ${code}`, "error");
      else toast(e instanceof ApiError && e.code === "network" ? "Mất mạng — chưa tra được mã" : e instanceof ApiError ? e.message : "Không tra được mã", "error");
      return;
    }
    if (r.lot?.expired || r.lot?.status === "expired") { toast("Lô này đã hết hạn — không bán", "error"); return; }
    let p = r.product as Product;
    if (!p.active) { toast(`${p.name} đã ngừng bán`, "error"); return; }
    try { const full = items<Product>(await get("/products", { ids: p.id }, { silent: true }))[0]; if (full) p = full; } catch { /* giữ bản rút gọn */ }
    const unit: string | undefined = r.unit?.unit ?? undefined;
    const byWeight = !!p.sellByWeight && (unit === undefined || unit === p.baseUnit);
    if (byWeight) { add(p, unit); return; } // mở ô nhập khối lượng
    if (scanCfg.mode === "ask") { setAsking({ p, unit }); return; }
    add(p, unit); toast(`Đã thêm: ${p.name}`, "ok");
  };
  const hw = useRef(onHardwareScan); hw.current = onHardwareScan;
  useEffect(() => {
    if (!scanCfg.on) return;
    const det = createScanDetector();
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (document.querySelector(".sheet-back")) { det.reset(); return; } // đang mở hộp thoại: không chen vào
      const sc = det.push({ key: e.key, t: e.timeStamp });
      if (!sc) return;
      // Máy quét gõ vào ô đang focus → xoá phần vừa bị gõ vào ô rồi xử lý như quét
      const el = document.activeElement;
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.endsWith(sc.code)) {
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, el.value.slice(0, el.value.length - sc.code.length));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      e.preventDefault(); e.stopPropagation();
      void hw.current(sc.code);
    };
    document.addEventListener("keydown", k, true);
    return () => document.removeEventListener("keydown", k, true);
  }, [scanCfg.on]);
  const changeScanCfg = (c: ScannerSettings) => { setScanCfg(c); saveScannerSettings(c); };

  // A5: sao chép hoá đơn — màn Đơn hàng ghi sessionStorage["hm_pos_copy"] rồi mở /pos?copy=1 → mở TAB MỚI với đúng hàng đó
  useEffect(() => {
    if (new URLSearchParams(location.search).get("copy") !== "1") return;
    let req: any = null;
    try { const raw = sessionStorage.getItem("hm_pos_copy"); sessionStorage.removeItem("hm_pos_copy"); req = raw ? JSON.parse(raw) : null; } catch { req = null; }
    setQuery({ copy: undefined });
    const src: { productId: number; unit: string; qtyMilli: number }[] = Array.isArray(req?.lines)
      ? req.lines.filter((l: any) => l && Number.isInteger(l.productId) && typeof l.unit === "string" && Number.isFinite(l.qtyMilli) && l.qtyMilli > 0) : [];
    if (!src.length) { toast("Không có dữ liệu hoá đơn để sao chép", "error"); return; }
    (async () => {
      let list: Product[] = [];
      try { list = items<Product>(await get("/products", { ids: [...new Set(src.map((l) => l.productId))].join(","), limit: 100 }, { silent: true })); }
      catch { toast("Không tải được hàng để sao chép — thử lại", "error"); return; }
      const byId = new Map(list.map((p) => [p.id, p]));
      const out: Line[] = [], skipped: string[] = [];
      for (const l of src) {
        const p = byId.get(l.productId);
        if (!p || !p.active) { skipped.push(p?.name ?? `mã #${l.productId}`); continue; }
        const f = l.unit === p.baseUnit ? 1000 : p.units?.find((u) => u.unit === l.unit)?.factorMilli;
        if (!f) { skipped.push(p.name); continue; }
        const raw = l.qtyMilli / f; // qtyMilli tính theo đơn vị chính (như cột order_lines.qty_milli) → quy ra số lượng theo đơn vị của dòng
        const qty = p.sellByWeight ? Math.round(raw * 1000) / 1000 : Math.max(1, Math.round(raw));
        const ex = out.find((o) => o.product.id === p.id && o.unit === l.unit);
        if (ex) ex.qty = Math.round((ex.qty + qty) * 1000) / 1000; else out.push({ key: uuid(), product: p, unit: l.unit, qty, discount: 0 });
      }
      if (!out.length) { toast("Không có hàng nào còn bán để sao chép", "error"); return; }
      const c: Cart = { ...newCart(), lines: out, customer: req.customerId ? { id: Number(req.customerId), name: String(req.customerName ?? `Khách #${req.customerId}`) } : null };
      if (live.current.tabs.length >= MAX_TABS) { toast(`Đã đủ ${MAX_TABS} hoá đơn — đóng bớt một hoá đơn rồi sao chép lại`, "error"); return; }
      setTabs((ts) => [...ts, c]); setActiveId(c.id); setView("cart");
      toast(skipped.length ? `Đã sao chép. Bỏ qua ${skipped.length} hàng không còn bán: ${skipped.join(", ")}` : "Đã sao chép hoá đơn sang hoá đơn mới", skipped.length ? "info" : "ok");
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => { patch(() => ({ lines: [], discount: 0, note: "", customer: null, cartId: uuid(), sellerId: null, charges: [] })); setView("products"); };
  const names = Object.fromEntries(lines.map((l) => [l.product.id, l.product.name]));
  const payloadBase = () => ({
    clientUuid: cartId,
    lines: lines.map((l) => ({ productId: l.product.id, unit: l.unit, qty: l.qty, ...(l.discount ? { discount: l.discount } : {}) })),
    ...(customer ? { customerId: customer.id } : {}),
    ...(discount ? { discount } : {}),
    ...(charges.length ? { charges: charges.map((c) => ({ ...(c.chargeTypeId ? { chargeTypeId: c.chargeTypeId } : { name: c.name }), amount: c.amount })) } : {}),
    ...(note ? { note } : {}),
    // A4: chỉ gửi sellerId khi máy chủ có danh sách người bán và người chọn khác người đăng nhập
    ...(sellers.data && sellerId != null && sellerId !== auth.user?.id && sellers.data.some((x) => x.id === sellerId) ? { sellerId } : {}),
    // A-09: ca đang bán và giá khách đã thấy — để đơn lập offline đồng bộ lại đúng ca / đúng giá
    shiftId: shift.id,
    priceSnapshot: [...new Map(shown.map((l) => [l.product.id, { productId: l.product.id, unitPrice: priceOf(l.product) }])).values()].filter((x) => x.unitPrice > 0),
  });

  return (
    <div className={"pos" + (view === "cart" ? " show-cart" : "")}>
      <div className="pos-tabs" role="tablist" aria-label="Hoá đơn đang lập" data-testid="pos-tabs">
        {tabs.map((t, i) => (
          <div key={t.id} className={"pos-tab" + (t.id === tab.id ? " on" : "")}>
            <button role="tab" aria-selected={t.id === tab.id} className="pos-tab-main" data-testid={`pos-tab-${i + 1}`} onClick={() => { setActiveId(t.id); setView("products"); }} title={`Ctrl+${i + 1}`}>
              <span className="long">Hoá đơn {i + 1}</span><span className="short">HĐ {i + 1}</span>
              {t.lines.length > 0 && <span className="pos-tab-n">{t.lines.length}</span>}
            </button>
            {(tabs.length > 1 || t.lines.length > 0) && <button className="pos-tab-x" aria-label={`Đóng hoá đơn ${i + 1}`} onClick={() => closeTab(t.id)}>×</button>}
          </div>
        ))}
        <button className="pos-tab-add" aria-label="Thêm hoá đơn" title="Thêm hoá đơn (F3)" disabled={tabs.length >= MAX_TABS} data-testid="pos-tab-add" onClick={addTab}>+<span className="kbd-hint"> F3</span></button>
      </div>
      <div className="pos-products stack">
        <div className="row pos-searchrow">
          <div className="grow"><Input label="Tìm sản phẩm" type="search" data-pos-search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tên hoặc mã…  (F2)" /></div>
          <Button variant="soft" style={{ alignSelf: "flex-end" }} onClick={() => setScan(true)}>Quét mã<span className="kbd-hint"> F4</span></Button>
          <Button variant="soft" style={{ alignSelf: "flex-end" }} data-testid="pos-debt-btn" title="Thu nợ khách lẻ" onClick={() => setDebtSheet(true)}>Thu nợ</Button>
          {can("pos.return") && <Button variant="soft" style={{ alignSelf: "flex-end" }} data-testid="pos-quick-return-btn" title="Khách trả hàng không có hoá đơn" onClick={() => setQuickReturn(true)}>Trả hàng nhanh</Button>}
          <Button variant="ghost" style={{ alignSelf: "flex-end" }} aria-label="Cài đặt quầy" title="Cài đặt quầy" data-testid="pos-settings" onClick={() => setSettings(true)}>⚙</Button>
        </div>
        <div className="pos-filter">
          {!!groups.data?.length && (
            <div className="chips scroll" role="group" aria-label="Nhóm hàng">
              <button className="chip" aria-pressed={groupId === 0} onClick={() => setGroupId(0)}>Tất cả</button>
              {groups.data.map((g) => <button key={g.id} className="chip" aria-pressed={groupId === g.id} onClick={() => setGroupId(g.id)}>{g.name}</button>)}
            </div>
          )}
          <Segmented value={pview} onChange={chooseView} fit options={[{ v: "list", label: "Danh sách" }, { v: "grid", label: "Lưới ảnh" }]} />
        </div>
        {queue.length > 0 && <div className="banner">Có {queue.length} đơn chờ đồng bộ. <Button size="sm" variant="ghost" onClick={() => syncQueue(true)}>Đồng bộ ngay</Button></div>}
        {prods.loading ? <Spinner /> : !prods.data?.length ? <EmptyState title="Không có sản phẩm" hint="Thử từ khoá khác hoặc quét mã." /> : (
          <div className={"pgrid" + (pview === "grid" ? " photos" : "")} data-testid={pview === "grid" ? "pos-photo-grid" : undefined}>
            {prods.data.map((p) => (
              <button key={p.id} className={"ptile" + (pview === "grid" ? " photo" : "")} onClick={() => add(p)} aria-label={`Thêm ${p.name}`}>
                {pview === "grid" && <ProductThumb p={p} />}
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
                {shown.map((l) => {
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
                {sellers.data && sellers.data.length > 0 && (
                  <Select label="Người bán" data-testid="pos-seller" value={String(sellerId ?? auth.user?.id ?? "")} onChange={(e) => setSellerId(Number(e.target.value) === auth.user?.id ? null : Number(e.target.value))}>
                    {!sellers.data.some((x) => x.id === auth.user?.id) && auth.user && <option value={auth.user.id}>{auth.user.fullName}</option>}
                    {sellers.data.map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === auth.user?.id ? " (bạn)" : ""}</option>)}
                  </Select>
                )}
                <MoneyInput label="Giảm giá cả đơn (₫)" value={discount} onChange={setDiscount} />
                <div className="row between" data-testid="pos-charges">
                  <span className="small muted">Thu khác (phí đóng gói, giỏ quà…)</span>
                  <Button size="sm" variant="soft" data-testid="pos-add-charge" style={{ whiteSpace: "nowrap" }} onClick={() => setChargeSheet(true)}>+ Thu khác</Button>
                </div>
                <div className="totals">
                  <div><span className="muted">Tạm tính</span><span className="money">{money(subtotal)}</span></div>
                  {discount > 0 && <div><span className="muted">Giảm giá</span><span className="money">-{money(discount)}</span></div>}
                  {charges.map((ch) => (
                    <div key={ch.key} data-testid="pos-charge-row"><span className="muted">{ch.name} <button className="link-btn" aria-label={`Bỏ ${ch.name}`} onClick={() => setCharges((cs) => cs.filter((x) => x.key !== ch.key))} style={{ background: "none", border: 0, cursor: "pointer", color: "var(--muted)", padding: "0 4px" }}>✕</button></span><span className="money">+{money(ch.amount)}</span></div>
                  ))}
                  <div className="grand"><span>Tổng</span><span className="money">{money(total)}</span></div>
                </div>
                <div className="pos-paybar stack">
                  <Button size="lg" block disabled={total <= 0} onClick={() => setCheckout(true)}>Thanh toán {money(total)}<span className="kbd-hint"> F9</span></Button>
                  <Button block variant="soft" data-testid="pos-delivery" disabled={count <= 0} onClick={() => setDelivery(true)}>Giao hàng</Button>
                </div>
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
      <Sheet open={settings} onClose={() => setSettings(false)} title="Cài đặt quầy">
        <div className="stack">
          <label className="row" style={{ minHeight: 44, alignItems: "flex-start" }}>
            <input type="checkbox" data-testid="pos-scanner-on" checked={scanCfg.on} onChange={(e) => changeScanCfg({ ...scanCfg, on: e.target.checked })} style={{ width: 22, height: 22, flex: "none", marginTop: 2 }} />
            <span><b>Dùng máy quét mã vạch</b><span className="small muted"> USB / Bluetooth (loại gõ như bàn phím). Quét được ở mọi chỗ trên màn bán hàng, không cần bấm vào ô tìm.</span></span>
          </label>
          {scanCfg.on && <Select label="Sau khi quét" value={scanCfg.mode} onChange={(e) => changeScanCfg({ ...scanCfg, mode: e.target.value === "ask" ? "ask" : "add" })}><option value="add">Cộng 1 vào giỏ</option><option value="ask">Hỏi số lượng</option></Select>}
          <div className="hint">Cài đặt lưu theo thiết bị này. Không có máy quét thì vẫn gõ tìm hoặc quét bằng camera (F4) như cũ.</div>
        </div>
      </Sheet>
      {asking && <AskQtySheet p={asking.p} unit={asking.unit ?? asking.p.baseUnit} onClose={() => setAsking(null)} onAdd={(n) => { add(asking.p, asking.unit, n); toast(`Đã thêm: ${asking.p.name}`, "ok"); setAsking(null); }} />}
      {weighing && <WeightSheet p={weighing.p} unit={weighing.unit ?? weighing.p.baseUnit} onClose={() => setWeighing(null)} onAdd={(n) => { add(weighing.p, weighing.unit, n); setWeighing(null); }} />}
      {checkout && (
        <CheckoutSheet total={total} charges={charges} payloadBase={payloadBase} customer={customer} onClose={() => setCheckout(false)} noteValue={note} onNote={setNote}
          onDone={(order, change) => { setCheckout(false); setReceipt({ order: { ...withShown(order, new Map(lines.map((l) => [l.product.id, l.product]))), change }, names }); finishTab(tab.id); setView("products"); }}
          onQueued={() => { setCheckout(false); finishTab(tab.id); setView("products"); toast("Mất mạng — đã lưu đơn, sẽ đồng bộ sau", "info"); }} />
      )}
      {delivery && <PosDeliverySheet lines={lines.map((l) => ({ productId: l.product.id, name: l.product.name, unit: l.unit, qty: l.qty }))} customer={customer} hasManualDiscount={discount > 0 || lines.some((l) => l.discount > 0)} onClose={() => setDelivery(false)} onDone={() => { setDelivery(false); reset(); }} />}
      {chargeSheet && <ChargesSheet charges={charges} onChange={setCharges} onClose={() => setChargeSheet(false)} />}
      {debtSheet && <PosDebtSheet onClose={() => setDebtSheet(false)} />}
      {quickReturn && <PosQuickReturnSheet customer={customer ? { id: customer.id, name: customer.name } : null} onClose={() => setQuickReturn(false)} onDone={() => setQuickReturn(false)} />}
      {pickCustomer && <CustomerSheet onClose={() => setPickCustomer(false)} onPick={(c) => { setCustomer(c); setPickCustomer(false); }} />}
      <Sheet open={!!receipt} onClose={() => setReceipt(null)} title="Hoá đơn" footer={<Button block onClick={() => setReceipt(null)}>Đơn mới</Button>}>
        {receipt && <Receipt order={receipt.order} names={receipt.names} />}
      </Sheet>
    </div>
  );
}

/** POS-KV B2: chọn loại thu khác có sẵn (chủ cấu hình ở Cài đặt) hoặc nhập tay (cần quyền quản lý). */
function ChargesSheet({ charges, onChange, onClose }: { charges: Charge[]; onChange: (u: (c: Charge[]) => Charge[]) => void; onClose: () => void }) {
  const can = useCan();
  const types = useAsync(() => get("/charge-types", undefined, { silent: true }).then((r) => items<{ id: number; name: string; defaultAmount: number }>(r)).catch(() => [] as { id: number; name: string; defaultAmount: number }[]), []);
  const [name, setName] = useState(""), [amount, setAmount] = useState(0);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [typeAmount, setTypeAmount] = useState(0);
  const manual = can("pos.other_charge");
  const pickType = (t: { id: number; name: string; defaultAmount: number }) => { setTypeId(t.id); setTypeAmount(t.defaultAmount); };
  const chosen = types.data?.find((t) => t.id === typeId);
  const addType = () => {
    if (!chosen || typeAmount <= 0) return;
    onChange((cs) => [...cs, { key: uuid(), chargeTypeId: chosen.id, name: chosen.name, amount: typeAmount }]);
    toast(`Đã thêm ${chosen.name}`, "ok"); setTypeId(null);
  };
  const addManual = () => {
    if (!name.trim() || amount <= 0) return;
    onChange((cs) => [...cs, { key: uuid(), name: name.trim(), amount }]);
    toast(`Đã thêm ${name.trim()}`, "ok"); setName(""); setAmount(0);
  };
  const editable = !!chosen && manual; // số tiền khác mặc định (kể cả loại mặc định 0) cần quyền pos.other_charge
  return (
    <Sheet open onClose={onClose} title="Thu khác" footer={<Button block onClick={onClose}>Xong</Button>}>
      <div className="stack" data-testid="pos-charges-sheet">
        <div className="hint">Khoản thu thêm trên hoá đơn. Không áp khuyến mãi, voucher, điểm và không tích điểm.</div>
        {charges.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            {charges.map((ch) => (
              <div key={ch.key} className="row between"><span>{ch.name}</span><span className="row"><b className="money">{money(ch.amount)}</b><Button size="sm" variant="ghost" aria-label={`Bỏ ${ch.name}`} onClick={() => onChange((cs) => cs.filter((x) => x.key !== ch.key))}>✕</Button></span></div>
            ))}
          </div>
        )}
        {types.loading ? <Spinner /> : !!types.data?.some((t) => manual || t.defaultAmount > 0) && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="chips" role="group" aria-label="Loại thu khác">
              {types.data.filter((t) => manual || t.defaultAmount > 0).map((t) => <button key={t.id} className="chip" data-testid="pos-charge-type" aria-pressed={typeId === t.id} onClick={() => pickType(t)}>{t.name}{t.defaultAmount > 0 ? ` · ${money(t.defaultAmount)}` : ""}</button>)}
            </div>
            {chosen && (
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="grow">{editable ? <MoneyInput label={`${chosen.name} (₫)`} value={typeAmount} onChange={setTypeAmount} /> : <div><div className="small muted">{chosen.name}</div><b className="money">{money(typeAmount)}</b></div>}</div>
                <Button variant="soft" disabled={typeAmount <= 0} data-testid="pos-charge-add" onClick={addType}>Thêm</Button>
              </div>
            )}
          </div>
        )}
        {manual ? (
          <div className="card flat stack" style={{ padding: 12 }}>
            <b className="small">Nhập tay</b>
            <Input label="Tên khoản thu" value={name} onChange={(e) => setName(e.target.value)} data-testid="pos-charge-name" />
            <MoneyInput label="Số tiền (₫)" value={amount} onChange={setAmount} />
            <Button variant="soft" disabled={!name.trim() || amount <= 0} data-testid="pos-charge-add-manual" onClick={addManual}>Thêm khoản thu</Button>
          </div>
        ) : <div className="hint">Nhập tay khoản thu khác cần quyền quản lý. Loại có sẵn do chủ cấu hình ở Cài đặt.</div>}
      </div>
    </Sheet>
  );
}

/** Ô ảnh hàng: ảnh đầu tiên; chưa có ảnh (hoặc ảnh lỗi) → chữ cái đầu tên trên nền màu theo mã hàng. */
function ProductThumb({ p }: { p: Product }) {
  const [bad, setBad] = useState(false);
  const hue = (p.id * 47) % 360;
  if (p.imageUrl && !bad) return <img className="pimg" src={p.imageUrl} alt="" loading="lazy" onError={() => setBad(true)} />;
  return <span className="pimg ph" aria-hidden style={{ background: `hsl(${hue} 55% 88%)`, color: `hsl(${hue} 45% 28%)` }}>{(p.name.trim()[0] ?? "?").toUpperCase()}</span>;
}

/** Hỏi số lượng sau khi quét (chế độ “Hỏi số lượng”). */
function AskQtySheet({ p, unit, onAdd, onClose }: { p: Product; unit: string; onAdd: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState<number | "">(1);
  const v = typeof n === "number" ? n : 0;
  return (
    <Sheet open onClose={onClose} title={p.name} footer={<Button block size="lg" disabled={v <= 0} onClick={() => onAdd(p.sellByWeight ? v : Math.round(v))}>Thêm {v > 0 ? `${v.toString().replace(".", ",")} ${unitLabel(unit)}` : ""}</Button>}>
      <div className="stack">
        <DecInput label={`Số lượng (${unitLabel(unit)})`} value={n} onChange={setN} autoFocus />
        <div className="chips">{[1, 2, 5, 10].map((x) => <button key={x} className="chip" onClick={() => setN(x)}>{x}</button>)}</div>
      </div>
    </Sheet>
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

type QrState = { id: number; code: string; payload: string; amount: number; status: "pending" | "paid" | "expired" | "cancelled" | "used"; expiresAt: string };
type Pay = { method: string; amount: number; qr?: QrState };

/** QR tại quầy (SePay): tạo mã theo đơn, hỏi backend ~3 giây/lần (không gọi SePay), báo đã nhận tiền. */
function QrLine({ amount, qr, onChange }: { amount: number; qr?: QrState; onChange: (q: QrState | undefined) => void }) {
  const [busy, setBusy] = useState(false);
  const stale = !!qr && qr.amount !== amount;
  const cur = useRef(qr); cur.current = qr;
  useEffect(() => {
    if (!qr || qr.status !== "pending") return;
    let live = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await get(`/pos/qr-requests/${qr.id}`, undefined, { silent: true });
        if (live && cur.current?.id === qr.id && r.status !== cur.current.status) { onChange({ ...cur.current, status: r.status }); if (r.status === "paid") toast(`Đã nhận ${money(r.amount)} qua QR`, "ok"); }
      } catch { /* mất mạng: thử lại lần sau */ }
    };
    const t = setInterval(tick, 3000);
    return () => { live = false; clearInterval(t); };
  }, [qr?.id, qr?.status]); // eslint-disable-line
  const create = async () => {
    setBusy(true);
    try {
      const r = await post("/pos/qr-requests", { amount });
      onChange({ id: r.id, code: r.code, payload: r.qrPayload, amount: r.amount, status: "pending", expiresAt: r.expiresAt });
    } catch { /* api đã báo lỗi */ } finally { setBusy(false); }
  };
  if (!qr || stale || qr.status === "expired" || qr.status === "cancelled")
    return (
      <div className="stack" style={{ marginTop: 8 }} data-testid="pos-qr-start">
        {stale && <div className="hint">Số tiền đã đổi — cần tạo lại mã QR.</div>}
        {qr && !stale && <div className="hint err">Mã QR đã hết hạn.</div>}
        <Button variant="soft" block loading={busy} disabled={amount <= 0} onClick={create}>{qr ? "Tạo mã QR mới" : "Hiện mã VietQR"}</Button>
      </div>
    );
  if (qr.status === "paid" || qr.status === "used")
    return (
      <div className="qr-wait paid" role="status" data-testid="pos-qr-paid" style={{ marginTop: 8 }}>
        <b>Đã nhận {money(qr.amount)}</b>
        <span className="small muted">Mã {qr.code} · bấm “Hoàn tất” để lập đơn</span>
      </div>
    );
  return (
    <div className="qr-wait" style={{ marginTop: 8 }} data-testid="pos-qr-wait">
      <QrImage value={qr.payload} size={200} label={`Mã VietQR ${money(qr.amount)}`} />
      <b className="num" data-testid="pos-qr-code">{qr.code}</b>
      <span className="small muted">Khách quét mã và giữ nguyên nội dung · đang chờ tiền về…</span>
      <Button size="sm" variant="ghost" onClick={() => { void post(`/pos/qr-requests/${qr.id}/cancel`, {}, { silent: true }).catch(() => {}); onChange(undefined); }}>Huỷ mã</Button>
    </div>
  );
}
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
    <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
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

function CheckoutSheet({ total: localTotal, charges, payloadBase, customer, onClose, onDone, onQueued, noteValue, onNote }: { total: number; charges: Charge[]; payloadBase: () => any; customer: Cust | null; onClose: () => void; onDone: (o: any, change: number) => void; onQueued: () => void; noteValue: string; onNote: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ id: number; message: string } | null>(null);
  const [stockErr, setStockErr] = useState("");
  const [needReason, setNeedReason] = useState(false); // A-29: người tự duyệt phải ghi lý do
  const [overrideReason, setOverrideReason] = useState("");
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
  const chargesTotal = charges.reduce((s, c) => s + c.amount, 0);
  // B1: bán nợ khách lẻ — chỉ khi bật ở cài đặt, có khách lẻ (SĐT), có mạng (không kiểm được hạn mức khi offline)
  const cc = useAsync(() => get("/pos/credit-config", undefined, { silent: true }).catch(() => null), []);
  const online = navigator.onLine;
  const debts = useAsync(() => (cc.data?.enabled && customer && online ? get(`/pos/customers/${customer.id}/debts`, undefined, { silent: true }).catch(() => null) : Promise.resolve(null)), [customer?.id, !!cc.data?.enabled, online]);
  const creditCard = !!(cc.data?.enabled && customer && online && debts.data);
  const [credit, setCredit] = useState(0);
  const avail = debts.data?.available ?? 0;

  const sepay = useAsync(() => get("/pos/sepay-config", undefined, { silent: true }).catch(() => null), []);
  const sepayPos = !!(sepay.data?.enabled && sepay.data?.flow?.pos) && navigator.onLine;
  const [pays, setPays] = useState<Pay[]>([{ method: "cash", amount: total }]);
  const [active, setActive] = useState(0);
  const creditAmt = creditCard ? Math.min(credit, total) : 0;
  useEffect(() => { setPays((ps) => (ps.length === 1 ? [{ ...ps[0], amount: Math.max(0, total - creditAmt) }] : ps)); }, [total, creditAmt]);
  const paid = pays.reduce((s, p) => s + p.amount, 0);
  const cash = pays.filter((p) => p.method === "cash").reduce((s, p) => s + p.amount, 0);
  const need = total - creditAmt; // phần phải thu ngay
  const over = paid - need, remaining = need - paid;
  const change = over > 0 ? over : 0;
  const qrPending = sepayPos && pays.some((p) => p.amount > 0 && p.method === "qr" && !(p.qr && p.qr.status === "paid" && p.qr.amount === p.amount));
  const limit = debts.data?.customer?.creditLimit ?? 0;
  const creditOk = creditAmt === 0 || (limit > 0 && over === 0 && !!customer); // vượt hạn mức → máy chủ trả approval_required, quản lý duyệt
  const valid = paid >= need && (over === 0 || cash >= over) && pays.every((p) => p.amount > 0 || (creditAmt > 0 && p.amount === 0)) && !qrPending && creditOk;
  const setAmt = (i: number, n: number) => setPays((ps) => ps.map((p, j) => (j === i ? { ...p, amount: n } : p)));
  const quickBase = Math.max(0, total - creditAmt);
  const quick = Array.from(new Set([quickBase, ...[50000, 100000, 200000, 500000].map((s) => Math.ceil(quickBase / s) * s)])).filter((v) => v > 0 && v >= quickBase).slice(0, 4);
  const pointVal = loy.data?.pointValueVnd ?? 0;
  const maxByBalance = loy.data?.points ?? 0;

  const submit = async () => {
    setBusy(true); setStockErr(""); setPromoErr("");
    const soldAt = new Date().toISOString(); // A-09: thời điểm bán gốc (dùng khi đơn phải xếp hàng offline)
    const payload = { ...payloadBase(), ...(overrideReason.trim().length >= 3 ? { overrideReason: overrideReason.trim() } : {}), ...(voucherApplied ? { voucherCode: voucher } : {}), ...(redeem > 0 ? { redeemPoints: redeem } : {}), ...(approval ? { approvalId: approval.id } : {}), ...(noteValue ? { note: noteValue } : {}), payments: pays.filter((p) => p.amount > 0).map((p) => ({ method: p.method, amount: p.amount, ...(sepayPos && p.method === "qr" && p.qr ? { qrRequestId: p.qr.id } : {}) })), ...(creditAmt > 0 ? { credit: { amount: creditAmt } } : {}) };
    try {
      const order = await post("/pos/orders", payload, { silent: true });
      toast("Thanh toán thành công", "ok");
      onDone(order, order.change ?? change);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "network" && creditAmt > 0) toast("Mất mạng — đơn ghi nợ không lưu offline được (không kiểm được hạn mức). Thu đủ tiền hoặc thử lại khi có mạng.", "error");
        else if (e.code === "network") { await enqueue({ ...payload, soldAt }); onQueued(); }
        else if (e.code === "credit_limit_exceeded") { setPromoErr(e.message + (e.details?.available != null ? ` Còn được nợ ${money(e.details.available)}.` : "")); debts.reload(); }
        else if (e.code === "credit_disabled" || e.code === "credit_needs_customer" || e.code === "credit_mismatch") { setPromoErr(e.message); cc.reload(); }
        else if (e.code === "override_reason_required") { setNeedReason(true); toast("Cần nhập lý do trước khi tự duyệt đơn này", "error"); }
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
    <Sheet open onClose={onClose} title="Thanh toán" footer={<Button block size="lg" loading={busy} disabled={!valid} onClick={submit}>{approval ? "Thử lại" : creditAmt > 0 ? "Ghi nợ & hoàn tất" : "Hoàn tất"} · {money(total)}</Button>}>
      <div className="stack">
        <div className="totals">
          {((prev?.discount ?? 0) > 0 || chargesTotal > 0) && <div><span className="muted">Tiền hàng</span><span className="money">{money(localTotal - chargesTotal)}</span></div>}
          {promoOnly.map((d, i) => <div key={i} data-testid="pos-discount"><span>{d.description}</span><span className="money">-{money(d.amount)}</span></div>)}
          {voucherDiscount && <div data-testid="pos-discount"><span>{voucherDiscount.description || `Voucher ${voucher}`}</span><span className="money">-{money(voucherDiscount.amount)}</span></div>}
          {(prev?.pointsAmount ?? 0) > 0 && <div data-testid="pos-discount"><span>Đổi {prev!.pointsRedeemed} điểm</span><span className="money">-{money(prev!.pointsAmount)}</span></div>}
          {charges.map((ch) => <div key={ch.key} data-testid="pos-charge-row"><span>{ch.name}</span><span className="money">+{money(ch.amount)}</span></div>)}
          <div className="grand" style={(prev?.discount ?? 0) > 0 || chargesTotal > 0 ? undefined : { borderTop: 0, marginTop: 0 }}><span>Cần thanh toán</span><span className="money" data-testid="pos-total">{money(total)}</span></div>
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
                  <Button variant="soft" onClick={() => setRedeem(Math.min(maxByBalance, Math.floor((Math.max(0, localTotal - chargesTotal - (promoOnly.reduce((s, d) => s + d.amount, 0) + (voucherDiscount?.amount ?? 0))) * 0.5) / (pointVal || 1))))}>Tối đa</Button>
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
        {needReason && (
          <div className="banner" role="alert">
            <div className="small"><b>Đơn bán dưới giá vốn hoặc giảm giá vượt ngưỡng.</b> Bạn có quyền tự duyệt nhưng phải ghi lý do (lưu vào nhật ký).</div>
            <TextArea label="Lý do (bắt buộc)" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
          </div>
        )}
        {stockErr && <Banner tone="danger">{stockErr}. Hãy giảm số lượng hoặc bỏ mặt hàng.</Banner>}
        {creditCard && (
          <div className="card flat stack" style={{ padding: 12 }} data-testid="pos-credit">
            <div><b>Ghi nợ</b><div className="small muted">Hạn mức {debts.data.customer.creditLimit > 0 ? money(debts.data.customer.creditLimit) : "chưa đặt"} · còn được nợ {money(avail)}</div></div>
            <MoneyInput label="Ghi nợ (₫)" value={credit} onChange={(n) => setCredit(Math.max(0, Math.min(total, n)))} />
            <div className="chips">
              <button className="chip" data-testid="pos-credit-all" onClick={() => setCredit(total)}>Nợ toàn bộ</button>
              {paid < need && <button className="chip" onClick={() => setCredit(Math.max(0, total - paid))}>Nợ phần còn thiếu</button>}
              {credit > 0 && <button className="chip" onClick={() => setCredit(0)}>Bỏ ghi nợ</button>}
            </div>
            {debts.data.outstanding > 0 && <div className="small muted">Khách đang nợ {money(debts.data.outstanding)}.</div>}
            {credit > 0 && limit <= 0 && <div className="err small" role="alert">Khách chưa được đặt hạn mức nợ — nhờ quản lý đặt ở màn Khách lẻ.</div>}
            {credit > avail && limit > 0 && <div className="hint" role="alert">Vượt hạn mức nợ (còn được nợ {money(avail)}) — cần quản lý duyệt.</div>}
            {credit > (cc.data?.approvalVnd ?? Infinity) && !cc.data?.canOverride && <div className="hint">Ghi nợ trên {money(cc.data.approvalVnd)} cần quản lý duyệt.</div>}
          </div>
        )}
        {pays.map((p, i) => (
          <div key={i} className="card flat" style={{ padding: 12, outline: active === i ? "2px solid var(--accent)" : undefined }} onClick={() => setActive(i)}>
            <div className="row">
              <div className="chips pay-methods grow" role="radiogroup" aria-label="Hình thức thanh toán">
                {[["cash", "Tiền mặt"], ["transfer", "Chuyển khoản"], ["qr", "QR"], ["card", "Thẻ"]].map(([m, l]) => (
                  <button key={m} className="chip" role="radio" aria-checked={p.method === m} aria-pressed={p.method === m} onClick={() => setPays((ps) => ps.map((x, j) => (j === i ? { ...x, method: m } : x)))}>{l}</button>
                ))}
              </div>
              {pays.length > 1 && <Button size="sm" variant="ghost" aria-label="Bỏ dòng thanh toán" onClick={() => { setPays((ps) => ps.filter((_, j) => j !== i)); setActive(0); }}>✕</Button>}
            </div>
            <div style={{ marginTop: 8 }}><MoneyInput label={`Số tiền (${METHODS[p.method]})`} value={p.amount} onChange={(n) => setAmt(i, n)} /></div>
            {p.method === "qr" && sepayPos && <QrLine amount={p.amount} qr={p.qr} onChange={(q) => setPays((ps) => ps.map((x, j) => (j === i ? { ...x, qr: q } : x)))} />}
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
          {creditAmt > 0 && <div data-testid="pos-credit-row"><span className="muted">Ghi nợ</span><span className="money">{money(creditAmt)}</span></div>}
          <div><span className="muted">Đã nhận</span><span className="money">{money(paid)}</span></div>
          {remaining > 0 && <div style={{ color: "var(--danger)" }}><span>Còn thiếu</span><span className="money">{money(remaining)}</span></div>}
          {over > 0 && <div style={{ color: valid ? "var(--accent)" : "var(--danger)", fontWeight: 700 }}><span>Tiền thừa trả khách</span><span className="money">{money(over)}</span></div>}
          {over > 0 && cash < over && <div className="err">Chỉ tiền mặt mới được thừa.</div>}
          {qrPending && <div className="err" data-testid="pos-qr-needed">Chờ báo “Đã nhận tiền” của mã QR trước khi hoàn tất.</div>}
        </div>
        <TextArea label="Ghi chú đơn (không bắt buộc)" value={noteValue} onChange={(e) => onNote(e.target.value)} />
      </div>
    </Sheet>
  );
}
