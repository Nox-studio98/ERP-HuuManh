import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "../../components/ui";
import { BarChart } from "../../components/charts";
import { toast } from "../../components/toast";
import { money, parseDec } from "../../format";
import { navigate, usePath } from "../../router";
import { useAuth, useCan } from "../../store";
import { Back, DebtBadge, Lnk, ProductPicker, EINVOICE, INVOICE_KIND, einvTone, orderTone, ymd, type ProductLite } from "./kit";
import { ORDER_STATUS } from "../../format";
import { PaymentSheet } from "./Debts";
import { ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, usePagedList } from "../../components/list";

const FALLBACK_GROUPS = [{ id: 3, name: "Sỉ cấp 1" }, { id: 4, name: "Sỉ cấp 2" }];
function useGroups() {
  return useAsync(async () => {
    try {
      // Khách sỉ: đưa nhóm sỉ (si_*) lên đầu để làm mặc định
      const all = items<any>(await get("/customer-groups", undefined, { silent: true }));
      const g = [...all.filter((x) => String(x.code).startsWith("si")), ...all.filter((x) => !String(x.code).startsWith("si"))]
        .map((x) => ({ id: x.id as number, name: String(x.name) }));
      return g.length ? g : FALLBACK_GROUPS;
    } catch { return FALLBACK_GROUPS; }
  }, []).data ?? FALLBACK_GROUPS;
}

export default function Customers() {
  const path = usePath();
  const m = path.match(/^\/customers\/(\d+)/);
  return m ? <CustomerDetail id={Number(m[1])} /> : <CustomerList />;
}

function CustomerList() {
  const can = useCan();
  const [q, setQ] = useState("");
  const [overdue, setOverdue] = useState(""), [group, setGroup] = useState("");
  const list = usePagedList<any>("/customers", { type: "b2b", q, limit: 100 }, [q]);
  const [add, setAdd] = useState(false);
  const all = list.rows;
  const groupOpts = [...new Set(all.map((c) => c.groupName).filter(Boolean))].map((g) => ({ v: String(g), label: String(g) }));
  const rows = all.filter((c) => (overdue !== "1" || c.debt?.overdueAmount > 0) && (overdue !== "debt" || c.debt?.balance > 0) && (!group || c.groupName === group));
  const totalDebt = all.reduce((s, c) => s + (c.debt?.balance ?? 0), 0);
  const totalOver = all.reduce((s, c) => s + (c.debt?.overdueAmount ?? 0), 0);
  const overN = all.filter((c) => c.debt?.overdueAmount > 0).length;
  const dirty = !!(q || overdue || group);
  const reset = () => { setQ(""); setOverdue(""); setGroup(""); };
  return (
    <div className="stack">
      <PageHeader compact subtitle="Khách sỉ, hạn mức và công nợ"
        actions={<>
          <ExportButton filename="khach-si" rows={rows} columns={[
            { label: "Mã", value: (c) => c.code }, { label: "Tên", value: (c) => c.name }, { label: "Nhóm", value: (c) => c.groupName }, { label: "SĐT", value: (c) => c.phone },
            { label: "Hạn nợ (ngày)", value: (c) => c.paymentTermsDays }, { label: "Hạn mức", value: (c) => c.creditLimit }, { label: "Công nợ", value: (c) => c.debt?.balance ?? 0 }, { label: "Quá hạn", value: (c) => c.debt?.overdueAmount ?? 0 },
          ]} />
          {can("b2b.write") && <Button onClick={() => setAdd(true)}>+ Thêm khách sỉ</Button>}
        </>} />
      <KpiRow items={[
        { label: "Khách sỉ", value: all.length, sub: list.hasMore ? "còn nữa — Tải thêm" : undefined },
        { label: "Tổng công nợ", value: money(totalDebt), onClick: () => setOverdue("debt") },
        { label: "Quá hạn", value: money(totalOver), tone: totalOver ? "warn" : undefined, onClick: () => setOverdue("1") },
        { label: "Khách có nợ quá hạn", value: overN, tone: overN ? "danger" : undefined, onClick: () => setOverdue("1") },
      ]} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[overdue, group].filter(Boolean).length} advanced={<>
        <FilterSelect label="Công nợ" value={overdue} onChange={setOverdue} options={[{ v: "debt", label: "Đang còn nợ" }, { v: "1", label: "Có nợ quá hạn" }]} />
        <FilterSelect label="Nhóm khách" value={group} onChange={setGroup} options={groupOpts} />
      </>}>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên, mã, SĐT, MST…" label="Tìm khách" />
      </FilterBar>
      {list.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(c) => c.id} onRowClick={(c) => navigate(`/customers/${c.id}`)} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
          footer={`Đang hiển thị ${rows.length} khách`}
          emptyState={<EmptyState title={dirty ? "Không có khách nào khớp bộ lọc" : "Chưa có khách sỉ"} hint="Thêm khách sỉ để lập báo giá, đơn sỉ và theo dõi công nợ."
            action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{can("b2b.write") && <Button onClick={() => setAdd(true)}>+ Thêm khách sỉ</Button>}</div>} />}
          cols={[
            { key: "n", label: "Khách hàng", title: true, sort: (c) => c.name, render: (c) => <span><b>{c.name}</b> <span className="muted small">{c.code}</span></span> },
            { key: "g", label: "Nhóm", sort: (c) => c.groupName ?? "", render: (c) => c.groupName ?? "—" },
            { key: "p", label: "SĐT", hideMobile: true, hideBelow: 1280, render: (c) => c.phone ?? "—" },
            { key: "t", label: "Hạn nợ", hideMobile: true, hideBelow: 1280, num: true, sort: (c) => c.paymentTermsDays, render: (c) => `${c.paymentTermsDays} ngày` },
            { key: "l", label: "Hạn mức", num: true, sort: (c) => c.creditLimit, render: (c) => <span className="money">{money(c.creditLimit)}</span> },
            { key: "d", label: "Công nợ", num: true, sort: (c) => c.debt?.balance ?? 0, render: (c) => <DebtBadge debt={c.debt} /> },
          ]} />
      )}
      {add && <CustomerForm onClose={() => setAdd(false)} onSaved={(c) => { setAdd(false); toast(`Đã tạo khách ${c.code}`, "ok"); navigate(`/customers/${c.id}`); }} />}
    </div>
  );
}

type ContactF = { name: string; phone: string; role: string; isReceiver: boolean };
type AddrF = { label: string; address: string; receiver: number; isDefault: boolean };

function CustomerForm({ customer, onClose, onSaved }: { customer?: any; onClose: () => void; onSaved: (c: any) => void }) {
  const can = useCan();
  const { user } = useAuth();
  const groups = useGroups();
  const owners = useAsync(() => get("/users/assignable", undefined, { silent: true }).then((r) => items<{ id: number; fullName: string }>(r)).catch(() => [] as { id: number; fullName: string }[]), []);
  const edit = !!customer;
  const [f, setF] = useState({
    name: customer?.name ?? "", taxCode: customer?.taxCode ?? "", phone: customer?.phone ?? "", email: customer?.email && customer.email !== "***" ? customer.email : "",
    billingAddress: customer?.billingAddress ?? "", groupId: String(customer?.customerGroupId ?? ""), creditLimit: customer?.creditLimit ?? 0, terms: customer ? customer.paymentTermsDays : 7,
    ownerId: customer ? (customer.ownerUserId != null ? String(customer.ownerUserId) : "") : String(user?.id ?? ""),
  });
  const [contacts, setContacts] = useState<ContactF[]>([{ name: "", phone: "", role: "", isReceiver: true }]);
  const [addrs, setAddrs] = useState<AddrF[]>([{ label: "Cửa hàng", address: "", receiver: 0, isDefault: true }]);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const gid = Number(f.groupId || groups[0]?.id);
  const sensitiveLocked = edit && !can("b2b.approve");
  const validNew = contacts.length >= 1 && contacts.every((c) => c.name.trim()) && contacts.some((c) => c.isReceiver) && addrs.length >= 1 && addrs.every((a) => a.label.trim() && a.address.trim().length >= 3);
  const ok = f.name.trim() && (edit || validNew);
  const submit = async () => {
    setBusy(true); setErr("");
    try {
      if (edit) {
        const r = await put(`/customers/${customer.id}`, {
          version: customer.version, name: f.name.trim(), taxCode: f.taxCode || null, phone: f.phone || null, email: f.email || null, billingAddress: f.billingAddress || null,
          ...(sensitiveLocked ? {} : { customerGroupId: gid, creditLimit: f.creditLimit, paymentTermsDays: f.terms }), ownerUserId: f.ownerId ? Number(f.ownerId) : null,
        });
        toast("Đã lưu khách hàng", "ok"); onSaved(r);
      } else {
        const r = await post("/customers", {
          name: f.name.trim(), type: "b2b", taxCode: f.taxCode || undefined, phone: f.phone || undefined, email: f.email || undefined, billingAddress: f.billingAddress || undefined,
          customerGroupId: gid, creditLimit: f.creditLimit, paymentTermsDays: f.terms, ownerUserId: f.ownerId ? Number(f.ownerId) : undefined,
          contacts: contacts.map((c) => ({ name: c.name.trim(), phone: c.phone || undefined, role: c.role || undefined, isReceiver: c.isReceiver })),
          addresses: addrs.map((a) => ({ label: a.label.trim(), address: a.address.trim(), receiverContactIndex: a.receiver, isDefault: a.isDefault })),
        });
        onSaved(r);
      }
    } catch { /* toast đã hiện */ } finally { setBusy(false); }
  };
  const setC = (i: number, p: Partial<ContactF>) => setContacts(contacts.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const setA = (i: number, p: Partial<AddrF>) => setAddrs(addrs.map((a, j) => (j === i ? { ...a, ...p } : a)));
  return (
    <Sheet open wide onClose={onClose} title={edit ? `Sửa ${customer.name}` : "Thêm khách sỉ"} footer={<Button block size="lg" loading={busy} disabled={!ok} onClick={submit}>Lưu khách hàng</Button>}>
      <div className="stack">
        {err && <Banner tone="danger">{err}</Banner>}
        <Input label="Tên khách / công ty" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid2">
          <Input label="Mã số thuế" value={f.taxCode} onChange={(e) => setF({ ...f, taxCode: e.target.value })} />
          <Input label="SĐT" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </div>
        <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Input label="Địa chỉ xuất hoá đơn" value={f.billingAddress} onChange={(e) => setF({ ...f, billingAddress: e.target.value })} />
        <Card title="Điều khoản công nợ" className="flat">
          {sensitiveLocked && <div className="hint" style={{ marginBottom: 8 }}>Đổi hạn mức / hạn thanh toán / nhóm giá cần quyền duyệt (chủ hoặc quản lý).</div>}
          <div className="stack">
            <Select label="Nhóm giá" value={String(gid)} disabled={sensitiveLocked} onChange={(e) => setF({ ...f, groupId: e.target.value })}>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
            <div className="grid2">
              <MoneyInput label="Hạn mức công nợ (₫)" value={f.creditLimit} onChange={(n) => !sensitiveLocked && setF({ ...f, creditLimit: n })} />
              <Input label="Hạn thanh toán (ngày)" inputMode="numeric" disabled={sensitiveLocked} value={String(f.terms)} onChange={(e) => setF({ ...f, terms: Math.max(0, Math.min(365, Math.floor(parseDec(e.target.value)))) })} />
            </div>
            <Select label="Nhân viên phụ trách" value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
              <option value="">— Chưa phân công —</option>
              {(owners.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}{u.id === user?.id ? " (tôi)" : ""}</option>)}
              {f.ownerId && !(owners.data ?? []).some((u) => String(u.id) === f.ownerId) && <option value={f.ownerId}>{customer?.ownerName ?? (String(user?.id) === f.ownerId ? user?.fullName : `Người dùng #${f.ownerId}`)}</option>}
            </Select>
          </div>
        </Card>
        {!edit && (
          <>
            <Card title="Người liên hệ (≥ 1 người nhận hàng)" className="flat">
              <div className="stack">
                {contacts.map((c, i) => (
                  <div key={i} className="card flat stack" data-testid="contact-row">
                    <div className="grid2"><Input label="Họ tên" value={c.name} onChange={(e) => setC(i, { name: e.target.value })} /><Input label="SĐT" inputMode="tel" value={c.phone} onChange={(e) => setC(i, { phone: e.target.value })} /></div>
                    <div className="grid2"><Input label="Chức vụ" value={c.role} onChange={(e) => setC(i, { role: e.target.value })} />
                      <label className="row" style={{ minHeight: 44, alignSelf: "end" }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={c.isReceiver} onChange={(e) => setC(i, { isReceiver: e.target.checked })} /> Người nhận hàng</label></div>
                    {contacts.length > 1 && <Button size="sm" variant="ghost" onClick={() => { setContacts(contacts.filter((_, j) => j !== i)); setAddrs(addrs.map((a) => ({ ...a, receiver: a.receiver === i ? 0 : a.receiver > i ? a.receiver - 1 : a.receiver }))); }}>Bỏ liên hệ</Button>}
                  </div>
                ))}
                {!contacts.some((c) => c.isReceiver) && <div className="err">Cần ít nhất 1 người nhận hàng.</div>}
                <Button variant="soft" onClick={() => setContacts([...contacts, { name: "", phone: "", role: "", isReceiver: false }])}>+ Thêm liên hệ</Button>
              </div>
            </Card>
            <Card title="Địa chỉ giao hàng (≥ 1)" className="flat">
              <div className="stack">
                {addrs.map((a, i) => (
                  <div key={i} className="card flat stack" data-testid="address-row">
                    <Input label="Tên địa chỉ" value={a.label} onChange={(e) => setA(i, { label: e.target.value })} />
                    <Input label="Địa chỉ" value={a.address} onChange={(e) => setA(i, { address: e.target.value })} />
                    <Select label="Người nhận" value={String(a.receiver)} onChange={(e) => setA(i, { receiver: Number(e.target.value) })}>{contacts.map((c, j) => <option key={j} value={j}>{c.name || `Liên hệ ${j + 1}`}</option>)}</Select>
                    <div className="row between">
                      <label className="row" style={{ minHeight: 44 }}><input type="radio" name="defaddr" style={{ width: 22, height: 22 }} checked={a.isDefault} onChange={() => setAddrs(addrs.map((x, j) => ({ ...x, isDefault: j === i })))} /> Mặc định</label>
                      {addrs.length > 1 && <Button size="sm" variant="ghost" onClick={() => setAddrs(addrs.filter((_, j) => j !== i).map((x, j, arr) => ({ ...x, receiver: Math.min(x.receiver, contacts.length - 1), isDefault: x.isDefault || (!arr.some((y) => y.isDefault) && j === 0) })))}>Bỏ địa chỉ</Button>}
                    </div>
                  </div>
                ))}
                <Button variant="soft" onClick={() => setAddrs([...addrs, { label: "", address: "", receiver: Math.max(0, contacts.findIndex((c) => c.isReceiver)), isDefault: false }])}>+ Thêm địa chỉ</Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </Sheet>
  );
}

type Tab = "info" | "history" | "debt" | "prices";
function CustomerDetail({ id }: { id: number }) {
  const can = useCan();
  const c = useAsync(() => get(`/customers/${id}`), [id]);
  const [tab, setTab] = useState<Tab>("info");
  const [edit, setEdit] = useState(false);
  const [pay, setPay] = useState(false);
  const d = c.data;
  if (c.loading && !d) return <Spinner />;
  if (!d) return <div className="stack"><Back to="/customers" label="Khách sỉ" /><EmptyState title="Không tìm thấy khách hàng" /></div>;
  const opts = [{ v: "info" as Tab, label: "Thông tin" }, { v: "history" as Tab, label: "Lịch sử mua" }, ...(can("debt.view") ? [{ v: "debt" as Tab, label: "Công nợ" }] : []), { v: "prices" as Tab, label: "Giá riêng" }];
  return (
    <div className="stack">
      <Back to="/customers" label="Khách sỉ" />
      <div className="page-head">
        <div style={{ minWidth: 0 }}><h2 style={{ margin: 0 }}>{d.name}</h2><div className="muted small">{d.code} · {d.groupName} · {d.active ? "Đang hoạt động" : "Ngừng"}</div></div>
        <div className="row wrap">
          {can("b2b.write") && <Lnk to={`/quotes?new=${d.id}`} className="btn soft sm">Tạo báo giá</Lnk>}
          {can("b2b.write") && <Lnk to={`/b2b-orders?new=${d.id}`} className="btn sm">Tạo đơn</Lnk>}
          {can("b2b.write") && <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>Sửa</Button>}
        </div>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="l">Công nợ</div><div className="v">{money(d.debt.balance)}</div></div>
        <div className="kpi"><div className="l">Quá hạn</div><div className="v" style={{ color: d.debt.overdueAmount ? "var(--warn)" : undefined }}>{money(d.debt.overdueAmount)}</div></div>
        <div className="kpi"><div className="l">Hạn mức</div><div className="v">{money(d.creditLimit)}</div></div>
        <div className="kpi"><div className="l">Còn được nợ</div><div className="v" style={{ color: d.debt.available < 0 ? "var(--danger)" : undefined }}>{money(d.debt.available)}</div></div>
      </div>
      <Segmented value={tab} onChange={setTab} options={opts} />
      {tab === "info" && <InfoTab d={d} reload={c.reload} />}
      {tab === "history" && <HistoryTab id={id} />}
      {tab === "debt" && <DebtTab key={`${d.debt.balance}:${d.debt.unapplied}`} d={d} onPay={() => setPay(true)} />}
      {tab === "prices" && <PricesTab d={d} reload={c.reload} />}
      {edit && <CustomerForm customer={d} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); c.reload(); }} />}
      {pay && <PaymentSheet partnerType="customer" partnerId={d.id} partnerName={d.name} direction="in" onClose={() => setPay(false)} onDone={() => { setPay(false); c.reload(); }} />}
    </div>
  );
}

function InfoTab({ d, reload }: { d: any; reload: () => void }) {
  const can = useCan();
  const [addC, setAddC] = useState(false), [addA, setAddA] = useState(false);
  const toggle = async (kind: "contacts" | "addresses", x: any) => {
    try { await put(`/customers/${d.id}/${kind}/${x.id}`, { active: !x.active }); reload(); } catch { /* toast */ }
  };
  return (
    <div className="stack">
      <Card title="Thông tin chung">
        <div className="stack" style={{ gap: 6 }}>
          {([["Mã số thuế", d.taxCode], ["SĐT", d.phone], ["Email", d.email], ["Địa chỉ xuất hoá đơn", d.billingAddress], ["Hạn thanh toán", `${d.paymentTermsDays} ngày`], ["Hạn mức", money(d.creditLimit)], ["Phụ trách", d.ownerName], ["Ghi chú", d.note]] as [string, any][]).map(([k, v]) => (
            <div key={k} className="row between" style={{ alignItems: "flex-start" }}><span className="muted">{k}</span><span style={{ textAlign: "right" }}>{v || "—"}</span></div>
          ))}
        </div>
      </Card>
      <Card title="Người liên hệ" actions={can("b2b.write") ? <Button size="sm" variant="soft" onClick={() => setAddC(true)}>+ Thêm</Button> : undefined}>
        <div className="stack">
          {d.contacts.map((x: any) => (
            <div key={x.id} className="row between" style={{ opacity: x.active ? 1 : 0.5 }}>
              <div><b>{x.name}</b> {x.isReceiver && <Badge tone="ok">Người nhận</Badge>} {!x.active && <Badge>Ngừng</Badge>}<div className="small muted">{[x.role, x.phone, x.email].filter(Boolean).join(" · ") || "—"}</div></div>
              {can("b2b.write") && <Button size="sm" variant="ghost" onClick={() => toggle("contacts", x)}>{x.active ? "Ngừng" : "Bật lại"}</Button>}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Địa chỉ giao hàng" actions={can("b2b.write") ? <Button size="sm" variant="soft" onClick={() => setAddA(true)}>+ Thêm</Button> : undefined}>
        <div className="stack">
          {d.addresses.map((x: any) => (
            <div key={x.id} className="row between" style={{ opacity: x.active ? 1 : 0.5, alignItems: "flex-start" }}>
              <div><b>{x.label}</b> {x.isDefault && <Badge tone="info">Mặc định</Badge>} {!x.active && <Badge>Ngừng</Badge>}<div className="small">{x.address}</div>
                <div className="small muted">Nhận: {d.contacts.find((c: any) => c.id === x.receiverContactId)?.name ?? "—"}{x.deliveryNote ? ` · ${x.deliveryNote}` : ""}</div></div>
              {can("b2b.write") && <Button size="sm" variant="ghost" onClick={() => toggle("addresses", x)}>{x.active ? "Ngừng" : "Bật lại"}</Button>}
            </div>
          ))}
        </div>
      </Card>
      {addC && <AddContact id={d.id} onClose={() => setAddC(false)} onDone={() => { setAddC(false); reload(); }} />}
      {addA && <AddAddress d={d} onClose={() => setAddA(false)} onDone={() => { setAddA(false); reload(); }} />}
    </div>
  );
}
function AddContact({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", phone: "", role: "", isReceiver: false }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Thêm người liên hệ" footer={<Button block loading={busy} disabled={!f.name.trim()} onClick={async () => { setBusy(true); try { await post(`/customers/${id}/contacts`, { ...f, phone: f.phone || undefined, role: f.role || undefined }); onDone(); } catch {} finally { setBusy(false); } }}>Lưu</Button>}>
      <div className="stack"><Input label="Họ tên" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input label="SĐT" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /><Input label="Chức vụ" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.isReceiver} onChange={(e) => setF({ ...f, isReceiver: e.target.checked })} /> Người nhận hàng</label></div>
    </Sheet>
  );
}
function AddAddress({ d, onClose, onDone }: { d: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ label: "", address: "", receiverContactId: String(d.contacts.find((c: any) => c.isReceiver && c.active)?.id ?? ""), deliveryNote: "", isDefault: false }), [busy, setBusy] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Thêm địa chỉ giao" footer={<Button block loading={busy} disabled={!f.label.trim() || f.address.trim().length < 3} onClick={async () => { setBusy(true); try { await post(`/customers/${d.id}/addresses`, { label: f.label.trim(), address: f.address.trim(), isDefault: f.isDefault, deliveryNote: f.deliveryNote || undefined, ...(f.receiverContactId ? { receiverContactId: Number(f.receiverContactId) } : {}) }); onDone(); } catch {} finally { setBusy(false); } }}>Lưu</Button>}>
      <div className="stack"><Input label="Tên địa chỉ" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /><Input label="Địa chỉ" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        <Select label="Người nhận" value={f.receiverContactId} onChange={(e) => setF({ ...f, receiverContactId: e.target.value })}>{d.contacts.filter((c: any) => c.active).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <TextArea label="Ghi chú giao hàng" value={f.deliveryNote} onChange={(e) => setF({ ...f, deliveryNote: e.target.value })} />
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /> Đặt làm mặc định</label></div>
    </Sheet>
  );
}

function HistoryTab({ id }: { id: number }) {
  const h = useAsync(() => get(`/customers/${id}/history`), [id]);
  if (h.loading) return <Spinner />;
  const d = h.data ?? { orders: [], invoices: [], revenueByMonth: [] };
  const months = (d.revenueByMonth ?? []).map((r: any) => ({ label: r.month, value: r.revenue }));
  return (
    <div className="stack">
      <Card title="Doanh thu theo tháng">{months.length ? <BarChart data={months} /> : <EmptyState title="Chưa có hoá đơn" hint="Biểu đồ hiện khi khách có hoá đơn đã xuất." />}</Card>
      <Card title="Đơn gần đây"><DataTable rows={d.orders} rowKey={(o: any) => o.id} onRowClick={(o: any) => navigate(`/b2b-orders/${o.id}`)} empty="Chưa có đơn" cols={[
        { key: "c", label: "Mã đơn", title: true, render: (o: any) => <b>{o.code}</b> },
        { key: "s", label: "Trạng thái", render: (o: any) => <Badge tone={orderTone(o.status)}>{ORDER_STATUS[o.status] ?? o.status}</Badge> },
        { key: "d", label: "Ngày giao", render: (o: any) => ymd(o.deliveryDate) },
        { key: "t", label: "Tổng", right: true, render: (o: any) => <span className="money">{money(o.total)}</span> },
      ]} /></Card>
      <Card title="Hoá đơn"><DataTable rows={d.invoices} rowKey={(o: any) => o.id} onRowClick={(o: any) => navigate(`/invoices?id=${o.id}`)} empty="Chưa có hoá đơn" cols={[
        { key: "c", label: "Số HĐ", title: true, render: (o: any) => <b>{o.code}</b> },
        { key: "k", label: "Loại", render: (o: any) => INVOICE_KIND[o.kind] ?? o.kind },
        { key: "d", label: "Ngày", render: (o: any) => ymd(o.issueDate) },
        { key: "e", label: "HĐĐT", render: (o: any) => <Badge tone={einvTone(o.einvoiceStatus)}>{EINVOICE[o.einvoiceStatus] ?? o.einvoiceStatus}</Badge> },
        { key: "t", label: "Tổng", right: true, render: (o: any) => <span className="money">{money(o.total)}</span> },
      ]} /></Card>
    </div>
  );
}

function DebtTab({ d, onPay }: { d: any; onPay: () => void }) {
  const can = useCan();
  const inv = useAsync(() => get("/invoices", { customerId: d.id, limit: 100 }).then((r) => items<any>(r)), [d.id]);
  return (
    <div className="stack">
      <div className="row wrap">
        {can("debt.write") && <Button onClick={onPay}>Thu tiền</Button>}
        <Lnk to={`/debts?statement=customer:${d.id}`} className="btn soft">Xem sao kê</Lnk>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="l">Còn nợ hoá đơn</div><div className="v">{money(d.debt.outstanding)}</div></div>
        <div className="kpi"><div className="l">Tiền trả trước chưa gạch</div><div className="v" style={{ color: d.debt.unapplied ? "var(--accent)" : undefined }}>{money(d.debt.unapplied)}</div></div>
        <div className="kpi"><div className="l">Số HĐ quá hạn</div><div className="v">{d.debt.overdueCount}</div></div>
        <div className="kpi"><div className="l">Nợ quá hạn lâu nhất</div><div className="v">{d.debt.oldestOverdueDays} ngày</div></div>
      </div>
      <Card title="Hoá đơn">
        {inv.loading ? <Spinner /> : <DataTable rows={inv.data ?? []} rowKey={(x) => x.id} onRowClick={(x) => navigate(`/invoices?id=${x.id}`)} empty="Chưa có hoá đơn" cols={[
          { key: "c", label: "Số HĐ", title: true, render: (x) => <b>{x.code}</b> },
          { key: "d", label: "Hạn", render: (x) => ymd(x.dueDate) },
          { key: "t", label: "Tổng", right: true, render: (x) => <span className="money">{money(x.total)}</span> },
          { key: "o", label: "Còn nợ", right: true, render: (x) => <span className="money" style={{ color: x.overdueDays > 0 ? "var(--warn)" : undefined }}>{money(x.outstanding)}{x.overdueDays > 0 ? ` · trễ ${x.overdueDays} ngày` : ""}</span> },
        ]} />}
      </Card>
    </div>
  );
}

function PricesTab({ d, reload }: { d: any; reload: () => void }) {
  const can = useCan();
  const p = useAsync(() => (d.priceListId ? get("/prices", { priceListId: d.priceListId }, { silent: true }).then((r) => items<any>(r)) : Promise.resolve([])), [d.priceListId]);
  const [pick, setPick] = useState(false);
  const [sel, setSel] = useState<{ product: ProductLite; price: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!sel) return;
    setBusy(true);
    try { await put(`/customers/${d.id}/prices`, { items: [{ productId: sel.product.id, unitPrice: sel.price }], note: "Giá riêng theo khách" }); toast("Đã lưu giá riêng", "ok"); setSel(null); p.reload(); reload(); } catch {} finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="hint">Giá riêng ưu tiên cao nhất khi lập báo giá / đơn cho khách này. Giá tính theo đơn vị chính của hàng.</div>
      {can("b2b.approve") && <div><Button variant="soft" onClick={() => setPick(true)}>+ Đặt giá riêng cho mặt hàng</Button></div>}
      {p.loading ? <Spinner /> : <DataTable rows={p.data ?? []} rowKey={(x) => x.id} empty="Chưa có giá riêng — khách dùng bảng giá theo nhóm" cols={[
        { key: "n", label: "Hàng", title: true, render: (x) => <b>{x.productName}</b> },
        { key: "p", label: "Giá riêng", right: true, render: (x) => <span className="money">{money(x.unitPrice)}</span> },
        { key: "f", label: "Hiệu lực từ", render: (x) => ymd(x.effectiveFrom) },
      ]} />}
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={(pr) => setSel({ product: pr, price: 0 })} />
      {sel && (
        <Sheet open onClose={() => setSel(null)} title={`Giá riêng: ${sel.product.name}`} footer={<Button block loading={busy} disabled={sel.price <= 0} onClick={save}>Lưu giá riêng</Button>}>
          <MoneyInput label={`Giá (₫/${sel.product.baseUnit})`} value={sel.price} onChange={(n) => setSel({ ...sel, price: n })} />
        </Sheet>
      )}
    </div>
  );
}
