#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MAIN_PY="$PROJECT_DIR/backend/main.py"

# --- Color helpers
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[R4TEditor]${NC} $*"; }
success() { echo -e "${GREEN}[R4TEditor]${NC} $*"; }
warn()    { echo -e "${YELLOW}[R4TEditor]${NC} $*"; }
error()   { echo -e "${RED}[R4TEditor] ERROR:${NC} $*"; exit 1; }
prompt()  { echo -e "${BOLD}$*${NC}"; }

echo ""
echo -e "${CYAN}╔══════════════════════════════╗${NC}"
echo -e "${CYAN}║     R4TEditor Setup          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════╝${NC}"
echo ""

# --- Step 1: build or run?
prompt "What do you want to do?"
echo "  1) Build the project (creates a standalone binary)"
echo "  2) Run the project"
echo ""
read -rp "Enter 1 or 2: " MODE_CHOICE
echo ""

case "$MODE_CHOICE" in
    1) MODE="build" ;;
    2) MODE="run"   ;;
    *) error "Invalid choice '$MODE_CHOICE'. Please enter 1 or 2." ;;
esac

# --- Step 2: dev mode?
prompt "Enable dev mode? (appends -dev to version, enables auto-reload)"
read -rp "Dev mode? [y/N]: " DEV_CHOICE
echo ""

DEV_MODE=false
if [[ "$DEV_CHOICE" =~ ^[Yy]$ ]]; then
    DEV_MODE=true
fi

# --- Apply / revert dev version tag in main.py
CURRENT_VERSION=$(grep -oP '(?<=APP_VERSION = ")[^"]+' "$MAIN_PY")
BASE_VERSION="${CURRENT_VERSION%-dev}"  # strip -dev if already present

if $DEV_MODE; then
    NEW_VERSION="${BASE_VERSION}-dev"
    info "Setting version to $NEW_VERSION in backend/main.py …"
    sed -i "s/APP_VERSION = \"${CURRENT_VERSION}\"/APP_VERSION = \"${NEW_VERSION}\"/" "$MAIN_PY"
    success "Version set to $NEW_VERSION"
else
    # Ensure -dev is stripped if it was left from a previous dev run
    if [[ "$CURRENT_VERSION" == *-dev ]]; then
        info "Reverting dev version ($CURRENT_VERSION → $BASE_VERSION) in backend/main.py …"
        sed -i "s/APP_VERSION = \"${CURRENT_VERSION}\"/APP_VERSION = \"${BASE_VERSION}\"/" "$MAIN_PY"
        success "Version reverted to $BASE_VERSION"
    fi
fi

echo ""

# --- Step 3: install deps
info "Installing dependencies …"
bash "$SCRIPT_DIR/install_deps.sh"
echo ""

# --- Step 4: branch on mode
if [ "$MODE" = "build" ]; then
    info "Cleaning previous build artifacts …"
    bash "$SCRIPT_DIR/clean.sh"
    echo ""
    info "Building …"
    bash "$SCRIPT_DIR/build.sh"
else
    # run mode
    if $DEV_MODE; then
        info "Launching in dev mode (auto-reload) …"
        bash "$SCRIPT_DIR/dev.sh"
    else
        info "Launching …"
        bash "$SCRIPT_DIR/launch.sh"
    fi
fi
