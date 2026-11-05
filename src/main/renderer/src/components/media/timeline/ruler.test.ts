import { describe, expect, test } from "vitest"
import { formatRulerLabel, getRulerConfig, visibleRulerTicks } from "./ruler"
import { sliderToZoom, zoomToSlider } from "./zoom"

describe("source-time ruler adapted from OpenCut", () => {
  test.each([0.00001, 0.01, 1, 13, 500, 20000])("keeps readable labels on ticks at %s px/s", pixelsPerSecond => {
    const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig(pixelsPerSecond)
    expect(labelIntervalSeconds * pixelsPerSecond).toBeGreaterThanOrEqual(120)
    expect(tickIntervalSeconds * pixelsPerSecond).toBeGreaterThanOrEqual(18)
    const ratio = labelIntervalSeconds / tickIntervalSeconds
    expect(ratio).toBeCloseTo(Math.round(ratio))
  })
  test("renders only a buffered viewport even far into a long source", () => {
    const args = { duration: 1_000_000, pixelsPerSecond: 10, viewportWidth: 800 }
    const near = visibleRulerTicks({ ...args, scrollLeft: 2000 })
    const far = visibleRulerTicks({ ...args, scrollLeft: 9_000_000 })
    expect(far.length).toBeLessThan(100)
    expect(Math.abs(far.length - near.length)).toBeLessThan(3)
    expect(far[0].time).toBeGreaterThan(899_000)
    expect(far.at(-1)!.time).toBeLessThan(901_000)
    expect(visibleRulerTicks({ ...args, duration: 0, scrollLeft: 0 })).toEqual([])
  })
  test("shows precise source seconds rather than suggesting frame-aligned cuts", () => {
    expect(formatRulerLabel(0.005)).toBe("00:00.005")
    expect(formatRulerLabel(12.5)).toBe("00:12.5")
    expect(formatRulerLabel(3661)).toBe("1:01:01")
  })
  test("zoom slider is exponential, reversible and bounded", () => {
    expect(sliderToZoom(0)).toBe(1)
    expect(sliderToZoom(0.5)).toBe(8)
    expect(sliderToZoom(1)).toBe(64)
    expect(sliderToZoom(2)).toBe(64)
    expect(zoomToSlider(sliderToZoom(0.23))).toBeCloseTo(0.23)
  })
})
