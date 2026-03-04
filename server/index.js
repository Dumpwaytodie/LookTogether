const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, '../public')));

// rooms: { roomId -> { [socketId]: { nick, avatar, socketId } } }
const rooms = {};

function getRoomId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function getRoomMembers(roomId) {
  return Object.values(rooms[roomId] || {});
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let myInfo = null;

  // ── CREATE ROOM ──
  // Tạo phòng và tự join luôn
  socket.on('create-room', ({ nick, avatar }, cb) => {
    const roomId = getRoomId();
    rooms[roomId] = {};

    // Host tự join room ngay
    currentRoom = roomId;
    myInfo = { socketId: socket.id, nick, avatar };
    rooms[roomId][socket.id] = myInfo;
    socket.join(roomId);

    cb({ roomId, members: [] });
    console.log(`[${roomId}] Room created by ${nick}`);
  });

  // ── JOIN ROOM ──
  socket.on('join-room', ({ roomId, nick, avatar }, cb) => {
    roomId = roomId.toUpperCase().trim();

    // Nếu phòng chưa tồn tại (server restart mất data) → tự tạo lại
    // Điều này cho phép người dùng join qua link dù server đã restart
    if (!rooms[roomId]) {
      rooms[roomId] = {};
    }

    // Nếu socket này đã ở trong phòng rồi (tránh join 2 lần)
    if (currentRoom === roomId) {
      cb({ success: true, members: getRoomMembers(roomId).filter(m => m.socketId !== socket.id) });
      return;
    }

    currentRoom = roomId;
    myInfo = { socketId: socket.id, nick, avatar };
    rooms[roomId][socket.id] = myInfo;
    socket.join(roomId);

    const existingMembers = getRoomMembers(roomId).filter(m => m.socketId !== socket.id);
    cb({ success: true, members: existingMembers });

    socket.to(roomId).emit('user-joined', myInfo);
    console.log(`[${roomId}] ${nick} joined. Total: ${Object.keys(rooms[roomId]).length}`);
  });

  // ── CHAT ──
  socket.on('chat', ({ text, time }) => {
    if (!currentRoom || !myInfo) return;
    io.to(currentRoom).emit('chat', {
      socketId: socket.id,
      nick: myInfo.nick,
      avatar: myInfo.avatar,
      text,
      time
    });
  });

  // ── WebRTC SIGNALING ──
  socket.on('offer', ({ to, offer }) => {
    socket.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    socket.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    socket.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── MEDIA STATE ──
  socket.on('media-state', (state) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('media-state', { socketId: socket.id, ...state });
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom][socket.id];
      socket.to(currentRoom).emit('user-left', { socketId: socket.id });
      if (Object.keys(rooms[currentRoom]).length === 0) {
        delete rooms[currentRoom];
        console.log(`[${currentRoom}] Room deleted (empty)`);
      }
      if (myInfo) console.log(`[${currentRoom || '?'}] ${myInfo?.nick} left`);
    }
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 NovaCast running at http://localhost:${PORT}\n`);
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
      http.get(`${process.env.RENDER_EXTERNAL_URL}/health`).on('error', () => {});
    }, 10 * 60 * 1000);
    console.log('Keep-alive enabled for Render free tier');
  }
});
