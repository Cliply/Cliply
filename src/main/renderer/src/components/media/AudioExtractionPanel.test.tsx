// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { MemoryRouter, Link, Routes, Route } from "react-router-dom"
import { mediaApi } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { ru } from "@/lib/i18n/ru"
import type { MediaSource, LocalExportState, AudioExportPlan } from "@/lib/local-media-types"
import { acceptExport, useLocalExport } from "@/lib/stores/localExportStore"
import { AudioExtractionPanel } from "./AudioExtractionPanel"
import { ExportStatus, LocalExportEvents } from "./LocalExportStatus"

const mocks = vi.hoisted(() => ({ listener: null as null | ((state: LocalExportState) => void), unsubscribe: vi.fn() }))
vi.mock("@/lib/api", () => ({ mediaApi: {
  prepareExport: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn(), exportState: vi.fn(), revealOutput: vi.fn(),
  onExportUpdated: vi.fn((fn: (state: LocalExportState) => void) => { mocks.listener = fn; return mocks.unsubscribe })
} }))
const source = {
  sourceId: "source", filename: "fixture.mkv", streams: [
    { index: 3, type: "audio", codec: "opus", language: "eng", title: "Unsupported" },
    { index: 7, type: "audio", codec: "aac", language: "rus", title: "Alternate" }
  ], extractionProfiles: [{ streamIndex: 7, extension: "aac" }]
} as MediaSource
const empty: LocalExportState = { revision: 0, preparing: false, job: null, plan: null, recoveryError: null }
const plan = { planId: "plan", sourceId: "source", operation: "extractAudio", streamIndex: 7, outputName: "selected.aac", extension: "aac", codec: "aac", language: "rus", title: "Alternate", duration: 5, expiresAt: Date.now() + 100000 } as AudioExportPlan
const running: LocalExportState = { ...empty, revision: 3, job: { jobId: "job", state: "running", progress: 42, outputName: "selected.aac", error: null } }
beforeEach(() => {
  vi.clearAllMocks(); useLocale.setState({ locale: "en" })
  useLocalExport.setState({ snapshot: { ...empty, revision: -1 }, selection: null, pending: false, error: null })
  vi.mocked(mediaApi.exportState).mockResolvedValue(empty)
  vi.mocked(mediaApi.prepareExport).mockResolvedValue({ cancelled: false, plan })
  vi.mocked(mediaApi.startExport).mockResolvedValue(running)
})
afterEach(cleanup)

test("explicit track choice shows actual ID/language/title, resulting format and omission notice before start", async () => {
  render(<AudioExtractionPanel source={source} busy={false} />)
  const choose = screen.getByRole("button", { name: en["media.chooseDestination"] }) as HTMLButtonElement
  expect(choose.disabled).toBe(true)
  fireEvent.click(screen.getByRole("combobox"))
  fireEvent.click(screen.getByRole("option", { name: /#3 · opus/ }))
  expect(choose.disabled).toBe(true)
  fireEvent.click(screen.getByRole("combobox"))
  fireEvent.click(screen.getByRole("option", { name: /#7 · aac · rus · Alternate/ }))
  expect(choose.disabled).toBe(false)
  expect(screen.getByText(en["media.extractionNotice"])).toBeTruthy()
  expect(screen.getByText(/Output: .AAC/)).toBeTruthy()
  vi.mocked(mediaApi.exportState).mockResolvedValue({ ...empty, revision: 2, plan })
  fireEvent.click(choose)
  await screen.findByText("Save as: selected.aac")
  expect(mediaApi.prepareExport).toHaveBeenCalledWith({ sourceId: "source", operation: "extractAudio", streamIndex: 7 })
  expect(mediaApi.startExport).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: en["media.extract"] }))
  await waitFor(() => expect(mediaApi.startExport).toHaveBeenCalledWith("plan"))
  await waitFor(() => expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(true))
})
test("a cancelled save dialog produces no review/start action; errors are readable", async () => {
  useLocalExport.setState({ selection: { sourceId: "source", streamIndex: 7 } })
  vi.mocked(mediaApi.prepareExport).mockResolvedValueOnce({ cancelled: true, plan: null }).mockRejectedValueOnce(new Error("Choose a different filename"))
  render(<><AudioExtractionPanel source={source} busy={false} /><ExportStatus /></>)
  fireEvent.click(screen.getByRole("button", { name: en["media.chooseDestination"] }))
  await waitFor(() => expect(useLocalExport.getState().pending).toBe(false))
  expect(screen.queryByRole("button", { name: en["media.extract"] })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: en["media.chooseDestination"] }))
  expect((await screen.findByRole("alert")).textContent).toBe("Choose a different filename")
})
test("a new source does not inherit another source's selection or plan", () => {
  useLocalExport.setState({ selection: { sourceId: "old", streamIndex: 7 }, snapshot: { ...empty, plan: { ...plan, sourceId: "old" } } })
  render(<AudioExtractionPanel source={source} busy={false} />)
  expect((screen.getByRole("combobox") as HTMLButtonElement).value).toBe("")
  expect(screen.queryByText("Save as: selected.aac")).toBeNull()
})
test("no audio and unsupported profiles are limitations rather than conversion controls", () => {
  render(<AudioExtractionPanel source={{ ...source, streams: [] }} busy={false} />)
  expect(screen.getByText(en["media.noAudio"])).toBeTruthy()
  expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(true)
})
test("global status survives routes; terminal revisions defeat late progress and initial reads", async () => {
  const view = render(<MemoryRouter><LocalExportEvents /><Routes>
    <Route path="/" element={<Link to="/media">Go to workspace</Link>} />
    <Route path="/media" element={<><ExportStatus /><Link to="/">Home</Link></>} />
  </Routes></MemoryRouter>)
  await act(async () => { mocks.listener!(running) })
  expect(screen.getByRole("complementary").textContent).toContain(en["media.exportRunning"])
  fireEvent.click(screen.getByText("Go to workspace"))
  expect(screen.queryByRole("complementary")).toBeNull()
  expect(mediaApi.onExportUpdated).toHaveBeenCalledTimes(1)
  await act(async () => { mocks.listener!({ ...running, revision: 5, job: { ...running.job!, state: "completed", progress: 100 } }); mocks.listener!(running) })
  expect(screen.getByRole("status").textContent).toContain(en["media.exportCompleted"])
  fireEvent.click(screen.getByText("Home"))
  expect(screen.getByRole("complementary").textContent).toContain(en["media.exportCompleted"])
  view.unmount(); expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
})
test("cancel is scoped to the local job and disappears at the publication commit point", async () => {
  acceptExport(running)
  vi.mocked(mediaApi.cancelExport).mockResolvedValue({ ...running, revision: 4, job: { ...running.job!, state: "stopping" } })
  render(<ExportStatus />)
  fireEvent.click(screen.getByRole("button", { name: en["media.cancelExport"] }))
  await waitFor(() => expect(mediaApi.cancelExport).toHaveBeenCalledWith("job"))
  await act(async () => acceptExport({ ...running, revision: 5, job: { ...running.job!, state: "publishing" } }))
  expect(screen.queryByRole("button", { name: en["media.cancelExport"] })).toBeNull()
})
test("Russian controls and specific recovery errors remain readable", () => {
  useLocale.setState({ locale: "ru" })
  acceptExport({ ...empty, revision: 6, recoveryError: "EXPORT_CLEANUP" })
  render(<><AudioExtractionPanel source={source} busy={false} /><ExportStatus /></>)
  expect(screen.getByLabelText(ru["media.selectAudio"])).toBeTruthy()
  expect(screen.getByRole("alert").textContent).toBe(ru["media.error.EXPORT_CLEANUP"])
})
