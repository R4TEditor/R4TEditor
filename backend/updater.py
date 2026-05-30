"""
Auto-updater for R4TEditor.

Only runs when the app is frozen (PyInstaller EXE). Does nothing in dev mode.

Flow:
  1. Hit the GitHub releases API for the latest release.
  2. Find the EXE asset by name (R4TEditor.exe on Windows, R4TEditor on Linux/macOS).
  3. Pull asset.digest — GitHub provides this as "sha256:<hex>" automatically.
  4. Hash the currently-running EXE.
  5. If they differ, download the new EXE, replace the current one, relaunch.
"""

import hashlib
import logging
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

import httpx

log = logging.getLogger(__name__)

# --- Config ----------------------------------------------------------------

GITHUB_OWNER = "your-username"       # TODO: replace with your GitHub username
GITHUB_REPO  = "R4TEditor"           # TODO: replace with your repo name
API_URL      = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"

# Asset name as uploaded to GitHub releases
EXE_ASSET_NAME = "R4TEditor.exe" if platform.system() == "Windows" else "R4TEditor"


# --- Helpers ---------------------------------------------------------------

def _is_frozen() -> bool:
    """True when running as a PyInstaller bundle."""
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def _current_exe() -> Path:
    return Path(sys.executable)


def _hash_file(path: Path) -> str:
    """SHA-256 hex digest of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# --- Core ------------------------------------------------------------------

def check_and_update(current_version: str) -> None:
    """
    Called at startup. Exits early (silently) if not frozen or if already
    up to date. Replaces the EXE and relaunches if an update is found.
    """
    if not _is_frozen():
        log.debug("Updater: not frozen, skipping.")
        return

    log.info("Updater: checking for updates …")

    try:
        release = _fetch_latest_release()
    except Exception as e:
        log.warning(f"Updater: could not reach GitHub — {e}")
        return

    if release is None:
        log.warning("Updater: no release data returned.")
        return

    latest_version = release.get("tag_name", "").lstrip("v")
    log.info(f"Updater: current={current_version}  latest={latest_version}")

    asset = _find_asset(release)
    if asset is None:
        log.warning(f"Updater: no asset named '{EXE_ASSET_NAME}' in latest release.")
        return

    remote_digest = _parse_digest(asset.get("digest", ""))
    if remote_digest is None:
        log.warning("Updater: asset has no digest field — skipping update check.")
        return

    local_exe  = _current_exe()
    local_hash = _hash_file(local_exe)

    log.info(f"Updater: local  sha256={local_hash}")
    log.info(f"Updater: remote sha256={remote_digest}")

    if local_hash == remote_digest:
        log.info("Updater: already up to date.")
        return

    log.info(f"Updater: update available ({current_version} → {latest_version}), downloading …")

    download_url = asset["browser_download_url"]
    try:
        _download_and_replace(download_url, local_exe)
    except Exception as e:
        log.error(f"Updater: download/replace failed — {e}")
        return

    log.info("Updater: update applied, relaunching …")
    _relaunch(local_exe)


def _fetch_latest_release() -> Optional[dict]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "R4TEditor-Updater",
    }
    with httpx.Client(timeout=10.0, follow_redirects=True) as client:
        r = client.get(API_URL, headers=headers)
        r.raise_for_status()
        return r.json()


def _find_asset(release: dict) -> Optional[dict]:
    for asset in release.get("assets", []):
        if asset.get("name") == EXE_ASSET_NAME:
            return asset
    return None


def _parse_digest(digest: str) -> Optional[str]:
    """
    GitHub returns digest as "sha256:<hex>".
    Returns just the hex string, or None if the field is missing/wrong format.
    """
    if digest.startswith("sha256:"):
        return digest[len("sha256:"):]
    return None


def _download_and_replace(url: str, target: Path) -> None:
    """
    Download the new EXE to a temp file, then atomically swap it in.
    On Windows we can't overwrite a running EXE directly, so we rename the
    old one to .old and write the new one in its place. The .old file is
    cleaned up on the next launch.
    """
    # Clean up any leftover .old from a previous update
    old_path = target.with_suffix(".old")
    if old_path.exists():
        try:
            old_path.unlink()
        except Exception:
            pass

    # Download to a temp file in the same directory so the rename is atomic
    tmp_fd, tmp_path_str = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
    tmp_path = Path(tmp_path_str)
    try:
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            with client.stream("GET", url) as r:
                r.raise_for_status()
                with os.fdopen(tmp_fd, "wb") as f:
                    for chunk in r.iter_bytes(65536):
                        f.write(chunk)

        # On Windows: rename current → .old, then tmp → current
        if platform.system() == "Windows":
            target.rename(old_path)

        tmp_path.replace(target)

        # Restore execute permission on Linux/macOS
        if platform.system() != "Windows":
            target.chmod(target.stat().st_mode | 0o111)

    except Exception:
        # Clean up the temp file if anything went wrong
        try:
            tmp_path.unlink()
        except Exception:
            pass
        raise


def _relaunch(exe: Path) -> None:
    """Replace the current process with the updated EXE."""
    args = [str(exe)] + sys.argv[1:]
    if platform.system() == "Windows":
        # On Windows os.execv isn't reliable; spawn a new process and exit
        subprocess.Popen(args, close_fds=True)
        sys.exit(0)
    else:
        os.execv(str(exe), args)
