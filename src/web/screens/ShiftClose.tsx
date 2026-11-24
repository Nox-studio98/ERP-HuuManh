import { useState } from "react";
import { PageHeader } from "../components/list";
import { ApiError, get, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, MoneyInput, Spinner, TextArea, useAsync } from "../components/ui";
import { CHANNELS, METHODS, fmtTime, money, qtyText } from "../format";
import { toast } from "../components/toast";
import { navigate } from "../router";

/** Báo cáo cuối ca (backend salesSummary): byChannel[{channel,orders,revenue}], byMethod[{method,amount}], topProducts[{productId,name,qtyMilli,revenue}] */
type Row = { label: string; value: number; extra?: string };
const rowsOf = (x: any, labelKey: string): Row[] => (Array.isArray(x) ? x.map((r) => ({ label: String(r[labelKey] ?? "—"), value: r.revenue ?? r.amount ?? 0, extra: r.qtyMilli != null ? qtyText(r.qtyMilli) : r.orders != null ? `${r.orders} đơn` : undefined })) : []);

export default function ShiftClose() {
  const cur = useAsync(async () => { try { const r = await get("/shifts/current", undefined, { silent: true }); return r?.shift ?? (r?.id ? r : null); } catch { return null; } }, []);
  const [counted, setCounted] = useState(0), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [srvExpected, setSrvExpected] = useState<number | undefined>();
  if (cur.loading) return <Spinner />;
  const s = cur.data;
  if (report) return <Summary r={report} />;
  if (!s) return <Card><div className="stack"><div>Hiện không có ca nào đang mở.</div><Button onClick={() => navigate("/pos")}>Về bán hàng</Button></div></Card>;
  const expected: number | undefined = srvExpected;
  const diff = expected != null ? counted - expected : undefined;
  const needReason = diff !== undefined ? diff !== 0 : false;
  const close = async () => {
    setBusy(true);
    try {
      const r = await post(`/shifts/${s.id}/close`, { countedCash: counted, ...(reason ? { diffReason: reason } : {}) }, { silent: true });
      toast("Đã chốt ca", "ok"); setReport(r);
    } catch (e) {
      if (e instanceof ApiError) {
        // Server tự tính tiền dự kiến; nếu lệch mà chưa có lý do → 422 diff_reason_required kèm expectedCash.
        if (e.code === "diff_reason_required") { setSrvExpected(e.details?.expectedCash); toast("Có chênh lệch tiền mặt — vui lòng nhập lý do rồi chốt lại.", "error"); }
        else toast(e.message, "error");
      }
    } finally { setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }} className="stack">
      <Card title={`Chốt ca #${s.id}`}>
        <div className="stack">
          <div className="grid2">
            <div className="kpi"><div className="l">Tiền đầu ca</div><div className="v">{money(s.openingCash)}</div></div>
            <div className="kpi"><div className="l">Dự kiến trong két</div><div className="v">{expected != null ? money(expected) : "Tính khi chốt"}</div></div>
          </div>
          <MoneyInput label="Tiền mặt kiểm đếm thực tế (₫)" value={counted} onChange={setCounted} />
          {diff !== undefined && <div className={"banner " + (diff === 0 ? "info" : "")}>{diff === 0 ? "Khớp, không chênh lệch." : `Chênh lệch ${diff > 0 ? "thừa" : "thiếu"} ${money(Math.abs(diff))}`}</div>}
          <TextArea label={needReason ? "Lý do chênh lệch (bắt buộc)" : "Lý do chênh lệch (nếu có)"} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="lg" block loading={busy} disabled={needReason && reason.trim().length < 3} onClick={close}>Chốt ca</Button>
        </div>
      </Card>
    </div>
  );
}

function Summary({ r }: { r: any }) {
  const sh = r.shift ?? r;
  const rep = r.report ?? {};
  const ch = rowsOf(rep.byChannel, "channel"), pm = rowsOf(rep.byMethod, "method"), top = rowsOf(rep.topProducts, "name");
  const diff = sh.diffCash;
  return (
    <div className="stack">
      <PageHeader subtitle="Tổng kết cuối ca" actions={<Button onClick={() => navigate("/pos")}>Xong</Button>} />
      <div className="kpis">
        <div className="kpi"><div className="l">Dự kiến</div><div className="v">{money(sh.expectedCash)}</div></div>
        <div className="kpi"><div className="l">Kiểm đếm</div><div className="v">{money(sh.countedCash)}</div></div>
        <div className="kpi"><div className="l">Chênh lệch</div><div className="v" style={{ color: diff ? "var(--warn)" : undefined }}>{money(diff ?? 0)}</div></div>
        <div className="kpi"><div className="l">Doanh thu</div><div className="v">{money(rep.revenue ?? 0)}</div></div>
      </div>
      <div className="grid3" style={{ alignItems: "start" }}>
        <Card title="Theo kênh"><DataTable rows={ch} rowKey={(x) => x.label} cols={[{ key: "l", label: "Kênh", render: (x) => <>{CHANNELS[x.label] ?? x.label} {x.extra && <Badge>{x.extra}</Badge>}</> }, { key: "v", label: "Doanh thu", right: true, render: (x) => money(x.value) }]} /></Card>
        <Card title="Theo hình thức TT"><DataTable rows={pm} rowKey={(x) => x.label} cols={[{ key: "l", label: "Hình thức", render: (x) => METHODS[x.label] ?? x.label }, { key: "v", label: "Số tiền", right: true, render: (x) => money(x.value) }]} /></Card>
        <Card title="Top 10 bán chạy"><DataTable rows={top} rowKey={(x) => x.label} cols={[{ key: "l", label: "Hàng", render: (x) => <>{x.label} {x.extra && <Badge>{x.extra}</Badge>}</> }, { key: "v", label: "Doanh thu", right: true, render: (x) => money(x.value) }]} /></Card>
      </div>
    </div>
  );
}
export { fmtTime };
