import { useEffect, useState } from "react"
import { toast } from "sonner"
import { systemApi } from "@/lib/api"
import {
  buildIssueBody,
  buildIssueUrl,
  type ReportEnvironment,
  type ReportInput
} from "@/lib/report"
import { useReportStore } from "@/lib/reportStore"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export function ReportIssueDialog() {
  const { context, isOpen, close } = useReportStore()
  const [environment, setEnvironment] = useState<ReportEnvironment | null>(
    null
  )
  const [notes, setNotes] = useState("")
  const [includeVideoUrl, setIncludeVideoUrl] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setNotes("")
      setIncludeVideoUrl(false)
      systemApi.getDiagnostics().then(setEnvironment)
    }
  }, [isOpen])

  if (!context) return null

  const handleSubmit = async () => {
    const input: ReportInput = {
      context,
      environment,
      userNotes: notes,
      includeVideoUrl
    }
    const { url, truncated } = buildIssueUrl(input)

    try {
      await navigator.clipboard.writeText(buildIssueBody(input))
    } catch {
      // clipboard is best-effort
    }

    const opened = await systemApi.openExternal(url)
    if (opened) {
      toast.success("Opening GitHub…", {
        description: truncated
          ? "Logs were shortened to fit — the full report is in your clipboard."
          : "Review the prefilled issue and press Submit."
      })
      close()
    } else {
      toast.error("Couldn't open the browser", {
        description:
          "The full report is in your clipboard — paste it at github.com/Cliply/Cliply/issues/new"
      })
    }
  }

  const logTail = (context.details || "").split("\n").slice(-15).join("\n")

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Report this issue</DialogTitle>
          <DialogDescription>
            Opens a prefilled GitHub issue in your browser — nothing is sent
            until you press Submit there.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-xs uppercase text-muted-foreground">Error</p>
            <p className="mt-1">{context.shortMessage}</p>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-xs uppercase text-muted-foreground">
              Environment
            </p>
            <p className="mt-1 text-muted-foreground">
              Cliply {environment?.appVersion ?? "unknown"} ·{" "}
              {environment?.platform ?? "unknown"} {environment?.arch ?? ""} ·
              yt-dlp {environment?.ytDlpVersion ?? "unknown"}
            </p>
          </div>

          {logTail && (
            <details className="rounded-lg border border-border bg-muted/40 p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Technical logs included in the report
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {logTail}
              </pre>
            </details>
          )}

          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="What were you doing when it failed? (optional)"
            className="w-full rounded-lg border border-border bg-background p-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />

          {context.videoUrl && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={includeVideoUrl}
                onChange={(e) => setIncludeVideoUrl(e.target.checked)}
              />
              Include the video URL in the report
            </label>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit}>Open GitHub issue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
