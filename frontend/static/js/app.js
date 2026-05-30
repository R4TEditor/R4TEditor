/**
 * R4TEditor, Main Application Logic
 */

// ============================================================
// Global State
// ============================================================
const state = {
  tabs:               [],       // Open editor tabs: [{ id, name, path, content, unsaved, sftp?, sftpSessionId? }]
  activeTabId:        null,     // ID of the currently focused tab
  settings:           {},       // Persisted user settings from backend
  projectPath:        null,     // Path of the active explorer folder
  editorView:         null,     // CodeMirror EditorView instance
  suppressChange:     false,    // Prevent onChange loop when setting content programmatically
  currentTheme:       null,     // Currently active theme object
  themes:             [],       // All available themes from backend
  sftp:               { sessionId: null, host: null },  // Legacy SFTP compat reference
  explorerTabs:       [],       // Multi-folder tabs: [{ id, path, name }]
  activeExplorerTabId: null,    // ID of the active explorer folder tab
  sftpSites:          [],       // Saved SFTP connections: [{ id, name, host, port, user, pass?, savePass, keyPath }]
  sftpConns:          [],       // Active SFTP sessions: [{ id, sessionId, host, user, label, siteId }]
  findReplace:        { mode: null, matches: [], matchIdx: 0 },
};

// ============================================================
// API Helper
// ============================================================
const API = "http://127.0.0.1:7842";


async function api(method, endpoint, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API + endpoint, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

// DOM shorthand helpers
const $  = (id) => document.getElementById(id);
const $q  = (s)  => document.querySelector(s);
const $qa = (s)  => [...document.querySelectorAll(s)];

// ============================================================
// Docs URL Fixer
// Ensures "Open in Docs" links use the correct /docs.html#<id> format
// rather than the bare-hash legacy format.
// ============================================================
function fixDocsLinks() {
  document.querySelectorAll('a[href*="docs.skriptlang.org/#"]').forEach(a => {
    a.href = a.href.replace('docs.skriptlang.org/#', 'docs.skriptlang.org/docs.html#');
    a.classList.add('doc-link-fixed');
  });
}

// Watch for dynamically inserted doc links (e.g. hover tooltips)
const _docsObserver = new MutationObserver(() => fixDocsLinks());
_docsObserver.observe(document.body, { childList: true, subtree: true });

// ============================================================
// Debug Console
// ============================================================
let _debugVisible = false;

/** Maps log level strings to their CSS class names for coloured output */
const _levelClass = {
  DEBUG:    "debug-line--debug",
  INFO:     "debug-line--info",
  WARNING:  "debug-line--warning",
  ERROR:    "debug-line--error",
  CRITICAL: "debug-line--error",
};

/** Appends a timestamped message to the debug panel. Caps history at 500 lines. */
function debugLog(msg, level = "INFO") {
  if (typeof msg === "string" && msg.includes("200 OK")) return; // suppress access-log noise

  const panel = $("debug-panel");
  if (!panel) return;

  const line = document.createElement("div");
  line.className = "debug-line " + (_levelClass[level] || "");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;

  while (panel.children.length > 500) panel.removeChild(panel.firstChild);
}

/** Toggles the debug console panel open/closed. */
function toggleDebugPanel() {
  _debugVisible = !_debugVisible;
  $("debug-panel-wrapper")?.classList.toggle("debug-open", _debugVisible);
  $("debug-toggle-btn")?.classList.toggle("active", _debugVisible);
}

// ============================================================
// Backend Log Streaming (WebSocket)
// Auto-reconnects every 3s if the connection drops.
// ============================================================
let _logSocket = null;
let _logReconnectTimer = null;

function initLogStream() {
  if (_logSocket && _logSocket.readyState <= 1) return; // already open or connecting

  _logSocket = new WebSocket(`ws://127.0.0.1:7842/ws/logs`);

  _logSocket.addEventListener("message", (evt) => {
    try {
      const { level, msg } = JSON.parse(evt.data);
      debugLog(msg, level);
    } catch {
      debugLog(evt.data);
    }
  });

  _logSocket.addEventListener("open", () => {
    debugLog("── log stream connected ──", "INFO");
    clearTimeout(_logReconnectTimer);
  });

  _logSocket.addEventListener("close", () => {
    _logReconnectTimer = setTimeout(initLogStream, 3000);
  });
}

// ============================================================
// Internet Status Indicator
// Uses navigator.onLine events + a periodic DNS ping for accuracy.
// ============================================================
function updateInternetStatus(online) {
  const dot   = $("internet-dot");
  const label = $("internet-label");
  if (!dot || !label) return;

  if (online) {
    dot.className     = "status-dot status-dot--internet online";
    label.textContent = "Online";
  } else {
    dot.className     = "status-dot status-dot--internet offline";
    label.textContent = "No Internet";
  }
}

function initInternetStatus() {
  updateInternetStatus(navigator.onLine);
  window.addEventListener("online",  () => { updateInternetStatus(true);  debugLog("Internet connection restored"); });
  window.addEventListener("offline", () => { updateInternetStatus(false); debugLog("Internet connection lost"); });

  // Verify connectivity every 30s with a lightweight no-cors ping
  setInterval(async () => {
    try {
      await fetch("https://dns.google/resolve?name=google.com&type=A", { cache: "no-store", mode: "no-cors" });
      updateInternetStatus(true);
    } catch {
      updateInternetStatus(false);
    }
  }, 30_000);
}

// ============================================================
// Theme System
// ============================================================

/** Fetches the theme list from the backend and populates the selector. */
async function loadThemes() {
  try {
    const data = await api("GET", "/api/themes");
    state.themes = data.themes || [];
    populateThemeSelector();
  } catch (e) {
    console.warn("Could not load themes:", e);
  }
}

/** Fetches and applies a theme by its ID, updating both DOM vars and CodeMirror. */
async function applyThemeById(themeId) {
  try {
    const theme = await api("GET", `/api/themes/${themeId}`);
    state.currentTheme = theme;
    const { applyThemeToDOM, reconfigureTheme } = await import("/static/js/editor.js");
    applyThemeToDOM(theme);
    if (state.editorView) reconfigureTheme(state.editorView, theme);
    const sel = $("theme-select");
    if (sel) sel.value = themeId;
  } catch (e) {
    console.warn("Theme load failed:", e);
  }
}

/** Rebuilds the theme <select> options from state.themes. */
function populateThemeSelector() {
  const sel = $("theme-select");
  if (!sel) return;
  sel.innerHTML = "";
  for (const t of state.themes) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name + (t.user ? " *" : ""); // * marks user-uploaded themes
    sel.appendChild(opt);
  }
  sel.value = state.settings.theme_id || "royal-purple-dark";
}

// ============================================================
// Settings
// ============================================================

/** Loads settings from the backend, falling back to safe defaults. */
async function loadSettings() {
  try {
    state.settings = await api("GET", "/api/settings");
  } catch {
    state.settings = {
      theme_id: "royal-purple-dark",
      editor_font_size: 14,
      tab_width: 4,
      autocomplete: true,
      indent_guides: true,
      minimap: false,
    };
  }
  syncSettingsUI(state.settings);
}

/** Pushes persisted settings values into the settings panel UI elements. */
function syncSettingsUI(s) {
  // Font size slider + label
  const fsInput = $("font-size-input");
  const fsVal   = $("font-size-value");
  if (fsInput) fsInput.value = s.editor_font_size || 14;
  if (fsVal)   fsVal.textContent = (s.editor_font_size || 14) + "px";
  document.documentElement.style.setProperty("--font-size-editor", (s.editor_font_size || 14) + "px");

  // Line height slider + label
  const lh = s.line_height || 1.6;
  $("line-height-input") && ($("line-height-input").value = lh);
  $("line-height-value") && ($("line-height-value").textContent = lh);
  document.documentElement.style.setProperty("--line-height-editor", lh);

  // Editor font family
  const font = s.editor_font || "JetBrains Mono";
  $("editor-font-input") && ($("editor-font-input").value = font);
  document.documentElement.style.setProperty("--font-editor", `"${font}", "Fira Code", monospace`);

  // Tab width segmented buttons
  $qa("#tab-width-toggle .seg-btn").forEach(btn =>
    btn.classList.toggle("seg-btn--active", parseInt(btn.dataset.value) === (s.tab_width || 4)));

  // Toggle checkboxes
  $("autocomplete-toggle") && ($("autocomplete-toggle").checked = s.autocomplete !== false);
  $("indent-guides-toggle") && ($("indent-guides-toggle").checked = s.indent_guides !== false);
  $("minimap-toggle") && ($("minimap-toggle").checked = s.minimap === true);
  $("upload-on-save-toggle") && ($("upload-on-save-toggle").checked = s.upload_on_save === true);

  // Sidebar position segmented buttons + layout class
  const pos = s.sidebar_position || "left";
  $qa("#sidebar-position-toggle .seg-btn").forEach(btn =>
    btn.classList.toggle("seg-btn--active", btn.dataset.value === pos));
  applySidebarPosition(pos);

  // Script header template
  $("header-enable-toggle") && ($("header-enable-toggle").checked = s.header_enabled === true);
  $("header-template-input") && ($("header-template-input").value = s.header_template || "");
  updateHeaderPreview(s.header_template || "");
  updateHeaderEditorState(s.header_enabled === true);
}

/** Applies the sidebar position class to the main layout element. */
function applySidebarPosition(pos) {
  $("main-layout").classList.toggle("layout--sidebar-right", pos === "right");
}

/** Persists a single setting key/value to the backend. */
async function saveSetting(key, value) {
  state.settings[key] = value;
  try { await api("POST", "/api/settings", { settings: { [key]: value } }); }
  catch (e) { console.warn("Settings save failed:", e); }
}

// ============================================================
// Native Folder / File Pickers (backend tkinter dialogs)
// ============================================================

/** Opens a native OS folder picker via the backend. Falls back to a prompt. */
async function pickFolder() {
  try {
    const data = await api("GET", "/api/browse/folder");
    if (data.path) openFolder(data.path);
  } catch {
    const path = prompt("Enter folder path:");
    if (path?.trim()) openFolder(path.trim());
  }
}

/** Opens a native OS file picker via the backend. Falls back to a prompt. */
async function pickFile() {
  try {
    const data = await api("GET", "/api/browse/file");
    if (data.path) {
      const name = data.path.replace(/\\/g, "/").split("/").pop();
      openFile(data.path, name);
    }
  } catch {
    const path = prompt("Enter file path:");
    if (path?.trim()) {
      const name = path.replace(/\\/g, "/").split("/").pop();
      openFile(path.trim(), name);
    }
  }
}

// ============================================================
// SFTP, Saved Sites
// Sites are stored in localStorage. Passwords are only saved if savePass is true.
// ============================================================
const SFTP_SITES_KEY = "r4t_sftp_sites";

function loadSftpSites() {
  try { state.sftpSites = JSON.parse(localStorage.getItem(SFTP_SITES_KEY) || "[]"); }
  catch { state.sftpSites = []; }
  renderSftpSitesList();
}

function saveSftpSitesToStorage() {
  const toSave = state.sftpSites.map(s => ({
    ...s,
    pass: s.savePass ? s.pass : "", // strip password if user didn't opt-in
  }));
  localStorage.setItem(SFTP_SITES_KEY, JSON.stringify(toSave));
}

let _sftpSiteEditId = null; // null = adding a new site

/** Opens the SFTP site add/edit dialog, pre-filled if editing an existing site. */
function showSftpSiteDialog(siteId = null) {
  _sftpSiteEditId = siteId;
  const site = siteId ? state.sftpSites.find(s => s.id === siteId) : null;
  $("sftp-site-dialog-title").textContent = siteId ? "Edit SFTP Site" : "Add SFTP Site";
  $("sftp-site-name").value       = site?.name    || "";
  $("sftp-site-host").value       = site?.host    || "";
  $("sftp-site-port").value       = site?.port    || 22;
  $("sftp-site-user").value       = site?.user    || "";
  $("sftp-site-pass").value       = site?.pass    || "";
  $("sftp-site-savepass").checked = !!site?.savePass;
  $("sftp-site-key").value        = site?.keyPath || "";
  $("sftp-site-delete").style.display = siteId ? "" : "none";
  $("sftp-site-overlay").hidden = false;
  $("sftp-site-name").focus();
}

function hideSftpSiteDialog() {
  $("sftp-site-overlay").hidden = true;
}

function saveSftpSite() {
  const host = $("sftp-site-host").value.trim();
  const user = $("sftp-site-user").value.trim();
  if (!host || !user) { showNotification("Host and username are required", "error"); return; }

  const patch = {
    name:     $("sftp-site-name").value.trim() || "Unnamed Site",
    host,
    port:     parseInt($("sftp-site-port").value) || 22,
    user,
    pass:     $("sftp-site-pass").value,
    savePass: $("sftp-site-savepass").checked,
    keyPath:  $("sftp-site-key").value.trim(),
  };

  if (_sftpSiteEditId) {
    const site = state.sftpSites.find(s => s.id === _sftpSiteEditId);
    if (site) Object.assign(site, patch);
  } else {
    state.sftpSites.push({ id: genId(), ...patch });
  }

  saveSftpSitesToStorage();
  renderSftpSitesList();
  hideSftpSiteDialog();
}

function deleteSftpSite() {
  if (!_sftpSiteEditId || !confirm("Delete this SFTP site?")) return;
  state.sftpSites = state.sftpSites.filter(s => s.id !== _sftpSiteEditId);
  saveSftpSitesToStorage();
  renderSftpSitesList();
  hideSftpSiteDialog();
}

function renderSftpSitesList() {
  const el = $("sftp-sites");
  if (!state.sftpSites.length) {
    el.innerHTML = `<div class="sftp-sites-empty">No saved sites.<br>Click + to add one.</div>`;
    return;
  }
  el.innerHTML = "";
  for (const site of state.sftpSites) {
    const row = document.createElement("div");
    row.className = "sftp-site-row";
    row.innerHTML = `
      <div>
        <div class="sftp-site-row__name">${escHtml(site.name)}</div>
        <div class="sftp-site-row__host">${escHtml(site.user)}@${escHtml(site.host)}:${site.port}</div>
      </div>
      <div class="sftp-site-row__actions">
        <button class="icon-btn icon-btn--icon-only icon-btn--sm" title="Edit" data-edit="${site.id}">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M11 2l3 3-9 9H2v-3l9-9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>
        </button>
      </div>`;
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit]")) return;
      connectSftpSite(site);
    });
    row.querySelector("[data-edit]").addEventListener("click", (e) => {
      e.stopPropagation();
      showSftpSiteDialog(site.id);
    });
    el.appendChild(row);
  }
}

// ============================================================
// SFTP, Active Connections
// ============================================================

async function connectSftpSite(site) {
  let password = site.pass;
  if (!password && !site.keyPath) {
    password = prompt(`Password for ${site.user}@${site.host}:`) || "";
  }
  try {
    const data = await api("POST", "/api/sftp/connect", {
      host: site.host, port: site.port, username: site.user,
      password: password || null,
      key_path: site.keyPath || null,
    });
    const conn = {
      id: genId(),
      sessionId: data.session_id,
      host: site.host,
      user: site.user,
      label: site.name || site.host,
      siteId: site.id,
    };
    state.sftpConns.push(conn);

    // Keep legacy single-sftp reference so saveActiveFile can still reach the session
    state.sftp.sessionId = data.session_id;
    state.sftp.host = site.host;

    renderSftpConnectionsList();
    showNotification(`Connected to ${site.host}`, "success");
    debugLog(`SFTP connected: ${site.user}@${site.host}:${site.port}`);
    openSftpConnectionTree(conn, "/");
    activateSidebarSection("sftp");
  } catch (e) {
    showNotification("SFTP connect failed: " + e.message, "error");
  }
}

function renderSftpConnectionsList() {
  const el = $("sftp-connections");
  const header = $("sftp-connections-header");
  el.innerHTML = "";
  if (!state.sftpConns.length) { header.style.display = "none"; return; }
  header.style.display = "";

  for (const conn of state.sftpConns) {
    const row = document.createElement("div");
    row.className = "sftp-conn-row";
    row.innerHTML = `
      <span class="sftp-conn-dot"></span>
      <span class="sftp-conn-label">${escHtml(conn.label)} (${escHtml(conn.user)})</span>
      <button class="sftp-conn-close" title="Disconnect" data-id="${conn.id}">✕</button>`;
    row.querySelector(".sftp-conn-close").addEventListener("click", (e) => {
      e.stopPropagation();
      disconnectSftpConn(conn.id);
    });
    row.addEventListener("click", (e) => {
      if (e.target.closest(".sftp-conn-close")) return;
      // Scroll the file tree for this connection into view
      document.querySelector(`[data-conn-id="${conn.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    el.appendChild(row);
  }
}

async function disconnectSftpConn(connId) {
  const conn = state.sftpConns.find(c => c.id === connId);
  if (!conn) return;
  try { await api("POST", "/api/sftp/disconnect", { session_id: conn.sessionId }); } catch {}
  state.sftpConns = state.sftpConns.filter(c => c.id !== connId);
  document.querySelector(`[data-conn-id="${connId}"]`)?.remove();
  renderSftpConnectionsList();
  showNotification("Disconnected from SFTP", "info");
}

/** Creates a collapsible file-tree panel for a single SFTP connection. */
function openSftpConnectionTree(conn, path) {
  const area = $("sftp-trees-area");

  // Remove any existing tree panel for this connection before re-creating
  area.querySelector(`[data-conn-id="${conn.id}"]`)?.remove();

  const wrapper = document.createElement("div");
  wrapper.dataset.connId = conn.id;
  wrapper.style.cssText = "border-top:1px solid var(--border-subtle);";

  const hdr = document.createElement("div");
  hdr.className = "sidebar-header";
  hdr.style.cssText = "font-size:10px;padding:5px 8px;";
  hdr.innerHTML = `<span class="sidebar-title" style="font-size:9px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(conn.label)}</span>`;
  wrapper.appendChild(hdr);

  const tree = document.createElement("div");
  tree.className = "file-tree";
  tree.style.cssText = "max-height:220px;flex:none;";
  wrapper.appendChild(tree);

  area.appendChild(wrapper);
  renderSftpDirInto(conn.sessionId, path, tree, 0, conn);
}

async function renderSftpDirInto(sessionId, dirPath, container, depth, conn) {
  try {
    const data = await api("POST", "/api/sftp/list", { session_id: sessionId, path: dirPath });
    for (const entry of data.entries) {
      container.appendChild(makeSftpTreeItem(entry, depth, sessionId, conn));
    }
  } catch (e) {
    showNotification("SFTP list failed: " + e.message, "error");
  }
}

function makeSftpTreeItem(entry, depth, sessionId, conn) {
  const item = document.createElement("div");
  item.className = `tree-item indent-${Math.min(depth, 4)}`;
  item.dataset.path  = entry.path;
  item.dataset.isDir = entry.is_dir ? "true" : "false";
  item.dataset.name  = entry.name;

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.innerHTML = entry.is_dir ? folderIcon(false) : fileIcon(entry.extension);

  const nameEl = document.createElement("span");
  nameEl.className = "tree-name" + (entry.extension === ".sk" ? " sk-file" : "");
  nameEl.textContent = entry.name;

  item.appendChild(icon);
  item.appendChild(nameEl);

  // Right-click context menu for all local tree items
  item.addEventListener("contextmenu", (e) => showTreeContextMenu(e, item));

  if (entry.is_dir) {
    item.classList.add("is-dir");
    item.dataset.open = "false";
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (item.dataset.open === "true") {
        collapseDir(item);
      } else {
        icon.innerHTML = folderIcon(true);
        item.dataset.open = "true";
        const data = await api("POST", "/api/sftp/list", { session_id: sessionId, path: entry.path }).catch(() => null);
        if (!data) return;
        const children = data.entries.map(child => {
          const childItem = makeSftpTreeItem(child, depth + 1, sessionId, conn);
          childItem.dataset.parentPath = entry.path;
          return childItem;
        });
        item._treeChildren = children;
        item.after(...children);
      }
    });
  } else {
    item.addEventListener("click", async () => {
      try {
        const data = await api("POST", "/api/sftp/read", { session_id: sessionId, path: entry.path });
        const tab = { id: genId(), name: entry.name, path: entry.path, content: data.content, unsaved: false, sftp: true, sftpSessionId: sessionId };
        state.tabs.push(tab);
        renderTabs();
        setActiveTab(tab.id);
      } catch (e) {
        showNotification("SFTP read failed: " + e.message, "error");
      }
    });
  }
  return item;
}

/** Disconnects all active SFTP sessions. */
async function disconnectSftp() {
  for (const conn of [...state.sftpConns]) await disconnectSftpConn(conn.id);
}

// ============================================================
// Sidebar Section Switcher
// ============================================================

/** Activates a named sidebar section (e.g. "explorer", "sftp", "env"). */
function activateSidebarSection(name) {
  $qa(".sidebar-tab").forEach(btn =>
    btn.classList.toggle("sidebar-tab--active", btn.dataset.section === name));
  $qa(".sidebar-section").forEach(sec =>
    sec.classList.toggle("sidebar-section--hidden", !sec.id.endsWith("-" + name)));
}

// ============================================================
// Explorer, Multi-Folder Tabs
// ============================================================

/** Adds a folder to the explorer tab bar. Avoids duplicates. */
function addExplorerTab(path) {
  if (!path) return;
  const existing = state.explorerTabs.find(t => t.path === path);
  if (existing) { activateExplorerTab(existing.id); return; }

  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  const id = genId();
  state.explorerTabs.push({ id, path, name });
  renderExplorerTabs();
  activateExplorerTab(id);
}

/** Switches the explorer to show the given folder tab and loads its file tree. */
function activateExplorerTab(id) {
  state.activeExplorerTabId = id;
  const tab = state.explorerTabs.find(t => t.id === id);
  renderExplorerTabs();

  const tree = $("file-tree");
  if (tab) {
    state.projectPath = tab.path;
    $("project-name").textContent = tab.name;
    tree.innerHTML = "";
    renderDirInto(tab.path, tree, 0);
  } else {
    state.projectPath = null;
    $("project-name").textContent = "No Project Open";
    tree.innerHTML = `<div class="file-tree-empty">
      <svg width="32" height="32" viewBox="0 0 16 16" fill="none" style="opacity:0.25">
        <path d="M1 3a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3z" stroke="currentColor" stroke-width="1.2" fill="none"/>
      </svg>
      <p>Open a folder to<br>start editing</p>
      <button class="btn btn--primary" id="open-folder-btn2b">Open Folder</button>
    </div>`;
    $("open-folder-btn2b")?.addEventListener("click", pickFolder);
  }
}

function closeExplorerTab(id) {
  state.explorerTabs = state.explorerTabs.filter(t => t.id !== id);
  if (state.activeExplorerTabId === id) {
    activateExplorerTab(state.explorerTabs[0]?.id ?? null);
  }
  renderExplorerTabs();
}

function renderExplorerTabs() {
  const bar = $("explorer-tabs");
  bar.innerHTML = "";
  for (const tab of state.explorerTabs) {
    const el = document.createElement("div");
    el.className = "explorer-folder-tab" + (tab.id === state.activeExplorerTabId ? " explorer-folder-tab--active" : "");
    el.title = tab.path;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = tab.name;

    const close = document.createElement("button");
    close.className = "etab-close";
    close.innerHTML = "✕";
    close.title = "Close";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeExplorerTab(tab.id); });

    el.appendChild(nameSpan);
    el.appendChild(close);
    el.addEventListener("click", () => activateExplorerTab(tab.id));
    bar.appendChild(el);
  }
}

// ============================================================
// File Tree
// ============================================================

/** Opens a folder in the explorer and scans the environment non-blocking. */
async function openFolder(path) {
  if (!path) return;
  addExplorerTab(path);
  activateSidebarSection("explorer");
  scanEnvironment(path).catch(() => {});
}

async function renderDirInto(dirPath, container, depth) {
  try {
    const data = await api("POST", "/api/directory/list", { path: dirPath });
    for (const entry of data.entries) container.appendChild(makeTreeItem(entry, depth));
  } catch (e) {
    showNotification("Cannot open folder: " + e.message, "error");
  }
}

function makeTreeItem(entry, depth) {
  const item = document.createElement("div");
  item.className = `tree-item indent-${Math.min(depth, 4)}`;
  item.dataset.path  = entry.path;
  item.dataset.isDir = entry.is_dir ? "true" : "false";
  item.dataset.name  = entry.name;

  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.innerHTML = entry.is_dir ? folderIcon(false) : fileIcon(entry.extension);

  const nameEl = document.createElement("span");
  nameEl.className = "tree-name" + (entry.extension === ".sk" ? " sk-file" : "");
  nameEl.textContent = entry.name;

  item.appendChild(icon);
  item.appendChild(nameEl);

  // Right-click context menu (matches SFTP tree behaviour)
  item.addEventListener("contextmenu", (e) => showTreeContextMenu(e, item));

  if (entry.is_dir) {
    item.classList.add("is-dir");
    item.dataset.open = "false";

    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (item.dataset.open === "true") collapseDir(item);
      else await expandDir(item, entry.path, depth + 1, icon);
    });

    // Accept internal drag-and-drop (tree-to-tree file moves)
    item.addEventListener("dragover", (e) => { e.preventDefault(); item.classList.add("drop-target"); });
    item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("drop-target");
      const srcPath = e.dataTransfer.getData("text/plain");
      if (srcPath && srcPath !== entry.path) moveFileToDir(srcPath, entry.path);
    });
  } else {
    item.addEventListener("click", () => openFile(entry.path, entry.name));

    // Make file items draggable so they can be dropped onto folder items
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", entry.path);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
  }
  return item;
}

async function expandDir(item, dirPath, childDepth, icon) {
  icon.innerHTML = folderIcon(true);
  item.dataset.open = "true";
  const data = await api("POST", "/api/directory/list", { path: dirPath }).catch(() => null);
  if (!data) return;
  const children = data.entries.map(entry => {
    const child = makeTreeItem(entry, childDepth);
    child.dataset.parentPath = dirPath;
    return child;
  });
  item._treeChildren = children;
  item.after(...children);
}

function collapseDir(item) {
  item.dataset.open = "false";
  item.querySelector(".tree-icon").innerHTML = folderIcon(false);
  removeDescendants(item);
  item._treeChildren = null;
}

function removeDescendants(item) {
  for (const child of (item._treeChildren || [])) {
    if (child.dataset.isDir === "true") removeDescendants(child);
    child.remove();
  }
}

async function moveFileToDir(srcPath, dstDir) {
  const srcName = srcPath.replace(/\\/g, "/").split("/").pop();
  try {
    const res = await api("POST", "/api/file/move", { src: srcPath, dst_dir: dstDir });
    showNotification(`Moved ${srcName}`, "success");
    const tab = state.tabs.find(t => t.path === srcPath);
    if (tab) { tab.path = res.new_path; renderTabs(); }
    if (state.projectPath) await openFolder(state.projectPath);
  } catch (e) {
    showNotification("Move failed: " + e.message, "error");
  }
}

/** Highlights the tree item that matches the given file path. */
function updateActiveTreeItem(path) {
  $qa(".tree-item").forEach(el => el.classList.toggle("active", el.dataset.path === path));
}

// ============================================================
// Context Menu
// ============================================================

let _ctxMenu = null;

function closeContextMenu() {
  _ctxMenu?.remove();
  _ctxMenu = null;
}

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999;`;

  for (const item of items) {
    if (item === "---") {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "ctx-item" + (item.danger ? " ctx-item--danger" : "");
    btn.textContent = item.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  _ctxMenu = menu;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth)   menu.style.left = (x - rect.width) + "px";
    if (rect.bottom > window.innerHeight) menu.style.top  = (y - rect.height) + "px";
  });
}

document.addEventListener("click", closeContextMenu, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });

// ============================================================
// File Tree Operations (Delete, Rename, Copy Path)
// ============================================================

async function deleteFile(filePath, fileName, treeItem) {
  if (!confirm(`Delete "${fileName}"?\nThis cannot be undone.`)) return;
  try {
    await api("POST", "/api/file/delete", { path: filePath });
    const tab = state.tabs.find(t => t.path === filePath);
    if (tab) {
      state.tabs = state.tabs.filter(t => t.id !== tab.id);
      if (state.activeTabId === tab.id) {
        const next = state.tabs[0];
        if (next) setActiveTab(next.id);
        else { state.activeTabId = null; showWelcome(); }
      }
      renderTabs();
    }
    treeItem.remove();
    showNotification(`Deleted: ${fileName}`, "success");
    debugLog(`Deleted file: ${filePath}`);
  } catch (e) {
    showNotification("Delete failed: " + e.message, "error");
  }
}

async function deleteDirectory(dirPath, dirName, treeItem) {
  if (!confirm(`Delete folder "${dirName}" and ALL its contents?\nThis cannot be undone.`)) return;
  try {
    await api("POST", "/api/directory/delete", { path: dirPath });
    const prefix = dirPath.replace(/\\/g, "/") + "/";
    const removed = state.tabs.filter(t => t.path && t.path.replace(/\\/g, "/").startsWith(prefix));
    state.tabs = state.tabs.filter(t => !removed.includes(t));
    if (removed.find(t => t.id === state.activeTabId)) {
      const next = state.tabs[0];
      if (next) setActiveTab(next.id);
      else { state.activeTabId = null; showWelcome(); }
    }
    renderTabs();
    if (treeItem.dataset.open === "true") collapseDir(treeItem);
    treeItem.remove();
    showNotification(`Deleted folder: ${dirName}`, "success");
    debugLog(`Deleted directory: ${dirPath}`);
  } catch (e) {
    showNotification("Delete failed: " + e.message, "error");
  }
}

function startRename(itemPath, itemName, treeItem) {
  const nameEl = treeItem.querySelector(".tree-name");
  if (!nameEl) return;

  const input = document.createElement("input");
  input.className = "tree-rename-input";
  input.value = itemName;
  nameEl.replaceWith(input);
  input.focus();
  const dotIdx = itemName.lastIndexOf(".");
  input.setSelectionRange(0, dotIdx > 0 ? dotIdx : itemName.length);

  const commit = async () => {
    const newName = input.value.trim();
    input.replaceWith(nameEl);
    if (!newName || newName === itemName) return;
    try {
      const res = await api("POST", "/api/file/rename", { path: itemPath, new_name: newName });
      treeItem.dataset.path = res.new_path;
      treeItem.dataset.name = newName;
      nameEl.textContent = newName;
      if (newName.endsWith(".sk")) nameEl.classList.add("sk-file");
      else nameEl.classList.remove("sk-file");
      const tab = state.tabs.find(t => t.path === itemPath);
      if (tab) { tab.path = res.new_path; tab.name = newName; renderTabs(); }
      showNotification(`Renamed to: ${newName}`, "success");
    } catch (e) {
      showNotification("Rename failed: " + e.message, "error");
    }
  };

  const cancel = () => input.replaceWith(nameEl);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener("blur", commit);
}

function showTreeContextMenu(e, treeItem) {
  e.preventDefault();
  e.stopPropagation();

  const isDir   = treeItem.dataset.isDir === "true";
  const filePath = treeItem.dataset.path;
  const fileName = treeItem.dataset.name;

  const items = [];

  if (!isDir) {
    items.push({ label: "Open", action: () => openFile(filePath, fileName) });
    items.push("---");
  }

  items.push({ label: "Rename", action: () => startRename(filePath, fileName, treeItem) });
  items.push({ label: "Copy Path", action: () => {
    navigator.clipboard.writeText(filePath).then(
      () => showNotification("Path copied", "success"),
      () => showNotification("Copy failed", "error")
    );
  }});
  items.push("---");

  if (isDir) {
    items.push({ label: "Delete Folder…", danger: true, action: () => deleteDirectory(filePath, fileName, treeItem) });
  } else {
    items.push({ label: "Delete File…", danger: true, action: () => deleteFile(filePath, fileName, treeItem) });
  }

  showContextMenu(e.clientX, e.clientY, items);
}

function folderIcon(open) {
  const opacity = open ? "" : ' opacity="0.5"';
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 4a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z" fill="var(--syn-expression)"${opacity}/></svg>`;
}

function fileIcon(ext) {
  if (ext === ".sk")
    return `<svg width="12" height="14" viewBox="0 0 12 14" fill="none"><rect x="1" y="1" width="10" height="12" rx="1.5" fill="var(--syn-keyword)" opacity="0.15" stroke="var(--syn-keyword)" stroke-width="1"/><text x="6" y="9" text-anchor="middle" font-size="5" fill="var(--syn-keyword)" font-family="monospace" font-weight="700">sk</text></svg>`;
  return `<svg width="12" height="14" viewBox="0 0 12 14" fill="none"><rect x="1" y="1" width="10" height="12" rx="1.5" fill="none" stroke="var(--text-muted)" stroke-width="1"/></svg>`;
}

// ============================================================
// Page-Wide File Drop
// Dragging a file from the OS desktop or file manager onto anywhere
// in the app will send it to the backend and open it as a tab.
// ============================================================

function initPageFileDrop() {
  // Show a visual drop overlay while a file is hovering over the window
  const overlay = document.createElement("div");
  overlay.id = "drop-overlay";
  overlay.innerHTML = `<div class="drop-overlay-inner">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 4v12M8 8l4-4 4 4"/>
    </svg>
    <span>Drop to open file</span>
  </div>`;
  document.body.appendChild(overlay);

  // Counter tracks nested dragenter/dragleave pairs so the overlay doesn't flicker
  let dragDepth = 0;

  document.addEventListener("dragenter", (e) => {
    // Only respond to files dragged from outside the browser
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth++;
    overlay.classList.add("visible");
  });

  document.addEventListener("dragleave", () => {
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; overlay.classList.remove("visible"); }
  });

  document.addEventListener("dragover", (e) => {
    // Required to allow the drop event to fire
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  });

  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove("visible");

    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;

    for (const file of files) {
      // Ask the backend to resolve the dropped file to a filesystem path,
      // then read and open it as a tab
      try {
        const data = await api("POST", "/api/file/open-dropped", { name: file.name, size: file.size });
        if (data?.path) {
          openFile(data.path, file.name);
        } else {
          // Backend couldn't map the file, read its text content directly
          const text = await file.text();
          const tab = { id: genId(), name: file.name, path: null, content: text, unsaved: false };
          state.tabs.push(tab);
          renderTabs();
          setActiveTab(tab.id);
        }
      } catch {
        // Fallback: open in-memory with the file's text content
        const text = await file.text().catch(() => "");
        const tab = { id: genId(), name: file.name, path: null, content: text, unsaved: false };
        state.tabs.push(tab);
        renderTabs();
        setActiveTab(tab.id);
      }
    }
  });
}

// ============================================================
// Editor Tabs
// ============================================================

function genId() { return Math.random().toString(36).slice(2, 9); }

/** Reads a file from the backend and opens it in a new tab (or focuses it if already open). */
async function openFile(path, name) {
  const existing = state.tabs.find(t => t.path === path);
  if (existing) { setActiveTab(existing.id); return; }

  try {
    const data = await api("POST", "/api/file/read", { path });
    const tab = { id: genId(), path, name, content: data.content, unsaved: false };
    state.tabs.push(tab);
    renderTabs();
    setActiveTab(tab.id);
    updateActiveTreeItem(path);
  } catch (e) {
    showNotification("Cannot open file: " + e.message, "error");
  }
}

function closeTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  if (tab.unsaved && !confirm(`"${tab.name}" has unsaved changes. Close anyway?`)) return;
  const idx = state.tabs.indexOf(tab);
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    if (next) setActiveTab(next.id);
    else { state.activeTabId = null; showWelcome(); }
  }
  renderTabs();
}

/** Switches the editor to display the given tab and loads its content into CodeMirror. */
function setActiveTab(id) {
  state.activeTabId = id;
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  renderTabs();
  $("editor-welcome").style.display = "none";
  $("cm-editor").style.display = "block";
  $("format-toolbar").style.display = "flex";

  if (state.editorView) {
    state.suppressChange = true;
    import("/static/js/editor.js").then(({ setEditorContent }) => {
      setEditorContent(state.editorView, tab.content);
      state.suppressChange = false;
    });
  }
  updateActiveTreeItem(tab.path);
  updateStatusBar();
  updateDiscordRPC(tab);
}

// ============================================================
// Discord Rich Presence
// ============================================================

let _rpcAvailable = null; // null = unchecked, true = connected, false = retry next time

async function updateDiscordRPC(tab) {
  // Re-check every call until connected; once true, trust it until an error
  if (_rpcAvailable !== true) {
    try {
      const st = await api("GET", "/api/rpc/status");
      _rpcAvailable = st.enabled === true;
    } catch {
      _rpcAvailable = false;
    }
  }
  if (!_rpcAvailable) return;

  try {
    const filename = tab ? tab.name : null;
    const isSkript = filename && filename.endsWith(".sk");
    const details  = isSkript ? "Editing a .sk file" : (filename ? "Editing a file" : "Idle");
    const state    = filename || null;
    await api("POST", "/api/rpc/update", { filename, details, state });
  } catch (e) {
    debugLog("Discord RPC update failed: " + e.message, "WARNING");
    _rpcAvailable = false;
  }
}

function showWelcome() {
  $("editor-welcome").style.display = "";
  $("cm-editor").style.display = "none";
  // Clear RPC when no files are open
  if (_rpcAvailable) api("POST", "/api/rpc/clear").catch(() => {});
}

function renderTabs() {
  const list = $("tab-list");
  list.innerHTML = "";
  for (const tab of state.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === state.activeTabId ? " active" : "") + (tab.unsaved ? " unsaved" : "");

    const icon = document.createElement("span");
    icon.innerHTML = tab.name.endsWith(".sk")
      ? `<svg width="10" height="10" viewBox="0 0 12 14" fill="none"><rect x="1" y="1" width="10" height="12" rx="1.5" fill="var(--syn-keyword)" opacity="0.5"/></svg>`
      : `<svg width="10" height="10" viewBox="0 0 12 14" fill="none"><rect x="1" y="1" width="10" height="12" rx="1.5" fill="none" stroke="var(--text-muted)"/></svg>`;

    if (tab.sftp) {
      icon.title = "SFTP file";
      icon.style.opacity = "0.7";
    }

    const nameEl = document.createElement("span");
    nameEl.className = "tab-name";
    nameEl.textContent = (tab.sftp ? "⟳ " : "") + tab.name;

    const close = document.createElement("button");
    close.className = "tab-close";
    close.innerHTML = "x";
    close.title = "Close";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab.id); });

    el.appendChild(icon);
    el.appendChild(nameEl);
    el.appendChild(close);
    el.addEventListener("click", () => setActiveTab(tab.id));
    list.appendChild(el);
  }
}

// ============================================================
// Save
// ============================================================

/** Saves the active tab. SFTP tabs write via the remote session; local tabs write to disk. */
async function saveActiveFile() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab) return;

  if (tab.sftp) {
    const sessionId = tab.sftpSessionId || state.sftp.sessionId;
    if (!sessionId) { showNotification("SFTP session lost, reconnect and try again", "error"); return; }
    try {
      await api("POST", "/api/sftp/write", { session_id: sessionId, path: tab.path, content: tab.content });
      tab.unsaved = false;
      renderTabs();
      showNotification(`Saved to SFTP: ${tab.name}`, "success");
      debugLog(`SFTP write: ${tab.path}`);
    } catch (e) {
      showNotification("SFTP save failed: " + e.message, "error");
    }
    return;
  }

  if (!tab.path) { promptSaveAs(tab); return; }

  try {
    await api("POST", "/api/file/write", { path: tab.path, content: tab.content });
    tab.unsaved = false;
    renderTabs();
    showNotification(`Saved: ${tab.name}`, "success");
  } catch (e) {
    showNotification("Save failed: " + e.message, "error");
  }
}

/** Prompts the user for a filename, then saves the tab to the current project folder. */
function promptSaveAs(tab) {
  const overlay = $("filename-overlay");
  const input   = $("filename-input");
  input.value = tab.name;
  overlay.hidden = false;
  input.focus();
  input.select();

  const doSave = async () => {
    const name = input.value.trim();
    if (!name) return;
    overlay.hidden = true;
    tab.path = (state.projectPath || ".") + "/" + name;
    tab.name = name;
    try {
      await api("POST", "/api/file/write", { path: tab.path, content: tab.content });
      tab.unsaved = false;
      renderTabs();
      showNotification(`Saved: ${tab.name}`, "success");
    } catch (e) {
      showNotification("Save failed: " + e.message, "error");
    }
    cleanup();
  };
  const doCancel = () => { overlay.hidden = true; cleanup(); };
  const cleanup = () => {
    $("filename-confirm").removeEventListener("click", doSave);
    $("filename-cancel").removeEventListener("click", doCancel);
  };
  $("filename-confirm").addEventListener("click", doSave);
  $("filename-cancel").addEventListener("click", doCancel);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSave();
    if (e.key === "Escape") doCancel();
  }, { once: true });
}

// ============================================================
// New File Dialog
// ============================================================

function promptNewFile() {
  const overlay = $("filename-overlay");
  const input   = $("filename-input");
  input.value = "";
  overlay.hidden = false;
  input.focus();

  const doCreate = () => {
    const name = input.value.trim() || "untitled.sk";
    overlay.hidden = true;
    const content = name.endsWith(".sk") ? buildScriptHeader() : "";
    const tab = {
      id: genId(), name, content,
      unsaved: content.length > 0,
      path: state.projectPath ? state.projectPath + "/" + name : null,
    };
    state.tabs.push(tab);
    renderTabs();
    setActiveTab(tab.id);
    cleanup();
  };
  const doCancel = () => { overlay.hidden = true; cleanup(); };
  const cleanup = () => {
    $("filename-confirm").removeEventListener("click", doCreate);
    $("filename-cancel").removeEventListener("click", doCancel);
  };
  $("filename-confirm").addEventListener("click", doCreate);
  $("filename-cancel").addEventListener("click", doCancel);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doCreate();
    if (e.key === "Escape") doCancel();
  }, { once: true });
}

// ============================================================
// Script Header Template
// Stored in backend settings (was previously localStorage).
// A one-time migration runs on first load if old localStorage data is found.
// ============================================================
const HEADER_KEY    = "r4t_script_header";
const HEADER_ON_KEY = "r4t_script_header_enabled";

function loadHeaderTemplate() {
  const lsText    = localStorage.getItem(HEADER_KEY);
  const lsEnabled = localStorage.getItem(HEADER_ON_KEY);
  if (lsText !== null && !state.settings.header_template) {
    state.settings.header_template = lsText;
    state.settings.header_enabled  = lsEnabled !== "false" && lsText.length > 0;
    saveSetting("header_template", state.settings.header_template);
    saveSetting("header_enabled",  state.settings.header_enabled);
    localStorage.removeItem(HEADER_KEY);
    localStorage.removeItem(HEADER_ON_KEY);
  }
}

function saveHeaderTemplate() {
  const text    = $("header-template-input")?.value ?? "";
  const enabled = $("header-enable-toggle")?.checked ?? false;
  state.settings.header_template = text;
  state.settings.header_enabled  = enabled;
  saveSetting("header_template", text);
  saveSetting("header_enabled",  enabled);
}

/**
 * Builds the script file header string from the template.
 * Each non-comment line is prefixed with "# ". Returns "" if disabled or empty.
 */
function buildScriptHeader() {
  if (!($("header-enable-toggle")?.checked)) return "";
  const raw = ($("header-template-input")?.value ?? "").trim();
  if (!raw) return "";
  const lines = raw.split("\n").map(line => {
    if (/^\s*#/.test(line)) return line; // already a comment
    if (line.trim() === "")  return "#"; // blank line → bare #
    return "# " + line;
  });
  return lines.join("\n") + "\n\n";
}

/** Updates the header preview panel with commented output. */
function updateHeaderPreview(rawText) {
  const preview = $("header-preview");
  if (!preview) return;
  if (!rawText.trim()) {
    preview.textContent = "(empty, no header will be added)";
    preview.style.color = "var(--text-muted)";
    preview.style.fontStyle = "italic";
    return;
  }
  preview.style.color = "";
  preview.style.fontStyle = "";
  const lines = rawText.split("\n").map(line => {
    if (/^\s*#/.test(line)) return line;
    if (line.trim() === "")  return "#";
    return "# " + line;
  });
  preview.textContent = lines.join("\n");
}

/** Dims the header editor textarea when the toggle is off. */
function updateHeaderEditorState(enabled) {
  $("header-editor-wrap")?.classList.toggle("header-disabled", !enabled);
}

function wireHeaderTemplate() {
  const toggle   = $("header-enable-toggle");
  const textarea = $("header-template-input");
  if (!toggle || !textarea) return;

  toggle.addEventListener("change", () => {
    updateHeaderEditorState(toggle.checked);
    saveHeaderTemplate();
  });

  textarea.addEventListener("input", () => {
    updateHeaderPreview(textarea.value);
    saveHeaderTemplate();
  });

  // Allow Tab key for indentation inside the header textarea
  textarea.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const s = textarea.selectionStart;
    textarea.value = textarea.value.slice(0, s) + "  " + textarea.value.slice(textarea.selectionEnd);
    textarea.selectionStart = textarea.selectionEnd = s + 2;
    updateHeaderPreview(textarea.value);
    saveHeaderTemplate();
  });
}

// ============================================================
// Find & Replace
// Modes: "file" (current tab), "open-files" (all open tabs), "all-files" (project)
// ============================================================
let _frCurrentMatches = [];
let _frMatchIdx = 0;

function openFindReplace(mode) {
  const bar = $("find-replace-bar");
  const scope = $("fr-scope");
  $("fr-replace-row").style.display = "";
  bar.style.display = "";

  if (mode === "file") {
    scope.style.display = "none";
  } else {
    scope.style.display = "";
    $("fr-scope-label").textContent = mode === "open-files"
      ? "Scope: open files in editor"
      : "Scope: all files & folders in project";
  }

  bar.dataset.mode = mode;
  $("fr-find").focus();
  $("fr-find").select();
  runFindReplace();
}

function closeFindReplace() {
  $("find-replace-bar").style.display = "none";
  _frCurrentMatches = [];
  _frMatchIdx = 0;
  $("fr-count").textContent = "";
  if (state.editorView) state.editorView.focus();
}

function getFrOptions() {
  return {
    useRegex:  $("fr-regex-btn").classList.contains("fr-opt--active"),
    matchCase: $("fr-case-btn").classList.contains("fr-opt--active"),
    wholeWord: $("fr-word-btn").classList.contains("fr-opt--active"),
  };
}

function buildPattern(query, opts) {
  if (!query) return null;
  let src = opts.useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, opts.matchCase ? "g" : "gi");
}

function runFindReplace() {
  const query = $("fr-find").value;
  const mode  = $("find-replace-bar").dataset.mode || "file";
  const opts  = getFrOptions();
  _frCurrentMatches = [];
  _frMatchIdx = 0;

  if (!query) { $("fr-count").textContent = ""; return; }
  const pattern = buildPattern(query, opts);
  if (!pattern) return;

  const searchTabs = mode === "file"
    ? state.tabs.filter(t => t.id === state.activeTabId)
    : state.tabs;

  for (const tab of searchTabs) {
    const content = tab.content || "";
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(content)) !== null) {
      _frCurrentMatches.push({ tabId: tab.id, tabName: tab.name, from: m.index, to: m.index + m[0].length, match: m[0] });
      if (_frCurrentMatches.length > 10000) break;
    }
  }

  const count = _frCurrentMatches.length;
  $("fr-count").textContent = count ? `${Math.min(_frMatchIdx + 1, count)} / ${count}` : "No results";
  if (count && mode === "file") jumpToMatch(0);
}

function jumpToMatch(idx) {
  if (!_frCurrentMatches.length) return;
  _frMatchIdx = (idx + _frCurrentMatches.length) % _frCurrentMatches.length;
  const m = _frCurrentMatches[_frMatchIdx];
  $("fr-count").textContent = `${_frMatchIdx + 1} / ${_frCurrentMatches.length}`;
  if (m.tabId !== state.activeTabId) setActiveTab(m.tabId);
  if (state.editorView) {
    setTimeout(() => {
      state.editorView?.dispatch({ selection: { anchor: m.from, head: m.to }, scrollIntoView: true });
      state.editorView?.focus();
    }, 50);
  }
}

function replaceCurrentMatch() {
  if (!_frCurrentMatches.length) return;
  const m = _frCurrentMatches[_frMatchIdx];
  const replaceText = $("fr-replace").value;
  const tab = state.tabs.find(t => t.id === m.tabId);
  if (!tab) return;

  tab.content = tab.content.slice(0, m.from) + replaceText + tab.content.slice(m.to);
  tab.unsaved = true;
  renderTabs();

  if (tab.id === state.activeTabId && state.editorView) {
    import("/static/js/editor.js").then(({ setEditorContent }) => {
      state.suppressChange = true;
      setEditorContent(state.editorView, tab.content);
      state.suppressChange = false;
    });
  }
  runFindReplace();
}

function replaceAllMatches() {
  if (!_frCurrentMatches.length) return;
  const pattern = buildPattern($("fr-find").value, getFrOptions());
  if (!pattern) return;
  const replaceText = $("fr-replace").value;
  const affectedTabs = new Set(_frCurrentMatches.map(m => m.tabId));

  for (const tabId of affectedTabs) {
    const tab = state.tabs.find(t => t.id === tabId);
    if (!tab) continue;
    tab.content = tab.content.replace(pattern, replaceText);
    tab.unsaved = true;
  }
  renderTabs();

  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  if (activeTab && affectedTabs.has(activeTab.id) && state.editorView) {
    import("/static/js/editor.js").then(({ setEditorContent }) => {
      state.suppressChange = true;
      setEditorContent(state.editorView, activeTab.content);
      state.suppressChange = false;
    });
  }
  showNotification(`Replaced ${_frCurrentMatches.length} occurrence(s)`, "success");
  runFindReplace();
}

function wireFindReplace() {
  $("fr-find").addEventListener("input", runFindReplace);
  $("fr-find").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); jumpToMatch(_frMatchIdx - 1); }
    else if (e.key === "Enter")          { e.preventDefault(); jumpToMatch(_frMatchIdx + 1); }
    else if (e.key === "Escape")         { e.preventDefault(); closeFindReplace(); }
  });
  $("fr-replace").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); replaceCurrentMatch(); }
    else if (e.key === "Escape")                       { e.preventDefault(); closeFindReplace(); }
  });
  $("fr-prev").addEventListener("click", () => jumpToMatch(_frMatchIdx - 1));
  $("fr-next").addEventListener("click", () => jumpToMatch(_frMatchIdx + 1));
  $("fr-close").addEventListener("click", closeFindReplace);
  $("fr-replace-one").addEventListener("click", replaceCurrentMatch);
  $("fr-replace-all").addEventListener("click", replaceAllMatches);

  ["fr-regex-btn", "fr-case-btn", "fr-word-btn"].forEach(id => {
    $(id).addEventListener("click", () => {
      $(id).classList.toggle("fr-opt--active");
      runFindReplace();
    });
  });
}

// ============================================================
// Status Bar
// ============================================================

function updateStatusBar() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  $("sb-lang").textContent = tab ? (tab.name.endsWith(".sk") ? "SkriptLang" : "Plain Text") : "--";
}

function updateCursor(line, col) {
  $("sb-cursor").textContent = `Ln ${line}, Col ${col}`;
}

// ============================================================
// Notifications
// ============================================================

function showNotification(msg, type = "info") {
  let el = document.getElementById("__notif");
  if (!el) {
    el = document.createElement("div");
    el.id = "__notif";
    el.style.cssText = [
      "position:fixed", "bottom:34px", "left:50%", "transform:translateX(-50%)",
      "padding:7px 16px", "border-radius:6px", "font-size:12px",
      "font-family:var(--font-ui)", "z-index:999",
      "box-shadow:0 4px 20px #00000040", "transition:opacity 0.3s",
    ].join(";");
    document.body.appendChild(el);
  }
  const colors = { success: "#22c55e", error: "#ef4444", info: "var(--accent)" };
  el.style.background = colors[type] || colors.info;
  el.style.color = "#fff";
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = "0"; }, 2500);
}

// ============================================================
// Settings Panel Wiring
// ============================================================

function wireSettings() {
  $("settings-btn").addEventListener("click", () => { $("settings-overlay").hidden = false; });
  $("settings-close").addEventListener("click", () => { $("settings-overlay").hidden = true; });
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === $("settings-overlay")) $("settings-overlay").hidden = true;
  });

  // Theme selector
  $("theme-select")?.addEventListener("change", (e) => {
    saveSetting("theme_id", e.target.value);
    applyThemeById(e.target.value);
  });

  // Tab width segmented control
  $qa("#tab-width-toggle .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $qa("#tab-width-toggle .seg-btn").forEach(b => b.classList.remove("seg-btn--active"));
      btn.classList.add("seg-btn--active");
      const tw = parseInt(btn.dataset.value);
      saveSetting("tab_width", tw);
      if (state.editorView)
        import("/static/js/editor.js").then(({ reconfigureTabWidth }) => reconfigureTabWidth(state.editorView, tw));
    });
  });

  // Sidebar position segmented control
  $qa("#sidebar-position-toggle .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $qa("#sidebar-position-toggle .seg-btn").forEach(b => b.classList.remove("seg-btn--active"));
      btn.classList.add("seg-btn--active");
      const pos = btn.dataset.value;
      saveSetting("sidebar_position", pos);
      applySidebarPosition(pos);
    });
  });

  // Font size
  $("font-size-input").addEventListener("input", (e) => {
    const sz = parseInt(e.target.value);
    $("font-size-value").textContent = sz + "px";
    saveSetting("editor_font_size", sz);
    document.documentElement.style.setProperty("--font-size-editor", sz + "px");
  });

  // Editor feature toggles
  $("autocomplete-toggle").addEventListener("change", (e) => {
    saveSetting("autocomplete", e.target.checked);
    if (state.editorView)
      import("/static/js/editor.js").then(({ reconfigureAutocomplete }) => reconfigureAutocomplete(state.editorView, e.target.checked));
  });

  $("indent-guides-toggle").addEventListener("change", (e) => {
    saveSetting("indent_guides", e.target.checked);
    if (state.editorView)
      import("/static/js/editor.js").then(({ reconfigureIndentGuides }) => reconfigureIndentGuides(state.editorView, e.target.checked));
  });

  $("minimap-toggle").addEventListener("change", (e) => {
    saveSetting("minimap", e.target.checked);
    if (state.editorView)
      import("/static/js/editor.js").then(({ reconfigureMinimap }) => reconfigureMinimap(state.editorView, e.target.checked));
  });

  // Line height
  $("line-height-input")?.addEventListener("input", (e) => {
    const lh = parseFloat(e.target.value).toFixed(1);
    $("line-height-value").textContent = lh;
    saveSetting("line_height", parseFloat(lh));
    document.documentElement.style.setProperty("--line-height-editor", lh);
  });

  // Editor font family (debounced to avoid hammering the backend on every keystroke)
  let _fontTimer;
  $("editor-font-input")?.addEventListener("input", (e) => {
    const font = e.target.value.trim() || "JetBrains Mono";
    document.documentElement.style.setProperty("--font-editor", `"${font}", "Fira Code", monospace`);
    clearTimeout(_fontTimer);
    _fontTimer = setTimeout(() => saveSetting("editor_font", font), 600);
  });

  // Upload on save
  $("upload-on-save-toggle")?.addEventListener("change", (e) => {
    saveSetting("upload_on_save", e.target.checked);
  });
}

// ============================================================
// Resize Handles
// Supports both axis directions and an optional delta inversion for
// panels that expand in the opposite direction of mouse movement.
// ============================================================

/**
 * Attaches mousedown/mousemove/mouseup listeners to make an element resizable.
 * @param {HTMLElement} handle     - The drag handle element
 * @param {() => HTMLElement} getEl - Returns the element being resized
 * @param {"x"|"y"} axis           - Resize direction
 * @param {number} minSize         - Minimum size in px
 * @param {() => number} maxFn     - Returns the current maximum size in px
 * @param {string} cssProp         - CSS custom property to keep in sync (e.g. "--sidebar-w")
 * @param {() => boolean} isReversed - Returns true when delta should be inverted
 */
function setupResize(handle, getEl, axis, minSize, maxFn, cssProp, isReversed = () => false) {
  let dragging = false, startPos, startSize;

  handle.addEventListener("mousedown", (e) => {
    dragging  = true;
    startPos  = axis === "x" ? e.clientX : e.clientY;
    startSize = axis === "x" ? getEl().offsetWidth : getEl().offsetHeight;
    document.body.style.cursor     = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta   = (axis === "x" ? e.clientX : e.clientY) - startPos;
    const reverse = isReversed();
    const size    = Math.max(minSize, Math.min(maxFn(), startSize + (reverse ? -delta : delta)));
    getEl().style[axis === "x" ? "width" : "height"] = size + "px";
    document.documentElement.style.setProperty(cssProp, size + "px");
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
    }
  });
}

// ============================================================
// Keyboard Shortcuts
// ============================================================

document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === "s") { e.preventDefault(); saveActiveFile(); }
  if (ctrl && e.key === "w") { e.preventDefault(); if (state.activeTabId) closeTab(state.activeTabId); }
  if (ctrl && e.key === ",") { e.preventDefault(); $("settings-overlay").hidden = false; }
  if (ctrl && e.key === "h") { e.preventDefault(); openFindReplace("file"); }
  if (ctrl && e.key === "n" && !e.shiftKey) { e.preventDefault(); openFindReplace("open-files"); }
  if (ctrl && e.key === "m") { e.preventDefault(); openFindReplace("all-files"); }
});

// ============================================================
// Diagnostics Panel
// ============================================================

/**
 * Renders the diagnostics list in the bottom panel.
 * Called by CodeMirror's lint update listener via the editor module.
 * @param {Array<{from,to,severity,message}>} diags
 * @param {EditorView} view
 */
function renderDiagnosticsPanel(diags, view) {
  const panel = $("diagnostics-panel");
  if (!panel) return;

  if (!diags?.length) {
    panel.innerHTML = `<div class="panel-empty">No diagnostics, looking good.</div>`;
    _setDiagBadge(0, 0);
    return;
  }

  const errors   = diags.filter(d => d.severity === "error");
  const warnings = diags.filter(d => d.severity === "warning");
  _setDiagBadge(errors.length, warnings.length);

  const errorIcon   = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#ef4444" stroke-width="1.5"/><path d="M8 5v4M8 11v.5" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const warningIcon = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2L15 14H1L8 2z" stroke="#f59e0b" stroke-width="1.5" fill="none"/><path d="M8 7v3M8 12v.5" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  panel.innerHTML = diags.map(d => {
    const line = view.state.doc.lineAt(d.from).number;
    const icon = d.severity === "error" ? errorIcon : warningIcon;
    return `
      <div class="diag-row diag-row--${d.severity}" data-line="${line}" data-from="${d.from}">
        <span class="diag-icon">${icon}</span>
        <span class="diag-loc">Ln ${line}</span>
        <span class="diag-msg">${escHtml(d.message)}</span>
      </div>`;
  }).join("");

  // Click a diagnostic row to jump to that position in the editor
  panel.querySelectorAll(".diag-row").forEach(row => {
    row.addEventListener("click", () => {
      const from = parseInt(row.dataset.from);
      if (!isNaN(from) && state.editorView) {
        state.editorView.dispatch({ selection: { anchor: from }, scrollIntoView: true });
        state.editorView.focus();
      }
    });
  });
}

/** Updates the error/warning count badges on the Diagnostics panel tab. */
function _setDiagBadge(errors, warnings) {
  const tab = $q('.panel-tab[data-panel="diagnostics"]');
  if (!tab) return;
  tab.querySelectorAll(".diag-badge").forEach(b => b.remove());
  if (errors + warnings === 0) { tab.textContent = "Diagnostics"; return; }
  tab.textContent = "Diagnostics ";
  if (errors > 0) {
    const b = document.createElement("span");
    b.className = "diag-badge diag-badge--error";
    b.textContent = errors;
    tab.appendChild(b);
  }
  if (warnings > 0) {
    const b = document.createElement("span");
    b.className = "diag-badge diag-badge--warning";
    b.textContent = warnings;
    tab.appendChild(b);
  }
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// Environment Scanner
// Detects Skript and addons in the plugins folder of a Minecraft server.
// ============================================================

async function scanEnvironment(folderPath) {
  const envPanel = $("env-panel");
  if (!envPanel) return;

  envPanel.innerHTML = `<div class="env-scanning">Scanning plugins…</div>`;

  try {
    const result = await api("POST", "/api/environment/scan", { path: folderPath });
    let html = "";

    // Skript core jar
    if (result.skript) {
      const sk = result.skript;
      html += `<div class="env-group">
        <div class="env-group-label">Skript</div>
        <div class="env-entry env-entry--skript">
          <span class="env-name">${escHtml(sk.name)}</span>
          <span class="env-version">${escHtml(sk.version)}</span>
        </div>
      </div>`;
    } else {
      html += `<div class="env-group"><div class="env-group-label">Skript</div>
        <div class="env-none">Not detected in plugins folder</div></div>`;
    }

    if (result.warning) {
      html += `<div class="env-warning">${escHtml(result.warning)}</div>`;
    }

    // Addon plugins
    if (result.addons?.length) {
      html += `<div class="env-group"><div class="env-group-label">Addons (${result.addons.length})</div>`;
      for (const a of result.addons) {
        html += `<div class="env-entry">
          <span class="env-name">${escHtml(a.name)}</span>
          <span class="env-version">${escHtml(a.version)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    const sbVer = $("sb-skript-version");
    if (sbVer) {
      sbVer.textContent = result.skript
        ? `Skript ${result.skript.version}` + (result.addons.length ? ` + ${result.addons.length} addon(s)` : "")
        : "No Skript detected";
    }

    envPanel.innerHTML = html || `<div class="env-none">No plugins found in folder.</div>`;
  } catch (e) {
    envPanel.innerHTML = `<div class="env-error">Scan failed: ${escHtml(e.message)}</div>`;
  }
}

// ============================================================
// Theme Upload
// ============================================================

function wireThemeUpload() {
  const btn   = $("theme-upload-btn");
  const input = $("theme-upload-input");
  if (!btn || !input) return;

  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const suffix = file.name.split(".").pop().toLowerCase();
    if (!["json", "yaml", "yml"].includes(suffix)) {
      showNotification("Theme files must be .json or .yaml/.yml", "error");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API}/api/themes/upload`, { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || res.statusText);
      }
      const data = await res.json();
      showNotification(`Theme "${data.name}" uploaded`, "success");
      await loadThemes();
      await applyThemeById(data.id);
    } catch (e) {
      showNotification(`Upload failed: ${e.message}`, "error");
    } finally {
      input.value = "";
    }
  });
}

// ============================================================
// Init
// ============================================================

async function init() {
  await loadSettings();
  await loadThemes();
  wireSettings();
  wireThemeUpload();
  initInternetStatus();
  initPageFileDrop();

  // Sidebar section tab buttons
  $qa(".sidebar-tab").forEach(btn =>
    btn.addEventListener("click", () => activateSidebarSection(btn.dataset.section)));

  // Folder open buttons (toolbar + welcome screen)
  [$("open-folder-btn"), $("open-folder-btn2"), $("wa-open-folder")].forEach(btn =>
    btn?.addEventListener("click", pickFolder));

  $("add-explorer-tab-btn")?.addEventListener("click", pickFolder);

  // New file buttons (toolbar + welcome screen)
  [$("new-file-btn"), $("wa-new-file")].forEach(btn =>
    btn?.addEventListener("click", promptNewFile));

  // Environment scan buttons
  const doEnvScan = () => {
    const path = state.projectPath || state.explorerTabs[0]?.path;
    if (path) scanEnvironment(path);
    else showNotification("Open a folder first to scan the environment", "info");
  };
  $("reload-env-btn")?.addEventListener("click", doEnvScan);
  $("reload-env-sidebar-btn")?.addEventListener("click", doEnvScan);

  // SFTP site management dialogs
  $("sftp-add-site-btn")?.addEventListener("click", () => showSftpSiteDialog());
  $("sftp-site-save")?.addEventListener("click", saveSftpSite);
  $("sftp-site-cancel")?.addEventListener("click", hideSftpSiteDialog);
  $("sftp-site-delete")?.addEventListener("click", deleteSftpSite);
  $("sftp-site-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("sftp-site-overlay")) hideSftpSiteDialog();
  });
  loadSftpSites();

  // Debug console
  $("debug-toggle-btn")?.addEventListener("click", toggleDebugPanel);
  initLogStream();

  // Find & Replace bar
  wireFindReplace();

  // Script header template
  loadHeaderTemplate();
  wireHeaderTemplate();

  // Sidebar resize, invert delta when the sidebar is on the right
  // so dragging left still increases width (instead of shrinking it).
  setupResize(
    $("sidebar-resize"),
    () => $q(".sidebar"),
    "x", 140,
    () => 480,
    "--sidebar-w",
    () => $("main-layout").classList.contains("layout--sidebar-right")
  );

  // Bottom panel resize, always inverted because the handle is at the top edge
  setupResize(
    $("bottom-resize"),
    () => $("bottom-panel"),
    "y", 80,
    () => window.innerHeight * 0.5,
    "--bottom-panel-h",
    () => true
  );

  // Bottom panel tab switching
  $qa(".panel-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      $qa(".panel-tab").forEach(b => b.classList.remove("panel-tab--active"));
      btn.classList.add("panel-tab--active");
    });
  });

  // Initialise CodeMirror
  const { createEditor } = await import("/static/js/editor.js");
  state.editorView = createEditor($("cm-editor"), {
    doc:          "",
    tabWidth:     state.settings.tab_width || 4,
    autocomplete: state.settings.autocomplete !== false,
    indentGuides: state.settings.indent_guides !== false,
    minimap:      state.settings.minimap === true,
    fontSize:     state.settings.editor_font_size || 14,
    theme:        state.currentTheme || null,
    onChange: (content) => {
      if (state.suppressChange) return;
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (!tab) return;
      if (!tab.unsaved) { tab.content = content; tab.unsaved = true; renderTabs(); }
      else tab.content = content;
      // Keep find-replace results live while the file-scope bar is open
      if ($("find-replace-bar").style.display !== "none" && $("find-replace-bar").dataset.mode === "file")
        runFindReplace();
    },
    onCursorMove:  updateCursor,
    onDiagnostics: renderDiagnosticsPanel,
  });

  // Wire docs browser
  wireDocsBrowser();

  // Apply the saved theme
  await applyThemeById(state.settings.theme_id || "royal-purple-dark");

  // Show local server connection status and inject build version
  try {
    const status = await api("GET", "/api/status");
    $q(".status-dot:not(.status-dot--internet)").className = "status-dot";
    $q(".status-label:not(#internet-label)").textContent = "Local";
    // Propagate version to every element that carries [data-version]
    const ver = status.version ?? "";
    document.querySelectorAll("[data-version]").forEach(el => {
      el.textContent = `v${ver}`;
    });
  } catch {
    $q(".status-dot:not(.status-dot--internet)").className = "status-dot offline";
    $q(".status-label:not(#internet-label)").textContent = "Offline";
  }

  // Expose key internals for debugging in the browser console
  window.R4T = { state, api, openFile, saveActiveFile, openFolder, applyThemeById, debugLog };
}

document.addEventListener("DOMContentLoaded", init);

// ============================================================
// Docs Browser
// ============================================================

let _docsSearchTimer = null;
let _docsCurrentResults = [];

// Safe string coercion, prevents escHtml from crashing on null/number/array values
function safeStr(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

async function docsSearch(query, source) {
  const resultsEl = $("docs-results");
  const detailEl  = $("docs-detail");
  detailEl.style.display = "none";
  resultsEl.style.display = "";

  if (query.trim().length === 0) {
    resultsEl.innerHTML = '<div class="docs-empty">Type to search Skript syntax.</div>';
    return;
  }

  resultsEl.innerHTML = '<div class="docs-empty">Searching…</div>';

  try {
    const qs = new URLSearchParams({ q: query, source: source || "all", limit: "80" });
    const data = await api("GET", "/api/syntax/search?" + qs.toString());
    _docsCurrentResults = data.results || [];
    renderDocsResults(_docsCurrentResults);
  } catch (e) {
    resultsEl.innerHTML = '<div class="docs-empty docs-error">Search failed: ' + escHtml(safeStr(e.message)) + '</div>';
  }
}

function renderDocsResults(results) {
  const el = $("docs-results");
  if (!results.length) {
    el.innerHTML = '<div class="docs-empty">No results.</div>';
    return;
  }

  const TYPE_COLORS = {
    expressions: "#a78bfa",
    effects:     "#34d399",
    conditions:  "#60a5fa",
    events:      "#f472b6",
    types:       "#fb923c",
    sections:    "#facc15",
    syntax:      "#94a3b8",
  };

  el.innerHTML = "";
  for (const item of results) {
    const row = document.createElement("div");
    row.className = "docs-result-row";
    const typeKey = safeStr(item.type).toLowerCase();
    const color   = TYPE_COLORS[typeKey] || "#94a3b8";
    const badge   = item.source === "hub" ? safeStr(item.addon) : "Skript";
    const patterns = Array.isArray(item.patterns) ? item.patterns : [];
    row.innerHTML = `
      <div class="docs-row-top">
        <span class="docs-type-badge" style="color:${color}">${escHtml(typeKey || "syntax")}</span>
        <span class="docs-addon-badge">${escHtml(badge)}</span>
      </div>
      <div class="docs-row-name">${escHtml(safeStr(item.name))}</div>
      ${patterns.length ? `<div class="docs-row-pattern">${escHtml(safeStr(patterns[0]))}</div>` : ""}
    `;
    row.addEventListener("click", () => showDocsDetail(item));
    el.appendChild(row);
  }
}

function showDocsDetail(item) {
  const resultsEl = $("docs-results");
  const detailEl  = $("docs-detail");
  const contentEl = $("docs-detail-content");
  resultsEl.style.display = "none";
  detailEl.style.display  = "";

  const TYPE_COLORS = {
    expressions: "#a78bfa",
    effects:     "#34d399",
    conditions:  "#60a5fa",
    events:      "#f472b6",
    types:       "#fb923c",
    sections:    "#facc15",
    syntax:      "#94a3b8",
  };
  const typeKey  = safeStr(item.type).toLowerCase();
  const color    = TYPE_COLORS[typeKey] || "#94a3b8";
  const patterns = Array.isArray(item.patterns) ? item.patterns : [];
  const name     = safeStr(item.name);
  const addon    = safeStr(item.addon);
  const since    = safeStr(item.since);
  const desc     = safeStr(item.description);
  const itemId   = safeStr(item.id);

  const patternsHtml = patterns.length
    ? patterns.map(p => `<div class="docs-detail-pattern">${escHtml(safeStr(p))}</div>`).join("")
    : "";

  const hubLink = item.source === "hub" && itemId
    ? `<a href="https://skripthub.net/docs/?id=${escHtml(itemId)}" target="_blank" class="docs-external-link">View on SkriptHub ↗</a>`
    : `<a href="https://docs.skriptlang.org/docs.html" target="_blank" class="docs-external-link">View on SkriptLang ↗</a>`;

  contentEl.innerHTML = `
    <div class="docs-detail-header">
      <span class="docs-type-badge" style="color:${color};font-size:11px">${escHtml(typeKey || "syntax")}</span>
      ${since ? `<span class="docs-since">since ${escHtml(since)}</span>` : ""}
    </div>
    <div class="docs-detail-name">${escHtml(name)}</div>
    ${addon ? `<div class="docs-detail-addon">${escHtml(addon)}</div>` : ""}
    ${patternsHtml ? `<div class="docs-detail-section-label">Patterns</div><div class="docs-detail-patterns">${patternsHtml}</div>` : ""}
    ${desc ? `<div class="docs-detail-section-label">Description</div><div class="docs-detail-desc">${escHtml(desc)}</div>` : ""}
    <div class="docs-detail-links">${hubLink}</div>
  `;
}

function wireDocsBrowser() {
  const input  = $("docs-search-input");
  const srcSel = $("docs-source-select");
  const backBtn = $("docs-back-btn");

  if (!input) return;

  const triggerSearch = () => {
    clearTimeout(_docsSearchTimer);
    _docsSearchTimer = setTimeout(() => {
      docsSearch(input.value, srcSel?.value || "all");
    }, 280);
  };

  input.addEventListener("input", triggerSearch);
  srcSel?.addEventListener("change", triggerSearch);

  backBtn?.addEventListener("click", () => {
    $("docs-detail").style.display = "none";
    $("docs-results").style.display = "";
    renderDocsResults(_docsCurrentResults);
  });

  // Trigger a blank search to show initial prompt
  docsSearch("", "all");
}

// ============================================================
// Small Caps Translator
// ============================================================
const SMALL_CAPS_MAP = {
  a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',
  k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'ꜱ',t:'ᴛ',
  u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ',
};

// Reverse map: small-cap char → original lowercase letter
const SMALL_CAPS_REVERSE = {};
for (const [k, v] of Object.entries(SMALL_CAPS_MAP)) SMALL_CAPS_REVERSE[v] = k;

function toSmallCaps(str) {
  return str.split('').map(ch => SMALL_CAPS_MAP[ch.toLowerCase()] || ch).join('');
}

function fromSmallCaps(str) {
  // Split on codepoints (some small-caps are multi-byte)
  return [...str].map(ch => SMALL_CAPS_REVERSE[ch] || ch).join('');
}

function isSmallCaps(str) {
  // True if every alphabetic codepoint in str is a known small-cap glyph
  return [...str].every(ch => /\s/.test(ch) || SMALL_CAPS_REVERSE[ch] !== undefined || !/[a-zA-Z]/.test(ch));
}

// Last small-caps operation: { from, to, original, converted }
// "to" is updated as the editor changes via the converted text length.
let _lastSmallCaps = null;

function insertTextAtCursor(text) {
  if (!state.editorView) return;
  const view = state.editorView;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

function getSelectionText() {
  if (!state.editorView) return '';
  const view = state.editorView;
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}

function applySmallCaps() {
  if (!state.editorView) return;
  const view = state.editorView;
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to);

  if (sel) {
    // Check if current selection is already small-caps → undo
    if (isSmallCaps(sel) && _lastSmallCaps && view.state.sliceDoc(_lastSmallCaps.from, _lastSmallCaps.from + _lastSmallCaps.converted.length) === _lastSmallCaps.converted) {
      // Undo: replace converted text with original
      const { from: f, converted, original } = _lastSmallCaps;
      view.dispatch({
        changes: { from: f, to: f + converted.length, insert: original },
        selection: { anchor: f, head: f + original.length },
      });
      _lastSmallCaps = null;
      view.focus();
      return;
    }
    // Forward: convert selection
    const converted = toSmallCaps(sel);
    view.dispatch({
      changes: { from, to, insert: converted },
      selection: { anchor: from, head: from + converted.length },
    });
    _lastSmallCaps = { from, converted, original: sel };
    view.focus();
  } else {
    // No selection, work on last word before cursor
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const textBefore = line.text.slice(0, pos - line.from);
    const wordMatch = textBefore.match(/\S+$/);
    if (!wordMatch) return;
    const word = wordMatch[0];
    const wFrom = pos - word.length;
    const wTo   = pos;

    // If word is already small-caps and matches last op → undo
    if (isSmallCaps(word) && _lastSmallCaps && _lastSmallCaps.from === wFrom && _lastSmallCaps.converted === word) {
      view.dispatch({
        changes: { from: wFrom, to: wTo, insert: _lastSmallCaps.original },
        selection: { anchor: wFrom + _lastSmallCaps.original.length },
      });
      _lastSmallCaps = null;
      view.focus();
      return;
    }
    // Forward
    const converted = toSmallCaps(word);
    view.dispatch({
      changes: { from: wFrom, to: wTo, insert: converted },
      selection: { anchor: wFrom + converted.length },
    });
    _lastSmallCaps = { from: wFrom, converted, original: word };
    view.focus();
  }
}

// ============================================================
// Hex Color Picker
// ============================================================
const HEX_PRESETS = [
  '#FF5555','#FF55FF','#FFFF55','#55FF55','#55FFFF','#5555FF',
  '#FFAA00','#AA00AA','#00AAAA','#AA0000','#00AA00','#0000AA',
  '#FFFFFF','#AAAAAA','#555555','#000000',
  '#FF8C00','#9B59B6','#3498DB','#2ECC71',
];

function wireFormatToolbar() {
  // Small caps button
  const scBtn = $("fmt-smallcaps-btn");
  if (scBtn) {
    scBtn.addEventListener("click", applySmallCaps);
  }

  // Hex button
  const hexBtn = $("fmt-hex-btn");
  if (hexBtn) {
    hexBtn.addEventListener("click", () => openHexPicker());
  }
  $("hex-picker-close")?.addEventListener("click", closeHexPicker);
  $("hex-picker-cancel")?.addEventListener("click", closeHexPicker);
  $("hex-picker-insert")?.addEventListener("click", commitHexInsert);

  // Render presets
  const swatchContainer = $("hex-preset-swatches");
  if (swatchContainer) {
    HEX_PRESETS.forEach(hex => {
      const s = document.createElement("div");
      s.className = "hex-preset-swatch";
      s.style.background = hex;
      s.title = hex;
      s.addEventListener("click", () => setHexPickerColor(hex.slice(1)));
      swatchContainer.appendChild(s);
    });
  }

  // Wire color inputs
  const colorInput = $("hex-color-input");
  const textInput  = $("hex-text-input");

  colorInput?.addEventListener("input", () => {
    const hex = colorInput.value.slice(1);
    textInput.value = hex.toUpperCase();
    updateHexPreview(hex);
  });

  textInput?.addEventListener("input", () => {
    const val = textInput.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
    textInput.value = val.toUpperCase();
    if (val.length === 6) {
      colorInput.value = '#' + val;
      updateHexPreview(val);
    }
  });
}

function setHexPickerColor(hex6) {
  $("hex-color-input").value = '#' + hex6;
  $("hex-text-input").value  = hex6.toUpperCase();
  updateHexPreview(hex6);
}

function updateHexPreview(hex6) {
  const color = '#' + hex6;
  $("hex-preview-swatch").style.background = color;
  $("hex-preview-text").style.color = color;
}

function openHexPicker() {
  $("hex-picker-overlay").style.display = "flex";
}

function closeHexPicker() {
  $("hex-picker-overlay").style.display = "none";
}

function commitHexInsert() {
  const hex    = $("hex-text-input").value.trim();
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return;
  const fmt    = document.querySelector('input[name="hex-fmt"]:checked')?.value || 'inline';
  const color  = '#' + hex.toUpperCase();
  const sel    = getSelectionText();

  let insert;
  if (fmt === 'paired') {
    insert = `<${color}>${sel || 'text'}</${color}>`;
  } else {
    insert = `<${color}>${sel}`;
  }

  insertTextAtCursor(insert);
  closeHexPicker();
}

// Wire after DOM ready, hook into existing init flow
document.addEventListener("DOMContentLoaded", () => {
  // Wire format toolbar after a short delay to ensure DOM is ready
  requestAnimationFrame(wireFormatToolbar);
});
