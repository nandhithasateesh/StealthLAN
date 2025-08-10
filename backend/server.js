const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Serve frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// Room management
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`New client connected: ${socket.id}`);

  socket.on('join-room', ({ room }) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined room: ${room}`);

    // Initialize room if not exists
    if (!rooms.has(room)) {
      rooms.set(room, new Set());
    }
    rooms.get(room).add(socket.id);

    // Notify other peers
    socket.to(room).emit('peer-joined', { peerId: socket.id });
  });

  socket.on('signal', ({ room, to, data }) => {
    console.log(`Signal from ${socket.id} to ${to} in room ${room}`);
    socket.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Clean up room references
    rooms.forEach((clients, room) => {
      if (clients.has(socket.id)) {
        clients.delete(socket.id);
        if (clients.size === 0) {
          rooms.delete(room);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});