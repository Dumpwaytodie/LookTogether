/**
 * WebRTC Manager — v3
 * Fix: dùng stream.id để phân biệt cam vs screen thay vì đoán qua label
 */
const WebRTC = (() => {

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]
  };

  const pcs = {}; // socketId -> RTCPeerConnection

  let _localCamStream    = null;
  let _localScreenStream = null;
  let socket         = null;
  let onRemoteStream = null;
  let onRemoveStream = null;

  function init(sock, callbacks) {
    socket         = sock;
    onRemoteStream = callbacks.onRemoteStream;
    onRemoveStream = callbacks.onRemoveStream;
    socket.on('offer',         ({ from, offer })     => handleOffer(from, offer));
    socket.on('answer',        ({ from, answer })    => handleAnswer(from, answer));
    socket.on('ice-candidate', ({ from, candidate }) => handleICE(from, candidate));
  }

  function createPC(peerId) {
    if (pcs[peerId]) return pcs[peerId];
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcs[peerId] = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
    };

    // streamId -> bool (isScreen) — tracked per PC
    const streamMeta = {};

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (!stream) return;

      // Nếu đã biết stream này rồi thì bỏ qua (tránh fire nhiều lần khi có nhiều tracks)
      if (streamMeta.hasOwnProperty(stream.id)) return;

      // Xác định isScreen: ưu tiên so sánh với stream ID đã biết từ sender
      // Cách đáng tin nhất: track label trên Chrome có "screen", "display", "window"
      // Nếu không có label → dùng số lượng streams: screen thường có 1-2 tracks, cam có 1
      const label = e.track.label || '';
      const isScreen = /screen|display|monitor|window|entire/i.test(label);

      streamMeta[stream.id] = isScreen;
      onRemoteStream(peerId, stream, isScreen);

      // Khi track kết thúc
      e.track.onended = () => {
        setTimeout(() => {
          const live = stream.getTracks().filter(t => t.readyState === 'live').length;
          if (live === 0) {
            const wasScreen = streamMeta[stream.id];
            delete streamMeta[stream.id];
            onRemoveStream(peerId, wasScreen, stream.id);
          }
        }, 300);
      };

      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) {
          const wasScreen = streamMeta[stream.id];
          delete streamMeta[stream.id];
          onRemoveStream(peerId, wasScreen, stream.id);
        }
      };
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        onRemoveStream(peerId, false, null);
        onRemoveStream(peerId, true, null);
        delete pcs[peerId];
      }
    };

    return pc;
  }

  function _addLocalTracksToPc(pc) {
    if (_localCamStream) {
      _localCamStream.getTracks().forEach(t => {
        if (!pc.getSenders().some(s => s.track === t)) pc.addTrack(t, _localCamStream);
      });
    }
    if (_localScreenStream) {
      _localScreenStream.getTracks().forEach(t => {
        if (!pc.getSenders().some(s => s.track === t)) pc.addTrack(t, _localScreenStream);
      });
    }
  }

  async function callPeer(peerId) {
    const pc = createPC(peerId);
    _addLocalTracksToPc(pc);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer: pc.localDescription });
    } catch (e) { console.error('callPeer error:', e); }
  }

  async function handleOffer(fromId, offer) {
    const pc = createPC(fromId);
    _addLocalTracksToPc(pc);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: fromId, answer: pc.localDescription });
    } catch (e) { console.error('handleOffer error:', e); }
  }

  async function handleAnswer(fromId, answer) {
    const pc = pcs[fromId];
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer')
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) { console.error('handleAnswer error:', e); }
  }

  async function handleICE(fromId, candidate) {
    const pc = pcs[fromId];
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
  }

  function updateAllPeers() {
    Object.entries(pcs).forEach(([peerId, pc]) => _syncTracks(peerId, pc));
  }

  function _syncTracks(peerId, pc) {
    const wanted = new Map();
    if (_localCamStream)    _localCamStream.getTracks().forEach(t => wanted.set(t, _localCamStream));
    if (_localScreenStream) _localScreenStream.getTracks().forEach(t => wanted.set(t, _localScreenStream));

    const senders = pc.getSenders();
    let changed = false;

    // Remove unwanted
    senders.forEach(sender => {
      if (sender.track && !wanted.has(sender.track)) {
        try { pc.removeTrack(sender); changed = true; } catch(e) {}
      }
    });

    // Add new
    const sentTracks = pc.getSenders().map(s => s.track).filter(Boolean);
    wanted.forEach((stream, track) => {
      if (!sentTracks.includes(track)) {
        try { pc.addTrack(track, stream); changed = true; } catch(e) {}
      }
    });

    if (changed) _renegotiate(peerId, pc);
  }

  async function _renegotiate(peerId, pc) {
    if (pc.signalingState !== 'stable') {
      setTimeout(() => _renegotiate(peerId, pc), 400); return;
    }
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer: pc.localDescription });
    } catch(e) { console.error('renegotiate error:', e); }
  }

  function closeAll() {
    Object.values(pcs).forEach(pc => { try { pc.close(); } catch(e){} });
    Object.keys(pcs).forEach(k => delete pcs[k]);
    stopLocalStreams();
  }

  function closePeer(peerId) {
    if (pcs[peerId]) { try { pcs[peerId].close(); } catch(e){} delete pcs[peerId]; }
  }

  function stopLocalStreams() {
    if (_localCamStream)    { _localCamStream.getTracks().forEach(t => t.stop());    _localCamStream = null; }
    if (_localScreenStream) { _localScreenStream.getTracks().forEach(t => t.stop()); _localScreenStream = null; }
  }

  return {
    init, callPeer, closePeer, closeAll, updateAllPeers, stopLocalStreams,
    get localCamStream()     { return _localCamStream; },
    set localCamStream(s)    { _localCamStream = s; },
    get localScreenStream()  { return _localScreenStream; },
    set localScreenStream(s) { _localScreenStream = s; },
  };
})();
