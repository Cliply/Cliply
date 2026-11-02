// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest"
import { mediaApi } from "./api"

afterEach(() => { delete (window as { electronAPI?: unknown }).electronAPI })

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

test("missing helper is readable without changing download state", async () => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    media: { open: async () => ({ success: false, error: { code: "PROBE_MISSING", message: "Local inspection needs FFprobe. Downloads are still available." } }) }
  }
  await expect(mediaApi.open()).rejects.toThrow("Local inspection needs FFprobe. Downloads are still available.")
})
