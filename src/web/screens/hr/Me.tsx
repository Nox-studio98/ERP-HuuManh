import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DecInput, EmptyState, Input, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { Scanner } from "../../components/Scanner";
import { toast } from "../../components/toast";
import { money, todayVN } from "../../format";
import { CORR_TYPE, KIND, LEAVE_TYPE, PUNCH_METHOD, PUNCH_STATUS, REQ_STATUS, addDaysS, days10, dm, dmy, errCode, hm, periodLabel, reqTone, vnIso, vnTime, WD_SHORT, wdOf } from "./kit";

type Tab = "today" | "schedule" | "swap" | "leave" | "ot" | "corr" | "payslip";
const TABS: { v: Tab; label: string }[] = [
  { v: "today", label: "Chấm công" }, { v: "schedule", label: "Lịch ca của tôi" }, { v: "swap", label: "Đổi ca" }, { v: "leave", label: "Xin nghỉ phép" },
  { v: "ot", label: "Đăng ký tăng ca" }, { v: "corr", label: "Quên chấm công" }, { v: "payslip", label: "Phiếu lương" },
];

export default function Me() {
  const [tab, setTab] = useState<Tab>("today");
  const [prefill, setPrefill] = useState<any>(null);
  return (
    <div className="stack" style={{ maxWidth: 640, margin: "0 auto" }}>
      <Segmented wrap value={tab} onChange={setTab} options={TABS} />
      {tab === "today" && <Today onCorrection={(p) => { setPrefill(p); setTab("corr"); }} />}
      {tab === "schedule" && <MySchedule />}
      {tab === "swap" && <Swaps />}
      {tab === "leave" && <Leave />}
      {tab === "ot" && <Overtime />}
      {tab === "corr" && <Correction prefill={prefill} />}
      {tab === "payslip" && <Payslips />}
    </div>
  );
}

/* ================= Chấm công ================= */
type Queued = { kind: "in" | "out"; lat?: number; lng?: number; accuracyM?: number; clientAt: string };
const QKEY = "hm_hr_offline";
const readQ = (): Queued[] => { try { return JSON.parse(localStorage.getItem(QKEY) ?? "[]"); } catch { return []; } };
const writeQ = (q: Queued[]) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* bộ nhớ bị chặn */ } };

function getPos(): Promise<{ lat: number; lng: number; accuracyM: number }> {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej({ code: 2, message: "unsupported" });
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }), (e) => rej(e), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

type Problem = { code: string; text: string; canQr: boolean; canCorr: boolean };

function Today({ onCorrection }: { onCorrection: (p: any) => void }) {
  const [d, setD] = useState<any>();
  const [noEmp, setNoEmp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<"gps" | "qr">("gps");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [info, setInfo] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const [queue, setQueue] = useState<Queued[]>(readQ);
  const flushing = useRef(false);

  const load = useCallback(async () => {
    try { setD(await get("/me/attendance/today", undefined, { silent: true })); setNoEmp(false); }
    catch (e) { if (e instanceof ApiError && e.code === "employee_not_found") setNoEmp(true); else if (!(e instanceof ApiError && e.status === 0)) toast((e as Error).message, "error"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      let q = readQ();
      while (q.length) {
        const it = q[0];
        try {
          await post("/me/attendance/punch", { kind: it.kind, method: "gps", lat: it.lat, lng: it.lng, accuracyM: it.accuracyM, offline: { clientAt: it.clientAt } }, { silent: true });
          toast("Đã gửi lần chấm công offline, đang chờ quản lý duyệt", "ok");
        } catch (e) {
          if (e instanceof ApiError && e.status === 0) break;
          toast(`Không gửi được lần chấm công offline (${(e as Error).message})`, "error");
        }
        q = q.slice(1); writeQ(q); setQueue(q);
      }
      load();
    } finally { flushing.current = false; }
  }, [load]);
  useEffect(() => { if (readQ().length) flush(); const f = () => flush(); window.addEventListener("online", f); return () => window.removeEventListener("online", f); }, [flush]);

  const explain = (e: ApiError): Problem | null => {
    const dt = e.details ?? {};
    switch (e.code) {
      case "out_of_area": return { code: e.code, text: `Bạn đang ở ngoài khu vực cửa hàng${dt.distanceM != null ? ` (cách khoảng ${dt.distanceM} m, cho phép ${dt.geofenceM} m)` : ""}. Hãy đến cửa hàng rồi thử lại, quét mã QR tại quầy, hoặc gửi yêu cầu bổ sung công.`, canQr: true, canCorr: true };
      case "low_accuracy": return { code: e.code, text: `Tín hiệu GPS chưa đủ chính xác (sai số ${dt.accuracyM ?? "?"} m, tối đa ${dt.maxAccuracyM ?? "?"} m). Hãy ra chỗ thoáng, bật định vị chính xác rồi thử lại, hoặc quét mã QR.`, canQr: true, canCorr: true };
      case "store_not_geolocated": return { code: e.code, text: "Cửa hàng chưa cài vị trí cho chấm công GPS. Hãy dùng mã QR hoặc báo quản lý.", canQr: true, canCorr: true };
      case "invalid_qr": case "qr_already_used": return { code: e.code, text: e.code === "qr_already_used" ? "Mã QR này đã được dùng. Đợi mã mới hiện trên màn hình cửa hàng rồi quét lại." : "Mã QR không hợp lệ hoặc đã hết hạn. Quét lại mã đang hiển thị trên màn hình cửa hàng.", canQr: true, canCorr: true };
      case "qr_not_configured": case "method_disabled": return { code: e.code, text: e.message, canQr: false, canCorr: true };
      default: return null;
    }
  };

  const punch = async (kind: "in" | "out", qrCode?: string) => {
    setBusy(true); setProblem(null); setInfo(null);
    const exempt = !!d?.employee?.locationExempt;
    let pos: { lat: number; lng: number; accuracyM: number } | undefined;
    try {
      if (method === "gps" && !exempt) {
        try { pos = await getPos(); }
        catch (ge: any) {
          if (ge?.code === 1) setProblem({ code: "denied", text: "Bạn đã chặn quyền vị trí cho trang này. Hãy bật quyền Vị trí trong cài đặt trình duyệt, hoặc dùng mã QR / gửi yêu cầu bổ sung công.", canQr: true, canCorr: true });
          else setProblem({ code: "no_gps", text: ge?.code === 3 ? "Không lấy được vị trí trong 15 giây. Hãy ra chỗ thoáng và thử lại, hoặc dùng mã QR." : "Thiết bị không xác định được vị trí. Hãy bật định vị hoặc dùng mã QR.", canQr: true, canCorr: true });
          return;
        }
      }
      const body: any = { kind, method };
      if (pos) Object.assign(body, pos);
      if (method === "qr") body.qrCode = qrCode;
      try {
        const r = await post("/me/attendance/punch", body, { silent: true });
        const p = r.punch;
        toast(`${KIND[p.kind]} lúc ${vnTime(p.serverAt)}${p.status === "pending" ? " — chờ duyệt" : ""}`, "ok");
        setInfo({ tone: "info", text: `Đã ${kind === "in" ? "vào ca" : "ra ca"} lúc ${vnTime(p.serverAt)}.` });
        await load();
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.status === 0) {
          if (method === "gps" && (pos || exempt)) {
            const q = [...readQ(), { kind, ...(pos ?? {}), clientAt: new Date().toISOString() }];
            writeQ(q); setQueue(q);
            setInfo({ tone: "info", text: "Mất kết nối. Đã lưu lần chấm công trên máy, sẽ tự gửi khi có mạng và chờ quản lý duyệt." });
          } else setInfo({ tone: "danger", text: "Không có mạng. Chấm công bằng mã QR cần kết nối — hãy chuyển sang GPS hoặc thử lại khi có mạng." });
        } else if (e.code === "device_not_registered") {
          setInfo({ tone: "danger", text: "Thiết bị mới, đã gửi quản lý duyệt. Bạn sẽ chấm công được trên máy này sau khi quản lý chấp nhận." });
        } else if (e.code === "already_in" || e.code === "not_in") { toast(e.message, "error"); await load(); }
        else { const pr = explain(e); if (pr) setProblem(pr); else toast(e.message, "error"); }
      }
    } finally { setBusy(false); }
  };

  if (loading) return <Spinner />;
  if (noEmp) return <EmptyState title="Tài khoản chưa gắn hồ sơ nhân viên" hint="Hãy báo quản lý để được tạo hồ sơ nhân viên và chấm công." />;
  if (!d) return <Banner tone="danger">Không tải được dữ liệu chấm công. Kiểm tra mạng rồi thử lại. <Button size="sm" variant="ghost" onClick={load}>Tải lại</Button></Banner>;

  const canOut = !!d.canPunch?.out, canIn = !!d.canPunch?.in;
  const kind: "in" | "out" = canOut ? "out" : "in";
  const exempt = !!d.employee?.locationExempt;
  const lastIn = [...d.punches].reverse().find((p: any) => p.kind === "in" && p.status !== "rejected");
  const methods: string[] = d.methods ?? ["gps"];
  return (
    <div className="stack">
      <Card>
        <div className="stack" style={{ alignItems: "center", textAlign: "center" }}>
          <div className="muted small">{d.employee.fullName} · {dmy(todayVN())}</div>
          <div style={{ fontWeight: 700, fontSize: "1.1rem" }} data-testid="punch-state">{canOut ? `Đang trong ca${lastIn ? ` (vào lúc ${vnTime(lastIn.serverAt)})` : ""}` : "Chưa vào ca"}</div>
          {method === "gps" || exempt ? (
            <Button size="lg" block loading={busy} disabled={!canIn && !canOut} variant={canOut ? "danger" : "primary"} onClick={() => punch(kind)} style={{ minHeight: 88, fontSize: "1.5rem" } as any} data-testid="punch-btn">
              {canOut ? "Ra ca" : "Vào ca"}
            </Button>
          ) : (
            <div className="stack" style={{ width: "100%", textAlign: "left" }}>
              <div className="small muted">{canOut ? "Ra ca" : "Vào ca"}: quét mã QR đang hiển thị ở cửa hàng hoặc nhập mã.</div>
              <Scanner onCode={(c) => punch(kind, c)} />
            </div>
          )}
          {!canIn && !canOut && d.canPunch?.reason && <div className="small muted">{d.canPunch.reason}</div>}
          {!exempt && methods.length > 1 && (
            <Segmented value={method} onChange={(m) => { setMethod(m); setProblem(null); }} options={[{ v: "gps", label: "Bằng GPS" }, { v: "qr", label: "Bằng mã QR" }]} />
          )}
          {exempt && <div className="small muted">Bạn được miễn xác thực vị trí.</div>}
          <div className="small muted" data-testid="privacy">Vị trí chỉ ghi lúc bấm chấm công, không theo dõi liên tục.</div>
        </div>
      </Card>

      {problem && (
        <Banner tone="danger">
          <div className="stack" style={{ gap: 8 }}>
            <div data-testid="punch-problem">{problem.text}</div>
            <div className="row wrap">
              {problem.canQr && methods.includes("qr") && method !== "qr" && <Button size="sm" variant="soft" onClick={() => { setMethod("qr"); setProblem(null); }}>Dùng mã QR</Button>}
              {problem.canCorr && <Button size="sm" variant="ghost" onClick={() => onCorrection({ workDate: todayVN(), type: "out_of_area", kind })}>Gửi yêu cầu bổ sung công</Button>}
            </div>
          </div>
        </Banner>
      )}
      {info && <Banner tone={info.tone}><span data-testid="punch-info">{info.text}</span></Banner>}
      {queue.length > 0 && (
        <Banner><b>Chờ gửi ({queue.length})</b>: {queue.map((q) => `${KIND[q.kind]} ${vnTime(q.clientAt)}`).join(", ")}. <Button size="sm" variant="ghost" onClick={flush}>Gửi ngay</Button></Banner>
      )}

      <Card title="Ca hôm nay">
        {!d.shifts.length ? <div className="muted">Hôm nay bạn không có ca nào.</div> : (
          <div className="stack" style={{ gap: 6 }}>
            {d.shifts.map((s: any) => <div key={s.id} className="row between"><b>{s.shiftName}</b><span className="num">{vnTime(s.startAt)} – {vnTime(s.endAt)}</span></div>)}
          </div>
        )}
      </Card>
      <Card title="Lần chấm công hôm nay">
        {!d.punches.length ? <div className="muted">Chưa có lần chấm công nào.</div> : (
          <div className="stack" style={{ gap: 6 }}>
            {d.punches.map((p: any, i: number) => (
              <div key={i} className="row between">
                <span><b>{KIND[p.kind]}</b> <span className="muted small">{PUNCH_METHOD[p.method] ?? p.method}</span></span>
                <span className="row"><span className="num">{vnTime(p.serverAt)}</span><Badge tone={p.status === "accepted" ? "ok" : p.status === "pending" ? "warn" : "danger"}>{p.status === "pending" ? "Chờ duyệt" : PUNCH_STATUS[p.status] ?? p.status}</Badge></span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ================= Lịch ca ================= */
function MySchedule() {
  const from = todayVN(), to = addDaysS(from, 13);
  const l = useAsync(() => get("/me/schedule", { from, to }).then((r) => items<any>(r)), []);
  if (l.loading) return <Spinner />;
  const byDate: Record<string, any[]> = {};
  for (const s of l.data ?? []) (byDate[s.workDate] ??= []).push(s);
  const days = Array.from({ length: 14 }, (_, i) => addDaysS(from, i));
  return (
    <Card title="Lịch ca 14 ngày tới">
      <div className="stack" style={{ gap: 6 }} data-testid="my-schedule">
        {days.map((d) => (
          <div key={d} className="row between" style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
            <span style={{ minWidth: 84 }}><b>{WD_SHORT[wdOf(d)]}</b> {dm(d)}</span>
            <span className="grow" style={{ textAlign: "right" }}>
              {byDate[d]?.length ? byDate[d].map((s) => <div key={s.id}>{s.shiftName} <span className="muted num">{vnTime(s.startAt)}–{vnTime(s.endAt)}</span></div>) : <span className="muted">Nghỉ</span>}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ================= Nghỉ phép ================= */
function Leave() {
  const l = useAsync(() => get("/me/leave-requests"), []);
  const [f, setF] = useState({ leaveTypeCode: "annual", fromDate: todayVN(1), toDate: todayVN(1), halfDay: false, reason: "" });
  const [busy, setBusy] = useState(false);
  const bal = l.data?.leaveBalance;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post("/me/leave-requests", { ...f, toDate: f.halfDay ? f.fromDate : f.toDate, reason: f.reason.trim() || undefined });
      toast(r.overBalance ? "Đã gửi đơn — vượt số ngày phép còn lại, quản lý sẽ xem xét ngoại lệ" : "Đã gửi đơn xin nghỉ", "ok");
      setF({ ...f, reason: "" }); l.reload();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Card title="Số dư phép năm">
        {bal ? <div className="row between" data-testid="leave-balance"><span>Còn lại <b>{days10(bal.remainingX10)}</b> / {days10(bal.entitledX10)} ngày</span><span className="muted small">Đã dùng {days10(bal.usedX10)}</span></div> : <Spinner />}
      </Card>
      <Card title="Xin nghỉ">
        <div className="stack">
          <Select label="Loại nghỉ" value={f.leaveTypeCode} onChange={(e) => setF({ ...f, leaveTypeCode: e.target.value })}>
            {Object.entries(LEAVE_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <div className="grid2">
            <Input label="Từ ngày" type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value, toDate: e.target.value > f.toDate ? e.target.value : f.toDate })} />
            <Input label="Đến ngày" type="date" value={f.halfDay ? f.fromDate : f.toDate} disabled={f.halfDay} min={f.fromDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} />
          </div>
          <label className="row"><input type="checkbox" checked={f.halfDay} onChange={(e) => setF({ ...f, halfDay: e.target.checked })} /> Nghỉ nửa ngày</label>
          <TextArea label="Lý do" rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <Button block loading={busy} disabled={!f.fromDate || !f.toDate} onClick={submit}>Gửi đơn xin nghỉ</Button>
        </div>
      </Card>
      <Card title="Đơn đã gửi">
        {l.loading ? <Spinner /> : !(l.data?.items ?? []).length ? <div className="muted">Chưa có đơn nào.</div> : (
          <div className="stack" style={{ gap: 8 }}>
            {l.data.items.map((r: any) => (
              <div key={r.id} className="row between" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
                <span><b>{LEAVE_TYPE[r.leaveTypeCode] ?? r.leaveTypeCode}</b> · {dmy(r.fromDate)}{r.toDate !== r.fromDate ? ` – ${dmy(r.toDate)}` : ""} · {days10(r.daysX10)} ngày{r.overBalance && <> <Badge tone="warn">Vượt phép</Badge></>}</span>
                <Badge tone={reqTone(r.status)}>{REQ_STATUS[r.status] ?? r.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ================= Tăng ca ================= */
function Overtime() {
  const [f, setF] = useState({ workDate: todayVN(), hours: 1, reason: "" });
  const [busy, setBusy] = useState(false);
  const hist = useAsync(() => get("/me/overtime-requests").then((r) => items<any>(r)), []);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post("/me/overtime-requests", { workDate: f.workDate, minutes: Math.round(f.hours * 60), reason: f.reason.trim() || undefined });
      hist.reload(); toast("Đã gửi đăng ký tăng ca, chờ quản lý duyệt", "ok");
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Card title="Đăng ký tăng ca">
        <div className="stack">
          <Input label="Ngày làm" type="date" value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value })} />
          <DecInput label="Số giờ tăng ca" value={f.hours} onChange={(n) => setF({ ...f, hours: n })} />
          <TextArea label="Lý do / công việc" rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <Button block loading={busy} disabled={!f.workDate || f.hours <= 0 || f.hours > 12} onClick={submit}>Gửi đăng ký</Button>
          <div className="hint">Chỉ phần tăng ca được quản lý duyệt mới được tính lương.</div>
        </div>
      </Card>
      {(hist.data ?? []).length > 0 && (
        <Card title="Đã đăng ký">
          {hist.data!.map((r) => <div key={r.id} className="row between"><span>{dmy(r.workDate)} · {hm(r.minutes)}</span><Badge tone={reqTone(r.status)}>{REQ_STATUS[r.status]}</Badge></div>)}
        </Card>
      )}
    </div>
  );
}

/* ================= Quên chấm công ================= */
function Correction({ prefill }: { prefill: any }) {
  const [f, setF] = useState({ workDate: prefill?.workDate ?? todayVN(), type: prefill?.type ?? "missing_out", kind: (prefill?.kind ?? "") as "" | "in" | "out", time: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const hist = useAsync(() => get("/me/attendance/corrections").then((r) => items<any>(r)), []);
  const kind = f.kind || (f.type === "missing_in" ? "in" : f.type === "missing_out" ? "out" : "");
  const submit = async () => {
    setBusy(true);
    try {
      const body: any = { workDate: f.workDate, type: f.type, reason: f.reason.trim() };
      if (kind) body.kind = kind;
      if (f.time) body.requestedAt = vnIso(f.workDate, f.time);
      const r = await post("/me/attendance/corrections", body);
      hist.reload(); toast("Đã gửi yêu cầu bổ sung công", "ok"); setF({ ...f, reason: "" });
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Card title="Yêu cầu bổ sung công">
        <div className="stack">
          <Input label="Ngày làm việc" type="date" max={todayVN()} value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value })} />
          <Select label="Lý do chính" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, kind: "" })}>
            {Object.entries(CORR_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          {(f.type === "out_of_area" || f.type === "other") && (
            <Select label="Bổ sung lần chấm" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as any })}>
              <option value="">— Chọn —</option><option value="in">Vào ca</option><option value="out">Ra ca</option>
            </Select>
          )}
          <Input label="Giờ thực tế (giờ VN)" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} hint="Quản lý cần giờ này để bổ sung bản ghi chấm công." />
          <TextArea label="Giải thích" rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          <Button block loading={busy} disabled={!f.reason.trim() || !f.workDate || !kind || !f.time} onClick={submit}>Gửi yêu cầu</Button>
        </div>
      </Card>
      {(hist.data ?? []).length > 0 && (
        <Card title="Yêu cầu đã gửi">
          {hist.data!.map((r) => <div key={r.id} className="row between"><span>{dmy(r.workDate)} · {CORR_TYPE[r.type]}</span><Badge tone={reqTone(r.status)}>{REQ_STATUS[r.status] ?? r.status}</Badge></div>)}
        </Card>
      )}
    </div>
  );
}

/* ================= Phiếu lương ================= */
function Payslips() {
  const l = useAsync(() => get("/me/payslips", undefined, { silent: true }).then((r) => items<any>(r)).catch(() => []), []);
  const [open, setOpen] = useState<string | null>(null);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack">
      {!(l.data ?? []).length ? <EmptyState title="Chưa có phiếu lương" hint="Phiếu lương hiện sau khi chủ duyệt bảng lương kỳ đó." /> : (
        <div className="stack" data-testid="payslip-list">
          {l.data!.map((p) => (
            <button key={p.period} className="dt-card" onClick={() => setOpen(p.period)}>
              <div className="row between"><b>{periodLabel(p.period)}</b><Badge tone={p.status === "paid" ? "ok" : "info"}>{p.status === "paid" ? "Đã chi" : "Đã duyệt"}</Badge></div>
              <div className="row between"><span className="muted small">Thực lĩnh</span><b className="num">{money(p.net)}</b></div>
            </button>
          ))}
        </div>
      )}
      {open && <PayslipSheet period={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
function PayslipSheet({ period, onClose }: { period: string; onClose: () => void }) {
  const l = useAsync(() => get("/me/payslips/" + period), [period]);
  const p = l.data;
  const grp = (g: string) => (p?.lines ?? []).filter((x: any) => x.group === g);
  return (
    <Sheet open onClose={onClose} title={`Phiếu lương ${periodLabel(period)}`}>
      {!p ? <Spinner /> : (
        <div className="stack" data-testid="payslip-detail">
          <div className="card flat" style={{ textAlign: "center" }}>
            <div className="muted small">Thực lĩnh</div>
            <div style={{ fontSize: "1.8rem", fontWeight: 700 }} className="num">{money(p.net)}</div>
            <div className="small muted">{p.employee.name} · {p.employee.code} · {p.status === "paid" ? "Đã chi" : "Đã duyệt"}</div>
          </div>
          {([["income", "Khoản thu nhập"], ["deduction", "Khoản trừ"], ["info", "Thông tin"]] as const).map(([g, t]) => grp(g).length > 0 && (
            <div key={g} className="stack" style={{ gap: 6 }}>
              <h3 style={{ margin: 0 }}>{t}</h3>
              {grp(g).map((x: any, i: number) => (
                <div key={i} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>
                  <div className="row between"><span>{x.label}</span><b className="num">{money(x.amount)}</b></div>
                  {x.note && <div className="small muted">{x.note}</div>}
                </div>
              ))}
            </div>
          ))}
          <div className="hint">Công thức và mức bảo hiểm/thuế còn chờ xác nhận của chủ cửa hàng.</div>
        </div>
      )}
    </Sheet>
  );
}

/* ================= Đổi ca ================= */
function Swaps() {
  const from = todayVN();
  const shifts = useAsync(() => get("/me/schedule", { from, to: addDaysS(from, 20) }).then((r) => items<any>(r).filter((x) => x.startAt > new Date().toISOString())), []);
  const col = useAsync(() => get("/me/colleagues").then((r) => items<any>(r)), []);
  const sw = useAsync(() => get("/me/schedule/swaps").then((r) => items<any>(r)), []);
  const me = useAsync(() => get("/me/attendance/today", undefined, { silent: true }).then((r) => r.employee?.id as number), []);
  const [f, setF] = useState({ from: "", to: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { await post("/schedule/swaps", { fromAssignmentId: Number(f.from || shifts.data?.[0]?.id), toEmployeeId: Number(f.to || col.data?.[0]?.id), reason: f.reason.trim() }); toast("Đã gửi yêu cầu đổi ca", "ok"); setF({ ...f, reason: "" }); sw.reload(); } catch { /* toast */ } finally { setBusy(false); }
  };
  const accept = async (id: number) => { try { await post(`/schedule/swaps/${id}/accept`, {}); toast("Đã đồng ý nhận ca, chờ quản lý duyệt", "ok"); sw.reload(); } catch { /* toast */ } };
  return (
    <div className="stack">
      <Card title="Xin đổi ca">
        {!(shifts.data ?? []).length ? <div className="muted">Bạn chưa có ca sắp tới để đổi.</div> : (
          <div className="stack">
            <Select label="Ca của tôi" value={f.from || String(shifts.data![0].id)} onChange={(e) => setF({ ...f, from: e.target.value })}>{shifts.data!.map((x) => <option key={x.id} value={x.id}>{WD_SHORT[wdOf(x.workDate)]} {dm(x.workDate)} · {x.shiftName}</option>)}</Select>
            <Select label="Đồng nghiệp nhận ca" value={f.to || String(col.data?.[0]?.id ?? "")} onChange={(e) => setF({ ...f, to: e.target.value })}>{(col.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}</Select>
            <TextArea label="Lý do" rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            <Button block loading={busy} disabled={!f.reason.trim() || !(col.data ?? []).length} onClick={submit}>Gửi yêu cầu đổi ca</Button>
          </div>
        )}
      </Card>
      <Card title="Yêu cầu đổi ca của tôi">
        {!(sw.data ?? []).length ? <div className="muted">Chưa có yêu cầu.</div> : sw.data!.map((x) => (
          <div key={x.id} className="stack" style={{ gap: 4, borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
            <div className="row between"><b>{x.fromEmployeeName} → {x.toEmployeeName}</b><Badge tone={reqTone(x.status)}>{x.status === "pending" ? "Chờ nhận ca" : x.status === "accepted" ? "Chờ quản lý duyệt" : REQ_STATUS[x.status] ?? x.status}</Badge></div>
            <div className="small">{x.fromShiftName} {x.fromWorkDate ? dm(x.fromWorkDate) : ""}{x.toAssignmentId ? ` ⇄ ${x.toShiftName} ${dm(x.toWorkDate)}` : ""} · {x.reason}</div>
            {x.status === "pending" && x.toEmployeeId === me.data && <Button size="sm" onClick={() => accept(x.id)}>Đồng ý nhận ca</Button>}
          </div>
        ))}
      </Card>
    </div>
  );
}
