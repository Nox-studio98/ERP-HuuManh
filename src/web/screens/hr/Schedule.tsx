import { useMemo, useState } from "react";
import { get, items, post, put, del } from "../../api";
import { Badge, Banner, Button, Card, Input, Segmented, Select, Sheet, Spinner, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { todayVN } from "../../format";
import { useCan } from "../../store";
import { Confirm, REQ_STATUS, WD_SHORT, addDaysS, dm, mondayOf, reqTone, vnTime } from "./kit";

type Tab = "week" | "swaps" | "templates";
export default function Schedule() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>("week");
  const w = can("hr.schedule");
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={[{ v: "week", label: "Lịch tuần" }, ...(w ? [{ v: "swaps" as Tab, label: "Đổi ca" }] : []), { v: "templates", label: "Mẫu ca" }]} />
      {tab === "week" && <Week write={w} />}
      {tab === "swaps" && <Swaps />}
      {tab === "templates" && <Templates write={w} />}
    </div>
  );
}

const cellKey = (e: number, d: string) => `${e}|${d}`;

function Week({ write }: { write: boolean }) {
  const [start, setStart] = useState(mondayOf(todayVN()));
  const days = Array.from({ length: 7 }, (_, i) => addDaysS(start, i));
  const emps = useAsync(() => get("/employees", { status: "active", limit: 200 }).then((r) => items<any>(r)), []);
  const tpls = useAsync(() => get("/shift-templates").then((r) => items<any>(r)), []);
  const sch = useAsync(() => get("/schedule", { from: start, to: addDaysS(start, 6) }).then((r) => items<any>(r)), [start]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [tpl, setTpl] = useState("");
  const [busy, setBusy] = useState(false);
  const [chip, setChip] = useState<any>(null);
  const map = useMemo(() => { const m = new Map<string, any[]>(); for (const s of sch.data ?? []) { const k = cellKey(s.employeeId, s.workDate); m.set(k, [...(m.get(k) ?? []), s]); } return m; }, [sch.data]);
  const activeTpls = (tpls.data ?? []).filter((t) => t.active);
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const bulk = async (list: { employeeId: number; workDate: string; shiftTemplateId: number }[]) => {
    setBusy(true);
    try { const r = await post("/schedule/bulk", { assignments: list }); toast(`Đã gán ${r.created} ca${r.skipped ? `, bỏ qua ${r.skipped} ca đã có` : ""}`, "ok"); setSel(new Set()); sch.reload(); } catch { /* toast */ } finally { setBusy(false); }
  };
  const assign = () => {
    const t = Number(tpl || activeTpls[0]?.id);
    bulk([...sel].map((k) => { const [e, d] = k.split("|"); return { employeeId: Number(e), workDate: d, shiftTemplateId: t }; }));
  };
  const copyPrev = async () => {
    try {
      const prev = items<any>(await get("/schedule", { from: addDaysS(start, -7), to: addDaysS(start, -1) }));
      if (!prev.length) { toast("Tuần trước chưa có ca để sao chép", "info"); return; }
      const list = prev.filter((p) => (emps.data ?? []).some((e) => e.id === p.employeeId)).map((p) => ({ employeeId: p.employeeId, workDate: addDaysS(p.workDate, 7), shiftTemplateId: p.shiftTemplateId }));
      await bulk(list);
    } catch { /* toast */ }
  };
  const today = todayVN();
  if (emps.loading || tpls.loading) return <Spinner />;
  return (
    <div className="stack">
      <div className="row wrap between">
        <div className="row">
          <Button size="sm" variant="ghost" aria-label="Tuần trước" onClick={() => { setStart(addDaysS(start, -7)); setSel(new Set()); }}>‹</Button>
          <b data-testid="week-label">{dm(start)} – {dm(addDaysS(start, 6))}</b>
          <Button size="sm" variant="ghost" aria-label="Tuần sau" onClick={() => { setStart(addDaysS(start, 7)); setSel(new Set()); }}>›</Button>
          <Button size="sm" variant="ghost" onClick={() => setStart(mondayOf(today))}>Tuần này</Button>
        </div>
        {write && <Button size="sm" variant="soft" loading={busy} onClick={copyPrev}>Sao chép tuần trước</Button>}
      </div>
      {write && <div className="hint">Chạm vào ô trống để chọn nhiều ô, rồi chọn ca và bấm “Gán ca”. Chạm vào ca để huỷ.</div>}
      {write && sel.size > 0 && (
        <div className="card stack" style={{ position: "sticky", top: 8, zIndex: 5, gap: 8, padding: 12 }} data-testid="assign-bar">
          <div className="row"><b className="grow">Đã chọn {sel.size} ô</b><Button size="sm" loading={busy} disabled={!activeTpls.length} onClick={assign}>Gán ca</Button><Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Bỏ chọn</Button></div>
          <Select label="Ca sẽ gán" value={tpl || String(activeTpls[0]?.id ?? "")} onChange={(e) => setTpl(e.target.value)}>{activeTpls.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.startTime}–{t.endTime})</option>)}</Select>
        </div>
      )}
      {(emps.data ?? []).length === 0 ? <Banner tone="info">Chưa có nhân viên đang làm.</Banner> : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }} data-testid="week-grid">
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: "var(--surface)", textAlign: "left", padding: 8, minWidth: 96, maxWidth: 96, zIndex: 1 }}>Nhân viên</th>
                {days.map((d) => <th key={d} style={{ padding: 6, fontSize: ".8rem", background: d === today ? "var(--accent-soft)" : undefined }}>{WD_SHORT[days.indexOf(d)]}<div className="muted">{dm(d)}</div></th>)}
              </tr>
            </thead>
            <tbody>
              {emps.data!.map((e) => (
                <tr key={e.id}>
                  <th style={{ position: "sticky", left: 0, background: "var(--surface)", textAlign: "left", padding: "8px 6px", fontWeight: 600, fontSize: ".78rem", lineHeight: 1.2, borderTop: "1px solid var(--border)", zIndex: 1, maxWidth: 96, overflow: "hidden", overflowWrap: "anywhere" }} title={e.fullName}>{e.fullName}</th>
                  {days.map((d) => {
                    const k = cellKey(e.id, d), list = map.get(k) ?? [], on = sel.has(k);
                    return (
                      <td key={d} data-cell={k} onClick={() => write && toggle(k)} style={{ borderTop: "1px solid var(--border)", borderLeft: "1px solid var(--border)", padding: 3, verticalAlign: "top", minWidth: 64, height: 54, cursor: write ? "pointer" : undefined, background: on ? "var(--accent-soft)" : undefined, outline: on ? "2px solid var(--accent)" : undefined, outlineOffset: -2 }}>
                        {list.map((s) => (
                          <button key={s.id} className="badge info" data-chip={s.id} style={{ border: 0, cursor: write ? "pointer" : "default", display: "block", width: "100%", marginBottom: 2, textAlign: "left", fontSize: ".72rem", padding: "2px 6px" }}
                            onClick={(ev) => { ev.stopPropagation(); if (write) setChip(s); }}>
                            {s.shiftName}<br />{vnTime(s.startAt)}
                          </button>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {chip && (
        <Confirm title="Huỷ ca làm" danger confirmLabel="Huỷ ca" onClose={() => setChip(null)}
          onConfirm={async () => { try { await del("/schedule/" + chip.id); toast("Đã huỷ ca", "ok"); setChip(null); sch.reload(); } catch { /* toast */ } }}>
          <div><b>{chip.employeeName}</b> · {chip.shiftName} · {dm(chip.workDate)} ({vnTime(chip.startAt)}–{vnTime(chip.endAt)})</div>
          <div className="muted small">Ca bị huỷ vẫn được lưu vết, không xoá khỏi lịch sử.</div>
        </Confirm>
      )}
    </div>
  );
}

function Swaps() {
  const today = todayVN();
  const l = useAsync(() => get("/schedule/swaps").then((r) => items<any>(r)), []);
  const emps = useAsync(() => get("/employees", { limit: 200 }).then((r) => items<any>(r)), []);
  const sch = useAsync(() => get("/schedule", { from: addDaysS(today, -30), to: addDaysS(today, 60) }).then((r) => items<any>(r)), []);
  const name = (id: number) => emps.data?.find((e) => e.id === id)?.fullName ?? `NV #${id}`;
  const asg = (id?: number | null) => { const a = sch.data?.find((x) => x.id === id); return a ? `${a.shiftName} ${dm(a.workDate)}` : id ? `ca #${id}` : "—"; };
  const [busy, setBusy] = useState<number | null>(null);
  const decide = async (id: number, decision: string) => {
    setBusy(id);
    try { await post(`/schedule/swaps/${id}/decide`, { decision }); toast(decision === "approved" ? "Đã duyệt đổi ca" : "Đã từ chối", "ok"); l.reload(); sch.reload(); } catch { /* toast */ } finally { setBusy(null); }
  };
  if (l.loading) return <Spinner />;
  const rows = l.data ?? [];
  return (
    <div className="stack">
      {!rows.length && <Card><div className="muted">Chưa có yêu cầu đổi ca.</div></Card>}
      {rows.map((s) => {
        const wait = ["pending", "accepted"].includes(s.status);
        const from = sch.data?.find((x) => x.id === s.fromAssignmentId);
        return (
          <Card key={s.id}>
            <div className="stack" style={{ gap: 6 }}>
              <div className="row between"><b>{from ? name(from.employeeId) : "NV"} → {name(s.toEmployeeId)}</b><Badge tone={reqTone(s.status)}>{s.status === "pending" ? "Chờ NV nhận ca" : REQ_STATUS[s.status] ?? s.status}</Badge></div>
              <div className="small">Ca đổi: {asg(s.fromAssignmentId)}{s.toAssignmentId ? ` ⇄ ${asg(s.toAssignmentId)}` : ""}</div>
              <div className="small muted">Lý do: {s.reason}</div>
              {wait && <div className="row"><Button size="sm" loading={busy === s.id} disabled={s.status !== "accepted"} onClick={() => decide(s.id, "approved")}>Duyệt</Button><Button size="sm" variant="ghost" onClick={() => decide(s.id, "rejected")}>Từ chối</Button></div>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Templates({ write }: { write: boolean }) {
  const l = useAsync(() => get("/shift-templates").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack">
      {write && <div className="row"><Button onClick={() => setEdit({})}>+ Thêm mẫu ca</Button></div>}
      {(l.data ?? []).map((t) => (
        <button key={t.id} className="dt-card" disabled={!write} onClick={() => setEdit(t)}>
          <div className="row between"><b>{t.name} <span className="muted small">({t.code})</span></b>{t.active ? <Badge tone="ok">Đang dùng</Badge> : <Badge>Tắt</Badge>}</div>
          <div className="small">{t.startTime} – {t.endTime}{t.overnight ? " (qua đêm)" : ""} · nghỉ giữa ca {t.breakMinutes} phút</div>
        </button>
      ))}
      {edit && <TplForm t={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); l.reload(); }} />}
    </div>
  );
}
function TplForm({ t, onClose, onSaved }: { t: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ code: t.code ?? "", name: t.name ?? "", startTime: t.startTime ?? "08:00", endTime: t.endTime ?? "17:00", breakMinutes: t.breakMinutes ?? 0, active: t.active ?? true });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (t.id) await put("/shift-templates/" + t.id, { name: f.name.trim(), startTime: f.startTime, endTime: f.endTime, breakMinutes: f.breakMinutes, active: f.active });
      else await post("/shift-templates", { code: f.code.trim(), name: f.name.trim(), startTime: f.startTime, endTime: f.endTime, breakMinutes: f.breakMinutes });
      toast("Đã lưu mẫu ca", "ok"); onSaved();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={t.id ? "Sửa mẫu ca" : "Thêm mẫu ca"} footer={<Button block loading={busy} disabled={!f.name.trim() || (!t.id && !/^[A-Za-z0-9_-]{1,20}$/.test(f.code.trim()))} onClick={save}>Lưu</Button>}>
      <div className="stack">
        {!t.id && <Input label="Mã ca (VD: TOI)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}
        <Input label="Tên ca" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid2"><Input label="Giờ vào" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /><Input label="Giờ ra" type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></div>
        {f.endTime <= f.startTime && <div className="hint">Giờ ra không sau giờ vào: ca sẽ được tính qua đêm (kết thúc ngày hôm sau).</div>}
        <Input label="Nghỉ giữa ca (phút)" type="number" min={0} max={240} value={f.breakMinutes} onChange={(e) => setF({ ...f, breakMinutes: Number(e.target.value) || 0 })} />
        {t.id && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Đang sử dụng</label>}
      </div>
    </Sheet>
  );
}
