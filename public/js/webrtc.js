/**
 * WebRTC Manager — v7 (fixed screen share detection + signaling)
 */
const WebRTC = (() => {

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]
  };

  const pcs         = {};  // peerId -> RTCPeerConnection
  const makingOffer = {};  // peerId -> bool

  // Track which streamIds are screen shares (set when we ADD tracks)
  // Format: streamId -> true/false
  const screenStreamIds = {};

  let _camStream    = null;
  let _screenStream = null;
  let socket         = null;
  let onRemoteStream = null;
  let onRemoveStream = null;

  function init(sock, cbs) {
    socket         = sock;
    onRemoteStream = cbs.onRemoteStream;
    onRemoveStream = cbs.onRemoveStream;
    socket.on('offer',         ({ from, offer })     => _handleOffer(from, offer));
    socket.on('answer',        ({ from, answer })    => _handleAnswer(from, answer));
    socket.on('ice-candidate', ({ from, candidate }) => _handleICE(from, candidate));
    // NEW: receive screen stream ID mapping from remote peer
    socket.on('screen-stream-id', ({ from, streamId }) => {
      if (streamId) {
        screenStreamIds[streamId] = true;
        console.log(`[WebRTC] Got screen-stream-id from ${from.slice(-4)}: ${streamId}`);
      }
    });
  }

  function _getOrCreatePC(peerId) {
    if (pcs[peerId]) return pcs[peerId];

    const pc = new RTCPeerConnection(ICE);
    pcs[peerId] = pc;
    makingOffer[peerId] = false;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
    };

    const reportedStreams = new Set();

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (!stream) return;

      // Wait a tick so screenStreamIds has time to be populated
      setTimeout(() => {
        if (!reportedStreams.has(stream.id)) {
          reportedStreams.add(stream.id);
          // Check if this streamId was flagged as a screen share by remote
          const isScreen = !!screenStreamIds[stream.id];
          console.log(`[WebRTC] ontrack stream=${stream.id.slice(-6)} isScreen=${isScreen}`);
          onRemoteStream(peerId, stream, isScreen);
        }

        e.track.onended = () => {
          setTimeout(() => {
            const live = stream.getTracks().filter(t => t.readyState === 'live').length;
            if (live === 0) {
              const wasScreen = !!screenStreamIds[stream.id];
              delete screenStreamIds[stream.id];
              reportedStreams.delete(stream.id);
              onRemoveStream(peerId, wasScreen, stream.id);
            }
          }, 300);
        };
      }, 100);
    };

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
      if (s === 'failed') pc.restartIce();
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

  // Broadcast our screen stream ID to all peers so they can identify it
  function _broadcastScreenStreamId() {
    if (!_screenStream) return;
    Object.keys(pcs).forEach(peerId => {
      socket.emit('screen-stream-id-to', { to: peerId, streamId: _screenStream.id });
    });
  }

  async function callPeer(peerId) {
    const pc = _getOrCreatePC(peerId);
    // Tell them our screen stream ID before sending tracks
    if (_screenStream) {
      socket.emit('screen-stream-id-to', { to: peerId, streamId: _screenStream.id });
    }
    _addAllTracks(pc);
    if (pc.getSenders().length === 0) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { to: peerId, offer: pc.localDescription });
      } catch(e) { console.error('callPeer error:', e); }
    }
  }

  async function _handleOffer(fromId, offer) {
    const pc = _getOrCreatePC(fromId);
    const offerCollision = pc.signalingState !== 'stable' || makingOffer[fromId];
    if (offerCollision) {
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
    } catch(e) { console.error('handleAnswer error:', e); }
  }

  async function _handleICE(fromId, candidate) {
    const pc = pcs[fromId];
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
  }

  function updateAllPeers() {
    console.log(`[WebRTC] updateAllPeers, peers: ${Object.keys(pcs).length}`);
    // Broadcast screen stream ID whenever we update
    if (_screenStream) {
      Object.keys(pcs).forEach(peerId => {
        socket.emit('screen-stream-id-to', { to: peerId, streamId: _screenStream.id });
      });
    }
    Object.entries(pcs).forEach(([peerId, pc]) => {
      const wanted = new Map();
      if (_camStream)    _camStream.getTracks().forEach(t => wanted.set(t, _camStream));
      if (_screenStream) _screenStream.getTracks().forEach(t => wanted.set(t, _screenStream));

      pc.getSenders().forEach(sender => {
        if (sender.track && !wanted.has(sender.track)) {
          pc.removeTrack(sender);
        }
      });

      const existing = pc.getSenders().map(s => s.track).filter(Boolean);
      wanted.forEach((stream, track) => {
        if (!existing.includes(track)) {
          pc.addTrack(track, stream);
        }
      });
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