// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest"
import { mediaApi } from "./api"
import { localizeCode, useLocale } from "./i18n"

afterEach(() => { delete (window as { electronAPI?: unknown }).electronAPI; useLocale.setState({ locale: "en" }) })

test("inspection stays on the media bridge and preserves cancelled selection", async () => {
  const media = {
    open: vi.fn(async () => ({ success: true, data: { cancelled: true, source: null } })),
    getState: vi.fn(async () => ({ success: true, data: { source: null, busy: false } })),
    close: vi.fn(async () => ({ success: true, data: { closed: true } }))
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { media }
  expect(await mediaApi.open()).toEqual({ cancelled: true, source: null })
  expect(await mediaApi.getState()).toEqual({ source: null, busy: false })
  expect(await mediaApi.close()).toEqual({ closed: true })
  expect(media.open).toHaveBeenCalledWith()
})

test("preview calls carry opaque IDs and local errors do not replace cookie error translations", async () => {
  const preview = vi.fn(async () => ({ success: true, data: { previewId: "token", url: "cliply-media://source/token" } }))
  const releasePreview = vi.fn(async () => ({ success: true, data: { released: true } }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    media: { preview, releasePreview, open: async () => ({ success: false, error: { code: "PROBE_FAILED", message: "Inspection failed" } }) }
  }
  expect((await mediaApi.preview("source")).previewId).toBe("token")
  await mediaApi.releasePreview("token")
  expect(preview).toHaveBeenCalledWith("source")
  expect(releasePreview).toHaveBeenCalledWith("token")
  useLocale.setState({ locale: "ru" })
  await expect(mediaApi.open()).rejects.toThrow("Не удалось прочитать файл.")
  expect(localizeCode("PROBE_FAILED", "Cookie check failed")).toBe("тест не удалось завершить.")
})

test("missing helper is readable without changing download state", async () => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    media: { open: async () => ({ success: false, error: { code: "PROBE_MISSING", message: "Local inspection needs FFprobe. Downloads are still available." } }) }
  }
  await expect(mediaApi.open()).rejects.toThrow("Local inspection needs FFprobe. Downloads are still available.")
})

test("remux stays on the narrow export bridge and localizes main refusals", async () => {
  const prepareExport = vi.fn(async () => ({ success: false, error: { code: "REMUX_CHAPTERS", message: "Chapters cannot be kept" } }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { media: { prepareExport } }
  useLocale.setState({ locale: "ru" })
  const request = { operation: "remux" as const, sourceId: "opaque", targetContainer: "mov" as const, streamIndexes: [3, 7], removeChapters: false }
  await expect(mediaApi.prepareExport(request)).rejects.toThrow("Главы сохраняются только")
  expect(prepareExport).toHaveBeenCalledWith(request)
})
