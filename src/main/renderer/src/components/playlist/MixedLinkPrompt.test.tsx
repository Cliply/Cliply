// @vitest-environment jsdom
//
// the question a mixed link asks.
//
// its whole justification is that it names the playlist and its real size:
// "All 11 videos in Short talks to watch during your coffee break" is a
// decision somebody can make, and "All videos in the playlist" is not. so what
// is under test is that the number on the button is the honest one, that the
// video stays the default, and that closing the thing decides nothing.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistInfoResponse } from "@/lib/api"
import { useMixedLinkStore } from "@/lib/mixedLinkStore"
import { MixedLinkPrompt } from "./MixedLinkPrompt"

const listing = (
  overrides: Partial<PlaylistInfoResponse> = {}
): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "Short talks to watch during your coffee break",
  uploader: "TED",
  count: 11,
  listed: 11,
  truncated: false,
  entries: [],
  ...overrides
})

const ask = (info: PlaylistInfoResponse, choose = vi.fn()) => {
  useMixedLinkStore.getState().ask({ info, choose })
  return choose
}

const videoButton = () => screen.getByRole("button", { name: /just this video/i })
const playlistButton = () =>
  screen.getByRole("button", { name: /videos\s*Open the playlist/i })

beforeEach(() => useMixedLinkStore.getState().reset())
afterEach(cleanup)

describe("what it asks", () => {
  test("names the playlist and how many videos it holds", () => {
    ask(listing())
    render(<MixedLinkPrompt />)

    expect(screen.getByText("This link is part of a playlist")).toBeTruthy()
    expect(
      screen.getByText("Short talks to watch during your coffee break")
    ).toBeTruthy()
    expect(playlistButton().textContent).toContain("All 11 videos")
  })

  test("offers the video Cliply has always taken out of such a link", () => {
    ask(listing())
    render(<MixedLinkPrompt />)

    expect(videoButton()).toBeTruthy()
    // the default is the one the keyboard lands on, so Enter changes nothing
    expect(document.activeElement).toBe(videoButton())
  })

  /**
   * a link can hold five thousand videos and we list the first hundred. "All
   * 100 videos" over that is the small lie the header already refuses to tell,
   * and the button would be promising a download it will not make.
   */
  test("does not say all of a listing that is not all of it", () => {
    ask(listing({ count: 5283, listed: 100, truncated: true }))
    render(<MixedLinkPrompt />)

    const label = screen.getByRole("button", {
      name: /first 100 videos/i
    }).textContent

    expect(label).toContain("The first 100 videos")
    expect(label).not.toContain("All")
    expect(screen.getByRole("dialog").textContent).toContain(
      "Showing the first 100 of 5,283 videos"
    )
  })

  test("says nothing in an em-dash", () => {
    ask(listing({ count: 5283, listed: 100, truncated: true }))
    const { container } = render(<MixedLinkPrompt />)

    expect(container.ownerDocument.body.textContent).not.toContain("—")
  })

  test("is not there at all until there is something to ask about", () => {
    render(<MixedLinkPrompt />)

    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("what the answers do", () => {
  test("the video button answers with the video", () => {
    const choose = ask(listing())
    render(<MixedLinkPrompt />)

    fireEvent.click(videoButton())

    expect(choose).toHaveBeenCalledWith("video")
    expect(useMixedLinkStore.getState().question).toBeNull()
  })

  test("the playlist button answers with the playlist", () => {
    const choose = ask(listing())
    render(<MixedLinkPrompt />)

    fireEvent.click(playlistButton())

    expect(choose).toHaveBeenCalledWith("playlist")
    expect(useMixedLinkStore.getState().question).toBeNull()
  })

  // both answers move the app somewhere, so an Escape that picked one for you
  // would be a paste the user cannot take back
  test("closing it decides nothing", () => {
    const choose = ask(listing())
    render(<MixedLinkPrompt />)

    fireEvent.keyDown(document.body, { key: "Escape" })

    expect(choose).not.toHaveBeenCalled()
    expect(useMixedLinkStore.getState().question).toBeNull()
  })
})
