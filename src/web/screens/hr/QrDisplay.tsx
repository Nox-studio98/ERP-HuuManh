import { useEffect, useState } from "react";
import { get } from "../../api";
import { Banner, Button, Spinner } from "../../components/ui";
import { useAuth } from "../../store";
import { navigate } from "../../router";
import { QrSvg } from "./kit";

/** Màn hình QR chấm công cho máy tính bảng tại cửa hàng: tự làm mới trước khi mã hết hạn. */
export default function QrDisplay() {
  const { user } = useAuth();
  const [q, setQ] = useState<{ code: string; expiresAt: string; windowSeconds: number } | null>(null);
  const [err, setErr] = useState("");
  const [left, setLeft] = useState(0);
  const storeId = user?.storeId ?? 1;

  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await get("/attendance/qr", { storeId }, { silent: true });
        if (!live) return;
        setQ(r); setErr("");
        const wait = Math.max(1000, new Date(r.expiresAt).getTime() - Date.now() - 2000);
        timer = setTimeout(load, wait);
      } catch (e) {
        if (!live) return;
        setErr((e as Error).message || "Không tải được mã QR");
        timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [storeId]);

  useEffect(() => {
    if (!q) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((new Date(q.expiresAt).getTime() - Date.now()) / 1000))), 500);
    return () => clearInterval(t);
  }, [q]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "#fff", color: "#111", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 16 }} data-testid="qr-screen">
      <div style={{ position: "absolute", top: 12, right: 12 }}><Button variant="ghost" size="sm" onClick={() => navigate("/hr/attendance")}>Đóng</Button></div>
      <h1 style={{ margin: 0, textAlign: "center" }}>Quét mã để chấm công</h1>
      {err && <Banner tone="danger">{err}</Banner>}
      {!q ? <Spinner /> : (
        <>
          <QrSvg value={q.code} size={Math.min(560, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.7))} label="Mã QR chấm công" />
          <div className="num" style={{ fontSize: "1.1rem" }}>Mã đổi sau <b>{left}</b> giây</div>
          <div style={{ fontFamily: "monospace", fontSize: ".85rem", color: "#555", wordBreak: "break-all", textAlign: "center" }} data-testid="qr-code">{q.code}</div>
        </>
      )}
      <div style={{ color: "#555", fontSize: ".85rem", textAlign: "center" }}>Nhân viên mở mục Chấm công › Bằng mã QR rồi quét. Mỗi mã chỉ dùng một lần.</div>
    </div>
  );
}
