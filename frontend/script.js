// Complete script.js with WebRTC, encryption, and error handling

// Check for Web Cryptography API support
if (!window.crypto || !window.crypto.subtle) {
  alert("Web Cryptography API not supported in this browser. Please use Chrome, Firefox, or Edge.");
  throw new Error("Web Cryptography API not available");
}

const socket = io(window.location.origin);
let room = '';
let passphrase = '';
let peerConnection;
let dataChannel;
let encryptionKey;
let peerId;
let remotePeerId;

// Crypto settings
const PBKDF2_ITERATIONS = 50000;
const SALT = new TextEncoder().encode('stealthlan-salt');

// DOM Elements
const elements = {
  joinScreen: document.getElementById('joinScreen'),
  app: document.getElementById('app'),
  statusText: document.getElementById('statusText'),
  roomInput: document.getElementById('roomInput'),
  passInput: document.getElementById('passInput'),
  joinBtn: document.getElementById('joinBtn'),
  messages: document.getElementById('messages'),
  textInput: document.getElementById('textInput'),
  sendText: document.getElementById('sendText'),
  fileInput: document.getElementById('fileInput'),
  sendFile: document.getElementById('sendFile')
};

// Key derivation
async function deriveKey(pass) {
  try {
    const enc = new TextEncoder();
    const passKey = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(pass),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    
    return await window.crypto.subtle.deriveKey(
      { 
        name: 'PBKDF2', 
        salt: SALT, 
        iterations: PBKDF2_ITERATIONS, 
        hash: 'SHA-256' 
      },
      passKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch (error) {
    console.error('Key derivation failed:', error);
    throw new Error('Failed to derive encryption key');
  }
}

// Encryption/Decryption functions
async function encryptData(data) {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      encoded
    );
    return { iv, ciphertext };
  } catch (error) {
    console.error('Encryption failed:', error);
    throw error;
  }
}

async function decryptData(iv, ciphertext) {
  try {
    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      ciphertext
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    console.error('Decryption failed:', error);
    throw error;
  }
}
// WebRTC Connection Management
async function startConnection() {
  try {
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    peerConnection = new RTCPeerConnection(configuration);

    // Setup data channel
    dataChannel = peerConnection.createDataChannel('chat', {
      ordered: true,
      maxPacketLifeTime: 3000
    });

    setupDataChannel();

    // ICE Candidate handling
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && remotePeerId) {
        socket.emit('signal', { 
          room, 
          to: remotePeerId, 
          data: { candidate: event.candidate } 
        });
      }
    };

    // Connection state monitoring
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log('Connection state:', state);
      elements.statusText.innerText = `Status: ${state}`;
      
      if (state === 'connected') {
        elements.statusText.innerText = 'Connected!';
      } else if (state === 'failed') {
        setTimeout(() => {
          elements.statusText.innerText = 'Reconnecting...';
          startConnection();
        }, 2000);
      }
    };

    // ICE Connection state
    peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', peerConnection.iceConnectionState);
    };

    // Join the room
    socket.emit('join-room', { room });

    // Handle signaling
    socket.on('peer-joined', ({ peerId: remoteId }) => {
      console.log('Peer joined:', remoteId);
      remotePeerId = remoteId;
      createOffer();
    });

    socket.on('signal', async ({ from, data }) => {
      remotePeerId = from;
      
      if (data.type === 'offer') {
        await handleOffer(data);
      } else if (data.type === 'answer') {
        await handleAnswer(data);
      } else if (data.candidate) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error('Error adding ICE candidate:', e);
        }
      }
    });

  } catch (error) {
    console.error('Connection setup failed:', error);
    throw error;
  }
}

// WebRTC Offer/Answer handling
async function createOffer() {
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { 
      room, 
      to: remotePeerId, 
      data: offer 
    });
  } catch (error) {
    console.error('Offer creation error:', error);
    throw error;
  }
}

async function handleOffer(offer) {
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('signal', { 
      room, 
      to: remotePeerId, 
      data: answer 
    });
  } catch (error) {
    console.error('Offer handling error:', error);
    throw error;
  }
}

async function handleAnswer(answer) {
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (error) {
    console.error('Answer handling error:', error);
    throw error;
  }
}

// Data Channel Management
function setupDataChannel() {
  dataChannel.onopen = () => {
    console.log('Data channel opened');
    elements.statusText.innerText = 'Connected!';
  };

  dataChannel.onclose = () => {
    console.log('Data channel closed');
    elements.statusText.innerText = 'Disconnected. Reconnecting...';
    setTimeout(startConnection, 2000);
  };

  dataChannel.onmessage = handleMessage;
  dataChannel.onerror = (error) => {
    console.error('Data channel error:', error);
  };

  peerConnection.ondatachannel = (event) => {
    console.log('Data channel received');
    dataChannel = event.channel;
    setupDataChannel();
  };
}

// Message handling
async function handleMessage(event) {
  try {
    const { iv, data, type, name } = JSON.parse(event.data);
    const decrypted = await decryptData(new Uint8Array(iv), new Uint8Array(data));

    if (type === 'text') {
      const text = new TextDecoder().decode(decrypted);
      addMessage(text, false);
    } else if (type === 'file') {
      const blob = new Blob([decrypted]);
      const url = URL.createObjectURL(blob);
      addFile(name, url, false);
    }
  } catch (error) {
    console.error('Message handling error:', error);
  }
}

// UI Event Handlers
elements.joinBtn.onclick = async () => {
  room = elements.roomInput.value.trim();
  passphrase = elements.passInput.value.trim();
  if (!room || !passphrase) return alert('Enter room and passphrase');
  
  elements.joinScreen.classList.add('hidden');
  elements.app.classList.remove('hidden');
  elements.statusText.innerText = 'Initializing encryption...';
  
  try {
    // Show loading state
    elements.joinBtn.disabled = true;
    elements.joinBtn.textContent = 'Connecting...';
    
    encryptionKey = await deriveKey(passphrase);
    elements.statusText.innerText = 'Establishing connection...';
    await startConnection();
  } catch (error) {
    console.error('Connection failed:', error);
    elements.statusText.innerText = 'Connection failed. Please try again.';
    elements.joinScreen.classList.remove('hidden');
    elements.app.classList.add('hidden');
    alert(`Connection error: ${error.message}`);
  } finally {
    elements.joinBtn.disabled = false;
    elements.joinBtn.textContent = 'Join Room';
  }
};

elements.sendText.onclick = async () => {
  const text = elements.textInput.value;
  if (!text || !dataChannel || dataChannel.readyState !== 'open') return;
  
  try {
    const { iv, ciphertext } = await encryptData(text);
    dataChannel.send(JSON.stringify({ 
      iv: [...iv], 
      data: [...new Uint8Array(ciphertext)], 
      type: 'text' 
    }));
    addMessage(text, true);
    elements.textInput.value = '';
  } catch (error) {
    console.error('Error sending text:', error);
    alert('Failed to send message. Please try again.');
  }
};

elements.sendFile.onclick = async () => {
  const file = elements.fileInput.files[0];
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const { iv, ciphertext } = await encryptData(new Uint8Array(arrayBuffer));
    dataChannel.send(JSON.stringify({ 
      iv: [...iv], 
      data: [...new Uint8Array(ciphertext)], 
      type: 'file', 
      name: file.name 
    }));
    addFile(file.name, URL.createObjectURL(file), true);
    elements.fileInput.value = '';
  } catch (error) {
    console.error('Error sending file:', error);
    alert('Failed to send file. Please try again.');
  }
};

// UI Helpers
function addMessage(text, isMe) {
  const msgDiv = document.createElement('div');
  msgDiv.classList.add('message', isMe ? 'msg-me' : 'msg-other');
  msgDiv.textContent = text;
  elements.messages.appendChild(msgDiv);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function addFile(name, url, isMe) {
  const msgDiv = document.createElement('div');
  msgDiv.classList.add('message', isMe ? 'msg-me' : 'msg-other');
  const link = document.createElement('a');
  link.href = url;
  link.textContent = `📎 ${name}`;
  link.classList.add('file-link');
  link.download = name;
  msgDiv.appendChild(link);
  elements.messages.appendChild(msgDiv);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// Auto-reconnect if connection drops
window.addEventListener('online', () => {
  if (peerConnection && peerConnection.connectionState !== 'connected') {
    elements.statusText.innerText = 'Reconnecting...';
    startConnection();
  }
});