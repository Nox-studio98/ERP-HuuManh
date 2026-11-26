import { ReactNode } from "react";
import { get } from "../api";
import { BarChart } from "../components/charts";
import { KpiRow, PageHeader, deltaPct, type Kpi } from "../components/list";
import { Banner, Button, Card, Spinner, useAsync } from "../components/ui";
import { CHANNELS, fmtDate, money, num } from "../format";
import { navigate } from "../router";

type Day = { day: string; orders: number; revenue: number; returns: number; grossProfit?: number; byChannel: { channel: string; orders: number; revenue: number }[] };
type Dash = {
  today: string;
  sales?: { today: Day; yesterday: Day; canSeeCost: boolean };
  series7d?: { day: string; revenue: number; orders: number }[];
  todo: {
    approvalsPending?: number; onlinePending?: number; b2bDeliveries?: { dueToday: number; late: number };
    stock?: { lowStock: number; expiringSoon: number }; overdueDebt?: { invoices: number; amount: number };
    attendanceReview?: { corrections: number; punches: number };
  };
};

const WD = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];
const dayLabel = (d: string) => `${WD[new Date(d + "T00:00:00Z").getUTCDay()]}, ${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function TodoRow({ n, tone, label, hint, to }: { n: number; tone: "warn" | "danger" | "ok" | ""; label: string; hint?: string; to: string }) {
  return (
    <button type="button" className="todo" onClick={() => navigate(to)}>
      <span className={"n " + (n > 0 ? tone : "ok")}>{num(n)}</span>
      <span><b>{label}</b>{hint && <div className="small muted">{hint}</div>}</span>
      <span className="go" aria-hidden="true">›</span>
    </button>
  );
}

export default function Dashboard() {
  const d = useAsync(() => get<Dash>("/dashboard"), []);
  if (d.loading && !d.data) return <Spinner />;
  if (!d.data) return <Banner tone="danger">Không tải được dữ liệu tổng quan. <Button size="sm" variant="ghost" onClick={d.reload}>Tải lại</Button></Banner>;
  const D = d.data, s = D.sales, t = D.todo;
  const kpis: Kpi[] = [];
  if (s) {
    kpis.push({ label: "Doanh thu hôm nay", value: money(s.today.revenue), delta: { pct: deltaPct(s.today.revenue, s.yesterday.revenue), label: "so với hôm qua" }, sub: `Hôm qua ${money(s.yesterday.revenue)}`, tone: "ok" });
    kpis.push({ label: "Số đơn", value: num(s.today.orders), delta: { pct: deltaPct(s.today.orders, s.yesterday.orders), label: "so với hôm qua" }, sub: `Hôm qua ${num(s.yesterday.orders)}` });
    if (s.canSeeCost) kpis.push({ label: "Lãi gộp hôm nay", value: money(s.today.grossProfit), delta: { pct: deltaPct(s.today.grossProfit ?? 0, s.yesterday.grossProfit ?? 0), label: "so với hôm qua" }, sub: `Hôm qua ${money(s.yesterday.grossProfit)}` });
    kpis.push({ label: "Trả hàng hôm nay", value: money(s.today.returns), sub: `Hôm qua ${money(s.yesterday.returns)}`, tone: s.today.returns > 0 ? "warn" : undefined });
  }
  const rows: ReactNode[] = [];
  if (t.approvalsPending != null) rows.push(<TodoRow key="ap" n={t.approvalsPending} tone="warn" label="Phiếu chờ duyệt" hint="Giảm giá, hao hụt, chi vượt ngưỡng…" to="/approvals" />);
  if (t.onlinePending != null) rows.push(<TodoRow key="on" n={t.onlinePending} tone="warn" label="Đơn online chờ xử lý" hint="Đơn mới chưa xác nhận" to="/online-orders" />);
  if (t.b2bDeliveries) rows.push(<TodoRow key="b2b" n={t.b2bDeliveries.dueToday + t.b2bDeliveries.late} tone={t.b2bDeliveries.late ? "danger" : "warn"} label="Đơn sỉ cần giao hôm nay" hint={t.b2bDeliveries.late ? `Trong đó ${t.b2bDeliveries.late} đơn trễ hạn` : "Đến hạn giao trong ngày"} to="/deliveries" />);
  if (t.stock) {
    rows.push(<TodoRow key="low" n={t.stock.lowStock} tone="danger" label="Hàng sắp hết" hint="Dưới mức tồn tối thiểu" to="/inventory" />);
    rows.push(<TodoRow key="exp" n={t.stock.expiringSoon} tone="warn" label="Lô sắp hết hạn" hint="Hết hạn trong 2 ngày tới" to="/inventory" />);
  }
  if (t.overdueDebt) rows.push(<TodoRow key="debt" n={t.overdueDebt.invoices} tone="danger" label="Công nợ quá hạn" hint={t.overdueDebt.invoices ? `Tổng ${money(t.overdueDebt.amount)}` : undefined} to="/debts" />);
  if (t.attendanceReview) rows.push(<TodoRow key="att" n={t.attendanceReview.corrections + t.attendanceReview.punches} tone="warn" label="Chấm công cần xem lại" hint="Yêu cầu bổ sung công, chấm offline chờ duyệt" to="/hr/approvals" />);
  const max = Math.max(1, ...(s?.today.byChannel ?? []).map((c) => c.revenue));
  return (
    <div className="dash">
      <PageHeader subtitle={dayLabel(D.today)} actions={<Button variant="ghost" size="sm" onClick={d.reload} loading={d.loading}>Làm mới</Button>} />
      {kpis.length > 0 && <KpiRow items={kpis} cols={kpis.length} />}
      <div className="dash-cols">
        {rows.length > 0 && (
          <Card title="Việc cần làm">
            <div className="todo-list">{rows}</div>
          </Card>
        )}
        <div className="stack">
          {D.series7d && (
            <Card title="Doanh thu 7 ngày gần nhất">
              <BarChart height={200} data={D.series7d.map((x) => ({ label: fmtDate(x.day + "T12:00:00+07:00").slice(0, 5), value: x.revenue }))} />
              <div className="small muted" style={{ marginTop: 8 }}>Tổng 7 ngày: <b className="money">{money(D.series7d.reduce((a, x) => a + x.revenue, 0))}</b> · {num(D.series7d.reduce((a, x) => a + x.orders, 0))} đơn</div>
            </Card>
          )}
          {s && (
            <Card title="Doanh thu hôm nay theo kênh">
              {s.today.byChannel.length === 0 ? <div className="muted">Hôm nay chưa có đơn hoàn tất.</div> : (
                <div className="chbar">
                  {[...s.today.byChannel].sort((a, b) => b.revenue - a.revenue).map((c) => (
                    <div className="r" key={c.channel}>
                      <span>{CHANNELS[c.channel] ?? c.channel}</span>
                      <span className="track"><span className="fill" style={{ width: `${Math.max(2, (c.revenue / max) * 100)}%`, display: "block" }} /></span>
                      <span className="money">{money(c.revenue)} <span className="muted small">· {c.orders} đơn</span></span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      {!s && rows.length === 0 && <Banner tone="info">Chưa có số liệu nào dành cho vai trò của bạn.</Banner>}
    </div>
  );
}
