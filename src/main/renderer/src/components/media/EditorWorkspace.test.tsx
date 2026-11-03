// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import MediaPage from "@/pages/MediaPage"
import { mediaApi } from "@/lib/api"
import { en } from "@/lib/i18n/en"
import { useLocale } from "@/lib/i18n"
import type { MediaSource } from "@/lib/local-media-types"
import { useLocalMedia } from "@/lib/stores/localMediaStore"
import { useLocalExport } from "@/lib/stores/localExportStore"

vi.mock("@/lib/api", () => ({ mediaApi: { getState: vi.fn(), preview: vi.fn(), releasePreview: vi.fn() } }))
vi.mock("@/components/ui/mode-toggle", () => ({ ModeToggle: () => <button>Theme</button> }))
const source = {
  schemaVersion: 1, sourceId: "11111111-1111-4111-8111-111111111111", filename: "workspace.mp4", bytes: 1024,
  duration: 5, formatNames: ["mp4"], streams: [
    { index: 0, type: "video", codec: "h264", language: "und", disposition: {} },
    { index: 1, type: "audio", codec: "aac", language: "eng", disposition: {} }
  ], chapterCount: 0
} as MediaSource

beforeEach(() => {
  vi.clearAllMocks()
  useLocale.setState({ locale: "en" })
  useLocalMedia.setState({ source, busy: false, error: null, position: 2 })
  useLocalExport.setState({ action: "trim", snapshot: { revision: -1, preparing: false, plan: null, job: null, recoveryError: null }, pending: false, timingPending: false, error: null, trimTiming: null })
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {})
  vi.mocked(mediaApi.getState).mockResolvedValue({ source, busy: false })
  vi.mocked(mediaApi.preview).mockResolvedValue({ sourceId: source.sourceId, previewId: "a".repeat(64), url: "cliply-media://source/test", mime: "video/mp4", expiresAt: Date.now() + 100000 })
  vi.mocked(mediaApi.releasePreview).mockResolvedValue({ released: true })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test("switching tools keeps the same preview element and restores the cut inspector", async () => {
  render(<MemoryRouter><MediaPage /></MemoryRouter>)
  const player = screen.getByLabelText(en["media.player"])
  await waitFor(() => expect(player.getAttribute("src")).toBe("cliply-media://source/test"))
  const inspector = screen.getByRole("complementary", { name: en["media.inspector"] })
  expect(within(inspector).getByRole("button", { name: en["media.reviewCut"] })).toBeTruthy()
  for (const key of ["media.extract", "media.remove", "media.remux", "media.trim"] as const) {
    fireEvent.click(within(screen.getByRole("navigation", { name: en["media.tools"] })).getByRole("button", { name: en[key] }))
    expect(screen.getByLabelText(en["media.player"])).toBe(player)
    expect(useLocalMedia.getState().position).toBe(2)
  }
  expect(within(inspector).getByRole("button", { name: en["media.reviewCut"] })).toBeTruthy()
  expect(mediaApi.preview).toHaveBeenCalledTimes(1)
  expect(mediaApi.releasePreview).not.toHaveBeenCalled()
})

test("separator arrow keys do not seek and export locks keep tools and source actions disabled", async () => {
  render(<MemoryRouter><MediaPage /></MemoryRouter>)
  const separator = screen.getByRole("separator", { name: en["media.resizeInspector"] })
  // Vitest resolves the library's node export, which omits browser resizing.
  // The native smoke checks resizing; this guards the editor's global shortcut.
  fireEvent.keyDown(separator, { key: "ArrowLeft" })
  expect(useLocalMedia.getState().position).toBe(2)
  act(() => useLocalExport.setState({ pending: true }))
  for (const button of within(screen.getByRole("navigation", { name: en["media.tools"] })).getAllByRole("button")) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
  }
  expect((screen.getByRole("button", { name: en["media.change"] }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: en["media.close"] }) as HTMLButtonElement).disabled).toBe(true)
})
