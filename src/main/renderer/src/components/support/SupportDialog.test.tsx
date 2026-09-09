// @vitest-environment jsdom
//
// the coffee ask, and the two things that make it tolerable: it only appears
// when main says so, and declining is a real button rather than a greyed-out
// afterthought.

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useLocale } from "@/lib/i18n"

const openExternal = vi.fn(async () => true)
vi.mock("@/lib/api", () => ({
  systemApi: { openExternal: (...a: unknown[]) => openExternal(...(a as [])) }
}))

type Listener = (data: { count: number }) => void

let listener: Listener | null = null
const off = vi.fn()

beforeEach(() => {
  listener = null
  off.mockClear()
  openExternal.mockClear()
  // @ts-expect-error - the preload bridge, as the renderer sees it
  window.electronAPI = {
    support: {
      onMilestone: (cb: Listener) => {
        listener = cb
        return off
      }
    }
  }
})

afterEach(() => {
  cleanup()
  useLocale.setState({ locale: "en" })
})

async function mount() {
  const { SupportDialog } = await import("./SupportDialog")
  render(<SupportDialog />)
}

describe("SupportDialog", () => {
  // the important one: it is silent for every download that is not a milestone,
  // which is almost all of them
  test("shows nothing until main says a milestone was reached", async () => {
    await mount()

    expect(screen.queryByText(/buy me a coffee/i)).toBeNull()
  })

  test("opens with the count main sent", async () => {
    await mount()

    listener?.({ count: 15 })

    await waitFor(() =>
      expect(screen.getByText(/that's 15 downloads/i)).toBeTruthy()
    )
  })

  test("makes the ask once, in one line", async () => {
    await mount()
    listener?.({ count: 5 })

    await waitFor(() =>
      expect(screen.getByText(/a coffee helps/i)).toBeTruthy()
    )
    // the ask no longer explains itself. one that does sounds like it expects
    // to be turned down, and the cadence already keeps the promise the words
    // were making
    expect(screen.queryByText(/won't keep asking/i)).toBeNull()
  })

  test("declining is a real button, and closes it", async () => {
    await mount()
    listener?.({ count: 5 })

    await waitFor(() => expect(screen.getByText("no thanks")).toBeTruthy())
    screen.getByText("no thanks").click()

    await waitFor(() => expect(screen.queryByText("no thanks")).toBeNull())
    // declining must not quietly open a payment page
    expect(openExternal).not.toHaveBeenCalled()
  })

  test("accepting opens the link and closes", async () => {
    await mount()
    listener?.({ count: 40 })

    await waitFor(() => expect(screen.getByText("buy me a coffee")).toBeTruthy())
    screen.getByText("buy me a coffee").click()

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://buymeacoffee.com/itssdevk"
      )
    )
    await waitFor(() => expect(screen.queryByText("no thanks")).toBeNull())
  })

  // an ask nobody can read is worse than no ask: declining has to stay the
  // plain word it is in english, and russian picks its plural for the count
  test("declining is a real button in russian too", async () => {
    useLocale.setState({ locale: "ru" })
    await mount()
    listener?.({ count: 5 })

    await waitFor(() => expect(screen.getByText("нет, спасибо")).toBeTruthy())
    expect(screen.getByText("это уже 5 загрузок")).toBeTruthy()
  })

  // a build whose preload predates the support bridge must still render the app
  test("mounts against a preload that has no support bridge", async () => {
    // @ts-expect-error - deliberately the older shape
    window.electronAPI = { download: {} }

    await expect(mount()).resolves.not.toThrow()
  })
})
