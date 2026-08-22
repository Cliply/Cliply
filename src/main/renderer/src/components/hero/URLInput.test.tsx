// @vitest-environment jsdom
//
// every other control in the action bar takes `disabled={isLoading}`, but the
// platform picker is a plain div, so it never got the guard. switching platform
// mid-flight resets every store underneath an in-flight fetch, whose late
// resolve then writes into the store that was just cleared.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useForm } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useAppStore } from "@/lib/store"
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
  const platform = (id: string, reset: () => void) => ({
    id,
    label: id,
    logo: `./${id}-logo.svg`,
    placeholder: `paste a ${id} url`,
    helperText: "helper",
    loadingText: "working",
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

function Harness({ isLoading }: { isLoading: boolean }) {
  const form = useForm<{ url: string }>({
    defaultValues: { url: "https://youtu.be/aqz-KE-bpKQ" }
  })

  return (
    <URLInput
      form={form}
      onFocusChange={() => {}}
      isLoading={isLoading}
      platform="youtube"
    />
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
