/**
 * NovaCast — Main App v8
 */
const App = (() => {

  const AVATARS = ['🦊','🐺','🦁','🐯','🦝','🦋','🐙','🦄','🐻','🐼','🦅','🦉','🦈','🐉','🦑','🐬','🦖','🐧','🦩','🦚'];
  const ADJ    = ['Rực','Tối','Băng','Lửa','Huyền','Sóng','Thần','Mờ','Lượn','Tàng','Kim','Ngọc'];
  const NOUN   = ['Long','Hổ','Ưng','Rồng','Sói','Bão','Kiếm','Mây','Tước','Phong','Lôi','Hải'];

  let socket = null;
  let myId   = null;
  let myNick = '';
  let myAvatar = AVATARS[0];
  let roomId  = '';

  const peers = {};
  const peerTiles = {};
  const myTiles   = { cam: null, screen: null };
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

    socket.on('connect',     () => { myId = socket.id; });
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
    if (rid) document.getElementById('joinInput').value = rid;
  }

  // ── ROOM ACTIONS ──
  function createRoom() {
    const nick = document.getElementById('nicknameInput').value.trim();
    if (!nick) { showLobbyError('Nhập biệt danh của bạn!'); return; }
    myNick = nick;
    clearLobbyError();
    socket.emit('create-room', { nick, avatar: myAvatar }, ({ roomId: rid }) => {
      roomId = rid;
      doJoin(false);
    });
  }

  function joinRoom() {
    const nick = document.getElementById('nicknameInput').value.trim();
    const rid  = document.getElementById('joinInput').value.trim().toUpperCase();
    if (!nick) { showLobbyError('Nhập biệt danh của bạn!'); return; }
    if (!rid)  { showLobbyError('Nhập Room ID!'); return; }
    myNick = nick; roomId = rid;
    clearLobbyError();
    doJoin(true);
  }

  function doJoin(isGuest) {
    socket.emit('join-room', { roomId, nick: myNick, avatar: myAvatar }, (res) => {
      if (res.error) { showLobbyError(res.error); return; }

      document.getElementById('lobby').classList.add('hidden');
      document.getElementById('room').classList.remove('hidden');
      document.getElementById('roomIdBadge').textContent = roomId;
      updateURL();

      res.members.forEach(m => {
        peers[m.socketId] = { nick: m.nick, avatar: m.avatar, micOn: false, camOn: false, screenOn: false };
      });

      systemMsg(`Chào ${myAvatar} ${myNick}! Room: ${roomId}`);
      renderPeople();
      updatePeerCount();
      _initSwipeToClose();

      // Modal chỉ mở tự động cho host
      if (!isGuest) {
        setTimeout(() => openModal(), 300);
      } else {
        toast('✅ Đã vào phòng! Nhấn 🔗 để mời thêm người', 'success');
      }

      res.members.forEach(m => WebRTC.callPeer(m.socketId));
    });
  }

  // ── SOCKET EVENTS ──
  function onUserJoined({ socketId, nick, avatar }) {
    peers[socketId] = { nick, avatar, micOn: false, camOn: false, screenOn: false };
    systemMsg(`${avatar} ${nick} đã tham gia`);
    renderPeople();
    updatePeerCount();
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
    appendChat(socketId === socket.id, nick, avatar, text, time);
  }

  function onMediaState({ socketId, micOn: m, camOn: c, screenOn: s }) {
    if (peers[socketId]) {
      peers[socketId].micOn    = m;
      peers[socketId].camOn    = c;
      peers[socketId].screenOn = s;
      renderPeople();
      updateTileLabel(socketId);
    }
  }

  // ── REMOTE STREAM ──
  function onRemoteStream(peerId, stream, isScreen) {
    console.log(`[App] onRemoteStream peer=${peerId.slice(-4)} isScreen=${isScreen} tracks=${stream.getTracks().length}`);
    const p = peers[peerId] || { nick: 'Khách', avatar: '👤' };

    if (!peerTiles[peerId]) peerTiles[peerId] = {};
    const tileKey = isScreen ? 'screen' : 'cam';

    // Remove existing tile for this slot
    if (peerTiles[peerId][tileKey]) {
      const old = peerTiles[peerId][tileKey];
      if (old.dataset.streamId) delete streamTileMap[old.dataset.streamId];
      old.remove();
      peerTiles[peerId][tileKey] = null;
    }

    // Skip audio-only non-screen streams (no need for tile)
    const hasVideo = stream.getVideoTracks().length > 0;
    if (!hasVideo) {
      console.log(`[App] audio-only stream, skipping tile`);
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
    if (streamId && streamTileMap[streamId]) {
      streamTileMap[streamId].remove();
      delete streamTileMap[streamId];
      if (peerTiles[peerId]) {
        const key = isScreen ? 'screen' : 'cam';
        if (peerTiles[peerId][key]?.dataset.streamId === streamId)
          peerTiles[peerId][key] = null;
      }
      refreshGrid();
      return;
    }
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
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!WebRTC.localCamStream) WebRTC.localCamStream = new MediaStream();
        s.getAudioTracks().forEach(t => WebRTC.localCamStream.addTrack(t));
        micOn = true;
        setCtrl('ctrlMic', true, '🎙️', 'Tắt mic');
        toast('🎙️ Mic đã bật');
      } catch (e) { toast('Không thể bật mic', 'warn'); return; }
    } else {
      WebRTC.localCamStream?.getAudioTracks().forEach(t => { t.stop(); WebRTC.localCamStream.removeTrack(t); });
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
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (!WebRTC.localCamStream) WebRTC.localCamStream = new MediaStream();
        s.getVideoTracks().forEach(t => WebRTC.localCamStream.addTrack(t));
        camOn = true;
        setCtrl('ctrlCam', true, '📷', 'Tắt camera');
        toast('📷 Camera đã bật');
        showMyCamTile();
      } catch (e) { toast('Không thể bật camera', 'warn'); return; }
    } else {
      WebRTC.localCamStream?.getVideoTracks().forEach(t => { t.stop(); WebRTC.localCamStream.removeTrack(t); });
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
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });

        WebRTC.localScreenStream = s;
        screenOn = true;
        setCtrl('ctrlScreen', true, '🖥️', 'Dừng chia sẻ');

        const hasAudio = s.getAudioTracks().length > 0;
        toast('🖥️ Đang chia sẻ màn hình' + (hasAudio ? ' + âm thanh ✅' : ''), hasAudio ? 'success' : 'info');

        showMyScreenTile();
        WebRTC.updateAllPeers();
        emitState();

        s.getVideoTracks()[0].onended = () => _stopScreen();
      } catch (e) {
        if (e.name !== 'NotAllowedError') toast('Lỗi share màn hình: ' + e.message, 'warn');
      }
    } else {
      _stopScreen();
    }
  }

  async function toggleTab() {
    if (screenOn) { _stopScreen(); await new Promise(r => setTimeout(r, 300)); }
    if (screenOn) return;
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: { echoCancellation: false, noiseSuppression: false },
        preferCurrentTab: true,
      });
      WebRTC.localScreenStream = s;
      screenOn = true;
      setCtrl('ctrlScreen', true, '🖥️', 'Dừng chia sẻ');
      document.getElementById('ctrlTab').classList.add('on');
      const hasAudio = s.getAudioTracks().length > 0;
      toast(hasAudio ? '🔊 Chia sẻ tab + âm thanh ✅' : '⚠️ Không có âm thanh', hasAudio ? 'success' : 'warn');
      showMyScreenTile();
      WebRTC.updateAllPeers();
      emitState();
      s.getVideoTracks()[0].onended = () => { document.getElementById('ctrlTab').classList.remove('on'); _stopScreen(); };
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast('Lỗi: ' + e.message, 'warn');
    }
  }

  function _stopScreen() {
    if (WebRTC.localScreenStream) {
      WebRTC.localScreenStream.getTracks().forEach(t => t.stop());
      WebRTC.localScreenStream = null;
    }
    screenOn = false;
    setCtrl('ctrlScreen', false, '🖥️', 'Chia sẻ màn hình');
    document.getElementById('ctrlTab').classList.remove('on');
    if (myTiles.screen) {
      if (myTiles.screen.dataset.streamId) delete streamTileMap[myTiles.screen.dataset.streamId];
      myTiles.screen.remove(); myTiles.screen = null;
    }
    refreshGrid();
    emitState();
    WebRTC.updateAllPeers();
    toast('Đã dừng chia sẻ');
  }

  function showMyCamTile() {
    if (myTiles.cam) {
      if (myTiles.cam.dataset.streamId) delete streamTileMap[myTiles.cam.dataset.streamId];
      myTiles.cam.remove();
    }
    const stream = WebRTC.localCamStream;
    const tile = makeTile(stream, myAvatar, myNick + ' (Bạn)', true, false);
    tile.dataset.peer = 'local'; tile.dataset.type = 'cam';
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
    tile.dataset.peer = 'local'; tile.dataset.type = 'screen';
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
    video.autoplay   = true;
    video.playsInline = true;
    video.muted      = muted;

    if (stream) {
      video.srcObject = stream;
      // Force play — needed on some mobile browsers
      const tryPlay = () => {
        video.play().catch(err => {
          console.warn('[Video] play() failed:', err.name);
          // On user gesture needed: add a click-to-play overlay
          if (err.name === 'NotAllowedError') {
            tile.classList.add('needs-play');
            tile.onclick = () => {
              video.play().then(() => tile.classList.remove('needs-play')).catch(() => {});
            };
          }
        });
      };
      if (video.readyState >= 2) {
        tryPlay();
      } else {
        video.onloadedmetadata = tryPlay;
      }
    }

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

    // Click-to-play overlay HTML
    const overlay = document.createElement('div');
    overlay.className = 'play-overlay';
    overlay.innerHTML = '▶';
    tile.appendChild(overlay);

    return tile;
  }

  function addTile(tile) {
    const grid = document.getElementById('videoGrid');
    document.getElementById('emptyVideo')?.remove();
    grid.appendChild(tile);
    refreshGrid();
  }

  function refreshGrid() {
    const grid = document.getElementById('videoGrid');
    const tiles = grid.querySelectorAll('.vtile');
    grid.className = 'video-grid';

    if (tiles.length === 0) {
      if (!document.getElementById('emptyVideo')) {
        const e = document.createElement('div');
        e.className = 'empty-video'; e.id = 'emptyVideo';
        e.innerHTML = '<div class="ev-icon">🎥</div><div class="ev-title">Chưa có video</div><div class="ev-sub">Bật camera hoặc chia sẻ màn hình</div>';
        grid.appendChild(e);
      }
      grid.classList.add('grid-1');
    } else {
      const n = tiles.length;
      grid.classList.add(n === 1 ? 'grid-1' : n === 2 ? 'grid-2' : n === 3 ? 'grid-3' : n === 4 ? 'grid-4' : 'grid-n');
    }
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
    if (!isMine && !sidebarOpen)
      document.getElementById('sidebarToggle').classList.add('has-unread');
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
    const me = document.createElement('div');
    me.className = 'person';
    me.innerHTML = `<div class="person-av">${myAvatar}</div>
      <div class="person-info">
        <div class="person-name">${esc(myNick)} <span class="you-tag">Bạn</span></div>
        <div class="person-status">${micOn?'🎙️':''} ${camOn?'📷':''} ${screenOn?'🖥️':''}</div>
      </div>`;
    list.appendChild(me);
    Object.entries(peers).forEach(([, p]) => {
      const el = document.createElement('div');
      el.className = 'person';
      el.innerHTML = `<div class="person-av">${p.avatar}</div>
        <div class="person-info">
          <div class="person-name">${esc(p.nick)}</div>
          <div class="person-status">${p.micOn?'🎙️':''} ${p.camOn?'📷':''} ${p.screenOn?'🖥️':''}</div>
        </div>`;
      list.appendChild(el);
    });
  }

  function updatePeerCount() {
    document.getElementById('peerCount').textContent = 1 + Object.keys(peers).length;
  }

  // ── SIDEBAR ──
  let sidebarOpen = false;

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    document.getElementById('sidebar').classList.toggle('open', sidebarOpen);
    const btn = document.getElementById('sidebarToggle');
    btn.textContent = sidebarOpen ? '✕' : '💬';
    btn.classList.remove('has-unread');
  }

  function _initSwipeToClose() {
    const sidebar = document.getElementById('sidebar');
    let startY = 0, startTime = 0;
    sidebar.addEventListener('touchstart', e => { startY = e.touches[0].clientY; startTime = Date.now(); }, { passive: true });
    sidebar.addEventListener('touchend', e => {
      if (e.changedTouches[0].clientY - startY > 60 && Date.now() - startTime < 400) {
        sidebarOpen = true; toggleSidebar();
      }
    }, { passive: true });
  }

  function switchTab(tab) {
    ['chat','people'].forEach(t => {
      document.getElementById('panel' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('hidden', t !== tab);
      document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('active', t === tab);
    });
  }

  // ── MODAL ──
  function openModal() {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    document.getElementById('inviteLinkText').textContent = url.toString();
    document.getElementById('modalBg').classList.remove('hidden');
  }

  function closeModal(e) {
    if (!e || e.target.id === 'modalBg')
      document.getElementById('modalBg').classList.add('hidden');
  }

  function copyLink() {
    navigator.clipboard.writeText(document.getElementById('inviteLinkText').textContent)
      .then(() => toast('✅ Đã sao chép link!', 'success'));
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
    t.className = 'toast ' + type; t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 3100);
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  window.addEventListener('DOMContentLoaded', init);

  return { toggleMic, toggleCamera, toggleScreen, toggleTab, toggleSidebar, sendChat, switchTab, openModal, closeModal, copyLink, leave };
})();