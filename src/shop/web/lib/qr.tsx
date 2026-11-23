import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** Mã QR (SVG, dựng ở trình duyệt) từ chuỗi bất kỳ — dùng cho VietQR. */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label?: string }) {
  const { path, n } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!q.isDark(r, c)) { c++; continue; }
        let e = c;
        while (e < n && q.isDark(r, e)) e++;
        d += `M${c} ${r}h${e - c}v1h-${e - c}z`;
        c = e;
      }
    }
    return { path: d, n };
  }, [value]);
  const quiet = 3;
  return (
    <svg className="qr" width={size} height={size} viewBox={`${-quiet} ${-quiet} ${n + quiet * 2} ${n + quiet * 2}`} role="img" aria-label={label ?? "Mã QR chuyển khoản"} shapeRendering="crispEdges" data-testid="qr">
      <rect x={-quiet} y={-quiet} width={n + quiet * 2} height={n + quiet * 2} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}
