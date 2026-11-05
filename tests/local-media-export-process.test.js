const { EventEmitter } = require("node:events")
const { startExportProcess } = require("../src/main/services/local-media/export-process")

function setup(options = {}) {
  const child = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 42; child.send = jest.fn()
  const spawnProcess = jest.fn(() => child), onProgress = jest.fn()
  const process = startExportProcess("/verified/ffmpeg", ["-c", "copy"], { inputFd: 17, outputFd: 18, spawnProcess, onProgress, ...options })
  return { child, spawnProcess, onProgress, process }
}
afterEach(() => jest.useRealTimers())
test("inherits only main-owned file descriptors and uses embedded Node with a parent-liveness channel", async () => {
  const previous = process.env.FfRePoRt; process.env.FfRePoRt = "file=/private/report"
  try {
    const s = setup()
    const [executable, args, options] = s.spawnProcess.mock.calls[0]
    expect(executable).toBe(process.execPath)
    expect(args[0]).toMatch(/export-worker\.js$/)
    expect(args.slice(1)).toEqual(["/verified/ffmpeg", '["-c","copy"]'])
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: [17, 18, "pipe", "ipc"] })
    expect(Object.keys(options.env).some(key => key.toUpperCase() === "FFREPORT")).toBe(false)
    s.child.emit("close", 0); await s.process.result
  } finally { if (previous === undefined) delete process.env.FfRePoRt; else process.env.FfRePoRt = previous }
})
test("machine progress tolerates split lines and ignores diagnostics/late events", async () => {
  const s = setup()
  s.child.stderr.emit("data", Buffer.from("private source error\nout_time_"))
  s.child.stderr.emit("data", Buffer.from("us=1234567\nprogress=continue\n"))
  expect(s.onProgress).toHaveBeenCalledWith(1.234567)
  s.child.emit("close", 0); await s.process.result
  s.child.stderr.emit("data", Buffer.from("out_time_us=5000000\n"))
  expect(s.onProgress).toHaveBeenCalledTimes(1)
})
test("duplicate cancellation escalates the supervised helper but does not call a live writer finished", async () => {
  jest.useFakeTimers()
  const s = setup({ killGraceMs: 10, drainMs: 20 })
  const check = expect(s.process.result).rejects.toMatchObject({ code: "EXPORT_STUCK" })
  s.process.cancel(); s.process.cancel()
  await jest.advanceTimersByTimeAsync(31); await check
  expect(s.child.send.mock.calls.map(call => call[0])).toEqual([{ cancel: true }, { cancel: true, force: true }])
  expect(s.process.ended).toBe(false)
  s.child.emit("close", 1); await s.process.closed
  expect(s.process.ended).toBe(true)
})
test("timeout followed by native close produces one path-free failure", async () => {
  jest.useFakeTimers()
  const s = setup({ timeoutMs: 20 })
  const check = expect(s.process.result).rejects.toMatchObject({ code: "EXPORT_TIMEOUT" })
  await jest.advanceTimersByTimeAsync(21)
  s.child.emit("close", 1); await check
})
test("overlong diagnostics cause bounded cancellation; disk-full errors have an actionable code", async () => {
  const s = setup()
  s.child.stderr.emit("data", Buffer.alloc(65537, 65))
  expect(s.child.send).toHaveBeenCalled()
  s.child.emit("close", 1)
  await expect(s.process.result).rejects.toMatchObject({ code: "EXPORT_FAILED" })
  const disk = setup(); disk.child.stderr.emit("data", Buffer.from("/private/output: No space left on device\n")); disk.child.emit("close", 1)
  await expect(disk.process.result).rejects.toMatchObject({ code: "OUTPUT_SPACE" })
})
