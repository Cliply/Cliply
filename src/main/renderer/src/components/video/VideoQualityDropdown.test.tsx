// @vitest-environment jsdom
//
// the menu is the video's own format list now, so what is under test is that
// it shows what yt-dlp reported - and nothing yt-dlp did not report

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import type { QualityTier } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { VideoQualityDropdown } from "./VideoQualityDropdown"

const tier = (
  height: number,
  container: "mp4" | "mkv",
  filesize: number | null,
  fps: number | null = 30
): QualityTier => ({
  height,
  container,
  filesize,
  fps
})

// the shape a 4K video really produces: h264 caps at 1080p, so 1440/2160 are mkv
const FOUR_K: QualityTier[] = [
  tier(2160, "mkv", 722716776, 60),
  tier(1440, "mkv", 402653184, 60),
  tier(1080, "mp4", 270000000, 60),
  tier(720, "mp4", 160796363, 60),
  tier(360, "mp4", 40000000)
]

// the same video list from a source that simply has no 4K
const CAPPED: QualityTier[] = [
  tier(1080, "mp4", 270000000),
  tier(720, "mp4", 160796363),
  tier(360, "mp4", 40000000)
]

const openMenu = () => fireEvent.click(screen.getAllByRole("button")[0])

// the popup rows: everything after the closed button's own summary
const rows = () => screen.getAllByRole("button").slice(1)

beforeEach(() => useYouTubeStore.getState().reset())
afterEach(cleanup)

describe("the rows", () => {
  test("each row carries the height, the container and the real size", () => {
    render(<VideoQualityDropdown tiers={FOUR_K} isVisible />)
    openMenu()

    expect(rows().map((row) => row.textContent)).toEqual([
      "2160pMKV · 60fps · 689.24 MB",
      "1440pMKV · 60fps · 384 MB",
      "1080pMP4 · 60fps · 257.49 MB",
      "720pMP4 · 60fps · 153.35 MB",
      "360pMP4 · 38.15 MB"
    ])
  })

  test("a tier whose size yt-dlp does not know renders without one", () => {
    render(<VideoQualityDropdown tiers={[tier(720, "mp4", null)]} isVisible />)
    openMenu()

    expect(rows()[0].textContent).toBe("720pMP4")
    expect(rows()[0].textContent).not.toContain("0 MB")
    expect(rows()[0].textContent).not.toContain("Unknown")
  })

  test("the container is on every row, so an MKV result is never a surprise", () => {
    render(<VideoQualityDropdown tiers={FOUR_K} isVisible />)
    openMenu()

    expect(rows().filter((row) => row.textContent?.includes("MKV"))).toHaveLength(2)
  })
})

describe("the default selection", () => {
  test("lands on the highest tier that is really an mp4", () => {
    render(<VideoQualityDropdown tiers={FOUR_K} isVisible />)

    expect(useYouTubeStore.getState().selectedTier).toMatchObject({
      height: 1080,
      container: "mp4"
    })
  })

  test("falls back to the best row when the source has no mp4 at all", () => {
    render(
      <VideoQualityDropdown tiers={[tier(2160, "mkv", 1), tier(1440, "mkv", 1)]} isVisible />
    )

    expect(useYouTubeStore.getState().selectedTier).toMatchObject({
      height: 2160,
      container: "mkv"
    })
  })

  test("a click sends the row that was displayed, container and all", () => {
    render(<VideoQualityDropdown tiers={FOUR_K} isVisible />)
    openMenu()

    fireEvent.click(screen.getByRole("button", { name: /2160p/ }))

    expect(useYouTubeStore.getState().selectedTier).toEqual(FOUR_K[0])
  })

  test("a selection the next video does not offer is replaced, not kept", () => {
    const { rerender } = render(<VideoQualityDropdown tiers={FOUR_K} isVisible />)
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: /2160p/ }))

    rerender(<VideoQualityDropdown tiers={CAPPED} isVisible />)

    expect(useYouTubeStore.getState().selectedTier).toMatchObject({
      height: 1080,
      container: "mp4"
    })
  })

  /**
   * a height and a container the next video happens to share are not a reason
   * to keep the previous video's row: that object carries its own filesize and
   * fps, and showing those against this video is the exact lie the real menu
   * exists to remove
   */
  test("a matching height and container does not preserve the previous row", () => {
    const { rerender } = render(<VideoQualityDropdown tiers={FOUR_K} isVisible />)
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: /720p/ }))
    expect(useYouTubeStore.getState().selectedTier).toBe(FOUR_K[3])

    // CAPPED offers 720p MP4 as well, at its own size
    rerender(<VideoQualityDropdown tiers={CAPPED} isVisible />)

    const selected = useYouTubeStore.getState().selectedTier
    expect(selected).toBe(CAPPED[0])
    expect(FOUR_K).not.toContain(selected)
  })
})

/**
 * the check that proves the menu is real rather than hardcoded: the same
 * component, given a 1080p-max video, has no 4K row to offer
 */
describe("a 1080p-max video", () => {
  test("is not offered 4K", () => {
    render(<VideoQualityDropdown tiers={CAPPED} isVisible />)
    openMenu()

    expect(rows().map((row) => row.textContent)).toEqual([
      "1080pMP4 · 257.49 MB",
      "720pMP4 · 153.35 MB",
      "360pMP4 · 38.15 MB"
    ])
    expect(screen.queryByText("2160p")).toBeNull()
    expect(screen.queryByText("1440p")).toBeNull()
  })
})

describe("a source with no video at all", () => {
  test("explains itself instead of offering an empty menu", () => {
    render(<VideoQualityDropdown tiers={[]} isVisible />)

    expect(screen.getByText(/no video streams/i)).toBeDefined()
    expect(screen.queryByRole("button")).toBeNull()
    expect(useYouTubeStore.getState().selectedTier).toBeNull()
  })
})
