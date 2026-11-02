import { create } from "zustand"
import { mediaApi } from "../api"
import type { MediaSource } from "../local-media-types"
import { localTrimActions, useLocalExport } from "./localExportStore"

// Session-only state, deliberately separate from URL/download stores and history.
export const useLocalMedia = create<{
  source: MediaSource | null; busy: boolean; error: string | null; position: number; auditionPreviewId: string | null
}>(() => ({ source: null, busy: false, error: null, position: 0, auditionPreviewId: null }))
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
      useLocalMedia.setState({ source: result.source, position: 0, auditionPreviewId: null })
      localTrimActions.reset()
      useLocalExport.setState({ selection: null, trackSelection: null, remuxSelection: null, trimSelection: null, trimTiming: null, action: "extractAudio" })
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
        useLocalMedia.setState({ source: state.source, position: 0, auditionPreviewId: null })
        localTrimActions.reset()
        useLocalExport.setState({ selection: null, trackSelection: null, remuxSelection: null, trimSelection: null, trimTiming: null, action: "extractAudio" })
      }
    } catch (error) {
      if (current !== revision) return
      useLocalMedia.setState({ source: null, position: 0, auditionPreviewId: null, error: message(error) })
      localTrimActions.reset()
      useLocalExport.setState({ trimSelection: null })
    }
  },
  async close() {
    const current = ++revision
    localTrimActions.reset()
    useLocalMedia.setState({ source: null, position: 0, auditionPreviewId: null, error: null, busy: true })
    useLocalExport.setState({ selection: null, trackSelection: null, remuxSelection: null, trimSelection: null, trimTiming: null, action: "extractAudio" })
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
