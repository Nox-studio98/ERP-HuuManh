import { useMemo, useState, type ReactNode } from "react";
import { ApiError, get, post, put } from "../api";
import { Badge, Banner, Button, DecInput, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { DetailPanel, PageHeader, SplitLayout } from "../components/list";
import { toast } from "../components/toast";
import { fmtDateTime, money, num } from "../format";
import { useCan } from "../store";

type Opt = { value: string; label: string };
type Item = {
  key: string; label: string; help: string; type: string; unit: string | null; min: number | null; max: number | null; options: Opt[] | null;
  value: string | null; note: string | null; needsConfirm: boolean; confirmed: boolean; confirmedAt: string | null; confirmedByName: string | null; pending: boolean;
};
type Data = { groups: { group: string; items: Item[] }[]; unknown: { key: string; value: string; note: string | null }[]; pendingCount: number; canWrite: boolean };

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const pct = (bp: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(bp / 100)}%`;
const parsePit = (v: string | null): [number | null, number][] => { try { const a = JSON.parse(v ?? "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };

/** Hiển thị giá trị theo kiểu: ₫, %, ngày/giờ/phút, Bật/Tắt... */
export function fmtValue(it: Pick<Item, "type" | "unit" | "options">, v: string | null): ReactNode {
  if (v === null || v === undefined) return <span className="muted">Chưa đặt</span>;
  const n = Number(v);
  switch (it.type) {
    case "vnd": return money(n);
    case "bp": return pct(n);
    case "int": return `${num(n)}${it.unit ? " " + it.unit : ""}`;
    case "bool": return n === 1 ? "Bật" : "Tắt";
    case "enum": return it.options?.find((o) => o.value === v)?.label ?? v;
    case "multi": return v.split(",").map((x) => it.options?.find((o) => o.value === x)?.label ?? x).join(", ");
    case "intlist": return v.split(",").join(" · ") + " ngày";
    case "pit": return `${parsePit(v).length} bậc`;
    default: return v === "" ? <span className="muted">Chưa nhập</span> : v;
  }
}

function PitEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const rows = parsePit(value);
  const set = (r: [number | null, number][]) => onChange(JSON.stringify(r));
  const upd = (i: number, k: 0 | 1, x: number) => set(rows.map((r, j) => (j === i ? (k === 0 ? [x, r[1]] : [r[0], x]) : r)) as [number | null, number][]);
  const add = () => {
    const last = rows[rows.length - 1];
    const prev = rows.length > 1 ? (rows[rows.length - 2][0] ?? 0) : 0;
    const cap = prev + 10_000_000;
    set([...rows.slice(0, -1), [cap, last ? last[1] : 500], [null, last ? last[1] : 500]] as [number | null, number][]);
  };
  return (
    <div className="stack" data-testid="pit-editor">
      <div className="pit-table" role="table" aria-label="Biểu thuế luỹ tiến">
        {rows.map((r, i) => (
          <div className="pit-row" role="row" key={i}>
            <div className="pit-n">Bậc {i + 1}</div>
            {r[0] === null
              ? <div className="pit-cap muted">Trên {money(rows[i - 1]?.[0] ?? 0)} (không có trần)</div>
              : <MoneyInput label={`Bậc ${i + 1}: thu nhập tính thuế tới (₫/tháng)`} value={r[0]} onChange={(n) => upd(i, 0, n)} />}
            <DecInput label={`Bậc ${i + 1}: thuế suất (%)`} value={r[1] / 100} onChange={(p) => upd(i, 1, Math.round(p * 100))} />
            {i < rows.length - 1 && rows.length > 2
              ? <Button variant="ghost" size="sm" aria-label={`Xoá bậc ${i + 1}`} onClick={() => set(rows.filter((_, j) => j !== i))}>Xoá</Button>
              : <span />}
          </div>
        ))}
      </div>
      <div><Button variant="soft" size="sm" onClick={add}>+ Thêm bậc</Button></div>
    </div>
  );
}

function Editor({ it, value, onChange }: { it: Item; value: string; onChange: (v: string) => void }) {
  const n = Number(value);
  const lbl = it.label;
  switch (it.type) {
    case "vnd": return <MoneyInput label={lbl} value={Number.isFinite(n) ? n : 0} onChange={(x) => onChange(String(x))} hint={it.min != null && it.max != null ? `Từ ${money(it.min)} đến ${money(it.max)}` : undefined} />;
    case "bp": return <DecInput label={`${lbl} (%)`} value={Number.isFinite(n) ? n / 100 : 0} onChange={(p) => onChange(String(Math.round(p * 100)))} />;
    case "int": return <Input label={`${lbl}${it.unit ? ` (${it.unit})` : ""}`} type="number" inputMode="numeric" min={it.min ?? undefined} max={it.max ?? undefined} value={value} onChange={(e) => onChange(e.target.value)} />;
    case "bool": return <label className="row" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 22, height: 22 }} checked={value === "1"} onChange={(e) => onChange(e.target.checked ? "1" : "0")} /> {lbl}: {value === "1" ? "Bật" : "Tắt"}</label>;
    case "enum": return <Select label={lbl} value={value} onChange={(e) => onChange(e.target.value)}>{it.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
    case "multi": {
      const sel = new Set(value.split(",").filter(Boolean));
      return (
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
          <legend className="small muted">{lbl}</legend>
          {it.options!.map((o) => (
            <label key={o.value} className="row" style={{ minHeight: 44 }}>
              <input type="checkbox" style={{ width: 22, height: 22 }} checked={sel.has(o.value)} onChange={(e) => { const s = new Set(sel); e.target.checked ? s.add(o.value) : s.delete(o.value); onChange(it.options!.filter((x) => s.has(x.value)).map((x) => x.value).join(",")); }} /> {o.label}
            </label>
          ))}
        </fieldset>
      );
    }
    case "pit": return <PitEditor value={value} onChange={onChange} />;
    default: return <Input label={lbl} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

function Row({ it, canWrite, draft, error, onStage, onConfirm, busy }: { it: Item; canWrite: boolean; draft: string | undefined; error?: string; onStage: (v: string | null) => void; onConfirm: () => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [tmp, setTmp] = useState("");
  const shown = draft ?? it.value;
  const open = () => { setTmp(shown ?? (it.type === "bool" ? "0" : it.type === "pit" ? "[[null,0]]" : "")); setEditing(true); };
  return (
    <div className={"set-row" + (draft !== undefined ? " dirty" : "") + (error ? " bad" : "")} data-key={it.key}>
      <div className="set-main">
        <div className="set-label">
          {it.label}
          {it.pending && <Badge tone="warn">Cần xác nhận</Badge>}
          {it.needsConfirm && it.confirmed && <Badge tone="ok">Đã xác nhận</Badge>}
          {draft !== undefined && <Badge tone="info">Chưa lưu</Badge>}
        </div>
        <div className="small muted">{it.help}</div>
        {it.confirmed && it.confirmedAt && <div className="small muted">Xác nhận bởi {it.confirmedByName ?? "—"} lúc {fmtDateTime(it.confirmedAt)}</div>}
        {error && <div className="err" role="alert">{error}</div>}
      </div>
      {!editing && (
        <div className="set-val">
          <b className="num" data-testid={`val-${it.key}`}>{fmtValue(it, shown)}</b>
          {canWrite && (
            <div className="row wrap" style={{ justifyContent: "flex-end" }}>
              <Button variant="ghost" size="sm" onClick={open} aria-label={`Sửa ${it.label}`}>Sửa</Button>
              {it.pending && draft === undefined && <Button variant="soft" size="sm" loading={busy} onClick={onConfirm} aria-label={`Xác nhận giữ nguyên ${it.label}`}>Xác nhận</Button>}
              {draft !== undefined && <Button variant="ghost" size="sm" onClick={() => onStage(null)}>Bỏ sửa</Button>}
            </div>
          )}
        </div>
      )}
      {editing && (
        <div className="set-edit stack">
          <Editor it={it} value={tmp} onChange={setTmp} />
          <div className="row">
            <Button size="sm" onClick={() => { onStage(tmp === it.value ? null : tmp); setEditing(false); }}>Xong</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Huỷ</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Params() {
  const can = useCan();
  const d = useAsync<Data>(() => get("/settings"), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [onlyPending, setOnlyPending] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set(["Ngưỡng duyệt"]));
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const data = d.data;
  const canWrite = !!data?.canWrite && can("settings.manage");
  const all = useMemo(() => data?.groups.flatMap((g) => g.items) ?? [], [data]);
  if (d.loading && !data) return <Spinner />;
  if (!data) return <Banner tone="danger">Không tải được cài đặt.</Banner>;
  const keys = Object.keys(draft);
  const needle = q.trim().toLowerCase();
  const match = (i: Item) => (!onlyPending || i.pending) && (!needle || (i.label + " " + i.key + " " + i.help).toLowerCase().includes(needle));
  const stage = (key: string, v: string | null) => { setDraft((p) => { const n = { ...p }; if (v === null) delete n[key]; else n[key] = v; return n; }); setErrs((p) => { const n = { ...p }; delete n[key]; return n; }); };
  const toggle = (g: string) => setOpen((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; });
  const save = async () => {
    setBusy("save");
    try {
      const r = await put<Data>("/settings", { settings: draft }, { silent: true });
      d.setData(r); setDraft({}); setErrs({}); setReview(false);
      toast(`Đã lưu ${keys.length} cài đặt`, "ok");
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.details?.fields) {
        const m: Record<string, string> = {};
        for (const k of keys) { const f = e.details.fields[camel(k)] ?? e.details.fields[k]; if (f) m[k] = f; }
        setErrs(m); setReview(false);
        toast("Một số giá trị chưa hợp lệ — xem các dòng báo đỏ", "error");
      } else toast(e instanceof ApiError ? e.message : "Không lưu được", "error");
    } finally { setBusy(null); }
  };
  const confirmOne = async (key: string) => {
    setBusy(key);
    try { const r = await put<Data>("/settings", { settings: {}, confirm: [key] }); d.setData(r); toast("Đã xác nhận", "ok"); } catch {} finally { setBusy(null); }
  };
  const goGroup = (g: string) => {
    setOpen((p) => new Set(p).add(g));
    setTimeout(() => document.getElementById("grp-" + g.replace(/\s+/g, "-"))?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  };
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Nhóm cài đặt">
        {data.groups.map((g) => {
          const pend = g.items.filter((i) => i.pending).length;
          return <button key={g.group} type="button" aria-current={open.has(g.group) ? "true" : undefined} onClick={() => goGroup(g.group)}><span>{g.group}</span>{pend > 0 ? <Badge tone="warn">{pend}</Badge> : <span className="muted small">{g.items.length}</span>}</button>;
        })}
      </nav>
    <div className="stack" style={{ minWidth: 0 }}>
      {!canWrite && <Banner tone="info">Bạn chỉ có quyền xem. Chỉ chủ cửa hàng được thay đổi cài đặt.</Banner>}
      <div className="set-tools">
        <Input label="Tìm cài đặt" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ví dụ: tăng ca, duyệt, thuế…" />
        <label className="row" style={{ minHeight: 44 }}>
          <input type="checkbox" style={{ width: 22, height: 22 }} checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
          Chỉ mục cần xác nhận <Badge tone="warn">{data.pendingCount}</Badge>
        </label>
      </div>
      {data.groups.map((g) => {
        const list = g.items.filter(match);
        if (!list.length) return null;
        const isOpen = onlyPending || !!needle || open.has(g.group);
        const pend = g.items.filter((i) => i.pending).length;
        return (
          <section className="card set-group" key={g.group} id={"grp-" + g.group.replace(/\s+/g, "-")} style={{ scrollMarginTop: 80 }}>
            <button className="set-head" aria-expanded={isOpen} onClick={() => toggle(g.group)}>
              <h2>{g.group}</h2>
              <span className="row">
                {pend > 0 && <Badge tone="warn">{pend} cần xác nhận</Badge>}
                <span className="muted small">{g.items.length} mục</span>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className={isOpen ? "chev up" : "chev"}><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
              </span>
            </button>
            {isOpen && <div className="set-list">{list.map((it) => <Row key={it.key} it={it} canWrite={canWrite} draft={draft[it.key]} error={errs[it.key]} onStage={(v) => stage(it.key, v)} onConfirm={() => confirmOne(it.key)} busy={busy === it.key} />)}</div>}
          </section>
        );
      })}
      {all.length > 0 && onlyPending && data.pendingCount === 0 && <div className="empty">Không còn mục nào cần xác nhận.</div>}
      {data.unknown.length > 0 && !onlyPending && (
        <section className="card">
          <h2>Khoá khác (chỉ đọc)</h2>
          <div className="small muted" style={{ marginBottom: 8 }}>Các khoá chưa có trong danh mục cài đặt; hiển thị thô để đối chiếu.</div>
          {data.unknown.map((u) => <div className="kv-row" key={u.key}><code>{u.key}</code><span className="num">{u.value}</span></div>)}
        </section>
      )}
      {keys.length > 0 && (
        <div className="set-bar" role="region" aria-label="Thay đổi chưa lưu">
          <span><b>{keys.length}</b> thay đổi chưa lưu</span>
          <Button variant="ghost" size="sm" onClick={() => { setDraft({}); setErrs({}); }}>Bỏ hết</Button>
          <Button onClick={() => setReview(true)}>Xem & lưu</Button>
        </div>
      )}
      <Sheet open={review} onClose={() => setReview(false)} title="Xác nhận thay đổi cài đặt"
        footer={<><Button variant="ghost" onClick={() => setReview(false)}>Quay lại</Button><Button block loading={busy === "save"} onClick={save}>Xác nhận lưu {keys.length} thay đổi</Button></>}>
        <div className="stack">
          <Banner tone="info">Thay đổi có hiệu lực ngay và được ghi vào Nhật ký (giá trị trước và sau). Các mục đã sửa được coi là chủ đã xác nhận.</Banner>
          {keys.map((k) => {
            const it = all.find((i) => i.key === k)!;
            return (
              <div className="diff" key={k} data-testid={`diff-${k}`}>
                <div style={{ fontWeight: 600 }}>{it.label}</div>
                <div className="row wrap"><span className="old">{fmtValue(it, it.value)}</span><span aria-hidden="true">→</span><b className="new">{fmtValue(it, draft[k])}</b></div>
                {it.type === "pit" && <div className="small muted">{parsePit(draft[k]).map((r) => `${r[0] === null ? "∞" : money(r[0])}: ${pct(r[1])}`).join(" · ")}</div>}
              </div>
            );
          })}
        </div>
      </Sheet>
    </div>
    </div>
  );
}

// ===================== Khoá sổ =====================

const prevPeriods = (cur: string, n: number) => {
  const [y, m] = cur.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => { const t = y * 12 + m - 1 - (i + 1); return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; });
};

function Periods() {
  const can = useCan();
  const canLock = can("finance.lock_period");
  const p = useAsync<any>(() => get("/periods"), []);
  const [act, setAct] = useState<{ kind: "lock" | "unlock"; period: string } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (p.loading && !p.data) return <Spinner />;
  const cur: string = p.data?.current ?? "";
  const byP = new Map<string, any>((p.data?.items ?? []).map((x: any) => [x.period, x]));
  const periods = [...new Set([...byP.keys(), ...prevPeriods(cur, 12)])].sort().reverse();
  const run = async () => {
    if (!act) return;
    setBusy(true);
    try {
      if (act.kind === "lock") await post(`/periods/${act.period}/lock`);
      else await post(`/periods/${act.period}/unlock`, { reason: reason.trim() });
      toast(act.kind === "lock" ? `Đã khoá sổ kỳ ${act.period}` : `Đã mở khoá kỳ ${act.period}`, "ok");
      setAct(null); setReason(""); p.reload();
    } catch {} finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <Banner tone="info">Khoá sổ chặn thêm/sửa phiếu thu chi vào kỳ đã kết thúc. Chỉ khoá được kỳ đã kết thúc; mở khoá cần chủ cửa hàng nhập lý do và được ghi vào Nhật ký. Khoá bảng công và bảng lương là chức năng riêng, không bị ảnh hưởng.</Banner>
      <div className="card-grid" data-testid="period-list">
        {periods.map((per) => {
          const x = byP.get(per);
          const ended = per < cur;
          return (
            <div className="card flat period-row" key={per} data-period={per}>
              <div>
                <b>Kỳ {per}</b>{" "}
                {x?.locked ? <Badge tone="ok">Đã khoá</Badge> : per === cur ? <Badge tone="info">Kỳ hiện tại</Badge> : per > cur ? <Badge>Chưa tới</Badge> : <Badge tone="warn">Chưa khoá</Badge>}
                {x?.locked && <div className="small muted">Khoá bởi {x.lockedByName ?? "—"} lúc {fmtDateTime(x.lockedAt)}</div>}
              </div>
              {canLock && x?.locked && <Button variant="ghost" size="sm" onClick={() => { setReason(""); setAct({ kind: "unlock", period: per }); }} aria-label={`Mở khoá kỳ ${per}`}>Mở khoá</Button>}
              {canLock && !x?.locked && ended && <Button variant="soft" size="sm" onClick={() => setAct({ kind: "lock", period: per })} aria-label={`Khoá sổ kỳ ${per}`}>Khoá sổ</Button>}
            </div>
          );
        })}
      </div>
      <Sheet open={!!act} onClose={() => setAct(null)} title={act?.kind === "lock" ? `Khoá sổ kỳ ${act?.period}` : `Mở khoá kỳ ${act?.period}`}
        footer={<><Button variant="ghost" onClick={() => setAct(null)}>Huỷ</Button>
          <Button block variant={act?.kind === "unlock" ? "danger" : "primary"} loading={busy} disabled={act?.kind === "unlock" && reason.trim().length < 5} onClick={run}>{act?.kind === "lock" ? "Khoá sổ" : "Mở khoá"}</Button></>}>
        {act?.kind === "lock"
          ? <Banner tone="info">Sau khi khoá, không thêm hoặc sửa phiếu thu chi trong kỳ {act.period}. Muốn điều chỉnh phải lập bút toán ở kỳ hiện tại hoặc mở khoá lại.</Banner>
          : <div className="stack"><Banner>Mở khoá cho phép sửa số liệu của kỳ đã chốt. Lý do được lưu vào Nhật ký.</Banner><TextArea label="Lý do mở khoá (bắt buộc, ít nhất 5 ký tự)" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
      </Sheet>
    </div>
  );
}

// ===================== Nhật ký =====================

const ACTION_VI: Record<string, string> = { "settings.update": "Sửa cài đặt", "settings.confirm": "Xác nhận cài đặt", "period.lock": "Khoá sổ", "period.unlock": "Mở khoá sổ", "user.create": "Tạo người dùng", "user.update": "Sửa người dùng", "user.deactivate": "Khoá người dùng", "approval.approved": "Duyệt", "approval.rejected": "Từ chối duyệt" };
const parseJson = (s: string | null) => { if (s == null) return undefined; try { return JSON.parse(s); } catch { return s; } };
const show = (v: unknown) => (v === undefined || v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const vnStart = (d: string, plus = 0) => new Date(new Date(`${d}T00:00:00+07:00`).getTime() + plus * 86400000).toISOString();

function DiffView({ before, after }: { before: unknown; after: unknown }) {
  if (before === "***" || after === "***") return <div className="banner info">Nội dung nhạy cảm (lương, nhân sự) được ẩn với vai trò của bạn.</div>;
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if ((before === undefined || isObj(before)) && (after === undefined || isObj(after)) && (before !== undefined || after !== undefined)) {
    const b = (before ?? {}) as Record<string, unknown>, a = (after ?? {}) as Record<string, unknown>;
    const ks = [...new Set([...Object.keys(b), ...Object.keys(a)])];
    return (
      <div className="stack" style={{ gap: 6 }} data-testid="audit-diff">
        {ks.map((k) => {
          const ch = JSON.stringify(b[k]) !== JSON.stringify(a[k]);
          return <div className={"diff" + (ch ? "" : " same")} key={k}><code>{k}</code><div className="row wrap"><span className="old">{show(b[k])}</span><span aria-hidden="true">→</span><b className="new">{show(a[k])}</b></div></div>;
        })}
      </div>
    );
  }
  return <div className="stack" data-testid="audit-diff"><div><div className="small muted">Trước</div><pre className="pre">{show(before)}</pre></div><div><div className="small muted">Sau</div><pre className="pre">{show(after)}</pre></div></div>;
}

function AuditLog() {
  const f = useAsync<any>(() => get("/audit/facets"), []);
  const [flt, setFlt] = useState({ userId: "", action: "", entity: "", from: "", to: "" });
  const [rows, setRows] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<any>(null);
  const [n, setN] = useState(0);
  const query = (c?: string | null) => ({ userId: flt.userId, action: flt.action, entity: flt.entity, from: flt.from ? vnStart(flt.from) : "", to: flt.to ? vnStart(flt.to, 1) : "", limit: 30, cursor: c ?? "" });
  const load = async (more = false) => {
    setLoading(true);
    try {
      const r: any = await get("/audit", query(more ? cursor : null));
      setRows(more ? (p) => [...p, ...r.items] : r.items); setCursor(r.nextCursor ?? null);
    } catch {} finally { setLoading(false); }
  };
  useAsync(async () => { await load(false); return null; }, [n]);
  const set = (k: keyof typeof flt) => (e: { target: { value: string } }) => setFlt((p) => ({ ...p, [k]: e.target.value }));
  const fa = f.data;
  return (
    <div className="stack">
      <div className="card flat audit-filters">
        <Select label="Người dùng" value={flt.userId} onChange={set("userId")}><option value="">Tất cả</option>{fa?.users?.map((u: any) => <option key={u.id} value={u.id}>{u.fullName} ({u.username})</option>)}</Select>
        <Select label="Hành động" value={flt.action} onChange={set("action")}><option value="">Tất cả</option>{fa?.actions?.map((a: string) => <option key={a} value={a}>{ACTION_VI[a] ? `${ACTION_VI[a]} — ${a}` : a}</option>)}</Select>
        <Select label="Đối tượng" value={flt.entity} onChange={set("entity")}><option value="">Tất cả</option>{fa?.entities?.map((a: string) => <option key={a} value={a}>{a}</option>)}</Select>
        <Input label="Từ ngày" type="date" value={flt.from} onChange={set("from")} />
        <Input label="Đến ngày" type="date" value={flt.to} onChange={set("to")} />
        <div className="row"><Button onClick={() => setN((x) => x + 1)}>Lọc</Button><Button variant="ghost" onClick={() => { setFlt({ userId: "", action: "", entity: "", from: "", to: "" }); setTimeout(() => setN((x) => x + 1), 0); }}>Xoá lọc</Button></div>
      </div>
      <SplitLayout open={!!sel} panel={sel ? (
        <DetailPanel title={ACTION_VI[sel.action] ?? sel.action} onClose={() => setSel(null)}>
          <div className="stack">
            <div className="small muted">{fmtDateTime(sel.at)} · {sel.username ?? "Hệ thống"} · <code>{sel.action}</code>{sel.entity ? ` · ${sel.entity}${sel.entityId ? " #" + sel.entityId : ""}` : ""}</div>
            {sel.reason && <Banner tone="info">Lý do: {sel.reason}</Banner>}
            <DiffView before={parseJson(sel.beforeJson)} after={parseJson(sel.afterJson)} />
          </div>
        </DetailPanel>) : null}>
      <div className="stack" data-testid="audit-list">
        {rows.map((r) => (
          <button className="audit-row" key={r.id} onClick={() => setSel(r)}>
            <div className="row between"><b>{ACTION_VI[r.action] ?? r.action}</b><span className="small muted">{fmtDateTime(r.at)}</span></div>
            <div className="small muted">{r.username ?? "Hệ thống"} · {r.action}{r.entity ? ` · ${r.entity}${r.entityId ? " #" + r.entityId : ""}` : ""}</div>
            {r.reason && <div className="small">Lý do: {r.reason}</div>}
          </button>
        ))}
        {!rows.length && !loading && <div className="empty">Không có bản ghi nào khớp bộ lọc.</div>}
      </div>
      {loading && <Spinner />}
      {cursor && !loading && <Button variant="ghost" onClick={() => load(true)}>Tải thêm</Button>}
      </SplitLayout>
    </div>
  );
}

export default function Settings() {
  const can = useCan();
  const tabs = [{ v: "params", label: "Tham số" }, ...(can("finance.view") ? [{ v: "periods", label: "Khoá sổ" }] : []), ...(can("audit.view") ? [{ v: "audit", label: "Nhật ký" }] : [])];
  const [tab, setTab] = useState(tabs[0].v);
  return (
    <div className="stack">
      <PageHeader subtitle={tab === "params" ? "Tham số vận hành, ngưỡng duyệt, thuế và lương" : tab === "periods" ? "Khoá sổ kế toán theo kỳ" : "Nhật ký thay đổi dữ liệu"} />
      <Segmented fit value={tab} onChange={setTab} options={tabs} />
      {tab === "params" && <Params />}
      {tab === "periods" && <Periods />}
      {tab === "audit" && <AuditLog />}
    </div>
  );
}
