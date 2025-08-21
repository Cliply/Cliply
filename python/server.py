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
import yt_dlp
from yt_dlp.utils import download_range_func
import uuid
import re
from typing import List, Optional, Union
import time
import os
import asyncio
import json
import zipfile
from pathlib import Path
from datetime import datetime
from contextlib import asynccontextmanager

import platform
import tempfile
import subprocess
from concurrent.futures import ThreadPoolExecutor

def get_downloads_directory():
    return Path.home() / "Downloads" / "Cliply"

def get_cookies_directory():
    return Path.home() / ".config" / "app-data-7c4f" / "cookies"

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

DOWNLOADS_DIR = get_downloads_directory()
COOKIES_DIR = get_cookies_directory()
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
COOKIES_DIR.mkdir(parents=True, exist_ok=True)

FFMPEG_PATH = detect_ffmpeg_path()
if FFMPEG_PATH:
    ffmpeg_dir = str(Path(FFMPEG_PATH).parent)
    current_path = os.environ.get('PATH', '')
    if ffmpeg_dir not in current_path:
        path_separator = ';' if platform.system() == 'Windows' else ':'
        os.environ['PATH'] = f"{ffmpeg_dir}{path_separator}{current_path}"

executor = ThreadPoolExecutor(max_workers=4)
active_downloads = {}
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

class CookieManager:
    def __init__(self):
        self.cookie_file = COOKIES_DIR / "youtube_cookies.txt"
        self.ensure_cookie_file()
        
    def ensure_cookie_file(self):
        if not self.cookie_file.exists():
            with open(self.cookie_file, 'w') as f:
                f.write("# Netscape HTTP Cookie File\n")
                f.write("# This is a generated file! Do not edit.\n\n")
    
    def has_valid_cookies(self) -> bool:
        try:
            with open(self.cookie_file, 'r') as f:
                content = f.read().strip()
                lines = [line for line in content.split('\n') if line and not line.startswith('#')]
                return len(lines) > 0
        except:
            return False
    
    async def test_cookies(self) -> bool:
        try:
            test_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
            ydl_opts = {
                'quiet': True,
                'no_warnings': True,
                'cookiefile': str(self.cookie_file) if self.has_valid_cookies() else None,
                'extract_flat': True,
            }
            info = await extract_info_async(test_url, ydl_opts)
            return bool(info and info.get('title'))
        except:
            return False

cookie_manager = CookieManager()

class TimeRange(BaseModel):
    start: Union[float, str]
    end: Union[float, str]
    
    @field_validator('start', 'end', mode='before')
    @classmethod
    def convert_time_to_seconds(cls, v):
        if isinstance(v, str):
            time_pattern = r'^(\d{1,2}):(\d{2}):(\d{2})$'
            match = re.match(time_pattern, v)
            if match:
                hours, minutes, seconds = map(int, match.groups())
                return hours * 3600 + minutes * 60 + seconds
            time_pattern_short = r'^(\d{1,2}):(\d{2})$'
            match = re.match(time_pattern_short, v)
            if match:
                minutes, seconds = map(int, match.groups())
                return minutes * 60 + seconds
            try:
                return float(v)
            except ValueError:
                raise ValueError(f"Invalid time format: {v}")
        return float(v)
    
    @field_validator('end')
    @classmethod
    def validate_time_range(cls, v, info):
        if 'start' in info.data and v <= info.data['start']:
            raise ValueError('End time must be greater than start time')
        return v

class VideoInfoRequest(BaseModel):
    url: str
    
    @field_validator('url')
    @classmethod
    def validate_youtube_url(cls, v):
        youtube_regex = r'(https?://)?(www\.)?(youtube\.com/(watch\?v=|embed/|v/)|youtu\.be/)'
        if not re.match(youtube_regex, v):
            raise ValueError('Invalid YouTube URL')
        return v

class Format(BaseModel):
    format_id: str
    quality: str
    ext: str
    filesize: Optional[int]
    type: str

class VideoInfoResponse(BaseModel):
    title: str
    duration: int
    duration_string: str
    thumbnail: Optional[str]
    uploader: str
    video_formats: List[Format]
    audio_formats: List[Format]

class CombinedDownloadRequest(BaseModel):
    url: str
    video_format_id: str
    audio_format_id: str
    time_range: Optional[TimeRange] = None
    precise_cut: bool = False

class AudioDownloadRequest(BaseModel):
    url: str
    format_id: str
    time_range: Optional[TimeRange] = None
    precise_cut: bool = False

class PlaylistInfoRequest(BaseModel):
    url: str
    max_videos: Optional[int] = 50  # Limit to prevent overwhelming requests
    include_formats: bool = False   # Whether to extract format info for each video
    
    @field_validator('url')
    @classmethod
    def validate_playlist_url(cls, v):
        # Accept YouTube playlist, channel, or user URLs
        playlist_patterns = [
            r'(https?://)?(www\.)?(youtube\.com/(playlist\?list=|channel/|user/|c/)|youtu\.be/)',
            r'(https?://)?(www\.)?youtube\.com/watch\?.*list='
        ]
        if not any(re.match(pattern, v) for pattern in playlist_patterns):
            raise ValueError('Invalid YouTube playlist/channel URL')
        return v

class PlaylistVideoInfo(BaseModel):
    video_id: str
    title: str
    duration: Optional[int]
    duration_string: str
    thumbnail: Optional[str]
    uploader: str
    index: int
    url: str
    video_formats: List[Format] = []  # Reuse existing Format model
    audio_formats: List[Format] = []

class PlaylistInfoResponse(BaseModel):
    playlist_title: str
    playlist_id: Optional[str]
    uploader: str
    total_videos: int
    extracted_videos: int
    videos: List[PlaylistVideoInfo]

class PlaylistDownloadRequest(BaseModel):
    url: str
    selected_videos: List[int]  # List of video indices to download
    video_format_id: Optional[str] = None  # If None, download audio only
    audio_format_id: str
    archive_name: Optional[str] = None  # Custom name for ZIP archive
    
    @field_validator('selected_videos')
    @classmethod
    def validate_selected_videos(cls, v):
        if not v:
            raise ValueError('At least one video must be selected')
        if len(v) > 20:  # Limit bulk downloads
            raise ValueError('Maximum 20 videos can be downloaded at once')
        return v

def sanitize_filename(filename: str) -> str:
    filename = filename.replace('..', '')
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

def extract_quality_number(quality_str: str) -> int:
    try:
        return int(quality_str.split('p')[0])
    except:
        return 0

def get_enhanced_ydl_opts(base_opts: dict = None) -> dict:
    if base_opts is None:
        base_opts = {}
    
    # Use yt-dlp's built-in retry mechanisms instead of custom fallbacks
    simple_opts = {
        'quiet': True,
        'no_warnings': True,
        'retries': 3,                    # Built-in HTTP retries (default is 10)
        'extractor_retries': 2,          # Built-in extractor retries (default is 3) 
        'fragment_retries': 3,           # Built-in fragment retries for HLS/DASH (default is 10)
        'file_access_retries': 2,        # Built-in file access retries (default is 3)
    }
    
    if FFMPEG_PATH:
        simple_opts['ffmpeg_location'] = FFMPEG_PATH
    
    simple_opts.update(base_opts)
    return simple_opts

def extract_formats(formats_list: List[dict]) -> tuple[List[Format], List[Format]]:
    # just return the predefined formats - no need to parse the mess from yt-dlp
    video_formats = [
        Format(
            format_id="160",
            quality="144p",
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="133", 
            quality="240p",
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="134",
            quality="360p", 
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="135",
            quality="480p",
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="136",
            quality="720p HD",
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="137",
            quality="1080p Full HD",
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="400",
            quality="1440p 2K",
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="401",
            quality="2160p 4K",
            ext="mp4",
            filesize=None,
            type="video"
        ),
        Format(
            format_id="18",
            quality="360p (Combined/Fast)",
            ext="mp4",
            filesize=None,
            type="combined"
        )
    ]
    
    audio_formats = [
        Format(
            format_id="worstaudio",
            quality="Low Quality",
            ext="webm",
            filesize=None,
            type="audio"
        ),
        Format(
            format_id="bestaudio[abr<=70]",
            quality="Medium Quality", 
            ext="webm",
            filesize=None,
            type="audio"
        ),
        Format(
            format_id="bestaudio",
            quality="High Quality",
            ext="webm",
            filesize=None,
            type="audio"
        )
    ]
    
    return video_formats, audio_formats


def get_ydl_opts_with_time_range(base_opts: dict, time_range: Optional[TimeRange], precise_cut: bool = False) -> dict:
    if time_range:
        base_opts['download_ranges'] = download_range_func(None, [(time_range.start, time_range.end)])
        if precise_cut:
            base_opts['force_keyframes_at_cuts'] = True
        base_opts.pop('postprocessor_args', None)
    return base_opts

async def extract_info_async(url: str, opts: dict) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, _extract_info_blocking, url, opts)

async def download_async(url: str, opts: dict) -> None:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, _download_blocking, url, opts)

async def download_with_fallback(url: str, base_opts: dict) -> None:
    """Download using yt-dlp's built-in retry mechanisms"""
    # Let yt-dlp handle fallbacks automatically with its built-in retry system
    opts = get_enhanced_ydl_opts(base_opts)
    await download_async(url, opts)

def _extract_info_blocking(url: str, opts: dict) -> dict:
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)

def _download_blocking(url: str, opts: dict) -> None:
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

async def extract_video_info_with_fallback(url: str) -> dict:
    """Extract video info using yt-dlp's built-in retry mechanisms"""
    # Let yt-dlp handle fallbacks automatically with its built-in retry system
    opts = get_enhanced_ydl_opts()
    return await extract_info_async(url, opts)

async def extract_playlist_info_with_fallback(url: str, max_videos: int = 50, include_formats: bool = False) -> dict:
    """Extract playlist info using yt-dlp's built-in retry mechanisms"""
    base_playlist_opts = {
        'extract_flat': not include_formats,
        'playlist_items': f'1:{max_videos}',
    }
    
    try:
        # Let yt-dlp handle fallbacks automatically with its built-in retry system
        opts = get_enhanced_ydl_opts(base_playlist_opts)
        return await extract_info_async(url, opts)
    except Exception as e:
        error_msg = str(e)
        # Still handle the specific cookie-related error for playlists
        if "Sign in to confirm" in error_msg and not cookie_manager.has_valid_cookies():
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "YouTube bot detection triggered for playlist",
                    "message": "Server needs YouTube cookies to access playlists",
                    "has_cookies": False,
                    "solution": "Admin needs to update server cookies"
                }
            )
        raise e

def process_playlist_entries(entries: List[dict], include_formats: bool = False) -> List[PlaylistVideoInfo]:
    videos = []
    
    for i, entry in enumerate(entries):
        try:
            video_id = entry.get('id', '')
            title = entry.get('title', f'Video {i+1}')
            duration = entry.get('duration', 0)
            thumbnail = entry.get('thumbnail')
            uploader = entry.get('uploader', entry.get('channel', 'Unknown'))
            
            # Construct video URL
            video_url = f"https://www.youtube.com/watch?v={video_id}"
            
            video_formats = []
            audio_formats = []
            
            if include_formats and entry.get('formats'):
                video_formats, audio_formats = extract_formats(entry.get('formats', []))
            
            video_info = PlaylistVideoInfo(
                video_id=video_id,
                title=title,
                duration=duration,
                duration_string=format_duration(duration),
                thumbnail=thumbnail,
                uploader=uploader,
                index=i,
                url=video_url,
                video_formats=video_formats,
                audio_formats=audio_formats
            )
            
            videos.append(video_info)
            
        except Exception as e:
            continue
    
    return videos

@app.get("/", include_in_schema=False)
async def root():
    """Basic status endpoint with download awareness"""
    return {
        "message": "Cliply Desktop Server",
        "version": "1.0.0",
        "status": "running",
        "active_downloads": len(active_downloads),
        "downloads_directory": str(DOWNLOADS_DIR),
        "cookies": cookie_manager.has_valid_cookies(),
        "ffmpeg_available": FFMPEG_PATH is not None,
        "ffmpeg_path": str(FFMPEG_PATH) if FFMPEG_PATH else None
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


@app.post("/api/video/info", response_model=VideoInfoResponse)
async def get_video_info(request: VideoInfoRequest):
    """Get video information with format details"""
    try:
        info = await extract_video_info_with_fallback(request.url)
        video_formats, audio_formats = extract_formats(info.get('formats', []))
        
        return VideoInfoResponse(
            title=info.get('title', 'Unknown'),
            duration=info.get('duration', 0),
            duration_string=format_duration(info.get('duration', 0)),
            thumbnail=info.get('thumbnail'),
            uploader=info.get('uploader', 'Unknown'),
            video_formats=video_formats,
            audio_formats=audio_formats
        )
        
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to get video info: {str(e)}")

@app.post("/api/video/download-combined")
async def download_combined_video_audio(request: CombinedDownloadRequest):
    """Download and merge video+audio with optional time range"""
    download_id = str(uuid.uuid4())
    

    
    try:
        # Track active download
        active_downloads[download_id] = {
            "type": "combined",
            "url": request.url,
            "started": time.time()
        }
        
        info = await extract_video_info_with_fallback(request.url)
        title = sanitize_filename(info.get('title', 'video'))
        
        # Create unique filename including quality info
        quality = request.video_format_id if request.video_format_id != "18" else "360p"
        timestamp = int(time.time() * 1000) % 100000  # Last 5 digits for uniqueness
        
        if request.time_range:
            start_str = seconds_to_time_string(request.time_range.start)
            end_str = seconds_to_time_string(request.time_range.end)
            final_filename = f"{title}_{quality}_trimmed_{start_str}-{end_str}_{timestamp}.%(ext)s".replace(':', '-')
        else:
            final_filename = f"{title}_{quality}_{timestamp}.%(ext)s"
        
        final_path = DOWNLOADS_DIR / final_filename
        
        # direct download to final location (no temp files)
        # combine video + audio formats or use single combined format
        if request.video_format_id == "18":
            # Format 18 is already combined (video+audio)
            format_string = request.video_format_id
        else:
            # Combine separate video + audio formats
            format_string = f"{request.video_format_id}+{request.audio_format_id}"
        
        base_opts = {
            'format': format_string,
            'outtmpl': str(final_path),
            'merge_output_format': 'mp4',
        }
        
        base_opts = get_ydl_opts_with_time_range(base_opts, request.time_range, request.precise_cut)
        
        await download_with_fallback(request.url, base_opts)
        
        base_name = final_filename.replace('.%(ext)s', '')
        downloaded_files = list(DOWNLOADS_DIR.glob(f"{base_name}.*"))
        
        if not downloaded_files:
            raise HTTPException(status_code=500, detail="Download failed - file not found")
        
        actual_file = downloaded_files[0]
        active_downloads.pop(download_id, None)
        
        return JSONResponse({
            "success": True,
            "filename": actual_file.name,
            "file_path": str(actual_file),
            "file_size": actual_file.stat().st_size,
            "download_id": download_id
        })
        
    except Exception as e:
        # Cleanup on error (simplified)
        active_downloads.pop(download_id, None)
        raise HTTPException(status_code=500, detail=f"Combined download failed: {str(e)}")

@app.post("/api/audio/download")
async def download_audio_only(request: AudioDownloadRequest):
    """Download audio-only with optional time range"""
    download_id = str(uuid.uuid4())
    
    try:
        # Track active download
        active_downloads[download_id] = {
            "type": "audio",
            "url": request.url,
            "started": time.time()
        }
        
        info = await extract_video_info_with_fallback(request.url)
        title = sanitize_filename(info.get('title', 'audio'))
        
        # Create unique filename including quality info
        quality = request.format_id.replace('bestaudio', 'high').replace('worstaudio', 'low')
        timestamp = int(time.time() * 1000) % 100000
        
        if request.time_range:
            start_str = seconds_to_time_string(request.time_range.start)
            end_str = seconds_to_time_string(request.time_range.end)
            final_filename = f"{title}_audio_{quality}_trimmed_{start_str}-{end_str}_{timestamp}.%(ext)s".replace(':', '-')
        else:
            final_filename = f"{title}_audio_{quality}_{timestamp}.%(ext)s"
        
        final_path = DOWNLOADS_DIR / final_filename
        
        # direct download to final location (no temp files)
        base_opts = {
            'format': request.format_id,
            'outtmpl': str(final_path),
        }
        
        base_opts = get_ydl_opts_with_time_range(base_opts, request.time_range, request.precise_cut)
        
        await download_with_fallback(request.url, base_opts)
        
        base_name = final_filename.replace('.%(ext)s', '')
        downloaded_files = list(DOWNLOADS_DIR.glob(f"{base_name}.*"))
        
        if not downloaded_files:
            raise HTTPException(status_code=500, detail="Download failed - file not found")
        
        actual_file = downloaded_files[0]
        active_downloads.pop(download_id, None)
        
        return JSONResponse({
            "success": True,
            "filename": actual_file.name,
            "file_path": str(actual_file),
            "file_size": actual_file.stat().st_size,
            "download_id": download_id
        })
        
    except Exception as e:
        # Cleanup on error (simplified)
        active_downloads.pop(download_id, None)
        raise HTTPException(status_code=500, detail=f"Audio download failed: {str(e)}")

# PLAYLIST ENDPOINTS
@app.post("/api/playlist/info", response_model=PlaylistInfoResponse)
async def get_playlist_info(request: PlaylistInfoRequest):
    """Get playlist information with video list"""
    try:
        # Extract playlist info
        info = await extract_playlist_info_with_fallback(
            request.url, 
            request.max_videos, 
            request.include_formats
        )
        
        # Get playlist metadata
        playlist_title = info.get('title', 'Unknown Playlist')
        playlist_id = info.get('id', '')
        uploader = info.get('uploader', info.get('channel', 'Unknown'))
        total_videos = info.get('playlist_count', 0)
        entries = info.get('entries', [])
        
        # Process video entries
        videos = process_playlist_entries(entries, request.include_formats)
        
        return PlaylistInfoResponse(
            playlist_title=playlist_title,
            playlist_id=playlist_id,
            uploader=uploader,
            total_videos=total_videos,
            extracted_videos=len(videos),
            videos=videos
        )
        
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to get playlist info: {str(e)}")

@app.post("/api/playlist/download")
async def download_playlist_videos(request: PlaylistDownloadRequest, background_tasks: BackgroundTasks):
    """Download selected videos from playlist"""
    try:
        download_id = str(uuid.uuid4())
        
        # First, get playlist info to validate selected videos
        playlist_info = await extract_playlist_info_with_fallback(request.url, max_videos=100)
        entries = playlist_info.get('entries', [])
        
        if not entries:
            raise HTTPException(status_code=400, detail="No videos found in playlist")
        
        max_index = len(entries) - 1
        invalid_indices = [i for i in request.selected_videos if i > max_index or i < 0]
        if invalid_indices:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid video indices: {invalid_indices}. Playlist has {len(entries)} videos (indices 0-{max_index})"
            )
        
        batch_dir = DOWNLOADS_DIR / f"playlist_{download_id}"
        batch_dir.mkdir(exist_ok=True)
        
        downloaded_files = []
        failed_downloads = []
        
        for video_index in request.selected_videos:
            try:
                entry = entries[video_index]
                video_id = entry.get('id', '')
                video_title = sanitize_filename(entry.get('title', f'video_{video_index}'))
                video_url = f"https://www.youtube.com/watch?v={video_id}"
                
                if request.video_format_id:
                    format_string = f"{request.video_format_id}+{request.audio_format_id}"
                    file_ext = "mp4"
                else:
                    format_string = request.audio_format_id
                    file_ext = "m4a"
                
                safe_video_title = re.sub(r'[^\w\s-]', '', video_title)[:100]
                output_filename = f"{video_index:03d}_{safe_video_title}"
                output_path = batch_dir / f"{output_filename}.%(ext)s"
                
                base_opts = {
                    'format': format_string,
                    'outtmpl': str(output_path),
                    'merge_output_format': file_ext,
                    'restrictfilenames': True,
                }
                
                await download_with_fallback(video_url, base_opts)
                
                downloaded_file = list(batch_dir.glob(f"{output_filename}.*"))
                
                if not downloaded_file:
                    downloaded_file = list(batch_dir.glob(f"*{output_filename}*"))
                
                if not downloaded_file:
                    downloaded_file = list(batch_dir.glob(f"*{video_id}*"))
                
                if not downloaded_file:
                    all_files = list(batch_dir.glob("*"))
                    if all_files:
                        downloaded_file = [max(all_files, key=os.path.getctime)]
                
                if downloaded_file:
                    downloaded_files.append(downloaded_file[0])
                else:
                    failed_downloads.append(f"Video {video_index}: {video_title}")
                
            except Exception as e:
                failed_downloads.append(f"Video {video_index}: {str(e)}")
                continue
        
        if not downloaded_files:
            try:
                batch_dir.rmdir()
            except:
                pass
            raise HTTPException(status_code=500, detail="No videos were successfully downloaded")
        
        if len(downloaded_files) == 1:
            file_path = downloaded_files[0]
            playlist_title = sanitize_filename(playlist_info.get('title', 'playlist'))
            
            def cleanup():
                try:
                    file_path.unlink(missing_ok=True)
                    batch_dir.rmdir()
                except:
                    pass
            
            background_tasks.add_task(cleanup)
            
            return FileResponse(
                path=str(file_path),
                filename=f"{playlist_title}_{file_path.name}",
                media_type='application/octet-stream'
            )
        
        else:
            playlist_title = sanitize_filename(playlist_info.get('title', 'playlist'))
            archive_name = request.archive_name or f"{playlist_title}_videos"
            zip_path = batch_dir.parent / f"{download_id}_{archive_name}.zip"
            
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                for file_path in downloaded_files:
                    zipf.write(file_path, file_path.name)
            
            def cleanup():
                try:
                    for file_path in downloaded_files:
                        file_path.unlink(missing_ok=True)
                    batch_dir.rmdir()
                    zip_path.unlink(missing_ok=True)
                except:
                    pass
            
            background_tasks.add_task(cleanup)
            
            return FileResponse(
                path=str(zip_path),
                filename=f"{archive_name}.zip",
                media_type='application/zip'
            )
        
    except Exception as e:
        try:
            batch_dir = DOWNLOADS_DIR / f"playlist_{download_id}"
            if batch_dir.exists():
                for file in batch_dir.glob("*"):
                    file.unlink()
                batch_dir.rmdir()
        except:
            pass
        raise HTTPException(status_code=500, detail=f"Playlist download failed: {str(e)}")

@app.get("/api/health/ffmpeg", include_in_schema=False)
async def check_ffmpeg_health():
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8888,
        log_level="warning"
    )