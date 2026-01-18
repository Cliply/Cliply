"""
Pinterest platform service module.
"""

import os
import re
import asyncio
import uuid
import time
from pathlib import Path
from typing import List, Optional, Union
from datetime import datetime

import yt_dlp
from yt_dlp.utils import download_range_func
from pydantic import BaseModel, field_validator
from fastapi import HTTPException

from shared_utils import (
    executor,
    sanitize_filename,
    format_duration,
    seconds_to_time_string,
    get_downloads_directory
)

# Reuse models from YouTube if possible, or redefine if preferred for isolation
# Given the instructions, I'll redefine them here to keep the module self-contained
# as they are simple and I want to avoid circular imports or heavy dependencies between platform modules

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


class Format(BaseModel):
    format_id: str
    quality: str
    ext: str
    filesize: Optional[int]
    type: str


class PinterestVideoInfoRequest(BaseModel):
    url: str
    
    @field_validator('url')
    @classmethod
    def validate_pinterest_url(cls, v):
        pinterest_patterns = [
            r'https?://(?:www\.)?pinterest\.com/pin/[\w-]+/?',
            r'https?://pin\.it/[\w-]+/?'
        ]
        if not any(re.match(pattern, v) for pattern in pinterest_patterns):
            raise ValueError('Please enter a valid Pinterest URL')
        return v


class PinterestVideoInfoResponse(BaseModel):
    title: str
    duration: int
    duration_string: str
    thumbnail: Optional[str]
    uploader: str
    video_formats: List[Format]
    audio_formats: List[Format]
    is_video: bool


class PinterestDownloadRequest(BaseModel):
    url: str
    video_format_id: str
    audio_format_id: str
    time_range: Optional[TimeRange] = None
    precise_cut: bool = False


class PinterestAudioDownloadRequest(BaseModel):
    url: str
    format_id: str
    time_range: Optional[TimeRange] = None
    precise_cut: bool = False


# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def is_pinterest_video(info: dict) -> bool:
    """Check if pin contains video formats"""
    formats = info.get('formats', [])
    return any(f.get('vcodec') != 'none' for f in formats)


def extract_formats(formats_list: List[dict]) -> tuple[List[Format], List[Format]]:
    """Simplified format extraction for Pinterest"""
    video_formats = [
        Format(format_id="auto", quality="Auto (Recommended)", ext="mp4", filesize=None, type="auto"),
        Format(format_id="best_quality", quality="Best Quality", ext="mp4", filesize=None, type="video"),
        Format(format_id="hd_720p", quality="720p HD", ext="mp4", filesize=None, type="video")
    ]
    audio_formats = [
        Format(format_id="auto_audio", quality="Auto", ext="m4a", filesize=None, type="audio"),
        Format(format_id="high_audio", quality="High Quality", ext="m4a", filesize=None, type="audio"),
        Format(format_id="medium_audio", quality="Medium Quality", ext="m4a", filesize=None, type="audio")
    ]
    return video_formats, audio_formats


def get_format_selector(video_format_id: str, audio_format_id: str) -> Optional[str]:
    """Map format IDs to yt-dlp selectors"""
    if video_format_id == "auto":
        return None
    elif video_format_id == "best_quality":
        return "bestvideo+bestaudio/best"
    elif video_format_id == "hd_720p":
        return "bestvideo[height<=720]+bestaudio"
    else:
        return "bestvideo+bestaudio/best"


def get_audio_format_selector(format_id: str) -> str:
    """Map audio format IDs to yt-dlp selectors"""
    selectors = {
        "auto_audio": "bestaudio",
        "high_audio": "bestaudio",
        "medium_audio": "bestaudio[abr<=128]"
    }
    return selectors.get(format_id, "bestaudio")


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
    
    if ffmpeg_path:
        simple_opts['ffmpeg_location'] = ffmpeg_path
    
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


async def download_with_fallback(url: str, base_opts: dict, ffmpeg_path: Optional[str] = None, deno_path: Optional[str] = None) -> None:
    opts = get_enhanced_ydl_opts(base_opts, ffmpeg_path, deno_path)
    await download_async(url, opts)


async def extract_video_info_with_fallback(url: str, ffmpeg_path: Optional[str] = None, deno_path: Optional[str] = None) -> dict:
    opts = get_enhanced_ydl_opts(None, ffmpeg_path, deno_path)
    return await extract_info_async(url, opts)


# =============================================================================
# PINTEREST SERVICE CLASS
# =============================================================================

class PinterestService:
    """Main service class that encapsulates all Pinterest operations."""
    
    def __init__(self, ffmpeg_path: Optional[str], deno_path: Optional[str]):
        self.ffmpeg_path = ffmpeg_path
        self.deno_path = deno_path
        self.active_downloads = {}

    def _track_download(self, download_id: str, download_type: str, url: str):
        self.active_downloads[download_id] = {
            "type": download_type,
            "url": url,
            "started": time.time()
        }

    def _untrack_download(self, download_id: str):
        self.active_downloads.pop(download_id, None)

    async def get_video_info(self, request: PinterestVideoInfoRequest, download_dir: Path) -> PinterestVideoInfoResponse:
        """Get Pinterest video info with format details."""
        try:
            info = await extract_video_info_with_fallback(request.url, self.ffmpeg_path, self.deno_path)
            
            if not is_pinterest_video(info):
                raise HTTPException(
                    status_code=400, 
                    detail="This Pinterest pin contains an image, not a video"
                )
            
            video_formats, audio_formats = extract_formats(info.get('formats', []))
            
            return PinterestVideoInfoResponse(
                title=info.get('title', 'Pinterest Video'),
                duration=info.get('duration', 0),
                duration_string=format_duration(info.get('duration', 0)),
                thumbnail=info.get('thumbnail'),
                uploader=info.get('uploader', 'Pinterest User'),
                video_formats=video_formats,
                audio_formats=audio_formats,
                is_video=True
            )
            
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to get Pinterest info: {str(e)}")

    async def download_combined(self, request: PinterestDownloadRequest, download_dir: Path) -> dict:
        """Download combined Pinterest video."""
        download_id = str(uuid.uuid4())
        self._track_download(download_id, "combined", request.url)
        try:
            info = await extract_video_info_with_fallback(request.url, self.ffmpeg_path, self.deno_path)
            title = sanitize_filename(info.get('title', 'pinterest_video'))
            timestamp = int(time.time() * 1000) % 100000
            
            final_filename = f"{title}_pinterest_{timestamp}.%(ext)s"
            final_path = download_dir / final_filename
            
            format_string = get_format_selector(request.video_format_id, request.audio_format_id)
            
            base_opts = {
                'outtmpl': str(final_path),
                'merge_output_format': 'mp4',
            }
            
            if format_string:
                base_opts['format'] = format_string
                
            base_opts = get_ydl_opts_with_time_range(base_opts, request.time_range, request.precise_cut)
            
            await download_with_fallback(request.url, base_opts, self.ffmpeg_path, self.deno_path)
            
            # Robust file detection
            base_name = final_filename.replace('.%(ext)s', '')
            possible_files = []
            for ext in ['mp4', 'm4a', 'webm', 'mkv']:
                pattern = f"{base_name}.{ext}"
                matches = list(download_dir.glob(pattern))
                possible_files.extend(matches)
                
            if not possible_files:
                # Fallback to most recent file if no exact match
                all_files = list(download_dir.glob("*.mp4")) + list(download_dir.glob("*.webm"))
                if all_files:
                    possible_files = [max(all_files, key=lambda x: x.stat().st_mtime)]
                    
            if not possible_files:
                raise HTTPException(status_code=500, detail="Download failed - no files found")
                
            actual_file = max(possible_files, key=lambda x: x.stat().st_mtime)
            
            return {
                "success": True,
                "filename": actual_file.name,
                "file_path": str(actual_file),
                "file_size": actual_file.stat().st_size,
                "download_id": download_id
            }
            
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Pinterest download failed: {str(e)}")
        finally:
            self._untrack_download(download_id)

    async def download_audio(self, request: PinterestAudioDownloadRequest, download_dir: Path) -> dict:
        """Download Pinterest audio."""
        download_id = str(uuid.uuid4())
        self._track_download(download_id, "audio", request.url)
        try:
            info = await extract_video_info_with_fallback(request.url, self.ffmpeg_path, self.deno_path)
            title = sanitize_filename(info.get('title', 'pinterest_audio'))
            timestamp = int(time.time() * 1000) % 100000
            
            final_filename = f"{title}_pinterest_audio_{timestamp}.%(ext)s"
            final_path = download_dir / final_filename
            
            format_string = get_audio_format_selector(request.format_id)
            
            base_opts = {
                'format': format_string,
                'outtmpl': str(final_path),
            }
            
            base_opts = get_ydl_opts_with_time_range(base_opts, request.time_range, request.precise_cut)
            
            await download_with_fallback(request.url, base_opts, self.ffmpeg_path, self.deno_path)
            
            # Robust file detection
            base_name = final_filename.replace('.%(ext)s', '')
            possible_files = []
            for ext in ['m4a', 'mp3', 'webm', 'ogg']:
                pattern = f"{base_name}.{ext}"
                matches = list(download_dir.glob(pattern))
                possible_files.extend(matches)
                
            if not possible_files:
                all_files = list(download_dir.glob("*.m4a")) + list(download_dir.glob("*.mp3"))
                if all_files:
                    possible_files = [max(all_files, key=lambda x: x.stat().st_mtime)]
                    
            if not possible_files:
                raise HTTPException(status_code=500, detail="Download failed - no audio files found")
                
            actual_file = max(possible_files, key=lambda x: x.stat().st_mtime)
            
            return {
                "success": True,
                "filename": actual_file.name,
                "file_path": str(actual_file),
                "file_size": actual_file.stat().st_size,
                "download_id": download_id
            }
            
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Pinterest audio download failed: {str(e)}")
        finally:
            self._untrack_download(download_id)
