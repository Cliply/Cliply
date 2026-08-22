// @vitest-environment jsdom
//
// what each download button puts on the wire: the height and the container the
// user was shown, or the audio mode the row promised - and nothing about
// format ids, which no longer exist on either side

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { QualityTier } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"

const mocks = vi.hoisted(() => ({
  downloadVideo: vi.fn(),
  downloadAudio: vi.fn()
}))

vi.mock("@/lib/hooks/useVideoDownload", () => ({
  useVideoDownload: () => ({
    mutateAsync: mocks.downloadVideo,
    isPending: false,
    downloadState: { status: "idle", progress: 0 },
    cancelDownload: vi.fn()
  })
}))

vi.mock("@/lib/hooks/useAudioDownload", () => ({
  useAudioDownload: () => ({
    mutateAsync: mocks.downloadAudio,
    isPending: false,
    downloadState: { status: "idle", progress: 0 },
    cancelDownload: vi.fn()
  })
}))

const { AudioDownloadButton } = await import("./AudioDownloadButton")
const { VideoDownloadButton } = await import("./VideoDownloadButton")

const DURATION = 600
const URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"

const TIER: QualityTier = {
  height: 2160,
  container: "mkv",
  filesize: 722716776,
  fps: 60
}

beforeEach(() => {
  useYouTubeStore.getState().reset()
  mocks.downloadVideo.mockReset().mockResolvedValue({ downloadId: "x" })
  mocks.downloadAudio.mockReset().mockResolvedValue({ downloadId: "x" })
})

afterEach(cleanup)

describe("the video download request", () => {
  test("carries the height and the container that were displayed", async () => {
    useYouTubeStore.setState({
      url: URL,
      selectedTier: TIER,
      videoTimeRange: { start: 0, end: DURATION },
      videoInfo: {
        title: "Big Buck Bunny",
        duration: DURATION,
        duration_string: "10:00",
        uploader: "Blender",
        quality_tiers: [TIER],
        // Big Buck Bunny has one audio language, like nearly every video
        audio_tracks: []
      }
    })

    render(<VideoDownloadButton maxDuration={DURATION} isVisible />)
    fireEvent.click(screen.getByRole("button", { name: "Download Video" }))

    await waitFor(() => expect(mocks.downloadVideo).toHaveBeenCalledTimes(1))

    expect(mocks.downloadVideo.mock.calls[0][0]).toEqual({
      url: URL,
      height: 2160,
      container: "mkv",
      time_range: undefined,
      precise_cut: true,
      title: "Big Buck Bunny"
    })
  })

  test("a trimmed download still sends its range alongside the tier", async () => {
    useYouTubeStore.setState({
      url: URL,
      selectedTier: { ...TIER, height: 1080, container: "mp4" },
      videoTimeRange: { start: 30, end: 45 }
    })

    render(<VideoDownloadButton maxDuration={DURATION} isVisible />)
    fireEvent.click(screen.getByRole("button", { name: "Download Video" }))

    await waitFor(() => expect(mocks.downloadVideo).toHaveBeenCalledTimes(1))

    expect(mocks.downloadVideo.mock.calls[0][0]).toMatchObject({
      height: 1080,
      container: "mp4",
      time_range: { start: 30, end: 45 }
    })
  })

  test("the summary names the container the file will really be", () => {
    useYouTubeStore.setState({
      url: URL,
      selectedTier: TIER,
      videoTimeRange: { start: 0, end: DURATION }
    })

    render(<VideoDownloadButton maxDuration={DURATION} isVisible />)

    expect(screen.getByText("2160p MKV")).toBeDefined()
    expect(screen.getByText("689.24 MB")).toBeDefined()
  })

  // the untouched case: no dub was offered, so nothing about the language
  // reaches the wire and the main process builds exactly today's args
  test("carries no language when the video offered no choice of dubs", async () => {
    useYouTubeStore.setState({
      url: URL,
      selectedTier: TIER,
      videoTimeRange: { start: 0, end: DURATION }
    })

    render(<VideoDownloadButton maxDuration={DURATION} isVisible />)
    fireEvent.click(screen.getByRole("button", { name: "Download Video" }))

    await waitFor(() => expect(mocks.downloadVideo).toHaveBeenCalledTimes(1))

    expect(mocks.downloadVideo.mock.calls[0][0]).not.toHaveProperty(
      "audio_language"
    )
    expect(screen.getByText("Best available")).toBeDefined()
  })

  test("carries the dub the user picked, and names it in the summary", async () => {
    useYouTubeStore.setState({
      url: URL,
      selectedTier: TIER,
      selectedAudioLanguage: "hi",
      videoTimeRange: { start: 0, end: DURATION }
    })

    render(<VideoDownloadButton maxDuration={DURATION} isVisible />)

    // the summary row that reads "Best available" on every other video
    expect(screen.getByText("Hindi")).toBeDefined()
    expect(screen.queryByText("Best available")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Download Video" }))

    await waitFor(() => expect(mocks.downloadVideo).toHaveBeenCalledTimes(1))

    expect(mocks.downloadVideo.mock.calls[0][0]).toMatchObject({
      height: 2160,
      container: "mkv",
      audio_language: "hi"
    })
  })

  test("a tier with no known size shows no size at all", () => {
    useYouTubeStore.setState({
      url: URL,
      selectedTier: { ...TIER, filesize: null },
      videoTimeRange: { start: 0, end: DURATION }
    })

    render(<VideoDownloadButton maxDuration={DURATION} isVisible />)

    expect(screen.queryByText("Size:")).toBeNull()
    expect(screen.queryByText(/Unknown size/)).toBeNull()
  })
})

describe("the audio download request", () => {
  test("carries the mode the row promised", async () => {
    useYouTubeStore.setState({
      url: URL,
      selectedAudioMode: "original",
      audioTimeRange: { start: 0, end: DURATION }
    })

    render(<AudioDownloadButton maxDuration={DURATION} isVisible />)
    fireEvent.click(screen.getByRole("button", { name: "Download Audio" }))

    await waitFor(() => expect(mocks.downloadAudio).toHaveBeenCalledTimes(1))

    expect(mocks.downloadAudio.mock.calls[0][0]).toEqual({
      url: URL,
      audio_mode: "original",
      time_range: undefined,
      precise_cut: true,
      title: "audio"
    })
  })

  test("carries no language when the video offered no choice of dubs", async () => {
    useYouTubeStore.setState({
      url: URL,
      selectedAudioMode: "mp3",
      audioTimeRange: { start: 0, end: DURATION }
    })

    render(<AudioDownloadButton maxDuration={DURATION} isVisible />)
    fireEvent.click(screen.getByRole("button", { name: "Download Audio" }))

    await waitFor(() => expect(mocks.downloadAudio).toHaveBeenCalledTimes(1))

    expect(mocks.downloadAudio.mock.calls[0][0]).not.toHaveProperty(
      "audio_language"
    )
    expect(screen.queryByText("Language:")).toBeNull()
  })

  test("carries the dub alongside the mode", async () => {
    useYouTubeStore.setState({
      url: URL,
      selectedAudioMode: "mp3",
      selectedAudioLanguage: "zh-Hant",
      audioTimeRange: { start: 0, end: DURATION }
    })

    render(<AudioDownloadButton maxDuration={DURATION} isVisible />)

    expect(screen.getByText("Traditional Chinese")).toBeDefined()

    fireEvent.click(screen.getByRole("button", { name: "Download Audio" }))

    await waitFor(() => expect(mocks.downloadAudio).toHaveBeenCalledTimes(1))

    expect(mocks.downloadAudio.mock.calls[0][0]).toMatchObject({
      audio_mode: "mp3",
      audio_language: "zh-Hant"
    })
  })

  test("each mode goes out as itself", async () => {
    for (const mode of ["mp3", "m4a"] as const) {
      useYouTubeStore.setState({
        url: URL,
        selectedAudioMode: mode,
        audioTimeRange: { start: 0, end: DURATION }
      })

      render(<AudioDownloadButton maxDuration={DURATION} isVisible />)
      fireEvent.click(screen.getByRole("button", { name: "Download Audio" }))

      await waitFor(() =>
        expect(mocks.downloadAudio).toHaveBeenCalledWith(
          expect.objectContaining({ audio_mode: mode })
        )
      )

      cleanup()
    }
  })
})
