/**
 * WebRTC Manager — v8
 * - RTCDataChannel để gửi metadata (streamId, isScreen) TRƯỚC khi stream đến
 * - Force-play video sau khi srcObject set
 * - Không dùng track.label hay socket relay
 */
const WebRTC = (() => {

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]
  };

  const pcs          = {};
  const dataChannels = {};
  const makingOffer  = {};

  // streamId -> { isScreen }
  const streamMeta = {};
  // streamId -> { stream, peerId } — waiting for meta
  const pendingStreams = {};

  let _camStream    = null;
  let _screenStream = null;
  let socket        = null;
  let onRemoteStream = null;
  let onRemoveStream = null;

  function init(sock, cbs) {
    socket         = sock;
    onRemoteStream = cbs.onRemoteStream;
    onRemoveStream = cbs.onRemoveStream;
    socket.on('offer',         ({ from, offer })     => _handleOffer(from, offer));
    socket.on('answer',        ({ from, answer })    => _handleAnswer(from, answer));
    socket.on('ice-candidate', ({ from, candidate }) => _handleICE(from, candidate));
  }

  // ── Data Channel ──
  function _sendMeta(peerId, payload) {
    const tryNow = () => {
      const dc = dataChannels[peerId];
      return dc && dc.readyState === 'open';
    };
    const send = () => dataChannels[peerId].send(JSON.stringify(payload));

    if (tryNow()) { send(); return; }

    let attempts = 0;
    const iv = setInterval(() => {
      attempts++;
      if (tryNow()) { send(); clearInterval(iv); }
      if (attempts > 50) clearInterval(iv); // give up after 5s
    }, 100);
  }

  function _setupDataChannel(peerId, dc) {
    dataChannels[peerId] = dc;
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'stream-meta') {
          console.log(`[DC] got meta streamId=${msg.streamId.slice(-6)} isScreen=${msg.isScreen}`);
          streamMeta[msg.streamId] = { isScreen: msg.isScreen };

          if (pendingStreams[msg.streamId]) {
            const { stream, peerId: pid } = pendingStreams[msg.streamId];
            delete pendingStreams[msg.streamId];
            onRemoteStream(pid, stream, msg.isScreen);
          }
        }
      } catch(err) {}
    };
  }

  function _broadcastStreamMeta() {
    Object.keys(pcs).forEach(peerId => {
      if (_camStream)
        _sendMeta(peerId, { type: 'stream-meta', streamId: _camStream.id, isScreen: false });
      if (_screenStream)
        _sendMeta(peerId, { type: 'stream-meta', streamId: _screenStream.id, isScreen: true });
    });
  }

  // ── PC Creation ──
  function _getOrCreatePC(peerId, initiator) {
    if (pcs[peerId]) return pcs[peerId];

    const pc = new RTCPeerConnection(ICE);
    pcs[peerId] = pc;
    makingOffer[peerId] = false;

    if (initiator) {
      const dc = pc.createDataChannel('meta', { ordered: true });
      _setupDataChannel(peerId, dc);
    } else {
      pc.ondatachannel = (e) => _setupDataChannel(peerId, e.channel);
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
    };

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (!stream) return;
      console.log(`[PC:${peerId.slice(-4)}] ontrack kind=${e.track.kind} stream=${stream.id.slice(-6)}`);

      const report = (isScreen) => {
        onRemoteStream(peerId, stream, isScreen);
      };

      const meta = streamMeta[stream.id];
      if (meta !== undefined) {
        report(meta.isScreen);
      } else {
        pendingStreams[stream.id] = { stream, peerId };
        // Fallback after 3s
        setTimeout(() => {
          if (pendingStreams[stream.id]) {
            console.warn(`[PC] Meta timeout for ${stream.id.slice(-6)}, guessing isScreen=false`);
            delete pendingStreams[stream.id];
            streamMeta[stream.id] = { isScreen: false };
            report(false);
          }
        }, 3000);
      }

      e.track.onended = () => {
        setTimeout(() => {
          if (stream.getTracks().every(t => t.readyState === 'ended')) {
            const wasScreen = streamMeta[stream.id]?.isScreen ?? false;
            delete streamMeta[stream.id];
            delete pendingStreams[stream.id];
            onRemoveStream(peerId, wasScreen, stream.id);
          }
        }, 300);
      };
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer[peerId] = true;
        await pc.setLocalDescription();
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
      } catch(err) {
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
        delete pcs[peerId]; delete makingOffer[peerId]; delete dataChannels[peerId];
      }
    };

    return pc;
  }

  function _addAllTracks(pc) {
    if (_camStream) {
      _camStream.getTracks().forEach(t => {
        if (!pc.getSenders().some(s => s.track === t)) pc.addTrack(t, _camStream);
      });
    }
    if (_screenStream) {
      _screenStream.getTracks().forEach(t => {
        if (!pc.getSenders().some(s => s.track === t)) pc.addTrack(t, _screenStream);
      });
    }
  }

  // ── Public API ──
  async function callPeer(peerId) {
    const pc = _getOrCreatePC(peerId, true);

    // Send meta first, then tracks
    if (_camStream)    _sendMeta(peerId, { type: 'stream-meta', streamId: _camStream.id, isScreen: false });
    if (_screenStream) _sendMeta(peerId, { type: 'stream-meta', streamId: _screenStream.id, isScreen: true });

    _addAllTracks(pc);

    if (pc.getSenders().length === 0) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
      } catch(err) { console.error('callPeer:', err); }
    }
  }

  async function _handleOffer(fromId, offer) {
    const pc = _getOrCreatePC(fromId, false);
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
  }

  async function _handleAnswer(fromId, answer) {
    const pc = pcs[fromId];
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer')
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch(err) { console.error('handleAnswer:', err); }
  }

  async function _handleICE(fromId, candidate) {
    const pc = pcs[fromId];
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(err) {}
  }

  function updateAllPeers() {
    console.log(`[WebRTC] updateAllPeers`);
    _broadcastStreamMeta();

    Object.entries(pcs).forEach(([peerId, pc]) => {
      const wanted = new Map();
      if (_camStream)    _camStream.getTracks().forEach(t => wanted.set(t, _camStream));
      if (_screenStream) _screenStream.getTracks().forEach(t => wanted.set(t, _screenStream));

      pc.getSenders().forEach(sender => {
        if (sender.track && !wanted.has(sender.track)) pc.removeTrack(sender);
      });
      const existing = pc.getSenders().map(s => s.track).filter(Boolean);
      wanted.forEach((stream, track) => {
        if (!existing.includes(track)) pc.addTrack(track, stream);
      });
    });
  }

  function closeAll() {
    Object.values(pcs).forEach(pc => { try { pc.close(); } catch(e){} });
    ['pcs','makingOffer','dataChannels','streamMeta','pendingStreams'].forEach(k => {
      const obj = { pcs, makingOffer, dataChannels, streamMeta, pendingStreams }[k];
      Object.keys(obj).forEach(key => delete obj[key]);
    });
    stopLocalStreams();
  }

  function closePeer(peerId) {
    if (pcs[peerId]) { try { pcs[peerId].close(); } catch(e){} delete pcs[peerId]; }
    delete makingOffer[peerId]; delete dataChannels[peerId];
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