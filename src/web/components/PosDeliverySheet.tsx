/**
 * POS-KV đợt B3: sheet "Giao hàng" của quầy. Người nhận + địa chỉ + khu vực/phí giao + người giao (nhân viên | xe ngoài)
 * + trả trước / thu hộ COD → POST /pos/delivery-orders (đơn sang thẳng "Đang giao"), rồi in phiếu giao 80mm.
 */
import { useEffect, useState } from "react";
import { ApiError, get, post } from "../api";
import { fmtDateTime, METHODS, money, qtyText, uuid } from "../format";
import { Banner, Button, Input, MoneyInput, Segmented, Select, Sheet, TextArea, useAsync } from "./ui";
import { Barcode } from "./Barcode";
import { toast } from "./toast";

export type DeliveryLine = { productId: number; name: string; unit: string; qty: number };
type Zone = { id: number; name: string; districts: string[]; fee: number; freeOver: number | null; minOrder: number };
type Result = { id: number; code: string; total: number; prepay: number; cod: number; trackingUrl: string };
const PAY_METHODS = ["cash", "transfer", "qr", "card", "ewallet"] as const;

export function PosDeliverySheet({ lines, customer, hasManualDiscount, onClose, onDone }: {
  lines: DeliveryLine[];
  customer: { id: number; name: string; phone?: string | null } | null;
  hasManualDiscount: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(customer?.name ?? "");
  const [phone, setPhone] = useState(customer?.phone && !customer.phone.includes("*") ? customer.phone : "");
  const [address, setAddress] = useState("");
  const [zoneId, setZoneId] = useState(0);
  const [fee, setFee] = useState(0);
  const [who, setWho] = useState<"staff" | "carrier">("staff");
  const [staffId, setStaffId] = useState(0);
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [mode, setMode] = useState<"cod" | "part" | "full">("cod");
  const [prepayAmt, setPrepayAmt] = useState(0);
  const [method, setMethod] = useState<(typeof PAY_METHODS)[number]>("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [uid] = useState(() => uuid());
  const [res, setRes] = useState<Result | null>(null);
  const [snap, setSnap] = useState<{ name: string; phone: string; address: string; deliverer: string; lines: DeliveryLine[] } | null>(null);

  const zones = useAsync(async () => ((await get("/pos/delivery-zones", undefined, { silent: true })).items ?? []) as Zone[], []);
  const staff = useAsync(async () => ((await get("/pos/deliverers", undefined, { silent: true })).items ?? []) as { id: number; fullName: string }[], []);
  const addrs = useAsync(async () => (customer ? await get("/pos/delivery-addresses", { customerId: customer.id }, { silent: true }) : null), [customer?.id]);
  const linesKey = JSON.stringify(lines.map((l) => [l.productId, l.unit, l.qty]));
  const quote = useAsync(async () => (await post("/pos/delivery-quote", { ...(customer ? { customerId: customer.id } : {}), lines: lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty })) }, { silent: true })).subtotal as number, [linesKey, customer?.id]);

  useEffect(() => { if (addrs.data?.receiverName && !name) setName(addrs.data.receiverName); if (addrs.data?.receiverPhone && !phone) setPhone(addrs.data.receiverPhone); }, [addrs.data]); // eslint-disable-line
  useEffect(() => { if (!staffId && staff.data?.length) setStaffId(staff.data[0].id); }, [staff.data]); // eslint-disable-line

  const subtotal = quote.data ?? 0;
  const total = subtotal + fee;
  const pickZone = (id: number) => {
    setZoneId(id);
    const z = zones.data?.find((x) => x.id === id);
    if (z) setFee(z.freeOver != null && subtotal >= z.freeOver ? 0 : z.fee);
  };
  const prepay = mode === "cod" ? 0 : mode === "full" ? total : Math.min(prepayAmt, total);
  const cod = total - prepay;
  const phoneOk = /^[0-9+ ().-]{8,16}$/.test(phone.trim());
  const delivererOk = who === "staff" ? staffId > 0 : carrier.trim().length > 0;
  const valid = !!name.trim() && phoneOk && address.trim().length >= 3 && delivererOk && quote.data != null && total > 0 && (mode !== "part" || (prepayAmt > 0 && prepayAmt < total));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post("/pos/delivery-orders", {
        clientUuid: uid,
        ...(customer ? { customerId: customer.id } : {}),
        receiver: { name: name.trim(), phone: phone.trim(), address: address.trim(), ...(zoneId ? { zoneId } : {}) },
        lines: lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty })),
        shippingFee: fee,
        deliverer: who === "staff" ? { userId: staffId } : { carrier: carrier.trim(), ...(tracking.trim() ? { trackingNo: tracking.trim() } : {}) },
        prepay: prepay > 0 ? [{ method, amount: prepay }] : [],
        cod,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setSnap({ name: name.trim(), phone: phone.trim(), address: address.trim(), deliverer: who === "staff" ? staff.data?.find((s) => s.id === staffId)?.fullName ?? "" : `${carrier.trim()}${tracking.trim() ? ` · ${tracking.trim()}` : ""}`, lines });
      setRes(r as Result);
      toast(`Đã tạo đơn giao ${(r as Result).code} — đang giao`, "ok");
    } catch (e) {
      if (e instanceof ApiError && e.code === "payment_mismatch") { quote.reload(); toast("Tổng đơn vừa thay đổi, đã cập nhật lại — kiểm tra rồi bấm tạo lại", "error"); }
    } finally { setBusy(false); }
  };

  if (res && snap) {
    return (
      <Sheet open onClose={onDone} title="Đã tạo đơn giao hàng" footer={<Button block size="lg" onClick={onDone}>Đơn mới</Button>}>
        <div className="stack">
          <Banner tone="info">Đơn <b>{res.code}</b> đã sang <b>Đang giao</b>. Hàng đã trừ kho; doanh thu ghi khi giao xong ở màn Đơn online.</Banner>
          <DeliverySlip code={res.code} total={res.total} cod={res.cod} prepay={res.prepay} trackingUrl={res.trackingUrl} {...snap} />
          <Button block variant="soft" data-testid="print-slip" onClick={() => window.print()}>In phiếu giao 80mm</Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={onClose} title="Giao hàng" wide footer={
      <Button block size="lg" loading={busy} disabled={!valid} data-testid="delivery-submit" onClick={submit}>Tạo đơn giao · {money(total)}</Button>
    }>
      <div className="stack" data-testid="delivery-sheet">
        <div className="totals" data-testid="delivery-totals">
          <div><span className="muted">Tiền hàng</span><span className="money">{quote.loading ? "…" : money(subtotal)}</span></div>
          <div><span className="muted">Phí giao</span><span className="money">{money(fee)}</span></div>
          <div className="grand"><span>Tổng</span><span className="money">{money(total)}</span></div>
          <div><span className="muted">Trả trước tại quầy</span><span className="money">{money(prepay)}</span></div>
          <div><span className="muted">Người giao thu hộ (COD)</span><b className="money" data-testid="delivery-cod">{money(cod)}</b></div>
        </div>
        {hasManualDiscount && <Banner tone="info">Đơn giao hàng tính theo giá bán online và không áp giảm giá tay trong giỏ.</Banner>}
        <div className="grid2">
          <Input label="Người nhận" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          <Input label="Số điện thoại" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={phone && !phoneOk ? "Số điện thoại chưa hợp lệ" : undefined} />
        </div>
        {addrs.data?.items?.length > 0 && (
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }} aria-label="Gợi ý địa chỉ">
            {addrs.data.items.map((a: { label: string; address: string }, i: number) => (
              <Button key={i} size="sm" variant="soft" onClick={() => setAddress(a.address)} title={a.address}>{a.label}: {a.address.length > 36 ? a.address.slice(0, 34) + "…" : a.address}</Button>
            ))}
          </div>
        )}
        <TextArea label="Địa chỉ giao" rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
        <Select label="Khu vực giao" value={String(zoneId)} onChange={(e) => pickZone(Number(e.target.value))}>
          <option value="0">Chọn khu vực (gợi ý phí)</option>
          {(zones.data ?? []).map((z) => <option key={z.id} value={z.id}>{z.name} · {money(z.fee)}</option>)}
        </Select>
        <MoneyInput label="Phí giao (₫)" value={fee} onChange={setFee} hint="Sửa được; ghi vào phí giao của đơn" />

        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl">Người giao</span>
          <Segmented value={who} onChange={setWho} options={[{ v: "staff", label: "Nhân viên" }, { v: "carrier", label: "Xe ngoài" }]} />
          {who === "staff" ? (
            <Select label="Nhân viên giao" value={String(staffId)} onChange={(e) => setStaffId(Number(e.target.value))}>
              {(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </Select>
          ) : (
            <div className="grid2">
              <Input label="Tên hãng / xe" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="Grab, Ahamove, xe tải…" />
              <Input label="Mã vận đơn (nếu có)" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl">Thanh toán</span>
          <Segmented value={mode} onChange={setMode} options={[{ v: "cod", label: "Thu hộ COD" }, { v: "part", label: "Trả một phần" }, { v: "full", label: "Trả đủ" }]} />
          {mode !== "cod" && (
            <div className="grid2">
              <Select label="Hình thức trả trước" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {PAY_METHODS.map((m) => <option key={m} value={m}>{METHODS[m] ?? m}</option>)}
              </Select>
              {mode === "part" ? <MoneyInput label="Số trả trước (₫)" value={prepayAmt} onChange={setPrepayAmt} /> : <div className="field"><span className="lbl">Số trả trước</span><b className="money">{money(total)}</b></div>}
            </div>
          )}
        </div>
        <Input label="Ghi chú giao hàng (không bắt buộc)" value={note} onChange={(e) => setNote(e.target.value)} />

      </div>
    </Sheet>
  );
}

/** Phiếu giao 80mm: người nhận, địa chỉ, số thu hộ, mã đơn + mã vạch. Dùng khuôn `.receipt print-area` của hoá đơn. */
function DeliverySlip({ code, total, cod, prepay, trackingUrl, name, phone, address, deliverer, lines }: { code: string; total: number; cod: number; prepay: number; trackingUrl: string; name: string; phone: string; address: string; deliverer: string; lines: DeliveryLine[] }) {
  return (
    <>
      <style>{`@media print { @page { size: 80mm auto; margin: 3mm; } }`}</style>
      <div className="receipt print-area" aria-label="Phiếu giao hàng" data-testid="delivery-slip">
        <div style={{ textAlign: "center", fontWeight: 700 }}>CỬA HÀNG TRÁI CÂY HỮU MẠNH</div>
        <div style={{ textAlign: "center" }}>PHIẾU GIAO HÀNG</div>
        <hr />
        <div className="l"><span>Mã đơn</span><b>{code}</b></div>
        <div className="l"><span>Ngày</span><span>{fmtDateTime(new Date().toISOString())}</span></div>
        <hr />
        <div style={{ fontWeight: 700 }}>NGƯỜI NHẬN</div>
        <div>{name}</div>
        <div style={{ fontWeight: 700, fontSize: "1.05em" }}>{phone}</div>
        <div style={{ whiteSpace: "pre-wrap" }}>{address}</div>
        <hr />
        {lines.map((l, i) => <div key={i} className="l"><span>{l.name}</span><span>{qtyText(Math.round(l.qty * 1000), l.unit)}</span></div>)}
        <hr />
        <div className="l"><span>Tổng đơn</span><span>{money(total)}</span></div>
        {prepay > 0 && <div className="l"><span>Đã trả trước</span><span>-{money(prepay)}</span></div>}
        <div className="l" style={{ fontWeight: 800, fontSize: "1.2em" }}><span>THU HỘ</span><span>{money(cod)}</span></div>
        {deliverer && <div className="l"><span>Người giao</span><span>{deliverer}</span></div>}
        <hr />
        <div style={{ display: "grid", placeItems: "center" }}><Barcode value={code} /></div>
        <div style={{ textAlign: "center" }}>{code}</div>
        <div style={{ textAlign: "center", fontSize: ".8em", wordBreak: "break-all" }} data-testid="slip-track">Tra cứu: {trackingUrl}</div>
      </div>
    </>
  );
}
