import { create } from "zustand"
import { mediaApi } from "../api"
import type { LocalExportRequest, LocalExportState, TrackExportRequest, MediaContainer, TrimTiming, TrimInspectRequest } from "../local-media-types"

export const useLocalExport = create<{
  snapshot: LocalExportState; pending: boolean; error: string | null
  selection: { sourceId: string; streamIndex: number } | null
  trackSelection: Omit<TrackExportRequest, "operation"> | null
  remuxSelection: (Omit<TrackExportRequest, "operation"> & { targetContainer: MediaContainer | "" }) | null
  trimSelection: { sourceId: string; start: string; end: string; mode: "before" | "after" } | null
  trimTiming: TrimTiming | null; timingPending: boolean
  action: LocalExportRequest["operation"]
}>(() => ({ snapshot: { revision: -1, preparing: false, plan: null, job: null, recoveryError: null }, pending: false, error: null, selection: null, trackSelection: null, remuxSelection: null, trimSelection: null, trimTiming: null, timingPending: false, action: "trim" }))
export const exportActive = (state: LocalExportState) => state.preparing || Boolean(state.job && ["reserved", "running", "validating", "publishing", "stopping"].includes(state.job.state))
export function acceptExport(state: LocalExportState) {
  if (state.revision > useLocalExport.getState().snapshot.revision) useLocalExport.setState({ snapshot: state })
}
async function action(run: () => Promise<unknown>) {
  if (useLocalExport.getState().pending) return
  useLocalExport.setState({ pending: true, error: null })
  try { await run() }
  catch (error) { useLocalExport.setState({ error: error instanceof Error ? error.message : String(error) }) }
  finally { useLocalExport.setState({ pending: false }) }
}
export const localExportActions = {
  prepare: (request: LocalExportRequest) => action(async () => { await mediaApi.prepareExport(request); acceptExport(await mediaApi.exportState()) }),
  start: (planId: string) => action(async () => { acceptExport(await mediaApi.startExport(planId)) }),
  cancel: (jobId: string) => action(async () => { acceptExport(await mediaApi.cancelExport(jobId)) }),
  reveal: (jobId: string) => action(() => mediaApi.revealOutput(jobId))
}

let timingRevision = 0
export const localTrimActions = {
  reset() {
    timingRevision += 1
    useLocalExport.setState({ trimTiming: null })
  },
  async inspect(request: TrimInspectRequest) {
    if (useLocalExport.getState().timingPending) return
    const current = ++timingRevision
    useLocalExport.setState({ timingPending: true, trimTiming: null, error: null })
    try {
      const timing = await mediaApi.inspectTrim(request)
      if (current === timingRevision) useLocalExport.setState({ trimTiming: timing })
    }
    catch (error) { if (current === timingRevision) useLocalExport.setState({ error: error instanceof Error ? error.message : String(error) }) }
    finally { useLocalExport.setState({ timingPending: false }) }
  },
  async cancel() {
    localTrimActions.reset()
    try { await mediaApi.cancelTrim() }
    catch (error) { useLocalExport.setState({ error: error instanceof Error ? error.message : String(error) }) }
  }
}
