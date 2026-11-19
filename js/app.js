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

    // Study Mode State (Normal Stopwatch vs 60m Work / 5m Break Pomodoro)
    this.studyState = {
      mode: 'normal',         // 'normal' | 'pomodoro'
      pomoPhase: 'work',      // 'work' (60m = 3600s) | 'break' (5m = 300s)
      isRunning: false,
      normalSeconds: 0,       // Stopwatch elapsed seconds
      pomoRemainingSec: 3600, // 60 minutes default
      totalWorkedSec: 0,      // Cumulative working time
      intervalId: null
    };

    this._initIdentityAndRoom();
    this._initStudyMode();
    this._bindDOMEvents();
    this._initResizablePanes();
    this._updateAuthHeaderUI();
    this._loadMonacoEditor();
  }

  _initIdentityAndRoom() {
    const params = new URLSearchParams(window.location.search);
    const pathMatch = window.location.pathname.match(/\/room\/([A-Za-z0-9_-]+)/i);
    const hashMatch = window.location.hash.replace(/^#/, '').trim();
    let roomParam = params.get('room') || (pathMatch ? pathMatch[1] : null) || (hashMatch || null);
    if (!roomParam) {
      roomParam = 'SYNC-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    }
    this.roomId = roomParam.toUpperCase();
    const canonicalUrl = `/?room=${encodeURIComponent(this.roomId)}`;
    if (window.location.pathname + window.location.search !== canonicalUrl) {
      window.history.replaceState({}, '', canonicalUrl);
    }

    // Always generate a unique runtime peer ID per tab/window instance so duplicated tabs never collide
    const runtimePeerId = 'usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);

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

    if (activeAccount && activeAccount.email && activeAccount.authenticated === true) {
      const colorObj = USER_COLORS.find(c => c.hex === activeAccount.color) || USER_COLORS[0];
      savedUser = {
        id: runtimePeerId,
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
        id: runtimePeerId,
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
    } else {
      savedUser.id = runtimePeerId;
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
        this._renderFileTabs();
        this._syncEditorToActiveFile();
        this._renderAllChatMessages(state.chat);
      },
      onRemoteCodeChange: (pkt) => {
        if (pkt.type === 'STDIN_EDIT') {
          if (!pkt.fileId || pkt.fileId === this.activeFileId) {
            const stdinEl = document.getElementById('stdin-input');
            if (document.activeElement !== stdinEl) {
              stdinEl.value = pkt.stdin;
            }
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
      onRemoteExecution: (execResult, fileId) => {
        const targetId = fileId || execResult?.fileId;
        if (!targetId || targetId === this.activeFileId) {
          this._displayExecutionOutput(execResult, true);
        }
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

    // Sync per-tab isolated Stdin & Compiler Output
    const termBadge = document.getElementById('terminal-active-file-badge');
    if (termBadge) termBadge.textContent = file.name;

    const stdinEl = document.getElementById('stdin-input');
    if (stdinEl && document.activeElement !== stdinEl) {
      stdinEl.value = file.stdin !== undefined ? file.stdin : '';
    }

    if (file.lastExecution) {
      this._displayExecutionOutput(file.lastExecution, false);
    } else {
      this._resetConsoleUI(file.name);
    }

    this._renderRemoteCursorsInEditor();
  }

  _resetConsoleUI(fileName = '') {
    const statusBadge = document.getElementById('exec-status-badge');
    const stdoutEl = document.getElementById('stdout-output');
    const stderrEl = document.getElementById('stderr-output');
    const metricsEl = document.getElementById('exec-metrics');
    const metaFooter = document.getElementById('output-meta-footer');

    if (statusBadge) {
      statusBadge.className = 'exec-status-badge idle';
      statusBadge.textContent = 'Ready';
    }
    if (stdoutEl) {
      stdoutEl.textContent = fileName
        ? `Ready to compile & run ${fileName} (Press Ctrl+Enter). Input and output are isolated to this tab.`
        : 'Click "Compile & Run" (or press Ctrl+Enter) to compile in real time.';
    }
    if (stderrEl) stderrEl.textContent = '';
    if (metricsEl) metricsEl.textContent = '';
    if (metaFooter) {
      metaFooter.textContent = fileName
        ? `Isolated console for ${fileName} — won't interfere with other tabs.`
        : 'Multi-language cloud compiler ready.';
    }
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
      tab.title = this.currentUser.role === 'editor'
        ? `${file.name} (Double-click to rename)`
        : file.name;
      tab.innerHTML = `
        <span class="file-lang-dot" style="background:${lang.color}"></span>
        <span>${this._escapeHtml(file.name)}</span>
        <span class="file-tab-peers">
          ${peersOnFile.map(p => `<span class="file-peer-pip" style="background:${p.color}" title="${this._escapeHtml(p.name)}"></span>`).join('')}
        </span>
        ${this.currentUser.role === 'editor' ? `<span class="file-tab-rename" data-rename-id="${file.id}" title="Rename tab">✎</span>` : ''}
        ${files.length > 1 && this.currentUser.role === 'editor' ? `<span class="file-tab-close" data-close-id="${file.id}" title="Close file">&times;</span>` : ''}
      `;

      tab.addEventListener('click', (e) => {
        const renameId = e.target.getAttribute('data-rename-id');
        if (renameId) {
          e.stopPropagation();
          this.openFileTabModal('rename', renameId);
          return;
        }
        const closeId = e.target.getAttribute('data-close-id');
        if (closeId) {
          e.stopPropagation();
          this._deleteFileTab(closeId);
          return;
        }
        this.switchFileTab(file.id);
      });

      tab.addEventListener('dblclick', (e) => {
        if (this.currentUser.role !== 'editor') return;
        if (e.target.getAttribute('data-close-id')) return;
        this.openFileTabModal('rename', file.id);
      });

      listEl.appendChild(tab);
    });
  }

  openFileTabModal(mode = 'create', targetFileId = null) {
    if (this.currentUser.role === 'observer') {
      this.showToast('Switch to Editor mode to create or rename files.');
      return;
    }

    const modal = document.getElementById('file-tab-modal');
    const titleEl = document.getElementById('file-tab-modal-title');
    const subtitleEl = document.getElementById('file-tab-modal-subtitle');
    const nameInput = document.getElementById('file-tab-name-input');
    const langGroup = document.getElementById('file-tab-lang-group');
    const langSelect = document.getElementById('file-tab-lang-select');
    const submitBtn = document.getElementById('btn-file-tab-submit');
    const errEl = document.getElementById('file-tab-error-msg');

    errEl.classList.add('hidden');
    modal.dataset.mode = mode;
    modal.dataset.targetFileId = targetFileId || '';

    langSelect.innerHTML = Object.values(LANGUAGES)
      .map(l => `<option value="${l.id}">${l.name} (.${l.ext})</option>`)
      .join('');

    if (mode === 'rename' && targetFileId) {
      const targetFile = this.collab.state.files.find(f => f.id === targetFileId);
      if (!targetFile) return;
      titleEl.textContent = 'Rename Code Tab';
      subtitleEl.textContent = 'Update the filename for this tab across all collaborators in the room.';
      nameInput.value = targetFile.name;
      langSelect.value = targetFile.language;
      langGroup.classList.add('hidden');
      submitBtn.textContent = 'Save Name';
    } else {
      const currentLang = document.getElementById('language-select').value || 'cpp';
      const langObj = LANGUAGES[currentLang] || LANGUAGES.cpp;
      const count = this.collab.state.files.filter(f => f.language === currentLang).length + 1;
      const suggestedName = langObj.defaultFileName.replace('.', count > 1 ? `_${count}.` : '.');

      titleEl.textContent = 'Create New Code Tab';
      subtitleEl.textContent = 'Name your file before creating it. Each tab has its own isolated Standard Input and Compiler Output.';
      nameInput.value = suggestedName;
      langSelect.value = currentLang;
      langGroup.classList.remove('hidden');
      submitBtn.textContent = 'Create Tab';
    }

    modal.classList.remove('hidden');
    nameInput.focus();
    nameInput.select();
  }

  _addNewFileTab(langId = 'cpp', customName = '') {
    if (this.currentUser.role === 'observer') {
      this.showToast('Switch to Editor mode to create new files.');
      return;
    }
    const lang = LANGUAGES[langId] || LANGUAGES.cpp;
    let fileName = (customName || '').trim();
    if (!fileName) {
      const count = this.collab.state.files.filter(f => f.language === langId).length + 1;
      fileName = lang.defaultFileName.replace('.', count > 1 ? `_${count}.` : '.');
    } else if (!fileName.includes('.')) {
      fileName = `${fileName}.${lang.ext}`;
    }

    const newFile = {
      id: 'file-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5),
      name: fileName,
      language: langId,
      content: lang.starterCode,
      stdin: '',
      lastExecution: null,
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

  _renameFileTab(fileId, newNameRaw) {
    const file = this.collab.state.files.find(f => f.id === fileId);
    if (!file) return;
    const oldName = file.name;
    let newName = newNameRaw.trim();
    if (!newName) return;

    const currentLang = LANGUAGES[file.language] || LANGUAGES.cpp;
    if (!newName.includes('.')) {
      newName = `${newName}.${currentLang.ext}`;
    } else {
      // Auto-detect language if user typed a known extension
      const ext = newName.split('.').pop().toLowerCase();
      const matchedLang = Object.values(LANGUAGES).find(l => l.ext === ext);
      if (matchedLang) {
        file.language = matchedLang.id;
      }
    }

    file.name = newName;
    file.updatedBy = this.currentUser.name;
    file.updatedAt = Date.now();

    this.collab.updateFilesList(this.collab.state.files, this.activeFileId);
    this._renderFileTabs();
    this._syncEditorToActiveFile();
    if (oldName !== newName) {
      this.collab.sendChatMessage(`${this.currentUser.name} renamed ${oldName} → ${newName}`, true);
      this.showToast(`Renamed tab to ${newName}`);
    }
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
    // Top bar: ONLY render the local user's circle/pill so the navbar never crowds with other peers
    const stackEl = document.getElementById('presence-avatar-stack');
    stackEl.innerHTML = '';

    const selfUsers = users.filter(u => u.isSelf);
    selfUsers.forEach((u) => {
      const initials = u.name
        .split(' ')
        .map(w => w[0])
        .join('')
        .substring(0, 2)
        .toUpperCase();

      const pill = document.createElement('div');
      pill.className = 'presence-avatar';
      pill.style.setProperty('--user-color', u.color);
      pill.title = `${u.name} (You — click to customize profile, color, or switch room)`;

      pill.innerHTML = `
        <span class="avatar-circle" style="background:${u.color}">${this._escapeHtml(initials)}</span>
        <span>${this._escapeHtml(u.name.split(' ')[0])} (You)</span>
        <span class="avatar-role-tag">${u.role === 'observer' ? 'Observing' : 'Editing'}</span>
      `;

      pill.addEventListener('click', () => {
        this.openProfileModal();
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
      card.className = `participant-card ${this.followingUserId === u.id ? 'following' : ''}`;
      card.title = u.isSelf
        ? 'Click to open your profile & room settings'
        : `Click to follow ${u.name}'s cursor & active tab`;
      const studyTag = u.studyStatus
        ? `<span style="color:#a5b4fc;font-size:10.5px;display:block;margin-top:2px">${this._escapeHtml(u.studyStatus)}</span>`
        : '';
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
              ${studyTag}
            </div>
          </div>
        </div>
        <span class="role-pill ${u.role === 'observer' ? 'observer' : 'editor'}">
          ${u.role === 'observer' ? 'Observing' : 'Editing'}
        </span>
      `;
      card.addEventListener('click', () => {
        if (u.isSelf) {
          this.openProfileModal();
        } else {
          this._toggleFollowUser(u);
        }
      });
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
      fileId: file.id,
      fileName: file.name,
      languageName: LANGUAGES[langId]?.name || langId,
      triggeredBy: this.currentUser.name,
      timestamp: Date.now()
    };

    runBtn.disabled = false;
    this.collab.broadcastExecutionResult(file.id, enrichedResult);
    if (this.activeFileId === file.id) {
      this._displayExecutionOutput(enrichedResult, false);
    }
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
    // Always clear form fields so previous credentials or emails are never exposed
    const emailInput = document.getElementById('auth-email-input');
    const passInput = document.getElementById('auth-password-input');
    const nameInput = document.getElementById('auth-name-input');
    if (emailInput) emailInput.value = '';
    if (passInput) passInput.value = '';
    if (nameInput) nameInput.value = '';
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
      : 'Sign In to pleaseAC';
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
      const raw = JSON.parse(localStorage.getItem('codesync_accounts_v1')) || [];
      // Only retain accounts that have a valid passwordHash (purges any legacy passwordless accounts)
      return raw.filter(a => a && a.email && a.passwordHash);
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
      authProvider, // 'google' | 'account'
      authenticated: true
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
        `${this.currentUser.name} signed in via ${authProvider === 'google' ? 'Google' : 'pleaseAC Account'}`,
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

    // Clear all Google sign-in inputs so no account is ever pre-filled or exposed
    const gName = document.getElementById('google-custom-name');
    const gEmail = document.getElementById('google-custom-email');
    const gPass = document.getElementById('google-custom-password');
    if (gName) gName.value = '';
    if (gEmail) gEmail.value = '';
    if (gPass) gPass.value = '';

    drawer.classList.remove('hidden');
    if (gEmail) gEmail.focus();
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
      this.openFileTabModal('create');
    });

    // File Tab Create / Rename Modal Events
    const closeFileModal = () => document.getElementById('file-tab-modal').classList.add('hidden');
    document.getElementById('btn-close-file-tab-modal').addEventListener('click', closeFileModal);
    document.getElementById('btn-cancel-file-tab-modal').addEventListener('click', closeFileModal);

    document.getElementById('file-tab-lang-select').addEventListener('change', (e) => {
      const modal = document.getElementById('file-tab-modal');
      if (modal.dataset.mode !== 'create') return;
      const langObj = LANGUAGES[e.target.value];
      const nameInput = document.getElementById('file-tab-name-input');
      if (langObj && nameInput) {
        const currentVal = nameInput.value.trim();
        const base = currentVal ? currentVal.split('.')[0] : langObj.defaultFileName.split('.')[0];
        nameInput.value = `${base}.${langObj.ext}`;
      }
    });

    document.getElementById('file-tab-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const modal = document.getElementById('file-tab-modal');
      const errEl = document.getElementById('file-tab-error-msg');
      errEl.classList.add('hidden');

      const rawName = document.getElementById('file-tab-name-input').value.trim();
      if (!rawName) {
        errEl.textContent = 'Please enter a valid file name.';
        errEl.classList.remove('hidden');
        return;
      }

      if (modal.dataset.mode === 'rename' && modal.dataset.targetFileId) {
        this._renameFileTab(modal.dataset.targetFileId, rawName);
      } else {
        const langId = document.getElementById('file-tab-lang-select').value || 'cpp';
        this._addNewFileTab(langId, rawName);
      }

      modal.classList.add('hidden');
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
      const errEl = document.getElementById('auth-error-msg');
      errEl.classList.add('hidden');

      const nameVal = document.getElementById('google-custom-name').value.trim();
      const emailVal = document.getElementById('google-custom-email').value.trim().toLowerCase();
      const passEl = document.getElementById('google-custom-password');
      const passwordVal = passEl ? passEl.value : '';

      if (!emailVal || !emailVal.includes('@')) {
        errEl.textContent = 'Please enter a valid Google email address.';
        errEl.classList.remove('hidden');
        return;
      }

      if (!passwordVal || passwordVal.length < 4) {
        errEl.textContent = 'Please enter your account password (minimum 4 characters).';
        errEl.classList.remove('hidden');
        return;
      }

      const accounts = this._getStoredAccounts();
      const existing = accounts.find(a => a.email === emailVal);
      const hashedInput = btoa(encodeURIComponent(passwordVal));

      if (existing) {
        if (existing.passwordHash !== hashedInput) {
          errEl.textContent = 'Incorrect password for this account. Please try again.';
          errEl.classList.remove('hidden');
          return;
        }
        const colorObj = USER_COLORS.find(c => c.hex === existing.color) || USER_COLORS[0];
        this._completeSignIn({
          name: nameVal || existing.name,
          email: existing.email,
          color: colorObj.hex,
          bg: colorObj.bg,
          authProvider: 'google'
        });
        return;
      }

      const displayName = nameVal || emailVal.split('@')[0];
      const colorObj = USER_COLORS.find(c => c.hex === this.currentUser.color) || USER_COLORS[0];

      accounts.push({
        name: displayName,
        email: emailVal,
        passwordHash: hashedInput,
        color: colorObj.hex,
        bg: colorObj.bg,
        authProvider: 'google',
        createdAt: Date.now()
      });
      this._saveStoredAccounts(accounts);

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

        if (accounts.some(a => a.email === email)) {
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
        if (found.passwordHash !== btoa(encodeURIComponent(password))) {
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
          authProvider: this.currentUser.authProvider,
          authenticated: true
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
      this.collab?.sendStdinChange(this.activeFileId, e.target.value);
    });

    document.getElementById('btn-clear-console').addEventListener('click', () => {
      const activeFile = this.collab?.state.files.find(f => f.id === this.activeFileId);
      if (activeFile) {
        activeFile.lastExecution = null;
      }
      this._resetConsoleUI(activeFile?.name || '');
    });

    document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
      const sb = document.getElementById('collab-sidebar');
      const sbResizer = document.getElementById('resizer-sidebar');
      const collapsed = sb.classList.toggle('collapsed');
      if (sbResizer) sbResizer.classList.toggle('hidden', collapsed);
      setTimeout(() => this.editor?.layout(), 60);
    });

    document.getElementById('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text || !this.collab) return;
      this.collab.sendChatMessage(text, false);
      input.value = '';
    });

    this._bindStudyModeEvents();
  }

  /* ============================================================================
   * Code::Blocks-Style Draggable / Resizable Workspace Panes
   * ============================================================================ */

  _initResizablePanes() {
    const terminalEl = document.getElementById('terminal-drawer');
    const stdinEl = document.getElementById('stdin-pane');
    const sidebarEl = document.getElementById('collab-sidebar');
    const peersSectionEl = document.getElementById('collab-peers-section');

    const resizerTerminal = document.getElementById('resizer-terminal');
    const resizerStdin = document.getElementById('resizer-stdin');
    const resizerSidebar = document.getElementById('resizer-sidebar');
    const resizerCollabChat = document.getElementById('resizer-collab-chat');

    const saveSizes = () => {
      try {
        localStorage.setItem('codesync_layout_sizes_v1', JSON.stringify({
          terminalHeight: terminalEl ? terminalEl.offsetHeight : 250,
          stdinWidth: stdinEl ? stdinEl.offsetWidth : 280,
          sidebarWidth: sidebarEl ? sidebarEl.offsetWidth : 320,
          peersHeight: peersSectionEl ? peersSectionEl.offsetHeight : 220
        }));
      } catch (_) {}
    };

    // Restore saved layout sizes
    try {
      const saved = JSON.parse(localStorage.getItem('codesync_layout_sizes_v1'));
      if (saved) {
        if (terminalEl && saved.terminalHeight >= 110) terminalEl.style.height = `${saved.terminalHeight}px`;
        if (stdinEl && saved.stdinWidth >= 140) stdinEl.style.width = `${saved.stdinWidth}px`;
        if (sidebarEl && saved.sidebarWidth >= 220) sidebarEl.style.width = `${saved.sidebarWidth}px`;
        if (peersSectionEl && saved.peersHeight >= 90) peersSectionEl.style.height = `${saved.peersHeight}px`;
      }
    } catch (_) {}

    const attachDrag = (handleEl, direction, onDrag) => {
      if (!handleEl) return;
      handleEl.addEventListener('mousedown', (startEvt) => {
        startEvt.preventDefault();
        handleEl.classList.add('active');
        document.body.classList.add(direction === 'col' ? 'is-resizing-col' : 'is-resizing-row');

        const startX = startEvt.clientX;
        const startY = startEvt.clientY;
        const initialMetrics = {
          terminalH: terminalEl ? terminalEl.offsetHeight : 250,
          stdinW: stdinEl ? stdinEl.offsetWidth : 280,
          sidebarW: sidebarEl ? sidebarEl.offsetWidth : 320,
          peersH: peersSectionEl ? peersSectionEl.offsetHeight : 220
        };

        const onMouseMove = (moveEvt) => {
          const dx = moveEvt.clientX - startX;
          const dy = moveEvt.clientY - startY;
          onDrag(dx, dy, initialMetrics);
          this.editor?.layout();
        };

        const onMouseUp = () => {
          handleEl.classList.remove('active');
          document.body.classList.remove('is-resizing-col', 'is-resizing-row');
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          saveSizes();
          this.editor?.layout();
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    };

    // 1. Editor <-> Compiler Output & Stdin (Drag up/down)
    attachDrag(resizerTerminal, 'row', (_dx, dy, init) => {
      if (!terminalEl) return;
      const splitContainer = document.getElementById('editor-console-split');
      const maxH = splitContainer ? Math.max(180, splitContainer.offsetHeight - 150) : window.innerHeight * 0.7;
      const nextH = Math.min(maxH, Math.max(110, init.terminalH - dy));
      terminalEl.style.height = `${nextH}px`;
    });

    // 2. Stdin <-> Stdout inside Compiler Console (Drag left/right)
    attachDrag(resizerStdin, 'col', (dx, _dy, init) => {
      if (!stdinEl) return;
      const bodyEl = document.getElementById('terminal-body-grid');
      const maxW = bodyEl ? Math.max(200, bodyEl.offsetWidth - 180) : 600;
      const nextW = Math.min(maxW, Math.max(140, init.stdinW + dx));
      stdinEl.style.width = `${nextW}px`;
    });

    // 3. Editor Column <-> Right Sidebar (Room Collaborators & Live Chat) (Drag left/right)
    attachDrag(resizerSidebar, 'col', (dx, _dy, init) => {
      if (!sidebarEl) return;
      const maxW = Math.max(260, Math.min(580, window.innerWidth - 360));
      const nextW = Math.min(maxW, Math.max(220, init.sidebarW - dx));
      sidebarEl.style.width = `${nextW}px`;
    });

    // 4. Room Collaborators <-> Live Room Chat inside Sidebar (Drag up/down)
    attachDrag(resizerCollabChat, 'row', (_dx, dy, init) => {
      if (!peersSectionEl || !sidebarEl) return;
      const maxH = Math.max(130, sidebarEl.offsetHeight - 170);
      const nextH = Math.min(maxH, Math.max(90, init.peersH + dy));
      peersSectionEl.style.height = `${nextH}px`;
    });
  }

  /* ============================================================================
   * Study Mode: Normal Working Time Stopwatch & 60m Work / 5m Break Pomodoro
   * ============================================================================ */

  _initStudyMode() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('codesync_study_state_v1'));
      if (saved) {
        this.studyState.mode = saved.mode || 'normal';
        this.studyState.pomoPhase = saved.pomoPhase || 'work';
        this.studyState.normalSeconds = Number(saved.normalSeconds) || 0;
        this.studyState.pomoRemainingSec = Number(saved.pomoRemainingSec) || 3600;
        this.studyState.totalWorkedSec = Number(saved.totalWorkedSec) || 0;
      }
    } catch (_) {}
    this._renderStudyModeUI();
  }

  _saveStudyState() {
    try {
      sessionStorage.setItem('codesync_study_state_v1', JSON.stringify({
        mode: this.studyState.mode,
        pomoPhase: this.studyState.pomoPhase,
        normalSeconds: this.studyState.normalSeconds,
        pomoRemainingSec: this.studyState.pomoRemainingSec,
        totalWorkedSec: this.studyState.totalWorkedSec
      }));
    } catch (_) {}
  }

  _bindStudyModeEvents() {
    const pillTrigger = document.getElementById('study-pill-trigger');
    const popover = document.getElementById('study-popover');
    const closePopoverBtn = document.getElementById('btn-close-study-popover');
    const quickToggleBtn = document.getElementById('btn-study-quick-toggle');
    const startPauseBtn = document.getElementById('btn-study-start-pause');
    const resetBtn = document.getElementById('btn-study-reset');
    const skipPhaseBtn = document.getElementById('btn-study-skip-phase');
    const testAlertBtn = document.getElementById('btn-study-test-alert');

    pillTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.toggle('hidden');
    });

    closePopoverBtn.addEventListener('click', () => {
      popover.classList.add('hidden');
    });

    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('study-mode-wrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        popover.classList.add('hidden');
      }
    });

    quickToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleStudyTimer();
    });

    startPauseBtn.addEventListener('click', () => {
      this.toggleStudyTimer();
    });

    resetBtn.addEventListener('click', () => {
      this.resetStudyTimer();
    });

    document.querySelectorAll('.study-type-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.setStudyModeType(tab.dataset.studyType);
      });
    });

    skipPhaseBtn.addEventListener('click', () => {
      if (this.studyState.pomoPhase === 'work') {
        this._triggerPomodoroBreakAlert();
      } else {
        this._startPomodoroWorkPhase();
      }
    });

    testAlertBtn.addEventListener('click', () => {
      popover.classList.add('hidden');
      this._triggerPomodoroBreakAlert();
    });

    document.getElementById('btn-pomo-start-break').addEventListener('click', () => {
      document.getElementById('pomodoro-break-modal').classList.add('hidden');
      this.studyState.mode = 'pomodoro';
      this.studyState.pomoPhase = 'break';
      this.studyState.pomoRemainingSec = 5 * 60;
      if (!this.studyState.isRunning) {
        this.toggleStudyTimer(true);
      }
      this._renderStudyModeUI();
      this.showToast('5-minute break timer started! Relax and recharge ☕');
    });

    document.getElementById('btn-pomo-skip-break').addEventListener('click', () => {
      document.getElementById('pomodoro-break-modal').classList.add('hidden');
      this._startPomodoroWorkPhase();
    });
  }

  setStudyModeType(type) {
    this.studyState.mode = type === 'pomodoro' ? 'pomodoro' : 'normal';
    this._saveStudyState();
    this._renderStudyModeUI();
    this._broadcastStudyPresence();
  }

  toggleStudyTimer(forceRun = null) {
    const shouldRun = forceRun !== null ? forceRun : !this.studyState.isRunning;
    this.studyState.isRunning = shouldRun;

    if (this.studyState.intervalId) {
      clearInterval(this.studyState.intervalId);
      this.studyState.intervalId = null;
    }

    if (shouldRun) {
      this.studyState.intervalId = setInterval(() => {
        this._tickStudyTimer();
      }, 1000);
    }

    this._renderStudyModeUI();
    this._broadcastStudyPresence();
  }

  resetStudyTimer() {
    this.toggleStudyTimer(false);
    if (this.studyState.mode === 'normal') {
      this.studyState.normalSeconds = 0;
    } else {
      this.studyState.pomoPhase = 'work';
      this.studyState.pomoRemainingSec = 3600;
    }
    this._saveStudyState();
    this._renderStudyModeUI();
    this._broadcastStudyPresence();
    this.showToast('Study timer reset.');
  }

  _tickStudyTimer() {
    if (this.studyState.mode === 'normal') {
      this.studyState.normalSeconds += 1;
      this.studyState.totalWorkedSec += 1;
    } else {
      if (this.studyState.pomoPhase === 'work') {
        this.studyState.totalWorkedSec += 1;
        this.studyState.normalSeconds += 1;
      }

      if (this.studyState.pomoRemainingSec > 0) {
        this.studyState.pomoRemainingSec -= 1;
      }

      const modalDigits = document.getElementById('pomo-modal-countdown');
      if (modalDigits && this.studyState.pomoPhase === 'break') {
        modalDigits.textContent = this._formatMMSS(this.studyState.pomoRemainingSec);
      }

      if (this.studyState.pomoRemainingSec <= 0) {
        if (this.studyState.pomoPhase === 'work') {
          this._triggerPomodoroBreakAlert();
        } else {
          this._playStudyChime();
          this.showToast('5-minute break finished! Starting new 1-hour Pomodoro work session.');
          this._startPomodoroWorkPhase();
        }
      }
    }

    if (this.studyState.totalWorkedSec % 10 === 0) {
      this._saveStudyState();
      this._broadcastStudyPresence();
    }
    this._renderStudyModeUI();
  }

  _triggerPomodoroBreakAlert() {
    this._playStudyChime();
    this.studyState.mode = 'pomodoro';
    this.studyState.pomoPhase = 'break';
    this.studyState.pomoRemainingSec = 5 * 60;
    this._saveStudyState();

    if (!this.studyState.isRunning) {
      this.toggleStudyTimer(true);
    }

    const modal = document.getElementById('pomodoro-break-modal');
    const modalDigits = document.getElementById('pomo-modal-countdown');
    if (modalDigits) modalDigits.textContent = '05:00';
    modal.classList.remove('hidden');

    this._renderStudyModeUI();
    this._broadcastStudyPresence();

    if (this.collab) {
      this.collab.sendChatMessage(
        `☕ ${this.currentUser.name} completed 1 hour of Pomodoro work and started a 5-minute break!`,
        true
      );
    }
  }

  _startPomodoroWorkPhase() {
    this.studyState.mode = 'pomodoro';
    this.studyState.pomoPhase = 'work';
    this.studyState.pomoRemainingSec = 3600;
    this._saveStudyState();
    this._renderStudyModeUI();
    this._broadcastStudyPresence();
    this.showToast('Pomodoro 1-hour work session active.');
  }

  _broadcastStudyPresence() {
    if (!this.collab) return;
    let statusText = null;
    if (this.studyState.isRunning) {
      if (this.studyState.mode === 'pomodoro' && this.studyState.pomoPhase === 'break') {
        statusText = `☕ On 5m Break (${this._formatMMSS(this.studyState.pomoRemainingSec)})`;
      } else if (this.studyState.mode === 'pomodoro') {
        statusText = `🍅 Pomodoro Work (${this._formatMMSS(this.studyState.pomoRemainingSec)} left)`;
      } else {
        const mins = Math.floor(this.studyState.normalSeconds / 60);
        statusText = `⏱ Studying (${mins}m)`;
      }
    }
    this.currentUser.studyStatus = statusText;
    this.collab.updateLocalUser({ studyStatus: statusText });
  }

  _renderStudyModeUI() {
    const wrapper = document.getElementById('study-mode-wrapper');
    const badgeEl = document.getElementById('study-mode-label');
    const timerDisplayEl = document.getElementById('study-timer-display');
    const quickBtn = document.getElementById('btn-study-quick-toggle');
    const startPauseBtn = document.getElementById('btn-study-start-pause');
    const bigDigitsEl = document.getElementById('study-big-digits');
    const phaseTagEl = document.getElementById('study-phase-tag');
    const totalWorkedEl = document.getElementById('study-total-worked');
    const pomoActionsEl = document.getElementById('study-pomo-actions');
    const clockCardEl = document.getElementById('study-clock-card');

    if (!wrapper) return;

    const { mode, pomoPhase, isRunning, normalSeconds, pomoRemainingSec, totalWorkedSec } = this.studyState;

    const isBreak = mode === 'pomodoro' && pomoPhase === 'break';
    wrapper.classList.toggle('running', isRunning && !isBreak);
    wrapper.classList.toggle('break-mode', isBreak);
    clockCardEl.classList.toggle('break-active', isBreak);

    document.querySelectorAll('.study-type-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.studyType === mode);
    });

    pomoActionsEl.classList.toggle('hidden', mode !== 'pomodoro');

    const formattedTime = mode === 'normal'
      ? this._formatHHMMSS(normalSeconds)
      : this._formatMMSS(pomoRemainingSec);

    timerDisplayEl.textContent = formattedTime;
    bigDigitsEl.textContent = formattedTime;

    if (mode === 'normal') {
      badgeEl.textContent = 'Study';
      phaseTagEl.textContent = isRunning ? 'WORKING TIME (LIVE)' : 'WORKING TIME (PAUSED)';
    } else if (isBreak) {
      badgeEl.textContent = 'Break 5m';
      phaseTagEl.textContent = '☕ 5-MINUTE REST BREAK';
    } else {
      badgeEl.textContent = 'Pomodoro';
      phaseTagEl.textContent = '🍅 1-HOUR FOCUS SESSION (60M)';
    }

    quickBtn.textContent = isRunning ? '⏸' : '▶';
    startPauseBtn.textContent = isRunning ? 'Pause Timer' : 'Start Timer';

    const totalMins = Math.floor(totalWorkedSec / 60);
    const totalHrs = Math.floor(totalMins / 60);
    const remMins = totalMins % 60;
    totalWorkedEl.textContent = totalHrs > 0
      ? `Total working time: ${totalHrs}h ${remMins}m`
      : `Total working time: ${totalMins}m ${totalWorkedSec % 60}s`;
  }

  _formatHHMMSS(totalSec) {
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    return [hrs, mins, secs].map(v => String(v).padStart(2, '0')).join(':');
  }

  _formatMMSS(totalSec) {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return [mins, secs].map(v => String(v).padStart(2, '0')).join(':');
  }

  _playStudyChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.14);
        gain.gain.setValueAtTime(0.16, ctx.currentTime + idx * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.14 + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.14);
        osc.stop(ctx.currentTime + idx * 0.14 + 0.45);
      });
    } catch (_) {}
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
