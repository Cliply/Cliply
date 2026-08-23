// lifecycle tests for the spawned operation - no real yt-dlp involved
// spawn is injected so close/error ordering, cancellation and the watchdog can
// be driven deterministically

const { EventEmitter } = require("events")
const { PassThrough } = require("stream")
const os = require("os")
const path = require("path")

const {
  YtdlpEngine,
  OperationGate,
  ERROR_CODES
} = require("../src/main/services/ytdlp-engine")

// a child process stand-in
class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
    this.signals = []
  }

  kill(signal) {
    this.killed = true
    this.signals.push(signal)
    return true
  }

  say(text) {
    this.stdout.write(text)
  }

  complain(text) {
    this.stderr.write(text)
  }

  exit(code) {
    this.emit("close", code)
  }
}

function createSpawner() {
  const spawnFn = (binary, args, options) => {
    const child = new FakeChild(9000 + spawnFn.children.length)
    spawnFn.calls.push({ binary, args, options })
    spawnFn.children.push(child)
    return child
  }

  spawnFn.calls = []
  spawnFn.children = []
  return spawnFn
}

// let queued microtasks and stream data events run
const settle = () => new Promise((resolve) => setImmediate(resolve))

function createEngine(spawnFn, options = {}) {
  return new YtdlpEngine({
    userDataPath: path.join(os.tmpdir(), "cliply-lifecycle"),
    resourcesPath: path.join(os.tmpdir(), "cliply-lifecycle"),
    ffmpegPath: "/fake/ffmpeg",
    denoPath: "/fake/deno",
    spawnFn,
    ...options
  })
}

const DOWNLOAD = {
  url: "https://www.youtube.com/watch?v=abc",
  height: 720,
  container: "mp4",
  outputDir: "/tmp/downloads",
  outputTemplate: "out.%(ext)s"
}

describe("successful run", () => {
  test("resolves with the destination once the process exits cleanly", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    const child = spawnFn.children[0]
    child.say("CLIPLY_STREAM|136+140\n")
    child.say("CLIPLY| 50.0%|1.00MiB/s|00:10|10\n")
    child.say("CLIPLY_FILE|/tmp/downloads/out.mp4\n")
    await settle()

    child.exit(0)
    const result = await handle.promise

    expect(result.exitCode).toBe(0)
    expect(result.filePath).toBe("/tmp/downloads/out.mp4")
    expect(engine.getActiveCount()).toBe(0)
  })

  test("emits a final 100% progress event", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const events = []
    const handle = engine.downloadCombined(DOWNLOAD)
    handle.on("progress", (update) => events.push(update))
    await settle()

    spawnFn.children[0].say("CLIPLY| 25.0%|1.00MiB/s|00:10|10\n")
    await settle()
    spawnFn.children[0].exit(0)
    await handle.promise

    expect(events[events.length - 1].progress).toBe(100)
    expect(handle.phase).toBe("completed")
  })

  test("splits stdout that arrives in fragments", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const events = []
    const handle = engine.downloadCombined(DOWNLOAD)
    handle.on("progress", (update) => events.push(update))
    await settle()

    const child = spawnFn.children[0]
    child.say("CLIPLY| 10.0%|1.0MiB/s|00:0")
    await settle()
    child.say("1|1\nCLIPLY| 20.0%|1.0MiB/s|00:01|1\n")
    await settle()

    child.exit(0)
    await handle.promise

    expect(events.map((event) => event.streamProgress)).toEqual([10, 20, 100])
  })
})

describe("failure paths", () => {
  test("maps stderr on a non-zero exit", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    spawnFn.children[0].complain("ERROR: [youtube] abc: Private video\n")
    await settle()
    spawnFn.children[0].exit(1)

    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.VIDEO_UNAVAILABLE,
      exitCode: 1
    })
    expect(engine.getActiveCount()).toBe(0)
  })

  test("a spawn error is reported as a missing binary", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    const error = new Error("spawn ENOENT")
    error.code = "ENOENT"
    spawnFn.children[0].emit("error", error)

    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.ENGINE_MISSING
    })
  })

  test("a close arriving after an error does not settle twice", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    const failures = []
    handle.on("failed", (error) => failures.push(error))
    await settle()

    const error = new Error("spawn EACCES")
    error.code = "EACCES"
    spawnFn.children[0].emit("error", error)
    spawnFn.children[0].exit(1)
    await settle()

    await expect(handle.promise).rejects.toBeDefined()
    expect(failures).toHaveLength(1)
  })

  test("a second close after a clean exit is ignored", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    const completions = []
    handle.on("completed", (result) => completions.push(result))
    await settle()

    spawnFn.children[0].exit(0)
    spawnFn.children[0].exit(1)
    await settle()

    await expect(handle.promise).resolves.toBeDefined()
    expect(completions).toHaveLength(1)
  })

  test("stderr is redacted before it reaches the ring buffer", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    spawnFn.children[0].complain(
      "Input from 'https://rr1.googlevideo.com/videoplayback?ip=203.0.113.7&sig=x'\n"
    )
    await settle()
    spawnFn.children[0].exit(1)
    await handle.promise.catch(() => {})

    expect(handle.getStderr()).not.toContain("203.0.113.7")
    expect(handle.getStderr()).toContain("<redacted>")
  })
})

describe("cancellation", () => {
  test("kills the child and rejects as cancelled", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    expect(handle.cancel()).toBe(true)
    expect(spawnFn.children[0].signals).toContain("SIGTERM")

    spawnFn.children[0].exit(null)
    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED
    })
  })

  test("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { killGraceMs: 10 })

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    handle.cancel()
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(spawnFn.children[0].signals).toEqual(["SIGTERM", "SIGKILL"])

    spawnFn.children[0].exit(null)
    await handle.promise.catch(() => {})
  })

  test("cancelling twice only signals once", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    expect(handle.cancel()).toBe(true)
    expect(handle.cancel()).toBe(false)

    spawnFn.children[0].exit(null)
    await handle.promise.catch(() => {})
  })

  test("cancelling before the process ever spawns never spawns it", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    // an update holds the gate, so the download is still queued
    const releaseUpdate = engine.gate.tryAcquireWrite()

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()
    expect(spawnFn.calls).toHaveLength(0)

    expect(handle.cancel()).toBe(true)
    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED
    })

    releaseUpdate()
    await settle()

    expect(spawnFn.calls).toHaveLength(0)
    expect(engine.getActiveCount()).toBe(0)
  })

  test("cancelAll stops every running operation", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const first = engine.downloadCombined(DOWNLOAD)
    const second = engine.downloadCombined(DOWNLOAD)
    await settle()

    expect(engine.cancelAll()).toBe(2)

    spawnFn.children.forEach((child) => child.exit(null))
    await Promise.all([
      first.promise.catch((error) => error.code),
      second.promise.catch((error) => error.code)
    ]).then((codes) => {
      expect(codes).toEqual([ERROR_CODES.CANCELLED, ERROR_CODES.CANCELLED])
    })
  })

  test("uses taskkill to take down the whole tree on windows", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    const original = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32" })

    try {
      handle.cancel()
    } finally {
      Object.defineProperty(process, "platform", original)
    }

    // ffmpeg and deno are grandchildren, so the direct kill is not enough
    const killer = spawnFn.calls[spawnFn.calls.length - 1]
    expect(killer.binary).toBe("taskkill")
    expect(killer.args).toEqual([
      "/pid",
      String(spawnFn.children[0].pid),
      "/T",
      "/F"
    ])

    spawnFn.children[0].exit(null)
    await handle.promise.catch(() => {})
  })

  test("falls back to a direct kill when taskkill exits non-zero", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    const target = spawnFn.children[0]
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32" })

    try {
      handle.cancel()
    } finally {
      Object.defineProperty(process, "platform", original)
    }

    const killer = spawnFn.children[spawnFn.children.length - 1]
    expect(target.signals).not.toContain("SIGKILL")

    // access denied, or the pid was already gone - the child may still be alive
    killer.exit(1)

    expect(target.signals).toContain("SIGKILL")

    target.exit(null)
    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.CANCELLED
    })
  })

  test("does not double-kill when taskkill succeeds", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    const target = spawnFn.children[0]
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32" })

    try {
      handle.cancel()
    } finally {
      Object.defineProperty(process, "platform", original)
    }

    // taskkill reported success, so the tree is already gone
    const killer = spawnFn.children[spawnFn.children.length - 1]
    killer.exit(0)

    expect(target.signals).not.toContain("SIGKILL")

    target.exit(null)
    await handle.promise.catch(() => {})
  })
})

describe("watchdog", () => {
  test("kills a process that goes silent and reports it as stalled", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { watchdogMs: 20, killGraceMs: 10 })

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(spawnFn.children[0].signals).toContain("SIGTERM")

    spawnFn.children[0].exit(null)
    await expect(handle.promise).rejects.toMatchObject({
      code: ERROR_CODES.STALLED
    })
  })

  test("output keeps the watchdog at bay", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { watchdogMs: 60 })

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    for (let index = 0; index < 4; index++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      spawnFn.children[0].say(`CLIPLY| ${index * 10}.0%|1.0MiB/s|00:01|1\n`)
      await settle()
    }

    expect(spawnFn.children[0].killed).toBe(false)

    spawnFn.children[0].exit(0)
    await expect(handle.promise).resolves.toBeDefined()
  })

  test("the timer is cleared on a normal exit", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn, { watchdogMs: 30 })

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    spawnFn.children[0].exit(0)
    await handle.promise

    // long enough that a surviving watchdog would have fired by now
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(spawnFn.children[0].killed).toBe(false)
    expect(handle.watchdog).toBeNull()
    expect(handle.killTimer).toBeNull()
  })
})

describe("update and download interleaving", () => {
  test("a download queues while an update holds the gate, then runs", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const releaseUpdate = engine.gate.tryAcquireWrite()

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    // the binary may be being replaced right now - nothing may spawn yet
    expect(spawnFn.calls).toHaveLength(0)

    releaseUpdate()
    await settle()

    expect(spawnFn.calls).toHaveLength(1)

    spawnFn.children[0].exit(0)
    await handle.promise
  })

  test("an update cannot start once a download holds the gate", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    expect(engine.gate.tryAcquireWrite()).toBeNull()

    spawnFn.children[0].exit(0)
    await handle.promise

    // the gate is free again the moment the download settles
    expect(engine.gate.tryAcquireWrite()).not.toBeNull()
  })

  test("concurrent downloads all run without blocking each other", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handles = [
      engine.downloadCombined(DOWNLOAD),
      engine.downloadCombined(DOWNLOAD),
      engine.downloadSimple({ url: "https://tiktok.com/@a/video/1", outputDir: "/tmp" })
    ]
    await settle()

    expect(spawnFn.calls).toHaveLength(3)
    expect(engine.getActiveCount()).toBe(3)

    spawnFn.children.forEach((child) => child.exit(0))
    await Promise.all(handles.map((handle) => handle.promise))

    expect(engine.getActiveCount()).toBe(0)
  })
})

describe("spawn arguments", () => {
  test("the real binary path and terminated url are what get spawned", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const handle = engine.downloadCombined(DOWNLOAD)
    await settle()

    const { binary, args } = spawnFn.calls[0]

    expect(binary).toBe(engine.getBinaryPath())
    expect(args[args.length - 2]).toBe("--")
    expect(args[args.length - 1]).toBe(DOWNLOAD.url)

    spawnFn.children[0].exit(0)
    await handle.promise
  })

  test("a hostile url is rejected before anything is spawned", () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    expect(() =>
      engine.downloadCombined({ ...DOWNLOAD, url: "--exec=touch /tmp/pwned" })
    ).toThrow(/valid link/)

    expect(spawnFn.calls).toHaveLength(0)
    expect(engine.getActiveCount()).toBe(0)
  })
})

describe("version probe", () => {
  // the probe runs the engine out of a directory the updater may be about to
  // rename or delete, so "the child is gone" is the only safe moment to settle
  test("reports the version once the process closes", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const probe = engine.probeVersion("/fake/yt-dlp")
    await settle()

    const child = spawnFn.children[0]
    expect(spawnFn.calls[0].args).toEqual(["--version"])

    child.say("2026.08.19\n")
    await settle()
    child.exit(0)

    expect(await probe).toBe("2026.08.19")
  })

  test("a timeout kills the probe but waits for it to actually die", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const probe = engine.probeVersion("/fake/yt-dlp", { timeoutMs: 10 })
    await settle()

    const child = spawnFn.children[0]
    let settledEarly = false
    probe.then(() => {
      settledEarly = true
    })

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(child.killed).toBe(true)
    // still running as far as the os is concerned - nothing may clean up yet
    expect(settledEarly).toBe(false)

    child.exit(null)
    expect(await probe).toBeNull()
  })

  test("an abort kills the probe and settles only on close", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)
    const controller = new AbortController()

    const probe = engine.probeVersion("/fake/yt-dlp", { signal: controller.signal })
    await settle()

    const child = spawnFn.children[0]
    let settledEarly = false
    probe.then(() => {
      settledEarly = true
    })

    controller.abort()
    await settle()

    expect(child.killed).toBe(true)
    expect(settledEarly).toBe(false)

    child.exit(null)
    expect(await probe).toBeNull()
  })

  test("a probe killed mid-flight is not trusted even if it exits cleanly", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)
    const controller = new AbortController()

    const probe = engine.probeVersion("/fake/yt-dlp", { signal: controller.signal })
    await settle()

    const child = spawnFn.children[0]
    child.say("2026.08.19\n")
    await settle()

    controller.abort()
    child.exit(0)

    // the answer arrived, but the operation it belonged to was cancelled
    expect(await probe).toBeNull()
  })

  test("an already-aborted signal never lets the probe answer", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)
    const controller = new AbortController()
    controller.abort()

    const probe = engine.probeVersion("/fake/yt-dlp", { signal: controller.signal })
    await settle()

    const child = spawnFn.children[0]
    expect(child.killed).toBe(true)

    child.say("2026.08.19\n")
    await settle()
    child.exit(0)

    expect(await probe).toBeNull()
  })

  test("a signal-delivery error does not settle a probe that is still running", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const probe = engine.probeVersion("/fake/yt-dlp", { timeoutMs: 10 })
    await settle()

    const child = spawnFn.children[0]
    let settledEarly = false
    probe.then(() => {
      settledEarly = true
    })

    await new Promise((resolve) => setTimeout(resolve, 40))

    // node emits this when a signal cannot be delivered to a live child
    child.emit("error", new Error("kill ESRCH"))
    await settle()

    expect(settledEarly).toBe(false)

    child.exit(null)
    expect(await probe).toBeNull()
  })

  test("a spawn that never starts settles immediately", async () => {
    const spawnFn = (binary, args) => {
      const child = new FakeChild(undefined)
      child.pid = undefined
      spawnFn.children.push({ binary, args, child })
      return child
    }
    spawnFn.children = []

    const engine = createEngine(spawnFn)
    const probe = engine.probeVersion("/missing/yt-dlp")
    await settle()

    spawnFn.children[0].child.emit("error", new Error("spawn ENOENT"))

    expect(await probe).toBeNull()
  })

  test("a spawn that throws outright settles too", async () => {
    const engine = createEngine(() => {
      throw new Error("spawn EACCES")
    })

    expect(await engine.probeVersion("/missing/yt-dlp")).toBeNull()
  })
})

// the engine is where the running version lives. the menu and the issue report
// both name it, and neither can await a probe or read it back out of analytics
// - telemetry is something the user can switch off, and an app must not lose
// track of what it is running when they do.
describe("the version the engine knows", () => {
  async function answerProbe(spawnFn, version) {
    await settle()
    const child = spawnFn.children[spawnFn.children.length - 1]
    child.say(`${version}\n`)
    await settle()
    child.exit(0)
  }

  test("knows nothing until somebody has looked", () => {
    expect(createEngine(createSpawner()).getKnownVersion()).toBeNull()
  })

  test("keeps what a probe found", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    const version = engine.getVersion()
    await answerProbe(spawnFn, "2026.08.19")

    expect(await version).toBe("2026.08.19")
    expect(engine.getKnownVersion()).toBe("2026.08.19")
  })

  test("takes an answer somebody else already paid for", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    // the seed and the self-update each run --version on the engine they just
    // installed, and on a cold onedir that first run is the slow one. handing
    // the result over means nothing downstream buys it twice
    engine.rememberVersion("2026.08.19")

    expect(engine.getKnownVersion()).toBe("2026.08.19")
    expect(await engine.getVersion()).toBe("2026.08.19")
    expect(spawnFn.calls).toHaveLength(0)
  })

  test("a probe that found nothing is not an answer to keep", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    engine.rememberVersion("2026.08.19")
    engine.rememberVersion(null)
    engine.rememberVersion(undefined)
    engine.rememberVersion("")

    // a refused seed reports no version at all. recording that would both
    // forget a version we did have and pin "unknown" for the rest of the run,
    // where an empty slot lets the next getVersion() go and ask
    expect(engine.getKnownVersion()).toBe("2026.08.19")
    expect(spawnFn.calls).toHaveLength(0)
  })

  test("forgets it when the engine underneath is replaced", async () => {
    const spawnFn = createSpawner()
    const engine = createEngine(spawnFn)

    engine.rememberVersion("2026.08.19")
    engine.invalidateVersion()

    expect(engine.getKnownVersion()).toBeNull()

    const version = engine.getVersion()
    await answerProbe(spawnFn, "2026.09.01")

    expect(await version).toBe("2026.09.01")
  })
})
