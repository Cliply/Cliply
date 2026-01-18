"""
Pinterest platform service module.

This module encapsulates all Pinterest-specific functionality including:
- Video pin information extraction
- Video/audio downloads
- Image vs video detection (critical for Pinterest)

Note: Pinterest is simpler than YouTube - no playlists, no authentication required,
and typically 1-2 video quality options.
"""

import os
import re
import asyncio
import uuid
import time
from pathlib import Path
from typing import List, Optional

import yt_dlp
from pydantic import BaseModel, field_validator
from fastapi import HTTPException

from shared_utils import (
    executor,
    sanitize_filename,
    format_duration,
    seconds_to_time_string
)


# =============================================================================
# PYDANTIC MODELS
# =============================================================================

class PinterestVideoInfoRequest(BaseModel):
    url: str
    
    @field_validator('url')
    @classmethod
    def validate_pinterest_url(cls, v):
        # Support both full URLs and short URLs
        pinterest_patterns = [
            r'https?://(?:www\.)?pinterest\.com/pin/[\w-]+',
            r'https?://pin\.it/[\w-]+'
        ]
        if not any(re.match(pattern, v) for pattern in pinterest_patterns):
            raise ValueError('Invalid Pinterest URL. Please use a pinterest.com/pin/[ID] or pin.it/[ID] URL')
        return v


class Format(BaseModel):
    format_id: str
    quality: str
    ext: str
    filesize: Optional[int]
    type: str


class PinterestVideoInfoResponse(BaseModel):
    title: str
    duration: int
    duration_string: str
    thumbnail: Optional[str]
    uploader: str
    video_formats: List[Format]
    audio_formats: List[Format]


class PinterestDownloadRequest(BaseModel):
    url: str
    format_id: str
    download_type: str  # "video" or "audio"
    
    @field_validator('download_type')
    @classmethod
    def validate_download_type(cls, v):
        if v not in ['video', 'audio']:
            raise ValueError('download_type must be "video" or "audio"')
        return v


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
# HELPER FUNCTIONS
# =============================================================================

def is_video_pin(info: dict) -> bool:
    """
    CRITICAL FUNCTION - Check if pin contains video vs image.
    Pinterest has many image pins, and we need to detect video pins specifically.
    """
    formats = info.get('formats', [])
    if not formats:
        return False
    
    # Check if any format has video codec
    return any(
        f.get('vcodec') and f.get('vcodec') != 'none'
        for f in formats
    )


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


def extract_pinterest_formats(info: dict) -> tuple[List[Format], List[Format]]:
    """
    Extract formats from Pinterest video info.
    Pinterest typically has 1-2 quality options, so we keep it simple.
    """
    # Simple format options for Pinterest
    video_formats = [
        Format(format_id="auto", quality="Auto (Best)", ext="mp4", filesize=None, type="auto")
    ]
    
    audio_formats = [
        Format(format_id="auto_audio", quality="Auto", ext="m4a", filesize=None, type="audio")
    ]
    
    return video_formats, audio_formats


# =============================================================================
# PINTEREST SERVICE CLASS
# =============================================================================

class PinterestService:
    """Main service class that encapsulates all Pinterest operations."""
    
    def __init__(self, ffmpeg_path: Optional[str], deno_path: Optional[str]):
        self.ffmpeg_path = ffmpeg_path
        self.deno_path = deno_path
        self.active_downloads = {}
        # Note: No cookie manager needed for Pinterest

    def _track_download(self, download_id: str, download_type: str, url: str):
        """Internal helper to track an active download."""
        self.active_downloads[download_id] = {
            "type": download_type,
            "url": url,
            "started": time.time()
        }

    def _untrack_download(self, download_id: str):
        """Internal helper to remove a completed/failed download from tracking."""
        self.active_downloads.pop(download_id, None)

    def get_active_downloads_count(self) -> int:
        """Expose the number of active downloads."""
        return len(self.active_downloads)

    async def get_video_info(self, request: PinterestVideoInfoRequest, download_dir: Path) -> PinterestVideoInfoResponse:
        """Get Pinterest video information with format details."""
        try:
            base_opts = {}
            opts = get_enhanced_ydl_opts(base_opts, self.ffmpeg_path, self.deno_path)
            
            info = await extract_info_async(request.url, opts)
            
            # Critical check: Is this a video pin or an image pin?
            if not is_video_pin(info):
                raise HTTPException(
                    status_code=400,
                    detail="This Pinterest pin contains an image, not a video. Please use a pin with video content."
                )
            
            video_formats, audio_formats = extract_pinterest_formats(info)
            
            return PinterestVideoInfoResponse(
                title=info.get('title', 'Pinterest Video'),
                duration=info.get('duration', 0) or 0,
                duration_string=format_duration(info.get('duration', 0) or 0),
                thumbnail=info.get('thumbnail'),
                uploader=info.get('uploader', info.get('channel', 'Unknown')),
                video_formats=video_formats,
                audio_formats=audio_formats
            )
            
        except HTTPException:
            raise
        except Exception as e:
            error_msg = str(e)
            
            # Handle 404 errors
            if "404" in error_msg or "Not Found" in error_msg:
                raise HTTPException(
                    status_code=400,
                    detail="Pinterest pin not found, is private, or has been deleted"
                )
            
            # Handle 403 errors
            if "403" in error_msg or "Forbidden" in error_msg:
                raise HTTPException(
                    status_code=503,
                    detail="Pinterest is blocking automated requests. Please try again later."
                )
            
            raise HTTPException(status_code=400, detail=f"Failed to extract Pinterest video: {error_msg}")

    async def download_video(self, request: PinterestDownloadRequest, download_dir: Path) -> dict:
        """Download Pinterest video or audio."""
        download_id = str(uuid.uuid4())
        self._track_download(download_id, request.download_type, request.url)
        
        try:
            # Extract video info to get title
            base_opts = {}
            opts = get_enhanced_ydl_opts(base_opts, self.ffmpeg_path, self.deno_path)
            info = await extract_info_async(request.url, opts)
            
            # Critical check: Is this a video pin?
            if not is_video_pin(info):
                raise HTTPException(
                    status_code=400,
                    detail="This Pinterest pin contains an image, not a video. Pinterest video downloader only works with video pins."
                )
            
            title = sanitize_filename(info.get('title', 'pinterest_video'))
            timestamp = int(time.time() * 1000) % 100000
            
            if request.download_type == "audio":
                final_filename = f"{title}_pinterest_audio_{timestamp}.%(ext)s"
                base_opts = {
                    'outtmpl': str(download_dir / final_filename),
                    'format': 'bestaudio',
                    'postprocessors': [{
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': 'm4a',
                    }]
                }
            else:
                final_filename = f"{title}_pinterest_{timestamp}.%(ext)s"
                base_opts = {
                    'outtmpl': str(download_dir / final_filename),
                    'format': 'bestvideo+bestaudio/best',
                    'merge_output_format': 'mp4'
                }
            
            download_opts = get_enhanced_ydl_opts(base_opts, self.ffmpeg_path, self.deno_path)
            await download_async(request.url, download_opts)
            
            # Find the downloaded file
            base_name = final_filename.replace('.%(ext)s', '')
            possible_files = []
            
            # Check for common video/audio extensions
            extensions = ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'ogg'] if request.download_type == "audio" else ['mp4', 'webm', 'mkv', 'mov']
            
            for ext in extensions:
                pattern = f"{base_name}.{ext}"
                matches = list(download_dir.glob(pattern))
                possible_files.extend(matches)
            
            # Fallback: find most recent file
            if not possible_files:
                all_files = []
                for ext in extensions:
                    all_files.extend(list(download_dir.glob(f"*.{ext}")))
                if all_files:
                    possible_files = [max(all_files, key=lambda x: x.stat().st_mtime)]
            
            if not possible_files:
                raise HTTPException(status_code=500, detail="Download failed - no files found in directory")
            
            actual_file = max(possible_files, key=lambda x: x.stat().st_mtime)
            
            # Verify file exists and is not empty
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
                "file_size": actual_file_size,
                "download_id": download_id
            }
            
        except HTTPException:
            raise
        except Exception as e:
            error_msg = str(e)
            
            # Handle 404 errors
            if "404" in error_msg or "Not Found" in error_msg:
                raise HTTPException(
                    status_code=400,
                    detail="Pinterest pin not found, is private, or has been deleted"
                )
            
            # Handle 403 errors
            if "403" in error_msg or "Forbidden" in error_msg:
                raise HTTPException(
                    status_code=503,
                    detail="Pinterest is blocking automated requests. Please try again later."
                )
            
            raise HTTPException(status_code=500, detail=f"Pinterest download failed: {error_msg}")
        finally:
            self._untrack_download(download_id)
