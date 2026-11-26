import { useState } from "react";
import { get } from "../api";
import { Badge, Banner, Button, EmptyState, DataTable, Spinner, useAsync } from "../components/ui";
import { DateRangeFilter, DetailPanel, ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SplitLayout, rangeOf, usePagedList, type DateRange } from "../components/list";
import { PrintButtons, usePrintDoc, type Paper } from "../components/report-print";
import { ShiftDetailBody, ShiftHandoverDoc } from "../components/shift-detail";
import { fmtDateTime, money } from "../format";
import { setQuery } from "../router";
import { useCan } from "../store";

/** Lịch sử ca: thu ngân thấy ca của mình, quản lý/chủ/kế toán thấy mọi ca. Bấm một ca để xem chi tiết và in / in lại phiếu bàn giao. */
export default function ShiftHistory() {
  const can = useCan();
  const seeAll = can("reports.view");
  const [range, setRange] = useState<DateRange>(() => rangeOf("7d"));
  const [userId, setUserId] = useState(""), [status, setStatus] = useState("");
  const [sel, setSel] = useState<number | null>(() => Number(new URLSearchParams(location.search).get("open")) || null);
  const list = usePagedList<any>("/shifts/history", { from: range.from, to: range.to, userId, status, limit: 50 }, [range.from, range.to, userId, status]);
  const cashiers = useAsync(async () => (seeAll ? (await get("/orders/cashiers", undefined, { silent: true }).catch(() => null))?.items ?? [] : []), [seeAll]);
  const rows = list.rows;
  const total = rows.reduce((s, r) => s + r.revenue, 0), diff = rows.reduce((s, r) => s + (r.status === "closed" ? r.diffCash ?? 0 : 0), 0);
  // Dữ liệu + khổ in nằm ở màn cha: khung chi tiết bị dựng lại khi bề rộng đổi (kể cả lúc mở hộp thoại in) nên không giữ state trong đó
  const detail = useAsync(async () => (sel != null ? get(`/shifts/${sel}/summary`) : null), [sel]);
  const { paper, print } = usePrintDoc();
  const open = (id: number | null) => { setSel(id); setQuery({ open: id ? String(id) : undefined }); };
  return (
    <div className="stack">
      <PageHeader subtitle={seeAll ? "Mọi ca của cửa hàng" : "Các ca của bạn"} actions={
        <ExportButton filename={`lich-su-ca-${range.from}_${range.to}`} rows={rows} columns={[
          { label: "Ca", value: (r) => r.id }, { label: "Thu ngân", value: (r) => r.cashierName }, { label: "Giờ mở", value: (r) => r.openedAt }, { label: "Giờ đóng", value: (r) => r.closedAt ?? "" },
          { label: "Tiền đầu ca", value: (r) => r.openingCash }, { label: "Doanh thu thuần", value: (r) => r.revenue }, { label: "Dự kiến", value: (r) => r.expectedCash }, { label: "Kiểm đếm", value: (r) => r.countedCash }, { label: "Chênh lệch", value: (r) => r.diffCash }, { label: "Lý do chênh lệch", value: (r) => r.diffReason ?? "" },
        ]} />} />
      <KpiRow cols={3} items={[
        { label: "Số ca", value: rows.length, sub: list.hasMore ? "đã tải, còn nữa" : undefined },
        { label: "Doanh thu thuần", value: money(total) },
        { label: "Tổng chênh lệch", value: money(diff), tone: diff ? "warn" : undefined, sub: "ca đã chốt" },
      ]} />
      <FilterBar dirty={!!(userId || status)} onReset={() => { setUserId(""); setStatus(""); }} advanced={<>
        {seeAll && <FilterSelect label="Thu ngân" value={userId} onChange={setUserId} options={(cashiers.data ?? []).map((u: any) => ({ v: String(u.id), label: u.name }))} />}
        <FilterSelect label="Trạng thái" value={status} onChange={setStatus} options={[{ v: "open", label: "Đang mở" }, { v: "closed", label: "Đã chốt" }]} />
      </>}>
        <DateRangeFilter value={range} onChange={setRange} presets={["today", "yesterday", "7d", "month", "lastMonth", "custom"]} />
      </FilterBar>
      {list.error && <Banner tone="danger">Không tải được lịch sử ca.</Banner>}
      <SplitLayout open={sel != null} panel={sel != null ? <ShiftPanel id={sel} onClose={() => open(null)} r={detail} paper={paper} print={print} /> : null}>
        {list.loading ? <Spinner /> : (
          <DataTable rows={rows} rowKey={(r: any) => r.id} selectedKey={sel} onRowClick={(r: any) => open(r.id)} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
            emptyState={<EmptyState title="Chưa có ca nào trong khoảng này" hint="Đổi khoảng ngày hoặc bộ lọc." action={<Button variant="soft" onClick={() => setRange(rangeOf("month"))}>Xem tháng này</Button>} />}
            cols={[
              { key: "id", label: "Ca", title: true, sort: (r: any) => r.id, render: (r: any) => <b>#{r.id}</b> },
              { key: "u", label: "Thu ngân", sort: (r: any) => r.cashierName, render: (r: any) => r.cashierName },
              { key: "o", label: "Mở lúc", sort: (r: any) => r.openedAt, render: (r: any) => <span className="nw">{fmtDateTime(r.openedAt)}</span> },
              { key: "c", label: "Đóng lúc", hideBelow: 1280, render: (r: any) => <span className="nw">{r.closedAt ? fmtDateTime(r.closedAt) : "—"}</span> },
              { key: "oc", label: "Tiền đầu ca", right: true, num: true, hideBelow: 1440, render: (r: any) => money(r.openingCash) },
              { key: "rv", label: "Doanh thu", right: true, num: true, sort: (r: any) => r.revenue, render: (r: any) => <b>{money(r.revenue)}</b> },
              { key: "ex", label: "Dự kiến", right: true, num: true, hideBelow: 1280, render: (r: any) => (r.status === "closed" ? money(r.expectedCash) : "—") },
              { key: "ct", label: "Kiểm đếm", right: true, num: true, hideBelow: 1280, render: (r: any) => (r.status === "closed" ? money(r.countedCash) : "—") },
              { key: "df", label: "Chênh lệch", right: true, num: true, sort: (r: any) => r.diffCash ?? 0, render: (r: any) => (r.status === "closed" ? <span style={{ color: r.diffCash ? "var(--warn)" : undefined }}>{money(r.diffCash ?? 0)}</span> : "—") },
              { key: "st", label: "Trạng thái", render: (r: any) => <Badge tone={r.status === "open" ? "info" : "ok"}>{r.status === "open" ? "Đang mở" : "Đã chốt"}</Badge> },
            ]} />
        )}
      </SplitLayout>
      {sel != null && detail.data && <ShiftHandoverDoc s={detail.data} paper={paper} />}
    </div>
  );
}

function ShiftPanel({ id, onClose, r, paper, print }: { id: number; onClose: () => void; r: { loading: boolean; data?: any }; paper: Paper; print: (p: Paper) => void }) {
  return (
    <DetailPanel title={`Ca #${id}`} onClose={onClose} footer={<div className="row wrap"><PrintButtons print={print} disabled={!r.data} /><span className="muted small">Phiếu bàn giao in được và in lại bất cứ lúc nào.</span></div>}>
      {r.loading ? <Spinner /> : !r.data ? <Banner tone="danger">Không xem được ca này.</Banner> : <ShiftDetailBody s={r.data} />}
    </DetailPanel>
  );
}
