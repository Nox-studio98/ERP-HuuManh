# Audit nghiệp vụ & đồng bộ luồng (24/11/2026)

3 audit độc lập, chỉ đọc code, đối chiếu tài liệu nghiệp vụ; lỗi quan trọng được tái hiện bằng probe test.

- [A — Bán hàng → tiền](nghiep-vu-A-ban-hang-tien.md): POS, website/online, B2B, công nợ phải thu, KM/voucher/điểm, giá bán.
- [B — Kho, mua hàng, giá, tài chính](nghiep-vu-B-kho-mua-tai-chinh.md): nhập hàng, lô/FEFO, giá vốn, phải trả NCC, quỹ, khoá kỳ, báo cáo.
- [C — Nhân sự, lương, phân quyền](nghiep-vu-C-nhan-su-phan-quyen.md): chấm công, bảng công, lương, ma trận RBAC, EC-01..39.

## Đánh giá chung: ~7/10 — demo tốt, chưa sẵn sàng chạy thật

| Module | Điểm |
|---|---|
| M1 Bán hàng (POS) | 8 |
| M8 Website/online | 7 |
| M4 B2B | 8 |
| M3 Giá / M7 Giá đối thủ | 8 / 8 |
| Khuyến mãi / điểm | 7,5 |
| M5 Công nợ | 6,5 |
| M2 Kho | 6 |
| M6 Tài chính / báo cáo | 5,5–6 |
| M9 Nhân sự / lương | 6,5 |
| Phân quyền | 8,5 |
| Yêu cầu chung | 6,5 |

EC-01..39: 29 đạt, 7 một phần, 3 thiếu (EC-10, 21, 22); 5 quy tắc Critical đạt.
Khoảng 81 phát hiện sau khi gộp trùng: 1 nghiêm trọng, ~15 cao, ~35 trung bình, ~31 thấp.

## Kế hoạch sửa
1. **Tiền & báo cáo**: phí COD/sàn trừ 2 lần (A-03 = B-05); xoá nợ/chiết khấu/cọc không vào P&L (A-04 = C-13); trả hàng online & P&L; chênh lệch kiểm kê, VAT đầu vào; chi NCC bỏ qua ngưỡng duyệt (B-01); khoá sổ chưa chặn hết (B-08); số dư có khi trả hàng B2B (A-01); cân lại đơn trả trước (A-02).
2. **Kho**: lô hỏng đang giữ chỗ (B-03, EC-15); kiểm kê dùng snapshot cũ (B-02); giao không kiểm hạn (B-04); EC-21/22.
3. **Nhân sự**: chấm công offline (C-01); lương giờ trả tăng ca 2 lần (C-03); duyệt lương không kiểm dữ liệu mới (C-04); tạm ứng vượt lương (C-05); lộ lương qua xuất sổ quỹ (C-02); sao lưu thiếu (C-06); đặt toạ độ cửa hàng (C-07).
