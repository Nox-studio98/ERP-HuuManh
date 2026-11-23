import { useEffect, useMemo, useState } from "react";
import { get, items, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../components/ui";
import { LineChart } from "../components/charts";
import { toast } from "../components/toast";
import { CHANNELS, fmtDateTime, money, unitLabel } from "../format";
import { useCan } from "../store";
import { priceOf, type Product } from "./Pos";

export default function Prices() {
  const can = useCan();
  const [tab, setTab] = useState<"bulk" | "lists" | "history">("bulk");
  const pend = useAsync(() => (can("approvals.decide") ? get("/approvals", { status: "pending" }, { silent: true }).then((r) => items<any>(r).filter((a) => /price/i.test(a.type ?? ""))) : Promise.resolve([])), []);
  return (
    <div className="stack">
      {(pend.data?.length ?? 0) > 0 && <Banner>{pend.data!.length} thay đổi giá đang chờ duyệt — vào mục “Duyệt” để xử lý.</Banner>}
      <Segmented value={tab} onChange={setTab} options={[{ v: "bulk", label: "Đổi giá" }, { v: "lists", label: "Bảng giá" }, { v: "history", label: "Lịch sử" }]} />
      {tab === "bulk" && <Bulk canWrite={can("prices.write")} canCost={can("prices.view_cost")} />}
      {tab === "lists" && <Lists canWrite={can("prices.write")} />}
      {tab === "history" && <History />}
    </div>
  );
}

const KINDS: Record<string, string> = { base: "Giá nền", group: "Theo nhóm khách", promo: "Khuyến mại", customer: "Theo khách" };
const CH: Record<string, string> = { ...CHANNELS, all: "Tất cả kênh" };
function Lists({ canWrite }: { canWrite: boolean }) {
  const l = useAsync(() => get("/price-lists").then((r) => items<any>(r)), []);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ name: "", channel: "pos", kind: "promo", priority: 10 });
  return (
    <div className="stack">
      {canWrite && <div><Button onClick={() => setAdd(true)}>+ Bảng giá mới</Button></div>}
      {l.loading ? <Spinner /> : <DataTable rows={l.data ?? []} rowKey={(x) => x.id} cols={[
        { key: "n", label: "Tên", title: true, render: (x) => <b>{x.name}</b> },
        { key: "c", label: "Kênh", render: (x) => CH[x.channel] ?? x.channel },
        { key: "k", label: "Loại", render: (x) => KINDS[x.kind] ?? x.kind },
        { key: "p", label: "Ưu tiên", right: true, render: (x) => x.priority },
      ]} />}
      <Sheet open={add} onClose={() => setAdd(false)} title="Bảng giá mới" footer={<Button block disabled={!f.name} onClick={async () => { try { await post("/price-lists", f); toast("Đã tạo bảng giá", "ok"); setAdd(false); l.reload(); } catch {} }}>Tạo</Button>}>
        <div className="stack">
          <Input label="Tên bảng giá" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Select label="Kênh" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{[["pos", "Tại quầy"], ["online", "Online"], ["b2b", "Sỉ"], ["all", "Tất cả kênh"]].map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Select label="Loại" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Input label="Ưu tiên (số lớn thắng)" type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} />
        </div>
      </Sheet>
    </div>
  );
}

const localInput = () => { const d = new Date(Date.now() + 7 * 3600000); return d.toISOString().slice(0, 16); };
function Bulk({ canWrite, canCost }: { canWrite: boolean; canCost: boolean }) {
  const lists = useAsync(() => get("/price-lists").then((r) => items<any>(r)), []);
  const [listId, setListId] = useState("");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const prods = useAsync(() => get("/products", { q: dq, limit: 100 }).then((r) => items<Product>(r)), [dq]);
  const [edits, setEdits] = useState<Record<number, number>>({});
  const [eff, setEff] = useState(localInput());
  const [note, setNote] = useState("");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  // Mặc định: bảng giá nền áp cho quầy (kind=base, kênh all/pos) — không phải bảng sỉ/nhóm khách có priority cao hơn.
  const lid = listId || String((lists.data?.find((l) => l.kind === "base" && (l.channel === "all" || l.channel === "pos")) ?? lists.data?.[0])?.id ?? "");
  const changed = useMemo(() => Object.entries(edits).filter(([id, v]) => v > 0 && v !== priceOf(prods.data?.find((p) => p.id === Number(id)) as Product)), [edits, prods.data]);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post("/prices/bulk", { priceListId: Number(lid), effectiveFrom: new Date(eff + ":00+07:00").toISOString(), items: changed.map(([id, v]) => ({ productId: Number(id), unitPrice: v })), ...(note ? { note } : {}) });
      setRes(r); setEdits({}); toast(r?.status === "pending_approval" ? "Đã gửi duyệt giá" : "Đã áp dụng giá mới", "ok"); prods.reload();
    } catch {} finally { setBusy(false); }
  };
  const below = new Set<number>((res?.belowCost ?? []).map(Number));
  return (
    <div className="stack">
      <div className="grid3">
        <Select label="Bảng giá" value={lid} onChange={(e) => setListId(e.target.value)}>{(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
        <Input label="Hiệu lực từ" type="datetime-local" value={eff} onChange={(e) => setEff(e.target.value)} />
        <Input label="Tìm hàng" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {res?.belowCost?.length > 0 && <Banner>Cảnh báo: {res.belowCost.length} mặt hàng có giá mới thấp hơn giá vốn bình quân. {res.status === "pending_approval" ? "Đang chờ duyệt." : ""}</Banner>}
      {res?.status === "pending_approval" && <Banner tone="info">Thay đổi giá cần quản lý duyệt trước khi có hiệu lực.</Banner>}
      {prods.loading ? <Spinner /> : (
        <DataTable rows={prods.data ?? []} rowKey={(p) => p.id} rowClass={(p) => (edits[p.id] && p.avgCost && edits[p.id] < p.avgCost) || below.has(p.id) ? "bad" : ""} cols={[
          { key: "n", label: "Hàng", title: true, render: (p) => <b>{p.name}</b> },
          ...(canCost ? [{ key: "c", label: "Giá vốn BQ", right: true, render: (p: Product) => (p.avgCost ? money(p.avgCost) : "—") }] : []),
          { key: "o", label: "Giá hiện tại", right: true, render: (p) => (priceOf(p) ? `${money(priceOf(p))}/${unitLabel(p.baseUnit)}` : "—") },
          { key: "w", label: "Giá mới", right: true, render: (p) => (
            <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", minWidth: 130 }}>
              <input className="input num" style={{ textAlign: "right", maxWidth: 140 }} inputMode="numeric" disabled={!canWrite} aria-label={`Giá mới ${p.name}`} placeholder={String(priceOf(p) || "")}
                value={edits[p.id] ? new Intl.NumberFormat("vi-VN").format(edits[p.id]) : ""} onChange={(e) => setEdits({ ...edits, [p.id]: parseInt(e.target.value.replace(/\D/g, "") || "0", 10) })} />
              {edits[p.id] > 0 && p.avgCost ? <span className="small" style={{ color: edits[p.id] < p.avgCost ? "var(--danger)" : "var(--muted)" }}>{edits[p.id] < p.avgCost ? "Dưới giá vốn! " : "Biên "}{Math.round(((edits[p.id] - p.avgCost) / edits[p.id]) * 100)}%</span> : null}
            </div>) },
        ]} />
      )}
      {canWrite && changed.length > 0 && (
        <Card className="flat"><div className="stack"><TextArea label="Ghi chú thay đổi giá" value={note} onChange={(e) => setNote(e.target.value)} /><Button size="lg" loading={busy} onClick={submit}>Áp dụng {changed.length} mức giá</Button></div></Card>
      )}
    </div>
  );
}

function History() {
  const [q, setQ] = useState(""), dq = useDebounced(q);
  const [prod, setProd] = useState<Product | null>(null);
  const found = useAsync(() => (dq ? get("/products", { q: dq, limit: 6 }).then((r) => items<Product>(r)) : Promise.resolve([])), [dq]);
  const h = useAsync(() => (prod ? get("/prices/history", { productId: prod.id }) : Promise.resolve(null)), [prod?.id]);
  const rows: any[] = h.data?.sell ?? [];
  const buys: any[] = h.data?.purchases ?? [];
  const basePl = rows.find((x) => x.kind === "base" && x.status === "active")?.priceListId ?? rows.find((x) => x.status === "active")?.priceListId;
  const pts = rows.filter((r) => r.status === "active" && r.priceListId === basePl).reverse().map((r) => ({ label: (r.effectiveFrom ?? "").slice(5, 10), value: r.unitPrice })).filter((x) => x.value);
  useEffect(() => { setQ(""); }, [prod]);
  return (
    <div className="stack">
      <Input label="Tìm hàng để xem lịch sử giá" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      {(found.data ?? []).map((p) => <button key={p.id} className="dt-card" onClick={() => setProd(p)}>{p.name}</button>)}
      {prod && (h.loading ? <Spinner /> : (
        <Card title={`Giá bán: ${prod.name}`}>
          {pts.length ? <LineChart points={pts} /> : <div className="muted">Chưa có lịch sử giá.</div>}
          <DataTable rows={rows} rowKey={(r: any) => r.id} cols={[
            { key: "f", label: "Hiệu lực từ", title: true, render: (r: any) => fmtDateTime(r.effectiveFrom) },
            { key: "pl", label: "Bảng giá", render: (r: any) => r.priceListName },
            { key: "t", label: "Đến", render: (r: any) => (r.effectiveTo ? fmtDateTime(r.effectiveTo) : "Hiện hành") },
            { key: "p", label: "Giá", right: true, render: (r: any) => <b>{money(r.unitPrice)}</b> },
            { key: "s", label: "TT", render: (r: any) => (r.status && r.status !== "active" ? <Badge tone="warn">{({ pending: "Chờ duyệt", rejected: "Từ chối" } as Record<string, string>)[r.status] ?? r.status}</Badge> : "") },
          ]} />
          {buys.length > 0 && <><h3 style={{ margin: "16px 0 8px" }}>Giá mua theo lô / NCC</h3><DataTable rows={buys} rowKey={(r: any) => r.lotId} cols={[
            { key: "l", label: "Lô", title: true, render: (r: any) => r.lotCode ?? "—" },
            { key: "d", label: "Ngày nhập", render: (r: any) => fmtDateTime(r.receivedAt) },
            { key: "s", label: "NCC", render: (r: any) => r.supplierName ?? "—" },
            { key: "c", label: "Giá mua", right: true, render: (r: any) => <>{money(r.unitCost)}/{unitLabel(prod.baseUnit)}</> },
          ]} /></>}
        </Card>
      ))}
    </div>
  );
}
