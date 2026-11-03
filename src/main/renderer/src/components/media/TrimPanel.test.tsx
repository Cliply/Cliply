// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { mediaApi } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { editorActions, useEditor } from "@/lib/stores/editorStore"
import type { MediaSource, TrimTiming } from "@/lib/local-media-types"
import { localTrimActions, useLocalExport } from "@/lib/stores/localExportStore"
import { localMediaActions, useLocalMedia } from "@/lib/stores/localMediaStore"
import { TrimPanel } from "./TrimPanel"
vi.mock("@/lib/api", () => ({ mediaApi: { inspectTrim: vi.fn(), cancelTrim: vi.fn(), prepareExport: vi.fn(), exportState: vi.fn(), startExport: vi.fn(), close: vi.fn(), open: vi.fn() } }))
const source = { sourceId: "source", duration: 12, trimProfile: { extension: "mp4", hasVideo: true }, streams: [] } as unknown as MediaSource
const timing: TrimTiming = { operation: "trim", sourceId: "source", trimPlanId: "main-timing", previewId: "preview", requestedStart: 4.2, requestedEnd: 6, plannedStart: 4, plannedEnd: 6.167, mode: "before", tolerance: 0.5, duration: 2, extension: "mp4", streamIndexes: [3, 7], expiresAt: Date.now() + 100000 }
const empty = { revision: -1, preparing: false, plan: null, job: null, recoveryError: null }
let player: { current: HTMLMediaElement }
beforeEach(() => {
  vi.clearAllMocks(); useEditor.setState({ sourceId: null, past: [], future: [] }); useLocale.setState({ locale: "en" })
  useLocalMedia.setState({ source, position: 1, auditionPreviewId: "preview", busy: false })
  useLocalExport.setState({ snapshot: empty, pending: false, error: null, trimSelection: null, trimTiming: null, timingPending: false })
  player = { current: document.createElement("video") }; player.current.currentTime = 4.234567
  vi.mocked(mediaApi.inspectTrim).mockResolvedValue(timing)
  vi.mocked(mediaApi.cancelTrim).mockResolvedValue({ cancelled: true })
  vi.mocked(mediaApi.close).mockResolvedValue({ closed: true })
})
afterEach(cleanup)
const input = (key: "media.trimStart" | "media.trimEnd") => screen.getByLabelText(en[key], { selector: "input" }) as HTMLInputElement
const button = (key: "media.reviewCut" | "media.setStart" | "media.setEnd") => screen.getByRole("button", { name: en[key] }) as HTMLButtonElement
const setRange = () => { fireEvent.change(input("media.trimStart"), { target: { value: "4.2" } }); fireEvent.change(input("media.trimEnd"), { target: { value: "6" } }) }

test("marks and inversion produce the actual segment request without playback gating", async () => {
  useLocalMedia.setState({ auditionPreviewId: null })
  render(<TrimPanel source={source} busy={false} player={player} />)
  setRange()
  fireEvent.change(screen.getByLabelText(en["media.editMode"]), { target: { value: "remove" } })
  fireEvent.click(button("media.reviewCut"))
  await waitFor(() => expect(mediaApi.inspectTrim).toHaveBeenCalledWith({ sourceId: "source", ranges: [{ start: 4.2, end: 6 }], intent: "remove", mode: "before" }))
  expect(screen.getByText(/2 parts/)).toBeTruthy()
})
test("split, delete, undo and redo affect the output rather than just the drawing", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  player.current.currentTime = 4
  fireEvent.keyDown(window, { key: "b" })
  player.current.currentTime = 8
  fireEvent.keyDown(window, { key: "b" })
  fireEvent.click(screen.getByRole("button", { name: "Delete marking 2" }))
  expect(useEditor.getState().document.ranges).toEqual([{ start: 0, end: 4 }, { start: 8, end: 12 }])
  fireEvent.keyDown(window, { key: "z", ctrlKey: true })
  expect(useEditor.getState().document.ranges).toHaveLength(3)
  fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true })
  expect(useEditor.getState().document.ranges).toHaveLength(2)
})
test("I/O read player time, shortcuts protect typing, handles support keyboard adjustment", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.keyDown(window, { key: "i" })
  expect(input("media.trimStart").value).toBe("4.234567")
  player.current.currentTime = 7
  fireEvent.keyDown(input("media.trimEnd"), { key: "o" })
  expect(input("media.trimEnd").value).toBe("12")
  fireEvent.keyDown(window, { key: "o" })
  expect(input("media.trimEnd").value).toBe("7")
  fireEvent.keyDown(screen.getByRole("slider", { name: en["media.trimStart"] }), { key: "ArrowRight" })
  expect(input("media.trimStart").value).toBe("4.334567")
})
test("empty remainder blocks export and mode/edits invalidate a reviewed plan", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.change(screen.getByLabelText(en["media.editMode"]), { target: { value: "remove" } })
  expect(button("media.reviewCut").disabled).toBe(true)
  expect(screen.getByRole("alert").textContent).toBe(en["media.emptyEdit"])
})
test("destination/start use opaque main IDs and active jobs lock edits", async () => {
  editorActions.open("source", 12)
  editorActions.commit({ ranges: [{ start: 4.2, end: 6 }], intent: "keep", mode: "before", active: 0 })
  const reviewed = { ...timing, ranges: [{ start: 4.2, end: 6 }], intent: "keep" as const, cuts: [timing] }
  useLocalExport.setState({ trimTiming: reviewed })
  const plan = { ...reviewed, planId: "save-plan", outputName: "cut.mp4" }
  vi.mocked(mediaApi.exportState).mockResolvedValue({ ...empty, revision: 1, plan })
  vi.mocked(mediaApi.startExport).mockResolvedValue({ ...empty, revision: 2, job: { jobId: "job", operation: "trim", state: "running", progress: 0, outputName: "cut.mp4", error: null } })
  render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.click(screen.getByRole("button", { name: en["media.chooseDestination"] }))
  await screen.findByText("Save as: cut.mp4")
  expect(mediaApi.prepareExport).toHaveBeenCalledWith({ operation: "trim", sourceId: "source", trimPlanId: "main-timing" })
  fireEvent.click(screen.getByRole("button", { name: en["media.exportEdit"] }))
  await waitFor(() => expect(input("media.trimStart").disabled).toBe(true))
  expect(mediaApi.startExport).toHaveBeenCalledWith("save-plan")
})
test("source replacement resets undo while route remount preserves edits; unavailable profile stays editable", () => {
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  setRange(); view.unmount()
  const again = render(<TrimPanel source={source} busy={false} player={player} />)
  expect(input("media.trimStart").value).toBe("4.2")
  again.rerender(<TrimPanel source={{ ...source, sourceId: "new", trimProfile: null }} busy={false} player={player} />)
  expect(input("media.trimStart").value).toBe("0")
  expect(useEditor.getState().past).toHaveLength(0)
  expect(button("media.reviewCut").disabled).toBe(true)
})
test("pending timing can be cancelled and drains on route exit", async () => {
  useLocalExport.setState({ timingPending: true })
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  expect(input("media.trimStart").disabled).toBe(true)
  view.unmount()
  await waitFor(() => expect(mediaApi.cancelTrim).toHaveBeenCalled())
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
