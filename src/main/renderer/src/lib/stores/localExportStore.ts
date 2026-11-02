import { create } from "zustand"
import { mediaApi } from "../api"
import type { AudioExportRequest, LocalExportState } from "../local-media-types"

export const useLocalExport = create<{
  snapshot: LocalExportState; pending: boolean; error: string | null
  selection: { sourceId: string; streamIndex: number } | null
}>(() => ({ snapshot: { revision: -1, preparing: false, plan: null, job: null, recoveryError: null }, pending: false, error: null, selection: null }))
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
  prepare: (request: AudioExportRequest) => action(async () => { await mediaApi.prepareExport(request); acceptExport(await mediaApi.exportState()) }),
  start: (planId: string) => action(async () => { acceptExport(await mediaApi.startExport(planId)) }),
  cancel: (jobId: string) => action(async () => { acceptExport(await mediaApi.cancelExport(jobId)) }),
  reveal: (jobId: string) => action(() => mediaApi.revealOutput(jobId))
}
