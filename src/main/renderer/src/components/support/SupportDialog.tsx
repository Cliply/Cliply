import { useEffect, useState } from "react"
import { Coffee } from "lucide-react"
import { systemApi } from "@/lib/api"
import { track } from "@/lib/analytics"
import { useT } from "@/lib/i18n"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

/** the app's voice, spelled out because `font-mono` maps to an undefined var */
const GEIST_MONO =
  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'

const BUY_ME_A_COFFEE = "https://buymeacoffee.com/itssdevk"

/**
 * the coffee ask, on the few downloads main decides are milestones
 *
 * it appears only after a download has succeeded, which is the one moment the
 * app has just done something for you rather than asked something of you. Main
 * owns the counting and the cadence - deliberately not named here, since this
 * comment said "three times" for a while after the sequence grew to five - so
 * this component has no schedule of its own to get wrong.
 *
 * "no thanks" is a real button rather than a greyed-out afterthought, because
 * an ask that makes declining awkward is not a request, and a sequence that
 * ends is one where no can be taken for an answer.
 */
export function SupportDialog() {
  const t = useT()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    const off = window.electronAPI?.support?.onMilestone?.((data) => {
      setCount(typeof data?.count === "number" ? data.count : 0)
    })

    return () => off?.()
  }, [])

  const close = () => setCount(null)

  return (
    <Dialog open={count !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="outline-none sm:max-w-md"
        style={{ fontFamily: GEIST_MONO }}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400">
              <Coffee className="h-4 w-4" />
            </span>
            <DialogTitle className="text-base font-medium text-slate-900 dark:text-white">
              {t("support.title", { n: count ?? 0 })}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {t("support.description")}
          </DialogDescription>
        </DialogHeader>

        {/* the reassurance came out. "this won't keep asking" and "that's
            genuinely fine" were the ask explaining itself, and an ask that
            explains itself sounds like it expects to be turned down. one line
            and two buttons says the same thing by not going on about it */}
        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          {t("support.ask")}
        </p>

        <div className="flex items-center gap-2">
          <Button
            className="text-xs"
            onClick={() => {
              // main captures the prompt being shown; this is the other half.
              // which button was pressed is only ever visible from here
              track("support_prompt_clicked", { milestone: count })
              systemApi.openExternal(BUY_ME_A_COFFEE)
              close()
            }}
          >
            {/* the same ask the hero footer makes, in the same words */}
            {t("hero.donate")}
          </Button>
          <Button
            variant="ghost"
            className="text-xs text-slate-500 dark:text-slate-400"
            onClick={close}
          >
            {t("support.decline")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
