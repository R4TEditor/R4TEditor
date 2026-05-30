#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

# --- Color helpers
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[R4TEditor]${NC} $*"; }
success() { echo -e "${GREEN}[R4TEditor]${NC} $*"; }
warn()    { echo -e "${YELLOW}[R4TEditor]${NC} $*"; }
error()   { echo -e "${RED}[R4TEditor] ERROR:${NC} $*"; exit 1; }

# --- Python check
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        VER=$("$cmd" -c "import sys; print(sys.version_info >= (3,10))" 2>/dev/null)
        if [ "$VER" = "True" ]; then
            PYTHON="$cmd"
            break
        fi
    fi
done
[ -z "$PYTHON" ] && error "Python 3.10+ is required but was not found.\nInstall it with: sudo apt install python3  (Debian/Ubuntu) or equivalent."

# --- PyInstaller check
VENV_DIR="$TOOLS_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    info "No virtual environment found — run launch.sh first to set up dependencies."
    error "Aborting build."
fi
source "$VENV_DIR/bin/activate"

# --- Build
info "Building R4TEditor binary …"
pyinstaller \
    --onefile \
    --windowed \
    --icon "$PROJECT_DIR/frontend/static/favicon.ico" \
    --add-data "$PROJECT_DIR/frontend:frontend" \
    --add-data "$PROJECT_DIR/themes:themes" \
    --name "R4TEditor" \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan.on \
    --hidden-import paramiko \
    --hidden-import pywebview \
    --hidden-import pypresence \
    "$PROJECT_DIR/backend/main.py"

success "Build complete → dist/R4TEditor"
