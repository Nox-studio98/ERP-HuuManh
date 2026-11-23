import { useState } from "react";
import { ApiError, get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, useAsync } from "../../components/ui";
import { BarChart } from "../../components/charts";
import { toast } from "../../components/toast";
import { downloadHref, money } from "../../format";
import { navigate } from "../../router";
import { useCan } from "../../store";
import { Confirm, ENTRY_KIND, moneyFmt, PAY_TYPE, PERIOD_STATUS, days10, dmy, hm, periodLabel, periodTone, shiftPeriod, thisPeriod } from "./kit";

type Tab = "periods" | "entries" | "advances" | "cost";
export default function Payroll() {
  const can = useCan();
  if (!can("hr.sensitive")) return <EmptyState title="Bạn không có quyền xem bảng lương" />;
  return <Inner />;
}
function Inner() {
  const [tab, setTab] = useState<Tab>("periods");
  const [period, setPeriod] = useState<string | null>(null);
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={[{ v: "periods", label: "Kỳ lương" }, { v: "entries", label: "Thưởng / phạt" }, { v: "advances", label: "Tạm ứng" }, { v: "cost", label: "Chi phí nhân sự" }]} />
      {tab === "periods" && (period ? <Detail period={period} onBack={() => setPeriod(null)} /> : <Periods onOpen={setPeriod} />)}
      {tab === "entries" && <Entries />}
      {tab === "advances" && <Advances />}
      {tab === "cost" && <Cost />}
    </div>
  );
}

/* ---------- danh sách kỳ + tính ---------- */
function Periods({ onOpen }: { onOpen: (p: string) => void }) {
  const can = useCan();
  const l = useAsync(() => get("/payroll/periods").then((r) => items<any>(r)), []);
  const [np, setNp] = useState(shiftPeriod(thisPeriod(), -1));
  const [busy, setBusy] = useState(false);
  const [open409, setOpen409] = useState<string | null>(null);
  const calc = async (p: string) => {
    setBusy(true); setOpen409(null);
    try { const r = await post(`/payroll/periods/${p}/calculate`, {}, { silent: true }); toast(`Đã tính lương ${r.employees} nhân viên`, "ok"); l.reload(); onOpen(p); }
    catch (e) { if (e instanceof ApiError && e.code === "timesheet_open") setOpen409(p); else toast((e as Error).message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack">
      {can("payroll.write") && (
        <Card title="Tính lương kỳ mới">
          <div className="row wrap" style={{ alignItems: "flex-end" }}>
            <div className="grow"><Input label="Kỳ lương" type="month" value={np} onChange={(e) => setNp(e.target.value)} /></div>
            <Button loading={busy} disabled={!np} onClick={() => calc(np)} data-testid="calc-new">Tính lương</Button>
          </div>
          {open409 && <div style={{ marginTop: 8 }}><Banner>Bảng công {periodLabel(open409)} chưa chốt nên chưa tính lương được. <a href={`/hr/timesheets?period=${open409}`} onClick={(e) => { e.preventDefault(); navigate(`/hr/timesheets?period=${open409}`); }}>Mở bảng công để chốt</a></Banner></div>}
        </Card>
      )}
      {l.loading ? <Spinner /> : !(l.data ?? []).length ? <EmptyState title="Chưa có kỳ lương nào" hint="Chốt bảng công của một tháng rồi bấm Tính lương." /> : (
        <div className="stack" data-testid="period-list">
          {l.data!.map((p) => (
            <button key={p.period} className="dt-card" onClick={() => onOpen(p.period)}>
              <div className="row between"><b>{periodLabel(p.period)}</b><Badge tone={periodTone(p.status)}>{PERIOD_STATUS[p.status] ?? p.status}</Badge></div>
              <div className="row between small"><span className="muted">{p.employeeCount} nhân viên</span><span className="num">Thực lĩnh {money(p.totalNet)} · Chi phí {money(p.totalCost)}</span></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- chi tiết kỳ ---------- */
function Detail({ period, onBack }: { period: string; onBack: () => void }) {
  const can = useCan();
  const l = useAsync(() => get("/payroll/periods/" + period, undefined, { silent: true }), [period]);
  const [row, setRow] = useState<any>(null);
  const [act, setAct] = useState<"approve" | "pay" | "recalc" | null>(null);
  const d = l.data;
  const st = d?.status;
  return (
    <div className="stack">
      <div className="row wrap between">
        <Button size="sm" variant="ghost" onClick={onBack}>← Các kỳ lương</Button>
        <div className="row wrap">
          {can("payroll.write") && (st === "calculated" || st === "draft") && <Button size="sm" variant="soft" onClick={() => setAct("recalc")}>Tính lại</Button>}
          {can("payroll.approve") && st === "calculated" && <Button size="sm" onClick={() => setAct("approve")} data-testid="approve">Duyệt bảng lương</Button>}
          {can("payroll.write") && st === "approved" && <Button size="sm" onClick={() => setAct("pay")} data-testid="pay">Chi lương</Button>}
          {can("payroll.write") && d && <a className="btn ghost sm" href={downloadHref(`/payroll/periods/${period}/export.xlsx`)} download>Xuất Excel</a>}
        </div>
      </div>
      <div className="row"><h2 style={{ margin: 0 }}>{periodLabel(period)}</h2>{st && <Badge tone={periodTone(st)}>{PERIOD_STATUS[st]}</Badge>}</div>
      {l.err && !d ? <EmptyState title="Chưa có bảng lương kỳ này" hint="Hãy tính lương cho kỳ này sau khi chốt bảng công." /> : l.loading ? <Spinner /> : d && (
        <>
          <div className="kpis">
            <div className="kpi"><div className="l">Tổng thu nhập</div><div className="v">{money(d.totals.gross)}</div></div>
            <div className="kpi"><div className="l">Thực lĩnh</div><div className="v" data-testid="total-net">{money(d.totals.net)}</div></div>
            <div className="kpi"><div className="l">BH + TNCN (NLĐ)</div><div className="v">{money(d.totals.insuranceEmployee + d.totals.pit)}</div></div>
            <div className="kpi"><div className="l">Chi phí DN</div><div className="v">{money(d.totals.cost)}</div></div>
          </div>
          <DataTable<any> rows={d.items} rowKey={(r) => r.employeeId} onRowClick={setRow} empty="Kỳ này chưa có nhân viên"
            cols={[
              { key: "n", label: "Nhân viên (số tiền: ₫)", title: true, render: (r) => <b>{r.name} <span className="muted small">{r.code}</span></b> },
              { key: "w", label: "Công", right: true, render: (r) => (r.payType === "shift" ? `${r.shifts} ca` : r.payType === "hourly" ? hm(r.workedMinutes) : `${days10(r.paidDaysX10)} ngày`) },
              { key: "b", label: "Lương", right: true, hideMobile: true, render: (r) => M(r.basePay) },
              { key: "a", label: "Phụ cấp", right: true, hideMobile: true, render: (r) => M(r.allowances) },
              { key: "o", label: "Tăng ca", right: true, hideMobile: true, render: (r) => M(r.overtimePay) },
              { key: "bn", label: "Thưởng/phạt", right: true, hideMobile: true, render: (r) => M(r.bonus + r.salesBonus - r.penalties + r.adjustments) },
              { key: "g", label: "Tổng thu nhập", right: true, render: (r) => M(r.gross) },
              { key: "i", label: "BH + thuế", right: true, hideMobile: true, render: (r) => M(r.insuranceEmployee + r.pit) },
              { key: "ad", label: "Tạm ứng", right: true, hideMobile: true, render: (r) => M(r.advances) },
              { key: "net", label: "Thực lĩnh", right: true, render: (r) => <b>{M(r.net)}</b> },
            ]} />
          <div className="hint">Công thức, mức bảo hiểm và biểu thuế là tham số cần chủ cửa hàng xác nhận.</div>
        </>
      )}
      {row && <RowDetail r={row} onClose={() => setRow(null)} />}
      {act === "recalc" && <Confirm title="Tính lại bảng lương" confirmLabel="Tính lại" onClose={() => setAct(null)} onConfirm={async () => { try { await post(`/payroll/periods/${period}/calculate`, {}); toast("Đã tính lại", "ok"); setAct(null); l.reload(); } catch { setAct(null); } }}>Tính lại sẽ thay thế toàn bộ bảng lương nháp bằng dữ liệu mới nhất (công, thưởng/phạt, tạm ứng).</Confirm>}
      {act === "approve" && <Confirm title="Duyệt bảng lương" confirmLabel="Duyệt & khoá kỳ" onClose={() => setAct(null)} onConfirm={async () => { try { await post(`/payroll/periods/${period}/approve`, {}); toast("Đã duyệt bảng lương", "ok"); setAct(null); l.reload(); } catch { setAct(null); } }}>Sau khi duyệt, bảng lương bị khoá và nhân viên xem được phiếu lương. Tổng thực lĩnh: <b>{money(d?.totals.net)}</b>.</Confirm>}
      {act === "pay" && <PayForm period={period} total={d?.totals.net ?? 0} onClose={() => setAct(null)} onDone={() => { setAct(null); l.reload(); }} />}
    </div>
  );
}
const M = (n: number) => <span style={{ whiteSpace: "nowrap" }}>{moneyFmt(n)}</span>;
function RowDetail({ r, onClose }: { r: any; onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} title={`${r.name} · ${PAY_TYPE[r.payType]}`}>
      <div className="stack" data-testid="payroll-row">
        {(r.lines ?? []).map((x: any, i: number) => (
          <div key={i} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 4 }}>
            <div className="row between"><span style={{ fontWeight: x.group === "info" ? 600 : 400 }}>{x.label}</span><b className="num">{money(x.amount)}</b></div>
            {x.note && <div className="small muted">{x.note}</div>}
          </div>
        ))}
        <div className="row between"><b>Thực lĩnh</b><b className="num">{money(r.net)}</b></div>
      </div>
    </Sheet>
  );
}
function PayForm({ period, total, onClose, onDone }: { period: string; total: number; onClose: () => void; onDone: () => void }) {
  const funds = useAsync(() => get("/funds").then((r) => items<any>(r).filter((f) => f.active)), []);
  const [fund, setFund] = useState("");
  const [busy, setBusy] = useState(false);
  const fid = Number(fund || funds.data?.[0]?.id || 0);
  return (
    <Confirm title="Chi lương" confirmLabel="Chi lương" busy={busy} disabled={!fid} onClose={onClose}
      onConfirm={async () => { setBusy(true); try { const r = await post(`/payroll/periods/${period}/pay`, { fundId: fid }); toast(`Đã lập ${r.vouchers.length} phiếu chi lương`, "ok"); onDone(); } catch { /* toast */ } finally { setBusy(false); } }}>
      <div>Mỗi nhân viên một phiếu chi (khoản mục LƯƠNG). Tổng thực lĩnh: <b>{money(total)}</b>.</div>
      {funds.loading ? <Spinner /> : <Select label="Chi từ quỹ" value={fund || String(funds.data?.[0]?.id ?? "")} onChange={(e) => setFund(e.target.value)}>{(funds.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.name} — số dư {money(f.balance)}</option>)}</Select>}
    </Confirm>
  );
}

/* ---------- thưởng / phạt ---------- */
function Entries() {
  const [period, setPeriod] = useState(thisPeriod());
  const l = useAsync(() => get("/payroll/entries", { period }).then((r) => items<any>(r)), [period]);
  const emps = useAsync(() => get("/employees", { status: "active", limit: 200 }).then((r) => items<any>(r)), []);
  const [add, setAdd] = useState(false);
  return (
    <div className="stack">
      <div className="row wrap between"><div style={{ maxWidth: 200 }}><Input label="Kỳ" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} /></div><Button onClick={() => setAdd(true)}>+ Thêm khoản</Button></div>
      {l.loading ? <Spinner /> : (
        <DataTable<any> rows={l.data ?? []} rowKey={(r) => r.id} empty="Chưa có khoản thưởng/phạt nào trong kỳ"
          cols={[
            { key: "e", label: "Nhân viên", title: true, render: (r) => <b>{r.employeeName}</b> },
            { key: "k", label: "Loại", render: (r) => <Badge tone={r.kind === "penalty" ? "danger" : r.kind === "adjustment" ? "info" : "ok"}>{ENTRY_KIND[r.kind]}</Badge> },
            { key: "a", label: "Số tiền", right: true, render: (r) => money(r.amount) },
            { key: "r", label: "Lý do", render: (r) => r.reason },
          ]} />
      )}
      {add && <EntryForm period={period} emps={emps.data ?? []} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); l.reload(); }} />}
    </div>
  );
}
function EntryForm({ period, emps, onClose, onSaved }: { period: string; emps: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ employeeId: emps[0]?.id ?? 0, kind: "bonus", amount: 0, reason: "", taxable: true, negative: false }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={`Thêm khoản · ${periodLabel(period)}`} footer={<Button block loading={busy} disabled={!f.employeeId || !f.amount || !f.reason.trim()} onClick={async () => {
      setBusy(true);
      try { await post("/payroll/entries", { employeeId: Number(f.employeeId), period, kind: f.kind, amount: f.kind === "adjustment" && f.negative ? -f.amount : f.amount, reason: f.reason.trim(), taxable: f.taxable }); toast("Đã thêm khoản", "ok"); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
    }}>Lưu</Button>}>
      <div className="stack">
        <Select label="Nhân viên" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: Number(e.target.value) })}>{emps.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}</Select>
        <Select label="Loại" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(ENTRY_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <MoneyInput label="Số tiền (₫)" value={f.amount} onChange={(n) => setF({ ...f, amount: n })} />
        {f.kind === "adjustment" && <label className="row"><input type="checkbox" checked={f.negative} onChange={(e) => setF({ ...f, negative: e.target.checked })} /> Điều chỉnh giảm (trừ)</label>}
        <Input label="Lý do" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        {f.kind !== "penalty" && <label className="row"><input type="checkbox" checked={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} /> Chịu thuế TNCN</label>}
        <div className="hint">Kỳ lương đã duyệt/đã chi không nhận thêm khoản; hãy ghi điều chỉnh vào kỳ sau.</div>
      </div>
    </Sheet>
  );
}

/* ---------- tạm ứng ---------- */
const ADV_STATUS: Record<string, string> = { paid: "Đã ứng", deducted: "Đã khấu trừ", cancelled: "Đã huỷ" };
function Advances() {
  const l = useAsync(() => get("/payroll/advances").then((r) => items<any>(r)), []);
  const emps = useAsync(() => get("/employees", { status: "active", limit: 200 }).then((r) => items<any>(r)), []);
  const funds = useAsync(() => get("/funds").then((r) => items<any>(r).filter((f) => f.active)), []);
  const [add, setAdd] = useState(false);
  return (
    <div className="stack">
      <div className="row"><Button onClick={() => setAdd(true)}>+ Tạm ứng lương</Button></div>
      {l.loading ? <Spinner /> : (
        <DataTable<any> rows={l.data ?? []} rowKey={(r) => r.id} empty="Chưa có khoản tạm ứng"
          cols={[
            { key: "e", label: "Nhân viên", title: true, render: (r) => <b>{r.employeeName}</b> },
            { key: "a", label: "Số tiền", right: true, render: (r) => money(r.amount) },
            { key: "d", label: "Ngày ứng", render: (r) => dmy(r.advanceDate) },
            { key: "p", label: "Khấu trừ kỳ", render: (r) => r.deductPeriod },
            { key: "v", label: "Phiếu chi", hideMobile: true, render: (r) => r.voucherCode },
            { key: "s", label: "Trạng thái", render: (r) => <Badge tone={r.status === "deducted" ? "ok" : "warn"}>{ADV_STATUS[r.status] ?? r.status}</Badge> },
          ]} />
      )}
      {add && <AdvForm emps={emps.data ?? []} funds={funds.data ?? []} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); l.reload(); }} />}
    </div>
  );
}
function AdvForm({ emps, funds, onClose, onSaved }: { emps: any[]; funds: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ employeeId: emps[0]?.id ?? 0, amount: 0, fundId: funds[0]?.id ?? 0, reason: "" }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Tạm ứng lương" footer={<Button block loading={busy} disabled={!f.employeeId || !f.amount || !f.fundId} onClick={async () => {
      setBusy(true);
      try { const r = await post("/payroll/advances", { employeeId: Number(f.employeeId), amount: f.amount, fundId: Number(f.fundId), reason: f.reason.trim() || undefined }); toast(`Đã chi tạm ứng, khấu trừ kỳ ${r.deductPeriod}`, "ok"); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
    }}>Chi tạm ứng</Button>}>
      <div className="stack">
        <Select label="Nhân viên" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: Number(e.target.value) })}>{emps.map((e) => <option key={e.id} value={e.id}>{e.fullName}</option>)}</Select>
        <MoneyInput label="Số tiền (₫)" value={f.amount} onChange={(n) => setF({ ...f, amount: n })} />
        <Select label="Chi từ quỹ" value={f.fundId} onChange={(e) => setF({ ...f, fundId: Number(e.target.value) })}>{funds.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        <Input label="Lý do" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <div className="hint">Tạo phiếu chi và tự khấu trừ vào kỳ lương kế tiếp chưa tính.</div>
      </div>
    </Sheet>
  );
}

/* ---------- chi phí ---------- */
function Cost() {
  const l = useAsync(() => get("/payroll/reports/cost"), []);
  if (l.loading) return <Spinner />;
  const d = l.data;
  if (!d || !d.byMonth.length) return <EmptyState title="Chưa có dữ liệu chi phí" hint="Chi phí chỉ tính từ các kỳ lương đã duyệt hoặc đã chi." />;
  return (
    <div className="stack">
      <Card title={`Chi phí nhân sự ${d.from} → ${d.to}`}>
        <BarChart data={d.byMonth.map((m: any) => ({ label: m.period, value: m.cost }))} />
        <div className="row between" style={{ marginTop: 8 }}><span className="muted">Tổng chi phí (gồm BH doanh nghiệp)</span><b className="num">{money(d.totals.cost)}</b></div>
      </Card>
      <Card title="Theo vị trí">
        <DataTable<any> rows={d.byPosition} rowKey={(r) => r.position} cols={[
          { key: "p", label: "Vị trí", title: true, render: (r) => <b>{r.position}</b> },
          { key: "n", label: "Số NV", right: true, render: (r) => r.employees },
          { key: "g", label: "Thu nhập", right: true, render: (r) => money(r.gross) },
          { key: "c", label: "Chi phí", right: true, render: (r) => money(r.cost) },
        ]} />
      </Card>
    </div>
  );
}
