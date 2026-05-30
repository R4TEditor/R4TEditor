#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

# --- Color helpers
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[R4TEditor]${NC} $*"; }
success() { echo -e "${GREEN}[R4TEditor]${NC} $*"; }
warn()    { echo -e "${YELLOW}[R4TEditor]${NC} $*"; }

info "Cleaning PyInstaller output …"

removed=0

if [ -d "$PROJECT_DIR/dist" ]; then
    rm -rf "$PROJECT_DIR/dist"
    info "Deleted: dist/"
    ((removed++))
fi

if [ -d "$PROJECT_DIR/build" ]; then
    rm -rf "$PROJECT_DIR/build"
    info "Deleted: build/"
    ((removed++))
fi

if [ -f "$PROJECT_DIR/R4TEditor.spec" ]; then
    rm -f "$PROJECT_DIR/R4TEditor.spec"
    info "Deleted: R4TEditor.spec"
    ((removed++))
fi

if [ "$removed" -eq 0 ]; then
    warn "Nothing to clean."
else
    success "Done. Removed $removed item(s)."
fi
