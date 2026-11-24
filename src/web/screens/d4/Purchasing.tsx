import { useMemo, useState } from "react";
import { ApiError, get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, EmptyState, Input, Select, Sheet, Spinner, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { money, qtyText, unitLabel } from "../../format";
import { navigate } from "../../router";
import { useCan } from "../../store";
import { ProductPicker, Tile, useCatalog, type Prod } from "./shared";

type Sug = {
  productId: number; name: string; baseUnit: string; onHandMilli: number; reservedMilli: number; expiringMilli: number; avgDailySalesMilli: number; daysCover: number | null;
  leadTimeDays: number; orderUnit: string; orderQty: number; suggestedMilli: number; supplierId: number; supplierName: string; lastCost: number | null;
};

export default function Purchasing() {
  const can = useCan();
  const sup = useAsync(() => get("/suppliers").then((r) => items<any>(r)), []);
  const [supplierId, setSupplierId] = useState("");
  const [needed, setNeeded] = useState(true);
  const sug = useAsync(() => get("/purchasing/suggestions", { supplierId, onlyNeeded: needed ? 1 : "" }).then((r) => items<Sug>(r)), [supplierId, needed]);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState("");
  const [made, setMade] = useState<{ code: string; id: number; total: number } | null>(null);
  const [ps, setPs] = useState<{ id: number; name: string } | null>(null);
  const [pick, setPick] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<number, { name: string; rows: Sug[] }>();
    for (const r of sug.data ?? []) { const g = m.get(r.supplierId) ?? { name: r.supplierName, rows: [] }; g.rows.push(r); m.set(r.supplierId, g); }
    return [...m.entries()];
  }, [sug.data]);
  const factor = (r: Sug) => (r.orderQty > 0 ? r.suggestedMilli / r.orderQty : 1000);
  const qtyOf = (r: Sug) => qty[r.productId] ?? r.orderQty;
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const canReceipt = can("inventory.write");

  const create = async (supplierId: number, rows: Sug[]) => {
    const lines = rows.filter((r) => sel.has(r.productId) && qtyOf(r) > 0);
    if (!lines.length) return toast("Chọn ít nhất một dòng có số lượng > 0", "error");
    setBusy(String(supplierId));
    try {
      const r = await post("/purchasing/suggestions/to-receipt", { supplierId, lines: lines.map((l) => ({ productId: l.productId, qtyMilli: Math.round(qtyOf(l) * factor(l)) })) }, { silent: true });
      setMade({ code: r.code, id: r.id, total: r.totalAmount });
      setSel((s) => { const n = new Set(s); lines.forEach((l) => n.delete(l.productId)); return n; });
      toast(`Đã tạo phiếu nhập nháp ${r.code}`, "ok");
    } catch (e) { if (e instanceof ApiError) toast(e.code === "missing_cost" ? "Có mặt hàng chưa có giá nhập — hãy nhập thủ công ở màn Kho." : e.message, "error"); } finally { setBusy(""); }
  };

  const needCount = (sug.data ?? []).filter((r) => r.suggestedMilli > 0).length;
  const low = (sug.data ?? []).filter((r) => r.daysCover != null && r.daysCover < r.leadTimeDays).length;
  return (
    <div className="stack d4">
      <div className="page-head"><h1 style={{ margin: 0 }}>Gợi ý đặt hàng</h1><Button size="sm" variant="soft" onClick={() => setPick(true)}>NCC theo sản phẩm</Button></div>
      <div className="tiles"><Tile label="Mặt hàng cần đặt" value={needCount} /><Tile label="Sắp hết trước khi hàng về" value={low} tone={low ? "danger" : undefined} /><Tile label="Đang chọn" value={sel.size} /><Tile label="Nhà cung cấp" value={groups.length} /></div>
      <div className="grid2">
        <Select label="Nhà cung cấp" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Tất cả</option>{(sup.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <label className="row" style={{ alignSelf: "flex-end", minHeight: 44 }}><input type="checkbox" checked={needed} onChange={(e) => setNeeded(e.target.checked)} />Chỉ hàng cần đặt</label>
      </div>
      {made && <Banner tone="info">Đã tạo phiếu nhập nháp <b>{made.code}</b> ({money(made.total)}). <Button size="sm" variant="soft" onClick={() => navigate("/inventory")}>Mở trong Kho</Button> — kiểm tra rồi ghi sổ khi hàng về.</Banner>}
      {sug.loading ? <Spinner /> : groups.length === 0 ? <EmptyState title="Không có mặt hàng cần đặt" hint="Hàng đủ tồn theo tốc độ bán gần đây, hoặc chưa gắn nhà cung cấp cho sản phẩm." /> : groups.map(([id, g]) => {
        const chosen = g.rows.filter((r) => sel.has(r.productId));
        return (
          <Card key={id} title={g.name} actions={<span className="small muted">{g.rows.length} mặt hàng</span>}>
            <div className="scrollx"><table className="tbl">
              <thead><tr><th /><th>Sản phẩm</th><th className="r">Tồn</th><th className="r">Giữ</th><th className="r">Bán/ngày</th><th className="r">Còn đủ</th><th className="r">Đề xuất</th></tr></thead>
              <tbody>{g.rows.map((r) => (
                <tr key={r.productId}>
                  <td><input type="checkbox" aria-label={`Chọn ${r.name}`} checked={sel.has(r.productId)} onChange={() => toggle(r.productId)} /></td>
                  <td><b>{r.name}</b><div className="small muted">Về sau {r.leadTimeDays} ngày{r.lastCost ? ` · giá nhập ${money(r.lastCost)}` : " · chưa có giá nhập"}{r.expiringMilli > 0 ? ` · ${qtyText(r.expiringMilli, r.baseUnit)} sắp hết hạn` : ""}</div></td>
                  <td className="r">{qtyText(r.onHandMilli, r.baseUnit)}</td><td className="r">{qtyText(r.reservedMilli)}</td>
                  <td className="r">{qtyText(r.avgDailySalesMilli)}</td>
                  <td className="r">{r.daysCover == null ? "—" : <Badge tone={r.daysCover < r.leadTimeDays ? "danger" : r.daysCover < r.leadTimeDays + 2 ? "warn" : "ok"}>{r.daysCover} ngày</Badge>}</td>
                  <td className="r"><div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                    <input className="input num" style={{ width: 72, minHeight: 36, textAlign: "right" }} aria-label={`Số lượng đặt ${r.name}`} inputMode="decimal" value={qtyOf(r)} onChange={(e) => setQty({ ...qty, [r.productId]: Number(e.target.value.replace(",", ".")) || 0 })} />
                    <span className="muted">{unitLabel(r.orderUnit)}</span></div></td>
                </tr>))}</tbody>
            </table></div>
            <div className="row between" style={{ marginTop: 12 }}>
              <span className="small muted">{chosen.length ? `Đã chọn ${chosen.length} dòng` : "Tick các dòng cần đặt"}</span>
              <div className="row"><Button size="sm" variant="ghost" onClick={() => setSel((s) => { const n = new Set(s); g.rows.forEach((r) => (r.suggestedMilli > 0 ? n.add(r.productId) : 0)); return n; })}>Chọn dòng cần đặt</Button>
                <Button loading={busy === String(id)} disabled={!canReceipt || !chosen.length} onClick={() => create(id, g.rows)}>Tạo phiếu nhập nháp</Button></div>
            </div>
          </Card>);
      })}
      <div className="hint">Đề xuất = tốc độ bán × (thời gian giao + số ngày dự trữ) − tồn khả dụng, làm tròn lên theo đơn vị đặt. Hàng sắp hết hạn trước khi hàng mới về không tính vào tồn. Cài đặt: <code>reorder.lookback_days</code>, <code>reorder.cover_days</code>.</div>
      <ProductPicker open={pick} onClose={() => setPick(false)} title="Chọn sản phẩm để cài NCC" onPick={(p) => setPs({ id: p.id, name: p.name })} />
      {ps && <SupplierSettings product={ps} suppliers={sup.data ?? []} canWrite={can("products.write")} onClose={() => setPs(null)} onSaved={() => { setPs(null); sug.reload(); }} />}
    </div>
  );
}

type PS = { supplierId: number; leadTimeDays: number; orderUnit: string; minOrder: number; preferred: boolean };
function SupplierSettings({ product, suppliers, canWrite, onClose, onSaved }: { product: { id: number; name: string }; suppliers: any[]; canWrite: boolean; onClose: () => void; onSaved: () => void }) {
  const cat = useCatalog();
  const p = cat.byId.get(product.id) as Prod | undefined;
  const [rows, setRows] = useState<PS[] | null>(null);
  const load = useAsync(async () => { const r = await get("/product-suppliers", { productId: product.id }); setRows(items<any>(r).map((x) => ({ supplierId: x.supplierId, leadTimeDays: x.leadTimeDays, orderUnit: x.orderUnit ?? "", minOrder: x.minOrderMilli / 1000, preferred: x.preferred }))); return 1; }, []);
  const units = p ? [p.baseUnit, ...(p.units ?? []).map((u) => u.unit).filter((u) => u !== p.baseUnit)] : ["kg"];
  const set = (i: number, patch: Partial<PS>) => setRows((x) => x!.map((r, j) => (j === i ? { ...r, ...patch } : patch.preferred ? { ...r, preferred: false } : r)));
  const save = async () => {
    try { await put(`/product-suppliers?productId=${product.id}`, { items: rows!.map((r) => ({ supplierId: r.supplierId, leadTimeDays: r.leadTimeDays, orderUnit: r.orderUnit || null, minOrderMilli: Math.round(r.minOrder * 1000), preferred: r.preferred })) }); toast("Đã lưu nhà cung cấp", "ok"); onSaved(); } catch {}
  };
  return (
    <Sheet open onClose={onClose} title={`NCC: ${product.name}`} footer={canWrite ? <Button block onClick={save} disabled={!rows}>Lưu</Button> : undefined}>
      {load.loading || !rows ? <Spinner /> : (
        <div className="stack">
          {rows.map((r, i) => (
            <Card key={i}>
              <div className="stack">
                <Select label="Nhà cung cấp" value={r.supplierId} onChange={(e) => set(i, { supplierId: Number(e.target.value) })}>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                <div className="grid3"><Input label="Ngày giao" type="number" min={0} max={60} value={r.leadTimeDays} onChange={(e) => set(i, { leadTimeDays: Number(e.target.value) })} /><Select label="Đơn vị đặt" value={r.orderUnit} onChange={(e) => set(i, { orderUnit: e.target.value })}><option value="">Đơn vị chính</option>{units.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}</Select><Input label="Đặt tối thiểu" type="number" min={0} value={r.minOrder} onChange={(e) => set(i, { minOrder: Number(e.target.value) })} /></div>
                <div className="row between"><label className="row"><input type="checkbox" checked={r.preferred} onChange={(e) => set(i, { preferred: e.target.checked })} />NCC ưu tiên</label><Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Bỏ</Button></div>
              </div>
            </Card>))}
          {canWrite && <Button variant="soft" onClick={() => setRows([...rows, { supplierId: suppliers.find((s) => !rows.some((r) => r.supplierId === s.id))?.id ?? suppliers[0]?.id, leadTimeDays: 1, orderUnit: "", minOrder: 0, preferred: rows.length === 0 }])}>+ Thêm nhà cung cấp</Button>}
          {!canWrite && <div className="hint">Cần quyền sửa hàng hoá để đổi nhà cung cấp.</div>}
        </div>)}
    </Sheet>
  );
}
