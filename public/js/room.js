// ============================================================
//  MeetSpace - Room Client
// ============================================================

const socket = io();
const peers = {}; // socketId -> RTCPeerConnection
const peerStreams = {}; // socketId -> MediaStream
const peerNames = {}; // socketId -> userName

let localStream = null;
let micEnabled = true;
let camEnabled = true;
let chatOpen = false;
let unreadCount = 0;
let startTime = Date.now();

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

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

socket.on('peer-media-state', ({ socketId, video, audio }) => {
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) return;
  const micIcon = tile.querySelector('.tile-icon');
  if (micIcon) {
    micIcon.className = 'tile-icon ' + (audio ? 'mic-on' : 'mic-off');
  }
  const ph = tile.querySelector('.no-video-placeholder');
  const vid = tile.querySelector('video');
  if (ph && vid) showVideo(ph, vid, video);
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

  // Remote stream
  pc.ontrack = ({ streams }) => {
    peerStreams[socketId] = streams[0];
    const tile = document.getElementById(`tile-${socketId}`);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = streams[0];
    } else {
      addRemoteTile(socketId, streams[0]);
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
  if (stream) {
    vid.srcObject = stream;
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

// ── Leave ─────────────────────────────────────────────────────
function leaveRoom() {
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
