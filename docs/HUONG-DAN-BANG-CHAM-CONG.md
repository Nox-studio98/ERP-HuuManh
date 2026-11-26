# Hướng dẫn sử dụng: Bảng chấm công

Dành cho **chủ cửa hàng và quản lý**. Tính năng nằm trong PR #21; sau khi gộp và deploy, mở menu **Nhân sự → Bảng chấm công**. Nhân viên vẫn tự chấm công bằng điện thoại như cũ (màn "Chấm công"), không thay đổi gì.

## 1. Màn hình chính
- **Lưới tuần:** mỗi dòng là một ca (Ca sáng, Ca chiều…), mỗi cột là một ngày. Mỗi thẻ trong ô là một nhân viên: tên, giờ vào – ra, nhãn trạng thái.
- **Màu thẻ** (chú thích luôn hiện ở đáy màn):
  - xanh dương: Đúng giờ
  - tím: Đi muộn / Về sớm (có số phút)
  - đỏ: Chấm công thiếu (thiếu giờ vào hoặc ra, hoặc đang chờ duyệt)
  - cam: Chưa chấm công (ca đã bắt đầu mà chưa chấm)
  - xám: Nghỉ làm, hoặc ca chưa tới giờ
  - xanh lá: Đang làm
- **Nhãn nhỏ trên thẻ:** *Phạt ×n*, *Thưởng ×n*, *Chờ duyệt*, *Thủ công* (quản lý chấm hộ), *Ngoài lịch* (chấm khi không có ca).
- **Thanh công cụ:** tìm nhân viên · *Theo tuần / Theo tháng* · ‹ › chuyển tuần/tháng · *Hôm nay* · *Xem theo ca / Xem theo nhân viên* · *Chọn* · *Duyệt chấm công (số việc chờ)* · *Xếp lịch* · *Xuất file*.
- **Theo tháng:** bảng nhân viên × ngày, mỗi ca là một chấm màu; bấm vào để xem chi tiết.
- **Trên điện thoại:** dải 7 ngày (mỗi ngày có chấm màu tóm tắt), chạm ngày để xem danh sách theo ca.

## 2. Chấm công hộ / sửa giờ cho một nhân viên
1. Bấm vào thẻ nhân viên.
2. Nhập **Ghi chú** (bắt buộc, ví dụ "Quên mang điện thoại").
3. Tab **Chấm công**: chọn *Đi làm*, đánh dấu *Vào* / *Ra* và sửa giờ (mặc định là giờ ca).
4. Có thể bỏ *Áp dụng đi muộn / về sớm / làm thêm* nếu không muốn tính cho lần này.
5. Bấm **Lưu**. Thẻ đổi màu ngay.

Hệ thống **không xoá** lần chấm cũ: lần cũ được đánh dấu "bị thay thế", lần mới ghi tên người sửa và lý do. Xem lại ở tab **Lịch sử chấm công**.

## 3. Chấm công nhiều người cùng lúc
1. Bấm **Chọn**, rồi bấm các thẻ cần chấm. Các thẻ phải **cùng một ca**.
2. Bấm **Chỉnh sửa chấm công** trên thanh nổi ở đáy màn.
3. Nhập ghi chú và giờ, rồi bấm **Lưu cho n ô**.

## 4. Ghi nghỉ, người làm thay, huỷ ca, đổi ca
- **Ghi nghỉ:** trong tab Chấm công chọn *Nghỉ phép hưởng lương* hoặc *Nghỉ không lương*. Có thể chọn **Nhân viên làm thay**; hệ thống tạo ca cho người đó.
- **Huỷ ca:** dùng khi ca không còn cần (không xoá dữ liệu, ca chuyển sang trạng thái huỷ).
- **Đổi ca:** chuyển ca sang nhân viên khác. Chỉ đổi được khi ca chưa có lần chấm công.

## 5. Phạt vi phạm và thưởng
1. Bấm thẻ nhân viên, mở tab **Phạt vi phạm** (hoặc **Thưởng**).
2. Bấm **+ Thêm vi phạm**, chọn loại, nhập số lần, có thể sửa mức tiền mỗi lần, rồi bấm **Lưu**.
3. Chưa có loại phù hợp thì bấm **+ Thêm loại vi phạm** (cần quyền quản lý nhân sự).

Ghi chú:
- Loại có sẵn: Đi muộn không lý do (20.000 ₫), Quên chấm công (10.000 ₫), Vi phạm nội quy (50.000 ₫), Chuyên cần (20.000 ₫), Làm tốt (50.000 ₫). Sửa mức trong phần thêm loại.
- Tiền phạt/thưởng **tự cộng vào phiếu lương** của tháng đó, mỗi khoản một dòng diễn giải.
- Ghi sai thì bấm **Huỷ** và nhập lý do. Không xoá được: khoản đã huỷ vẫn hiện, gạch ngang.
- Tháng lương đã duyệt hoặc đã chi thì không thêm hay huỷ được nữa.
- Người chỉ có quyền xem nhân sự thấy loại và số lần, **không thấy số tiền**.

## 6. Duyệt, xếp lịch, xuất file
- **Duyệt chấm công (n):** mở các tab duyệt quen thuộc (chấm công cần xem, bổ sung công, nghỉ phép, tăng ca, thiết bị, cảnh báo). Lần chấm chờ duyệt của một người cũng duyệt được ngay trong tab Lịch sử chấm công của thẻ.
- **Xếp lịch:** chọn ca, chọn nhiều nhân viên, chọn ngày trong tuần, bật *Lặp lại hằng tuần* (2–12 tuần) hoặc *Sao chép tuần trước*. Ca đã có sẽ được bỏ qua.
- **Xuất file:** bảng chấm công của tuần/tháng đang xem, hoặc tổng phạt/thưởng (CSV mở bằng Excel).

## 7. Thiết lập (Cài đặt → nhóm "Chấm công")
Mặc định giữ nguyên cách tính cũ; chỉ đổi khi cửa hàng đã thống nhất quy định.

| Tham số | Ý nghĩa |
|---|---|
| Cách chấm công | *Theo ca làm việc* (xếp ca cho từng người) hoặc *Theo khung giờ* (mọi người dùng chung một khung giờ, không cần xếp ca) |
| Khung giờ làm việc, nghỉ giữa giờ | Chỉ dùng khi chấm theo khung giờ; giờ nghỉ bị trừ khỏi giờ làm |
| Ân hạn về sớm | Về sớm không quá số phút này thì không tính về sớm (ân hạn đi muộn nằm ở nhóm Nhân sự & lương) |
| Tự tính làm thêm giờ từ giờ chấm | Bật: đến sớm / ở lại sau ca từ mức tối thiểu trở lên được tính làm thêm, không cần đơn. Nếu có cả đơn tăng ca đã duyệt cùng ngày thì lấy số lớn hơn |
| Làm thêm trước / sau ca: tối thiểu | Ngưỡng phút để bắt đầu tính làm thêm |
| Quy đổi giờ làm ra số công | Ví dụ `240:5,480:10,600:15` = từ 4 giờ được 0,5 công, từ 8 giờ 1 công, từ 10 giờ 1,5 công. Để trống = tắt |
| Tự chấm công theo lịch | Ca đã qua mà không có lần chấm nào (và không nghỉ phép) được tính đủ giờ |
| Chấm công khi không có ca | Không cho chấm / Cho chấm nhưng chờ duyệt / Ghi nhận ngay |

## 8. Tháng đã chốt công
Sau khi **Bảng công** của tháng đã chốt, các ô của tháng đó chỉ xem được (hiện dòng "Kỳ đã chốt — dùng điều chỉnh công"). Sai sót xử lý bằng **Điều chỉnh công** ở màn Bảng công, cộng/trừ vào kỳ sau.
