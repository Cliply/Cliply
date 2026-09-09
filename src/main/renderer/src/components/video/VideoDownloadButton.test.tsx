// @vitest-environment jsdom
//
// the download button under a russian locale. the card around it is the app's
// tightest layout, so this is the one label that must never fall back to
// english: it is the button the whole screen exists for.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import type { QualityTier } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { ru } from "@/lib/i18n/ru"
import { useYouTubeStore } from "@/lib/youtubeStore"

vi.mock("@/lib/hooks/useVideoDownload", () => ({
  useVideoDownload: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    downloadState: { status: "idle", progress: 0 },
    cancelDownload: vi.fn()
  })
}))

const { VideoDownloadButton } = await import("./VideoDownloadButton")

const DURATION = 600
const TIER: QualityTier = {
  height: 1080,
  container: "mp4",
  filesize: null,
  fps: null
}

afterEach(() => {
  cleanup()
  useLocale.setState({ locale: "en" })
  useYouTubeStore.getState().reset()
})

describe("the video download button", () => {
  test("says what it does in russian when the locale is russian", () => {
    useLocale.setState({ locale: "ru" })
    useYouTubeStore.setState({
      selectedTier: TIER,
      videoTimeRange: { start: 0, end: DURATION }
    })

    render(<VideoDownloadButton maxDuration={DURATION} isVisible />)

    expect(
      screen.getByRole("button", { name: ru["download.video"] })
    ).toBeTruthy()
    expect(screen.getByText(ru["download.mergeHint"])).toBeTruthy()
  })
})
