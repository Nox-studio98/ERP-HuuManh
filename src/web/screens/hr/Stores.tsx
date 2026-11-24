import { useEffect, useState } from "react";
import { get, items, put } from "../../api";
import { Banner, Button, Card, Input, Spinner, useAsync } from "../../components/ui";
import { PageHeader } from "../../components/list";
import { toast } from "../../components/toast";

/** Cấu hình cửa hàng cho chấm công GPS: toạ độ + bán kính hợp lệ (audit C-07). */
export default function Stores() {
  const l = useAsync(() => get("/stores").then((r) => items<any>(r)), []);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack" data-testid="stores">
      <PageHeader subtitle="Cửa hàng & vị trí chấm công" />
      <div className="hint">Nhân viên chỉ chấm công bằng GPS được khi cửa hàng đã có toạ độ. Hãy đứng tại cửa hàng và bấm "Lấy vị trí hiện tại".</div>
      {(l.data ?? []).map((s) => <StoreCard key={s.id} s={s} onSaved={l.reload} />)}
    </div>
  );
}

function StoreCard({ s, onSaved }: { s: any; onSaved: () => void }) {
  const [lat, setLat] = useState(s.lat == null ? "" : String(s.lat));
  const [lng, setLng] = useState(s.lng == null ? "" : String(s.lng));
  const [fence, setFence] = useState(String(s.geofenceM ?? 100));
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setLat(s.lat == null ? "" : String(s.lat)); setLng(s.lng == null ? "" : String(s.lng)); setFence(String(s.geofenceM ?? 100)); }, [s]);

  const locate = () => {
    if (!navigator.geolocation) { setErr("Thiết bị không hỗ trợ định vị"); return; }
    setLocating(true); setErr("");
    navigator.geolocation.getCurrentPosition(
      (p) => { setLat(p.coords.latitude.toFixed(6)); setLng(p.coords.longitude.toFixed(6)); setLocating(false); toast(`Đã lấy vị trí (sai số ~${Math.round(p.coords.accuracy)} m)`, "ok"); },
      () => { setLocating(false); setErr("Không lấy được vị trí. Hãy cho phép truy cập vị trí hoặc nhập tay."); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  const save = async () => {
    setErr("");
    const la = lat.trim() === "" ? null : Number(lat), ln = lng.trim() === "" ? null : Number(lng), g = Number(fence);
    if ((la == null) !== (ln == null)) { setErr("Nhập đủ cả vĩ độ và kinh độ"); return; }
    if ((la != null && (!Number.isFinite(la) || la < -90 || la > 90)) || (ln != null && (!Number.isFinite(ln) || ln < -180 || ln > 180))) { setErr("Toạ độ không hợp lệ"); return; }
    if (!Number.isInteger(g) || g < 10 || g > 2000) { setErr("Bán kính phải từ 10 đến 2000 mét"); return; }
    setBusy(true);
    try { await put(`/stores/${s.id}`, { lat: la, lng: ln, geofenceM: g }); toast("Đã lưu cấu hình cửa hàng", "ok"); onSaved(); } catch { /* toast */ } finally { setBusy(false); }
  };
  return (
    <Card title={`${s.name} (${s.code})`}>
      <div className="store-grid">
      <div className="stack">
        {s.lat == null && <Banner>Cửa hàng chưa có toạ độ — chấm công GPS đang bị chặn.</Banner>}
        <div className="grid2">
          <Input label="Vĩ độ" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          <Input label="Kinh độ" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
        </div>
        <Input label="Bán kính cho phép (mét)" inputMode="numeric" value={fence} onChange={(e) => setFence(e.target.value)} />
        {err && <div className="small" style={{ color: "var(--danger)" }}>{err}</div>}
        <div className="row wrap store-actions">
          <Button variant="soft" loading={locating} onClick={locate}>Lấy vị trí hiện tại</Button>
          <Button loading={busy} onClick={save} className="store-save">Lưu</Button>
        </div>
      </div>
      <GeoPreview lat={Number(lat)} lng={Number(lng)} fence={Number(fence)} ok={lat.trim() !== "" && lng.trim() !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))} />
      </div>
    </Card>
  );
}

/** Xem trước vị trí + bán kính chấm công (không dùng bản đồ ngoài): lưới, ghim cửa hàng và vòng bán kính theo tỉ lệ. */
function GeoPreview({ lat, lng, fence, ok }: { lat: number; lng: number; fence: number; ok: boolean }) {
  const R = Math.max(10, Math.min(2000, Number.isFinite(fence) ? fence : 100));
  const view = Math.max(200, R * 1.6); // mét hiển thị từ tâm tới mép
  const r = (R / view) * 80;
  return (
    <div className="geo-prev" aria-label="Xem trước vị trí cửa hàng">
      <svg viewBox="0 0 200 200" role="img" aria-label={ok ? `Vị trí ${lat.toFixed(5)}, ${lng.toFixed(5)}, bán kính ${R} mét` : "Chưa có toạ độ"}>
        <rect x="0" y="0" width="200" height="200" rx="10" className="geo-bg" />
        {[40, 80, 120, 160].map((v) => <g key={v}><line x1={v} y1="0" x2={v} y2="200" className="geo-grid" /><line x1="0" y1={v} x2="200" y2={v} className="geo-grid" /></g>)}
        {ok && <>
          <circle cx="100" cy="100" r={r} className="geo-fence" />
          <path d="M100 112c-6-8-10-13-10-19a10 10 0 0120 0c0 6-4 11-10 19z" className="geo-pin" transform="translate(0 -4)" />
          <circle cx="100" cy="93" r="3.5" fill="#fff" />
          <line x1="100" y1="100" x2={100 + r} y2="100" className="geo-rad" />
          <text x={100 + r / 2} y="94" textAnchor="middle" className="geo-txt">{R} m</text>
        </>}
        {!ok && <text x="100" y="104" textAnchor="middle" className="geo-txt">Chưa có toạ độ</text>}
      </svg>
      {ok && <div className="small muted" style={{ textAlign: "center" }}>{lat.toFixed(6)}, {lng.toFixed(6)} · <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`} target="_blank" rel="noreferrer">Mở bản đồ</a></div>}
    </div>
  );
}
