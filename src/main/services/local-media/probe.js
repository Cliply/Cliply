const { spawn } = require("node:child_process")
const { MediaError } = require("./errors")

const MAX_OUTPUT = 1024 * 1024
const MAX_STDERR = 64 * 1024
const MAX_STREAMS = 128
const MAX_CHAPTERS = 512

// Deliberately exclude playlists, concat, image sequences and other demuxers
// that can open referenced files. MOV external data references stay disabled.
function probeArgs(sourcePath) {
  return [
    "-hide_banner", "-v", "error", "-max_alloc", "67108864",
    "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,wav,mp3,aac",
    "-enable_drefs", "0", "-use_absolute_path", "0",
    "-probesize", "5000000", "-analyzeduration", "5000000", "-max_streams", String(MAX_STREAMS),
    "-of", "json", "-show_format", "-show_streams", "-show_chapters", "-i", sourcePath
  ]
}

// A single ffprobe does not spawn helpers. Keep the slot until actual close,
// including after a failed drain; never call a killed-but-not-exited child done.
function startProbe(executable, sourcePath, {
  spawnProcess = spawn, timeoutMs = 30000, killGraceMs = 500, drainMs = 2000,
  maxOutput = MAX_OUTPUT, maxStderr = MAX_STDERR
} = {}) {
  let child
  let failure
  let settled = false
  let ended = false
  let timer, escalation, drainTimer
  let resolveClosed, resolveResult, rejectResult
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const chunks = []
  let bytes = 0, stderrBytes = 0
  const settle = (error, value) => {
    if (settled) return
    settled = true
    if (error) rejectResult(error)
    else resolveResult(value)
  }
  const stop = (code = "CANCELLED") => {
    if (ended || failure) return
    failure = new MediaError(code)
    try { child.kill("SIGTERM") } catch { /* still escalate and await close */ }
    escalation = setTimeout(() => {
      try { child.kill("SIGKILL") } catch { /* the drain remains pending */ }
    }, killGraceMs)
    drainTimer = setTimeout(() => settle(new MediaError("PROBE_STUCK")), killGraceMs + drainMs)
  }
  const finish = (code) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    clearTimeout(escalation)
    clearTimeout(drainTimer)
    if (failure) settle(failure)
    else if (code !== 0) settle(new MediaError("PROBE_FAILED"))
    else {
      try { settle(null, normalizeProbe(JSON.parse(Buffer.concat(chunks).toString("utf8")))) }
      catch (error) { settle(error instanceof MediaError ? error : new MediaError("PROBE_JSON")) }
    }
    resolveClosed()
  }
  try {
    child = spawnProcess(executable, probeArgs(sourcePath), {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      // Windows environment names are case-insensitive. No spelling of
      // FFREPORT may make this read-only inspection write a report file.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT"))
    })
    child.stdout.on("data", (chunk) => {
      if (failure || ended) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxOutput) stop("PROBE_LIMIT")
      else chunks.push(Buffer.from(chunk))
    })
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > maxStderr) stop("PROBE_LIMIT")
    })
    child.on("error", (error) => {
      if (!child.pid) {
        failure = new MediaError(error.code === "ENOENT" || error.code === "EACCES" ? "PROBE_MISSING" : "PROBE_FAILED")
        finish(null)
      } else stop("PROBE_FAILED")
    })
    child.once("close", finish)
    timer = setTimeout(() => stop("PROBE_TIMEOUT"), timeoutMs)
  } catch {
    failure = new MediaError("PROBE_FAILED")
    finish(null)
  }
  return { result, closed, cancel: () => stop(), get ended() { return ended } }
}

function finite(value, minimum = -Infinity) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum ? number : null
}

function text(value, limit = 256) {
  // Strip metadata control characters before exposing display text.
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit) : null
}

function rational(value) {
  if (typeof value !== "string" || !/^-?\d+\/[1-9]\d*$/.test(value) || value.length > 64) return null
  const [a, b] = value.split("/").map(Number)
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? value : null
}

function tags(raw, keys) {
  const entries = Object.entries(raw || {})
  return Object.fromEntries(keys.flatMap(key => {
    const value = text(entries.find(([name]) => name.toLowerCase() === key)?.[1], 1024)
    return value === null ? [] : [[key, value]]
  }))
}

function normalizeProbe(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.format || typeof raw.format !== "object" || Array.isArray(raw.format) ||
      !Array.isArray(raw.streams) || raw.streams.length === 0 ||
      (raw.chapters !== undefined && !Array.isArray(raw.chapters))) throw new MediaError("PROBE_JSON")
  if (raw.streams.length > MAX_STREAMS || (raw.chapters?.length || 0) > MAX_CHAPTERS) throw new MediaError("PROBE_LIMIT")
  const ids = new Set()
  const streams = raw.streams.map((stream) => {
    if (!stream || !Number.isSafeInteger(stream.index) || stream.index < 0 || ids.has(stream.index)) throw new MediaError("PROBE_JSON")
    ids.add(stream.index)
    const disposition = Object.fromEntries(Object.entries(stream.disposition || {})
      .filter(([key, value]) => /^[a-z_]{1,40}$/.test(key) && (value === 0 || value === 1)).slice(0, 32))
    const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
    return {
      index: stream.index, type: text(stream.codec_type, 40) || "unknown", codec: text(stream.codec_name, 80), profile: text(stream.profile, 80),
      duration: finite(stream.duration, 0), startTime: finite(stream.start_time), timeBase: rational(stream.time_base),
      width: finite(stream.width, 0), height: finite(stream.height, 0), pixelFormat: text(stream.pix_fmt, 80),
      sampleRate: finite(stream.sample_rate, 0), channels: finite(stream.channels, 0),
      averageFrameRate: rational(stream.avg_frame_rate),
      language: text(stream.tags?.language, 80), title: text(stream.tags?.title ?? stream.tags?.name), disposition,
      titleCopySafe: (stream.tags?.title ?? stream.tags?.name) == null || text(stream.tags?.title ?? stream.tags?.name) === (stream.tags?.title ?? stream.tags?.name),
      tags: tags(stream.tags, ["handler_name"]),
      colorTransfer: text(stream.color_transfer, 40), colorPrimaries: text(stream.color_primaries, 40),
      hasHdrMetadata: sideData.some(item => /Mastering display|Content light|HDR Dynamic|DOVI/.test(item?.side_data_type || "")),
      rotation: finite(sideData.find((item) => item?.rotation !== undefined)?.rotation ?? stream.tags?.rotate)
    }
  })
  const chapters = (raw.chapters || []).map(chapter => ({
    start: finite(chapter?.start_time, 0), end: finite(chapter?.end_time, 0), title: text(Object.entries(chapter?.tags || {}).find(([key]) => key.toLowerCase() === "title")?.[1])
  }))
  const chaptersCopySafe = chapters.every((chapter, index) => chapter.start !== null && chapter.end !== null &&
    chapter.end > chapter.start && chapter.end <= (finite(raw.format.duration, 0) ?? 0) + 0.25 &&
    (index === 0 || chapter.start >= chapters[index - 1].end) &&
    Object.entries(raw.chapters[index]?.tags || {}).every(([key, value]) => key.toLowerCase() === "title" && value === chapter.title))
  return {
    duration: finite(raw.format.duration, 0), startTime: finite(raw.format.start_time),
    // FFprobe can name a family; never pretend its first label proves MP4/MOV.
    formatNames: (text(raw.format.format_name, 256) || "").split(",").filter(Boolean),
    majorBrand: text(raw.format.tags?.major_brand, 16)?.trim() || null,
    tags: tags(raw.format.tags, ["title", "artist", "comment"]),
    streams, chapterCount: chapters.length, chapters, chaptersCopySafe
  }
}

module.exports = { startProbe, probeArgs, normalizeProbe, MAX_OUTPUT, MAX_STREAMS, MAX_CHAPTERS }
