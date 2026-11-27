import { useRef, useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput } from "../../components/list";
import { toast } from "../../components/toast";
import { fmtDateTime } from "../../format";
import { useCan } from "../../store";
import { ProductPicker, unitLabelSafe, type ProductLite } from "./kit";

const JOB_TYPE: Record<string, string> = { "einvoice.issue": "Phát hành HĐĐT", "einvoice.adjust": "HĐĐT điều chỉnh", "einvoice.cancel": "Huỷ HĐĐT", "debt.remind": "Nhắc nợ", "notify.order_status": "Thông báo trạng thái đơn", "notify.staff_new_order": "Báo nhân viên có đơn mới", "notify.email": "Gửi email", "notify.managers": "Thông báo quản lý", "notify.approval": "Thông báo duyệt" };
const REF_TYPE: Record<string, string> = { order: "Đơn hàng", invoice: "Hoá đơn", b2b_order: "Đơn sỉ", customer: "Khách hàng", approval: "Yêu cầu duyệt" };
const refText = (x: any) => (x.refType ? `${REF_TYPE[x.refType] ?? x.refType} ${x.refId ?? ""}`.trim() : "—");
const JOB_ST: Record<string, string> = { queued: "Đang chờ", running: "Đang chạy", done: "Hoàn tất", failed: "Lỗi", dead: "Dừng" };
const jobTone = (s: string) => ({ done: "ok", failed: "danger", dead: "danger", queued: "info", running: "info" } as any)[s];

export default function Integrations() {
  const [tab, setTab] = useState<"jobs" | "settings" | "sku" | "import">("jobs");
  return (
    <div className="stack">
      <PageHeader subtitle="Hoá đơn điện tử, sàn Fresco và hàng đợi tác vụ nền" />
      <Segmented fit value={tab} onChange={setTab} options={[{ v: "jobs", label: "Tác vụ" }, { v: "settings", label: "Cài đặt" }, { v: "sku", label: "SKU Fresco" }, { v: "import", label: "Nhập đơn" }]} />
      {tab === "jobs" && <Jobs />}
      {tab === "settings" && <Settings />}
      {tab === "sku" && <Sku />}
      {tab === "import" && <ImportOrders />}
    </div>
  );
}

function Jobs() {
  const [status, setStatus] = useState(""), [q, setQ] = useState("");
  const j = useAsync(() => get("/integrations/jobs", { status, limit: 100 }).then((r) => items<any>(r)), [status]);
  const [busy, setBusy] = useState<number | null>(null);
  const term = q.trim().toLowerCase();
  const all = j.data ?? [];
  const rows = all.filter((x) => !term || `${JOB_TYPE[x.type] ?? x.type} ${x.refType ?? ""} ${x.refId ?? ""} ${x.lastError ?? ""}`.toLowerCase().includes(term));
  const n = (st: string[]) => all.filter((x) => st.includes(x.status)).length;
  return (
    <div className="stack">
      <FilterBar dirty={!!(status || q)} onReset={() => { setStatus(""); setQ(""); }}>
        <SearchInput value={q} onSearch={setQ} placeholder="Loại tác vụ, đối tượng, lỗi…" label="Tìm tác vụ" />
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={Object.entries(JOB_ST).map(([v, label]) => ({ v, label }))} />
        <span style={{ marginLeft: "auto" }} className="row"><ExportButton filename="tac-vu-nen" rows={rows} columns={[{ label: "#", value: (x) => x.id }, { label: "Loại", value: (x) => JOB_TYPE[x.type] ?? x.type }, { label: "Đối tượng", value: (x) => (x.refType ? refText(x) : "") }, { label: "Trạng thái", value: (x) => JOB_ST[x.status] ?? x.status }, { label: "Lần thử", value: (x) => x.attempts }, { label: "Lỗi", value: (x) => x.lastError }]} /><Button variant="ghost" size="sm" onClick={j.reload}>Làm mới</Button></span>
      </FilterBar>
      {!j.loading && <KpiRow items={[{ label: "Tác vụ", value: all.length }, { label: "Đang chờ / chạy", value: n(["queued", "running"]), tone: "info" }, { label: "Hoàn tất", value: n(["done"]), tone: "ok" }, { label: "Lỗi / dừng", value: n(["failed", "dead"]), tone: n(["failed", "dead"]) ? "danger" : undefined, onClick: () => setStatus("failed") }]} />}
      {j.loading ? <Spinner /> : <DataTable rows={rows} rowKey={(x) => x.id} pageSize={50} defaultSort={{ key: "i", dir: "desc" }} emptyState={<EmptyState title="Không có tác vụ nào" hint="Tác vụ nền (phát hành HĐĐT, nhắc nợ…) sẽ hiện ở đây." action={status || q ? <Button variant="soft" onClick={() => { setStatus(""); setQ(""); }}>Xoá lọc</Button> : undefined} />} cols={[
        { key: "i", label: "#", title: true, sort: (x) => x.id, render: (x) => <b className="nw">#{x.id} · {JOB_TYPE[x.type] ?? x.type}</b> },
        { key: "r", label: "Đối tượng", render: (x) => refText(x) },
        { key: "s", label: "Trạng thái", sort: (x) => x.status, render: (x) => <Badge tone={jobTone(x.status)}>{JOB_ST[x.status] ?? x.status}</Badge> },
        { key: "a", label: "Lần thử", num: true, hideMobile: true, sort: (x) => x.attempts, render: (x) => x.attempts },
        { key: "e", label: "Lỗi gần nhất", render: (x) => (x.lastError ? <span className="small" style={{ color: "var(--danger)" }}>{String(x.lastError).slice(0, 100)}</span> : "—") },
        { key: "u", label: "Cập nhật", hideMobile: true, sort: (x) => x.updatedAt, render: (x) => <span className="nw">{fmtDateTime(x.updatedAt)}</span> },
        { key: "b", label: "", render: (x) => (["failed", "dead"].includes(x.status) ? <Button size="sm" loading={busy === x.id} onClick={async () => { setBusy(x.id); try { await post(`/integrations/jobs/${x.id}/retry`); toast("Đã xếp chạy lại", "ok"); j.reload(); } catch {} finally { setBusy(null); } }}>Chạy lại</Button> : null) },
      ]} />}
    </div>
  );
}

function Settings() {
  const s = useAsync(() => get("/integrations/settings"), []);
  const [busy, setBusy] = useState(false);
  const d = s.data;
  const save = async (patch: any) => { setBusy(true); try { await put("/integrations/settings", patch); toast("Đã lưu cài đặt", "ok"); s.reload(); } catch {} finally { setBusy(false); } };
  if (s.loading && !d) return <Spinner />;
  if (!d) return null;
  return (
    <div className="card-grid" style={{ alignItems: "start" }}>
      <Card title="Fresco (sàn bán hàng)">
        <div className="stack">
          <label className="row between" style={{ minHeight: 44 }}><span>Bật nhận đơn từ Fresco</span><input type="checkbox" role="switch" style={{ width: 26, height: 26 }} checked={d.frescoEnabled} disabled={busy} onChange={(e) => save({ frescoEnabled: e.target.checked })} /></label>
          <div className="row between"><span className="muted">Khoá bí mật webhook</span>{d.frescoWebhookConfigured ? <Badge tone="ok">Đã cấu hình</Badge> : <Badge tone="warn">Chưa cấu hình</Badge>}</div>
        </div>
      </Card>
      <Card title="Hoá đơn điện tử">
        <div className="stack">
          <Select label="Nhà cung cấp HĐĐT" value={d.einvoiceProvider} disabled={busy} onChange={(e) => save({ einvoiceProvider: e.target.value })}>
            <option value="fake">Giả lập (thử nghiệm — số HĐ bắt đầu TEST-)</option><option value="misa" disabled={!d.misaConfigured}>MISA meInvoice{d.misaConfigured ? "" : " (chưa cấu hình)"}</option>
          </Select>
          <div className="row between"><span className="muted">Thông tin kết nối MISA</span>{d.misaConfigured ? <Badge tone="ok">Đã cấu hình</Badge> : <Badge tone="warn">Chưa cấu hình</Badge>}</div>
          {!d.misaConfigured && <div className="hint">Thông tin MISA đặt trong secrets của hệ thống, không nhập trên giao diện.</div>}
          <label className="row between" style={{ minHeight: 44 }}><span>Tự phát hành HĐĐT khi giao hàng sỉ</span><input type="checkbox" role="switch" style={{ width: 26, height: 26 }} checked={d.einvoiceAutoIssueB2b} disabled={busy} onChange={(e) => save({ einvoiceAutoIssueB2b: e.target.checked })} /></label>
        </div>
      </Card>
      <Card title="Nhắc nợ"><div style={{ maxWidth: 220 }}><Input label="Nhắc trước hạn (ngày)" inputMode="numeric" defaultValue={String(d.remindDaysBeforeDue)} onBlur={(e) => { const n = parseInt(e.target.value); if (Number.isFinite(n) && n !== d.remindDaysBeforeDue) save({ remindDaysBeforeDue: Math.max(0, Math.min(60, n)) }); }} /></div></Card>
    </div>
  );
}

function Sku() {
  const m = useAsync(() => get("/fresco/products").then((r) => items<any>(r)), []);
  const [pick, setPick] = useState(false), [prod, setProd] = useState<ProductLite | null>(null), [sku, setSku] = useState(""), [unit, setUnit] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await put("/fresco/products", { mappings: [{ externalSku: sku.trim(), productId: prod!.id, unit: unit || prod!.baseUnit }] }); toast("Đã lưu ghép SKU", "ok"); setProd(null); setSku(""); m.reload(); } catch {} finally { setBusy(false); }
  };
  return (
    <div className="two-col">
      <div className="card flat stack">
        <b>Ghép SKU sàn với hàng hoá</b>
        <Input label="SKU trên sàn" value={sku} onChange={(e) => setSku(e.target.value)} />
        <div className="row wrap"><Button variant="soft" onClick={() => setPick(true)}>{prod ? `Hàng: ${prod.name}` : "Chọn hàng hoá…"}</Button>
          {prod && <Select label="Đơn vị" value={unit || prod.baseUnit} onChange={(e) => setUnit(e.target.value)}>{(prod.units?.length ? prod.units : [{ unit: prod.baseUnit, factorMilli: 1000 }]).map((u) => <option key={u.unit} value={u.unit}>{unitLabelSafe(u.unit)}</option>)}</Select>}</div>
        <div><Button loading={busy} disabled={!sku.trim() || !prod} onClick={save}>Lưu ghép</Button></div>
      </div>
      <div style={{ minWidth: 0 }}>{m.loading ? <Spinner /> : <DataTable rows={m.data ?? []} rowKey={(x) => x.externalSku} empty="Chưa ghép SKU nào" cols={[
        { key: "s", label: "SKU sàn", title: true, render: (x) => <b>{x.externalSku}</b> },
        { key: "p", label: "Hàng hoá", render: (x) => `${x.productName} (${x.productSku})` },
        { key: "u", label: "Đơn vị", render: (x) => unitLabelSafe(x.unit) },
        { key: "r", label: "", render: (x) => <Button size="sm" variant="ghost" onClick={async () => { try { await put("/fresco/products", { remove: [x.externalSku] }); m.reload(); } catch {} }}>Xoá</Button> },
      ]} />}</div>
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={(p) => { setProd(p); setUnit(""); }} />
    </div>
  );
}

function ImportOrders() {
  const can = useCan();
  const [csv, setCsv] = useState(""), [busy, setBusy] = useState(false), [res, setRes] = useState<any>(null);
  const file = useRef<HTMLInputElement>(null);
  if (!can("orders.online.manage")) return <Banner>Cần quyền quản lý đơn online để nhập đơn.</Banner>;
  return (
    <div className="two-col">
      <div className="stack">
      <div className="hint">Cột giả định: <code>order_id, created_at, sku, qty, unit_price, shipping_fee, buyer_name</code>. SKU chưa ghép sẽ tạo đơn ở trạng thái mới kèm cảnh báo, không giữ tồn.</div>
      <TextArea label="Dán CSV đơn từ sàn" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} style={{ fontFamily: "ui-monospace, monospace" } as any} />
      <div className="row wrap">
        <input ref={file} type="file" accept=".csv,text/csv,text/plain" hidden aria-label="Chọn tệp CSV" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); e.target.value = ""; }} />
        <Button variant="ghost" onClick={() => file.current?.click()}>Chọn tệp CSV…</Button>
        <Button loading={busy} disabled={!csv.trim()} onClick={async () => { setBusy(true); setRes(null); try { const r = await post("/fresco/orders/import", { csv }); setRes(r); toast(`Đã nhập ${r.imported} đơn`, "ok"); } catch {} finally { setBusy(false); } }}>Nhập đơn</Button>
      </div>
      </div>
      {res ? (
        <div className="stack">
          <Banner tone="info">Nhập thành công {res.imported} đơn · {res.items.length - res.imported} bỏ qua / lỗi · {res.errors?.length ?? 0} dòng CSV lỗi.</Banner>
          <DataTable rows={res.items} rowKey={(x: any) => x.externalId} cols={[
            { key: "e", label: "Mã sàn", title: true, render: (x: any) => <b>{x.externalId}</b> },
            { key: "s", label: "Kết quả", render: (x: any) => (x.error ? <Badge tone="danger">{x.error}</Badge> : x.duplicate ? <Badge>Đã có</Badge> : <Badge tone="ok">Đã tạo{x.status ? ` · ${x.status}` : ""}</Badge>) },
          ]} />
          {(res.errors ?? []).map((e: any, i: number) => <div key={i} className="err">{typeof e === "string" ? e : JSON.stringify(e)}</div>)}
        </div>
      ) : <Card><EmptyState title="Kết quả nhập sẽ hiện ở đây" hint="Dán CSV hoặc chọn tệp rồi bấm “Nhập đơn”." /></Card>}
    </div>
  );
}
export { Sheet };
