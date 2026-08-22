// @vitest-environment jsdom
//
// the picker exists only where a choice exists. nearly every video has one
// audio language and must render nothing at all - that is the case this whole
// feature is not allowed to change.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import type { AudioTrack } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"
import { AudioTrackDropdown } from "./AudioTrackDropdown"

const track = (code: string, is_original = false): AudioTrack => ({
  code,
  is_original
})

// the head of what Af6i6ChAVTw really returns: english original, then dubs in
// the order the extractor listed them
const DUBBED: AudioTrack[] = [
  track("en", true),
  track("hi"),
  track("ja"),
  track("zh-Hans"),
  track("zh-Hant")
]

const openMenu = () => fireEvent.click(screen.getAllByRole("button")[0])
const rows = () => screen.getAllByRole("button").slice(1)

beforeEach(() => useYouTubeStore.getState().reset())
afterEach(cleanup)

describe("a video with one audio language", () => {
  // this is nearly every video: an empty array means "no choice exists"
  test("renders nothing at all", () => {
    const { container } = render(<AudioTrackDropdown tracks={[]} isVisible />)

    expect(container.firstChild).toBeNull()
    expect(screen.queryByText(/audio language/i)).toBeNull()
  })

  test("a lone track is still not a choice", () => {
    const { container } = render(
      <AudioTrackDropdown tracks={[track("en", true)]} isVisible />
    )

    expect(container.firstChild).toBeNull()
  })

  test("sends no language, so the download args stay today's", () => {
    render(<AudioTrackDropdown tracks={[]} isVisible />)

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBeNull()
  })
})

describe("a dubbed video", () => {
  test("shows a row per language, named rather than coded", () => {
    render(<AudioTrackDropdown tracks={DUBBED} isVisible />)
    openMenu()

    expect(rows().map((row) => row.textContent)).toEqual([
      "EnglishOriginal",
      "Hindi",
      "Japanese",
      "Simplified Chinese",
      "Traditional Chinese"
    ])
  })

  // the names come from Intl.DisplayNames, not a table of our own - which is
  // also what keeps zh-Hans and zh-Hant apart instead of collapsing them
  test("regional tags get their own distinct names", () => {
    render(<AudioTrackDropdown tracks={DUBBED} isVisible />)
    openMenu()

    expect(screen.getByText("Simplified Chinese")).toBeDefined()
    expect(screen.getByText("Traditional Chinese")).toBeDefined()
  })

  test("defaults to the original track and marks it as such", () => {
    render(<AudioTrackDropdown tracks={DUBBED} isVisible />)

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBe("en")
    expect(screen.getByText("English")).toBeDefined()
    expect(screen.getByText("Original")).toBeDefined()
  })

  test("picking a dub is what puts a code on the wire", () => {
    render(<AudioTrackDropdown tracks={DUBBED} isVisible />)
    openMenu()

    fireEvent.click(screen.getByRole("button", { name: "Hindi" }))

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBe("hi")
  })

  test("a code the next video does not carry is replaced, not kept", () => {
    const { rerender } = render(<AudioTrackDropdown tracks={DUBBED} isVisible />)
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: "Hindi" }))

    rerender(
      <AudioTrackDropdown tracks={[track("de", true), track("fr")]} isVisible />
    )

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBe("de")
  })

  /**
   * the leak worth a test of its own: two dubbed videos that both carry Hindi.
   * a code that merely *exists* in the next video's list is not a reason to
   * keep it - loading a video clears the store, so B opens on its own original
   * instead of silently downloading a dub nobody asked for.
   */
  test("a code the next video also carries is still reset to its original", () => {
    const { rerender } = render(<AudioTrackDropdown tracks={DUBBED} isVisible />)
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: "Hindi" }))
    expect(useYouTubeStore.getState().selectedAudioLanguage).toBe("hi")

    const NEXT = [track("de", true), track("hi")]
    act(() => {
      useYouTubeStore.getState().setVideoInfo({
        title: "the next video",
        duration: 60,
        duration_string: "1:00",
        uploader: "someone",
        quality_tiers: [],
        audio_tracks: NEXT
      })
    })
    rerender(<AudioTrackDropdown tracks={NEXT} isVisible />)

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBe("de")
  })

  // moving from a dubbed video to an ordinary one has to leave the ordinary
  // one requesting nothing, or it would inherit a language it has no track for
  test("moving to a single-language video clears the code", () => {
    const { rerender } = render(<AudioTrackDropdown tracks={DUBBED} isVisible />)
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: "Hindi" }))

    rerender(<AudioTrackDropdown tracks={[]} isVisible />)

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBeNull()
  })

  // a dub-only listing has no original to open on; the first row stands in
  test("with no original marked, the first track is the default", () => {
    render(<AudioTrackDropdown tracks={[track("hi"), track("ja")]} isVisible />)

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBe("hi")
  })

  test("hidden while the tab it belongs to is not showing options", () => {
    const { container } = render(
      <AudioTrackDropdown tracks={DUBBED} isVisible={false} />
    )

    expect(container.firstChild).toBeNull()
  })
})
