import { money, num } from "../format";

export function BarChart({ data, height = 180, format = money }: { data: { label: string; value: number }[]; height?: number; format?: (n: number) => string }) {
  const W = 560, padL = 8, padB = 22, padT = 16;
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = (W - padL * 2) / Math.max(1, data.length);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={"Biểu đồ cột: " + data.map((d) => `${d.label} ${format(d.value)}`).join(", ")}>
      <line className="axis" x1={padL} x2={W - padL} y1={height - padB} y2={height - padB} />
      {data.map((d, i) => {
        const h = Math.max(1, ((height - padB - padT) * Math.max(0, d.value)) / max);
        const x = padL + i * bw + bw * 0.15, w = bw * 0.7;
        return (
          <g key={i}>
            <rect className="bar" x={x} y={height - padB - h} width={w} height={h} rx={3}><title>{`${d.label}: ${format(d.value)}`}</title></rect>
            {data.length <= 12 && <text x={x + w / 2} y={height - 6} textAnchor="middle">{d.label.length > 8 ? d.label.slice(-5) : d.label}</text>}
            {data.length <= 7 && d.value > 0 && <text x={x + w / 2} y={height - padB - h - 4} textAnchor="middle">{num(Math.round(d.value / 1000))}k</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function LineChart({ points, height = 160 }: { points: { label: string; value: number }[]; height?: number }) {
  const W = 560, p = 24;
  if (points.length < 1) return null;
  const vs = points.map((x) => x.value);
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const X = (i: number) => p + (points.length === 1 ? (W - 2 * p) / 2 : (i * (W - 2 * p)) / (points.length - 1));
  const Y = (v: number) => height - p - ((v - min) / span) * (height - 2 * p);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={"Biểu đồ giá: " + points.map((x) => `${x.label} ${money(x.value)}`).join(", ")}>
      <line className="axis" x1={p} x2={W - p} y1={height - p} y2={height - p} />
      <polyline className="ln" points={points.map((x, i) => `${X(i)},${Y(x.value)}`).join(" ")} />
      {points.map((x, i) => <circle key={i} className="pt" cx={X(i)} cy={Y(x.value)} r={4}><title>{`${x.label}: ${money(x.value)}`}</title></circle>)}
      <text x={p} y={12}>{money(max)}</text>
      <text x={p} y={height - 6}>{points[0].label}</text>
      <text x={W - p} y={height - 6} textAnchor="end">{points[points.length - 1].label}</text>
    </svg>
  );
}
