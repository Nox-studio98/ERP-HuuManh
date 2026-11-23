import { useState } from "react";
import { get, items, post, put } from "../../api";
import { Badge, Banner, Button, Card, DataTable, Input, Select, Sheet, Spinner, TextArea, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";
import { downloadHref, money, todayVN, unitLabel } from "../../format";
import { navigate } from "../../router";
import { useCan } from "../../store";
import { CreditBlocked, CustomerSelect, LinesEditor, Lnk, QUOTE_STATUS, ReasonSheet, errCode, linePayload, qparam, qtyU, quoteTone, ymd, type CustomerLite, type EditLine } from "./kit";
import { ApiError } from "../../api";

export default function Quotes() {
  const can = useCan();
  const [status, setStatus] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const pre = qparam("new");
  const [creating, setCreating] = useState<boolean>(!!pre);
  const list = useAsync(() => get("/quotes", { status, limit: 100 }).then((r) => items<any>(r)), [status]);
  return (
    <div className="stack">
      <div className="row wrap" style={{ alignItems: "flex-end" }}>
        <div className="grow" style={{ minWidth: 200 }}>
          <Select label="Trạng thái" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tất cả</option>{Object.entries(QUOTE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        {can("b2b.write") && <Button onClick={() => setCreating(true)}>+ Tạo báo giá</Button>}
      </div>
      {list.loading ? <Spinner /> : (
        <DataTable rows={list.data ?? []} rowKey={(q) => q.id} onRowClick={(q) => setSel(q.id)} empty="Chưa có báo giá" cols={[
          { key: "c", label: "Mã", title: true, render: (q) => <b>{q.code}</b> },
          { key: "k", label: "Khách hàng", render: (q) => q.customerName },
          { key: "s", label: "Trạng thái", render: (q) => <Badge tone={quoteTone(q.status)}>{QUOTE_STATUS[q.status] ?? q.status}</Badge> },
          { key: "v", label: "Hiệu lực đến", render: (q) => ymd(q.validUntil) },
          { key: "t", label: "Tạm tính", right: true, render: (q) => <span className="money">{money(q.subtotal)}</span> },
        ]} />
      )}
      {creating && <QuoteForm presetCustomerId={pre ? Number(pre) : undefined} onClose={() => { setCreating(false); if (pre) history.replaceState({}, "", "/quotes"); }} onSaved={(q) => { setCreating(false); if (pre) history.replaceState({}, "", "/quotes"); list.reload(); setSel(q.id); }} />}
      {sel != null && <QuoteDetail id={sel} onClose={() => setSel(null)} onChanged={list.reload} />}
    </div>
  );
}

function QuoteForm({ presetCustomerId, onClose, onSaved }: { presetCustomerId?: number; onClose: () => void; onSaved: (q: any) => void }) {
  const can = useCan();
  const [cust, setCust] = useState<CustomerLite | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [days, setDays] = useState(7), [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  useAsync(async () => { if (presetCustomerId) { try { setCust(await get(`/customers/${presetCustomerId}`, undefined, { silent: true })); } catch {} } return 1; }, [presetCustomerId]);
  const submit = async () => {
    if (!cust) return;
    setBusy(true);
    try {
      const q = await post("/quotes", { customerId: cust.id, validDays: days, note: note || undefined, lines: linePayload(lines, true) });
      toast(q.status === "pending_approval" ? "Báo giá giảm sâu / dưới giá vốn — đã gửi chủ duyệt" : `Đã tạo báo giá ${q.code}`, q.status === "pending_approval" ? "info" : "ok");
      onSaved(q);
    } catch {} finally { setBusy(false); }
  };
  return (
    <Sheet open wide onClose={onClose} title="Tạo báo giá" footer={<Button block size="lg" loading={busy} disabled={!cust || !lines.length || lines.some((l) => l.qty <= 0)} onClick={submit}>Lưu báo giá</Button>}>
      <div className="stack">
        <CustomerSelect value={cust} onChange={(c) => { setCust(c); setLines([]); }} />
        {cust && (
          <>
            <div className="grid2"><Input label="Hiệu lực (ngày)" inputMode="numeric" value={String(days)} onChange={(e) => setDays(Math.max(1, Math.min(365, parseInt(e.target.value) || 1)))} /></div>
            <LinesEditor lines={lines} setLines={setLines} groupId={cust.customerGroupId} customerId={cust.id} allowPrice showCost={can("prices.view_cost")} />
            <TextArea label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="hint">Giảm giá sâu so với bảng giá hoặc bán dưới giá vốn sẽ cần chủ duyệt trước khi gửi khách.</div>
          </>
        )}
      </div>
    </Sheet>
  );
}

function QuoteDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const qd = useAsync(() => get(`/quotes/${id}`), [id]);
  const [mode, setMode] = useState<"" | "cancel" | "extend" | "convert">("");
  const [busy, setBusy] = useState(false);
  const q = qd.data;
  const reload = () => { qd.reload(); onChanged(); };
  const send = async () => {
    setBusy(true);
    try { const r = await post(`/quotes/${id}/send`); toast(r.pdf === false ? "Đã gửi — PDF chưa tạo được, thử mở lại sau" : "Đã gửi báo giá", "ok"); reload(); } catch {} finally { setBusy(false); }
  };
  const showCost = q?.lines?.some((l: any) => l.marginBp != null);
  return (
    <Sheet open wide onClose={onClose} title={q ? `Báo giá ${q.code}` : "Báo giá"}>
      {qd.loading || !q ? <Spinner /> : (
        <div className="stack">
          <div className="row wrap"><Badge tone={quoteTone(q.status)}>{QUOTE_STATUS[q.status] ?? q.status}</Badge><span className="muted small">{q.customerName} · hiệu lực {ymd(q.validFrom)} → {ymd(q.validUntil)}</span></div>
          {q.status === "pending_approval" && <Banner>Báo giá đang chờ chủ duyệt{q.approvalId ? ` (yêu cầu #${q.approvalId})` : ""} — chưa gửi khách được.</Banner>}
          {q.status === "expired" && <Banner>Báo giá đã hết hạn. {can("b2b.approve") ? "Gia hạn để tiếp tục dùng." : "Nhờ chủ/quản lý gia hạn."}</Banner>}
          {q.extendedReason && <div className="small muted">Đã gia hạn: {q.extendedReason}</div>}
          <DataTable rows={q.lines} rowKey={(l: any) => l.id} rowClass={(l: any) => (l.marginBp != null && l.marginBp < 0 ? "bad" : "")} cols={[
            { key: "n", label: "Hàng", title: true, render: (l: any) => <b>{l.productName}</b> },
            { key: "q", label: "SL", right: true, render: (l: any) => (l.qty != null ? qtyU(l.qty, l.unit) : <span className="muted">chưa có</span>) },
            { key: "lp", label: "Giá bảng", right: true, render: (l: any) => money(l.listPrice) },
            { key: "up", label: "Giá báo", right: true, render: (l: any) => <b className="money" style={{ color: l.unitPrice < l.listPrice ? "var(--warn)" : undefined }}>{money(l.unitPrice)}</b> },
            ...(showCost ? [{ key: "m", label: "Biên", right: true, render: (l: any) => (l.marginBp == null ? "—" : <Badge tone={l.marginBp < 0 ? "danger" : l.marginBp < 1000 ? "warn" : "ok"}>{l.marginBp < 0 ? "Dưới vốn " : ""}{(l.marginBp / 100).toFixed(1)}%</Badge>) }] : []),
          ]} />
          <div className="totals"><div className="grand"><span>Tạm tính</span><span className="money">{money(q.subtotal)}</span></div></div>
          {q.note && <div className="small muted">Ghi chú: {q.note}</div>}
          <div className="row wrap">
            <a className="btn soft" href={downloadHref(`/quotes/${q.id}/pdf`)} target="_blank" rel="noreferrer">Mở PDF báo giá</a>
            {q.status === "draft" && can("b2b.write") && <Button loading={busy} onClick={send}>Gửi khách</Button>}
            {["draft", "sent"].includes(q.status) && can("b2b.write") && <Button variant="soft" onClick={() => setMode("convert")}>Chuyển thành đơn</Button>}
            {["draft", "sent", "expired"].includes(q.status) && can("b2b.approve") && <Button variant="ghost" onClick={() => setMode("extend")}>Gia hạn</Button>}
            {["draft", "pending_approval", "sent"].includes(q.status) && can("b2b.write") && <Button variant="danger" onClick={() => setMode("cancel")}>Huỷ báo giá</Button>}
          </div>
          {q.status === "sent" && <div className="hint">Link PDF gửi khách: <code>/api/v1/quotes/{q.id}/pdf</code></div>}
        </div>
      )}
      {mode === "cancel" && <ReasonSheet title="Huỷ báo giá" confirm="Huỷ báo giá" danger onClose={() => setMode("")} onSubmit={async (reason) => { await post(`/quotes/${id}/cancel`, { reason }); toast("Đã huỷ báo giá", "ok"); setMode(""); reload(); }} />}
      {mode === "extend" && <ExtendSheet id={id} onClose={() => setMode("")} onDone={() => { setMode(""); reload(); }} />}
      {mode === "convert" && q && <ConvertSheet q={q} onClose={() => setMode("")} onDone={() => { setMode(""); reload(); }} onExtend={() => setMode("extend")} />}
    </Sheet>
  );
}

function ExtendSheet({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = useState(7);
  return (
    <ReasonSheet title="Gia hạn báo giá" confirm="Gia hạn" onClose={onClose} onSubmit={async (reason) => { await post(`/quotes/${id}/extend`, { days, reason }); toast("Đã gia hạn", "ok"); onDone(); }}>
      <Input label="Gia hạn thêm (ngày, tối đa 90)" inputMode="numeric" value={String(days)} onChange={(e) => setDays(Math.max(1, Math.min(90, parseInt(e.target.value) || 1)))} />
    </ReasonSheet>
  );
}

function ConvertSheet({ q, onClose, onDone, onExtend }: { q: any; onClose: () => void; onDone: () => void; onExtend: () => void }) {
  const can = useCan();
  const cu = useAsync(() => get(`/customers/${q.customerId}`), [q.customerId]);
  const [addr, setAddr] = useState(""), [date, setDate] = useState(todayVN(1)), [note, setNote] = useState("");
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ kind: "ok" | "blocked" | "expired" | "stock"; data?: any } | null>(null);
  const addrs = (cu.data?.addresses ?? []).filter((a: any) => a.active);
  const addrId = addr || String(addrs.find((a: any) => a.isDefault)?.id ?? addrs[0]?.id ?? "");
  const missing = q.lines.filter((l: any) => l.qty == null && !(qtys[l.productId] > 0));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post(`/quotes/${q.id}/convert`, { addressId: Number(addrId), deliveryDate: date, note: note || undefined, clientUuid: `quote-${q.id}-${Date.now()}`, ...(Object.keys(qtys).length ? { lines: Object.entries(qtys).filter(([, v]) => v > 0).map(([k, v]) => ({ productId: Number(k), qty: v })) } : {}) }, { silent: true });
      setRes({ kind: "ok", data: r });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "credit_blocked") setRes({ kind: "blocked", data: e.details });
        else if (e.code === "quote_expired") setRes({ kind: "expired", data: e.details });
        else if (e.code === "insufficient_stock") setRes({ kind: "stock", data: e.details });
        else toast(e.message, "error");
      }
    } finally { setBusy(false); }
  };
  const warn = res?.data?.warnings ?? [];
  const pname = (pid: number) => q.lines.find((l: any) => l.productId === pid)?.productName ?? `#${pid}`;
  return (
    <Sheet open wide onClose={onClose} title={`Chuyển ${q.code} thành đơn`} footer={!res ? <Button block size="lg" loading={busy} disabled={!addrId || !date || missing.length > 0} onClick={submit}>Tạo đơn & giữ hàng</Button> : undefined}>
      {cu.loading ? <Spinner /> : res?.kind === "ok" ? (
        <div className="stack">
          <Banner tone="info">Đã tạo đơn <b>{res.data.code}</b> — trạng thái {res.data.status === "confirmed" ? "đã giữ hàng" : res.data.status}.</Banner>
          {warn.length > 0 && <Banner>Cảnh báo biên lợi nhuận âm theo giá vốn hiện tại: {warn.map((w: any) => `${pname(w.productId)} (${(w.marginBp / 100).toFixed(1)}%)`).join("; ")}. Giá báo vẫn được giữ.</Banner>}
          <Button onClick={() => navigate(`/b2b-orders/${res.data.id}`)}>Mở đơn {res.data.code}</Button>
        </div>
      ) : res?.kind === "blocked" ? (
        <CreditBlocked details={res.data} orderLink={res.data?.orderId ? <Button onClick={() => navigate(`/b2b-orders/${res.data.orderId}`)}>Mở đơn đã tạo</Button> : undefined} />
      ) : res?.kind === "expired" ? (
        <div className="stack"><Banner tone="danger">Báo giá đã hết hạn ({ymd(res.data?.validUntil)}). Không chuyển thành đơn được.</Banner>{can("b2b.approve") ? <Button onClick={onExtend}>Gia hạn báo giá</Button> : <div className="hint">Nhờ chủ / quản lý gia hạn hoặc tạo báo giá mới.</div>}</div>
      ) : res?.kind === "stock" ? (
        <div className="stack"><Banner>Đơn đã tạo nhưng <b>không đủ tồn</b> để giữ hàng. Mở danh sách đơn sỉ, nhập hàng rồi bấm "Giữ hàng lại".</Banner><Lnk to="/b2b-orders" className="btn">Mở đơn sỉ</Lnk></div>
      ) : (
        <div className="stack">
          <Select label="Địa chỉ giao" value={addrId} onChange={(e) => setAddr(e.target.value)}>{addrs.map((a: any) => <option key={a.id} value={a.id}>{a.label} — {a.address}</option>)}</Select>
          <Input label="Ngày giao" type="date" min={todayVN()} value={date} onChange={(e) => setDate(e.target.value)} />
          {q.lines.filter((l: any) => l.qty == null).map((l: any) => (
            <Input key={l.id} label={`Số lượng ${l.productName} (${unitLabel(l.unit)}) — báo giá chưa có SL`} inputMode="decimal" value={String(qtys[l.productId] ?? "")} onChange={(e) => setQtys({ ...qtys, [l.productId]: parseFloat(e.target.value.replace(",", ".")) || 0 })} />
          ))}
          <TextArea label="Ghi chú đơn" value={note} onChange={(e) => setNote(e.target.value)} />
          <Card className="flat" title="Hệ thống sẽ">
            <div className="small">1) Kiểm tra hạn mức & nợ quá hạn → 2) giữ tồn theo lô. Nếu vượt hạn mức, đơn được tạo và gửi chủ duyệt.</div>
          </Card>
        </div>
      )}
    </Sheet>
  );
}
