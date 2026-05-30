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

info "Using $($PYTHON --version)"

# --- Virtual environment
VENV_DIR="$TOOLS_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
    info "Creating virtual environment at tools/.venv …"
    $PYTHON -m venv "$VENV_DIR" || error "Failed to create virtual environment."
    success "Virtual environment created."
fi

# Activate
source "$VENV_DIR/bin/activate"

# --- pip + dependencies
info "Checking / installing dependencies from tools/requirements.txt …"
pip install --quiet --upgrade pip
pip install --quiet -r "$TOOLS_DIR/requirements.txt"
success "Dependencies ready."

# --- Discord RPC (optional, non-fatal)
if ! python -c "import pypresence" &>/dev/null 2>&1; then
    info "Installing pypresence for Discord RPC (optional) …"
    pip install --quiet pypresence || warn "pypresence install failed, Discord RPC will be disabled."
fi

# --- Launch
success "Starting R4TEditor …"
exec $PYTHON "$PROJECT_DIR/backend/main.py" "$@"
