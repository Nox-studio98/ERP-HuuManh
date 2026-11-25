/**
 * Danh mục cài đặt (registry): nguồn sự thật cho màn hình Cài đặt — nhóm, nhãn tiếng Việt, kiểu dữ liệu, giới hạn.
 * Mọi khoá trong bảng `settings` sau migrations + seed PHẢI có ở đây (test/settings-ui.test.ts kiểm tra).
 * Khoá lạ (không có ở đây) chỉ hiển thị thô, chỉ đọc. Secret thật (API key, token) nằm ở env/secrets Worker, KHÔNG nằm trong bảng settings;
 * `sensitive: true` / mẫu tên bí mật → giá trị luôn bị che, không bao giờ trả ra API hay ghi vào nhật ký.
 */
export type SettingType = "vnd" | "bp" | "int" | "bool" | "enum" | "multi" | "intlist" | "text" | "pit";

export const GROUPS = [
  "Ngưỡng duyệt", "Bán hàng & giá", "Công nợ", "Online/website", "Tích điểm & khuyến mãi",
  "Nhân sự & lương", "Thuế TNCN", "Giá đối thủ", "Hệ thống",
] as const;
export type SettingGroup = (typeof GROUPS)[number];

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  type: SettingType;
  unit?: string; // hậu tố hiển thị: ngày, giờ, phút, giây, mét...
  min?: number;
  max?: number;
  options?: { value: string; label: string }[]; // enum / multi
  maxLen?: number;
  sensitive?: boolean;
  allowEmpty?: boolean; // intlist: cho phép để trống
}

const o = (...p: [string, string][]) => p.map(([value, label]) => ({ value, label }));

export const SETTING_DEFS: SettingDef[] = [
  // ===== Ngưỡng duyệt =====
  { key: "approval.discount_pct_bp", group: "Ngưỡng duyệt", label: "Giảm giá đơn lẻ cần duyệt khi vượt", help: "Thu ngân giảm giá một đơn vượt mức % này thì phải được quản lý duyệt.", type: "bp", min: 0, max: 10000 },
  { key: "approval.cash_out_vnd", group: "Ngưỡng duyệt", label: "Phiếu chi cần chủ duyệt khi vượt", help: "Phiếu chi có số tiền lớn hơn mức này sẽ chờ chủ cửa hàng duyệt.", type: "vnd", min: 0, max: 10_000_000_000 },
  { key: "approval.waste_pct_bp", group: "Ngưỡng duyệt", label: "Hao hụt báo quản lý khi vượt", help: "Hao hụt vượt % lượng nhập thì báo quản lý.", type: "bp", min: 0, max: 10000 },
  { key: "approval.count_diff_vnd", group: "Ngưỡng duyệt", label: "Chênh lệch kiểm kê cần chủ duyệt khi vượt", help: "Giá trị chênh lệch kiểm kê lớn hơn mức này cần chủ duyệt.", type: "vnd", min: 0, max: 10_000_000_000 },
  { key: "approval.writeoff_vnd", group: "Ngưỡng duyệt", label: "Xoá nợ / chiết khấu công nợ cần chủ duyệt khi vượt", help: "Đặt 0 = luôn phải duyệt.", type: "vnd", min: 0, max: 10_000_000_000 },
  { key: "approval.pos_return_vnd", group: "Ngưỡng duyệt", label: "Trả hàng tại quầy cần quản lý duyệt khi vượt", help: "Thu ngân chỉ tự trả hàng cho đơn của ca đang mở, giá trị không vượt mức này và hàng nhập lại kho; ngoài ra cần quản lý duyệt.", type: "vnd", min: 0, max: 10_000_000_000 },
  { key: "approval.quote_discount_bp", group: "Ngưỡng duyệt", label: "Báo giá thấp hơn bảng giá cần duyệt khi vượt", help: "Báo giá sỉ thấp hơn bảng giá quá % này cần duyệt.", type: "bp", min: 0, max: 10000 },
  { key: "approval.purchase_return_vnd", group: "Ngưỡng duyệt", label: "Trả hàng nhà cung cấp cần chủ duyệt khi vượt", help: "Phiếu trả hàng NCC có giá trị lớn hơn mức này cần chủ duyệt (vì giảm công nợ phải trả). Người lập không có quyền duyệt kho thì luôn chờ duyệt. [Cần xác nhận]", type: "vnd", min: 0, max: 10_000_000_000 },

  // ===== Bán hàng & giá =====
  { key: "costing.method", group: "Bán hàng & giá", label: "Phương pháp tính giá vốn", help: "Theo lô nhập (lot) hoặc bình quân gia quyền (average).", type: "enum", options: o(["lot", "Theo lô nhập"], ["average", "Bình quân"]) },
  { key: "pos.allow_offline", group: "Bán hàng & giá", label: "Cho phép bán hàng khi mất mạng", help: "Bật: thu ngân vẫn lập đơn offline và đồng bộ lại sau.", type: "bool" },
  { key: "pos.offline_max_age_hours", group: "Bán hàng & giá", label: "Đơn bán offline đồng bộ chậm tối đa", help: "Đơn lập khi mất mạng được ghi theo giờ bán gốc; đồng bộ chậm quá số giờ này thì bị từ chối để quản lý xử lý.", type: "int", unit: "giờ", min: 1, max: 720 },
  { key: "pos.offline_price_tolerance_bp", group: "Bán hàng & giá", label: "Ngưỡng chấp nhận giá đã hiển thị khi offline", help: "Đơn offline giữ giá khách đã thấy nếu lệch bảng giá tại lúc bán không quá mức % này; vượt thì từ chối đồng bộ.", type: "bp", min: 0, max: 10000 },
  { key: "quote.valid_days", group: "Bán hàng & giá", label: "Hiệu lực báo giá sỉ", help: "Số ngày báo giá còn hiệu lực kể từ ngày lập.", type: "int", unit: "ngày", min: 1, max: 365 },
  { key: "invoice.vat_rate_bp", group: "Bán hàng & giá", label: "Thuế suất GTGT mặc định", help: "Hộ kinh doanh thường để 0%.", type: "bp", min: 0, max: 3000 },
  { key: "recurring.auto_generate", group: "Bán hàng & giá", label: "Tự sinh đơn sỉ lặp lại", help: "Bật: hệ thống tự tạo đơn sỉ định kỳ cho ngày mai lúc 08:00.", type: "bool" },
  { key: "reorder.lookback_days", group: "Bán hàng & giá", label: "Gợi ý đặt hàng: số ngày tính tốc độ bán", help: "Tốc độ bán được tính trên số ngày gần nhất này.", type: "int", unit: "ngày", min: 1, max: 365 },
  { key: "reorder.cover_days", group: "Bán hàng & giá", label: "Gợi ý đặt hàng: số ngày tồn mục tiêu", help: "Số ngày bán đủ hàng mong muốn sau khi hàng về.", type: "int", unit: "ngày", min: 1, max: 90 },

  // ===== Công nợ =====
  { key: "debt.aging_buckets", group: "Công nợ", label: "Mốc tuổi nợ", help: "Các mốc ngày, cách nhau dấu phẩy và tăng dần. Ví dụ 30,60,90.", type: "intlist", min: 1, max: 3650 },
  { key: "debt.allocation", group: "Công nợ", label: "Cách gạch nợ khi khách trả tiền", help: "Hiện hệ thống gạch hoá đơn cũ nhất trước.", type: "enum", options: o(["oldest_first", "Hoá đơn cũ nhất trước"]) },
  { key: "b2b.new_credit_limit_max_vnd", group: "Công nợ", label: "Hạn mức nợ quản lý được tự đặt cho khách sỉ", help: "Quản lý đặt hạn mức cao hơn mức này (khi tạo khách hoặc nâng hạn mức) phải chờ chủ duyệt. Chủ không bị giới hạn.", type: "vnd", min: 0, max: 10_000_000_000 },
  { key: "b2b.new_payment_terms_max_days", group: "Công nợ", label: "Hạn thanh toán quản lý được tự đặt cho khách sỉ", help: "Quản lý đặt hạn thanh toán dài hơn mức này phải chờ chủ duyệt.", type: "int", unit: "ngày", min: 0, max: 365 },
  { key: "remind.days_before_due", group: "Công nợ", label: "Nhắc nợ trước hạn", help: "Nhắc khách sỉ trước ngày đến hạn bao nhiêu ngày.", type: "int", unit: "ngày", min: 0, max: 60 },
  { key: "einvoice.provider", group: "Công nợ", label: "Nhà cung cấp hoá đơn điện tử", help: "fake = chạy thử; misa chỉ chọn được khi đã cấu hình kết nối MISA (secrets). Có thể đổi thêm ở màn Tích hợp.", type: "enum", options: o(["fake", "Chạy thử (fake)"], ["misa", "MISA"]) },
  { key: "einvoice.auto_issue_b2b", group: "Công nợ", label: "Tự phát hành hoá đơn điện tử khi xuất hoá đơn sỉ", help: "Bật: phát hành HĐĐT tự động cho hoá đơn B2B.", type: "bool" },

  // ===== Online/website =====
  { key: "online.weight_tolerance_bp", group: "Online/website", label: "Dung sai lệch cân đơn online", help: "Lệch cân trong mức này thì tự chấp nhận; vượt thì khách phải xác nhận lại.", type: "bp", min: 0, max: 10000 },
  { key: "online.hold_minutes_transfer", group: "Online/website", label: "Giữ đơn chuyển khoản chờ tiền", help: "Quá số phút này chưa nhận được tiền thì huỷ đơn.", type: "int", unit: "phút", min: 1, max: 1440 },
  { key: "online.auto_confirm", group: "Online/website", label: "Tự xác nhận đơn online khi đủ hàng", help: "Tắt: nhân viên xác nhận thủ công.", type: "bool" },
  { key: "online.cancel_fee_policy", group: "Online/website", label: "Ai chịu phí giao khi khách huỷ sau khi giao cho shipper", help: "Áp dụng khi khách huỷ sau khi đơn đã giao cho đơn vị vận chuyển.", type: "enum", options: o(["shop", "Cửa hàng chịu"], ["customer", "Khách chịu"]) },
  { key: "online.pack_recalc_promo", group: "Online/website", label: "Tính lại khuyến mãi sau khi cân hàng", help: "Bật: sau khi cân/đóng gói, khuyến mãi % và voucher được tính lại theo tiền hàng thực tế; voucher không còn đủ điều kiện thì bỏ giảm giá và hoàn lượt dùng.", type: "bool" },
  { key: "online.pack_recalc_shipping", group: "Online/website", label: "Xét lại ngưỡng miễn phí giao sau khi cân hàng", help: "Bật: tiền hàng thực tế dưới ngưỡng miễn phí giao của khu vực thì thu phí giao hàng (và ngược lại).", type: "bool" },
  { key: "b2b.backorder_on_short", group: "Bán hàng & giá", label: "Giao thiếu đơn sỉ: tự tạo đơn bổ sung", help: "Bật: phần đặt nhưng chưa giao (không phải hàng bị từ chối) được tạo thành đơn bổ sung chờ xác nhận. Có thể chọn lại ở từng lần xác nhận giao.", type: "bool" },
  { key: "payment.methods", group: "Online/website", label: "Phương thức thanh toán đơn online", help: "COD, chuyển khoản, cổng thanh toán.", type: "multi", options: o(["cod", "COD"], ["transfer", "Chuyển khoản"], ["gateway", "Cổng thanh toán"]) },
  { key: "payment.bank_bin", group: "Online/website", label: "Mã BIN ngân hàng nhận tiền", help: "Mã 6 chữ số dùng tạo VietQR (970436 = Vietcombank).", type: "text", maxLen: 6 },
  { key: "payment.bank_account", group: "Online/website", label: "Số tài khoản nhận tiền", help: "Hiển thị cho khách khi chuyển khoản.", type: "text", maxLen: 30 },
  { key: "payment.bank_account_name", group: "Online/website", label: "Tên chủ tài khoản", help: "Viết hoa không dấu, đúng như ngân hàng.", type: "text", maxLen: 100 },
  { key: "shop.name", group: "Online/website", label: "Tên cửa hàng trên website", help: "Hiển thị trên website bán hàng và email.", type: "text", maxLen: 100 },
  { key: "shop.hotline", group: "Online/website", label: "Hotline", help: "Số điện thoại hiển thị cho khách.", type: "text", maxLen: 30 },
  { key: "fresco.enabled", group: "Online/website", label: "Nhận đơn từ sàn Fresco", help: "Bật khi đã có tài khoản và khoá webhook Fresco.", type: "bool" },

  // ===== Tích điểm & khuyến mãi =====
  { key: "loyalty.enabled", group: "Tích điểm & khuyến mãi", label: "Bật tích điểm", help: "Bật: khách có số điện thoại được tích điểm theo đơn.", type: "bool" },
  { key: "loyalty.earn_per_vnd", group: "Tích điểm & khuyến mãi", label: "Chi tiêu để được 1 điểm", help: "Mỗi bao nhiêu đồng chi tiêu được 1 điểm.", type: "vnd", min: 1, max: 100_000_000 },
  { key: "loyalty.point_value_vnd", group: "Tích điểm & khuyến mãi", label: "Giá trị 1 điểm khi đổi", help: "1 điểm quy đổi được bao nhiêu đồng.", type: "vnd", min: 0, max: 1_000_000 },
  { key: "loyalty.max_redeem_bp", group: "Tích điểm & khuyến mãi", label: "Đổi điểm tối đa theo giá trị đơn", help: "Tỷ lệ tối đa của đơn được thanh toán bằng điểm.", type: "bp", min: 0, max: 10000 },
  { key: "promo.allow_stacking", group: "Tích điểm & khuyến mãi", label: "Cho phép cộng dồn khuyến mãi", help: "Tắt: chỉ áp khuyến mãi tốt nhất. Bật: cộng dồn các khuyến mãi cho phép cộng dồn.", type: "bool" },
  { key: "deposit.min_bp", group: "Tích điểm & khuyến mãi", label: "Đặt cọc tối thiểu cho đơn đặt trước", help: "Áp dụng cho giỏ quà và đơn đặt trước.", type: "bp", min: 0, max: 10000 },

  // ===== Nhân sự & lương =====
  { key: "hr.monthly_pay_mode", group: "Nhân sự & lương", label: "Cách tính lương tháng", help: "Theo giờ làm thực tế: ngày công = phút làm / phút ca (tối đa 1, làm tròn 0,1 ngày), đi muộn/về sớm bị trừ. Kiểu cũ: có công trong ngày là đủ 1 ngày.", type: "enum", options: o(["proportional", "Theo giờ làm thực tế"], ["day_present", "Có công là đủ ngày (kiểu cũ)"]) },
  { key: "hr.weekly_off_days", group: "Nhân sự & lương", label: "Ngày nghỉ hằng tuần", help: "Không tính vào số ngày phép. 1 = Thứ Hai … 7 = Chủ nhật, ví dụ 7 hoặc 6,7. Để trống = không loại ngày nào.", type: "intlist", min: 1, max: 7, allowEmpty: true },
  { key: "hr.standard_workdays", group: "Nhân sự & lương", label: "Ngày công chuẩn mỗi tháng", help: "Dùng tính lương tháng.", type: "int", unit: "ngày", min: 1, max: 31 },
  { key: "hr.late_grace_minutes", group: "Nhân sự & lương", label: "Ân hạn đi muộn", help: "Đi muộn quá số phút này mới tính là muộn.", type: "int", unit: "phút", min: 0, max: 120 },
  { key: "hr.rounding_minutes", group: "Nhân sự & lương", label: "Làm tròn phút tăng ca xuống bội số", help: "Ví dụ 15: 50 phút tính thành 45 phút.", type: "int", unit: "phút", min: 1, max: 60 },
  { key: "hr.ot_weekday_bp", group: "Nhân sự & lương", label: "Hệ số tăng ca ngày thường", help: "15000 = 150% lương giờ.", type: "bp", min: 10000, max: 100000 },
  { key: "hr.ot_weekend_bp", group: "Nhân sự & lương", label: "Hệ số tăng ca cuối tuần", help: "20000 = 200% lương giờ.", type: "bp", min: 10000, max: 100000 },
  { key: "hr.ot_holiday_bp", group: "Nhân sự & lương", label: "Hệ số làm ngày lễ", help: "30000 = 300% lương giờ.", type: "bp", min: 10000, max: 100000 },
  { key: "hr.attendance_methods", group: "Nhân sự & lương", label: "Cách xác thực nơi chấm công", help: "Chọn GPS, mã QR hoặc cả hai.", type: "multi", options: o(["gps", "GPS"], ["qr", "Mã QR"]) },
  { key: "hr.gps_max_accuracy_m", group: "Nhân sự & lương", label: "Sai số GPS tối đa", help: "Bỏ qua toạ độ có sai số lớn hơn số mét này.", type: "int", unit: "mét", min: 5, max: 5000 },
  { key: "hr.qr_window_seconds", group: "Nhân sự & lương", label: "Mã QR chấm công đổi sau", help: "Mã QR đổi mỗi số giây này.", type: "int", unit: "giây", min: 5, max: 600 },
  { key: "hr.offline_max_hours", group: "Nhân sự & lương", label: "Chấm công offline: giờ máy lùi tối đa", help: "Chấp nhận giờ trên máy nhân viên lùi tối đa bấy nhiêu giờ so với lúc gửi lên.", type: "int", unit: "giờ", min: 1, max: 720 },
  { key: "hr.advance_max_bp", group: "Nhân sự & lương", label: "Tạm ứng tối đa theo lương", help: "Tổng tạm ứng của một nhân viên cho cùng một kỳ khấu trừ không vượt % lương tháng này (5000 = 50%). 0 = không giới hạn. Lương giờ/ca được quy đổi theo ngày công chuẩn.", type: "bp", min: 0, max: 10000 },
  { key: "hr.holiday_premium_bp", group: "Nhân sự & lương", label: "Phụ trội giờ làm trong ca ngày lễ", help: "Cộng thêm trên lương giờ thường cho giờ làm trong ca vào ngày lễ (20000 = +200%, tổng 300%). 0 = không phụ trội. Giờ tăng ca đã duyệt vẫn trả riêng.", type: "bp", min: 0, max: 100000 },
  { key: "hr.weekend_premium_bp", group: "Nhân sự & lương", label: "Phụ trội giờ làm trong ca cuối tuần", help: "Cộng thêm trên lương giờ thường cho giờ làm trong ca thứ Bảy/Chủ nhật (5000 = +50%). 0 = không phụ trội.", type: "bp", min: 0, max: 100000 },
  { key: "hr.prorate_fixed_pay", group: "Nhân sự & lương", label: "Phụ cấp và bảo hiểm theo ngày làm", help: "Bật: phụ cấp cố định và lương đóng bảo hiểm tính theo tỉ lệ ngày làm khi nhân viên vào/nghỉ giữa tháng, và bằng 0 nếu cả tháng không có công. Tắt: tính đủ tháng.", type: "bool" },
  { key: "hr.insurance_employee_bp", group: "Nhân sự & lương", label: "Bảo hiểm phần người lao động", help: "BHXH 8% + BHYT 1,5% + BHTN 1% = 10,5%.", type: "bp", min: 0, max: 5000 },
  { key: "hr.insurance_employer_bp", group: "Nhân sự & lương", label: "Bảo hiểm phần doanh nghiệp", help: "Mặc định 21,5%.", type: "bp", min: 0, max: 5000 },
  { key: "hr.insurance_cap_vnd", group: "Nhân sự & lương", label: "Trần lương đóng bảo hiểm", help: "20 × lương cơ sở; cập nhật theo năm.", type: "vnd", min: 0, max: 1_000_000_000 },
  { key: "hr.sales_bonus_bp", group: "Nhân sự & lương", label: "Thưởng doanh số", help: "% doanh thu nhân viên bán. 0 = tắt.", type: "bp", min: 0, max: 10000 },

  // ===== Thuế TNCN =====
  { key: "hr.pit_family_deduction", group: "Thuế TNCN", label: "Giảm trừ gia cảnh bản thân", help: "Mỗi tháng, theo quy định hiện hành.", type: "vnd", min: 0, max: 1_000_000_000 },
  { key: "hr.pit_dependent_deduction", group: "Thuế TNCN", label: "Giảm trừ mỗi người phụ thuộc", help: "Mỗi người, mỗi tháng.", type: "vnd", min: 0, max: 1_000_000_000 },
  { key: "hr.pit_brackets_json", group: "Thuế TNCN", label: "Biểu thuế luỹ tiến", help: "Mỗi bậc gồm trần thu nhập tính thuế tháng và thuế suất. Bậc cuối không có trần.", type: "pit" },

  // ===== Giá đối thủ =====
  { key: "competitor.outlier_band_bp", group: "Giá đối thủ", label: "Ngưỡng giá bất thường so với trung vị", help: "Giá đối thủ lệch hơn mức này so với trung vị bị coi là bất thường.", type: "bp", min: 0, max: 100000 },
  { key: "competitor.alert_change_bp", group: "Giá đối thủ", label: "Cảnh báo khi đối thủ đổi giá hơn", help: "Cảnh báo khi giá đối thủ đổi vượt mức %.", type: "bp", min: 0, max: 100000 },
  { key: "competitor.suggest_band_bp", group: "Giá đối thủ", label: "Gợi ý chỉnh giá khi lệch giá thị trường hơn", help: "Gợi ý khi giá cửa hàng lệch giá trung bình thị trường quá mức %.", type: "bp", min: 0, max: 100000 },
  { key: "competitor.user_agent", group: "Giá đối thủ", label: "User-Agent khi thu thập giá", help: "Nên kèm thông tin liên hệ của cửa hàng.", type: "text", maxLen: 200 },

  // ===== Hệ thống =====
  { key: "session.ttl_hours", group: "Hệ thống", label: "Thời hạn phiên đăng nhập", help: "Hết số giờ này phải đăng nhập lại.", type: "int", unit: "giờ", min: 1, max: 720 },
  { key: "timezone", group: "Hệ thống", label: "Múi giờ", help: "Cố định theo giờ Việt Nam.", type: "enum", options: o(["Asia/Ho_Chi_Minh", "Giờ Việt Nam (UTC+7)"]) },
  { key: "backup.retention_days", group: "Hệ thống", label: "Số ngày giữ bản sao lưu", help: "Bản sao lưu R2 cũ hơn số ngày này sẽ bị xoá.", type: "int", unit: "ngày", min: 1, max: 3650 },
  { key: "notify.email_provider", group: "Hệ thống", label: "Nhà cung cấp email thông báo", help: "fake = chỉ ghi nhật ký; cloudflare = gửi thật.", type: "enum", options: o(["fake", "Chạy thử (fake)"], ["cloudflare", "Cloudflare Email"]) },
  { key: "notify.approval.enabled", group: "Hệ thống", label: "Thông báo yêu cầu chờ duyệt", help: "Bật: người có quyền duyệt nhận thông báo (chuông + đẩy) khi có yêu cầu, người yêu cầu được báo lại khi được duyệt hoặc từ chối.", type: "bool" },
  { key: "notify.approval.push", group: "Hệ thống", label: "Gửi thêm thông báo đẩy khi có yêu cầu duyệt", help: "Chỉ gửi cho người đã bật thông báo đẩy trên thiết bị. Tắt: chỉ hiện ở chuông trong ứng dụng.", type: "bool" },
  { key: "notify.approval.groups", group: "Hệ thống", label: "Nhóm yêu cầu có thông báo", help: "Chọn nhóm cần thông báo: chi tiền/công nợ, bán hàng/giá, kho, nhân sự, khác.", type: "multi", options: o(["finance", "Chi tiền, công nợ"], ["sales", "Giảm giá, dưới giá vốn, hạn mức nợ, báo giá, giá"], ["stock", "Kiểm kê, trả hàng NCC"], ["hr", "Nghỉ phép, đổi ca, tăng ca, bổ sung công, chấm offline"], ["other", "Khác"]) },
];

export const DEF_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/** Khoá nội bộ do hệ thống tự ghi (cache...), không phải cài đặt người dùng: ẩn khỏi màn hình. */
export const isInternalKey = (k: string) => /^competitor\.robots_at\./.test(k);
/** Khoá lạ có tên giống bí mật: giá trị luôn bị che. */
export const looksSecret = (k: string) => /(secret|token|password|passwd|api_?key|private)/i.test(k);
export const isSensitive = (k: string) => DEF_BY_KEY.get(k)?.sensitive === true || looksSecret(k);
export const needsConfirmNote = (note: string | null | undefined) => !!note && note.includes("[Cần xác nhận");

export type PitBracket = [number | null, number];

/** Chuẩn hoá + kiểm tra một giá trị. Trả { value } (chuỗi lưu DB) hoặc { error } (tiếng Việt). */
export function validateSetting(def: SettingDef, raw: unknown): { value: string } | { error: string } {
  const s = typeof raw === "boolean" ? (raw ? "1" : "0") : String(raw ?? "").trim();
  const range = (n: number) => {
    if (def.min !== undefined && n < def.min) return `Phải từ ${def.min.toLocaleString("vi-VN")} trở lên`;
    if (def.max !== undefined && n > def.max) return `Không được vượt ${def.max.toLocaleString("vi-VN")}`;
    return null;
  };
  switch (def.type) {
    case "vnd":
    case "int":
    case "bp": {
      if (!/^-?\d{1,15}$/.test(s)) return { error: "Phải là số nguyên" };
      const n = Number(s);
      const e = range(n);
      return e ? { error: e } : { value: String(n) };
    }
    case "bool":
      return s === "0" || s === "1" ? { value: s } : { error: "Chỉ nhận 0 (tắt) hoặc 1 (bật)" };
    case "enum":
      return def.options!.some((x) => x.value === s) ? { value: s } : { error: `Chỉ nhận: ${def.options!.map((x) => x.value).join(", ")}` };
    case "multi": {
      const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return { error: "Chọn ít nhất một mục" };
      if (parts.some((p) => !def.options!.some((x) => x.value === p))) return { error: `Chỉ nhận: ${def.options!.map((x) => x.value).join(", ")}` };
      return { value: [...new Set(parts)].join(",") };
    }
    case "intlist": {
      if (def.allowEmpty && s.trim() === "") return { value: "" };
      const parts = s.split(",").map((x) => x.trim());
      if (!parts.length || parts.some((p) => !/^\d{1,5}$/.test(p))) return { error: "Nhập các số nguyên cách nhau dấu phẩy, ví dụ 30,60,90" };
      const ns = parts.map(Number);
      if (ns.some((n, i) => n < (def.min ?? 0) || n > (def.max ?? 1e9) || (i > 0 && n <= ns[i - 1]))) return { error: "Các mốc phải là số dương, tăng dần" };
      return { value: ns.join(",") };
    }
    case "text": {
      if (s.length > (def.maxLen ?? 200)) return { error: `Tối đa ${def.maxLen ?? 200} ký tự` };
      if (def.key === "payment.bank_bin" && s && !/^\d{6}$/.test(s)) return { error: "Mã BIN gồm đúng 6 chữ số" };
      if (def.key === "payment.bank_account" && s && !/^[0-9A-Za-z]{4,30}$/.test(s)) return { error: "Số tài khoản chỉ gồm chữ số/chữ cái (4–30 ký tự)" };
      if (def.key === "shop.name" && !s) return { error: "Không được để trống" };
      return { value: s };
    }
    case "pit": {
      let v: unknown;
      try { v = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)); } catch { return { error: "Biểu thuế không hợp lệ" }; }
      if (!Array.isArray(v) || v.length < 1 || v.length > 12) return { error: "Biểu thuế cần từ 1 đến 12 bậc" };
      let prev = 0;
      for (let i = 0; i < v.length; i++) {
        const b = v[i];
        if (!Array.isArray(b) || b.length !== 2) return { error: `Bậc ${i + 1} không hợp lệ` };
        const [cap, rate] = b as [unknown, unknown];
        const last = i === v.length - 1;
        if (!Number.isInteger(rate) || (rate as number) < 0 || (rate as number) > 10000) return { error: `Bậc ${i + 1}: thuế suất phải từ 0% đến 100%` };
        if (last) {
          if (cap !== null) return { error: "Bậc cuối cùng không có trần (để trống)" };
        } else {
          if (!Number.isInteger(cap) || (cap as number) <= prev) return { error: `Bậc ${i + 1}: trần phải lớn hơn trần bậc trước` };
          prev = cap as number;
        }
      }
      return { value: JSON.stringify(v) };
    }
  }
}
