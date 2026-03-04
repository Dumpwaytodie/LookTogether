/**
 * WebRTC Manager — v5
 * Dùng onnegotiationneeded thay vì tự tay renegotiate
 * Tránh race condition khi add/remove tracks
 */
const WebRTC = (() => {

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]
  };

  const pcs       = {};  // peerId -> RTCPeerConnection
  const makingOffer = {}; // peerId -> bool (perfect negotiation)

  let _camStream    = null;
  let _screenStream = null;
  let socket         = null;
  let onRemoteStream = null;
  let onRemoveStream = null;

  function init(sock, cbs) {
    socket         = sock;
    onRemoteStream = cbs.onRemoteStream;
    onRemoveStream = cbs.onRemoveStream;
    socket.on('offer',         ({ from, offer, polite })     => _handleOffer(from, offer, polite));
    socket.on('answer',        ({ from, answer })    => _handleAnswer(from, answer));
    socket.on('ice-candidate', ({ from, candidate }) => _handleICE(from, candidate));
  }

  function _getOrCreatePC(peerId) {
    if (pcs[peerId]) return pcs[peerId];

    const pc = new RTCPeerConnection(ICE);
    pcs[peerId] = pc;
    makingOffer[peerId] = false;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
    };

    const receivedStreams = {};

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (!stream) return;

      if (!receivedStreams[stream.id]) {
        const label = e.track.label || '';
        const isScreen = /screen|display|monitor|window|entire/i.test(label);
        receivedStreams[stream.id] = { isScreen, reported: false };
      }

      const meta = receivedStreams[stream.id];
      if (!meta.reported) {
        meta.reported = true;
        onRemoteStream(peerId, stream, meta.isScreen);
      }

      e.track.onended = () => {
        setTimeout(() => {
          const live = stream.getTracks().filter(t => t.readyState === 'live').length;
          if (live === 0 && receivedStreams[stream.id]) {
            const { isScreen } = receivedStreams[stream.id];
            delete receivedStreams[stream.id];
            onRemoveStream(peerId, isScreen, stream.id);
          }
        }, 300);
      };
    };

    // Perfect negotiation: onnegotiationneeded tự trigger khi add track
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer[peerId] = true;
        await pc.setLocalDescription();
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
        console.log(`[WebRTC] onnegotiationneeded → offer sent to ${peerId.slice(-4)}`);
      } catch(e) {
        console.error('onnegotiationneeded error:', e);
      } finally {
        makingOffer[peerId] = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log(`[PC:${peerId.slice(-4)}] ${s}`);
      if (s === 'failed') {
        pc.restartIce();
      }
      if (s === 'closed') {
        onRemoveStream(peerId, false, null);
        onRemoveStream(peerId, true, null);
        delete pcs[peerId];
        delete makingOffer[peerId];
      }
    };

    return pc;
  }

  function _addAllTracks(pc) {
    if (_camStream) {
      _camStream.getTracks().forEach(t => {
        if (!pc.getSenders().some(s => s.track === t))
          pc.addTrack(t, _camStream);
      });
    }
    if (_screenStream) {
      _screenStream.getTracks().forEach(t => {
        if (!pc.getSenders().some(s => s.track === t))
          pc.addTrack(t, _screenStream);
      });
    }
  }

  // Gọi peer lần đầu
  async function callPeer(peerId) {
    const pc = _getOrCreatePC(peerId);
    _addAllTracks(pc);
    // onnegotiationneeded sẽ tự trigger sau addTrack
    // Nếu không có track nào (peer join phòng trống), tạo offer thủ công
    if (pc.getSenders().length === 0) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
      } catch(e) { console.error('callPeer error:', e); }
    }
  }

  // Perfect negotiation: xử lý offer từ remote
  async function _handleOffer(fromId, offer) {
    const pc = _getOrCreatePC(fromId);
    // Nếu chúng ta cũng đang tạo offer (collision) → chúng ta là "polite" side nên rollback
    const offerCollision = pc.signalingState !== 'stable' || makingOffer[fromId];
    if (offerCollision) {
      console.log(`[WebRTC] Offer collision with ${fromId.slice(-4)}, rolling back`);
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(new RTCSessionDescription(offer)),
      ]);
    } else {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
    }

    _addAllTracks(pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: fromId, answer: pc.localDescription });
    console.log(`[WebRTC] Answered offer from ${fromId.slice(-4)}`);
  }

  async function _handleAnswer(fromId, answer) {
    const pc = pcs[fromId];
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer')
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch(e) { console.error('handleAnswer error:', e); }
  }

  async function _handleICE(fromId, candidate) {
    const pc = pcs[fromId];
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
  }

  // Khi stream thay đổi: sync tracks trên tất cả PC
  function updateAllPeers() {
    console.log(`[WebRTC] updateAllPeers, peers: ${Object.keys(pcs).length}`);
    Object.entries(pcs).forEach(([peerId, pc]) => {
      // Xác định tracks cần có
      const wanted = new Map();
      if (_camStream)    _camStream.getTracks().forEach(t => wanted.set(t, _camStream));
      if (_screenStream) _screenStream.getTracks().forEach(t => wanted.set(t, _screenStream));

      // Xóa tracks không cần nữa
      pc.getSenders().forEach(sender => {
        if (sender.track && !wanted.has(sender.track)) {
          pc.removeTrack(sender);
          console.log(`[WebRTC] Removed track from ${peerId.slice(-4)}`);
        }
      });

      // Thêm tracks mới
      const existing = pc.getSenders().map(s => s.track).filter(Boolean);
      wanted.forEach((stream, track) => {
        if (!existing.includes(track)) {
          pc.addTrack(track, stream);
          console.log(`[WebRTC] Added track to ${peerId.slice(-4)}`);
        }
      });
      // onnegotiationneeded sẽ tự trigger sau khi add/remove
    });
  }

  function closeAll() {
    Object.values(pcs).forEach(pc => { try { pc.close(); } catch(e){} });
    Object.keys(pcs).forEach(k => delete pcs[k]);
    Object.keys(makingOffer).forEach(k => delete makingOffer[k]);
    stopLocalStreams();
  }

  function closePeer(peerId) {
    if (pcs[peerId]) { try { pcs[peerId].close(); } catch(e){} delete pcs[peerId]; }
    delete makingOffer[peerId];
  }

  function stopLocalStreams() {
    if (_camStream)    { _camStream.getTracks().forEach(t => t.stop());    _camStream = null; }
    if (_screenStream) { _screenStream.getTracks().forEach(t => t.stop()); _screenStream = null; }
  }

  return {
    init, callPeer, closePeer, closeAll, updateAllPeers, stopLocalStreams,
    get localCamStream()     { return _camStream; },
    set localCamStream(s)    { _camStream = s; },
    get localScreenStream()  { return _screenStream; },
    set localScreenStream(s) { _screenStream = s; },
  };
})();
