"""
YouTube platform service module.

This module encapsulates all YouTube-specific functionality including:
- Video/playlist information extraction
- Video/audio downloads with time range support
- Playlist batch downloads with ZIP archive creation
- Cookie management for authenticated requests
"""

import os
import re
import asyncio
import uuid
import time
import zipfile
from pathlib import Path
from typing import List, Optional, Union
from datetime import datetime

import yt_dlp
from yt_dlp.utils import download_range_func
from pydantic import BaseModel, field_validator
from fastapi import HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse

from shared_utils import (
    executor,
    sanitize_filename,
    format_duration,
    seconds_to_time_string,
    get_downloads_directory
)


# =============================================================================
# COOKIES DIRECTORY
# =============================================================================

def get_cookies_directory():
    return Path.home() / ".config" / "app-data-7c4f" / "cookies"


# =============================================================================
# PYDANTIC MODELS
# =============================================================================

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
        youtube_regex = r'(https?://)?(www\.)?(youtube\.com/(watch\?v=|embed/|v/|shorts/)|youtu\.be/)'
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


# =============================================================================
# COOKIE MANAGER
# =============================================================================

class CookieManager:
    def __init__(self):
        cookies_dir = get_cookies_directory()
        cookies_dir.mkdir(parents=True, exist_ok=True)
        self.cookie_file = cookies_dir / "youtube_cookies.txt"
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

    def get_cookie_path(self) -> Path:
        return self.cookie_file


# =============================================================================
# YOUTUBE UTILITY FUNCTIONS
# =============================================================================

def is_youtube_shorts(url: str) -> bool:
    """Check if URL is a YouTube Shorts URL"""
    return '/shorts/' in url.lower()


def extract_quality_number(quality_str: str) -> int:
    try:
        return int(quality_str.split('p')[0])
    except:
        return 0


def extract_formats(formats_list: List[dict], url: str = "") -> tuple[List[Format], List[Format]]:
    # shorts get single auto format, regular videos get full options
    if is_youtube_shorts(url):
        video_formats = [Format(format_id="shorts_auto", quality="Auto", ext="mp4", filesize=None, type="auto")]
        audio_formats = [Format(format_id="auto_audio", quality="Auto", ext="m4a", filesize=None, type="audio")]
    else:
        video_formats = [
            Format(format_id="auto", quality="Auto (Recommended)", ext="mp4/webm", filesize=None, type="auto"),
            Format(format_id="best_quality", quality="Best Quality", ext="mp4/webm", filesize=None, type="video"),
            Format(format_id="hd_720p", quality="720p HD", ext="mp4/webm", filesize=None, type="video"),
            Format(format_id="eco_360p", quality="360p (Fast)", ext="mp4", filesize=None, type="combined")
        ]
        audio_formats = [
            Format(format_id="auto_audio", quality="Auto", ext="m4a", filesize=None, type="audio"),
            Format(format_id="high_audio", quality="High Quality", ext="m4a", filesize=None, type="audio"),
            Format(format_id="medium_audio", quality="Medium Quality", ext="m4a", filesize=None, type="audio")
        ]
    
    return video_formats, audio_formats


def get_format_selector(video_format_id: str, audio_format_id: str) -> Optional[str]:
    # convert format ids to yt-dlp selectors
    if video_format_id == "auto":
        return None
    elif video_format_id == "shorts_auto":
        return "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    elif video_format_id == "eco_360p":
        return "best[height<=720]/bestvideo[height<=360]+bestaudio"
    elif video_format_id == "hd_720p":
        return "bestvideo[height<=720]+bestaudio"
    else:
        return "bestvideo+bestaudio/best"


def get_audio_format_selector(format_id: str) -> str:
    selectors = {
        "auto_audio": "bestaudio",
        "high_audio": "bestaudio", 
        "medium_audio": "bestaudio[abr<=128]"
    }
    return selectors.get(format_id, "bestaudio")


def get_quality_label(video_format_id: str) -> str:
    labels = {
        "auto": "auto",
        "shorts_auto": "shorts",
        "best_quality": "best", 
        "hd_720p": "720p",
        "eco_360p": "360p"
    }
    return labels.get(video_format_id, video_format_id)


def get_enhanced_ydl_opts(base_opts: dict = None, ffmpeg_path: Optional[str] = None, deno_path: Optional[str] = None) -> dict:
    """Get enhanced yt-dlp options with FFmpeg and Deno paths."""
    if base_opts is None:
        base_opts = {}
    
    simple_opts = {
        'quiet': True,
        'no_warnings': True,
        'retries': 1,
        'extractor_retries': 1,
        'fragment_retries': 2,
    }
    
    # Add FFmpeg location if available
    if ffmpeg_path:
        simple_opts['ffmpeg_location'] = ffmpeg_path
    
    # Add Deno runtime for JavaScript execution (required for yt-dlp 2025.11.12+)
    if deno_path:
        simple_opts['js_runtimes'] = {'deno': {'path': deno_path}}
    
    simple_opts.update(base_opts)
    return simple_opts


def get_ydl_opts_with_time_range(base_opts: dict, time_range: Optional[TimeRange], precise_cut: bool = False) -> dict:
    if time_range:
        base_opts['download_ranges'] = download_range_func(None, [(time_range.start, time_range.end)])
        if precise_cut:
            base_opts['force_keyframes_at_cuts'] = True
        base_opts.pop('postprocessor_args', None)
    return base_opts


# =============================================================================
# ASYNC WRAPPERS
# =============================================================================

def _extract_info_blocking(url: str, opts: dict) -> dict:
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


def _download_blocking(url: str, opts: dict) -> None:
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])


async def extract_info_async(url: str, opts: dict) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, _extract_info_blocking, url, opts)


async def download_async(url: str, opts: dict) -> None:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(executor, _download_blocking, url, opts)


# =============================================================================
# FALLBACK FUNCTIONS
# =============================================================================

async def download_with_fallback(url: str, base_opts: dict, ffmpeg_path: Optional[str] = None, deno_path: Optional[str] = None) -> None:
    """Download using yt-dlp's built-in retry mechanisms"""
    opts = get_enhanced_ydl_opts(base_opts, ffmpeg_path, deno_path)
    await download_async(url, opts)


async def extract_video_info_with_fallback(url: str, ffmpeg_path: Optional[str] = None, deno_path: Optional[str] = None) -> dict:
    """Extract video info using yt-dlp's built-in retry mechanisms"""
    opts = get_enhanced_ydl_opts(None, ffmpeg_path, deno_path)
    return await extract_info_async(url, opts)


async def extract_playlist_info_with_fallback(
    url: str, 
    max_videos: int = 50, 
    include_formats: bool = False,
    ffmpeg_path: Optional[str] = None,
    deno_path: Optional[str] = None,
    cookie_manager: Optional[CookieManager] = None
) -> dict:
    """Extract playlist info using yt-dlp's built-in retry mechanisms"""
    base_playlist_opts = {
        'extract_flat': not include_formats,
        'playlist_items': f'1:{max_videos}',
    }
    
    try:
        opts = get_enhanced_ydl_opts(base_playlist_opts, ffmpeg_path, deno_path)
        return await extract_info_async(url, opts)
    except Exception as e:
        error_msg = str(e)
        # Handle the specific cookie-related error for playlists
        if "Sign in to confirm" in error_msg and cookie_manager and not cookie_manager.has_valid_cookies():
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


# =============================================================================
# PLAYLIST PROCESSING
# =============================================================================

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
                video_formats, audio_formats = extract_formats(entry.get('formats', []), video_url)
            
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


# =============================================================================
# YOUTUBE SERVICE CLASS
# =============================================================================

class YouTubeService:
    """Main service class that encapsulates all YouTube operations."""
    
    def __init__(self, ffmpeg_path: Optional[str], deno_path: Optional[str], cookie_manager: CookieManager):
        self.ffmpeg_path = ffmpeg_path
        self.deno_path = deno_path
        self.cookie_manager = cookie_manager
        self.cookie_file = cookie_manager.get_cookie_path()

    async def get_video_info(self, request: VideoInfoRequest, download_dir: Path) -> VideoInfoResponse:
        """Get video information with format details."""
        try:
            info = await extract_video_info_with_fallback(request.url, self.ffmpeg_path, self.deno_path)
            video_formats, audio_formats = extract_formats(info.get('formats', []), request.url)
            
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

    async def download_combined(self, request: CombinedDownloadRequest, download_dir: Path) -> dict:
        """Download and merge video+audio with optional time range."""
        try:
            info = await extract_video_info_with_fallback(request.url, self.ffmpeg_path, self.deno_path)
            title = sanitize_filename(info.get('title', 'video'))
            
            quality = get_quality_label(request.video_format_id)
            timestamp = int(time.time() * 1000) % 100000
            
            if request.time_range:
                start_str = seconds_to_time_string(request.time_range.start)
                end_str = seconds_to_time_string(request.time_range.end)
                final_filename = f"{title}_{quality}_trimmed_{start_str}-{end_str}_{timestamp}.%(ext)s".replace(':', '-')
            else:
                final_filename = f"{title}_{quality}_{timestamp}.%(ext)s"
            
            final_path = download_dir / final_filename
            
            format_string = get_format_selector(request.video_format_id, request.audio_format_id)
            
            base_opts = {
                'outtmpl': str(final_path),
                'merge_output_format': 'mp4',
            }
            
            if format_string is not None:
                base_opts['format'] = format_string
            
            base_opts = get_ydl_opts_with_time_range(base_opts, request.time_range, request.precise_cut)
            
            await download_with_fallback(request.url, base_opts, self.ffmpeg_path, self.deno_path)
            
            # More robust file detection - check for files with the expected base name
            base_name = final_filename.replace('.%(ext)s', '')
            possible_files = []
            
            # Look for files with the exact base name and common extensions
            for ext in ['mp4', 'm4a', 'webm', 'mkv', 'mov', 'avi']:
                pattern = f"{base_name}.{ext}"
                matches = list(download_dir.glob(pattern))
                possible_files.extend(matches)
            
            # If no exact matches, fall back to generic search (most recent file)
            if not possible_files:
                all_files = list(download_dir.glob("*.mp4")) + list(download_dir.glob("*.m4a")) + list(download_dir.glob("*.webm")) + list(download_dir.glob("*.mkv"))
                if all_files:
                    # Get the most recently created file
                    possible_files = [max(all_files, key=lambda x: x.stat().st_mtime)]
            
            if not possible_files:
                raise HTTPException(status_code=500, detail="Download failed - no files found in directory")
            
            # Use the most recent file if multiple matches
            actual_file = max(possible_files, key=lambda x: x.stat().st_mtime)
            
            # ensure file is completely written before getting size
            try:
                actual_file_size = actual_file.stat().st_size
                if actual_file_size == 0:
                    raise HTTPException(status_code=500, detail="Download failed - file is empty")
            except OSError as e:
                raise HTTPException(status_code=500, detail=f"Download failed - cannot access file: {str(e)}")
            
            return {
                "success": True,
                "filename": actual_file.name,
                "file_path": str(actual_file),
                "file_size": actual_file_size
            }
            
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Combined download failed: {str(e)}")

    async def download_audio(self, request: AudioDownloadRequest, download_dir: Path) -> dict:
        """Download audio-only with optional time range."""
        try:
            info = await extract_video_info_with_fallback(request.url, self.ffmpeg_path, self.deno_path)
            title = sanitize_filename(info.get('title', 'audio'))
            
            # Create unique filename including quality info
            quality = request.format_id.replace('_audio', '').replace('auto_audio', 'auto').replace('high_audio', 'high').replace('medium_audio', 'medium')
            timestamp = int(time.time() * 1000) % 100000
            
            if request.time_range:
                start_str = seconds_to_time_string(request.time_range.start)
                end_str = seconds_to_time_string(request.time_range.end)
                final_filename = f"{title}_audio_{quality}_trimmed_{start_str}-{end_str}_{timestamp}.%(ext)s".replace(':', '-')
            else:
                final_filename = f"{title}_audio_{quality}_{timestamp}.%(ext)s"
            
            final_path = download_dir / final_filename
            
            # Use yt-dlp audio format selector
            format_string = get_audio_format_selector(request.format_id)
            base_opts = {
                'format': format_string,
                'outtmpl': str(final_path),
            }
            
            base_opts = get_ydl_opts_with_time_range(base_opts, request.time_range, request.precise_cut)
            
            await download_with_fallback(request.url, base_opts, self.ffmpeg_path, self.deno_path)
            
            # More robust file detection - check for files with the expected base name
            base_name = final_filename.replace('.%(ext)s', '')
            possible_files = []
            
            # Look for files with the exact base name and common extensions
            for ext in ['m4a', 'mp3', 'webm', 'ogg', 'wav', 'aac']:
                pattern = f"{base_name}.{ext}"
                matches = list(download_dir.glob(pattern))
                possible_files.extend(matches)
            
            # If no exact matches, fall back to generic search (most recent file)
            if not possible_files:
                all_files = list(download_dir.glob("*.m4a")) + list(download_dir.glob("*.mp3")) + list(download_dir.glob("*.webm")) + list(download_dir.glob("*.ogg"))
                if all_files:
                    # Get the most recently created file
                    possible_files = [max(all_files, key=lambda x: x.stat().st_mtime)]
            
            if not possible_files:
                raise HTTPException(status_code=500, detail="Download failed - no audio files found in directory")
            
            # Use the most recent file if multiple matches
            actual_file = max(possible_files, key=lambda x: x.stat().st_mtime)
            
            # ensure file is completely written before getting size
            try:
                actual_file_size = actual_file.stat().st_size
                if actual_file_size == 0:
                    raise HTTPException(status_code=500, detail="Download failed - file is empty")
            except OSError as e:
                raise HTTPException(status_code=500, detail=f"Download failed - cannot access file: {str(e)}")
            
            return {
                "success": True,
                "filename": actual_file.name,
                "file_path": str(actual_file),
                "file_size": actual_file_size
            }
            
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Audio download failed: {str(e)}")

    async def get_playlist_info(self, request: PlaylistInfoRequest, download_dir: Path) -> PlaylistInfoResponse:
        """Get playlist information with video list."""
        try:
            # Extract playlist info
            info = await extract_playlist_info_with_fallback(
                request.url, 
                request.max_videos, 
                request.include_formats,
                self.ffmpeg_path,
                self.deno_path,
                self.cookie_manager
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
            
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to get playlist info: {str(e)}")

    async def download_playlist(self, request: PlaylistDownloadRequest, download_dir: Path, background_tasks: BackgroundTasks) -> FileResponse:
        """Download selected videos from playlist."""
        download_id = str(uuid.uuid4())
        batch_dir = download_dir / f"playlist_{download_id}"
        
        try:
            # First, get playlist info to validate selected videos
            playlist_info = await extract_playlist_info_with_fallback(
                request.url, 
                max_videos=100,
                ffmpeg_path=self.ffmpeg_path,
                deno_path=self.deno_path,
                cookie_manager=self.cookie_manager
            )
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
                        format_string = get_format_selector(request.video_format_id, request.audio_format_id)
                        file_ext = "mp4"
                    else:
                        format_string = get_audio_format_selector(request.audio_format_id)
                        file_ext = "m4a"
                    
                    safe_video_title = re.sub(r'[^\w\s-]', '', video_title)[:100]
                    output_filename = f"{video_index:03d}_{safe_video_title}"
                    output_path = batch_dir / f"{output_filename}.%(ext)s"
                    
                    base_opts = {
                        'outtmpl': str(output_path),
                        'merge_output_format': file_ext,
                        'restrictfilenames': True,
                    }
                    
                    # Only add format if not using yt-dlp default (auto)
                    if format_string is not None:
                        base_opts['format'] = format_string
                    
                    await download_with_fallback(video_url, base_opts, self.ffmpeg_path, self.deno_path)
                    
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
            
        except HTTPException:
            raise
        except Exception as e:
            try:
                if batch_dir.exists():
                    for file in batch_dir.glob("*"):
                        file.unlink()
                    batch_dir.rmdir()
            except:
                pass
            raise HTTPException(status_code=500, detail=f"Playlist download failed: {str(e)}")
