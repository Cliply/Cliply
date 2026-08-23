// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { useYouTubeStore } from "@/lib/youtubeStore"
import { AudioFormatDropdown } from "./AudioFormatDropdown"

const openMenu = () => fireEvent.click(screen.getAllByRole("button")[0])
const rows = () => screen.getAllByRole("button").slice(1)

beforeEach(() => useYouTubeStore.getState().reset())
afterEach(cleanup)

describe("the audio menu", () => {
  test("offers the three things yt-dlp can actually do, and says what each is", () => {
    render(<AudioFormatDropdown isVisible />)
    openMenu()

    expect(rows().map((row) => row.textContent)).toEqual([
      "MP3Converted · plays everywhere",
      "M4AAAC · converted",
      "OriginalSource quality, no re-encode · usually WEBM/Opus"
    ])
  })

  test("opens on mp3, the one every device plays", () => {
    render(<AudioFormatDropdown isVisible />)

    expect(useYouTubeStore.getState().selectedAudioMode).toBe("mp3")
  })

  test("a click selects the mode the row promised", () => {
    render(<AudioFormatDropdown isVisible />)
    openMenu()

    fireEvent.click(screen.getByRole("button", { name: /Original/ }))

    expect(useYouTubeStore.getState().selectedAudioMode).toBe("original")
  })
})
