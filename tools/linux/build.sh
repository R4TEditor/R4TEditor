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
error()   { echo -e "${RED}[R4TEditor] ERROR:${NC} $*"; exit 1; }

VENV_DIR="$TOOLS_DIR/.venv"
[ ! -d "$VENV_DIR" ] && error "No virtual environment found — run install_deps.sh first."
source "$VENV_DIR/bin/activate"

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
    --hidden-import _cffi_backend \
    --collect-all cffi \
    --collect-all clr_loader \
    "$PROJECT_DIR/backend/main.py"

success "Build complete → dist/R4TEditor"
