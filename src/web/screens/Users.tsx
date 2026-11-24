import { useState } from "react";
import { get, items, post, put } from "../api";
import { Badge, Button, DataTable, EmptyState, Input, Select, Sheet, Spinner, useAsync } from "../components/ui";
import { DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout } from "../components/list";
import { toast } from "../components/toast";
import { ROLES, fmtDateTime } from "../format";
import { Banner } from "../components/ui";

export default function Users() {
  const u = useAsync(() => get("/users").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  const [temp, setTemp] = useState<{ username: string; pw: string } | null>(null);
  const [q, setQ] = useState(""), [role, setRole] = useState(""), [st, setSt] = useState("");
  const all = u.data ?? [];
  const locked = (x: any) => x.active === 0 || x.active === false;
  const term = q.trim().toLowerCase();
  const rows = all.filter((x) => (!role || x.role === role) && (!st || (st === "locked") === locked(x)) && (!term || `${x.fullName} ${x.username}`.toLowerCase().includes(term)));
  const dirty = !!(q || role || st);
  const reset = () => { setQ(""); setRole(""); setSt(""); };
  const byRole = all.reduce<Record<string, number>>((m, x) => ({ ...m, [x.role]: (m[x.role] ?? 0) + 1 }), {});
  return (
    <div className="stack">
      <PageHeader subtitle={u.loading ? "Đang tải…" : `${rows.length}/${all.length} người dùng`} actions={<>
        <ExportButton filename="nguoi-dung" rows={rows} columns={[{ label: "Họ tên", value: (x: any) => x.fullName }, { label: "Tài khoản", value: (x: any) => x.username }, { label: "Vai trò", value: (x: any) => ROLES[x.role] ?? x.role }, { label: "Trạng thái", value: (x: any) => (locked(x) ? "Đã khoá" : "Hoạt động") }, { label: "Tạo lúc", value: (x: any) => fmtDateTime(x.createdAt) }]} />
        <Button size="sm" onClick={() => setEdit({})}>+ Thêm người dùng</Button></>} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[role, st].filter(Boolean).length}
        advanced={<>
          <FilterSelect label="Vai trò" value={role} onChange={setRole} options={Object.entries(ROLES).map(([v, label]) => ({ v, label }))} />
          <FilterSelect label="Trạng thái" value={st} onChange={setSt} options={[{ v: "active", label: "Hoạt động" }, { v: "locked", label: "Đã khoá" }]} />
        </>}>
        <SearchInput value={q} onSearch={setQ} placeholder="Họ tên, tài khoản…" label="Tìm người dùng" />
      </FilterBar>
      {!u.loading && <KpiRow items={[
        { label: "Tổng người dùng", value: all.length },
        { label: "Đang hoạt động", value: all.filter((x) => !locked(x)).length, tone: "ok", onClick: () => setSt(st === "active" ? "" : "active") },
        { label: "Đã khoá", value: all.filter(locked).length, tone: all.some(locked) ? "danger" : undefined, onClick: () => setSt(st === "locked" ? "" : "locked") },
        { label: "Vai trò", value: Object.keys(byRole).length, sub: Object.entries(byRole).slice(0, 3).map(([k, n]) => `${ROLES[k] ?? k} ${n}`).join(" · ") },
      ]} />}
      {u.loading ? <Spinner /> : (
        <SplitLayout open={!!edit} panel={edit ? <UserForm key={edit.id ?? "new"} u={edit} onClose={() => setEdit(null)} onSaved={(t) => { setEdit(null); u.reload(); if (t) setTemp(t); }} /> : null}>
          <DataTable rows={rows} rowKey={(x) => x.id} onRowClick={setEdit} selectedKey={edit?.id ?? null} pageSize={50}
            emptyState={<EmptyState title={dirty ? "Không có người dùng nào khớp bộ lọc" : "Chưa có người dùng"} action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}<Button onClick={() => setEdit({})}>+ Thêm người dùng</Button></div>} />}
            cols={[
              { key: "n", label: "Họ tên", title: true, sort: (x) => x.fullName, render: (x) => <b>{x.fullName}</b> },
              { key: "u", label: "Tài khoản", sort: (x) => x.username, render: (x) => x.username },
              { key: "r", label: "Vai trò", sort: (x) => ROLES[x.role] ?? x.role, render: (x) => ROLES[x.role] ?? x.role },
              { key: "a", label: "Trạng thái", sort: (x) => (locked(x) ? 1 : 0), render: (x) => (locked(x) ? <Badge tone="danger">Đã khoá</Badge> : <Badge tone="ok">Hoạt động</Badge>) },
              { key: "l", label: "Tạo lúc", hideBelow: 1280, sort: (x) => x.createdAt, render: (x) => <span className="nw">{fmtDateTime(x.createdAt)}</span> },
            ]} />
        </SplitLayout>
      )}
      {temp && <Sheet open onClose={() => setTemp(null)} title="Mật khẩu tạm" footer={<Button block onClick={() => setTemp(null)}>Đã ghi lại</Button>}><div className="stack"><Banner tone="info">Chỉ hiển thị một lần. Gửi cho <b>{temp.username}</b>; người dùng phải đổi mật khẩu ở lần đăng nhập đầu.</Banner><div className="card flat" style={{ textAlign: "center", fontSize: "1.4rem", fontWeight: 700, letterSpacing: 1 }} data-testid="temp-password">{temp.pw}</div></div></Sheet>}
    </div>
  );
}
function UserForm({ u, onClose, onSaved }: { u: any; onClose: () => void; onSaved: (temp?: { username: string; pw: string }) => void }) {
  const isNew = !u.id;
  const [f, setF] = useState({ username: u.username ?? "", fullName: u.fullName ?? "", role: u.role ?? "cashier", reset: false, tempPassword: "", active: !(u.active === 0 || u.active === false) });
  const [busy, setBusy] = useState(false);
  return (
    <DetailPanel onClose={onClose} title={isNew ? "Thêm người dùng" : `Sửa ${u.username}`} footer={<Button block loading={busy} disabled={!f.fullName || (isNew && (!f.username || (f.tempPassword !== "" && f.tempPassword.length < 8)))} onClick={async () => {
      setBusy(true);
      try {
        // Backend: POST /users {username, fullName, role, tempPassword?} → trả tempPassword (tự sinh nếu bỏ trống); PUT {…, resetPassword:true} → trả tempPassword mới.
        const r = isNew
          ? await post("/users", { username: f.username.trim(), fullName: f.fullName.trim(), role: f.role, ...(f.tempPassword ? { tempPassword: f.tempPassword } : {}) })
          : await put(`/users/${u.id}`, { fullName: f.fullName.trim(), role: f.role, active: f.active, ...(f.reset ? { resetPassword: true } : {}) });
        toast("Đã lưu người dùng", "ok"); onSaved(r?.tempPassword ? { username: r.username ?? u.username, pw: r.tempPassword } : undefined);
      } catch {} finally { setBusy(false); }
    }}>Lưu</Button>}>
      <div className="stack">
        <Input label="Tên đăng nhập" value={f.username} disabled={!isNew} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" />
        <Input label="Họ tên" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <Select label="Vai trò" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {isNew
          ? <Input label="Mật khẩu tạm (≥ 8 ký tự, để trống: hệ thống tự sinh)" type="text" value={f.tempPassword} onChange={(e) => setF({ ...f, tempPassword: e.target.value })} hint="Người dùng sẽ phải đổi mật khẩu khi đăng nhập lần đầu." />
          : <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.reset} onChange={(e) => setF({ ...f, reset: e.target.checked })} /> Đặt lại mật khẩu tạm (hệ thống sinh mã mới, thu hồi phiên)</label>}
        {!isNew && <label className="row wrap" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> <span>Cho phép đăng nhập</span> {!f.active && <span className="err small">(khoá sẽ đăng xuất mọi phiên)</span>}</label>}
      </div>
    </DetailPanel>
  );
}
