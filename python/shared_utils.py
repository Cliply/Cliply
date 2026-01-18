import os
import re
import json
import platform
import subprocess
import shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

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
        if path.exists() and path.is_file():
            import stat
            if path.stat().st_mode & stat.S_IXUSR:
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
        if path.exists() and path.is_file():
            import stat
            if path.stat().st_mode & stat.S_IXUSR:
                return str(path)
    return None

def sanitize_filename(filename: str) -> str:
    filename = os.path.basename(filename)
    filename = re.sub(r'[<>:"/\\|?*]', '', filename)
    filename = re.sub(r'\s+', ' ', filename).strip()
    return filename[:200] if len(filename) > 200 else filename

def format_duration(seconds: int) -> str:
    if not seconds:
        return "00:00"
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    seconds = seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"

def seconds_to_time_string(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"
