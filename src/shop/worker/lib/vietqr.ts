/**
 * Chuỗi VietQR (EMVCo MPM, tiêu chuẩn NAPAS) cho chuyển nhanh 24/7 tới tài khoản ngân hàng.
 * 00 Payload Format "01" · 01 Point of Initiation "12" (động, có số tiền) · 38 Merchant Account Info
 *   (00 GUID A000000727 · 01 [00 BIN · 01 số TK] · 02 dịch vụ QRIBFTTA) · 53 tiền tệ 704 · 54 số tiền ·
 *  58 quốc gia VN · 62 Additional Data (08 = nội dung chuyển khoản) · 63 CRC16-CCITT(FALSE) của toàn bộ chuỗi tới "6304".
 */
const tlv = (tag: string, value: string) => `${tag}${String(value.length).padStart(2, "0")}${value}`;

export function crc16ccitt(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export interface VietQrInput {
  bankBin: string;
  accountNo: string;
  amount: number;
  content: string;
}

export function buildVietQr(i: VietQrInput): string {
  const content = i.content.replace(/[^\x20-\x7E]/g, "").slice(0, 25);
  const acct = tlv("00", i.bankBin) + tlv("01", i.accountNo);
  const mai = tlv("00", "A000000727") + tlv("01", acct) + tlv("02", "QRIBFTTA");
  let p = tlv("00", "01") + tlv("01", "12") + tlv("38", mai) + tlv("53", "704");
  if (i.amount > 0) p += tlv("54", String(Math.round(i.amount)));
  p += tlv("58", "VN") + tlv("62", tlv("08", content));
  p += "6304";
  return p + crc16ccitt(p);
}
