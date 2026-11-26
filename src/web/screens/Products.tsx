import { useState } from "react";
import { get, items, post, put } from "../api";
import { Badge, Button, Card, DataTable, DecInput, EmptyState, Input, Segmented, Select, Sheet, Spinner, useAsync, useDebounced } from "../components/ui";
import { ExportButton, FilterBar, FilterSelect, PageHeader, SearchInput, usePagedList } from "../components/list";
import { Barcode } from "../components/Barcode";
import { toast } from "../components/toast";
import { UNIT_OPTIONS, money, qtyText, unitLabel } from "../format";
import { useCan } from "../store";
import { navigate } from "../router";
import { ProductOnline } from "./online/ProductOnline";
import { priceOf, type Product } from "./Pos";

type UnitRow = { unit: string; factor: number | ""; barcode: string };
export default function Products() {
  const can = useCan();
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get("q") ?? "");
  const [group, setGroup] = useState(""), [active, setActive] = useState(""), [stock, setStock] = useState("");
  const groups = useAsync(() => get("/product-groups", undefined, { silent: true }).then((r) => items<{ id: number; name: string }>(r)).catch(() => [] as { id: number; name: string }[]), []);
  const list = usePagedList<Product>("/products", { q, groupId: group, active, limit: 100 }, [q, group, active]);
  const [edit, setEdit] = useState<Product | "new" | null>(null);
  const [label, setLabel] = useState<Product | null>(null);
  const costOk = can("prices.view_cost");
  const gname = (id?: number | null) => (id ? groups.data?.find((g) => g.id === id)?.name ?? `#${id}` : "—");
  const low = (p: Product) => p.minStockMilli != null && p.minStockMilli > 0 && (p.availableMilli ?? 0) < p.minStockMilli;
  const rows = list.rows.filter((p) => (stock === "out" ? (p.availableMilli ?? 0) <= 0 : stock === "in" ? (p.availableMilli ?? 0) > 0 : stock === "low" ? low(p) : true));
  const dirty = !!(q || group || active || stock);
  const reset = () => { setQ(""); setGroup(""); setActive(""); setStock(""); };
  const rowsAll = list.rows;
  return (
    <div className="stack">
      <PageHeader compact subtitle={`${rowsAll.length}${list.hasMore ? "+" : ""} mặt hàng${stock ? ` · ${rows.length} khớp lọc tồn` : ""}`}
        actions={<>
          <ExportButton filename="hang-hoa" rows={rows} columns={[
            { label: "SKU", value: (p) => p.sku }, { label: "Tên", value: (p) => p.name }, { label: "Nhóm hàng", value: (p) => gname(p.groupId) }, { label: "Đơn vị", value: (p) => unitLabel(p.baseUnit) },
            { label: "Tồn", value: (p) => (p.availableMilli ?? 0) / 1000 }, { label: "Giá bán", value: (p) => priceOf(p) || "" },
            ...(costOk ? [{ label: "Giá vốn", value: (p: Product) => p.avgCost ?? "" }] : []),
            { label: "Đang bán", value: (p) => (p.active === false || p.active === 0 ? "Không" : "Có") },
          ]} />
          {can("products.write") && <Button variant="soft" onClick={() => navigate("/import?kind=products")}>Nhập từ Excel</Button>}
          {can("products.write") && <Button onClick={() => setEdit("new")}>+ Thêm hàng hoá</Button>}
        </>} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[group, active, stock].filter(Boolean).length} advanced={<>
        <FilterSelect label="Nhóm hàng" value={group} onChange={setGroup} options={(groups.data ?? []).map((g) => ({ v: String(g.id), label: g.name }))} />
        <FilterSelect label="Đang bán" value={active} onChange={setActive} allLabel="Tất cả" options={[{ v: "1", label: "Đang bán" }, { v: "0", label: "Ngưng bán" }]} />
        <FilterSelect label="Tồn kho" value={stock} onChange={setStock} options={[{ v: "in", label: "Còn hàng" }, { v: "low", label: "Dưới tối thiểu" }, { v: "out", label: "Hết hàng" }]} />
      </>}>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên, SKU, mã vạch…" label="Tìm hàng hoá" />
      </FilterBar>
      {list.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(p) => p.id} onRowClick={(p) => (can("products.write") ? setEdit(p) : setLabel(p))} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
          footer={`Đang hiển thị ${rows.length} mặt hàng`}
          emptyState={<EmptyState title={dirty ? "Không có hàng hoá nào khớp bộ lọc" : "Chưa có hàng hoá"} hint={dirty ? "Thử bỏ bớt bộ lọc." : "Thêm hàng hoá để bắt đầu bán và quản lý tồn kho."}
            action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{can("products.write") && <Button onClick={() => setEdit("new")}>+ Thêm hàng hoá</Button>}</div>} />}
          cols={[
            { key: "n", label: "Tên", title: true, sort: (p) => p.name, render: (p) => <><b>{p.name}</b> {!p.active && p.active !== undefined && <Badge>Ngưng bán</Badge>}</> },
            { key: "s", label: "SKU", sort: (p) => p.sku, render: (p) => <span className="num">{p.sku}</span> },
            { key: "g", label: "Nhóm hàng", hideBelow: 1280, sort: (p) => gname(p.groupId), render: (p) => gname(p.groupId) },
            { key: "u", label: "Đơn vị", hideBelow: 1440, render: (p) => <>{unitLabel(p.baseUnit)}{(p.units ?? []).filter((u) => u.unit !== p.baseUnit).map((u) => ` · ${unitLabel(u.unit)}=${u.factorMilli / 1000}${unitLabel(p.baseUnit)}`)}</> },
            { key: "st", label: "Tồn", num: true, sort: (p) => p.availableMilli ?? 0, render: (p) => <span style={{ color: low(p) ? "var(--warn)" : undefined }}>{qtyText(p.availableMilli, p.baseUnit)}{low(p) ? " ⚠" : ""}</span> },
            ...(costOk ? [{ key: "c", label: "Giá vốn", num: true as const, hideBelow: 1024 as const, sort: (p: Product) => p.avgCost ?? 0, render: (p: Product) => (p.avgCost ? money(p.avgCost) : "—") }] : []),
            { key: "p", label: "Giá bán", num: true, sort: (p) => priceOf(p), render: (p) => (priceOf(p) ? money(priceOf(p)) : "—") },
            { key: "l", label: "", render: (p) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setLabel(p); }}>Tem</Button> },
          ]} />
      )}
      {edit && <ProductForm p={edit === "new" ? null : edit} groups={groups.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {label && <LabelSheet p={label} onClose={() => setLabel(null)} />}
    </div>
  );
}

function ProductForm({ p, groups, onClose, onSaved }: { p: Product | null; groups: { id: number; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ groupId: p?.groupId ? String(p.groupId) : "", sku: p?.sku ?? "", name: p?.name ?? "", baseUnit: p?.baseUnit ?? "kg", sellByWeight: !!p?.sellByWeight, origin: p?.origin ?? "", barcode: p?.barcode ?? "", shelfLifeDays: p?.shelfLifeDays ?? ("" as number | ""), minStock: p?.minStockMilli != null ? p.minStockMilli / 1000 : ("" as number | "") });
  const [units, setUnits] = useState<UnitRow[]>((p?.units ?? []).filter((u) => u.unit !== p?.baseUnit).map((u) => ({ unit: u.unit, factor: u.factorMilli / 1000, barcode: u.barcode ?? "" })));
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"info" | "online">("info");
  const can = useCan();
  const [merging, setMerging] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    const body: any = {
      ...(f.groupId ? { groupId: Number(f.groupId) } : {}), sku: f.sku.trim(), name: f.name.trim(), baseUnit: f.baseUnit, sellByWeight: f.sellByWeight,
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
        {groups.length > 0 && <Select label="Nhóm hàng" value={f.groupId} onChange={(e) => set("groupId", e.target.value)}><option value="">— Chưa phân nhóm —</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
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
