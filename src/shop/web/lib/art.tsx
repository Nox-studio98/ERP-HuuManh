import { strHash } from "./format";

const PALETTES = [
  { bg: ["#fde7e4", "#fbd0cb"], a: "#e5483e", b: "#b92a2a", leaf: "#3f9a4a" }, // táo đỏ / cherry
  { bg: ["#fff3d1", "#ffe19a"], a: "#fbbf24", b: "#f08a1c", leaf: "#4a9d48" }, // xoài / lê
  { bg: ["#ffe9d1", "#ffd2a3"], a: "#fb9a2e", b: "#e56b12", leaf: "#3e9b4b" }, // cam
  { bg: ["#ece4fa", "#d9c9f3"], a: "#8a5bd0", b: "#5d3a9e", leaf: "#4a9d58" }, // nho / việt quất
  { bg: ["#e3f3d9", "#c9e8b5"], a: "#8fcf4a", b: "#4f9d2a", leaf: "#2f7d3a" }, // kiwi / lê xanh
  { bg: ["#fde2ee", "#f9c4dc"], a: "#ec4a93", b: "#b8246b", leaf: "#3f9a4a" }, // thanh long
];

/** Minh hoạ trái cây dùng khi sản phẩm chưa có ảnh (SVG, xác định theo tên → mỗi sản phẩm một màu/hình riêng). */
export function FruitArt({ seed, className }: { seed: string; className?: string }) {
  const h = strHash(seed || "x");
  const p = PALETTES[h % PALETTES.length];
  const v = Math.floor(h / 7) % 5;
  const id = `fa${h}`;
  return (
    <svg className={className} viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={p.bg[0]} /><stop offset="1" stopColor={p.bg[1]} /></linearGradient>
        <radialGradient id={`${id}f`} cx="0.35" cy="0.3" r="0.8"><stop offset="0" stopColor={p.a} /><stop offset="1" stopColor={p.b} /></radialGradient>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={p.leaf} /><stop offset="1" stopColor="#1f6a2e" /></linearGradient>
      </defs>
      <rect width="400" height="300" fill={`url(#${id}b)`} />
      <circle cx="338" cy="52" r="70" fill="#fff" opacity=".35" />
      <circle cx="40" cy="270" r="90" fill="#fff" opacity=".25" />
      <ellipse cx="200" cy="262" rx="104" ry="13" fill="#000" opacity=".1" />
      {v === 0 && (
        <g>
          <path d="M200 92c-34-26-92-8-96 54-3 56 38 112 70 112 14 0 16-6 26-6s12 6 26 6c32 0 70-56 66-112-4-62-62-80-92-54z" fill={`url(#${id}f)`} />
          <path d="M200 96c2-22 12-40 26-52" stroke="#6b4a2a" strokeWidth="7" strokeLinecap="round" fill="none" />
          <path d="M226 52c22-20 52-14 60 4-18 18-46 20-60-4z" fill={`url(#${id}l)`} />
          <ellipse cx="156" cy="150" rx="14" ry="30" fill="#fff" opacity=".35" transform="rotate(18 156 150)" />
        </g>
      )}
      {v === 1 && (
        <g>
          <path d="M200 80c40 0 52 34 48 62-4 26 34 44 34 84 0 38-38 36-82 36s-82 2-82-36c0-40 38-58 34-84-4-28 8-62 48-62z" fill={`url(#${id}f)`} />
          <path d="M200 82c0-18 6-30 16-38" stroke="#6b4a2a" strokeWidth="7" strokeLinecap="round" fill="none" />
          <path d="M216 50c18-18 46-12 54 6-16 16-42 18-54-6z" fill={`url(#${id}l)`} />
          <ellipse cx="164" cy="190" rx="12" ry="30" fill="#fff" opacity=".3" transform="rotate(14 164 190)" />
        </g>
      )}
      {v === 2 && (
        <g>
          <circle cx="200" cy="158" r="100" fill={p.b} />
          <circle cx="200" cy="158" r="90" fill="#fff6dc" />
          <circle cx="200" cy="158" r="80" fill={`url(#${id}f)`} />
          {Array.from({ length: 8 }).map((_, i) => (
            <path key={i} d="M200 158L200 82" stroke="#fff6dc" strokeWidth="5" strokeLinecap="round" transform={`rotate(${i * 45} 200 158)`} />
          ))}
          <circle cx="200" cy="158" r="9" fill="#fff6dc" />
          <path d="M276 78c20-22 48-20 56-2-18 18-44 20-56 2z" fill={`url(#${id}l)`} />
        </g>
      )}
      {v === 3 && (
        <g>
          {[[150, 170, 46], [222, 160, 52], [186, 218, 44], [262, 214, 38], [120, 224, 34]].map(([x, y, r], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r={r} fill={`url(#${id}f)`} />
              <circle cx={x - r * 0.3} cy={y - r * 0.35} r={r * 0.2} fill="#fff" opacity=".4" />
            </g>
          ))}
          <path d="M190 120c10-26 34-36 56-30-6 24-30 40-56 30z" fill={`url(#${id}l)`} />
        </g>
      )}
      {v === 4 && (
        <g>
          <path d="M70 140a130 130 0 0 0 260 0z" fill={p.leaf} />
          <path d="M82 140a118 118 0 0 0 236 0z" fill="#f4f9e9" />
          <path d="M94 140a106 106 0 0 0 212 0z" fill={`url(#${id}f)`} />
          {[[150, 176], [200, 196], [250, 176], [176, 222], [226, 224]].map(([x, y], i) => (
            <ellipse key={i} cx={x} cy={y} rx="5" ry="9" fill="#2b1a14" opacity=".75" transform={`rotate(${i * 20 - 30} ${x} ${y})`} />
          ))}
        </g>
      )}
    </svg>
  );
}

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="18" fill="var(--brand)" />
      <path d="M32 20c-12-9-22 2-19 14 3 11 12 18 19 18s16-7 19-18c3-12-7-23-19-14z" fill="#fff" opacity=".95" />
      <path d="M33 21c1-7 5-11 11-13 1 7-3 11-11 13z" fill="var(--accent)" />
    </svg>
  );
}
