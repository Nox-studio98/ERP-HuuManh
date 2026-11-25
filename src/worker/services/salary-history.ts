/**
 * C-18: lịch sử lương theo ngày hiệu lực (bảng employee_salary_history, chỉ API hr.sensitive đọc được).
 * Giá trị tại ngày D = new_value của bản ghi mới nhất có effective_date <= D; chưa có bản ghi <= D mà có bản ghi sau D
 * thì lấy old_value của bản ghi sớm nhất sau D; không có bản ghi nào thì lấy giá trị hiện hành.
 */
export interface HistRow { id: number; employee_id: number; field: string; ref_id: number | null; old_value: number; new_value: number; effective_date: string }

export function valueAsOf(rows: HistRow[], current: number, date: string): number {
  if (!rows.length) return current;
  const sorted = [...rows].sort((a, b) => (a.effective_date === b.effective_date ? a.id - b.id : a.effective_date < b.effective_date ? -1 : 1));
  let v: number | null = null;
  for (const r of sorted) if (r.effective_date <= date) v = r.new_value;
  return v ?? sorted[0].old_value;
}

/** Giá trị của kỳ 'YYYY-MM' = trung bình theo từng ngày lịch (đổi lương giữa tháng thì mỗi ngày dùng mức đúng của ngày đó). */
export function periodValue(rows: HistRow[], current: number, period: string): number {
  if (!rows.length) return current;
  const [y, m] = period.split("-").map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let sum = 0;
  for (let d = 1; d <= dim; d++) sum += valueAsOf(rows, current, `${period}-${String(d).padStart(2, "0")}`);
  return Math.round(sum / dim);
}

export const pick = (rows: HistRow[], employeeId: number, field: string, refId: number | null = null) =>
  rows.filter((r) => r.employee_id === employeeId && r.field === field && (r.ref_id ?? null) === refId);
