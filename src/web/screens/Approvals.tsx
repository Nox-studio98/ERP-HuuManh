import { useState } from "react";
import { get, items, post } from "../api";
import { Badge, Button, Card, EmptyState, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { Obj } from "./Inventory";
import { toast } from "../components/toast";
import { fmtDateTime, money } from "../format";

/** Loại yêu cầu thật của backend (routes/pos.ts, finance.ts, inventory.ts, prices.ts). */
const TYPES: Record<string, string> = { "order.below_cost": "Bán dưới giá vốn", "order.discount": "Giảm giá vượt ngưỡng", "stock_doc.post": "Chứng từ kho cần duyệt", "cash_voucher.post": "Chi tiền lớn", "price.activate": "Đổi giá bán" };
export default function Approvals() {
  const a = useAsync(() => get("/approvals", { status: "pending" }).then((r) => items<any>(r)), []);
  const [sel, setSel] = useState<any>(null);
  const [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try { await post(`/approvals/${sel.id}/decide`, { decision, note }); toast(decision === "approved" ? "Đã duyệt" : "Đã từ chối", "ok"); setSel(null); setNote(""); a.reload(); } catch {} finally { setBusy(false); }
  };
  if (a.loading) return <Spinner />;
  if (!a.data?.length) return <EmptyState title="Không có yêu cầu chờ duyệt" hint="Mọi thứ đã được xử lý." />;
  const REASON: Record<string, string> = { discount: "Giảm giá vượt ngưỡng", below_cost: "Giá bán thấp hơn giá vốn" };
const reasonText = (x: any) => (String(x.type).startsWith("order.") ? String(x.reason ?? "").split(",").map((r) => REASON[r] ?? r).join(", ") : x.reason);
/** Chi tiết theo từng loại payload của backend. */
const detail = (x: any) => {
  const p = x.payload ?? {};
  const d: Record<string, any> = { "Loại": TYPES[x.type] ?? x.type, "Lý do": reasonText(x), "Người yêu cầu": x.requestedByName, "Lúc": fmtDateTime(x.requestedAt) };
  if (String(x.type).startsWith("order.")) { d["Tổng đơn"] = money(p.total); d["Giá trị giảm"] = money(p.discountValue); }
  else if (x.type === "cash_voucher.post") { d["Phiếu"] = p.code; d["Số tiền"] = money(p.amount); }
  else if (x.type === "price.activate") { d["Giá mới"] = money(p.unitPrice); d["Mặt hàng #"] = p.productId; d["Có hiệu lực từ"] = fmtDateTime(p.effectiveFrom); if (p.belowCost) d["Cảnh báo"] = "Thấp hơn giá vốn"; }
  else if (x.refType) d["Tham chiếu"] = `${x.refType} #${x.refId}`;
  return d;
};
  return (
    <div className="stack">
      {a.data.map((x) => (
        <button key={x.id} className="dt-card" onClick={() => setSel(x)}>
          <div className="row between"><b>#{x.id} · {TYPES[x.type] ?? x.type}</b><Badge tone="warn">Chờ duyệt</Badge></div>
          <div className="small muted">{fmtDateTime(x.requestedAt)} · {x.requestedByName ?? `NV #${x.requestedBy}`}</div>
          {x.reason && <div style={{ marginTop: 4 }}>{reasonText(x)}</div>}
        </button>
      ))}
      <Sheet open={!!sel} onClose={() => setSel(null)} title={sel ? `Yêu cầu #${sel.id}` : ""} footer={<><Button variant="danger" disabled={busy} onClick={() => decide("rejected")}>Từ chối</Button><Button className="grow" loading={busy} onClick={() => decide("approved")}>Duyệt</Button></>}>
        {sel && <div className="stack"><Card className="flat"><Obj v={detail(sel)} /></Card><TextArea label="Ghi chú quyết định" value={note} onChange={(e) => setNote(e.target.value)} /></div>}
      </Sheet>
    </div>
  );
}
