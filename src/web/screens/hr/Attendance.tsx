import { useEffect, useState } from "react";
import { get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, Input, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { fmtDateTime, todayVN } from "../../format";
import { navigate } from "../../router";
import { Confirm, CORR_TYPE, KIND, LEAVE_TYPE, PUNCH_METHOD, PUNCH_STATUS, REQ_STATUS, days10, dmy, errCode, hm, reqTone } from "./kit";

type Tab = "punches" | "corr" | "leave" | "ot" | "dev" | "log";

export default function Attendance() {
  const [tab, setTab] = useState<Tab>("punches");
  const counts = useAsync(async () => {
    const q = (p: string, k: any = { status: "pending", limit: 100 }) => get(p, k, { silent: true }).then((r) => items<any>(r).length).catch(() => 0);
    const [punches, corr, leave, ot, dev] = await Promise.all([q("/attendance/punches"), q("/attendance/corrections"), q("/leave-requests"), q("/overtime-requests"), q("/devices/requests", { status: "pending" })]);
    return { punches, corr, leave, ot, dev };
  }, []);
  const c = counts.data;
  const lab = (t: string, n?: number) => (n ? `${t} (${n})` : t);
  return (
    <div className="stack">
      <div className="row wrap between">
        <Segmented wrap value={tab} onChange={setTab} options={[
          { v: "punches", label: lab("Chấm công chờ duyệt", c?.punches) }, { v: "corr", label: lab("Bổ sung công", c?.corr) }, { v: "leave", label: lab("Nghỉ phép", c?.leave) },
          { v: "ot", label: lab("Tăng ca", c?.ot) }, { v: "dev", label: lab("Thiết bị", c?.dev) }, { v: "log", label: "Nhật ký" }]} />
        <Button variant="soft" size="sm" onClick={() => navigate("/hr/qr")}>Mở màn hình QR cửa hàng</Button>
      </div>
      {tab === "punches" && <Punches onChange={counts.reload} />}
      {tab === "corr" && <Corrections onChange={counts.reload} />}
      {tab === "leave" && <Leaves onChange={counts.reload} />}
      {tab === "ot" && <Overtime onChange={counts.reload} />}
      {tab === "dev" && <Devices onChange={counts.reload} />}
      {tab === "log" && <Log />}
    </div>
  );
}

/** Nút duyệt / từ chối (từ chối hỏi ghi chú) */
function Decide({ onDecide, approveLabel = "Duyệt", disabled }: { onDecide: (d: "approved" | "rejected", note?: string) => Promise<any>; approveLabel?: string; disabled?: boolean }) {
  const [rej, setRej] = useState(false), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const run = async (d: "approved" | "rejected", n?: string) => { setBusy(true); try { await onDecide(d, n); setRej(false); } catch { /* toast */ } finally { setBusy(false); } };
  return (
    <>
      <div className="row"><Button size="sm" loading={busy} disabled={disabled} onClick={() => run("approved")}>{approveLabel}</Button><Button size="sm" variant="ghost" onClick={() => setRej(true)}>Từ chối</Button></div>
      {rej && <Confirm title="Từ chối yêu cầu" danger confirmLabel="Từ chối" busy={busy} onClose={() => setRej(false)} onConfirm={() => run("rejected", note.trim() || undefined)}><TextArea label="Lý do (không bắt buộc)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Confirm>}
    </>
  );
}
const Empty = ({ t }: { t: string }) => <Card><div className="muted">{t}</div></Card>;

function Punches({ onChange }: { onChange: () => void }) {
  const l = useAsync(() => get("/attendance/punches", { status: "pending", limit: 100 }).then((r) => items<any>(r)), []);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack" data-testid="pending-punches">
      <div className="hint">Lần chấm công gửi từ máy khi mất mạng (offline) cần quản lý xác nhận trước khi tính công.</div>
      {!(l.data ?? []).length && <Empty t="Không có lần chấm công nào chờ duyệt." />}
      {l.data!.map((p) => (
        <Card key={p.id}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b>{p.employeeName} · {KIND[p.kind]}</b><Badge tone="warn">{PUNCH_METHOD[p.method] ?? p.method}</Badge></div>
            <div className="small">Giờ máy khách: {fmtDateTime(p.clientAt)} · giờ nhận: {fmtDateTime(p.serverAt)}</div>
            {p.distanceM != null && <div className="small muted">Cách cửa hàng {p.distanceM} m{p.accuracyM != null ? `, sai số GPS ${Math.round(p.accuracyM)} m` : ""}</div>}
            <Decide onDecide={async (d, note) => { await post(`/attendance/punches/${p.id}/decide`, { decision: d, note }); toast(d === "approved" ? "Đã xác nhận" : "Đã từ chối", "ok"); l.reload(); onChange(); }} approveLabel="Xác nhận" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function Corrections({ onChange }: { onChange: () => void }) {
  const l = useAsync(() => get("/attendance/corrections", { status: "pending", limit: 100 }).then((r) => items<any>(r)), []);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack" data-testid="pending-corrections">
      {!(l.data ?? []).length && <Empty t="Không có yêu cầu bổ sung công nào chờ duyệt." />}
      {l.data!.map((r) => {
        const incomplete = !r.kind || !r.requestedAt;
        return (
          <Card key={r.id}>
            <div className="stack" style={{ gap: 6 }}>
              <div className="row between"><b>{r.employeeName}</b><Badge tone="warn">{CORR_TYPE[r.type] ?? r.type}</Badge></div>
              <div className="small">Ngày {dmy(r.workDate)} · đề nghị {r.kind ? KIND[r.kind] : "?"} lúc {r.requestedAt ? fmtDateTime(r.requestedAt) : "—"}</div>
              <div className="small muted">Lý do: {r.reason}</div>
              {incomplete && <div className="small" style={{ color: "var(--danger)" }}>Yêu cầu thiếu loại vào/ra hoặc giờ — chỉ có thể từ chối và nhờ nhân viên gửi lại.</div>}
              <Decide disabled={incomplete} onDecide={async (d, note) => { await post(`/attendance/corrections/${r.id}/decide`, { decision: d, note }); toast(d === "approved" ? "Đã duyệt, đã tạo bản ghi chấm công" : "Đã từ chối", "ok"); l.reload(); onChange(); }} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Leaves({ onChange }: { onChange: () => void }) {
  const l = useAsync(() => get("/leave-requests", { status: "pending", limit: 100 }).then((r) => items<any>(r)), []);
  const [over, setOver] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (l.loading) return <Spinner />;
  const done = (t: string) => { toast(t, "ok"); l.reload(); onChange(); };
  return (
    <div className="stack" data-testid="pending-leaves">
      {!(l.data ?? []).length && <Empty t="Không có đơn nghỉ nào chờ duyệt." />}
      {l.data!.map((r) => (
        <Card key={r.id}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b>{r.employeeName}</b><span className="row">{r.overBalance && <Badge tone="danger">Vượt số dư phép</Badge>}<Badge>{LEAVE_TYPE[r.leaveTypeCode] ?? r.leaveTypeCode}</Badge></span></div>
            <div className="small">{dmy(r.fromDate)}{r.toDate !== r.fromDate ? ` – ${dmy(r.toDate)}` : ""} · {days10(r.daysX10)} ngày{r.halfDay ? " (nửa ngày)" : ""}</div>
            {r.reason && <div className="small muted">Lý do: {r.reason}</div>}
            {r.overBalance && <div className="small" style={{ color: "var(--danger)" }}>Đơn vượt số ngày phép còn lại. Duyệt sẽ là ngoại lệ và được ghi vào nhật ký.</div>}
            <Decide approveLabel={r.overBalance ? "Duyệt ngoại lệ…" : "Duyệt"} onDecide={async (d, note) => {
              if (d === "approved" && r.overBalance) { setOver(r); return; }
              await post(`/leave-requests/${r.id}/decide`, { decision: d, note }); done(d === "approved" ? "Đã duyệt đơn nghỉ" : "Đã từ chối");
            }} />
          </div>
        </Card>
      ))}
      {over && (
        <Confirm title="Duyệt vượt số dư phép" confirmLabel="Duyệt ngoại lệ" busy={busy} onClose={() => setOver(null)}
          onConfirm={async () => { setBusy(true); try { await post(`/leave-requests/${over.id}/decide`, { decision: "approved", allowOverBalance: true }); setOver(null); done("Đã duyệt ngoại lệ"); } catch { /* toast */ } finally { setBusy(false); } }}>
          <Banner><b>{over.employeeName}</b> xin nghỉ {days10(over.daysX10)} ngày, vượt số dư phép năm còn lại. Bạn xác nhận duyệt ngoại lệ?</Banner>
        </Confirm>
      )}
    </div>
  );
}

function Overtime({ onChange }: { onChange: () => void }) {
  const l = useAsync(() => get("/overtime-requests", { status: "pending" }).then((r) => items<any>(r)), []);
  const emps = useAsync(() => get("/employees", { status: "active", limit: 200 }).then((r) => items<any>(r)), []);
  const [add, setAdd] = useState(false);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack" data-testid="pending-ot">
      <div className="row between"><div className="hint">Chỉ phần tăng ca đã duyệt mới được tính lương.</div><Button size="sm" variant="soft" onClick={() => setAdd(true)}>+ Ghi nhận tăng ca</Button></div>
      {!(l.data ?? []).length && <Empty t="Không có yêu cầu tăng ca nào chờ duyệt." />}
      {l.data!.map((r) => (
        <Card key={r.id}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b>{r.employeeName}</b><Badge tone="warn">{hm(r.minutes)} tăng ca</Badge></div>
            <div className="small">Ngày {dmy(r.workDate)}{r.reason ? ` · ${r.reason}` : ""}</div>
            <Decide onDecide={async (d, note) => { await post(`/overtime-requests/${r.id}/decide`, { decision: d, note }); toast(d === "approved" ? "Đã duyệt tăng ca" : "Đã từ chối", "ok"); l.reload(); onChange(); }} />
          </div>
        </Card>
      ))}
      {add && <OtForm emps={emps.data ?? []} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); toast("Đã ghi nhận tăng ca", "ok"); }} />}
    </div>
  );
}
function OtForm({ emps, onClose, onSaved }: { emps: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ employeeId: emps[0]?.id ?? 0, workDate: todayVN(), hours: 1, reason: "" }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Ghi nhận tăng ca (đã xác nhận)" footer={<Button block loading={busy} disabled={!f.employeeId || f.hours <= 0} onClick={async () => {
      setBusy(true); try { await post("/overtime-requests", { employeeId: Number(f.employeeId), workDate: f.workDate, minutes: Math.round(f.hours * 60), reason: f.reason.trim() || undefined }); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
    }}>Ghi nhận</Button>}>
      <div className="stack">
        <Select label="Nhân viên" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: Number(e.target.value) })}>{emps.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}</Select>
        <Input label="Ngày" type="date" value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value })} />
        <DecInput label="Số giờ" value={f.hours} onChange={(n) => setF({ ...f, hours: n })} />
        <Input label="Lý do" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
    </Sheet>
  );
}

function Devices({ onChange }: { onChange: () => void }) {
  const l = useAsync(() => get("/devices/requests", { status: "pending" }).then((r) => items<any>(r)), []);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack" data-testid="pending-devices">
      <div className="hint">Mỗi nhân viên chỉ chấm công trên một điện thoại đã đăng ký. Duyệt thiết bị mới sẽ thu hồi thiết bị cũ.</div>
      {!(l.data ?? []).length && <Empty t="Không có yêu cầu đổi thiết bị nào." />}
      {l.data!.map((r) => (
        <Card key={r.id}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between"><b>{r.fullName}</b><span className="muted small">{r.username}</span></div>
            <div className="small muted truncate">{r.label || "Thiết bị không rõ"} · gửi {fmtDateTime(r.createdAt)}</div>
            <Decide approveLabel="Cho phép thiết bị" onDecide={async (d, note) => { await post(`/devices/requests/${r.id}/decide`, { decision: d, note }); toast(d === "approved" ? "Đã duyệt thiết bị" : "Đã từ chối", "ok"); l.reload(); onChange(); }} />
          </div>
        </Card>
      ))}
    </div>
  );
}

function Log() {
  const [f, setF] = useState({ employeeId: "", from: todayVN(-6), to: todayVN(), status: "" });
  const emps = useAsync(() => get("/employees", { limit: 200 }).then((r) => items<any>(r)), []);
  const l = useAsync(() => get("/attendance/punches", { employeeId: f.employeeId, from: f.from, to: f.to, status: f.status, limit: 200 }).then((r) => items<any>(r)), [f.employeeId, f.from, f.to, f.status]);
  return (
    <div className="stack">
      <div className="grid2">
        <Select label="Nhân viên" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">Tất cả</option>{(emps.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}</Select>
        <Select label="Trạng thái" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Tất cả</option>{Object.entries(PUNCH_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Input label="Từ ngày" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="Đến ngày" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div>
      {l.loading ? <Spinner /> : (
        <DataTable<any> rows={l.data ?? []} rowKey={(r) => r.id} empty="Không có lần chấm công trong bộ lọc"
          cols={[
            { key: "t", label: "Giờ máy chủ", render: (r) => fmtDateTime(r.serverAt) },
            { key: "e", label: "Nhân viên", title: true, render: (r) => <b>{r.employeeName}</b> },
            { key: "k", label: "Loại", render: (r) => KIND[r.kind] },
            { key: "m", label: "Cách chấm", render: (r) => PUNCH_METHOD[r.method] ?? r.method },
            { key: "d", label: "Khoảng cách", hideMobile: true, render: (r) => (r.distanceM != null ? `${r.distanceM} m` : "—") },
            { key: "s", label: "Trạng thái", render: (r) => <Badge tone={r.status === "accepted" ? "ok" : r.status === "pending" ? "warn" : "danger"}>{PUNCH_STATUS[r.status] ?? r.status}</Badge> },
            { key: "n", label: "Ghi chú", hideMobile: true, render: (r) => r.note ?? "" },
          ]} />
      )}
    </div>
  );
}
