import { useEffect, useState } from "react";
import { get, items, put } from "../../api";
import { Banner, Button, Card, Input, Spinner, useAsync } from "../../components/ui";
import { toast } from "../../components/toast";

/** Cấu hình cửa hàng cho chấm công GPS: toạ độ + bán kính hợp lệ (audit C-07). */
export default function Stores() {
  const l = useAsync(() => get("/stores").then((r) => items<any>(r)), []);
  if (l.loading) return <Spinner />;
  return (
    <div className="stack" data-testid="stores">
      <h2 style={{ margin: 0 }}>Cửa hàng & vị trí chấm công</h2>
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
      <div className="stack">
        {s.lat == null && <Banner>Cửa hàng chưa có toạ độ — chấm công GPS đang bị chặn.</Banner>}
        <div className="grid2">
          <Input label="Vĩ độ" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          <Input label="Kinh độ" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
        </div>
        <Input label="Bán kính cho phép (mét)" inputMode="numeric" value={fence} onChange={(e) => setFence(e.target.value)} />
        {err && <div className="small" style={{ color: "var(--danger)" }}>{err}</div>}
        <div className="row wrap">
          <Button variant="soft" loading={locating} onClick={locate}>Lấy vị trí hiện tại</Button>
          <Button loading={busy} onClick={save} className="grow">Lưu</Button>
        </div>
      </div>
    </Card>
  );
}
