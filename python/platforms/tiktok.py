"""tiktok download service."""

import os
import re
import asyncio
import uuid
import time
from pathlib import Path
from typing import Optional

import yt_dlp
from pydantic import BaseModel, field_validator
from fastapi import HTTPException

from shared_utils import (
    executor,
    sanitize_filename,
    format_duration,
    FFmpegLogger,
    format_download_error,
)


# =============================================================================
# pydantic models
# =============================================================================

class TikTokVideoInfoRequest(BaseModel):
    url: str

    @field_validator('url')
    @classmethod
    def validate_tiktok_url(cls, v):
        tiktok_patterns = [
            r'https?://(?:www\.)?tiktok\.com/@[\w.-]+/video/\d+',
            r'https?://vm\.tiktok\.com/[\w-]+',
            r'https?://vt\.tiktok\.com/[\w-]+',
            r'https?://(?:www\.)?tiktok\.com/t/[\w-]+',
            r'https?://(?:www\.)?tiktok\.com/embed/\d+'
        ]
        if not any(re.match(pattern, v) for pattern in tiktok_patterns):
            raise ValueError(
                'Invalid TikTok URL. Please use a tiktok.com/@user/video/ID, '
                'vm.tiktok.com, or vt.tiktok.com URL'
            )
        return v


class TikTokVideoInfoResponse(BaseModel):
    title: str
    duration: int
    duration_string: str
    thumbnail: Optional[str]
    uploader: str


class TikTokDownloadRequest(BaseModel):
    url: str
    format_id: Optional[str] = None


# =============================================================================
# async wrappers
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
# helper functions
# =============================================================================

def get_tiktok_ydl_opts(base_opts: dict = None, ffmpeg_path: Optional[str] = None, deno_path: Optional[str] = None) -> dict:
    if base_opts is None:
        base_opts = {}

    # 'b' selects the best pre-merged file — yt-dlp's preference scoring places
    # the non-watermarked play_addr streams above the watermarked download_addr (-2 pref),
    # so this reliably avoids watermarks without extra format selector logic.
    # X-Forwarded-For: US IP normalises format availability; non-US regions sometimes
    # only get a single low-quality format from the TikTok CDN.
    tiktok_opts = {
        'quiet': True,
        'no_warnings': True,
        'retries': 2,
        'extractor_retries': 2,
        'fragment_retries': 3,
        'format': 'b',
        'http_headers': {
            'X-Forwarded-For': '8.8.8.8'
        },
        'extractor_args': {
            'tiktok': {
                'api_hostname': ['api22-normal-v4.tiktokv.com']
            }
        }
    }

    if ffmpeg_path:
        tiktok_opts['ffmpeg_location'] = ffmpeg_path

    if deno_path:
        tiktok_opts['js_runtimes'] = {'deno': {'path': deno_path}}

    tiktok_opts.update(base_opts)
    return tiktok_opts


def _parse_tiktok_error(error_msg: str) -> HTTPException:
    """Map known TikTok/yt-dlp error strings to user-friendly HTTPExceptions."""
    if "404" in error_msg or "Not Found" in error_msg:
        return HTTPException(
            status_code=400,
            detail="TikTok video not found, is private, or has been deleted"
        )
    if "403" in error_msg or "Forbidden" in error_msg:
        return HTTPException(
            status_code=503,
            detail="TikTok is blocking this request. Please try again in a moment."
        )
    if (
        "Unable to extract" in error_msg
        or "webpage video data" in error_msg
        or "JS challenge" in error_msg
        or "CAPTCHA" in error_msg.upper()
    ):
        return HTTPException(
            status_code=503,
            detail="TikTok temporarily blocked this request. Please try again in a moment."
        )
    return None


# =============================================================================
# tiktok service
# =============================================================================

class TikTokService:

    def __init__(self, ffmpeg_path: Optional[str], deno_path: Optional[str]):
        self.ffmpeg_path = ffmpeg_path
        self.deno_path = deno_path
        self.active_downloads = {}

    def _track_download(self, download_id: str, url: str):
        self.active_downloads[download_id] = {
            "type": "video",
            "url": url,
            "started": time.time()
        }

    def _untrack_download(self, download_id: str):
        self.active_downloads.pop(download_id, None)

    def get_active_downloads_count(self) -> int:
        return len(self.active_downloads)

    async def get_video_info(self, request: TikTokVideoInfoRequest, download_dir: Path) -> TikTokVideoInfoResponse:
        try:
            opts = get_tiktok_ydl_opts({}, self.ffmpeg_path, self.deno_path)
            info = await extract_info_async(request.url, opts)

            duration_raw = info.get('duration', 0) or 0
            return TikTokVideoInfoResponse(
                title=info.get('title', 'TikTok Video'),
                duration=int(duration_raw),
                duration_string=format_duration(duration_raw),
                thumbnail=info.get('thumbnail'),
                uploader=info.get('uploader', info.get('channel', info.get('creator', 'Unknown')))
            )

        except HTTPException:
            raise
        except Exception as e:
            error_msg = str(e)
            mapped = _parse_tiktok_error(error_msg)
            if mapped:
                raise mapped
            raise HTTPException(status_code=400, detail=f"Failed to extract TikTok video: {error_msg}")

    async def download_video(self, request: TikTokDownloadRequest, download_dir: Path) -> dict:
        download_id = str(uuid.uuid4())
        self._track_download(download_id, request.url)
        ffmpeg_logger = FFmpegLogger()

        try:
            opts = get_tiktok_ydl_opts({}, self.ffmpeg_path, self.deno_path)
            info = await extract_info_async(request.url, opts)

            title = sanitize_filename(info.get('title', 'tiktok_video'))
            timestamp = int(time.time() * 1000) % 100000

            final_filename = f"{title}_tiktok_{timestamp}.%(ext)s"
            base_opts = {
                'outtmpl': str(download_dir / final_filename),
                'merge_output_format': 'mp4',
                'logger': ffmpeg_logger,
            }

            download_opts = get_tiktok_ydl_opts(base_opts, self.ffmpeg_path, self.deno_path)
            await download_async(request.url, download_opts)

            base_name = final_filename.replace('.%(ext)s', '')
            extensions = ['mp4', 'webm', 'mkv', 'mov']
            possible_files = []

            for ext in extensions:
                possible_files.extend(list(download_dir.glob(f"{base_name}.{ext}")))

            # fallback: grab most recent video file
            if not possible_files:
                all_files = []
                for ext in extensions:
                    all_files.extend(list(download_dir.glob(f"*.{ext}")))
                if all_files:
                    possible_files = [max(all_files, key=lambda x: x.stat().st_mtime)]

            if not possible_files:
                raise HTTPException(status_code=500, detail="Download failed - no files found in directory")

            actual_file = max(possible_files, key=lambda x: x.stat().st_mtime)

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
            mapped = _parse_tiktok_error(error_msg)
            if mapped:
                raise mapped
            raise HTTPException(
                status_code=500,
                detail=f"TikTok download failed: {format_download_error(e, ffmpeg_logger)}"
            )
        finally:
            self._untrack_download(download_id)
