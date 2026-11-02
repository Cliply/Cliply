// Stable, path-free errors. Helper stderr and source names never become telemetry.
const MESSAGES = {
  AUDIO_UNSUPPORTED: "No verified audio extraction profile is available for this track. Choose AAC-LC, MP3 or 16-bit little-endian PCM, mono/stereo, with a known duration.",
  OUTPUT_PATH: "Choose a local output folder and the displayed file extension.",
  OUTPUT_EXISTS: "That output already exists. Choose a different name; existing files are never replaced.",
  OUTPUT_SPACE: "The destination is out of space. Free space or choose another folder.",
  OUTPUT_INVALID: "The extracted audio failed validation. No final file was published.",
  OUTPUT_CHANGED: "The completed file changed or moved. Locate it in its destination folder.",
  EXPORT_BUSY: "A local export or destination selection is active. Finish or cancel it before changing the source.",
  EXPORT_FAILED: "Audio extraction failed. Check the helpers, source and destination permissions, then try again.",
  EXPORT_CANCELLED: "Audio extraction was cancelled.",
  EXPORT_TIMEOUT: "Audio extraction exceeded its time limit.",
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
