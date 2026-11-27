import { useRef, useState } from "react";
import { api, get } from "../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Segmented, Spinner, useAsync } from "../components/ui";
import { KpiRow, PageHeader } from "../components/list";
import { toast } from "../components/toast";
import { downloadHref } from "../format";
import { navigate } from "../router";
import { useCan } from "../store";

type Kind = "products" | "customers" | "suppliers";
const KINDS: { v: Kind; label: string; perm: string; noun: string; to: string; toLabel: string }[] = [
  { v: "products", label: "Hàng hoá", perm: "products.write", noun: "mặt hàng", to: "/products", toLabel: "Xem hàng hoá" },
  { v: "customers", label: "Khách sỉ", perm: "b2b.write", noun: "khách sỉ", to: "/customers", toLabel: "Xem khách sỉ" },
  { v: "suppliers", label: "Nhà cung cấp", perm: "inventory.write", noun: "nhà cung cấp", to: "/suppliers", toLabel: "Xem nhà cung cấp" },
];
type Row = { line: number; status: "create" | "exists" | "error" | "merged"; key: string; label: string; errors: string[]; warnings: string[]; changes: string[] };
type Preview = { filename: string; summary: { lines: number; create: number; exists: number; merged: number; error: number }; ignoredColumns: string[]; rows: Row[] };
type Done = { created: number; updated: number; skipped: number; errors: number };

const STATUS: Record<Row["status"], { label: string; tone?: "ok" | "warn" | "danger" | "info" }> = {
  create: { label: "Tạo mới", tone: "ok" }, exists: { label: "Đã có", tone: "info" }, merged: { label: "Thêm đơn vị", tone: "ok" }, error: { label: "Lỗi", tone: "danger" },
};

export default function Import() {
  const can = useCan();
  const kinds = KINDS.filter((k) => can(k.perm));
  const initial = new URLSearchParams(location.search).get("kind");
  const [kind, setKind] = useState<Kind>((kinds.find((k) => k.v === initial)?.v ?? kinds[0]?.v ?? "products") as Kind);
  if (!kinds.length) return <Card><EmptyState title="Bạn chưa có quyền nhập dữ liệu hàng loạt" hint="Cần quyền tạo hàng hoá, khách sỉ hoặc nhà cung cấp." /></Card>;
  return (
    <div className="stack">
      <PageHeader subtitle="Nạp danh mục từ file Excel / CSV khi bắt đầu dùng hệ thống: tải file mẫu, điền, xem trước rồi mới ghi" />
      {kinds.length > 1 && <Segmented fit value={kind} onChange={setKind} options={kinds.map((k) => ({ v: k.v, label: k.label }))} />}
      <Importer key={kind} kind={kind} />
    </div>
  );
}

function Importer({ kind }: { kind: Kind }) {
  const meta = KINDS.find((k) => k.v === kind)!;
  const guide = useAsync(() => get(`/imports/${kind}`), [kind]);
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [filter, setFilter] = useState<"all" | "error" | "create" | "exists">("all");
  const [done, setDone] = useState<Done | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const send = (step: "preview" | "commit", f: File) => {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("mode", mode);
    return api(`/imports/${kind}/${step}`, { method: "POST", body: fd, raw: step === "preview" });
  };
  const pick = async (f: File | undefined | null) => {
    if (!f) return;
    setFile(f); setPv(null); setDone(null); setFilter("all"); setBusy(true);
    try {
      const r = (await send("preview", f)) as Preview;
      setPv(r);
      setFilter(r.summary.error ? "error" : "all");
      setMode("skip");
    } catch { setFile(null); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const reset = () => { setFile(null); setPv(null); setDone(null); setFilter("all"); };
  const willWrite = pv ? pv.summary.create + (mode === "update" ? pv.summary.exists : 0) : 0;
  const commit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = (await send("commit", file)) as Done;
      setDone(r); setPv(null); toast(`Đã nhập ${r.created + r.updated} ${meta.noun}`, "ok");
    } catch { /* toast đã hiện */ } finally { setBusy(false); }
  };
  const rows = (pv?.rows ?? []).filter((r) => (filter === "all" ? true : filter === "error" ? r.status === "error" : filter === "create" ? r.status === "create" || r.status === "merged" : r.status === "exists"));

  return (
    <div className="stack">
      <div className="imp-grid">
        <Card title="1. Tải file mẫu">
          <div className="stack">
            <div className="small muted">File mẫu có sẵn dòng tiêu đề đúng và vài dòng ví dụ (xoá trước khi tải lên). Dùng Excel (.xlsx) hoặc CSV UTF-8, tối đa {guide.data?.limits?.maxRows ?? 1000} dòng mỗi lần.</div>
            <div className="row wrap">
              <a className="btn soft" href={downloadHref(`/imports/${kind}/template.xlsx`)} download data-testid="imp-template-xlsx">Tải mẫu Excel (.xlsx)</a>
              <a className="btn ghost" href={downloadHref(`/imports/${kind}/template.csv`)} download>Tải mẫu CSV</a>
            </div>
            {guide.loading ? <Spinner /> : (
              <details className="imp-cols" open={!pv && !done}>
                <summary>Các cột trong file ({guide.data?.columns?.length})</summary>
                <ul>
                  {(guide.data?.columns ?? []).map((c: any) => <li key={c.key}><b>{c.header}</b>{c.required && <span className="badge danger" style={{ marginLeft: 6 }}>bắt buộc</span>}<div className="small muted">{c.hint}</div></li>)}
                </ul>
                {(guide.data?.notes ?? []).map((n: string) => <div key={n} className="small muted">• {n}</div>)}
              </details>
            )}
          </div>
        </Card>
        <Card title="2. Chọn file và xem trước">
          <div className="stack">
            <div className={"imp-drop" + (drag ? " drag" : "")} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}>
              <input ref={input} id="imp-file" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => pick(e.target.files?.[0])} data-testid="imp-file" />
              <div style={{ fontWeight: 600 }}>{file ? file.name : "Kéo thả file vào đây hoặc bấm để chọn"}</div>
              <div className="small muted">{file ? `${(file.size / 1024).toFixed(0)} KB` : ".xlsx hoặc .csv (UTF-8) · tối đa 2 MB"}</div>
              <div className="row wrap" style={{ justifyContent: "center", marginTop: 8 }}>
                <Button variant="soft" loading={busy && !pv} onClick={() => input.current?.click()}>{file ? "Chọn file khác" : "Chọn file"}</Button>
                {file && <Button variant="ghost" onClick={reset}>Bỏ file</Button>}
              </div>
            </div>
            <Banner tone="info">Bước này chỉ kiểm tra, chưa ghi gì vào hệ thống. Tồn kho không được nhập ở đây — tồn đầu kỳ nhập qua phiếu nhập kho để có lô, hạn dùng và giá vốn.</Banner>
          </div>
        </Card>
      </div>

      {done && (
        <Card title="Đã nhập xong">
          <div className="stack">
            <KpiRow cols={4} items={[
              { label: "Tạo mới", value: done.created, tone: "ok" },
              { label: "Cập nhật", value: done.updated },
              { label: "Bỏ qua (đã có)", value: done.skipped },
              { label: "Dòng lỗi không ghi", value: done.errors, tone: done.errors ? "warn" : undefined },
            ]} />
            <div className="row wrap"><Button onClick={() => navigate(meta.to)}>{meta.toLabel}</Button><Button variant="soft" onClick={reset}>Nhập file khác</Button></div>
          </div>
        </Card>
      )}

      {pv && (
        <div className="stack">
          <KpiRow items={[
            { label: "Số dòng", value: pv.summary.lines, sub: pv.filename },
            { label: "Tạo mới", value: pv.summary.create, tone: "ok" },
            { label: "Đã có trong hệ thống", value: pv.summary.exists, tone: pv.summary.exists ? "info" : undefined },
            { label: "Dòng lỗi", value: pv.summary.error, tone: pv.summary.error ? "danger" : "ok", sub: pv.summary.error ? "Sẽ không được ghi" : "Không có lỗi" },
          ]} />
          {pv.ignoredColumns.length > 0 && <Banner>Cột không nhận ra, bị bỏ qua: {pv.ignoredColumns.join(", ")}.</Banner>}
          <Card>
            <div className="imp-bar">
              <Segmented fit value={filter} onChange={setFilter} options={[
                { v: "all", label: `Tất cả (${pv.rows.length})` },
                { v: "error", label: `Lỗi (${pv.summary.error})` },
                { v: "create", label: `Tạo mới (${pv.summary.create + pv.summary.merged})` },
                { v: "exists", label: `Đã có (${pv.summary.exists})` },
              ]} />
              {pv.summary.exists > 0 && (
                <div className="imp-mode" role="radiogroup" aria-label="Xử lý dòng trùng mã">
                  <span className="small muted">Dòng đã có trong hệ thống:</span>
                  <Segmented fit value={mode} onChange={setMode} options={[{ v: "skip", label: "Bỏ qua" }, { v: "update", label: "Cập nhật" }]} />
                </div>
              )}
            </div>
          </Card>
          <div className="imp-confirm">
            <div>
              <b>{willWrite > 0 ? `Sẽ ghi ${willWrite} ${meta.noun}` : "Chưa có dòng nào để ghi"}</b>
              <div className="small muted">
                {pv.summary.create} tạo mới{mode === "update" && pv.summary.exists ? `, ${pv.summary.exists} cập nhật` : pv.summary.exists ? `, ${pv.summary.exists} đã có sẽ bỏ qua` : ""}
                {pv.summary.error ? ` · ${pv.summary.error} dòng lỗi sẽ không được ghi` : ""}
              </div>
            </div>
            <div className="row">
              <Button variant="ghost" onClick={reset}>Huỷ</Button>
              <Button size="lg" loading={busy} disabled={willWrite === 0} onClick={commit} data-testid="imp-commit">Xác nhận ghi {willWrite || ""}</Button>
            </div>
          </div>
          <DataTable rows={rows} rowKey={(r) => r.line} pageSize={50} rowClass={(r: Row) => (r.status === "error" ? "bad" : "")}
            emptyState={<EmptyState title="Không có dòng nào trong bộ lọc này" action={<Button variant="soft" onClick={() => setFilter("all")}>Xem tất cả</Button>} />}
            cols={[
              { key: "l", label: "Dòng", num: true, sort: (r: Row) => r.line, render: (r: Row) => <span className="muted">{r.line}</span> },
              { key: "s", label: "Kết quả", sort: (r: Row) => r.status, render: (r: Row) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge> },
              { key: "k", label: "Mã", title: true, sort: (r: Row) => r.key, render: (r: Row) => <b className="nw">{r.key || "(tự sinh)"}</b> },
              { key: "n", label: "Tên", sort: (r: Row) => r.label, render: (r: Row) => r.label || "—" },
              { key: "m", label: "Ghi chú", render: (r: Row) => (
                <div className="imp-notes">
                  {r.errors.map((e, i) => <div key={"e" + i} className="err">{e}</div>)}
                  {r.changes.length > 0 && <div className="small">{mode === "update" ? "Sẽ đổi: " : "Khác file: "}{r.changes.join("; ")}</div>}
                  {r.warnings.map((w, i) => <div key={"w" + i} className="small muted">{w}</div>)}
                  {r.status === "exists" && !r.changes.length && !r.warnings.length && <span className="small muted">Đã có, không có thay đổi rõ</span>}
                </div>
              ) },
            ]} />
        </div>
      )}
    </div>
  );
}
