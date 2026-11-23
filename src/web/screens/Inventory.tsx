import { useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { Scanner } from "../components/Scanner";
import { toast } from "../components/toast";
import { DOC_STATUS, DOC_TYPES, fmtDate, fmtDateTime, money, qtyText, todayVN, unitLabel } from "../format";
import { useCan } from "../store";
import type { Product } from "./Pos";

const REASONS = [["dap", "Dập"], ["heo", "Héo"], ["het_han", "Hết hạn"], ["hao_can", "Hao cân"], ["khac", "Khác"]];
const docTone = (s: string) => (s === "posted" ? "ok" : s === "pending_approval" ? "warn" : s === "cancelled" ? "danger" : "info") as any;
const remain = (l: any) => l.remainingMilli ?? l.qtyMilli ?? l.onHandMilli ?? l.availableMilli;
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
  if (a.loading) return <Spinner />;
  const d = a.data ?? {};
  const low = d.lowStock ?? [], soon = d.expiringSoon ?? [], exp = d.expired ?? [];
  return (
    <div className="stack">
      <div className="kpis">
        <div className="kpi"><div className="l">Sắp hết hàng</div><div className="v" style={{ color: low.length ? "var(--warn)" : undefined }}>{low.length}</div></div>
        <div className="kpi"><div className="l">Sắp hết hạn (≤2 ngày)</div><div className="v" style={{ color: soon.length ? "var(--warn)" : undefined }}>{soon.length}</div></div>
        <div className="kpi"><div className="l">Đã hết hạn</div><div className="v" style={{ color: exp.length ? "var(--danger)" : undefined }}>{exp.length}</div></div>
      </div>
      {exp.length > 0 && <Banner tone="danger">Có {exp.length} lô đã hết hạn — chỉ được xuất bằng phiếu huỷ hàng.</Banner>}
      <Card title="Tồn thấp"><DataTable rows={low} rowKey={(x: any) => x.productId ?? x.id} empty="Không có mặt hàng dưới mức tồn tối thiểu" cols={[
        { key: "n", label: "Hàng", title: true, render: (x: any) => pname(x) },
        { key: "a", label: "Tồn", right: true, render: (x: any) => qtyText(x.availableMilli ?? x.qtyMilli, x.baseUnit ?? "kg") },
        { key: "m", label: "Tối thiểu", right: true, render: (x: any) => qtyText(x.minStockMilli, x.baseUnit ?? "kg") },
      ]} /></Card>
      <div className="grid3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", alignItems: "start" }}>
        {[["Sắp hết hạn", soon, "warn"], ["Đã hết hạn", exp, "danger"]].map(([t, rows, tn]: any) => (
          <Card key={t} title={t}><DataTable rows={rows} rowKey={(x: any) => x.lotId ?? x.id ?? x.lotCode} empty="Không có lô nào" cols={[
            { key: "n", label: "Hàng", title: true, render: (x: any) => pname(x) },
            { key: "l", label: "Lô", render: (x: any) => <span className="num">{x.lotCode}</span> },
            { key: "e", label: "HSD", render: (x: any) => <Badge tone={tn}>{fmtDate(x.expiresAt)}</Badge> },
            { key: "q", label: "Còn", right: true, render: (x: any) => qtyText(remain(x), x.baseUnit ?? "kg") },
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
  const type = doc.data?.type ?? t0 ?? "receipt";
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = doc.data;
  const editable = !d || d.status === "draft";
  const lines: any[] = d?.lines ?? [];

  const act = async (what: "post" | "cancel") => {
    setBusy(true);
    try {
      const r = await post(`/stock-docs/${id}/${what}`, {});
      toast(what === "cancel" ? "Đã huỷ phiếu" : r?.status === "pending_approval" || r?.doc?.status === "pending_approval" ? "Đã gửi quản lý duyệt" : "Đã ghi sổ", "ok");
      if (what === "post" && r?.status !== "pending_approval") onClose(); else doc.reload();
    } catch {} finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} wide title={`${DOC_TYPES[type] ?? type}${d ? " · " + d.code : ""}`}
      footer={d && editable ? <><Button variant="ghost" onClick={() => act("cancel")} disabled={busy}>Huỷ phiếu</Button><Button className="grow" loading={busy} disabled={!lines.length} onClick={() => act("post")}>Ghi sổ</Button></> : undefined}>
      {!id ? <CreateDoc type={type} onCreated={setId} /> : doc.loading && !d ? <Spinner /> : (
        <div className="stack">
          <div className="row wrap"><Badge tone={docTone(d.status)}>{DOC_STATUS[d.status] ?? d.status}</Badge>{d.supplierRef && <span className="muted small">Số CT NCC: {d.supplierRef}</span>}{d.reason && <span className="muted small">{d.reason}</span>}</div>
          {d.status === "pending_approval" && <Banner>Phiếu đang chờ quản lý duyệt.</Banner>}
          <DataTable rows={lines} rowKey={(l) => l.id} empty="Chưa có dòng nào" cols={[
            { key: "n", label: "Hàng / lô", title: true, render: (l) => <>{pname(l)}{l.lotCode ? ` · ${l.lotCode}` : ""}</> },
            { key: "dq", label: type === "count" ? "Hệ thống" : "Theo CT", right: true, render: (l) => (l.docQtyMilli != null ? qtyText(l.docQtyMilli) : "—") },
            { key: "q", label: type === "count" ? "Đếm" : "Thực tế", right: true, render: (l) => <b>{qtyText(l.qtyMilli, l.unit)}</b> },
            { key: "c", label: "Giá vốn", right: true, hideMobile: type !== "receipt", render: (l) => (l.unitCost != null ? money(l.unitCost) : "—") },
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
  const [loc, setLoc] = useState(""), [sup, setSup] = useState(""), [ref, setRef] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const locationId = loc || String(locs.data?.[0]?.id ?? "");
  return (
    <div className="stack">
      <Select label="Vị trí kho" value={locationId} onChange={(e) => setLoc(e.target.value)}>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
      {type === "receipt" && <>
        <Select label="Nhà cung cấp" value={sup} onChange={(e) => setSup(e.target.value)}><option value="">— Chọn —</option>{(sups.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Input label="Số chứng từ NCC" value={ref} onChange={(e) => setRef(e.target.value)} />
      </>}
      <TextArea label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="lg" loading={busy} disabled={!locationId || (type === "receipt" && !sup)} onClick={async () => {
        setBusy(true);
        try { const r = await post("/stock-docs", { type, locationId: Number(locationId), ...(sup ? { supplierId: Number(sup) } : {}), ...(ref ? { supplierRef: ref } : {}), ...(note ? { note } : {}) }); onCreated(r.id ?? r.doc?.id); } catch {} finally { setBusy(false); }
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
        : { lotId: lot.id, qty: n, unit: u, reason };
      await post(`/stock-docs/${docId}/lines`, body); toast("Đã thêm dòng", "ok"); onDone();
    } catch (e) { if (e instanceof ApiError) { /* toast đã hiện */ } } finally { setBusy(false); }
  };
  return (
    <Card className="flat" title={type === "receipt" ? "Thêm hàng nhập" : type === "count" ? "Đếm lô" : "Huỷ theo lô"}>
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

function Trace() {
  const [code, setCode] = useState("");
  const r = useAsync(() => (code ? get(`/stock/lots/${encodeURIComponent(code)}/trace`) : Promise.resolve(null)), [code]);
  return (
    <div className="stack">
      <Card title="Truy vết lô hàng"><Scanner onCode={setCode} /></Card>
      {code && (r.loading ? <Spinner /> : r.data ? <Card title={`Lô ${code}`}><Obj v={r.data} /></Card> : <EmptyState title="Không tìm thấy lô" />)}
    </div>
  );
}
export { Obj };
