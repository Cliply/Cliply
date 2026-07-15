import os
import re
import json
import platform
import subprocess
import shutil
from collections import deque
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

# app config directory
APP_CONFIG_DIR = ".config/app-data-7c4f"

# global thread pool executor
executor = ThreadPoolExecutor(max_workers=4)

def get_settings_directory():
    return Path.home() / APP_CONFIG_DIR

def get_settings_file():
    return get_settings_directory() / "settings.json"

def load_settings():
    """load user settings, fallback to defaults if missing"""
    try:
        settings_file = get_settings_file()
        if settings_file.exists():
            with open(settings_file, 'r') as f:
                return json.load(f)
    except Exception as e:
        print(f"failed to load settings: {e}")
    
    # Return default settings
    return {
        "download_path": str(Path.home() / "Downloads" / "Cliply")
    }

def save_settings(settings):
    """save settings to disk"""
    try:
        settings_dir = get_settings_directory()
        settings_dir.mkdir(parents=True, exist_ok=True)
        
        settings_file = get_settings_file()
        with open(settings_file, 'w') as f:
            json.dump(settings, f, indent=2)
        return True
    except Exception as e:
        print(f"failed to save settings: {e}")
        return False

def get_downloads_directory():
    """get user's download folder, create if needed"""
    settings = load_settings()
    download_path = Path(settings.get("download_path", Path.home() / "Downloads" / "Cliply"))
    
    # Ensure directory exists
    try:
        download_path.mkdir(parents=True, exist_ok=True)
        return download_path
    except Exception as e:
        print(f"failed to create download directory {download_path}: {e}")
        # Fallback to default
        fallback_path = Path.home() / "Downloads" / "Cliply"
        fallback_path.mkdir(parents=True, exist_ok=True)
        return fallback_path

def set_downloads_directory(new_path):
    """update download folder after validation"""
    try:
        path_obj = Path(new_path)
        
        # validate and test the new path
        if not path_obj.exists():
            path_obj.mkdir(parents=True, exist_ok=True)
        
        if not path_obj.is_dir():
            raise ValueError("path is not a directory")
        
        # make sure we can write files here
        test_file = path_obj / "cliply_test_file.tmp"
        test_file.write_text("test")
        test_file.unlink()
        
        # all good, save to settings
        settings = load_settings()
        settings["download_path"] = str(path_obj)
        return save_settings(settings)
        
    except Exception as e:
        print(f"failed to set download directory to {new_path}: {e}")
        return False

def detect_ffmpeg_path():
    script_dir = Path(__file__).parent.absolute()
    potential_paths = []
    
    if platform.system() == "Darwin":
        potential_paths.append(script_dir.parent / "binaries" / "ffmpeg")
        potential_paths.append(script_dir.parent / "binaries" / "macos" / "ffmpeg")
    elif platform.system() == "Windows":
        potential_paths.append(script_dir.parent / "binaries" / "ffmpeg.exe")
        potential_paths.append(script_dir.parent / "binaries" / "windows" / "ffmpeg.exe")
    elif platform.system() == "Linux":
        potential_paths.append(script_dir.parent / "binaries" / "ffmpeg")
        potential_paths.append(script_dir.parent / "binaries" / "linux" / "ffmpeg")
    
    for path in potential_paths:
        if path.exists() and path.is_file() and os.access(str(path), os.X_OK):
            return str(path)
    return None

def detect_deno_path():
    """Detect Deno binary path for yt-dlp JavaScript runtime support"""
    script_dir = Path(__file__).parent.absolute()
    potential_paths = []

    if platform.system() == "Darwin":
        potential_paths.append(script_dir.parent / "binaries" / "deno" / "macos" / "deno")
    elif platform.system() == "Windows":
        potential_paths.append(script_dir.parent / "binaries" / "deno" / "windows" / "deno.exe")
    elif platform.system() == "Linux":
        potential_paths.append(script_dir.parent / "binaries" / "deno" / "linux" / "deno")

    for path in potential_paths:
        if path.exists() and path.is_file() and os.access(str(path), os.X_OK):
            return str(path)
    return None

def sanitize_filename(filename: str) -> str:
    filename = os.path.basename(filename)
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', filename)
    filename = re.sub(r'\s+', ' ', filename).strip()
    filename = filename[:200]
    # windows rejects trailing dots/spaces and treats them specially
    filename = filename.rstrip('. ')
    return filename or 'video'


# =============================================================================
# ffmpeg / yt-dlp error capture
# =============================================================================

class FFmpegLogger:
    """Ring-buffer logger for yt-dlp. Captures the last N lines of FFmpeg / yt-dlp
    output so we can surface the real cause when a download fails, instead of
    only the generic 'ffmpeg exited with code N' message."""

    def __init__(self, max_lines: int = 40):
        self.lines = deque(maxlen=max_lines)

    def _push(self, msg):
        if not msg:
            return
        for line in str(msg).splitlines():
            line = line.strip()
            if line:
                self.lines.append(line)

    def debug(self, msg):
        self._push(msg)

    def info(self, msg):
        self._push(msg)

    def warning(self, msg):
        self._push(msg if str(msg).startswith('WARNING') else f"WARNING: {msg}")

    def error(self, msg):
        self._push(msg if str(msg).startswith('ERROR') else f"ERROR: {msg}")

    def tail(self, n: int = 15) -> str:
        return "\n".join(list(self.lines)[-n:])


_FFMPEG_CODE_RE = re.compile(r'ffmpeg exited with code (-?\d+)')

# user home folder often appears inside FFmpeg / yt-dlp output; redact so we
# never send the user's real name to analytics.
_HOME_DIR = str(Path.home())
_USER_PATH_PATTERNS = [
    (re.compile(r'/Users/[^/\\\s"\'<>]+'), '/Users/~'),
    (re.compile(r'/home/[^/\\\s"\'<>]+'), '/home/~'),
    (re.compile(r'([A-Za-z]):\\\\Users\\\\[^\\\\<>"|?*\n\r]+'), r'\1:\\\\Users\\\\~'),
    (re.compile(r'([A-Za-z]):\\Users\\[^\\<>"|?*\n\r]+'), r'\1:\\Users\\~'),
]


def redact_user_paths(text: str) -> str:
    """Replace the current user's home directory with ~ so error messages
    don't leak the OS account name to analytics."""
    if not text:
        return text
    if _HOME_DIR and _HOME_DIR in text:
        text = text.replace(_HOME_DIR, '~')
    for pattern, replacement in _USER_PATH_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _short_message_for(exit_code: Optional[str], text: str) -> Optional[str]:
    """Return a single-sentence summary of the failure, or None if unknown."""
    t = text.lower()
    if exit_code in ("183", "251", "215", "-5", "-9") or "killed" in t or "sigkill" in t:
        return "Antivirus may have blocked FFmpeg. Add Cliply to your exclusions and try again."
    if exit_code == "127" or "no such file" in t or "not found" in t:
        return "FFmpeg binary is missing. Please reinstall Cliply."
    if "permission denied" in t:
        return "Can't write to the download folder. Check permissions or pick a different location."
    if "no space" in t or "disk full" in t or "enospc" in t:
        return "Not enough disk space to save this download."
    if "moov atom" in t or "invalid data" in t:
        return "The source stream looks corrupted. Try downloading again."
    if "network is unreachable" in t or "connection reset" in t or "timed out" in t:
        return "Network interrupted the download. Check your connection and try again."
    return None


def format_download_error(exc: Exception, logger: Optional['FFmpegLogger'] = None) -> str:
    """Return '<short>\\n\\n<full technical>'.

    The caller (Node IPC layer) shows the short paragraph to the user and
    forwards the entire string to analytics.
    """
    base = str(exc) or exc.__class__.__name__
    match = _FFMPEG_CODE_RE.search(base)
    exit_code = match.group(1) if match else None

    tail = logger.tail(15) if logger else ""
    short = _short_message_for(exit_code, f"{base}\n{tail}") or base

    technical_parts = []
    if short != base:
        technical_parts.append(base)
    if tail and tail not in base:
        technical_parts.append(f"FFmpeg output:\n{tail}")

    if not technical_parts:
        return redact_user_paths(short)
    return redact_user_paths(short + "\n\n" + "\n\n".join(technical_parts))

def format_duration(seconds) -> str:
    if not seconds:
        return "00:00"
    seconds = int(seconds)
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"

def seconds_to_time_string(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"
