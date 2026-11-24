import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Button, Card, EmptyState, Input, Select, Sheet, Spinner, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput } from "../../components/list";
import { todayVN } from "../../format";
import { CustomerSelect, LinesEditor, linePayload, qtyU, ymd, type CustomerLite, type EditLine } from "./kit";

/** Thứ trong tuần theo ISO: 1 = Thứ 2 … 7 = Chủ nhật */
const WD: [number, string][] = [[1, "T2"], [2, "T3"], [3, "T4"], [4, "T5"], [5, "T6"], [6, "T7"], [7, "CN"]];
const wdText = (w: number[]) => (w.length === 7 ? "Hằng ngày" : WD.filter(([n]) => w.includes(n)).map(([, l]) => l).join(", "));

export default function Recurring() {
  const list = useAsync(() => get("/b2b/recurring").then((r) => items<any>(r)), []);
  const [q, setQ] = useState(""), [cust, setCust] = useState(""), [act, setAct] = useState("");
  const all = list.data ?? [];
  const rows = all.filter((r) => (!cust || String(r.customerId) === cust) && (!act || (act === "1") === !!r.active) && (!q.trim() || `${r.customerName} ${r.lines.map((l: any) => l.productName ?? "").join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())));
  const custOpts = [...new Map(all.map((r) => [r.customerId, r.customerName])).entries()].map(([v, label]) => ({ v: String(v), label: String(label) }));
  const dirty = !!(q || cust || act);
  const reset = () => { setQ(""); setCust(""); setAct(""); };
  const [edit, setEdit] = useState<any | "new" | null>(null);
  const [gen, setGen] = useState<any | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const toggle = async (r: any) => {
    setBusy(r.id);
    try { await put(`/b2b/recurring/${r.id}`, { active: !r.active }); toast(r.active ? "Đã tắt mẫu đơn lặp" : "Đã bật mẫu đơn lặp", "ok"); list.reload(); } catch {} finally { setBusy(null); }
  };
  return (
    <div className="stack" data-testid="recurring">
      <PageHeader compact subtitle="Mẫu đơn tự sinh lúc 08:00 cho ngày giao hôm sau theo các thứ đã chọn." actions={<Button onClick={() => setEdit("new")}>+ Mẫu đơn lặp</Button>} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[cust, act].filter(Boolean).length} advanced={<>
        <FilterSelect label="Khách hàng" value={cust} onChange={setCust} options={custOpts} />
        <FilterSelect label="Trạng thái" value={act} onChange={setAct} options={[{ v: "1", label: "Đang chạy" }, { v: "0", label: "Đã tắt" }]} />
      </>}>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên khách, mặt hàng…" label="Tìm mẫu đơn lặp" />
      </FilterBar>
      <KpiRow cols={3} items={[
        { label: "Mẫu đơn lặp", value: all.length }, { label: "Đang chạy", value: all.filter((r) => r.active).length, tone: "ok" }, { label: "Đã tắt", value: all.filter((r) => !r.active).length },
      ]} />
      {list.loading ? <Spinner /> : !all.length ? <Card><EmptyState title="Chưa có mẫu đơn lặp" hint="Tạo mẫu cho khách đặt hàng đều đặn mỗi tuần." action={<Button onClick={() => setEdit("new")}>+ Mẫu đơn lặp</Button>} /></Card> : !rows.length ? <Card><EmptyState title="Không có mẫu nào khớp bộ lọc" action={<Button variant="soft" onClick={reset}>Xoá lọc</Button>} /></Card> : (
       <div className="cards-grid">{
        rows.map((r) => (
          <Card key={r.id} className="flat">
            <div className="row between wrap">
              <b>{r.customerName}</b>
              <Badge tone={r.active ? "ok" : "warn"}>{r.active ? "Đang chạy" : "Đã tắt"}</Badge>
            </div>
            <div className="small" style={{ marginTop: 4 }}>{wdText(r.weekdays)} · {r.lines.length} mặt hàng{r.lastGeneratedFor ? ` · sinh gần nhất cho ${ymd(r.lastGeneratedFor)}` : ""}</div>
            <div className="small muted">{r.lines.map((l: any) => `${l.productName ?? "#" + l.productId} ${qtyU(l.qty, l.unit)}`).join(" · ")}</div>
            <div className="row wrap" style={{ marginTop: 8 }}>
              <Button size="sm" variant="soft" onClick={() => setEdit(r)}>Sửa</Button>
              <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => toggle(r)}>{r.active ? "Tắt" : "Bật"}</Button>
              <Button size="sm" disabled={!r.active} onClick={() => setGen(r)}>Tạo đơn ngay</Button>
            </div>
          </Card>
        ))
       }</div>
      )}
      {edit && <RecurForm tpl={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {gen && <GenSheet tpl={gen} onClose={() => setGen(null)} onDone={() => { setGen(null); list.reload(); }} />}
    </div>
  );
}

function GenSheet({ tpl, onClose, onDone }: { tpl: any; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayVN(1));
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Tạo đơn từ mẫu lặp" footer={<Button block size="lg" loading={busy} disabled={!date} onClick={async () => {
      setBusy(true);
      try { const r = await post(`/b2b/recurring/${tpl.id}/generate`, { deliveryDate: date }); toast(`Đã tạo đơn ${r.code}`, "ok"); onDone(); } catch {} finally { setBusy(false); }
    }}>Tạo đơn</Button>}>
      <div className="stack">
        <div><b>{tpl.customerName}</b><div className="small muted">{wdText(tpl.weekdays)}</div></div>
        <Input label="Ngày giao" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="hint">Bấm lại cùng ngày sẽ không tạo thêm đơn trùng.</div>
      </div>
    </Sheet>
  );
}

function RecurForm({ tpl, onClose, onSaved }: { tpl: any | null; onClose: () => void; onSaved: () => void }) {
  const [cust, setCust] = useState<any>(null);
  const [addr, setAddr] = useState<string>(tpl ? String(tpl.addressId) : "");
  const [days, setDays] = useState<number[]>(tpl?.weekdays ?? []);
  const [active, setActive] = useState<boolean>(tpl?.active ?? true);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [busy, setBusy] = useState(false);
  const cid: number | undefined = tpl?.customerId ?? cust?.id;
  // Tải khách (để lấy địa chỉ + nhóm giá) và dựng lại dòng hàng khi sửa
  const boot = useAsync(async () => {
    if (!tpl) return null;
    const c = await get(`/customers/${tpl.customerId}`, undefined, { silent: true });
    setCust(c);
    const built: EditLine[] = [];
    for (const l of tpl.lines) {
      try {
        const p = await get(`/products/${l.productId}`, undefined, { silent: true });
        built.push({ key: `${l.productId}-${built.length}`, product: p, unit: l.unit, qty: l.qty, unitPrice: 0, listPrice: null });
      } catch { /* hàng không còn xem được */ }
    }
    setLines(built);
    return c;
  }, [tpl?.id]);
  const pick = async (c: CustomerLite | null) => {
    if (!c) { setCust(null); return; }
    try { setCust(await get(`/customers/${c.id}`)); } catch { setCust(null); }
    setLines([]); setAddr("");
  };
  const addrs = (cust?.addresses ?? []).filter((a: any) => a.active);
  const addrId = addr || String(addrs.find((a: any) => a.isDefault)?.id ?? addrs[0]?.id ?? "");
  const ready = !!cid && !!addrId && days.length > 0 && lines.length > 0 && lines.every((l) => l.qty > 0);
  const save = async () => {
    setBusy(true);
    try {
      const body = { addressId: Number(addrId), weekdays: days, lines: linePayload(lines, false), active };
      if (tpl) await put(`/b2b/recurring/${tpl.id}`, body); else await post("/b2b/recurring", { customerId: cid, ...body });
      toast(tpl ? "Đã lưu mẫu đơn lặp" : "Đã tạo mẫu đơn lặp", "ok"); onSaved();
    } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet open wide onClose={onClose} title={tpl ? "Sửa đơn lặp" : "Mẫu đơn lặp mới"} footer={<Button block size="lg" loading={busy} disabled={!ready} onClick={save}>Lưu</Button>}>
      {boot.loading ? <Spinner /> : (
        <div className="stack">
          {tpl ? <div className="field"><span className="lbl">Khách hàng</span><div className="card flat" style={{ padding: "8px 12px" }}><b>{tpl.customerName}</b></div></div> : <CustomerSelect value={cust} onChange={pick} />}
          {cust && (
            <>
              <Select label="Địa chỉ giao" value={addrId} onChange={(e) => setAddr(e.target.value)}>{addrs.map((a: any) => <option key={a.id} value={a.id}>{a.label} — {a.address}</option>)}</Select>
              <div className="field"><span className="lbl">Lặp vào các thứ</span>
                <div className="chips" role="group" aria-label="Các thứ trong tuần">
                  {WD.map(([n, l]) => <button key={n} type="button" className="chip" aria-pressed={days.includes(n)} onClick={() => setDays(days.includes(n) ? days.filter((x) => x !== n) : [...days, n].sort())}>{l}</button>)}
                </div>
              </div>
              <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Đang chạy (tự sinh đơn)</label>
              <LinesEditor lines={lines} setLines={setLines} groupId={cust.customerGroupId} customerId={cust.id} allowPrice={false} showCost={false} />
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
