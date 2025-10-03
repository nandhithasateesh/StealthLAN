// frontend/script.js

if (!window.crypto || !window.crypto.subtle) {
  alert("Web Cryptography API not supported. Use the latest Chrome/Edge/Firefox. If using http://LAN-IP, add it to chrome://flags/#unsafely-treat-insecure-origin-as-secure for testing.");
  throw new Error("Web Cryptography API not available");
}

const socket = io(window.location.origin, { transports: ['websocket', 'polling'] });

let room = '';
let displayName = '';
let roomName = '';
let passphrase = '';
let encryptionKey;
let myPeerId = '';
let myIsHost = false;
const peerConnections = new Map();
const dataChannels = new Map();
const peerNames = new Map();
const users = new Map();
const pendingConnections = new Set();

const PBKDF2_ITERATIONS = 50000;
const SALT = new TextEncoder().encode('stealthlan-salt');
const CHUNK_SIZE = 16 * 1024;
const incomingFiles = new Map();

const els = {
  joinScreen: document.getElementById('joinScreen'),
  app: document.getElementById('app'),
  statusText: document.getElementById('statusText'),
  roomInput: document.getElementById('roomInput'),
  roomNameInput: document.getElementById('roomNameInput'),
  nameInput: document.getElementById('nameInput'),
  passInput: document.getElementById('passInput'),
  createBtn: document.getElementById('createBtn'),
  joinBtn: document.getElementById('joinBtn'),
  leaveBtn: document.getElementById('leaveBtn'),
  messages: document.getElementById('messages'),
  textInput: document.getElementById('textInput'),
  sendText: document.getElementById('sendText'),
  fileInput: document.getElementById('fileInput'),
  sendFile: document.getElementById('sendFile'),
  statusDot: document.querySelector('.dot'),
  roomNameDisplay: document.getElementById('roomNameDisplay'),
  userListUl: document.getElementById('userListUl'),
  typingIndicator: document.getElementById('typingIndicator'),
  typingText: document.getElementById('typingText'),
  // Navigation elements
  dashboardBtn: document.getElementById('dashboardBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  helpBtn: document.getElementById('helpBtn'),
  dashboardOverlay: document.getElementById('dashboardOverlay'),
  dashboardClose: document.getElementById('dashboardClose'),
  settingsOverlay: document.getElementById('settingsOverlay'),
  settingsClose: document.getElementById('settingsClose'),
  helpOverlay: document.getElementById('helpOverlay'),
  helpClose: document.getElementById('helpClose'),
  // Dashboard elements
  connectedPeers: document.getElementById('connectedPeers'),
  messagesCount: document.getElementById('messagesCount'),
  filesShared: document.getElementById('filesShared'),
  connectionDot: document.getElementById('connectionDot'),
  connectionStatus: document.getElementById('connectionStatus'),
  roomInfoSection: document.getElementById('roomInfoSection'),
  currentRoomId: document.getElementById('currentRoomId'),
  currentRoomName: document.getElementById('currentRoomName'),
  currentUserName: document.getElementById('currentUserName'),
  // Settings elements
  darkModeToggle: document.getElementById('darkModeToggle'),
  soundNotifications: document.getElementById('soundNotifications'),
  showTypingIndicator: document.getElementById('showTypingIndicator'),
  autoReconnect: document.getElementById('autoReconnect'),
  resetSettings: document.getElementById('resetSettings'),
  exportSettings: document.getElementById('exportSettings')
};

// Dashboard stats
let stats = {
  messagesCount: 0,
  filesShared: 0
};

// Settings state
let appSettings = {
  darkMode: true,
  soundNotifications: true,
  showTypingIndicator: true,
  autoReconnect: true
};

// Typing indicator state
let typingUsers = new Set();
let typingTimeout = null;
let isTyping = false;

// Global audio context for better performance and sync
let globalAudioContext = null;

// Initialize audio context on first user interaction
function initializeAudioContext() {
  if (!globalAudioContext) {
    try {
      globalAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // Resume context if it's suspended (browser policy)
      if (globalAudioContext.state === 'suspended') {
        globalAudioContext.resume();
      }
    } catch (e) {
      console.log('Audio context initialization failed');
    }
  }
  return globalAudioContext;
}

// Sound notification function
function playNotificationSound() {
  if (!appSettings.soundNotifications) return;
  
  try {
    // Use global audio context for better sync
    const audioContext = initializeAudioContext();
    if (!audioContext || audioContext.state === 'closed') return;
    
    // Resume if suspended
    if (audioContext.state === 'suspended') {
      audioContext.resume().then(() => {
        playActualSound(audioContext);
      });
    } else {
      playActualSound(audioContext);
    }
    
  } catch (e) {
    console.log('Sound notification not available');
  }
}

// Separate function for actual sound generation
function playActualSound(audioContext) {
  try {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Create a pleasant notification sound
    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.frequency.linearRampToValueAtTime(600, audioContext.currentTime + 0.1);
    
    // Set volume and fade out - more aggressive initial volume for better sync
    gainNode.gain.setValueAtTime(0.2, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);
    
    // Start and stop the oscillator
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.15);
    
  } catch (e) {
    console.log('Sound generation failed');
  }
}
// Typing indicator functions
async function sendTypingIndicator(isTypingNow) {
  if (!appSettings.showTypingIndicator) return;
  
  const message = {
    kind: 'typing',
    isTyping: isTypingNow,
    userId: myPeerId,
    userName: displayName
  };
  
  try {
    // Use existing encryption method like other messages
    const payload = await encryptPayload(message);
    
    // Send to all connected peers
    for (const [peerId, channel] of dataChannels) {
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify(payload));
        } catch (e) {
          console.log('Failed to send typing indicator to', peerId);
        }
      }
    }
  } catch (e) {
    console.log('Failed to encrypt typing indicator:', e);
  }
}

function handleTypingIndicator(peerId, userName, isTypingNow) {
  if (!appSettings.showTypingIndicator) return;
  
  if (isTypingNow) {
    typingUsers.add(`${userName}`);
  } else {
    typingUsers.delete(`${userName}`);
  }
  
  updateTypingDisplay();
}

function updateTypingDisplay() {
  if (typingUsers.size === 0) {
    els.typingIndicator.classList.remove('active');
    return;
  }
  
  const typingArray = Array.from(typingUsers);
  let text;
  
  if (typingArray.length === 1) {
    text = `${typingArray[0]} is typing`;
  } else if (typingArray.length === 2) {
    text = `${typingArray[0]} and ${typingArray[1]} are typing`;
  } else {
    text = `${typingArray.length} people are typing`;
  }
  
  els.typingText.textContent = text;
  els.typingIndicator.classList.add('active');
}

function startTyping() {
  if (!isTyping) {
    isTyping = true;
    sendTypingIndicator(true);
  }
  
  // Clear existing timeout
  if (typingTimeout) {
    clearTimeout(typingTimeout);
  }
  
  // Stop typing after 2 seconds of inactivity
  typingTimeout = setTimeout(() => {
    stopTyping();
  }, 2000);
}

function stopTyping() {
  if (isTyping) {
    isTyping = false;
    sendTypingIndicator(false);
  }
  
  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }
}

async function deriveKey(pass) {
  const enc = new TextEncoder();
  const passKey = await crypto.subtle.importKey(
    'raw', enc.encode(pass),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    passKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function getPassphraseHash(pass) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pass));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function toBinaryString(bytes) {
  return String.fromCharCode(...bytes);
}

function toUint8Array(base64) {
  const binStr = atob(base64);
  const len = binStr.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    arr[i] = binStr.charCodeAt(i);
  }
  return arr;
}

async function encryptPayload(payloadObj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, bytes);
  return { iv: btoa(toBinaryString(iv)), data: btoa(toBinaryString(new Uint8Array(ciphertext))) };
}

async function decryptPayload({ iv, data }) {
  try {
    const ivArr = toUint8Array(iv);
    const dataArr = toUint8Array(data);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivArr },
      encryptionKey,
      dataArr
    );
    return JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext)));
  } catch (e) {
    console.error('Decryption failed:', e);
    return null;
  }
}

function createPeerConnection(peerId) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { room, to: peerId, data: { candidate: e.candidate } });
    }
  };

    pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) {
      cleanupPeer(peerId);
      pendingConnections.delete(peerId);
      updateGlobalStatus();
    } else if (pc.connectionState === 'connected') {
      pendingConnections.delete(peerId);
      updateGlobalStatus();
    }
  };

  pc.ondatachannel = (event) => {
    setupDataChannel(peerId, event.channel);
  };

  peerConnections.set(peerId, pc);
  return pc;
}

function setupDataChannel(peerId, channel) {
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => { 
    if (channel.readyState === 'open') {
      dataChannels.set(peerId, channel); 
      updateGlobalStatus();
    }
  };
  channel.onclose = () => { 
    dataChannels.delete(peerId); 
    updateGlobalStatus();
  };
  channel.onerror = (e) => {
    console.warn('DataChannel error for peer', peerId, e);
    if (e.error?.message?.includes('Close called')) {
      cleanupPeer(peerId);
    }
  };

  channel.onmessage = async (event) => {
    try {
      const envelope = JSON.parse(event.data);
      const msg = await decryptPayload(envelope);
      if (!msg) return;
      switch (msg.kind) {
        case 'text':
          addMessage(msg.text, false, peerNames.get(peerId) || peerId);
          break;
        case 'file-meta':
          ensureReceiverState(peerId, msg.fileId, msg.name, msg.size, msg.mime);
          break;
        case 'file-chunk':
          appendChunk(peerId, msg.fileId, msg.seq, msg.chunk);
          break;
        case 'file-complete':
          completeFile(peerId, msg.fileId);
          break;
        case 'system':
          addSystem(msg.text);
          break;
        case 'typing':
          handleTypingIndicator(peerId, msg.userName || peerNames.get(peerId) || peerId, msg.isTyping);
          break;
      }
    } catch (e) {
      console.error('Failed to handle incoming message:', e);
    }
  };
}

function updateGlobalStatus() {
  const connected = Array.from(dataChannels.values()).filter(ch => ch.readyState === 'open').length;
  if (pendingConnections.size > 0) {
    els.statusText.innerText = 'Connecting to peers...';
  } else {
    els.statusText.innerText = connected > 0 ? `${connected} peer${connected > 1 ? 's' : ''} connected` : 'No peers connected';
  }
  setOnlineDot(connected > 0);
  
  // Update dashboard stats in real-time
  updateDashboardStats();
}

function updateUserList() {
  els.userListUl.innerHTML = '';
  for (const [peerId, user] of users) {
    const li = document.createElement('li');
    li.textContent = `${user.name}${user.isHost ? ' (Host)' : ''}`;
    if (myIsHost && !user.isHost && peerId !== myPeerId) {
      const btn = document.createElement('button');
      btn.className = 'kick-btn';
      btn.textContent = 'Kick';
      btn.dataset.peerId = peerId;
      btn.onclick = () => {
        socket.emit('kick-user', { room, peerId: btn.dataset.peerId });
      };
      li.appendChild(btn);
    }
    els.userListUl.appendChild(li);
  }
}

socket.on('your-id', ({ peerId, roomName: receivedRoomName }) => {
  myPeerId = peerId;
  roomName = receivedRoomName || roomName || room;
  if (els.roomNameDisplay) els.roomNameDisplay.innerText = roomName;
});
socket.on('user-list', ({ users: userArray }) => {
  users.clear();
  for (const u of userArray) {
    users.set(u.peerId, { name: u.name, isHost: u.isHost });
    peerNames.set(u.peerId, u.name);
  }
  myIsHost = users.get(myPeerId)?.isHost || false;
  updateUserList();
});

socket.on('peers', async ({ peers }) => {
  for (const { peerId, name } of peers) {
    peerNames.set(peerId, name);
    pendingConnections.add(peerId);
    await connectToPeer(peerId);
  }
  updateGlobalStatus();
});

socket.on('peer-joined', async ({ peerId, name }) => {
  peerNames.set(peerId, name);
  addSystem(`${name} joined`);
  pendingConnections.add(peerId);
  createPeerConnection(peerId);
  updateGlobalStatus();
});

socket.on('peer-left', ({ peerId, name }) => {
  addSystem(`${name} left`);
  cleanupPeer(peerId);
});

socket.on('signal', async ({ from, data }) => {
  const pc = createPeerConnection(from);
  try {
    if (data.type === 'offer') {
      await pc.setRemoteDescription(data);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { room, to: from, data: answer });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data);
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (e) {
    console.error('Signal handling error:', e);
  }
});

async function connectToPeer(peerId) {
  const pc = createPeerConnection(peerId);
  const ch = pc.createDataChannel('chat', { ordered: true });
  setupDataChannel(peerId, ch);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { room, to: peerId, data: offer });
}

/* ---------- File transfer (chunked) ---------- */
function ensureReceiverState(peerId, fileId, name, size, mime) {
  incomingFiles.set(`${peerId}:${fileId}`, { name, size, mime, chunks: [], received: 0 });
}

function appendChunk(peerId, fileId, seq, chunk) {
  const key = `${peerId}:${fileId}`;
  const st = incomingFiles.get(key); if (!st) return;
  st.chunks[seq] = toUint8Array(chunk);
  st.received += st.chunks[seq].length;
}

function completeFile(peerId, fileId) {
  const key = `${peerId}:${fileId}`;
  const st = incomingFiles.get(key); if (!st) return;

  const total = st.chunks.reduce((sum, c) => sum + (c?.length || 0), 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of st.chunks) { if (!c) continue; buf.set(c, off); off += c.length; }
  const blob = new Blob([buf], { type: st.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  addFile(st.name, url, false, peerNames.get(peerId) || peerId);
  incomingFiles.delete(key);
}

async function sendTextToAll(text) {
  const payload = await encryptPayload({ kind: 'text', text });
  for (const [, ch] of dataChannels) if (ch.readyState === 'open') ch.send(JSON.stringify(payload));
}

async function sendSystemToAll(text) {
  const payload = await encryptPayload({ kind: 'system', text });
  for (const [, ch] of dataChannels) if (ch.readyState === 'open') ch.send(JSON.stringify(payload));
}

async function sendFileToAll(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const total = Math.ceil(bytes.length / CHUNK_SIZE);
  const fileId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

  const meta = await encryptPayload({
    kind: 'file-meta', fileId, name: file.name, size: bytes.length, mime: file.type, chunks: total
  });
  for (const [, ch] of dataChannels) if (ch.readyState === 'open') ch.send(JSON.stringify(meta));

  for (let i = 0; i < total; i++) {
    const chunkBytes = bytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const chunkBase64 = btoa(toBinaryString(chunkBytes));
    const part = await encryptPayload({
      kind: 'file-chunk',
      fileId,
      seq: i,
      chunk: chunkBase64
    });
    for (const [, ch] of dataChannels) if (ch.readyState === 'open') ch.send(JSON.stringify(part));
  }

  const done = await encryptPayload({ kind: 'file-complete', fileId });
  for (const [, ch] of dataChannels) if (ch.readyState === 'open') ch.send(JSON.stringify(done));
}

/* ------------- UI handlers ------------- */
async function handleEnterRoom(isCreate) {
  room = els.roomInput.value.trim();
  displayName = els.nameInput.value.trim();
  roomName = isCreate ? els.roomNameInput.value.trim() : '';
  passphrase = els.passInput.value.trim();
  if (!room || !displayName || !passphrase || (isCreate && !roomName)) return alert('Enter all required fields');

  els.createBtn.disabled = true;
  els.joinBtn.disabled = true;
  els.statusText.innerText = 'Deriving key...';
  try {
    encryptionKey = await deriveKey(passphrase);
    const passphraseHash = await getPassphraseHash(passphrase);
    els.joinScreen.classList.add('hidden');
els.app.classList.remove('hidden');

els.statusText.innerText = 'Connecting...';
    setOnlineDot(false);

    const event = isCreate ? 'create-room' : 'join-room';
    socket.emit(event, { room, name: displayName, roomName, passphraseHash });
    addSystem(`Joined as ${displayName} • room ${room}`);
    
    // Update dashboard room info
    updateRoomInfo();
  } catch (e) {
    console.error(e);
    alert('Failed to initialize encryption.');
    els.createBtn.disabled = false;
    els.joinBtn.disabled = false;
  }
};

els.createBtn.onclick = () => {
  // Initialize audio context on first user interaction
  initializeAudioContext();
  handleEnterRoom(true);
};

els.joinBtn.onclick = () => {
  // Initialize audio context on first user interaction
  initializeAudioContext();
  handleEnterRoom(false);
};

// Typing indicator event listeners
els.textInput.addEventListener('input', () => {
  if (els.textInput.value.trim().length > 0) {
    startTyping();
  } else {
    stopTyping();
  }
});

els.textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault(); // Prevent form submission
    originalSendMessage(); // Send the message
    return;
  }
  
  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (els.textInput.value.trim().length <= 1) {
      stopTyping();
    } else {
      startTyping();
    }
  }
});

// Stop typing when message is sent
const originalSendMessage = async () => {
  const text = els.textInput.value.trim();
  if (!text || !encryptionKey) return;
  
  // Stop typing indicator
  stopTyping();
  
  // Send message (existing functionality)
  const msg = { kind: 'text', text };
  const payload = await encryptPayload(msg);
  for (const ch of dataChannels.values()) {
    if (ch.readyState === 'open') ch.send(JSON.stringify(payload));
  }
  addMessage(text, true);
  els.textInput.value = '';
};

els.sendText.onclick = originalSendMessage;

socket.on('create-error', (message) => {
  alert(message);
  els.app.classList.add('hidden');
  els.joinScreen.classList.remove('hidden');
  els.createBtn.disabled = false;
  els.joinBtn.disabled = false;
  els.messages.innerHTML = '';
  els.statusText.innerText = 'No peers connected';
});

socket.on('join-error', (message) => {
  alert(message);
  els.app.classList.add('hidden');
  els.joinScreen.classList.remove('hidden');
  els.createBtn.disabled = false;
  els.joinBtn.disabled = false;
  els.messages.innerHTML = '';
  els.statusText.innerText = 'No peers connected';
});

socket.on('kicked', (message) => {
  alert(message);
  teardownAll(message);
});

els.leaveBtn.onclick = () => {
  socket.emit('leave-room', { room });
  teardownAll('You left the room');
};

els.sendText.onclick = async () => {
  const text = els.textInput.value.trim();
  if (!text) return;
  if (dataChannels.size === 0) return alert('No peers connected yet.');

  addMessage(text, true, displayName);
  els.textInput.value = '';
  await sendTextToAll(text);
};

els.sendFile.onclick = async () => {
  const file = els.fileInput.files[0];
  if (!file) return alert('No file selected.');
  if (dataChannels.size === 0) return alert('No peers connected yet.');

  addFile(file.name, URL.createObjectURL(file), true, displayName);
  await sendFileToAll(file);
  els.fileInput.value = '';
};

/* ------------- helpers ------------- */
function setOnlineDot(connected) {
  if (!els.statusDot) return;
  els.statusDot.classList.toggle('online', connected);
}
function cleanupPeer(peerId) {
  peerConnections.get(peerId)?.close();
  dataChannels.get(peerId)?.close();
  peerConnections.delete(peerId);
  dataChannels.delete(peerId);
  pendingConnections.delete(peerId);
  
  // Clean up typing indicator for this user
  const userName = peerNames.get(peerId);
  if (userName) {
    typingUsers.delete(userName);
    updateTypingDisplay();
  }
  
  users.delete(peerId);
  updateUserList();
  updateGlobalStatus();
}

function teardownAll(reasonText) {
  for (const peerId of [...peerConnections.keys()]) cleanupPeer(peerId);
  encryptionKey = undefined;
  myPeerId = '';
  myIsHost = false;
  users.clear();
  pendingConnections.clear();
  
  // Clear all typing indicators
  typingUsers.clear();
  updateTypingDisplay();
  stopTyping();
  
  // Clear reconnection state when manually leaving
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  isReconnecting = false;
  reconnectAttempts = 0;
  wasConnected = false;
  
  // Reset dashboard stats
  stats.messagesCount = 0;
  stats.filesShared = 0;
  room = '';
  displayName = '';
  roomName = '';
  
  // Always clear messages when leaving room
  els.messages.innerHTML = '';
  
  updateUserList();
  updateDashboardStats();
  updateRoomInfo();
  addSystem(reasonText);
  setTimeout(() => location.reload(), 250);
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'message msg-system';
  div.innerHTML = `<em>${text}</em>`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessage(text, isMe, who = '') {
  const div = document.createElement('div');
  div.className = `message ${isMe ? 'msg-me' : 'msg-other'}`;
  div.innerHTML = who ? `<strong>${who}:</strong> ${escapeHtml(text)}` : escapeHtml(text);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  
  // Track message stats for dashboard
  if (isMe) {
    stats.messagesCount++;
    updateDashboardStats();
  } else {
    // Play sound for incoming messages (not your own)
    playNotificationSound();
  }
}

function addFile(name, url, isMe, who = '') {
  const div = document.createElement('div');
  div.className = `message ${isMe ? 'msg-me' : 'msg-other'}`;
  const label = who ? `<strong>${who}:</strong> ` : '';
  div.innerHTML = `${label}<a href="${url}" download="${name}">📎 ${escapeHtml(name)}</a>`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  
  // Track file stats for dashboard
  if (isMe) {
    stats.filesShared++;
    updateDashboardStats();
  } else {
    // Play sound for incoming files (not your own)
    playNotificationSound();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Auto-reconnect functionality
let reconnectTimeout = null;
let isReconnecting = false;
let wasConnected = false;
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;

function attemptReconnect() {
  if (!appSettings.autoReconnect || isReconnecting || !room || !displayName || !passphrase) return;
  
  isReconnecting = true;
  reconnectAttempts++;
  
  if (reconnectAttempts <= maxReconnectAttempts) {
    addSystem(`Connection lost. Reconnecting immediately... (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
    
    reconnectTimeout = setTimeout(async () => {
      if (room && displayName && passphrase) {
        addSystem('Attempting to reconnect...');
        
        try {
          // Try to reconnect to the socket first
          if (socket.disconnected) {
            socket.connect();
          }
          
          // Wait a moment for socket to connect
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          if (socket.connected) {
            // Clear existing peer connections first
            for (const peerId of [...peerConnections.keys()]) {
              cleanupPeer(peerId);
            }
            
            // Re-derive encryption key and rejoin room
            encryptionKey = await deriveKey(passphrase);
            const passphraseHash = await getPassphraseHash(passphrase);
            
            // Rejoin the room
            socket.emit('join-room', { room, name: displayName, roomName, passphraseHash });
            addSystem(`Reconnected successfully as ${displayName}`);
            
            // Reset reconnect attempts on success
            reconnectAttempts = 0;
            isReconnecting = false;
            
            // Update dashboard
            updateRoomInfo();
            updateGlobalStatus();
          } else {
            // Socket still not connected, try again
            isReconnecting = false;
            setTimeout(() => attemptReconnect(), 2000);
          }
        } catch (e) {
          console.error('Reconnection failed:', e);
          isReconnecting = false;
          
          if (reconnectAttempts < maxReconnectAttempts) {
            setTimeout(() => attemptReconnect(), 2000);
          } else {
            addSystem('Reconnection failed after maximum attempts. Please refresh the page.');
          }
        }
      } else {
        isReconnecting = false;
      }
    }, 500); // Small delay to prevent overwhelming the server
  } else {
    addSystem('Maximum reconnection attempts reached. Please refresh the page to reconnect.');
    isReconnecting = false;
  }
}

// Socket connection monitoring
socket.on('connect', () => {
  if (wasConnected && room && displayName && passphrase && appSettings.autoReconnect) {
    addSystem('Socket reconnected. Rejoining room...');
    
    // Clear existing peer connections before rejoining
    for (const peerId of [...peerConnections.keys()]) {
      cleanupPeer(peerId);
    }
    
    attemptReconnect();
  }
  wasConnected = true;
});

socket.on('disconnect', (reason) => {
  if (room && displayName && passphrase && appSettings.autoReconnect) {
    if (reason === 'io server disconnect') {
      addSystem('Server disconnected. Attempting to reconnect...');
    } else if (reason === 'transport close') {
      addSystem('Connection lost. Attempting to reconnect...');
    } else {
      addSystem('Disconnected. Attempting to reconnect...');
    }
    
    // Start reconnection attempts after a short delay
    setTimeout(() => {
      if (!socket.connected && appSettings.autoReconnect) {
        attemptReconnect();
      }
    }, 1000);
  }
});

// Handle connection events
window.addEventListener('online', () => {
  if (room && displayName && passphrase && appSettings.autoReconnect) {
    addSystem('Network connection restored. Reconnecting...');
    
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    
    // Reset attempts when network comes back
    reconnectAttempts = 0;
    
    if (!socket.connected) {
      attemptReconnect();
    }
  }
});

window.addEventListener('offline', () => {
  if (appSettings.autoReconnect && room && displayName && passphrase) {
    addSystem('Network connection lost. Will attempt to reconnect when online.');
    
    // Clear any pending reconnection attempts
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    isReconnecting = false;
  }
});

// Dashboard modal functionality
function openDashboard() {
  els.dashboardOverlay.classList.add('active');
  updateDashboardStats();
  updateRoomInfo();
}

function closeDashboard() {
  els.dashboardOverlay.classList.remove('active');
}

// Event listeners for dashboard modal
els.dashboardBtn.onclick = openDashboard;
els.dashboardClose.onclick = closeDashboard;

// Close modal when clicking outside of it
els.dashboardOverlay.onclick = (e) => {
  if (e.target === els.dashboardOverlay) {
    closeDashboard();
  }
};

// Close modals with Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (els.dashboardOverlay.classList.contains('active')) {
      closeDashboard();
    } else if (els.settingsOverlay.classList.contains('active')) {
      closeSettings();
    } else if (els.helpOverlay.classList.contains('active')) {
      closeHelp();
    }
  }
});

// Settings modal functionality
function openSettings() {
  els.settingsOverlay.classList.add('active');
  loadSettings();
}

function closeSettings() {
  els.settingsOverlay.classList.remove('active');
}

// Event listeners for settings modal
els.settingsBtn.onclick = openSettings;
els.settingsClose.onclick = closeSettings;

// Close modal when clicking outside of it
els.settingsOverlay.onclick = (e) => {
  if (e.target === els.settingsOverlay) {
    closeSettings();
  }
};

// Help modal functionality
function openHelp() {
  els.helpOverlay.classList.add('active');
}

function closeHelp() {
  els.helpOverlay.classList.remove('active');
}

// Event listeners for help modal
els.helpBtn.onclick = openHelp;
els.helpClose.onclick = closeHelp;

// Close modal when clicking outside of it
els.helpOverlay.onclick = (e) => {
  if (e.target === els.helpOverlay) {
    closeHelp();
  }
};

// Dashboard update functions
function updateDashboardStats() {
  // Get real-time connection count from existing dataChannels
  const connected = Array.from(dataChannels.values()).filter(ch => ch.readyState === 'open').length;
  
  // Update dashboard elements if they exist
  if (els.connectedPeers) els.connectedPeers.textContent = connected;
  if (els.messagesCount) els.messagesCount.textContent = stats.messagesCount;
  if (els.filesShared) els.filesShared.textContent = stats.filesShared;
  
  // Update connection status with real data
  if (els.connectionStatus && els.connectionDot) {
    if (pendingConnections.size > 0) {
      els.connectionStatus.textContent = 'Connecting to peers...';
      els.connectionDot.classList.remove('online');
    } else if (connected > 0) {
      els.connectionStatus.textContent = `Connected to ${connected} peer${connected > 1 ? 's' : ''}`;
      els.connectionDot.classList.add('online');
    } else {
      els.connectionStatus.textContent = 'Disconnected';
      els.connectionDot.classList.remove('online');
    }
  }
}

function updateRoomInfo() {
  if (room && displayName) {
    els.roomInfoSection.style.display = 'block';
    els.currentRoomId.textContent = room;
    els.currentRoomName.textContent = roomName || room;
    els.currentUserName.textContent = displayName;
  } else {
    els.roomInfoSection.style.display = 'none';
  }
}
// Settings functionality
function loadSettings() {
  const settings = JSON.parse(localStorage.getItem('stealthlan-settings') || '{}');
  
  // Update appSettings object
  appSettings.darkMode = settings.darkMode !== false;
  appSettings.soundNotifications = settings.soundNotifications !== false;
  appSettings.showTypingIndicator = settings.showTypingIndicator !== false;
  appSettings.autoReconnect = settings.autoReconnect !== false;
  
  // Update UI elements
  if (els.darkModeToggle) els.darkModeToggle.checked = appSettings.darkMode;
  if (els.soundNotifications) els.soundNotifications.checked = appSettings.soundNotifications;
  if (els.showTypingIndicator) els.showTypingIndicator.checked = appSettings.showTypingIndicator;
  if (els.autoReconnect) els.autoReconnect.checked = appSettings.autoReconnect;
  
  // Apply dark mode
  applyDarkMode();
}
function saveSettings() {
  // Update appSettings from UI
  appSettings.darkMode = els.darkModeToggle?.checked !== false;
  appSettings.soundNotifications = els.soundNotifications?.checked !== false;
  appSettings.showTypingIndicator = els.showTypingIndicator?.checked !== false;
  appSettings.autoReconnect = els.autoReconnect?.checked !== false;
  
  // Save to localStorage
  localStorage.setItem('stealthlan-settings', JSON.stringify(appSettings));
  
  // Apply changes
  applyDarkMode();
}

function applyDarkMode() {
  if (appSettings.darkMode) {
    document.body.classList.remove('light-mode');
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
    document.body.classList.add('light-mode');
  }
}

function resetSettings() {
  localStorage.removeItem('stealthlan-settings');
  // Reset appSettings to defaults
  appSettings = {
    darkMode: true,
    soundNotifications: true,
    showTypingIndicator: true,
    autoReconnect: true
  };
  loadSettings();
  alert('Settings reset to defaults');
}

function exportSettings() {
  const settings = localStorage.getItem('stealthlan-settings') || '{}';
  const blob = new Blob([settings], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stealthlan-settings.json';
  a.click();
  URL.revokeObjectURL(url);
}

// Settings event listeners
if (els.darkModeToggle) els.darkModeToggle.onchange = saveSettings;
if (els.soundNotifications) els.soundNotifications.onchange = saveSettings;
if (els.showTypingIndicator) els.showTypingIndicator.onchange = saveSettings;
if (els.autoReconnect) els.autoReconnect.onchange = saveSettings;
if (els.resetSettings) els.resetSettings.onclick = resetSettings;
if (els.exportSettings) els.exportSettings.onclick = exportSettings;

// Initialize dashboard and settings on page load
updateDashboardStats();
updateRoomInfo();
loadSettings();
