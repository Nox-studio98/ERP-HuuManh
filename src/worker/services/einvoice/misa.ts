import type { Env } from "../../env";
import type { EInvoiceDoc, EInvoiceProvider, EInvoiceResult } from "./types";

/**
 * MISA meInvoice (REST). TOÀN BỘ đường dẫn endpoint, tên trường payload và cấu trúc phản hồi dưới đây là
 * GIẢ ĐỊNH dựa trên kiểu API meInvoice phổ biến — mỗi chỗ có chú thích "[Cần xác nhận với tài liệu MISA]"
 * phải đối chiếu với tài liệu tích hợp MISA cấp riêng cho cửa hàng trước khi bật `einvoice.provider = misa`.
 * Không bao giờ log mật khẩu / token; thông báo lỗi chỉ chứa mã HTTP và đoạn thông điệp ngắn từ MISA.
 */
const TIMEOUT_MS = 15000;

// [Cần xác nhận với tài liệu MISA] đường dẫn endpoint
const PATHS = {
  token: "/api/v2/Account/Token",
  issue: "/api/v2/Invoice/Publish",
  adjust: "/api/v2/Invoice/Adjust",
  cancel: "/api/v2/Invoice/Cancel",
};

export class MisaError extends Error {}

interface MisaConfig {
  baseUrl: string;
  appId: string;
  taxCode: string;
  username: string;
  password: string;
}

export function misaConfigFromEnv(env: Env): MisaConfig | null {
  if (!env.MISA_BASE_URL || !env.MISA_APP_ID || !env.MISA_TAX_CODE || !env.MISA_USERNAME || !env.MISA_PASSWORD) return null;
  return { baseUrl: env.MISA_BASE_URL.replace(/\/+$/, ""), appId: env.MISA_APP_ID, taxCode: env.MISA_TAX_CODE, username: env.MISA_USERNAME, password: env.MISA_PASSWORD };
}

const ymd = (d: string) => d; // [Cần xác nhận với tài liệu MISA] định dạng ngày (ở đây yyyy-MM-dd)

/** Ánh xạ hoá đơn nội bộ → JSON kiểu meInvoice. [Cần xác nhận với tài liệu MISA] toàn bộ tên trường. */
export function buildMisaPayload(inv: EInvoiceDoc, original?: EInvoiceDoc, reason?: string) {
  return {
    RefID: inv.code, // khoá idempotency phía MISA (số nội bộ) — [Cần xác nhận với tài liệu MISA]
    InvoiceDate: ymd(inv.issueDate), // [Cần xác nhận với tài liệu MISA]
    InvoiceType: inv.kind === "adjustment" ? "ADJUSTMENT" : inv.kind === "replacement" ? "REPLACEMENT" : "NORMAL", // [Cần xác nhận với tài liệu MISA]
    PaymentMethodName: "TM/CK", // [Cần xác nhận với tài liệu MISA]
    CurrencyCode: "VND",
    ExchangeRate: 1,
    BuyerLegalName: inv.buyerName ?? "", // [Cần xác nhận với tài liệu MISA]
    BuyerTaxCode: inv.buyerTaxCode ?? "",
    BuyerAddress: inv.buyerAddress ?? "",
    BuyerEmail: inv.buyerEmail ?? "",
    TotalAmountWithoutVAT: inv.subtotal,
    VATRateName: `${inv.vatRateBp / 100}%`, // [Cần xác nhận với tài liệu MISA] (KCT / 0% / 5% / 8% / 10%)
    TotalVATAmount: inv.vatAmount,
    TotalAmount: inv.total,
    Note: inv.note ?? "",
    ...(original
      ? {
          OriginalInvoiceNo: original.einvoiceNo ?? "", // [Cần xác nhận với tài liệu MISA]
          OriginalInvoiceSeries: original.einvoiceSeries ?? "",
          OriginalInvoiceDate: ymd(original.issueDate),
        }
      : {}),
    ...(reason ? { CancelReason: reason } : {}),
    OriginalInvoiceDetails: inv.lines.map((l, i) => ({
      // [Cần xác nhận với tài liệu MISA] tên mảng dòng hàng và các trường
      LineNumber: i + 1,
      ItemName: l.description,
      UnitName: l.unit,
      Quantity: l.qtyMilli / 1000,
      UnitPrice: l.unitPrice,
      Amount: l.amount,
      VATRateName: `${inv.vatRateBp / 100}%`,
      VATAmount: inv.subtotal ? Math.round((l.amount * inv.vatAmount) / inv.subtotal) : 0,
    })),
  };
}

export class MisaProvider implements EInvoiceProvider {
  readonly name = "misa";
  private token: string | null = null;
  constructor(private readonly cfg: MisaConfig) {}

  private async call(path: string, body: unknown, auth: boolean): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${this.token}`; // [Cần xác nhận với tài liệu MISA] cách gửi token
    let res: Response;
    try {
      res = await fetch(this.cfg.baseUrl + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const name = (e as Error)?.name;
      throw new MisaError(name === "TimeoutError" || name === "AbortError" ? "MISA: hết thời gian chờ (15s)" : "MISA: không kết nối được");
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* không phải JSON */
    }
    if (!res.ok) throw new MisaError(`MISA trả HTTP ${res.status}: ${safeMsg(json, text)}`);
    // [Cần xác nhận với tài liệu MISA] cờ thành công trong thân phản hồi
    if (json && json.Success === false) throw new MisaError(`MISA từ chối: ${safeMsg(json, text)}`);
    return json;
  }

  private async ensureToken() {
    if (this.token) return;
    // [Cần xác nhận với tài liệu MISA] tên trường đăng nhập và trường trả token
    const r = await this.call(PATHS.token, { appid: this.cfg.appId, taxcode: this.cfg.taxCode, username: this.cfg.username, password: this.cfg.password }, false);
    const t = r?.Data?.access_token ?? r?.Data ?? r?.access_token;
    if (typeof t !== "string" || !t) throw new MisaError("MISA: không lấy được token");
    this.token = t;
  }

  private parseResult(r: any): EInvoiceResult {
    // [Cần xác nhận với tài liệu MISA] tên trường số HĐ, ký hiệu, mã tra cứu
    const d = r?.Data ?? r;
    const einvoiceNo = d?.InvoiceNo ?? d?.invoiceNo;
    const series = d?.InvoiceSeries ?? d?.invoiceSeries ?? "";
    const lookupCode = d?.TransactionID ?? d?.LookupCode ?? d?.lookupCode ?? "";
    if (!einvoiceNo) throw new MisaError("MISA: phản hồi thiếu số hoá đơn");
    return { einvoiceNo: String(einvoiceNo), series: String(series), lookupCode: String(lookupCode) };
  }

  async issue(inv: EInvoiceDoc) {
    await this.ensureToken();
    return this.parseResult(await this.call(PATHS.issue, buildMisaPayload(inv), true));
  }
  async adjust(inv: EInvoiceDoc, original: EInvoiceDoc) {
    await this.ensureToken();
    return this.parseResult(await this.call(PATHS.adjust, buildMisaPayload(inv, original), true));
  }
  async cancel(inv: EInvoiceDoc, reason: string) {
    await this.ensureToken();
    await this.call(PATHS.cancel, { RefID: inv.code, InvoiceNo: inv.einvoiceNo, InvoiceSeries: inv.einvoiceSeries, CancelReason: reason }, true); // [Cần xác nhận với tài liệu MISA]
  }
}

function safeMsg(json: any, text: string) {
  const m = json?.Message ?? json?.message ?? json?.ErrorMessage ?? text;
  return String(m ?? "").replace(/\s+/g, " ").slice(0, 200);
}
