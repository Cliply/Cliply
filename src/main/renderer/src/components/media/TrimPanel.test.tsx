// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { mediaApi } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { ru } from "@/lib/i18n/ru"
import type { MediaSource, TrimTiming } from "@/lib/local-media-types"
import { localTrimActions, useLocalExport } from "@/lib/stores/localExportStore"
import { localMediaActions, useLocalMedia } from "@/lib/stores/localMediaStore"
import { TrimPanel, cutSeconds } from "./TrimPanel"
vi.mock("@/lib/api", () => ({ mediaApi: { inspectTrim: vi.fn(), cancelTrim: vi.fn(), prepareExport: vi.fn(), exportState: vi.fn(), startExport: vi.fn(), close: vi.fn(), open: vi.fn() } }))
const source = { sourceId: "source", duration: 12, trimProfile: { extension: "mp4", hasVideo: true }, streams: [] } as unknown as MediaSource
const timing: TrimTiming = { operation: "trim", sourceId: "source", trimPlanId: "main-timing", previewId: "preview", requestedStart: 4.2, requestedEnd: 6, plannedStart: 4, plannedEnd: 6.167, mode: "before", tolerance: 0.5, duration: 2, extension: "mp4", streamIndexes: [3, 7], expiresAt: Date.now() + 100000 }
const empty = { revision: -1, preparing: false, plan: null, job: null, recoveryError: null }
let player: { current: HTMLMediaElement }
beforeEach(() => {
  vi.clearAllMocks(); useLocale.setState({ locale: "en" })
  useLocalMedia.setState({ source, position: 1, auditionPreviewId: "preview", busy: false })
  useLocalExport.setState({ snapshot: empty, pending: false, error: null, trimSelection: null, trimTiming: null, timingPending: false })
  player = { current: document.createElement("video") }; player.current.currentTime = 4.234567
  vi.mocked(mediaApi.inspectTrim).mockResolvedValue(timing)
  vi.mocked(mediaApi.cancelTrim).mockResolvedValue({ cancelled: true })
  vi.mocked(mediaApi.close).mockResolvedValue({ closed: true })
})
afterEach(cleanup)
const input = (key: "media.trimStart" | "media.trimEnd") => screen.getByLabelText(en[key]) as HTMLInputElement
const button = (key: "media.reviewCut" | "media.setStart" | "media.setEnd") => screen.getByRole("button", { name: en[key] }) as HTMLButtonElement
const setRange = () => { fireEvent.change(input("media.trimStart"), { target: { value: "4.2" } }); fireEvent.change(input("media.trimEnd"), { target: { value: "6" } }) }

test("controlled fractional fields refuse incomplete, invalid and collapsed ranges before IPC", async () => {
  for (const value of ["", "-1", "NaN", "1e2", "1.0000001", " "]) expect(cutSeconds(value)).toBeNull()
  expect(cutSeconds(".125")).toBe(0.125)
  render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.change(input("media.trimStart"), { target: { value: "" } })
  expect(input("media.trimStart").value).toBe(""); expect(button("media.reviewCut").disabled).toBe(true)
  setRange(); fireEvent.click(button("media.reviewCut"))
  await screen.findByText(/Requested: 4.200/)
  expect(mediaApi.inspectTrim).toHaveBeenCalledWith({ sourceId: "source", previewId: "preview", start: 4.2, end: 6, mode: "before" })
  expect(screen.getByText(/Planned content: approximately 4.000/)).toBeTruthy()
  expect(screen.getByText(/#3, #7/)).toBeTruthy()
  fireEvent.change(input("media.trimEnd"), { target: { value: "4.21" } })
  expect(button("media.reviewCut").disabled).toBe(true)
  expect(screen.queryByRole("button", { name: en["media.chooseDestination"] })).toBeNull()
})
test("requires current native playback; expired/foreign timing never exposes save", () => {
  useLocalMedia.setState({ auditionPreviewId: null })
  useLocalExport.setState({ trimTiming: timing, trimSelection: { sourceId: "source", start: "4.2", end: "6", mode: "before" } })
  render(<TrimPanel source={source} busy={false} player={player} />)
  expect(screen.getByRole("alert").textContent).toBe(en["media.error.TRIM_PREVIEW"])
  expect(button("media.reviewCut").disabled).toBe(true)
  expect(screen.queryByRole("button", { name: en["media.chooseDestination"] })).toBeNull()
})
test("Set and shortcuts read actual player time without intercepting typing; seek is clamped", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.click(button("media.setStart")); expect(input("media.trimStart").value).toBe("4.234567")
  player.current.currentTime = 7.123456
  fireEvent.keyDown(input("media.trimEnd"), { key: "o" }); expect(input("media.trimEnd").value).toBe("12.000000")
  fireEvent.keyDown(window, { key: "o" }); expect(input("media.trimEnd").value).toBe("7.123456")
  fireEvent.keyDown(window, { key: "ArrowRight" }); expect(player.current.currentTime).toBe(12)
  fireEvent.keyDown(window, { key: "i", ctrlKey: true }); expect(input("media.trimStart").value).toBe("4.234567")
})
test("destination/start carry opaque main IDs; active job locks range and keeps it after completion", async () => {
  useLocalExport.setState({ trimTiming: timing, trimSelection: { sourceId: "source", start: "4.2", end: "6", mode: "before" } })
  const plan = { ...timing, planId: "save-plan", outputName: "cut.mp4" }
  vi.mocked(mediaApi.exportState).mockResolvedValue({ ...empty, revision: 1, plan })
  vi.mocked(mediaApi.startExport).mockResolvedValue({ ...empty, revision: 2, job: { jobId: "job", operation: "trim", state: "running", progress: 0, outputName: "cut.mp4", error: null } })
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.click(screen.getByRole("button", { name: en["media.chooseDestination"] }))
  await screen.findByText("Save as: cut.mp4")
  expect(mediaApi.prepareExport).toHaveBeenCalledWith({ operation: "trim", sourceId: "source", trimPlanId: "main-timing" })
  fireEvent.click(screen.getByRole("button", { name: en["media.saveClip"] }))
  await waitFor(() => expect(input("media.trimStart").disabled).toBe(true))
  expect(mediaApi.startExport).toHaveBeenCalledWith("save-plan")
  act(() => useLocalExport.setState({ snapshot: { ...empty, revision: 3 } }))
  view.unmount(); render(<TrimPanel source={source} busy={false} player={player} />)
  expect(input("media.trimStart").value).toBe("4.2"); expect(input("media.trimEnd").value).toBe("6")
})
test("pending inspection locks controls, offers cancel, and navigation drains it", async () => {
  useLocalExport.setState({ timingPending: true })
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  expect(input("media.trimStart").disabled).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: en["media.cancelTiming"] }))
  await waitFor(() => expect(mediaApi.cancelTrim).toHaveBeenCalledTimes(1))
  view.unmount(); expect(mediaApi.cancelTrim).toHaveBeenCalledTimes(2)
})
test("source changes and close reset the range, while unsupported profiles explain the limit in Russian", async () => {
  useLocalExport.setState({ trimSelection: { sourceId: "old", start: "4", end: "6", mode: "before" } })
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  expect(input("media.trimStart").value).toBe("0")
  await act(async () => { await localMediaActions.close() })
  expect(useLocalExport.getState().trimSelection).toBeNull()
  view.unmount(); useLocale.setState({ locale: "ru" })
  render(<TrimPanel source={{ ...source, trimProfile: null }} busy={false} player={player} />)
  expect(screen.getByRole("alert").textContent).toBe(ru["media.error.TRIM_PROFILE"])
})

test("closing or cancelling discards an already-returning timing reply", async () => {
  let resolve!: (value: TrimTiming) => void
  vi.mocked(mediaApi.inspectTrim).mockImplementation(() => new Promise(r => { resolve = r }))
  const checking = localTrimActions.inspect({ sourceId: "source", previewId: "preview", start: 4.2, end: 6, mode: "before" })
  await localMediaActions.close()
  resolve(timing); await checking
  expect(useLocalExport.getState().trimTiming).toBeNull()
  expect(useLocalExport.getState().timingPending).toBe(false)
})
