class VideoChatApp {
    constructor() {
        this.clientId = this.generateClientId();
        this.roomId = null;
        this.username = 'User';
        this.peers = new Map(); // clientId -> RTCPeerConnection
        this.localStream = null;
        this.screenStream = null;
        this.socket = null;
        this.isVideoOn = true;
        this.isAudioOn = true;
        this.isSharingScreen = false;
        
        this.initializeUI();
        this.setupEventListeners();
        this.loadActiveRooms();
    }

    generateClientId() {
        return 'user_' + Math.random().toString(36).substr(2, 9);
    }

    initializeUI() {
        // Set default username
        const savedName = localStorage.getItem('videoChatUsername');
        if (savedName) {
            document.getElementById('username').value = savedName;
        }
        
        // Set default room if in URL
        const urlParams = new URLSearchParams(window.location.search);
        const roomFromUrl = urlParams.get('room');
        if (roomFromUrl) {
            document.getElementById('roomId').value = roomFromUrl;
        }
    }

    setupEventListeners() {
        // Enter key for room joining
        document.getElementById('roomId').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });
        
        document.getElementById('username').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });
        
        // Enter key for chat
        document.getElementById('messageInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });
    }

    async loadActiveRooms() {
        try {
            const response = await fetch('/api/rooms');
            const rooms = await response.json();
            this.displayActiveRooms(rooms);
        } catch (error) {
            console.log('Could not load rooms:', error);
        }
    }

    displayActiveRooms(rooms) {
        const container = document.getElementById('roomsContainer');
        if (Object.keys(rooms).length === 0) {
            container.innerHTML = '<p class="no-rooms">No active rooms. Create one!</p>';
            return;
        }
        
        container.innerHTML = Object.entries(rooms).map(([roomId, roomInfo]) => `
            <div class="room-item" onclick="joinRoomById('${roomId}')">
                <div>
                    <strong>${roomId}</strong>
                    <div class="room-users">
                        <span>👥</span> ${roomInfo.user_count} user${roomInfo.user_count !== 1 ? 's' : ''}
                    </div>
                </div>
                <button class="btn-secondary" onclick="event.stopPropagation(); joinRoomById('${roomId}')">
                    Join
                </button>
            </div>
        `).join('');
    }

    async joinRoom() {
        this.username = document.getElementById('username').value.trim() || 'User';
        this.roomId = document.getElementById('roomId').value.trim() || 'default-room';
        
        // Save username
        localStorage.setItem('videoChatUsername', this.username);
        
        // Update URL
        window.history.pushState({}, '', `?room=${this.roomId}`);
        
        // Switch to call screen
        document.getElementById('joinScreen').style.display = 'none';
        document.getElementById('callScreen').style.display = 'block';
        document.getElementById('currentRoomName').textContent = this.roomId;
        
        // Connect to WebSocket
        await this.connectWebSocket();
        
        // Start local media
        await this.startLocalMedia();
        
        // Add local video
        this.addLocalVideo();
    }

    async connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/${this.clientId}`;
        
        this.socket = new WebSocket(wsUrl);
        
        this.socket.onopen = () => {
            console.log('WebSocket connected');
            this.updateConnectionStatus(true);
            
            // Send join message
            this.socket.send(JSON.stringify({
                type: 'join',
                room_id: this.roomId,
                username: this.username,
                client_id: this.clientId
            }));
            
            // Start ping interval
            this.pingInterval = setInterval(() => {
                if (this.socket.readyState === WebSocket.OPEN) {
                    this.socket.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);
        };
        
        this.socket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            await this.handleWebSocketMessage(data);
        };
        
        this.socket.onclose = () => {
            console.log('WebSocket disconnected');
            this.updateConnectionStatus(false);
            clearInterval(this.pingInterval);
            
            // Try to reconnect after 3 seconds
            setTimeout(() => {
                if (this.roomId) {
                    this.connectWebSocket();
                }
            }, 3000);
        };
        
        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }

    async handleWebSocketMessage(data) {
        switch(data.type) {
            case 'room_joined':
                console.log('Joined room:', data.room_id);
                // Create peer connections with existing users
                for (const user of data.existing_users) {
                    await this.createPeerConnection(user.client_id);
                }
                break;
                
            case 'user_joined':
                this.addUserNotification(`${data.username} joined the room`);
                // Create peer connection with new user
                await this.createPeerConnection(data.client_id);
                break;
                
            case 'user_left':
                this.addUserNotification(`${data.username} left the room`);
                this.removePeerConnection(data.client_id);
                break;
                
            case 'signal':
                await this.handleSignal(data.from, data.signal, data.signal_type);
                break;
                
            case 'chat':
                this.addChatMessage(data.username, data.message, data.timestamp);
                break;
                
            case 'pong':
                // Update last ping time
                this.lastPong = Date.now();
                break;
        }
    }

    async createPeerConnection(targetClientId) {
        if (this.peers.has(targetClientId)) {
            console.log('Peer connection already exists for:', targetClientId);
            return;
        }

        const peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        });

        // Add local tracks
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, this.localStream);
            });
        }

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({
                    type: 'signal',
                    to: targetClientId,
                    signal: event.candidate,
                    signal_type: 'candidate'
                }));
            }
        };

        // Handle remote stream
        peerConnection.ontrack = (event) => {
            this.addRemoteVideo(targetClientId, event.streams[0]);
        };

        // Handle connection state
        peerConnection.onconnectionstatechange = () => {
            console.log(`Connection state with ${targetClientId}:`, peerConnection.connectionState);
            if (peerConnection.connectionState === 'failed' || 
                peerConnection.connectionState === 'disconnected' ||
                peerConnection.connectionState === 'closed') {
                setTimeout(() => {
                    this.removePeerConnection(targetClientId);
                }, 2000);
            }
        };

        this.peers.set(targetClientId, peerConnection);

        // Create and send offer
        if (peerConnection.signalingState === 'stable') {
            try {
                const offer = await peerConnection.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true
                });
                await peerConnection.setLocalDescription(offer);
                
                this.socket.send(JSON.stringify({
                    type: 'signal',
                    to: targetClientId,
                    signal: offer,
                    signal_type: 'offer'
                }));
            } catch (error) {
                console.error('Error creating offer:', error);
            }
        }
    }

    async handleSignal(fromClientId, signal, signalType) {
        const peerConnection = this.peers.get(fromClientId);
        
        if (!peerConnection) {
            // Create peer connection if it doesn't exist
            await this.createPeerConnection(fromClientId);
            return this.handleSignal(fromClientId, signal, signalType);
        }

        try {
            switch(signalType) {
                case 'offer':
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
                    const answer = await peerConnection.createAnswer();
                    await peerConnection.setLocalDescription(answer);
                    
                    this.socket.send(JSON.stringify({
                        type: 'signal',
                        to: fromClientId,
                        signal: answer,
                        signal_type: 'answer'
                    }));
                    break;
                    
                case 'answer':
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
                    break;
                    
                case 'candidate':
                    await peerConnection.addIceCandidate(new RTCIceCandidate(signal));
                    break;
            }
        } catch (error) {
            console.error('Error handling signal:', error);
        }
    }

    async startLocalMedia() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
        } catch (error) {
            console.error('Error accessing media devices:', error);
            alert('Could not access camera/microphone. Please check permissions.');
            
            // Try audio only
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (audioError) {
                console.error('Could not access audio either:', audioError);
            }
        }
    }

    addLocalVideo() {
        const videoGrid = document.getElementById('videoGrid');
        
        // Clear existing local video
        const existingLocal = document.getElementById('localVideoContainer');
        if (existingLocal) existingLocal.remove();
        
        const videoContainer = document.createElement('div');
        videoContainer.id = 'localVideoContainer';
        videoContainer.className = 'video-container';
        
        const video = document.createElement('video');
        video.id = 'localVideo';
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        
        if (this.localStream) {
            video.srcObject = this.localStream;
        } else {
            // Show placeholder if no camera
            video.style.backgroundColor = '#333';
        }
        
        const overlay = document.createElement('div');
        overlay.className = 'video-overlay';
        overlay.innerHTML = `
            <span class="user-name">${this.username} (You)</span>
            ${!this.isVideoOn ? '📷 Off' : ''}
            ${!this.isAudioOn ? '🔇 Muted' : ''}
        `;
        
        videoContainer.appendChild(video);
        videoContainer.appendChild(overlay);
        videoGrid.appendChild(videoContainer);
    }

    addRemoteVideo(clientId, stream) {
        const videoGrid = document.getElementById('videoGrid');
        
        // Remove existing remote video for this client
        const existingRemote = document.getElementById(`remoteVideo-${clientId}`);
        if (existingRemote) existingRemote.remove();
        
        const videoContainer = document.createElement('div');
        videoContainer.id = `remoteVideo-${clientId}`;
        videoContainer.className = 'video-container';
        
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        
        const overlay = document.createElement('div');
        overlay.className = 'video-overlay';
        overlay.innerHTML = `<span class="user-name">User ${clientId.substr(0, 8)}</span>`;
        
        videoContainer.appendChild(video);
        videoContainer.appendChild(overlay);
        videoGrid.appendChild(videoContainer);
        
        // Update user count
        this.updateUserCount();
    }

    removePeerConnection(clientId) {
        const peerConnection = this.peers.get(clientId);
        if (peerConnection) {
            peerConnection.close();
            this.peers.delete(clientId);
        }
        
        // Remove video element
        const videoElement = document.getElementById(`remoteVideo-${clientId}`);
        if (videoElement) {
            videoElement.remove();
        }
        
        // Update user count
        this.updateUserCount();
    }

    async toggleVideo() {
        if (!this.localStream) return;
        
        this.isVideoOn = !this.isVideoOn;
        const videoTrack = this.localStream.getVideoTracks()[0];
        
        if (videoTrack) {
            videoTrack.enabled = this.isVideoOn;
            document.getElementById('videoToggle').innerHTML = 
                `<span class="icon">${this.isVideoOn ? '📹' : '📷'}</span> ${this.isVideoOn ? 'Video On' : 'Video Off'}`;
            
            // Update local video overlay
            this.updateLocalVideoOverlay();
        }
    }

    async toggleAudio() {
        if (!this.localStream) return;
        
        this.isAudioOn = !this.isAudioOn;
        const audioTrack = this.localStream.getAudioTracks()[0];
        
        if (audioTrack) {
            audioTrack.enabled = this.isAudioOn;
            document.getElementById('audioToggle').innerHTML = 
                `<span class="icon">${this.isAudioOn ? '🎤' : '🔇'}</span> ${this.isAudioOn ? 'Mic On' : 'Mic Off'}`;
            
            // Update local video overlay
            this.updateLocalVideoOverlay();
        }
    }

    async shareScreen() {
        if (this.isSharingScreen) {
            // Stop screen sharing
            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
                this.screenStream = null;
            }
            
            // Switch back to camera
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                this.replaceTrack(videoTrack);
            }
            
            this.isSharingScreen = false;
            document.getElementById('screenShare').innerHTML = 
                '<span class="icon">🖥️</span> Share Screen';
        } else {
            try {
                this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: false
                });
                
                // Replace video track with screen track
                const screenTrack = this.screenStream.getVideoTracks()[0];
                this.replaceTrack(screenTrack);
                
                this.isSharingScreen = true;
                document.getElementById('screenShare').innerHTML = 
                    '<span class="icon">🖥️</span> Stop Sharing';
                
                // Handle when user stops sharing via browser UI
                screenTrack.onended = () => {
                    this.shareScreen();
                };
                
            } catch (error) {
                console.error('Error sharing screen:', error);
            }
        }
    }

    replaceTrack(newTrack) {
        // Replace track in local stream
        const oldTrack = this.localStream.getVideoTracks()[0];
        if (oldTrack) {
            this.localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        this.localStream.addTrack(newTrack);
        
        // Update local video
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
            localVideo.srcObject = this.localStream;
        }
        
        // Replace track in all peer connections
        for (const [clientId, peerConnection] of this.peers.entries()) {
            const sender = peerConnection.getSenders().find(s => 
                s.track && s.track.kind === 'video'
            );
            if (sender) {
                sender.replaceTrack(newTrack);
            }
        }
    }

    updateLocalVideoOverlay() {
        const overlay = document.querySelector('#localVideoContainer .video-overlay');
        if (overlay) {
            overlay.innerHTML = `
                <span class="user-name">${this.username} (You)</span>
                ${!this.isVideoOn ? '📷 Off' : ''}
                ${!this.isAudioOn ? '🔇 Muted' : ''}
            `;
        }
    }

    updateUserCount() {
        const userCount = this.peers.size + 1; // +1 for local user
        document.getElementById('userCount').textContent = userCount;
    }

    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('connectionStatus');
        if (connected) {
            statusElement.innerHTML = '<span class="status-indicator"></span> Connected';
            statusElement.style.color = '#10b981';
        } else {
            statusElement.innerHTML = '<span class="status-indicator" style="background: #ef4444;"></span> Connecting...';
            statusElement.style.color = '#ef4444';
        }
    }

    sendMessage() {
        const input = document.getElementById('messageInput');
        const message = input.value.trim();
        
        if (message && this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'chat',
                message: message
            }));
            
            // Clear input
            input.value = '';
            input.focus();
        }
    }

    addChatMessage(username, message, timestamp) {
        const chatMessages = document.getElementById('chatMessages');
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        
        const now = new Date();
        const timeStr = timestamp ? 
            new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) :
            now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        messageDiv.innerHTML = `
            <div class="message-header">
                <span class="message-sender">${username}</span>
                <span class="message-time">${timeStr}</span>
            </div>
            <div class="message-content">${this.escapeHtml(message)}</div>
        `;
        
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    addUserNotification(message) {
        const chatMessages = document.getElementById('chatMessages');
        
        const notificationDiv = document.createElement('div');
        notificationDiv.className = 'message system-message';
        notificationDiv.textContent = message;
        
        chatMessages.appendChild(notificationDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async leaveRoom() {
        // Close all peer connections
        for (const [clientId, peerConnection] of this.peers.entries()) {
            peerConnection.close();
        }
        this.peers.clear();
        
        // Stop local media
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        
        // Stop screen sharing
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }
        
        // Close WebSocket
        if (this.socket) {
            this.socket.close();
        }
        
        // Clear video grid
        document.getElementById('videoGrid').innerHTML = '';
        
        // Clear chat
        document.getElementById('chatMessages').innerHTML = 
            '<div class="system-message">Welcome to the chat! Messages are end-to-end encrypted.</div>';
        
        // Switch back to join screen
        document.getElementById('callScreen').style.display = 'none';
        document.getElementById('joinScreen').style.display = 'block';
        
        // Reload active rooms
        this.loadActiveRooms();
        
        this.roomId = null;
        this.isSharingScreen = false;
    }
}

// Global functions for HTML onclick handlers
function generateRoomId() {
    const adjectives = ['Cool', 'Fun', 'Happy', 'Sunny', 'Bright', 'Quick', 'Smart', 'Brave'];
    const nouns = ['Room', 'Space', 'Zone', 'Area', 'Place', 'Spot', 'Hub'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const number = Math.floor(Math.random() * 1000);
    document.getElementById('roomId').value = `${adj}${noun}${number}`;
}

function joinRoom() {
    if (!window.videoChatApp) {
        window.videoChatApp = new VideoChatApp();
    }
    window.videoChatApp.joinRoom();
}

function joinRoomById(roomId) {
    document.getElementById('roomId').value = roomId;
    joinRoom();
}

function sendMessage() {
    if (window.videoChatApp) {
        window.videoChatApp.sendMessage();
    }
}

function leaveRoom() {
    if (window.videoChatApp) {
        window.videoChatApp.leaveRoom();
    }
}

function toggleVideo() {
    if (window.videoChatApp) {
        window.videoChatApp.toggleVideo();
    }
}

function toggleAudio() {
    if (window.videoChatApp) {
        window.videoChatApp.toggleAudio();
    }
}

function shareScreen() {
    if (window.videoChatApp) {
        window.videoChatApp.shareScreen();
    }
}

// Initialize app when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.videoChatApp = new VideoChatApp();
});