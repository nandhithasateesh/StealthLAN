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
userListUl: document.getElementById('userListUl')
};

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
  } catch (e) {
    console.error(e);
    alert('Failed to initialize encryption.');
    els.createBtn.disabled = false;
    els.joinBtn.disabled = false;
  }
};

els.createBtn.onclick = () => handleEnterRoom(true);
els.joinBtn.onclick = () => handleEnterRoom(false);

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
  const ch = dataChannels.get(peerId);
  if (ch) { try { ch.close(); } catch {} dataChannels.delete(peerId); }

  const pc = peerConnections.get(peerId);
  if (pc) { try { pc.close(); } catch {} peerConnections.delete(peerId); }

  peerNames.delete(peerId);
  users.delete(peerId);
  pendingConnections.delete(peerId);
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
  updateUserList();
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
}

function addFile(name, url, isMe, who = '') {
  const div = document.createElement('div');
  div.className = `message ${isMe ? 'msg-me' : 'msg-other'}`;
  const label = who ? `<strong>${who}:</strong> ` : '';
  div.innerHTML = `${label}<a href="${url}" download="${name}">📎 ${escapeHtml(name)}</a>`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

window.addEventListener('online', () => {
  if (room && displayName && passphrase) location.reload();
});
