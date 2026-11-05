// Runs under the app's embedded Node, never a separately installed runtime.
// The IPC channel is a parent-liveness guard: even a hard application crash
// closes it, and this small supervisor kills/drains its one FFmpeg child.
const { spawn } = require("node:child_process")
let child, timer, stopping = false
function stop(force = false) {
  if (!child) { stopping = true; return }
  if (force) { try { child.kill("SIGKILL") } catch { /* wait for close */ } return }
  if (stopping) return
  stopping = true
  try { child.kill("SIGTERM") } catch { /* escalate */ }
  timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* wait */ } }, 500)
}
process.on("disconnect", () => stop())
process.on("SIGTERM", () => stop())
process.on("message", message => { if (message?.cancel) stop(Boolean(message.force)) })
try {
  child = spawn(process.argv[2], JSON.parse(process.argv[3]), { shell: false, windowsHide: true, stdio: [0, 1, 2] })
  if (process.connected) process.send({ helperPid: child.pid }, () => {})
  child.once("error", () => { if (!child.pid) process.exit(1); else stop() })
  child.once("close", code => { clearTimeout(timer); process.exit(Number.isInteger(code) && code >= 0 ? code : 1) })
  if (!process.connected || stopping) { stopping = false; stop() }
} catch { process.exit(1) }
