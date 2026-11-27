import { useRef, useState } from "react";
import { api } from "../api";
import { Badge, Banner, Button, DataTable, EmptyState, Segmented, Sheet } from "../components/ui";
import { KpiRow } from "../components/list";
import { toast } from "../components/toast";
import { downloadHref, unitLabel } from "../format";

type Row = { line: number; status: "ok" | "error" | "skip"; lotCode: string; productName: string; sku: string; unit: string; systemQty: number | null; countedQty: number | null; diffQty: number | null; errors: string[]; warnings: string[] };
type Preview = { filename: string; summary: { lines: number; ok: number; skip: number; error: number; withDiff: number; warned: number }; ignoredColumns: string[]; rows: Row[] };
const STATUS = { ok: { label: "Ghi được", tone: "ok" as const }, error: { label: "Lỗi", tone: "danger" as const }, skip: { label: "Bỏ qua", tone: "info" as const } };
const num = (n: number | null) => (n == null ? "—" : n.toLocaleString("vi-VN", { maximumFractionDigits: 3 }));

/** Nhập kết quả kiểm kho từ Excel/CSV vào phiếu kiểm kê nháp: tải mẫu (danh sách lô) → chọn file → xem trước → xác nhận ghi dòng. Không ghi sổ. */
export default function CountImportSheet({ docId, docCode, onClose, onDone }: { docId: number; docCode: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "error" | "diff">("all");
  const input = useRef<HTMLInputElement>(null);
  const base = `/stock-docs/${docId}/count-import`;

  const send = (step: "preview" | "commit", f: File) => {
    const fd = new FormData();
    fd.append("file", f);
    return api(`${base}/${step}`, { method: "POST", body: fd, raw: true });
  };
  const pick = async (f: File | undefined | null) => {
    if (!f) return;
    setFile(f); setPv(null); setBusy(true);
    try {
      const r = (await send("preview", f)) as Preview;
      setPv(r); setFilter(r.summary.error ? "error" : "all");
    } catch { setFile(null); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const reset = () => { setFile(null); setPv(null); setFilter("all"); };
  const commit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r: any = await send("commit", file);
      toast(`Đã ghi ${r.added + r.overwritten} dòng đếm vào phiếu ${docCode}`, "ok");
      onDone();
    } catch { /* toast đã hiện */ } finally { setBusy(false); }
  };
  const rows = (pv?.rows ?? []).filter((r) => (filter === "all" ? true : filter === "error" ? r.status === "error" : r.status === "ok" && !!r.diffQty));
  const willWrite = pv?.summary.ok ?? 0;

  return (
    <Sheet open onClose={onClose} wide title={`Nhập kết quả kiểm kho · ${docCode}`}>
      <div className="stack">
        <div className="small muted">Tải mẫu (danh sách lô đang tồn tại vị trí này), điền cột Số đếm rồi tải lên. Bước xem trước chưa ghi gì; xác nhận chỉ ghi các dòng đếm vào phiếu — ghi sổ và duyệt chênh lệch làm trên phiếu như bình thường.</div>
        <div className="row wrap">
          <a className="btn soft" href={downloadHref(`${base}/template.xlsx`)} download data-testid="ci-template">Tải mẫu Excel (.xlsx)</a>
          <a className="btn ghost" href={downloadHref(`${base}/template.csv`)} download>Tải mẫu CSV</a>
          <input ref={input} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => pick(e.target.files?.[0])} data-testid="ci-file" />
          <Button variant="soft" loading={busy && !pv} onClick={() => input.current?.click()}>{file ? "Chọn file khác" : "Chọn file kết quả"}</Button>
          {file && <span className="small muted">{file.name}</span>}
        </div>
        <Banner tone="info">Hàng có nhiều lô: ghi rõ Mã lô ở từng dòng (hệ thống không tự chia số đếm giữa các lô). Lô đã có dòng đếm trong phiếu sẽ bị ghi đè.</Banner>

        {pv && (
          <div className="stack">
            <KpiRow items={[
              { label: "Số dòng", value: pv.summary.lines, sub: pv.filename },
              { label: "Ghi được", value: pv.summary.ok, tone: "ok" },
              { label: "Có chênh lệch", value: pv.summary.withDiff, tone: pv.summary.withDiff ? "warn" : undefined },
              { label: "Dòng lỗi", value: pv.summary.error, tone: pv.summary.error ? "danger" : "ok", sub: pv.summary.error ? "Sẽ không được ghi" : "Không có lỗi" },
            ]} />
            {pv.ignoredColumns.length > 0 && <Banner>Cột không nhận ra, bị bỏ qua: {pv.ignoredColumns.join(", ")}.</Banner>}
            <div className="imp-bar">
              <Segmented fit value={filter} onChange={setFilter} options={[
                { v: "all", label: `Tất cả (${pv.rows.length})` },
                { v: "error", label: `Lỗi (${pv.summary.error})` },
                { v: "diff", label: `Chênh lệch (${pv.summary.withDiff})` },
              ]} />
            </div>
            <div className="imp-confirm">
              <div>
                <b>{willWrite ? `Sẽ ghi ${willWrite} dòng đếm vào phiếu` : "Chưa có dòng nào để ghi"}</b>
                <div className="small muted">{pv.summary.skip ? `${pv.summary.skip} dòng chưa đếm bị bỏ qua` : "Phiếu vẫn ở trạng thái nháp"}{pv.summary.error ? ` · ${pv.summary.error} dòng lỗi sẽ không được ghi` : ""}</div>
              </div>
              <div className="row">
                <Button variant="ghost" onClick={reset}>Huỷ</Button>
                <Button size="lg" loading={busy} disabled={!willWrite} onClick={commit} data-testid="ci-commit">Xác nhận ghi {willWrite || ""}</Button>
              </div>
            </div>
            <DataTable rows={rows} rowKey={(r: Row) => r.line} pageSize={50} rowClass={(r: Row) => (r.status === "error" ? "bad" : "")}
              emptyState={<EmptyState title="Không có dòng nào trong bộ lọc này" action={<Button variant="soft" onClick={() => setFilter("all")}>Xem tất cả</Button>} />}
              cols={[
                { key: "l", label: "Dòng", num: true, render: (r: Row) => <span className="muted">{r.line}</span> },
                { key: "s", label: "Kết quả", render: (r: Row) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge> },
                { key: "k", label: "Hàng / lô", title: true, render: (r: Row) => <><b className="nw">{r.lotCode || r.sku || "—"}</b>{r.productName ? <span className="muted"> · {r.productName}</span> : null}</> },
                { key: "sys", label: "Hệ thống", right: true, render: (r: Row) => (r.systemQty == null ? "—" : `${num(r.systemQty)} ${unitLabel(r.unit)}`) },
                { key: "cnt", label: "Đếm", right: true, render: (r: Row) => (r.countedQty == null ? "—" : <b>{num(r.countedQty)} {unitLabel(r.unit)}</b>) },
                { key: "d", label: "Chênh lệch", right: true, render: (r: Row) => (r.diffQty == null ? "—" : <span className={r.diffQty < 0 ? "neg" : undefined}>{r.diffQty > 0 ? "+" : ""}{num(r.diffQty)}</span>) },
                { key: "m", label: "Ghi chú", render: (r: Row) => (
                  <div className="imp-notes">
                    {r.errors.map((e, i) => <div key={"e" + i} className="err">{e}</div>)}
                    {r.warnings.map((w, i) => <div key={"w" + i} className="small muted">{w}</div>)}
                  </div>
                ) },
              ]} />
          </div>
        )}
        {!pv && !busy && <EmptyState title="Chưa chọn file" hint="Chọn file Excel/CSV đã điền số đếm để xem trước kết quả." />}
      </div>
    </Sheet>
  );
}
