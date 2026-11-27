import { useState } from "react";
import { get, post } from "../api";
import { Badge, Banner, Button, DataTable, EmptyState, Input, Segmented, Select, Sheet, Spinner, TextArea, useAsync } from "../components/ui";
import { ExportButton, FilterBar, KpiRow, PageHeader, SearchInput, usePagedList } from "../components/list";
import { toast } from "../components/toast";
import { fmtDateTime, money } from "../format";
import { useCan } from "../store";

type St = "pending" | "unmatched" | "refund_pending" | "pos_unused" | "matched" | "refunded" | "ignored";
const TABS: { v: St; label: string }[] = [
  { v: "pending", label: "Cần xử lý" },
  { v: "unmatched", label: "Chưa khớp" },
  { v: "refund_pending", label: "Chờ hoàn" },
  { v: "pos_unused", label: "QR quầy chưa tạo đơn" },
  { v: "matched", label: "Đã khớp" },
  { v: "refunded", label: "Đã hoàn" },
  { v: "ignored", label: "Bỏ qua" },
];
const STATUS: Record<string, { label: string; tone: any }> = {
  unmatched: { label: "Chưa khớp", tone: "warn" },
  refund_pending: { label: "Chờ hoàn", tone: "danger" },
  matched: { label: "Đã khớp", tone: "ok" },
  refunded: { label: "Đã hoàn", tone: "info" },
  ignored: { label: "Bỏ qua", tone: "neutral" },
  received: { label: "Đang xử lý", tone: "neutral" },
};
const REASON: Record<string, string> = {
  amount_mismatch: "Sai số tiền", unknown_code: "Mã không có trong hệ thống", no_code: "Không có mã thanh toán", wrong_account: "Vào tài khoản khác",
  account_not_configured: "Chưa cấu hình tài khoản nhận", not_money_in: "Không phải tiền vào", sepay_disabled: "SePay đang tắt", flow_disabled: "Luồng này đang tắt",
  already_paid: "Đã được thanh toán (chuyển thừa)", order_closed: "Đơn đã huỷ / đã đóng", order_expired: "Đơn quá hạn thanh toán", invoice_closed: "Hoá đơn đã đóng",
  qr_expired: "Mã QR hết hạn", qr_cancelled: "Mã QR đã bị thay", not_prepaid: "Đơn thanh toán khi nhận hàng", manual: "Gán tay",
};
const reasonText = (r?: string | null) => (!r ? "" : r.startsWith("error:") ? `Lỗi xử lý (${r.slice(6)})` : REASON[r] ?? r);
const KIND: Record<string, string> = { web: "Đơn website", b2b: "Hoá đơn sỉ", pos: "QR tại quầy" };

export default function Sepay() {
  const can = useCan();
  const [st, setSt] = useState<St>("pending");
  const [q, setQ] = useState("");
  const [act, setAct] = useState<null | { kind: "assign" | "refunded" | "ignored"; row: any }>(null);
  const [showHold, setShowHold] = useState(false);
  const cfg = useAsync(() => get("/sepay/config").catch(() => null), []);
  const list = usePagedList<any>("/sepay/events", { status: st, q, limit: 50 }, [st, q]);
  const sum = list.extra?.summary;
  const canAct = can("finance.write");
  return (
    <div className="stack">
      <PageHeader subtitle="Tiền chuyển khoản SePay chưa gán được đơn / hoá đơn, và khoản cần hoàn lại cho khách"
        actions={<ExportButton filename="giao-dich-sepay" rows={list.rows} columns={[
          { label: "Thời gian", value: (r: any) => r.txnAt }, { label: "Số tiền", value: (r: any) => r.amount }, { label: "Mã", value: (r: any) => r.code ?? "" },
          { label: "Trạng thái", value: (r: any) => STATUS[r.status]?.label ?? r.status }, { label: "Lý do", value: (r: any) => reasonText(r.reason) }, { label: "Mã tham chiếu", value: (r: any) => r.referenceCode ?? "" },
        ]} />} />
      {cfg.data && !cfg.data.enabled && <Banner>SePay đang <b>tắt</b>: giao dịch gửi tới (nếu có) đều được ghi là chưa khớp. Bật ở Cài đặt → Thanh toán SePay sau khi đã tạo webhook (xem docs/SEPAY.md).</Banner>}
      {cfg.data?.enabled && !cfg.data.webhookSecretSet && <Banner tone="danger">Chưa cài khoá bí mật xác thực webhook SePay: mọi thông báo từ SePay đều bị từ chối. Cần đặt biến SEPAY_WEBHOOK_SECRET khi triển khai (xem docs/SEPAY.md).</Banner>}
      {cfg.data?.bankCheck?.mismatch && (
        <Banner tone="danger">
          Ngân hàng nhận tiền trong Cài đặt là <b>{cfg.data.bankCheck.selected?.shortName ?? `mã ${cfg.data.bank?.bin}`}</b>, nhưng giao dịch SePay gần nhất đến từ <b>{cfg.data.bankCheck.lastGateway}</b>.
          Mã QR khách quét đang trỏ sai ngân hàng: sửa ở Cài đặt → Online/website → Ngân hàng nhận tiền.
        </Banner>
      )}
      {cfg.data?.bankCheck?.selected?.vaOnly && (
        <Banner>
          <b>{cfg.data.bankCheck.selected.shortName}</b>: {cfg.data.bankCheck.selected.note} Nếu tài khoản liên kết SePay bằng <b>kết nối API không có SMS</b> và thuộc loại này, ô Số tài khoản nhận tiền phải là <b>số VA</b>. Tài khoản có kết nối SMS nhận cả số tài khoản chính.
        </Banner>
      )}
      {canAct && sum?.hold?.legacy?.count > 0 && <LegacyBanner legacy={sum.hold.legacy} onDone={() => list.reload()} />}
      <KpiRow cols={3} items={[
        { label: "Chưa khớp", value: sum?.unmatched?.count ?? "—", sub: sum ? money(sum.unmatched.amount) : undefined, tone: sum?.unmatched?.count ? "warn" : undefined, onClick: () => setSt("unmatched") },
        { label: "Chờ hoàn tiền", value: sum?.refundPending?.count ?? "—", sub: sum ? money(sum.refundPending.amount) : undefined, tone: sum?.refundPending?.count ? "danger" : undefined, onClick: () => setSt("refund_pending") },
        { label: "Chuyển khoản chờ xử lý (trong quỹ)", value: sum?.hold ? money(sum.hold.balance) : "—", sub: sum?.hold ? `${sum.hold.openCount} giao dịch chưa xử lý xong` : undefined, tone: sum?.hold?.balance ? "warn" : undefined, onClick: () => setShowHold((v) => !v) },
      ]} />
      {showHold && <HoldVouchers />}
      <Segmented wrap value={st} onChange={setSt} options={TABS} />
      <FilterBar dirty={!!q} onReset={() => setQ("")}>
        <SearchInput value={q} onSearch={setQ} placeholder="Mã thanh toán, mã tham chiếu, nội dung…" />
      </FilterBar>
      {list.loading ? <Spinner /> : (
        <DataTable rows={list.rows} rowKey={(r: any) => r.id} hasMore={list.hasMore} loadingMore={list.loadingMore} onLoadMore={list.loadMore}
          emptyState={<EmptyState title={st === "pending" ? "Không có giao dịch cần xử lý" : "Không có giao dịch"} hint="Giao dịch khớp tự động sẽ nằm ở tab “Đã khớp”." />}
          cols={[
            { key: "t", label: "Thời gian", title: true, sort: (r: any) => r.txnAt ?? "", render: (r: any) => <span className="nw">{fmtDateTime(r.txnAt ?? r.createdAt)}</span> },
            { key: "a", label: "Số tiền", num: true, sort: (r: any) => r.amount, render: (r: any) => <b className="money">{money(r.amount)}</b> },
            { key: "c", label: "Mã", render: (r: any) => <span className="num">{r.code ?? "—"}</span> },
            { key: "s", label: "Trạng thái", render: (r: any) => <div className="st-badges"><Badge tone={STATUS[r.status]?.tone}>{STATUS[r.status]?.label ?? r.status}</Badge></div> },
            { key: "r", label: "Lý do / xử lý", render: (r: any) => <span className="small">{reasonText(r.reason)}{r.refCode && r.kind ? ` · ${KIND[r.kind] ?? r.kind} ${r.refCode}` : ""}{r.resolution ? ` — ${r.resolution}` : ""}</span> },
            { key: "h", label: "Sổ quỹ", hideBelow: 1280, render: (r: any) => <span className="small">{r.holdInCode ? <>Chờ xử lý {r.holdInCode}{r.holdOutCode ? ` → ra ${r.holdOutCode}` : <Badge tone="warn">đang ở khoản chờ</Badge>}</> : r.status === "matched" ? "Ghi thẳng vào chứng từ" : "—"}</span> },
            { key: "n", label: "Nội dung CK", hideBelow: 1600, render: (r: any) => <span className="small clip" title={r.content ?? ""}>{r.content ?? ""}</span> },
            { key: "f", label: "Tham chiếu", hideBelow: 1600, render: (r: any) => <span className="num small">{r.referenceCode ?? ""}</span> },
            ...(canAct ? [{ key: "x", label: "", render: (r: any) => (r.status === "unmatched" || r.status === "refund_pending") ? (
              <div className="row nw">
                <Button size="sm" variant="soft" onClick={() => setAct({ kind: "assign", row: r })}>Gán</Button>
                <Button size="sm" variant="ghost" onClick={() => setAct({ kind: "refunded", row: r })}>Đã hoàn</Button>
                <Button size="sm" variant="ghost" onClick={() => setAct({ kind: "ignored", row: r })}>Bỏ qua</Button>
              </div>) : null }] : []),
          ]} />
      )}
      {act && <ActionSheet act={act} onClose={() => setAct(null)} onDone={() => { setAct(null); list.reload(); }} />}
    </div>
  );
}

function ActionSheet({ act, onClose, onDone }: { act: { kind: "assign" | "refunded" | "ignored"; row: any }; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"web" | "b2b">("web");
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const r = act.row;
  const assign = act.kind === "assign";
  const ok = note.trim().length >= 3 && (!assign || code.trim().length >= 3);
  const ignoring = act.kind === "ignored";
  const inHold = !!r.holdInCode && !r.holdOutCode;
  const cats = useAsync(() => (ignoring && inHold ? get("/cash-categories", undefined, { silent: true }).then((x: any) => (x.items ?? []) as any[]).catch(() => [] as any[]) : Promise.resolve([] as any[])), []);
  const [cat, setCat] = useState(""); // "" = chưa chọn; "hold" = giữ ở khoản chờ
  const [refundRef, setRefundRef] = useState("");
  const okAll = ok && (!(ignoring && inHold) || !!cat);
  const submit = async () => {
    setBusy(true);
    try {
      if (assign) await post(`/sepay/events/${r.id}/assign`, { kind, code: code.trim(), note: note.trim() });
      else if (act.kind === "refunded") await post(`/sepay/events/${r.id}/resolve`, { action: "refunded", reason: note.trim(), ...(refundRef.trim() ? { refundRef: refundRef.trim() } : {}) });
      else await post(`/sepay/events/${r.id}/resolve`, { action: "ignored", reason: note.trim(), ...(inHold ? (cat === "hold" ? { keepInHold: true } : { categoryId: Number(cat) }) : {}) });
      toast(assign ? "Đã gán giao dịch và ghi nhận thanh toán" : act.kind === "refunded" ? "Đã đánh dấu hoàn tiền" : "Đã bỏ qua giao dịch", "ok");
      onDone();
    } catch { /* api.ts đã báo lỗi */ } finally { setBusy(false); }
  };
  const title = assign ? "Gán giao dịch vào đơn / hoá đơn" : act.kind === "refunded" ? "Đánh dấu đã hoàn tiền" : "Bỏ qua giao dịch";
  return (
    <Sheet open onClose={onClose} title={title} footer={<Button block size="lg" loading={busy} disabled={!okAll} onClick={submit}>{assign ? "Gán và ghi nhận thanh toán" : "Xác nhận"}</Button>}>
      <div className="stack">
        <div className="card flat" style={{ padding: 12 }}>
          <div className="row between"><span className="muted">Số tiền</span><b className="money">{money(r.amount)}</b></div>
          <div className="row between"><span className="muted">Mã trong giao dịch</span><span className="num">{r.code ?? "—"}</span></div>
          <div className="row between"><span className="muted">Lý do chưa khớp</span><span>{reasonText(r.reason) || "—"}</span></div>
        </div>
        {assign && (
          <>
            <Select label="Gán vào" value={kind} onChange={(e) => setKind(e.target.value as any)}>
              <option value="web">Đơn website (mã DH…, phải đúng số tiền)</option>
              <option value="b2b">Hoá đơn sỉ (mã hoá đơn, thu nợ)</option>
            </Select>
            <Input label={kind === "web" ? "Mã đơn" : "Mã hoá đơn"} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={kind === "web" ? "DH202611250001" : "HDB-20261125-0001"} />
          </>
        )}
        {assign && inHold && <Banner tone="info">Tiền đang nằm ở “Chuyển khoản chờ xử lý” trong quỹ: khi gán, hệ thống chuyển ra khỏi khoản chờ và ghi thanh toán thật (quỹ không đổi thêm).</Banner>}
        {act.kind === "refunded" && <Banner>Hệ thống không tự chuyển tiền. Hãy hoàn tiền cho khách bằng Internet Banking trước, rồi ghi lại ở đây. {inHold ? "Hệ thống lập phiếu chi hoàn tiền từ quỹ ngân hàng (khoản chờ xử lý)." : ""}</Banner>}
        {act.kind === "refunded" && inHold && <Input label="Mã giao dịch hoàn (nếu có)" value={refundRef} onChange={(e) => setRefundRef(e.target.value)} />}
        {ignoring && inHold && (
          <Select label="Tiền đã vào quỹ — ghi vào đâu? (bắt buộc)" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">— Chọn —</option>
            {(cats.data ?? []).filter((x: any) => x.direction === "in" && x.code !== "CK_CHO_XL" && x.pnlLine !== "transfer" && x.pnl_line !== "transfer").map((x: any) => <option key={x.id} value={String(x.id)}>Thu: {x.name}</option>)}
            <option value="hold">Giữ ở “Chuyển khoản chờ xử lý” (kế toán xử lý sau, ghi lý do)</option>
          </Select>
        )}
        <TextArea label={assign ? "Ghi chú / căn cứ gán (bắt buộc)" : "Lý do (bắt buộc)"} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Sheet>
  );
}

function HoldVouchers() {
  const q = useAsync(() => get("/sepay/hold"), []);
  const rows: any[] = q.data?.items ?? [];
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row between"><b>Phiếu “Chuyển khoản chờ xử lý”</b><span className="muted small">Số dư khoản chờ: <b className="money">{money(q.data?.summary?.balance ?? 0)}</b></span></div>
      <div className="small muted" style={{ margin: "4px 0 8px" }}>Khoản này nằm trong số dư quỹ ngân hàng nhưng không tính vào lãi lỗ. Phiếu thu = tiền SePay báo về chưa gán; phiếu chi = đã gán đơn / hoàn khách / chuyển khoản mục khác.</div>
      {q.loading ? <Spinner /> : (
        <DataTable rows={rows} rowKey={(r: any) => r.id} emptyState={<EmptyState title="Chưa có phiếu" />}
          cols={[
            { key: "c", label: "Phiếu", title: true, render: (r: any) => <span className="num">{r.code}</span> },
            { key: "d", label: "Ngày", render: (r: any) => <span className="nw">{fmtDateTime(r.createdAt)}</span> },
            { key: "k", label: "Loại", render: (r: any) => <Badge tone={r.direction === "in" ? "warn" : "info"}>{r.direction === "in" ? "Thu vào chờ" : "Chi khỏi chờ"}</Badge> },
            { key: "a", label: "Số tiền", num: true, render: (r: any) => <b className="money">{r.direction === "in" ? "+" : "−"}{money(r.amount)}</b> },
            { key: "n", label: "Ghi chú", render: (r: any) => <span className="small">{r.note}</span> },
          ]} />
      )}
    </div>
  );
}

function LegacyBanner({ legacy, onDone }: { legacy: { count: number; amount: number }; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pre = useAsync(() => (open ? get("/sepay/ledger/backfill") : Promise.resolve(null)), [open]);
  const run = async () => {
    setBusy(true);
    try {
      const r = await post("/sepay/ledger/backfill", { expectedCount: pre.data.count, expectedAmount: pre.data.amount });
      toast(`Đã ghi ${r.posted} giao dịch (${money(r.amount)}) vào khoản chờ xử lý${r.skipped ? `, bỏ qua ${r.skipped}` : ""}`, "ok");
      setOpen(false);
      onDone();
    } catch { /* api.ts đã báo lỗi */ } finally { setBusy(false); }
  };
  return (
    <>
      <Banner tone="danger">
        Có <b>{legacy.count}</b> giao dịch SePay ({money(legacy.amount)}) chưa khớp / chờ hoàn từ trước, <b>chưa được ghi vào sổ quỹ</b> nên số dư quỹ đang thiếu khoản này.{" "}
        <Button size="sm" variant="soft" onClick={() => setOpen(true)}>Ghi các giao dịch chờ cũ vào sổ</Button>
      </Banner>
      {open && (
        <Sheet open onClose={() => setOpen(false)} title="Ghi các giao dịch chờ cũ vào sổ" footer={<Button block size="lg" loading={busy} disabled={!pre.data?.count} onClick={run}>Ghi {pre.data?.count ?? 0} giao dịch vào khoản chờ</Button>}>
          <div className="stack">
            <Banner tone="info">Mỗi giao dịch được lập một phiếu thu “Chuyển khoản chờ xử lý” (không vào lãi lỗ) vào ngày giao dịch (kỳ đã khoá thì ghi vào hôm nay). Làm một lần.</Banner>
            {pre.loading ? <Spinner /> : (
              <>
                <div className="row between"><span className="muted">Số giao dịch</span><b>{pre.data?.count ?? 0}</b></div>
                <div className="row between"><span className="muted">Tổng tiền</span><b className="money">{money(pre.data?.amount ?? 0)}</b></div>
                <DataTable rows={pre.data?.items ?? []} rowKey={(r: any) => r.id} emptyState={<EmptyState title="Không còn giao dịch" />}
                  cols={[
                    { key: "t", label: "Thời gian", render: (r: any) => <span className="nw">{fmtDateTime(r.txnAt)}</span> },
                    { key: "a", label: "Số tiền", num: true, render: (r: any) => <b className="money">{money(r.amount)}</b> },
                    { key: "r", label: "Lý do", render: (r: any) => <span className="small">{reasonText(r.reason) || (r.status === "matched" ? "QR quầy chưa tạo đơn" : "")}</span> },
                  ]} />
              </>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
