import { ListVideo } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { useT } from "@/lib/i18n"
import { useMixedLinkStore } from "@/lib/stores/mixedLinkStore"
import { countLine, mixedLinkPlaylistChoice } from "@/lib/playlistView"
import { cn } from "@/lib/utils"

/**
 * which of the two things the pasted link meant
 *
 * shown only for `watch?v=…&list=…`, and only once its playlist has been
 * listed: the question exists to name the playlist and say how big it is, and
 * without that it is not a question anybody can answer.
 *
 * it lives beside `ReportIssueDialog` at the top of the page rather than in
 * either youtube view, because the link can be submitted from three places -
 * the hero, and the compact box in each of the two loaded layouts - and the
 * answer is what decides which of those views comes next.
 *
 * closing without answering does nothing at all. the two buttons both move the
 * app somewhere, so an Escape that picked one of them for you would be a paste
 * you cannot take back; leaving the screen as the paste found it is the one
 * ending that is always recoverable, and re-pasting asks again.
 */
export function MixedLinkPrompt() {
  const question = useMixedLinkStore((state) => state.question)
  const answer = useMixedLinkStore((state) => state.answer)
  const dismiss = useMixedLinkStore((state) => state.dismiss)
  const t = useT()

  if (!question) return null

  const { info } = question

  const choiceClass =
    "rounded-xl border-2 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"

  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="font-space-grotesk sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400">
              <ListVideo className="h-4 w-4" />
            </span>
            <DialogTitle className="text-slate-900 dark:text-white">
              {t("mixedLink.title")}
            </DialogTitle>
          </div>
          <DialogDescription className="text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {info.title}
            </span>
            {"  ·  "}
            {countLine(info)}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-2">
          {/* the default, and what this link has always done on its own */}
          <button
            type="button"
            autoFocus
            onClick={() => answer("video")}
            className={cn(
              choiceClass,
              "border-cyan-500 bg-cyan-50/70 hover:bg-cyan-50 dark:border-cyan-500/70 dark:bg-cyan-950/40 dark:hover:bg-cyan-950/60"
            )}
          >
            <span className="block text-sm font-semibold text-cyan-800 dark:text-cyan-200">
              {t("mixedLink.videoChoice")}
            </span>
            <span className="mt-0.5 block text-xs text-cyan-700/70 dark:text-cyan-300/70">
              {t("mixedLink.videoHint")}
            </span>
          </button>

          <button
            type="button"
            onClick={() => answer("playlist")}
            className={cn(
              choiceClass,
              "border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50 dark:hover:bg-slate-800"
            )}
          >
            <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
              {mixedLinkPlaylistChoice(info)}
            </span>
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
              {t("mixedLink.playlistHint")}
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
