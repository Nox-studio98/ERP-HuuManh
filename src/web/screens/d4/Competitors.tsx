import { useMemo, useState } from "react";
import { ApiError, get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Field, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, when } from "../../components/ui";
import { toast } from "../../components/toast";
import { ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput } from "../../components/list";
import { fmtDate, fmtDateTime, money, todayVN } from "../../format";
import { useCan } from "../../store";
import { Group, ProductPicker, Tile, diffText, downloadCsv, useCatalog, type Prod } from "./shared";

type Tab = "cmp" | "match" | "src" | "manual" | "alert" | "sug";

export default function Competitors() {
  const can = useCan();
  const w = can("competitors.write");
  const [tab, setTab] = useState<Tab>("cmp");
  const alerts = useAsync(() => get("/price-alerts", { acked: 0 }, { silent: true }).then((r) => items<any>(r).length).catch(() => 0), [tab]);
  return (
    <div className="stack d4">
      <PageHeader subtitle="Theo dõi giá đối thủ, ghép sản phẩm và gợi ý điều chỉnh giá bán" />
      <Segmented className="tabs-d" value={tab} onChange={setTab} options={[
        { v: "cmp", label: "So sánh giá" }, { v: "match", label: "Ghép sản phẩm" }, { v: "src", label: "Nguồn & thu thập" }, { v: "manual", label: "Nhập giá" },
        { v: "alert", label: `Cảnh báo${alerts.data ? ` (${alerts.data})` : ""}` }, { v: "sug", label: "Gợi ý giá" }]} />
      {tab === "cmp" && <Comparison />}
      {tab === "match" && <Matching canWrite={w} />}
      {tab === "src" && <Sources canWrite={w} />}
      {tab === "manual" && <Manual canWrite={w} />}
      {tab === "alert" && <Alerts canWrite={w} />}
      {tab === "sug" && <Suggestions canWrite={w} canPrice={can("prices.write")} />}
    </div>
  );
}

const diffTone = (bp: number | null) => (bp == null ? "flat" : bp > 300 ? "up" : bp < -300 ? "down" : "flat");
const ageDays = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);

// ---------------------------------------------------------------- so sánh
function Comparison() {
  const cat = useCatalog();
  const [groupId, setGroupId] = useState("");
  const [cheaper, setCheaper] = useState(false);
  const [q, setQ] = useState("");
  const cmp = useAsync(() => get("/price-comparison", { groupId, onlyCheaper: cheaper ? 1 : "" }).then((r) => items<any>(r)), [groupId, cheaper]);
  const [open, setOpen] = useState<any | null>(null);
  const rows = (cmp.data ?? []).filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const dearer = rows.filter((r) => (r.diffAvgBp ?? 0) > 300).length;
  const cheaperN = rows.filter((r) => (r.diffAvgBp ?? 0) < -300).length;
  return (
    <div className="stack">
      <KpiRow items={[
        { label: "Mặt hàng có dữ liệu", value: rows.length }, { label: "Ta đắt hơn TB thị trường", value: dearer, tone: dearer ? "danger" : undefined },
        { label: "Ta rẻ hơn TB", value: cheaperN, tone: "ok" }, { label: "Rẻ hơn mức thấp nhất", value: rows.filter((r) => (r.diffMinBp ?? 0) < 0).length },
      ]} />
      <FilterBar dirty={!!(groupId || q || cheaper)} onReset={() => { setGroupId(""); setQ(""); setCheaper(false); }} activeCount={groupId ? 1 : 0}
        advanced={<FilterSelect label="Nhóm hàng" value={groupId} onChange={setGroupId} allLabel="Tất cả nhóm" options={cat.groups.map((g) => ({ v: String(g.id), label: g.name }))} />}>
        <SearchInput value={q} onSearch={setQ} placeholder="Tên sản phẩm…" label="Tìm sản phẩm" />
        <label className="row" style={{ minHeight: 40 }}><input type="checkbox" checked={cheaper} onChange={(e) => setCheaper(e.target.checked)} />Chỉ hiện hàng đối thủ đang bán rẻ hơn ta</label>
        <ExportButton className="fb-end" filename="so-sanh-gia" rows={rows} columns={[
          { label: "Sản phẩm", value: (r) => r.name }, { label: "Giá ta", value: (r) => r.ourPrice }, { label: "Thấp nhất thị trường", value: (r) => r.marketMin }, { label: "Trung bình thị trường", value: (r) => r.marketAvg },
          { label: "Chênh so TB (%)", value: (r) => (r.diffAvgBp == null ? "" : r.diffAvgBp / 100) }, { label: "Cập nhật", value: (r) => fmtDateTime(r.latestObservedAt) },
        ]} />
      </FilterBar>
      {cmp.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(r) => r.productId} onRowClick={setOpen}
          emptyState={<EmptyState title="Chưa có giá đối thủ đã ghép sản phẩm" hint="Dữ liệu trong 7 ngày gần đây. Thêm nguồn thu thập, nhập giá thủ công và duyệt ghép sản phẩm để so sánh." />} cols={[
          { key: "n", label: "Sản phẩm", title: true, sort: (r) => r.name, render: (r) => <b>{r.name}</b> },
          { key: "o", label: "Giá ta", num: true, sort: (r) => r.ourPrice, render: (r) => money(r.ourPrice) },
          { key: "mn", label: "Thấp nhất", num: true, sort: (r) => r.marketMin, render: (r) => <span>{money(r.marketMin)} <span className={"diff " + diffTone(r.diffMinBp)}>{diffText(r.diffMinBp)}</span></span> },
          { key: "av", label: "Trung bình", num: true, sort: (r) => r.marketAvg, render: (r) => <span>{money(r.marketAvg)} <span className={"diff " + diffTone(r.diffAvgBp)}>{diffText(r.diffAvgBp)}</span></span> },
          { key: "d", label: "Cập nhật", sort: (r) => r.latestObservedAt, render: (r) => <span className={ageDays(r.latestObservedAt) >= 3 ? "diff up" : ""}>{fmtDateTime(r.latestObservedAt)}</span> },
        ]} />
      )}
      <div className="hint">Đỏ = giá ta cao hơn thị trường quá 3%, xanh = thấp hơn quá 3%. Chỉ tính quan sát trong 7 ngày và đã duyệt ghép sản phẩm; giá đã quy về đơn vị chính (₫/kg hoặc ₫/trái).</div>
      {open && <HistorySheet row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

const COLORS = ["#1d7f46", "#28607f", "#a4580a", "#8a5cc2", "#b3261e"];
function HistorySheet({ row, onClose }: { row: any; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const h = useAsync(() => get("/competitor-prices/history", { productId: row.productId, days }), [days]);
  return (
    <Sheet open onClose={onClose} title={row.name} wide>
      <div className="stack">
        <div className="chips">{[7, 30, 90].map((d) => <button key={d} className="chip" aria-pressed={days === d} onClick={() => setDays(d)}>{d} ngày</button>)}</div>
        {h.loading ? <Spinner /> : h.data && <HistoryChart data={h.data} />}
        <div>{row.competitors.map((c: any) => (
          <div className="li" key={c.competitorProductId}>
            <div className="t"><b>{c.competitorName}</b><span className="small muted">{c.productName} · {fmtDateTime(c.observedAt)}{c.promoText ? " · " + c.promoText : ""}</span></div>
            <div style={{ textAlign: "right" }}><b className="num">{money(c.unitPrice)}</b>{c.inStock === false && <div><Badge tone="warn">Hết hàng</Badge></div>}</div>
          </div>))}</div>
      </div>
    </Sheet>
  );
}

function HistoryChart({ data }: { data: any }) {
  const series: { name: string; color: string; pts: { t: number; v: number }[] }[] = data.series
    .map((s: any, i: number) => ({ name: s.competitorName, color: COLORS[(i + 1) % COLORS.length], pts: s.points.filter((p: any) => p.unitPrice != null).map((p: any) => ({ t: Date.parse(p.observedAt), v: p.unitPrice })) }))
    .filter((s: any) => s.pts.length);
  const ours = (data.ours ?? []).map((o: any) => ({ t: Date.parse(o.effectiveFrom), v: o.unitPrice }));
  const all = [...series.flatMap((s) => s.pts), ...ours];
  if (!all.length) return <EmptyState title="Chưa có lịch sử giá trong khoảng này" />;
  const W = 560, H = 190, p = { l: 44, r: 12, t: 12, b: 24 };
  const t0 = Math.min(...all.map((x) => x.t)), t1 = Math.max(...all.map((x) => x.t), t0 + 1);
  const vmin = Math.min(...all.map((x) => x.v)), vmax = Math.max(...all.map((x) => x.v));
  const span = vmax - vmin || vmax * 0.1 || 1;
  const X = (t: number) => p.l + ((t - t0) / (t1 - t0)) * (W - p.l - p.r);
  const Y = (v: number) => H - p.b - ((v - (vmin - span * 0.1)) / (span * 1.2)) * (H - p.t - p.b);
  const line = (pts: { t: number; v: number }[], step = false) => pts.map((q, i) => (step && i ? `L${X(q.t)},${Y(pts[i - 1].v)} L${X(q.t)},${Y(q.v)}` : `${i ? "L" : "M"}${X(q.t)},${Y(q.v)}`)).join(" ");
  const k = (n: number) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Biểu đồ lịch sử giá ta và đối thủ">
        {[0, 0.5, 1].map((f) => { const v = vmin - span * 0.1 + f * span * 1.2; return <g key={f}><line className="axis" x1={p.l} x2={W - p.r} y1={Y(v)} y2={Y(v)} /><text x={p.l - 6} y={Y(v) + 4} textAnchor="end">{k(Math.round(v))}</text></g>; })}
        <text x={p.l} y={H - 6}>{new Date(t0).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}</text>
        <text x={W - p.r} y={H - 6} textAnchor="end">{new Date(t1).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}</text>
        {series.map((s) => <g key={s.name}><path className="l1" d={line(s.pts)} stroke={s.color} />{s.pts.map((q, i) => <circle key={i} cx={X(q.t)} cy={Y(q.v)} r={3} fill={s.color}><title>{`${s.name}: ${money(q.v)}`}</title></circle>)}</g>)}
        {ours.length > 0 && <path className="l1" d={line(ours, true)} stroke="var(--text)" strokeDasharray="5 3" />}
      </svg>
      <div className="legend">{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}{ours.length > 0 && <span><i style={{ background: "var(--text)" }} />Giá ta</span>}</div>
    </div>
  );
}

// ---------------------------------------------------------------- ghép sản phẩm
function Matching({ canWrite }: { canWrite: boolean }) {
  const m = useAsync(() => get("/product-matches", { status: "suggested" }).then((r) => items<any>(r)), []);
  const un = useAsync(() => get("/competitor-products", { unmatched: 1, limit: 100 }).then((r) => items<any>(r)), []);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<any | null>(null);
  const [pack, setPack] = useState<any | null>(null);
  const decide = async (id: number, decision: "approved" | "rejected") => {
    try { await post(`/product-matches/${id}/decide`, { decision }); toast(decision === "approved" ? "Đã duyệt ghép" : "Đã từ chối", "ok"); m.reload(); un.reload(); } catch {}
  };
  const suggest = async () => { setBusy(true); try { const r = await post("/product-matches/suggest", {}); toast(r.created ? `Đã tạo ${r.created} gợi ý ghép` : "Không có gợi ý mới", "ok"); m.reload(); } catch {} finally { setBusy(false); } };
  return (
    <div className="stack">
      <Card title={`Hộp thư gợi ý ghép (${m.data?.length ?? 0})`} actions={canWrite && <Button size="sm" variant="soft" loading={busy} onClick={suggest}>Tạo gợi ý</Button>}>
        {m.loading ? <Spinner /> : !m.data?.length ? <div className="muted">Không có gợi ý chờ duyệt.</div> : m.data.map((x) => (
          <div className="li" key={x.id}>
            <div className="t"><b>{x.productName}</b><span className="small muted">↔ {x.competitorProductName} ({x.competitorName}){x.packText ? " · " + x.packText : ""} · giống {Math.round(x.score * (x.score <= 1 ? 100 : 1))}%</span></div>
            {canWrite && <div className="row"><Button size="sm" onClick={() => decide(x.id, "approved")}>Duyệt</Button><Button size="sm" variant="ghost" onClick={() => decide(x.id, "rejected")}>Từ chối</Button></div>}
          </div>))}
      </Card>
      <Card title={`Sản phẩm đối thủ chưa ghép (${un.data?.length ?? 0})`}>
        {un.loading ? <Spinner /> : !un.data?.length ? <div className="muted">Mọi sản phẩm đối thủ đều đã ghép.</div> : un.data.map((x) => (
          <div className="li" key={x.id}>
            <div className="t"><b>{x.name}</b><span className="small muted">{x.competitorName} · {x.packKnown ? x.packText ?? "đã có quy cách" : "chưa rõ quy cách"} · {money(x.lastPrice)}</span></div>
            {canWrite && <div className="row">{!x.packKnown && <Button size="sm" variant="ghost" onClick={() => setPack(x)}>Quy cách</Button>}<Button size="sm" variant="soft" onClick={() => setManual(x)}>Ghép tay</Button></div>}
          </div>))}
      </Card>
      {manual && <ManualMatch cp={manual} onClose={() => setManual(null)} onDone={() => { setManual(null); m.reload(); un.reload(); }} />}
      {pack && <PackForm cp={pack} onClose={() => setPack(null)} onDone={() => { setPack(null); un.reload(); }} />}
    </div>
  );
}
function ManualMatch({ cp, onClose, onDone }: { cp: any; onClose: () => void; onDone: () => void }) {
  const [pick, setPick] = useState(true);
  const go = async (p: Prod) => {
    try { const r = await post("/product-matches", { productId: p.id, competitorProductId: cp.id }); if (r.status !== "approved") await post(`/product-matches/${r.id}/decide`, { decision: "approved" }); toast(`Đã ghép với ${p.name}`, "ok"); onDone(); } catch { onClose(); }
  };
  return <ProductPicker open={pick} onClose={onClose} title={`Ghép “${cp.name}” với…`} onPick={go} />;
}
function PackForm({ cp, onClose, onDone }: { cp: any; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState("1"); const [unit, setUnit] = useState("kg");
  const save = async () => { try { await put(`/competitor-products/${cp.id}`, { packQtyMilli: Math.round(Number(qty.replace(",", ".")) * 1000), packUnit: unit }); toast("Đã cập nhật quy cách", "ok"); onDone(); } catch {} };
  return (
    <Sheet open onClose={onClose} title={`Quy cách: ${cp.name}`} footer={<Button block disabled={!(Number(qty.replace(",", ".")) > 0)} onClick={save}>Lưu quy cách</Button>}>
      <div className="stack"><div className="hint">Số lượng thực tế trong một đơn vị đối thủ bán (vd. khay 500 g = 0,5 kg).</div>
        <div className="grid2"><Input label="Số lượng" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /><Select label="Đơn vị" value={unit} onChange={(e) => setUnit(e.target.value)}><option value="kg">kg</option><option value="trai">trái</option></Select></div></div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- nguồn & thu thập
const RUN: Record<string, { l: string; t?: "ok" | "warn" | "danger" | "info" }> = {
  ok: { l: "Thành công", t: "ok" }, running: { l: "Đang chạy", t: "info" }, blocked: { l: "Bị chặn", t: "danger" }, layout_changed: { l: "Đổi bố cục trang", t: "warn" },
  failed: { l: "Lỗi", t: "danger" }, error: { l: "Lỗi", t: "danger" }, robots_blocked: { l: "robots.txt cấm", t: "warn" }, skipped: { l: "Bỏ qua" }, partial: { l: "Một phần", t: "warn" },
};
const runBadge = (s?: string | null) => (s ? <Badge tone={RUN[s]?.t}>{RUN[s]?.l ?? s}</Badge> : <Badge>Chưa chạy</Badge>);

function Sources({ canWrite }: { canWrite: boolean }) {
  const comps = useAsync(() => get("/competitors").then((r) => items<any>(r)), []);
  const [cid, setCid] = useState<number>(0);
  const cur = cid || comps.data?.[0]?.id || 0;
  const srcs = useAsync(() => (cur ? get(`/competitors/${cur}/sources`).then((r) => items<any>(r)) : Promise.resolve([])), [cur]);
  const [newComp, setNewComp] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [runs, setRuns] = useState<any | null>(null);
  const [busyId, setBusyId] = useState(0);
  const run = async (s: any) => {
    setBusyId(s.id);
    try { const r = await post(`/competitor-sources/${s.id}/run`, {}); toast(`Thu thập: ${RUN[r.status]?.l ?? r.status}${r.items != null ? ` (${r.items} mục)` : ""}`, r.status === "ok" ? "ok" : "info"); srcs.reload(); } catch {} finally { setBusyId(0); }
  };
  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="grow"><Select label="Đối thủ" value={cur} onChange={(e) => setCid(Number(e.target.value))}>{(comps.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
        {canWrite && <Button variant="soft" onClick={() => setNewComp(true)} style={{ alignSelf: "flex-end" }}>+ Đối thủ</Button>}
      </div>
      <Card title="Nguồn dữ liệu" actions={canWrite && cur ? <Button size="sm" onClick={() => setEdit({ kind: "website", parser: "jsonld" })}>+ Nguồn</Button> : undefined}>
        {srcs.loading ? <Spinner /> : !srcs.data?.length ? <div className="muted">Chưa có nguồn.</div> : srcs.data.map((s) => (
          <div className="li" key={s.id} style={{ alignItems: "flex-start" }}>
            <div className="t"><b>{s.kind === "manual" ? "Nhập tay" : s.kind === "marketplace" ? "Sàn TMĐT" : "Website"}{s.parser === "css" ? " · CSS" : s.parser === "jsonld" ? " · JSON-LD" : ""}</b>
              <span className="small muted" style={{ overflowWrap: "anywhere" }}>{s.url ?? "—"}</span>
              <span className="small muted">Mỗi {s.frequencyMinutes} phút · giãn cách {s.minDelayMs} ms · tối đa {s.maxPages} trang · {s.lastRunAt ? "chạy " + fmtDateTime(s.lastRunAt) : "chưa chạy"}{s.consecutiveFailures ? ` · lỗi liên tiếp ${s.consecutiveFailures}` : ""}</span>
              <div className="row wrap" style={{ marginTop: 4 }}>{runBadge(s.lastStatus)}{!s.active && <Badge>Tạm dừng</Badge>}{s.robotsAllowed === false && <Badge tone="warn">robots.txt không cho phép</Badge>}</div></div>
            {s.kind !== "manual" && <div className="stack" style={{ gap: 4 }}>
              {canWrite && <Button size="sm" variant="soft" loading={busyId === s.id} onClick={() => run(s)}>Chạy ngay</Button>}
              <Button size="sm" variant="ghost" onClick={() => setRuns(s)}>Lịch sử</Button>
              {canWrite && <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>Sửa</Button>}
            </div>}
          </div>))}
      </Card>
      <div className="hint">Hệ thống chỉ đọc trang công khai, tuân thủ robots.txt và giãn cách giữa các lần tải; gặp chặn/captcha sẽ dừng và báo (giữ dữ liệu cũ).</div>
      {newComp && <CompetitorForm onClose={() => setNewComp(false)} onDone={(c) => { setNewComp(false); setCid(c.id); comps.reload(); }} />}
      {edit && <SourceForm competitorId={cur} init={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); srcs.reload(); }} />}
      {runs && <RunsSheet src={runs} onClose={() => setRuns(null)} />}
    </div>
  );
}
function CompetitorForm({ onClose, onDone }: { onClose: () => void; onDone: (c: any) => void }) {
  const [f, setF] = useState({ name: "", website: "" });
  return (
    <Sheet open onClose={onClose} title="Đối thủ mới" footer={<Button block disabled={!f.name.trim()} onClick={async () => { try { onDone(await post("/competitors", { name: f.name.trim(), ...(f.website.trim() ? { website: f.website.trim() } : {}) })); } catch {} }}>Thêm</Button>}>
      <div className="stack"><Input label="Tên đối thủ" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input label="Website (nếu có)" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></div>
    </Sheet>
  );
}
function SourceForm({ competitorId, init, onClose, onDone }: { competitorId: number; init: any; onClose: () => void; onDone: () => void }) {
  const cfg0 = init.parserConfig ?? {};
  const [f, setF] = useState({ kind: init.kind ?? "website", url: init.url ?? "", parser: init.parser ?? "jsonld", frequencyMinutes: init.frequencyMinutes ?? 720, minDelayMs: init.minDelayMs ?? 3000, maxPages: init.maxPages ?? 20, active: init.active ?? true,
    itemSelector: cfg0.itemSelector ?? "", nameSelector: cfg0.nameSelector ?? "", priceSelector: cfg0.priceSelector ?? "", linkSelector: cfg0.linkSelector ?? "", packSelector: cfg0.packSelector ?? "", promoSelector: cfg0.promoSelector ?? "", soldOutSelector: cfg0.soldOutSelector ?? "", pageParam: cfg0.pageParam ?? "" });
  const [err, setErr] = useState("");
  const css = f.parser === "css";
  const save = async () => {
    setErr("");
    const body: any = { kind: f.kind, url: f.url.trim(), parser: f.parser, frequencyMinutes: f.frequencyMinutes, minDelayMs: f.minDelayMs, maxPages: f.maxPages, active: f.active };
    if (css) body.parserConfig = Object.fromEntries(["itemSelector", "nameSelector", "priceSelector", "linkSelector", "packSelector", "promoSelector", "soldOutSelector", "pageParam"].map((k) => [k, (f as any)[k].trim()]).filter(([, v]) => v));
    try { init.id ? await put(`/competitor-sources/${init.id}`, body, { silent: true }) : await post(`/competitors/${competitorId}/sources`, body, { silent: true }); toast("Đã lưu nguồn", "ok"); onDone(); } catch (e) { if (e instanceof ApiError) setErr(e.message); }
  };
  const S = (k: keyof typeof f, label: string, hint?: string) => <Input label={label} hint={hint} value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} />;
  return (
    <Sheet open onClose={onClose} title={init.id ? "Sửa nguồn" : "Nguồn mới"} footer={<div className="stack" style={{ width: "100%" }}>{err && <div className="err" role="alert">{err}</div>}<Button block onClick={save}>Lưu nguồn</Button></div>}>
      <div className="stack">
        <Select label="Loại nguồn" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="website">Website</option><option value="marketplace">Sàn thương mại điện tử</option></Select>
        {S("url", "Địa chỉ trang danh sách (https://…)")}
        <Select label="Cách đọc dữ liệu" value={f.parser} onChange={(e) => setF({ ...f, parser: e.target.value })}><option value="jsonld">JSON-LD (schema.org Product/Offer) — mặc định</option><option value="css">Bộ chọn CSS</option></Select>
        {css && (
          <Card title="Bộ chọn CSS">
            <div className="stack">
              {S("itemSelector", "Khung một sản phẩm *", "vd. .product-card")}
              {S("nameSelector", "Tên sản phẩm *", "vd. .product-card .title")}
              {S("priceSelector", "Giá *", "vd. .product-card .price")}
              {S("packSelector", "Quy cách (tuỳ chọn)", "vd. .weight — “500g”, “1kg”")}
              {S("promoSelector", "Khuyến mãi (tuỳ chọn)")}{S("soldOutSelector", "Hết hàng (tuỳ chọn)")}{S("linkSelector", "Liên kết (tuỳ chọn)")}{S("pageParam", "Tham số phân trang (tuỳ chọn)", "vd. page")}
            </div>
          </Card>)}
        <div className="grid3"><Input label="Chu kỳ (phút)" type="number" min={30} value={f.frequencyMinutes} onChange={(e) => setF({ ...f, frequencyMinutes: Number(e.target.value) })} /><Input label="Giãn cách (ms)" type="number" min={500} value={f.minDelayMs} onChange={(e) => setF({ ...f, minDelayMs: Number(e.target.value) })} /><Input label="Số trang tối đa" type="number" min={1} max={50} value={f.maxPages} onChange={(e) => setF({ ...f, maxPages: Number(e.target.value) })} /></div>
        <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Đang hoạt động</label>
      </div>
    </Sheet>
  );
}
function RunsSheet({ src, onClose }: { src: any; onClose: () => void }) {
  const r = useAsync(() => get(`/competitor-sources/${src.id}/runs`).then((x) => items<any>(x)), []);
  return (
    <Sheet open onClose={onClose} title="Lịch sử thu thập">
      {r.loading ? <Spinner /> : !r.data?.length ? <div className="muted">Chưa có lần chạy nào.</div> : r.data.map((x) => (
        <div className="li" key={x.id}><div className="t"><b>{fmtDateTime(x.startedAt)}</b><span className="small muted">{x.pages ?? 0} trang · {x.items ?? 0} mục{x.error ? " · " + x.error : ""}</span></div>{runBadge(x.status)}</div>))}
    </Sheet>
  );
}

// ---------------------------------------------------------------- nhập giá tay / CSV
function Manual({ canWrite }: { canWrite: boolean }) {
  const comps = useAsync(() => get("/competitors").then((r) => items<any>(r)), []);
  const [f, setF] = useState({ competitorId: 0, name: "", qty: "1", unit: "kg", price: 0, inStock: "", observedAt: todayVN(), product: null as Prod | null });
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState("");
  const [res, setRes] = useState<any>(null);
  const cid = f.competitorId || comps.data?.[0]?.id || 0;
  const qtyN = Number(f.qty.replace(",", "."));
  const unitPrice = qtyN > 0 && f.price > 0 ? Math.round(f.price / qtyN) : 0;
  const save = async () => {
    setBusy(true);
    try {
      const r = await post("/competitor-prices/manual", { competitorId: cid, name: f.name.trim(), packText: `${f.qty} ${f.unit}`, packQtyMilli: Math.round(qtyN * 1000), packUnit: f.unit, price: f.price, ...(f.inStock ? { inStock: f.inStock === "1" } : {}), observedAt: f.observedAt, ...(f.product ? { productId: f.product.id } : {}) });
      toast(`Đã ghi giá: ${money(r.unitPrice)}/${f.unit === "kg" ? "kg" : "trái"}`, "ok"); setF({ ...f, name: "", price: 0, product: null });
    } catch {} finally { setBusy(false); }
  };
  const importCsv = async () => {
    setBusy(true);
    try { const r = await post("/competitor-prices/import", { csv }, { silent: true }); setRes(r); toast(`Đã nhập ${r.imported} dòng`, "ok"); } catch (e) { if (e instanceof ApiError) { setRes({ imported: 0, errors: e.details?.errors ?? [{ line: 0, message: e.message }] }); } } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Card title="Nhập một mức giá">
        <div className="stack">
          <Select label="Đối thủ" value={cid} onChange={(e) => setF({ ...f, competitorId: Number(e.target.value) })}>{(comps.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <Input label="Tên hàng của đối thủ" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <div className="grid3"><Input label="Quy cách (số lượng)" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /><Select label="Đơn vị" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}><option value="kg">kg</option><option value="trai">trái</option></Select><MoneyInput label="Giá bán (₫)" value={f.price} onChange={(n) => setF({ ...f, price: n })} /></div>
          {unitPrice > 0 && <div className="small muted">Quy đổi: <b>{money(unitPrice)}</b>/{f.unit === "kg" ? "kg" : "trái"}</div>}
          <div className="grid2"><Input label="Ngày ghi nhận" type="date" max={todayVN()} value={f.observedAt} onChange={(e) => setF({ ...f, observedAt: e.target.value })} /><Select label="Tình trạng" value={f.inStock} onChange={(e) => setF({ ...f, inStock: e.target.value })}><option value="">Không rõ</option><option value="1">Còn hàng</option><option value="0">Hết hàng</option></Select></div>
          <Group label="Ghép với sản phẩm của ta (tuỳ chọn)"><div className="row"><span className="grow">{f.product?.name ?? "Chưa chọn — sẽ nằm trong hộp thư ghép"}</span><Button size="sm" variant="soft" onClick={() => setPick(true)}>Chọn</Button>{f.product && <Button size="sm" variant="ghost" onClick={() => setF({ ...f, product: null })}>✕</Button>}</div></Group>
          <Button loading={busy} disabled={!canWrite || !cid || !f.name.trim() || !(qtyN > 0) || f.price <= 0} onClick={save}>Ghi giá</Button>
          {!canWrite && <div className="hint">Cần quyền ghi dữ liệu đối thủ.</div>}
        </div>
      </Card>
      <Card title="Nhập CSV hàng loạt">
        <div className="stack">
          <div className="hint">Cột: <code>competitor,name,pack_qty,pack_unit,price,in_stock,observed_at,product_sku</code> (tối đa 500 dòng). pack_unit: kg, g hoặc trai.</div>
          <div className="row wrap"><Button size="sm" variant="ghost" onClick={() => downloadCsv("mau-gia-doi-thu.csv", [["competitor", "name", "pack_qty", "pack_unit", "price", "in_stock", "observed_at", "product_sku"], [comps.data?.[0]?.name ?? "Đối thủ A", "Táo Envy 1kg", 1, "kg", 169000, 1, todayVN(), "TAO-ENVY"]])}>Tải file mẫu</Button>
            <label className="btn soft sm" style={{ cursor: "pointer" }}>Chọn file CSV<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const fl = e.target.files?.[0]; if (fl) setCsv(await fl.text()); e.target.value = ""; }} /></label></div>
          <TextArea label="Nội dung CSV" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} />
          <Button loading={busy} disabled={!canWrite || !csv.trim()} onClick={importCsv}>Nhập CSV</Button>
          {res && <div><b>Đã nhập {res.imported} dòng.</b>{res.errors?.map((x: any, i: number) => <div key={i} className="small err">Dòng {x.line}: {x.message}</div>)}</div>}
        </div>
      </Card>
      <ProductPicker open={pick} onClose={() => setPick(false)} onPick={(p) => setF({ ...f, product: p })} />
    </div>
  );
}

// ---------------------------------------------------------------- cảnh báo + giá bất thường
const ALERT: Record<string, string> = { outlier: "Giá bất thường", big_change: "Đổi giá lớn", competitor_cheaper: "Đối thủ rẻ hơn", source_failed: "Nguồn lỗi" };
function Alerts({ canWrite }: { canWrite: boolean }) {
  const al = useAsync(() => get("/price-alerts", { acked: 0 }).then((r) => items<any>(r)), []);
  const out = useAsync(() => (canWrite ? get("/competitor-prices/outliers").then((r) => items<any>(r)) : Promise.resolve([])), []);
  const ack = async (id: number) => { try { await post(`/price-alerts/${id}/ack`, {}); al.reload(); } catch {} };
  const decide = async (id: number, decision: "approved" | "rejected") => { try { await post(`/competitor-prices/${id}/decide`, { decision }); toast(decision === "approved" ? "Đã chấp nhận mức giá" : "Đã loại mức giá", "ok"); out.reload(); } catch {} };
  return (
    <div className="stack">
      <Card title={`Giá bất thường chờ duyệt (${out.data?.length ?? 0})`}>
        {out.loading ? <Spinner /> : !out.data?.length ? <div className="muted">Không có quan sát bất thường.</div> : out.data.map((o) => (
          <div className="li" key={o.obsId}>
            <div className="t"><b>{o.name}</b><span className="small muted">{o.competitorName} · {money(o.unitPrice ?? o.price)} (trung vị {money(o.medianUnitPrice)}{o.deviationBp != null ? `, lệch ${diffText(o.deviationBp)}` : ""}) · {fmtDateTime(o.observedAt)}</span></div>
            <div className="row"><Button size="sm" onClick={() => decide(o.obsId, "approved")}>Chấp nhận</Button><Button size="sm" variant="ghost" onClick={() => decide(o.obsId, "rejected")}>Loại</Button></div>
          </div>))}
        <div className="hint" style={{ marginTop: 6 }}>Quan sát bất thường không được đưa vào bảng so sánh cho tới khi bạn chấp nhận.</div>
      </Card>
      <Card title={`Cảnh báo chưa xử lý (${al.data?.length ?? 0})`}>
        {al.loading ? <Spinner /> : !al.data?.length ? <div className="muted">Không có cảnh báo.</div> : al.data.map((a) => (
          <div className="li" key={a.id}>
            <div className="t"><Badge tone={a.kind === "source_failed" ? "danger" : a.kind === "competitor_cheaper" ? "warn" : "info"}>{ALERT[a.kind] ?? a.kind}</Badge><span style={{ marginTop: 4 }}>{a.message}</span><span className="small muted">{fmtDateTime(a.createdAt)}</span></div>
            {canWrite && <Button size="sm" variant="soft" onClick={() => ack(a.id)}>Đã xem</Button>}
          </div>))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- gợi ý giá
function Suggestions({ canWrite, canPrice }: { canWrite: boolean; canPrice: boolean }) {
  const s = useAsync(() => get("/price-suggestions", { status: "pending" }).then((r) => items<any>(r)), []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const gen = async () => { setBusy(true); try { const r = await post("/price-suggestions/generate", {}); toast(r.created ? `Đã tạo ${r.created} gợi ý giá` : "Giá hiện tại đang hợp lý — không có gợi ý mới", "ok"); s.reload(); } catch {} finally { setBusy(false); } };
  const accept = async (x: any) => {
    try {
      const r = await post(`/price-suggestions/${x.id}/accept`, {}, { silent: true });
      const msg = r.priceStatus === "active" ? `Đã áp dụng giá mới cho ${x.productName}` : `Đã gửi duyệt đổi giá ${x.productName} — chờ quản lý duyệt ở mục “Duyệt”`;
      toast(msg, "ok"); setNote(msg); s.reload();
    } catch (e) { if (e instanceof ApiError) toast(e.code === "below_cost_floor" ? `Giá gợi ý thấp hơn giá sàn ${money(e.details?.floor)} (vốn + biên mục tiêu)` : e.message, "error"); }
  };
  const dismiss = async (id: number) => { try { await post(`/price-suggestions/${id}/dismiss`, {}); s.reload(); } catch {} };
  return (
    <div className="stack">
      <Banner tone="info">Đề xuất chỉ là tham khảo: khi bạn chấp nhận, giá đi qua luồng đổi giá hiện có (có lịch sử giá; nếu bạn không có quyền duyệt giá thì phải chờ quản lý duyệt). Hệ thống không bao giờ tự đổi giá và không đề xuất dưới giá vốn + biên mục tiêu.</Banner>
      {note && <Banner>{note}</Banner>}
      {canWrite && <div><Button loading={busy} onClick={gen}>Tạo gợi ý từ giá thị trường</Button></div>}
      {s.loading ? <Spinner /> : !s.data?.length ? <EmptyState title="Không có gợi ý chờ xử lý" /> : s.data.map((x) => {
        const d = Math.round(((x.suggestedPrice - x.currentPrice) * 10000) / x.currentPrice);
        return (
          <Card key={x.id}>
            <div className="row between"><b>{x.productName}</b><span className={"diff " + (d < 0 ? "down" : "up")}>{diffText(d)}</span></div>
            <div className="totals"><div><span className="muted">Giá hiện tại</span><span className="money">{money(x.currentPrice)}</span></div><div><span className="muted">Giá đề xuất</span><b className="money">{money(x.suggestedPrice)}</b></div><div><span className="muted">Thị trường (thấp nhất / TB)</span><span>{money(x.marketMin)} / {money(x.marketAvg)}</span></div></div>
            <div className="small muted" style={{ margin: "6px 0" }}>{x.reason}</div>
            <div className="row">{canPrice && <Button size="sm" onClick={() => accept(x)}>Chấp nhận</Button>}{canWrite && <Button size="sm" variant="ghost" onClick={() => dismiss(x.id)}>Bỏ qua</Button>}</div>
          </Card>);
      })}
    </div>
  );
}
