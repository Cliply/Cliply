// Real same-source cut/concat acceptance. Fixtures and outputs belong in the
// caller's disposable directory; no user media or network access is needed.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const { LocalMediaService } = require("../src/main/services/local-media")
const { startExportProcess } = require("../src/main/services/local-media/export-process")

async function runNative({ directory, ffmpeg, ffprobe, heAac = process.platform === "darwin" }) {
  fs.mkdirSync(directory, { recursive: true })
  const run = (exe, args) => execFileSync(exe, args, { maxBuffer: 64 * 1024 * 1024 })
  const make = (name, args) => run(ffmpeg, ["-v", "error", ...args, path.join(directory, name)])
  const base = path.join(directory, "base.mp4")
  make("base.mp4", ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=16", "-f", "lavfi", "-i", "anoisesrc=d=16:r=48000:seed=42:a=0.3",
    "-c:v", "libx264", "-g", "48", "-sc_threshold", "0", "-bf", "3", "-c:a", "aac", "-aac_pns", "0", "-metadata", "title=Segment fixture"])
  make("vfr.mp4", ["-i", base, "-vf", "select='lt(t,8)+gte(t,8)*not(mod(n,2))'", "-fps_mode", "vfr", "-c:v", "libx264", "-g", "48", "-sc_threshold", "0", "-bf", "3", "-c:a", "copy"])
  make("rotated.mov", ["-i", base, "-map", "0", "-c", "copy", "-metadata:s:v:0", "rotate=90"])
  make("long.mp4", ["-f", "lavfi", "-i", "testsrc2=s=160x90:r=24:d=200", "-f", "lavfi", "-i", "anoisesrc=d=200:r=48000:seed=43:a=0.3", "-c:v", "libx264", "-g", "48", "-sc_threshold", "0", "-bf", "3", "-c:a", "aac", "-aac_pns", "0"])
  make("base.mov", ["-i", base, "-map", "0", "-c", "copy"])
  make("base.mkv", ["-i", base, "-map", "0", "-c", "copy"])
  make("negative.mkv", ["-i", base, "-map", "0", "-c", "copy", "-avoid_negative_ts", "disabled"])
  make("multi.mp4", ["-i", base, "-map", "0:v", "-map", "0:a", "-map", "0:a", "-c", "copy", "-disposition:a:0", "default", "-disposition:a:1", "0", "-metadata:s:a:1", "language=rus"])
  if (heAac) make("he-aac.mp4", ["-i", base, "-map", "0", "-c:v", "copy", "-c:a", "aac_at", "-profile:a", "4", "-ar", "44100", "-ac", "2", "-b:a", "48k"])
  const cases = [
    { file: "base.mp4", intent: "remove", ranges: [{ start: 4, end: 8 }] },
    { file: "base.mov", intent: "keep", ranges: [{ start: 0, end: 2 }, { start: 6, end: 8 }, { start: 12, end: 16 }] },
    { file: "long.mp4", intent: "keep", ranges: [{ start: 60.3, end: 64 }, { start: 180.2, end: 186 }] },
    { file: "vfr.mp4", intent: "remove", ranges: [{ start: 4, end: 8 }] },
    { file: "rotated.mov", intent: "remove", ranges: [{ start: 4, end: 8 }] },
    { file: "base.mkv", intent: "remove", ranges: [{ start: 4, end: 8 }] },
    { file: "negative.mkv", intent: "remove", ranges: [{ start: 4, end: 8 }] },
    { file: "multi.mp4", intent: "remove", ranges: [{ start: 4, end: 8 }] },
    ...(heAac ? [{ file: "he-aac.mp4", intent: "remove", ranges: [{ start: 4, end: 8 }] }] : [])
  ]
  let selected, target
  const service = new LocalMediaService({ selectFile: async () => selected, resolveProbe: async () => ffprobe,
    exportOptions: { storagePath: path.join(directory, "state"), resolveFfmpeg: async () => ffmpeg, selectDestination: async () => target } })
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  const inspect = file => JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]))
  const frames = file => run(ffmpeg, ["-v", "error", "-noautorotate", "-i", file, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "framemd5", "-"]).toString().split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim())
  // Preserve even sub-100-ms timestamp gaps in the decoded comparison. Raw
  // PCM otherwise collapses them and cannot measure presentation-time sync.
  const pcm = (file, index, lowpass = false) => run(ffmpeg, ["-v", "error", "-i", file, "-map", `0:${index}`, "-af", `aresample=async=1:min_hard_comp=0.001:first_pts=0${lowpass ? ",lowpass=f=4000" : ""}`, "-f", "s16le", "-"])
  const facts = []
  try {
    for (const [index, scenario] of cases.entries()) {
      selected = path.join(directory, scenario.file); target = path.join(directory, `joined-${index}.${scenario.file.endsWith(".mov") ? "mov" : "mp4"}`)
      const originalHash = hash(selected), source = (await service.open()).source
      if (scenario.file.startsWith("he-aac")) assert.equal(source.streams.find(stream => stream.type === "audio").profile, "HE-AAC")
      const timing = await service.inspectTrim({ sourceId: source.sourceId, mode: "after", intent: scenario.intent, ranges: scenario.ranges })
      const { plan } = await service.exports.prepare({ sourceId: source.sourceId, operation: "trim", trimPlanId: timing.trimPlanId })
      service.exports.start(plan.planId); await service.exports.active.done
      assert.equal(service.exports.job.state, "completed", `${scenario.file}: ${service.exports.job.error}`)
      run(ffmpeg, ["-v", "error", "-xerror", "-i", target, "-fps_mode", "passthrough", "-f", "null", "-"])
      const before = frames(selected), after = frames(target)
      const sourceFrames = JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", selected])).frames
      const origin = source.contentContainer === "mkv" ? source.streams.find(stream => stream.type === "video").startTime : 0
      const times = sourceFrames.map(frame => Number(frame.best_effort_timestamp_time) - origin)
      const sourceIndexes = after.map(digest => before.indexOf(digest))
      assert(sourceIndexes.every((value, i) => value >= 0 && (!i || value > sourceIndexes[i - 1])), "pictures retain source order")
      for (const cut of timing.cuts) {
        assert(sourceIndexes.some(index => Math.abs(times[index] - cut.plannedStart) <= 0.001), "each retained section begins at its planned picture")
      }
      assert(sourceIndexes.every(value => timing.cuts.some(cut => times[value] >= cut.plannedStart - 0.001 && times[value] < cut.plannedEnd + 0.001)), "no picture outside reviewed cuts")
      const decoded = JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", target])).frames
      assert(decoded.every((frame, i) => !i || Number(frame.best_effort_timestamp_time) > Number(decoded[i - 1].best_effort_timestamp_time)), "joined picture timestamps increase")
      const audioFacts = []
      for (const stream of source.streams.filter(stream => stream.type === "audio")) {
        const audioPackets = (file, index) => JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", String(index), "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts_time,data_hash", "-of", "json", file])).packets
        const sourcePackets = audioPackets(selected, stream.index), outputPackets = audioPackets(target, source.streams.indexOf(stream))
        const original = pcm(selected, stream.index), result = pcm(target, source.streams.indexOf(stream)), stride = stream.channels * 2
        let elapsed = 0
        for (const cut of timing.cuts) {
          const anchorTime = cut.plannedStart + Math.min(1, (cut.plannedEnd - cut.plannedStart) / 2)
          const packet = sourcePackets.find(packet => Number(packet.pts_time) >= anchorTime + origin)
          const matched = outputPackets.find(candidate => candidate.data_hash === packet.data_hash)
          assert(matched, "encoded audio anchor retained")
          const timestampError = Number(matched.pts_time) - (Number(packet.pts_time) - origin - cut.plannedStart + elapsed)
          assert(Math.abs(timestampError) < 0.002, `packet timeline error ${timestampError}`)
          const offset = Math.round(anchorTime * stream.sampleRate) * stride
          let at = result.indexOf(original.subarray(offset, offset + 1024 * stride))
          let correlation = 1
          if (stream.profile === "HE-AAC" && at < 0) {
            // SBR decoder noise state can differ after a seek although encoded
            // packets are identical. Verify packet payloads and correlate the
            // low-frequency decoded core; keep the same 50 ms sync limit.
            const payloads = file => JSON.parse(run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=data_hash", "-of", "json", file])).packets.map(packet => packet.data_hash)
            const beforePackets = payloads(selected), afterPackets = payloads(target)
            let prior = -1
            for (const payload of afterPackets) { const next = beforePackets.indexOf(payload, prior + 1); assert(next > prior, "HE-AAC packets copied in source order"); prior = next }
            const a = pcm(selected, stream.index, true), b = pcm(target, source.streams.indexOf(stream), true)
            const expected = Math.round((elapsed + anchorTime - cut.plannedStart) * stream.sampleRate)
            const n = 2048, radius = Math.ceil(stream.sampleRate * 0.05)
            let best = -Infinity, bestSample = -1
            for (let sample = Math.max(0, expected - radius); sample <= expected + radius; sample++) {
              let dot = 0, aa = 0, bb = 0
              for (let j = 0; j < n; j++) {
                const x = a.readInt16LE(offset + j * stride), y = b.readInt16LE((sample + j) * stride)
                dot += x * y; aa += x * x; bb += y * y
              }
              const coefficient = dot / Math.sqrt(aa * bb)
              if (coefficient > best) { best = coefficient; bestSample = sample }
            }
            assert(best > 0.99, `HE-AAC decoded core correlation ${best}`)
            at = bestSample * stride; correlation = best
          }
          assert(at >= 0, "decoded audio interior matches original")
          const error = at / stride / stream.sampleRate - (elapsed + anchorTime - cut.plannedStart)
          assert(Math.abs(error) < 0.05, `audio sync error ${error}`)
          audioFacts.push({ stream: stream.index, start: cut.plannedStart, errorSeconds: error, timestampError, correlation })
          elapsed += cut.plannedEnd - cut.plannedStart
        }
      }
      assert.equal(hash(selected), originalHash)
      assert(!fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")))
      facts.push({ file: scenario.file, cuts: timing.cuts.map(cut => ({ start: cut.plannedStart, end: cut.plannedEnd })), decodedFrames: after.length, duration: inspect(target).format.duration, audio: audioFacts, sourceUnchanged: true })
    }
    // Cancellation during a real writer must remove all intermediates and keep
    // the original registered, then permit another plan on the same source.
    for (const phase of [1, 2, 3]) {
      target = path.join(directory, `cancel-${phase}.${service.source.dto.trimProfile.extension}`)
      const source = service.source.dto
      const timing = await service.inspectTrim({ sourceId: source.sourceId, intent: "remove", mode: "after", ranges: [{ start: 4, end: 8 }] })
      const { plan } = await service.exports.prepare({ sourceId: source.sourceId, operation: "trim", trimPlanId: timing.trimPlanId })
      let launched = 0
      service.exports.runProcess = (exe, args, options) => startExportProcess(exe, ++launched === phase ? ["-readrate", "0.1", ...args] : args, options)
      service.exports.start(plan.planId)
      while (service.exports.active && (launched < phase || !service.exports.active.process)) await new Promise(resolve => setTimeout(resolve, 10))
      const active = service.exports.active
      assert(active, "job stays active until cancellation")
      service.exports.cancel(service.exports.job.jobId); await active.done
      assert.equal(service.exports.job.state, "cancelled"); assert.equal(fs.existsSync(target), false)
      assert(!fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")))
    }
    return { cases: facts, cancellation: true }
  } finally { await service.shutdown() }
}
module.exports = { runNative }
if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  if (![directory, ffmpeg, ffprobe].every(value => value && path.isAbsolute(value))) throw new Error("Usage: node scripts/smoke-local-segments.js <new-task-dir> <ffmpeg> <ffprobe>")
  runNative({ directory, ffmpeg, ffprobe }).then(result => {
    fs.writeFileSync(path.join(directory, "segments-evidence.json"), JSON.stringify(result, null, 2))
    console.log(`Joined export: ${result.cases.length} decoded cases; cancellation at cut 1, cut 2 and concat passed`)
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
