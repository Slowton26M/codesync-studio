# CodeSync Studio — Real-Time Collaborative IDE & Multi-Language Compiler

A Google Docs-style real-time collaborative code editor and multi-language cloud compiler built for zero-config deployment on **Vercel (`.vercel.app`)**.

## Features

1. **Collaborative Rooms & Shareable URLs (`?room=SYNC-XXXX`)**
   - Create or join any room by ID or URL.
   - Multi-tab sync via `BroadcastChannel` + cross-device P2P relay so multiple participants can edit and observe simultaneously with zero backend setup.
   - Built-in **"+2nd Tab"** and **"Simulate Peer"** buttons in the top navbar for instant single-person testing of live remote cursors.

2. **Google Docs-Style Colored Cursors, Selections & Presence**
   - Each participant is assigned a unique presence color from a high-contrast palette (customizable via the Room & Identity modal).
   - Live remote cursor carets, floating collaborator name tags, and translucent selection range highlights inside **Monaco Editor**.
   - **Click-to-Follow**: Click any collaborator's avatar badge in the top navbar to follow their active file tab and cursor position automatically.

3. **Editing vs. Observing (Read-Only) Mode**
   - Switch between **Editing** and **Observing** in one click from the top toolbar.
   - Observing locks the editor against accidental modifications while still broadcasting your presence color and cursor location to peers.

4. **Multi-Language Cloud Compilation & Execution**
   - Supports **C++20 (GCC 13.2)**, **Python 3.12**, **JavaScript (ES2024)**, **TypeScript 5.4**, **C (GCC 13.2)**, **Java 21 (OpenJDK)**, **Rust (1.78)**, and **Go (1.22)**.
   - Resilient multi-provider execution engine (Compiler Explorer REST execution API + Wandbox API + V8 browser sandbox).
   - Synced **`stdin`** input pane, execution timing (`ms`), memory metrics (`MB`), and live broadcast of compiler outputs to all room members.

5. **Multi-File Room Tabs & Live Chat Sidebar**
   - Create, switch, and close synchronized file tabs (`main.cpp`, `solution.py`, `index.js`, etc.) with live colored pips showing which file each peer is viewing.
   - Built-in real-time text chat and activity log in the collapsible right sidebar.

## Local Preview

```bash
python -m http.server 3000
```

Open `http://localhost:3000`.

## Deploying to Vercel (`*.vercel.app`)

This project includes [vercel.json](file:///c:/Code/ProjectAlpha/vercel.json) and [package.json](file:///c:/Code/ProjectAlpha/package.json) pre-configured for zero-build static deployment on Vercel:

- **Option 1: Official Vercel Plugin in Antigravity** — Add the Vercel plugin card in chat to connect your Vercel account and deploy directly to `.vercel.app`.
- **Option 2: Vercel CLI** (once Node.js is installed):
  ```bash
  npx vercel --prod
  ```
- **Option 3: Vercel Dashboard / Git Import** — Drag-and-drop or import the `c:\Code\ProjectAlpha` repository in the Vercel dashboard; no build step or environment variables are required.
