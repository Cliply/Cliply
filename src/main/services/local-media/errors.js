// Stable, path-free errors. Helper stderr and source names never become telemetry.
const MESSAGES = {
  TRIM_CHAPTERS: "Chapter timing cannot be rewritten for cuts yet. Use Remove tracks to explicitly save a copy without chapters first.",
  TRIM_AUDIO: "This audio format is not supported for cutting yet. AAC-LC and HE-AAC mono/stereo at 44.1 or 48 kHz are supported.",
  TRIM_VIDEO: "Cutting this video codec or HDR format is not implemented yet. H.264 SDR video is supported.",
  TRIM_CONTAINER: "Cutting supports MP4, MOV and compatible MKV video, plus M4A and WAV audio. Try Change format for this container.",
  AUDIO_UNSUPPORTED: "No verified audio extraction profile is available for this track. Choose AAC-LC, MP3 or 16-bit little-endian PCM, mono/stereo, with a known duration.",
  TRIM_OVERLAP: "Keyframe adjustments overlap two sections. Move their boundaries farther apart and review again.",
  TRIM_PROFILE: "This track metadata or layout cannot be preserved by cutting yet. Inspect the tracks or use a full-file tool.",
  TRIM_STREAMS: "Cutting supports one video and up to 16 audio tracks. Use Remove tracks to explicitly save a copy without subtitles or other extra tracks first.",
  TRIM_TIMING: "This file has missing, delayed or ambiguous timing outside the verified fast-cut profile.",
  TRIM_RANGE: "Choose an ordered range of at least 0.1 seconds within the file. The planned keyframe must be before the end.",
  TRIM_KEYFRAME: "No usable keyframe was found within the bounded search. Adjust the start or choose the other keyframe direction.",
  TRIM_PREVIEW: "Play or audition this source in native preview before planning and saving a clip.",
  REMUX_SOURCE: "Container changes need a verified MP4, MOV or Matroska source.",
  REMUX_TARGET: "Choose a different supported target: MP4, MOV or MKV.",
  REMUX_CHAPTERS: "Chapter preservation is verified only for compatible MKV output. Explicitly remove chapters or choose a supported target.",
  REMUX_TIMING: "This file has unknown or delayed track timing outside the verified container-change profile.",
  TRACK_CONTAINER: "Track removal needs a verified MP4, MOV or MKV file with known duration. For audio-only files, try Extract audio.",
  TRACK_EMPTY: "Keep at least one playable video or audio track.",
  TRACK_UNSUPPORTED: "A retained track has an unverified codec, metadata or disposition. Explicitly remove it to continue; no conversion is performed.",
  TRACK_VIDEO_LIMIT: "Keep at most one video track for this copy.",
  TRACK_CHAPTERS: "Confirm removal of chapters before saving this copy. Chapter preservation is not available for this operation.",
  TRACK_DEFAULT: "This container would change a retained track's default flag. Keep the default track of that type too, or use Extract audio.",
  OUTPUT_PATH: "Choose a local output folder and the displayed file extension.",
  OUTPUT_EXISTS: "That output already exists. Choose a different name; existing files are never replaced.",
  OUTPUT_SPACE: "The destination is out of space. Free space or choose another folder.",
  OUTPUT_INVALID: "The exported file failed validation. No final file was published.",
  OUTPUT_CHANGED: "The completed file changed or moved. Locate it in its destination folder.",
  EXPORT_BUSY: "A local export or destination selection is active. Finish or cancel it before changing the source.",
  EXPORT_FAILED: "Local export failed. Check the helpers, source and destination permissions, then try again.",
  EXPORT_CANCELLED: "Local export was cancelled.",
  EXPORT_TIMEOUT: "Local export exceeded its time limit.",
  EXPORT_STUCK: "A local helper has not stopped. Wait and try again; installation and shutdown are blocked while it writes.",
  EXPORT_CLEANUP: "An owned partial could not be safely cleaned. Check the destination before retrying; unrelated files will not be removed.",
  EXPORT_INTERRUPTED: "The previous export was interrupted. Its owned partial was cleaned. Check the destination for any already completed output.",
  PLAN_EXPIRED: "This export plan is no longer current. Choose the destination again.",
  JOB_UNKNOWN: "This local export is no longer available.",
  PREVIEW_HOST: "Local preview requires a secure application window.",
  PREVIEW_UNAVAILABLE: "Native preview is unavailable for this file.",
  PROBE_MISSING: "Local inspection needs FFprobe. This build does not include it; downloads are still available.",
  PROBE_FAILED: "This file could not be inspected. Choose a self-contained MP4, MOV, MKV, WAV, MP3 or AAC file.",
  PROBE_JSON: "FFprobe returned invalid media information.",
  PROBE_LIMIT: "This file returned more media information than the inspection limit allows.",
  PROBE_TIMEOUT: "Local file inspection timed out.",
  PROBE_STUCK: "FFprobe did not stop. Local inspection remains busy until the process exits.",
  CANCELLED: "Local file inspection was cancelled.",
  BUSY: "Another local file inspection is still active. Close it or wait for it to finish.",
  CLOSED: "Local inspection is shutting down.",
  SOURCE_INVALID: "Choose one regular local file, not a device, network URL or shared network path.",
  SOURCE_CHANGED: "The source changed or is no longer accessible. Open it again to inspect it.",
  SOURCE_UNKNOWN: "This source is no longer open. Open the file again.",
  FORBIDDEN: "Local inspection is only available from the application window.",
  REQUEST_INVALID: "Invalid local inspection request."
}

class MediaError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.PROBE_FAILED)
    this.code = code
  }
}

module.exports = { MediaError }
