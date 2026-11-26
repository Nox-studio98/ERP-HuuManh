/**
 * Bản in báo cáo dùng chung (Báo cáo cuối ngày, Phiếu bàn giao ca): khổ A4 hoặc giấy nhiệt 80mm bằng CSS print.
 * `PrintDoc` luôn nằm trong DOM nhưng ẩn trên màn hình; chỉ hiện khi in (xem `.rpt-doc` trong app.css).
 * `usePrintDoc()` trả `{ paper, print }`: `print("a4" | "80")` đặt khổ giấy (@page) rồi gọi window.print().
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";

export type Paper = "a4" | "80";
export type DocSection = {
  heading?: string;
  /** cặp nhãn – giá trị; phần tử thứ 3 = true để in đậm */
  kv?: [string, ReactNode, boolean?][];
  table?: { head: string[]; rows: ReactNode[][]; foot?: ReactNode[]; /** các cột căn phải (chỉ số) */ right?: number[] };
  note?: ReactNode;
};

const PAGE_STYLE_ID = "rpt-page-style";
function setPage(paper: Paper) {
  let el = document.getElementById(PAGE_STYLE_ID) as HTMLStyleElement | null;
  if (!el) { el = document.createElement("style"); el.id = PAGE_STYLE_ID; document.head.appendChild(el); }
  el.textContent = paper === "80" ? "@page { size: 80mm auto; margin: 3mm; }" : "@page { size: A4; margin: 14mm; }";
}

export function usePrintDoc(defaultPaper: Paper = "a4") {
  const [paper, setPaper] = useState<Paper>(defaultPaper);
  useEffect(() => () => { document.getElementById(PAGE_STYLE_ID)?.remove(); }, []);
  const print = (p: Paper) => {
    setPaper(p); setPage(p);
    // chờ React vẽ lại bản in theo khổ mới rồi mới mở hộp thoại in
    setTimeout(() => window.print(), 60);
  };
  return { paper, print };
}

export function PrintButtons({ print, disabled }: { print: (p: Paper) => void; disabled?: boolean }) {
  return (
    <>
      <Button size="sm" variant="soft" disabled={disabled} onClick={() => print("a4")}>In A4</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => print("80")}>In 80mm</Button>
    </>
  );
}

export function PrintDoc({ paper, store = "CỬA HÀNG TRÁI CÂY HỮU MẠNH", title, meta, sections, footer }: { paper: Paper; store?: string; title: string; meta?: string; sections: DocSection[]; footer?: ReactNode }) {
  // Khổ 80mm: bỏ ký hiệu ₫ trong bảng cho vừa khổ giấy hẹp
  const cell = (c: ReactNode) => (paper === "80" && typeof c === "string" ? c.replace(/\s*₫/g, "") : c);
  // Portal ra body: không bị lệch vị trí khi nằm trong khung chi tiết (position: sticky)
  return createPortal(
    <div className={"print-area rpt-doc paper-" + paper} aria-hidden="true" data-testid="print-doc">
      <div className="rpt-store">{store}</div>
      <div className="rpt-title">{title}</div>
      {meta && <div className="rpt-meta">{meta}</div>}
      {sections.map((s, i) => (
        <section key={i} className="rpt-sec">
          {s.heading && <div className="rpt-h">{s.heading}</div>}
          {s.kv?.map(([k, v, b], j) => <div key={j} className={"rpt-kv" + (b ? " b" : "")}><span>{k}</span><span>{v}</span></div>)}
          {s.table && (
            <table className="rpt-table">
              <thead><tr>{s.table.head.map((h, j) => <th key={j} className={s.table!.right?.includes(j) ? "r" : ""}>{h}</th>)}</tr></thead>
              <tbody>{s.table.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} className={s.table!.right?.includes(k) ? "r" : ""}>{cell(c)}</td>)}</tr>)}</tbody>
              {s.table.foot && <tfoot><tr>{s.table.foot.map((c, k) => <td key={k} className={s.table!.right?.includes(k) ? "r" : ""}>{cell(c)}</td>)}</tr></tfoot>}
            </table>
          )}
          {s.note && <div className="rpt-note">{s.note}</div>}
        </section>
      ))}
      {footer && <div className="rpt-foot">{footer}</div>}
    </div>,
    document.body,
  );
}
