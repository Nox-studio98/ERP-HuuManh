import { useEffect, useState } from "react";
import { ExportButton, FilterBar, KpiRow, PageHeader, SearchInput } from "../../components/list";
import { ApiError, get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Field, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, when } from "../../components/ui";
import { toast } from "../../components/toast";
import { CHANNELS, fmtDate, money } from "../../format";
import { useCan } from "../../store";
import { reasonText } from "./voucher-text";
import { BtnRow, Group, ProductPicker, Tile, bpPct, copyText, downloadCsv, useCatalog, type Prod } from "./shared";

const KIND: Record<string, string> = { percent: "Giảm %", amount: "Giảm số tiền", fixed_price: "Giá cố định", combo: "Combo", end_of_day: "Xả cuối ngày" };
const STATUS: Record<string, { l: string; t?: "ok" | "warn" | "danger" | "info" }> = {
  draft: { l: "Nháp" }, pending_approval: { l: "Chờ duyệt", t: "warn" }, active: { l: "Đang chạy", t: "ok" }, ended: { l: "Đã kết thúc" }, cancelled: { l: "Đã huỷ", t: "danger" },
};
export const statusBadge = (s: string) => <Badge tone={STATUS[s]?.t}>{STATUS[s]?.l ?? s}</Badge>;

export default function Promotions() {
  const can = useCan();
  const [tab, setTab] = useState<"promo" | "voucher" | "preview" | "loyalty">("promo");
  return (
    <div className="stack d4">
      <PageHeader subtitle="Khuyến mãi, mã giảm giá và tích điểm khách hàng" />
      <Segmented className="tabs-d" value={tab} onChange={setTab} options={[{ v: "promo", label: "Khuyến mãi" }, { v: "voucher", label: "Voucher" }, { v: "preview", label: "Tính thử" }, { v: "loyalty", label: "Tích điểm" }]} />
      {tab === "promo" && <PromoList canWrite={can("promotions.write")} />}
      {tab === "voucher" && <Vouchers canWrite={can("promotions.write")} />}
      {tab === "preview" && <Preview />}
      {tab === "loyalty" && <Loyalty canAdjust={can("loyalty.adjust")} />}
    </div>
  );
}

// ---------------------------------------------------------------- danh sách + biểu mẫu
type Item = { productId?: number | null; groupId?: number | null; qtyMilli?: number | null };
type Form = {
  id?: number; name: string; kind: string; channels: string[]; pct: number; valueAmount: number; maxDiscount: number; minOrder: number; startsAt: string; endsAt: string;
  dailyStart: string; dailyEnd: string; requiresVoucher: boolean; stackable: boolean; priority: number; items: Item[];
};
const ymd = (d: Date) => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
const blank = (): Form => ({ name: "", kind: "percent", channels: ["pos", "online"], pct: 10, valueAmount: 0, maxDiscount: 0, minOrder: 0, startsAt: ymd(new Date()), endsAt: ymd(new Date(Date.now() + 30 * 86400000)), dailyStart: "19:00", dailyEnd: "22:00", requiresVoucher: false, stackable: false, priority: 0, items: [] });
const dayOf = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : ymd(new Date(iso)));
const fromApi = (p: any): Form => ({
  id: p.id, name: p.name, kind: p.kind, channels: p.channels, pct: (p.valueBp ?? 0) / 100, valueAmount: p.valueAmount ?? 0, maxDiscount: p.maxDiscount ?? 0, minOrder: p.minOrder ?? 0,
  startsAt: dayOf(p.startsAt), endsAt: dayOf(p.endsAt), dailyStart: p.dailyStart ?? "19:00", dailyEnd: p.dailyEnd ?? "22:00", requiresVoucher: p.requiresVoucher, stackable: p.stackable, priority: p.priority, items: p.items ?? [],
});

function PromoList({ canWrite }: { canWrite: boolean }) {
  const [status, setStatus] = useState(""), [q, setQ] = useState("");
  const list = useAsync(() => get("/promotions").then((r) => items<any>(r)), []);
  const [edit, setEdit] = useState<Form | null>(null);
  const [view, setView] = useState<any | null>(null);
  const open = async (p: any) => {
    const full = await get(`/promotions/${p.id}`);
    if (full.status === "draft" && canWrite) setEdit(fromApi(full)); else setView(full);
  };
  const all = list.data ?? [];
  const n = (s: string) => all.filter((p) => p.status === s).length;
  const rows = all.filter((p) => (!status || p.status === status) && (!q.trim() || `${p.name} ${p.code}`.toLowerCase().includes(q.trim().toLowerCase())));
  const pending = n("pending_approval");
  return (
    <div className="stack">
      <KpiRow items={[
        { label: "Đang chạy", value: n("active"), tone: "ok", onClick: () => setStatus("active") }, { label: "Chờ duyệt", value: pending, tone: pending ? "warn" : undefined, onClick: () => setStatus("pending_approval") },
        { label: "Nháp", value: n("draft"), onClick: () => setStatus("draft") }, { label: "Đã kết thúc", value: n("ended"), onClick: () => setStatus("ended") },
      ]} />
      <FilterBar dirty={!!(status || q)} onReset={() => { setStatus(""); setQ(""); }}>
        <div className="chips scroll" role="group" aria-label="Lọc trạng thái">
          {[["", "Tất cả"], ["draft", "Nháp"], ["pending_approval", "Chờ duyệt"], ["active", "Đang chạy"], ["ended", "Đã kết thúc"]].map(([v, l]) => <button key={v} className="chip" aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>)}
        </div>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên, mã khuyến mãi…" label="Tìm khuyến mãi" />
        <ExportButton className="fb-end" filename="khuyen-mai" rows={rows} columns={[{ label: "Mã", value: (p) => p.code }, { label: "Tên", value: (p) => p.name }, { label: "Loại", value: (p) => KIND[p.kind] ?? p.kind }, { label: "Bắt đầu", value: (p) => fmtDate(p.startsAt) }, { label: "Kết thúc", value: (p) => fmtDate(p.endsAt) }, { label: "Trạng thái", value: (p) => STATUS[p.status]?.l ?? p.status }]} />
        {canWrite && <Button onClick={() => setEdit(blank())}>+ Khuyến mãi mới</Button>}
      </FilterBar>
      {pending > 0 && <Banner>{pending} khuyến mãi đang chờ quản lý duyệt — vào mục “Duyệt” để kích hoạt.</Banner>}
      {list.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(p) => p.id} onRowClick={open}
          emptyState={<EmptyState title={status || q ? "Không có khuyến mãi nào khớp bộ lọc" : "Chưa có khuyến mãi"} hint="Tạo khuyến mãi giảm %, giảm tiền, combo hoặc xả cuối ngày." action={<div className="row wrap" style={{ justifyContent: "center" }}>{(status || q) && <Button variant="soft" onClick={() => { setStatus(""); setQ(""); }}>Xoá lọc</Button>}{canWrite && <Button onClick={() => setEdit(blank())}>+ Khuyến mãi mới</Button>}</div>} />} cols={[
          { key: "n", label: "Khuyến mãi", title: true, sort: (p) => p.name, render: (p) => <span><b>{p.name}</b><div className="small muted">{p.code} · {KIND[p.kind] ?? p.kind}</div></span> },
          { key: "v", label: "Giá trị", num: true, sort: (p) => p.valueBp ?? p.valueAmount ?? 0, render: (p) => (p.valueBp ? bpPct(p.valueBp) : p.valueAmount != null ? money(p.valueAmount) : "—") },
          { key: "t", label: "Thời gian", sort: (p) => p.startsAt, render: (p) => `${fmtDate(p.startsAt)} – ${fmtDate(p.endsAt)}` },
          { key: "c", label: "Kênh", hideMobile: true, render: (p) => p.channels.map((c: string) => CHANNELS[c] ?? c).join(", ") },
          { key: "vc", label: "Voucher", num: true, render: (p) => (p.requiresVoucher ? `${p.voucherCount} mã` : "Tự động") },
          { key: "s", label: "Trạng thái", sort: (p) => p.status, render: (p) => statusBadge(p.status) },
        ]} />
      )}
      {edit && <PromoForm init={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); }} />}
      {view && <PromoView p={view} canWrite={canWrite} onClose={() => setView(null)} onChanged={() => { setView(null); list.reload(); }} />}
    </div>
  );
}

function PromoView({ p, canWrite, onClose, onChanged }: { p: any; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const cat = useCatalog();
  const [busy, setBusy] = useState(false);
  const end = async () => { setBusy(true); try { await post(`/promotions/${p.id}/end`); toast("Đã kết thúc khuyến mãi", "ok"); onChanged(); } catch {} finally { setBusy(false); } };
  return (
    <Sheet open onClose={onClose} title={p.name} footer={canWrite && ["active", "pending_approval"].includes(p.status) ? <Button block variant="danger" loading={busy} onClick={end}>Kết thúc khuyến mãi</Button> : undefined}>
      <div className="stack">
        <div className="row">{statusBadge(p.status)}<span className="muted">{p.code} · {KIND[p.kind]}</span></div>
        <div className="totals">
          <div><span className="muted">Giá trị</span><span>{p.valueBp ? bpPct(p.valueBp) : p.valueAmount != null ? money(p.valueAmount) : "—"}</span></div>
          {p.maxDiscount != null && p.maxDiscount > 0 && <div><span className="muted">Giảm tối đa</span><span>{money(p.maxDiscount)}</span></div>}
          <div><span className="muted">Đơn tối thiểu</span><span>{money(p.minOrder)}</span></div>
          <div><span className="muted">Thời gian</span><span>{fmtDate(p.startsAt)} – {fmtDate(p.endsAt)}</span></div>
          {p.dailyStart && <div><span className="muted">Khung giờ</span><span>{p.dailyStart} – {p.dailyEnd}</span></div>}
          <div><span className="muted">Kênh</span><span>{p.channels.map((c: string) => CHANNELS[c] ?? c).join(", ")}</span></div>
          <div><span className="muted">Cộng dồn</span><span>{p.stackable ? "Có" : "Không"}</span></div>
          <div><span className="muted">Cần voucher</span><span>{p.requiresVoucher ? "Có" : "Không"}</span></div>
        </div>
        {p.status === "pending_approval" && <Banner>Đang chờ người có quyền duyệt khuyến mãi kích hoạt (mục “Duyệt”).</Banner>}
        {p.items?.length > 0 && <div><b>Phạm vi áp dụng</b>{p.items.map((i: Item, k: number) => <div key={k} className="small">• {itemLabel(i, cat)}</div>)}</div>}
      </div>
    </Sheet>
  );
}

const itemLabel = (i: Item, cat: ReturnType<typeof useCatalog>) =>
  (i.productId ? cat.byId.get(i.productId)?.name ?? `SP #${i.productId}` : `Nhóm: ${cat.groups.find((g) => g.id === i.groupId)?.name ?? "#" + i.groupId}`) + (i.qtyMilli ? ` × ${i.qtyMilli / 1000}` : "");

function PromoForm({ init, onClose, onSaved }: { init: Form; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(init);
  const cat = useCatalog();
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const k = f.kind;
  const needScope = k === "fixed_price" || k === "combo";
  const body = () => ({
    name: f.name.trim(), kind: k, channels: f.channels, minOrder: f.minOrder, startsAt: f.startsAt, endsAt: f.endsAt, requiresVoucher: f.requiresVoucher, stackable: f.stackable, priority: f.priority,
    ...(k === "percent" || k === "end_of_day" ? { valueBp: Math.round(f.pct * 100) } : {}),
    ...(k === "amount" || k === "fixed_price" || k === "combo" ? { valueAmount: f.valueAmount } : {}),
    ...(k === "percent" && f.maxDiscount ? { maxDiscount: f.maxDiscount } : {}),
    ...(k === "end_of_day" ? { dailyStart: f.dailyStart, dailyEnd: f.dailyEnd } : {}),
    items: f.items.map((i) => ({ ...(i.productId ? { productId: i.productId } : { groupId: i.groupId }), ...(k === "combo" ? { qtyMilli: i.qtyMilli ?? 1000 } : {}) })),
  });
  const save = async (submit: boolean) => {
    setErr("");
    if (f.name.trim().length < 2) return setErr("Nhập tên khuyến mãi.");
    if (!f.channels.length) return setErr("Chọn ít nhất một kênh.");
    if (needScope && !f.items.length) return setErr(k === "combo" ? "Combo cần ít nhất một thành phần." : "Chọn sản phẩm hoặc nhóm áp dụng.");
    setBusy(true);
    try {
      const saved = f.id ? await put(`/promotions/${f.id}`, body()) : await post("/promotions", body());
      if (submit) {
        const r = await post(`/promotions/${saved.id}/submit`);
        toast(r.status === "active" ? "Khuyến mãi đã được kích hoạt" : "Đã gửi duyệt — chờ quản lý kích hoạt", "ok");
      } else toast("Đã lưu bản nháp", "ok");
      onSaved();
    } catch (e) { if (e instanceof ApiError) setErr(e.message); } finally { setBusy(false); }
  };
  const addItem = (p: Prod) => setF((x) => (x.items.some((i) => i.productId === p.id) ? x : { ...x, items: [...x.items, { productId: p.id, qtyMilli: 1000 }] }));
  return (
    <Sheet open onClose={onClose} title={f.id ? "Sửa khuyến mãi" : "Khuyến mãi mới"} footer={
      <div className="stack" style={{ width: "100%" }}>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="row"><Button variant="soft" className="grow" loading={busy} onClick={() => save(false)}>Lưu nháp</Button><Button className="grow" loading={busy} onClick={() => save(true)}>Lưu & gửi duyệt</Button></div>
      </div>}>
      <div className="stack">
        <Input label="Tên chương trình" value={f.name} onChange={(e) => set("name", e.target.value)} />
        <Select label="Loại khuyến mãi" value={k} onChange={(e) => set("kind", e.target.value)}>{Object.entries(KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        {(k === "percent" || k === "end_of_day") && <Input label="Phần trăm giảm (%)" type="number" min={0.01} max={100} step={0.5} value={f.pct} onChange={(e) => set("pct", Number(e.target.value))} />}
        {k === "percent" && <MoneyInput label="Giảm tối đa (₫, bỏ trống = không giới hạn)" value={f.maxDiscount} onChange={(n) => set("maxDiscount", n)} />}
        {k === "amount" && <MoneyInput label="Số tiền giảm (₫)" value={f.valueAmount} onChange={(n) => set("valueAmount", n)} />}
        {k === "fixed_price" && <MoneyInput label="Đơn giá cố định (₫ / đơn vị chính)" value={f.valueAmount} onChange={(n) => set("valueAmount", n)} />}
        {k === "combo" && <MoneyInput label="Giá combo trọn bộ (₫)" value={f.valueAmount} onChange={(n) => set("valueAmount", n)} />}
        {k === "end_of_day" && <div className="grid2"><Input label="Từ giờ" type="time" value={f.dailyStart} onChange={(e) => set("dailyStart", e.target.value)} /><Input label="Đến giờ" type="time" value={f.dailyEnd} onChange={(e) => set("dailyEnd", e.target.value)} /></div>}
        <div className="grid2"><Input label="Bắt đầu" type="date" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} /><Input label="Kết thúc (hết ngày)" type="date" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} /></div>
        <MoneyInput label="Đơn tối thiểu (₫)" value={f.minOrder} onChange={(n) => set("minOrder", n)} />
        <Group label="Kênh áp dụng"><div className="checks">{[["pos", "Tại quầy"], ["online", "Online"], ["b2b", "Sỉ"]].map(([c, l]) => (
          <label key={c}><input type="checkbox" checked={f.channels.includes(c)} onChange={(e) => set("channels", e.target.checked ? [...f.channels, c] : f.channels.filter((x) => x !== c))} />{l}</label>))}</div></Group>
        <Group label={k === "combo" ? "Thành phần combo" : needScope ? "Sản phẩm / nhóm áp dụng" : "Phạm vi (bỏ trống = toàn đơn)"}>
          <div className="stack" style={{ gap: 4 }}>
            {f.items.map((i, idx) => (
              <div className="li" key={idx}>
                <div className="t"><b>{itemLabel({ ...i, qtyMilli: null }, cat)}</b></div>
                {k === "combo" && i.productId && <input className="input num" style={{ width: 80 }} aria-label="Số lượng thành phần" inputMode="decimal" value={(i.qtyMilli ?? 1000) / 1000} onChange={(e) => { const n = Number(e.target.value.replace(",", ".")); setF((x) => ({ ...x, items: x.items.map((y, j) => (j === idx ? { ...y, qtyMilli: Math.max(1, Math.round((n || 0) * 1000)) } : y)) })); }} />}
                <Button size="sm" variant="ghost" aria-label="Bỏ" onClick={() => setF((x) => ({ ...x, items: x.items.filter((_, j) => j !== idx) }))}>✕</Button>
              </div>
            ))}
            <div className="row wrap"><Button size="sm" variant="soft" onClick={() => setPick(true)}>+ Sản phẩm</Button>
              {k !== "combo" && <select className="input" style={{ width: "auto" }} aria-label="Thêm nhóm hàng" value="" onChange={(e) => { const id = Number(e.target.value); if (id) setF((x) => (x.items.some((i) => i.groupId === id) ? x : { ...x, items: [...x.items, { groupId: id }] })); }}>
                <option value="">+ Nhóm hàng…</option>{cat.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
            </div>
          </div>
        </Group>
        <div className="checks">
          <label><input type="checkbox" checked={f.requiresVoucher} onChange={(e) => set("requiresVoucher", e.target.checked)} />Chỉ áp dụng khi nhập voucher</label>
          <label><input type="checkbox" checked={f.stackable} onChange={(e) => set("stackable", e.target.checked)} />Được cộng dồn với khuyến mãi khác</label>
        </div>
        <div className="hint">Mặc định mỗi đơn chỉ áp dụng một khuyến mãi lợi nhất; cộng dồn chỉ có hiệu lực khi cài đặt hệ thống cho phép. Giá bán không bao giờ bị kéo xuống dưới giá vốn.</div>
        <Input label="Độ ưu tiên (số lớn xét trước)" type="number" min={0} max={1000} value={f.priority} onChange={(e) => set("priority", Number(e.target.value))} />
      </div>
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={addItem} />
    </Sheet>
  );
}

// ---------------------------------------------------------------- voucher
function Vouchers({ canWrite }: { canWrite: boolean }) {
  const promos = useAsync(() => get("/promotions").then((r) => items<any>(r).filter((p) => !["ended", "cancelled"].includes(p.status))), []);
  const [pid, setPid] = useState("");
  useEffect(() => { if (!pid && promos.data?.length) setPid(String((promos.data.find((p) => p.requiresVoucher) ?? promos.data[0]).id)); }, [promos.data]); // eslint-disable-line
  const vs = useAsync(() => (pid ? get(`/promotions/${pid}/vouchers`, { limit: 500 }).then((r) => items<any>(r)) : Promise.resolve([])), [pid]);
  const [gen, setGen] = useState({ count: 5, prefix: "", maxUses: 1, perCustomerLimit: 1, unlimited: false });
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string[]>([]);
  const make = async () => {
    setBusy(true);
    try {
      const r = await post(`/promotions/${pid}/vouchers`, { count: gen.count, prefix: gen.prefix.trim().toUpperCase(), ...(gen.unlimited ? {} : { maxUses: gen.maxUses }), perCustomerLimit: gen.perCustomerLimit });
      setFresh(r.codes); toast(`Đã tạo ${r.count} voucher`, "ok"); vs.reload();
    } catch {} finally { setBusy(false); }
  };
  const list = vs.data ?? [];
  const sel = promos.data?.find((p) => String(p.id) === pid);
  return (
    <div className="stack">
      {promos.loading ? <Spinner /> : !promos.data?.length ? <EmptyState title="Chưa có khuyến mãi để tạo voucher" hint="Tạo khuyến mãi (tick “Chỉ áp dụng khi nhập voucher”) trước." /> : (
        <>
          <Select label="Khuyến mãi" value={pid} onChange={(e) => { setPid(e.target.value); setFresh([]); }}>{promos.data.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}{p.requiresVoucher ? "" : " (không bắt buộc voucher)"}</option>)}</Select>
          {sel && !sel.requiresVoucher && <Banner tone="info">Khuyến mãi này tự áp dụng — voucher chỉ cần khi bật “Chỉ áp dụng khi nhập voucher”.</Banner>}
          {canWrite && (
            <Card title="Tạo voucher hàng loạt">
              <div className="stack">
                <div className="grid2"><Input label="Số lượng (1–500)" type="number" min={1} max={500} value={gen.count} onChange={(e) => setGen({ ...gen, count: Number(e.target.value) })} /><Input label="Tiền tố (tối đa 8 ký tự)" maxLength={8} value={gen.prefix} onChange={(e) => setGen({ ...gen, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} /></div>
                <div className="grid2"><Input label="Số lượt dùng / mã" type="number" min={1} disabled={gen.unlimited} value={gen.maxUses} onChange={(e) => setGen({ ...gen, maxUses: Number(e.target.value) })} /><Input label="Lượt tối đa / khách" type="number" min={1} value={gen.perCustomerLimit} onChange={(e) => setGen({ ...gen, perCustomerLimit: Number(e.target.value) })} /></div>
                <label className="row"><input type="checkbox" checked={gen.unlimited} onChange={(e) => setGen({ ...gen, unlimited: e.target.checked })} />Không giới hạn lượt dùng</label>
                <Button loading={busy} disabled={!pid || gen.count < 1} onClick={make}>Tạo voucher</Button>
              </div>
              {fresh.length > 0 && (
                <div className="stack" style={{ marginTop: 12 }}>
                  <b>Mã vừa tạo ({fresh.length})</b>
                  <div className="codebox" data-testid="new-vouchers">{fresh.join("\n")}</div>
                  <BtnRow><Button size="sm" variant="soft" onClick={() => copyText(fresh.join("\n"))}>Sao chép</Button><Button size="sm" variant="soft" onClick={() => downloadCsv(`voucher-${sel?.code ?? pid}.csv`, [["Mã voucher"], ...fresh.map((c) => [c])])}>Tải CSV</Button></BtnRow>
                </div>
              )}
            </Card>
          )}
          <Card title={`Danh sách voucher (${list.length})`} actions={list.length > 0 && <Button size="sm" variant="ghost" onClick={() => downloadCsv(`voucher-${sel?.code ?? pid}-dung.csv`, [["Mã", "Đã dùng", "Tối đa", "Lượt/khách", "Trạng thái"], ...list.map((v) => [v.code, v.usedCount, v.maxUses ?? "không giới hạn", v.perCustomerLimit, v.active ? "hoạt động" : "khoá"])])}>Xuất CSV</Button>}>
            {vs.loading ? <Spinner /> : list.length === 0 ? <div className="muted">Chưa có voucher.</div> : (
              <div>{list.map((v) => (
                <div className="li" key={v.id}>
                  <div className="t"><b style={{ fontFamily: "ui-monospace, monospace" }}>{v.code}</b><span className="small muted">Đã dùng {v.usedCount}/{v.maxUses ?? "∞"}{v.customerId ? " · voucher cá nhân" : ""}</span></div>
                  {v.maxUses != null && v.usedCount >= v.maxUses ? <Badge tone="warn">Hết lượt</Badge> : v.active ? <Badge tone="ok">Dùng được</Badge> : <Badge tone="danger">Khoá</Badge>}
                  <Button size="sm" variant="ghost" aria-label={`Sao chép ${v.code}`} onClick={() => copyText(v.code)}>Chép</Button>
                </div>))}</div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tính thử
function Preview() {
  const [lines, setLines] = useState<{ p: Prod; qty: number }[]>([]);
  const [pick, setPick] = useState(false);
  const [channel, setChannel] = useState("pos");
  const [voucher, setVoucher] = useState("");
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setRes(await post("/promotions/preview", { channel, lines: lines.map((l) => ({ productId: l.p.id, unit: l.p.baseUnit, qty: l.qty })), ...(voucher.trim() ? { voucherCode: voucher.trim() } : {}) })); } catch {} finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Card title="Giỏ hàng thử">
        <div className="stack">
          {lines.map((l, i) => (
            <div className="li" key={l.p.id}>
              <div className="t"><b>{l.p.name}</b><span className="small muted">{money(l.p.price)}/{l.p.baseUnit}</span></div>
              <input className="input num" style={{ width: 80 }} aria-label={`Số lượng ${l.p.name}`} inputMode="decimal" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value.replace(",", ".")) || 0 } : x)))} />
              <Button size="sm" variant="ghost" aria-label="Bỏ" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</Button>
            </div>
          ))}
          <div><Button size="sm" variant="soft" onClick={() => setPick(true)}>+ Thêm sản phẩm</Button></div>
          <div className="grid2"><Select label="Kênh" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="pos">Tại quầy</option><option value="online">Online</option><option value="b2b">Sỉ</option></Select><Input label="Mã voucher" value={voucher} onChange={(e) => setVoucher(e.target.value)} /></div>
          <Button loading={busy} disabled={!lines.length || lines.some((l) => l.qty <= 0)} onClick={run}>Tính giảm giá</Button>
        </div>
      </Card>
      {res && (
        <Card title="Kết quả" className="">
          <div className="totals">
            <div><span className="muted">Tạm tính</span><span className="money">{money(res.subtotal)}</span></div>
            {res.discounts.map((d: any, i: number) => <div key={i}><span>{d.description}</span><span className="money">-{money(d.amount)}</span></div>)}
            <div className="grand"><span>Khách trả</span><span className="money">{money(res.total)}</span></div>
          </div>
          {res.discounts.length === 0 && <div className="muted" style={{ marginTop: 8 }}>Không có khuyến mãi nào áp dụng.</div>}
          {res.rejected.map((r: any, i: number) => <div key={i} className="small" style={{ color: "var(--warn)" }}>• {r.code}: {reasonText(r.reason)}</div>)}
        </Card>
      )}
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={(p) => setLines((ls) => (ls.some((x) => x.p.id === p.id) ? ls : [...ls, { p, qty: 1 }]))} />
    </div>
  );
}

// ---------------------------------------------------------------- tích điểm
function Loyalty({ canAdjust }: { canAdjust: boolean }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<any[] | null>(null);
  const [cu, setCu] = useState<any | null>(null);
  const [info, setInfo] = useState<any | null>(null);
  const [adj, setAdj] = useState({ points: 0, note: "" });
  const [busy, setBusy] = useState(false);
  const search = async () => { try { setFound(await get("/customers", { q: q.trim(), limit: 10 }).then((r) => items<any>(r))); } catch { setFound([]); } };
  const loadInfo = async (c: any) => { setCu(c); setInfo(await get(`/customers/${c.id}/loyalty`)); };
  const doAdjust = async () => {
    setBusy(true);
    try { await post(`/customers/${cu.id}/loyalty/adjust`, { points: adj.points, note: adj.note.trim() }); toast("Đã điều chỉnh điểm", "ok"); setAdj({ points: 0, note: "" }); setInfo(await get(`/customers/${cu.id}/loyalty`)); } catch {} finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Card title="Tra cứu khách hàng">
        <form className="row" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <div className="grow"><Input label="Tên / mã / số điện thoại" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Button type="submit" variant="soft" style={{ alignSelf: "flex-end" }}>Tìm</Button>
        </form>
        {found && (found.length === 0 ? <div className="muted" style={{ marginTop: 8 }}>Không tìm thấy khách.</div> : (
          <div className="stack" style={{ marginTop: 8, gap: 6 }}>{found.map((c) => <button key={c.id} className="dt-card" onClick={() => loadInfo(c)}><div className="ttl">{c.name}</div><div className="small muted">{c.code}{c.phone ? " · " + c.phone : ""}</div></button>)}</div>
        ))}
      </Card>
      {cu && info && (
        <>
          <div className="tiles"><Tile label={cu.name} value={`${info.points.toLocaleString("vi-VN")} điểm`} sub={info.enabled ? `1 điểm = ${money(info.pointValueVnd)}` : "Chương trình tích điểm đang tắt"} tone="ok" /></div>
          {!info.enabled && <Banner>Tích điểm chưa bật (cài đặt <code>loyalty.enabled</code>). Điểm hiện có vẫn xem/điều chỉnh được.</Banner>}
          {canAdjust && (
            <Card title="Điều chỉnh điểm">
              <div className="stack">
                <Input label="Số điểm (+ cộng, − trừ)" type="number" value={adj.points || ""} onChange={(e) => setAdj({ ...adj, points: Math.trunc(Number(e.target.value)) })} />
                <TextArea label="Lý do (bắt buộc)" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} />
                <Button loading={busy} disabled={!adj.points || adj.note.trim().length < 3} onClick={doAdjust}>Lưu điều chỉnh</Button>
              </div>
            </Card>
          )}
          <Card title="Sổ điểm">
            {info.ledger.length === 0 ? <div className="muted">Chưa có giao dịch điểm.</div> : info.ledger.map((l: any) => (
              <div className="li" key={l.id}><div className="t"><b>{{ earn: "Tích điểm", redeem: "Đổi điểm", reverse: "Hoàn / thu hồi", adjust: "Điều chỉnh", expire: "Hết hạn" }[l.kind as string] ?? l.kind}</b><span className="small muted">{when(l.createdAt)}{l.note ? " · " + l.note : ""}</span></div>
                <b className="num" style={{ color: l.points < 0 ? "var(--danger)" : "var(--accent)" }}>{l.points > 0 ? "+" : ""}{l.points}</b></div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
