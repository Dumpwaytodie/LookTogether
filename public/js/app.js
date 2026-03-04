/**
 * NovaCast — Main App
 */
const App = (() => {

  const AVATARS = ['🦊','🐺','🦁','🐯','🦝','🦋','🐙','🦄','🐻','🐼','🦅','🦉','🦈','🐉','🦑','🐬','🦖','🐧','🦩','🦚'];
  const ADJ = [
    'Sơn','Tùng','Mỹ','Tâm','Đức','Phúc','Hoàng','Thùy',
    'Chi','Noo','Jack','Erik','Min','Trúc','Hà','Hương',
    'Đen','Vũ','Bích','Phương','Hồ','Ngọc','Hòa','Miu'
  ];

  const NOUN = [
    'M-TP','Sky','Fan','Vibe','Show','Live','Stage',
    'Hit','Ballad','Remix','Acoustic','Rap','Idol',
    'Queen','King','Legend','Star','Voice','Tour'
  ];

  let socket = null;
  let myId   = null;
  let myNick = '';
  let myAvatar = AVATARS[0];
  let roomId  = '';

  // peerId -> { nick, avatar, micOn, camOn, screenOn }
  const peers = {};

  // peerId -> { cam: HTMLElement|null, screen: HTMLElement|null }
  const peerTiles = {};
  const myTiles   = { cam: null, screen: null };
  // streamId -> tile element (for precise removal)
  const streamTileMap = {};

  let micOn    = false;
  let camOn    = false;
  let screenOn = false;

  // ── INIT ──
  function init() {
    renderAvatarPicker();
    autoFillNick();
    autoFillRoomFromURL();

    document.getElementById('btnCreate').onclick = createRoom;
    document.getElementById('btnJoin').onclick   = joinRoom;
    document.getElementById('btnInvite').onclick = () => openModal();

    socket = io();
    myId = socket.id;

    socket.on('connect',    () => { myId = socket.id; });
    socket.on('user-joined', onUserJoined);
    socket.on('user-left',   onUserLeft);
    socket.on('chat',        onChatMessage);
    socket.on('media-state', onMediaState);

    WebRTC.init(socket, {
      onRemoteStream: (peerId, stream, isScreen) => onRemoteStream(peerId, stream, isScreen),
      onRemoveStream: (peerId, isScreen, streamId) => onRemoveStream(peerId, isScreen, streamId),
    });
  }

  function renderAvatarPicker() {
    const picker = document.getElementById('avatarPicker');
    myAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
    AVATARS.forEach(av => {
      const el = document.createElement('div');
      el.className = 'av-opt' + (av === myAvatar ? ' selected' : '');
      el.textContent = av;
      el.onclick = () => {
        myAvatar = av;
        picker.querySelectorAll('.av-opt').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
      };
      picker.appendChild(el);
    });
  }

  function autoFillNick() {
    const n = document.getElementById('nicknameInput');
    n.value = ADJ[Math.floor(Math.random()*ADJ.length)] + ' ' + NOUN[Math.floor(Math.random()*NOUN.length)];
  }

  function autoFillRoomFromURL() {
    const p = new URLSearchParams(location.search);
    const rid = p.get('room');
    if (rid) {
      document.getElementById('joinInput').value = rid;
      toast('🔗 Nhập biệt danh và nhấn "Vào phòng" để tham gia!', 'info');
    }
  }

  // ── ROOM ACTIONS ──
  function createRoom() {
    const nick = document.getElementById('nicknameInput').value.trim();
    if (!nick) { showLobbyError('Nhập biệt danh của bạn!'); return; }
    myNick = nick;
    clearLobbyError();
    socket.emit('create-room', { nick, avatar: myAvatar }, ({ roomId: rid }) => {
      roomId = rid;
      doJoin();
    });
  }

  function joinRoom() {
    const nick = document.getElementById('nicknameInput').value.trim();
    const rid  = document.getElementById('joinInput').value.trim().toUpperCase();
    if (!nick) { showLobbyError('Nhập biệt danh của bạn!'); return; }
    if (!rid)  { showLobbyError('Nhập Room ID!'); return; }
    myNick = nick; roomId = rid;
    clearLobbyError();
    doJoin();
  }

  function doJoin() {
    socket.emit('join-room', { roomId, nick: myNick, avatar: myAvatar }, (res) => {
      if (res.error) { showLobbyError(res.error); return; }
      // Enter room UI
      document.getElementById('lobby').classList.add('hidden');
      document.getElementById('room').classList.remove('hidden');
      document.getElementById('roomIdBadge').textContent = roomId;
      updateURL();

      // Existing members
      res.members.forEach(m => {
        peers[m.socketId] = { nick: m.nick, avatar: m.avatar, micOn: false, camOn: false, screenOn: false };
      });

      systemMsg(`Chào ${myAvatar} ${myNick}! Room: ${roomId}`);
      renderPeople();
      updatePeerCount();
      openModal();

      // Call existing members
      res.members.forEach(m => WebRTC.callPeer(m.socketId));
    });
  }

  // ── SOCKET EVENTS ──
  function onUserJoined({ socketId, nick, avatar }) {
    peers[socketId] = { nick, avatar, micOn: false, camOn: false, screenOn: false };
    systemMsg(`${avatar} ${nick} đã tham gia`);
    renderPeople();
    updatePeerCount();
    // New user calls us back — nothing to do, they'll call us
  }

  function onUserLeft({ socketId }) {
    const p = peers[socketId];
    if (p) systemMsg(`${p.avatar} ${p.nick} đã rời phòng`);
    delete peers[socketId];
    WebRTC.closePeer(socketId);
    removePeerTiles(socketId);
    renderPeople();
    updatePeerCount();
  }

  function onChatMessage({ socketId, nick, avatar, text, time }) {
    const isMine = socketId === socket.id;
    appendChat(isMine, nick, avatar, text, time);
  }

  function onMediaState({ socketId, micOn: m, camOn: c, screenOn: s }) {
    if (peers[socketId]) {
      peers[socketId].micOn   = m;
      peers[socketId].camOn   = c;
      peers[socketId].screenOn = s;
      renderPeople();
      updateTileLabel(socketId);
    }
  }

  function onRemoteStream(peerId, stream, isScreen) {
    const p = peers[peerId] || { nick: 'Khách', avatar: '👤' };

    if (!peerTiles[peerId]) peerTiles[peerId] = {};

    const tileKey = isScreen ? 'screen' : 'cam';

    // Remove old tile for this slot if it exists
    if (peerTiles[peerId][tileKey]) {
      peerTiles[peerId][tileKey].remove();
      peerTiles[peerId][tileKey] = null;
    }

    // Only create tile if stream has video tracks (audio-only streams don't need a tile)
    const hasVideo = stream.getVideoTracks().length > 0;
    if (!hasVideo && !isScreen) {
      // audio only — no tile, but audio will play via existing video element or we add hidden audio
      return;
    }

    const tile = makeTile(stream, p.avatar, p.nick, false, isScreen);
    tile.dataset.peer     = peerId;
    tile.dataset.type     = tileKey;
    tile.dataset.streamId = stream.id;

    peerTiles[peerId][tileKey] = tile;
    streamTileMap[stream.id]   = tile;
    addTile(tile);
  }

  function onRemoveStream(peerId, isScreen, streamId) {
    // Remove by streamId first (most precise)
    if (streamId && streamTileMap[streamId]) {
      streamTileMap[streamId].remove();
      delete streamTileMap[streamId];
      if (peerTiles[peerId]) {
        const key = isScreen ? 'screen' : 'cam';
        if (peerTiles[peerId][key] && peerTiles[peerId][key].dataset.streamId === streamId) {
          peerTiles[peerId][key] = null;
        }
      }
      refreshGrid();
      return;
    }
    // Fallback: remove all tiles for peer
    removePeerTiles(peerId);
  }

  function removePeerTiles(peerId) {
    if (peerTiles[peerId]) {
      Object.values(peerTiles[peerId]).forEach(t => {
        if (t) {
          if (t.dataset.streamId) delete streamTileMap[t.dataset.streamId];
          t.remove();
        }
      });
      delete peerTiles[peerId];
    }
    refreshGrid();
  }

  // ── MEDIA CONTROLS ──
  async function toggleMic() {
    if (!micOn) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000, channelCount: 2 },
          video: false
        });
        // Add audio tracks to camStream or create new stream
        if (!WebRTC.localCamStream) WebRTC.localCamStream = new MediaStream();
        s.getAudioTracks().forEach(t => WebRTC.localCamStream.addTrack(t));
        micOn = true;
        setCtrl('ctrlMic', true, '🎙️', 'Tắt mic');
        toast('🎙️ Mic đã bật');
      } catch (e) { toast('Không thể bật mic: ' + e.message, 'warn'); return; }
    } else {
      if (WebRTC.localCamStream) {
        WebRTC.localCamStream.getAudioTracks().forEach(t => { t.stop(); WebRTC.localCamStream.removeTrack(t); });
      }
      micOn = false;
      setCtrl('ctrlMic', false, '🔇', 'Bật mic');
      toast('Mic đã tắt');
    }
    emitState();
    WebRTC.updateAllPeers();
  }

  async function toggleCamera() {
    if (!camOn) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, min: 30 } },
          audio: false
        });
        if (!WebRTC.localCamStream) WebRTC.localCamStream = new MediaStream();
        s.getVideoTracks().forEach(t => WebRTC.localCamStream.addTrack(t));
        camOn = true;
        setCtrl('ctrlCam', true, '📷', 'Tắt camera');
        toast('📷 Camera đã bật');
        // Show my cam tile
        showMyCamTile();
      } catch (e) { toast('Không thể bật camera: ' + e.message, 'warn'); return; }
    } else {
      if (WebRTC.localCamStream) {
        WebRTC.localCamStream.getVideoTracks().forEach(t => { t.stop(); WebRTC.localCamStream.removeTrack(t); });
      }
      camOn = false;
      setCtrl('ctrlCam', false, '📷', 'Bật camera');
      if (myTiles.cam) { myTiles.cam.remove(); myTiles.cam = null; }
      refreshGrid();
      toast('Camera đã tắt');
    }
    emitState();
    WebRTC.updateAllPeers();
  }

  async function toggleScreen() {
    if (!screenOn) {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
            frameRate: { ideal: 60, max: 60 },
            displaySurface: 'monitor'
          },
          // Request system audio — user must tick "Share audio" in Chrome dialog
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2
          }
        });

        WebRTC.localScreenStream = s;
        screenOn = true;
        setCtrl('ctrlScreen', true, '🖥️', 'Dừng chia sẻ');

        const hasAudio = s.getAudioTracks().length > 0;
        toast(`🖥️ Đang chia sẻ màn hình${hasAudio ? ' + âm thanh' : ' (không có âm thanh hệ thống)'}`, 'success');

        showMyScreenTile();
        WebRTC.updateAllPeers();
        emitState();

        // Handle when user clicks "Stop sharing" in browser UI
        s.getVideoTracks()[0].onended = () => {
          _stopScreen();
        };

      } catch (e) {
        if (e.name !== 'NotAllowedError') toast('Lỗi share màn hình: ' + e.message, 'warn');
        return;
      }
    } else {
      _stopScreen();
    }
  }

  function _stopScreen() {
    // Stop all tracks first
    if (WebRTC.localScreenStream) {
      WebRTC.localScreenStream.getTracks().forEach(t => t.stop());
      WebRTC.localScreenStream = null;  // must be null BEFORE updateAllPeers
    }
    screenOn = false;
    setCtrl('ctrlScreen', false, '🖥️', 'Chia sẻ màn hình');

    // Remove local screen tile
    if (myTiles.screen) {
      if (myTiles.screen.dataset.streamId) delete streamTileMap[myTiles.screen.dataset.streamId];
      myTiles.screen.remove();
      myTiles.screen = null;
    }
    refreshGrid();
    emitState();
    // Renegotiate to remove screen tracks from remote peers
    WebRTC.updateAllPeers();
    toast('Đã dừng chia sẻ màn hình');
  }

  function showMyCamTile() {
    if (myTiles.cam) {
      if (myTiles.cam.dataset.streamId) delete streamTileMap[myTiles.cam.dataset.streamId];
      myTiles.cam.remove();
    }
    const stream = WebRTC.localCamStream;
    const tile = makeTile(stream, myAvatar, myNick + ' (Bạn)', true, false);
    tile.dataset.peer = 'local-cam';
    tile.dataset.type = 'cam';
    if (stream) { tile.dataset.streamId = stream.id; streamTileMap[stream.id] = tile; }
    myTiles.cam = tile;
    addTile(tile);
  }

  function showMyScreenTile() {
    if (myTiles.screen) {
      if (myTiles.screen.dataset.streamId) delete streamTileMap[myTiles.screen.dataset.streamId];
      myTiles.screen.remove();
    }
    const stream = WebRTC.localScreenStream;
    const tile = makeTile(stream, myAvatar, myNick + ' (Bạn)', true, true);
    tile.dataset.peer = 'local-screen';
    tile.dataset.type = 'screen';
    if (stream) { tile.dataset.streamId = stream.id; streamTileMap[stream.id] = tile; }
    myTiles.screen = tile;
    addTile(tile);
  }

  function emitState() {
    socket.emit('media-state', { micOn, camOn, screenOn });
  }

  // ── VIDEO TILES ──
  function makeTile(stream, avatar, nick, muted, isScreen) {
    const tile = document.createElement('div');
    tile.className = 'vtile' + (isScreen ? ' is-screen' : '');

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = muted;
    if (stream) video.srcObject = stream;
    tile.appendChild(video);

    const label = document.createElement('div');
    label.className = 'vtile-label';
    label.innerHTML = `<span>${avatar}</span><span>${esc(nick)}</span>`;
    tile.appendChild(label);

    if (isScreen) {
      const badge = document.createElement('div');
      badge.className = 'vtile-screen-badge';
      badge.textContent = 'SCREEN';
      tile.appendChild(badge);
    }

    return tile;
  }

  function addTile(tile) {
    const grid = document.getElementById('videoGrid');
    const empty = document.getElementById('emptyVideo');
    if (empty) empty.remove();
    grid.appendChild(tile);
    refreshGrid();
  }

  function refreshGrid() {
    const grid = document.getElementById('videoGrid');
    const tiles = grid.querySelectorAll('.vtile');

    // Remove all grid classes
    grid.className = 'video-grid';

    if (tiles.length === 0) {
      if (!document.getElementById('emptyVideo')) {
        const e = document.createElement('div');
        e.className = 'empty-video'; e.id = 'emptyVideo';
        e.innerHTML = '<div class="ev-icon">🎥</div><div class="ev-title">Chưa có video</div><div class="ev-sub">Bật camera hoặc chia sẻ màn hình</div>';
        grid.appendChild(e);
      }
      grid.classList.add('grid-1');
    } else if (tiles.length === 1) { grid.classList.add('grid-1'); }
    else if (tiles.length === 2)   { grid.classList.add('grid-2'); }
    else if (tiles.length === 3)   { grid.classList.add('grid-3'); }
    else if (tiles.length === 4)   { grid.classList.add('grid-4'); }
    else                           { grid.classList.add('grid-n'); }
  }

  function updateTileLabel(peerId) {
    const p = peers[peerId];
    if (!p || !peerTiles[peerId]) return;
    Object.values(peerTiles[peerId]).forEach(tile => {
      if (!tile) return;
      const lbl = tile.querySelector('.vtile-label');
      if (lbl) lbl.innerHTML = `<span>${p.avatar}</span><span>${esc(p.nick)}</span>${!p.micOn ? '<span class="vtile-muted">🔇</span>' : ''}`;
    });
  }

  // ── CHAT ──
  function sendChat() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const time = new Date().toLocaleTimeString('vi', { hour: '2-digit', minute: '2-digit' });
    socket.emit('chat', { text, time });
  }

  function onChatMessage({ socketId, nick, avatar, text, time }) {
    const isMine = socketId === socket.id;
    appendChat(isMine, nick, avatar, text, time);
  }

  function appendChat(isMine, nick, avatar, text, time) {
    const area = document.getElementById('messages');
    const div  = document.createElement('div');
    div.className = 'msg' + (isMine ? ' mine' : '');
    div.innerHTML = `
      <div class="msg-head">
        <span class="msg-av">${avatar}</span>
        <span class="msg-nick">${esc(nick)}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-body">${esc(text)}</div>`;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
    if (!isMine) switchTab('chat');
  }

  function systemMsg(text) {
    const area = document.getElementById('messages');
    const d = document.createElement('div');
    d.className = 'sys-msg'; d.textContent = text;
    area.appendChild(d);
    area.scrollTop = area.scrollHeight;
  }

  // ── PEOPLE ──
  function renderPeople() {
    const list = document.getElementById('peopleList');
    list.innerHTML = '';

    // Me
    const me = document.createElement('div');
    me.className = 'person';
    me.innerHTML = `
      <div class="person-av">${myAvatar}</div>
      <div class="person-info">
        <div class="person-name">${esc(myNick)} <span class="you-tag">Bạn</span></div>
        <div class="person-status">${micOn ? '🎙️ Mic' : ''} ${camOn ? '📷 Cam' : ''} ${screenOn ? '🖥️ Screen' : ''}</div>
      </div>`;
    list.appendChild(me);

    Object.entries(peers).forEach(([id, p]) => {
      const el = document.createElement('div');
      el.className = 'person';
      el.innerHTML = `
        <div class="person-av">${p.avatar}</div>
        <div class="person-info">
          <div class="person-name">${esc(p.nick)}</div>
          <div class="person-status">${p.micOn ? '🎙️' : ''} ${p.camOn ? '📷' : ''} ${p.screenOn ? '🖥️' : ''}</div>
        </div>`;
      list.appendChild(el);
    });
  }

  function updatePeerCount() {
    document.getElementById('peerCount').textContent = 1 + Object.keys(peers).length;
  }

  // ── TABS ──
  function switchTab(tab) {
    document.getElementById('panelChat').classList.toggle('hidden', tab !== 'chat');
    document.getElementById('panelPeople').classList.toggle('hidden', tab !== 'people');
    document.getElementById('tabChat').classList.toggle('active', tab === 'chat');
    document.getElementById('tabPeople').classList.toggle('active', tab === 'people');
  }

  // ── INVITE MODAL ──
  function openModal() {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    document.getElementById('inviteLinkText').textContent = url.toString();
    document.getElementById('modalBg').classList.remove('hidden');
  }

  function closeModal(e) {
    if (!e || e.target.id === 'modalBg') {
      document.getElementById('modalBg').classList.add('hidden');
    }
  }

  function copyLink() {
    const link = document.getElementById('inviteLinkText').textContent;
    navigator.clipboard.writeText(link).then(() => toast('✅ Đã sao chép link!', 'success'));
  }

  // ── LEAVE ──
  function leave() {
    WebRTC.closeAll();
    socket.disconnect();
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState({}, '', url.toString());
    location.reload();
  }

  // ── HELPERS ──
  function setCtrl(id, on, icon, tip) {
    const el = document.getElementById(id);
    el.textContent = icon;
    el.classList.toggle('on', on);
    el.dataset.tip = tip;
  }

  function updateURL() {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    history.replaceState({}, '', url.toString());
  }

  function showLobbyError(msg) { document.getElementById('lobbyError').textContent = msg; }
  function clearLobbyError()   { document.getElementById('lobbyError').textContent = ''; }

  function toast(msg, type = 'info') {
    const c = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3100);
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Override onChatMessage properly (avoid duplicate binding)
  // Socket binding is in init(), so we wire it after socket is created
  // Patch: make onChatMessage accessible
  window.addEventListener('DOMContentLoaded', init);

  return { toggleMic, toggleCamera, toggleScreen, sendChat, switchTab, openModal, closeModal, copyLink, leave };
})();
