/**
 * B-18: thành tiền theo từng dòng (qty milli × đơn giá VND / 1000) làm tròn NỬA LÊN theo độ lớn, trùng `lineAmount`/`Math.round` ở money.ts.
 * SQL `a * b / 1000` (chia nguyên) cắt cụt từng dòng nên tổng báo cáo lệch vài đồng so với giá trị lô/COGS tính ở code → mọi báo cáo
 * giá trị tồn / hao hụt / điều chỉnh dùng biểu thức này (tính từng dòng thẻ kho rồi mới cộng).
 */
export const valueSql = (qtyExpr: string, costExpr: string) =>
  `((CASE WHEN ${qtyExpr} < 0 THEN -1 ELSE 1 END) * CAST(ROUND(ABS(${qtyExpr}) * ${costExpr} / 1000.0) AS INTEGER))`;
