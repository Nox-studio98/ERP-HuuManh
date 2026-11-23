import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DecInput, EmptyState, Input, MoneyInput, Segmented, Sheet, Spinner, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { money } from "../../format";
import { useCan } from "../../store";
import { TagInput, Toggle, WEEKDAYS } from "./kit";

export default function Zones() {
  const [tab, setTab] = useState<"zones" | "slots">("zones");
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={[{ v: "zones", label: "Khu vực giao" }, { v: "slots", label: "Khung giờ giao" }]} />
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
      {w && <div className="row"><Button onClick={() => setEdit({})}>+ Thêm khu vực</Button></div>}
      {l.loading ? <Spinner /> : !(l.data ?? []).length ? <EmptyState title="Chưa có khu vực giao" /> : (
        <div className="stack" data-testid="zone-list">
          {l.data!.map((z) => (
            <button key={z.id} className="dt-card" disabled={!w} onClick={() => setEdit(z)}>
              <div className="row between"><b>{z.name}</b>{z.active ? <Badge tone="ok">Đang giao</Badge> : <Badge>Tạm ngưng</Badge>}</div>
              <div className="small">{z.districts.join(", ")}</div>
              <div className="small muted">Phí {money(z.fee)}{z.freeOver ? ` · miễn phí từ ${money(z.freeOver)}` : ""}{z.minOrder ? ` · tối thiểu ${money(z.minOrder)}` : ""}</div>
            </button>
          ))}
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
      {w && <div className="row"><Button onClick={() => setEdit({})}>+ Thêm khung giờ</Button></div>}
      {!w && <Banner tone="info">Chỉ quản lý/chủ mới sửa được khu vực và khung giờ.</Banner>}
      {l.loading ? <Spinner /> : !(l.data ?? []).length ? <EmptyState title="Chưa có khung giờ" /> : (
        <div className="stack" data-testid="slot-list">
          {l.data!.map((s) => (
            <button key={s.id} className="dt-card" disabled={!w} onClick={() => setEdit(s)}>
              <div className="row between"><b>{s.label}</b>{s.active ? <Badge tone="ok">Đang mở</Badge> : <Badge>Tạm ngưng</Badge>}</div>
              <div className="small">{s.startTime}–{s.endTime} · tối đa {s.capacity} đơn · chốt trước {s.cutoffMinutes} phút</div>
              <div className="small muted">{WEEKDAYS.filter(([n]) => s.weekdays.includes(n)).map(([, t]) => t).join(" ")}</div>
            </button>
          ))}
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
