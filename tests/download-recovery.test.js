const { EventEmitter } = require("events")
const { DownloadRunner } = require("../src/main/services/download-runner")
const { mapError } = require("../src/main/services/ytdlp-engine")

function handle() {
  const result = new EventEmitter()
  result.promise = new Promise((resolve, reject) => {
    result.resolve = resolve
    result.reject = reject
  })
  result.cancel = jest.fn(() => true)
  return result
}

const request = { downloadId: "clip", type: "combined", trimmed: true }
const networkError = () => mapError({ stderrLines: [
  "[tls @ 123] Failed to read handshake response",
  "ERROR: ffmpeg exited with code 4294957242"
] })
const saved = { filePath: "/downloads/clip.mp4" }

let runner, events, tracked
beforeEach(() => {
  jest.useFakeTimers()
  events = []
  tracked = []
  runner = new DownloadRunner({
    engine: {}, maxConcurrent: 1,
    sendEvent: (id, event) => events.push({ id, ...event }),
    trackEvent: (name) => tracked.push(name)
  })
})
afterEach(() => jest.useRealTimers())

// Flush asynchronous handle creation without advancing the retry clock.
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test("a trim transport failure gets one fresh operation and one terminal outcome", async () => {
  const first = handle(), second = handle()
  const createHandle = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
  const running = runner.run({ ...request, createHandle })
  await flush()
  first.reject(networkError())
  await flush()
  expect(createHandle).toHaveBeenCalledTimes(1)
  expect(events.filter((event) => event.status === "failed")).toHaveLength(0)
  await jest.advanceTimersByTimeAsync(1500)
  expect(createHandle).toHaveBeenCalledTimes(2)
  second.resolve(saved)
  expect((await running).success).toBe(true)
  expect(tracked).toEqual(["download_completed"])
  expect(runner.size).toBe(0)
  expect(jest.getTimerCount()).toBe(0)
})

test("the retry cannot take a second slot or jump a queued download ahead", async () => {
  const first = handle(), retry = handle(), queued = handle()
  const createHandle = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(retry)
  const createQueued = jest.fn(() => queued)
  const a = runner.run({ ...request, createHandle })
  const b = runner.run({ ...request, downloadId: "queued", createHandle: createQueued })
  await flush()
  first.reject(networkError())
  await jest.advanceTimersByTimeAsync(1500)
  expect(runner.running).toBe(1)
  expect(createQueued).not.toHaveBeenCalled()
  retry.reject(networkError())
  expect((await a).success).toBe(false)
  await flush()
  expect(createHandle).toHaveBeenCalledTimes(2)
  expect(createQueued).toHaveBeenCalledTimes(1)
  queued.resolve(saved)
  await b
  expect(runner.running).toBe(0)
  expect(events.filter((event) => event.id === "clip" && event.status === "failed")).toHaveLength(1)
})

test.each(["cancel", "quit"])("%s during the delay prevents another process", async (action) => {
  const first = handle()
  const createHandle = jest.fn(() => first)
  const running = runner.run({ ...request, createHandle })
  await flush()
  first.reject(networkError())
  await flush()
  if (action === "quit") {
    runner.freeze()
    runner.cancelAll()
  } else runner.cancel("clip")
  expect((await running).cancelled).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
  await jest.advanceTimersByTimeAsync(2000)
  expect(createHandle).toHaveBeenCalledTimes(1)
  expect(tracked).toEqual(["download_cancelled"])
})

test("a cancel racing the failure does not even schedule a retry", async () => {
  const first = handle()
  const running = runner.run({ ...request, createHandle: () => first })
  await flush()
  first.reject(networkError())
  runner.cancel("clip")
  expect((await running).cancelled).toBe(true)
  expect(jest.getTimerCount()).toBe(0)
})

test("a network retry cannot then trigger another repair attempt", async () => {
  const first = handle(), second = handle()
  runner.updater = { updateNow: jest.fn() }
  const createHandle = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
  const running = runner.run({ ...request, createHandle })
  await flush()
  first.reject(networkError())
  await jest.advanceTimersByTimeAsync(1500)
  second.reject(mapError({ stderrLines: ["HTTP Error 403: Forbidden"] }))
  expect((await running).success).toBe(false)
  expect(runner.updater.updateNow).not.toHaveBeenCalled()
  expect(createHandle).toHaveBeenCalledTimes(2)
})

test("a rejected repair is reported while preserving the original download failure", async () => {
  const first = handle()
  const error = mapError({ stderrLines: ["HTTP Error 403: Forbidden"] })
  runner.updater = { updateNow: jest.fn(async () => { throw new Error("spawn EACCES") }) }
  runner.reportEngineUpdate = jest.fn()
  const running = runner.run({ ...request, createHandle: () => first })
  await flush()
  first.reject(error)
  expect((await running).error).toBe(error)
  expect(runner.reportEngineUpdate).toHaveBeenCalledWith({
    updated: false, reason: "check-rejected", error: "spawn EACCES"
  })
})

test.each([
  ["full download", false, networkError()],
  ["rate limit", true, mapError({ stderrLines: ["HTTP Error 429: Too Many Requests"] })],
  ["processing error", true, mapError({ stderrLines: ["ERROR: ffmpeg exited with code 1"] })],
  ["disk full", true, mapError({ stderrLines: ["No space left on device"] })]
])("does not add retries for %s", async (_name, trimmed, error) => {
  const first = handle()
  const createHandle = jest.fn(() => first)
  const running = runner.run({ ...request, trimmed, createHandle })
  await flush()
  first.reject(error)
  expect((await running).success).toBe(false)
  expect(createHandle).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

test.each([true, false])("403 recovery retries only when a newer engine lands (%s)", async (updated) => {
  const log = jest.spyOn(console, "log").mockImplementation(() => {})
  runner.updater = { updateNow: jest.fn(async () => ({ updated, from: "old", to: "new" })) }
  runner.reportEngineUpdate = jest.fn()
  const first = handle(), second = handle()
  const createHandle = jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
  const running = runner.run({ ...request, createHandle })
  await flush()
  first.reject(mapError({ stderrLines: ["HTTP Error 403: Forbidden"] }))
  await flush()
  if (updated) second.resolve(saved)
  expect((await running).success).toBe(updated)
  expect(createHandle).toHaveBeenCalledTimes(updated ? 2 : 1)
  expect(runner.updater.updateNow).toHaveBeenCalledTimes(1)
  expect(runner.reportEngineUpdate).toHaveBeenCalledWith({ updated, from: "old", to: "new" })
  log.mockRestore()
})
