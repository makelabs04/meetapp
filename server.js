const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory room store
const rooms = {};

// Routes
app.get('/', (req, res) => res.render('index'));

app.get('/room/:roomId', (req, res) => {
  res.render('room', { roomId: req.params.roomId });
});

app.post('/create-room', (req, res) => {
  const roomId = uuidv4().substring(0, 8);
  rooms[roomId] = { participants: [], host: null, createdAt: Date.now() };
  res.json({ roomId });
});

app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (room) {
    res.json({ exists: true, participants: room.participants.length });
  } else {
    res.json({ exists: false });
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, userName }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { participants: [], host: null, createdAt: Date.now() };
    }

    const room = rooms[roomId];

    // First person to join becomes the host
    const isHost = room.participants.length === 0;
    if (isHost) {
      room.host = socket.id;
    }

    if (!room.participants.find(p => p.socketId === socket.id)) {
      room.participants.push({ socketId: socket.id, userName, isHost, video: true, audio: true });
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userName,
      participants: room.participants
    });

    socket.emit('room-users', {
      participants: room.participants.filter(p => p.socketId !== socket.id),
      hostSocketId: room.host,
      isHost
    });

    console.log(`${userName} joined room ${roomId}. Host: ${room.host}. Participants: ${room.participants.length}`);
  });

  // WebRTC signaling relay
  socket.on('offer', ({ to, offer, from, fromName }) => {
    io.to(to).emit('offer', { from, offer, fromName });
  });

  socket.on('answer', ({ to, answer, from }) => {
    io.to(to).emit('answer', { from, answer });
  });

  socket.on('ice-candidate', ({ to, candidate, from }) => {
    io.to(to).emit('ice-candidate', { from, candidate });
  });

  // Chat
  socket.on('chat-message', ({ roomId, message, userName }) => {
    io.in(roomId).emit('chat-message', {
      userName,
      message,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      socketId: socket.id
    });
  });

  // Media state updates
  socket.on('media-state', ({ roomId, video, audio, screen }) => {
    socket.to(roomId).emit('peer-media-state', {
      socketId: socket.id,
      video,
      audio,
      screen
    });

    // Update participant media state in room store
    const room = rooms[roomId];
    if (room) {
      const p = room.participants.find(p => p.socketId === socket.id);
      if (p) { p.video = video; p.audio = audio; p.screen = screen; }
      // Notify host of updated states
      if (room.host) {
        io.to(room.host).emit('participants-updated', { participants: room.participants });
      }
    }
  });

  // ── HOST CONTROLS ──────────────────────────────────────────
  socket.on('host-mute-mic', ({ roomId, targetSocketId, mute }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit('remote-mute-mic', { mute, byHost: true });
  });

  socket.on('host-mute-cam', ({ roomId, targetSocketId, mute }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit('remote-mute-cam', { mute, byHost: true });
  });

  socket.on('host-kick', ({ roomId, targetSocketId }) => {
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    io.to(targetSocketId).emit('kicked-from-room', {});
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const wasHost = rooms[roomId].host === socket.id;
      rooms[roomId].participants = rooms[roomId].participants.filter(
        p => p.socketId !== socket.id
      );
      socket.to(roomId).emit('user-left', { socketId: socket.id, userName: socket.userName });

      if (wasHost && rooms[roomId].participants.length > 0) {
        const newHost = rooms[roomId].participants[0];
        rooms[roomId].host = newHost.socketId;
        newHost.isHost = true;
        io.to(newHost.socketId).emit('you-are-now-host', {});
        socket.to(roomId).emit('host-changed', { hostSocketId: newHost.socketId });
      }

      if (rooms[roomId].participants.length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (empty)`);
      }
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(roomId => {
    if (rooms[roomId].participants.length === 0 && now - rooms[roomId].createdAt > 1800000) {
      delete rooms[roomId];
    }
  });
}, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MeetApp running on port ${PORT}`);
});
