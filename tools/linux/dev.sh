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

# --- Venv check
VENV_DIR="$TOOLS_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    info "No virtual environment found — run install_deps.sh first."
    error "Aborting."
fi
source "$VENV_DIR/bin/activate"

# --- uvicorn check
if ! python -c "import uvicorn" &>/dev/null 2>&1; then
    error "uvicorn not found in venv. Run install_deps.sh first."
fi

# --- Default port, overridable via env
PORT="${R4T_PORT:-8000}"

warn "Running in DEVELOPMENT mode (auto-reload enabled) on port $PORT"
info "Press Ctrl+C to stop."

exec uvicorn backend.main:app \
    --reload \
    --reload-dir "$PROJECT_DIR/backend" \
    --host 127.0.0.1 \
    --port "$PORT" \
    "$@"
