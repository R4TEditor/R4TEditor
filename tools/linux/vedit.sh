#!/usr/bin/env bash
set -e

MAIN_PY="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../" && pwd)/backend/main.py"

CURRENT_VERSION=$(grep -oP '(?<=APP_VERSION = ")[^"]+' "$MAIN_PY")

echo ""
echo "Current version: $CURRENT_VERSION"
read -rp "New version: " NEW_VERSION
echo ""

if [ -z "$NEW_VERSION" ]; then
    echo "[R4TEditor] No version entered. Aborting."
    exit 1
fi

sed -i "s/APP_VERSION = \"${CURRENT_VERSION}\"/APP_VERSION = \"${NEW_VERSION}\"/" "$MAIN_PY"
echo "[R4TEditor] Version updated: $CURRENT_VERSION → $NEW_VERSION"
