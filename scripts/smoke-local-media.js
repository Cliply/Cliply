// Synthetic, offline inspection through the same main-owned service as IPC.
// Explicit helpers only; no PATH resolution, downloads, or user-data access.
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { parseArgs } = require("node:util")
const { LocalMediaService } = require("../src/main/services/local-media")
const { resolveFfprobe } = require("../src/main/services/local-media/paths")
const { startProbe } = require("../src/main/services/local-media/probe")
const { hash } = require("./stage-ffprobe")

function wavFixture() {
  const buffer = Buffer.alloc(44 + 16000)
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write("WAVEfmt ", 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24)
  buffer.writeUInt32LE(16000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(16000, 40)
  for (let i = 0; i < 8000; i++) buffer.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 8000)), 44 + i * 2)
  return buffer
}

async function smoke({ ffprobe, ffmpeg }) {
  const executable = await resolveFfprobe({ isPackaged: false, developmentPath: ffprobe })
  if (ffmpeg && !path.isAbsolute(ffmpeg)) throw new Error("--ffmpeg must be absolute")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-inspection-"))
  let selection
  const service = new LocalMediaService({ resolveProbe: async () => executable, selectFile: async () => selection })
  try {
    const wav = path.join(root, "tone 'тест'.wav")
    await fs.writeFile(wav, wavFixture())
    const fixtures = [wav]
    if (ffmpeg) {
      const mp4 = path.join(root, "video.mp4")
      execFileSync(ffmpeg, ["-hide_banner", "-v", "error", "-nostdin", "-n",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=1", "-i", wav,
        "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4
      ], { timeout: 30000 })
      fixtures.push(mp4)
    }
    const results = []
    for (const fixture of fixtures) {
      const before = await hash(fixture)
      selection = fixture
      const opened = await service.open()
      assert.equal(opened.cancelled, false)
      assert.ok(Math.abs(opened.source.duration - 1) < 0.2)
      assert.deepEqual(opened.source.streams.map((s) => [s.index, s.codec]), fixture === wav ? [[0, "pcm_s16le"]] : [[0, "h264"], [1, "aac"]])
      assert.equal(await hash(fixture), before, "original hash unchanged")
      assert.equal(opened.source.capabilities.nativePreview.status, "unchecked")
      results.push({ filename: path.basename(fixture), sha256: before, bytes: opened.source.bytes, duration: opened.source.duration, streams: opened.source.streams.map(({ index, codec, type }) => ({ index, codec, type })) })
    }
    selection = null
    assert.equal((await service.open()).cancelled, true)
    const bad = path.join(root, "malformed.mp4")
    await fs.writeFile(bad, "not media")
    selection = bad
    await assert.rejects(service.open(), { code: "PROBE_FAILED" })
    // A disguised playlist cannot cause another local file or network request.
    await fs.writeFile(bad, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://127.0.0.1:1/segment.ts\n")
    await assert.rejects(service.open(), { code: "PROBE_FAILED" })
    const cancelled = startProbe(executable, wav)
    cancelled.cancel()
    await assert.rejects(cancelled.result, { code: "CANCELLED" })
    await cancelled.closed
    assert.equal(cancelled.ended, true)
    const timedOut = startProbe(executable, wav, { timeoutMs: 0 })
    await assert.rejects(timedOut.result, { code: "PROBE_TIMEOUT" })
    await timedOut.closed
    selection = wav
    await service.open()
    await fs.appendFile(wav, "changed")
    await assert.rejects(service.getState(), { code: "SOURCE_CHANGED" })
    console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, helperSha256: await hash(executable), fixtures: results, checks: ["source hashes unchanged after probe", "cancelled dialog", "malformed media", "disguised network playlist rejected", "native cancellation drained", "native timeout drained", "changed source refused"] }, null, 2))
  } finally {
    await service.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  }
}

if (require.main === module) {
  const { values } = parseArgs({ options: { ffprobe: { type: "string" }, ffmpeg: { type: "string" } } })
  if (!values.ffprobe) throw new Error("Pass --ffprobe <verified absolute executable> [--ffmpeg <existing absolute executable>]")
  smoke(values).catch((error) => { console.error(error); process.exitCode = 1 })
}

module.exports = { smoke, wavFixture }
