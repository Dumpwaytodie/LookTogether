# 🚀 NovaCast

Share màn hình · Video call · Chat realtime — Không cần tài khoản

---

## 📁 Cấu trúc project

```
novacast/
├── server/index.js       # Signaling server (Socket.IO + Express)
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── webrtc.js
│       └── app.js
├── render.yaml           # Config Render.com
├── .gitignore
├── package.json
└── README.md
```

---

## ⚡ Chạy local

```bash
npm install
npm start
# Mở http://localhost:3000
```

---

## 🌐 Deploy lên Render.com (FREE)

### Bước 1 — Push lên GitHub

```bash
git init
git add .
git commit -m "init novacast"
git remote add origin https://github.com/TÊN_BẠN/novacast.git
git push -u origin main
```

### Bước 2 — Tạo Web Service trên Render

1. Vào **render.com** → đăng nhập
2. Nhấn **"New +"** → **"Web Service"**
3. Kết nối GitHub → chọn repo **novacast**
4. Render tự đọc `render.yaml` — **không cần điền gì thêm**
5. Nhấn **"Create Web Service"**

### Bước 3 — Đợi ~2 phút

Render tự chạy `npm install` và `npm start`, cấp domain:
`https://novacast-xxxx.onrender.com`

### Bước 4 — Xong! 🎉

---

## ⚠️ Render Free Tier hay bị ngủ

Server free sẽ sleep nếu 15 phút không có request → lần đầu mở chậm ~30 giây.

**Fix bằng UptimeRobot (miễn phí):**
1. Vào **uptimerobot.com** → tạo tài khoản
2. Add Monitor → HTTP(s)
3. URL: `https://novacast-xxxx.onrender.com/health`
4. Interval: **5 minutes**
5. Server sẽ không bao giờ ngủ nữa ✅

---

## 🔧 Lưu ý

- Dùng **Chrome hoặc Edge** — Firefox không share được system audio
- Render tự cấp **HTTPS** miễn phí (WebRTC bắt buộc cần HTTPS trên production)
