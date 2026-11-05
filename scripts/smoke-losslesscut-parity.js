// Real same-source cut/concat acceptance. Fixtures and outputs belong in the
// caller's disposable directory; no user media or network access is needed.
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const { LocalMediaService } = require("../src/main/services/local-media")
const { startExportProcess } = require("../src/main/services/local-media/export-process")

async function runNative({ directory, ffmpeg, ffprobe, heAac = process.platform === "darwin", single = false }) {
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
  make("offset.mp4", ["-i", base, "-map", "0", "-c", "copy", "-output_ts_offset", "2"])
  make("audio.m4a", ["-i", base, "-map", "0:a", "-c", "copy"])
  make("audio.wav", ["-i", base, "-map", "0:a", "-c:a", "pcm_s16le"])
  const files = ["base.mp4", "base.mov", "base.mkv", "negative.mkv", "vfr.mp4", "rotated.mov", "multi.mp4", "offset.mp4", "long.mp4", "audio.m4a", "audio.wav", ...(heAac ? ["he-aac.mp4"] : [])]
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  const packets = file => JSON.parse(run(ffprobe, ["-v", "error", "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=stream_index,pts_time,dts_time,duration_time,data_hash", "-of", "json", file])).packets
  let selected, target
  const service = new LocalMediaService({ selectFile: async () => selected, resolveProbe: async () => ffprobe,
    exportOptions: { storagePath: path.join(directory, "state"), resolveFfmpeg: async () => ffmpeg, selectDestination: async () => target } })
  const facts = []
  try {
    for (const file of files) for (const mode of ["before", "after"]) {
      selected = path.join(directory, file)
      const originalHash = hash(selected), source = (await service.open()).source
      const offset = file === "long.mp4" ? 60 : 0
      const ranges = single ? [{ start: offset + 0.3, end: offset + 6.2 }] : [{ start: offset, end: offset + 3.2 }, { start: offset + 8.3, end: offset + 14 }]
      const timing = await service.inspectTrim({ sourceId: source.sourceId, mode, intent: "keep", ranges })
      const name = `${file}-${mode}`
      target = path.join(directory, `${name}-cliply.${timing.extension}`)
      const { plan } = await service.exports.prepare({ sourceId: source.sourceId, operation: "trim", trimPlanId: timing.trimPlanId })
      service.exports.start(plan.planId); await service.exports.active.done
      assert.equal(service.exports.job.state, "completed", `${name}: ${service.exports.job.error}`)
      // Independent transcription of upstream losslessCutSingle/concatFiles
      // for one input, default cut flags, preserveMetadataOnMerge=true.
      // Do not call Cliply argument builders to construct this oracle.
      const parts = []
      for (const [i, range] of ranges.entries()) {
        const part = path.join(directory, `${name}-reference-${i}.${timing.extension}`)
        const keyframe = mode === "before"
        const compensation = keyframe && range.start > 0 && file.endsWith(".mkv") && source.streams.some(s => s.bFrames > 0) ? 3 / 23 + 0.001 : 0
        const seek = range.start > 0 ? ["-ss", (range.start + compensation).toFixed(6)] : []
        const movFlags = ["mp4", "mov", "m4a"].includes(timing.extension) ? ["-movflags", "+faststart"] : []
        run(ffmpeg, ["-v", "error", ...(keyframe ? [...seek, ...(compensation ? ["-itsoffset", compensation.toFixed(6)] : [])] : []),
          "-i", selected, ...(!keyframe ? seek : []), ...(range.end < source.duration ? ["-t", (range.end - range.start).toFixed(6)] : []),
          ...(keyframe && range.start > 0 ? ["-avoid_negative_ts", "make_zero"] : []),
          ...(!keyframe && range.start > 0 && !timing.hasVideo ? ["-copyinkf"] : []),
          ...source.streams.flatMap((stream, index) => ["-map", `0:${stream.index}`, `-c:${index}`, "copy"]),
          "-map_metadata", "0", "-map_chapters", "-1", ...movFlags, "-ignore_unknown", "-f", timing.muxer, part])
        parts.push(part)
      }
      let reference = parts[0]
      if (parts.length > 1) {
        reference = path.join(directory, `${name}-reference.${timing.extension}`)
        const list = path.join(directory, `${name}.ffconcat`)
        fs.writeFileSync(list, parts.map(file => `file 'file:${file.replace(/'/g, "'\\''")}'`).join("\n"))
        run(ffmpeg, ["-v", "error", "-f", "concat", "-safe", "0", "-protocol_whitelist", "file,pipe,fd", "-i", list, "-i", parts[0],
          ...source.streams.flatMap((stream, index) => ["-map", `0:${index}`, `-c:${index}`, "copy", `-disposition:${index}`, Object.entries(stream.disposition).filter(([,v]) => v).map(([k]) => k).join("+") || "0"]),
          "-map_metadata", "1", "-map_chapters", "-1", ...(["mp4", "mov", "m4a"].includes(timing.extension) ? ["-movflags", "+faststart"] : []),
          "-ignore_unknown", "-f", timing.muxer, reference])
      }
      const actualPackets = packets(target), referencePackets = packets(reference)
      assert.deepEqual(actualPackets, referencePackets, `${name}: packet payloads AND audio/video timestamps match upstream procedure`)
      run(ffmpeg, ["-v", "error", "-xerror", "-i", target, "-fps_mode", "passthrough", "-f", "null", "-"])
      assert.equal(hash(selected), originalHash, "original unchanged")
      facts.push({ file, mode, sections: ranges.length, packets: actualPackets.length, packetPayloadAndTimingMatch: true, fullyDecoded: true, sourceUnchanged: true })
    }
    // Keep original cancellation coverage at cut 1, cut 2 and concat.
    selected = base
    const source = (await service.open()).source
    for (const phase of [1, 2, 3]) {
      target = path.join(directory, `cancel-${phase}.mp4`)
      const timing = await service.inspectTrim({ sourceId: source.sourceId, intent: "keep", mode: "before", ranges: [{ start: 0, end: 4 }, { start: 8, end: 12 }] })
      const { plan } = await service.exports.prepare({ sourceId: source.sourceId, operation: "trim", trimPlanId: timing.trimPlanId })
      let launched = 0
      service.exports.runProcess = (exe, args, options) => startExportProcess(exe, ++launched === phase ? ["-readrate", "0.1", ...args] : args, options)
      service.exports.start(plan.planId)
      while (service.exports.active && (launched < phase || !service.exports.active.process)) await new Promise(resolve => setTimeout(resolve, 10))
      const active = service.exports.active
      assert(active)
      service.exports.cancel(service.exports.job.jobId); await active.done
      assert.equal(service.exports.job.state, "cancelled"); assert(!fs.existsSync(target))
      assert(!fs.readdirSync(directory).some(name => name.startsWith(".cliply-export-")))
    }
    return { cases: facts, cancellation: true, reference: "LosslessCut 6fc47dd4cc81b72a8f1b3132c47a99880cd9bbdb" }
  } finally { await service.shutdown() }
}
module.exports = { runNative }
if (require.main === module) {
  const [directory, ffmpeg, ffprobe] = process.argv.slice(2)
  runNative({ directory, ffmpeg, ffprobe }).then(result => {
    fs.writeFileSync(path.join(directory, "parity-evidence.json"), JSON.stringify(result, null, 2))
    console.log(`LosslessCut parity: ${result.cases.length} outputs matched packet payloads/timestamps; decode, source preservation and cancellation passed`)
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
