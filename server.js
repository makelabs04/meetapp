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
  rooms[roomId] = { participants: [], createdAt: Date.now() };
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

// Socket.io signaling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', ({ roomId, userName }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { participants: [], createdAt: Date.now() };
    }

    const room = rooms[roomId];

    // Check if already in room
    if (!room.participants.find(p => p.socketId === socket.id)) {
      room.participants.push({ socketId: socket.id, userName });
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    // Tell existing users about new peer
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      userName,
      participants: room.participants
    });

    // Send existing participants to new user
    socket.emit('room-users', {
      participants: room.participants.filter(p => p.socketId !== socket.id)
    });

    console.log(`${userName} joined room ${roomId}. Participants: ${room.participants.length}`);
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
  socket.on('media-state', ({ roomId, video, audio }) => {
    socket.to(roomId).emit('peer-media-state', {
      socketId: socket.id,
      video,
      audio
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].participants = rooms[roomId].participants.filter(
        p => p.socketId !== socket.id
      );
      socket.to(roomId).emit('user-left', { socketId: socket.id, userName: socket.userName });

      if (rooms[roomId].participants.length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (empty)`);
      }
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Clean up old empty rooms every 30 minutes
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
