import { useEffect, useRef, useState } from "react";
import { Button, Input } from "./ui";

declare global { interface Window { BarcodeDetector?: any } }
/** Quét mã bằng camera (BarcodeDetector) hoặc nhập tay. onCode được gọi mỗi lần có mã mới. */
export function Scanner({ onCode, continuous }: { onCode: (code: string) => void; continuous?: boolean }) {
  const [manual, setManual] = useState("");
  const [cam, setCam] = useState(false);
  const [msg, setMsg] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (!cam) return;
    let stop = false, stream: MediaStream | undefined, last = "", lastAt = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const det = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "code_39", "qr_code", "upc_a"] });
        const loop = async () => {
          if (stop || !video.current) return;
          try {
            const r = await det.detect(video.current);
            const v = r[0]?.rawValue as string | undefined;
            if (v && (v !== last || Date.now() - lastAt > 2500)) {
              last = v; lastAt = Date.now();
              navigator.vibrate?.(60);
              onCode(v);
              if (!continuous) { setCam(false); return; }
            }
          } catch { /* khung hình chưa sẵn sàng */ }
          setTimeout(loop, 200);
        };
        loop();
      } catch { setMsg("Không mở được camera. Hãy cấp quyền hoặc nhập mã thủ công."); setCam(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [cam]); // eslint-disable-line

  const submit = (e: React.FormEvent) => { e.preventDefault(); const c = manual.trim(); if (c) { onCode(c); setManual(""); } };
  return (
    <div className="stack">
      <form className="row" onSubmit={submit} style={{ alignItems: "flex-end" }}>
        <div className="grow"><Input label="Mã vạch / mã lô" value={manual} onChange={(e) => setManual(e.target.value)} inputMode="text" autoComplete="off" /></div>
        <Button type="submit" variant="soft">Tra</Button>
        {supported && <Button variant="ghost" onClick={() => setCam((c) => !c)} aria-pressed={cam}>{cam ? "Tắt camera" : "Quét"}</Button>}
      </form>
      {!supported && <div className="hint">Thiết bị không hỗ trợ quét bằng camera — nhập mã thủ công hoặc dùng máy quét USB.</div>}
      {msg && <div className="err" role="alert">{msg}</div>}
      {cam && <div className="scanbox"><video ref={video} muted playsInline aria-label="Camera quét mã" /><div className="line" /></div>}
    </div>
  );
}
