// Real-Time Collaboration Engine (Google Docs-style Presence, Cursors, Multi-Tab & P2P Sync)
import { LANGUAGES } from './compilers.js';

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
    this.user = user; // { id, name, email, authProvider, color, bg, role: 'editor' | 'observer', activeFileId, cursor, selection, isTyping }
    this.onStateSync = onStateSync;
    this.onRemoteCodeChange = onRemoteCodeChange;
    this.onPresenceUpdate = onPresenceUpdate;
    this.onChatMessage = onChatMessage;
    this.onRemoteExecution = onRemoteExecution;
    this.onTabChange = onTabChange;

    this.peers = new Map(); // peerId -> peerUserObject
    this.channel = null;
    this.wsRelay = null;
    this.heartbeatInterval = null;

    // Shared room document state
    this.state = {
      roomId: this.roomId,
      files: [
        {
          id: 'file-cpp',
          name: 'main.cpp',
          language: 'cpp',
          content: LANGUAGES.cpp.starterCode,
          updatedBy: 'System',
          updatedAt: Date.now()
        },
        {
          id: 'file-py',
          name: 'solution.py',
          language: 'python',
          content: LANGUAGES.python.starterCode,
          updatedBy: 'System',
          updatedAt: Date.now()
        },
        {
          id: 'file-js',
          name: 'index.js',
          language: 'javascript',
          content: LANGUAGES.javascript.starterCode,
          updatedBy: 'System',
          updatedAt: Date.now()
        }
      ],
      stdin: 'CodeSyncer\n',
      chat: [],
      lastExecution: null
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
        }
      } catch (e) {
        console.warn('Could not parse saved room state:', e);
      }
    }

    // 2. Setup BroadcastChannel for instant multi-tab sync
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(`codesync_channel_${this.roomId}`);
      this.channel.onmessage = (event) => {
        this._handleIncomingPacket(event.data);
      };
    }

    // 3. Setup storage event fallback for cross-window sync
    this._storageListener = (e) => {
      if (e.key === `codesync_pkt_${this.roomId}` && e.newValue) {
        try {
          const pkt = JSON.parse(e.newValue);
          this._handleIncomingPacket(pkt);
        } catch (_) {}
      }
    };
    window.addEventListener('storage', this._storageListener);

    // 4. Connect to public WebSocket signaling relay for cross-device sync
    this._connectPublicRelay();

    // 5. Announce presence & start heartbeat
    this.broadcastPacket({
      type: 'JOIN_REQUEST',
      senderId: this.user.id,
      user: this.user
    });

    this.heartbeatInterval = setInterval(() => {
      this._pruneStalePeers();
      this.broadcastPacket({
        type: 'HEARTBEAT',
        senderId: this.user.id,
        user: { ...this.user, lastSeen: Date.now() }
      });
    }, 2000);

    // Notify initial state
    this.onStateSync?.(this.state);
    this._emitPresence();
  }

  _connectPublicRelay() {
    try {
      const topic = `codesync_v1_room_${this.roomId.replace(/[^A-Z0-9_-]/gi, '')}`;
      const ws = new WebSocket(`wss://ntfy.sh/${topic}/ws`);

      ws.onopen = () => {
        this.wsRelay = ws;
        this.broadcastPacket({
          type: 'JOIN_REQUEST',
          senderId: this.user.id,
          user: this.user
        });
      };

      ws.onmessage = (evt) => {
        try {
          const wrapper = JSON.parse(evt.data);
          if (wrapper.event === 'message' && wrapper.message) {
            const packet = JSON.parse(wrapper.message);
            this._handleIncomingPacket(packet, true);
          }
        } catch (_) {}
      };

      ws.onerror = () => {
        this.wsRelay = null;
      };
      ws.onclose = () => {
        this.wsRelay = null;
      };
    } catch (_) {
      this.wsRelay = null;
    }
  }

  broadcastPacket(packet, skipRemoteRelay = false) {
    const payload = {
      ...packet,
      roomId: this.roomId,
      senderId: this.user.id,
      timestamp: Date.now()
    };

    if (this.channel) {
      try {
        this.channel.postMessage(payload);
      } catch (_) {}
    }

    try {
      localStorage.setItem(`codesync_pkt_${this.roomId}`, JSON.stringify(payload));
    } catch (_) {}

    if (!skipRemoteRelay && packet.type !== 'HEARTBEAT') {
      this._sendToPublicRelay(payload);
    }
  }

  _sendToPublicRelay(payload) {
    const topic = `codesync_v1_room_${this.roomId.replace(/[^A-Z0-9_-]/gi, '')}`;
    if (payload.type === 'CURSOR_MOVE') {
      const now = Date.now();
      if (this._lastRelayCursor && now - this._lastRelayCursor < 350) return;
      this._lastRelayCursor = now;
    }
    fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  _saveRoomToStorage() {
    try {
      localStorage.setItem(`codesync_room_${this.roomId}`, JSON.stringify(this.state));
    } catch (_) {}
  }

  _handleIncomingPacket(pkt) {
    if (!pkt || pkt.senderId === this.user.id || pkt.roomId !== this.roomId) return;

    if (pkt.user) {
      this.peers.set(pkt.senderId, {
        ...pkt.user,
        lastSeen: Date.now()
      });
    }

    switch (pkt.type) {
      case 'JOIN_REQUEST':
        this.broadcastPacket({
          type: 'STATE_SNAPSHOT',
          targetId: pkt.senderId,
          user: this.user,
          state: this.state
        }, false);
        this._emitPresence();
        break;

      case 'STATE_SNAPSHOT':
        if (!pkt.targetId || pkt.targetId === this.user.id) {
          if (pkt.state && Array.isArray(pkt.state.files)) {
            this.state = pkt.state;
            this._saveRoomToStorage();
            this.onStateSync?.(this.state);
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

      case 'STDIN_EDIT':
        this.state.stdin = pkt.stdin;
        this._saveRoomToStorage();
        this.onRemoteCodeChange?.({ type: 'STDIN_EDIT', stdin: pkt.stdin });
        break;

      case 'TABS_UPDATE':
        if (Array.isArray(pkt.files)) {
          this.state.files = pkt.files;
          this._saveRoomToStorage();
          this.onTabChange?.(pkt.files, pkt.activeFileId);
        }
        break;

      case 'CHAT_MESSAGE':
        this.state.chat.push(pkt.message);
        this._saveRoomToStorage();
        this.onChatMessage?.(pkt.message);
        break;

      case 'EXECUTION_RESULT':
        this.state.lastExecution = pkt.execution;
        this.onRemoteExecution?.(pkt.execution);
        break;

      case 'USER_LEAVE':
        this.peers.delete(pkt.senderId);
        this._emitPresence();
        break;
    }
  }

  updateLocalUser(patch) {
    this.user = { ...this.user, ...patch };
    this.broadcastPacket({
      type: 'USER_UPDATE',
      user: this.user
    });
    this._emitPresence();
  }

  sendCursorUpdate({ activeFileId, cursor, selection, isTyping = false }) {
    this.user.activeFileId = activeFileId;
    this.user.cursor = cursor;
    this.user.selection = selection;
    this.user.isTyping = isTyping;

    this.broadcastPacket({
      type: 'CURSOR_MOVE',
      user: this.user,
      activeFileId,
      cursor,
      selection,
      isTyping
    });
  }

  sendCodeChange(fileId, content, cursor) {
    if (this.user.role === 'observer') return;
    const file = this.state.files.find(f => f.id === fileId);
    if (file) {
      file.content = content;
      file.updatedBy = this.user.name;
      file.updatedAt = Date.now();
      this._saveRoomToStorage();
    }

    this.broadcastPacket({
      type: 'CODE_EDIT',
      user: this.user,
      fileId,
      content,
      cursor
    });
  }

  sendStdinChange(stdin) {
    this.state.stdin = stdin;
    this._saveRoomToStorage();
    this.broadcastPacket({
      type: 'STDIN_EDIT',
      user: this.user,
      stdin
    });
  }

  updateFilesList(files, activeFileId) {
    this.state.files = files;
    this._saveRoomToStorage();
    this.broadcastPacket({
      type: 'TABS_UPDATE',
      user: this.user,
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
      user: this.user,
      message
    });
  }

  broadcastExecutionResult(execution) {
    this.state.lastExecution = execution;
    this.broadcastPacket({
      type: 'EXECUTION_RESULT',
      user: this.user,
      execution
    });
  }

  _pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (now - (peer.lastSeen || 0) > 8500) {
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
    if (this.wsRelay) this.wsRelay.close();
    if (this._storageListener) {
      window.removeEventListener('storage', this._storageListener);
    }
  }
}
