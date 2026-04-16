const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory room store
// rooms[roomId] = { participants:[], host:null, originalHostName:null, createdAt, waiting:[] }
// waiting entry: { socketId, userName, resolve }
const rooms = {};

app.get('/',                (req, res) => res.render('index'));
app.get('/room/:roomId',    (req, res) => res.render('room', { roomId: req.params.roomId }));

app.post('/create-room', (req, res) => {
  const roomId = uuidv4().substring(0, 8);
  rooms[roomId] = { participants: [], host: null, originalHostName: null, createdAt: Date.now(), waiting: [], admittedNames: new Set() };
  res.json({ roomId });
});

app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  res.json(room ? { exists: true, participants: room.participants.length } : { exists: false });
});

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // ── JOIN ────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, userName }) => {
    // Create room if it doesn't exist (e.g. host joined via link)
    if (!rooms[roomId]) {
      rooms[roomId] = { participants: [], host: null, originalHostName: null, createdAt: Date.now(), waiting: [], admittedNames: new Set() };
    }

    const room = rooms[roomId];
    const isFirstPerson = room.participants.length === 0;

    // If this is the original host rejoining (same name, room still exists), restore host role
    const isOriginalHostRejoining = !isFirstPerson && room.originalHostName && room.originalHostName === userName;

    if (isFirstPerson || isOriginalHostRejoining) {
      // First person or original host returning: becomes host immediately, no waiting
      room.host = socket.id;
      if (!room.originalHostName) room.originalHostName = userName;
      _admitParticipant(socket, roomId, userName, true, room);

      // If original host reclaimed, notify everyone else
      if (isOriginalHostRejoining) {
        socket.to(roomId).emit('host-changed', { hostSocketId: socket.id });
      }
    } else if (room.admittedNames && room.admittedNames.has(userName)) {
      // Previously admitted user rejoining — skip the waiting room, admit directly
      _admitParticipant(socket, roomId, userName, false, room);
    } else {
      // Others: go to waiting room — host must admit them
      room.waiting.push({ socketId: socket.id, userName });
      socket.join(roomId);          // join room so we can receive messages
      socket.roomId  = roomId;
      socket.userName = userName;

      // Tell this socket they are waiting
      socket.emit('waiting-for-admission', { roomId });

      // Tell the host someone is waiting
      io.to(room.host).emit('admission-request', {
        socketId: socket.id,
        userName
      });

      console.log(`${userName} is waiting in room ${roomId}`);
    }
  });

  // ── HOST ADMITS / DENIES ────────────────────────────────────
  socket.on('admit-participant', ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;

    const waiter = room.waiting.find(w => w.socketId === targetSocketId);
    if (!waiter) return;

    room.waiting = room.waiting.filter(w => w.socketId !== targetSocketId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;

    _admitParticipant(targetSocket, roomId, waiter.userName, false, room);
  });

  socket.on('deny-participant', ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;

    room.waiting = room.waiting.filter(w => w.socketId !== targetSocketId);
    io.to(targetSocketId).emit('admission-denied', {});
    console.log(`${targetSocketId} denied entry to ${roomId}`);
  });

  // ── SIGNALING ───────────────────────────────────────────────
  socket.on('offer',         ({ to, offer,      from, fromName }) => io.to(to).emit('offer',         { from, offer, fromName }));
  socket.on('answer',        ({ to, answer,     from })           => io.to(to).emit('answer',        { from, answer }));
  socket.on('ice-candidate', ({ to, candidate,  from })           => io.to(to).emit('ice-candidate', { from, candidate }));

  // Relay screen share notifications so receivers know to re-bind their video element
  socket.on('screen-share-started', ({ roomId }) => {
    socket.to(roomId).emit('peer-screen-share-started', { socketId: socket.id });
  });
  socket.on('screen-share-stopped', ({ roomId }) => {
    socket.to(roomId).emit('peer-screen-share-stopped', { socketId: socket.id });
  });

  // ── CHAT ────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message, userName }) => {
    io.in(roomId).emit('chat-message', {
      userName, message,
      socketId: socket.id
    });
  });

  // ── MEDIA STATE ─────────────────────────────────────────────
  socket.on('media-state', ({ roomId, video, audio, screen }) => {
    socket.to(roomId).emit('peer-media-state', { socketId: socket.id, video, audio, screen });

    const room = rooms[roomId];
    if (room) {
      const p = room.participants.find(p => p.socketId === socket.id);
      if (p) { p.video = video; p.audio = audio; p.screen = screen; }
      if (room.host) io.to(room.host).emit('participants-updated', { participants: room.participants });
    }
  });

  // ── HOST CONTROLS ───────────────────────────────────────────
  socket.on('host-mute-mic', ({ roomId, targetSocketId, mute }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit('remote-mute-mic', { mute });
  });

  socket.on('host-mute-cam', ({ roomId, targetSocketId, mute }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit('remote-mute-cam', { mute });
  });

  socket.on('host-kick', ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit('kicked-from-room', {});
    // Clean up their participant entry
    if (room) room.participants = room.participants.filter(p => p.socketId !== targetSocketId);
  });

  // ── DISCONNECT ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) {
      console.log(`Disconnected (no room): ${socket.id}`);
      return;
    }

    const room = rooms[roomId];

    // Remove from waiting list if they disconnect while waiting
    room.waiting = room.waiting.filter(w => w.socketId !== socket.id);

    const wasInRoom  = room.participants.some(p => p.socketId === socket.id);
    const wasHost    = room.host === socket.id;

    room.participants = room.participants.filter(p => p.socketId !== socket.id);

    if (wasInRoom) {
      // Broadcast user-left ONLY if they were actually admitted
      socket.to(roomId).emit('user-left', { socketId: socket.id, userName: socket.userName });
    }

    if (wasHost && room.participants.length > 0) {
      // Host left — do NOT auto-transfer. Notify others that host is gone.
      // The original host will reclaim host role when they rejoin.
      room.host = null;
      socket.to(roomId).emit('host-left', {});
      console.log(`Host left room ${roomId}. Waiting for original host (${room.originalHostName}) to rejoin.`);

      // Deny all waiting participants since there's no host to admit them
      room.waiting.forEach(w => {
        io.to(w.socketId).emit('admission-denied', {});
      });
      room.waiting = [];
    }

    if (room.participants.length === 0 && room.waiting.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (empty)`);
    }

    console.log(`Disconnected: ${socket.id} from ${roomId}`);
  });
});

// ── Helper: fully admit a participant ───────────────────────
function _admitParticipant(socket, roomId, userName, isHost, room) {
  // Prevent duplicate entries (e.g. fast rejoin)
  if (!room.participants.find(p => p.socketId === socket.id)) {
    room.participants.push({ socketId: socket.id, userName, isHost, video: true, audio: true });
  }

  // Remember this name was admitted so they can rejoin without waiting
  if (!room.admittedNames) room.admittedNames = new Set();
  room.admittedNames.add(userName);

  socket.join(roomId);
  socket.roomId   = roomId;
  socket.userName = userName;

  // Tell existing participants about the new joiner
  socket.to(roomId).emit('user-joined', {
    socketId: socket.id,
    userName,
    participants: room.participants
  });

  // Tell the joiner about existing participants
  socket.emit('room-users', {
    participants: room.participants.filter(p => p.socketId !== socket.id),
    hostSocketId: room.host,
    isHost
  });

  console.log(`${userName} admitted to ${roomId}. Host: ${room.host}. Total: ${room.participants.length}`);
}

// Clean up stale empty rooms every 30 min
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(roomId => {
    if (rooms[roomId].participants.length === 0 && now - rooms[roomId].createdAt > 1800000) {
      delete rooms[roomId];
    }
  });
}, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MeetApp running on port ${PORT}`));
