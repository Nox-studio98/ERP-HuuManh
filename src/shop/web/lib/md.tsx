import { Fragment, type ReactNode } from "react";

/** Chỉ cho http(s) hoặc đường dẫn nội bộ ("/x", không phải "//x"). */
export function safeHref(u: string): string | null {
  const s = u.trim();
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  if (/^\/(?![\/\\])[^\s]*$/.test(s)) return s;
  return null;
}

const INLINE = /(\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|`([^`]+?)`|\[([^\]]+?)\]\(([^)\s]+)\))/;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${key}-${n++}`;
    if (m[2] ?? m[3]) out.push(<strong key={k}>{inline((m[2] ?? m[3])!, k)}</strong>);
    else if (m[4] ?? m[5]) out.push(<em key={k}>{inline((m[4] ?? m[5])!, k)}</em>);
    else if (m[6]) out.push(<code key={k}>{m[6]}</code>);
    else {
      const href = safeHref(m[8]);
      if (!href) out.push(<Fragment key={k}>{m[7]}</Fragment>);
      else {
        const external = /^https?:/i.test(href);
        out.push(<a key={k} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>{inline(m[7], k)}</a>);
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Markdown tối giản → React (không dùng innerHTML). Hỗ trợ: đoạn, tiêu đề #..####, **đậm**, *nghiêng*, danh sách -, 1., liên kết, trích dẫn >, ---. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let bi = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${bi++}`;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 5); // # trong bài → h2 (h1 là tiêu đề trang)
      const Tag = `h${level}` as "h2";
      blocks.push(<Tag key={key}>{inline(h[2].trim(), key)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push(<hr key={key} />); i++; continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      blocks.push(<ul key={key}>{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={key}>{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ol>);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(q.join(" "), key)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*>)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className={`md ${className ?? ""}`}>{blocks}</div>;
}
