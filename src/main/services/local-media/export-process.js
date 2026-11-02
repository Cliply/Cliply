const { spawn } = require("node:child_process")
const path = require("node:path")
const { MediaError } = require("./errors")

// The tiny worker also drains FFmpeg if this application's IPC endpoint dies.
function startExportProcess(executable, args, { inputFd, outputFd, onProgress = () => {},
  spawnProcess = spawn, timeoutMs = 6 * 60 * 60 * 1000, killGraceMs = 500, drainMs = 2000 } = {}) {
  let child, ended = false, settled = false, failure, timer, escalation, drainTimer
  let resolveResult, rejectResult, resolveClosed
  let line = "", tail = ""
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const settle = error => {
    if (settled) return
    settled = true
    if (error) rejectResult(error)
    else resolveResult()
  }
  const stop = (code = "EXPORT_CANCELLED") => {
    if (ended || failure) return
    failure = new MediaError(code)
    try { child.send({ cancel: true }, () => {}) } catch { /* await close or report a stuck writer */ }
    escalation = setTimeout(() => { try { child.send({ cancel: true, force: true }, () => {}) } catch { /* wait */ } }, killGraceMs)
    drainTimer = setTimeout(() => settle(new MediaError("EXPORT_STUCK")), killGraceMs + drainMs)
  }
  const finish = code => {
    if (ended) return
    ended = true
    clearTimeout(timer); clearTimeout(escalation); clearTimeout(drainTimer)
    settle(failure || (code === 0 ? null : new MediaError(/No space left/i.test(tail) ? "OUTPUT_SPACE" : "EXPORT_FAILED")))
    resolveClosed()
  }
  try {
    child = spawnProcess(process.execPath, [path.join(__dirname, "export-worker.js"), executable, JSON.stringify(args)], {
      shell: false, windowsHide: true, stdio: [inputFd, outputFd, "pipe", "ipc"],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")), ELECTRON_RUN_AS_NODE: "1" } })
    child.stderr.on("data", chunk => {
      if (ended || failure) return
      const text = chunk.toString("utf8")
      tail = (tail + text).slice(-16384)
      line += text
      if (line.length > 65536) { stop("EXPORT_FAILED"); return }
      const lines = line.split("\n"); line = lines.pop()
      for (const item of lines) {
        const match = /^out_time_us=(\d+)\r?$/.exec(item)
        if (match && Number.isSafeInteger(Number(match[1]))) onProgress(Number(match[1]) / 1000000)
      }
    })
    child.on("error", () => { if (!child.pid) { failure = new MediaError("EXPORT_FAILED"); finish(null) } else stop("EXPORT_FAILED") })
    child.once("close", finish)
    timer = setTimeout(() => stop("EXPORT_TIMEOUT"), timeoutMs)
  } catch { failure = new MediaError("EXPORT_FAILED"); finish(null) }
  return { result, closed, cancel: () => stop(), get ended() { return ended } }
}

module.exports = { startExportProcess }
