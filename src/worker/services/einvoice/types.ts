/** Hợp đồng nhà cung cấp hoá đơn điện tử (HĐĐT). */
export interface EInvoiceLine {
  description: string;
  unit: string;
  qtyMilli: number; // milli đơn vị `unit`
  unitPrice: number; // VND / đơn vị chính (theo bảng invoice_lines)
  amount: number; // thành tiền (có thể âm với hoá đơn điều chỉnh giảm)
}

export interface EInvoiceDoc {
  id: number;
  code: string; // số nội bộ HDB-...
  kind: "sale" | "adjustment" | "replacement";
  issueDate: string; // YYYY-MM-DD giờ VN
  subtotal: number;
  vatRateBp: number;
  vatAmount: number;
  total: number;
  buyerName: string | null;
  buyerTaxCode: string | null;
  buyerAddress: string | null;
  buyerEmail: string | null;
  note: string | null;
  lines: EInvoiceLine[];
  /** Số HĐĐT đã phát hành (khi là hoá đơn gốc của một điều chỉnh/huỷ). */
  einvoiceNo?: string | null;
  einvoiceSeries?: string | null;
}

export interface EInvoiceResult {
  einvoiceNo: string;
  series: string;
  lookupCode: string;
}

export interface EInvoiceProvider {
  readonly name: string;
  issue(inv: EInvoiceDoc): Promise<EInvoiceResult>;
  /** Phát hành hoá đơn điều chỉnh cho `original` (đã phát hành). */
  adjust(inv: EInvoiceDoc, original: EInvoiceDoc): Promise<EInvoiceResult>;
  /** Huỷ hoá đơn đã phát hành. */
  cancel(inv: EInvoiceDoc, reason: string): Promise<void>;
}
