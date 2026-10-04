# h5p2scorm – Chuyển H5P sang SCORM 1.2 / SCORM 2004

Công cụ dòng lệnh đóng gói file `.h5p` thành gói SCORM để đưa lên các LMS chỉ hỗ trợ SCORM.
Hỗ trợ chuyển hàng loạt cả thư mục, xuất SCORM 1.2, SCORM 2004 (4th Edition) hoặc cả hai.

Mỗi gói SCORM:
- Chạy nội dung H5P bằng trình phát `h5p-standalone` (không cần máy chủ H5P).
- Ghi **điểm** (quy về thang 100), **trạng thái hoàn thành / đạt – không đạt** và **thời gian học** lên LMS.
- **Lưu tiến độ** khi học viên thoát giữa chừng và **khôi phục** khi mở lại (`cmi.suspend_data`).

## Cài đặt

Cần Node.js 18 trở lên.

```bash
cd h5p2scorm
npm install        # chỉ cần nếu thư mục node_modules chưa có sẵn
```

## Sử dụng

```bash
# Chuyển 1 file, xuất cả SCORM 1.2 và 2004
node h5p2scorm.js bai1.h5p

# Chuyển cả thư mục (quét cả thư mục con), ngưỡng đạt 80%
node h5p2scorm.js hoc-lieu/ -o goi-scorm -m 80

# Chỉ xuất SCORM 1.2
node h5p2scorm.js hoc-lieu/ --scorm 1.2

# Nội dung không chấm điểm (Accordion, video, bài đọc): hoàn thành khi mở
node h5p2scorm.js bai-doc.h5p --complete-on-open
```

Kết quả: `<tên file>_scorm12.zip` và `<tên file>_scorm2004.zip` trong thư mục xuất (mặc định `scorm-out`).
Upload file zip đó lên LMS như một gói SCORM thông thường.

### Tuỳ chọn

| Tuỳ chọn | Ý nghĩa |
|---|---|
| `-o, --out <thư mục>` | Thư mục xuất (mặc định `./scorm-out`) |
| `-s, --scorm <1.2\|2004\|both>` | Phiên bản SCORM (mặc định `both`) |
| `-m, --mastery <0-100>` | Ngưỡng đạt (%). Có ngưỡng → báo `passed`/`failed`; không có → chỉ báo `completed` kèm điểm |
| `--complete-on-open` | Đánh dấu hoàn thành ngay khi mở (cho nội dung không chấm điểm) |
| `--score last` | Ghi điểm của lần làm cuối (mặc định giữ **điểm cao nhất**) |
| `--no-resume` | Không lưu/khôi phục tiến độ |
| `--max-width <css>` | Độ rộng tối đa của khung nội dung (mặc định `1100px`) |
| `--title <tiêu đề>` | Ghi đè tiêu đề gói (chỉ khi chuyển 1 file) |
| `--debug` | Ghi log chi tiết ra console trình duyệt để dò lỗi |

## Dữ liệu ghi lên LMS

| | SCORM 1.2 | SCORM 2004 |
|---|---|---|
| Khi mở | `lesson_status = incomplete` | `completion_status = incomplete` |
| Điểm | `score.raw` (0–100), `min=0`, `max=100` | thêm `score.scaled` (0–1) |
| Có ngưỡng đạt | `lesson_status = passed / failed` | `success_status = passed / failed` |
| Không có ngưỡng | `lesson_status = completed` | `completion_status = completed` |
| Thời gian | `session_time` | `session_time` |
| Tiến độ | `suspend_data` (tối đa 4.096 ký tự) | `suspend_data` (tối đa 64.000 ký tự) |

- Ngưỡng đạt ưu tiên giá trị LMS cung cấp (`mastery_score` / `scaled_passing_score`); nếu LMS không có thì dùng `-m`.
  Khi dùng `-m`, ngưỡng cũng được ghi vào `imsmanifest.xml`.
- Chỉ điểm của **nội dung chính** được ghi (bỏ qua điểm của từng câu con), nên Question Set,
  Interactive Video, Course Presentation… đều báo một điểm tổng.

## Lưu ý

- **File tải từ h5p.org thường thiếu thư viện.** Công cụ sẽ cảnh báo “Thiếu thư viện…”. Cách xử lý:
  mở file bằng Lumi Desktop hoặc tải lên Moodle rồi xuất lại `.h5p` (khi đó gói kèm đủ thư viện).
- **SCORM 1.2 giới hạn `suspend_data` 4.096 ký tự.** Nội dung dài (Interactive Book, Course
  Presentation nhiều trang) có thể vượt giới hạn → vẫn ghi điểm bình thường nhưng không lưu được
  tiến độ. Nếu LMS hỗ trợ, nên dùng gói SCORM 2004.
- **Không có chi tiết từng câu hỏi** (`cmi.interactions`) – LMS chỉ nhận điểm tổng và trạng thái.
- Gói **không chạy khi mở trực tiếp `index.html` từ ổ đĩa** (`file://`) vì trình phát cần tải file JSON;
  cần mở qua LMS hoặc một web server.
- Video nhúng YouTube/Vimeo cần học viên có Internet; video tải lên trong H5P được đóng gói kèm.
- Gói không kèm các file `.xsd`. Moodle, Canvas, Blackboard… không yêu cầu; nếu một LMS kiểm tra
  nghiêm ngặt đòi file `.xsd`, hãy báo để bổ sung.

## Kiểm thử

Thư mục `test/` có một LMS giả lập và kịch bản kiểm thử tự động (Python + Playwright) chạy trên
file mẫu `samples/`:

```bash
node h5p2scorm.js samples -o out -m 80
python test/run_test.py
```

Kịch bản kiểm tra cho cả 1.2 và 2004: trạng thái khi mở, điểm khi trả lời sai/đúng, giữ điểm cao nhất,
thời gian học, `exit`, lưu và khôi phục tiến độ.

## Cấu trúc gói SCORM sinh ra

```
imsmanifest.xml      khai báo SCORM 1.2 hoặc 2004
index.html           trang khởi chạy
config.js            cấu hình (phiên bản, ngưỡng đạt…)
scorm-bridge.js      cầu nối xAPI → SCORM API
player/              trình phát h5p-standalone
h5p/                 nội dung H5P đã giải nén
```
