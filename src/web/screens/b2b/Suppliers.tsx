import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, usePagedList } from "../../components/list";
import { toast } from "../../components/toast";
import { fmtDateTime, money } from "../../format";
import { useCan } from "../../store";
import { PaymentSheet } from "./Debts";
import { ymd } from "./kit";
import { copyText } from "../d4/shared";

export default function Suppliers() {
  const can = useCan();
  const [q, setQ] = useState(""), [owing, setOwing] = useState("");
  const list = usePagedList<any>("/suppliers", { q, limit: 100 }, [q]);
  const debts = useAsync(async () => {
    if (!can("debt.view")) return { map: new Map<number, any>(), totals: null as any };
    const r = await get("/debts/payables", undefined, { silent: true });
    return { map: new Map<number, any>(items<any>(r).map((x) => [x.supplierId, x])), totals: r?.totals ?? null };
  }, []);
  const [sel, setSel] = useState<any>(null);
  const [form, setForm] = useState<any | "new" | null>(null);
  const canDebt = can("debt.view");
  const dmap = debts.data?.map;
  const t = debts.data?.totals;
  const rows = list.rows.filter((x) => (owing === "owing" ? (dmap?.get(x.id)?.balance ?? 0) > 0 : owing === "overdue" ? (dmap?.get(x.id)?.overdueAmount ?? 0) > 0 : true));
  const owingCount = dmap ? [...dmap.values()].filter((d) => d.balance > 0).length : 0;
  const dirty = !!(q || owing);
  const reset = () => { setQ(""); setOwing(""); };
  return (
    <div className="stack">
      <PageHeader compact subtitle={`${list.rows.length}${list.hasMore ? "+" : ""} nhà cung cấp`}
        actions={<>
          <ExportButton filename="nha-cung-cap" rows={rows} columns={[
            { label: "Mã", value: (x) => x.code }, { label: "Tên", value: (x) => x.name }, { label: "SĐT", value: (x) => x.phone }, { label: "MST", value: (x) => x.taxCode }, { label: "Hạn trả (ngày)", value: (x) => x.paymentTermsDays },
            ...(canDebt ? [{ label: "Còn phải trả", value: (x: any) => dmap?.get(x.id)?.balance ?? 0 }, { label: "Quá hạn", value: (x: any) => dmap?.get(x.id)?.overdueAmount ?? 0 }] : []),
          ]} />
          {can("inventory.write") && <Button onClick={() => setForm("new")}>+ Thêm NCC</Button>}
        </>} />
      {canDebt && (
        <KpiRow items={[
          { label: "Tổng phải trả NCC", value: t ? money(t.balance) : "—", tone: t?.balance > 0 ? "warn" : undefined },
          { label: "Quá hạn", value: t ? money(t.overdueAmount) : "—", tone: t?.overdueAmount > 0 ? "danger" : undefined, onClick: () => setOwing("overdue") },
          { label: "NCC đang còn nợ", value: dmap ? owingCount : "—", sub: `trên ${list.rows.length} NCC`, onClick: () => setOwing("owing") },
          { label: "Trả trước chưa gạch", value: t ? money(t.unapplied) : "—" },
        ]} />
      )}
      <FilterBar dirty={dirty} onReset={reset} activeCount={owing ? 1 : 0} advanced={canDebt ? <FilterSelect label="Công nợ" value={owing} onChange={setOwing} options={[{ v: "owing", label: "Đang còn nợ" }, { v: "overdue", label: "Có nợ quá hạn" }]} /> : undefined}>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên hoặc mã NCC…" label="Tìm nhà cung cấp" />
      </FilterBar>
      <SplitLayout open={!!sel} panel={sel ? <SupplierPanel s={sel} onEdit={() => setForm(sel)} onClose={() => { setSel(null); debts.reload(); }} /> : null}>
        {list.loading ? <Spinner /> : (
          <DataTable rows={rows} rowKey={(x) => x.id} onRowClick={setSel} selectedKey={sel?.id} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
            emptyState={<EmptyState title={dirty ? "Không có NCC nào khớp bộ lọc" : "Chưa có nhà cung cấp"} hint="Nhà cung cấp dùng khi nhập hàng và theo dõi công nợ phải trả."
              action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{can("inventory.write") && <Button onClick={() => setForm("new")}>+ Thêm NCC</Button>}</div>} />}
            cols={[
              { key: "n", label: "Nhà cung cấp", title: true, sort: (x) => x.name, render: (x) => <span><b>{x.name}</b> <span className="muted small">{x.code}</span></span> },
              { key: "p", label: "SĐT", hideMobile: true, hideBelow: 1280, render: (x) => x.phone ?? "—" },
              { key: "m", label: "MST", hideMobile: true, hideBelow: 1440, render: (x) => x.taxCode ?? "—" },
              { key: "t", label: "Hạn trả", num: true, sort: (x) => x.paymentTermsDays ?? 0, render: (x) => `${x.paymentTermsDays ?? 0} ngày` },
              ...(canDebt ? [{ key: "b", label: "Còn phải trả", num: true as const, sort: (x: any) => dmap?.get(x.id)?.balance ?? 0, render: (x: any) => { const d = dmap?.get(x.id); return d ? <span><b className="money">{money(d.balance)}</b>{d.overdueAmount > 0 && <> <Badge tone="warn">Quá hạn {money(d.overdueAmount)}</Badge></>}</span> : <span className="muted">—</span>; } }] : []),
            ]} />
        )}
      </SplitLayout>
      {form && <SupplierForm s={form === "new" ? null : form} onClose={() => setForm(null)} onSaved={(row) => { setForm(null); list.reload(); if (sel && row) setSel({ ...sel, ...row }); }} />}
    </div>
  );
}

function SupplierForm({ s, onClose, onSaved }: { s: any | null; onClose: () => void; onSaved: (row: any) => void }) {
  const [f, setF] = useState({ name: s?.name ?? "", phone: s?.phone ?? "", address: s?.address ?? "", taxCode: s?.taxCode ?? "", terms: String(s?.paymentTermsDays ?? 0), active: s?.active ?? true });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name.trim(), phone: f.phone.trim() || null, address: f.address.trim() || null, taxCode: f.taxCode.trim() || null, paymentTermsDays: Math.max(0, parseInt(f.terms) || 0), active: f.active };
      const row = s ? await put(`/suppliers/${s.id}`, body) : await post("/suppliers", body);
      toast(s ? "Đã cập nhật nhà cung cấp" : "Đã thêm nhà cung cấp", "ok"); onSaved(row);
    } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={s ? `Sửa ${s.name}` : "Thêm nhà cung cấp"} footer={<Button block size="lg" loading={busy} disabled={!f.name.trim()} onClick={save}>Lưu nhà cung cấp</Button>}>
      <div className="stack">
        <Input label="Tên nhà cung cấp" value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus />
        <div className="grid2"><Input label="SĐT" value={f.phone} onChange={(e) => set("phone", e.target.value)} /><Input label="Mã số thuế" value={f.taxCode} onChange={(e) => set("taxCode", e.target.value)} /></div>
        <Input label="Địa chỉ" value={f.address} onChange={(e) => set("address", e.target.value)} />
        <Input label="Hạn thanh toán (ngày)" inputMode="numeric" value={f.terms} onChange={(e) => set("terms", e.target.value)} hint="Số ngày được nợ kể từ ngày nhập hàng." />
        {s && <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={f.active} onChange={(e) => set("active", e.target.checked)} /> <span>Đang giao dịch</span></label>}
      </div>
    </Sheet>
  );
}

function SupplierPanel({ s, onClose, onEdit }: { s: any; onClose: () => void; onEdit: () => void }) {
  const can = useCan();
  const canDebt = can("debt.view");
  const b = useAsync(() => (canDebt ? get(`/suppliers/${s.id}/bills`, { limit: 100 }).then((r) => items<any>(r)) : Promise.resolve([] as any[])), [s.id]);
  const [fin, setFin] = useState<any>(null), [pay, setPay] = useState(false);
  return (
    <DetailPanel title={s.name} onClose={onClose}>
      <div className="stack">
        <div className="row wrap">
          {canDebt && can("debt.write") && <Button size="sm" onClick={() => setPay(true)}>Trả tiền</Button>}
          {can("inventory.write") && <Button size="sm" variant="soft" onClick={onEdit}>Sửa thông tin</Button>}
        </div>
        <div className="muted small">{s.code} · Hạn trả {s.paymentTermsDays ?? 0} ngày{s.taxCode ? ` · MST ${s.taxCode}` : ""}{s.phone ? ` · ${s.phone}` : ""}{s.address ? ` · ${s.address}` : ""}</div>
        {can("purchasing.approve") && <PortalBox supplier={s} />}
        {canDebt && (b.loading ? <Spinner /> : <DataTable rows={b.data ?? []} rowKey={(x) => x.id} empty="Chưa có hoá đơn mua — hoá đơn sinh khi nhập hàng có nhà cung cấp" cols={[
          { key: "c", label: "Mã", title: true, render: (x) => <span><b>{x.code}</b>{x.isProvisional ? <div className="row" style={{ gap: 6, marginTop: 4 }}><Badge tone="warn">Tạm tính</Badge>{x.status === "open" && can("debt.write") ? <Button size="sm" onClick={(e) => { e.stopPropagation(); setFin(x); }}>Chốt hoá đơn</Button> : null}</div> : null}</span> },
          { key: "r", label: "Số HĐ NCC", hideBelow: 1280, render: (x) => x.supplierRef || "—" },
          { key: "d", label: "Hạn", render: (x) => ymd(x.dueDate) },
          { key: "t", label: "Tổng", right: true, hideBelow: 1280, render: (x) => <span className="money">{money(x.total)}</span> },
          { key: "o", label: "Còn nợ", right: true, render: (x) => <span className="money">{money(x.outstanding)}</span> },
        ]} />)}
      </div>
      {fin && <FinalizeSheet bill={fin} onClose={() => setFin(null)} onDone={() => { setFin(null); b.reload(); }} />}
      {pay && <PaymentSheet partnerType="supplier" partnerId={s.id} partnerName={s.name} direction="out" onClose={() => setPay(false)} onDone={() => { setPay(false); b.reload(); }} />}
    </DetailPanel>
  );
}

function FinalizeSheet({ bill, onClose, onDone }: { bill: any; onClose: () => void; onDone: () => void }) {
  const [ref, setRef] = useState(bill.supplierRef ?? ""), [total, setTotal] = useState(bill.total), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const changed = total !== bill.total;
  return (
    <Sheet open onClose={onClose} title={`Chốt hoá đơn ${bill.code}`} footer={<Button block loading={busy} disabled={!ref.trim() || total <= 0 || (changed && reason.trim().length < 3)} onClick={async () => {
      setBusy(true);
      try { await post(`/bills/${bill.id}/finalize`, { supplierRef: ref.trim(), ...(changed ? { total, reason: reason.trim() } : {}) }); toast("Đã chốt hoá đơn mua", "ok"); onDone(); } catch {} finally { setBusy(false); }
    }}>Chốt hoá đơn</Button>}>
      <div className="stack">
        <Banner tone="info">Hoá đơn tạm tính theo phiếu nhập: {money(bill.total)}. Nhập số hoá đơn NCC gửi và chốt giá thực tế.</Banner>
        <Input label="Số hoá đơn của nhà cung cấp" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus />
        <MoneyInput label="Tổng tiền chốt (₫)" value={total} onChange={setTotal} />
        {changed && <><Banner>Chênh lệch giá chốt: <b>{money(total - bill.total)}</b> so với tạm tính — bắt buộc ghi lý do.</Banner><TextArea label="Lý do chênh lệch" value={reason} onChange={(e) => setReason(e.target.value)} /></>}
      </div>
    </Sheet>
  );
}
export { Card };

/** Cổng nhà cung cấp (/ncc): mời người của NCC, gửi lại link, thu hồi lời mời, khoá/mở khoá. Link chỉ hiện MỘT lần. */
const ACC_ST: Record<string, { label: string; tone?: "ok" | "warn" | "danger" }> = {
  invited: { label: "Chưa đặt mật khẩu", tone: "warn" }, active: { label: "Đang hoạt động", tone: "ok" }, locked: { label: "Đã khoá", tone: "danger" },
};

function PortalBox({ supplier }: { supplier: any }) {
  const r = useAsync(() => get(`/suppliers/${supplier.id}/portal`).then((x) => x as { enabled: boolean; shopConfigured: boolean; items: any[] }), [supplier.id]);
  const [inviting, setInviting] = useState(false);
  const [shown, setShown] = useState<{ account: any; invite: any; reset?: boolean } | null>(null);
  const [busy, setBusy] = useState<string>("");
  const act = async (a: any, what: "reinvite" | "revoke" | "lock" | "unlock") => {
    setBusy(`${what}-${a.id}`);
    try {
      const base = `/suppliers/${supplier.id}/portal/accounts/${a.id}`;
      if (what === "reinvite") { const x = await post(`${base}/invite`, {}); setShown({ ...x, reset: a.hasPassword }); }
      else if (what === "revoke") { await post(`${base}/revoke-invite`, {}); toast("Đã thu hồi lời mời", "ok"); }
      else if (what === "lock") { await post(`${base}/lock`, {}); toast("Đã khoá tài khoản, phiên đang mở bị đăng xuất", "ok"); }
      else { await post(`${base}/unlock`, {}); toast("Đã mở khoá", "ok"); }
      r.reload();
    } catch { /* toast từ api */ } finally { setBusy(""); }
  };
  return (
    <div className="stack" data-testid="portal-box" style={{ gap: 8 }}>
      <div className="row between">
        <b>Cổng nhà cung cấp</b>
        <Button size="sm" variant="soft" onClick={() => setInviting(true)} data-testid="portal-invite">Mời vào cổng</Button>
      </div>
      {r.data && !r.data.enabled && <Banner>Cổng đang <b>tắt</b> trong Cài đặt (ncc.portal_enabled) — NCC chưa đăng nhập được.</Banner>}
      {r.loading ? <Spinner /> : !(r.data?.items.length) ? (
        <div className="muted small">Chưa có tài khoản nào. Mời người của nhà cung cấp để họ xem và xác nhận đơn đặt hàng, đối chiếu công nợ trên website (/ncc).</div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {r.data.items.map((a) => {
            const st = ACC_ST[a.status] ?? { label: a.status };
            return (
              <div key={a.id} className="card flat" style={{ padding: "8px 12px" }} data-testid="portal-account">
                <div className="row between wrap" style={{ gap: 8 }}>
                  <span style={{ minWidth: 0 }}><b>{a.fullName}</b> <span className="muted small" style={{ overflowWrap: "anywhere" }}>{a.email}</span></span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="muted small">
                  {a.lastLoginAt ? `Vào lần cuối ${fmtDateTime(a.lastLoginAt)}` : "Chưa từng đăng nhập"}
                  {a.pendingInvite ? ` · ${a.pendingInvite.expired ? "Link mời đã hết hạn" : `Link mời còn hiệu lực đến ${fmtDateTime(a.pendingInvite.expiresAt)}`}` : ""}
                </div>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  {a.status !== "locked" && <Button size="sm" variant="ghost" loading={busy === `reinvite-${a.id}`} onClick={() => act(a, "reinvite")}>{a.hasPassword ? "Cấp link đặt lại mật khẩu" : "Gửi lại link mời"}</Button>}
                  {a.pendingInvite && <Button size="sm" variant="ghost" loading={busy === `revoke-${a.id}`} onClick={() => act(a, "revoke")}>Thu hồi lời mời</Button>}
                  {a.status === "locked"
                    ? <Button size="sm" variant="ghost" loading={busy === `unlock-${a.id}`} onClick={() => act(a, "unlock")}>Mở khoá</Button>
                    : <Button size="sm" variant="ghost" loading={busy === `lock-${a.id}`} onClick={() => { if (confirm(`Khoá tài khoản ${a.fullName}? Phiên đang mở sẽ bị đăng xuất ngay.`)) void act(a, "lock"); }}>Khoá</Button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {inviting && <InviteSheet supplier={supplier} onClose={() => setInviting(false)} onDone={(x) => { setInviting(false); setShown(x); r.reload(); }} />}
      {shown && <LinkSheet data={shown} shopConfigured={r.data?.shopConfigured ?? true} onClose={() => setShown(null)} />}
    </div>
  );
}

function InviteSheet({ supplier, onClose, onDone }: { supplier: any; onClose: () => void; onDone: (x: any) => void }) {
  const [f, setF] = useState({ fullName: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const ok = f.fullName.trim() && /^\S+@\S+\.\S+$/.test(f.email.trim());
  return (
    <Sheet portal open onClose={onClose} title={`Mời vào cổng — ${supplier.name}`} footer={<Button block size="lg" loading={busy} disabled={!ok} onClick={async () => {
      setBusy(true);
      try { onDone(await post(`/suppliers/${supplier.id}/portal/invites`, { fullName: f.fullName.trim(), email: f.email.trim(), phone: f.phone.trim() || null })); } catch { /* toast */ } finally { setBusy(false); }
    }}>Tạo link mời</Button>}>
      <div className="stack">
        <Banner tone="info">Hệ thống tạo một link đặt mật khẩu dùng một lần. Bạn sao chép và gửi cho người được mời qua Zalo hoặc email (hệ thống chưa tự gửi email).</Banner>
        <Input label="Họ tên người được mời" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} autoFocus />
        <Input label="Email (dùng để đăng nhập)" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Input label="Số điện thoại (không bắt buộc)" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </div>
    </Sheet>
  );
}

function LinkSheet({ data, shopConfigured, onClose }: { data: { account: any; invite: any; reset?: boolean }; shopConfigured: boolean; onClose: () => void }) {
  const { account: a, invite: i } = data;
  const msg = `Hữu Mạnh mời ${a.fullName} vào cổng nhà cung cấp. Mở link để đặt mật khẩu (dùng một lần, hết hạn ${fmtDateTime(i.expiresAt)}):\n${i.link ?? i.path}`;
  return (
    <Sheet portal open onClose={onClose} title="Link mời đã sẵn sàng" footer={<Button block size="lg" onClick={onClose}>Xong</Button>}>
      <div className="stack" data-testid="portal-link">
        <Banner tone="info">Link <b>chỉ hiện một lần</b> và hết hạn lúc <b>{fmtDateTime(i.expiresAt)}</b> ({i.ttlHours} giờ). Gửi cho <b>{a.fullName}</b> ({a.email}) qua Zalo hoặc email. Nếu mất link, bấm "Gửi lại link" để cấp link mới (link cũ sẽ bị thu hồi).</Banner>
        {!shopConfigured && !i.link && <Banner>Chưa cấu hình địa chỉ website (biến SHOP_BASE_URL) nên link chỉ có phần đường dẫn. Hãy ghép với địa chỉ website bán hàng khi gửi.</Banner>}
        <TextArea label={data.reset ? "Link đặt lại mật khẩu" : "Link đặt mật khẩu"} readOnly rows={3} value={i.link ?? i.path} onFocus={(e) => e.currentTarget.select()} data-testid="portal-link-text" />
        <div className="row wrap">
          <Button onClick={() => void copyText(i.link ?? i.path)}>Sao chép link</Button>
          <Button variant="soft" onClick={() => void copyText(msg)}>Sao chép cả lời nhắn</Button>
        </div>
      </div>
    </Sheet>
  );
}
