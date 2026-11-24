/** Xuất CSV phía trình duyệt (mở được bằng Excel: có BOM UTF-8, dòng CRLF, chống CSV-injection như phía máy chủ). */
export const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // chuỗi bắt đầu bằng = + - @ tab CR bị Excel hiểu là công thức → thêm dấu nháy; số thật (number) giữ nguyên
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
export const toCsv = (header: string[], rows: unknown[][]) => "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const blob = new Blob([toCsv(header, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename.endsWith(".csv") ? filename : filename + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
