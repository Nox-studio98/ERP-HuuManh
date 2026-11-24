import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, MoneyInput, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, SplitLayout, usePagedList } from "../../components/list";
import { toast } from "../../components/toast";
import { money } from "../../format";
import { useCan } from "../../store";
import { PaymentSheet } from "./Debts";
import { ymd } from "./kit";

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
