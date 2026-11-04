// @vitest-environment jsdom
import { PLATFORM_REGISTRY } from "@/lib/platform-config"
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen
} from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { InstagramDetailsCard } from "./InstagramDetailsCard"
import { InstagramThumbnail } from "./InstagramThumbnail"
import { UnifiedDownloadCard } from "@/components/video/UnifiedDownloadCard"
import { useMediaSearch } from "@/lib/hooks/useMediaSearch"
import { useInstagramStore } from "@/lib/stores/instagramStore"
import { usePinterestStore } from "@/lib/stores/pinterestStore"
import { useDownloadsStore } from "@/lib/stores/downloadsStore"
import { useAppStore } from "@/lib/stores/store"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { ruErrors, ruInstagramErrors } from "@/lib/i18n/ru"

const mocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({
  toast: { error: mocks.error, success: mocks.success }
}))
const url = "https://www.instagram.com/reel/Example/?igsh=shared"
const info = {
  title: "Example Reel",
  uploader: "Example creator",
  duration: 0,
  duration_string: "00:00",
  thumbnail: null
}
const getInfo = vi.fn()
const download = vi.fn()
const track = vi.fn()
const cancel = vi.fn()
const openExternal = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useInstagramStore.getState().reset()
  usePinterestStore.getState().reset()
  useDownloadsStore.getState().reset()
  useAppStore.getState().setShowMediaDetails(false)
  useLocale.getState().setLocale("en")
  getInfo.mockResolvedValue({ success: true, data: info })
  download.mockImplementation(async (request) => ({
    success: true,
    data: { download_id: request.download_id, status: "started", type: "video" }
  }))
  track.mockResolvedValue({ success: true })
  openExternal.mockResolvedValue({ success: true })
  cancel.mockResolvedValue({ success: true, data: { cancelled: true } })
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: {
      instagram: { getInfo, download },
      analytics: { track },
      download: { cancel },
      system: { openExternal }
    }
  })
})
afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

test("search uses Instagram state and bridge and sends only summary analytics", async () => {
  const { result } = renderHook(() => useMediaSearch("instagram"))
  await act(async () => {
    await result.current.onSubmit({ url })
  })
  expect(getInfo).toHaveBeenCalledWith(url)
  expect(useInstagramStore.getState()).toMatchObject({ url, info })
  expect(usePinterestStore.getState().info).toBeNull()
  expect(useAppStore.getState().showMediaDetails).toBe(true)
  expect(result.current.form.getValues("url")).toBe(url)
  expect(track).toHaveBeenCalledWith("media_info_loaded", {
    platform: "instagram"
  })
  expect(JSON.stringify(track.mock.calls)).not.toContain(url)
  expect(JSON.stringify(track.mock.calls)).not.toContain(info.title)
  act(() => {
    result.current.handleClear()
  })
  expect(useInstagramStore.getState().info).toBeNull()
})

test.each([undefined, null, 0])(
  "missing duration (%s) never displays 00:00 or format options",
  (duration) => {
    const metadata = { ...info, duration }
    render(
      <>
        <InstagramDetailsCard videoInfo={metadata} />
        <UnifiedDownloadCard platform="instagram" instagramInfo={metadata} />
      </>
    )
    expect(screen.getAllByText(/Unknown duration/)).toHaveLength(2)
    expect(screen.queryByText(/00:00/)).toBeNull()
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(
      screen.getByRole("button", { name: en["download.video"] })
    ).toBeTruthy()
  }
)

test("download keeps Instagram identity, best quality analytics and pending cancellation", async () => {
  useInstagramStore.getState().setUrl(url)
  download.mockImplementation(async (request) => {
    useDownloadsStore.getState().rememberCancelIntent(request.download_id)
    return {
      success: true,
      data: {
        download_id: request.download_id,
        status: "started",
        type: "video"
      }
    }
  })
  render(<UnifiedDownloadCard platform="instagram" instagramInfo={info} />)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en["download.video"] }))
  })
  const row = useDownloadsStore.getState().rows[0]
  expect(row).toMatchObject({
    kind: "simple",
    platform: "instagram",
    label: "instagram",
    status: "starting"
  })
  expect(download).toHaveBeenCalledWith({
    url,
    title: info.title,
    download_id: row.downloadId
  })
  expect(cancel).toHaveBeenCalledWith(row.downloadId)
  expect(track).toHaveBeenCalledWith("download_started", {
    platform: "instagram",
    media_type: "video",
    quality: "best_available",
    is_trimmed: false
  })
  expect(mocks.success).not.toHaveBeenCalled()
})

test.each([
  "LOGIN_REQUIRED",
  "UNSUPPORTED_COLLECTION",
  "NOT_A_VIDEO",
  "RATE_LIMITED",
  "EXTRACTION_FAILED"
])("%s shows localized advice without a cookies action", async (category) => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  useLocale.getState().setLocale("ru")
  getInfo.mockResolvedValue({
    success: false,
    error: { message: "Instagram rejected this request", category }
  })
  const { result } = renderHook(() => useMediaSearch("instagram"))
  await act(async () => {
    await result.current.onSubmit({ url })
  })
  expect(mocks.error).toHaveBeenCalledWith(expect.any(String), {
    description: (ruInstagramErrors[category] ?? ruErrors[category])!.message
  })
  expect(useInstagramStore.getState().info).toBeNull()
  expect(useAppStore.getState().showMediaDetails).toBe(false)
  vi.restoreAllMocks()
})

test.each(["RATE_LIMITED", "EXTRACTION_FAILED"])(
  "download admission localizes %s for Instagram",
  async (category) => {
    useLocale.getState().setLocale("ru")
    useInstagramStore.getState().setUrl(url)
    download.mockResolvedValue({
      success: false,
      error: { message: "Instagram failure", category }
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(<UnifiedDownloadCard platform="instagram" instagramInfo={info} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button"))
    })
    expect(mocks.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: ruInstagramErrors[category]!.message
      })
    )
    vi.restoreAllMocks()
  }
)

test.each([
  [undefined, null],
  [null, null],
  [0, null],
  [-1, null],
  [35, 35]
])(
  "registry normalizes duration %s before analytics",
  async (duration, expected) => {
    getInfo.mockResolvedValue({ success: true, data: { ...info, duration } })
    expect(await PLATFORM_REGISTRY.instagram.fetchAndStore(url)).toEqual({
      durationSeconds: expected,
      formatsCount: null
    })
  }
)

test.each([
  [
    "  www.instagram.com/reel/Example/?igsh=shared  ",
    "https://www.instagram.com/reel/Example/?igsh=shared"
  ],
  [
    "  https://www.instagram.com/reel/Example/?igsh=shared  ",
    "https://www.instagram.com/reel/Example/?igsh=shared"
  ]
])(
  "View on Instagram opens a normalized link from %s",
  async (videoUrl, expected) => {
    render(
      <InstagramThumbnail
        thumbnailUrl={null}
        videoUrl={videoUrl}
        title="Example Reel"
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "View on Instagram" }))
    })
    expect(openExternal).toHaveBeenCalledWith(expected)
    expect(mocks.error).not.toHaveBeenCalled()
  }
)

function pendingInfo() {
  let resolve!: (response: object) => void
  const promise = new Promise<object>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("a failed replacement preserves the last successful URL and metadata while pending and afterward", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const { result } = renderHook(() => useMediaSearch("instagram"))
  await act(async () => {
    await result.current.onSubmit({ url })
  })
  const replacement = pendingInfo()
  getInfo.mockReturnValueOnce(replacement.promise)
  let pending!: Promise<void>
  act(() => {
    pending = result.current.onSubmit({
      url: "https://instagram.com/reel/Other/"
    })
  })
  expect(useInstagramStore.getState()).toMatchObject({
    url,
    info,
    isLoadingInfo: true
  })
  await act(async () => {
    replacement.resolve({
      success: false,
      error: {
        message: "Instagram requires sign-in",
        category: "LOGIN_REQUIRED"
      }
    })
    await pending
  })
  expect(useInstagramStore.getState()).toMatchObject({
    url,
    info,
    isLoadingInfo: false
  })
  expect(useAppStore.getState().showMediaDetails).toBe(true)
  vi.restoreAllMocks()
})

test("Clear invalidates a pending lookup without reviving its details or success notification", async () => {
  const response = pendingInfo()
  getInfo.mockReturnValueOnce(response.promise)
  const { result } = renderHook(() => useMediaSearch("instagram"))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.onSubmit({ url })
  })
  act(() => {
    result.current.handleClear()
  })
  await act(async () => {
    response.resolve({ success: true, data: info })
    await pending
  })
  expect(useInstagramStore.getState()).toMatchObject({
    url: "",
    info: null,
    isLoadingInfo: false
  })
  expect(useAppStore.getState().showMediaDetails).toBe(false)
  expect(mocks.success).not.toHaveBeenCalled()
  expect(track.mock.calls.map(([name]) => name)).toEqual(["url_submitted"])
})

test.each([true, false])(
  "a superseded lookup (success=%s) cannot settle a newer lookup's spinner or notifications",
  async (success) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const first = pendingInfo()
    const second = pendingInfo()
    getInfo
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useMediaSearch("instagram"))
    let oldLookup!: Promise<void>
    let newLookup!: Promise<void>
    act(() => {
      oldLookup = result.current.onSubmit({ url })
    })
    act(() => {
      result.current.handleClear()
    })
    const nextUrl = "https://instagram.com/reel/New/"
    act(() => {
      newLookup = result.current.onSubmit({ url: nextUrl })
    })
    await act(async () => {
      first.resolve(
        success
          ? { success: true, data: info }
          : {
              success: false,
              error: { message: "Old failure", category: "RATE_LIMITED" }
            }
      )
      await oldLookup
    })
    expect(useInstagramStore.getState()).toMatchObject({
      info: null,
      isLoadingInfo: true
    })
    expect(mocks.success).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(track.mock.calls.map(([name]) => name)).toEqual([
      "url_submitted",
      "url_submitted"
    ])
    const nextInfo = { ...info, title: "New Reel" }
    await act(async () => {
      second.resolve({ success: true, data: nextInfo })
      await newLookup
    })
    expect(useInstagramStore.getState()).toMatchObject({
      url: nextUrl,
      info: nextInfo,
      isLoadingInfo: false
    })
    expect(mocks.success).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  }
)

test("a new submission invalidates the previous response even without Clear", async () => {
  const first = pendingInfo()
  const second = pendingInfo()
  getInfo.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const { result } = renderHook(() => useMediaSearch("instagram"))
  let oldLookup!: Promise<void>
  let newLookup!: Promise<void>
  act(() => {
    oldLookup = result.current.onSubmit({ url })
  })
  const nextUrl = "https://instagram.com/reel/New/"
  act(() => {
    newLookup = result.current.onSubmit({ url: nextUrl })
  })
  const nextInfo = { ...info, title: "New Reel" }
  await act(async () => {
    second.resolve({ success: true, data: nextInfo })
    await newLookup
    first.resolve({ success: true, data: info })
    await oldLookup
  })
  expect(useInstagramStore.getState()).toMatchObject({
    url: nextUrl,
    info: nextInfo,
    isLoadingInfo: false
  })
  expect(mocks.success).toHaveBeenCalledTimes(1)
})

test("search and remounted download cards use the same canonical URL as main snapshots", async () => {
  const input =
    "  WWW.Instagram.COM/reel/Example/?caption=hello world&symbol=é  "
  const canonical =
    "https://www.instagram.com/reel/Example/?caption=hello%20world&symbol=%C3%A9"
  const { result } = renderHook(() => useMediaSearch("instagram"))
  await act(async () => {
    await result.current.onSubmit({ url: input })
  })
  expect(getInfo).toHaveBeenCalledWith(canonical)
  expect(useInstagramStore.getState()).toMatchObject({ url: canonical, info })
  const firstCard = render(
    <UnifiedDownloadCard platform="instagram" instagramInfo={info} />
  )
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en["download.video"] }))
  })
  const id = useDownloadsStore.getState().rows[0].downloadId
  expect(download).toHaveBeenCalledWith({
    url: canonical,
    title: info.title,
    download_id: id
  })
  firstCard.unmount()
  act(() => {
    useDownloadsStore.getState().applySnapshot({
      seq: 1,
      lifetimeCompleted: 0,
      rows: [
        {
          download_id: id,
          kind: "simple",
          platform: "instagram",
          label: "instagram",
          status: "downloading",
          started_at: 1,
          request: { url: canonical, title: info.title, platform: "instagram" }
        }
      ]
    })
    // A legacy/raw candidate also has to match the canonical snapshot.
    useInstagramStore.getState().setUrl(input)
  })
  render(<UnifiedDownloadCard platform="instagram" instagramInfo={info} />)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: en["download.video"] }))
  })
  expect(download).toHaveBeenCalledTimes(1)
  expect(useDownloadsStore.getState()).toMatchObject({
    highlightedId: id,
    panelOpen: true
  })
})
