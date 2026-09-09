// @vitest-environment jsdom
//
// the playlist quality menu is the one place this feature deliberately does
// *not* show the user real numbers. a flat listing carries no formats, so a
// derived menu would have to make them up from one video's ladder, and a
// playlist whose first item is a 4K trailer would then promise 4K for a
// hundred 480p clips. what is under test is that the six fixed rows are what
// they claim to be, and that the copy under them does not over-promise.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { usePlaylistStore } from "@/lib/playlistStore"
import { PlaylistCeilingDropdown } from "./PlaylistCeilingDropdown"

const openMenu = () => fireEvent.click(screen.getAllByRole("button")[0])
const rows = () => screen.getAllByRole("button").slice(1)

beforeEach(() => usePlaylistStore.getState().reset())
afterEach(cleanup)

describe("the six rows", () => {
  test("are the six ceilings, in order, with no sizes and no fps", () => {
    render(<PlaylistCeilingDropdown />)
    openMenu()

    expect(rows().map((row) => row.textContent)).toEqual([
      "Up to 4KMP4",
      "Up to 1440pMP4",
      "Up to 1080pMP4",
      "Up to 720pMP4",
      "Up to 480pMP4",
      "Up to 360pMP4"
    ])
  })

  test("promise no byte count, because the listing carries none", () => {
    render(<PlaylistCeilingDropdown />)
    openMenu()

    const menu = rows().map((row) => row.textContent).join(" ")

    expect(menu).not.toMatch(/\bMB\b/)
    expect(menu).not.toMatch(/\bGB\b/)
    expect(menu).not.toMatch(/fps/)
  })

  test("offer one container and no choice about it", () => {
    render(<PlaylistCeilingDropdown />)
    openMenu()

    expect(rows().filter((row) => row.textContent?.includes("MP4"))).toHaveLength(6)
    expect(screen.queryByText(/MKV/)).toBeNull()
  })
})

describe("the default", () => {
  test("opens on 1080p, which is what the store starts on", () => {
    render(<PlaylistCeilingDropdown />)

    expect(usePlaylistStore.getState().selectedCeiling).toBe(1080)
    expect(screen.getAllByRole("button")[0].textContent).toContain("Up to 1080p")
  })

  test("a click sends the height that row promised", () => {
    render(<PlaylistCeilingDropdown />)
    openMenu()

    fireEvent.click(screen.getByRole("button", { name: /Up to 4K/ }))

    expect(usePlaylistStore.getState().selectedCeiling).toBe(2160)
  })

  test("every row sends its own height and nothing else", () => {
    render(<PlaylistCeilingDropdown />)

    for (const [label, height] of [
      [/Up to 1440p/, 1440],
      [/Up to 720p/, 720],
      [/Up to 480p/, 480],
      [/Up to 360p/, 360]
    ] as const) {
      openMenu()
      fireEvent.click(screen.getByRole("button", { name: label }))
      expect(usePlaylistStore.getState().selectedCeiling).toBe(height)
    }
  })

  /**
   * the menu is fixed rather than derived, so unlike the single-video one it
   * has no defaulting effect and nothing to re-apply. a selection made under
   * one playlist is still a legal selection under the next
   */
  test("survives a new playlist, because every playlist offers the same six", () => {
    const { rerender } = render(<PlaylistCeilingDropdown />)
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: /Up to 480p/ }))

    rerender(<PlaylistCeilingDropdown />)

    expect(usePlaylistStore.getState().selectedCeiling).toBe(480)
    expect(screen.getAllByRole("button")[0].textContent).toContain("Up to 480p")
  })
})

/**
 * `-S res:N` is a *preference*, not a hard ceiling: it takes the largest
 * stream at or below N, and the smallest one available when the video has
 * nothing that small. so "never above 1080p" is a promise the flag does not
 * keep, and a 608x1080 portrait Short really does come down under `res:720`
 * and land with 1080p in its name.
 */
describe("the helper copy", () => {
  test("says what happens rather than promising a hard limit", () => {
    render(<PlaylistCeilingDropdown />)

    const helper = screen.getByText(/Each video is saved at its best quality/)

    expect(helper.textContent).toContain("up to 1080p")
    expect(helper.textContent).toContain("nothing that small is saved at its smallest")
    expect(helper.textContent).toContain("filename shows the height")
    expect(helper.textContent).not.toMatch(/never above/i)
  })

  test("follows the ceiling that is actually selected", () => {
    render(<PlaylistCeilingDropdown />)
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: /Up to 4K/ }))

    expect(
      screen.getByText(/Each video is saved at its best quality/).textContent
    ).toContain("up to 4K")
  })

  test("uses no em-dash", () => {
    render(<PlaylistCeilingDropdown />)
    openMenu()

    expect(document.body.textContent).not.toContain("—")
  })
})
