import { Fragment, useEffect, useMemo, useState } from "react";
import { get, items } from "../../api";
import { Banner, Button, EmptyState, Segmented, Sheet, Spinner, useAsync } from "../../components/ui";
import { SearchInput, useMedia } from "../../components/list";
import { downloadCsv } from "../../csv";
import { toast } from "../../components/toast";
import { todayVN } from "../../format";
import { useCan } from "../../store";
import Attendance from "./Attendance";
import { AddToShiftSheet, BulkEditSheet, CellSheet, ScheduleSheet } from "./BoardSheets";
import { TplForm } from "./Schedule";
import { LEGEND, STATUS, type BoardCellT, type BoardResp, type BoardShift, type CellStatus } from "./board-types";
import { WD_SHORT, addDaysS, dm, mondayOf, moneyFmt, shiftPeriod, vnTime, wdOf } from "./kit";

type Range = "week" | "month";
type View = "shift" | "emp";
const WD_LONG = ["Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy", "Chủ nhật"];
const OFF_ROW = -1; // hàng "Ngoài lịch" khi ô không gắn ca

const isoWeek = (d: string) => {
  const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((+t - +y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7);
};
const monthEnd = (d: string) => addDaysS(shiftPeriod(d.slice(0, 7), 1) + "-01", -1);
const rangeOf = (r: Range, a: string) => (r === "week" ? { from: mondayOf(a), to: addDaysS(mondayOf(a), 6) } : { from: a.slice(0, 7) + "-01", to: monthEnd(a) });
const ls = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* bị chặn */ } };

const rowKeyOf = (c: BoardCellT, b: BoardResp) => { const id = c.shiftId ?? 0; return b.shifts.some((s) => s.id === id) ? id : OFF_ROW; };

/** Nhãn dòng 3 của thẻ: chỉ hiện khi không phải đúng giờ / chưa tới giờ */
function statusLine(c: BoardCellT): string | null {
  switch (c.status) {
    case "late_early": return [c.lateMinutes > 0 ? `Đi muộn ${c.lateMinutes}'` : "", c.earlyMinutes > 0 ? `Về sớm ${c.earlyMinutes}'` : ""].filter(Boolean).join(" · ") || "Đi muộn / Về sớm";
    case "leave": return c.leavePaid === false ? "Nghỉ không lương" : c.leavePaid ? "Nghỉ phép hưởng lương" : "Nghỉ làm";
    case "on_time": case "upcoming": return null;
    default: return STATUS[c.status].label;
  }
}
const timeLine = (c: BoardCellT) => {
  if (c.inAt || c.outAt) return `${c.inAt ? vnTime(c.inAt) : "--"} - ${c.outAt ? vnTime(c.outAt) : "--"}`;
  if ((c.status === "upcoming" || c.status === "auto" || c.status === "leave") && c.startAt && c.endAt) return `${vnTime(c.startAt)} - ${vnTime(c.endAt)}`;
  return "-- --";
};

function Card({ c, b, as, onPick, selMode, on, off }: { c: BoardCellT; b: BoardResp; as: View; onPick: (c: BoardCellT) => void; selMode: boolean; on: boolean; off: boolean }) {
  const emp = b.employees.find((e) => e.id === c.employeeId);
  const shift = b.shifts.find((s) => s.id === (c.shiftId ?? 0));
  const name = as === "shift" ? emp?.name ?? `NV #${c.employeeId}` : shift?.name ?? "Ngoài lịch";
  const line = statusLine(c);
  const sub = c.substituteForId ? `Làm thay ${b.employees.find((e) => e.id === c.substituteForId)?.name ?? ""}` : "";
  const inc = c.incidents;
  return (
    <button type="button" data-cell={c.key} data-status={c.status} aria-pressed={selMode ? on : undefined} disabled={off}
      className={`bd-card st-${c.status}${selMode ? " selm" : ""}${c.pending ? " pend" : ""}${on ? " on" : ""}${off ? " off" : ""}`}
      onClick={() => onPick(c)} aria-label={`${name}, ${STATUS[c.status].label}`}>
      {selMode && <span className="tick" aria-hidden="true">{on ? "✓" : ""}</span>}
      <span className="n">{name}</span>
      <span className="t">{timeLine(c)}</span>
      {(line || sub || c.pending > 0 || inc.penalty > 0 || inc.bonus > 0 || c.manual || !c.assignmentId) && (
        <span className="s">
          {line && <span>{line}</span>}
          {sub && <span className="bdc">{sub}</span>}
          {c.pending > 0 && <span className="bdc" title="Có lần chấm chờ duyệt">Chờ duyệt</span>}
          {inc.penalty > 0 && <span className="bdc" title={inc.amountPenalty != null ? `Phạt ${moneyFmt(inc.amountPenalty)} ₫` : "Có phạt"}>Phạt ×{inc.penalty}</span>}
          {inc.bonus > 0 && <span className="bdc" title={inc.amountBonus != null ? `Thưởng ${moneyFmt(inc.amountBonus)} ₫` : "Có thưởng"}>Thưởng ×{inc.bonus}</span>}
          {c.manual && <span className="bdc">Thủ công</span>}
          {!c.assignmentId && <span className="bdc">Ngoài lịch</span>}
        </span>
      )}
    </button>
  );
}

function ExportMenu({ b, from, to, disabled }: { b?: BoardResp; from: string; to: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const board = () => {
    if (!b) return;
    const E = new Map(b.employees.map((e) => [e.id, e])), S = new Map(b.shifts.map((s) => [s.id, s]));
    const rows = [...b.cells].sort((x, y) => x.workDate.localeCompare(y.workDate) || x.employeeId - y.employeeId).map((c) => [
      c.workDate, E.get(c.employeeId)?.code ?? "", E.get(c.employeeId)?.name ?? "", S.get(c.shiftId ?? 0)?.name ?? "Ngoài lịch",
      c.inAt ? vnTime(c.inAt) : "", c.outAt ? vnTime(c.outAt) : "", STATUS[c.status].label, c.lateMinutes, c.earlyMinutes, c.otMinutes, Math.round((c.workedMinutes / 60) * 100) / 100,
    ]);
    downloadCsv(`bang-cham-cong-${from}_${to}`, ["Ngày", "Mã NV", "Nhân viên", "Ca", "Giờ vào", "Giờ ra", "Trạng thái", "Đi muộn (phút)", "Về sớm (phút)", "Làm thêm (phút)", "Giờ làm"], rows);
    setOpen(false);
  };
  const incidents = async () => {
    setBusy(true);
    try {
      const r: any = await get("/attendance/incidents", { from, to });
      const rows = items<any>(r).map((i) => [i.workDate, i.employeeName, i.shiftName ?? "", i.kind === "penalty" ? "Phạt" : "Thưởng", i.typeName, i.times, i.amountEach ?? "", i.amount ?? "", i.note ?? "", i.createdByName ?? "", i.voided ? "Đã huỷ" : ""]);
      if (!rows.length) { toast("Không có phạt / thưởng trong khoảng này", "info"); return; }
      downloadCsv(`phat-thuong-${from}_${to}`, ["Ngày", "Nhân viên", "Ca", "Loại", "Tên", "Số lần", "Mức mỗi lần", "Thành tiền", "Ghi chú", "Người tạo", "Ghi chú huỷ"], rows);
    } catch { /* toast */ } finally { setBusy(false); setOpen(false); }
  };
  return (
    <div className="bd-menu">
      <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={open} disabled={disabled} loading={busy} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style={{ stroke: "currentColor", fill: "none", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg> <span>Xuất<span className="bd-hm"> file</span></span>
      </Button>
      {open && <div className="bd-pop" role="menu" onMouseLeave={() => setOpen(false)}>
        <button role="menuitem" onClick={board}>Bảng chấm công (CSV)</button>
        <button role="menuitem" onClick={incidents}>Tổng phạt vi phạm / thưởng (CSV)</button>
      </div>}
    </div>
  );
}

export default function Board() {
  const can = useCan();
  const canWrite = can("hr.schedule");
  const pc = useMedia("(min-width: 1024px)");
  const [range, setRange] = useState<Range>(() => (ls("hm_bd_range", "week") === "month" ? "month" : "week"));
  const [view, setView] = useState<View>(() => (ls("hm_bd_view", "shift") === "emp" ? "emp" : "shift"));
  const [anchor, setAnchor] = useState(todayVN());
  const [q, setQ] = useState("");
  const { from, to } = rangeOf(range, anchor);
  const data = useAsync(() => get<BoardResp>("/attendance/board", { from, to, ...(q ? { q } : {}) }), [from, to, q]);
  const b = data.data;
  const today = b?.today ?? todayVN();
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null); // key ô đang mở
  const [bulk, setBulk] = useState(false);
  const [approvals, setApprovals] = useState(false);
  const [sched, setSched] = useState(false);
  const [add, setAdd] = useState<{ shift: BoardShift; date: string } | null>(null);
  const [tpl, setTpl] = useState(false);
  const [selDay, setSelDay] = useState(todayVN());

  const days = useMemo(() => { const out: string[] = []; for (let d = from; d <= to; d = addDaysS(d, 1)) out.push(d); return out; }, [from, to]);
  useEffect(() => { if (!days.includes(selDay)) setSelDay(days.includes(todayVN()) ? todayVN() : days[0]); }, [days]); // eslint-disable-line
  useEffect(() => { setSel([]); }, [from, to, q]);

  const byKey = useMemo(() => new Map((b?.cells ?? []).map((c) => [c.key, c])), [b]);
  const byRowDay = useMemo(() => { const m = new Map<string, BoardCellT[]>(); if (b) for (const c of b.cells) { const k = `${rowKeyOf(c, b)}|${c.workDate}`; m.set(k, [...(m.get(k) ?? []), c]); } return m; }, [b]);
  const byEmpDay = useMemo(() => { const m = new Map<string, BoardCellT[]>(); for (const c of b?.cells ?? []) { const k = `${c.employeeId}|${c.workDate}`; m.set(k, [...(m.get(k) ?? []), c]); } return m; }, [b]);
  const shiftRows = useMemo(() => {
    if (!b) return [] as { id: number; name: string; startTime?: string; endTime?: string; shift?: BoardShift }[];
    const used = new Set(b.cells.map((c) => rowKeyOf(c, b)));
    const rows: { id: number; name: string; startTime?: string; endTime?: string; shift?: BoardShift }[] = b.shifts.filter((s) => s.active || used.has(s.id)).map((s) => ({ id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime, shift: s }));
    if (used.has(OFF_ROW)) rows.push({ id: OFF_ROW, name: "Ngoài lịch" });
    return rows;
  }, [b]);

  const closedOf = (d: string) => !!b?.periodsClosed.includes(d.slice(0, 7));
  const selCells = sel.map((k) => byKey.get(k)).filter(Boolean) as BoardCellT[];
  const selRow = selCells.length && b ? rowKeyOf(selCells[0], b) : null;
  const pick = (c: BoardCellT) => {
    if (!selMode) { setOpen(c.key); return; }
    if (closedOf(c.workDate) || !b) return;
    setSel((s) => (s.includes(c.key) ? s.filter((x) => x !== c.key) : selRow != null && rowKeyOf(c, b) !== selRow && s.length ? s : [...s, c.key]));
  };
  const cardProps = (c: BoardCellT) => ({ b: b!, onPick: pick, selMode, on: sel.includes(c.key), off: selMode && (closedOf(c.workDate) || (selRow != null && rowKeyOf(c, b!) !== selRow)) });
  const reload = () => data.reload();
  const setR = (r: Range) => { setRange(r); lsSet("hm_bd_range", r); };
  const setV = (v: View) => { setView(v); lsSet("hm_bd_view", v); };
  const nav = (n: number) => setAnchor(range === "week" ? addDaysS(anchor, 7 * n) : shiftPeriod(anchor.slice(0, 7), n) + "-01");
  const label = range === "week" ? `Tuần ${isoWeek(from)} — ${dm(from)}–${dm(to)}` : `Tháng ${from.slice(5, 7)}/${from.slice(0, 4)}`;
  const openCell = open ? byKey.get(open) : undefined;
  const pendingTotal = b?.pendingTotal ?? 0;

  const toolbar = (
    <div className="bd-bar" data-testid="board-toolbar">
      <SearchInput value={q} onSearch={setQ} placeholder="Tìm nhân viên" label="Tìm nhân viên" />
      <Segmented fit value={range} onChange={setR} options={[{ v: "week", label: "Theo tuần" }, { v: "month", label: "Theo tháng" }]} />
      <div className="bd-nav" role="group" aria-label="Khoảng thời gian">
        <Button variant="ghost" size="sm" aria-label={range === "week" ? "Tuần trước" : "Tháng trước"} onClick={() => nav(-1)}>‹</Button>
        <b data-testid="board-range">{label}</b>
        <Button variant="ghost" size="sm" aria-label={range === "week" ? "Tuần sau" : "Tháng sau"} onClick={() => nav(1)}>›</Button>
      </div>
      <Button variant="soft" size="sm" onClick={() => { setAnchor(todayVN()); setSelDay(todayVN()); }}>Hôm nay</Button>
      <Segmented fit value={view} onChange={setV} options={[{ v: "shift", label: "Xem theo ca" }, { v: "emp", label: "Xem theo nhân viên" }]} />
      <div className="bd-actions">
      {canWrite && <Button variant={selMode ? "primary" : "ghost"} size="sm" aria-pressed={selMode} onClick={() => { setSelMode(!selMode); setSel([]); }}>Chọn</Button>}
      {canWrite && <Button variant="ghost" size="sm" data-testid="approve-btn" onClick={() => setApprovals(true)}><span>Duyệt<span className="bd-hm"> chấm công</span></span>{pendingTotal ? <span className="bd-badge" aria-label={`${pendingTotal} việc chờ`}>{pendingTotal}</span> : null}</Button>}
      {canWrite && <Button variant="soft" size="sm" onClick={() => setSched(true)}>Xếp lịch</Button>}
      <ExportMenu b={b} from={from} to={to} disabled={!b} />
      </div>
    </div>
  );

  const legend = pc ? (
    <div className="bd-legend" aria-label="Chú thích màu">{LEGEND.map((s) => <span key={s} className={"st-" + s}><i />{STATUS[s].label}</span>)}</div>
  ) : null;

  /* ---------- PC: lưới theo ca / nhân viên / tháng ---------- */
  const dayHead = (d: string) => (
    <div key={d} className={"bd-h" + (d === today ? " today" : "")}>{WD_LONG[wdOf(d)]} <span className="dn">{d.slice(8)}</span></div>
  );
  const weekGrid = b && (
    <div className="bd-scroll"><div className="bd-grid" data-testid="board-grid" style={{ ["--bd-cols" as any]: 7 }}>
      <div className="bd-h first">{view === "shift" ? "Ca làm việc" : "Nhân viên"}
        {view === "shift" && canWrite && b.mode === "shift" && <Button variant="ghost" size="sm" className="icon-btn" aria-label="Thêm ca mẫu" title="Thêm ca mẫu" onClick={() => setTpl(true)}>+</Button>}
      </div>
      {days.map((d) => dayHead(d))}
      {view === "shift" ? shiftRows.map((r) => (
        <Fragment key={r.id}>
          <div className="bd-side"><b>{r.name}</b>{r.startTime && <span>{r.startTime} - {r.endTime}</span>}</div>
          {days.map((d) => {
            const list = byRowDay.get(`${r.id}|${d}`) ?? [];
            const addable = canWrite && !selMode && !!r.shift && r.id > 0 && !closedOf(d);
            return (
              <div key={d} className={"bd-slot" + (d === today ? " today" : "") + (addable ? " add" : "")} data-slot={`${r.id}|${d}`}>
                {addable && <button type="button" className="hit" aria-label={`Thêm nhân viên vào ${r.name} ngày ${dm(d)}`} onClick={() => setAdd({ shift: r.shift!, date: d })} />}
                {list.map((c) => <Card key={c.key} c={c} as="shift" {...cardProps(c)} />)}
              </div>
            );
          })}
        </Fragment>
      )) : b.employees.map((e) => (
        <Fragment key={e.id}>
          <div className="bd-side"><b>{e.name}</b><span>{e.code}{e.position ? ` · ${e.position}` : ""}</span></div>
          {days.map((d) => <div key={d} className={"bd-slot" + (d === today ? " today" : "")}>{(byEmpDay.get(`${e.id}|${d}`) ?? []).map((c) => <Card key={c.key} c={c} as="emp" {...cardProps(c)} />)}</div>)}
        </Fragment>
      ))}
    </div></div>
  );

  const monthGrid = b && (
    <div className="bd-scroll"><div className="bd-grid bd-mgrid" data-testid="board-grid" style={{ ["--bd-cols" as any]: days.length }}>
      <div className="bd-h first">Nhân viên</div>
      {days.map((d) => <div key={d} className={"bd-h" + (d === today ? " today" : "") + (wdOf(d) >= 5 ? " we" : "")} title={dm(d)}>{WD_SHORT[wdOf(d)]}<small><span className="dn">{+d.slice(8)}</span></small></div>)}
      {b.employees.map((e) => (
        <Fragment key={e.id}>
          <div className="bd-side"><b>{e.name}</b><span>{e.code}</span></div>
          {days.map((d) => (
            <div key={d} className={"bd-slot" + (d === today ? " today" : "")}>
              {(byEmpDay.get(`${e.id}|${d}`) ?? []).map((c) => (
                <button key={c.key} type="button" data-cell={c.key} className={`bd-dot st-${c.status}${c.pending ? " pend" : ""}`} aria-label={`${e.name} ${dm(d)}: ${STATUS[c.status].label}`} title={`${e.name} · ${dm(d)} · ${STATUS[c.status].label}`} onClick={() => setOpen(c.key)} />
              ))}
            </div>
          ))}
        </Fragment>
      ))}
    </div></div>
  );

  /* ---------- Điện thoại: dải ngày / lịch tháng + danh sách theo ca ---------- */
  const dayDots = (d: string) => { const st = [...new Set((b?.cells ?? []).filter((c) => c.workDate === d).map((c) => c.status))].slice(0, 4); return <span className="dots">{st.map((s) => <i key={s} className={"st-" + s} />)}</span>; };
  const dayBtn = (d: string, small?: boolean) => (
    <button key={d} type="button" className={"bd-day" + (d === selDay ? " sel" : "") + (d === today ? " today" : "")} aria-pressed={d === selDay} data-day={d} onClick={() => setSelDay(d)}>
      {!small && <small>{WD_SHORT[wdOf(d)]}</small>}<b>{+d.slice(8)}</b>{dayDots(d)}
    </button>
  );
  const dayCells = (b?.cells ?? []).filter((c) => c.workDate === selDay);
  const mobileList = b && (
    <div className="bd-list" data-testid="board-list">
      <div className="muted small">{WD_LONG[wdOf(selDay)]}, {dm(selDay)} · {dayCells.length} ca{closedOf(selDay) ? " · kỳ đã chốt" : ""}</div>
      {!dayCells.length && <EmptyState title="Chưa có ca nào trong ngày" hint={canWrite ? "Bấm “Xếp lịch” để thêm ca." : undefined} />}
      {view === "shift" ? shiftRows.map((r) => {
        const list = byRowDay.get(`${r.id}|${selDay}`) ?? [];
        if (!list.length) return null;
        return <div key={r.id} className="bd-list"><h3>{r.name}<span>{r.startTime ? `${r.startTime} - ${r.endTime}` : ""}</span></h3>{list.map((c) => <Card key={c.key} c={c} as="shift" {...cardProps(c)} />)}</div>;
      }) : b.employees.map((e) => {
        const list = byEmpDay.get(`${e.id}|${selDay}`) ?? [];
        if (!list.length) return null;
        return <div key={e.id} className="bd-list"><h3>{e.name}<span>{e.code}</span></h3>{list.map((c) => <Card key={c.key} c={c} as="emp" {...cardProps(c)} />)}</div>;
      })}
    </div>
  );
  const strip = range === "week" ? <div className="bd-days" data-testid="day-strip">{days.map((d) => dayBtn(d))}</div> : (
    <div className="bd-cal" data-testid="month-cal">
      {WD_SHORT.map((w) => <div key={w} className="wd">{w}</div>)}
      {Array.from({ length: wdOf(from) }, (_, i) => <div key={"b" + i} className="bd-day blank" />)}
      {days.map((d) => dayBtn(d, true))}
    </div>
  );

  return (
    <div className="bd" data-testid="board">
      {toolbar}
      {data.err && !b ? <Banner>Không tải được bảng chấm công. <Button size="sm" variant="ghost" onClick={reload}>Thử lại</Button></Banner> : null}
      {!b && !data.err && <Spinner />}
      {b && b.mode === "window" && <div className="bd-ro">Đang chấm công theo khung giờ làm việc (không theo ca).</div>}
      {b && (pc ? (
        <div style={{ opacity: data.loading ? 0.6 : 1, transition: "opacity .15s" }}>
          {range === "month" ? monthGrid : weekGrid}
          {!b.employees.length && <EmptyState title="Không có nhân viên phù hợp" />}
        </div>
      ) : (
        <div className="stack" style={{ opacity: data.loading ? 0.6 : 1 }}>
          {strip}
          <div className="bd-legend-m" aria-label="Chú thích màu">{LEGEND.map((s) => <span key={s} className={"st-" + s}><i />{STATUS[s].label}</span>)}</div>
          {mobileList}
        </div>
      ))}
      <div className="bd-dock">
        {selMode && (
          <div className="bd-selbar" data-testid="select-bar">
            <b>Đã chọn {sel.length}</b>
            <Button size="sm" disabled={!sel.length} onClick={() => setBulk(true)}>Chỉnh sửa chấm công</Button>
            <Button size="sm" variant="ghost" onClick={() => { setSelMode(false); setSel([]); }}>Huỷ</Button>
          </div>
        )}
        {legend}
      </div>

      {openCell && b && <CellSheet key={openCell.key} cell={openCell} board={b} canWrite={canWrite} onClose={() => setOpen(null)} onChanged={reload} />}
      {bulk && b && selCells.length > 0 && <BulkEditSheet cells={selCells} board={b} onClose={() => setBulk(false)} onDone={() => { setBulk(false); setSel([]); setSelMode(false); reload(); }} />}
      {approvals && <Sheet open wide title="Duyệt chấm công" onClose={() => { setApprovals(false); reload(); }}><Attendance onChange={reload} /></Sheet>}
      {sched && <ScheduleSheet anchor={range === "week" ? from : selDay} onClose={() => setSched(false)} onDone={() => { setSched(false); reload(); }} />}
      {add && b && <AddToShiftSheet shift={add.shift} date={add.date} taken={new Set((byRowDay.get(`${add.shift.id}|${add.date}`) ?? []).map((c) => c.employeeId))} onClose={() => setAdd(null)} onDone={() => { setAdd(null); reload(); }} />}
      {tpl && <TplForm t={{}} onClose={() => setTpl(false)} onSaved={() => { setTpl(false); reload(); }} />}
    </div>
  );
}

