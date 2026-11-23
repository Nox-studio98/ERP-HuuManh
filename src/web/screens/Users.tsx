import { useState } from "react";
import { get, items, post, put } from "../api";
import { Badge, Button, DataTable, Input, Select, Sheet, Spinner, useAsync } from "../components/ui";
import { toast } from "../components/toast";
import { ROLES, fmtDateTime } from "../format";
import { Banner } from "../components/ui";

export default function Users() {
  const u = useAsync(() => get("/users").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<any>(null);
  const [temp, setTemp] = useState<{ username: string; pw: string } | null>(null);
  return (
    <div className="stack">
      <div><Button onClick={() => setEdit({})}>+ Thêm người dùng</Button></div>
      {u.loading ? <Spinner /> : <DataTable rows={u.data ?? []} rowKey={(x) => x.id} onRowClick={setEdit} cols={[
        { key: "n", label: "Họ tên", title: true, render: (x) => <b>{x.fullName}</b> },
        { key: "u", label: "Tài khoản", render: (x) => x.username },
        { key: "r", label: "Vai trò", render: (x) => ROLES[x.role] ?? x.role },
        { key: "a", label: "Trạng thái", render: (x) => (x.active === 0 || x.active === false ? <Badge tone="danger">Đã khoá</Badge> : <Badge tone="ok">Hoạt động</Badge>) },
        { key: "l", label: "Tạo lúc", render: (x) => fmtDateTime(x.createdAt) },
      ]} />}
      {temp && <Sheet open onClose={() => setTemp(null)} title="Mật khẩu tạm" footer={<Button block onClick={() => setTemp(null)}>Đã ghi lại</Button>}><div className="stack"><Banner tone="info">Chỉ hiển thị một lần. Gửi cho <b>{temp.username}</b>; người dùng phải đổi mật khẩu ở lần đăng nhập đầu.</Banner><div className="card flat" style={{ textAlign: "center", fontSize: "1.4rem", fontWeight: 700, letterSpacing: 1 }} data-testid="temp-password">{temp.pw}</div></div></Sheet>}
      {edit && <UserForm u={edit} onClose={() => setEdit(null)} onSaved={(t) => { setEdit(null); u.reload(); if (t) setTemp(t); }} />}
    </div>
  );
}
function UserForm({ u, onClose, onSaved }: { u: any; onClose: () => void; onSaved: (temp?: { username: string; pw: string }) => void }) {
  const isNew = !u.id;
  const [f, setF] = useState({ username: u.username ?? "", fullName: u.fullName ?? "", role: u.role ?? "cashier", reset: false, tempPassword: "", active: !(u.active === 0 || u.active === false) });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title={isNew ? "Thêm người dùng" : `Sửa ${u.username}`} footer={<Button block loading={busy} disabled={!f.fullName || (isNew && (!f.username || (f.tempPassword !== "" && f.tempPassword.length < 8)))} onClick={async () => {
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
        {!isNew && <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Cho phép đăng nhập {!f.active && <span className="err">(khoá sẽ đăng xuất mọi phiên)</span>}</label>}
      </div>
    </Sheet>
  );
}
