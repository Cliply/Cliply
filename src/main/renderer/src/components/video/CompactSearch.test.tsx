// @vitest-environment jsdom
//
// the second url box, the one on the details screen after a video has loaded.
//
// it shares `platform-config` and the zod schemas with the hero's input, and
// both of those now carry translation keys rather than sentences. this one was
// missed on the first pass and rendered `url.placeholder` at an english user,
// which is exactly the failure a shared contract produces: the surface that
// nobody edited is the one that breaks.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { en } from "@/lib/i18n/en"
import { ru } from "@/lib/i18n/ru"
import { useLocale } from "@/lib/i18n"
import { CompactSearch } from "./CompactSearch"

vi.mock("@/lib/api", () => ({
  DownloadError: class extends Error {},
  videoApi: { getVideoInfo: vi.fn() },
  pinterestApi: { getInfo: vi.fn() },
  tiktokApi: { getInfo: vi.fn() }
}))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))

afterEach(() => {
  cleanup()
  useLocale.setState({ locale: "en" })
})

const submit = (url: string) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: url } })
  fireEvent.submit(screen.getByRole("textbox"))
}

describe("the details-screen search box", () => {
  test("asks for a replacement link in words, not in a key", () => {
    render(<CompactSearch />)

    expect(
      screen.getByPlaceholderText(en["url.replacePlaceholder"])
    ).toBeTruthy()
  })

  test("rejects a bad link in words, not in a key", async () => {
    render(<CompactSearch />)

    submit("not a link")

    await waitFor(() =>
      expect(screen.getByText(en["validation.youtubeInvalid"])).toBeTruthy()
    )
  })

  test("says both in russian when the locale is russian", async () => {
    useLocale.setState({ locale: "ru" })
    render(<CompactSearch />)

    expect(
      screen.getByPlaceholderText(ru["url.replacePlaceholder"])
    ).toBeTruthy()

    submit("not a link")

    await waitFor(() =>
      expect(screen.getByText(ru["validation.youtubeInvalid"])).toBeTruthy()
    )
  })
})
