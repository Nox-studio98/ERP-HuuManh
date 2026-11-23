import type { EInvoiceDoc, EInvoiceProvider, EInvoiceResult } from "./types";

/** Nhà cung cấp giả cho dev/test: số TEST-xxxxxx tất định theo mã nội bộ, không gọi mạng. */
export class FakeProvider implements EInvoiceProvider {
  readonly name = "fake";
  constructor(private readonly opts: { failTimes?: number } = {}) {}
  private calls = 0;

  private make(inv: EInvoiceDoc): EInvoiceResult {
    return {
      einvoiceNo: `TEST-${String(inv.id).padStart(6, "0")}`,
      series: "C26TEST",
      lookupCode: `TEST${inv.code.replace(/[^A-Za-z0-9]/g, "")}`,
    };
  }
  private maybeFail() {
    if (this.opts.failTimes && this.calls++ < this.opts.failTimes) throw new Error("FakeProvider: lỗi giả lập");
  }
  async issue(inv: EInvoiceDoc) {
    this.maybeFail();
    return this.make(inv);
  }
  async adjust(inv: EInvoiceDoc, _original: EInvoiceDoc) {
    this.maybeFail();
    return this.make(inv);
  }
  async cancel(_inv: EInvoiceDoc, _reason: string) {
    this.maybeFail();
  }
}
