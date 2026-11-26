/**
 * Kiểu dữ liệu và nhãn của màn Bảng chấm công — bám sát docs/API-attendance-board.md (mục 1, 2).
 * Mọi chỗ khác chỉ import từ file này; đổi hợp đồng API thì sửa ở đây.
 */
export type CellStatus = "on_time" | "late_early" | "incomplete" | "not_yet" | "leave" | "auto" | "upcoming" | "working";

export type BoardShift = { id: number; name: string; startTime: string; endTime: string; active: boolean };
export type BoardEmployee = { id: number; code: string; name: string; position?: string | null };
export type BoardCellT = {
  key: string; assignmentId: number | null; employeeId: number; workDate: string; shiftId: number | null;
  startAt: string | null; endAt: string | null; inAt: string | null; outAt: string | null;
  status: CellStatus; lateMinutes: number; earlyMinutes: number; otMinutes: number; workedMinutes: number;
  pending: number; leaveCode: string | null; leavePaid: boolean | null; substituteForId: number | null;
  /** số lần; tiền (amountPenalty / amountBonus) chỉ có khi người xem có quyền */
  incidents: { penalty: number; bonus: number; amountPenalty?: number; amountBonus?: number };
  manual: boolean;
};
export type BoardResp = {
  from: string; to: string; today: string; mode: "shift" | "window";
  shifts: BoardShift[]; employees: BoardEmployee[]; cells: BoardCellT[];
  pendingTotal: number; periodsClosed: string[];
};

export type CellPunch = {
  id: number; kind: "in" | "out"; at: string; method: string; status: "accepted" | "pending" | "rejected";
  note?: string | null; createdByName?: string | null; decidedByName?: string | null; decidedAt?: string | null;
};
export type CellIncident = {
  id: number; kind: "penalty" | "bonus"; typeId?: number; typeName: string; times: number;
  amountEach?: number; amount?: number; note?: string | null; createdByName?: string | null; createdAt?: string; voided?: boolean;
};
export type CellHistoryRow = { at: string; action: string; byName?: string | null; detail?: string | null };
export type CellDetail = {
  cell: BoardCellT; punches: CellPunch[]; corrections: any[]; incidents: CellIncident[]; history: CellHistoryRow[];
};
export type IncidentType = { id: number; kind: "penalty" | "bonus"; name: string; defaultAmount?: number; active: boolean };
export type ManualType = "work" | "paid_leave" | "unpaid_leave";

/** nhãn + lớp màu (CSS .st-<status>) */
export const STATUS: Record<CellStatus, { label: string }> = {
  on_time: { label: "Đúng giờ" },
  late_early: { label: "Đi muộn / Về sớm" },
  incomplete: { label: "Chấm công thiếu" },
  not_yet: { label: "Chưa chấm công" },
  leave: { label: "Nghỉ làm" },
  auto: { label: "Đúng giờ (tự động)" },
  upcoming: { label: "Chưa tới giờ" },
  working: { label: "Đang làm" },
};
/** 5 mục chú thích cố định ở đáy bảng */
export const LEGEND: CellStatus[] = ["on_time", "late_early", "incomplete", "not_yet", "leave"];

export const METHOD_LABEL: Record<string, string> = { gps: "GPS", qr: "Mã QR", offline: "Offline", exempt: "Miễn vị trí", manual: "Thủ công" };
