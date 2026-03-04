/**
 * WebRTC Manager — v9 (simplified & reliable)
 *
 * Nguyên tắc đơn giản:
 * - Mỗi stream chỉ được report 1 lần dù ontrack gọi nhiều lần
 * - isScreen truyền qua socket signal (đơn giản, đáng tin)
 * - Không dùng data channel
 */
const WebRTC = (() => {

  // ICE config fetched from server (includes TURN credentials)
  let ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]
  };

  const pcs         = {};   // peerId -> RTCPeerConnection
  const makingOffer = {};   // peerId -> bool

  let _camStream     = null;
  let _screenStream  = null;
  let socket         = null;
  let onRemoteStream = null;
  let onRemoveStream = null;

  // peerId -> Set of streamIds already reported
  const reportedStreams = {};

  async function init(sock, cbs) {
    socket         = sock;
    onRemoteStream = cbs.onRemoteStream;
    onRemoveStream = cbs.onRemoveStream;

    // Fetch TURN credentials from server
    try {
      const res = await fetch('/ice-config');
      if (res.ok) { ICE = await res.json(); console.log('[ICE] config loaded', ICE); }
    } catch (e) { console.warn('[ICE] using fallback STUN only'); }

    socket.on('offer',         ({ from, offer, isScreen }) => _handleOffer(from, offer, isScreen));
    socket.on('answer',        ({ from, answer })          => _handleAnswer(from, answer));
    socket.on('ice-candidate', ({ from, candidate })       => _handleICE(from, candidate));
    socket.on('stream-meta',   ({ from, streamId, isScreen }) => {
      // Server relay: khi peer bắt đầu share, báo trước streamId là screen
      if (!reportedStreams[from]) reportedStreams[from] = {};
      reportedStreams[from]['_meta_' + streamId] = isScreen;
      console.log('[Meta] received streamId=', streamId?.slice(-6), 'isScreen=', isScreen);
    });
  }

  function _getOrCreatePC(peerId) {
    if (pcs[peerId]) return pcs[peerId];

    const pc = new RTCPeerConnection(ICE);
    pcs[peerId] = pc;
    makingOffer[peerId] = false;
    reportedStreams[peerId] = {};

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
    };

    // ontrack fires once per track — same stream may fire 2x (audio + video)
    // We wait until stream has at least 1 video track before reporting
    pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream) return;

      const sid = stream.id;
      console.log(`[ontrack] peer=${peerId.slice(-4)} kind=${e.track.kind} stream=${sid.slice(-6)}`);

      // Already reported this stream
      if (reportedStreams[peerId]?.[sid] !== undefined) return;

      // Mark as "seen" immediately to avoid double-report from audio+video tracks
      reportedStreams[peerId][sid] = null; // null = waiting

      const tryReport = () => {
        // Wait until stream has video tracks (audio-only = no tile needed)
        const hasVideo = stream.getVideoTracks().length > 0;
        if (!hasVideo) {
          // Check again when video track arrives
          stream.onaddtrack = () => tryReport();
          return;
        }

        // Determine isScreen from pre-signaled meta
        const metaKey = '_meta_' + sid;
        const isScreen = reportedStreams[peerId]?.[metaKey] === true;
        reportedStreams[peerId][sid] = isScreen;
        delete reportedStreams[peerId][metaKey];

        console.log(`[ontrack] Reporting stream=${sid.slice(-6)} isScreen=${isScreen}`);
        onRemoteStream(peerId, stream, isScreen);
      };

      tryReport();

      // Handle stream ending
      e.track.onended = () => {
        setTimeout(() => {
          const allEnded = stream.getTracks().every(t => t.readyState === 'ended');
          if (allEnded) {
            const wasScreen = reportedStreams[peerId]?.[sid] === true;
            delete reportedStreams[peerId]?.[sid];
            onRemoveStream(peerId, wasScreen, sid);
          }
        }, 500);
      };
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer[peerId] = true;
        await pc.setLocalDescription();
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
        console.log(`[WebRTC] offer → ${peerId.slice(-4)}`);
      } catch (err) {
        console.error('onnegotiationneeded:', err);
      } finally {
        makingOffer[peerId] = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log(`[PC:${peerId.slice(-4)}] ${s}`);
      if (s === 'failed') pc.restartIce();
      if (s === 'closed') {
        onRemoveStream(peerId, false, null);
        onRemoveStream(peerId, true, null);
        delete pcs[peerId];
        delete makingOffer[peerId];
        delete reportedStreams[peerId];
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

  async function callPeer(peerId) {
    const pc = _getOrCreatePC(peerId);
    _addAllTracks(pc);

    // Send stream-meta before offer so receiver knows which stream is screen
    _sendStreamMeta(peerId);

    if (pc.getSenders().length === 0) {
      // No tracks yet — send empty offer so we can receive
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
      } catch (err) { console.error('callPeer:', err); }
    }
    // else: onnegotiationneeded fires automatically after addTrack
  }

  function _sendStreamMeta(peerId) {
    if (_screenStream) {
      socket.emit('stream-meta-to', { to: peerId, streamId: _screenStream.id, isScreen: true });
    }
    if (_camStream) {
      socket.emit('stream-meta-to', { to: peerId, streamId: _camStream.id, isScreen: false });
    }
  }

  async function _handleOffer(fromId, offer) {
    const pc = _getOrCreatePC(fromId);
    const collision = pc.signalingState !== 'stable' || makingOffer[fromId];
    if (collision) {
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
    console.log(`[WebRTC] answer → ${fromId.slice(-4)}`);
  }

  async function _handleAnswer(fromId, answer) {
    const pc = pcs[fromId];
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); }
    catch (err) { console.error('handleAnswer:', err); }
  }

  async function _handleICE(fromId, candidate) {
    const pc = pcs[fromId];
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }

  function updateAllPeers() {
    console.log('[WebRTC] updateAllPeers');

    // Tell all peers about current stream meta
    Object.keys(pcs).forEach(peerId => _sendStreamMeta(peerId));

    Object.entries(pcs).forEach(([peerId, pc]) => {
      const wanted = new Map();
      if (_camStream)    _camStream.getTracks().forEach(t => wanted.set(t, _camStream));
      if (_screenStream) _screenStream.getTracks().forEach(t => wanted.set(t, _screenStream));

      // Remove stale senders
      pc.getSenders().forEach(sender => {
        if (sender.track && !wanted.has(sender.track)) {
          console.log(`[WebRTC] removeTrack from ${peerId.slice(-4)}`);
          pc.removeTrack(sender);
        }
      });

      // Add new tracks
      const existing = new Set(pc.getSenders().map(s => s.track).filter(Boolean));
      wanted.forEach((stream, track) => {
        if (!existing.has(track)) {
          console.log(`[WebRTC] addTrack to ${peerId.slice(-4)}`);
          pc.addTrack(track, stream);
        }
      });
      // onnegotiationneeded fires automatically
    });
  }

  function closeAll() {
    Object.values(pcs).forEach(pc => { try { pc.close(); } catch (_) {} });
    Object.keys(pcs).forEach(k => delete pcs[k]);
    Object.keys(makingOffer).forEach(k => delete makingOffer[k]);
    Object.keys(reportedStreams).forEach(k => delete reportedStreams[k]);
    stopLocalStreams();
  }

  function closePeer(peerId) {
    if (pcs[peerId]) { try { pcs[peerId].close(); } catch (_) {} delete pcs[peerId]; }
    delete makingOffer[peerId];
    delete reportedStreams[peerId];
  }

  function stopLocalStreams() {
    if (_camStream)    { _camStream.getTracks().forEach(t => t.stop());    _camStream = null; }
    if (_screenStream) { _screenStream.getTracks().forEach(t => t.stop()); _screenStream = null; }
  }

  return {
    init, callPeer, closePeer, closeAll, updateAllPeers, stopLocalStreams,
    get localCamStream()    { return _camStream; },
    set localCamStream(s)   { _camStream = s; },
    get localScreenStream() { return _screenStream; },
    set localScreenStream(s){ _screenStream = s; },
  };
})();