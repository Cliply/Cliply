// @vitest-environment jsdom
import { StrictMode } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { mediaApi } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { ru } from "@/lib/i18n/ru"
import { localMediaActions, useLocalMedia } from "@/lib/stores/localMediaStore"
import type { MediaSource } from "@/lib/local-media-types"
import { LocalFileEntry } from "./LocalFileEntry"
import { NativeMediaPlayer } from "./NativeMediaPlayer"
import MediaPage from "@/pages/MediaPage"

vi.mock("@/lib/api", () => ({ mediaApi: { open: vi.fn(), close: vi.fn(), getState: vi.fn(), preview: vi.fn(), releasePreview: vi.fn(), confirmPlayback: vi.fn(), compatClock: vi.fn() } }))

const source = {
  schemaVersion: 1, sourceId: "11111111-1111-4111-8111-111111111111", filename: "synthetic.mp4", bytes: 1024,
  duration: 5, formatNames: ["mov", "mp4"], streams: [
    { index: 3, type: "video", codec: "h264", language: "und", title: "Picture", disposition: {} },
    { index: 7, type: "audio", codec: "aac", language: "eng", title: "Voice", disposition: {} },
    { index: 12, type: "subtitle", codec: "mov_text", language: "eng", title: "Captions", disposition: {} }
  ], chapterCount: 0
} as MediaSource
const grant = { sourceId: source.sourceId, previewId: "a".repeat(64), url: `cliply-media://source/${"a".repeat(64)}`, mime: "video/mp4", expiresAt: Date.now() + 100000 }

beforeEach(() => {
  vi.clearAllMocks()
  useLocale.setState({ locale: "en" })
  useLocalMedia.setState({ source: null, busy: false, error: null, position: 0 })
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(160)
  vi.spyOn(HTMLMediaElement.prototype as HTMLMediaElement & { audioTracks: unknown[] }, "audioTracks", "get").mockReturnValue([{ id: "8" }])
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {})
  vi.mocked(mediaApi.preview).mockResolvedValue(grant)
  vi.mocked(mediaApi.releasePreview).mockResolvedValue({ released: true })
  vi.mocked(mediaApi.confirmPlayback).mockImplementation(async ({ played }) => ({ confirmed: played }))
  vi.mocked(mediaApi.close).mockResolvedValue({ closed: true })
  vi.mocked(mediaApi.getState).mockImplementation(async () => ({ source: useLocalMedia.getState().source, busy: false }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

test("entry opens the workspace only after successful selection; cancellation keeps the home screen", async () => {
  vi.mocked(mediaApi.open).mockResolvedValueOnce({ cancelled: true, source: null }).mockResolvedValueOnce({ cancelled: false, source })
  render(<MemoryRouter><Routes><Route path="/" element={<LocalFileEntry />} /><Route path="/media" element={<MediaPage />} /></Routes></MemoryRouter>)
  fireEvent.click(screen.getByRole("button", { name: en["media.open"] }))
  await waitFor(() => expect(useLocalMedia.getState().busy).toBe(false))
  expect(screen.queryByRole("heading")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: en["media.open"] }))
  await screen.findByRole("heading", { name: en["media.title"] })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: en["media.title"] })))
  expect(screen.getByText("synthetic.mp4")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: en["media.extract"] }))
  expect(screen.getAllByRole("columnheader")).toHaveLength(5)
  expect(screen.getByText("12")).toBeTruthy()
  expect(screen.getByText("Captions")).toBeTruthy()
  for (const key of ["media.trim"] as const) {
    expect((screen.getByRole("button", { name: en[key] }) as HTMLButtonElement).disabled).toBe(false)
  }
  expect((screen.getByRole("button", { name: en["media.remux"] }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByRole("button", { name: "ru" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Toggle theme" })).toBeNull()
  act(() => useLocale.setState({ locale: "ru" }))
  expect(screen.getByRole("heading", { name: ru["media.title"] })).toBeTruthy()
  expect(screen.getByRole("button", { name: ru["media.close"] })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: ru["media.close"] }))
  await screen.findByText(ru["media.empty"])
  expect(mediaApi.releasePreview).toHaveBeenCalledWith(grant.previewId)
})

test("missing helper has a readable alert; cancellation discards a late open reply", async () => {
  vi.mocked(mediaApi.open).mockRejectedValueOnce(new Error("Local inspection needs FFprobe. Downloads are still available."))
  render(<MemoryRouter><LocalFileEntry /></MemoryRouter>)
  fireEvent.click(screen.getByRole("button", { name: en["media.open"] }))
  expect((await screen.findByRole("alert")).textContent).toContain("FFprobe")
  let resolve!: (result: { source: MediaSource; cancelled: boolean }) => void
  vi.mocked(mediaApi.open).mockImplementationOnce(() => new Promise(r => { resolve = r }))
  fireEvent.click(screen.getByRole("button", { name: en["media.open"] }))
  fireEvent.click(screen.getByRole("button", { name: en["media.cancel"] }))
  await act(async () => { resolve({ source, cancelled: false }) })
  expect(useLocalMedia.getState().source).toBeNull()
  expect(useLocalMedia.getState().busy).toBe(false)
})

test("native events report seek/end/error without losing the probed tracks; retry releases old access", async () => {
  useLocalMedia.setState({ source })
  render(<NativeMediaPlayer source={source} busy={false} />)
  const player = screen.getByLabelText(en["media.player"]) as HTMLVideoElement
  await waitFor(() => expect(player.getAttribute("src")).toBe(grant.url))
  fireEvent.seeking(player)
  expect(screen.getByRole("status").textContent).toBe(en["media.seeking"])
  fireEvent.ended(player)
  expect(screen.getByRole("status").textContent).toBe(en["media.ended"])
  vi.mocked(mediaApi.compatClock).mockRejectedValue(new Error("decoder unavailable"))
  fireEvent.error(player)
  await screen.findByRole("alert")
  expect(mediaApi.compatClock).toHaveBeenCalledWith(source.sourceId)
  expect(screen.getByRole("alert").textContent).toBe(en["media.previewUnavailable"])
  expect(useLocalMedia.getState().source).toBe(source)
  fireEvent.click(screen.getByRole("button", { name: en["media.retryPreview"] }))
  await waitFor(() => expect(mediaApi.preview).toHaveBeenCalledTimes(3))
  expect(mediaApi.releasePreview).toHaveBeenCalledWith(grant.previewId)
})

test("returning restores position, strict effects discard stale access, and cleanup stops media", async () => {
  useLocalMedia.setState({ source, position: 2 })
  const view = render(<StrictMode><NativeMediaPlayer source={source} busy={false} /></StrictMode>)
  const player = screen.getByLabelText(en["media.player"]) as HTMLVideoElement
  await waitFor(() => expect(player.getAttribute("src")).toBe(grant.url))
  Object.defineProperty(player, "duration", { value: 5 })
  Object.defineProperty(player, "readyState", { value: 4 })
  fireEvent.loadedMetadata(player)
  expect(player.currentTime).toBe(2)
  player.currentTime = 3
  fireEvent.timeUpdate(player)
  view.unmount()
  expect(useLocalMedia.getState().position).toBe(3)
  expect(player.getAttribute("src")).toBeNull()
  expect(player.pause).toHaveBeenCalled()
  expect(mediaApi.releasePreview).toHaveBeenCalled()
})

test("expiry removes the resource and explains how to restore preview", async () => {
  vi.useFakeTimers()
  vi.mocked(mediaApi.preview).mockResolvedValue({ ...grant, expiresAt: Date.now() + 1000 })
  await act(async () => { render(<NativeMediaPlayer source={source} busy={false} />) })
  await act(async () => { vi.advanceTimersByTime(1001) })
  expect(screen.getByRole("alert").textContent).toBe(en["media.expired"])
  expect(screen.getByLabelText(en["media.player"]).getAttribute("src")).toBeNull()
  expect(mediaApi.releasePreview).toHaveBeenCalledWith(grant.previewId)
})

test("unload timeupdate cannot erase the saved position before expiry reload", async () => {
  vi.useFakeTimers()
  useLocalMedia.setState({ source, position: 2 })
  vi.mocked(mediaApi.preview).mockResolvedValueOnce({ ...grant, expiresAt: Date.now() + 1000 })
  await act(async () => { render(<NativeMediaPlayer source={source} busy={false} />) })
  const player = screen.getByLabelText(en["media.player"]) as HTMLVideoElement
  Object.defineProperty(player, "duration", { configurable: true, value: 5 })
  Object.defineProperty(player, "readyState", { configurable: true, value: 1 })
  fireEvent.loadedMetadata(player)
  expect(player.currentTime).toBe(2)
  await act(async () => { vi.advanceTimersByTime(1001) })
  player.currentTime = 0
  fireEvent.timeUpdate(player) // real Chromium load() emits this during reset
  expect(useLocalMedia.getState().position).toBe(2)
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: en["media.retryPreview"] })) })
  fireEvent.loadedMetadata(player)
  expect(player.currentTime).toBe(2)
})

test("cover artwork does not turn an audio file into video; source change clears workspace state", async () => {
  const audio = { ...source, streams: source.streams.map(s => ({ ...s, disposition: { attached_pic: s.type === "video" ? 1 : 0 } })) } as MediaSource
  useLocalMedia.setState({ source: audio })
  render(<NativeMediaPlayer source={audio} busy={false} />)
  expect(screen.getByLabelText(en["media.player"]).tagName).toBe("AUDIO")
  vi.mocked(mediaApi.getState).mockRejectedValueOnce(new Error("The original file changed. Open it again."))
  await act(async () => { await localMediaActions.refresh() })
  expect(useLocalMedia.getState()).toMatchObject({ source: null, position: 0, error: "The original file changed. Open it again." })
})
