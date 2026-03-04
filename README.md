# 🚀 NovaCast

Share màn hình · Video call · Chat thời gian thực — Không cần tài khoản

---

## 📁 Cấu trúc project

```
novacast/
├── server/
│   └── index.js          # Signaling server (Socket.IO + Express)
├── public/
│   ├── index.html         # Giao diện chính
│   ├── css/
│   │   └── style.css      # Toàn bộ styles
│   └── js/
│       ├── webrtc.js      # WebRTC manager (peer connections)
│       └── app.js         # Logic chính của app
├── package.json
└── README.md
```

---

## ⚡ Cài đặt & Chạy

### 1. Cài dependencies

```bash
npm install
```

### 2. Chạy server

```bash
npm start
```

Server sẽ chạy tại: **http://localhost:3000**

### 3. (Dev) Auto-reload khi sửa code

```bash
npm run dev
```

---

## 🌐 Cách sử dụng

1. Mở `http://localhost:3000` trong trình duyệt
2. Nhập biệt danh, chọn avatar
3. Nhấn **"Tạo phòng mới"**
4. Copy link mời → gửi cho bạn bè
5. Bạn bè mở link → nhập biệt danh → **"Vào phòng"**

---

## ✨ Tính năng

| Tính năng | Chi tiết |
|-----------|---------|
| 🖥️ Screen share | Chia sẻ màn hình / cửa sổ / tab — 1080p / 60fps |
| 🔊 System audio | Share kèm âm thanh hệ thống (Chrome/Edge) |
| 📷 Camera | Video call chất lượng cao |
| 🎙️ Mic | Voice với noise cancellation |
| 💬 Chat | Tin nhắn realtime, avatar, timestamp |
| 🔗 Invite link | Chỉ cần link, không cần tài khoản |
| 👥 Participants | Xem danh sách người dùng, trạng thái mic/cam |
| 🎲 Random avatar | Tự động gán avatar và tên ngẫu nhiên |

---

## 🌍 Deploy lên internet (để dùng ngoài mạng LAN)

### Option 1: Railway (miễn phí, dễ nhất)
```bash
# Push lên GitHub rồi kết nối với railway.app
```

### Option 2: Render.com
```bash
# Tạo Web Service, kết nối GitHub repo
# Build command: npm install
# Start command: npm start
```

### Option 3: ngrok (test nhanh)
```bash
npm start
# Terminal khác:
ngrok http 3000
```

---

## ⚙️ Cấu hình

Đổi port trong `server/index.js`:
```js
const PORT = process.env.PORT || 3000;
```

Hoặc dùng biến môi trường:
```bash
PORT=8080 npm start
```

---

## 🔧 Yêu cầu

- Node.js 16+
- Trình duyệt: **Chrome hoặc Edge** (tốt nhất cho screen share + system audio)
- HTTPS khi deploy (WebRTC yêu cầu HTTPS trên production)
