import { code128Svg } from "../barcode128";
export function Barcode({ value }: { value: string }) {
  const { width, height, rects } = code128Svg(value, { height: 70, module: 2 });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Mã vạch ${value}`} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", maxWidth: 360 }}>
      <rect width={width} height={height} fill="#fff" />
      {rects.map((r, i) => <rect key={i} x={r.x} y={0} width={r.w} height={height} fill="#000" />)}
    </svg>
  );
}
