import { useState } from "react";
import { ApiError, get, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, MoneyInput, Spinner, TextArea, useAsync } from "../components/ui";
import { CHANNELS, METHODS, fmtTime, money, qtyText } from "../format";
import { toast } from "../components/toast";
import { navigate } from "../router";

const rowsOf = (x: any): { label: string; value: number; extra?: string }[] => {
  if (!x) return [];
  if (Array.isArray(x)) return x.map((r) => ({ label: r.label ?? r.name ?? r.productName ?? r.channel ?? r.method ?? r.key ?? "—", value: r.total ?? r.amount ?? r.revenue ?? r.value ?? 0, extra: r.qtyMilli != null ? qtyText(r.qtyMilli, r.unit ?? "") : undefined }));
  return Object.entries(x).filter(([, v]) => typeof v === "number").map(([k, v]) => ({ label: k, value: v as number }));
};

export default function ShiftClose() {
  const cur = useAsync(async () => { try { const r = await get("/shifts/current", undefined, { silent: true }); return r?.shift ?? (r?.id ? r : null); } catch { return null; } }, []);
  const [counted, setCounted] = useState(0), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>(null);
  if (cur.loading) return <Spinner />;
  const s = cur.data;
  if (report) return <Summary r={report} />;
  if (!s) return <Card><div className="stack"><div>Hiện không có ca nào đang mở.</div><Button onClick={() => navigate("/pos")}>Về bán hàng</Button></div></Card>;
  const expected: number | undefined = s.expectedCash ?? (s.expectedCashSoFar as number | undefined);
  const diff = expected != null ? counted - expected : undefined;
  const needReason = diff !== undefined ? diff !== 0 : false;
  const close = async () => {
    setBusy(true);
    try {
      const r = await post(`/shifts/${s.id}/close`, { countedCash: counted, ...(reason ? { diffReason: reason } : {}) }, { silent: true });
      toast("Đã chốt ca", "ok"); setReport(r);
    } catch (e) {
      if (e instanceof ApiError) toast(e.code === "validation_error" && !reason ? "Có chênh lệch tiền mặt — vui lòng nhập lý do." : e.message, "error");
    } finally { setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }} className="stack">
      <Card title={`Chốt ca #${s.id}`}>
        <div className="stack">
          <div className="grid2">
            <div className="kpi"><div className="l">Tiền đầu ca</div><div className="v">{money(s.openingCash)}</div></div>
            <div className="kpi"><div className="l">Dự kiến trong két</div><div className="v">{expected != null ? money(expected) : "Hệ thống tính khi chốt"}</div></div>
          </div>
          <MoneyInput label="Tiền mặt kiểm đếm thực tế (₫)" value={counted} onChange={setCounted} />
          {diff !== undefined && <div className={"banner " + (diff === 0 ? "info" : "")}>{diff === 0 ? "Khớp, không chênh lệch." : `Chênh lệch ${diff > 0 ? "thừa" : "thiếu"} ${money(Math.abs(diff))}`}</div>}
          <TextArea label={needReason ? "Lý do chênh lệch (bắt buộc)" : "Lý do chênh lệch (nếu có)"} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="lg" block loading={busy} disabled={needReason && !reason.trim()} onClick={close}>Chốt ca</Button>
        </div>
      </Card>
    </div>
  );
}

function Summary({ r }: { r: any }) {
  const sh = r.shift ?? r;
  const rep = r.report ?? r.summary ?? r;
  const ch = rowsOf(rep.byChannel ?? rep.revenueByChannel), pm = rowsOf(rep.byMethod ?? rep.byPaymentMethod ?? rep.payments), top = rowsOf(rep.topProducts ?? rep.top ?? rep.top10);
  const diff = sh.diffCash;
  return (
    <div className="stack">
      <div className="page-head"><h1>Tổng kết cuối ca</h1><Button onClick={() => navigate("/pos")}>Xong</Button></div>
      <div className="kpis">
        <div className="kpi"><div className="l">Dự kiến</div><div className="v">{money(sh.expectedCash)}</div></div>
        <div className="kpi"><div className="l">Kiểm đếm</div><div className="v">{money(sh.countedCash)}</div></div>
        <div className="kpi"><div className="l">Chênh lệch</div><div className="v" style={{ color: diff ? "var(--warn)" : undefined }}>{money(diff ?? 0)}</div></div>
        <div className="kpi"><div className="l">Doanh thu</div><div className="v">{money(rep.revenue ?? rep.total ?? ch.reduce((s, x) => s + x.value, 0))}</div></div>
      </div>
      <div className="grid3" style={{ alignItems: "start" }}>
        <Card title="Theo kênh"><DataTable rows={ch} rowKey={(x) => x.label} cols={[{ key: "l", label: "Kênh", render: (x) => CHANNELS[x.label] ?? x.label }, { key: "v", label: "Doanh thu", right: true, render: (x) => money(x.value) }]} /></Card>
        <Card title="Theo hình thức TT"><DataTable rows={pm} rowKey={(x) => x.label} cols={[{ key: "l", label: "Hình thức", render: (x) => METHODS[x.label] ?? x.label }, { key: "v", label: "Số tiền", right: true, render: (x) => money(x.value) }]} /></Card>
        <Card title="Top 10 bán chạy"><DataTable rows={top} rowKey={(x) => x.label} cols={[{ key: "l", label: "Hàng", render: (x) => <>{x.label} {x.extra && <Badge>{x.extra}</Badge>}</> }, { key: "v", label: "Doanh thu", right: true, render: (x) => money(x.value) }]} /></Card>
      </div>
    </div>
  );
}
export { fmtTime };
