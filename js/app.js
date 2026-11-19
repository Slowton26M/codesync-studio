import { LANGUAGES, USER_COLORS, compileAndRunCode } from './compilers.js';
import { RoomCollaborationEngine } from './collab.js';

const DEFAULT_PERSONAS = [
  'Guest Developer',
  'Alex Rivera',
  'Jordan Chen',
  'Taylor Kim',
  'Morgan Vance',
  'Casey Patel',
  'Riley Novak',
  'Quinn Sterling'
];

class CodeSyncApp {
  constructor() {
    this.editor = null;
    this.monaco = null;
    this.collab = null;
    this.activeFileId = 'file-cpp';
    this.followingUserId = null;
    this.isApplyingRemoteEdit = false;
    this.remoteDecorations = [];
    this.typingTimeout = null;
    this.allUsers = [];
    this.authTabMode = 'signin'; // 'signin' | 'signup'

    this._initIdentityAndRoom();
    this._bindDOMEvents();
    this._updateAuthHeaderUI();
    this._loadMonacoEditor();
  }

  _initIdentityAndRoom() {
    const params = new URLSearchParams(window.location.search);
    let roomParam = params.get('room');
    if (!roomParam) {
      roomParam = 'SYNC-' + Math.random().toString(36).substring(2, 6).toUpperCase();
      const newUrl = `${window.location.pathname}?room=${roomParam}`;
      window.history.replaceState({}, '', newUrl);
    }
    this.roomId = roomParam.toUpperCase();

    // 1. Check if user has an active authenticated session (Google or CodeSync Account)
    let activeAccount = null;
    try {
      activeAccount = JSON.parse(localStorage.getItem('codesync_active_account_v1'));
    } catch (_) {}

    // 2. Otherwise check per-tab guest session
    let savedUser = null;
    try {
      savedUser = JSON.parse(sessionStorage.getItem('codesync_tab_user'));
    } catch (_) {}

    if (activeAccount && activeAccount.email) {
      const colorObj = USER_COLORS.find(c => c.hex === activeAccount.color) || USER_COLORS[0];
      savedUser = {
        id: savedUser?.id || ('usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6)),
        name: activeAccount.name,
        email: activeAccount.email,
        authProvider: activeAccount.authProvider || 'account', // 'google' | 'account'
        color: colorObj.hex,
        bg: colorObj.bg,
        role: savedUser?.role || 'editor',
        activeFileId: savedUser?.activeFileId || 'file-cpp',
        cursor: { lineNumber: 1, column: 1 },
        selection: null,
        isTyping: false
      };
      sessionStorage.setItem('codesync_tab_user', JSON.stringify(savedUser));
    } else if (!savedUser) {
      const tabIndex = Math.floor(Math.random() * USER_COLORS.length);
      const colorObj = USER_COLORS[tabIndex];
      const personaName = DEFAULT_PERSONAS[tabIndex % DEFAULT_PERSONAS.length];
      savedUser = {
        id: 'usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
        name: personaName,
        email: null,
        authProvider: 'guest',
        color: colorObj.hex,
        bg: colorObj.bg,
        role: 'editor',
        activeFileId: 'file-cpp',
        cursor: { lineNumber: 1, column: 1 },
        selection: null,
        isTyping: false
      };
      sessionStorage.setItem('codesync_tab_user', JSON.stringify(savedUser));
    }

    this.currentUser = savedUser;
    document.getElementById('room-code-display').textContent = this.roomId;
  }

  _updateAuthHeaderUI() {
    const signInBtn = document.getElementById('btn-auth-trigger');
    const isAuthed = this.currentUser.authProvider === 'google' || this.currentUser.authProvider === 'account';

    if (isAuthed && this.currentUser.email) {
      signInBtn.classList.add('hidden');
    } else {
      signInBtn.classList.remove('hidden');
    }
  }

  _loadMonacoEditor() {
    const startCollabAndMount = () => {
      this._initCollabEngine();
      this._renderFileTabs();
      this._syncEditorToActiveFile();
    };

    if (window.monaco) {
      this.monaco = window.monaco;
      this._createMonacoInstance();
      startCollabAndMount();
      return;
    }

    if (window.require) {
      window.require.config({
        paths: {
          vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.47.0/min/vs'
        }
      });
      window.require(['vs/editor/editor.main'], () => {
        this.monaco = window.monaco;
        this._createMonacoInstance();
        startCollabAndMount();
      });
    } else {
      window.addEventListener('load', () => this._loadMonacoEditor(), { once: true });
    }
  }

  _createMonacoInstance() {
    this.monaco.editor.defineTheme('codesync-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
        { token: 'keyword', foreground: '818cf8' },
        { token: 'string', foreground: '34d399' },
        { token: 'number', foreground: 'fbbf24' },
        { token: 'type', foreground: '38bdf8' }
      ],
      colors: {
        'editor.background': '#080a0f',
        'editor.foreground': '#f1f5f9',
        'editorLineNumber.foreground': '#475569',
        'editorLineNumber.activeForeground': '#cbd5e1',
        'editor.lineHighlightBackground': '#111622',
        'editorCursor.foreground': this.currentUser.color,
        'editor.selectionBackground': 'rgba(99, 102, 241, 0.25)'
      }
    });

    const container = document.getElementById('monaco-editor-container');
    this.editor = this.monaco.editor.create(container, {
      value: LANGUAGES.cpp.starterCode,
      language: 'cpp',
      theme: 'codesync-dark',
      fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      fontSize: 14,
      lineHeight: 22,
      fontLigatures: true,
      minimap: { enabled: true, scale: 0.75 },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 14, bottom: 14 },
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      readOnly: this.currentUser.role === 'observer'
    });

    this.editor.onDidChangeModelContent(() => {
      if (this.isApplyingRemoteEdit) return;
      if (this.currentUser.role === 'observer') return;

      const content = this.editor.getValue();
      const pos = this.editor.getPosition();

      if (this.collab) {
        this.collab.sendCodeChange(this.activeFileId, content, pos);
      }

      clearTimeout(this.typingTimeout);
      this.typingTimeout = setTimeout(() => {
        if (this.collab) {
          this.collab.sendCursorUpdate({
            activeFileId: this.activeFileId,
            cursor: this.editor.getPosition(),
            selection: this.editor.getSelection(),
            isTyping: false
          });
        }
      }, 900);
    });

    this.editor.onDidChangeCursorSelection((e) => {
      if (!this.collab) return;
      const pos = e.selection.getPosition();
      const sel = e.selection.isEmpty() ? null : {
        startLineNumber: e.selection.startLineNumber,
        startColumn: e.selection.startColumn,
        endLineNumber: e.selection.endLineNumber,
        endColumn: e.selection.endColumn
      };

      this.collab.sendCursorUpdate({
        activeFileId: this.activeFileId,
        cursor: { lineNumber: pos.lineNumber, column: pos.column },
        selection: sel,
        isTyping: false
      });
    });

    this.editor.onDidScrollChange(() => this._renderRemoteCursorsInEditor());
    this.editor.onDidLayoutChange(() => this._renderRemoteCursorsInEditor());

    this.editor.addCommand(this.monaco.KeyMod.CtrlCmd | this.monaco.KeyCode.Enter, () => {
      this.handleCompileAndRun();
    });
  }

  _initCollabEngine() {
    this.collab = new RoomCollaborationEngine({
      roomId: this.roomId,
      user: this.currentUser,
      onStateSync: (state) => {
        if (!state.files.some(f => f.id === this.activeFileId)) {
          this.activeFileId = state.files[0].id;
        }
        document.getElementById('stdin-input').value = state.stdin || '';
        this._renderFileTabs();
        this._syncEditorToActiveFile();
        this._renderAllChatMessages(state.chat);
      },
      onRemoteCodeChange: (pkt) => {
        if (pkt.type === 'STDIN_EDIT') {
          const stdinEl = document.getElementById('stdin-input');
          if (document.activeElement !== stdinEl) {
            stdinEl.value = pkt.stdin;
          }
          return;
        }

        if (pkt.fileId === this.activeFileId && this.editor) {
          const currentPos = this.editor.getPosition();
          if (this.editor.getValue() !== pkt.content) {
            this.isApplyingRemoteEdit = true;
            this.editor.setValue(pkt.content);
            if (currentPos) this.editor.setPosition(currentPos);
            this.isApplyingRemoteEdit = false;
          }
        }
      },
      onPresenceUpdate: (users) => {
        this.allUsers = users;
        this._renderPresenceUI(users);
        this._renderFileTabs();
        this._renderRemoteCursorsInEditor();

        if (this.followingUserId) {
          const target = users.find(u => u.id === this.followingUserId);
          if (target) {
            if (target.activeFileId && target.activeFileId !== this.activeFileId) {
              this.switchFileTab(target.activeFileId, true);
            }
            if (target.cursor && this.editor) {
              this.editor.revealLineInCenterIfOutsideViewport(target.cursor.lineNumber);
            }
          }
        }
      },
      onChatMessage: (msg) => {
        this._appendChatMessage(msg);
      },
      onRemoteExecution: (execResult) => {
        this._displayExecutionOutput(execResult, true);
      },
      onTabChange: (files) => {
        if (!files.some(f => f.id === this.activeFileId)) {
          this.activeFileId = files[0]?.id;
        }
        this._renderFileTabs();
        this._syncEditorToActiveFile();
      }
    });

    this.collab.init();
  }

  _syncEditorToActiveFile() {
    if (!this.editor || !this.collab) return;
    const file = this.collab.state.files.find(f => f.id === this.activeFileId) || this.collab.state.files[0];
    if (!file) return;

    this.activeFileId = file.id;
    const langObj = LANGUAGES[file.language] || LANGUAGES.cpp;

    const selectEl = document.getElementById('language-select');
    if (selectEl) selectEl.value = file.language;

    this.isApplyingRemoteEdit = true;
    const model = this.editor.getModel();
    if (model) {
      this.monaco.editor.setModelLanguage(model, langObj.monacoLang);
    }
    if (this.editor.getValue() !== file.content) {
      this.editor.setValue(file.content);
    }
    this.isApplyingRemoteEdit = false;

    this._renderRemoteCursorsInEditor();
  }

  switchFileTab(fileId, fromFollow = false) {
    if (!fromFollow) {
      this.followingUserId = null;
    }
    this.activeFileId = fileId;
    this.currentUser.activeFileId = fileId;
    this._renderFileTabs();
    this._syncEditorToActiveFile();

    if (this.collab) {
      this.collab.sendCursorUpdate({
        activeFileId: fileId,
        cursor: this.editor ? this.editor.getPosition() : { lineNumber: 1, column: 1 },
        selection: null,
        isTyping: false
      });
    }
  }

  _renderFileTabs() {
    if (!this.collab) return;
    const listEl = document.getElementById('file-tabs-list');
    listEl.innerHTML = '';

    const files = this.collab.state.files;
    files.forEach((file) => {
      const lang = LANGUAGES[file.language] || LANGUAGES.cpp;
      const isActive = file.id === this.activeFileId;

      const peersOnFile = this.allUsers.filter(u => !u.isSelf && u.activeFileId === file.id);

      const tab = document.createElement('button');
      tab.className = `file-tab ${isActive ? 'active' : ''}`;
      tab.innerHTML = `
        <span class="file-lang-dot" style="background:${lang.color}"></span>
        <span>${this._escapeHtml(file.name)}</span>
        <span class="file-tab-peers">
          ${peersOnFile.map(p => `<span class="file-peer-pip" style="background:${p.color}" title="${this._escapeHtml(p.name)}"></span>`).join('')}
        </span>
        ${files.length > 1 && this.currentUser.role === 'editor' ? `<span class="file-tab-close" data-close-id="${file.id}" title="Close file">&times;</span>` : ''}
      `;

      tab.addEventListener('click', (e) => {
        const closeId = e.target.getAttribute('data-close-id');
        if (closeId) {
          e.stopPropagation();
          this._deleteFileTab(closeId);
          return;
        }
        this.switchFileTab(file.id);
      });

      listEl.appendChild(tab);
    });
  }

  _addNewFileTab(langId = 'cpp') {
    if (this.currentUser.role === 'observer') {
      this.showToast('Switch to Editor mode to create new files.');
      return;
    }
    const lang = LANGUAGES[langId] || LANGUAGES.cpp;
    const count = this.collab.state.files.filter(f => f.language === langId).length + 1;
    const baseName = lang.defaultFileName.replace('.', count > 1 ? `_${count}.` : '.');
    const newFile = {
      id: 'file-' + Date.now().toString(36),
      name: baseName,
      language: langId,
      content: lang.starterCode,
      updatedBy: this.currentUser.name,
      updatedAt: Date.now()
    };

    const updatedFiles = [...this.collab.state.files, newFile];
    this.activeFileId = newFile.id;
    this.collab.updateFilesList(updatedFiles, this.activeFileId);
    this._renderFileTabs();
    this._syncEditorToActiveFile();
    this.collab.sendChatMessage(`${this.currentUser.name} created ${newFile.name}`, true);
  }

  _deleteFileTab(fileId) {
    if (this.collab.state.files.length <= 1) return;
    const target = this.collab.state.files.find(f => f.id === fileId);
    const remaining = this.collab.state.files.filter(f => f.id !== fileId);
    if (this.activeFileId === fileId) {
      this.activeFileId = remaining[0].id;
    }
    this.collab.updateFilesList(remaining, this.activeFileId);
    this._renderFileTabs();
    this._syncEditorToActiveFile();
    if (target) {
      this.collab.sendChatMessage(`${this.currentUser.name} removed ${target.name}`, true);
    }
  }

  _renderRemoteCursorsInEditor() {
    if (!this.editor || !this.monaco) return;
    const overlay = document.getElementById('remote-cursor-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';

    const remotePeersOnFile = this.allUsers.filter(
      u => !u.isSelf && u.activeFileId === this.activeFileId && u.cursor
    );

    const newDecorations = [];

    remotePeersOnFile.forEach((peer) => {
      const lineNumber = peer.cursor.lineNumber || 1;
      const column = peer.cursor.column || 1;

      if (peer.selection) {
        const className = this._ensureDynamicSelectionCss(peer.id, peer.bg, peer.color);
        newDecorations.push({
          range: new this.monaco.Range(
            peer.selection.startLineNumber,
            peer.selection.startColumn,
            peer.selection.endLineNumber,
            peer.selection.endColumn
          ),
          options: {
            className: className,
            stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        });
      }

      const coords = this.editor.getScrolledVisiblePosition({ lineNumber, column });
      if (!coords) return;

      const caret = document.createElement('div');
      caret.className = 'remote-caret-bar';
      caret.style.backgroundColor = peer.color;
      caret.style.height = `${coords.height || 20}px`;
      caret.style.top = `${coords.top}px`;
      caret.style.left = `${coords.left}px`;

      const flag = document.createElement('div');
      flag.className = 'remote-cursor-flag';
      flag.style.backgroundColor = peer.color;
      flag.style.top = `${Math.max(18, coords.top)}px`;
      flag.style.left = `${coords.left}px`;
      const roleIcon = peer.role === 'observer' ? '👁' : (peer.isTyping ? '✎' : '');
      flag.textContent = `${peer.name} ${roleIcon}`.trim();

      overlay.appendChild(caret);
      overlay.appendChild(flag);
    });

    this.remoteDecorations = this.editor.deltaDecorations(this.remoteDecorations, newDecorations);
  }

  _ensureDynamicSelectionCss(peerId, bgRgba, borderHex) {
    const safeId = peerId.replace(/[^a-zA-Z0-9_-]/g, '');
    const className = `remote-sel-${safeId}`;
    if (!document.getElementById(`style-${className}`)) {
      const style = document.createElement('style');
      style.id = `style-${className}`;
      style.textContent = `
        .${className} {
          background-color: ${bgRgba || 'rgba(99, 102, 241, 0.25)'} !important;
          border-bottom: 1.5px solid ${borderHex || '#6366f1'};
        }
      `;
      document.head.appendChild(style);
    }
    return className;
  }

  _renderPresenceUI(users) {
    const stackEl = document.getElementById('presence-avatar-stack');
    stackEl.innerHTML = '';

    users.forEach((u) => {
      const initials = u.name
        .split(' ')
        .map(w => w[0])
        .join('')
        .substring(0, 2)
        .toUpperCase();

      const pill = document.createElement('div');
      pill.className = `presence-avatar ${this.followingUserId === u.id ? 'following' : ''}`;
      pill.style.setProperty('--user-color', u.color);
      pill.title = u.isSelf
        ? `${u.name} (You — click to customize color or switch room)`
        : `Click to follow ${u.name} (${u.role === 'observer' ? 'Observing' : 'Editing'})`;

      pill.innerHTML = `
        <span class="avatar-circle" style="background:${u.color}">${this._escapeHtml(initials)}</span>
        <span>${this._escapeHtml(u.name.split(' ')[0])}${u.isSelf ? ' (You)' : ''}</span>
        <span class="avatar-role-tag">${u.role === 'observer' ? 'Observing' : 'Editing'}</span>
      `;

      pill.addEventListener('click', () => {
        if (u.isSelf) {
          this.openProfileModal();
        } else {
          this._toggleFollowUser(u);
        }
      });

      stackEl.appendChild(pill);
    });

    const countEl = document.getElementById('participants-count');
    if (countEl) countEl.textContent = `${users.length} Online`;

    const listEl = document.getElementById('participants-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    users.forEach((u) => {
      const fileObj = this.collab?.state.files.find(f => f.id === u.activeFileId);
      const fileName = fileObj ? fileObj.name : 'main.cpp';
      const lineNum = u.cursor?.lineNumber || 1;
      const verifiedBadge = u.authProvider === 'google'
        ? '<span title="Verified Google Account" style="color:#38bdf8;font-size:11px;margin-left:4px">● Google</span>'
        : (u.authProvider === 'account' ? '<span title="Registered Account" style="color:#10b981;font-size:11px;margin-left:4px">✓</span>' : '');

      const card = document.createElement('div');
      card.className = 'participant-card';
      card.innerHTML = `
        <div class="participant-info">
          <div class="participant-swatch" style="background:${u.color}">
            ${this._escapeHtml(u.name.charAt(0).toUpperCase())}
          </div>
          <div class="participant-meta">
            <div class="participant-name">
              ${this._escapeHtml(u.name)}${verifiedBadge} ${u.isSelf ? '<span style="color:var(--text-muted);font-weight:400">(You)</span>' : ''}
            </div>
            <div class="participant-cursor-loc">
              ${this._escapeHtml(fileName)} : Ln ${lineNum} ${u.isTyping ? '• typing...' : ''}
            </div>
          </div>
        </div>
        <span class="role-pill ${u.role === 'observer' ? 'observer' : 'editor'}">
          ${u.role === 'observer' ? 'Observing' : 'Editing'}
        </span>
      `;
      listEl.appendChild(card);
    });
  }

  _toggleFollowUser(peer) {
    if (this.followingUserId === peer.id) {
      this.followingUserId = null;
      this.showToast(`Stopped following ${peer.name}`);
    } else {
      this.followingUserId = peer.id;
      this.showToast(`Following ${peer.name}'s cursor & active file`);
      if (peer.activeFileId && peer.activeFileId !== this.activeFileId) {
        this.switchFileTab(peer.activeFileId, true);
      }
      if (peer.cursor && this.editor) {
        this.editor.revealLineInCenter(peer.cursor.lineNumber);
      }
    }
    this._renderPresenceUI(this.allUsers);
  }

  setRoleMode(role) {
    this.currentUser.role = role;
    sessionStorage.setItem('codesync_tab_user', JSON.stringify(this.currentUser));

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.role === role);
    });

    const banner = document.getElementById('observer-banner');
    if (banner) {
      banner.classList.toggle('hidden', role !== 'observer');
    }

    if (this.editor) {
      this.editor.updateOptions({ readOnly: role === 'observer' });
    }

    if (this.collab) {
      this.collab.updateLocalUser({ role });
      this.collab.sendChatMessage(
        `${this.currentUser.name} switched to ${role === 'observer' ? 'Observer (Read-Only)' : 'Editor'} mode`,
        true
      );
    }
    this._renderFileTabs();
  }

  async handleCompileAndRun() {
    if (!this.editor || !this.collab) return;
    const runBtn = document.getElementById('btn-compile-run');
    const statusBadge = document.getElementById('exec-status-badge');
    const stdoutEl = document.getElementById('stdout-output');
    const stderrEl = document.getElementById('stderr-output');
    const metricsEl = document.getElementById('exec-metrics');

    const file = this.collab.state.files.find(f => f.id === this.activeFileId) || this.collab.state.files[0];
    const langId = document.getElementById('language-select').value || file.language;
    const code = this.editor.getValue();
    const stdin = document.getElementById('stdin-input').value;

    runBtn.disabled = true;
    statusBadge.className = 'exec-status-badge running';
    statusBadge.textContent = `Compiling ${LANGUAGES[langId]?.name || langId}...`;
    stdoutEl.textContent = 'Running remote compiler pipeline...';
    stderrEl.textContent = '';
    metricsEl.textContent = '';

    const result = await compileAndRunCode(langId, code, stdin);
    const enrichedResult = {
      ...result,
      fileName: file.name,
      languageName: LANGUAGES[langId]?.name || langId,
      triggeredBy: this.currentUser.name,
      timestamp: Date.now()
    };

    runBtn.disabled = false;
    this._displayExecutionOutput(enrichedResult, false);
    this.collab.broadcastExecutionResult(enrichedResult);
  }

  _displayExecutionOutput(res, isRemote = false) {
    const statusBadge = document.getElementById('exec-status-badge');
    const stdoutEl = document.getElementById('stdout-output');
    const stderrEl = document.getElementById('stderr-output');
    const metricsEl = document.getElementById('exec-metrics');
    const metaFooter = document.getElementById('output-meta-footer');

    if (res.success) {
      statusBadge.className = 'exec-status-badge success';
      statusBadge.textContent = `✓ Exit 0 (${res.languageName})`;
    } else {
      statusBadge.className = 'exec-status-badge error';
      statusBadge.textContent = res.stage === 'compile' ? '✕ Compilation Error' : `✕ Runtime Error (Exit ${res.exitCode})`;
    }

    stdoutEl.textContent = res.stdout || (res.success ? '(Program finished with no stdout output)' : '');
    stderrEl.textContent = res.stderr || '';
    metricsEl.textContent = `${res.timeMs} ms  •  ${(res.memoryKB / 1024).toFixed(2)} MB  •  ${res.engine}`;
    metaFooter.textContent = `Executed ${res.fileName} by ${res.triggeredBy}${isRemote ? ' (synced from peer)' : ''} at ${new Date(res.timestamp).toLocaleTimeString()}`;
  }

  _renderAllChatMessages(messages) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    messages.forEach(m => this._appendChatMessage(m));
  }

  _appendChatMessage(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const div = document.createElement('div');
    if (msg.isSystem) {
      div.className = 'chat-msg system';
      div.textContent = msg.text;
    } else {
      const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      div.className = 'chat-msg';
      div.innerHTML = `
        <div class="chat-msg-header">
          <span class="chat-sender" style="color:${msg.senderColor}">
            <span style="width:7px;height:7px;border-radius:50%;background:${msg.senderColor};display:inline-block"></span>
            ${this._escapeHtml(msg.senderName)}
          </span>
          <span class="chat-time">${timeStr}</span>
        </div>
        <div class="chat-text">${this._escapeHtml(msg.text)}</div>
      `;
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /* ============================================================================
   * Authentication System: Google Sign-In & Email/Password Create Account / Login
   * ============================================================================ */

  openAuthModal(defaultTab = 'signin') {
    const modal = document.getElementById('auth-modal');
    document.getElementById('google-picker-drawer').classList.add('hidden');
    document.getElementById('auth-error-msg').classList.add('hidden');
    this._switchAuthTab(defaultTab);
    this._renderAuthColorSwatches();
    modal.classList.remove('hidden');
  }

  _switchAuthTab(tab) {
    this.authTabMode = tab;
    document.querySelectorAll('.auth-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.authTab === tab);
    });

    const isSignup = tab === 'signup';
    document.getElementById('auth-name-group').classList.toggle('hidden', !isSignup);
    document.getElementById('auth-color-group').classList.toggle('hidden', !isSignup);
    document.getElementById('auth-name-input').required = isSignup;
    document.getElementById('btn-auth-submit').textContent = isSignup
      ? 'Create Account & Join Room'
      : 'Sign In to CodeSync';
    document.getElementById('auth-error-msg').classList.add('hidden');
  }

  _renderAuthColorSwatches() {
    const container = document.getElementById('auth-color-swatches');
    const modal = document.getElementById('auth-modal');
    container.innerHTML = '';

    let selectedColor = USER_COLORS.find(c => c.hex === this.currentUser.color) || USER_COLORS[0];
    modal.dataset.selectedHex = selectedColor.hex;
    modal.dataset.selectedBg = selectedColor.bg;

    USER_COLORS.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `color-swatch-btn ${c.hex === selectedColor.hex ? 'selected' : ''}`;
      btn.style.backgroundColor = c.hex;
      btn.title = c.name;
      btn.addEventListener('click', () => {
        selectedColor = c;
        modal.dataset.selectedHex = c.hex;
        modal.dataset.selectedBg = c.bg;
        container.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      container.appendChild(btn);
    });
  }

  _getStoredAccounts() {
    try {
      return JSON.parse(localStorage.getItem('codesync_accounts_v1')) || [];
    } catch (_) {
      return [];
    }
  }

  _saveStoredAccounts(accounts) {
    try {
      localStorage.setItem('codesync_accounts_v1', JSON.stringify(accounts));
    } catch (_) {}
  }

  _completeSignIn({ name, email, color, bg, authProvider }) {
    const colorObj = USER_COLORS.find(c => c.hex === color) || USER_COLORS[0];
    const activeAccount = {
      name,
      email: email.toLowerCase(),
      color: colorObj.hex,
      bg: bg || colorObj.bg,
      authProvider // 'google' | 'account'
    };

    localStorage.setItem('codesync_active_account_v1', JSON.stringify(activeAccount));

    this.currentUser.name = activeAccount.name;
    this.currentUser.email = activeAccount.email;
    this.currentUser.color = activeAccount.color;
    this.currentUser.bg = activeAccount.bg;
    this.currentUser.authProvider = activeAccount.authProvider;
    sessionStorage.setItem('codesync_tab_user', JSON.stringify(this.currentUser));

    document.getElementById('auth-modal').classList.add('hidden');
    this._updateAuthHeaderUI();

    if (this.collab) {
      this.collab.updateLocalUser({
        name: this.currentUser.name,
        email: this.currentUser.email,
        color: this.currentUser.color,
        bg: this.currentUser.bg,
        authProvider: this.currentUser.authProvider
      });
      this.collab.sendChatMessage(
        `${this.currentUser.name} signed in via ${authProvider === 'google' ? 'Google' : 'CodeSync Account'}`,
        true
      );
    }

    this.showToast(`Signed in as ${this.currentUser.name} (${this.currentUser.email})`);
  }

  signOut() {
    localStorage.removeItem('codesync_active_account_v1');
    const prevName = this.currentUser.name;
    this.currentUser.authProvider = 'guest';
    this.currentUser.email = null;
    sessionStorage.setItem('codesync_tab_user', JSON.stringify(this.currentUser));

    this._updateAuthHeaderUI();
    document.getElementById('profile-modal').classList.add('hidden');

    if (this.collab) {
      this.collab.updateLocalUser({
        authProvider: 'guest',
        email: null
      });
      this.collab.sendChatMessage(`${prevName} signed out to Guest mode`, true);
    }

    this.showToast('Signed out. You are now browsing as Guest.');
  }

  _toggleGoogleAccountDrawer() {
    const drawer = document.getElementById('google-picker-drawer');
    const isHidden = drawer.classList.contains('hidden');
    if (!isHidden) {
      drawer.classList.add('hidden');
      return;
    }

    const listEl = document.getElementById('google-accounts-list');
    listEl.innerHTML = '';

    // Suggest saved accounts or quick Google account presets
    const existingAccounts = this._getStoredAccounts().filter(a => a.authProvider === 'google');
    const defaultGooglePresets = existingAccounts.length > 0 ? existingAccounts : [
      {
        name: 'Minh Huynh',
        email: 'useforcoding123@gmail.com',
        color: '#6366f1',
        bg: 'rgba(99, 102, 241, 0.22)'
      }
    ];

    defaultGooglePresets.forEach((acc) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'google-account-option';
      btn.innerHTML = `
        <div style="display:flex;align-items:center;gap:9px">
          <span class="participant-swatch" style="background:${acc.color || '#4285F4'};width:28px;height:28px">
            ${this._escapeHtml(acc.name.charAt(0).toUpperCase())}
          </span>
          <div>
            <div style="font-size:12.5px;font-weight:600;color:var(--text-primary)">${this._escapeHtml(acc.name)}</div>
            <div style="font-size:11px;color:var(--text-secondary)">${this._escapeHtml(acc.email)}</div>
          </div>
        </div>
        <span style="font-size:11px;color:#60a5fa;font-weight:600">Continue →</span>
      `;
      btn.addEventListener('click', () => {
        this._completeSignIn({
          name: acc.name,
          email: acc.email,
          color: acc.color || '#6366f1',
          bg: acc.bg || 'rgba(99, 102, 241, 0.22)',
          authProvider: 'google'
        });
      });
      listEl.appendChild(btn);
    });

    drawer.classList.remove('hidden');
  }

  openProfileModal() {
    const modal = document.getElementById('profile-modal');
    const nameInput = document.getElementById('modal-user-name');
    const roomInput = document.getElementById('modal-room-code');
    const swatchesContainer = document.getElementById('modal-color-swatches');
    const summaryEl = document.getElementById('profile-account-summary');
    const authActionBtn = document.getElementById('btn-profile-auth-action');

    const isAuthed = this.currentUser.authProvider === 'google' || this.currentUser.authProvider === 'account';
    if (isAuthed && this.currentUser.email) {
      summaryEl.innerHTML = `Signed in as <strong>${this._escapeHtml(this.currentUser.email)}</strong> (${this.currentUser.authProvider === 'google' ? 'Google' : 'Account'})`;
      authActionBtn.textContent = 'Sign Out';
    } else {
      summaryEl.innerHTML = `Collaborating as <strong>Guest</strong>`;
      authActionBtn.textContent = 'Sign In / Create Account';
    }

    nameInput.value = this.currentUser.name;
    roomInput.value = this.roomId;
    swatchesContainer.innerHTML = '';

    let selectedColor = USER_COLORS.find(c => c.hex === this.currentUser.color) || USER_COLORS[0];

    USER_COLORS.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `color-swatch-btn ${c.hex === selectedColor.hex ? 'selected' : ''}`;
      btn.style.backgroundColor = c.hex;
      btn.title = c.name;
      btn.addEventListener('click', () => {
        selectedColor = c;
        swatchesContainer.querySelectorAll('.color-swatch-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      swatchesContainer.appendChild(btn);
    });

    modal.dataset.selectedHex = selectedColor.hex;
    modal.dataset.selectedBg = selectedColor.bg;

    swatchesContainer.addEventListener('click', () => {
      modal.dataset.selectedHex = selectedColor.hex;
      modal.dataset.selectedBg = selectedColor.bg;
    });

    modal.classList.remove('hidden');
  }

  _bindDOMEvents() {
    const langSelect = document.getElementById('language-select');
    langSelect.innerHTML = Object.values(LANGUAGES)
      .map(l => `<option value="${l.id}">${l.name} (${l.version})</option>`)
      .join('');

    langSelect.addEventListener('change', (e) => {
      const newLang = e.target.value;
      const file = this.collab?.state.files.find(f => f.id === this.activeFileId);
      if (file) {
        const prevLang = LANGUAGES[file.language];
        const nextLangObj = LANGUAGES[newLang];
        file.language = newLang;

        const base = file.name.split('.')[0] || 'main';
        file.name = `${base}.${nextLangObj.ext}`;

        if (prevLang && file.content.trim() === prevLang.starterCode.trim()) {
          file.content = nextLangObj.starterCode;
        }

        this.collab.updateFilesList(this.collab.state.files, this.activeFileId);
        this._renderFileTabs();
        this._syncEditorToActiveFile();
      }
    });

    document.getElementById('btn-compile-run').addEventListener('click', () => {
      this.handleCompileAndRun();
    });

    document.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setRoleMode(btn.dataset.role);
      });
    });

    document.getElementById('btn-switch-to-editor')?.addEventListener('click', () => {
      this.setRoleMode('editor');
    });

    document.getElementById('btn-add-file').addEventListener('click', () => {
      const currentLang = document.getElementById('language-select').value || 'cpp';
      this._addNewFileTab(currentLang);
    });

    document.getElementById('btn-copy-room').addEventListener('click', () => {
      const url = window.location.href;
      navigator.clipboard.writeText(url).then(() => {
        this.showToast(`Room link copied! Share with collaborators (${this.roomId})`);
      });
    });

    // Room & Profile settings buttons
    document.getElementById('btn-room-settings').addEventListener('click', () => {
      this.openProfileModal();
    });
    document.getElementById('btn-change-room').addEventListener('click', () => {
      this.openProfileModal();
    });

    document.getElementById('btn-close-modal').addEventListener('click', () => {
      document.getElementById('profile-modal').classList.add('hidden');
    });
    document.getElementById('btn-cancel-profile-modal').addEventListener('click', () => {
      document.getElementById('profile-modal').classList.add('hidden');
    });

    document.getElementById('btn-profile-auth-action').addEventListener('click', () => {
      const isAuthed = this.currentUser.authProvider === 'google' || this.currentUser.authProvider === 'account';
      if (isAuthed) {
        this.signOut();
      } else {
        document.getElementById('profile-modal').classList.add('hidden');
        this.openAuthModal('signin');
      }
    });

    // Auth Modal triggers
    document.getElementById('btn-auth-trigger').addEventListener('click', () => {
      this.openAuthModal('signin');
    });

    document.getElementById('btn-close-auth-modal').addEventListener('click', () => {
      document.getElementById('auth-modal').classList.add('hidden');
    });

    document.querySelectorAll('.auth-tab').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        this._switchAuthTab(tabBtn.dataset.authTab);
      });
    });

    // Google Sign-In Flow
    document.getElementById('btn-google-signin').addEventListener('click', () => {
      this._toggleGoogleAccountDrawer();
    });

    document.getElementById('btn-google-custom-submit').addEventListener('click', () => {
      const nameVal = document.getElementById('google-custom-name').value.trim();
      const emailVal = document.getElementById('google-custom-email').value.trim().toLowerCase();
      if (!emailVal || !emailVal.includes('@')) {
        this.showToast('Please enter a valid Google email address.');
        return;
      }
      const displayName = nameVal || emailVal.split('@')[0];
      const accounts = this._getStoredAccounts();
      const existing = accounts.find(a => a.email === emailVal);
      const colorObj = existing
        ? (USER_COLORS.find(c => c.hex === existing.color) || USER_COLORS[0])
        : (USER_COLORS.find(c => c.hex === this.currentUser.color) || USER_COLORS[0]);

      if (!existing) {
        accounts.push({
          name: displayName,
          email: emailVal,
          color: colorObj.hex,
          bg: colorObj.bg,
          authProvider: 'google'
        });
        this._saveStoredAccounts(accounts);
      }

      this._completeSignIn({
        name: displayName,
        email: emailVal,
        color: colorObj.hex,
        bg: colorObj.bg,
        authProvider: 'google'
      });
    });

    // Email / Password Sign In & Create Account Submit
    document.getElementById('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const errEl = document.getElementById('auth-error-msg');
      errEl.classList.add('hidden');

      const email = document.getElementById('auth-email-input').value.trim().toLowerCase();
      const password = document.getElementById('auth-password-input').value;
      const accounts = this._getStoredAccounts();

      if (this.authTabMode === 'signup') {
        const name = document.getElementById('auth-name-input').value.trim() || email.split('@')[0];
        const modal = document.getElementById('auth-modal');
        const chosenHex = modal.dataset.selectedHex || this.currentUser.color;
        const chosenBg = modal.dataset.selectedBg || this.currentUser.bg;

        if (accounts.some(a => a.email === email && a.authProvider === 'account')) {
          errEl.textContent = 'An account with this email already exists. Please switch to Sign In.';
          errEl.classList.remove('hidden');
          return;
        }

        const newAccount = {
          name,
          email,
          passwordHash: btoa(encodeURIComponent(password)),
          color: chosenHex,
          bg: chosenBg,
          authProvider: 'account',
          createdAt: Date.now()
        };

        accounts.push(newAccount);
        this._saveStoredAccounts(accounts);

        this._completeSignIn({
          name,
          email,
          color: chosenHex,
          bg: chosenBg,
          authProvider: 'account'
        });
      } else {
        const found = accounts.find(a => a.email === email);
        if (!found) {
          errEl.textContent = 'No account found with that email. Click "Create Account" above to register.';
          errEl.classList.remove('hidden');
          return;
        }
        if (found.authProvider === 'account' && found.passwordHash !== btoa(encodeURIComponent(password))) {
          errEl.textContent = 'Incorrect password. Please try again.';
          errEl.classList.remove('hidden');
          return;
        }

        this._completeSignIn({
          name: found.name,
          email: found.email,
          color: found.color,
          bg: found.bg,
          authProvider: found.authProvider || 'account'
        });
      }
    });

    document.getElementById('btn-generate-new-room').addEventListener('click', () => {
      const randomCode = 'SYNC-' + Math.random().toString(36).substring(2, 6).toUpperCase();
      document.getElementById('modal-room-code').value = randomCode;
    });

    document.getElementById('profile-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const modal = document.getElementById('profile-modal');
      const newName = document.getElementById('modal-user-name').value.trim() || 'Developer';
      const newRoom = document.getElementById('modal-room-code').value.trim().toUpperCase() || this.roomId;
      const newHex = modal.dataset.selectedHex || this.currentUser.color;
      const newBg = modal.dataset.selectedBg || this.currentUser.bg;

      this.currentUser.name = newName;
      this.currentUser.color = newHex;
      this.currentUser.bg = newBg;
      sessionStorage.setItem('codesync_tab_user', JSON.stringify(this.currentUser));

      // Also update persisted account if logged in
      if (this.currentUser.email) {
        localStorage.setItem('codesync_active_account_v1', JSON.stringify({
          name: newName,
          email: this.currentUser.email,
          color: newHex,
          bg: newBg,
          authProvider: this.currentUser.authProvider
        }));
      }

      modal.classList.add('hidden');

      if (newRoom !== this.roomId) {
        window.location.search = `?room=${encodeURIComponent(newRoom)}`;
        return;
      }

      this.collab?.updateLocalUser({
        name: newName,
        color: newHex,
        bg: newBg
      });
      this.showToast(`Settings saved (${newName})`);
    });

    document.getElementById('stdin-input').addEventListener('input', (e) => {
      this.collab?.sendStdinChange(e.target.value);
    });

    document.getElementById('btn-clear-console').addEventListener('click', () => {
      document.getElementById('stdout-output').textContent = '';
      document.getElementById('stderr-output').textContent = '';
      document.getElementById('exec-status-badge').className = 'exec-status-badge idle';
      document.getElementById('exec-status-badge').textContent = 'Ready';
      document.getElementById('exec-metrics').textContent = '';
    });

    document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
      const sb = document.getElementById('collab-sidebar');
      sb.classList.toggle('collapsed');
      setTimeout(() => this.editor?.layout(), 210);
    });

    document.getElementById('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text || !this.collab) return;
      this.collab.sendChatMessage(text, false);
      input.value = '';
    });
  }

  showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3400);
  }

  _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.codeSyncApp = new CodeSyncApp();
});
