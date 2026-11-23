/** Thành tiền = đơn giá (VND / đơn vị chính) × số lượng milli / 1000, làm tròn tới đồng. */
export const lineAmount = (unitPrice: number, qtyMilli: number) => Math.round((unitPrice * qtyMilli) / 1000);
/** Đổi số lượng theo đơn vị bất kỳ sang milli đơn vị chính. */
export const toMilli = (qty: number, factorMilli = 1000) => Math.round(qty * factorMilli);
