// Real-Time Collaboration Engine (Google Docs-style Presence, Cursors, Multi-Tab & Global Cross-Device Sync)
import { LANGUAGES } from './compilers.js';

const PUBLIC_MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];

export class RoomCollaborationEngine {
  constructor({
    roomId,
    user,
    onStateSync,
    onRemoteCodeChange,
    onPresenceUpdate,
    onChatMessage,
    onRemoteExecution,
    onTabChange
  }) {
    this.roomId = roomId.toUpperCase();
    this.user = user;
    this.onStateSync = onStateSync;
    this.onRemoteCodeChange = onRemoteCodeChange;
    this.onPresenceUpdate = onPresenceUpdate;
    this.onChatMessage = onChatMessage;
    this.onRemoteExecution = onRemoteExecution;
    this.onTabChange = onTabChange;

    this.peers = new Map(); // peerId -> peerUserObject
    this.channel = null;
    this.mqttClients = [];
    this.seenPacketIds = new Set();
    this.heartbeatInterval = null;
    this.topic = `codesync/studio/v2/room/${this.roomId.replace(/[^A-Z0-9_-]/gi, '')}`;

    // Shared room document state (with per-tab isolated stdin & lastExecution)
    this.state = {
      roomId: this.roomId,
      files: [
        {
          id: 'file-cpp',
          name: 'main.cpp',
          language: 'cpp',
          content: LANGUAGES.cpp.starterCode,
          stdin: 'CodeSyncer\n',
          lastExecution: null,
          updatedBy: 'System',
          updatedAt: 0
        },
        {
          id: 'file-py',
          name: 'solution.py',
          language: 'python',
          content: LANGUAGES.python.starterCode,
          stdin: 'CodeSyncer\n',
          lastExecution: null,
          updatedBy: 'System',
          updatedAt: 0
        },
        {
          id: 'file-js',
          name: 'index.js',
          language: 'javascript',
          content: LANGUAGES.javascript.starterCode,
          stdin: 'CodeSyncer\n',
          lastExecution: null,
          updatedBy: 'System',
          updatedAt: 0
        }
      ],
      stdin: 'CodeSyncer\n',
      chat: [],
      lastExecution: null,
      lastModified: 0
    };
  }

  init() {
    // 1. Load persisted room state from localStorage if available
    const saved = localStorage.getItem(`codesync_room_${this.roomId}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.files) && parsed.files.length > 0) {
          this.state.files = parsed.files;
          this.state.stdin = parsed.stdin ?? this.state.stdin;
          this.state.chat = Array.isArray(parsed.chat) ? parsed.chat.slice(-50) : [];
          this.state.lastModified = parsed.lastModified || 0;
        }
      } catch (e) {
        console.warn('Could not parse saved room state:', e);
      }
    }

    // 2. Setup BroadcastChannel for instant zero-latency local multi-tab sync
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(`codesync_channel_${this.roomId}`);
      this.channel.onmessage = (event) => {
        this._handleIncomingPacket(event.data);
      };
    }

    // 3. Setup storage event fallback for cross-window sync on same browser
    this._storageListener = (e) => {
      if (e.key === `codesync_pkt_${this.roomId}` && e.newValue) {
        try {
          const pkt = JSON.parse(e.newValue);
          this._handleIncomingPacket(pkt);
        } catch (_) {}
      }
    };
    window.addEventListener('storage', this._storageListener);

    // 4. Clean disconnect on tab close
    this._unloadListener = () => {
      this.broadcastPacket({ type: 'USER_LEAVE' });
    };
    window.addEventListener('beforeunload', this._unloadListener);

    // 5. Connect to dual persistent WebSocket MQTT brokers for global cross-device sync
    this._connectGlobalWebSockets();

    // 6. Announce presence immediately & start continuous heartbeat (sent over ALL transports)
    this.broadcastPacket({
      type: 'JOIN_REQUEST',
      user: this.user
    });

    this.heartbeatInterval = setInterval(() => {
      this._pruneStalePeers();
      this.broadcastPacket({
        type: 'HEARTBEAT',
        user: { ...this.user, lastSeen: Date.now() }
      });
    }, 2500);

    // Notify initial state
    this.onStateSync?.(this.state);
    this._emitPresence();
  }

  _connectGlobalWebSockets() {
    if (typeof window.mqtt === 'undefined') {
      console.warn('MQTT client library not loaded yet, retrying in 500ms...');
      setTimeout(() => this._connectGlobalWebSockets(), 500);
      return;
    }

    PUBLIC_MQTT_BROKERS.forEach((brokerUrl) => {
      try {
        const client = window.mqtt.connect(brokerUrl, {
          clientId: `cs_${this.user.id}_${Math.random().toString(36).slice(2, 6)}`,
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 2000
        });

        client.on('connect', () => {
          client.subscribe(this.topic, { qos: 0 }, (err) => {
            if (!err) {
              // Immediately announce presence to everyone in the room across the internet
              this.broadcastPacket({
                type: 'JOIN_REQUEST',
                user: this.user
              });
            }
          });
        });

        client.on('message', (topic, messageBuffer) => {
          if (topic !== this.topic) return;
          try {
            const packet = JSON.parse(messageBuffer.toString());
            this._handleIncomingPacket(packet);
          } catch (_) {}
        });

        this.mqttClients.push(client);
      } catch (err) {
        console.warn('Broker connection error:', brokerUrl, err);
      }
    });
  }

  broadcastPacket(packet) {
    const packetId = `${this.user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const payload = {
      ...packet,
      packetId,
      roomId: this.roomId,
      senderId: this.user.id,
      user: this.user,
      timestamp: Date.now()
    };

    this.seenPacketIds.add(packetId);
    if (this.seenPacketIds.size > 600) {
      const first = this.seenPacketIds.values().next().value;
      this.seenPacketIds.delete(first);
    }

    // 1. Local BroadcastChannel
    if (this.channel) {
      try {
        this.channel.postMessage(payload);
      } catch (_) {}
    }

    // 2. LocalStorage event fallback
    try {
      localStorage.setItem(`codesync_pkt_${this.roomId}`, JSON.stringify(payload));
    } catch (_) {}

    // 3. Global Persistent WebSocket MQTT Brokers (for cross-device & cross-browser sync)
    const serialized = JSON.stringify(payload);
    this.mqttClients.forEach((client) => {
      if (client && client.connected) {
        try {
          client.publish(this.topic, serialized, { qos: 0 });
        } catch (_) {}
      }
    });
  }

  _saveRoomToStorage() {
    try {
      localStorage.setItem(`codesync_room_${this.roomId}`, JSON.stringify(this.state));
    } catch (_) {}
  }

  _handleIncomingPacket(pkt) {
    if (!pkt || pkt.senderId === this.user.id || pkt.roomId !== this.roomId) return;

    // Deduplicate packets received across multiple redundant brokers
    if (pkt.packetId) {
      if (this.seenPacketIds.has(pkt.packetId)) return;
      this.seenPacketIds.add(pkt.packetId);
      if (this.seenPacketIds.size > 600) {
        const first = this.seenPacketIds.values().next().value;
        this.seenPacketIds.delete(first);
      }
    }

    const isNewPeer = !this.peers.has(pkt.senderId);

    if (pkt.user && pkt.type !== 'USER_LEAVE') {
      const existingPeer = this.peers.get(pkt.senderId) || {};
      this.peers.set(pkt.senderId, {
        ...existingPeer,
        ...pkt.user,
        lastSeen: Date.now()
      });
    }

    // If we just discovered a peer we didn't know about (even via HEARTBEAT or CURSOR_MOVE),
    // send them our presence and current room state so both sides are 100% synced!
    if (isNewPeer && pkt.type !== 'USER_LEAVE' && pkt.type !== 'JOIN_REQUEST') {
      this.broadcastPacket({
        type: 'STATE_SNAPSHOT',
        targetId: pkt.senderId,
        state: this.state
      });
    }

    switch (pkt.type) {
      case 'JOIN_REQUEST':
        // Reply with our presence and current room state snapshot
        this.broadcastPacket({
          type: 'STATE_SNAPSHOT',
          targetId: pkt.senderId,
          state: this.state
        });
        this._emitPresence();
        break;

      case 'STATE_SNAPSHOT':
        if (!pkt.targetId || pkt.targetId === this.user.id) {
          if (pkt.state && Array.isArray(pkt.state.files)) {
            const incomingMod = pkt.state.lastModified || 0;
            const localMod = this.state.lastModified || 0;
            // Adopt incoming state if our room is untouched or incoming state has newer edits
            if (incomingMod >= localMod) {
              this.state = {
                ...pkt.state,
                lastModified: incomingMod
              };
              this._saveRoomToStorage();
              this.onStateSync?.(this.state);
            }
          }
        }
        this._emitPresence();
        break;

      case 'HEARTBEAT':
      case 'USER_UPDATE':
        this._emitPresence();
        break;

      case 'CURSOR_MOVE':
        if (this.peers.has(pkt.senderId)) {
          const peer = this.peers.get(pkt.senderId);
          peer.cursor = pkt.cursor;
          peer.selection = pkt.selection;
          peer.activeFileId = pkt.activeFileId;
          peer.isTyping = pkt.isTyping;
          peer.lastSeen = Date.now();
          this.peers.set(pkt.senderId, peer);
          this._emitPresence();
        }
        break;

      case 'CODE_EDIT': {
        const file = this.state.files.find(f => f.id === pkt.fileId);
        if (file && file.content !== pkt.content) {
          file.content = pkt.content;
          file.updatedBy = pkt.user?.name || 'Collaborator';
          file.updatedAt = pkt.timestamp;
          this.state.lastModified = pkt.timestamp;
          this._saveRoomToStorage();
          this.onRemoteCodeChange?.(pkt);
        }
        if (this.peers.has(pkt.senderId)) {
          const peer = this.peers.get(pkt.senderId);
          peer.cursor = pkt.cursor || peer.cursor;
          peer.activeFileId = pkt.fileId;
          peer.isTyping = true;
          peer.lastSeen = Date.now();
          this.peers.set(pkt.senderId, peer);
          this._emitPresence();
        }
        break;
      }

      case 'STDIN_EDIT': {
        const targetFile = this.state.files.find(f => f.id === pkt.fileId);
        if (targetFile) {
          targetFile.stdin = pkt.stdin;
        } else {
          this.state.stdin = pkt.stdin;
        }
        this.state.lastModified = pkt.timestamp;
        this._saveRoomToStorage();
        this.onRemoteCodeChange?.({ type: 'STDIN_EDIT', fileId: pkt.fileId, stdin: pkt.stdin });
        break;
      }

      case 'TABS_UPDATE':
        if (Array.isArray(pkt.files)) {
          this.state.files = pkt.files;
          this.state.lastModified = pkt.timestamp;
          this._saveRoomToStorage();
          this.onTabChange?.(pkt.files, pkt.activeFileId);
        }
        break;

      case 'CHAT_MESSAGE':
        if (!this.state.chat.some(m => m.id === pkt.message?.id)) {
          this.state.chat.push(pkt.message);
          this._saveRoomToStorage();
          this.onChatMessage?.(pkt.message);
        }
        break;

      case 'EXECUTION_RESULT': {
        const execFileId = pkt.fileId || pkt.execution?.fileId;
        const targetFile = this.state.files.find(f => f.id === execFileId);
        if (targetFile) {
          targetFile.lastExecution = pkt.execution;
          this._saveRoomToStorage();
        }
        this.state.lastExecution = pkt.execution;
        this.onRemoteExecution?.(pkt.execution, execFileId);
        break;
      }

      case 'USER_LEAVE':
        this.peers.delete(pkt.senderId);
        this._emitPresence();
        break;
    }
  }

  updateLocalUser(patch) {
    this.user = { ...this.user, ...patch };
    this.broadcastPacket({
      type: 'USER_UPDATE'
    });
    this._emitPresence();
  }

  sendCursorUpdate({ activeFileId, cursor, selection, isTyping = false }) {
    this.user.activeFileId = activeFileId;
    this.user.cursor = cursor;
    this.user.selection = selection;
    this.user.isTyping = isTyping;

    const now = Date.now();
    if (!isTyping && this._lastCursorSent && now - this._lastCursorSent < 60) {
      return;
    }
    this._lastCursorSent = now;

    this.broadcastPacket({
      type: 'CURSOR_MOVE',
      activeFileId,
      cursor,
      selection,
      isTyping
    });
  }

  sendCodeChange(fileId, content, cursor) {
    if (this.user.role === 'observer') return;
    const now = Date.now();
    const file = this.state.files.find(f => f.id === fileId);
    if (file) {
      file.content = content;
      file.updatedBy = this.user.name;
      file.updatedAt = now;
      this.state.lastModified = now;
      this._saveRoomToStorage();
    }

    this.broadcastPacket({
      type: 'CODE_EDIT',
      fileId,
      content,
      cursor
    });
  }

  sendStdinChange(fileId, stdin) {
    const targetFile = this.state.files.find(f => f.id === fileId);
    if (targetFile) {
      targetFile.stdin = stdin;
    } else {
      this.state.stdin = stdin;
    }
    this.state.lastModified = Date.now();
    this._saveRoomToStorage();
    this.broadcastPacket({
      type: 'STDIN_EDIT',
      fileId,
      stdin
    });
  }

  updateFilesList(files, activeFileId) {
    this.state.files = files;
    this.state.lastModified = Date.now();
    this._saveRoomToStorage();
    this.broadcastPacket({
      type: 'TABS_UPDATE',
      files,
      activeFileId
    });
  }

  sendChatMessage(text, isSystem = false) {
    const message = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      senderId: this.user.id,
      senderName: isSystem ? 'System' : this.user.name,
      senderColor: isSystem ? '#94a3b8' : this.user.color,
      senderRole: this.user.role,
      text,
      isSystem,
      timestamp: Date.now()
    };
    this.state.chat.push(message);
    this._saveRoomToStorage();
    this.onChatMessage?.(message);

    this.broadcastPacket({
      type: 'CHAT_MESSAGE',
      message
    });
  }

  broadcastExecutionResult(fileId, execution) {
    const targetFile = this.state.files.find(f => f.id === fileId);
    if (targetFile) {
      targetFile.lastExecution = execution;
      this._saveRoomToStorage();
    }
    this.state.lastExecution = execution;
    this.broadcastPacket({
      type: 'EXECUTION_RESULT',
      fileId,
      execution
    });
  }

  _pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      // Allow 15 seconds (6 missed heartbeats) before pruning
      if (now - (peer.lastSeen || 0) > 15000) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this._emitPresence();
    }
  }

  _emitPresence() {
    const allUsers = [
      { ...this.user, isSelf: true },
      ...Array.from(this.peers.values()).map(p => ({ ...p, isSelf: false }))
    ];
    this.onPresenceUpdate?.(allUsers);
  }

  destroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.broadcastPacket({ type: 'USER_LEAVE' });
    if (this.channel) this.channel.close();
    this.mqttClients.forEach((client) => {
      try {
        client.end(true);
      } catch (_) {}
    });
    if (this._storageListener) {
      window.removeEventListener('storage', this._storageListener);
    }
    if (this._unloadListener) {
      window.removeEventListener('beforeunload', this._unloadListener);
    }
  }
}
