/**
 * NovaCast App — v9
 */
const App = (() => {
  const AVATARS = ['🦊','🐺','🦁','🐯','🦝','🦋','🐙','🦄','🐻','🐼','🦅','🦉','🦈','🐉','🦑','🐬','🦖','🐧','🦩','🦚'];
  const ADJ  = ['Rực','Tối','Băng','Lửa','Huyền','Sóng','Thần','Mờ','Lượn','Tàng','Kim','Ngọc'];
  const NOUN = ['Long','Hổ','Ưng','Rồng','Sói','Bão','Kiếm','Mây','Tước','Phong','Lôi','Hải'];

  let socket, myId, myNick = '', myAvatar = AVATARS[0], roomId = '';
  const peers = {}, peerTiles = {}, streamTileMap = {};
  const myTiles = { cam: null, screen: null };
  let micOn = false, camOn = false, screenOn = false;

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    renderAvatarPicker();
    autoFillNick();
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (urlRoom) document.getElementById('joinInput').value = urlRoom;

    document.getElementById('btnCreate').onclick = createRoom;
    document.getElementById('btnJoin').onclick   = joinRoom;
    document.getElementById('btnInvite').onclick = openModal;

    socket = io();
    socket.on('connect',     () => { myId = socket.id; });
    socket.on('user-joined', onUserJoined);
    socket.on('user-left',   onUserLeft);
    socket.on('chat',        onChatMsg);
    socket.on('media-state', onMediaState);

    WebRTC.init(socket, { onRemoteStream, onRemoveStream });
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
    document.getElementById('nicknameInput').value =
      ADJ[Math.floor(Math.random()*ADJ.length)] + ' ' + NOUN[Math.floor(Math.random()*NOUN.length)];
  }

  // ── Room ──────────────────────────────────────────────────────
  function createRoom() {
    const nick = document.getElementById('nicknameInput').value.trim();
    if (!nick) { showErr('Nhập biệt danh!'); return; }
    myNick = nick; clearErr();
    socket.emit('create-room', { nick, avatar: myAvatar }, ({ roomId: rid }) => {
      roomId = rid; doJoin(false);
    });
  }

  function joinRoom() {
    const nick = document.getElementById('nicknameInput').value.trim();
    const rid  = document.getElementById('joinInput').value.trim().toUpperCase();
    if (!nick) { showErr('Nhập biệt danh!'); return; }
    if (!rid)  { showErr('Nhập Room ID!');   return; }
    myNick = nick; roomId = rid; clearErr();
    doJoin(true);
  }

  function doJoin(isGuest) {
    socket.emit('join-room', { roomId, nick: myNick, avatar: myAvatar }, (res) => {
      if (res.error) { showErr(res.error); return; }
      document.getElementById('lobby').classList.add('hidden');
      document.getElementById('room').classList.remove('hidden');
      document.getElementById('roomIdBadge').textContent = roomId;
      const url = new URL(location.href);
      url.searchParams.set('room', roomId);
      history.replaceState({}, '', url);

      res.members.forEach(m => { peers[m.socketId] = { ...m, micOn:false, camOn:false, screenOn:false }; });
      systemMsg(`Chào ${myAvatar} ${myNick}! Room: ${roomId}`);
      renderPeople(); updateCount();
      _initSwipe();

      if (!isGuest) setTimeout(openModal, 300);
      else toast('✅ Đã vào phòng!', 'success');

      res.members.forEach(m => WebRTC.callPeer(m.socketId));
    });
  }

  // ── Socket events ─────────────────────────────────────────────
  function onUserJoined({ socketId, nick, avatar }) {
    peers[socketId] = { socketId, nick, avatar, micOn:false, camOn:false, screenOn:false };
    systemMsg(`${avatar} ${nick} đã tham gia`);
    renderPeople(); updateCount();
  }

  function onUserLeft({ socketId }) {
    const p = peers[socketId];
    if (p) systemMsg(`${p.avatar} ${p.nick} đã rời phòng`);
    delete peers[socketId];
    WebRTC.closePeer(socketId);
    removePeerTiles(socketId);
    renderPeople(); updateCount();
  }

  function onChatMsg({ socketId, nick, avatar, text, time }) {
    appendChat(socketId === socket.id, nick, avatar, text, time);
  }

  function onMediaState({ socketId, micOn: m, camOn: c, screenOn: s }) {
    if (!peers[socketId]) return;
    Object.assign(peers[socketId], { micOn: m, camOn: c, screenOn: s });
    renderPeople(); updateTileLabel(socketId);
  }

  // ── Remote streams ────────────────────────────────────────────
  function onRemoteStream(peerId, stream, isScreen) {
    console.log(`[App] onRemoteStream peer=${peerId.slice(-4)} isScreen=${isScreen}`);
    const p = peers[peerId] || { nick: 'Khách', avatar: '👤' };
    if (!peerTiles[peerId]) peerTiles[peerId] = {};
    const key = isScreen ? 'screen' : 'cam';

    // Remove old tile for this slot
    const old = peerTiles[peerId][key];
    if (old) { if (old._streamId) delete streamTileMap[old._streamId]; old.remove(); }

    const tile = makeTile(stream, p.avatar, p.nick, false, isScreen);
    tile._streamId = stream.id;
    peerTiles[peerId][key] = tile;
    streamTileMap[stream.id] = tile;
    addTile(tile);
  }

  function onRemoveStream(peerId, isScreen, streamId) {
    if (streamId && streamTileMap[streamId]) {
      streamTileMap[streamId].remove();
      delete streamTileMap[streamId];
      if (peerTiles[peerId]) {
        const key = isScreen ? 'screen' : 'cam';
        if (peerTiles[peerId][key]?._streamId === streamId)
          peerTiles[peerId][key] = null;
      }
      refreshGrid(); return;
    }
    removePeerTiles(peerId);
  }

  function removePeerTiles(peerId) {
    (Object.values(peerTiles[peerId] || {})).forEach(t => {
      if (!t) return;
      if (t._streamId) delete streamTileMap[t._streamId];
      t.remove();
    });
    delete peerTiles[peerId];
    refreshGrid();
  }

  // ── Media controls ────────────────────────────────────────────
  async function toggleMic() {
    if (!micOn) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (!WebRTC.localCamStream) WebRTC.localCamStream = new MediaStream();
        s.getAudioTracks().forEach(t => WebRTC.localCamStream.addTrack(t));
        micOn = true; setCtrl('ctrlMic', true, '🎙️', 'Tắt mic'); toast('🎙️ Mic bật');
      } catch { toast('Không thể bật mic', 'warn'); return; }
    } else {
      WebRTC.localCamStream?.getAudioTracks().forEach(t => { t.stop(); WebRTC.localCamStream.removeTrack(t); });
      micOn = false; setCtrl('ctrlMic', false, '🔇', 'Bật mic'); toast('Mic tắt');
    }
    emitState(); WebRTC.updateAllPeers();
  }

  async function toggleCamera() {
    if (!camOn) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (!WebRTC.localCamStream) WebRTC.localCamStream = new MediaStream();
        s.getVideoTracks().forEach(t => WebRTC.localCamStream.addTrack(t));
        camOn = true; setCtrl('ctrlCam', true, '📷', 'Tắt camera');
        toast('📷 Camera bật'); showMyTile('cam');
      } catch { toast('Không thể bật camera', 'warn'); return; }
    } else {
      WebRTC.localCamStream?.getVideoTracks().forEach(t => { t.stop(); WebRTC.localCamStream.removeTrack(t); });
      camOn = false; setCtrl('ctrlCam', false, '📷', 'Bật camera');
      removeMine('cam'); toast('Camera tắt');
    }
    emitState(); WebRTC.updateAllPeers();
  }

  async function toggleScreen() {
    if (!screenOn) {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({
          video: { width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30} },
          audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false },
        });
        WebRTC.localScreenStream = s;
        screenOn = true; setCtrl('ctrlScreen', true, '🖥️', 'Dừng chia sẻ');
        toast('🖥️ Đang chia sẻ' + (s.getAudioTracks().length ? ' + âm thanh ✅' : ''), 'success');
        showMyTile('screen');
        WebRTC.updateAllPeers(); emitState();
        s.getVideoTracks()[0].onended = _stopScreen;
      } catch (e) { if (e.name !== 'NotAllowedError') toast('Lỗi: ' + e.message, 'warn'); }
    } else { _stopScreen(); }
  }

  async function toggleTab() {
    if (screenOn) { _stopScreen(); await new Promise(r => setTimeout(r, 300)); }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface:'browser' },
        audio: { echoCancellation:false, noiseSuppression:false },
        preferCurrentTab: true,
      });
      WebRTC.localScreenStream = s;
      screenOn = true; setCtrl('ctrlScreen', true, '🖥️', 'Dừng chia sẻ');
      document.getElementById('ctrlTab').classList.add('on');
      toast(s.getAudioTracks().length ? '🔊 Tab + âm thanh ✅' : '⚠️ Không có âm thanh', s.getAudioTracks().length ? 'success' : 'warn');
      showMyTile('screen');
      WebRTC.updateAllPeers(); emitState();
      s.getVideoTracks()[0].onended = () => { document.getElementById('ctrlTab').classList.remove('on'); _stopScreen(); };
    } catch (e) { if (e.name !== 'NotAllowedError') toast('Lỗi: ' + e.message, 'warn'); }
  }

  function _stopScreen() {
    WebRTC.localScreenStream?.getTracks().forEach(t => t.stop());
    WebRTC.localScreenStream = null;
    screenOn = false; setCtrl('ctrlScreen', false, '🖥️', 'Chia sẻ màn hình');
    document.getElementById('ctrlTab').classList.remove('on');
    removeMine('screen'); emitState(); WebRTC.updateAllPeers(); toast('Đã dừng chia sẻ');
  }

  function showMyTile(type) {
    removeMine(type);
    const stream = type === 'cam' ? WebRTC.localCamStream : WebRTC.localScreenStream;
    const tile = makeTile(stream, myAvatar, myNick + ' (Bạn)', true, type === 'screen');
    tile._streamId = stream?.id;
    myTiles[type] = tile;
    if (stream?.id) streamTileMap[stream.id] = tile;
    addTile(tile);
  }

  function removeMine(type) {
    const t = myTiles[type];
    if (t) { if (t._streamId) delete streamTileMap[t._streamId]; t.remove(); myTiles[type] = null; }
    refreshGrid();
  }

  function emitState() { socket.emit('media-state', { micOn, camOn, screenOn }); }

  // ── Video tile ────────────────────────────────────────────────
  function makeTile(stream, avatar, nick, muted, isScreen) {
    const tile = document.createElement('div');
    tile.className = 'vtile' + (isScreen ? ' is-screen' : '');

    const video = document.createElement('video');
    video.autoplay    = true;
    video.playsInline = true;
    video.muted       = muted;

    if (stream) {
      video.srcObject = stream;
      video.onloadedmetadata = () => {
        video.play().catch(err => {
          if (err.name === 'NotAllowedError') {
            // Show tap-to-play overlay
            overlay.style.display = 'flex';
          }
        });
      };
    }

    const label = document.createElement('div');
    label.className = 'vtile-label';
    label.innerHTML = `<span>${avatar}</span><span>${esc(nick)}</span>`;

    const overlay = document.createElement('div');
    overlay.className = 'play-overlay';
    overlay.textContent = '▶';
    overlay.onclick = () => { video.play().then(() => { overlay.style.display = 'none'; }); };

    tile.append(video, label, overlay);
    if (isScreen) {
      const badge = document.createElement('div');
      badge.className = 'vtile-screen-badge';
      badge.textContent = 'SCREEN';
      tile.appendChild(badge);
    }
    return tile;
  }

  function addTile(tile) {
    document.getElementById('emptyVideo')?.remove();
    document.getElementById('videoGrid').appendChild(tile);
    refreshGrid();
  }

  function refreshGrid() {
    const grid = document.getElementById('videoGrid');
    const n = grid.querySelectorAll('.vtile').length;
    grid.className = 'video-grid';
    if (n === 0) {
      if (!document.getElementById('emptyVideo')) {
        const e = document.createElement('div');
        e.className = 'empty-video'; e.id = 'emptyVideo';
        e.innerHTML = '<div class="ev-icon">🎥</div><div class="ev-title">Chưa có video</div><div class="ev-sub">Bật camera hoặc chia sẻ màn hình</div>';
        grid.appendChild(e);
      }
      grid.classList.add('grid-1');
    } else {
      grid.classList.add(['grid-1','grid-2','grid-3','grid-4','grid-n'][Math.min(n,5)-1] || 'grid-n');
    }
  }

  function updateTileLabel(peerId) {
    const p = peers[peerId]; if (!p || !peerTiles[peerId]) return;
    Object.values(peerTiles[peerId]).forEach(tile => {
      if (!tile) return;
      const lbl = tile.querySelector('.vtile-label');
      if (lbl) lbl.innerHTML = `<span>${p.avatar}</span><span>${esc(p.nick)}</span>${!p.micOn?'<span class="vtile-muted">🔇</span>':''}`;
    });
  }

  // ── Chat ──────────────────────────────────────────────────────
  function sendChat() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim(); if (!text) return;
    input.value = '';
    socket.emit('chat', { text, time: new Date().toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'}) });
  }

  function appendChat(isMine, nick, avatar, text, time) {
    const area = document.getElementById('messages');
    const d = document.createElement('div');
    d.className = 'msg' + (isMine ? ' mine' : '');
    d.innerHTML = `<div class="msg-head"><span class="msg-av">${avatar}</span><span class="msg-nick">${esc(nick)}</span><span class="msg-time">${time}</span></div><div class="msg-body">${esc(text)}</div>`;
    area.appendChild(d); area.scrollTop = area.scrollHeight;
    if (!isMine && !sidebarOpen) document.getElementById('sidebarToggle').classList.add('has-unread');
  }

  function systemMsg(text) {
    const area = document.getElementById('messages');
    const d = document.createElement('div'); d.className = 'sys-msg'; d.textContent = text;
    area.appendChild(d); area.scrollTop = area.scrollHeight;
  }

  // ── People ────────────────────────────────────────────────────
  function renderPeople() {
    const list = document.getElementById('peopleList'); list.innerHTML = '';
    const add = (av, nick, isMe, info) => {
      const el = document.createElement('div'); el.className = 'person';
      el.innerHTML = `<div class="person-av">${av}</div><div class="person-info">
        <div class="person-name">${esc(nick)}${isMe?'<span class="you-tag">Bạn</span>':''}</div>
        <div class="person-status">${info.micOn?'🎙️':''} ${info.camOn?'📷':''} ${info.screenOn?'🖥️':''}</div></div>`;
      list.appendChild(el);
    };
    add(myAvatar, myNick, true, { micOn, camOn, screenOn });
    Object.values(peers).forEach(p => add(p.avatar, p.nick, false, p));
  }

  function updateCount() { document.getElementById('peerCount').textContent = 1 + Object.keys(peers).length; }

  // ── Sidebar ───────────────────────────────────────────────────
  let sidebarOpen = false;
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    document.getElementById('sidebar').classList.toggle('open', sidebarOpen);
    const btn = document.getElementById('sidebarToggle');
    btn.textContent = sidebarOpen ? '✕' : '💬';
    btn.classList.remove('has-unread');
  }
  function _initSwipe() {
    const sidebar = document.getElementById('sidebar');
    let y0 = 0, t0 = 0;
    sidebar.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; t0 = Date.now(); }, {passive:true});
    sidebar.addEventListener('touchend',   e => { if (e.changedTouches[0].clientY - y0 > 60 && Date.now()-t0 < 400) { sidebarOpen=true; toggleSidebar(); } }, {passive:true});
  }
  function switchTab(tab) {
    ['Chat','People'].forEach(t => {
      document.getElementById('panel'+t).classList.toggle('hidden', t.toLowerCase() !== tab);
      document.getElementById('tab'+t).classList.toggle('active',   t.toLowerCase() === tab);
    });
  }

  // ── Modal ─────────────────────────────────────────────────────
  function openModal() {
    const url = new URL(location.href); url.searchParams.set('room', roomId);
    document.getElementById('inviteLinkText').textContent = url;
    document.getElementById('modalBg').classList.remove('hidden');
  }
  function closeModal(e) { if (!e || e.target.id === 'modalBg') document.getElementById('modalBg').classList.add('hidden'); }
  function copyLink() { navigator.clipboard.writeText(document.getElementById('inviteLinkText').textContent).then(() => toast('✅ Đã sao chép!','success')); }

  // ── Leave ─────────────────────────────────────────────────────
  function leave() {
    WebRTC.closeAll(); socket.disconnect();
    const url = new URL(location.href); url.searchParams.delete('room');
    history.replaceState({}, '', url); location.reload();
  }

  // ── Helpers ───────────────────────────────────────────────────
  function setCtrl(id, on, icon, tip) { const el=document.getElementById(id); el.textContent=icon; el.classList.toggle('on',on); el.dataset.tip=tip; }
  function showErr(m) { document.getElementById('lobbyError').textContent = m; }
  function clearErr()  { document.getElementById('lobbyError').textContent = ''; }
  function toast(msg, type='info') {
    const c=document.getElementById('toasts'), t=document.createElement('div');
    t.className='toast '+type; t.textContent=msg; c.appendChild(t); setTimeout(()=>t.remove(),3100);
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  window.addEventListener('DOMContentLoaded', init);
  return { toggleMic, toggleCamera, toggleScreen, toggleTab, toggleSidebar, sendChat, switchTab, openModal, closeModal, copyLink, leave };
})();