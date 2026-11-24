import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, MoneyInput, Segmented, Sheet, Spinner, useAsync } from "../../components/ui";
import { KpiRow, PageHeader } from "../../components/list";
import { toast } from "../../components/toast";
import { money } from "../../format";
import { useCan } from "../../store";
import { TagInput, Toggle, WEEKDAYS } from "./kit";

export default function Zones() {
  const [tab, setTab] = useState<"zones" | "slots">("zones");
  return (
    <div className="stack">
      <PageHeader subtitle="Khu vực nhận giao hàng, phí giao và các khung giờ giao cho đơn online" />
      <Segmented className="tabs-d" value={tab} onChange={setTab} options={[{ v: "zones", label: "Khu vực giao" }, { v: "slots", label: "Khung giờ giao" }]} />
      {tab === "zones" ? <ZoneList /> : <SlotList />}
    </div>
  );
}

function ZoneList() {
  const can = useCan(); const w = can("approvals.decide");
  const l = useAsync(() => get("/delivery-zones").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="stack">
      <KpiRow cols={3} items={[{ label: "Khu vực", value: (l.data ?? []).length }, { label: "Đang giao", value: (l.data ?? []).filter((z) => z.active).length, tone: "ok" }, { label: "Tạm ngưng", value: (l.data ?? []).filter((z) => !z.active).length }]} />
      <div className="row between wrap"><span className="muted small">{w ? "Bấm vào một khu vực để sửa phí giao, quận/huyện." : "Chỉ quản lý/chủ mới sửa được khu vực."}</span>{w && <Button onClick={() => setEdit({})}>+ Thêm khu vực</Button>}</div>
      {l.loading ? <Spinner /> : (
        <div data-testid="zone-list">
          <DataTable rows={l.data ?? []} rowKey={(z) => z.id} onRowClick={w ? setEdit : undefined}
            emptyState={<EmptyState title="Chưa có khu vực giao" hint="Thêm khu vực để khách chọn khi đặt hàng online." action={w ? <Button onClick={() => setEdit({})}>+ Thêm khu vực</Button> : undefined} />}
            cols={[
              { key: "n", label: "Khu vực", title: true, sort: (z) => z.name, render: (z) => <b className="nw">{z.name}</b> },
              { key: "d", label: "Quận/huyện", render: (z) => z.districts.join(", ") },
              { key: "f", label: "Phí giao", num: true, sort: (z) => z.fee, render: (z) => money(z.fee) },
              { key: "o", label: "Miễn phí từ", num: true, hideBelow: 1024, sort: (z) => z.freeOver ?? 0, render: (z) => (z.freeOver ? money(z.freeOver) : "—") },
              { key: "m", label: "Tối thiểu", num: true, hideBelow: 1024, sort: (z) => z.minOrder ?? 0, render: (z) => (z.minOrder ? money(z.minOrder) : "—") },
              { key: "a", label: "Trạng thái", sort: (z) => (z.active ? 0 : 1), render: (z) => (z.active ? <Badge tone="ok">Đang giao</Badge> : <Badge>Tạm ngưng</Badge>) },
            ]} />
        </div>
      )}
      {edit && <ZoneForm z={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); l.reload(); }} />}
    </div>
  );
}
function ZoneForm({ z, onClose, onSaved }: { z: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: z.name ?? "", districts: (z.districts ?? []) as string[], fee: z.fee ?? 0, freeOver: z.freeOver ?? 0, minOrder: z.minOrder ?? 0, active: z.active ?? true });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    const body = { name: f.name.trim(), districts: f.districts, fee: f.fee, freeOver: f.freeOver || null, minOrder: f.minOrder, active: f.active };
    try { if (z.id) await put(`/delivery-zones/${z.id}`, body); else await post("/delivery-zones", body); toast("Đã lưu khu vực", "ok"); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={z.id ? "Sửa khu vực" : "Thêm khu vực"} footer={<Button block loading={busy} disabled={!f.name.trim() || !f.districts.length} onClick={save}>Lưu khu vực</Button>}>
      <div className="stack">
        <Input label="Tên khu vực" value={f.name} onChange={(e) => set("name", e.target.value)} />
        <TagInput label="Quận/huyện" value={f.districts} onChange={(v) => set("districts", v)} />
        <MoneyInput label="Phí giao (₫)" value={f.fee} onChange={(n) => set("fee", n)} />
        <MoneyInput label="Miễn phí từ đơn (₫, 0 = không)" value={f.freeOver} onChange={(n) => set("freeOver", n)} />
        <MoneyInput label="Đơn tối thiểu (₫)" value={f.minOrder} onChange={(n) => set("minOrder", n)} />
        <Toggle label="Đang nhận giao" checked={f.active} onChange={(v) => set("active", v)} />
      </div>
    </Sheet>
  );
}

function SlotList() {
  const can = useCan(); const w = can("approvals.decide");
  const l = useAsync(() => get("/delivery-slots").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="stack">
      <div className="row between wrap"><span className="muted small">{w ? "Bấm vào một khung giờ để sửa." : "Chỉ quản lý/chủ mới sửa được khung giờ."}</span>{w && <Button onClick={() => setEdit({})}>+ Thêm khung giờ</Button>}</div>
      {!w && <Banner tone="info">Chỉ quản lý/chủ mới sửa được khu vực và khung giờ.</Banner>}
      {l.loading ? <Spinner /> : (
        <div data-testid="slot-list">
          <DataTable rows={l.data ?? []} rowKey={(s) => s.id} onRowClick={w ? setEdit : undefined}
            emptyState={<EmptyState title="Chưa có khung giờ" hint="Thêm khung giờ để khách hẹn giờ nhận hàng." action={w ? <Button onClick={() => setEdit({})}>+ Thêm khung giờ</Button> : undefined} />}
            cols={[
              { key: "n", label: "Khung giờ", title: true, sort: (s) => s.startTime, render: (s) => <b>{s.label}</b> },
              { key: "t", label: "Thời gian", render: (s) => `${s.startTime}–${s.endTime}` },
              { key: "c", label: "Tối đa", num: true, sort: (s) => s.capacity, render: (s) => `${s.capacity} đơn` },
              { key: "u", label: "Chốt trước", num: true, hideBelow: 1024, render: (s) => `${s.cutoffMinutes} phút` },
              { key: "w", label: "Ngày", render: (s) => WEEKDAYS.filter(([n]) => s.weekdays.includes(n)).map(([, t]) => t).join(" ") },
              { key: "a", label: "Trạng thái", render: (s) => (s.active ? <Badge tone="ok">Đang mở</Badge> : <Badge>Tạm ngưng</Badge>) },
            ]} />
        </div>
      )}
      {edit && <SlotForm s={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); l.reload(); }} />}
    </div>
  );
}
function SlotForm({ s, onClose, onSaved }: { s: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ label: s.label ?? "", startTime: s.startTime ?? "08:00", endTime: s.endTime ?? "10:00", cutoffMinutes: s.cutoffMinutes ?? 90, capacity: s.capacity ?? 20, weekdays: (s.weekdays ?? [1, 2, 3, 4, 5, 6, 7]) as number[], active: s.active ?? true });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try { if (s.id) await put(`/delivery-slots/${s.id}`, { ...f, label: f.label.trim() }); else await post("/delivery-slots", { ...f, label: f.label.trim() }); toast("Đã lưu khung giờ", "ok"); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={s.id ? "Sửa khung giờ" : "Thêm khung giờ"} footer={<Button block loading={busy} disabled={!f.label.trim() || !f.weekdays.length || f.endTime <= f.startTime} onClick={save}>Lưu khung giờ</Button>}>
      <div className="stack">
        <Input label="Tên khung giờ" value={f.label} onChange={(e) => set("label", e.target.value)} />
        <div className="grid2"><Input label="Từ" type="time" value={f.startTime} onChange={(e) => set("startTime", e.target.value)} /><Input label="Đến" type="time" value={f.endTime} onChange={(e) => set("endTime", e.target.value)} /></div>
        <div className="grid2"><DecInput label="Chốt nhận đơn trước (phút)" value={f.cutoffMinutes} onChange={(n) => set("cutoffMinutes", Math.round(n))} /><DecInput label="Số đơn tối đa" value={f.capacity} onChange={(n) => set("capacity", Math.round(n))} /></div>
        <div className="field"><span className="lbl">Ngày trong tuần</span>
          <div className="chips">{WEEKDAYS.map(([n, t]) => <button key={n} type="button" className="chip" aria-pressed={f.weekdays.includes(n)} onClick={() => set("weekdays", f.weekdays.includes(n) ? f.weekdays.filter((x) => x !== n) : [...f.weekdays, n].sort())}>{t}</button>)}</div>
        </div>
        <Toggle label="Đang mở" checked={f.active} onChange={(v) => set("active", v)} />
      </div>
    </Sheet>
  );
}
export { Card };
