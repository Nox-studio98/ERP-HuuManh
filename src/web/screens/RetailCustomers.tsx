import { useState } from "react";
import { get, items, post, api } from "../api";
import { Badge, Banner, Button, DataTable, EmptyState, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, usePagedList } from "../components/list";
import { toast } from "../components/toast";
import { CHANNELS, METHODS, ORDER_STATUS, fmtDate, fmtDateTime, money, num } from "../format";
import { navigate } from "../router";
import { useCan } from "../store";

const GENDER: Record<string, string> = { male: "Nam", female: "Nữ", other: "Khác" };
const KIND: Record<string, string> = { earn: "Tích điểm", redeem: "Đổi điểm", reverse: "Hoàn / thu hồi", adjust: "Điều chỉnh", expire: "Hết hạn" };
const birthdayText = (b?: string | null) => (!b ? "—" : b.length === 5 ? `${b.slice(3)}/${b.slice(0, 2)}` : `${b.slice(8)}/${b.slice(5, 7)}/${b.slice(0, 4)}`);
const lastText = (iso?: string | null) => (iso ? fmtDate(iso) : "Chưa mua");

export default function RetailCustomers() {
  const can = useCan();
  const [q, setQ] = useState(""), [group, setGroup] = useState(""), [pts, setPts] = useState(""), [recent, setRecent] = useState(""), [status, setStatus] = useState("active");
  const [sel, setSel] = useState<number | null>(null);
  const groups = useAsync(() => get("/customer-groups", undefined, { silent: true }).then((r) => items<{ id: number; name: string; code: string }>(r)).catch(() => []), []);
  const today = new Date(Date.now() + 7 * 3600_000);
  const ago = (d: number) => new Date(today.getTime() - d * 86400_000).toISOString().slice(0, 10);
  const range: Record<string, Record<string, string>> = {
    "30": { lastFrom: ago(30), lastTo: ago(0) }, "90": { lastFrom: ago(90), lastTo: ago(0) },
    stale: { lastFrom: "2000-01-01", lastTo: ago(91) }, never: { purchased: "0" },
  };
  const query = { q, customerGroupId: group, hasPoints: pts, status, limit: 50, ...(range[recent] ?? {}) };
  const list = usePagedList<any>("/retail-customers", query, [q, group, pts, recent, status]);
  const sum = list.extra?.summary;
  const dirty = !!(q || group || pts || recent || status !== "active");
  const reset = () => { setQ(""); setGroup(""); setPts(""); setRecent(""); setStatus("active"); };
  const empty = (
    <EmptyState title={dirty ? "Không có khách nào khớp bộ lọc" : "Chưa có khách lẻ nào"}
      hint={dirty ? "Thử bỏ bớt bộ lọc." : "Khách lẻ được tạo khi bán hàng (nhập tên + SĐT tại quầy) hoặc khi đăng ký trên website."}
      action={dirty ? <Button variant="soft" onClick={reset}>Xoá lọc</Button> : can("pos.sell") ? <Button onClick={() => navigate("/pos")}>Bán hàng</Button> : undefined} />
  );
  return (
    <div className="stack">
      <PageHeader subtitle="Khách mua tại quầy và trên website: thông tin, điểm, lịch sử mua, gộp khách trùng"
        actions={<ExportButton filename="khach-le" rows={list.rows} columns={[
          { label: "Mã", value: (c) => c.code }, { label: "Tên", value: (c) => c.name }, { label: "SĐT", value: (c) => c.phone }, { label: "Email", value: (c) => c.email },
          { label: "Ngày sinh", value: (c) => birthdayText(c.birthday) }, { label: "Giới tính", value: (c) => (c.gender ? GENDER[c.gender] : "") }, { label: "Địa chỉ", value: (c) => c.address },
          { label: "Nhóm", value: (c) => c.groupName }, { label: "Điểm", value: (c) => c.points }, { label: "Số đơn", value: (c) => c.ordersCount },
          { label: "Tổng chi tiêu", value: (c) => c.spend }, { label: "Mua gần nhất", value: (c) => (c.lastPurchaseAt ? fmtDate(c.lastPurchaseAt) : "") }, { label: "Trạng thái", value: (c) => (c.active ? "Hoạt động" : "Ngừng") },
        ]} />} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={[group, pts, recent, status !== "active" ? status : ""].filter(Boolean).length} advanced={<>
        <FilterSelect label="Nhóm khách" value={group} onChange={setGroup} options={(groups.data ?? []).map((g) => ({ v: String(g.id), label: g.name }))} />
        <FilterSelect label="Điểm" value={pts} onChange={setPts} options={[{ v: "1", label: "Có điểm" }, { v: "0", label: "Chưa có điểm" }]} />
        <FilterSelect label="Mua gần nhất" value={recent} onChange={setRecent} options={[{ v: "30", label: "Trong 30 ngày" }, { v: "90", label: "Trong 90 ngày" }, { v: "stale", label: "Hơn 90 ngày trước" }, { v: "never", label: "Chưa từng mua" }]} />
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} allLabel="Hoạt động" options={[{ v: "inactive", label: "Đã ngừng" }, { v: "all", label: "Tất cả" }]} />
      </>}>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên, mã khách, SĐT…" label="Tìm khách lẻ" />
      </FilterBar>
      <KpiRow items={[
        { label: "Số khách", value: sum ? num(sum.count) : "—", sub: dirty ? "theo bộ lọc" : "đang hoạt động" },
        { label: "Tổng chi tiêu", value: sum ? money(sum.totalSpend) : "—", sub: "đơn hoàn tất trừ trả hàng", tone: "ok" },
        { label: "Điểm đang giữ", value: sum ? num(sum.totalPoints) : "—", sub: "tổng số dư điểm" },
        { label: "Chi tiêu TB / khách", value: sum && sum.count ? money(Math.round(sum.totalSpend / sum.count)) : "—" },
      ]} />
      <SplitLayout open={sel != null} panel={sel != null ? <Detail id={sel} groups={groups.data ?? []} onClose={() => setSel(null)} onChanged={list.reload} /> : null}>
        {list.error ? <Banner tone="danger">Không tải được danh sách khách. <Button size="sm" variant="ghost" onClick={list.reload}>Tải lại</Button></Banner>
          : list.loading ? <Spinner /> : (
            <DataTable rows={list.rows} rowKey={(c) => c.id} onRowClick={(c) => setSel(c.id)} selectedKey={sel} emptyState={empty}
              hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
              footer={`Đang hiển thị ${list.rows.length}${sum ? ` / ${sum.count}` : ""} khách`}
              cols={[
                { key: "n", label: "Khách hàng", title: true, sort: (c) => c.name, render: (c) => <span><b>{c.name}</b>{!c.active && <> <Badge tone="warn">Ngừng</Badge></>}<div className="small muted">{c.code}{c.phone ? ` · ${c.phone}` : ""}</div></span> },
                { key: "g", label: "Nhóm", hideBelow: 1280, sort: (c) => c.groupName ?? "", render: (c) => c.groupName ?? "—" },
                { key: "p", label: "Điểm", num: true, sort: (c) => c.points, render: (c) => num(c.points) },
                { key: "o", label: "Số đơn", num: true, hideBelow: 1280, sort: (c) => c.ordersCount, render: (c) => num(c.ordersCount) },
                { key: "l", label: "Mua gần nhất", hideBelow: 1024, sort: (c) => c.lastPurchaseAt ?? "", render: (c) => <span className={c.lastPurchaseAt ? "" : "muted"}>{lastText(c.lastPurchaseAt)}</span> },
                { key: "cr", label: "Hạn mức nợ", num: true, hideBelow: 1280, sort: (c) => c.creditLimit ?? 0, render: (c) => (c.creditLimit > 0 ? money(c.creditLimit) : <span className="muted">—</span>) },
                { key: "s", label: "Tổng chi tiêu", num: true, sort: (c) => c.spend, render: (c) => <span className="money">{money(c.spend)}</span> },
              ]} />
          )}
      </SplitLayout>
    </div>
  );
}

function Detail({ id, groups, onClose, onChanged }: { id: number; groups: { id: number; name: string }[]; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const d = useAsync(() => get(`/retail-customers/${id}`), [id]);
  const [tab, setTab] = useState<"orders" | "points" | "debt" | "web">("orders");
  const [dlg, setDlg] = useState<null | "edit" | "merge" | "active" | "credit">(null);
  const c = d.data;
  const done = () => { setDlg(null); d.reload(); onChanged(); };
  const write = can("b2b.write");
  return (
    <DetailPanel onClose={onClose} title={c ? c.name : "Khách lẻ"}>
      {d.loading || !c ? <Spinner /> : (
        <div className="stack">
          <div className="row wrap">
            <Badge tone={c.active ? "ok" : "warn"}>{c.active ? "Đang hoạt động" : "Đã ngừng"}</Badge>
            <span className="muted small">{c.code}{c.groupName ? ` · ${c.groupName}` : ""}{c.createdAt ? ` · tạo ${fmtDate(c.createdAt)}` : ""}</span>
          </div>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <div className="kpi" style={{ gridColumn: "1 / -1" }}><div className="l">Tổng chi tiêu</div><div className="v money">{money(c.spend)}</div></div>
            <div className="kpi"><div className="l">Điểm</div><div className="v">{num(c.points)}</div></div>
            <div className="kpi"><div className="l">Mua gần nhất</div><div className="v nw" style={{ fontSize: "1.05rem" }}>{lastText(c.lastPurchaseAt)}</div></div>
            <div className="kpi" data-testid="rc-credit-limit"><div className="l">Hạn mức nợ</div><div className="v" style={{ fontSize: "1.05rem" }}>{c.creditLimit > 0 ? money(c.creditLimit) : "Chưa cho nợ"}</div><div className="s small muted">kỳ hạn {c.paymentTermsDays > 0 ? `${c.paymentTermsDays} ngày` : "mặc định"}</div></div>
            {c.debt && <div className="kpi" data-testid="rc-debt-out"><div className="l">Còn nợ</div><div className="v money" style={{ fontSize: "1.05rem", color: c.debt.overdueAmount > 0 ? "var(--danger)" : undefined }}>{money(c.debt.outstanding)}</div><div className="s small muted">{c.debt.overdueAmount > 0 ? `quá hạn ${money(c.debt.overdueAmount)}` : "chưa quá hạn"}</div></div>}
          </div>
          <div className="card flat stack" style={{ gap: 6 }}>
            <Row k="SĐT" v={c.phone} /><Row k="Email" v={c.email} /><Row k="Ngày sinh" v={birthdayText(c.birthday)} /><Row k="Giới tính" v={c.gender ? GENDER[c.gender] : null} />
            <Row k="Địa chỉ" v={c.address} /><Row k="Ghi chú" v={c.note} />
          </div>
          {c.mergedFrom?.length > 0 && <Banner tone="info">Đã gộp từ: {c.mergedFrom.map((m: any) => `${m.code} (${m.name})`).join(", ")}</Banner>}
          {write && (
            <div className="row wrap">
              <Button variant="soft" onClick={() => setDlg("edit")}>Sửa thông tin</Button>
              {can("b2b.approve") && <Button variant="soft" data-testid="rc-credit-edit" onClick={() => setDlg("credit")}>Đặt hạn mức nợ</Button>}
              {c.active && <Button variant="ghost" onClick={() => setDlg("merge")}>Gộp khách trùng</Button>}
              <Button variant="ghost" onClick={() => setDlg("active")}>{c.active ? "Ngừng hoạt động" : "Kích hoạt lại"}</Button>
            </div>
          )}
          <Segmented value={tab} onChange={setTab} options={[{ v: "orders", label: `Đơn (${c.orders.length})` }, { v: "points", label: "Điểm" }, ...(c.debt ? [{ v: "debt" as const, label: c.debt.outstanding > 0 ? "Công nợ •" : "Công nợ" }] : []), { v: "web", label: `Website (${c.shopAccounts.length})` }]} />
          {tab === "orders" && (
            <DataTable rows={c.orders} rowKey={(o: any) => o.id} empty="Chưa có đơn hàng" onRowClick={can("orders.view") ? (o: any) => navigate(`/orders?open=${o.id}`) : undefined}
              cols={[
                { key: "c", label: "Mã đơn", title: true, render: (o: any) => <b className="nw">{o.code}</b> },
                { key: "t", label: "Ngày", render: (o: any) => fmtDateTime(o.createdAt) },
                { key: "ch", label: "Kênh", hideMobile: true, render: (o: any) => CHANNELS[o.channel] ?? o.channel },
                { key: "s", label: "Trạng thái", render: (o: any) => <Badge tone={o.status === "completed" ? "ok" : o.status === "cancelled" || o.status === "returned" ? "danger" : "info"}>{o.kind === "return" ? "Trả hàng" : ORDER_STATUS[o.status] ?? o.status}</Badge> },
                { key: "tt", label: "Tổng", num: true, render: (o: any) => <span className="money">{o.kind === "return" ? "-" : ""}{money(o.total)}</span> },
              ]} />
          )}
          {tab === "points" && (
            <div className="stack">
              {!c.loyalty.enabled && <Banner tone="info">Chương trình tích điểm đang tắt (Cài đặt). Số dư cũ vẫn được giữ.</Banner>}
              <DataTable rows={c.loyalty.ledger} rowKey={(l: any) => l.id} empty="Chưa có giao dịch điểm"
                cols={[
                  { key: "t", label: "Ngày", title: true, render: (l: any) => fmtDateTime(l.createdAt) },
                  { key: "k", label: "Loại", render: (l: any) => KIND[l.kind] ?? l.kind },
                  { key: "n", label: "Ghi chú", hideMobile: true, render: (l: any) => <span className="small muted">{l.note ?? "—"}</span> },
                  { key: "p", label: "Điểm", num: true, render: (l: any) => <b style={{ color: l.points < 0 ? "var(--danger, #c0392b)" : "var(--ok, #1a7f4b)" }}>{l.points > 0 ? "+" : ""}{num(l.points)}</b> },
                ]} />
            </div>
          )}
          {tab === "debt" && c.debt && (
            <div className="stack" data-testid="rc-debt-tab">
              <div className="card flat stack" style={{ gap: 6 }}>
                <div className="row between"><span className="muted small">Còn nợ</span><b className="money">{money(c.debt.outstanding)}</b></div>
                <div className="row between"><span className="muted small">Còn được nợ thêm</span><span className="money">{money(c.debt.available)}</span></div>
                {c.debt.unapplied > 0 && <div className="row between"><span className="muted small">Tiền đã thu chưa gạch</span><span className="money">{money(c.debt.unapplied)}</span></div>}
                {c.debt.oldestOverdueDays > 0 && <div className="row between"><span className="muted small">Quá hạn lâu nhất</span><span style={{ color: "var(--danger)" }}>{c.debt.oldestOverdueDays} ngày</span></div>}
              </div>
              <DataTable rows={c.debt.invoices} rowKey={(i: any) => i.id} empty="Không có hoá đơn nợ"
                cols={[
                  { key: "c", label: "Hoá đơn", title: true, render: (i: any) => <span><b className="nw">{i.code}</b>{i.orderCode && <div className="small muted">đơn {i.orderCode}</div>}</span> },
                  { key: "d", label: "Hạn trả", render: (i: any) => <span>{fmtDate(i.dueDate)}{i.overdueDays > 0 && <> <Badge tone="danger">quá {i.overdueDays} ngày</Badge></>}</span> },
                  { key: "t", label: "Số tiền", num: true, hideMobile: true, render: (i: any) => money(i.total) },
                  { key: "o", label: "Còn nợ", num: true, render: (i: any) => <b className="money">{money(i.outstanding)}</b> },
                ]} />
              <div className="small muted">Phiếu thu nợ gần đây</div>
              <DataTable rows={c.debt.payments} rowKey={(p: any) => p.code} empty="Chưa có phiếu thu nợ"
                cols={[
                  { key: "c", label: "Phiếu", title: true, render: (p: any) => <span><b className="nw">{p.code}</b>{p.status !== "posted" && <> <Badge tone="warn">đã đảo</Badge></>}</span> },
                  { key: "t", label: "Ngày", render: (p: any) => fmtDateTime(p.paidAt) },
                  { key: "m", label: "Hình thức", hideMobile: true, render: (p: any) => METHODS[p.method] ?? p.method },
                  { key: "a", label: "Số tiền", num: true, render: (p: any) => <span className="money">{money(p.amount)}</span> },
                ]} />
            </div>
          )}
          {tab === "web" && (
            <DataTable rows={c.shopAccounts} rowKey={(a: any) => a.id} empty="Chưa liên kết tài khoản website"
              cols={[
                { key: "e", label: "Tài khoản", title: true, render: (a: any) => <span><b>{a.fullName}</b><div className="small muted">{a.email}</div></span> },
                { key: "p", label: "SĐT", hideMobile: true, render: (a: any) => a.phone ?? "—" },
                { key: "s", label: "Trạng thái", render: (a: any) => <Badge tone={a.active ? "ok" : "warn"}>{a.active ? "Hoạt động" : "Khoá"}</Badge> },
              ]} />
          )}
          {dlg === "credit" && <CreditSheet c={c} onClose={() => setDlg(null)} onDone={done} />}
          {dlg === "edit" && <EditSheet c={c} groups={groups} onClose={() => setDlg(null)} onDone={done} />}
          {dlg === "merge" && <MergeSheet c={c} onClose={() => setDlg(null)} onDone={() => { done(); }} />}
          {dlg === "active" && <ActiveSheet c={c} onClose={() => setDlg(null)} onDone={done} />}
        </div>
      )}
    </DetailPanel>
  );
}

const Row = ({ k, v }: { k: string; v?: string | null }) => (
  <div className="row between" style={{ gap: 12, alignItems: "flex-start" }}><span className="muted small" style={{ flex: "0 0 84px" }}>{k}</span><span style={{ textAlign: "right", overflowWrap: "anywhere" }}>{v || "—"}</span></div>
);

function EditSheet({ c, groups, onClose, onDone }: { c: any; groups: { id: number; name: string }[]; onClose: () => void; onDone: () => void }) {
  const masked = String(c.phone ?? "").includes("*") || c.email === "***" || c.address === "***";
  const [f, setF] = useState({ name: c.name ?? "", phone: c.phone ?? "", email: c.email ?? "", birthday: c.birthday ?? "", gender: c.gender ?? "", address: c.address ?? "", note: c.note ?? "", group: String(c.customerGroupId ?? "") });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { version: c.version, name: f.name, birthday: f.birthday || null, gender: f.gender || null, note: f.note || null };
      if (!masked) Object.assign(body, { phone: f.phone || null, email: f.email || null, address: f.address || null });
      if (f.group) body.customerGroupId = Number(f.group);
      await api(`/retail-customers/${c.id}`, { method: "PATCH", body });
      toast("Đã lưu thông tin khách", "ok"); onDone();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open portal onClose={onClose} title="Sửa thông tin khách" footer={<><Button variant="ghost" onClick={onClose}>Huỷ</Button><Button className="grow" loading={busy} disabled={!f.name.trim()} onClick={save}>Lưu</Button></>}>
      <div className="stack">
        {masked && <Banner tone="info">Bạn không có quyền xem thông tin liên hệ nên chỉ sửa được các trường còn lại.</Banner>}
        <Input label="Tên khách" value={f.name} onChange={set("name")} />
        <Input label="Số điện thoại" inputMode="tel" value={masked ? "" : f.phone} placeholder={masked ? "Đã ẩn" : ""} disabled={masked} onChange={set("phone")} />
        <Input label="Email" type="email" value={masked ? "" : f.email} placeholder={masked ? "Đã ẩn" : ""} disabled={masked} onChange={set("email")} />
        <Input label="Ngày sinh" type="text" placeholder="YYYY-MM-DD hoặc MM-DD" hint="Khách không nhớ năm: nhập tháng-ngày, ví dụ 03-15" value={f.birthday} onChange={set("birthday")} />
        <Select label="Giới tính" value={f.gender} onChange={set("gender")}><option value="">Chưa rõ</option>{Object.entries(GENDER).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        <Select label="Nhóm khách" value={f.group} onChange={set("group")}><option value="">—</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>
        <Input label="Địa chỉ" value={masked ? "" : f.address} disabled={masked} placeholder={masked ? "Đã ẩn" : ""} onChange={set("address")} />
        <TextArea label="Ghi chú" value={f.note} onChange={set("note")} />
      </div>
    </Sheet>
  );
}

/** Đặt hạn mức nợ + kỳ hạn (quản lý/chủ). Quản lý nâng vượt ngưỡng → chờ chủ duyệt (A-10). */
function CreditSheet({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const [limit, setLimit] = useState<number>(c.creditLimit ?? 0), [terms, setTerms] = useState(String(c.paymentTermsDays ?? 0)), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const t = Math.max(0, Math.min(365, Math.floor(Number(terms) || 0)));
  const changed = limit !== (c.creditLimit ?? 0) || t !== (c.paymentTermsDays ?? 0);
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { version: c.version, reason: reason.trim() };
      if (limit !== (c.creditLimit ?? 0)) body.creditLimit = limit;
      if (t !== (c.paymentTermsDays ?? 0)) body.paymentTermsDays = t;
      const r = await api(`/retail-customers/${c.id}/credit`, { method: "PUT", body });
      toast(r?.creditApprovalPending ? "Đã gửi chủ duyệt phần vượt ngưỡng; phần còn lại đã lưu" : "Đã lưu hạn mức nợ", "ok"); onDone();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open portal onClose={onClose} title="Hạn mức nợ khách lẻ" footer={<><Button variant="ghost" onClick={onClose}>Huỷ</Button><Button className="grow" loading={busy} disabled={!changed || reason.trim().length < 3} onClick={save}>Lưu</Button></>}>
      <div className="stack">
        <Banner tone="info">Hạn mức = tổng nợ tối đa khách được ghi nợ tại quầy. Để 0 là không cho nợ. Bán nợ chỉ chạy khi bật “Cho phép bán nợ khách lẻ” ở Cài đặt → Công nợ.</Banner>
        <MoneyInput label="Hạn mức nợ (₫)" value={limit} onChange={setLimit} />
        <Input label="Kỳ hạn trả (ngày)" type="number" min={0} max={365} value={terms} onChange={(e) => setTerms(e.target.value)} hint="0 = dùng kỳ hạn mặc định trong Cài đặt." />
        <TextArea label="Lý do (bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Sheet>
  );
}

function ActiveSheet({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const next = !c.active;
  const go = async () => {
    setBusy(true);
    try { await post(`/retail-customers/${c.id}/active`, { active: next, version: c.version, reason: reason || undefined }); toast(next ? "Đã kích hoạt lại khách" : "Đã ngừng hoạt động", "ok"); onDone(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open portal onClose={onClose} title={next ? "Kích hoạt lại khách" : "Ngừng hoạt động"} footer={<><Button variant="ghost" onClick={onClose}>Huỷ</Button><Button className="grow" variant={next ? "primary" : "danger"} loading={busy} onClick={go}>{next ? "Kích hoạt" : "Ngừng hoạt động"}</Button></>}>
      <div className="stack">
        <Banner tone="info">{next ? "Khách sẽ hiện lại khi tìm ở quầy bán hàng." : "Khách sẽ không còn hiện khi tìm ở quầy bán hàng. Lịch sử mua và điểm vẫn được giữ."}</Banner>
        <TextArea label="Lý do (không bắt buộc)" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Sheet>
  );
}

function MergeSheet({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<any>(null);
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const found = useAsync(async () => (q.trim().length < 2 ? [] : items<any>(await get("/retail-customers", { q: q.trim(), limit: 8 }, { silent: true })).filter((x) => x.id !== c.id)), [q]);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post(`/retail-customers/${c.id}/merge`, { targetId: target.id, version: c.version, targetVersion: target.version, reason });
      toast(`Đã gộp: chuyển ${r.ordersMoved} đơn, ${num(r.pointsMoved)} điểm`, "ok"); onDone();
    } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Sheet open portal onClose={onClose} title="Gộp khách trùng" footer={<><Button variant="ghost" onClick={onClose}>Huỷ</Button><Button className="grow" variant="danger" loading={busy} disabled={!target || reason.trim().length < 3} onClick={go}>Gộp vào {target?.code ?? "…"}</Button></>}>
      <div className="stack">
        <Banner tone="info">Hồ sơ <b>{c.name}</b> ({c.code}) sẽ được gộp vào hồ sơ bạn chọn bên dưới: đơn hàng, tài khoản website và {num(c.points)} điểm chuyển sang hồ sơ đó; hồ sơ này bị ngừng. Không hoàn tác được.</Banner>
        <SearchInput value={q} onSearch={(v) => { setQ(v); setTarget(null); }} placeholder="Tìm khách giữ lại (tên, mã, SĐT)…" label="Khách giữ lại" />
        {q.trim().length >= 2 && !found.loading && !(found.data ?? []).length && <div className="muted small">Không tìm thấy khách nào.</div>}
        <div className="stack" style={{ gap: 6 }}>
          {(found.data ?? []).map((x: any) => (
            <button type="button" key={x.id} className={"card flat row between" + (target?.id === x.id ? " selected" : "")} onClick={() => setTarget(x)}
              style={{ textAlign: "left", cursor: "pointer", outline: target?.id === x.id ? "2px solid var(--brand, #1f7a3f)" : undefined }}>
              <span><b>{x.name}</b><div className="small muted">{x.code}{x.phone ? ` · ${x.phone}` : ""}</div></span>
              <span className="small muted" style={{ textAlign: "right" }}>{num(x.points)} điểm<div>{money(x.spend)}</div></span>
            </button>
          ))}
        </div>
        <TextArea label="Lý do gộp" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Sheet>
  );
}
