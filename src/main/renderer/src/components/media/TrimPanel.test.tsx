// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
  useLocalExport.setState({ snapshot: empty, pending: false, error: null, trimTiming: null, timingPending: false })
  player = { current: document.createElement("video") }; Object.defineProperty(player.current, "readyState", { value: 2 }); player.current.currentTime = 4.234567
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


test("splitting retains separate output sections and one timeline is mounted", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.keyDown(window, { key: "b" })
  expect(screen.getByText(/2 parts/)).toBeTruthy()
  expect(screen.getAllByTestId("cut-timeline")).toHaveLength(1)
})

test("dragging a handle updates the preview, commits one undo step and clamps to the other edge", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  const track = screen.getByTestId("cut-timeline")
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 100, width: 600 } as DOMRect)
  track.setPointerCapture = vi.fn(); track.releasePointerCapture = vi.fn(); track.hasPointerCapture = () => true
  const start = screen.getByRole("slider", { name: en["media.trimStart"] })
  fireEvent.pointerDown(start, { button: 0, pointerId: 1, clientX: 100 })
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 300 })
  expect(start.getAttribute("aria-valuenow")).toBe("4")
  expect(useEditor.getState().past).toHaveLength(0)
  fireEvent.pointerMove(track, { pointerId: 1, clientX: 800 })
  expect(start.getAttribute("aria-valuenow")).toBe("11.9")
  fireEvent.pointerUp(track, { pointerId: 1 })
  expect(useEditor.getState().document.ranges).toEqual([{ start: 11.9, end: 12 }])
  expect(useEditor.getState().past).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: en["media.undo"] }))
  expect(useEditor.getState().document.ranges).toEqual([{ start: 0, end: 12 }])
})

test("pointer selection seeks, cancelled drags preserve the edit, and zoom does not alter output", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  fireEvent.keyDown(window, { key: "b" })
  const before = useEditor.getState().document.ranges
  const track = screen.getByTestId("cut-timeline")
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, width: 600 } as DOMRect)
  track.setPointerCapture = vi.fn(); track.releasePointerCapture = vi.fn(); track.hasPointerCapture = () => true
  fireEvent.pointerDown(screen.getByRole("button", { name: "Section 1" }).firstChild!, { button: 0, pointerId: 1, clientX: 100 })
  expect(useEditor.getState().document.active).toBe(0)
  expect(useLocalMedia.getState().position).toBe(2)
  fireEvent.pointerUp(track, { pointerId: 1 })
  fireEvent.pointerDown(screen.getByRole("slider", { name: en["media.trimStart"] }), { button: 0, pointerId: 2 })
  fireEvent.pointerMove(track, { pointerId: 2, clientX: 50 })
  fireEvent.pointerCancel(track, { pointerId: 2 })
  expect(useEditor.getState().document.ranges).toEqual(before)
  fireEvent.click(screen.getByRole("button", { name: en["media.zoomIn"] }))
  expect(track.style.width).toBe("200%")
  expect(useEditor.getState().document.ranges).toEqual(before)
})


test("arrow seeking and shift-arrow boundaries use LosslessCut defaults", () => {
  Object.defineProperty(player.current, "duration", { value: 12 })
  render(<TrimPanel source={source} busy={false} player={player} />)
  player.current.currentTime = 5
  fireEvent.keyDown(window, { key: "ArrowRight" })
  expect(player.current.currentTime).toBe(6)
  fireEvent.keyDown(window, { key: "ArrowLeft" })
  expect(player.current.currentTime).toBe(5)
  fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true })
  expect(player.current.currentTime).toBe(0)
  fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true })
  expect(player.current.currentTime).toBe(12)
})

test("inspector can move beside the player without duplicating controls or resetting the edit", async () => {
  const inspector = document.createElement("aside")
  document.body.append(inspector)
  try {
    const view = render(<TrimPanel source={source} busy={false} player={player} inspectorTarget={inspector} />)
    setRange()
    expect(inspector.contains(screen.getByTestId("cut-inspector"))).toBe(true)
    expect(document.querySelector("#trim-panel")?.contains(input("media.trimStart"))).toBe(false)
    fireEvent.click(button("media.reviewCut"))
    await waitFor(() => expect(mediaApi.inspectTrim).toHaveBeenCalledWith({ sourceId: "source", ranges: [{ start: 4.2, end: 6 }], intent: "keep", mode: "before" }))
    view.rerender(<TrimPanel source={source} busy={false} player={player} />)
    expect(screen.getAllByTestId("cut-inspector")).toHaveLength(1)
    expect(input("media.trimStart").value).toBe("4.2")
    expect(inspector.childElementCount).toBe(0)
  } finally { inspector.remove() }
})

test("transport icon follows native play and pause events", () => {
  render(<TrimPanel source={source} busy={false} player={player} />)
  const transport = screen.getByRole("button", { name: en["media.playPause"] })
  expect(transport.querySelector(".lucide-play")).toBeTruthy()
  Object.defineProperty(player.current, "paused", { configurable: true, value: false })
  fireEvent.play(player.current)
  expect(transport.querySelector(".lucide-pause")).toBeTruthy()
  Object.defineProperty(player.current, "paused", { configurable: true, value: true })
  fireEvent.pause(player.current)
  expect(transport.querySelector(".lucide-play")).toBeTruthy()
})


test("panel resize keyboard events do not trigger editor seeking or shortcuts", () => {
  Object.defineProperty(player.current, "duration", { value: 12 })
  render(<TrimPanel source={source} busy={false} player={player} />)
  const separator = document.createElement("div")
  separator.setAttribute("role", "separator")
  separator.tabIndex = 0
  document.body.append(separator)
  try {
    player.current.currentTime = 5
    fireEvent.keyDown(separator, { key: "ArrowRight" })
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true })
    fireEvent.keyDown(separator, { key: "b" })
    const consumedArrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
    consumedArrow.preventDefault()
    window.dispatchEvent(consumedArrow)
    expect(player.current.currentTime).toBe(5)
    expect(useEditor.getState().document.ranges).toEqual([{ start: 0, end: 12 }])
    expect(useEditor.getState().past).toHaveLength(0)
  } finally { separator.remove() }
})


test("transport subscription moves to a replacement source media element", () => {
  const oldMedia = player.current
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  Object.defineProperty(oldMedia, "paused", { configurable: true, value: false })
  fireEvent.play(oldMedia)
  expect(screen.getByRole("button", { name: en["media.playPause"] }).querySelector(".lucide-pause")).toBeTruthy()
  player.current = document.createElement("video")
  view.rerender(<TrimPanel source={{ ...source, sourceId: "replacement" }} busy={false} player={player} />)
  const transport = screen.getByRole("button", { name: en["media.playPause"] })
  expect(transport.querySelector(".lucide-play")).toBeTruthy()
  fireEvent.play(oldMedia)
  expect(transport.querySelector(".lucide-play")).toBeTruthy()
  Object.defineProperty(player.current, "paused", { configurable: true, value: false })
  fireEvent.play(player.current)
  expect(transport.querySelector(".lucide-pause")).toBeTruthy()
})

// Exercise the extracted playback lifecycle through the public panel controls.
test("retained preview skips removed ranges, survives position updates and stops at the final boundary", () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  const play = vi.spyOn(player.current, "play").mockResolvedValue()
  const pause = vi.spyOn(player.current, "pause").mockImplementation(() => {})
  const tick = () => act(() => {
    const current = [...frames.values()]
    frames.clear()
    current.forEach(callback => callback(0))
  })
  Object.defineProperty(player.current, "duration", { value: 12 })
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  try {
    setRange()
    fireEvent.change(screen.getByLabelText(en["media.editMode"]), { target: { value: "remove" } })
    fireEvent.click(screen.getByRole("button", { name: en["media.previewEdit"] }))
    expect(player.current.currentTime).toBe(0)
    expect(play).toHaveBeenCalledOnce()
    expect(frames.size).toBe(1)
    act(() => useLocalMedia.setState({ position: 2 }))
    expect(pause).not.toHaveBeenCalled()
    player.current.currentTime = 4.2
    tick()
    expect(player.current.currentTime).toBe(6)
    expect(frames.size).toBe(1)
    player.current.currentTime = 12
    tick()
    expect(pause).toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(screen.getByRole("button", { name: en["media.previewEdit"] })).toBeTruthy()
  } finally {
    view.unmount()
    request.mockRestore(); cancel.mockRestore(); play.mockRestore(); pause.mockRestore()
  }
})

test("editing and unmounting stop retained preview and remove its scheduled frame", () => {
  const frames = new Set<number>()
  let nextFrame = 0
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
    frames.add(++nextFrame)
    return nextFrame
  })
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  const play = vi.spyOn(player.current, "play").mockResolvedValue()
  const pause = vi.spyOn(player.current, "pause").mockImplementation(() => {})
  Object.defineProperty(player.current, "duration", { value: 12 })
  const view = render(<TrimPanel source={source} busy={false} player={player} />)
  try {
    fireEvent.click(screen.getByRole("button", { name: en["media.previewEdit"] }))
    expect(frames.size).toBe(1)
    fireEvent.change(input("media.trimEnd"), { target: { value: "10" } })
    expect(pause).toHaveBeenCalled()
    expect(frames.size).toBe(0)
    fireEvent.click(screen.getByRole("button", { name: en["media.previewEdit"] }))
    expect(frames.size).toBe(1)
    pause.mockClear()
    view.unmount()
    expect(pause).toHaveBeenCalled()
    expect(frames.size).toBe(0)
  } finally {
    view.unmount()
    request.mockRestore(); cancel.mockRestore(); play.mockRestore(); pause.mockRestore()
  }
})
