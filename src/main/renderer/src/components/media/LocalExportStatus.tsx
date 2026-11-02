import { useEffect } from "react"
import { Link, useLocation } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { mediaApi } from "@/lib/api"
import { useT, type Key } from "@/lib/i18n"
import { acceptExport, localExportActions, useLocalExport } from "@/lib/stores/localExportStore"
import { en } from "@/lib/i18n/en"
import type { LocalExportJob } from "@/lib/local-media-types"

const labels: Record<LocalExportJob["state"], Key> = {
  reserved: "media.exportReserved", running: "media.exportRunning", validating: "media.exportValidating",
  publishing: "media.exportPublishing", stopping: "media.exportStopping", completed: "media.exportCompleted",
  cancelled: "media.exportCancelled", failed: "media.exportFailed", interrupted: "media.exportInterrupted"
}

export function ExportStatus() {
  const t = useT()
  const snapshot = useLocalExport(s => s.snapshot)
  const pending = useLocalExport(s => s.pending)
  const error = useLocalExport(s => s.error)
  const job = snapshot.job
  const code = snapshot.recoveryError || job?.error
  return <div className="space-y-3" aria-label={t("media.exportStatus")}>
    {job && <>
      <p role="status" className="break-words text-sm">{t(labels[job.state])}{job.outputName ? ` · ${job.outputName}` : ""}</p>
      <Progress value={job.progress} aria-label={t("media.exportProgress")} />
      <div className="flex flex-wrap gap-2">
        {["reserved", "running", "validating", "stopping"].includes(job.state) && <Button variant="outline" disabled={pending || job.state === "stopping"} onClick={() => void localExportActions.cancel(job.jobId)}>{t("media.cancelExport")}</Button>}
        {job.state === "completed" && <Button variant="outline" onClick={() => void localExportActions.reveal(job.jobId)}>{t("media.revealOutput")}</Button>}
      </div>
    </>}
    {(error || code) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error || t(Object.hasOwn(en, `media.error.${code}`) ? `media.error.${code}` as Key : "media.exportFailureHelp")}</p>}
  </div>
}

// One subscription outside the route; subscribe before reading to avoid missing
// a terminal update racing the initial state reply. No download-store writes.
export function LocalExportEvents() {
  const t = useT()
  const location = useLocation()
  const hasStatus = useLocalExport(s => Boolean(s.snapshot.job || s.snapshot.recoveryError))
  useEffect(() => {
    let alive = true
    const unsubscribe = mediaApi.onExportUpdated(acceptExport)
    void mediaApi.exportState().then(state => { if (alive) acceptExport(state) }).catch(() => {})
    return () => { alive = false; unsubscribe() }
  }, [])
  if (!hasStatus || location.pathname === "/media") return null
  return <aside className="fixed bottom-4 left-4 z-30 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-slate-300 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
    <ExportStatus /><Button variant="ghost" asChild><Link to="/media">{t("media.return")}</Link></Button>
  </aside>
}
