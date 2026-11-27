import { useState } from "react";
import { PageHeader } from "../components/list";
import { ApiError, get, post } from "../api";
import { Badge, Banner, Button, Card, DataTable, MoneyInput, Spinner, TextArea, useAsync } from "../components/ui";
import { CHANNELS, METHODS, fmtDateTime, fmtTime, money, qtyText } from "../format";
import { toast } from "../components/toast";
import { navigate } from "../router";
import { syncQueue, useQueue } from "../offline";
import { PayTable } from "../components/pay-breakdown";
import { PrintButtons, usePrintDoc } from "../components/report-print";
import { ShiftHandoverDoc } from "../components/shift-detail";

/** Báo cáo cuối ca (backend salesSummary): byChannel[{channel,orders,revenue}], byMethod[{method,amount}], topProducts[{productId,name,qtyMilli,revenue}] */
type Row = { label: string; value: number; extra?: string };
const rowsOf = (x: any, labelKey: string): Row[] => (Array.isArray(x) ? x.map((r) => ({ label: String(r[labelKey] ?? "—"), value: r.revenue ?? r.amount ?? 0, extra: r.qtyMilli != null ? qtyText(r.qtyMilli) : r.orders != null ? `${r.orders} đơn` : undefined })) : []);

export default function ShiftClose() {
  const queue = useQueue(); // A-09: còn đơn offline chưa đồng bộ thì chưa được chốt ca
  const cur = useAsync(async () => { try { const r = await get("/shifts/current", undefined, { silent: true }); return r?.shift ?? (r?.id ? r : null); } catch { return null; } }, []);
  const [counted, setCounted] = useState(0), [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [srvExpected, setSrvExpected] = useState<number | undefined>();
  // Tổng kết theo hình thức thanh toán ngay trên màn chốt ca để đối chiếu máy POS thẻ / sao kê chuyển khoản
  const sum = useAsync(async () => (cur.data?.id ? get(`/shifts/${cur.data.id}/summary`, undefined, { silent: true }).catch(() => null) : null), [cur.data?.id]);
  if (cur.loading) return <Spinner />;
  const s = cur.data;
  if (report) return <Summary r={report} />;
  if (!s) return <NoShift />;
  const expected: number | undefined = srvExpected;
  const diff = expected != null ? counted - expected : undefined;
  const needReason = diff !== undefined ? diff !== 0 : false;
  const close = async () => {
    setBusy(true);
    try {
      const r = await post(`/shifts/${s.id}/close`, { countedCash: counted, ...(reason ? { diffReason: reason } : {}) }, { silent: true });
      toast("Đã chốt ca", "ok"); setReport(r); window.dispatchEvent(new Event("hm:shift"));
    } catch (e) {
      if (e instanceof ApiError) {
        // Server tự tính tiền dự kiến; nếu lệch mà chưa có lý do → 422 diff_reason_required kèm expectedCash.
        if (e.code === "diff_reason_required") { setSrvExpected(e.details?.expectedCash); toast("Có chênh lệch tiền mặt — vui lòng nhập lý do rồi chốt lại.", "error"); }
        else toast(e.message, "error");
      }
    } finally { setBusy(false); }
  };
  return (
    <div className="hero-panel" style={{ maxWidth: 980 }}>
     <div className="hero-grid">
      <Card title={`Chốt ca #${s.id}`} className="hero-main">
        <div className="stack">
          <div className="grid2">
            <div className="kpi"><div className="l">Tiền đầu ca</div><div className="v">{money(s.openingCash)}</div></div>
            <div className="kpi"><div className="l">Dự kiến trong két</div><div className="v">{expected != null ? money(expected) : sum.data ? money(sum.data.cashFormula.expected) : "Tính khi chốt"}</div></div>
          </div>
          {queue.length > 0 && (
            <Banner tone="danger">
              Còn {queue.length} đơn bán offline chưa đồng bộ — phải đồng bộ xong mới chốt ca, nếu không tiền mặt của các đơn này sẽ lệch.{" "}
              <Button size="sm" variant="soft" onClick={() => syncQueue(true)}>Đồng bộ ngay</Button>
            </Banner>
          )}
          <MoneyInput label="Tiền mặt kiểm đếm thực tế (₫)" value={counted} onChange={setCounted} />
          {diff !== undefined && <div className={"banner " + (diff === 0 ? "info" : "")}>{diff === 0 ? "Khớp, không chênh lệch." : `Chênh lệch ${diff > 0 ? "thừa" : "thiếu"} ${money(Math.abs(diff))}`}</div>}
          <TextArea label={needReason ? "Lý do chênh lệch (bắt buộc)" : "Lý do chênh lệch (nếu có)"} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="lg" block loading={busy} disabled={queue.length > 0 || (needReason && reason.trim().length < 3)} onClick={close}>Chốt ca</Button>
        </div>
      </Card>
      <Card title="Thông tin ca">
        <div className="stack">
          <div className="kv-row"><span className="muted">Mở lúc</span><b>{fmtDateTime(s.openedAt)}</b></div>
          <div className="kv-row"><span className="muted">Tiền đầu ca</span><b className="money">{money(s.openingCash)}</b></div>
          {sum.data?.cashFormula && (
            <>
              <div className="kv-row"><span className="muted">+ Thu tiền mặt bán hàng</span><span className="num">{money(sum.data.cashFormula.cashSold)}</span></div>
              {sum.data.cashFormula.cashRefunded > 0 && <div className="kv-row"><span className="muted">− Hoàn tiền mặt trả hàng</span><span className="num">{money(sum.data.cashFormula.cashRefunded)}</span></div>}
              {sum.data.cashFormula.deposits !== 0 && <div className="kv-row"><span className="muted">± Cọc đặt trước</span><span className="num">{money(sum.data.cashFormula.deposits)}</span></div>}
              <div className="kv-row" data-testid="shift-debt-collected"><span className="muted">+ Thu nợ khách lẻ bằng tiền mặt</span><span className="num">{money(sum.data.cashFormula.debtCollected ?? 0)}</span></div>
              {sum.data.cashFormula.voidRefunds > 0 && <div className="kv-row"><span className="muted">− Hoàn tiền mặt khi huỷ đơn</span><span className="num">{money(sum.data.cashFormula.voidRefunds)}</span></div>}
            </>
          )}
          <div className="hint">Hệ thống tự tính tiền dự kiến trong két từ các đơn tiền mặt của ca. Đếm tiền thực tế rồi nhập vào ô bên cạnh; nếu lệch cần ghi lý do.</div>
        </div>
      </Card>

     </div>
      {sum.data && (
        <div style={{ marginTop: "var(--s-4)" }}>
          <Card title="Bán theo hình thức thanh toán (tính đến lúc này)">
            <PayTable rows={sum.data.byPayment} />
            <div className="hint">Đối chiếu số thẻ với máy POS thẻ, số chuyển khoản với sao kê. Chỉ tiền mặt được đếm trong két.</div>
          </Card>
        </div>
      )}
    </div>
  );
}

function NoShift() {
  const last = useAsync(async () => { try { return (await get("/shifts/last", undefined, { silent: true }))?.shift ?? null; } catch { return null; } }, []);
  const l = last.data;
  return (
    <div className="hero-panel" style={{ maxWidth: 760 }}>
      <Card>
        <div className="stack" style={{ padding: "var(--s-3)" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Hiện không có ca nào đang mở</h2>
            <div className="muted">Mở ca ở màn Bán hàng để bắt đầu bán; khi kết thúc quay lại đây để chốt ca và đối chiếu tiền mặt.</div>
          </div>
          <div className="row wrap"><Button onClick={() => navigate("/pos")}>Mở ca bán hàng</Button><Button variant="ghost" onClick={() => navigate("/orders")}>Xem đơn hàng</Button></div>
          {last.loading ? null : l && (
            <div className="stack">
              <hr style={{ border: 0, borderTop: "1px solid var(--border)", width: "100%" }} />
              <div className="muted small">Ca gần nhất — #{l.id} · chốt lúc {fmtDateTime(l.closedAt)}</div>
              <div className="kpis">
                <div className="kpi"><div className="l">Doanh thu</div><div className="v">{money(l.revenue)}</div><div className="s small muted">{l.orderCount} đơn</div></div>
                <div className="kpi"><div className="l">Kiểm đếm</div><div className="v">{money(l.countedCash)}</div><div className="s small muted">dự kiến {money(l.expectedCash)}</div></div>
                <div className="kpi"><div className="l">Chênh lệch</div><div className="v" style={{ color: l.diffCash ? "var(--warn)" : undefined }}>{money(l.diffCash ?? 0)}</div></div>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Summary({ r }: { r: any }) {
  const { paper, print } = usePrintDoc();
  const hand = useAsync(async () => (r.shift?.id ? get(`/shifts/${r.shift.id}/summary`, undefined, { silent: true }).catch(() => null) : null), [r.shift?.id]);
  const sh = r.shift ?? r;
  const rep = r.report ?? {};
  const ch = rowsOf(rep.byChannel, "channel"), pm = rowsOf(rep.byMethod, "method"), top = rowsOf(rep.topProducts, "name");
  const diff = sh.diffCash;
  return (
    <div className="stack">
      <PageHeader subtitle="Tổng kết cuối ca" actions={<><PrintButtons print={print} disabled={!hand.data} /><Button onClick={() => navigate("/pos")}>Xong</Button></>} />
      <div className="kpis">
        <div className="kpi"><div className="l">Dự kiến</div><div className="v">{money(sh.expectedCash)}</div></div>
        <div className="kpi"><div className="l">Kiểm đếm</div><div className="v">{money(sh.countedCash)}</div></div>
        <div className="kpi"><div className="l">Chênh lệch</div><div className="v" style={{ color: diff ? "var(--warn)" : undefined }}>{money(diff ?? 0)}</div></div>
        <div className="kpi"><div className="l">Doanh thu</div><div className="v">{money(rep.revenue ?? 0)}</div></div>
      </div>
      <div className="grid3" style={{ alignItems: "start" }}>
        <Card title="Theo kênh"><DataTable rows={ch} rowKey={(x) => x.label} cols={[{ key: "l", label: "Kênh", render: (x) => <>{CHANNELS[x.label] ?? x.label} {x.extra && <Badge>{x.extra}</Badge>}</> }, { key: "v", label: "Doanh thu", right: true, render: (x) => money(x.value) }]} /></Card>
        <Card title="Theo hình thức TT">{hand.data ? <PayTable rows={hand.data.byPayment} /> : <DataTable rows={pm} rowKey={(x) => x.label} cols={[{ key: "l", label: "Hình thức", render: (x) => METHODS[x.label] ?? x.label }, { key: "v", label: "Số tiền", right: true, render: (x) => money(x.value) }]} />}</Card>
        <Card title="Top 10 bán chạy"><DataTable rows={top} rowKey={(x) => x.label} cols={[{ key: "l", label: "Hàng", render: (x) => <>{x.label} {x.extra && <Badge>{x.extra}</Badge>}</> }, { key: "v", label: "Doanh thu", right: true, render: (x) => money(x.value) }]} /></Card>
      </div>
      {hand.data && <ShiftHandoverDoc s={hand.data} paper={paper} />}
      <div className="hint">Phiếu bàn giao ca có thể in lại bất cứ lúc nào ở Lịch sử ca.</div>
    </div>
  );
}
export { fmtTime };
