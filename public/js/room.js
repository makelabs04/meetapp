// ============================================================
//  MeetSpace — Room Client
//  Fixes applied:
//    [FIX 1] ontrack always updates srcObject even if tile exists
//    [FIX 2] renderRemoteTile always re-assigns srcObject + calls play()
//    [FIX 3] replaceTrack screen share sends correct stream to peers
// ============================================================

const socket = io();
const peers       = {};
const peerStreams  = {};
const peerNames   = {};

let USER_NAME       = '';
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
let pendingAdmission = null;
let admitQueue      = [];

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

// ── DOM refs ──────────────────────────────────────────────────
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

// ── GATE ──────────────────────────────────────────────────────
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

const _savedName = sessionStorage.getItem('userName');
if (_savedName) {
  USER_NAME = _savedName;
  document.getElementById('gate-overlay').classList.add('hidden');
  document.getElementById('waiting-overlay').classList.remove('hidden');
  socket.emit('join-room', { roomId: ROOM_ID, userName: USER_NAME });
} else {
  document.getElementById('gate-overlay').classList.remove('hidden');
}

// ── Socket Events ─────────────────────────────────────────────
socket.on('waiting-for-admission', () => {
  document.getElementById('waiting-overlay').classList.remove('hidden');
});

socket.on('admission-denied', () => {
  document.getElementById('gate-overlay').classList.add('hidden');
  document.getElementById('waiting-overlay').classList.add('hidden');
  document.getElementById('denied-overlay').classList.remove('hidden');
});

socket.on('room-users', ({ participants, hostSocketId: hid, isHost: ih }) => {
  isHost = ih;
  hostSocketId = hid;
  document.getElementById('room-ui').classList.remove('hidden');
  document.getElementById('gate-overlay').classList.add('hidden');
  document.getElementById('waiting-overlay').classList.add('hidden');

  if (isHost) {
    document.getElementById('host-badge').classList.remove('hidden');
    document.getElementById('participants-btn').classList.remove('hidden');
  }

  document.getElementById('display-room-id').textContent = ROOM_ID;
  localNameLabel().textContent = USER_NAME;
  localAvatar().textContent = USER_NAME[0].toUpperCase();

  participants.forEach(p => {
    peerNames[p.socketId] = p.userName;
    offerToPeer(p.socketId);
  });

  updateParticipantCount();
});

socket.on('user-joined', ({ socketId, userName }) => {
  console.log(`${userName} joined`);
  peerNames[socketId] = userName;
  updateParticipantCount();
});

socket.on('user-left', ({ socketId, userName }) => {
  console.log(`${userName} left`);
  closePeer(socketId);
  delete peerNames[socketId];
  if (focusedPeer === socketId) closeFocusOverlay();
  updateParticipantCount();
});

socket.on('host-changed', ({ hostSocketId: hid }) => {
  hostSocketId = hid;
  if (hid === socket.id) {
    isHost = true;
    document.getElementById('host-badge').classList.remove('hidden');
    document.getElementById('participants-btn').classList.remove('hidden');
  } else {
    isHost = false;
    document.getElementById('host-badge').classList.add('hidden');
    document.getElementById('participants-btn').classList.add('hidden');
  }
});

socket.on('host-left', () => {
  isHost = false;
  hostSocketId = null;
  document.getElementById('host-badge').classList.add('hidden');
  document.getElementById('participants-btn').classList.add('hidden');
  showToast('Host left the meeting. Waiting for host to rejoin...');
});

socket.on('offer', async ({ from, offer, fromName }) => {
  if (!peers[from]) makePeer(from);
  const pc = peers[from];
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer });
  } catch (err) {
    console.error('Offer handling error:', err);
  }
});

socket.on('answer', async ({ from, answer }) => {
  const pc = peers[from];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error('Answer handling error:', err);
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = peers[from];
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('ICE candidate error:', err);
  }
});

socket.on('chat-message', ({ userName, message, socketId }) => {
  const isLocal = socketId === socket.id;
  const d = document.createElement('div');
  d.className = 'chat-msg' + (isLocal ? ' local' : '');
  d.innerHTML = `<div class="chat-sender">${userName}</div><div class="chat-text">${escapeHtml(message)}</div>`;
  chatMessages().appendChild(d);
  chatMessages().scrollTop = chatMessages().scrollHeight;
  if (!chatOpen) {
    unreadCount++;
    chatBadge().textContent = unreadCount;
    chatBadge().classList.remove('hidden');
  }
});

socket.on('peer-media-state', ({ socketId, video, audio, screen }) => {
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) return;

  const micIcon = tile.querySelector('.mic-icon');
  const camIcon = tile.querySelector('.cam-icon');

  if (micIcon) {
    micIcon.classList.toggle('muted', !audio);
    micIcon.classList.toggle('active', audio);
  }
  if (camIcon) {
    camIcon.classList.toggle('muted', !video);
  }

  // ── [FIX 3] If remote peer started/stopped screenshare,
  //    the track change fires ontrack. But if they STOPPED sharing,
  //    we need to show the screenshare label or remove it.
  const existingLabel = tile.querySelector('.screenshare-label');
  if (screen && !existingLabel) {
    const lbl = document.createElement('div');
    lbl.className = 'screenshare-label';
    lbl.textContent = '🖥 Presenting';
    tile.appendChild(lbl);
    tile.classList.add('screenshare-tile');
  } else if (!screen && existingLabel) {
    existingLabel.remove();
    tile.classList.remove('screenshare-tile');
  }
});

socket.on('admission-request', ({ socketId, userName }) => {
  admitQueue.push({ socketId, userName });
  if (!pendingAdmission) showNextAdmitRequest();
});

socket.on('remote-mute-mic', ({ mute }) => {
  micEnabled = !mute;
  updateMicButton();
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
});

socket.on('remote-mute-cam', ({ mute }) => {
  camEnabled = !mute;
  updateCameraButton();
  if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
});

socket.on('kicked-from-room', () => {
  showToast('You have been kicked from the meeting');
  setTimeout(() => window.location.href = '/', 1000);
});

socket.on('participants-updated', ({ participants }) => {
  updateHostParticipantsList(participants);
});

// ── WebRTC ────────────────────────────────────────────────────
async function makeLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }
    });
  } catch (err) {
    showToast('Camera/Mic access denied: ' + err.message);
    if (err.name === 'NotAllowedError') {
      document.getElementById('audio-banner').classList.remove('hidden');
    }
    return false;
  }

  const lv = localVideo();
  lv.srcObject = localStream;
  lv.muted = true;
  localPlaceholder().classList.add('hidden');
  return true;
}

function makePeer(socketId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS.iceServers });
  peers[socketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  if (isScreenSharing && screenStream) {
    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) {
      try { pc.addTrack(screenTrack, screenStream); }
      catch { console.log('Track already added'); }
    }
  }

  // ── [FIX 1] Always update peerStreams AND re-render tile ──────
  // ontrack fires for EVERY track (audio + video) and also when
  // replaceTrack causes a new track to arrive. We must update the
  // video element each time, not just when creating it fresh.
  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream) return;

    console.log(`ontrack from ${socketId}: track.kind=${event.track.kind}, stream.id=${stream.id}`);

    // Always refresh the stored stream reference
    peerStreams[socketId] = stream;

    // Always re-render (updates srcObject even if tile already exists)
    renderRemoteTile(socketId);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: socketId, from: socket.id, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`${socketId} connection: ${pc.connectionState}`);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      closePeer(socketId);
    }
  };

  return pc;
}

async function offerToPeer(socketId) {
  const pc = makePeer(socketId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: socketId, from: socket.id, offer, fromName: USER_NAME });
  } catch (err) {
    console.error('Offer creation error:', err);
  }
}

// ── [FIX 2] renderRemoteTile ALWAYS sets srcObject + plays ───
function renderRemoteTile(socketId) {
  const stream = peerStreams[socketId];
  if (!stream) return;

  let tile = document.getElementById(`tile-${socketId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `tile-${socketId}`;
    tile.className = 'video-tile';
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="tile-info">
        <div class="tile-name">${peerNames[socketId] || 'Guest'}</div>
        <div class="tile-icons">
          <span class="tile-icon mic-icon active">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-1 15.93V20H9v2h6v-2h-2v-3.07A7.001 7.001 0 0119 11h-2a5 5 0 01-10 0H5a7.001 7.001 0 006 6.93z"/></svg>
          </span>
        </div>
      </div>
      <div class="no-video-placeholder">
        <div class="avatar-circle">${(peerNames[socketId] || 'G')[0].toUpperCase()}</div>
      </div>
    `;
    tile.onclick = () => focusOnPeer(socketId);
    videoGrid().appendChild(tile);
  }

  const video = tile.querySelector('video');

  // KEY FIX: Always reassign srcObject and call play()
  // Without this, when screen share replaces the video track,
  // the <video> element keeps the old stream → shows black
  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  video.muted = false; // allow remote audio
  tile.classList.remove('no-video');

  // Force play — required by Safari and mobile browsers
  video.play().catch(err => {
    console.warn(`Remote video play() blocked for ${socketId}:`, err);
    // Auto-play blocked: wait for user interaction
    const playOnClick = () => {
      video.play().catch(() => {});
      tile.removeEventListener('click', playOnClick);
    };
    tile.addEventListener('click', playOnClick);
  });
}

function closePeer(socketId) {
  const pc = peers[socketId];
  if (pc) {
    pc.close();
    delete peers[socketId];
  }
  delete peerStreams[socketId];

  const tile = document.getElementById(`tile-${socketId}`);
  if (tile) tile.remove();
}

// ── CAMERA & MIC ──────────────────────────────────────────────
async function toggleCamera() {
  if (!localStream) {
    const ok = await makeLocalStream();
    if (!ok) return;
    micEnabled = true;
    camEnabled = true;
    updateMicButton();
  }

  camEnabled = !camEnabled;
  localStream?.getVideoTracks().forEach(t => t.enabled = camEnabled);
  updateCameraButton();

  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: isScreenSharing });
}

async function toggleMic() {
  if (!localStream) {
    const ok = await makeLocalStream();
    if (!ok) return;
    micEnabled = true;
    camEnabled = true;
    updateMicButton();
    updateCameraButton();
  }

  micEnabled = !micEnabled;
  localStream?.getAudioTracks().forEach(t => t.enabled = micEnabled);
  updateMicButton();

  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: isScreenSharing });
}

function updateMicButton() {
  const btn = document.getElementById('mic-btn');
  btn.querySelector('.icon-on').classList.toggle('hidden', !micEnabled);
  btn.querySelector('.icon-off').classList.toggle('hidden', micEnabled);
}

function updateCameraButton() {
  const btn = document.getElementById('cam-btn');
  btn.querySelector('.icon-on').classList.toggle('hidden', !camEnabled);
  btn.querySelector('.icon-off').classList.toggle('hidden', camEnabled);
  localPlaceholder().classList.toggle('hidden', camEnabled);
}

// ── SCREEN SHARING ────────────────────────────────────────────
async function toggleScreenShare() {
  isScreenSharing ? stopScreenShare() : await startScreenShare();
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') showToast('Screen share failed: ' + err.message);
    return;
  }

  isScreenSharing = true;
  screenMinimized = false;
  const screenTrack = screenStream.getVideoTracks()[0];

  // ── [FIX 3] replaceTrack for existing peers ───────────────────
  // replaceTrack swaps the track in-place WITHOUT renegotiation.
  // The receiver's ontrack fires with the SAME stream object, so we
  // must use the stream already associated with that sender, not screenStream.
  // Best practice: use replaceTrack on the video sender only.
  await Promise.allSettled(Object.keys(peers).map(async sid => {
    const pc = peers[sid];
    const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (videoSender) {
      try {
        await videoSender.replaceTrack(screenTrack);
        // replaceTrack does NOT trigger ontrack on the remote side in all browsers.
        // So we also need the remote to know via media-state (done below via socket.emit).
      } catch (e) {
        // Fallback: add as new track (triggers ontrack + renegotiation)
        pc.addTrack(screenTrack, screenStream);
      }
    } else {
      pc.addTrack(screenTrack, screenStream);
    }
  }));

  // Local PiP preview
  const spv = screenPreviewVid();
  spv.srcObject = screenStream;
  spv.muted = true;
  spv.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
  try { await spv.play(); } catch(e) { console.log('PiP play blocked:', e); }

  const pip = screenPreview();
  pip.style.cssText = 'right:20px;bottom:calc(var(--ctrl-bar, 80px) + 16px);left:auto;top:auto;';
  pip.classList.remove('hidden', 'minimized');

  // Local tile shows screen
  const lv = localVideo();
  lv.srcObject = screenStream;
  lv.muted = true;
  lv.style.cssText = 'transform:none;width:100%;height:100%;object-fit:contain;display:block;';
  try { await lv.play(); } catch(e) { console.log('Local screen play blocked:', e); }

  localPlaceholder().classList.add('hidden');

  const localTile = document.getElementById('local-tile');
  localTile.classList.add('screenshare-tile');
  if (!localTile.querySelector('.screenshare-label')) {
    const lbl = document.createElement('div');
    lbl.className = 'screenshare-label';
    lbl.textContent = '🖥 You are presenting';
    localTile.appendChild(lbl);
  }

  const btn = document.getElementById('screen-btn');
  btn.classList.add('active');
  btn.querySelector('.icon-on').classList.add('hidden');
  btn.querySelector('.icon-off').classList.remove('hidden');
  btn.querySelector('span').textContent = 'Stop';
  document.getElementById('screen-banner').classList.remove('hidden');

  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: true });

  screenTrack.onended = () => stopScreenShare();
  showToast('Screen sharing started');
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  isScreenSharing = false;

  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  // Restore camera track to all peers
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      Object.keys(peers).forEach(sid => {
        const pc = peers[sid];
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
          videoSender.replaceTrack(videoTrack).catch(() => {});
        }
      });
    }
  }

  screenPreview().classList.add('hidden');
  document.getElementById('screen-banner').classList.add('hidden');

  // Restore local video to camera
  const lv = localVideo();
  if (localStream) {
    lv.srcObject = localStream;
    lv.muted = true;
    lv.style.cssText = 'transform:scaleX(-1);';
    lv.play().catch(() => {});
  }

  localPlaceholder().classList.toggle('hidden', camEnabled);

  const localTile = document.getElementById('local-tile');
  const label = localTile.querySelector('.screenshare-label');
  if (label) label.remove();
  localTile.classList.remove('screenshare-tile');

  const btn = document.getElementById('screen-btn');
  btn.classList.remove('active');
  btn.querySelector('.icon-on').classList.remove('hidden');
  btn.querySelector('.icon-off').classList.add('hidden');
  btn.querySelector('span').textContent = 'Share';

  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: false });
  showToast('Screen sharing stopped');
}

function toggleScreenPreview() {
  screenMinimized = !screenMinimized;
  screenPreview().classList.toggle('minimized', screenMinimized);
}

// ── FOCUS / FULLSCREEN ────────────────────────────────────────
function focusOnPeer(socketId) {
  focusedPeer = socketId;
  const stream = peerStreams[socketId];
  if (!stream) return;

  const fv = focusVideo();
  fv.srcObject = stream;
  fv.muted = false;
  fv.play().catch(() => {});
  focusName().textContent = peerNames[socketId] || 'Peer';
  focusOverlay().classList.remove('hidden');
}

function closeFocusOverlay() {
  focusedPeer = null;
  focusOverlay().classList.add('hidden');
}

// ── CHAT ──────────────────────────────────────────────────────
function toggleChat() {
  chatOpen = !chatOpen;
  chatPanel().classList.toggle('hidden', !chatOpen);
  if (chatOpen) {
    unreadCount = 0;
    chatBadge().classList.add('hidden');
    chatBadge().textContent = '0';
    chatInput().focus();
  }
}

function sendMessage() {
  const msg = chatInput().value.trim();
  if (!msg) return;
  socket.emit('chat-message', { roomId: ROOM_ID, message: msg, userName: USER_NAME });
  chatInput().value = '';
}

document.getElementById('chat-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── LOCAL TILE MINIMIZE ───────────────────────────────────────
function toggleLocalTile() {
  localMinimized = !localMinimized;
  const localTile = document.getElementById('local-tile');
  const minBtn = document.getElementById('local-min-btn');
  const maxBtn = document.getElementById('local-max-btn');

  localTile.classList.toggle('minimized', localMinimized);
  minBtn?.classList.toggle('hidden', localMinimized);
  maxBtn?.classList.toggle('hidden', !localMinimized);
}

// ── ROOM CONTROLS ─────────────────────────────────────────────
function updateParticipantCount() {
  const count = 1 + Object.keys(peers).length;
  participantCount().textContent = count === 1 ? '1 participant' : count + ' participants';
}

function leaveRoom() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  socket.disconnect();
  window.location.href = '/';
}

function copyRoomId() {
  navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Room ID copied'));
}

function copyLink() {
  navigator.clipboard.writeText(window.location.href).then(() => showToast('Meeting link copied'));
}

// ── MEETING TIMER ─────────────────────────────────────────────
setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const formatted = (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  const el = document.getElementById('meeting-time');
  if (el) el.textContent = formatted;
}, 1000);

// ── HOST CONTROLS ─────────────────────────────────────────────
function toggleParticipantsPanel() {
  participantsPanelOpen = !participantsPanelOpen;
  document.getElementById('participants-panel').classList.toggle('hidden', !participantsPanelOpen);
}

function showNextAdmitRequest() {
  if (admitQueue.length === 0) {
    pendingAdmission = null;
    return;
  }
  const req = admitQueue.shift();
  pendingAdmission = req;
  const toast = document.getElementById('admit-toast');
  document.getElementById('admit-avatar').textContent = (req.userName || '?')[0].toUpperCase();
  document.getElementById('admit-name').textContent = req.userName;
  toast.classList.remove('hidden');
}

function handleAdmit(allow) {
  if (!pendingAdmission) return;
  const { socketId } = pendingAdmission;
  document.getElementById('admit-toast').classList.add('hidden');

  socket.emit(allow ? 'admit-participant' : 'deny-participant', { roomId: ROOM_ID, targetSocketId: socketId });

  const count = admitQueue.length;
  if (count > 0) {
    document.getElementById('admit-badge').textContent = count;
    document.getElementById('admit-badge').classList.remove('hidden');
    showNextAdmitRequest();
  } else {
    document.getElementById('admit-badge').classList.add('hidden');
    pendingAdmission = null;
  }
}

function updateHostParticipantsList(participants) {
  const list = document.getElementById('host-participants-list');
  list.innerHTML = '';
  const others = participants.filter(p => p.socketId !== socket.id);

  if (others.length === 0) {
    list.innerHTML = '<div class="hc-empty">No other participants</div>';
    return;
  }

  others.forEach(p => {
    const item = document.createElement('div');
    item.className = 'hc-item';
    const statusClass = (p.audio ? 'mic-on' : 'mic-off') + ' ' + (p.video ? 'cam-on' : 'cam-off') + (p.screen ? ' screen-on' : '');
    item.innerHTML = `
      <div class="hc-avatar">${(p.userName || 'G')[0].toUpperCase()}</div>
      <div class="hc-name">${p.userName}</div>
      <div class="hc-status ${statusClass}">
        ${!p.audio ? '<span class="status-badge muted">🔇</span>' : ''}
        ${!p.video ? '<span class="status-badge">📷</span>' : ''}
        ${p.screen ? '<span class="status-badge">🖥</span>' : ''}
      </div>
      <div class="hc-controls">
        <button class="hc-btn" onclick="remoteAction('mute-mic', '${p.socketId}', ${!p.audio})" title="Mute/Unmute">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-1 15.93V20H9v2h6v-2h-2v-3.07A7.001 7.001 0 0119 11h-2a5 5 0 01-10 0H5a7.001 7.001 0 006 6.93z"/></svg>
        </button>
        <button class="hc-btn" onclick="remoteAction('mute-cam', '${p.socketId}', ${!p.video})" title="Disable/Enable Camera">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>
        </button>
        <button class="hc-btn danger" onclick="remoteAction('kick', '${p.socketId}')" title="Remove from meeting">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><path d="M13.7 6.7A7 7 0 005 17M21 15a9 9 0-12.8-12"/></svg>
        </button>
      </div>
    `;
    list.appendChild(item);
  });
}

function remoteAction(action, targetSocketId, state) {
  if (action === 'mute-mic') {
    socket.emit('host-mute-mic', { roomId: ROOM_ID, targetSocketId, mute: state });
  } else if (action === 'mute-cam') {
    socket.emit('host-mute-cam', { roomId: ROOM_ID, targetSocketId, mute: state });
  } else if (action === 'kick') {
    socket.emit('host-kick', { roomId: ROOM_ID, targetSocketId });
  }
}

// ── UTILITIES ─────────────────────────────────────────────────
function forceUnlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  document.getElementById('audio-banner').classList.add('hidden');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// ── DRAGGABLE PiP ─────────────────────────────────────────────
(function setupDraggablePiP() {
  const pip = screenPreview();
  const handle = document.getElementById('screen-preview-drag-handle');
  if (!handle) return;
  let isDragging = false, offsetX = 0, offsetY = 0;

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = pip.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    pip.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    pip.style.left   = (e.clientX - offsetX) + 'px';
    pip.style.top    = (e.clientY - offsetY) + 'px';
    pip.style.right  = 'auto';
    pip.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    pip.style.cursor = 'grab';
  });
})();

// ── INIT ──────────────────────────────────────────────────────
makeLocalStream().catch(() => {
  console.log('Failed to get local stream on init');
});
