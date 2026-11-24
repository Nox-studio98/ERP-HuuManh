import { useEffect, useMemo, useState } from "react";
import { ApiError, get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { METHODS, fmtDate, money, qtyText, todayVN, unitLabel } from "../../format";
import { useCan } from "../../store";
import { ProductPicker, Tile, useCatalog, type Prod } from "./shared";

export default function Bundles() {
  const can = useCan();
  const [tab, setTab] = useState<"basket" | "assemble" | "pre">("basket");
  return (
    <div className="stack d4">
      <div className="page-head"><h1 style={{ margin: 0 }}>Giỏ quà & đặt trước</h1></div>
      <Segmented value={tab} onChange={setTab} options={[{ v: "basket", label: "Thành phần" }, { v: "assemble", label: "Đóng giỏ" }, { v: "pre", label: "Đặt trước" }]} />
      {tab === "basket" && <Components canWrite={can("products.write")} />}
      {tab === "assemble" && <Assembly canWrite={can("inventory.write")} />}
      {tab === "pre" && <Preorders />}
    </div>
  );
}

type Cmp = { productId: number; qty: number };

/** Chọn mặt hàng giỏ quà: ưu tiên nhóm “Giỏ quà”, có thể chọn sản phẩm bất kỳ. */
function BasketSelect({ value, onChange }: { value: number; onChange: (id: number) => void }) {
  const cat = useCatalog();
  const gid = cat.groups.find((g) => /giỏ quà/i.test(g.name))?.id;
  const baskets = cat.products.filter((p) => p.groupId === gid);
  useEffect(() => { if (!value && baskets[0]) onChange(baskets[0].id); }, [baskets.length]); // eslint-disable-line
  return (
    <Select label="Giỏ quà" value={value || ""} onChange={(e) => onChange(Number(e.target.value))}>
      {(baskets.length ? baskets : cat.products).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
}

function Components({ canWrite }: { canWrite: boolean }) {
  const cat = useCatalog();
  const [pid, setPid] = useState(0);
  const [cmps, setCmps] = useState<Cmp[]>([]);
  const [dirty, setDirty] = useState(false);
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useAsync(async () => {
    if (!pid) return null;
    const r = await get(`/bundles/${pid}/components`, undefined, { silent: true });
    setCmps(r.components.map((c: any) => ({ productId: c.productId, qty: c.qty }))); setDirty(false);
    return r;
  }, [pid]);
  const cost = cmps.reduce((s, c) => s + Math.round((cat.byId.get(c.productId)?.avgCost ?? 0) * c.qty), 0);
  const basket = cat.byId.get(pid);
  const save = async () => {
    setBusy(true);
    try { await put(`/bundles/${pid}/components`, { components: cmps.map((c) => ({ productId: c.productId, qty: c.qty })) }); toast("Đã lưu thành phần giỏ quà", "ok"); setDirty(false); } catch {} finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <BasketSelect value={pid} onChange={setPid} />
      <Card title="Thành phần cho 1 giỏ" actions={canWrite && <Button size="sm" variant="soft" onClick={() => setPick(true)}>+ Thêm</Button>}>
        {load.loading ? <Spinner /> : cmps.length === 0 ? <EmptyState title="Chưa khai báo thành phần" hint="Thêm các loại trái cây/hàng đóng gói cấu thành giỏ quà." /> : (
          <div>
            {cmps.map((c, i) => {
              const p = cat.byId.get(c.productId);
              return (
                <div className="li" key={c.productId}>
                  <div className="t"><b>{p?.name ?? "SP #" + c.productId}</b><span className="small muted">Tồn {qtyText(p?.availableMilli, p?.baseUnit)} · vốn ~{money(p?.avgCost)}/{p ? unitLabel(p.baseUnit) : ""}</span></div>
                  {canWrite ? <input className="input num" style={{ width: 80 }} aria-label={`Số lượng ${p?.name}`} inputMode="decimal" value={c.qty} onChange={(e) => { setDirty(true); setCmps((x) => x.map((y, j) => (j === i ? { ...y, qty: Number(e.target.value.replace(",", ".")) || 0 } : y))); }} /> : <b>{c.qty}</b>}
                  <span className="muted">{p ? unitLabel(p.baseUnit) : ""}</span>
                  {canWrite && <Button size="sm" variant="ghost" aria-label={`Bỏ ${p?.name}`} onClick={() => { setDirty(true); setCmps((x) => x.filter((_, j) => j !== i)); }}>✕</Button>}
                </div>
              );
            })}
          </div>
        )}
        <div className="totals" style={{ marginTop: 8 }}>
          <div><span className="muted">Giá vốn thành phần / giỏ</span><span className="money">{money(cost)}</span></div>
          {basket?.price ? <div><span className="muted">Giá bán giỏ</span><span className="money">{money(basket.price)}</span></div> : null}
          {basket?.price && cost > 0 ? <div><span className="muted">Biên gộp ước tính (chưa tính bao bì)</span><span>{Math.round(((basket.price - cost) * 100) / basket.price)}%</span></div> : null}
        </div>
        {canWrite && <div style={{ marginTop: 12 }}><Button block loading={busy} disabled={!dirty || cmps.some((c) => c.qty <= 0)} onClick={save}>Lưu thành phần</Button></div>}
        {!canWrite && <div className="hint">Cần quyền sửa hàng hoá để đổi thành phần.</div>}
      </Card>
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={(p) => { if (p.id !== pid && !cmps.some((c) => c.productId === p.id)) { setCmps((x) => [...x, { productId: p.id, qty: 1 }]); setDirty(true); } }} />
    </div>
  );
}

function Assembly({ canWrite }: { canWrite: boolean }) {
  const cat = useCatalog();
  const [pid, setPid] = useState(0);
  const [qty, setQty] = useState(1);
  const [extra, setExtra] = useState(0);
  const [exp, setExp] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState("");
  const comp = useAsync(() => (pid ? get(`/bundles/${pid}/components`, undefined, { silent: true }).then((r) => r.components as any[]) : Promise.resolve([])), [pid, done]);
  const recent = useAsync(() => get("/assembly-orders").then((r) => items<any>(r)), [done]);
  const need = (comp.data ?? []).map((c) => {
    const p = cat.byId.get(c.productId);
    const needMilli = Math.round(c.qtyMilli * qty);
    return { ...c, p, needMilli, have: p?.availableMilli ?? 0, short: needMilli - (p?.availableMilli ?? 0) };
  });
  const short = need.filter((n) => n.short > 0);
  const compCost = need.reduce((s, n) => s + Math.round(((n.p?.avgCost ?? 0) * n.needMilli) / 1000), 0);
  const unitCost = qty > 0 ? Math.round((compCost + extra) / qty) : 0;
  const run = async () => {
    setBusy(true); setErr("");
    try {
      const r = await post("/assembly-orders", { bundleProductId: pid, qty, unit: cat.byId.get(pid)?.baseUnit ?? "trai", extraCost: extra, ...(exp ? { expiresAt: new Date(exp + "T23:59:59+07:00").toISOString() } : {}) }, { silent: true });
      setDone(r); toast(`Đã đóng ${qty} giỏ — ${r.code}`, "ok"); cat.reload();
    } catch (e) { if (e instanceof ApiError) setErr(e.code === "insufficient_stock" ? "Không đủ tồn thành phần để đóng giỏ." : e.message); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <BasketSelect value={pid} onChange={(v) => { setPid(v); setDone(null); }} />
      <Card title="Lệnh đóng giỏ">
        <div className="stack">
          <div className="grid2"><Input label="Số giỏ cần đóng" type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))} /><MoneyInput label="Chi phí đóng gói thêm (₫)" value={extra} onChange={setExtra} /></div>
          <Input label="Hạn dùng giỏ (bỏ trống = theo thành phần hết hạn sớm nhất)" type="date" value={exp} min={todayVN()} onChange={(e) => setExp(e.target.value)} />
          {comp.loading ? <Spinner /> : need.length === 0 ? <Banner>Giỏ này chưa có thành phần — khai báo ở tab “Thành phần”.</Banner> : (
            <div className="scrollx"><table className="tbl">
              <thead><tr><th>Thành phần</th><th className="r">Cần</th><th className="r">Tồn</th><th /></tr></thead>
              <tbody>{need.map((n) => (
                <tr key={n.productId}><td>{n.name}</td><td className="r">{qtyText(n.needMilli, n.baseUnit)}</td><td className="r">{qtyText(n.have, n.baseUnit)}</td>
                  <td>{n.short > 0 ? <Badge tone="danger">Thiếu {qtyText(n.short, n.baseUnit)}</Badge> : <Badge tone="ok">Đủ</Badge>}</td></tr>))}</tbody>
            </table></div>
          )}
          <div className="tiles"><Tile label="Giá vốn thành phần" value={money(compCost)} /><Tile label="Giá vốn / giỏ" value={money(unitCost)} sub={extra ? `gồm ${money(extra)} đóng gói` : undefined} /></div>
          {short.length > 0 && <Banner tone="danger">Không đủ tồn: {short.map((s) => s.name).join(", ")}. Hãy nhập thêm hàng hoặc giảm số giỏ.</Banner>}
          {err && <div className="err" role="alert">{err}</div>}
          <Button size="lg" loading={busy} disabled={!canWrite || !pid || need.length === 0 || short.length > 0} onClick={run}>Đóng {qty} giỏ</Button>
          {!canWrite && <div className="hint">Cần quyền ghi kho để đóng giỏ.</div>}
        </div>
      </Card>
      {done && (
        <Banner tone="info">Đã đóng giỏ <b>{done.code}</b>: {qtyText(done.qtyMilli)} × {done.productName}, giá vốn {money(done.unitCost)}/giỏ{done.expiresAt ? `, hạn ${fmtDate(done.expiresAt)}` : ""}. Tồn giỏ quà đã tăng.</Banner>
      )}
      <Card title="Lệnh đóng giỏ gần đây">
        {recent.loading ? <Spinner /> : <DataTable rows={recent.data ?? []} rowKey={(a) => a.id} empty="Chưa có lệnh đóng giỏ" cols={[
          { key: "c", label: "Mã", title: true, render: (a) => <b>{a.code}</b> },
          { key: "p", label: "Giỏ", render: (a) => a.productName },
          { key: "q", label: "Số lượng", right: true, render: (a) => qtyText(a.qtyMilli) },
          { key: "s", label: "Trạng thái", render: (a) => <Badge tone={a.status === "posted" ? "ok" : "danger"}>{a.status === "posted" ? "Đã ghi sổ" : "Không ghi được"}</Badge> },
        ]} />}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- đặt trước
const PRE_STATUS: Record<string, { l: string; t?: "ok" | "warn" | "danger" }> = { confirmed: { l: "Chờ giao", t: "warn" }, completed: { l: "Đã giao", t: "ok" }, cancelled: { l: "Đã huỷ", t: "danger" } };
const DEP: Record<string, string> = { held: "Đang giữ cọc", applied: "Đã trừ vào đơn", refunded: "Đã hoàn cọc", forfeited: "Mất cọc" };

function Preorders() {
  const [st, setSt] = useState("confirmed");
  const list = useAsync(() => get("/pos/preorders", { status: st }).then((r) => items<any>(r)), [st]);
  const [create, setCreate] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="chips" role="group" aria-label="Trạng thái">{[["confirmed", "Chờ giao"], ["completed", "Đã giao"], ["cancelled", "Đã huỷ"]].map(([v, l]) => <button key={v} className="chip" aria-pressed={st === v} onClick={() => setSt(v)}>{l}</button>)}</div>
        <Button onClick={() => setCreate(true)}>+ Đơn đặt trước</Button>
      </div>
      {list.loading ? <Spinner /> : <DataTable rows={list.data ?? []} rowKey={(o) => o.id} onRowClick={(o) => setOpen(o.id)} empty="Chưa có đơn đặt trước" cols={[
        { key: "c", label: "Đơn", title: true, render: (o) => <span><b>{o.code}</b><div className="small muted">{o.customerName ?? "Khách lẻ"}</div></span> },
        { key: "d", label: "Ngày lấy", render: (o) => fmtDate(o.pickupDate) },
        { key: "t", label: "Tổng", right: true, render: (o) => money(o.total) },
        { key: "dp", label: "Tiền cọc", right: true, render: (o) => (o.depositAmount != null ? `${money(o.depositAmount)} · ${DEP[o.depositStatus] ?? o.depositStatus}` : "—") },
        { key: "s", label: "Trạng thái", render: (o) => <Badge tone={PRE_STATUS[o.status]?.t}>{PRE_STATUS[o.status]?.l ?? o.status}</Badge> },
      ]} />}
      {create && <PreorderForm onClose={() => setCreate(false)} onSaved={(id) => { setCreate(false); setSt("confirmed"); list.reload(); setOpen(id); }} />}
      {open != null && <PreorderDetail id={open} onClose={() => setOpen(null)} onChanged={() => list.reload()} />}
    </div>
  );
}

function PreorderForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: number) => void }) {
  const [cust, setCust] = useState({ name: "", phone: "" });
  const [date, setDate] = useState(todayVN(1));
  const [lines, setLines] = useState<{ p: Prod; qty: number }[]>([]);
  const [pick, setPick] = useState(false);
  const [dep, setDep] = useState({ amount: 0, method: "cash" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const total = useMemo(() => lines.reduce((s, l) => s + Math.round((l.p.price ?? 0) * l.qty), 0), [lines]);
  useEffect(() => { if (total > 0 && dep.amount === 0) setDep((d) => ({ ...d, amount: Math.ceil((total * 0.3) / 1000) * 1000 })); }, [total]); // eslint-disable-line
  const ok = cust.name.trim() && cust.phone.trim().length >= 8 && lines.length > 0 && lines.every((l) => l.qty > 0) && dep.amount > 0;
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const r = await post("/pos/preorders", { customer: { name: cust.name.trim(), phone: cust.phone.trim() }, pickupDate: date, lines: lines.map((l) => ({ productId: l.p.id, unit: l.p.baseUnit, qty: l.qty })), deposit: dep, ...(note ? { note } : {}) }, { silent: true });
      toast(`Đã tạo đơn đặt trước ${r.code}`, "ok"); onSaved(r.id);
    } catch (e) {
      if (e instanceof ApiError) setErr(e.code === "no_open_shift" ? "Chưa mở ca bán hàng — vào màn Bán hàng để mở ca trước." : e.code === "deposit_too_low" ? `Tiền cọc thấp hơn mức tối thiểu (${money(e.details?.minDeposit)}).` : e.message);
    } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Đơn đặt trước" footer={<div className="stack" style={{ width: "100%" }}>{err && <div className="err" role="alert">{err}</div>}<Button block size="lg" loading={busy} disabled={!ok} onClick={save}>Nhận cọc {money(dep.amount)} & tạo đơn</Button></div>}>
      <div className="stack">
        <div className="grid2"><Input label="Tên khách" value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} /><Input label="Số điện thoại" inputMode="tel" value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} /></div>
        <Input label="Ngày hẹn lấy" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="stack" style={{ gap: 0 }}>
          <b>Hàng đặt</b>
          {lines.map((l, i) => (
            <div className="li" key={l.p.id}>
              <div className="t"><b>{l.p.name}</b><span className="small muted">{money(l.p.price)}/{unitLabel(l.p.baseUnit)}</span></div>
              <input className="input num" style={{ width: 72 }} aria-label={`Số lượng ${l.p.name}`} inputMode="decimal" value={l.qty} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, qty: Number(e.target.value.replace(",", ".")) || 0 } : y)))} />
              <Button size="sm" variant="ghost" aria-label="Bỏ" onClick={() => setLines((x) => x.filter((_, j) => j !== i))}>✕</Button>
            </div>
          ))}
          <div style={{ marginTop: 8 }}><Button size="sm" variant="soft" onClick={() => setPick(true)}>+ Thêm hàng</Button></div>
        </div>
        <div className="totals"><div className="grand"><span>Tạm tính</span><span className="money">{money(total)}</span></div></div>
        <MoneyInput label="Tiền cọc (₫)" value={dep.amount} onChange={(n) => setDep({ ...dep, amount: n })} hint="Mức cọc tối thiểu theo cài đặt cửa hàng; cọc không vượt giá trị đơn." />
        <Select label="Hình thức nhận cọc" value={dep.method} onChange={(e) => setDep({ ...dep, method: e.target.value })}>{["cash", "transfer", "qr", "card"].map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}</Select>
        <TextArea label="Ghi chú (lời chúc, thiệp…)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={(p) => setLines((x) => (x.some((y) => y.p.id === p.id) ? x : [...x, { p, qty: 1 }]))} />
    </Sheet>
  );
}

function PreorderDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const d = useAsync(() => get(`/pos/preorders/${id}`), [id]);
  const [mode, setMode] = useState<"" | "fulfill" | "cancel">("");
  const [method, setMethod] = useState("cash");
  const [paid, setPaid] = useState(0);
  const [refund, setRefund] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const o = d.data;
  useEffect(() => { if (o) setPaid(o.remaining); }, [o?.remaining]); // eslint-disable-line
  const fulfill = async () => {
    setBusy(true); setMsg("");
    try { const r = await post(`/pos/preorders/${id}/fulfill`, { payments: o.remaining > 0 ? [{ method, amount: paid }] : [] }, { silent: true }); toast(r.change ? `Đã giao hàng — thối lại ${money(r.change)}` : "Đã giao hàng, hoàn tất đơn", "ok"); setMode(""); d.reload(); onChanged(); }
    catch (e) { if (e instanceof ApiError) setMsg(e.code === "no_open_shift" ? "Chưa mở ca bán hàng — vào màn Bán hàng để mở ca." : e.code === "insufficient_stock" ? "Không đủ tồn để giao đơn này." : e.message); } finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true); setMsg("");
    try { await post(`/pos/preorders/${id}/cancel`, { refundDeposit: refund, reason: reason.trim() }, { silent: true }); toast(refund ? "Đã huỷ đơn và hoàn cọc" : "Đã huỷ đơn, cọc không hoàn", "ok"); setMode(""); d.reload(); onChanged(); }
    catch (e) { if (e instanceof ApiError) setMsg(e.code === "approval_required" ? `Không hoàn cọc cần quản lý duyệt. Đã gửi yêu cầu duyệt #${e.details?.approvalId ?? "?"} — khi được duyệt, đơn sẽ tự huỷ và ghi nhận mất cọc.` : e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={o ? `Đặt trước ${o.code}` : "Đặt trước"} footer={o?.status === "confirmed" && !mode ? (
      <div className="row" style={{ width: "100%" }}><Button variant="ghost" className="grow" onClick={() => setMode("cancel")}>Huỷ đơn</Button><Button className="grow" onClick={() => setMode("fulfill")}>Giao hàng</Button></div>) : undefined}>
      {d.loading || !o ? <Spinner /> : (
        <div className="stack">
          <div className="row"><Badge tone={PRE_STATUS[o.status]?.t}>{PRE_STATUS[o.status]?.l ?? o.status}</Badge><span className="muted">Lấy ngày {fmtDate(o.pickupDate)}</span></div>
          <div className="muted">{o.customer?.name ?? "Khách lẻ"}</div>
          <div>{o.lines.map((l: any) => <div className="li" key={l.id}><div className="t"><b>{l.productName}</b><span className="small muted">{qtyText(l.qtyMilli, l.unit)} × {money(l.unitPrice)}</span></div><b className="num">{money(l.lineTotal)}</b></div>)}</div>
          <div className="totals">
            <div><span className="muted">Tổng đơn</span><span className="money">{money(o.total)}</span></div>
            {o.deposit && <div><span className="muted">Tiền cọc ({METHODS[o.deposit.method] ?? o.deposit.method})</span><span className="money">{money(o.deposit.amount)}</span></div>}
            {o.deposit && <div><span className="muted">Trạng thái cọc</span><Badge tone={o.deposit.status === "held" ? "warn" : o.deposit.status === "forfeited" ? "danger" : "ok"}>{DEP[o.deposit.status] ?? o.deposit.status}</Badge></div>}
            {o.status === "confirmed" && <div className="grand"><span>Còn phải thu khi giao</span><span className="money">{money(o.remaining)}</span></div>}
          </div>
          {o.status === "confirmed" && <div className="small muted">{o.reservedMilli > 0 ? "Đã giữ tồn cho đơn này." : "Chưa giữ được tồn (hàng chưa về) — sẽ lấy FEFO khi giao."}</div>}
          {mode === "fulfill" && (
            <Card title="Giao hàng & thu phần còn lại">
              <div className="stack">
                {o.remaining > 0 ? <>
                  <Select label="Hình thức thanh toán" value={method} onChange={(e) => setMethod(e.target.value)}>{["cash", "transfer", "qr", "card"].map((m) => <option key={m} value={m}>{METHODS[m]}</option>)}</Select>
                  <MoneyInput label="Khách đưa (₫)" value={paid} onChange={setPaid} />
                </> : <div className="muted">Cọc đã đủ — không thu thêm.</div>}
                {msg && <div className="err" role="alert">{msg}</div>}
                <div className="row"><Button variant="ghost" className="grow" onClick={() => setMode("")}>Quay lại</Button><Button className="grow" loading={busy} disabled={o.remaining > 0 && paid < o.remaining} onClick={fulfill}>Xác nhận giao</Button></div>
              </div>
            </Card>
          )}
          {mode === "cancel" && (
            <Card title="Huỷ đơn đặt trước">
              <div className="stack">
                <div className="chips" role="radiogroup" aria-label="Xử lý tiền cọc"><button className="chip" role="radio" aria-checked={refund} aria-pressed={refund} onClick={() => setRefund(true)}>Hoàn cọc</button><button className="chip" role="radio" aria-checked={!refund} aria-pressed={!refund} onClick={() => setRefund(false)}>Không hoàn (mất cọc)</button></div>
                {!refund && <div className="hint">Không hoàn cọc cần quản lý duyệt; cọc được ghi nhận là thu khác.</div>}
                <TextArea label="Lý do huỷ" value={reason} onChange={(e) => setReason(e.target.value)} />
                {msg && <Banner>{msg}</Banner>}
                <div className="row"><Button variant="ghost" className="grow" onClick={() => setMode("")}>Quay lại</Button><Button variant="danger" className="grow" loading={busy} disabled={reason.trim().length < 3} onClick={cancel}>Xác nhận huỷ</Button></div>
              </div>
            </Card>
          )}
        </div>
      )}
    </Sheet>
  );
}
