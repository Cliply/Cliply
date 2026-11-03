const { MediaError } = require("./errors")
const MAX_SEGMENTS = 32
const fail = code => { throw new MediaError(code) }

// Marked sections are chronological, disjoint, half-open source intervals.
// Main derives the export intervals; the renderer cannot supply a cut plan.
function retainedRanges(source, request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "intent,mode,ranges,sourceId" ||
      !["keep", "remove"].includes(request.intent) || !["before", "after"].includes(request.mode) ||
      !Array.isArray(request.ranges) || request.ranges.length > MAX_SEGMENTS) fail("REQUEST_INVALID")
  if (!source || source.sourceId !== request.sourceId) fail("SOURCE_UNKNOWN")
  if (!Number.isFinite(source.duration) || source.duration <= 0) fail("TRIM_RANGE")
  let previous = 0
  for (const range of request.ranges) {
    if (!range || Object.keys(range).sort().join(",") !== "end,start" ||
        !Number.isFinite(range.start) || !Number.isFinite(range.end)) fail("REQUEST_INVALID")
    if (range.start < previous || range.start < 0 || range.end > source.duration || range.end - range.start < 0.1 - 1e-9) fail("TRIM_RANGE")
    previous = range.end
  }
  const result = []
  if (request.intent === "keep") result.push(...request.ranges.map(range => ({ ...range })))
  else {
    let start = 0
    for (const range of request.ranges) {
      if (range.start > start) result.push({ start, end: range.start })
      start = range.end
    }
    if (start < source.duration) result.push({ start, end: source.duration })
  }
  // Never silently discard a tiny retained sliver.
  if (!result.length || result.length > MAX_SEGMENTS || result.some(range => range.end - range.start < 0.1 - 1e-9)) fail("TRIM_RANGE")
  return result
}

function combineTiming(request, cuts) {
  return { ...cuts[0], previewId: null, intent: request.intent, ranges: request.ranges.map(range => ({ ...range })), cuts,
    duration: cuts.reduce((sum, cut) => sum + cut.duration, 0) }
}
module.exports = { retainedRanges, combineTiming, MAX_SEGMENTS }
