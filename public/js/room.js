// ============================================================
//  MeetSpace - Room Client  (Fixed: screenshare + pip + min/max for all)
// ============================================================

const socket = io();
const peers       = {};
const peerStreams  = {};
const peerNames   = {};

let localStream     = null;
let screenStream    = null;
let isScreenSharing = false;
let screenMinimized = false;
let micEnabled  = true;
let camEnabled  = true;
let chatOpen    = false;
let unreadCount = 0;
let startTime   = Date.now();
let audioUnlocked = false;
let localMinimized = false;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

const videoGrid        = document.getElementById('video-grid');
const localVideo       = document.getElementById('local-video');
const localPlaceholder = document.getElementById('local-placeholder');
const localAvatar      = document.getElementById('local-avatar');
const localNameLabel   = document.getElementById('local-name-label');
const chatPanel        = document.getElementById('chat-panel');
const chatMessages     = document.getElementById('chat-messages');
const chatInput        = document.getElementById('chat-input');
const chatBadge        = document.getElementById('chat-badge');
const participantCount = document.getElementById('participant-count');
const screenPreview    = document.getElementById('screen-preview');
const screenPreviewVid = document.getElementById('screen-preview-video');

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

document.getElementById('display-room-id').textContent = ROOM_ID;
localNameLabel.textContent = USER_NAME + ' (You)';
localAvatar.textContent    = USER_NAME.charAt(0).toUpperCase();

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localPlaceholder.classList.add('hidden');
  } catch (err) {
    console.error('[init] getUserMedia error:', err.name, err.message);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      camEnabled = false;
      showToast('Camera unavailable — audio only');
    } catch (e2) {
      micEnabled = false; camEnabled = false;
      showToast('No camera/mic — joining as viewer');
    }
    syncBtnUI();
  }
  socket.emit('join-room', { roomId: ROOM_ID, userName: USER_NAME });
  updateGridLayout();
}

socket.on('room-users', async ({ participants }) => {
  for (const p of participants) {
    if (!peers[p.socketId]) {
      peerNames[p.socketId] = p.userName;
      await createPeer(p.socketId, true);
    }
  }
  updateParticipantCount();
});

socket.on('user-joined', ({ socketId, userName }) => {
  peerNames[socketId] = userName;
  addSystemMessage(`${userName} joined`);
  updateParticipantCount();
});

socket.on('offer', async ({ from, offer, fromName }) => {
  peerNames[from] = fromName;
  if (!peers[from]) await createPeer(from, false);
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
  removePeer(socketId);
  addSystemMessage(`${name} left`);
  delete peerNames[socketId];
  updateParticipantCount();
});

socket.on('chat-message', ({ userName, message, time, socketId: sid }) => {
  appendMessage(userName, message, time, sid === socket.id);
  if (!chatOpen) {
    unreadCount++;
    chatBadge.textContent = unreadCount;
    chatBadge.classList.remove('hidden');
  }
});

socket.on('peer-media-state', ({ socketId, video, audio, screen }) => {
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) return;
  const micIcon = tile.querySelector('.tile-icon');
  if (micIcon) micIcon.className = 'tile-icon ' + (audio ? 'mic-on' : 'mic-off');
  const ph = tile.querySelector('.no-video-placeholder');
  if (ph) ph.classList.toggle('hidden', !!(video || screen));
  let label = tile.querySelector('.screenshare-label');
  if (screen) {
    tile.classList.add('screenshare-tile');
    if (!label) {
      label = document.createElement('div');
      label.className = 'screenshare-label';
      label.textContent = '🖥 Presenting';
      tile.appendChild(label);
    }
  } else {
    tile.classList.remove('screenshare-tile');
    if (label) label.remove();
  }
});

async function createPeer(socketId, initiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[socketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // If already screen sharing, send screen track to new peer immediately
  if (isScreenSharing && screenStream) {
    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) {
      const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (videoSender) {
        videoSender.replaceTrack(screenTrack).catch(e => console.warn('[new peer screen replaceTrack]', e));
      } else {
        pc.addTrack(screenTrack, screenStream);
      }
    }
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { to: socketId, from: socket.id, candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log(`[peer ${socketId}] conn: ${pc.connectionState}`);
    if (['disconnected','failed','closed'].includes(pc.connectionState)) removePeer(socketId);
  };

  peerStreams[socketId] = new MediaStream();

  pc.ontrack = ({ track }) => {
    console.log(`[peer ${socketId}] received ${track.kind} track, id=${track.id}`);
    const stream = peerStreams[socketId];

    stream.getTracks().filter(t => t.kind === track.kind).forEach(t => stream.removeTrack(t));
    stream.addTrack(track);
    if (track.kind === 'audio') track.enabled = true;

    const tile = document.getElementById(`tile-${socketId}`);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid) {
        // KEY FIX: null then reassign forces browser to re-render with new track
        vid.srcObject = null;
        vid.srcObject = stream;
        vid.muted  = false;
        vid.volume = 1.0;
        safePlay(vid);
        if (track.kind === 'video') {
          const ph = tile.querySelector('.no-video-placeholder');
          if (ph) ph.classList.add('hidden');
        }
      }
    } else {
      addRemoteTile(socketId, stream);
    }
    updateGridLayout();
  };

  if (!document.getElementById(`tile-${socketId}`)) {
    addRemoteTile(socketId, peerStreams[socketId]);
  }

  if (initiator) {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: socketId, offer, from: socket.id, fromName: USER_NAME });
  }

  return pc;
}

function removePeer(socketId) {
  if (peers[socketId]) { peers[socketId].close(); delete peers[socketId]; }
  delete peerStreams[socketId];
  const tile = document.getElementById(`tile-${socketId}`);
  if (tile) tile.remove();
  updateGridLayout();
  updateParticipantCount();
}

function addRemoteTile(socketId, stream) {
  if (document.getElementById(`tile-${socketId}`)) return;
  const name    = peerNames[socketId] || 'Participant';
  const initial = name.charAt(0).toUpperCase();

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${socketId}`;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-controls">
      <button class="tile-action-btn tile-action-min" onclick="minimizeTile('${socketId}')" title="Minimize">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>
      </button>
      <button class="tile-action-btn tile-action-max hidden" onclick="maximizeTile('${socketId}')" title="Maximize">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
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

  const vid = tile.querySelector('video');
  vid.volume = 1.0;
  if (stream && stream.getTracks().length > 0) {
    vid.srcObject = stream;
    safePlay(vid);
    if (stream.getVideoTracks().length > 0) {
      tile.querySelector('.no-video-placeholder').classList.add('hidden');
    }
  }
  videoGrid.appendChild(tile);
  updateGridLayout();
}

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

function safePlay(videoEl) {
  videoEl.muted  = false;
  videoEl.volume = 1.0;
  const p = videoEl.play();
  if (p) p.catch(err => {
    if (err.name === 'NotAllowedError') {
      document.getElementById('audio-banner').classList.remove('hidden');
    }
  });
}

function updateGridLayout() {
  const count = videoGrid.children.length;
  videoGrid.setAttribute('data-count', Math.min(count, 6));
}

function updateParticipantCount() {
  const n = Object.keys(peers).length + 1;
  participantCount.textContent = n === 1 ? '1 participant' : `${n} participants`;
}

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
  localPlaceholder.classList.toggle('hidden', camEnabled);
  syncBtnUI();
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: isScreenSharing });
}

function syncBtnUI() {
  const mb = document.getElementById('mic-btn');
  mb.querySelector('.icon-on').classList.toggle('hidden', !micEnabled);
  mb.querySelector('.icon-off').classList.toggle('hidden', micEnabled);
  mb.classList.toggle('off', !micEnabled);
  mb.querySelector('span').textContent = micEnabled ? 'Mute' : 'Unmute';

  const cb = document.getElementById('cam-btn');
  cb.querySelector('.icon-on').classList.toggle('hidden', !camEnabled);
  cb.querySelector('.icon-off').classList.toggle('hidden', camEnabled);
  cb.classList.toggle('off', !camEnabled);
  cb.querySelector('span').textContent = camEnabled ? 'Camera' : 'Start Cam';
}
function updateButtons() { syncBtnUI(); }

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

  isScreenSharing   = true;
  screenMinimized   = false;
  const screenTrack = screenStream.getVideoTracks()[0];

  // KEY FIX: Replace video sender track per peer; null+reassign srcObject on remote forces re-render
  const replacePromises = Object.keys(peers).map(async (socketId) => {
    const pc = peers[socketId];
    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      try {
        await videoSender.replaceTrack(screenTrack);
        console.log(`[screen] replaceTrack ok -> ${socketId}`);
      } catch (e) {
        console.warn(`[screen] replaceTrack failed -> ${socketId}, addTrack fallback`, e.message);
        pc.addTrack(screenTrack, screenStream);
      }
    } else {
      pc.addTrack(screenTrack, screenStream);
    }
  });
  await Promise.allSettled(replacePromises);

  // PiP — muted so you don't hear yourself
  screenPreviewVid.srcObject = screenStream;
  screenPreviewVid.muted = true;
  screenPreviewVid.play().catch(() => {});
  screenPreview.classList.remove('hidden', 'minimized');

  // Local tile — show screen, remove mirror (mirror looks wrong for screen content)
  localVideo.srcObject = screenStream;
  localVideo.muted = true;
  localVideo.style.transform = 'none';
  localPlaceholder.classList.add('hidden');

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

  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }

  const camTrack = localStream ? localStream.getVideoTracks()[0] : null;
  Object.keys(peers).forEach(socketId => {
    const pc = peers[socketId];
    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (videoSender) {
      videoSender.replaceTrack(camTrack || null).catch(e => console.warn('[stop screen replaceTrack]', e.message));
    }
  });

  if (localStream) {
    localVideo.srcObject = localStream;
    localVideo.style.transform = ''; // restore CSS class mirror
    localPlaceholder.classList.toggle('hidden', camEnabled);
  }

  const localTile = document.getElementById('local-tile');
  localTile.classList.remove('screenshare-tile');
  const lbl = localTile.querySelector('.screenshare-label');
  if (lbl) lbl.remove();

  screenPreview.classList.add('hidden');
  screenPreviewVid.srcObject = null;

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
  screenPreview.classList.toggle('minimized', screenMinimized);
  const btn = document.getElementById('screen-preview-toggle');
  btn.title = screenMinimized ? 'Maximize' : 'Minimize';
  btn.innerHTML = screenMinimized
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;
}

function toggleChat() {
  chatOpen = !chatOpen;
  chatPanel.classList.toggle('open', chatOpen);
  document.getElementById('chat-btn').classList.toggle('active', chatOpen);
  if (chatOpen) {
    unreadCount = 0;
    chatBadge.classList.add('hidden');
    chatInput.focus();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat-message', { roomId: ROOM_ID, message: msg, userName: USER_NAME });
  chatInput.value = '';
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
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

function forceUnlockAudio() {
  document.querySelectorAll('.video-tile:not(.local-tile) video').forEach(v => {
    v.muted = false; v.volume = 1.0; v.play().catch(() => {});
  });
  document.getElementById('audio-banner').classList.add('hidden');
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

setInterval(() => {
  const s  = Math.floor((Date.now() - startTime) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2,'0');
  const ss = String(s % 60).padStart(2,'0');
  document.getElementById('meeting-time').textContent = `${mm}:${ss}`;
}, 1000);

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
