// Adapted from OpenCut Classic (MIT), cf5e79e919144200294fb9fed22a222592a0aeea:
// apps/web/src/timeline/ruler-utils.ts and components/timeline-ruler.tsx.
// Uses source seconds rather than OpenCut's WASM ticks/frame grid. This is a
// display ruler; it must never snap or change LosslessCut export boundaries.
// License and complete source mapping: third-party/opencut-classic/README.md.
const SECOND_INTERVALS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const MIN_LABEL_SPACING_PX = 120
const MIN_TICK_SPACING_PX = 18

export function getRulerConfig(pixelsPerSecond: number) {
  const scale = Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0 ? pixelsPerSecond : 1
  const findInterval = (minSpacing: number) => SECOND_INTERVALS.find(seconds => seconds * scale >= minSpacing) ?? Math.ceil(minSpacing / scale / 3600) * 3600
  const labelIntervalSeconds = findInterval(MIN_LABEL_SPACING_PX)
  const rawTickIntervalSeconds = findInterval(MIN_TICK_SPACING_PX)
  const dividesLabel = (seconds: number) => Math.abs(labelIntervalSeconds / seconds - Math.round(labelIntervalSeconds / seconds)) < 0.0001
  // As upstream, label and tick densities are independent, but every label
  // must still land on a tick. Extend the hour fallback for very long sources.
  const tickIntervalSeconds = dividesLabel(rawTickIntervalSeconds) ? rawTickIntervalSeconds :
    SECOND_INTERVALS.find(seconds => seconds * scale >= MIN_TICK_SPACING_PX && dividesLabel(seconds)) ?? labelIntervalSeconds
  return { labelIntervalSeconds, tickIntervalSeconds }
}

export function visibleRulerTicks({ duration, pixelsPerSecond, scrollLeft, viewportWidth }: {
  duration: number; pixelsPerSecond: number; scrollLeft: number; viewportWidth: number
}) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return []
  const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig(pixelsPerSecond)
  // OpenCut's buffered visible range, bounded to viewport width so scrolling
  // far into a long source does not grow the rendered tick count.
  const bufferPx = Math.max(200, viewportWidth * 0.15)
  const startTickIndex = Math.max(0, Math.floor((scrollLeft - bufferPx) / pixelsPerSecond / tickIntervalSeconds))
  const endTickIndex = Math.min(Math.floor(duration / tickIntervalSeconds), Math.ceil((scrollLeft + viewportWidth + bufferPx) / pixelsPerSecond / tickIntervalSeconds))
  const ticks = []
  for (let index = startTickIndex; index <= endTickIndex; index += 1) {
    const time = index * tickIntervalSeconds
    const remainder = time % labelIntervalSeconds
    ticks.push({ time, showLabel: remainder < 0.0001 || remainder > labelIntervalSeconds - 0.0001 })
  }
  return ticks
}

export function formatRulerLabel(time: number) {
  const totalSeconds = Math.floor(time + 0.00001)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0")
  const seconds = (totalSeconds % 60).toString().padStart(2, "0")
  const milliseconds = Math.round((time - totalSeconds) * 1000)
  const fraction = milliseconds > 0 ? `.${milliseconds.toString().padStart(3, "0").replace(/0+$/, "")}` : ""
  return `${hours > 0 ? `${hours}:` : ""}${minutes}:${seconds}${fraction}`
}
