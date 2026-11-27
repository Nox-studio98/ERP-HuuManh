import { useRef, useState } from "react";
import { ApiError, get, items, post } from "../api";
import { Banner, Button, DecInput, Input, MoneyInput, Segmented, Select, Sheet, Spinner, TextArea, useAsync, useDebounced } from "./ui";
import { toast } from "./toast";
import { METHODS, money, unitLabel, uuid } from "../format";
import { priceOf, type Product } from "../screens/Pos";
import { useCan } from "../store";

/**
 * G9: "Trả hàng nhanh" tại quầy — khách trả hàng không mang hoá đơn. Hoàn theo GIÁ BÁN HIỆN HÀNH (thu ngân chỉ được sửa giảm), bắt buộc lý do,
 * thu ngân cần quản lý duyệt (quản lý/chủ tự lập): gửi duyệt → hoàn tất khi đã duyệt (cùng mã phiếu, bấm "Hoàn tất" lại). Tiền hoàn lấy từ két ca đang mở khi chọn tiền mặt.
 */
type Line = { product: Product; qty: number; price: number; restock: boolean };

export function PosQuickReturnSheet({ customer, onClose, onDone }: { customer?: { id: number; name: string } | null; onClose: () => void; onDone: (o: any) => void }) {
  const can = useCan();
  const [search, setSearch] = useState("");
  const dq = useDebounced(search, 250);
  const prods = useAsync(() => (dq.trim() ? get("/products", { q: dq, limit: 6, active: 1 }).then((r) => items<Product>(r)) : Promise.resolve([] as Product[])), [dq]);
  const [lines, setLines] = useState<Line[]>([]);
  const [reason, setReason] = useState(""), [method, setMethod] = useState("cash"), [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ id: number } | null>(null);
  const uid = useRef(uuid());

  const total = lines.reduce((s, l) => s + Math.round(l.price * l.qty), 0);
  const ready = lines.length > 0 && lines.every((l) => l.qty > 0 && l.price > 0 && l.price <= priceOf(l.product)) && reason.trim().length >= 3;
  const patch = (id: number, p: Partial<Line>) => setLines((a) => a.map((x) => (x.product.id === id ? { ...x, ...p } : x)));
  const add = (p: Product) => { setLines((a) => (a.some((x) => x.product.id === p.id) ? a : [...a, { product: p, qty: 1, price: priceOf(p), restock: true }])); setSearch(""); };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post("/pos/quick-return", {
        clientUuid: uid.current,
        ...(customer ? { customerId: customer.id } : {}),
        lines: lines.map((l) => ({ productId: l.product.id, unit: l.product.baseUnit, qty: l.qty, ...(l.price !== priceOf(l.product) ? { unitPrice: l.price } : {}), restock: l.restock })),
        reason: reason.trim(), refundMethod: method,
        ...(approval ? { approvalId: approval.id } : {}),
      });
      toast("Đã trả hàng", "ok"); onDone(r);
    } catch (e) {
      if (e instanceof ApiError && e.code === "approval_required") setApproval({ id: e.details?.approvalId });
      else if (e instanceof ApiError && e.code === "approval_invalid") { setApproval(null); uid.current = uuid(); }
    } finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} title="Trả hàng nhanh" wide
      footer={<Button block size="lg" loading={busy} disabled={!ready} data-testid="qr-submit" onClick={submit}>{approval ? "Hoàn tất trả hàng (sau khi duyệt)" : can("approvals.decide") ? "Hoàn tất trả hàng" : "Gửi quản lý duyệt"} · {money(total)}</Button>}>
      <div className="stack" data-testid="quick-return">
        <div className="hint">Khách trả hàng không có hoá đơn. Hoàn theo giá bán hiện hành (chỉ được giảm); thu ngân cần quản lý duyệt.{customer ? <> Khách: <b>{customer.name}</b>.</> : null}</div>
        <Input label="Tìm hàng khách trả" type="search" data-testid="qr-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tên hoặc mã…" />
        {dq.trim() && (prods.loading ? <Spinner /> : (
          <div className="ex-results">
            {(prods.data ?? []).length === 0 ? <div className="muted small">Không tìm thấy hàng phù hợp.</div> : (prods.data ?? []).map((p) => (
              <button key={p.id} type="button" className="ex-pick" onClick={() => add(p)}>
                <span className="n">{p.name}</span><span className="muted small">{priceOf(p) ? `${money(priceOf(p))}/${unitLabel(p.baseUnit)}` : "Chưa có giá"}</span>
              </button>
            ))}
          </div>
        ))}
        {lines.map((l) => (
          <div key={l.product.id} className="qr-line" data-testid="qr-line">
            <div className="row between wrap">
              <div style={{ minWidth: 0 }}><b>{l.product.name}</b><div className="small muted">Giá hiện hành {money(priceOf(l.product))}/{unitLabel(l.product.baseUnit)}</div></div>
              <Button size="sm" variant="ghost" onClick={() => setLines((a) => a.filter((x) => x.product.id !== l.product.id))} aria-label={`Bỏ ${l.product.name}`}>Bỏ</Button>
            </div>
            <div className="qr-grid">
              <DecInput label={`Số lượng (${unitLabel(l.product.baseUnit)})`} value={l.qty} onChange={(n) => patch(l.product.id, { qty: n })} />
              <MoneyInput label="Giá hoàn (₫)" value={l.price} onChange={(n) => patch(l.product.id, { price: n })}
                hint={l.price > priceOf(l.product) ? "Không được cao hơn giá hiện hành" : l.price < priceOf(l.product) ? "Đã giảm so với giá hiện hành" : undefined} />
            </div>
            <Segmented value={l.restock ? "in" : "waste"} onChange={(v) => patch(l.product.id, { restock: v === "in" })} options={[{ v: "in", label: "Nhập lại kho" }, { v: "waste", label: "Hao hụt" }]} />
          </div>
        ))}
        <TextArea label="Lý do trả hàng (bắt buộc)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="qr-reason" />
        <Select label="Hoàn tiền bằng" value={method} onChange={(e) => setMethod(e.target.value)}>
          {["cash", "transfer", "qr", "card", "ewallet"].map((m) => <option key={m} value={m}>{METHODS[m]}{m === "cash" ? " (trừ két ca đang mở)" : ""}</option>)}
        </Select>
        <div className="totals"><div className="grand"><span>Hoàn lại khách</span><span className="money">{money(total)}</span></div></div>
        {approval && <Banner tone="info">Đã gửi yêu cầu duyệt #{approval.id} cho quản lý. Khi quản lý duyệt xong, bấm “Hoàn tất trả hàng” lại (không đổi hàng/số lượng/giá).</Banner>}
      </div>
    </Sheet>
  );
}
