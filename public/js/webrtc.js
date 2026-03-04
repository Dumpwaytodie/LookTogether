/**
 * WebRTC Manager — v2
 * Fixes:
 *  - Screen tile properly removed on remote side when sender stops
 *  - System audio from screen share is transmitted correctly
 *  - Full renegotiation when tracks are added/removed
 */
const WebRTC = (() => {

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ]
  };

  // socketId -> RTCPeerConnection
  const pcs = {};

  let _localCamStream    = null;
  let _localScreenStream = null;

  let socket         = null;
  let onRemoteStream = null;  // (peerId, stream, isScreen) => void
  let onRemoveStream = null;  // (peerId, isScreen) => void

  // ── Init ──
  function init(sock, callbacks) {
    socket         = sock;
    onRemoteStream = callbacks.onRemoteStream;
    onRemoveStream = callbacks.onRemoveStream;

    socket.on('offer',         ({ from, offer })     => handleOffer(from, offer));
    socket.on('answer',        ({ from, answer })    => handleAnswer(from, answer));
    socket.on('ice-candidate', ({ from, candidate }) => handleICE(from, candidate));
  }

  // ── Create peer connection ──
  function createPC(peerId) {
    if (pcs[peerId]) return pcs[peerId];

    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcs[peerId] = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice-candidate', { to: peerId, candidate });
    };

    // Track which streamIds we've already reported so we don't double-fire
    const reportedStreamIds = new Set();

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (!stream) return;

      // Detect if this track belongs to a screen-share stream
      // We use the track label and also a flag we encode via stream.id
      const label = e.track.label || '';
      const isScreen = /screen|display|monitor|window|entire/i.test(label);

      // Fire once per stream (a stream may deliver multiple tracks)
      if (!reportedStreamIds.has(stream.id)) {
        reportedStreamIds.add(stream.id);
        onRemoteStream(peerId, stream, isScreen);

        // When all tracks in this stream end → remove tile
        stream.onremovetrack = () => {
          if (stream.getTracks().length === 0) {
            reportedStreamIds.delete(stream.id);
            onRemoveStream(peerId, isScreen, stream.id);
          }
        };
      }

      // When individual track ends → check if stream is empty
      e.track.onended = () => {
        // Small delay so browser updates stream.getTracks()
        setTimeout(() => {
          if (stream.getTracks().filter(t => t.readyState === 'live').length === 0) {
            reportedStreamIds.delete(stream.id);
            onRemoveStream(peerId, isScreen, stream.id);
          }
        }, 200);
      };
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        onRemoveStream(peerId, false, null);
        onRemoveStream(peerId, true, null);
        delete pcs[peerId];
      }
    };

    return pc;
  }

  // ── Add all current local tracks to a PC ──
  function _addLocalTracksToPc(pc) {
    if (_localCamStream) {
      _localCamStream.getTracks().forEach(track => {
        if (!pc.getSenders().some(s => s.track === track)) {
          pc.addTrack(track, _localCamStream);
        }
      });
    }
    if (_localScreenStream) {
      _localScreenStream.getTracks().forEach(track => {
        if (!pc.getSenders().some(s => s.track === track)) {
          pc.addTrack(track, _localScreenStream);
        }
      });
    }
  }

  // ── Initiate call ──
  async function callPeer(peerId) {
    const pc = createPC(peerId);
    _addLocalTracksToPc(pc);
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer: pc.localDescription });
    } catch (e) {
      console.error('callPeer error:', e);
    }
  }

  async function handleOffer(fromId, offer) {
    const pc = createPC(fromId);
    _addLocalTracksToPc(pc);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: fromId, answer: pc.localDescription });
    } catch (e) {
      console.error('handleOffer error:', e);
    }
  }

  async function handleAnswer(fromId, answer) {
    const pc = pcs[fromId];
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    } catch (e) {
      console.error('handleAnswer error:', e);
    }
  }

  async function handleICE(fromId, candidate) {
    const pc = pcs[fromId];
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) { /* trickle ICE — ignore */ }
  }

  // ── Sync tracks after stream change ──
  // Called after toggleMic / toggleCamera / toggleScreen
  function updateAllPeers() {
    Object.entries(pcs).forEach(([peerId, pc]) => {
      _syncTracks(peerId, pc);
    });
  }

  function _syncTracks(peerId, pc) {
    // Build the "wanted" set: all live tracks from current local streams
    const wanted = new Map(); // track -> stream
    if (_localCamStream)    _localCamStream.getTracks().forEach(t => wanted.set(t, _localCamStream));
    if (_localScreenStream) _localScreenStream.getTracks().forEach(t => wanted.set(t, _localScreenStream));

    const senders = pc.getSenders();
    let changed = false;

    // Remove senders whose track is no longer wanted
    senders.forEach(sender => {
      if (sender.track && !wanted.has(sender.track)) {
        try { pc.removeTrack(sender); changed = true; }
        catch (e) { console.warn('removeTrack', e); }
      }
    });

    // Add new wanted tracks not yet sent
    const sentTracks = pc.getSenders().map(s => s.track).filter(Boolean);
    wanted.forEach((stream, track) => {
      if (!sentTracks.includes(track)) {
        try { pc.addTrack(track, stream); changed = true; }
        catch (e) { console.warn('addTrack', e); }
      }
    });

    if (changed) _renegotiate(peerId, pc);
  }

  async function _renegotiate(peerId, pc) {
    if (pc.signalingState !== 'stable') {
      setTimeout(() => _renegotiate(peerId, pc), 400);
      return;
    }
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer: pc.localDescription });
    } catch (e) {
      console.error('renegotiate error:', e);
    }
  }

  // ── Cleanup ──
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
