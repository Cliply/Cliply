// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { mediaApi } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { ru } from "@/lib/i18n/ru"
import type { MediaSource, LocalExportState, TrackExportPlan } from "@/lib/local-media-types"
import { acceptExport, useLocalExport } from "@/lib/stores/localExportStore"
import { TrackRemovalPanel } from "./TrackRemovalPanel"
import { ExportStatus } from "./LocalExportStatus"
vi.mock("@/lib/api", () => ({ mediaApi: { prepareExport: vi.fn(), startExport: vi.fn(), exportState: vi.fn(), cancelExport: vi.fn() } }))
const source = { sourceId: "source", filename: "fixture.mkv", chapterCount: 0, streams: [
  { index: 3, type: "video", codec: "h264", disposition: {} },
  { index: 7, type: "audio", codec: "aac", language: "rus", title: "Alternate", disposition: {} },
  { index: 11, type: "subtitle", codec: "subrip", language: "eng", title: "Captions", disposition: { forced: 1 } }
], trackRemovalProfile: { extension: "mkv", supportedStreamIndexes: [3, 7, 11] } } as MediaSource
const empty: LocalExportState = { revision: 0, preparing: false, plan: null, job: null, recoveryError: null }
const plan: TrackExportPlan = { operation: "removeTracks", sourceId: "source", streamIndexes: [3, 11], removeChapters: false, removedStreamIndexes: [7], planId: "plan", outputName: "silent.mkv", duration: 4, extension: "mkv", expiresAt: Date.now() + 100000 }
beforeEach(() => {
  vi.clearAllMocks(); useLocale.setState({ locale: "en" })
  useLocalExport.setState({ snapshot: { ...empty, revision: -1 }, selection: null, trackSelection: null, action: "removeTracks", pending: false, error: null })
  vi.mocked(mediaApi.exportState).mockResolvedValue(empty)
  vi.mocked(mediaApi.prepareExport).mockResolvedValue({ cancelled: false, plan })
  vi.mocked(mediaApi.startExport).mockResolvedValue({ ...empty, revision: 3, job: { jobId: "job", operation: "removeTracks", outputName: "silent.mkv", state: "running", progress: 25, error: null } })
})
afterEach(cleanup)
const choose = () => screen.getByRole("button", { name: en["media.chooseDestination"] }) as HTMLButtonElement

test("all streams start kept; mute removes only audio, actual IDs and exact reviewed result precede Save copy", async () => {
  render(<TrackRemovalPanel source={source} busy={false} />)
  expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).checked)).toBe(true)
  expect(screen.getByLabelText(/#7 · audio · aac · rus · Alternate/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: en["media.removeAllAudio"] }))
  expect((screen.getByLabelText(/#7/) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByLabelText(/#11/) as HTMLInputElement).checked).toBe(true)
  vi.mocked(mediaApi.exportState).mockResolvedValue({ ...empty, revision: 2, plan })
  fireEvent.click(choose())
  expect(await screen.findByText("Save as: silent.mkv")).toBeTruthy()
  expect(screen.getByText("Keep: #3, #11")).toBeTruthy()
  expect(mediaApi.prepareExport).toHaveBeenCalledWith({ operation: "removeTracks", sourceId: "source", streamIndexes: [3, 11], removeChapters: false })
  expect(mediaApi.startExport).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: en["media.saveCopy"] }))
  await waitFor(() => expect(mediaApi.startExport).toHaveBeenCalledWith("plan"))
  await waitFor(() => expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).disabled)).toBe(true))
})
test("unsupported attachments stay checked and require explicit removal plus separate chapter consent", () => {
  const special = { ...source, chapterCount: 2, streams: [...source.streams, { index: 20, type: "attachment", codec: "ttf", title: "Font", disposition: {} }] } as MediaSource
  render(<TrackRemovalPanel source={special} busy={false} />)
  const attachment = screen.getByLabelText(/#20/) as HTMLInputElement
  expect(attachment.checked).toBe(true); expect(choose().disabled).toBe(true)
  fireEvent.click(attachment); expect(choose().disabled).toBe(true)
  expect(screen.getByRole("alert").textContent).toBe(en["media.error.TRACK_CHAPTERS"])
  fireEvent.click(screen.getByLabelText(/Remove all 2 chapters/)); expect(choose().disabled).toBe(false)
})
test("a subtitle-only selection is refused; cancelled destination never starts a job", async () => {
  render(<TrackRemovalPanel source={source} busy={false} />)
  fireEvent.click(screen.getByLabelText(/#3/)); fireEvent.click(screen.getByLabelText(/#7/))
  expect(choose().disabled).toBe(true)
  expect(screen.getByRole("alert").textContent).toBe(en["media.error.TRACK_EMPTY"])
  fireEvent.click(screen.getByLabelText(/#3/))
  vi.mocked(mediaApi.prepareExport).mockResolvedValue({ cancelled: true, plan: null })
  fireEvent.click(choose()); await waitFor(() => expect(useLocalExport.getState().pending).toBe(false))
  expect(screen.queryByRole("button", { name: en["media.saveCopy"] })).toBeNull()
  expect(mediaApi.startExport).not.toHaveBeenCalled()
})
test("selection survives unmount/return, resets for a different source, and a changed selection hides stale plan", () => {
  let view = render(<TrackRemovalPanel source={source} busy={false} />)
  fireEvent.click(screen.getByLabelText(/#7/)); view.unmount()
  view = render(<TrackRemovalPanel source={source} busy={false} />)
  expect((screen.getByLabelText(/#7/) as HTMLInputElement).checked).toBe(false)
  act(() => acceptExport({ ...empty, revision: 2, plan }))
  expect(screen.getByRole("button", { name: en["media.saveCopy"] })).toBeTruthy()
  fireEvent.click(screen.getByLabelText(/#11/))
  expect(screen.queryByRole("button", { name: en["media.saveCopy"] })).toBeNull()
  view.rerender(<TrackRemovalPanel source={{ ...source, sourceId: "another" }} busy={false} />)
  expect(screen.getAllByRole("checkbox").every(input => (input as HTMLInputElement).checked)).toBe(true)
})
test("MOV/MP4 default promotion is explained before export", () => {
  render(<TrackRemovalPanel source={{ ...source, trackRemovalProfile: { extension: "mp4", supportedStreamIndexes: [3, 7, 11] } }} busy={false} />)
  expect(choose().disabled).toBe(true)
  expect(screen.getByRole("alert").textContent).toBe(en["media.error.TRACK_DEFAULT"])
})
test("unsupported container remains a readable limitation without hiding its streams", () => {
  render(<TrackRemovalPanel source={{ ...source, trackRemovalProfile: null }} busy={false} />)
  expect(screen.getAllByRole("checkbox")).toHaveLength(3)
  expect(screen.getByText(en["media.error.TRACK_CONTAINER"])).toBeTruthy()
  expect(choose().disabled).toBe(true)
})
test("Russian copy status and cancellation refer to the shared local job", async () => {
  useLocale.setState({ locale: "ru" })
  const running: LocalExportState = { ...empty, revision: 3, job: { jobId: "copy", operation: "removeTracks", outputName: "copy.mkv", state: "running", progress: 30, error: null } }
  acceptExport(running); vi.mocked(mediaApi.cancelExport).mockResolvedValue({ ...running, revision: 4, job: { ...running.job!, state: "cancelled" } })
  render(<><TrackRemovalPanel source={source} busy={false} /><ExportStatus /></>)
  expect(screen.getByRole("group", { name: ru["media.keepTracks"] })).toBeTruthy()
  expect(screen.getByRole("status").textContent).toContain(ru["media.copyRunning"])
  fireEvent.click(screen.getByRole("button", { name: ru["media.cancelCopy"] }))
  await waitFor(() => expect(mediaApi.cancelExport).toHaveBeenCalledWith("copy"))
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain(ru["media.copyCancelled"]))
})

test("container selection preserves all streams; incompatible tracks require explicit removal and target survives navigation", async () => {
  const remuxSource = { ...source, contentContainer: "mkv", startTime: 0, streams: source.streams.map(stream => ({ ...stream, startTime: 0, disposition: { ...stream.disposition, default: 1 as const } })), remuxProfiles: [
    { targetContainer: "mp4", extension: "mp4", supportedStreamIndexes: [3, 7], preservesChapters: false },
    { targetContainer: "mov", extension: "mov", supportedStreamIndexes: [3, 7], preservesChapters: false }
  ] } as MediaSource
  useLocalExport.setState({ remuxSelection: null })
  let view = render(<TrackRemovalPanel source={remuxSource} busy={false} operation="remux" />)
  expect(screen.getAllByRole("checkbox").every(e => (e as HTMLInputElement).checked)).toBe(true)
  expect(choose().disabled).toBe(true)
  fireEvent.click(screen.getByLabelText(en["media.targetContainer"]))
  fireEvent.click(screen.getByRole("option", { name: "MP4" }))
  expect(screen.getAllByRole("checkbox").every(e => (e as HTMLInputElement).checked)).toBe(true)
  expect(screen.getByText("Output: .MP4 · full file · original codecs")).toBeTruthy()
  expect(screen.getByRole("alert").textContent).toBe(en["media.error.TRACK_UNSUPPORTED"])
  fireEvent.click(screen.getByLabelText(/#11/)); expect(choose().disabled).toBe(false)
  fireEvent.click(choose())
  await waitFor(() => expect(mediaApi.prepareExport).toHaveBeenCalledWith({ operation: "remux", sourceId: "source", targetContainer: "mp4", streamIndexes: [3, 7], removeChapters: false }))
  await waitFor(() => expect(useLocalExport.getState().pending).toBe(false))
  view.unmount(); view = render(<TrackRemovalPanel source={remuxSource} busy={false} operation="remux" />)
  expect((screen.getByRole("combobox") as HTMLButtonElement).value).toBe("mp4")
  expect((screen.getByLabelText(/#11/) as HTMLInputElement).checked).toBe(false)
  act(() => acceptExport({ ...empty, revision: 5, plan: { ...plan, operation: "remux", targetContainer: "mp4", streamIndexes: [3, 7], removedStreamIndexes: [11], outputName: "converted.mp4" } }))
  expect(screen.getByText("Save as: converted.mp4")).toBeTruthy()
  fireEvent.click(screen.getByRole("combobox"))
  fireEvent.click(screen.getByRole("option", { name: "MOV" }))
  expect(screen.queryByText("Save as: converted.mp4")).toBeNull()
  view.rerender(<TrackRemovalPanel source={{ ...remuxSource, sourceId: "new" }} busy={false} operation="remux" />)
  expect((screen.getByRole("combobox") as HTMLButtonElement).value).toBe("")
  expect(screen.getAllByRole("checkbox").every(e => (e as HTMLInputElement).checked)).toBe(true)
})
test("remux chapters default to preservation when verified; another target requires explicit removal", () => {
  useLocalExport.setState({ remuxSelection: null })
  const withChapters = { ...source, chapterCount: 2, startTime: 0, streams: source.streams.slice(0, 2).map(stream => ({ ...stream, startTime: 0, disposition: { default: 1 as const } })), remuxProfiles: [
    { targetContainer: "mkv", extension: "mkv", supportedStreamIndexes: [3, 7], preservesChapters: true },
    { targetContainer: "mov", extension: "mov", supportedStreamIndexes: [3, 7], preservesChapters: false }
  ] } as MediaSource
  render(<TrackRemovalPanel source={withChapters} busy={false} operation="remux" />)
  fireEvent.click(screen.getByRole("combobox"))
  fireEvent.click(screen.getByRole("option", { name: "MKV" }))
  expect(screen.getByText("Keep all 2 chapters.")).toBeTruthy()
  expect((screen.getByLabelText(/Remove all 2 chapters/) as HTMLInputElement).checked).toBe(false)
  expect(choose().disabled).toBe(false)
  fireEvent.click(screen.getByRole("combobox"))
  fireEvent.click(screen.getByRole("option", { name: "MOV" }))
  expect(choose().disabled).toBe(true)
  expect(screen.getByRole("alert").textContent).toBe(en["media.error.REMUX_CHAPTERS"])
  fireEvent.click(screen.getByLabelText(/Remove all 2 chapters/)); expect(choose().disabled).toBe(false)
})
test("remux shares copy status and cancellation in Russian", async () => {
  useLocale.setState({ locale: "ru" })
  acceptExport({ ...empty, revision: 3, job: { jobId: "remux", operation: "remux", outputName: "copy.mp4", state: "running", progress: 20, error: null } })
  render(<ExportStatus />)
  expect(screen.getByRole("status").textContent).toContain(ru["media.copyRunning"])
  fireEvent.click(screen.getByRole("button", { name: ru["media.cancelCopy"] }))
  await waitFor(() => expect(mediaApi.cancelExport).toHaveBeenCalledWith("remux"))
})

test("switching from chapter-preserving remux to track removal still requires chapter-removal consent", () => {
  const withChapters = { ...source, chapterCount: 2, startTime: 0,
    streams: source.streams.slice(0, 2).map(stream => ({ ...stream, startTime: 0 })),
    remuxProfiles: [{ targetContainer: "mkv", extension: "mkv", supportedStreamIndexes: [3, 7], preservesChapters: true }]
  } as MediaSource
  useLocalExport.setState({ remuxSelection: null })
  const view = render(<TrackRemovalPanel source={withChapters} busy={false} operation="remux" />)
  fireEvent.click(screen.getByRole("combobox"))
  fireEvent.click(screen.getByRole("option", { name: "MKV" }))
  expect(choose().disabled).toBe(false)
  view.rerender(<TrackRemovalPanel source={withChapters} busy={false} operation="removeTracks" />)
  expect(choose().disabled).toBe(true)
  expect(screen.getByRole("alert").textContent).toBe(en["media.error.TRACK_CHAPTERS"])
  fireEvent.click(screen.getByLabelText(/Remove all 2 chapters/))
  expect(choose().disabled).toBe(false)
  view.rerender(<TrackRemovalPanel source={withChapters} busy={false} operation="remux" />)
  expect((screen.getByLabelText(/Remove all 2 chapters/) as HTMLInputElement).checked).toBe(false)
  expect(screen.getByText("Keep all 2 chapters.")).toBeTruthy()
})
