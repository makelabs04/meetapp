// ============================================================
//  MeetSpace - Room Client
// ============================================================

const socket = io();
const peers = {}; // socketId -> RTCPeerConnection
const peerStreams = {}; // socketId -> MediaStream (merged audio+video)
const peerNames = {}; // socketId -> userName

let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let micEnabled = true;
let camEnabled = true;
let chatOpen = false;
let unreadCount = 0;
let startTime = Date.now();
let audioUnlocked = false;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

// ── Unlock audio on first user interaction (browser autoplay policy) ──
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  // Force-play all remote videos to unblock autoplay
  document.querySelectorAll('.video-tile:not(.local-tile) video').forEach(v => {
    if (v.srcObject) v.play().catch(() => {});
  });
}
document.addEventListener('click', unlockAudio, { once: false });
document.addEventListener('keydown', unlockAudio, { once: false });

// ── DOM helpers ─────────────────────────────────────────────
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');
const localPlaceholder = document.getElementById('local-placeholder');
const localAvatar = document.getElementById('local-avatar');
const localNameLabel = document.getElementById('local-name-label');
const chatPanel = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatBadge = document.getElementById('chat-badge');
const participantCount = document.getElementById('participant-count');

// ── Init ─────────────────────────────────────────────────────
document.getElementById('display-room-id').textContent = ROOM_ID;
localNameLabel.textContent = USER_NAME + ' (You)';
localAvatar.textContent = USER_NAME.charAt(0).toUpperCase();

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    showVideo(localPlaceholder, localVideo, true);
  } catch (err) {
    console.warn('No camera/mic:', err);
    micEnabled = false;
    camEnabled = false;
    updateButtons();
    showVideo(localPlaceholder, localVideo, false);
    showToast('Camera/mic unavailable — joining without media');
  }

  socket.emit('join-room', { roomId: ROOM_ID, userName: USER_NAME });
  updateGridLayout();
}

// ── Socket Events ────────────────────────────────────────────
socket.on('room-users', async ({ participants }) => {
  for (const p of participants) {
    if (!peers[p.socketId]) {
      peerNames[p.socketId] = p.userName;
      await createPeer(p.socketId, true);
    }
  }
  updateParticipantCount();
});

socket.on('user-joined', async ({ socketId, userName }) => {
  peerNames[socketId] = userName;
  addSystemMessage(`${userName} joined`);
  updateParticipantCount();
});

socket.on('offer', async ({ from, offer, fromName }) => {
  peerNames[from] = fromName;
  if (!peers[from]) await createPeer(from, false);
  await peers[from].setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peers[from].createAnswer();
  await peers[from].setLocalDescription(answer);
  socket.emit('answer', { to: from, from: socket.id, answer });
});

socket.on('answer', async ({ from, answer }) => {
  if (peers[from]) {
    await peers[from].setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('ice-candidate', async ({ from, candidate }) => {
  if (peers[from] && candidate) {
    try { await peers[from].addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('ICE error:', e); }
  }
});

socket.on('user-left', ({ socketId, userName }) => {
  removePeer(socketId);
  addSystemMessage(`${peerNames[socketId] || userName} left`);
  delete peerNames[socketId];
  updateParticipantCount();
});

socket.on('chat-message', ({ userName, message, time, socketId }) => {
  appendMessage(userName, message, time, socketId === socket.id);
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
  if (micIcon) {
    micIcon.className = 'tile-icon ' + (audio ? 'mic-on' : 'mic-off');
  }
  const ph = tile.querySelector('.no-video-placeholder');
  const vid = tile.querySelector('video');
  if (ph && vid) showVideo(ph, vid, video || screen);

  // Show/hide screenshare label on remote tile
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

// ── WebRTC Peer ──────────────────────────────────────────────
async function createPeer(socketId, initiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[socketId] = pc;

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // ICE candidates
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ice-candidate', { to: socketId, from: socket.id, candidate });
    }
  };

  // Remote stream — ontrack fires once per track (audio + video separately)
  // We collect into a single MediaStream per peer
  pc.ontrack = ({ track, streams }) => {
    console.log(`[${socketId}] Got ${track.kind} track, streams:`, streams.length);

    // Use the provided stream if available, otherwise build one
    let stream = streams[0];
    if (!stream) {
      if (!peerStreams[socketId]) peerStreams[socketId] = new MediaStream();
      peerStreams[socketId].addTrack(track);
      stream = peerStreams[socketId];
    } else {
      peerStreams[socketId] = stream;
    }

    const tile = document.getElementById(`tile-${socketId}`);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid && vid.srcObject !== stream) {
        vid.srcObject = stream;
        // Force play — critical for audio autoplay
        safePlay(vid);
      }
    } else {
      addRemoteTile(socketId, stream);
    }

    // When audio track arrives, ensure it's not muted
    if (track.kind === 'audio') {
      track.enabled = true;
      console.log(`[${socketId}] Audio track arrived, enabled:`, track.enabled);
    }

    updateGridLayout();
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      removePeer(socketId);
    }
  };

  // Add tile immediately
  if (!document.getElementById(`tile-${socketId}`)) {
    addRemoteTile(socketId, null);
  }

  // Create offer if initiator
  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: socketId, offer, from: socket.id, fromName: USER_NAME });
  }

  return pc;
}

function removePeer(socketId) {
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  delete peerStreams[socketId];
  const tile = document.getElementById(`tile-${socketId}`);
  if (tile) tile.remove();
  updateGridLayout();
  updateParticipantCount();
}

// ── Video Tiles ──────────────────────────────────────────────
function addRemoteTile(socketId, stream) {
  const name = peerNames[socketId] || 'Participant';
  const initial = name.charAt(0).toUpperCase();

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${socketId}`;
  // IMPORTANT: remote video must NOT be muted — no `muted` attribute!
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-info">
      <div class="tile-name">${escapeHtml(name)}</div>
      <div class="tile-icons">
        <span class="tile-icon mic-on">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-1 15.93V20H9v2h6v-2h-2v-3.07A7.001 7.001 0 0019 11h-2a5 5 0 01-10 0H5a7.001 7.001 0 006 6.93z"/></svg>
        </span>
      </div>
    </div>
    <div class="no-video-placeholder">
      <div class="avatar-circle">${initial}</div>
    </div>
  `;

  const vid = tile.querySelector('video');
  vid.volume = 1.0;  // Ensure full volume

  if (stream) {
    vid.srcObject = stream;
    safePlay(vid);
    tile.querySelector('.no-video-placeholder').classList.add('hidden');
  }

  videoGrid.appendChild(tile);
  updateGridLayout();
}

function showVideo(placeholder, video, show) {
  if (show) { placeholder.classList.add('hidden'); }
  else { placeholder.classList.remove('hidden'); }
}

function updateGridLayout() {
  const count = videoGrid.children.length;
  videoGrid.setAttribute('data-count', Math.min(count, 6));
  const countLabel = count === 1 ? '1 participant' : `${count} participants`;
  participantCount.textContent = countLabel;
}

function updateParticipantCount() {
  const count = Object.keys(peers).length + 1;
  participantCount.textContent = count === 1 ? '1 participant' : `${count} participants`;
}

// ── Media Controls ───────────────────────────────────────────
function toggleMic() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);

  const btn = document.getElementById('mic-btn');
  btn.querySelector('.icon-on').classList.toggle('hidden', !micEnabled);
  btn.querySelector('.icon-off').classList.toggle('hidden', micEnabled);
  btn.classList.toggle('off', !micEnabled);
  btn.querySelector('span').textContent = micEnabled ? 'Mute' : 'Unmute';

  const micIcon = document.getElementById('local-mic-icon');
  micIcon.className = 'tile-icon ' + (micEnabled ? 'mic-on' : 'mic-off');

  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled });
}

function toggleCamera() {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);

  const btn = document.getElementById('cam-btn');
  btn.querySelector('.icon-on').classList.toggle('hidden', !camEnabled);
  btn.querySelector('.icon-off').classList.toggle('hidden', camEnabled);
  btn.classList.toggle('off', !camEnabled);
  btn.querySelector('span').textContent = camEnabled ? 'Camera' : 'Start Cam';

  showVideo(localPlaceholder, localVideo, camEnabled);
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled });
}

function updateButtons() {
  if (!micEnabled) toggleMic();
  if (!camEnabled) toggleCamera();
}

// ── Screen Share ──────────────────────────────────────────────
async function toggleScreenShare() {
  if (isScreenSharing) {
    stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: 30 },
      audio: false  // system audio optional; keep false for simplicity
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      showToast('Screen share failed: ' + err.message);
    }
    return;
  }

  isScreenSharing = true;
  const screenTrack = screenStream.getVideoTracks()[0];

  // Replace the video track in ALL peer connections
  for (const socketId of Object.keys(peers)) {
    const pc = peers[socketId];
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      await sender.replaceTrack(screenTrack);
    }
  }

  // Show screen in local tile
  const localTileVideo = document.getElementById('local-video');
  localTileVideo.srcObject = screenStream;
  showVideo(localPlaceholder, localTileVideo, true);

  // Show local screen label
  const localTile = document.getElementById('local-tile');
  localTile.classList.add('screenshare-tile');
  if (!localTile.querySelector('.screenshare-label')) {
    const lbl = document.createElement('div');
    lbl.className = 'screenshare-label';
    lbl.textContent = '🖥 You are presenting';
    localTile.appendChild(lbl);
  }

  // Update button UI
  const btn = document.getElementById('screen-btn');
  btn.classList.add('active');
  btn.querySelector('.icon-on').classList.add('hidden');
  btn.querySelector('.icon-off').classList.remove('hidden');
  btn.querySelector('span').textContent = 'Stop';
  document.getElementById('screen-banner').classList.remove('hidden');

  // Notify peers
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: true });

  // Handle when user stops via browser's native "Stop sharing" button
  screenTrack.onended = () => stopScreenShare();
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  isScreenSharing = false;

  // Stop all screen tracks
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  // Restore camera track in all peer connections
  const cameraTrack = localStream ? localStream.getVideoTracks()[0] : null;
  for (const socketId of Object.keys(peers)) {
    const pc = peers[socketId];
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender && cameraTrack) {
      sender.replaceTrack(cameraTrack).catch(e => console.warn('replaceTrack error:', e));
    }
  }

  // Restore local video
  const localTileVideo = document.getElementById('local-video');
  if (localStream) {
    localTileVideo.srcObject = localStream;
    showVideo(localPlaceholder, localTileVideo, camEnabled);
  }

  // Remove local screen label
  const localTile = document.getElementById('local-tile');
  localTile.classList.remove('screenshare-tile');
  const lbl = localTile.querySelector('.screenshare-label');
  if (lbl) lbl.remove();

  // Reset button UI
  const btn = document.getElementById('screen-btn');
  btn.classList.remove('active');
  btn.querySelector('.icon-on').classList.remove('hidden');
  btn.querySelector('.icon-off').classList.add('hidden');
  btn.querySelector('span').textContent = 'Share';
  document.getElementById('screen-banner').classList.add('hidden');

  // Notify peers
  socket.emit('media-state', { roomId: ROOM_ID, video: camEnabled, audio: micEnabled, screen: false });
  showToast('Screen sharing stopped');
}

// ── Chat ─────────────────────────────────────────────────────
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
    <div class="chat-msg-body">${escapeHtml(message)}</div>
  `;
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

// ── Force Audio Unlock (called from banner button) ────────────
function forceUnlockAudio() {
  document.querySelectorAll('.video-tile:not(.local-tile) video').forEach(v => {
    v.muted = false;
    v.volume = 1.0;
    v.play().catch(e => console.warn('play error:', e));
  });
  document.getElementById('audio-banner').classList.add('hidden');
  showToast('Audio enabled!');
  audioUnlocked = true;
}

// ── Safe play helper — shows banner if autoplay blocked ───────
function safePlay(videoEl) {
  videoEl.muted = false;
  videoEl.volume = 1.0;
  const p = videoEl.play();
  if (p !== undefined) {
    p.catch(err => {
      if (err.name === 'NotAllowedError') {
        // Autoplay blocked — show the unlock banner
        document.getElementById('audio-banner').classList.remove('hidden');
        console.warn('Autoplay blocked — showing unlock banner');
      }
    });
  }
}


function leaveRoom() {
  if (isScreenSharing && screenStream) screenStream.getTracks().forEach(t => t.stop());
  Object.keys(peers).forEach(id => peers[id].close());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  socket.disconnect();
  window.location.href = '/';
}

// ── Share / Copy ──────────────────────────────────────────────
function copyRoomId() {
  navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Meeting ID copied!'));
}

function copyLink() {
  navigator.clipboard.writeText(window.location.href).then(() => showToast('Meeting link copied!'));
}

// ── Timer ─────────────────────────────────────────────────────
setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const s = (elapsed % 60).toString().padStart(2, '0');
  document.getElementById('meeting-time').textContent = `${m}:${s}`;
}, 1000);

// ── Toast ─────────────────────────────────────────────────────
let toastTimeout;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Utils ─────────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Start ─────────────────────────────────────────────────────
init();
