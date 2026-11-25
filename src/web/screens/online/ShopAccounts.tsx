import { useState } from "react";
import { get, items, post } from "../../api";
import { Badge, Banner, Button, Card, DataTable, EmptyState, Input, Segmented, Sheet, Spinner, useAsync } from "../../components/ui";
import { ExportButton, FilterBar, FilterSelect, KpiRow, PageHeader, SearchInput, usePagedList } from "../../components/list";
import { toast } from "../../components/toast";
import { fmtDateTime } from "../../format";
import { useCan } from "../../store";
import { CustomerSelect, type CustomerLite } from "../b2b/kit";

const B2B: Record<string, string> = { none: "Khách lẻ", pending: "Chờ liên kết sỉ", approved: "Khách sỉ", rejected: "Từ chối" };
export default function ShopAccounts() {
  const can = useCan();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [q, setQ] = useState(""), [b2b, setB2b] = useState("");
  const qsel = new URLSearchParams(location.search).get("id");
  const l = usePagedList<any>("/shop-accounts", { b2bStatus: tab === "pending" ? "pending" : b2b || undefined, q, limit: 100 }, [tab, b2b, q]);
  const [sel, setSel] = useState<any>(null);
  if (!can("customers.view_pii")) return <EmptyState title="Bạn không có quyền xem tài khoản khách" />;
  const rows = l.rows;
  const target = sel ?? (qsel ? rows.find((a) => String(a.id) === qsel) : null);
  const dirty = !!(q || b2b);
  const reset = () => { setQ(""); setB2b(""); };
  return (
    <div className="stack">
      <PageHeader compact subtitle="Tài khoản khách đăng ký trên website và yêu cầu liên kết khách sỉ"
        actions={<ExportButton filename="tai-khoan-khach" rows={rows} columns={[
          { label: "Tên", value: (a) => a.fullName }, { label: "Email", value: (a) => a.email }, { label: "SĐT", value: (a) => a.phone }, { label: "Loại", value: (a) => B2B[a.b2bStatus] ?? a.b2bStatus },
          { label: "Đã xác minh email", value: (a) => (a.emailVerified ? "Có" : "Chưa") }, { label: "Ngày đăng ký", value: (a) => fmtDateTime(a.createdAt) },
        ]} />} />
      <Segmented className="tabs-d" value={tab} onChange={setTab} options={[{ v: "pending", label: "Yêu cầu liên kết sỉ" }, { v: "all", label: "Tất cả tài khoản" }]} />
      <FilterBar dirty={dirty} onReset={reset} activeCount={b2b && tab === "all" ? 1 : 0} advanced={tab === "all" ? <FilterSelect label="Loại tài khoản" value={b2b} onChange={setB2b} options={[{ v: "pending", label: "Chờ liên kết sỉ" }, { v: "approved", label: "Khách sỉ" }, { v: "rejected", label: "Từ chối" }]} /> : undefined}>
        <SearchInput value={q} onSearch={setQ} placeholder="Email, tên, SĐT" label="Tìm" />
      </FilterBar>
      <KpiRow cols={3} items={[
        { label: tab === "pending" ? "Yêu cầu chờ xử lý" : "Tài khoản", value: rows.length, tone: tab === "pending" && rows.length ? "warn" : undefined, sub: l.hasMore ? "còn nữa — Tải thêm" : undefined },
        { label: "Đã xác minh email", value: rows.filter((a) => a.emailVerified).length },
        { label: "Khách sỉ", value: rows.filter((a) => a.b2bStatus === "approved").length, tone: "ok" },
      ]} />
      {l.loading && !rows.length ? <Spinner /> : (
        <div data-testid="account-list">
          <DataTable rows={rows} rowKey={(a) => a.id} onRowClick={setSel} hasMore={l.hasMore} loadingMore={l.loadingMore} onLoadMore={l.loadMore}
            emptyState={<EmptyState title={dirty ? "Không có tài khoản nào khớp bộ lọc" : tab === "pending" ? "Không có yêu cầu liên kết" : "Chưa có tài khoản"} hint={tab === "pending" ? "Khi khách đăng ký tài khoản sỉ trên website, yêu cầu sẽ hiện ở đây để bạn liên kết với khách sỉ." : undefined}
              action={<div className="row wrap" style={{ justifyContent: "center" }}>{dirty && <Button variant="soft" onClick={reset}>Xoá lọc</Button>}{tab === "pending" && <Button variant="ghost" onClick={() => setTab("all")}>Xem tất cả tài khoản</Button>}</div>} />}
            cols={[
              { key: "n", label: "Khách", title: true, sort: (a) => a.fullName ?? a.email, render: (a) => <span><b>{a.fullName ?? a.email}</b>{a.fullName && <div className="small muted">{a.email}</div>}</span> },
              { key: "p", label: "SĐT", hideBelow: 1280, render: (a) => a.phone ?? "—" },
              { key: "b", label: "Loại", sort: (a) => a.b2bStatus, render: (a) => <Badge tone={a.b2bStatus === "pending" ? "warn" : a.b2bStatus === "approved" ? "ok" : undefined}>{B2B[a.b2bStatus] ?? a.b2bStatus}</Badge> },
              { key: "r", label: "Công ty / MST", hideBelow: 1024, render: (a) => (a.b2bRequest ? `${a.b2bRequest.companyName} · MST ${a.b2bRequest.taxCode}` : "—") },
              { key: "v", label: "Email", hideBelow: 1280, render: (a) => (a.emailVerified ? <Badge tone="ok">Đã xác minh</Badge> : <Badge tone="warn">Chưa xác minh</Badge>) },
              { key: "d", label: "Đăng ký", sort: (a) => a.createdAt, render: (a) => fmtDateTime(a.createdAt) },
            ]} />
        </div>
      )}
      {target && <LinkSheet a={target} canLink={can("b2b.approve")} onClose={() => { setSel(null); if (qsel) history.replaceState({}, "", "/shop-accounts"); }} onDone={() => { setSel(null); l.reload(); }} />}
    </div>
  );
}
function LinkSheet({ a, canLink, onClose, onDone }: { a: any; canLink: boolean; onClose: () => void; onDone: () => void }) {
  const [c, setC] = useState<CustomerLite | null>(null);
  const [busy, setBusy] = useState(false);
  const link = async () => { setBusy(true); try { await post(`/shop-accounts/${a.id}/b2b-link`, { customerId: c!.id }); toast("Đã liên kết khách sỉ", "ok"); onDone(); } catch { /* toast */ } finally { setBusy(false); } };
  const r = a.b2bRequest;
  return (
    <Sheet open onClose={onClose} title={a.fullName ?? a.email} footer={canLink && a.kind !== "b2b" ? <Button block loading={busy} disabled={!c} onClick={link}>Liên kết với khách sỉ</Button> : undefined}>
      <div className="stack">
        <div className="card flat stack" style={{ gap: 4 }}>
          <div>{a.email} {a.emailVerified ? <Badge tone="ok">Đã xác minh</Badge> : <Badge tone="warn">Chưa xác minh</Badge>}</div>
          <div className="small muted">{a.phone ?? "Chưa có SĐT"} · {B2B[a.b2bStatus]}{a.customerId ? ` · khách #${a.customerId}` : ""}</div>
          {r && <div className="small"><b>{r.companyName}</b> · MST {r.taxCode}{r.note ? ` · ${r.note}` : ""}</div>}
        </div>
        {a.kind === "b2b" ? <Banner tone="info">Tài khoản đã liên kết khách sỉ.</Banner> : canLink ? <CustomerSelect label="Chọn khách sỉ có sẵn" value={c} onChange={setC} /> : <Banner>Bạn không có quyền liên kết khách sỉ.</Banner>}
      </div>
    </Sheet>
  );
}
