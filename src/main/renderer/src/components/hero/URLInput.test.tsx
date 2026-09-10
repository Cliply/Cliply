// @vitest-environment jsdom
//
// every other control in the action bar takes `disabled={isLoading}`, but the
// platform picker is a plain div, so it never got the guard. switching platform
// mid-flight resets every store underneath an in-flight fetch, whose late
// resolve then writes into the store that was just cleared.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useForm } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { en } from "@/lib/i18n/en"
import { DEMO_PLAYLIST_URL } from "@/lib/playlistView"
import { useAppStore, type Platform } from "@/lib/store"
import { URLInput } from "./URLInput"

const mocks = vi.hoisted(() => ({
  selectFolder: vi.fn(),
  resetYouTube: vi.fn(),
  resetPinterest: vi.fn(),
  resetTikTok: vi.fn()
}))

vi.mock("@/lib/hooks/useDownloadPath", () => ({
  useDownloadPath: () => ({ selectFolder: mocks.selectFolder, isLoading: false })
}))

vi.mock("@/lib/platform-config", () => {
  // the real translation keys, so the assertions below read the copy a user
  // sees rather than a label this file made up. which key each platform points
  // at is the registry's own business, and the last test here asks the real one
  const platform = (id: string, reset: () => void) => ({
    id,
    label: id,
    logo: `./${id}-logo.svg`,
    placeholder:
      id === "youtube" ? "url.youtubePlaceholder" : "url.placeholder",
    helperText: `url.${id}Helper`,
    loadingText: "url.loading",
    store: { reset }
  })

  const PLATFORM_REGISTRY = {
    youtube: platform("youtube", mocks.resetYouTube),
    pinterest: platform("pinterest", mocks.resetPinterest),
    tiktok: platform("tiktok", mocks.resetTikTok)
  }

  return {
    PLATFORM_REGISTRY,
    PLATFORM_LIST: Object.values(PLATFORM_REGISTRY).map((p) => ({
      id: p.id,
      label: p.label,
      logo: p.logo
    }))
  }
})

// wrapped in the form SearchCard puts around it, so a control that submits when
// it should not has something to submit
function Harness({
  isLoading,
  platform = "youtube",
  onSubmit = () => {}
}: {
  isLoading: boolean
  platform?: Platform
  onSubmit?: () => void
}) {
  const form = useForm<{ url: string }>({
    defaultValues: { url: "https://youtu.be/aqz-KE-bpKQ" }
  })

  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <URLInput
        form={form}
        onFocusChange={() => {}}
        isLoading={isLoading}
        platform={platform}
      />
    </form>
  )
}

const pickerState = () =>
  screen.getByTestId("platform-picker").getAttribute("data-state")

const openPicker = () =>
  fireEvent.click(screen.getByTestId("platform-picker-trigger"))

// the row div and its span both carry the label as text content
const platformOption = (label: string) =>
  screen.getByText(label, { selector: "span" })

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ selectedPlatform: "youtube", showMediaDetails: false })
})

// this project runs vitest without globals, so RTL's auto-cleanup never registers
afterEach(cleanup)

describe("platform picker while a url is being processed", () => {
  test("the list cannot be opened", () => {
    render(<Harness isLoading />)

    openPicker()

    expect(pickerState()).toBe("closed")
  })

  test("a platform cannot be selected", () => {
    render(<Harness isLoading />)

    fireEvent.click(platformOption("pinterest"))

    expect(useAppStore.getState().selectedPlatform).toBe("youtube")
    expect(mocks.resetYouTube).not.toHaveBeenCalled()
    expect(mocks.resetPinterest).not.toHaveBeenCalled()
  })

  test("an already-open list collapses when processing starts", () => {
    const { rerender } = render(<Harness isLoading={false} />)

    openPicker()
    expect(pickerState()).toBe("open")

    rerender(<Harness isLoading />)

    expect(pickerState()).toBe("closed")
  })
})

/**
 * telling somebody playlists exist is half of it. the other half is the link
 * under the box, which hands them one to try rather than leaving them to go and
 * find a playlist before they can see the feature at all.
 */
describe("the playlist link in the helper line", () => {
  const playlistLink = () =>
    screen.getByRole("button", { name: en["url.youtubeHelperPlaylists"] })

  const box = () => screen.getByRole("textbox") as HTMLInputElement

  test("sits inside youtube's sentence, whole", () => {
    render(<Harness isLoading={false} />)

    expect(screen.getByText(en["url.youtubeHelper"], { exact: false })).toBeTruthy()
    expect(playlistLink()).toBeTruthy()
    expect(screen.getByText(en["url.youtubeHelperRest"], { exact: false })).toBeTruthy()
  })

  test("keeps a focus ring for the keyboard", () => {
    // the mouse never sees the browser's outline and the keyboard must see
    // something: dropping the outline without a focus-visible replacement
    // leaves a tab stop nobody can find
    render(<Harness isLoading={false} />)

    const className = playlistLink().className
    expect(className).toContain("focus:outline-none")
    expect(className).toMatch(/focus-visible:ring/)
  })

  // pinterest and tiktok have no playlists to offer, so their lines are the one
  // sentence they always were
  test.each([["pinterest"], ["tiktok"]] as const)(
    "is absent for %s",
    (platform) => {
      render(<Harness isLoading={false} platform={platform} />)

      expect(
        screen.queryByRole("button", {
          name: en["url.youtubeHelperPlaylists"]
        })
      ).toBeNull()
    }
  )

  test("fills the box with the demo playlist and focuses it", () => {
    render(<Harness isLoading={false} />)

    fireEvent.click(playlistLink())

    expect(box().value).toBe(DEMO_PLAYLIST_URL)
    expect(document.activeElement).toBe(box())
  })

  // the click offers a link, it does not spend a lookup on somebody's behalf:
  // the user reads it and presses Enter, the same as any link they pasted
  test("does not submit the form", () => {
    const onSubmit = vi.fn()
    render(<Harness isLoading={false} onSubmit={onSubmit} />)

    fireEvent.click(playlistLink())

    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe("the box's placeholder", () => {
  test("says youtube takes a playlist too", () => {
    render(<Harness isLoading={false} />)

    expect(
      screen.getByPlaceholderText(en["url.youtubePlaceholder"])
    ).toBeTruthy()
  })

  test.each([["pinterest"], ["tiktok"]] as const)(
    "keeps the shared line for %s",
    (platform) => {
      render(<Harness isLoading={false} platform={platform} />)

      expect(screen.getByPlaceholderText(en["url.placeholder"])).toBeTruthy()
    }
  )

  // the mock above says which key each platform points at, so on its own it
  // would only ever agree with itself. this is the registry the app ships
  test("is the registry's own choice, not this file's", async () => {
    const { PLATFORM_REGISTRY } = await vi.importActual<
      typeof import("@/lib/platform-config")
    >("@/lib/platform-config")

    expect(PLATFORM_REGISTRY.youtube.placeholder).toBe("url.youtubePlaceholder")
    expect(PLATFORM_REGISTRY.pinterest.placeholder).toBe("url.placeholder")
    expect(PLATFORM_REGISTRY.tiktok.placeholder).toBe("url.placeholder")
  })
})

describe("platform picker while idle", () => {
  test("opens on click", () => {
    render(<Harness isLoading={false} />)

    openPicker()

    expect(pickerState()).toBe("open")
  })

  test("selects a platform and clears the previous platform's state", () => {
    render(<Harness isLoading={false} />)

    fireEvent.click(platformOption("pinterest"))

    expect(useAppStore.getState().selectedPlatform).toBe("pinterest")
    expect(useAppStore.getState().showMediaDetails).toBe(false)
    expect(mocks.resetYouTube).toHaveBeenCalled()
    expect(mocks.resetPinterest).toHaveBeenCalled()
    expect(pickerState()).toBe("closed")
  })
})
