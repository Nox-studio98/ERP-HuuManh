import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, DecInput, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../../components/ui";
import { toast } from "../../components/toast";
import { money, ROLES, todayVN } from "../../format";
import { useAuth, useCan } from "../../store";
import { Confirm, EMP_STATUS, PAY_TYPE, dmy, useLeaveTypes } from "./kit";

const EMPTY = { fullName: "", position: "Nhân viên bán hàng", hireDate: todayVN(), payType: "monthly", baseSalary: 0, hourlyRate: 0, shiftRate: 0, insuranceSalary: 0, dependents: 0, annualLeaveDays: 12, locationExempt: false, pitEnabled: false, phone: "", email: "", idNumber: "", dob: "", address: "", bankName: "", bankAccount: "", note: "" };

export default function Employees() {
  const can = useCan();
  const sens = can("hr.sensitive"), manage = can("hr.manage");
  const [status, setStatus] = useState("active");
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const l = useAsync(() => get("/employees", { status: status === "all" ? undefined : status, q: dq, limit: 200 }).then((r) => items<any>(r)), [status, dq]);
  const [sel, setSel] = useState<number | null>(null);
  const [lt, setLt] = useState(false);
  const [form, setForm] = useState<any>(null);
  const [temp, setTemp] = useState<{ username: string; password: string; name: string } | null>(null);
  const rows = l.data ?? [];
  return (
    <div className="stack">
      <div className="row wrap between">
        <Segmented value={status} onChange={setStatus} options={[{ v: "active", label: "Đang làm" }, { v: "terminated", label: "Đã nghỉ" }, { v: "all", label: "Tất cả" }]} />
        <div className="row">{manage && <Button variant="soft" onClick={() => setLt(true)}>Loại nghỉ phép</Button>}{manage && <Button onClick={() => setForm({})}>+ Thêm nhân viên</Button>}</div>
      </div>
      <Input label="Tìm theo tên hoặc mã" value={q} onChange={(e) => setQ(e.target.value)} />
      {!sens && <Banner tone="info">Bạn không có quyền xem lương và thông tin cá nhân nhạy cảm.</Banner>}
      {l.loading ? <Spinner /> : (
        <DataTable<any> rows={rows} rowKey={(r) => r.id} onRowClick={(r) => setSel(r.id)} empty="Chưa có nhân viên"
          cols={[
            { key: "code", label: "Mã", render: (r) => <span className="num">{r.code}</span> },
            { key: "name", label: "Họ tên", title: true, render: (r) => <b>{r.fullName}</b> },
            { key: "pos", label: "Vị trí", render: (r) => r.position },
            { key: "pay", label: "Hình thức", render: (r) => PAY_TYPE[r.payType] ?? r.payType },
            ...(sens ? [{ key: "sal", label: "Lương", right: true, render: (r: any) => <span className="num">{r.payType === "monthly" ? money(r.baseSalary) : r.payType === "hourly" ? money(r.hourlyRate) + "/giờ" : money(r.shiftRate) + "/ca"}</span> }] : []),
            { key: "acc", label: "Tài khoản", render: (r) => r.username ?? <span className="muted">—</span> },
            { key: "st", label: "Trạng thái", render: (r) => <Badge tone={r.status === "active" ? "ok" : undefined}>{EMP_STATUS[r.status] ?? r.status}</Badge> },
          ]} />
      )}
      {lt && <LeaveTypes onClose={() => setLt(false)} />}
      {sel != null && <Detail id={sel} sens={sens} manage={manage} onClose={() => setSel(null)} onChanged={l.reload} onEdit={(e) => { setSel(null); setForm(e); }} />}
      {form && <EmpForm emp={form.id ? form : null} sens={sens} onClose={() => setForm(null)}
        onSaved={(r) => { setForm(null); l.reload(); if (r.tempPassword) setTemp({ username: r.username, password: r.tempPassword, name: r.fullName }); }} />}
      {temp && (
        <Sheet open onClose={() => setTemp(null)} title="Tài khoản đã tạo" footer={<Button block onClick={() => setTemp(null)}>Đã ghi lại</Button>}>
          <div className="stack">
            <Banner tone="info">Mật khẩu tạm chỉ hiện <b>một lần</b>. Hãy gửi cho {temp.name}; họ sẽ phải đổi khi đăng nhập lần đầu.</Banner>
            <div className="card flat stack" style={{ gap: 6 }}><div>Tên đăng nhập: <b data-testid="tmp-user">{temp.username}</b></div><div>Mật khẩu tạm: <b data-testid="tmp-pass" style={{ fontFamily: "monospace", fontSize: "1.2rem" }}>{temp.password}</b></div></div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Detail({ id, sens, manage, onClose, onChanged, onEdit }: { id: number; sens: boolean; manage: boolean; onClose: () => void; onChanged: () => void; onEdit: (e: any) => void }) {
  const d = useAsync(() => get("/employees/" + id), [id]);
  const [term, setTerm] = useState(false);
  const [ct, setCt] = useState<false | "new" | any>(false);
  const [al, setAl] = useState(false);
  const e = d.data;
  const reload = () => { d.reload(); onChanged(); };
  return (
    <Sheet open wide onClose={onClose} title={e ? `${e.fullName} · ${e.code}` : "Nhân viên"}>
      {!e ? <Spinner /> : (
        <div className="stack">
          <div className="row wrap">
            <Badge tone={e.status === "active" ? "ok" : undefined}>{EMP_STATUS[e.status]}</Badge>
            {e.username && <Badge tone="info">TK: {e.username}</Badge>}
            {e.locationExempt && <Badge>Miễn vị trí</Badge>}
            <span className="grow" />
            {manage && e.status === "active" && <><Button size="sm" variant="soft" onClick={() => onEdit(e)}>Sửa hồ sơ</Button><Button size="sm" variant="danger" onClick={() => setTerm(true)}>Cho nghỉ việc</Button></>}
          </div>
          <div className="grid2">
            <KV l="Vị trí" v={e.position} /><KV l="Ngày vào làm" v={dmy(e.hireDate)} />
            <KV l="Hình thức trả lương" v={PAY_TYPE[e.payType]} />
            <KV l="Phép năm" v={`${e.leaveBalance.remainingX10 / 10} / ${e.leaveBalance.entitledX10 / 10} ngày`} />
            {e.terminationDate && <KV l="Ngày nghỉ việc" v={dmy(e.terminationDate)} />}
          </div>
          {sens ? (
            <Card title="Lương & thông tin nhạy cảm" className="flat">
              <div className="grid2">
                <KV l="Lương cơ bản" v={money(e.baseSalary)} /><KV l="Lương giờ" v={money(e.hourlyRate)} />
                <KV l="Lương ca" v={money(e.shiftRate)} /><KV l="Lương đóng BH" v={money(e.insuranceSalary)} />
                <KV l="Người phụ thuộc" v={String(e.dependents ?? 0)} /><KV l="Tính TNCN" v={e.pitEnabled ? "Có" : "Không"} />
                <KV l="Điện thoại" v={e.phone} /><KV l="Email" v={e.email} />
                <KV l="CCCD" v={e.idNumber} /><KV l="Ngày sinh" v={e.dob ? dmy(e.dob) : null} />
                <KV l="Ngân hàng" v={[e.bankName, e.bankAccount].filter(Boolean).join(" · ")} /><KV l="Địa chỉ" v={e.address} />
              </div>
              {e.note && <div className="small muted" style={{ whiteSpace: "pre-line", marginTop: 8 }}>{e.note}</div>}
            </Card>
          ) : null}
          <Card title="Hợp đồng" className="flat" actions={manage && <Button size="sm" variant="soft" onClick={() => setCt("new")}>+ Hợp đồng</Button>}>
            {!e.contracts.length ? <div className="muted">Chưa có hợp đồng.</div> : e.contracts.map((c: any) => (
              <div key={c.id} className="row between" style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
                <span><b>{c.type}</b> · {dmy(c.startDate)} → {c.endDate ? dmy(c.endDate) : "không thời hạn"}{c.note && <span className="muted small"> · {c.note}</span>}</span>
                <span className="row">{sens && c.salary != null && <span className="num">{money(c.salary)}</span>}
                  {manage && <Button size="sm" variant="ghost" aria-label={`Sửa hợp đồng ${c.type}`} onClick={() => setCt(c)}>Sửa</Button>}</span>
              </div>
            ))}
          </Card>
          <Card title="Phụ cấp" className="flat" actions={manage && sens && <Button size="sm" variant="soft" onClick={() => setAl(true)}>+ Phụ cấp</Button>}>
            {!e.allowances.length ? <div className="muted">Không có phụ cấp.</div> : e.allowances.map((a: any) => (
              <div key={a.id} className="row between" style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
                <span><b>{a.name}</b> {!a.taxable && <span className="muted small">(không chịu thuế)</span>} {!a.active && <Badge>Ngừng</Badge>}</span>
                <span className="row">{sens && <span className="num">{money(a.amount)}</span>}
                  {manage && <Button size="sm" variant="ghost" onClick={async () => { try { await put(`/employees/${e.id}/allowances/${a.id}`, { active: !a.active }); reload(); } catch { /* toast */ } }}>{a.active ? "Ngừng" : "Bật lại"}</Button>}</span>
              </div>
            ))}
          </Card>
          {term && <Terminate e={e} onClose={() => setTerm(false)} onDone={() => { setTerm(false); reload(); }} />}
          {ct && <ContractForm id={e.id} sens={sens} contract={ct === "new" ? null : ct} onClose={() => setCt(false)} onDone={() => { setCt(false); reload(); }} />}
          {al && <AllowanceForm id={e.id} onClose={() => setAl(false)} onDone={() => { setAl(false); reload(); }} />}
        </div>
      )}
    </Sheet>
  );
}
const KV = ({ l, v }: { l: string; v?: string | null }) => <div><div className="small muted">{l}</div><div>{v || "—"}</div></div>;

function Terminate({ e, onClose, onDone }: { e: any; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(todayVN()), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  return (
    <Confirm title={`Cho ${e.fullName} nghỉ việc`} danger confirmLabel="Xác nhận nghỉ việc" busy={busy} disabled={!reason.trim() || !date} onClose={onClose}
      onConfirm={async () => { setBusy(true); try { await post(`/employees/${e.id}/terminate`, { terminationDate: date, reason: reason.trim() }); toast("Đã cho nghỉ việc", "ok"); onDone(); } catch { /* toast */ } finally { setBusy(false); } }}>
      <Banner>{e.username ? <>Tài khoản <b>{e.username}</b> sẽ bị <b>khoá ngay</b> và mọi phiên đăng nhập đang mở bị thu hồi. </> : null}Các ca sau ngày nghỉ sẽ bị huỷ. Lịch sử chấm công và lương vẫn được giữ.</Banner>
      <Input label="Ngày nghỉ việc" type="date" value={date} onChange={(x) => setDate(x.target.value)} />
      <TextArea label="Lý do" rows={2} value={reason} onChange={(x) => setReason(x.target.value)} />
    </Confirm>
  );
}
function ContractForm({ id, sens, contract, onClose, onDone }: { id: number; sens: boolean; contract: any | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ type: contract?.type ?? "Hợp đồng thử việc", startDate: contract?.startDate ?? todayVN(), endDate: contract?.endDate ?? "", salary: contract?.salary ?? 0, note: contract?.note ?? "" }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={contract ? "Sửa hợp đồng" : "Thêm hợp đồng"} footer={<Button block loading={busy} disabled={!f.type.trim()} onClick={async () => {
      setBusy(true);
      try {
        const body = { type: f.type.trim(), startDate: f.startDate, endDate: f.endDate || null, salary: sens && f.salary ? f.salary : undefined, note: f.note || null };
        if (contract) await put(`/employees/${id}/contracts/${contract.id}`, sens ? { ...body, salary: f.salary || null } : { type: body.type, startDate: body.startDate, endDate: body.endDate, note: body.note });
        else await post(`/employees/${id}/contracts`, body);
        toast(contract ? "Đã lưu hợp đồng" : "Đã thêm hợp đồng", "ok"); onDone();
      } catch { /* toast */ } finally { setBusy(false); }
    }}>Lưu hợp đồng</Button>}>
      <div className="stack">
        <Input label="Loại hợp đồng" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} />
        <div className="grid2"><Input label="Từ ngày" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /><Input label="Đến ngày (để trống = không thời hạn)" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></div>
        {sens && <MoneyInput label="Lương theo hợp đồng (₫)" value={f.salary} onChange={(n) => setF({ ...f, salary: n })} />}
        <Input label="Ghi chú" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
    </Sheet>
  );
}
function AllowanceForm({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", amount: 0, taxable: true }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Thêm phụ cấp" footer={<Button block loading={busy} disabled={!f.name.trim() || !f.amount} onClick={async () => {
      setBusy(true);
      try { await post(`/employees/${id}/allowances`, { name: f.name.trim(), amount: f.amount, taxable: f.taxable }); toast("Đã thêm phụ cấp", "ok"); onDone(); } catch { /* toast */ } finally { setBusy(false); }
    }}>Lưu phụ cấp</Button>}>
      <div className="stack">
        <Input label="Tên phụ cấp (ăn trưa, xăng xe…)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <MoneyInput label="Số tiền mỗi tháng (₫)" value={f.amount} onChange={(n) => setF({ ...f, amount: n })} />
        <label className="row"><input type="checkbox" checked={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} /> Chịu thuế TNCN</label>
      </div>
    </Sheet>
  );
}

function EmpForm({ emp, sens, onClose, onSaved }: { emp: any | null; sens: boolean; onClose: () => void; onSaved: (r: any) => void }) {
  const { user } = useAuth();
  const base = emp ? Object.fromEntries(Object.keys(EMPTY).map((k) => [k, emp[k] ?? (EMPTY as any)[k]])) : EMPTY;
  const [f, setF] = useState<any>(base);
  const [acc, setAcc] = useState(false);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("staff");
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const nul = (s: string) => (s.trim() ? s.trim() : null);
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { fullName: f.fullName.trim(), position: f.position.trim(), hireDate: f.hireDate, payType: f.payType, annualLeaveDays: f.annualLeaveDays, locationExempt: f.locationExempt, storeId: emp?.storeId ?? user?.storeId ?? 1 };
      if (sens) Object.assign(body, { baseSalary: f.baseSalary, hourlyRate: f.hourlyRate, shiftRate: f.shiftRate, insuranceSalary: f.insuranceSalary, dependents: f.dependents, phone: nul(f.phone), email: nul(f.email), idNumber: nul(f.idNumber), dob: nul(f.dob), address: nul(f.address), bankName: nul(f.bankName), bankAccount: nul(f.bankAccount) });
      if (emp) {
        const diff: any = { version: emp.version };
        for (const k of Object.keys(body)) { const old = emp[k] ?? null; if ((old ?? "") !== (body[k] ?? "")) diff[k] = body[k]; }
        if (sens && f.pitEnabled !== !!emp.pitEnabled) diff.pitEnabled = f.pitEnabled;
        if (Object.keys(diff).length === 1) { toast("Chưa có thay đổi nào", "info"); return; }
        await put("/employees/" + emp.id, diff);
        toast("Đã lưu hồ sơ", "ok"); onSaved({});
      } else {
        if (sens) body.pitEnabled = undefined;
        if (acc) body.createUser = { username: username.trim(), role };
        const r = await post("/employees", body);
        toast("Đã tạo nhân viên " + r.code, "ok"); onSaved({ ...r, username: username.trim() });
      }
    } catch { /* toast */ } finally { setBusy(false); }
  };
  const okAcc = !acc || /^[A-Za-z0-9._-]{3,50}$/.test(username.trim());
  return (
    <Sheet open wide onClose={onClose} title={emp ? "Sửa hồ sơ " + emp.code : "Thêm nhân viên"} footer={<Button block loading={busy} disabled={!f.fullName.trim() || !f.position.trim() || !okAcc} onClick={save}>{emp ? "Lưu thay đổi" : "Tạo nhân viên"}</Button>}>
      <div className="stack">
        <Input label="Họ và tên" value={f.fullName} onChange={(e) => set("fullName", e.target.value)} />
        <div className="grid2"><Input label="Vị trí" value={f.position} onChange={(e) => set("position", e.target.value)} /><Input label="Ngày vào làm" type="date" value={f.hireDate} onChange={(e) => set("hireDate", e.target.value)} /></div>
        <div className="grid2">
          <Select label="Hình thức trả lương" value={f.payType} onChange={(e) => set("payType", e.target.value)}>{Object.entries(PAY_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <DecInput label="Phép năm (ngày)" value={f.annualLeaveDays} onChange={(n) => set("annualLeaveDays", Math.round(n))} />
        </div>
        <label className="row"><input type="checkbox" checked={f.locationExempt} onChange={(e) => set("locationExempt", e.target.checked)} /> Miễn xác thực vị trí khi chấm công</label>
        {sens ? (
          <>
            <h3 style={{ margin: 0 }}>Lương (nhạy cảm)</h3>
            {f.payType === "monthly" && <MoneyInput label="Lương cơ bản tháng (₫)" value={f.baseSalary} onChange={(n) => set("baseSalary", n)} />}
            {f.payType === "hourly" && <MoneyInput label="Lương theo giờ (₫)" value={f.hourlyRate} onChange={(n) => set("hourlyRate", n)} />}
            {f.payType === "shift" && <MoneyInput label="Lương theo ca (₫)" value={f.shiftRate} onChange={(n) => set("shiftRate", n)} />}
            <div className="grid2"><MoneyInput label="Lương đóng bảo hiểm (₫, 0 = không đóng)" value={f.insuranceSalary} onChange={(n) => set("insuranceSalary", n)} /><DecInput label="Người phụ thuộc" value={f.dependents} onChange={(n) => set("dependents", Math.round(n))} /></div>
            {emp && <label className="row"><input type="checkbox" checked={f.pitEnabled} onChange={(e) => set("pitEnabled", e.target.checked)} /> Tính thuế TNCN</label>}
            <h3 style={{ margin: 0 }}>Thông tin cá nhân</h3>
            <div className="grid2"><Input label="Điện thoại" value={f.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" /><Input label="Email" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
            <div className="grid2"><Input label="CCCD" value={f.idNumber} onChange={(e) => set("idNumber", e.target.value)} /><Input label="Ngày sinh" type="date" value={f.dob} onChange={(e) => set("dob", e.target.value)} /></div>
            <Input label="Địa chỉ" value={f.address} onChange={(e) => set("address", e.target.value)} />
            <div className="grid2"><Input label="Ngân hàng" value={f.bankName} onChange={(e) => set("bankName", e.target.value)} /><Input label="Số tài khoản" value={f.bankAccount} onChange={(e) => set("bankAccount", e.target.value)} /></div>
          </>
        ) : <Banner tone="info">Bạn không có quyền sửa lương và thông tin nhạy cảm.</Banner>}
        {!emp && (
          <>
            <label className="row"><input type="checkbox" checked={acc} onChange={(e) => setAcc(e.target.checked)} /> Tạo tài khoản đăng nhập</label>
            {acc && (
              <div className="grid2">
                <Input label="Tên đăng nhập" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" error={username && !okAcc ? "Chỉ chữ, số, . _ - (tối thiểu 3 ký tự)" : undefined} />
                <Select label="Vai trò" value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(ROLES).filter(([k]) => k !== "owner").map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
              </div>
            )}
            {acc && <div className="hint">Mật khẩu tạm sẽ hiện một lần sau khi tạo; nhân viên phải đổi khi đăng nhập lần đầu.</div>}
          </>
        )}
      </div>
    </Sheet>
  );
}

function LeaveTypes({ onClose }: { onClose: () => void }) {
  const lt = useLeaveTypes(true);
  const [f, setF] = useState<{ id?: number; code: string; name: string; paid: boolean; usesBalance: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!f) return;
    setBusy(true);
    try {
      if (f.id) await put(`/leave-types/${f.id}`, { name: f.name.trim(), paid: f.paid, usesBalance: f.usesBalance });
      else await post("/leave-types", { code: f.code.trim(), name: f.name.trim(), paid: f.paid, usesBalance: f.usesBalance });
      toast("Đã lưu loại nghỉ", "ok"); setF(null); lt.reload();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title="Loại nghỉ phép">
      <div className="stack" data-testid="leave-types">
        {!f && <div><Button size="sm" onClick={() => setF({ code: "", name: "", paid: true, usesBalance: false })}>+ Loại nghỉ mới</Button></div>}
        {f ? (
          <div className="stack">
            <Input label="Mã (chữ thường, không dấu, vd: cuoi)" value={f.code} disabled={!!f.id} onChange={(e) => setF({ ...f, code: e.target.value })} />
            <Input label="Tên hiển thị" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <label className="row"><input type="checkbox" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} /> Có lương</label>
            <label className="row"><input type="checkbox" checked={f.usesBalance} onChange={(e) => setF({ ...f, usesBalance: e.target.checked })} /> Trừ vào số dư phép năm</label>
            <div className="row"><Button variant="ghost" onClick={() => setF(null)}>Huỷ</Button><Button loading={busy} disabled={!f.name.trim() || (!f.id && !/^[a-z0-9_]{2,30}$/.test(f.code.trim()))} onClick={save}>Lưu</Button></div>
          </div>
        ) : lt.types.map((t) => (
          <div key={t.id} className="card flat row between wrap">
            <span><b>{t.name}</b> <span className="muted small">{t.code}</span><div className="small muted">{t.paid ? "Có lương" : "Không lương"} · {t.usesBalance ? "Trừ phép năm" : "Không trừ phép năm"}</div></span>
            <span className="row">
              {!t.active && <Badge tone="warn">Đã tắt</Badge>}
              <Button size="sm" variant="ghost" onClick={() => setF({ id: t.id, code: t.code, name: t.name, paid: t.paid, usesBalance: t.usesBalance })}>Sửa</Button>
              <Button size="sm" variant="ghost" onClick={async () => { try { await put(`/leave-types/${t.id}`, { active: !t.active }); lt.reload(); } catch { /* toast */ } }}>{t.active ? "Tắt" : "Bật"}</Button>
            </span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
