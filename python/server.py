import sys
import io
# fix windows console issues
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from fastapi import FastAPI, HTTPException, Request, Depends, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.openapi.docs import get_swagger_ui_html
from pydantic import BaseModel, field_validator
import uuid
import time
import os
from pathlib import Path
from contextlib import asynccontextmanager

import platform
import subprocess
from shared_utils import (
    APP_CONFIG_DIR,
    executor,
    get_settings_directory,
    get_settings_file,
    load_settings,
    save_settings,
    get_downloads_directory,
    set_downloads_directory,
    detect_ffmpeg_path,
    detect_deno_path,
)

from platforms.youtube import (
    YouTubeService,
    CookieManager,
    VideoInfoRequest,
    VideoInfoResponse,
    CombinedDownloadRequest,
    AudioDownloadRequest,
    PlaylistInfoRequest,
    PlaylistInfoResponse,
    PlaylistDownloadRequest,
    get_cookies_directory
)

from platforms.pinterest import (
    PinterestService,
    PinterestVideoInfoRequest,
    PinterestVideoInfoResponse,
    PinterestDownloadRequest
)

# Initialize cookies directory
COOKIES_DIR = get_cookies_directory()
COOKIES_DIR.mkdir(parents=True, exist_ok=True)

# make sure default download folder exists
get_downloads_directory()

# Detect binary paths
FFMPEG_PATH = detect_ffmpeg_path()
DENO_PATH = detect_deno_path()

if FFMPEG_PATH:
    ffmpeg_dir = str(Path(FFMPEG_PATH).parent)
    current_path = os.environ.get('PATH', '')
    if ffmpeg_dir not in current_path:
        path_separator = ';' if platform.system() == 'Windows' else ':'
        os.environ['PATH'] = f"{ffmpeg_dir}{path_separator}{current_path}"

# Initialize cookie manager and YouTube service
cookie_manager = CookieManager()
youtube_service = YouTubeService(FFMPEG_PATH, DENO_PATH, cookie_manager)

# Initialize Pinterest service
pinterest_service = PinterestService(FFMPEG_PATH, DENO_PATH)

@asynccontextmanager
async def lifespan(app: FastAPI):
    cookie_manager.ensure_cookie_file()
    if cookie_manager.has_valid_cookies():
        await cookie_manager.test_cookies()
    yield
    executor.shutdown(wait=True)

app = FastAPI(
    title="Cliply API Server", 
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan
)


# =============================================================================
# SETTINGS MODELS (kept in server.py - not YouTube-specific)
# =============================================================================

class DownloadPathRequest(BaseModel):
    path: str
    
    @field_validator('path')
    @classmethod
    def validate_path(cls, v):
        if not v or not v.strip():
            raise ValueError('Path cannot be empty')
        
        # Basic path validation
        try:
            path_obj = Path(v)
            if not path_obj.is_absolute():
                raise ValueError('Path must be absolute')
        except Exception:
            raise ValueError('Invalid path format')
        
        return v.strip()


class DownloadPathResponse(BaseModel):
    path: str
    exists: bool
    writable: bool


# =============================================================================
# ROOT & DOCUMENTATION ENDPOINTS
# =============================================================================

@app.get("/", include_in_schema=False)
async def root():
    """Basic status endpoint with download awareness"""
    return {
        "message": "Cliply Desktop Server",
        "version": "1.0.0",
        "status": "running",
        "active_downloads": youtube_service.get_active_downloads_count() + pinterest_service.get_active_downloads_count(),
        "downloads_directory": str(get_downloads_directory()),
        "services": {
            "youtube": {
                "active_downloads": youtube_service.get_active_downloads_count(),
                "cookies": cookie_manager.has_valid_cookies()
            },
            "pinterest": {
                "active_downloads": pinterest_service.get_active_downloads_count()
            }
        },
        "ffmpeg_available": FFMPEG_PATH is not None,
        "ffmpeg_path": str(FFMPEG_PATH) if FFMPEG_PATH else None,
        "deno_available": DENO_PATH is not None,
        "deno_path": str(DENO_PATH) if DENO_PATH else None
    }

@app.get("/docs", response_class=HTMLResponse, include_in_schema=False)
async def get_docs():
    """API documentation"""
    return get_swagger_ui_html(
        openapi_url="/openapi.json",
        title=app.title + " - API Documentation",
        swagger_favicon_url="/favicon.ico"
    )

@app.get("/openapi.json", include_in_schema=False)
async def get_openapi():
    """OpenAPI schema"""
    return app.openapi()


# =============================================================================
# VIDEO ENDPOINTS (delegated to YouTubeService)
# =============================================================================

@app.post("/api/video/info", response_model=VideoInfoResponse)
async def get_video_info(request: VideoInfoRequest):
    """Get video information with format details"""
    download_dir = get_downloads_directory()
    return await youtube_service.get_video_info(request, download_dir)


@app.post("/api/video/download-combined")
async def download_combined_video_audio(request: CombinedDownloadRequest):
    """Download and merge video+audio with optional time range"""
    try:
        download_dir = get_downloads_directory()
        result = await youtube_service.download_combined(request, download_dir)
        return JSONResponse(result)
    except Exception as e:
        raise


# =============================================================================
# AUDIO ENDPOINTS (delegated to YouTubeService)
# =============================================================================

@app.post("/api/audio/download")
async def download_audio_only(request: AudioDownloadRequest):
    """Download audio-only with optional time range"""
    try:
        download_dir = get_downloads_directory()
        result = await youtube_service.download_audio(request, download_dir)
        return JSONResponse(result)
    except Exception as e:
        raise


# =============================================================================
# PLAYLIST ENDPOINTS (delegated to YouTubeService)
# =============================================================================

@app.post("/api/playlist/info", response_model=PlaylistInfoResponse)
async def get_playlist_info(request: PlaylistInfoRequest):
    """Get playlist information with video list"""
    download_dir = get_downloads_directory()
    return await youtube_service.get_playlist_info(request, download_dir)


@app.post("/api/playlist/download")
async def download_playlist_videos(request: PlaylistDownloadRequest, background_tasks: BackgroundTasks):
    """Download selected videos from playlist"""
    download_dir = get_downloads_directory()
    return await youtube_service.download_playlist(request, download_dir, background_tasks)


# =============================================================================
# PINTEREST ENDPOINTS
# =============================================================================

@app.post("/api/pinterest/info", response_model=PinterestVideoInfoResponse)
async def get_pinterest_info(request: PinterestVideoInfoRequest):
    """Get Pinterest video pin information"""
    download_dir = get_downloads_directory()
    return await pinterest_service.get_video_info(request, download_dir)


@app.post("/api/pinterest/download")
async def download_pinterest_video(request: PinterestDownloadRequest):
    """Download Pinterest video or audio"""
    try:
        download_dir = get_downloads_directory()
        result = await pinterest_service.download_video(request, download_dir)
        return JSONResponse(result)
    except Exception as e:
        raise


# =============================================================================
# SETTINGS ENDPOINTS
# =============================================================================

@app.get("/api/settings/download-path", response_model=DownloadPathResponse)
async def get_download_path():
    """Get current download folder info"""
    try:
        current_path = get_downloads_directory()
        
        # Check if path exists and is writable
        exists = current_path.exists()
        writable = False
        
        if exists:
            try:
                # Test write permissions
                test_file = current_path / "cliply_test_write.tmp"
                test_file.write_text("test")
                test_file.unlink()
                writable = True
            except:
                writable = False
        
        return DownloadPathResponse(
            path=str(current_path),
            exists=exists,
            writable=writable
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get download path: {str(e)}")


@app.post("/api/settings/download-path")
async def set_download_path(request: DownloadPathRequest):
    """Update download folder location"""
    try:
        success = set_downloads_directory(request.path)
        
        if not success:
            raise HTTPException(
                status_code=400, 
                detail="Failed to set download path. Please check path exists and is writable."
            )
        
        # Return updated path info
        current_path = get_downloads_directory()
        exists = current_path.exists()
        writable = False
        
        if exists:
            try:
                test_file = current_path / "cliply_test_write.tmp"
                test_file.write_text("test")
                test_file.unlink()
                writable = True
            except:
                writable = False
        
        return {
            "success": True,
            "path": str(current_path),
            "exists": exists,
            "writable": writable
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to set download path: {str(e)}")


# =============================================================================
# HEALTH CHECK ENDPOINTS
# =============================================================================

@app.get("/api/health/ffmpeg", include_in_schema=False)
async def check_ffmpeg_health():
    """Check if FFmpeg is available and working"""
    if not FFMPEG_PATH: 
        return {
            "available": False,
            "error": "ffmpeg not found"
        }
    
    try:
        result = subprocess.run([FFMPEG_PATH, '-version'], 
                              capture_output=True, 
                              timeout=10,
                              text=True)
        
        if result.returncode == 0:
            version_line = result.stdout.split('\n')[0] if result.stdout else "Unknown version"
            return {
                "available": True,
                "path": FFMPEG_PATH,
                "version": version_line,
                "test_passed": True
            }
        else:
            return {
                "available": False,
                "path": FFMPEG_PATH,
                "error": f"ffmpeg test failed with code {result.returncode}",
                "stderr": result.stderr[:500] if result.stderr else ""
            }
            
    except subprocess.TimeoutExpired:
        return {
            "available": False,
            "path": FFMPEG_PATH,
            "error": "ffmpeg test timeout"
        }
    except Exception as e:
        return {
            "available": False,
            "path": FFMPEG_PATH,
            "error": f"ffmpeg test error: {str(e)}"
        }


@app.get("/api/health/deno", include_in_schema=False)
async def check_deno_health():
    """Check if Deno runtime is available and working"""
    if not DENO_PATH: 
        return {
            "available": False,
            "error": "deno not found"
        }
    
    try:
        result = subprocess.run([DENO_PATH, '--version'], 
                              capture_output=True, 
                              timeout=10,
                              text=True)
        
        if result.returncode == 0:
            version_line = result.stdout.split('\n')[0] if result.stdout else "Unknown version"
            return {
                "available": True,
                "path": DENO_PATH,
                "version": version_line,
                "test_passed": True
            }
        else:
            return {
                "available": False,
                "path": DENO_PATH,
                "error": f"deno test failed with code {result.returncode}",
                "stderr": result.stderr[:500] if result.stderr else ""
            }
            
    except subprocess.TimeoutExpired:
        return {
            "available": False,
            "path": DENO_PATH,
            "error": "deno test timeout"
        }
    except Exception as e:
        return {
            "available": False,
            "path": DENO_PATH,
            "error": f"deno test error: {str(e)}"
        }


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8888,
        log_level="warning"
    )
