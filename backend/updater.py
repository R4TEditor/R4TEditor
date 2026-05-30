import logging
import os
import platform
import subprocess
import sys
import tempfile
import hashlib
from pathlib import Path
from typing import Optional

import httpx
from packaging.version import Version, InvalidVersion

log = logging.getLogger(__name__)

# --- Config ----------------------------------------------------------------

GITHUB_OWNER = "R4TEditor"
GITHUB_REPO  = "R4TEditor"
API_URL      = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"

# Asset name as uploaded to GitHub releases
EXE_ASSET_NAME = "R4TEditor.exe" if platform.system() == "Windows" else "R4TEditor"


# --- Helpers ---------------------------------------------------------------

def _is_frozen() -> bool:
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def _current_exe() -> Path:
    return Path(sys.executable)


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_newer(latest: str, current: str) -> bool:
    try:
        return Version(latest) > Version(current)
    except InvalidVersion:
        log.warning(
            f"Updater: could not parse versions (current={current!r}, latest={latest!r}) "
            "— skipping update."
        )
        return False


# --- Core ------------------------------------------------------------------

def check_and_update(current_version: str) -> None:
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

    latest_version = release.get("tag_name", "").strip().lstrip("vV")
    log.info(f"Updater: current={current_version}  latest={latest_version}")

    # --- FIX: only proceed if the remote release is actually newer ----------
    if not _is_newer(latest_version, current_version):
        log.info(
            f"Updater: latest ({latest_version}) is not newer than current "
            f"({current_version}) — no update needed."
        )
        return
    # -------------------------------------------------------------------------

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
        tmp_path = _download_to_tmp(download_url, local_exe.parent)
    except Exception as e:
        log.error(f"Updater: download failed — {e}")
        return

    # Verify the downloaded file before touching the live EXE
    log.info("Updater: verifying download …")
    try:
        downloaded_hash = _hash_file(tmp_path)
    except Exception as e:
        log.error(f"Updater: could not hash downloaded file — {e}")
        tmp_path.unlink(missing_ok=True)
        return

    if downloaded_hash != remote_digest:
        log.error(
            f"Updater: hash mismatch — download is corrupted or incomplete. "
            f"expected={remote_digest}  got={downloaded_hash}"
        )
        tmp_path.unlink(missing_ok=True)
        return

    log.info("Updater: download verified. Replacing EXE …")
    try:
        _replace_exe(tmp_path, local_exe)
    except Exception as e:
        log.error(f"Updater: replace failed — {e}")
        tmp_path.unlink(missing_ok=True)
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
    if isinstance(digest, str) and digest.startswith("sha256:"):
        return digest[len("sha256:"):]
    return None


def _download_to_tmp(url: str, directory: Path) -> Path:
    for leftover in directory.glob("*.old"):
        try:
            leftover.unlink()
            log.debug(f"Updater: removed leftover {leftover.name}")
        except Exception:
            pass

    tmp_fd, tmp_path_str = tempfile.mkstemp(dir=directory, suffix=".tmp")
    tmp_path = Path(tmp_path_str)

    try:
        with httpx.Client(timeout=300.0, follow_redirects=True) as client:
            with client.stream("GET", url) as r:
                r.raise_for_status()
                with os.fdopen(tmp_fd, "wb") as f:
                    for chunk in r.iter_bytes(65536):
                        f.write(chunk)
        log.info(f"Updater: download complete ({tmp_path.stat().st_size:,} bytes)")
        return tmp_path

    except Exception:
        try:
            os.close(tmp_fd)
        except OSError:
            pass
        try:
            tmp_path.unlink()
        except Exception:
            pass
        raise


def _replace_exe(tmp_path: Path, target: Path) -> None:
    old_path = target.with_suffix(".old")

    if platform.system() == "Windows":
        target.rename(old_path)

    tmp_path.replace(target)

    if platform.system() != "Windows":
        target.chmod(target.stat().st_mode | 0o111)


def _relaunch(exe: Path) -> None:
    args = [str(exe)] + sys.argv[1:]
    if platform.system() == "Windows":
        subprocess.Popen(args, close_fds=True)
        sys.exit(0)
    else:
        os.execv(str(exe), args)
