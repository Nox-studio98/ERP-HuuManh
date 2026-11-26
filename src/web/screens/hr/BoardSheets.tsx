import { useMemo, useState } from "react";
import { get, items, post, del } from "../../api";
import { Badge, Banner, Button, DataTable, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { fmtDateTime } from "../../format";
import { useCan } from "../../store";
import { Decide } from "./Attendance";
import { Confirm, WD_SHORT, addDaysS, dm, dmy, hm, mondayOf, moneyFmt, vnTime, wdOf } from "./kit";
import { METHOD_LABEL, STATUS, type BoardCellT, type BoardResp, type BoardShift, type CellDetail, type CellIncident, type IncidentType, type ManualType } from "./board-types";

const hhmm = (iso?: string | null) => { const t = vnTime(iso); return t === "—" ? "" : t; };
const WD_FULL = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy", "Chủ nhật"];
export const dayLabel = (d: string) => `${WD_FULL[wdOf(d)]}, ${dmy(d)}`;
export const targetOf = (c: BoardCellT) => (c.assignmentId ? { assignmentId: c.assignmentId } : { employeeId: c.employeeId, workDate: c.workDate });
const shiftText = (s?: BoardShift) => (s ? `${s.name} (${s.startTime} – ${s.endTime})` : "Ngoài lịch");
const shiftOf = (b: BoardResp, c: BoardCellT) => b.shifts.find((s) => s.id === (c.shiftId ?? 0));

/* ---------------- Form chấm công thủ công (dùng cho 1 ô và nhiều ô) ---------------- */
type ManualForm = { type: ManualType; inOn: boolean; inTime: string; outOn: boolean; outTime: string; applyLate: boolean; applyEarly: boolean; applyOt: boolean; substitute: number; note: string };
function ManualFields({ f, setF, employees, selfId, showSub }: { f: ManualForm; setF: (v: ManualForm) => void; employees: BoardResp["employees"]; selfId?: number; showSub: boolean }) {
  const set = (p: Partial<ManualForm>) => setF({ ...f, ...p });
  const work = f.type === "work";
  return (
    <div className="stack">
      <div className="bd-form-row">
        <span className="lbl">Chấm công</span>
        <div className="row wrap" style={{ gap: "6px 16px" }} role="radiogroup" aria-label="Loại chấm công">
          {([["work", "Đi làm"], ["paid_leave", "Nghỉ phép hưởng lương"], ["unpaid_leave", "Nghỉ không lương"]] as [ManualType, string][]).map(([v, l]) => (
            <label key={v} className="row" style={{ gap: 6 }}><input type="radio" name="bd-type" checked={f.type === v} onChange={() => set({ type: v })} /> {l}</label>
          ))}
        </div>
      </div>
      {work && (
        <>
          <div className="bd-form-row">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.inOn} onChange={(e) => set({ inOn: e.target.checked })} /> Vào</label>
            <input className="input" type="time" aria-label="Giờ vào" style={{ maxWidth: 160 }} disabled={!f.inOn} value={f.inTime} onChange={(e) => set({ inTime: e.target.value })} />
          </div>
          <div className="bd-form-row">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.outOn} onChange={(e) => set({ outOn: e.target.checked })} /> Ra</label>
            <input className="input" type="time" aria-label="Giờ ra" style={{ maxWidth: 160 }} disabled={!f.outOn} value={f.outTime} onChange={(e) => set({ outTime: e.target.value })} />
          </div>
          <div className="bd-form-row">
            <span className="lbl">Áp dụng</span>
            <div className="row wrap" style={{ gap: "6px 16px" }}>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.applyLate} onChange={(e) => set({ applyLate: e.target.checked })} /> Đi muộn</label>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.applyEarly} onChange={(e) => set({ applyEarly: e.target.checked })} /> Về sớm</label>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.applyOt} onChange={(e) => set({ applyOt: e.target.checked })} /> Làm thêm</label>
            </div>
          </div>
        </>
      )}
      {!work && showSub && (
        <Select label="Nhân viên làm thay (không bắt buộc)" value={f.substitute || ""} onChange={(e) => set({ substitute: Number(e.target.value) || 0 })}>
          <option value="">Không có</option>
          {employees.filter((e) => e.id !== selfId).map((e) => <option key={e.id} value={e.id}>{e.name} · {e.code}</option>)}
        </Select>
      )}
    </div>
  );
}
const initForm = (c: BoardCellT | undefined, s: BoardShift | undefined): ManualForm => ({
  type: "work", inOn: true, inTime: hhmm(c?.inAt) || s?.startTime || hhmm(c?.startAt) || "08:00",
  outOn: c?.status !== "working", outTime: hhmm(c?.outAt) || s?.endTime || hhmm(c?.endAt) || "17:00",
  applyLate: true, applyEarly: true, applyOt: true, substitute: 0, note: "",
});
const manualBody = (targets: any[], f: ManualForm) => ({
  targets, type: f.type,
  ...(f.type === "work" ? { ...(f.inOn ? { inTime: f.inTime } : {}), ...(f.outOn ? { outTime: f.outTime } : {}), applyLate: f.applyLate, applyEarly: f.applyEarly, applyOt: f.applyOt } : {}),
  ...(f.type !== "work" && f.substitute && targets.length === 1 ? { substituteEmployeeId: f.substitute } : {}),
  note: f.note.trim(),
});
const manualInvalid = (f: ManualForm) => f.note.trim().length < 3 || (f.type === "work" && !f.inOn && !f.outOn);

/* ---------------- Sheet chi tiết ô ---------------- */
type Tab = "punch" | "hist" | "penalty" | "bonus";
export function CellSheet({ cell, board, canWrite, onClose, onChanged }: { cell: BoardCellT; board: BoardResp; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const emp = board.employees.find((e) => e.id === cell.employeeId);
  const shift = shiftOf(board, cell);
  const closed = board.periodsClosed.includes(cell.workDate.slice(0, 7));
  const ro = closed || !canWrite;
  const d = useAsync(() => get<CellDetail>("/attendance/cell", cell.assignmentId ? { assignmentId: cell.assignmentId } : { employeeId: cell.employeeId, workDate: cell.workDate }), [cell.key]);
  const cur = d.data?.cell ?? cell;
  const [tab, setTab] = useState<Tab>("punch");
  const [f, setF] = useState<ManualForm>(() => initForm(cell, shift));
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<"cancel" | "swap" | null>(null);
  const [swap, setSwap] = useState({ employeeId: 0, reason: "" });
  const changed = () => { d.reload(); onChanged(); };
  const save = async () => {
    setBusy(true);
    try { await post("/attendance/manual", manualBody([targetOf(cell)], f)); toast("Đã lưu chấm công", "ok"); onChanged(); onClose(); } catch { /* toast */ } finally { setBusy(false); }
  };
  const label = cur.status === "leave" && cur.leavePaid != null ? (cur.leavePaid ? "Nghỉ phép hưởng lương" : "Nghỉ không lương") : STATUS[cur.status].label;
  return (
    <>
      <Sheet open onClose={onClose} wide title="Chấm công"
        footer={tab === "punch" && !ro ? (
          <div className="row grow" style={{ flexWrap: "wrap" }}>
            {cell.assignmentId && <Button variant="ghost" size="sm" onClick={() => setDlg("cancel")}>Huỷ ca</Button>}
            {cell.assignmentId && <Button variant="ghost" size="sm" onClick={() => { setSwap({ employeeId: 0, reason: "" }); setDlg("swap"); }}>Đổi ca</Button>}
            <Button className="grow" loading={busy} disabled={manualInvalid(f)} onClick={save}>Lưu</Button>
          </div>
        ) : undefined}>
        <div className="stack" data-testid="cell-sheet">
          <div className="bd-sheet-head">
            <b>{emp?.name ?? `NV #${cell.employeeId}`}</b>
            {emp && <span className="muted small">{emp.code}</span>}
            <span className={"st-badge st-" + cur.status}>{label}</span>
            {cur.manual && <Badge>Thủ công</Badge>}
          </div>
          {closed && <div className="bd-ro">Kỳ đã chốt — dùng điều chỉnh công. Ô này chỉ xem.</div>}
          {!closed && !canWrite && <div className="bd-ro">Bạn chỉ có quyền xem.</div>}
          <div className="bd-info"><span className="lbl">Thời gian</span><span>{dayLabel(cell.workDate)}</span></div>
          <div className="bd-info"><span className="lbl">Ca làm việc</span><span>{shiftText(shift)}{cur.substituteForId ? ` · làm thay ${board.employees.find((e) => e.id === cur.substituteForId)?.name ?? ""}` : ""}</span></div>
          {tab === "punch" && !ro && <TextArea label="Ghi chú (bắt buộc, từ 3 ký tự)" rows={2} placeholder="VD: Quên mang điện thoại" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}
          <Segmented fit wrap value={tab} onChange={setTab} options={[
            { v: "punch", label: "Chấm công" },
            { v: "hist", label: d.data?.punches.some((p) => p.status === "pending") ? "Lịch sử chấm công •" : "Lịch sử chấm công" },
            { v: "penalty", label: "Phạt vi phạm" }, { v: "bonus", label: "Thưởng" }]} />
          {d.err ? <Banner>Không tải được chi tiết ô. Thử lại sau.</Banner> : null}
          {tab === "punch" && (
            <div className="stack">
              {ro ? <PunchSummary c={cur} /> : <ManualFields f={f} setF={setF} employees={board.employees} selfId={cell.employeeId} showSub={!!cell.assignmentId} />}
              <div className="bd-stats">
                <div><b>{cur.lateMinutes || 0}</b><span>Đi muộn (phút)</span></div>
                <div><b>{cur.earlyMinutes || 0}</b><span>Về sớm (phút)</span></div>
                <div><b>{cur.otMinutes || 0}</b><span>Làm thêm (phút)</span></div>
                <div><b>{hm(cur.workedMinutes)}</b><span>Giờ làm</span></div>
              </div>
            </div>
          )}
          {tab === "hist" && (d.loading ? <Spinner /> : <History d={d.data} ro={ro} onChanged={changed} />)}
          {(tab === "penalty" || tab === "bonus") && (d.loading ? <Spinner /> : <Incidents kind={tab} cell={cell} d={d.data} ro={ro} onChanged={changed} />)}
        </div>
      </Sheet>
      {dlg === "cancel" && (
        <Confirm title="Huỷ ca làm" danger confirmLabel="Huỷ ca" onClose={() => setDlg(null)}
          onConfirm={async () => { try { await del("/schedule/" + cell.assignmentId); toast("Đã huỷ ca", "ok"); onChanged(); onClose(); } catch { /* toast */ } }}>
          <div><b>{emp?.name}</b> · {shiftText(shift)} · {dm(cell.workDate)}</div>
          <div className="muted small">Ca bị huỷ vẫn được lưu vết, không xoá khỏi lịch sử.</div>
        </Confirm>
      )}
      {dlg === "swap" && (
        <Confirm title="Đổi ca sang nhân viên khác" confirmLabel="Đổi ca" disabled={!swap.employeeId || swap.reason.trim().length < 3} onClose={() => setDlg(null)}
          onConfirm={async () => { try { await post(`/schedule/${cell.assignmentId}/reassign`, { employeeId: swap.employeeId, reason: swap.reason.trim() }); toast("Đã đổi ca", "ok"); onChanged(); onClose(); } catch { /* toast */ } }}>
          <div className="muted small">{shiftText(shift)} · {dayLabel(cell.workDate)} · chỉ đổi được khi ca chưa có lần chấm hợp lệ.</div>
          <Select label="Nhân viên nhận ca" value={swap.employeeId || ""} onChange={(e) => setSwap({ ...swap, employeeId: Number(e.target.value) })}>
            <option value="">Chọn nhân viên…</option>
            {board.employees.filter((e) => e.id !== cell.employeeId).map((e) => <option key={e.id} value={e.id}>{e.name} · {e.code}</option>)}
          </Select>
          <Input label="Lý do (từ 3 ký tự)" value={swap.reason} onChange={(e) => setSwap({ ...swap, reason: e.target.value })} />
        </Confirm>
      )}
    </>
  );
}

function PunchSummary({ c }: { c: BoardCellT }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="bd-info"><span className="lbl">Vào</span><span>{c.inAt ? vnTime(c.inAt) : "-- --"}</span></div>
      <div className="bd-info"><span className="lbl">Ra</span><span>{c.outAt ? vnTime(c.outAt) : "-- --"}</span></div>
    </div>
  );
}

function History({ d, ro, onChanged }: { d?: CellDetail; ro: boolean; onChanged: () => void }) {
  const punches = d?.punches ?? [];
  const tone = (s: string) => (s === "accepted" ? "ok" : s === "pending" ? "warn" : "danger");
  const st: Record<string, string> = { accepted: "Hợp lệ", pending: "Chờ duyệt", rejected: "Từ chối" };
  return (
    <div className="stack" data-testid="cell-history">
      <DataTable<any> rows={punches} rowKey={(p) => p.id} empty="Chưa có lần chấm công nào" cols={[
        { key: "t", label: "Thời gian", title: true, render: (p) => <span className="nw">{fmtDateTime(p.at)}</span> },
        { key: "k", label: "Loại", render: (p) => (p.kind === "in" ? "Vào" : "Ra") },
        { key: "s", label: "Trạng thái", render: (p) => <Badge tone={tone(p.status)}>{st[p.status] ?? p.status}</Badge> },
        { key: "m", label: "Hình thức", render: (p) => METHOD_LABEL[p.method] ?? p.method },
        { key: "u", label: "Người", render: (p) => p.decidedByName ?? p.createdByName ?? "—" },
        { key: "n", label: "Nội dung", render: (p) => (
          <div className="stack" style={{ gap: 4, alignItems: "flex-start" }}>
            <span>{p.note === "replaced_by_manual" ? "Bị thay thế bởi chấm thủ công" : p.note ?? ""}</span>
            {p.status === "pending" && !ro && (
              <Decide approveLabel="Duyệt" onDecide={async (dec, note) => { await post(`/attendance/punches/${p.id}/decide`, { decision: dec, note }); toast(dec === "approved" ? "Đã duyệt" : "Đã từ chối", "ok"); onChanged(); }} />
            )}
          </div>
        ) },
      ]} />
      {(d?.corrections ?? []).length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <b className="small">Yêu cầu bổ sung công</b>
          {d!.corrections.map((c: any, i: number) => <div key={c.id ?? i} className="small muted">{c.reason ?? c.type} · {c.status === "pending" ? "chờ duyệt" : c.status === "approved" ? "đã duyệt" : c.status === "rejected" ? "từ chối" : c.status}</div>)}
        </div>
      )}
      {(d?.history ?? []).length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <b className="small">Nhật ký thao tác</b>
          {d!.history.map((h, i) => <div key={i} className="small muted">{fmtDateTime(h.at)} · {h.byName ?? "Hệ thống"} · {h.action}{h.detail ? ` — ${h.detail}` : ""}</div>)}
        </div>
      )}
    </div>
  );
}

function Incidents({ kind, cell, d, ro, onChanged }: { kind: "penalty" | "bonus"; cell: BoardCellT; d?: CellDetail; ro: boolean; onChanged: () => void }) {
  const can = useCan();
  const L = kind === "penalty" ? { one: "vi phạm", add: "Thêm vi phạm", empty: "Chưa có vi phạm nào", types: "loại vi phạm" } : { one: "thưởng", add: "Thêm thưởng", empty: "Chưa có khoản thưởng nào", types: "loại thưởng" };
  const types = useAsync(() => get("/attendance/incident-types", { kind }).then((r) => items<IncidentType>(r).filter((t) => t.active)), [kind]);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ typeId: 0, times: 1, amount: -1, note: "" });
  const [newType, setNewType] = useState<{ name: string; amount: number } | null>(null);
  const [voidId, setVoidId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const list = (d?.incidents ?? []).filter((i) => i.kind === kind);
  const sel = (types.data ?? []).find((t) => t.id === f.typeId);
  const money = typeof sel?.defaultAmount === "number";
  const total = list.filter((i) => !i.voided).reduce((s, i) => s + (i.amount ?? 0), 0);
  const showTotal = list.some((i) => typeof i.amount === "number");
  const run = async (fn: () => Promise<any>, ok: string, after?: () => void) => { setBusy(true); try { await fn(); toast(ok, "ok"); after?.(); } catch { /* toast */ } finally { setBusy(false); } };
  return (
    <div className="stack" data-testid={"cell-" + kind}>
      {list.length === 0 && <div className="muted">{L.empty}</div>}
      {list.map((i: CellIncident) => (
        <div key={i.id} className="card flat" style={{ padding: 10, opacity: i.voided ? 0.55 : 1 }}>
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <div>
              <b style={{ textDecoration: i.voided ? "line-through" : undefined }}>{i.typeName} × {i.times}</b>
              {typeof i.amount === "number" && <span className="num"> · {moneyFmt(i.amount)} ₫</span>}
              {i.voided && <> <Badge>Đã huỷ</Badge></>}
              <div className="small muted">{i.note ? i.note + " · " : ""}{i.createdByName ?? ""}{i.createdAt ? " · " + fmtDateTime(i.createdAt) : ""}</div>
            </div>
            {!ro && !i.voided && <Button size="sm" variant="ghost" onClick={() => { setReason(""); setVoidId(i.id); }}>Huỷ</Button>}
          </div>
        </div>
      ))}
      {showTotal && <div className="row between"><span className="muted">Tổng {kind === "penalty" ? "phạt" : "thưởng"}</span><b className="num">{moneyFmt(total)} ₫</b></div>}
      {!ro && !adding && <div><Button variant="soft" size="sm" onClick={() => { setAdding(true); setF({ typeId: types.data?.[0]?.id ?? 0, times: 1, amount: -1, note: "" }); }}>+ {L.add}</Button></div>}
      {!ro && adding && (
        <div className="card flat stack" style={{ padding: 12 }}>
          <Select label={"Loại " + L.one} value={f.typeId || ""} onChange={(e) => setF({ ...f, typeId: Number(e.target.value), amount: -1 })}>
            <option value="">Chọn…</option>
            {(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}{typeof t.defaultAmount === "number" ? ` · ${moneyFmt(t.defaultAmount)} ₫` : ""}</option>)}
          </Select>
          {can("hr.manage") && !newType && <div><Button variant="ghost" size="sm" onClick={() => setNewType({ name: "", amount: 0 })}>+ Thêm {L.types}</Button></div>}
          {newType && (
            <div className="card flat stack" style={{ padding: 10 }}>
              <Input label={"Tên " + L.types} value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} />
              <MoneyInput label="Mức mặc định (₫)" value={newType.amount} onChange={(n) => setNewType({ ...newType, amount: n })} />
              <div className="row"><Button size="sm" loading={busy} disabled={!newType.name.trim()} onClick={() => run(async () => { const r: any = await post("/attendance/incident-types", { kind, name: newType.name.trim(), defaultAmount: newType.amount }); await types.reload(); if (r?.id) setF((x) => ({ ...x, typeId: r.id })); }, "Đã thêm loại", () => setNewType(null))}>Lưu loại</Button><Button size="sm" variant="ghost" onClick={() => setNewType(null)}>Bỏ qua</Button></div>
            </div>
          )}
          <Input label="Số lần" type="number" min={1} max={99} value={f.times} onChange={(e) => setF({ ...f, times: Math.max(1, Number(e.target.value) || 1) })} />
          {money && <MoneyInput label="Mức áp dụng mỗi lần (₫)" hint={`Mặc định ${moneyFmt(sel!.defaultAmount)} ₫`} value={f.amount < 0 ? sel!.defaultAmount ?? 0 : f.amount} onChange={(n) => setF({ ...f, amount: n })} />}
          <Input label="Ghi chú" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <div className="row">
            <Button loading={busy} disabled={!f.typeId} onClick={() => run(() => post("/attendance/incidents", { employeeId: cell.employeeId, workDate: cell.workDate, ...(cell.assignmentId ? { assignmentId: cell.assignmentId } : {}), typeId: f.typeId, times: f.times, ...(f.amount >= 0 ? { amountEach: f.amount } : {}), ...(f.note.trim() ? { note: f.note.trim() } : {}) }), "Đã ghi nhận", () => { setAdding(false); onChanged(); })}>Lưu</Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Bỏ qua</Button>
          </div>
        </div>
      )}
      {voidId != null && (
        <Confirm title={"Huỷ " + L.one} danger confirmLabel="Huỷ khoản này" busy={busy} disabled={reason.trim().length < 3} onClose={() => setVoidId(null)}
          onConfirm={() => run(() => post(`/attendance/incidents/${voidId}/void`, { reason: reason.trim() }), "Đã huỷ", () => { setVoidId(null); onChanged(); })}>
          <Input label="Lý do huỷ (từ 3 ký tự)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Confirm>
      )}
    </div>
  );
}

/* ---------------- Chỉnh sửa chấm công hàng loạt ---------------- */
export function BulkEditSheet({ cells, board, onClose, onDone }: { cells: BoardCellT[]; board: BoardResp; onClose: () => void; onDone: () => void }) {
  const shift = shiftOf(board, cells[0]);
  const [f, setF] = useState<ManualForm>(() => initForm(undefined, shift));
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={`Chỉnh sửa chấm công (${cells.length} ô)`} footer={
      <Button block loading={busy} disabled={manualInvalid(f)} onClick={async () => {
        setBusy(true);
        try { const r: any = await post("/attendance/manual", manualBody(cells.map(targetOf), f)); toast(`Đã cập nhật ${r?.updated ?? cells.length} ô`, "ok"); onDone(); } catch { /* toast */ } finally { setBusy(false); }
      }}>Lưu cho {cells.length} ô</Button>}>
      <div className="stack" data-testid="bulk-edit">
        <div className="muted small">{shiftText(shift)} · {[...new Set(cells.map((c) => dm(c.workDate)))].join(", ")}<br />{cells.map((c) => board.employees.find((e) => e.id === c.employeeId)?.name).filter(Boolean).join(", ")}</div>
        <ManualFields f={f} setF={setF} employees={board.employees} showSub={false} />
        <TextArea label="Ghi chú (bắt buộc, từ 3 ký tự)" rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
    </Sheet>
  );
}

/* ---------------- Thêm nhân viên vào ca của một ngày ---------------- */
function EmployeePicker({ emps, sel, setSel, hide }: { emps: any[]; sel: Set<number>; setSel: (s: Set<number>) => void; hide?: Set<number> }) {
  const [q, setQ] = useState("");
  const list = emps.filter((e) => !hide?.has(e.id) && (!q || (e.fullName + " " + (e.code ?? "")).toLowerCase().includes(q.toLowerCase())));
  const toggle = (id: number) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row"><input className="input" type="search" aria-label="Tìm nhân viên" placeholder="Tìm nhân viên…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button size="sm" variant="ghost" style={{ whiteSpace: "nowrap" }} onClick={() => setSel(sel.size === list.length ? new Set() : new Set(list.map((e) => e.id)))}>{sel.size === list.length && list.length ? "Bỏ hết" : "Chọn hết"}</Button></div>
      <div className="bd-pick" data-testid="emp-picker">
        {list.map((e) => <label key={e.id}><input type="checkbox" checked={sel.has(e.id)} onChange={() => toggle(e.id)} /> <span className="grow">{e.fullName}</span><span className="muted small">{e.code}</span></label>)}
        {!list.length && <div className="muted" style={{ padding: 12 }}>Không có nhân viên phù hợp</div>}
      </div>
    </div>
  );
}
export function AddToShiftSheet({ shift, date, taken, onClose, onDone }: { shift: BoardShift; date: string; taken: Set<number>; onClose: () => void; onDone: () => void }) {
  const emps = useAsync(() => get("/employees", { status: "active", limit: 200 }).then((r) => items<any>(r)), []);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={`Thêm nhân viên · ${shift.name} · ${dm(date)}`} footer={
      <Button block loading={busy} disabled={!sel.size} onClick={async () => {
        setBusy(true);
        try { const r = await post("/schedule/bulk", { assignments: [...sel].map((employeeId) => ({ employeeId, workDate: date, shiftTemplateId: shift.id })) }); toast(`Đã gán ${r.created} ca`, "ok"); onDone(); } catch { /* toast */ } finally { setBusy(false); }
      }}>Thêm {sel.size || ""} nhân viên vào ca</Button>}>
      <div className="stack">
        <div className="muted small">{dayLabel(date)} · {shift.startTime} – {shift.endTime}</div>
        {emps.loading ? <Spinner /> : <EmployeePicker emps={emps.data ?? []} sel={sel} setSel={setSel} hide={taken} />}
      </div>
    </Sheet>
  );
}

/* ---------------- Xếp lịch (nhiều nhân viên, nhiều ngày, lặp hằng tuần) ---------------- */
export function ScheduleSheet({ anchor, onClose, onDone }: { anchor: string; onClose: () => void; onDone: () => void }) {
  const start = mondayOf(anchor);
  const emps = useAsync(() => get("/employees", { status: "active", limit: 200 }).then((r) => items<any>(r)), []);
  const tpls = useAsync(() => get("/shift-templates").then((r) => items<any>(r).filter((t) => t.active)), []);
  const [tpl, setTpl] = useState(0);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [days, setDays] = useState<Set<number>>(new Set());
  const [repeat, setRepeat] = useState(false);
  const [weeks, setWeeks] = useState(4);
  const [busy, setBusy] = useState(false);
  const tplId = tpl || tpls.data?.[0]?.id || 0;
  const dates = useMemo(() => { const out: string[] = []; for (let w = 0; w < (repeat ? weeks : 1); w++) for (const d of [...days].sort()) out.push(addDaysS(start, w * 7 + d)); return out; }, [days, repeat, weeks, start]);
  const total = sel.size * dates.length;
  const toggleDay = (i: number) => setDays((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const submit = async () => {
    setBusy(true);
    try {
      const all = [...sel].flatMap((employeeId) => dates.map((workDate) => ({ employeeId, workDate, shiftTemplateId: tplId })));
      let created = 0, skipped = 0;
      for (let i = 0; i < all.length; i += 500) { const r = await post("/schedule/bulk", { assignments: all.slice(i, i + 500) }); created += r.created; skipped += r.skipped ?? 0; }
      toast(`Đã gán ${created} ca${skipped ? `, bỏ qua ${skipped} ca đã có` : ""}`, "ok"); onDone();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const copyPrev = async () => {
    setBusy(true);
    try {
      const prev = items<any>(await get("/schedule", { from: addDaysS(start, -7), to: addDaysS(start, -1) }));
      if (!prev.length) { toast("Tuần trước chưa có ca để sao chép", "info"); return; }
      const r = await post("/schedule/bulk", { assignments: prev.map((p) => ({ employeeId: p.employeeId, workDate: addDaysS(p.workDate, 7), shiftTemplateId: p.shiftTemplateId })) });
      toast(`Đã sao chép ${r.created} ca${r.skipped ? `, bỏ qua ${r.skipped} ca đã có` : ""}`, "ok"); onDone();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} wide title="Xếp lịch làm việc" footer={
      <Button block loading={busy} disabled={!total || !tplId || total > 3000} onClick={submit}>Xếp {total ? `${total} ca` : "lịch"}</Button>}>
      <div className="stack" data-testid="schedule-sheet">
        {tpls.loading || emps.loading ? <Spinner /> : (tpls.data ?? []).length === 0 ? <Banner tone="info">Chưa có mẫu ca nào đang dùng. Hãy thêm mẫu ca trước.</Banner> : (
          <>
            <Select label="Ca làm việc" value={tplId} onChange={(e) => setTpl(Number(e.target.value))}>{tpls.data!.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.startTime}–{t.endTime})</option>)}</Select>
            <div className="stack" style={{ gap: 6 }}>
              <span className="lbl">Nhân viên ({sel.size})</span>
              <EmployeePicker emps={emps.data ?? []} sel={sel} setSel={setSel} />
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <span className="lbl">Các ngày trong tuần {dm(start)} – {dm(addDaysS(start, 6))}</span>
              <div className="bd-chips">{WD_SHORT.map((w, i) => <button key={w} type="button" aria-pressed={days.has(i)} onClick={() => toggleDay(i)}>{w} {dm(addDaysS(start, i))}</button>)}</div>
            </div>
            <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Lặp lại hằng tuần</label>
            {repeat && <Input label="Số tuần (tính cả tuần này)" type="number" min={2} max={12} value={weeks} onChange={(e) => setWeeks(Math.min(12, Math.max(2, Number(e.target.value) || 2)))} />}
            <div className="muted small">{total ? `Sẽ tạo tối đa ${total} ca (${sel.size} nhân viên × ${dates.length} ngày). Ca đã có sẽ được bỏ qua.` : "Chọn nhân viên và ngày để xếp."}</div>
            <div><Button variant="ghost" size="sm" loading={busy} onClick={copyPrev}>Sao chép tuần trước sang tuần này</Button></div>
          </>
        )}
      </div>
    </Sheet>
  );
}
