import { useState } from "react";
import { get, items, post } from "../../api";
import { Badge, Banner, Button, EmptyState, Input, Segmented, Sheet, Spinner, useAsync, useDebounced } from "../../components/ui";
import { toast } from "../../components/toast";
import { fmtDateTime } from "../../format";
import { useCan } from "../../store";
import { CustomerSelect, type CustomerLite } from "../b2b/kit";

const B2B: Record<string, string> = { none: "Khách lẻ", pending: "Chờ liên kết sỉ", approved: "Khách sỉ", rejected: "Từ chối" };
export default function ShopAccounts() {
  const can = useCan();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [q, setQ] = useState(""); const dq = useDebounced(q);
  const qsel = new URLSearchParams(location.search).get("id");
  const l = useAsync(() => get("/shop-accounts", { b2bStatus: tab === "pending" ? "pending" : undefined, q: dq, limit: 100 }).then((r) => items<any>(r)), [tab, dq]);
  const [sel, setSel] = useState<any>(null);
  if (!can("customers.view_pii")) return <EmptyState title="Bạn không có quyền xem tài khoản khách" />;
  const target = sel ?? (qsel ? (l.data ?? []).find((a) => String(a.id) === qsel) : null);
  return (
    <div className="stack">
      <Segmented value={tab} onChange={setTab} options={[{ v: "pending", label: "Yêu cầu liên kết sỉ" }, { v: "all", label: "Tất cả tài khoản" }]} />
      <Input label="Tìm" type="search" placeholder="Email, tên, SĐT" value={q} onChange={(e) => setQ(e.target.value)} />
      {l.loading && !l.data ? <Spinner /> : !(l.data ?? []).length ? <EmptyState title={tab === "pending" ? "Không có yêu cầu liên kết" : "Chưa có tài khoản"} /> : (
        <div className="stack" data-testid="account-list">
          {l.data!.map((a) => (
            <button key={a.id} className="dt-card" onClick={() => setSel(a)}>
              <div className="row between"><b>{a.fullName ?? a.email}</b><Badge tone={a.b2bStatus === "pending" ? "warn" : a.b2bStatus === "approved" ? "ok" : undefined}>{B2B[a.b2bStatus] ?? a.b2bStatus}</Badge></div>
              <div className="small muted">{a.email}{a.phone ? ` · ${a.phone}` : ""} · {fmtDateTime(a.createdAt)}</div>
              {a.b2bRequest && <div className="small">{a.b2bRequest.companyName} · MST {a.b2bRequest.taxCode}</div>}
            </button>
          ))}
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
