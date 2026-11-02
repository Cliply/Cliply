// Stable, path-free errors. Helper stderr and source names never become telemetry.
const MESSAGES = {
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
