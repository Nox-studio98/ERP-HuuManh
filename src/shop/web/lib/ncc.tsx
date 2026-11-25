import { createContext, useContext, useEffect } from "react";
import { api, ApiError } from "./api";

/** Cổng nhà cung cấp /ncc: kiểu dữ liệu, nhãn tiếng Việt, ngữ cảnh đăng nhập. API: docs/API-po.md mục 8. */
export interface NccMe { id: number; fullName: string; email: string; phone: string | null; supplier: { name: string; code: string } }
export interface NccOrder {
  id: number; code: string; status: string; sentAt: string | null; expectedDate: string | null; proposedExpectedDate: string | null; overdue: boolean;
  total: number; version: number; confirmedAt: string | null; awaitingYou: boolean; lineCount?: number;
}
export interface NccLine {
  id: number; productName: string; baseUnit: string; orderUnit: string; factor: number; qtyMilli: number; orderQty: number; unitCost: number | null;
  proposedQtyMilli: number | null; proposedUnitCost: number | null; confirmedQtyMilli: number | null; confirmedUnitCost: number | null;
  receivedMilli: number; remainingMilli: number; supplierNote: string | null; lineTotal: number | null;
}
export interface NccOrderDetail extends NccOrder {
  supplierName: string; note: string | null; supplierNote: string | null; storeReply: string | null; canRespond: boolean; lines: NccLine[];
  bills: { code: string; issueDate: string; total: number; provisional: boolean }[]; history: { at: string; label: string; note?: string }[];
}
export interface NccBill { code: string; supplierRef: string | null; provisional: boolean; issueDate: string; dueDate: string; total: number; outstanding: number; poCode: string | null; overdueDays: number }
export interface NccStatementLine { date: string; docType: string; docCode: string; debit: number; credit: number; balance: number; method?: string }

export const STATUS_LABEL: Record<string, string> = {
  sent: "Chờ bạn xác nhận", supplier_proposed: "Chờ cửa hàng xem đề xuất", confirmed: "Đã xác nhận, chờ giao", partially_received: "Đã giao một phần",
  received: "Đã giao đủ", rejected: "Bạn đã từ chối", cancelled: "Cửa hàng đã huỷ", closed: "Đã đóng",
};
export const STATUS_TONE: Record<string, string> = { sent: "warn", supplier_proposed: "info", confirmed: "info", partially_received: "info", received: "ok", rejected: "bad", cancelled: "bad", closed: "" };
export const METHOD_LABEL: Record<string, string> = { cash: "Tiền mặt", transfer: "Chuyển khoản", offset: "Cấn trừ công nợ" };
export const DOC_LABEL: Record<string, string> = {
  bill: "Hoá đơn mua", payment: "Thanh toán", discount: "Chiết khấu thanh toán", write_off: "Điều chỉnh giảm công nợ", return_credit: "Trả hàng nhà cung cấp",
  offset: "Cấn trừ công nợ", opening_balance: "Số dư đầu kỳ",
};

export interface NccCtx { me: NccMe | null; ready: boolean; setMe: (m: NccMe | null) => void }
export const NccAuthContext = createContext<NccCtx>({ me: null, ready: false, setMe: () => {} });
export const useNcc = () => useContext(NccAuthContext);

/** API cổng NCC; 401 (hết phiên) phát sự kiện để NccApp đưa về trang đăng nhập. */
export async function nccApi<T = any>(path: string, o: Parameters<typeof api>[1] = {}): Promise<T> {
  try {
    return await api<T>(`/ncc${path}`, o);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.code === "unauthenticated") window.dispatchEvent(new Event("ncc:unauth"));
    throw e;
  }
}

/** Cổng NCC không được lập chỉ mục. */
export function useNoIndex() {
  useEffect(() => {
    const m = document.createElement("meta");
    m.name = "robots"; m.content = "noindex,nofollow";
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);
}

export const qtyKg = (milli: number, unit: string) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(milli / 1000)} ${unit}`;
export const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // chống CSV-injection
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export function downloadCsv(name: string, rows: unknown[][]) {
  const blob = new Blob(["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
