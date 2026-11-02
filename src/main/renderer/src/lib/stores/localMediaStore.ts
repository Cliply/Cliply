import { create } from "zustand"
import { mediaApi } from "../api"
import type { MediaSource } from "../local-media-types"

// Session-only state, deliberately separate from URL/download stores and history.
export const useLocalMedia = create<{
  source: MediaSource | null; busy: boolean; error: string | null; position: number
}>(() => ({ source: null, busy: false, error: null, position: 0 }))
let revision = 0
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const localMediaActions = {
  async open() {
    if (useLocalMedia.getState().busy) return false
    const current = ++revision
    useLocalMedia.setState({ busy: true, error: null })
    try {
      const result = await mediaApi.open()
      if (current !== revision || result.cancelled || !result.source) return false
      useLocalMedia.setState({ source: result.source, position: 0 })
      return true
    } catch (error) {
      if (current === revision) useLocalMedia.setState({ error: message(error) })
      return false
    } finally {
      if (current === revision) useLocalMedia.setState({ busy: false })
    }
  },
  async refresh() {
    const current = revision
    try {
      const state = await mediaApi.getState()
      if (current !== revision || useLocalMedia.getState().busy) return
      if (state.source?.sourceId !== useLocalMedia.getState().source?.sourceId) {
        useLocalMedia.setState({ source: state.source, position: 0 })
      }
    } catch (error) {
      if (current !== revision) return
      useLocalMedia.setState({ source: null, position: 0, error: message(error) })
    }
  },
  async close() {
    const current = ++revision
    useLocalMedia.setState({ source: null, position: 0, error: null, busy: true })
    try {
      await mediaApi.close()
      if (current === revision) useLocalMedia.setState({ busy: false })
    } catch (error) {
      if (current === revision) useLocalMedia.setState({ error: message(error), busy: false })
    }
  },
  rememberPosition(sourceId: string, position: number) {
    if (useLocalMedia.getState().source?.sourceId === sourceId && Number.isFinite(position)) {
      useLocalMedia.setState({ position: Math.max(0, position) })
    }
  }
}
