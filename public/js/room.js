// ============================================================
//  MeetSpace — Room Client
//  Fixes: draggable PiP, PiP position clear of chat, focus
//         overlay CSS, admission gate, ghost tiles, name prompt,
//         track recovery, health-check, host controls
// ============================================================

const socket = io();
const peers       = {};
const peerStreams  = {};
const peerNames   = {};

let USER_NAME       = '';   // set after gate
let localStream     = null;
let screenStream    = null;
let isScreenSharing = false;
let screenMinimized = false;
let micEnabled      = true;
let camEnabled      = true;
let chatOpen        = false;
let participantsPanelOpen = false;
let unreadCount     = 0;
let startTime       = Date.now();
let audioUnlocked   = false;
let localMinimized  = false;
let focusedPeer     = null;
let isHost          = false;
let hostSocketId    = null;
let pendingAdmission = null;   // { socketId, userName } currently showing in admit toast
let admitQueue      = [];      // queue of waiting requests

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

// ── DOM refs (only accessed after room-ui is shown) ───────────
const videoGrid        = () => document.getElementById('video-grid');
const localVideo       = () => document.getElementById('local-video');
const localPlaceholder = () => document.getElementById('local-placeholder');
const localAvatar      = () => document.getElementById('local-avatar');
const localNameLabel   = () => document.getElementById('local-name-label');
const chatPanel        = () => document.getElementById('chat-panel');
const chatMessages     = () => document.getElementById('chat-messages');
const chatInput        = () => document.getElementById('chat-input');
const chatBadge        = () => document.getElementById('chat-badge');
const participantCount = () => document.getElementById('participant-count');
const screenPreview    = () => document.getElementById('screen-preview');
const screenPreviewVid = () => document.getElementById('screen-preview-video');
const focusOverlay     = () => document.getElementById('focus-overlay');
const focusVideo       = () => document.getElementById('focus-video');
const focusName        = () => document.getElementById('focus-name');

// ── GATE: name entry / waiting / denied ───────────────────────
function gateJoin() {
  const input = document.getElementById('gate-name-input');
  const name  = input.value.trim();
  if (!name) {
    document.getElementById('gate-error').classList.remove('hidden');
    input.focus();
    return;
  }
  USER_NAME = name;
  sessionStorage.setItem('userName', name);

  // Show waiting overlay
  document.getElementById('gate-overlay').classList.add('hidden');
  document.getElementById('waiting-overlay').classList.remove('hidden');

  socket.emit('join-room', { roomId: ROOM_ID, userName: USER_NAME });
}

function cancelWait() {
  socket.disconnect();
  window.location.href = '/';
}

document.getElementById('gate-name-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') gateJoin();
});

// Check if name already known (came from index page)
const _savedName = sessionStorage.getItem('userName');
if (_savedName) {
  USER_NAME = _savedName;
  // Skip gate — go straight to waiting overlay, then emit join
  document.getElementById('gate-overlay').classList.add('hidden');
  document.getElementById('waiting-overlay').classList.remove('hidden');
  socket.emit('join-room', { roomId: ROOM_ID, userName: USER_NAME });
} else {
  // Show gate (name entry)
  document.getElementById('gate-overlay').classList.remove('hidden');
}

// ── Admitted — show main room UI ──────────────────────────────
function showRoomUI() {
  document.getElementById('waiting-overlay').classList.add('hidden');
  document.getElementById('room-ui').classList.remove('hidden');

  document.getElementById('display-room-id').textContent = ROOM_ID;
  localNameLabel().textContent = USER_NAME + ' (You)';
  localAvatar().textContent    = USER_NAME.charAt(0).toUpperCase();

  startTimer();
  initDraggablePip();
}

// ── Autoplay unlock ───────────────────────────────────────────
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  document.querySelectorAll('.video-tile:not(.local-tile) video').forEach(v => {
    v.muted = false; v.volume = 1.0;
    if (v.srcObject) v.play().catch(() => {});
  });
}
document.addEventListener('click',   unlockAudio);
document.addEventListener('keydown', unlockAudio);

// ── Init media ────────────────────────────────────────────────
async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30} },
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    localVideo().srcObject = localStream;
    localVideo().muted = true;
    localPlaceholder().classList.add('hidden');
  } catch (err) {
    console.error('[init] getUserMedia:', err.name, err.message);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      camEnabled = false;
      showToast('Camera unavailable — audio only');
    } catch {
      micEnabled = camEnabled = false;
      showToast('No camera/mic — joining as viewer');
    }
    syncBtnUI();
  }
  updateGridLayout();
}

// ── Socket events ─────────────────────────────────────────────

// Admitted by host (or first person)
socket.on('room-users', async ({ participants, hostSocketId: hid, isHost: iAmHost }) => {
  isHost       = iAmHost;
  hostSocketId = hid;

  showRoomUI();
  await init();
  applyHostUI();

  for (const p of participants) {
    if (!peers[p.socketId]) {
      peerNames[p.socketId] = p.userName;
      await createPeer(p.socketId, true);
    }
  }
  updateParticipantCount();
  updateHostPanel(participants);

  // If rejoining as host, send media state so others know our screen/mic/cam status
  if (iAmHost) {
    socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: false });
  }
});

// Still waiting — host will send admission-request to themselves
socket.on('waiting-for-admission', () => {
  // Already showing waiting overlay — nothing extra needed
});

// Denied by host
socket.on('admission-denied', () => {
  document.getElementById('waiting-overlay').classList.add('hidden');
  document.getElementById('denied-overlay').classList.remove('hidden');
});

socket.on('user-joined', ({ socketId, userName, participants }) => {
  // Always store the name — even if peer connection already exists
  peerNames[socketId] = userName;
  // If peer already exists (duplicate join signal), don't create another
  if (peers[socketId]) {
    if (isHost && participants) updateHostPanel(participants);
    return;
  }
  addSystemMessage(`${userName} joined`);
  updateParticipantCount();
  if (isHost && participants) updateHostPanel(participants);
});

socket.on('offer', async ({ from, offer, fromName }) => {
  peerNames[from] = fromName;
  // FIX: if peer already exists, close old one cleanly before recreating
  if (peers[from]) {
    peers[from].close();
    delete peers[from];
    delete peerStreams[from];
    const oldTile = document.getElementById(`tile-${from}`);
    if (oldTile) oldTile.remove();
  }
  await createPeer(from, false);
  const pc = peers[from];
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, from: socket.id, answer });
});

socket.on('answer', async ({ from, answer }) => {
  if (peers[from]) await peers[from].setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  if (peers[from] && candidate) {
    try { await peers[from].addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('[ICE]', e.message); }
  }
});

socket.on('user-left', ({ socketId, userName }) => {
  const name = peerNames[socketId] || userName;
  if (focusedPeer === socketId) closeFocusOverlay();
  removePeer(socketId);
  addSystemMessage(`${name} left`);
  // Remove from admit queue if they left while waiting
  admitQueue = admitQueue.filter(q => q.socketId !== socketId);
  if (pendingAdmission && pendingAdmission.socketId === socketId) {
    pendingAdmission = null;
    document.getElementById('admit-toast').classList.add('hidden');
    setTimeout(showNextAdmitToast, 400);
  }
  updateAdmitBadge();
  updateParticipantCount();
  // If host panel is now empty after removal, show empty state
  if (isHost) {
    const list = document.getElementById('host-participants-list');
    if (list && list.querySelectorAll('.hc-participant').length === 0) {
      list.innerHTML = '<div class="hc-empty">No other participants</div>';
    }
  }
});

socket.on('chat-message', ({ userName, message, socketId: sid }) => {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  appendMessage(userName, message, time, sid === socket.id);
  if (!chatOpen) {
    unreadCount++;
    chatBadge().textContent = unreadCount;
    chatBadge().classList.remove('hidden');
  }
});

socket.on('peer-media-state', ({ socketId, video, audio, screen }) => {
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) return;

  const micIcon = tile.querySelector('.tile-icon');
  if (micIcon) micIcon.className = 'tile-icon ' + (audio ? 'mic-on' : 'mic-off');

  const ph = tile.querySelector('.no-video-placeholder');
  if (ph) ph.classList.toggle('hidden', !!(video || screen));

  const expandBtn = tile.querySelector('.tile-action-expand');
  if (expandBtn) expandBtn.classList.toggle('hidden', !screen);

  let label = tile.querySelector('.screenshare-label');
  if (screen) {
    tile.classList.add('screenshare-tile');
    if (!label) {
      label = document.createElement('div');
      label.className = 'screenshare-label';
      label.textContent = '🖥 Presenting';
      tile.appendChild(label);
    }
    // Wait for the incoming video track to carry live frames before opening
    // the focus overlay. Poll until the video element is actually playing.
    const stream = peerStreams[socketId];
    const vid = tile.querySelector('video');
    let attempts = 0;
    const tryOpen = () => {
      attempts++;
      const hasLiveVideo = stream && stream.getVideoTracks().some(t => t.readyState === 'live');
      if ((vid && vid.readyState >= 2) || hasLiveVideo || attempts >= 10) {
        openFocusOverlay(socketId);
      } else {
        setTimeout(tryOpen, 300);
      }
    };
    setTimeout(tryOpen, 300);
  } else {
    tile.classList.remove('screenshare-tile');
    if (label) label.remove();
    if (focusedPeer === socketId) closeFocusOverlay();
  }

  if (isHost) {
    const micBtn = document.getElementById(`hc-mic-${socketId}`);
    const camBtn = document.getElementById(`hc-cam-${socketId}`);
    if (micBtn) micBtn.classList.toggle('muted', !audio);
    if (camBtn) camBtn.classList.toggle('muted', !video);
  }
});

// ── Screen share refresh signals (receiver side) ──────────────
// The sender calls screen-share-started → server relays → we receive peer-screen-share-started.
// Because replaceTrack() on the sender does NOT trigger a new ontrack() on the receiver
// in most browsers (same codec, same m-line), we must manually re-bind the video element
// to flush the stale black frame from the old cam track.
socket.on('peer-screen-share-started', ({ socketId }) => {
  // Give the RTP pipeline a short moment to deliver the first screen frame
  setTimeout(() => {
    const stream = peerStreams[socketId];
    if (!stream) return;
    const tile = document.getElementById(`tile-${socketId}`);
    const vid  = tile?.querySelector('video');
    if (vid) {
      vid.srcObject = null;
      vid.srcObject = stream;
      safePlay(vid);
    }
    // Also refresh focus overlay if this peer is currently focused
    const fv = focusVideo();
    if (focusedPeer === socketId && fv) {
      fv.srcObject = null;
      fv.srcObject = stream;
      safePlay(fv);
    }
  }, 300);
});

socket.on('peer-screen-share-stopped', ({ socketId }) => {
  setTimeout(() => {
    const stream = peerStreams[socketId];
    if (!stream) return;
    const tile = document.getElementById(`tile-${socketId}`);
    const vid  = tile?.querySelector('video');
    if (vid) {
      vid.srcObject = null;
      vid.srcObject = stream;
      safePlay(vid);
    }
    if (focusedPeer === socketId) closeFocusOverlay();
  }, 200);
});


socket.on('admission-request', ({ socketId, userName }) => {
  admitQueue.push({ socketId, userName });
  updateAdmitBadge();
  showNextAdmitToast();
});

function showNextAdmitToast() {
  if (pendingAdmission || admitQueue.length === 0) return;
  pendingAdmission = admitQueue.shift();

  const toast   = document.getElementById('admit-toast');
  const nameEl  = document.getElementById('admit-name');
  const avatarEl= document.getElementById('admit-avatar');
  nameEl.textContent   = pendingAdmission.userName;
  avatarEl.textContent = pendingAdmission.userName.charAt(0).toUpperCase();
  toast.classList.remove('hidden');

  // Auto-open participants panel so host sees context
  if (!participantsPanelOpen) toggleParticipantsPanel();
}

function handleAdmit(allow) {
  if (!pendingAdmission) return;
  const { socketId, userName } = pendingAdmission;
  pendingAdmission = null;
  document.getElementById('admit-toast').classList.add('hidden');

  if (allow) {
    socket.emit('admit-participant', { roomId: ROOM_ID, targetSocketId: socketId });
    addSystemMessage(`You admitted ${userName}`);
  } else {
    socket.emit('deny-participant', { roomId: ROOM_ID, targetSocketId: socketId });
    addSystemMessage(`You denied ${userName}`);
  }

  updateAdmitBadge();
  // Show next one if any
  setTimeout(showNextAdmitToast, 400);
}

function updateAdmitBadge() {
  const badge = document.getElementById('admit-badge');
  if (!badge) return;
  const total = admitQueue.length + (pendingAdmission ? 1 : 0);
  badge.textContent = total;
  badge.classList.toggle('hidden', total === 0);
}

// ── HOST: participants-updated ────────────────────────────────
socket.on('participants-updated', ({ participants }) => {
  if (isHost) updateHostPanel(participants);
});

// NOTE: 'you-are-now-host' is no longer emitted by the server.
// Host role is only reclaimed when the original host rejoins with the same name.
// Keeping handler as no-op for backward compatibility.
socket.on('you-are-now-host', () => {
  // No-op: host role is reclaimed via rejoin, not auto-transferred
});

socket.on('host-changed', ({ hostSocketId: newHost }) => {
  hostSocketId = newHost;
  document.querySelectorAll('.host-crown').forEach(el => el.remove());
  // Mark new host tile
  const tile = document.getElementById(`tile-${newHost}`);
  if (tile) {
    const crown = document.createElement('div');
    crown.className = 'host-crown'; crown.title = 'Host'; crown.textContent = '👑';
    tile.appendChild(crown);
  }
  // If we ARE the new host (original host rejoining), update local tile too
  if (newHost === socket.id) {
    applyHostUI();
  }
});

socket.on('host-left', () => {
  hostSocketId = null;
  // Remove all host crowns from remote tiles (host left, no new host until they return)
  document.querySelectorAll('.host-crown').forEach(el => {
    const tile = el.closest('.video-tile');
    if (tile && !tile.classList.contains('local-tile')) el.remove();
  });
  addSystemMessage('Host left the meeting. Waiting for host to return...');
  showToast('👑 Host left — meeting continues until host returns');
});

// ── Remote control (participant receives) ─────────────────────
socket.on('remote-mute-mic', ({ mute }) => {
  micEnabled = !mute;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  document.getElementById('local-mic-icon').className = 'tile-icon ' + (micEnabled ? 'mic-on' : 'mic-off');
  syncBtnUI();
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: isScreenSharing });
  showToast(mute ? '🔇 Host muted your microphone' : '🎙 Host unmuted your microphone');
});

socket.on('remote-mute-cam', ({ mute }) => {
  camEnabled = !mute;
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  localPlaceholder().classList.toggle('hidden', camEnabled);
  syncBtnUI();
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: isScreenSharing });
  showToast(mute ? '📷 Host turned off your camera' : '📸 Host turned on your camera');
});

socket.on('kicked-from-room', () => {
  showToast('You were removed from the meeting by the host');
  setTimeout(() => leaveRoom(), 1500);
});

// ── Host UI ───────────────────────────────────────────────────
function applyHostUI() {
  const badge = document.getElementById('host-badge');
  if (badge) badge.classList.toggle('hidden', !isHost);
  const panelBtn = document.getElementById('participants-btn');
  if (panelBtn) panelBtn.classList.toggle('hidden', !isHost);

  const localTile = document.getElementById('local-tile');
  if (localTile) {
    localTile.querySelector('.host-crown')?.remove();
    if (isHost) {
      const crown = document.createElement('div');
      crown.className = 'host-crown'; crown.title = 'You are the host'; crown.textContent = '👑';
      localTile.appendChild(crown);
    }
  }
}

function toggleParticipantsPanel() {
  if (!isHost) return;
  participantsPanelOpen = !participantsPanelOpen;
  document.getElementById('participants-panel').classList.toggle('open', participantsPanelOpen);
  document.getElementById('participants-btn').classList.toggle('active', participantsPanelOpen);
}

function updateHostPanel(participants) {
  if (!isHost) return;
  const list = document.getElementById('host-participants-list');
  if (!list) return;
  list.innerHTML = '';

  const others = participants.filter(p => p.socketId !== socket.id);
  if (others.length === 0) {
    list.innerHTML = '<div class="hc-empty">No other participants</div>';
    return;
  }

  others.forEach(p => {
    const div = document.createElement('div');
    div.className = 'hc-participant';
    div.id = `hc-row-${p.socketId}`;
    const audioMuted = p.audio === false;
    const videoMuted = p.video === false;
    const micOnSvg  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-1 15.93V20H9v2h6v-2h-2v-3.07A7.001 7.001 0 0019 11h-2a5 5 0 01-10 0H5a7.001 7.001 0 006 6.93z"/></svg>`;
    const micOffSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11a7 7 0 01-7.93 6.93L9.4 16.26A5 5 0 0017 11h2zm-7 7a5 5 0 01-5-5v-.17L3.41 9.41 2 10.83l2.07 2.07A7.001 7.001 0 0011 18.93V21H9v2h6v-2h-2v-2.07c.35-.04.69-.1 1.02-.19L22 21.17l1.41-1.42L3.41 1 2 2.41l8.17 8.17V11a2 2 0 004 .15V5.83L16.59 8A3.98 3.98 0 0016 6a4 4 0 00-8 0v5a4 4 0 01.07-.73z"/></svg>`;
    const camOnSvg  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>`;
    const camOffSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h2m5.66 0H14a2 2 0 012 2v3.34l1 1L23 7v10M1 1l22 22"/></svg>`;
    div.innerHTML = `
      <div class="hc-avatar">${escapeHtml(p.userName.charAt(0).toUpperCase())}</div>
      <div class="hc-name">${escapeHtml(p.userName)}</div>
      <div class="hc-actions">
        <button id="hc-mic-${p.socketId}" class="hc-btn ${audioMuted?'muted':''}"
          title="${audioMuted?'Unmute mic':'Mute mic'}" onclick="hostToggleMic('${p.socketId}',this)">
          ${audioMuted ? micOffSvg : micOnSvg}
        </button>
        <button id="hc-cam-${p.socketId}" class="hc-btn ${videoMuted?'muted':''}"
          title="${videoMuted?'Turn on camera':'Turn off camera'}" onclick="hostToggleCam('${p.socketId}',this)">
          ${videoMuted ? camOffSvg : camOnSvg}
        </button>
        <button class="hc-btn hc-kick" title="Remove from meeting"
          onclick="hostKick('${p.socketId}','${escapeHtml(p.userName)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3H6a2 2 0 00-2 2v14c0 1.1.9 2 2 2h4M16 17l5-5-5-5M21 12H9"/></svg>
        </button>
      </div>`;
    list.appendChild(div);
  });
}

function hostToggleMic(targetSocketId, btn) {
  const isMuted = btn.classList.contains('muted');
  socket.emit('host-mute-mic', { roomId: ROOM_ID, targetSocketId, mute: !isMuted });
  btn.classList.toggle('muted', !isMuted);
}

function hostToggleCam(targetSocketId, btn) {
  const isMuted = btn.classList.contains('muted');
  socket.emit('host-mute-cam', { roomId: ROOM_ID, targetSocketId, mute: !isMuted });
  btn.classList.toggle('muted', !isMuted);
}

function hostKick(targetSocketId, name) {
  if (!confirm(`Remove ${name} from the meeting?`)) return;
  socket.emit('host-kick', { roomId: ROOM_ID, targetSocketId });
  document.getElementById(`hc-row-${targetSocketId}`)?.remove();
}

// ── Peer connection ───────────────────────────────────────────
async function createPeer(socketId, initiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[socketId] = pc;

  // Add local camera/mic tracks first
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // If screen sharing is active, replace the video sender with the live screen track.
  // We must do this AFTER addTrack so a video sender already exists.
  if (isScreenSharing && screenStream) {
    const screenTrack = screenStream.getVideoTracks().find(t => t.readyState === 'live');
    if (screenTrack) {
      const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (videoSender) {
        // replaceTrack is synchronous from the sender perspective but async with the browser.
        // Awaiting here ensures the offer/answer SDP reflects the actual track being sent.
        await videoSender.replaceTrack(screenTrack).catch(e =>
          console.warn('[createPeer] replaceTrack for screen:', e.message)
        );
      } else {
        pc.addTrack(screenTrack, screenStream);
      }
    }
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { to: socketId, from: socket.id, candidate });
  };

  // ICE connection state for transport-level failures
  pc.oniceconnectionstatechange = () => {
    console.log(`[peer ${socketId}] ice: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.warn(`[peer ${socketId}] ICE failed — attempting restart`);
      pc.restartIce();
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[peer ${socketId}] conn: ${pc.connectionState}`);
    if (['failed','closed'].includes(pc.connectionState)) removePeer(socketId);
  };

  peerStreams[socketId] = new MediaStream();

  pc.ontrack = ({ track, streams }) => {
    console.log(`[peer ${socketId}] ontrack ${track.kind} id=${track.id} readyState=${track.readyState}`);

    // FIX: Always use the incoming stream directly (streams[0]) when available.
    // replaceTrack() sends on the same stream, so streams[0] carries the latest track.
    // Falling back to our cached MediaStream caused receivers to keep showing the old cam.
    const incomingStream = (streams && streams[0]) ? streams[0] : null;

    if (incomingStream) {
      // Update our cache to point to the real incoming stream
      peerStreams[socketId] = incomingStream;
    }

    const stream = peerStreams[socketId];

    // For manual MediaStream (no streams[0]), splice the track in
    if (!incomingStream) {
      stream.getTracks().filter(t => t.kind === track.kind).forEach(t => stream.removeTrack(t));
      stream.addTrack(track);
    }

    if (track.kind === 'audio') track.enabled = true;

    track.onmute   = () => console.log(`[peer ${socketId}] track muted   ${track.kind}`);
    track.onunmute = () => refreshTileVideo(socketId, peerStreams[socketId]);
    track.onended  = () => {
      if (!incomingStream) peerStreams[socketId]?.removeTrack(track);
      refreshTileVideo(socketId, peerStreams[socketId]);
    };

    refreshTileVideo(socketId, peerStreams[socketId], track);
    updateGridLayout();
  };

  if (!document.getElementById(`tile-${socketId}`)) addRemoteTile(socketId, peerStreams[socketId]);

  if (initiator) {
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: socketId, offer, from: socket.id, fromName: USER_NAME });
  }
  return pc;
}

// Reassigning srcObject (null → stream) forces the browser to re-bind the
// MediaStream and begin decoding the new/replaced track, clearing black frames.
function refreshTileVideo(socketId, stream, newTrack) {
  // Don't create/refresh tiles for peers that are no longer tracked
  if (!peers[socketId] && !peerNames[socketId]) return;
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) { addRemoteTile(socketId, stream); return; }
  const vid = tile.querySelector('video');
  if (!vid) return;

  // Force re-bind so the browser flushes the stale (black) decoded frame buffer
  vid.srcObject = null;
  vid.srcObject = stream;
  vid.muted = false; vid.volume = 1.0;
  safePlay(vid);

  // Hide placeholder once we have an active video track
  const hasVideo = stream.getVideoTracks().some(t => t.readyState === 'live' && t.enabled);
  if (hasVideo || newTrack?.kind === 'video') {
    const ph = tile.querySelector('.no-video-placeholder');
    if (ph) ph.classList.add('hidden');
  }

  // Refresh focus overlay too if this peer is currently focused
  const fv = focusVideo();
  if (focusedPeer === socketId && fv) {
    fv.srcObject = null;
    fv.srcObject = stream;
    fv.muted = false; fv.volume = 1.0;
    safePlay(fv);
  }
}

function removePeer(socketId) {
  if (peers[socketId]) { peers[socketId].close(); delete peers[socketId]; }
  delete peerStreams[socketId];
  delete peerNames[socketId];
  const tile = document.getElementById(`tile-${socketId}`);
  if (tile) tile.remove();
  document.getElementById(`hc-row-${socketId}`)?.remove();
  // Sweep any orphan tiles whose socketId has no peer and no known name (ghost "Participant" tiles)
  document.querySelectorAll('.video-tile[id^="tile-"]').forEach(t => {
    const sid = t.id.replace('tile-', '');
    if (sid !== 'local' && !peers[sid] && !peerNames[sid]) t.remove();
  });
  updateGridLayout();
  updateParticipantCount();
}

// ── Remote tile ───────────────────────────────────────────────
function addRemoteTile(socketId, stream) {
  // FIX: strict guard — never create duplicate tiles
  if (document.getElementById(`tile-${socketId}`)) {
    // If tile exists but has placeholder name, update it now that we have the real name
    const existingTile = document.getElementById(`tile-${socketId}`);
    const nameEl = existingTile?.querySelector('.tile-name');
    if (nameEl && nameEl.textContent === 'Participant' && peerNames[socketId]) {
      const realName = peerNames[socketId];
      nameEl.textContent = realName;
      const avatarEl = existingTile.querySelector('.avatar-circle');
      if (avatarEl) avatarEl.textContent = realName.charAt(0).toUpperCase();
    }
    return;
  }
  const name    = peerNames[socketId] || 'Participant';
  const initial = name.charAt(0).toUpperCase();

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${socketId}`;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-controls">
      <button class="tile-action-btn tile-action-expand hidden" onclick="openFocusOverlay('${socketId}')" title="Expand screen">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
      <button class="tile-action-btn tile-action-min" onclick="minimizeTile('${socketId}')" title="Minimize">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 20 15 20 15 15"/><polyline points="4 4 9 4 9 9"/><line x1="15" y1="20" x2="21" y2="14"/><line x1="9" y1="4" x2="3" y2="10"/></svg>
      </button>
      <button class="tile-action-btn tile-action-max hidden" onclick="maximizeTile('${socketId}')" title="Restore">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
    </div>
    <div class="tile-info">
      <div class="tile-name">${escapeHtml(name)}</div>
      <div class="tile-icons">
        <span class="tile-icon mic-on">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-1 15.93V20H9v2h6v-2h-2v-3.07A7.001 7.001 0 0019 11h-2a5 5 0 01-10 0H5a7.001 7.001 0 006 6.93z"/></svg>
        </span>
      </div>
    </div>
    <div class="no-video-placeholder">
      <div class="avatar-circle">${escapeHtml(initial)}</div>
    </div>`;

  if (socketId === hostSocketId) {
    const crown = document.createElement('div');
    crown.className = 'host-crown'; crown.title = 'Host'; crown.textContent = '👑';
    tile.appendChild(crown);
  }

  const vid = tile.querySelector('video');
  vid.volume = 1.0;
  if (stream?.getTracks().length > 0) {
    vid.srcObject = stream;
    safePlay(vid);
    if (stream.getVideoTracks().length > 0) {
      tile.querySelector('.no-video-placeholder').classList.add('hidden');
    }
  }
  videoGrid().appendChild(tile);
  updateGridLayout();
}

// ── Focus overlay (fullscreen shared screen) ──────────────────
function openFocusOverlay(socketId) {
  const stream = peerStreams[socketId];
  if (!stream) return;
  focusedPeer = socketId;
  const name = peerNames[socketId] || 'Participant';
  focusName().textContent = name + ' — Screen Share';

  const fv = focusVideo();
  // Force null → reassign to flush any stale/black buffered frame
  fv.srcObject = null;
  fv.srcObject = stream;
  fv.muted = false; fv.volume = 1.0;
  safePlay(fv);

  focusOverlay().classList.remove('hidden');
}

function closeFocusOverlay() {
  focusedPeer = null;
  focusOverlay().classList.add('hidden');
  const fv = focusVideo();
  if (fv) fv.srcObject = null;
}

// ── Tile min/max ──────────────────────────────────────────────
function minimizeTile(socketId) {
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) return;
  tile.classList.add('tile-minimized');
  tile.querySelector('.tile-action-min').classList.add('hidden');
  tile.querySelector('.tile-action-max').classList.remove('hidden');
  updateGridLayout();
}
function maximizeTile(socketId) {
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) return;
  tile.classList.remove('tile-minimized');
  tile.querySelector('.tile-action-min').classList.remove('hidden');
  tile.querySelector('.tile-action-max').classList.add('hidden');
  updateGridLayout();
}
function toggleLocalTile() {
  const tile = document.getElementById('local-tile');
  localMinimized = !localMinimized;
  tile.classList.toggle('tile-minimized', localMinimized);
  document.getElementById('local-min-btn').classList.toggle('hidden', localMinimized);
  document.getElementById('local-max-btn').classList.toggle('hidden', !localMinimized);
  updateGridLayout();
}

// ── safePlay ──────────────────────────────────────────────────
function safePlay(videoEl) {
  if (!videoEl) return;
  const p = videoEl.play();
  if (p) p.catch(err => {
    if (err.name === 'NotAllowedError') document.getElementById('audio-banner')?.classList.remove('hidden');
    else if (err.name === 'AbortError') {
      // Mobile browsers abort play() when tab goes to background — retry shortly
      setTimeout(() => {
        if (videoEl.srcObject && videoEl.paused) videoEl.play().catch(() => {});
      }, 500);
    }
  });
}

// ── Mobile: force-rebind every video after returning from background ───────────
// Mobile OSes (iOS, Android) suspend WebRTC video decoders when the browser
// tab is backgrounded or the screen locks. On return the video element stays
// black even though the RTP stream is still flowing. A null→reassign of
// srcObject forces the browser to re-attach the decoder to the live track.
function rebindAllVideos() {
  console.log('[mobile] rebindAllVideos');
  Object.keys(peerStreams).forEach(socketId => {
    const stream = peerStreams[socketId];
    if (!stream) return;
    const tile = document.getElementById(`tile-${socketId}`);
    const vid  = tile?.querySelector('video');
    if (vid) {
      const src = vid.srcObject || stream;
      vid.srcObject = null;
      vid.srcObject = src;
      safePlay(vid);
    }
  });
  // Focus overlay
  if (focusedPeer) {
    const fv = focusVideo();
    if (fv) {
      const src = fv.srcObject || peerStreams[focusedPeer];
      if (src) { fv.srcObject = null; fv.srcObject = src; safePlay(fv); }
    }
  }
  // Local video (may also pause after background)
  const lv = localVideo();
  if (lv && localStream) {
    if (!lv.srcObject) lv.srcObject = localStream;
    if (lv.paused) lv.play().catch(() => {});
  }
}

// ── Mobile: Page Visibility API ───────────────────────────────
// Tab switch / screen lock → decoders suspended → must rebind on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    setTimeout(rebindAllVideos, 400);   // first pass: fast devices
    setTimeout(rebindAllVideos, 1500);  // second pass: slow devices
  }
});

// ── Mobile: Page Lifecycle freeze/resume (Chrome Android) ─────
window.addEventListener('resume', () => setTimeout(rebindAllVideos, 400));

// ── Mobile: bfcache restore (Safari iOS) ─────────────────────
window.addEventListener('pageshow', e => {
  if (e.persisted) setTimeout(rebindAllVideos, 400);
});

// ── Mobile: Screen Wake Lock ──────────────────────────────────
// Prevents the screen from turning off while watching a shared screen.
// The OS would suspend the video decoder, causing permanent black frames.
let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    console.log('[mobile] wake lock acquired');
  } catch (err) {
    console.warn('[mobile] wake lock failed:', err.message);
  }
}
// Re-acquire after OS releases it (happens on every visibility change)
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
});
function acquireWakeLockForScreenShare() { requestWakeLock(); }

// ── Mobile: tap-to-recover stalled videos (iOS fallback) ──────
// iOS Safari requires a user gesture to resume suspended video playback.
document.addEventListener('touchend', () => {
  document.querySelectorAll('video').forEach(v => {
    if (v.paused && v.srcObject) v.play().catch(() => {});
  });
}, { passive: true });

// ── FIX: Draggable PiP panel ──────────────────────────────────
function initDraggablePip() {
  const pip    = document.getElementById('screen-preview');
  const handle = document.getElementById('screen-preview-drag-handle');
  if (!pip || !handle) return;

  let dragging = false, startX, startY, origLeft, origTop;

  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return; // don't drag if clicking a button
    dragging = true;
    // Convert current right/bottom to left/top for drag math
    const rect = pip.getBoundingClientRect();
    pip.style.right  = 'auto';
    pip.style.bottom = 'auto';
    pip.style.left   = rect.left + 'px';
    pip.style.top    = rect.top  + 'px';
    startX  = e.clientX;
    startY  = e.clientY;
    origLeft = rect.left;
    origTop  = rect.top;
    pip.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let newLeft = origLeft + dx;
    let newTop  = origTop  + dy;
    // Clamp within viewport
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth  - pip.offsetWidth));
    newTop  = Math.max(0, Math.min(newTop,  window.innerHeight - pip.offsetHeight));
    pip.style.left = newLeft + 'px';
    pip.style.top  = newTop  + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; pip.style.transition = ''; }
  });

  // Touch support
  handle.addEventListener('touchstart', e => {
    if (e.target.closest('button')) return;
    const touch = e.touches[0];
    const rect  = pip.getBoundingClientRect();
    pip.style.right  = 'auto';
    pip.style.bottom = 'auto';
    pip.style.left   = rect.left + 'px';
    pip.style.top    = rect.top  + 'px';
    startX = touch.clientX; startY = touch.clientY;
    origLeft = rect.left;   origTop  = rect.top;
    dragging = true;
    pip.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const touch = e.touches[0];
    let newLeft = origLeft + (touch.clientX - startX);
    let newTop  = origTop  + (touch.clientY - startY);
    newLeft = Math.max(0, Math.min(newLeft, window.innerWidth  - pip.offsetWidth));
    newTop  = Math.max(0, Math.min(newTop,  window.innerHeight - pip.offsetHeight));
    pip.style.left = newLeft + 'px';
    pip.style.top  = newTop  + 'px';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (dragging) { dragging = false; pip.style.transition = ''; }
  });
}

// ── Periodic health-check ─────────────────────────────────────
// Catches black screens caused by stalled decoders or detached srcObjects.
// Runs every 2 s. Also detects readyState===0 (HAVE_NOTHING) which is the
// signature of a mobile decoder being silently detached after backgrounding.
setInterval(() => {
  Object.keys(peerStreams).forEach(socketId => {
    const stream = peerStreams[socketId];
    if (!stream) return;
    const tile = document.getElementById(`tile-${socketId}`);
    if (!tile) return;
    const vid = tile.querySelector('video');
    if (!vid) return;

    const hasLiveVideo = stream.getVideoTracks().some(t => t.readyState === 'live');
    const needsRefresh =
      !vid.srcObject ||
      vid.readyState === 0 ||                          // HAVE_NOTHING — mobile decoder detached
      (vid.readyState < 2 && hasLiveVideo) ||
      vid.paused;

    if (needsRefresh) {
      const src = vid.srcObject || stream;
      console.log(`[health] refreshing stalled video for ${socketId} readyState=${vid.readyState} paused=${vid.paused}`);
      vid.srcObject = null;
      vid.srcObject = src;
      safePlay(vid);
    }

    // Also keep the focus overlay in sync
    const fv = focusVideo();
    if (focusedPeer === socketId && fv) {
      const fvSrc = fv.srcObject || stream;
      if (!fv.srcObject || fv.readyState === 0 || fv.readyState < 2 || fv.paused) {
        fv.srcObject = null; fv.srcObject = fvSrc; safePlay(fv);
      }
    }
  });
}, 2000);

// ── Grid ──────────────────────────────────────────────────────
function updateGridLayout() {
  const grid = videoGrid();
  if (!grid) return;
  const count = grid.children.length;
  grid.setAttribute('data-count', Math.min(count, 6));
}
function updateParticipantCount() {
  const n = Object.keys(peers).length + 1;
  const el = participantCount();
  if (el) el.textContent = n === 1 ? '1 participant' : `${n} participants`;
}

// ── Mic / Camera ──────────────────────────────────────────────
function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  document.getElementById('local-mic-icon').className = 'tile-icon ' + (micEnabled ? 'mic-on' : 'mic-off');
  syncBtnUI();
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: isScreenSharing });
}
function toggleCamera() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  localPlaceholder().classList.toggle('hidden', camEnabled);
  syncBtnUI();
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: isScreenSharing });
}
function syncBtnUI() {
  const mb = document.getElementById('mic-btn');
  if (!mb) return;
  mb.querySelector('.icon-on').classList.toggle('hidden', !micEnabled);
  mb.querySelector('.icon-off').classList.toggle('hidden', micEnabled);
  mb.classList.toggle('off', !micEnabled);
  mb.querySelector('span').textContent = micEnabled ? 'Mute' : 'Unmute';

  const cb = document.getElementById('cam-btn');
  if (!cb) return;
  cb.querySelector('.icon-on').classList.toggle('hidden', !camEnabled);
  cb.querySelector('.icon-off').classList.toggle('hidden', camEnabled);
  cb.classList.toggle('off', !camEnabled);
  cb.querySelector('span').textContent = camEnabled ? 'Camera' : 'Start Cam';
}

// ── Screen Share ──────────────────────────────────────────────
async function toggleScreenShare() {
  isScreenSharing ? stopScreenShare() : await startScreenShare();
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor:'always', frameRate:{ideal:30,max:60}, width:{ideal:1920}, height:{ideal:1080} },
      audio: false
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') showToast('Screen share failed: ' + err.message);
    return;
  }

  isScreenSharing = true;
  screenMinimized = false;
  const screenTrack = screenStream.getVideoTracks()[0];

  // Improve encoding quality for screen content
  screenTrack.contentHint = 'detail';

  // Keep the screen on while sharing — prevents OS from suspending the encoder
  acquireWakeLockForScreenShare();

  // Wait for the screen track to actually produce its FIRST FRAME before sending.
  // The unmute event fires too early on many browsers — the track is 'live' but
  // the encoder hasn't output any frames yet, which causes receivers to decode black.
  // We use a hidden <video> to detect when real pixel data is available.
  await new Promise(resolve => {
    if (screenTrack.readyState !== 'live') { resolve(); return; }
    const probe = document.createElement('video');
    probe.muted = true;
    probe.srcObject = new MediaStream([screenTrack]);
    probe.play().catch(() => {});
    let attempts = 0;
    const check = () => {
      attempts++;
      // videoWidth > 0 means the decoder has at least one decoded frame
      if (probe.videoWidth > 0 || attempts >= 20) {
        probe.srcObject = null;
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    };
    requestAnimationFrame(check);
    // Hard fallback: 800 ms max wait so we never hang
    setTimeout(() => { probe.srcObject = null; resolve(); }, 800);
  });

  // Replace video track on every existing peer connection
  await Promise.allSettled(Object.keys(peers).map(async sid => {
    const pc = peers[sid];
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') return;
    const vs = pc.getSenders().find(s => s.track?.kind === 'video');
    if (vs) {
      try { await vs.replaceTrack(screenTrack); }
      catch (e) {
        console.warn(`[screen] replaceTrack failed for ${sid}, adding instead:`, e.message);
        pc.addTrack(screenTrack, screenStream);
      }
    } else {
      pc.addTrack(screenTrack, screenStream);
    }
  }));

  // Show PiP preview of own screen
  const spv = screenPreviewVid();
  spv.srcObject = screenStream; spv.muted = true; spv.play().catch(()=>{});

  // Reset PiP position away from chat panel
  const pip = screenPreview();
  pip.style.left = ''; pip.style.top = '';
  pip.style.right = '20px'; pip.style.bottom = 'calc(var(--ctrl-bar) + 16px)';
  pip.classList.remove('hidden', 'minimized');

  // Show screen track in local tile (mirroring disabled for screen content)
  const lv = localVideo();
  lv.srcObject = screenStream; lv.muted = true; lv.style.transform = 'none';
  localPlaceholder().classList.add('hidden');

  const localTile = document.getElementById('local-tile');
  localTile.classList.add('screenshare-tile');
  if (!localTile.querySelector('.screenshare-label')) {
    const lbl = document.createElement('div');
    lbl.className = 'screenshare-label'; lbl.textContent = '🖥 You are presenting';
    localTile.appendChild(lbl);
  }

  const btn = document.getElementById('screen-btn');
  btn.classList.add('active');
  btn.querySelector('.icon-on').classList.add('hidden');
  btn.querySelector('.icon-off').classList.remove('hidden');
  btn.querySelector('span').textContent = 'Stop';
  document.getElementById('screen-banner').classList.remove('hidden');

  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: true });

  // Emit a dedicated signal so receivers immediately re-bind their video element.
  // replaceTrack() on the sender does NOT fire a new ontrack on the receiver when
  // the codec/m-line is unchanged — so receivers stay stuck on their old srcObject.
  socket.emit('screen-share-started', { roomId: ROOM_ID });

  // Handle user clicking browser's "Stop sharing" button
  screenTrack.onended = () => stopScreenShare();
  showToast('Screen sharing started');
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  isScreenSharing = false;

  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }

  // Restore camera track on all peers (null replaceTrack sends black — use a live track or remove)
  const camTrack = localStream?.getVideoTracks().find(t => t.readyState === 'live') || null;
  Object.keys(peers).forEach(sid => {
    const pc = peers[sid];
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') return;
    const vs = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!vs) return;
    if (camTrack) {
      vs.replaceTrack(camTrack).catch(e => console.warn(`[screen stop] replaceTrack ${sid}:`, e.message));
    } else {
      // Camera was never available — replace with null to send silence/black
      // but don't crash; some browsers reject null replaceTrack
      vs.replaceTrack(null).catch(() => {});
    }
  });

  const lv = localVideo();
  if (localStream) {
    lv.srcObject = localStream; lv.style.transform = '';
    localPlaceholder().classList.toggle('hidden', camEnabled);
  }

  const localTile = document.getElementById('local-tile');
  localTile.classList.remove('screenshare-tile');
  localTile.querySelector('.screenshare-label')?.remove();

  const pip = screenPreview();
  pip.classList.add('hidden');
  screenPreviewVid().srcObject = null;

  const btn = document.getElementById('screen-btn');
  btn.classList.remove('active');
  btn.querySelector('.icon-on').classList.remove('hidden');
  btn.querySelector('.icon-off').classList.add('hidden');
  btn.querySelector('span').textContent = 'Share';
  document.getElementById('screen-banner').classList.add('hidden');

  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: false });
  showToast('Screen sharing stopped');
}

function toggleScreenPreview() {
  screenMinimized = !screenMinimized;
  screenPreview().classList.toggle('minimized', screenMinimized);
  const btn = document.getElementById('screen-preview-toggle');
  btn.title = screenMinimized ? 'Maximize' : 'Minimize';
  btn.innerHTML = screenMinimized
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;
}

// ── Chat ──────────────────────────────────────────────────────
function toggleChat() {
  chatOpen = !chatOpen;
  chatPanel().classList.toggle('open', chatOpen);
  document.getElementById('chat-btn').classList.toggle('active', chatOpen);
  if (chatOpen) {
    unreadCount = 0;
    chatBadge().classList.add('hidden');
    chatInput().focus();
    chatMessages().scrollTop = chatMessages().scrollHeight;
  }
}
function sendMessage() {
  const msg = chatInput().value.trim();
  if (!msg) return;
  socket.emit('chat-message', { roomId: ROOM_ID, message: msg, userName: USER_NAME });
  chatInput().value = '';
}
function appendMessage(userName, message, time, isOwn) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isOwn ? ' own' : '');
  div.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-name">${escapeHtml(userName)}</span>
      <span class="chat-msg-time">${time}</span>
    </div>
    <div class="chat-msg-body">${escapeHtml(message)}</div>`;
  chatMessages().appendChild(div);
  chatMessages().scrollTop = chatMessages().scrollHeight;
}
function addSystemMessage(text) {
  const cm = chatMessages();
  if (!cm) return;
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text;
  cm.appendChild(div);
  cm.scrollTop = cm.scrollHeight;
}
document.addEventListener('keydown', e => {
  const ci = chatInput();
  if (ci && document.activeElement === ci && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); sendMessage();
  }
});

function forceUnlockAudio() {
  document.querySelectorAll('.video-tile:not(.local-tile) video').forEach(v => {
    v.muted = false; v.volume = 1.0; v.play().catch(()=>{});
  });
  document.getElementById('audio-banner')?.classList.add('hidden');
  showToast('Audio enabled!');
  audioUnlocked = true;
}

function leaveRoom() {
  if (isScreenSharing && screenStream) screenStream.getTracks().forEach(t => t.stop());
  Object.keys(peers).forEach(id => peers[id].close());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  socket.disconnect();
  window.location.href = '/';
}

function copyRoomId() { navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Meeting ID copied!')); }
function copyLink()   { navigator.clipboard.writeText(window.location.href).then(() => showToast('Link copied!')); }

function startTimer() {
  startTime = Date.now();
  setInterval(() => {
    const s  = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2,'0');
    const ss = String(s % 60).padStart(2,'0');
    const el = document.getElementById('meeting-time');
    if (el) el.textContent = `${mm}:${ss}`;
  }, 1000);
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
