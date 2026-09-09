import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Bug } from "lucide-react"
import { systemApi } from "@/lib/api"
import { useT } from "@/lib/i18n"
import {
  buildIssueBody,
  buildIssueUrl,
  environmentFields,
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
import { cn } from "@/lib/utils"

export function ReportIssueDialog() {
  const t = useT()
  const { context, isOpen, close } = useReportStore()
  const [environment, setEnvironment] = useState<ReportEnvironment | null>(null)
  const [notes, setNotes] = useState("")
  const [includeVideoUrl, setIncludeVideoUrl] = useState(false)

  useEffect(() => {
    if (isOpen) {
      systemApi.getDiagnostics().then(setEnvironment)
    }
  }, [isOpen])

  // reset the form whenever the staged failure changes (or the dialog opens),
  // so notes and the URL opt-in always belong to the error being shown even if
  // a second download fails while this dialog is still open.
  useEffect(() => {
    setNotes("")
    setIncludeVideoUrl(false)
  }, [context, isOpen])

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
      toast.success(t("report.opening"), {
        description: truncated ? t("report.trimmed") : t("report.reviewIt")
      })
      close()
    } else {
      toast.error(t("report.browserFailed"), {
        description: t("report.browserFailedDesc")
      })
    }
  }

  // the same list the issue body tabulates, so the card can never show less
  // than the report sends
  const setupFields = environmentFields(environment)

  const logTail = (context.details || "").split("\n").slice(-15).join("\n")

  const cardClass =
    "rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700/60 dark:bg-slate-800/50"
  const labelClass =
    "text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="font-space-grotesk sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400">
              <Bug className="h-4 w-4" />
            </span>
            <DialogTitle className="text-slate-900 dark:text-white">
              {t("report.title")}
            </DialogTitle>
          </div>
          <DialogDescription className="text-slate-500 dark:text-slate-400">
            {t("report.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className={cardClass}>
            <p className={labelClass}>{t("report.whatWentWrong")}</p>
            <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">
              {context.shortMessage}
            </p>
          </div>

          <div className={cardClass}>
            <p className={labelClass}>{t("report.yourSetup")}</p>
            <dl className="mt-1.5 space-y-1">
              {setupFields.map((field) => (
                <div
                  key={field.label}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <dt className="text-slate-500 dark:text-slate-400">
                    {field.label}
                  </dt>
                  <dd className="truncate text-slate-700 tabular-nums dark:text-slate-200">
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {logTail && (
            <details className={cn(cardClass, "group")}>
              <summary className="flex cursor-pointer items-center justify-between text-sm text-slate-600 select-none dark:text-slate-300">
                <span>{t("report.technicalDetails")}</span>
                <span className="text-xs text-slate-400 group-open:hidden">
                  {t("report.show")}
                </span>
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-slate-100 p-2 text-xs whitespace-pre-wrap text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                {logTail}
              </pre>
            </details>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="report-notes"
              className="text-sm font-medium text-slate-700 dark:text-slate-200"
            >
              {t("report.notes")}
            </label>
            <textarea
              id="report-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={t("report.notesPlaceholder")}
              className="w-full resize-none rounded-xl border border-slate-300 bg-white/70 p-3 text-sm text-slate-800 outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-100"
            />
          </div>

          {context.videoUrl && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={includeVideoUrl}
                onChange={(e) => setIncludeVideoUrl(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-cyan-600 dark:border-slate-600"
              />
              {t("report.includeLink")}
            </label>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={close}
            className="text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
          >
            {t("report.notNow")}
          </Button>
          <Button
            onClick={handleSubmit}
            className="bg-cyan-600 text-white hover:bg-cyan-700"
          >
            {t("report.openOnGithub")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
