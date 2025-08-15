// backend/server.js
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());

// Serve your frontend (adjust this path if needed)
app.use(express.static(path.join(__dirname, '../frontend')));

// Simple health check
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

/**
 * rooms: Map<roomId, Map<socketId, { name: string }>>
 */
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`⚡ client connected: ${socket.id}`);
  socket.data.room = null;
  socket.data.name = null;

  // Join a room with a display name
  socket.on('join-room', ({ room, name }) => {
    if (!room || !name) return;

    // leave previous room if any
    if (socket.data.room) {
      leaveCurrentRoom(socket);
    }

    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    if (!rooms.has(room)) rooms.set(room, new Map());
    const members = rooms.get(room);
    members.set(socket.id, { name });

    // Send existing peers to the newcomer (excluding themselves)
    const peers = Array.from(members.entries())
      .filter(([id]) => id !== socket.id)
      .map(([peerId, meta]) => ({ peerId, name: meta.name }));

    socket.emit('peers', { peers });

    // Notify others that this peer joined
    socket.to(room).emit('peer-joined', { peerId: socket.id, name });

    console.log(`➡️  ${socket.id} (${name}) joined room "${room}"`);
  });

  // Targeted signaling (offer/answer/candidates)
  socket.on('signal', ({ room, to, data }) => {
    if (!room || !to || !data) return;
    // only relay if sender is actually in that room
    if (socket.data.room !== room) return;

    io.to(to).emit('signal', {
      from: socket.id,
      data
    });
    // Optional debug:
    // console.log(`🔁 signal ${data.type || 'candidate'}: ${socket.id} -> ${to} @ ${room}`);
  });

  // Explicit leave (button)
  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    leaveCurrentRoom(socket, { disconnecting: true });
    console.log(`💨 client disconnected: ${socket.id}`);
  });
});

/** Helpers */
function leaveCurrentRoom(socket, { disconnecting = false } = {}) {
  const room = socket.data.room;
  const name = socket.data.name || 'Unknown';
  if (!room) return;

  const members = rooms.get(room);
  if (members) {
    members.delete(socket.id);
    if (members.size === 0) rooms.delete(room);
  }

  socket.leave(room);
  socket.data.room = null;

  // Tell others this peer left
  socket.to(room).emit('peer-left', { peerId: socket.id, name });
  console.log(`⬅️  ${socket.id} (${name}) left room "${room}"${disconnecting ? ' (disconnect)' : ''}`);
}

const PORT = process.env.PORT || 5001;
// Bind to 0.0.0.0 so phones on the same Wi-Fi can reach it via your LAN IP
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Tip: open http://<your-LAN-IP>:${PORT} on your phone (same Wi-Fi).`);
});