# R4TEditor — Feature List

> A lightweight SkriptLang editor built in Python, designed to replace options like skeditor and VSCode for Skript development.

---

## ✅ Implemented

### Editor Core
- Syntax highlighting for SkriptLang
- Code analysis / static analyzer
- Syntax documentation lookup (`/api/syntax/docs`)
- Addon syntax support (`/api/syntax/addons`)
- Syntax status panel showing doc/addon load state

### File Management
- Open and read local files
- Write / save local files
- Move / rename files
- Directory listing and browsing
- Native folder picker dialog (OS file browser)
- Native file picker dialog (OS file browser)

### SFTP (Remote Editing)
- Connect to remote servers via SFTP (host, port, username, password/key)
- List remote directories
- Read remote files
- Write remote files
- Disconnect sessions
- Multiple concurrent SFTP sessions

### Environment Scanner
- Scan a server directory for installed Skript plugins
- Detect and classify plugins (Skript, addons, other)
- Extract plugin metadata from `.jar` files (`plugin.yml`)

### Themes
- Built-in themes: **Forest Dark**, **Light Default**, **Royal Purple Dark**
- Load and apply themes by ID
- Save / modify existing themes
- Upload custom theme files (`.json`)

### Settings
- Persistent settings (read/write to local JSON)
- Update settings via API

### Logging & Diagnostics
- Real-time log streaming over WebSocket (`/ws/logs`)
- Live diagnostics WebSocket (`/ws/diagnostics`)
- Log broker fans out to all connected clients
- Captures both Python `logging` records and raw stdout/stderr

### App Shell
- Runs as a standalone desktop app via `pywebview` (no browser required)
- Falls back to opening in the system browser if the webview fails
- Server-ready detection (no blind sleep — polls until ready)
- Packaged as a single `.exe` via PyInstaller

---

## 🔜 Planned / Todo

> Have a feature request? Send a message — *R4T Out.*

- [ ] Project / workspace management
- [ ] Auto-complete / IntelliSense for Skript syntax
- [ ] Error highlighting inline in the editor
- [ ] Git integration
- [ ] Plugin/addon manager (install, update, remove)
- [ ] Multi-tab editing
- [ ] Terminal / console panel
- [ ] Find & replace
- [ ] Keybind customization
- [ ] Linux & macOS builds
