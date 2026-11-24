import { useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { Scanner } from "../components/Scanner";
import { toast } from "../components/toast";
import { DOC_STATUS, DOC_TYPES, fmtDate, fmtDateTime, money, qtyText, todayVN, unitLabel, withShown } from "../format";
import { useUnitMap } from "../units";
import { useCan } from "../store";
import type { Product } from "./Pos";

const REASONS = [["dap", "Dập"], ["heo", "Héo"], ["het_han", "Hết hạn"], ["hao_can", "Hao cân"], ["khac", "Khác"]];
const docTone = (s: string) => (s === "posted" ? "ok" : s === "pending_approval" ? "warn" : s === "cancelled" ? "danger" : "info") as any;
const remain = (l: any) => l.qtyOnHandMilli ?? l.onHandMilli ?? l.remainingMilli ?? l.availableMilli;
const pname = (x: any) => x.productName ?? x.name ?? `#${x.productId}`;

export default function Inventory() {
  const can = useCan();
  const [tab, setTab] = useState<"alerts" | "docs" | "trace">("alerts");
  const [editor, setEditor] = useState<{ type?: string; id?: number } | null>(null);
  const [rev, setRev] = useState(0);
  return (
    <div className="stack">
      <div className="row wrap">
        <div className="grow" style={{ minWidth: 260 }}><Segmented value={tab} onChange={setTab} options={[{ v: "alerts", label: "Cảnh báo" }, { v: "docs", label: "Chứng từ" }, { v: "trace", label: "Truy vết lô" }]} /></div>
      </div>
      {can("inventory.write") && (
        <div className="row wrap">
          <Button onClick={() => setEditor({ type: "receipt" })}>+ Nhập hàng</Button>
          <Button variant="soft" onClick={() => setEditor({ type: "waste" })}>Huỷ hàng</Button>
          <Button variant="soft" onClick={() => setEditor({ type: "count" })}>Kiểm kê</Button>
          <Button variant="soft" onClick={() => setEditor({ type: "transfer" })}>Chuyển kho</Button>
        </div>
      )}
      {tab === "alerts" && <Alerts key={rev} />}
      {tab === "docs" && <Docs key={rev} onOpen={(id) => setEditor({ id })} />}
      {tab === "trace" && <Trace />}
      {editor && <DocEditor {...editor} onClose={() => { setEditor(null); setRev((r) => r + 1); }} />}
    </div>
  );
}

function Alerts() {
  const a = useAsync(() => get("/stock/alerts"), []);
  const notes = useAsync(() => get("/notifications", { unread: 1 }).catch(() => ({ items: [] })), []);
  const pmap = useUnitMap();
  const bu = (x: any) => pmap?.get(x.productId ?? x.id)?.baseUnit ?? x.baseUnit;
  if (a.loading) return <Spinner />;
  const d = a.data ?? {};
  const low = d.lowStock ?? [], soon = d.expiringSoon ?? [], exp = d.expired ?? [], quar = d.quarantined ?? [];
  return (
    <div className="stack">
      {(notes.data?.items ?? []).map((n: any) => (
        <div key={n.id} className="banner danger" role="alert">
          <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}>
            <div><b>{n.title}</b><div className="small">{n.body}</div></div>
            <Button size="sm" variant="soft" onClick={async () => { try { await post(`/notifications/${n.id}/read`, {}); notes.reload(); } catch {} }}>Đã xem</Button>
          </div>
        </div>
      ))}
      <div className="kpis">
        <div className="kpi"><div className="l">Sắp hết hàng</div><div className="v" style={{ color: low.length ? "var(--warn)" : undefined }}>{low.length}</div></div>
        <div className="kpi"><div className="l">Sắp hết hạn (≤2 ngày)</div><div className="v" style={{ color: soon.length ? "var(--warn)" : undefined }}>{soon.length}</div></div>
        <div className="kpi"><div className="l">Đã hết hạn</div><div className="v" style={{ color: exp.length ? "var(--danger)" : undefined }}>{exp.length}</div></div>
      </div>
      {exp.length > 0 && <Banner tone="danger">Có {exp.length} lô đã hết hạn — chỉ được xuất bằng phiếu huỷ hàng.</Banner>}
      <Card title="Tồn thấp"><DataTable rows={low} rowKey={(x: any) => x.productId ?? x.id} empty="Không có mặt hàng dưới mức tồn tối thiểu" cols={[
        { key: "n", label: "Hàng", title: true, render: (x: any) => pname(x) },
        { key: "a", label: "Tồn", right: true, render: (x: any) => qtyText(x.onHandMilli, bu(x)) },
        { key: "m", label: "Tối thiểu", right: true, render: (x: any) => qtyText(x.minStockMilli, bu(x)) },
      ]} /></Card>
      <div className="grid3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", alignItems: "start" }}>
        {[["Sắp hết hạn", soon, "warn"], ["Đã hết hạn", exp, "danger"], ["Đang cách ly (lô hỏng)", quar, "danger"]].map(([t, rows, tn]: any) => (
          <Card key={t} title={t}><DataTable rows={rows} rowKey={(x: any) => x.id} empty="Không có lô nào" cols={[
            { key: "n", label: "Hàng", title: true, render: (x: any) => pname(x) },
            { key: "l", label: "Lô", render: (x: any) => <span className="num">{x.lotCode}</span> },
            { key: "e", label: t === "Đang cách ly (lô hỏng)" ? "Lý do" : "HSD", render: (x: any) => (t === "Đang cách ly (lô hỏng)" ? <Badge tone={tn}>{x.quarantineReason ?? "Cách ly"}</Badge> : <Badge tone={tn}>{fmtDate(x.expiresAt)}</Badge>) },
            { key: "q", label: "Còn", right: true, render: (x: any) => qtyText(remain(x), bu(x)) },
          ]} /></Card>
        ))}
      </div>
    </div>
  );
}

function Docs({ onOpen }: { onOpen: (id: number) => void }) {
  const [type, setType] = useState(""), [status, setStatus] = useState("");
  const d = useAsync(() => get("/stock-docs", { type, status }).then((r) => items<any>(r)), [type, status]);
  return (
    <div className="stack">
      <div className="grid2">
        <Select label="Loại" value={type} onChange={(e) => setType(e.target.value)}><option value="">Tất cả</option>{Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select label="Trạng thái" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Tất cả</option>{Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
      </div>
      {d.loading ? <Spinner /> : <DataTable rows={d.data ?? []} rowKey={(x) => x.id} onRowClick={(x) => onOpen(x.id)} empty="Chưa có chứng từ" cols={[
        { key: "c", label: "Mã", title: true, render: (x) => <b>{x.code}</b> },
        { key: "t", label: "Loại", render: (x) => DOC_TYPES[x.type] ?? x.type },
        { key: "s", label: "Trạng thái", render: (x) => <Badge tone={docTone(x.status)}>{DOC_STATUS[x.status] ?? x.status}</Badge> },
        { key: "d", label: "Ngày", render: (x) => fmtDateTime(x.createdAt) },
        { key: "a", label: "Giá trị", right: true, render: (x) => money(x.totalAmount) },
      ]} />}
    </div>
  );
}

function ProductPick({ onPick }: { onPick: (p: Product, lot?: any, unit?: string) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const r = useAsync(() => (dq.length < 1 ? Promise.resolve([] as Product[]) : get("/products", { q: dq, limit: 8 }).then((x) => items<Product>(x))), [dq]);
  const [scan, setScan] = useState(false);
  const onCode = async (code: string) => {
    try { const x = await get("/products/lookup", { code }); setScan(false); onPick(x.product, x.lot, x.unit?.unit); } catch {}
  };
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="grow"><Input label="Tìm hàng hoá" type="search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Button variant="soft" onClick={() => setScan((s) => !s)}>Quét mã</Button>
      </div>
      {scan && <Scanner onCode={onCode} />}
      {(r.data ?? []).map((p) => <button key={p.id} className="dt-card" onClick={() => onPick(p)}><b>{p.name}</b> <span className="muted small">· {p.sku}</span></button>)}
    </div>
  );
}

function LotPick({ onPick }: { onPick: (lot: any, p: Product) => void }) {
  const [prod, setProd] = useState<Product | null>(null);
  const lots = useAsync(() => (prod ? get("/stock/lots", { productId: prod.id }).then((x) => items<any>(x)) : Promise.resolve([])), [prod?.id]);
  if (!prod) return <ProductPick onPick={async (p, lot) => { if (lot) onPick(lot, p); else setProd(p); }} />;
  return (
    <div className="stack">
      <div className="row between"><b>{prod.name}</b><Button size="sm" variant="ghost" onClick={() => setProd(null)}>Đổi hàng</Button></div>
      {lots.loading ? <Spinner /> : !(lots.data ?? []).length ? <EmptyState title="Không còn lô tồn" /> : (lots.data ?? []).map((l) => (
        <button key={l.id} className="dt-card" onClick={() => onPick(l, prod)}>
          <div className="row between"><b className="num">{l.lotCode}</b><span className="num">{qtyText(remain(l), prod.baseUnit)}</span></div>
          <div className="small muted">HSD {fmtDate(l.expiresAt)} {l.status === "expired" && <Badge tone="danger">Hết hạn</Badge>}</div>
        </button>
      ))}
    </div>
  );
}

function DocEditor({ type: t0, id: id0, onClose }: { type?: string; id?: number; onClose: () => void }) {
  const [id, setId] = useState<number | undefined>(id0);
  const doc = useAsync(() => (id ? get(`/stock-docs/${id}`) : Promise.resolve(null)), [id]);
  const pmap = useUnitMap();
  const type = doc.data?.type ?? t0 ?? "receipt";
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const can = useCan();
  const d = doc.data && pmap ? withShown(doc.data, pmap) : doc.data;
  const editable = !d || d.status === "draft";
  const lines: any[] = d?.lines ?? [];

  const act = async (what: "post" | "cancel") => {
    setBusy(true);
    try {
      const r = await post(`/stock-docs/${id}/${what}`, {});
      if (r?.warnings?.length) toast(`Có ${r.warnings.length} lô biến động tồn giữa lúc đếm và lúc ghi sổ — chênh lệch đã tính theo tồn lúc đếm, hãy kiểm tra lại`, "info");
      toast(what === "cancel" ? "Đã huỷ phiếu" : r?.status === "pending_approval" || r?.doc?.status === "pending_approval" ? "Đã gửi quản lý duyệt" : "Đã ghi sổ", "ok");
      if (what === "post" && r?.status !== "pending_approval") onClose(); else doc.reload();
    } catch {} finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} wide title={`${DOC_TYPES[type] ?? type}${d ? " · " + d.code : ""}`}
      footer={d && editable ? <><Button variant="ghost" onClick={() => act("cancel")} disabled={busy}>Huỷ phiếu</Button><Button className="grow" loading={busy} disabled={!lines.length} onClick={() => act("post")}>Ghi sổ</Button></> : undefined}>
      {receiving && d && <ReceiveSheet doc={d} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); doc.reload(); }} />}
      {!id ? <CreateDoc type={type} onCreated={setId} /> : !d ? <Spinner /> : (
        <div className="stack">
          <div className="row wrap"><Badge tone={docTone(d.status)}>{DOC_STATUS[d.status] ?? d.status}</Badge>{d.supplierRef && <span className="muted small">Số CT NCC: {d.supplierRef}</span>}{d.reason && <span className="muted small">{d.reason}</span>}</div>
          {d.status === "pending_approval" && <Banner>Phiếu đang chờ quản lý duyệt.</Banner>}
          {type === "count" && d.lockLots && d.status !== "posted" && d.status !== "cancelled" && <Banner>Đang khoá lô tại vị trí này: không bán / xuất hao hụt cho tới khi ghi sổ hoặc huỷ phiếu kiểm kê.</Banner>}
          {type === "transfer" && d.transferStatus === "in_transit" && (
            <Banner>Hàng đang đi đường — chưa bán được ở nguồn lẫn đích. {can("inventory.write") && <Button size="sm" onClick={() => setReceiving(true)}>Nhận hàng</Button>}</Banner>
          )}
          {type === "transfer" && d.transferStatus === "received" && <Banner tone="info">Đã nhận hàng lúc {fmtDateTime(d.receivedAt)}.</Banner>}
          <DataTable rows={lines} rowKey={(l) => l.id} empty="Chưa có dòng nào" cols={[
            { key: "n", label: "Hàng / lô", title: true, render: (l) => <>{pname(l)}{l.lotCode ? ` · ${l.lotCode}` : ""}</> },
            { key: "dq", label: type === "count" ? "Hệ thống lúc đếm" : "Theo CT", right: true, render: (l) => (l.docQtyShown != null ? qtyText(l.docQtyShown, l.unit) : "—") },
            { key: "q", label: type === "count" ? "Đếm" : "Thực tế", right: true, render: (l) => <b>{qtyText(l.qtyShown ?? l.qtyMilli, l.unit)}</b> },
            { key: "c", label: "Giá vốn/đv chính", right: true, hideMobile: type !== "receipt", render: (l) => (l.unitCost != null ? money(l.unitCost) : "—") },
            { key: "e", label: type === "waste" ? "Lý do" : "HSD", render: (l) => (type === "waste" ? REASONS.find((r) => r[0] === l.reason)?.[1] ?? l.reason ?? "—" : fmtDate(l.expiresAt)) },
            ...(editable ? [{ key: "x", label: "", render: (l: any) => <Button size="sm" variant="ghost" aria-label="Xoá dòng" onClick={async () => { try { await api_del(id, l.id); doc.reload(); } catch {} }}>✕</Button> }] : []),
          ]} />
          {editable && (adding ? <LineForm type={type} docId={id} onDone={() => { setAdding(false); doc.reload(); }} onCancel={() => setAdding(false)} /> : <Button variant="soft" onClick={() => setAdding(true)}>+ Thêm dòng (quét / tìm)</Button>)}
        </div>
      )}
    </Sheet>
  );
}
async function api_del(docId: number, lineId: number) {
  const { api } = await import("../api");
  return api(`/stock-docs/${docId}/lines/${lineId}`, { method: "DELETE" });
}

function CreateDoc({ type, onCreated }: { type: string; onCreated: (id: number) => void }) {
  const locs = useAsync(() => get("/locations").then((x) => items<any>(x)), []);
  const sups = useAsync(() => (type === "receipt" ? get("/suppliers").then((x) => items<any>(x)) : Promise.resolve([])), [type]);
  const [toLoc, setToLoc] = useState(""), [lock, setLock] = useState(false);
  const [loc, setLoc] = useState(""), [sup, setSup] = useState(""), [ref, setRef] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const locationId = loc || String(locs.data?.[0]?.id ?? "");
  return (
    <div className="stack">
      <Select label="Vị trí kho" value={locationId} onChange={(e) => setLoc(e.target.value)}>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
      {type === "transfer" && <Select label="Vị trí đích" value={toLoc} onChange={(e) => setToLoc(e.target.value)}><option value="">— Chọn —</option>{(locs.data ?? []).filter((l) => String(l.id) !== locationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
      {type === "count" && <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={lock} onChange={(e) => setLock(e.target.checked)} /> Khoá lô trong lúc kiểm kê (không bán / xuất)</label>}
      {type === "receipt" && <>
        <Select label="Nhà cung cấp" value={sup} onChange={(e) => setSup(e.target.value)}><option value="">— Chọn —</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Input label="Số chứng từ NCC" value={ref} onChange={(e) => setRef(e.target.value)} />
      </>}
      <TextArea label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="lg" loading={busy} disabled={!locationId || (type === "receipt" && !sup) || (type === "transfer" && !toLoc)} onClick={async () => {
        setBusy(true);
        try { const r = await post("/stock-docs", { type, locationId: Number(locationId), ...(sup ? { supplierId: Number(sup) } : {}), ...(ref ? { supplierRef: ref } : {}), ...(note ? { note } : {}), ...(type === "transfer" ? { toLocationId: Number(toLoc) } : {}), ...(type === "count" && lock ? { lockLots: true } : {}) }); onCreated(r.id ?? r.doc?.id); } catch {} finally { setBusy(false); }
      }}>Tạo phiếu nháp</Button>
    </div>
  );
}

function LineForm({ type, docId, onDone, onCancel }: { type: string; docId: number; onDone: () => void; onCancel: () => void }) {
  const [prod, setProd] = useState<Product | null>(null);
  const [lot, setLot] = useState<any>(null);
  const [unit, setUnit] = useState("");
  const [qty, setQty] = useState<number | "">(""), [docQty, setDocQty] = useState<number | "">(""), [cost, setCost] = useState(0), [exp, setExp] = useState(""), [reason, setReason] = useState("dap");
  const [busy, setBusy] = useState(false);
  const picked = type === "receipt" ? prod : lot && prod;
  const u = unit || prod?.baseUnit || "kg";
  const unitOpts = prod ? [prod.baseUnit, ...(prod.units ?? []).map((x) => x.unit).filter((x) => x !== prod.baseUnit)] : [];
  const n = typeof qty === "number" ? qty : 0;
  const submit = async () => {
    setBusy(true);
    try {
      const body = type === "receipt" ? { productId: prod!.id, unit: u, qty: n, ...(typeof docQty === "number" ? { docQty } : {}), unitCost: cost, ...(exp ? { expiresAt: exp } : {}) }
        : type === "count" ? { lotId: lot.id, countedQty: n, unit: u }
        : type === "transfer" ? { lotId: lot.id, qty: n, unit: u }
        : { lotId: lot.id, qty: n, unit: u, reason };
      await post(`/stock-docs/${docId}/lines`, body); toast("Đã thêm dòng", "ok"); onDone();
    } catch (e) { if (e instanceof ApiError) { /* toast đã hiện */ } } finally { setBusy(false); }
  };
  return (
    <Card className="flat" title={type === "receipt" ? "Thêm hàng nhập" : type === "count" ? "Đếm lô" : type === "transfer" ? "Chuyển theo lô" : "Huỷ theo lô"}>
      <div className="stack">
        {!picked ? (type === "receipt" ? <ProductPick onPick={(p, _l, un) => { setProd(p); setUnit(un ?? ""); }} /> : <LotPick onPick={(l, p) => { setLot(l); setProd(p); }} />) : (
          <>
            <div className="row between"><div><b>{prod!.name}</b>{lot && <div className="small muted num">Lô {lot.lotCode} · còn {qtyText(remain(lot), prod!.baseUnit)}</div>}</div><Button size="sm" variant="ghost" onClick={() => { setProd(null); setLot(null); }}>Đổi</Button></div>
            <div className="grid2">
              <DecInput label={type === "count" ? "Số đếm thực tế" : "Số lượng thực nhận"} value={qty} onChange={setQty} autoFocus />
              <Select label="Đơn vị" value={u} onChange={(e) => setUnit(e.target.value)}>{unitOpts.map((x) => <option key={x} value={x}>{unitLabel(x)}</option>)}</Select>
            </div>
            {type === "receipt" && <>
              <DecInput label="Số lượng theo chứng từ NCC" value={docQty} onChange={setDocQty} />
              {typeof docQty === "number" && n > 0 && docQty !== n && <div className="banner">Chênh lệch {qtyText(Math.round((n - docQty) * 1000), u)} so với chứng từ.</div>}
              <MoneyInput label={`Giá nhập / ${unitLabel(u)} (₫)`} value={cost} onChange={setCost} />
              <Input label="Hạn sử dụng" type="date" value={exp} min={todayVN()} onChange={(e) => setExp(e.target.value)} />
            </>}
            {type === "waste" && <div><div className="small muted" style={{ marginBottom: 6 }}>Lý do</div><div className="chips">{REASONS.map(([k, l]) => <button key={k} className="chip" aria-pressed={reason === k} onClick={() => setReason(k)}>{l}</button>)}</div></div>}
            <div className="row"><Button variant="ghost" onClick={onCancel}>Xong</Button><Button className="grow" loading={busy} disabled={n <= 0 && type !== "count"} onClick={submit}>Thêm dòng</Button></div>
          </>
        )}
        {!picked && <Button variant="ghost" onClick={onCancel}>Đóng</Button>}
      </div>
    </Card>
  );
}

/** B-19: nhận hàng chuyển kho — nhập số thực nhận từng dòng; nhận thiếu phải ghi lý do (ghi hao hụt). */
function ReceiveSheet({ doc, onClose, onDone }: { doc: any; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<number, number | "">>(() => Object.fromEntries((doc.lines ?? []).map((l: any) => [l.id, (l.qtyShown ?? l.qtyMilli) / 1000])));
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const short = (doc.lines ?? []).some((l: any) => Number(qty[l.id] ?? 0) * 1000 < (l.qtyShown ?? l.qtyMilli) - 0.5);
  return (
    <Sheet open onClose={onClose} title={`Nhận hàng · ${doc.code}`} footer={<Button block loading={busy} disabled={short && !reason.trim()} onClick={async () => {
      setBusy(true);
      try {
        await post(`/stock-docs/${doc.id}/receive`, { ...(reason.trim() ? { reason: reason.trim() } : {}), lines: (doc.lines ?? []).map((l: any) => ({ lineId: l.id, qty: Number(qty[l.id] ?? 0) })) });
        toast("Đã nhận hàng", "ok"); onDone();
      } catch {} finally { setBusy(false); }
    }}>Xác nhận nhận hàng</Button>}>
      <div className="stack">
        {(doc.lines ?? []).map((l: any) => (
          <div key={l.id} className="card flat" style={{ padding: 12 }}>
            <div className="small muted">{pname(l)} · {l.lotCode} · đã chuyển {qtyText(l.qtyShown ?? l.qtyMilli, l.unit)}</div>
            <DecInput label={`Thực nhận (${unitLabel(l.unit)})`} value={qty[l.id] ?? ""} onChange={(n) => setQty({ ...qty, [l.id]: n })} />
          </div>
        ))}
        {short && <><Banner>Nhận thiếu — phần thiếu được ghi hao hụt (huỷ hàng). Cần nêu lý do.</Banner><Input label="Lý do hao hụt" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="vd: rơi vỡ khi vận chuyển" /></>}
      </div>
    </Sheet>
  );
}

/** B-03: đánh dấu lô hỏng — lô ngừng bán, phần giữ cho đơn được chuyển sang lô khác (FEFO). */
function QuarantineButton({ lot, onDone }: { lot: any; onDone: () => void }) {
  const can = useCan();
  const [open, setOpen] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  if (!can("inventory.write")) return null;
  if (lot.status === "quarantine") {
    return can("inventory.approve") ? <Button variant="soft" onClick={async () => { const r = window.prompt("Lý do bỏ cách ly"); if (!r) return; try { await post(`/lots/${lot.id}/release-quarantine`, { reason: r }); toast("Đã bỏ cách ly", "ok"); onDone(); } catch {} }}>Bỏ cách ly</Button> : <Badge tone="danger">Đang cách ly</Badge>;
  }
  if (lot.status !== "active") return null;
  return (
    <>
      <Button variant="soft" onClick={() => setOpen(true)}>Đánh dấu lô hỏng</Button>
      {open && (
        <Sheet open onClose={() => setOpen(false)} title={`Cách ly lô ${lot.lotCode}`} footer={<Button block variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={async () => {
          setBusy(true);
          try {
            const r = await post(`/lots/${lot.id}/quarantine`, { reason: reason.trim() });
            const short = r?.shortOrders?.length ?? 0;
            toast(short ? `Đã cách ly lô. ${short} đơn thiếu hàng — đã báo quản lý` : "Đã cách ly lô, phần giữ cho đơn đã chuyển sang lô khác", short ? "error" : "ok");
            setOpen(false); onDone();
          } catch {} finally { setBusy(false); }
        }}>Cách ly lô</Button>}>
          <div className="stack">
            <Banner>Lô sẽ ngừng bán ngay. Phần đã giữ cho đơn B2B/online được chuyển sang lô tốt khác theo hạn dùng; phần không thay được sẽ nhả và báo quản lý. Sau đó có thể lập phiếu huỷ hàng cho lô này.</Banner>
            <Input label="Lý do (bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="vd: dập nát, thối" />
          </div>
        </Sheet>
      )}
    </>
  );
}

function Obj({ v, depth = 0 }: { v: any; depth?: number }) {
  if (v == null) return <span className="muted">—</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="muted">Không có</span>;
    if (typeof v[0] !== "object") return <>{v.join(", ")}</>;
    const keys = Object.keys(v[0]).filter((k) => typeof v[0][k] !== "object");
    return (
      <div style={{ overflowX: "auto" }}><table className="dt-table" style={{ display: "table" }}><thead><tr>{keys.map((k) => <th key={k}>{k}</th>)}</tr></thead>
        <tbody>{v.map((r, i) => <tr key={i}>{keys.map((k) => <td key={k}>{fmtVal(k, r[k])}</td>)}</tr>)}</tbody></table></div>
    );
  }
  if (typeof v === "object") {
    return <div className="stack" style={{ gap: 6 }}>{Object.entries(v).map(([k, x]) => (
      <div key={k} className={depth ? "" : "kv row between wrap"} style={{ alignItems: "flex-start" }}><span className="muted small" style={{ minWidth: 110 }}>{k}</span><span style={{ textAlign: "right" }}><Obj v={x} depth={depth + 1} /></span></div>
    ))}</div>;
  }
  return <>{fmtVal("", v)}</>;
}
const fmtVal = (k: string, v: any) => (typeof v === "string" && /At$|^at$|Date$/.test(k) && /^\d{4}-\d\d-\d\dT/.test(v) ? fmtDateTime(v) : /Milli$/.test(k) && typeof v === "number" ? qtyText(v) : /(price|cost|amount|total)$/i.test(k) && typeof v === "number" ? money(v) : String(v ?? "—"));

const MOVE: Record<string, string> = { receipt: "Nhập kho", sale: "Bán", return: "Trả hàng", waste: "Huỷ hàng", adjust: "Điều chỉnh", transfer_in: "Nhận chuyển kho", transfer_out: "Xuất chuyển kho" };
/** Backend: { lot, receipt:{code,postedAt,supplierName,supplierRef}|null, moves[{at,moveType,qtyDeltaMilli}], orders[{code,kind,channel,status,createdAt,qtyMilli}] } */
function Trace() {
  const [code, setCode] = useState("");
  const r = useAsync(async () => { if (!code) return null; try { return await get(`/stock/lots/${encodeURIComponent(code)}/trace`, undefined, { silent: true }); } catch { return null; } }, [code]);
  const pmap = useUnitMap();
  const d = r.data;
  const bu = d ? pmap?.get(d.lot?.productId)?.baseUnit : undefined;
  return (
    <div className="stack">
      <Card title="Truy vết lô hàng"><Scanner onCode={setCode} /></Card>
      {code && (r.loading ? <Spinner /> : d ? (
        <>
          <Card title={`Lô ${d.lot.lotCode} · ${d.lot.productName}`}>
            <div className="stack">
              <div className="kv row between"><span className="muted small">Nhập</span><span>{qtyText(d.lot.qtyInMilli, bu)}</span></div>
              <div className="kv row between"><span className="muted small">Còn lại</span><span>{qtyText(d.lot.qtyOnHandMilli, bu)}</span></div>
              <div className="kv row between"><span className="muted small">Hạn dùng</span><span>{d.lot.expiresAt ? fmtDate(d.lot.expiresAt) : "—"} {d.lot.expired && <Badge tone="danger">Hết hạn</Badge>}</span></div>
              {d.lot.status === "quarantine" && <Banner>Lô đang cách ly{d.lot.quarantineReason ? `: ${d.lot.quarantineReason}` : ""} — không bán, không giữ cho đơn.</Banner>}
              <QuarantineButton lot={d.lot} onDone={r.reload} />
              <div className="kv row between"><span className="muted small">Nhà cung cấp</span><span>{d.receipt?.supplierName ?? "—"}</span></div>
              <div className="kv row between"><span className="muted small">Phiếu nhập</span><span>{d.receipt ? `${d.receipt.code} · ${fmtDateTime(d.receipt.postedAt)}` : "—"}{d.receipt?.supplierRef ? ` · CT ${d.receipt.supplierRef}` : ""}</span></div>
            </div>
          </Card>
          <Card title="Đơn đã bán từ lô này"><DataTable rows={d.orders ?? []} rowKey={(x: any) => `${x.id}-${x.qtyMilli}`} empty="Chưa bán đơn nào từ lô này" cols={[
            { key: "c", label: "Đơn", title: true, render: (x: any) => <b>{x.code}</b> },
            { key: "t", label: "Thời gian", render: (x: any) => fmtDateTime(x.createdAt) },
            { key: "q", label: "Lượng", right: true, render: (x: any) => qtyText(x.qtyMilli, bu) },
          ]} /></Card>
          <Card title="Biến động kho"><DataTable rows={d.moves ?? []} rowKey={(x: any) => x.id} cols={[
            { key: "t", label: "Thời gian", title: true, render: (x: any) => fmtDateTime(x.at) },
            { key: "m", label: "Loại", render: (x: any) => MOVE[x.moveType] ?? x.moveType },
            { key: "q", label: "Số lượng", right: true, render: (x: any) => <b style={{ color: x.qtyDeltaMilli < 0 ? "var(--danger)" : "var(--accent)" }}>{x.qtyDeltaMilli > 0 ? "+" : ""}{qtyText(x.qtyDeltaMilli, bu)}</b> },
          ]} /></Card>
        </>
      ) : <EmptyState title="Không tìm thấy lô" hint="Kiểm tra lại mã lô (dạng L…)." />)}
    </div>
  );
}
export { Obj };
