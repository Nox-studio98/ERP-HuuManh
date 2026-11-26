# PoC đọc ảnh bảng đặt hàng nhiều chi nhánh (Cloudflare Workers AI)

Mã thử nghiệm cho `docs/ZALO-ORDER.md` mục 9.8. **Không phải mã chạy production** — chỉ để tái hiện kết quả và làm mẫu khi viết tính năng thật.

## Chuẩn bị (không commit hai file dưới đây)
- `anh-mau.png`: ảnh bảng khách gửi (ảnh của khách, **không đưa vào repo**). Toạ độ cột/dòng trong `greenmask.py`, `pipeline.py` đang đặt cho ảnh mẫu 817×309.
- `acc.txt`: Cloudflare account ID. Token Workers AI **không** để trong file: trong phiên Claude Code cloud, token được lưu làm *network secret* của môi trường cho host `api.cloudflare.com` (proxy tự chèn header). Chạy ở máy khác thì sửa header `Authorization` trong script để đọc từ biến môi trường `CLOUDFLARE_API_TOKEN`.
- Python 3 + Pillow + numpy.

## Các file
| File | Việc |
|---|---|
| `pipeline.py` | **Quy trình đầy đủ**: chuẩn hoá → 4 dải → Gemma 4 → mặt nạ ô xanh → bù TỔNG → chấm điểm theo `truth.json`. `python3 pipeline.py anh1.png anh2.jpg …` |
| `tiles.py`, `tilerun.py` | Cắt dải / gửi các dải song song tới một model, gộp kết quả |
| `greenmask.py` | Mặt nạ ô có số (ô nền xanh) |
| `fix2.py` | Bù ô thiếu bằng cột TỔNG + đánh dấu dòng cần xem |
| `ensemble.py` | Thử gộp nhiều lần chạy (không cần nếu dùng `fix2`) |
| `run.py` | Gửi nguyên ảnh tới một model (so sánh) |
| `score.py` | Chấm điểm một kết quả JSON theo `truth.json` |
| `truth.json` | Đáp án chuẩn chép tay của ảnh mẫu (22 dòng × 12 chi nhánh) |

Giá: Gemma 4 0,10 USD/M token vào, 0,30 USD/M token ra (9.091 / 27.273 neuron mỗi M token). Gói miễn phí 10.000 neuron/ngày, đặt lại 00:00 UTC.
