import { useEffect, useState } from "react"
import { Coffee } from "lucide-react"
import { systemApi } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

const BUY_ME_A_COFFEE = "https://buymeacoffee.com/itssdevk"

/**
 * the coffee ask, on the third, fifteenth and fortieth file somebody gets out
 * of this
 *
 * it appears after a download has already succeeded, which is the one moment
 * the app has just done something for you rather than asked something of you.
 * Main owns the counting and only sends the event on those three, so this
 * component has no cadence logic of its own to get wrong.
 *
 * "no thanks" is a real button and not a greyed-out afterthought, because an
 * ask that makes the decline awkward is not a request, and the whole point of
 * only asking three times is that a no can be taken for an answer.
 */
export function SupportDialog() {
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
      <DialogContent className="font-space-grotesk outline-none sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400">
              <Coffee className="h-4 w-4" />
            </span>
            <DialogTitle className="text-slate-900 dark:text-white">
              that&apos;s {count} downloads
            </DialogTitle>
          </div>
          <DialogDescription className="text-slate-500 dark:text-slate-400">
            cliply is free, has no ads, and doesn&apos;t track you. it&apos;s
            built and kept working by one person in their spare time, mostly
            against youtube changing things on purpose.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-slate-600 dark:text-slate-300">
          if it&apos;s saved you some time, a coffee helps. if not, that&apos;s
          genuinely fine, and this won&apos;t keep asking.
        </p>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              systemApi.openExternal(BUY_ME_A_COFFEE)
              close()
            }}
          >
            buy me a coffee
          </Button>
          <Button
            variant="ghost"
            className="text-slate-500 dark:text-slate-400"
            onClick={close}
          >
            no thanks
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
