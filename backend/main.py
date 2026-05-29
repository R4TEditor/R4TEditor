"""
R4TEditor - Local FastAPI backend
Phase 1: Core Editor
"""

import os
import sys
import json
import shutil
import logging
import asyncio
import zipfile
import io
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import httpx

# ----------------------------------------------------------------- Log broker
# Collects log records from Python's logging system + raw stdout/stderr writes
# and fans them out to all connected /ws/logs WebSocket clients.

class _LogBroker:
    """Thread-safe log message broker for WebSocket streaming."""

    def __init__(self):
        self._clients: list[asyncio.Queue] = []
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._clients.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        try:
            self._clients.remove(q)
        except ValueError:
            pass

    def publish(self, level: str, message: str):
        if not self._loop or not self._clients:
            return
        payload = json.dumps({"level": level, "msg": message})
        for q in list(self._clients):
            try:
                # put_nowait is safe to call from any thread
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass  # slow client — drop rather than block

    def publish_threadsafe(self, level: str, message: str):
        """Call this from non-async threads (e.g. the uvicorn worker threads)."""
        if not self._loop:
            return
        self._loop.call_soon_threadsafe(self.publish, level, message)


log_broker = _LogBroker()


class _WSLogHandler(logging.Handler):
    """Logging handler that forwards records to the log broker."""

    def emit(self, record: logging.LogRecord):
        level = record.levelname  # DEBUG / INFO / WARNING / ERROR / CRITICAL
        msg = self.format(record)
        log_broker.publish_threadsafe(level, msg)


class _StreamCapture:
    """Wraps sys.stdout or sys.stderr to also forward writes to the broker."""

    def __init__(self, original, level: str):
        self._original = original
        self._level = level
        self._buf = ""

    # ---- stream interface ----
    def write(self, text: str):
        self._original.write(text)
        self._buf += text
        # Flush complete lines to the broker
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line:
                log_broker.publish_threadsafe(self._level, line)

    def flush(self):
        self._original.flush()
        if self._buf:
            log_broker.publish_threadsafe(self._level, self._buf)
            self._buf = ""

    def __getattr__(self, name):
        return getattr(self._original, name)


def _install_log_capture():
    """Install the WS log handler on the root logger and wrap stdout/stderr."""
    handler = _WSLogHandler()
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    handler.setLevel(logging.DEBUG)

    root = logging.getLogger()
    root.addHandler(handler)
    # Make sure uvicorn's own loggers also propagate
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        logging.getLogger(name).addHandler(handler)

    sys.stdout = _StreamCapture(sys.__stdout__, "INFO")
    sys.stderr = _StreamCapture(sys.__stderr__, "ERROR")


_install_log_capture()

from contextlib import asynccontextmanager

@asynccontextmanager
async def _lifespan(application: FastAPI):
    """Capture the running event loop for the log broker on startup."""
    log_broker.set_loop(asyncio.get_running_loop())
    yield

app = FastAPI(title="R4TEditor", version="0.1.0", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    _BASE = Path(sys._MEIPASS)
else:
    _BASE = Path(__file__).resolve().parent.parent
ROOT_DIR   = _BASE
FRONTEND   = _BASE / "frontend"
THEMES_DIR = _BASE / "themes"

# ---------------------------------------------------------------- Syntax Cache

SYNTAX_CACHE_DIR = Path.home() / ".r4teditor" / "syntax_cache"
SYNTAX_CACHE_DIR.mkdir(parents=True, exist_ok=True)

DOCS_JSON_URL  = "https://docs.skriptlang.org/docs.json"
HUB_API_URL    = "https://skripthub.net/api/v1/addonsyntaxlist/"
CACHE_TTL_SECS = 86400  # 24 hours

def _cache_path(name: str) -> Path:
    return SYNTAX_CACHE_DIR / name

def _cache_fresh(path: Path) -> bool:
    if not path.exists():
        return False
    import time
    return (time.time() - path.stat().st_mtime) < CACHE_TTL_SECS

async def _fetch_and_cache(url: str, cache_name: str) -> Optional[dict | list]:
    cache_file = _cache_path(cache_name)
    if _cache_fresh(cache_file):
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url, headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json()
            cache_file.write_text(json.dumps(data), encoding="utf-8")
            return data
    except Exception as e:
        # Return stale cache if available
        if cache_file.exists():
            try:
                return json.loads(cache_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return None


app.mount("/static", StaticFiles(directory=str(FRONTEND / "static")), name="static")

# ------------------------------------------------------------------ Settings --

SETTINGS_FILE = Path.home() / ".r4teditor" / "settings.json"
SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)

USER_THEMES_DIR = Path.home() / ".r4teditor" / "themes"
USER_THEMES_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS = {
    # Theme
    "theme_id":             "royal-purple-dark",
    # Editor appearance
    "editor_font":          "JetBrains Mono",
    "editor_font_size":     14,
    "line_height":          1.6,
    # Editor behaviour
    "tab_width":            4,
    "autocomplete":         True,
    "indent_guides":        True,
    "minimap":              False,
    # Layout
    "sidebar_position":     "left",
    # SFTP
    "upload_on_save":       False,
    # Script header template
    "header_enabled":       False,
    "header_template":      "",
}

def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                saved = json.load(f)
            return {**DEFAULT_SETTINGS, **saved}
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()

def save_settings(settings: dict):
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)

# -------------------------------------------------------------------- Models --

class FileReadRequest(BaseModel):
    path: str

class FileWriteRequest(BaseModel):
    path: str
    content: str

class FileMoveRequest(BaseModel):
    src: str
    dst_dir: str

class SettingsUpdateRequest(BaseModel):
    settings: dict

class DirectoryRequest(BaseModel):
    path: str

class ThemeSaveRequest(BaseModel):
    theme: dict

# ---------------------------------------------------------------- SFTP Models --

class SFTPConnectRequest(BaseModel):
    host: str
    port: int = 22
    username: str
    password: Optional[str] = None
    key_path: Optional[str] = None

class SFTPReadRequest(BaseModel):
    session_id: str
    path: str

class SFTPWriteRequest(BaseModel):
    session_id: str
    path: str
    content: str

class SFTPListRequest(BaseModel):
    session_id: str
    path: str

class SFTPDisconnectRequest(BaseModel):
    session_id: str

# -------------------------------------------------------------------- Routes --

@app.get("/", response_class=HTMLResponse)
async def root():
    index = FRONTEND / "templates" / "index.html"
    return HTMLResponse(content=index.read_text(encoding="utf-8"), status_code=200)

@app.get("/api/status")
async def status():
    return {"status": "running", "version": "0.1.0", "phase": 1}

# -- Settings --

@app.get("/api/settings")
async def get_settings():
    return load_settings()

@app.post("/api/settings")
async def update_settings(req: SettingsUpdateRequest):
    settings = load_settings()
    settings.update(req.settings)
    save_settings(settings)
    return {"ok": True, "settings": settings}

# -- File ops --

@app.post("/api/file/read")
async def read_file(req: FileReadRequest):
    path = Path(req.path)
    if not path.exists():
        raise HTTPException(404, f"File not found: {req.path}")
    if not path.is_file():
        raise HTTPException(400, "Path is not a file")
    try:
        content = path.read_text(encoding="utf-8")
        return {"path": str(path), "content": content}
    except UnicodeDecodeError:
        raise HTTPException(400, "File is not valid UTF-8 text")

@app.post("/api/file/write")
async def write_file(req: FileWriteRequest):
    path = Path(req.path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(req.content, encoding="utf-8")
        return {"ok": True, "path": str(path)}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/file/move")
async def move_file(req: FileMoveRequest):
    src = Path(req.src)
    dst_dir = Path(req.dst_dir)
    if not src.exists():
        raise HTTPException(404, f"Source not found: {req.src}")
    if not dst_dir.is_dir():
        raise HTTPException(400, f"Destination is not a directory: {req.dst_dir}")
    dst = dst_dir / src.name
    if dst.exists():
        raise HTTPException(409, f"A file named '{src.name}' already exists in that folder")
    try:
        shutil.move(str(src), str(dst))
        return {"ok": True, "new_path": str(dst)}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/directory/list")
async def list_directory(req: DirectoryRequest):
    path = Path(req.path)
    if not path.exists():
        raise HTTPException(404, f"Directory not found: {req.path}")
    if not path.is_dir():
        raise HTTPException(400, "Path is not a directory")
    entries = []
    try:
        for entry in sorted(path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            entries.append({
                "name":      entry.name,
                "path":      str(entry),
                "is_dir":    entry.is_dir(),
                "size":      entry.stat().st_size if entry.is_file() else None,
                "extension": entry.suffix.lower() if entry.is_file() else None,
            })
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    return {"path": str(path), "entries": entries}

# -- Native folder/file picker via tkinter --

@app.get("/api/browse/folder")
async def browse_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.wm_attributes("-topmost", 1)
        path = filedialog.askdirectory(title="Select Project Folder")
        root.destroy()
        return {"path": path if path else None}
    except Exception as e:
        raise HTTPException(500, f"Folder picker unavailable: {e}")

@app.get("/api/browse/file")
async def browse_file():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.wm_attributes("-topmost", 1)
        path = filedialog.askopenfilename(
            title="Open File",
            filetypes=[("Skript files", "*.sk"), ("All files", "*.*")]
        )
        root.destroy()
        return {"path": path if path else None}
    except Exception as e:
        raise HTTPException(500, f"File picker unavailable: {e}")

# -- Themes --

def _load_theme_file(path: Path) -> Optional[dict]:
    try:
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            return json.loads(text)
        if path.suffix in (".yaml", ".yml"):
            import yaml
            return yaml.safe_load(text)
    except Exception:
        pass
    return None

@app.get("/api/themes")
async def list_themes():
    themes = []
    seen = set()
    # User themes take priority
    for d in [USER_THEMES_DIR, THEMES_DIR]:
        for ext in ("*.json", "*.yaml", "*.yml"):
            for f in sorted(d.glob(ext)):
                theme = _load_theme_file(f)
                if theme and "id" in theme and theme["id"] not in seen:
                    seen.add(theme["id"])
                    themes.append({
                        "id":   theme["id"],
                        "name": theme.get("name", theme["id"]),
                        "base": theme.get("base", "dark"),
                        "path": str(f),
                        "user": d == USER_THEMES_DIR,
                    })
    return {"themes": themes}

@app.get("/api/themes/{theme_id}")
async def get_theme(theme_id: str):
    for d in [USER_THEMES_DIR, THEMES_DIR]:
        for ext in (".json", ".yaml", ".yml"):
            f = d / (theme_id + ext)
            if f.exists():
                theme = _load_theme_file(f)
                if theme:
                    return theme
    raise HTTPException(404, f"Theme not found: {theme_id}")

@app.post("/api/themes/{theme_id}")
async def save_theme(theme_id: str, req: ThemeSaveRequest):
    theme = req.theme
    theme["id"] = theme_id
    path = USER_THEMES_DIR / (theme_id + ".json")
    path.write_text(json.dumps(theme, indent=2), encoding="utf-8")
    return {"ok": True, "path": str(path)}


@app.post("/api/themes/upload")
async def upload_theme(file: UploadFile = File(...)):
    """Accept a JSON or YAML theme file upload and save it to the user themes directory."""
    filename = file.filename or "uploaded_theme"
    suffix = Path(filename).suffix.lower()
    if suffix not in (".json", ".yaml", ".yml"):
        raise HTTPException(400, "Theme files must be .json or .yaml/.yml")

    raw = await file.read()

    if suffix == ".json":
        try:
            theme = json.loads(raw)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"Invalid JSON: {e}")
    else:
        try:
            import yaml  # type: ignore
            theme = yaml.safe_load(raw)
        except Exception as e:
            raise HTTPException(400, f"Invalid YAML: {e}")

    if not isinstance(theme, dict):
        raise HTTPException(400, "Theme file must be a JSON/YAML object")

    theme_id = theme.get("id") or Path(filename).stem
    theme["id"] = theme_id
    out_path = USER_THEMES_DIR / (theme_id + ".json")
    out_path.write_text(json.dumps(theme, indent=2), encoding="utf-8")
    return {"ok": True, "id": theme_id, "name": theme.get("name", theme_id)}


# ----------------------------------------------------------------- Environment Scanning

def _extract_plugin_yml(jar_path: Path) -> Optional[dict]:
    """Read plugin.yml from a jar (zip) without extracting the whole file."""
    try:
        import yaml  # type: ignore
        with zipfile.ZipFile(jar_path, "r") as zf:
            names = zf.namelist()
            target = next((n for n in names if n.lower() == "plugin.yml"), None)
            if not target:
                return None
            data = zf.read(target)
            meta = yaml.safe_load(data)
            if isinstance(meta, dict):
                return meta
    except Exception:
        pass
    return None


def _classify_plugin(meta: dict) -> str:
    """Return 'skript', 'addon', or 'plugin' for a parsed plugin.yml."""
    name = (meta.get("name") or "").lower()
    depend = [d.lower() for d in (meta.get("depend") or [])]
    soft_depend = [d.lower() for d in (meta.get("softdepend") or [])]
    all_deps = depend + soft_depend

    # Skript itself: name contains "skript" and has no dependency on skript
    if "skript" in name and "skript" not in all_deps:
        return "skript"
    # Addon: depends or soft-depends on Skript
    if "skript" in all_deps:
        return "addon"
    return "plugin"


@app.post("/api/environment/scan")
async def scan_environment(req: DirectoryRequest):
    """
    Scan a local plugins folder, extract plugin.yml from each jar,
    detect Skript and addons, then compare the Skript version against
    the latest version in docs.json.
    """
    base = Path(req.path)

    # Auto-locate a plugins/ subfolder if the user passed a project root
    if (base / "plugins").is_dir():
        plugins_dir = base / "plugins"
    else:
        plugins_dir = base

    if not plugins_dir.is_dir():
        raise HTTPException(404, f"Directory not found: {plugins_dir}")

    jar_files = list(plugins_dir.glob("*.jar"))
    if not jar_files:
        return {"skript": None, "addons": [], "plugins": [], "warning": None, "docs_version": None}

    skript_entry = None
    addons = []
    others = []

    for jar in sorted(jar_files, key=lambda j: j.name.lower()):
        meta = _extract_plugin_yml(jar)
        if not meta:
            continue
        kind = _classify_plugin(meta)
        entry = {
            "name":    meta.get("name", jar.stem),
            "version": meta.get("version", "?"),
            "author":  meta.get("author") or ((meta.get("authors") or [None])[0]),
            "jar":     jar.name,
        }
        if kind == "skript" and skript_entry is None:
            skript_entry = entry
        elif kind == "addon":
            addons.append(entry)
        else:
            others.append(entry)

    # Compare installed Skript version against the docs.json source version
    warning = None
    docs_version = None
    try:
        docs_data = await _fetch_and_cache(DOCS_JSON_URL, "docs.json")
        if docs_data and isinstance(docs_data, dict):
            docs_version = (docs_data.get("source") or {}).get("version")
    except Exception:
        pass

    if skript_entry and docs_version:
        installed = (skript_entry.get("version") or "").strip()
        if installed and installed != docs_version:
            warning = (
                f"You should update Skript — "
                f"installed: {installed}, latest: {docs_version}"
            )

    return {
        "skript":       skript_entry,
        "addons":       addons,
        "plugins":      others,
        "docs_version": docs_version,
        "warning":      warning,
    }


# ----------------------------------------------------------------- Syntax API

@app.get("/api/syntax/docs")
async def get_syntax_docs():
    """Proxy + cache for docs.skriptlang.org/docs.json"""
    data = await _fetch_and_cache(DOCS_JSON_URL, "docs.json")
    if data is None:
        raise HTTPException(503, "Syntax docs unavailable and no cache found")
    return data

@app.get("/api/syntax/addons")
async def get_syntax_addons():
    """Proxy + cache for skripthub.net addon syntax list"""
    data = await _fetch_and_cache(HUB_API_URL, "addons.json")
    if data is None:
        raise HTTPException(503, "Addon syntax unavailable and no cache found")
    return data

@app.get("/api/syntax/status")
async def get_syntax_status():
    """Report cache freshness for the UI status indicator"""
    import time
    docs_file  = _cache_path("docs.json")
    addon_file = _cache_path("addons.json")
    now = time.time()
    return {
        "docs": {
            "cached": docs_file.exists(),
            "fresh":  _cache_fresh(docs_file),
            "age_hours": round((now - docs_file.stat().st_mtime) / 3600, 1) if docs_file.exists() else None,
        },
        "addons": {
            "cached": addon_file.exists(),
            "fresh":  _cache_fresh(addon_file),
            "age_hours": round((now - addon_file.stat().st_mtime) / 3600, 1) if addon_file.exists() else None,
        },
    }

# ------------------------------------------------------------------- SFTP API

# In-memory SFTP session store
_sftp_sessions: dict = {}

@app.post("/api/sftp/connect")
async def sftp_connect(req: SFTPConnectRequest):
    try:
        import paramiko
        import uuid

        transport = paramiko.Transport((req.host, req.port))

        if req.key_path:
            key_path = Path(req.key_path).expanduser()
            # Try common key types
            pkey = None
            for key_class in [paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.DSSKey]:
                try:
                    pkey = key_class.from_private_key_file(str(key_path))
                    break
                except Exception:
                    continue
            if pkey is None:
                raise HTTPException(400, "Could not load private key")
            transport.connect(username=req.username, pkey=pkey)
        elif req.password:
            transport.connect(username=req.username, password=req.password)
        else:
            raise HTTPException(400, "Must provide either password or key_path")

        sftp = paramiko.SFTPClient.from_transport(transport)
        session_id = str(uuid.uuid4())
        _sftp_sessions[session_id] = {"sftp": sftp, "transport": transport, "host": req.host}

        return {"ok": True, "session_id": session_id, "host": req.host}
    except paramiko.AuthenticationException:
        raise HTTPException(401, "Authentication failed")
    except paramiko.SSHException as e:
        raise HTTPException(500, f"SSH error: {e}")
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/sftp/list")
async def sftp_list(req: SFTPListRequest):
    session = _sftp_sessions.get(req.session_id)
    if not session:
        raise HTTPException(404, "SFTP session not found")
    try:
        sftp = session["sftp"]
        attrs_list = sftp.listdir_attr(req.path)
        entries = []
        import stat as stat_mod
        for attr in sorted(attrs_list, key=lambda a: (not stat_mod.S_ISDIR(a.st_mode or 0), a.filename.lower())):
            is_dir = stat_mod.S_ISDIR(attr.st_mode or 0)
            name = attr.filename
            full = req.path.rstrip("/") + "/" + name
            ext = Path(name).suffix.lower() if not is_dir else None
            entries.append({
                "name": name,
                "path": full,
                "is_dir": is_dir,
                "size": attr.st_size if not is_dir else None,
                "extension": ext,
            })
        return {"path": req.path, "entries": entries}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/sftp/read")
async def sftp_read(req: SFTPReadRequest):
    session = _sftp_sessions.get(req.session_id)
    if not session:
        raise HTTPException(404, "SFTP session not found")
    try:
        sftp = session["sftp"]
        with sftp.open(req.path, "r") as f:
            content = f.read().decode("utf-8")
        return {"path": req.path, "content": content}
    except UnicodeDecodeError:
        raise HTTPException(400, "File is not valid UTF-8 text")
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/sftp/write")
async def sftp_write(req: SFTPWriteRequest):
    session = _sftp_sessions.get(req.session_id)
    if not session:
        raise HTTPException(404, "SFTP session not found")
    try:
        sftp = session["sftp"]
        with sftp.open(req.path, "w") as f:
            f.write(req.content.encode("utf-8"))
        return {"ok": True, "path": req.path}
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/sftp/disconnect")
async def sftp_disconnect(req: SFTPDisconnectRequest):
    session = _sftp_sessions.pop(req.session_id, None)
    if session:
        try:
            session["sftp"].close()
            session["transport"].close()
        except Exception:
            pass
    return {"ok": True}

@app.get("/api/sftp/sessions")
async def sftp_sessions():
    return {
        "sessions": [
            {"session_id": sid, "host": s["host"]}
            for sid, s in _sftp_sessions.items()
        ]
    }

# -- WebSocket diagnostics stub --

@app.websocket("/ws/diagnostics")
async def diagnostics_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            await websocket.send_json({
                "type": "diagnostics",
                "file": data.get("file", ""),
                "diagnostics": [],
            })
    except WebSocketDisconnect:
        pass

# -- WebSocket log streaming --

@app.websocket("/ws/logs")
async def logs_ws(websocket: WebSocket):
    """Stream backend log output to the debug console in real time."""
    await websocket.accept()
    q = log_broker.subscribe()
    try:
        while True:
            payload = await q.get()
            await websocket.send_text(payload)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        log_broker.unsubscribe(q)

# ----------------------------------------------------------------- Entry point

def _wait_for_server(host: str, port: int, timeout: float = 10.0) -> bool:
    """Poll until the server is accepting connections or timeout expires."""
    import socket
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.1)
    return False


if __name__ == "__main__":
    HOST = "127.0.0.1"
    PORT = 7842

    try:
        import webview
        import threading

        def start_server():
            uvicorn.run(app, host=HOST, port=PORT, log_level="warning")

        server_thread = threading.Thread(target=start_server, daemon=True)
        server_thread.start()

        # Wait until the server is actually ready (instead of a blind sleep)
        if not _wait_for_server(HOST, PORT):
            print("[R4TEditor] Server did not start in time — falling back to browser")
            raise ImportError("server timeout")  # jump to browser fallback

        window = webview.create_window(
            "R4TEditor",
            f"http://{HOST}:{PORT}",
            width=1400,
            height=900,
            resizable=True,
            min_size=(900, 600),
        )
        # webview.start() must be called on the main thread
        _ICON = str(_BASE / "frontend" / "static" / "favicon.ico")
        webview.start(icon=_ICON)

    except ImportError:
        # pywebview not installed or server failed — fall back to system browser
        import webbrowser
        import threading

        def open_browser():
            if _wait_for_server(HOST, PORT):
                webbrowser.open(f"http://{HOST}:{PORT}")

        threading.Thread(target=open_browser, daemon=True).start()
        uvicorn.run(app, host=HOST, port=PORT, log_level="info")
