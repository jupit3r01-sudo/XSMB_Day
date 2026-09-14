# Tự động chụp kết quả xổ số mỗi ngày 7h sáng → gửi Telegram

Toàn bộ job này chạy trên máy chủ của GitHub (GitHub Actions), **bạn không cần cài gì trên máy mình, không cần Task Scheduler**. Bạn chỉ cần tạo 1 repo GitHub và dán các file này vào qua trình duyệt.

## 1. Tạo bot Telegram

1. Mở Telegram, tìm và chat với **@BotFather**.
2. Gửi lệnh `/newbot`, đặt tên bot, đặt username (phải kết thúc bằng `bot`, vd `xoso_capture_bot`).
3. BotFather trả về một **token** dạng `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Lưu lại — đây là `TELEGRAM_BOT_TOKEN`.
4. Bấm vào bot bạn vừa tạo trong Telegram, gửi bất kỳ tin nhắn nào (ví dụ "hi") để bot ghi nhận cuộc chat với bạn.

## 2. Lấy Chat ID của bạn

Cách đơn giản nhất: chat với bot **@userinfobot** trên Telegram, nó sẽ trả về `Id: xxxxxxxx` — đó là `TELEGRAM_CHAT_ID` của bạn.

(Nếu muốn tự lấy qua API: mở trình duyệt vào
`https://api.telegram.org/bot<TOKEN>/getUpdates` sau khi đã gửi tin nhắn cho bot ở bước 1, tìm trường `"chat":{"id":...}`.)

## 3. Tạo repo GitHub

1. Vào https://github.com, đăng nhập/đăng ký (miễn phí).
2. Bấm **New repository**, đặt tên (vd `minhngoc-auto-capture`), chọn **Private** nếu muốn giữ kín, bấm **Create repository**.
3. Trong repo mới, dùng nút **Add file → Upload files** (trên web, không cần git/cài gì) để tải lên đúng cấu trúc sau:

```
minhngoc-auto-capture/
├── package.json
├── capture.js
└── .github/workflows/capture.yml
```

> Lưu ý: khi upload qua web UI, GitHub cho phép kéo cả thư mục `.github/workflows` vào — cấu trúc thư mục sẽ được giữ nguyên.

## 4. Khai báo Secrets (để không lộ token trong code)

1. Trong repo → **Settings** → **Secrets and variables** → **Actions**.
2. Bấm **New repository secret**:
   - Tên: `TELEGRAM_BOT_TOKEN`, giá trị: token lấy ở bước 1.
3. Bấm **New repository secret** lần nữa:
   - Tên: `TELEGRAM_CHAT_ID`, giá trị: chat id lấy ở bước 2.

## 5. Kiểm tra chạy thử

1. Vào tab **Actions** của repo.
2. Chọn workflow **"Chup ket qua xo so hang ngay"**.
3. Bấm **Run workflow** (nút màu xanh, chạy thủ công) để test ngay, không cần chờ tới 7h sáng.
4. Sau ~30–60 giây, kiểm tra Telegram — bot sẽ gửi ảnh kết quả (hoặc gửi tin nhắn báo lỗi nếu có vấn đề, xem log trong tab Actions để debug).

## 6. Lịch chạy tự động

Workflow đã đặt cron `0 0 * * *` = 00:00 UTC = **07:00 giờ Việt Nam** mỗi ngày. Không cần làm gì thêm, GitHub sẽ tự chạy.

### Lưu ý quan trọng
- Muốn đổi sang trang miền Trung/Nam: sửa dòng `TARGET_URL` trong file `.github/workflows/capture.yml`.
- GitHub Actions cron có thể **trễ vài phút** vào giờ cao điểm (đây là giới hạn chung của GitHub, không phải lỗi script).
- Nếu repo **không có hoạt động (commit) trong 60 ngày**, GitHub tự tạm dừng workflow theo lịch — chỉ cần vào tab Actions bấm "Run workflow" một lần hoặc commit gì đó là kích hoạt lại.
- Tài khoản GitHub miễn phí có giới hạn ~2000 phút chạy Actions/tháng — job này chạy vài chục giây/ngày nên dùng không đáng kể.
