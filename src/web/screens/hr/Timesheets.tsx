import { useState } from "react";
import { ApiError, get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { DetailPanel, ExportButton, FilterBar, KpiRow, PageHeader, SearchInput, SplitLayout } from "../../components/list";
import { toast } from "../../components/toast";
import { useCan } from "../../store";
import { navigate } from "../../router";
import { Confirm, WD_SHORT, dm, hm, periodLabel, shiftPeriod, thisPeriod, wdOf, days10, dmy } from "./kit";

export default function Timesheets() {
  const can = useCan();
  const manage = can("timesheet.close");
  const qp = (() => { try { return new URLSearchParams(location.search).get("period"); } catch { return null; } })();
  const [period, setPeriod] = useState(qp && /^\d{4}-\d{2}$/.test(qp) ? qp : shiftPeriod(thisPeriod(), 0));
  const l = useAsync(() => get("/timesheets/" + period), [period]);
  const [emp, setEmp] = useState<any>(null);
  const [closing, setClosing] = useState(false);
  const [adj, setAdj] = useState(false);
  const ts = l.data;
  const closed = ts?.status === "closed";
  const [q, setQ] = useState("");
  const all: any[] = ts?.employees ?? [];
  const rows = all.filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const sum = (f: (r: any) => number) => all.reduce((a, r) => a + f(r), 0);
  return (
    <div className="stack">
      <PageHeader subtitle={<>{periodLabel(period)}. Giờ công = tổng (ra − vào) trừ giờ nghỉ giữa ca; thiếu giờ ra không bị đoán.</>} actions={<>
        <ExportButton filename={`bang-cong-${period}`} rows={rows} columns={[{ label: "Nhân viên", value: (r: any) => r.name }, { label: "Giờ làm (phút)", value: (r: any) => r.totals.workedMinutes }, { label: "Ngày công", value: (r: any) => r.totals.workDays }, { label: "Đi trễ (phút)", value: (r: any) => r.totals.lateMinutes }, { label: "Về sớm (phút)", value: (r: any) => r.totals.earlyLeaveMinutes }, { label: "Tăng ca (phút)", value: (r: any) => r.totals.overtimeMinutes }, { label: "Phép (ngày)", value: (r: any) => r.totals.paidLeaveX10 / 10 }, { label: "Thiếu công (ngày)", value: (r: any) => r.totals.missingDays }]} />
        {closed && manage && <Button size="sm" variant="soft" onClick={() => setAdj(true)}>Điều chỉnh công</Button>}
        {ts && !closed && manage && <Button size="sm" onClick={() => setClosing(true)} data-testid="close-period">Chốt bảng công</Button>}</>} />
      <FilterBar>
        <div className="row wrap">
          <Button size="sm" variant="ghost" aria-label="Tháng trước" onClick={() => setPeriod(shiftPeriod(period, -1))}>‹</Button>
          <input type="month" className="input" style={{ width: 210 }} aria-label="Kỳ công" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />
          <Button size="sm" variant="ghost" aria-label="Tháng sau" onClick={() => setPeriod(shiftPeriod(period, 1))}>›</Button>
          {ts && <Badge tone={closed ? "ok" : "warn"}>{closed ? "Đã chốt" : "Đang mở (tính trực tiếp)"}</Badge>}
        </div>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên nhân viên…" label="Tìm nhân viên" />
      </FilterBar>
      {ts && all.length > 0 && <KpiRow items={[
        { label: "Nhân viên", value: all.length },
        { label: "Tổng giờ làm", value: hm(sum((r) => r.totals.workedMinutes)), sub: `${sum((r) => r.totals.workDays)} ngày công` },
        { label: "Tăng ca", value: hm(sum((r) => r.totals.overtimeMinutes)) },
        { label: "Ngày thiếu công", value: sum((r) => r.totals.missingDays), tone: sum((r) => r.totals.missingDays) ? "danger" : "ok", sub: `Đi trễ ${sum((r) => r.totals.lateMinutes)} phút` },
      ]} />}
      {l.loading ? <Spinner /> : !ts || !ts.employees.length ? <EmptyState title="Chưa có dữ liệu công kỳ này" hint="Nhân viên cần có ca hoặc lần chấm công trong tháng." action={<div className="row wrap" style={{ justifyContent: "center" }}><Button variant="soft" onClick={() => setPeriod(shiftPeriod(period, -1))}>Xem tháng trước</Button><Button variant="ghost" onClick={() => navigate("/hr/schedule")}>Xếp lịch ca</Button></div>} /> : (
        <SplitLayout open={!!emp} panel={emp ? <DayDrill e={emp} onClose={() => setEmp(null)} /> : null}>
        <DataTable<any> rows={rows} rowKey={(r) => r.employeeId} onRowClick={setEmp} selectedKey={emp?.employeeId} rowClass={(r) => (r.totals.missingDays ? "bad" : "")}
          cols={[
            { key: "n", label: "Nhân viên", title: true, sort: (r) => r.name, render: (r) => <b>{r.name}</b> },
            { key: "w", label: "Giờ làm", num: true, sort: (r) => r.totals.workedMinutes, render: (r) => hm(r.totals.workedMinutes) },
            { key: "d", label: "Ngày công", num: true, sort: (r) => r.totals.workDays, render: (r) => r.totals.workDays },
            { key: "l", label: "Đi trễ (phút)", num: true, sort: (r) => r.totals.lateMinutes, render: (r) => r.totals.lateMinutes },
            { key: "e", label: "Về sớm (phút)", num: true, hideMobile: true, hideBelow: 1280, sort: (r) => r.totals.earlyLeaveMinutes, render: (r) => r.totals.earlyLeaveMinutes },
            { key: "o", label: "Tăng ca", num: true, sort: (r) => r.totals.overtimeMinutes, render: (r) => hm(r.totals.overtimeMinutes) },
            { key: "p", label: "Phép (ngày)", num: true, hideMobile: true, hideBelow: 1280, sort: (r) => r.totals.paidLeaveX10, render: (r) => days10(r.totals.paidLeaveX10) },
            { key: "m", label: "Thiếu công", num: true, sort: (r) => r.totals.missingDays, render: (r) => (r.totals.missingDays ? <Badge tone="danger">{r.totals.missingDays} ngày</Badge> : "0") },
          ]} />
        </SplitLayout>
      )}
      {closed && <Adjustments period={period} />}
      {closing && <Close period={period} onClose={() => setClosing(false)} onDone={() => { setClosing(false); l.reload(); }} />}
      {adj && ts && <AdjForm period={period} emps={ts.employees} onClose={() => setAdj(false)} />}
    </div>
  );
}

function DayDrill({ e, onClose }: { e: any; onClose: () => void }) {
  const rows = e.days.filter((d: any) => d.scheduledMinutes || d.workedMinutes || d.missingPunch || d.leaveCode || d.holiday);
  return (
    <DetailPanel onClose={onClose} title={`Công của ${e.name}`}>
      <DataTable<any> rows={rows} rowKey={(d) => d.workDate} empty="Không có ngày công" rowClass={(d) => (d.missingPunch ? "bad" : "")}
        cols={[
          { key: "d", label: "Ngày", title: true, render: (d) => <b>{WD_SHORT[wdOf(d.workDate)]} {dm(d.workDate)}</b> },
          { key: "s", label: "Theo ca", right: true, render: (d) => hm(d.scheduledMinutes) },
          { key: "w", label: "Đã làm", right: true, render: (d) => hm(d.workedMinutes) },
          { key: "l", label: "Trễ", right: true, render: (d) => d.lateMinutes || "" },
          { key: "e", label: "Sớm", right: true, render: (d) => d.earlyLeaveMinutes || "" },
          { key: "o", label: "Tăng ca", right: true, render: (d) => (d.overtimeMinutes ? hm(d.overtimeMinutes) : "") },
          { key: "n", label: "Ghi chú", render: (d) => <span className="row wrap" style={{ gap: 4 }}>{d.missingPunch && <Badge tone="danger">Thiếu giờ ra</Badge>}{d.leaveCode && <Badge tone="info">Nghỉ {d.leaveCode}</Badge>}{d.holiday && <Badge>Lễ</Badge>}</span> },
        ]} />
      <div className="small muted" style={{ marginTop: 8 }}>Tổng: {hm(e.totals.workedMinutes)} làm · {e.totals.shiftsWorked} ca · {e.totals.missingDays} ngày thiếu công.</div>
    </DetailPanel>
  );
}

function Close({ period, onClose, onDone }: { period: string; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [un, setUn] = useState<any>(null);
  const [reason, setReason] = useState("");
  const run = async (force: boolean) => {
    setBusy(true);
    try {
      await post(`/timesheets/${period}/close`, force ? { force: true, reason: reason.trim() } : {}, { silent: true });
      toast("Đã chốt bảng công " + periodLabel(period), "ok"); onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "unresolved_items") setUn(e.details ?? {});
      else toast((e as Error).message, "error");
    } finally { setBusy(false); }
  };
  const L = (n: number, t: string, go: string) => n > 0 && <li key={t}><b>{n}</b> {t} <a href={go} onClick={(ev) => { ev.preventDefault(); navigate(go); }}>Xử lý</a></li>;
  return (
    <Sheet open onClose={onClose} title={`Chốt bảng công ${periodLabel(period)}`} footer={!un
      ? <div className="row"><Button variant="ghost" onClick={onClose}>Huỷ</Button><Button className="grow" loading={busy} onClick={() => run(false)}>Chốt bảng công</Button></div>
      : <div className="row"><Button variant="ghost" onClick={onClose}>Quay lại xử lý</Button><Button variant="danger" className="grow" loading={busy} disabled={!reason.trim()} onClick={() => run(true)} data-testid="force-close">Vẫn chốt (cưỡng chế)</Button></div>}>
      {!un ? (
        <div className="stack"><Banner tone="info">Sau khi chốt, công của kỳ này bị khoá để tính lương. Muốn sửa phải lập phiếu điều chỉnh vào kỳ sau.</Banner></div>
      ) : (
        <div className="stack" data-testid="unresolved">
          <Banner>Còn mục chưa xử lý trong kỳ:</Banner>
          <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
            {L(un.pendingPunches, "lần chấm công chờ duyệt", "/hr/attendance")}
            {L(un.pendingCorrections, "yêu cầu bổ sung công", "/hr/attendance")}
            {L(un.pendingLeaves, "đơn nghỉ phép", "/hr/attendance")}
            {L(un.pendingOvertime, "yêu cầu tăng ca", "/hr/attendance")}
            {(un.missingPunchDays ?? []).length > 0 && <li><b>{un.missingPunchDays.length}</b> ngày thiếu giờ ra: {un.missingPunchDays.slice(0, 8).map((x: any) => `${x.name} ${dm(x.workDate)}`).join("; ")}{un.missingPunchDays.length > 8 ? "…" : ""}</li>}
          </ul>
          <TextArea label="Lý do chốt cưỡng chế (bắt buộc, ghi vào nhật ký)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
    </Sheet>
  );
}

function Adjustments({ period }: { period: string }) {
  const l = useAsync(() => get("/timesheets/adjustments", { period }).then((r) => items<any>(r)), [period]);
  if (!l.data?.length) return null;
  return (
    <Card title="Điều chỉnh công">
      {l.data.map((a) => <div key={a.id} className="row between" style={{ borderBottom: "1px solid var(--border)", padding: "4px 0" }}><span>{a.sourcePeriod} → {a.targetPeriod} · NV #{a.employeeId} · {a.kind === "work" ? "giờ làm" : "tăng ca"}: <b>{a.minutes > 0 ? "+" : ""}{a.minutes} phút</b></span><span className="muted small">{a.reason}</span></div>)}
    </Card>
  );
}
function AdjForm({ period, emps, onClose }: { period: string; emps: any[]; onClose: () => void }) {
  const [f, setF] = useState({ employeeId: emps[0]?.employeeId ?? 0, kind: "work", minutes: 30, reason: "", targetPeriod: shiftPeriod(period, 1) }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Điều chỉnh công kỳ đã chốt" footer={<Button block loading={busy} disabled={!f.reason.trim() || !f.minutes} onClick={async () => {
      setBusy(true); try { await post("/timesheets/adjustments", { employeeId: Number(f.employeeId), sourcePeriod: period, targetPeriod: f.targetPeriod, minutes: f.minutes, kind: f.kind, reason: f.reason.trim() }); toast("Đã lập điều chỉnh", "ok"); onClose(); } catch { /* toast */ } finally { setBusy(false); }
    }}>Lưu điều chỉnh</Button>}>
      <div className="stack">
        <Banner tone="info">Kỳ {period} đã chốt nên không sửa trực tiếp. Điều chỉnh (cộng/trừ phút) được tính vào kỳ sau.</Banner>
        <Select label="Nhân viên" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: Number(e.target.value) })}>{emps.map((e) => <option key={e.employeeId} value={e.employeeId}>{e.name}</option>)}</Select>
        <Select label="Loại" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="work">Giờ làm</option><option value="overtime">Tăng ca</option></Select>
        <Input label="Số phút (âm = trừ)" type="number" value={f.minutes} onChange={(e) => setF({ ...f, minutes: Math.trunc(Number(e.target.value)) || 0 })} />
        <Input label="Tính vào kỳ" type="month" value={f.targetPeriod} onChange={(e) => setF({ ...f, targetPeriod: e.target.value })} />
        <TextArea label="Lý do" rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
    </Sheet>
  );
}
