const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e7 });

app.use(express.static(path.join(__dirname, '../public')));

const rooms = {}; // roomId -> { socketId: { nick, avatar, socketId } }

function genRoomId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }
function members(roomId) { return Object.values(rooms[roomId] || {}); }

io.on('connection', (socket) => {
  let currentRoom = null;
  let myInfo = null;

  socket.on('create-room', ({ nick, avatar }, cb) => {
    const roomId = genRoomId();
    rooms[roomId] = {};
    currentRoom = roomId;
    myInfo = { socketId: socket.id, nick, avatar };
    rooms[roomId][socket.id] = myInfo;
    socket.join(roomId);
    cb({ roomId, members: [] });
    console.log(`[${roomId}] created by ${nick}`);
  });

  socket.on('join-room', ({ roomId, nick, avatar }, cb) => {
    roomId = roomId.toUpperCase().trim();
    if (!rooms[roomId]) rooms[roomId] = {};
    if (currentRoom === roomId) {
      cb({ success: true, members: members(roomId).filter(m => m.socketId !== socket.id) });
      return;
    }
    currentRoom = roomId;
    myInfo = { socketId: socket.id, nick, avatar };
    rooms[roomId][socket.id] = myInfo;
    socket.join(roomId);
    const existing = members(roomId).filter(m => m.socketId !== socket.id);
    cb({ success: true, members: existing });
    socket.to(roomId).emit('user-joined', myInfo);
    console.log(`[${roomId}] ${nick} joined. Total: ${Object.keys(rooms[roomId]).length}`);
  });

  socket.on('chat', ({ text, time }) => {
    if (!currentRoom || !myInfo) return;
    io.to(currentRoom).emit('chat', { socketId: socket.id, nick: myInfo.nick, avatar: myInfo.avatar, text, time });
  });

  // WebRTC signaling
  socket.on('offer',         ({ to, offer })     => socket.to(to).emit('offer',         { from: socket.id, offer }));
  socket.on('answer',        ({ to, answer })    => socket.to(to).emit('answer',        { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => socket.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  // Stream metadata relay: which streamId is a screen share
  socket.on('stream-meta-to', ({ to, streamId, isScreen }) => {
    socket.to(to).emit('stream-meta', { from: socket.id, streamId, isScreen });
  });

  socket.on('media-state', (state) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('media-state', { socketId: socket.id, ...state });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom][socket.id];
      socket.to(currentRoom).emit('user-left', { socketId: socket.id });
      if (Object.keys(rooms[currentRoom]).length === 0) {
        delete rooms[currentRoom];
        console.log(`[${currentRoom}] deleted (empty)`);
      }
      if (myInfo) console.log(`[${currentRoom}] ${myInfo.nick} left`);
    }
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 NovaCast @ http://localhost:${PORT}\n`);
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => { http.get(`${process.env.RENDER_EXTERNAL_URL}/health`).on('error', () => {}); }, 10 * 60 * 1000);
  }
});

// ICE config endpoint — trả TURN credentials cho client
// Cấu hình: set TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL trong env
app.get('/ice-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const { TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL) {
    iceServers.push({
      urls: TURN_URLS.split(',').map(u => u.trim()),
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
    console.log('[ICE] TURN enabled:', TURN_URLS);
  } else {
    console.warn('[ICE] TURN not configured — cross-network calls may fail');
  }
  res.json({ iceServers });
});