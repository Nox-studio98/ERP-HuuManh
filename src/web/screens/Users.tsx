import { useState } from "react";
import { get, items, post, put } from "../api";
import { Badge, Button, DataTable, Input, Select, Sheet, Spinner, useAsync } from "../components/ui";
import { toast } from "../components/toast";
import { ROLES, fmtDateTime } from "../format";

export default function Users() {
  const u = useAsync(() => get("/users").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="stack">
      <div><Button onClick={() => setEdit({})}>+ Thêm người dùng</Button></div>
      {u.loading ? <Spinner /> : <DataTable rows={u.data ?? []} rowKey={(x) => x.id} onRowClick={setEdit} cols={[
        { key: "n", label: "Họ tên", title: true, render: (x) => <b>{x.fullName}</b> },
        { key: "u", label: "Tài khoản", render: (x) => x.username },
        { key: "r", label: "Vai trò", render: (x) => ROLES[x.role] ?? x.role },
        { key: "a", label: "Trạng thái", render: (x) => (x.active === 0 || x.active === false ? <Badge tone="danger">Đã khoá</Badge> : <Badge tone="ok">Hoạt động</Badge>) },
        { key: "l", label: "Đăng nhập cuối", render: (x) => fmtDateTime(x.lastLoginAt) },
      ]} />}
      {edit && <UserForm u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); u.reload(); }} />}
    </div>
  );
}
function UserForm({ u, onClose, onSaved }: { u: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !u.id;
  const [f, setF] = useState({ username: u.username ?? "", fullName: u.fullName ?? "", role: u.role ?? "cashier", password: "", active: !(u.active === 0 || u.active === false) });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={isNew ? "Thêm người dùng" : `Sửa ${u.username}`} footer={<Button block loading={busy} disabled={!f.fullName || (isNew && (!f.username || f.password.length < 8))} onClick={async () => {
      setBusy(true);
      try {
        if (isNew) await post("/users", { username: f.username, fullName: f.fullName, role: f.role, password: f.password });
        else await put(`/users/${u.id}`, { fullName: f.fullName, role: f.role, active: f.active ? 1 : 0, ...(f.password ? { password: f.password } : {}) });
        toast("Đã lưu người dùng", "ok"); onSaved();
      } catch {} finally { setBusy(false); }
    }}>Lưu</Button>}>
      <div className="stack">
        <Input label="Tên đăng nhập" value={f.username} disabled={!isNew} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" />
        <Input label="Họ tên" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <Select label="Vai trò" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Input label={isNew ? "Mật khẩu tạm (≥ 8 ký tự)" : "Đặt lại mật khẩu tạm (để trống nếu giữ)"} type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} hint="Người dùng sẽ phải đổi mật khẩu khi đăng nhập lần đầu." />
        {!isNew && <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Cho phép đăng nhập {!f.active && <span className="err">(khoá sẽ đăng xuất mọi phiên)</span>}</label>}
      </div>
    </Sheet>
  );
}
