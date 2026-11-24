import { useState } from "react";
import { get, items, post, put } from "../api";
import { Badge, Button, Card, DataTable, DecInput, Input, Segmented, Select, Sheet, Spinner, useAsync, useDebounced } from "../components/ui";
import { Barcode } from "../components/Barcode";
import { toast } from "../components/toast";
import { UNIT_OPTIONS, money, qtyText, unitLabel } from "../format";
import { useCan } from "../store";
import { ProductOnline } from "./online/ProductOnline";
import { priceOf, type Product } from "./Pos";

type UnitRow = { unit: string; factor: number | ""; barcode: string };
export default function Products() {
  const can = useCan();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const list = useAsync(() => get("/products", { q: dq, limit: 100 }).then((r) => items<Product>(r)), [dq]);
  const [edit, setEdit] = useState<Product | "new" | null>(null);
  const [label, setLabel] = useState<Product | null>(null);
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="grow"><Input label="Tìm hàng hoá" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tên, SKU, mã vạch…" /></div>
        {can("products.write") && <Button onClick={() => setEdit("new")}>+ Thêm</Button>}
      </div>
      {list.loading ? <Spinner /> : (
        <DataTable rows={list.data ?? []} rowKey={(p) => p.id} onRowClick={(p) => (can("products.write") ? setEdit(p) : setLabel(p))} empty="Chưa có hàng hoá" cols={[
          { key: "n", label: "Tên", title: true, render: (p) => <><b>{p.name}</b> {!p.active && p.active !== undefined && <Badge>Ngưng bán</Badge>}</> },
          { key: "s", label: "SKU", render: (p) => <span className="num">{p.sku}</span> },
          { key: "u", label: "Đơn vị", render: (p) => <>{unitLabel(p.baseUnit)}{(p.units ?? []).filter((u) => u.unit !== p.baseUnit).map((u) => ` · ${unitLabel(u.unit)}=${u.factorMilli / 1000}${unitLabel(p.baseUnit)}`)}</> },
          { key: "st", label: "Tồn", right: true, render: (p) => qtyText(p.availableMilli, p.baseUnit) },
          { key: "p", label: "Giá bán", right: true, render: (p) => (priceOf(p) ? money(priceOf(p)) : "—") },
          { key: "l", label: "", render: (p) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setLabel(p); }}>Tem</Button> },
        ]} />
      )}
      {edit && <ProductForm p={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {label && <LabelSheet p={label} onClose={() => setLabel(null)} />}
    </div>
  );
}

function ProductForm({ p, onClose, onSaved }: { p: Product | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ sku: p?.sku ?? "", name: p?.name ?? "", baseUnit: p?.baseUnit ?? "kg", sellByWeight: !!p?.sellByWeight, origin: p?.origin ?? "", barcode: p?.barcode ?? "", shelfLifeDays: p?.shelfLifeDays ?? ("" as number | ""), minStock: p?.minStockMilli != null ? p.minStockMilli / 1000 : ("" as number | "") });
  const [units, setUnits] = useState<UnitRow[]>((p?.units ?? []).filter((u) => u.unit !== p?.baseUnit).map((u) => ({ unit: u.unit, factor: u.factorMilli / 1000, barcode: u.barcode ?? "" })));
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"info" | "online">("info");
  const can = useCan();
  const [merging, setMerging] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    const body: any = {
      sku: f.sku.trim(), name: f.name.trim(), baseUnit: f.baseUnit, sellByWeight: f.sellByWeight,
      ...(f.origin ? { origin: f.origin } : {}), ...(f.barcode ? { barcode: f.barcode } : {}),
      ...(typeof f.shelfLifeDays === "number" ? { shelfLifeDays: f.shelfLifeDays } : {}), ...(typeof f.minStock === "number" ? { minStockMilli: Math.round(f.minStock * 1000) } : {}),
      units: [{ unit: f.baseUnit, factorMilli: 1000 }, ...units.filter((u) => u.unit && Number(u.factor) > 0).map((u) => ({ unit: u.unit, factorMilli: Math.round(Number(u.factor) * 1000), ...(u.barcode ? { barcode: u.barcode } : {}) }))],
    };
    try {
      if (p) await put(`/products/${p.id}`, { ...body, version: p.version }); else await post("/products", body);
      toast("Đã lưu hàng hoá", "ok"); onSaved();
    } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} wide title={p ? "Sửa hàng hoá" : "Thêm hàng hoá"} footer={tab === "info" ? <Button block loading={busy} disabled={!f.sku || !f.name} onClick={save}>Lưu</Button> : undefined}>
      <div className="stack">
        {p && <Segmented value={tab} onChange={setTab} options={[{ v: "info", label: "Thông tin" }, { v: "online", label: "Bán online" }]} />}
        {tab === "online" && p ? <ProductOnline productId={p.id} /> : <>
        <div className="grid2"><Input label="SKU" value={f.sku} onChange={(e) => set("sku", e.target.value)} /><Input label="Tên hàng" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
        <div className="grid2">
          <Select label="Đơn vị chính" value={f.baseUnit} onChange={(e) => set("baseUnit", e.target.value)}>{UNIT_OPTIONS.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}</Select>
          <Input label="Xuất xứ" value={f.origin} onChange={(e) => set("origin", e.target.value)} />
        </div>
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.sellByWeight} onChange={(e) => set("sellByWeight", e.target.checked)} /> Bán theo cân (nhập kg lẻ)</label>
        <Input label="Mã vạch" value={f.barcode} onChange={(e) => set("barcode", e.target.value)} hint="Để trống: hệ thống tự sinh mã nội bộ." />
        <div className="grid2">
          <DecInput label="Hạn dùng (ngày)" value={f.shelfLifeDays} onChange={(n) => set("shelfLifeDays", n)} />
          <DecInput label={`Tồn tối thiểu (${unitLabel(f.baseUnit)})`} value={f.minStock} onChange={(n) => set("minStock", n)} />
        </div>
        <h3>Đơn vị quy đổi</h3>
        {units.map((u, i) => (
          <div key={i} className="card flat" style={{ padding: 12 }}>
            <div className="grid2">
              <Input label="Đơn vị (vd: thùng)" value={u.unit} list="unit-list" onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} />
              <DecInput label={`1 ${u.unit || "…"} = ? ${unitLabel(f.baseUnit)}`} value={u.factor} onChange={(n) => setUnits(units.map((x, j) => (j === i ? { ...x, factor: n } : x)))} />
            </div>
            <div className="row" style={{ alignItems: "flex-end", marginTop: 8 }}>
              <div className="grow"><Input label="Mã vạch đơn vị (nếu có)" value={u.barcode} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)))} /></div>
              <Button variant="ghost" aria-label="Xoá đơn vị" onClick={() => setUnits(units.filter((_, j) => j !== i))}>✕</Button>
            </div>
          </div>
        ))}
        <datalist id="unit-list">{["thung", "khay", "hop", "tui"].map((u) => <option key={u} value={u} />)}</datalist>
        <Button variant="soft" onClick={() => setUnits([...units, { unit: "thung", factor: "", barcode: "" }])}>+ Thêm đơn vị quy đổi</Button>
        {p && can("products.write") && <Button variant="ghost" onClick={() => setMerging(true)}>Gộp mã trùng vào mã khác…</Button>}
        </>}
        {merging && p && <MergeSheet p={p} onClose={() => setMerging(false)} onDone={() => { setMerging(false); onSaved(); }} />}
      </div>
    </Sheet>
  );
}

/** EC-22: gộp mã trùng — lô, giá, mapping online, đơn đang mở chuyển sang mã đích; lịch sử giữ nguyên. */
function MergeSheet({ p, onClose, onDone }: { p: Product; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const r = useAsync(() => (dq.length < 1 ? Promise.resolve([] as Product[]) : get("/products", { q: dq, limit: 8, active: 1 }).then((x) => items<Product>(x))), [dq]);
  const [target, setTarget] = useState<Product | null>(null);
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={`Gộp "${p.name}" vào mã khác`} footer={target ? <Button block variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={async () => {
      setBusy(true);
      try { await post(`/products/${p.id}/merge-into/${target.id}`, { reason: reason.trim() }); toast("Đã gộp mã hàng", "ok"); onDone(); } catch {} finally { setBusy(false); }
    }}>Xác nhận gộp</Button> : undefined}>
      <div className="stack">
        {!target ? <>
          <Input label="Tìm mã đích" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tên, SKU, mã vạch…" />
          {(r.data ?? []).filter((x) => x.id !== p.id).map((x) => <button key={x.id} className="dt-card" onClick={() => setTarget(x)}><b>{x.name}</b> <span className="muted small">· {x.sku} · {unitLabel(x.baseUnit)}</span></button>)}
        </> : <>
          <div className="banner danger" role="alert">Mã <b>{p.name}</b> ({p.sku}) sẽ bị ngừng và gộp vào <b>{target.name}</b> ({target.sku}). Lô tồn, giá, liên kết bán online và các đơn đang mở chuyển sang mã đích. Lịch sử bán/thẻ kho giữ nguyên. Không thể hoàn tác.</div>
          <Input label="Lý do gộp (bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="vd: nhập trùng mã Táo Envy" />
          <Button variant="ghost" onClick={() => setTarget(null)}>Chọn mã khác</Button>
        </>}
      </div>
    </Sheet>
  );
}

function LabelSheet({ p, onClose }: { p: Product; onClose: () => void }) {
  const code = p.barcode || p.sku;
  return (
    <Sheet open onClose={onClose} title="In tem hàng" footer={<Button block onClick={() => window.print()}>In tem</Button>}>
      <div className="label-card print-area">
        <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>{p.name}</div>
        <div className="price">{priceOf(p) ? `${money(priceOf(p))}/${unitLabel(p.baseUnit)}` : "Chưa có giá"}</div>
        <Barcode value={code} />
        <div className="code">{code}</div>
        {p.origin && <div className="small">Xuất xứ: {p.origin}</div>}
      </div>
    </Sheet>
  );
}
