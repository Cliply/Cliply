import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Check, Cookie, Copy, KeyRound } from "lucide-react"
import { cookiesApi, systemApi, type CookieStatus } from "@/lib/api"
import { useCookieStore } from "@/lib/cookieStore"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// the extensions yt-dlp's FAQ names. the chrome one has to be the LOCALLY
// build: the original "Get cookies.txt" was pulled from the web store as
// malware, so sending someone off to search for it by name is a hazard rather
// than a shortcut
const CHROME_EXTENSION =
  "https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
const FIREFOX_EXTENSION =
  "https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/"
const YTDLP_COOKIE_GUIDE =
  "https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"

/**
 * copied rather than opened, and that is not a shortcut we failed to take
 *
 * openExternal hands the url to the *default* browser, which may not be the
 * one they just signed into, and lands them on a fresh tab rather than the one
 * holding the session. A copy button puts the address where it does some good:
 * the tab they already have open.
 */
const ROBOTS_URL = "https://www.youtube.com/robots.txt"

function daysAgo(iso?: string | null): string | null {
  if (!iso) return null

  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return null

  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return "imported today"
  if (days === 1) return "imported yesterday"

  return `imported ${days} days ago`
}

export function CookieDialog() {
  const { isOpen, close } = useCookieStore()
  const [status, setStatus] = useState<CookieStatus | null>(null)
  const [busy, setBusy] = useState<"import" | "test" | "clear" | null>(null)
  const [copied, setCopied] = useState(false)
  // radix focuses the first tabbable node, which here is the extension link in
  // step 1 - so the dialog opened with a ring around a link rather than around
  // the thing the user came to do
  const importRef = useRef<HTMLButtonElement>(null)

  // reads are numbered so a slow one cannot land on top of a newer one. the
  // open-effect and the post-import refresh race by construction, and out of
  // order they repaint the dialog with the jar as it was before the import
  const reads = useRef(0)

  // read on open and after anything that touches the jar. nothing polls: the
  // file is a few kilobytes and main re-reads it per operation anyway, so a
  // rotation shows up the next time someone looks - which is when it matters
  const refresh = useCallback(async () => {
    const ticket = ++reads.current

    try {
      const next = await cookiesApi.getStatus()
      if (ticket === reads.current) setStatus(next)
      return next
    } catch {
      if (ticket === reads.current) setStatus(null)
      return null
    }
  }, [])

  useEffect(() => {
    if (isOpen) refresh()
  }, [isOpen, refresh])

  const signedIn = status?.hasValidCookies === true
  const imported = (status?.fileInfo.cookieCount ?? 0) > 0

  const handleImport = async () => {
    setBusy("import")
    try {
      const result = await cookiesApi.importFile()
      // null is a cancelled picker, which is not an outcome worth a toast
      if (result) {
        const next = await refresh()

        if (result.hasValidCookies) {
          toast.success("cookies imported", {
            description: "youtube will see you as signed in from now on."
          })
        } else {
          // an import that lands but is not a login used to say nothing at all,
          // which reads as the button doing nothing. main already worked out
          // which way it fell short
          toast.warning("imported, but not signed in", {
            description: next?.problem ?? "these cookies won't sign you in."
          })
        }
      }
    } catch (error) {
      toast.error("couldn't import that file", {
        description:
          error instanceof Error ? error.message : "couldn't import cookies"
      })
    } finally {
      setBusy(null)
    }
  }

  const handleTest = async () => {
    setBusy("test")
    try {
      const result = await cookiesApi.test()
      await refresh()

      // three outcomes, not two. titling this off cookiesLoaded alone put
      // "Cookies look fine" above a description explaining that YouTube had
      // just refused them
      if (result.rejected) {
        toast.warning("youtube turned these down", {
          description: result.note
        })
      } else {
        toast(result.cookiesLoaded ? "cookies look fine" : "cookies aren't usable", {
          description: result.note
        })
      }
    } catch (error) {
      toast.error("couldn't test the cookies", {
        description: error instanceof Error ? error.message : undefined
      })
    } finally {
      setBusy(null)
    }
  }

  const handleClear = async () => {
    setBusy("clear")
    try {
      await cookiesApi.clear()
      await refresh()
    } catch (error) {
      // a failure here means the jar is still on disk, which is the opposite
      // of what the screen would otherwise go on to show
      toast.error("couldn't remove the cookies", {
        description:
          error instanceof Error
            ? error.message
            : "they're still on this machine."
      })
      await refresh()
    } finally {
      // without this the button stayed spinning for the rest of the session
      setBusy(null)
    }
  }

  const openLink = (url: string) => () => {
    systemApi.openExternal(url)
  }

  const copyRobots = async () => {
    try {
      await navigator.clipboard.writeText(ROBOTS_URL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // clipboard is best-effort, and the address is on screen to type
      toast.error("couldn't copy that", {
        description: "type youtube.com/robots.txt into that tab instead."
      })
    }
  }

  const linkClass =
    "text-cyan-600 underline underline-offset-2 hover:text-cyan-500 dark:text-cyan-400"

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        // outline-none is doing real work: radix focuses the content itself,
        // and chromium then paints its platform focus ring around it - which on
        // macos follows the system accent colour, so the dialog picked up a
        // thick orange boundary that is nothing to do with our palette
        className="font-space-grotesk outline-none sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          importRef.current?.focus()
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-100 text-cyan-600 dark:bg-cyan-950/60 dark:text-cyan-400">
              <Cookie className="h-4 w-4" />
            </span>
            <DialogTitle className="text-slate-900 dark:text-white">
              youtube cookies
            </DialogTitle>
          </div>
          <DialogDescription className="text-slate-500 dark:text-slate-400">
            youtube sometimes decides this machine looks like a bot, usually
            because of your network rather than anything you did. a cookie file
            from your own browser is how you tell it otherwise.
          </DialogDescription>
        </DialogHeader>

        {/* before the ask, not after it. someone uneasy about handing over a
            youtube session has already decided by the time they reach a
            footnote. three bullets was the reassurance arguing its case, which
            protests slightly too much - one line lands better and stays put
            whether or not there is a jar yet */}
        <p className="flex gap-2.5 rounded-xl bg-cyan-50/70 p-3 text-sm text-slate-600 dark:bg-cyan-950/20 dark:text-slate-300">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-600 dark:text-cyan-400" />
          <span>
            you sign in to youtube in your own browser, never to cliply. the
            file it gives you stays on this device, and remove deletes it.
          </span>
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-2.5 border-b border-slate-200 pb-3 text-sm dark:border-slate-700/60">
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                signedIn
                  ? "bg-cyan-500 ring-4 ring-cyan-500/15"
                  : imported
                    ? "bg-amber-500"
                    : "bg-slate-400"
              )}
            />
            <span className="text-slate-700 dark:text-slate-200">
              {signedIn
                ? `signed in · ${status?.fileInfo.youtubeCookieCount ?? 0} cookies`
                : (status?.problem ?? "nothing imported yet")}
            </span>
            {imported && daysAgo(status?.status?.lastImport) && (
              <span className="ml-auto shrink-0 text-xs text-slate-400 dark:text-slate-500">
                {daysAgo(status?.status?.lastImport)}
              </span>
            )}
          </div>

          {/* a jar that stopped working is not the same as no jar, and used
              to render identically to one - same layout, same button, no trace
              that an import ever happened. that reads as "it deleted them" */}
          {imported && !signedIn && (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              your file is still here
              {status?.fileInfo.youtubeCookieCount
                ? ` (${status.fileInfo.youtubeCookieCount} cookies)`
                : ""}
              , it just stopped working. nothing got deleted. grab a fresh
              export and import it over the top.
            </p>
          )}

          {/* the instructions are the empty state, not permanent furniture -
              once the cookies work they are noise, and the dialog is better
              for losing them */}
          {!signedIn && (
            <>
              {/* the throwaway-account warning used to sit on its own with an
                  amber bar down the side, shouting. it belongs with the step it
                  is actually about, which is also where someone is deciding
                  which account to use */}
              <ol className="space-y-3 text-sm">
                <Step n={1}>
                  install{" "}
                  <button className={linkClass} onClick={openLink(CHROME_EXTENSION)}>
                    get cookies.txt LOCALLY
                  </button>{" "}
                  (chrome) or{" "}
                  <button className={linkClass} onClick={openLink(FIREFOX_EXTENSION)}>
                    cookies.txt
                  </button>{" "}
                  (firefox)
                </Step>

                <Step
                  n={2}
                  note="use a spare account if you have one. youtube has been known to ban accounts it catches using downloaders."
                >
                  open youtube in your browser and sign in
                </Step>

                <Step
                  n={3}
                  note="parks the tab somewhere youtube isn't handing out fresh cookies."
                >
                  in that same tab, go to{" "}
                  <button
                    onClick={copyRobots}
                    className="inline-flex items-center gap-1.5 rounded bg-slate-200/70 px-1.5 py-0.5 align-middle text-xs text-cyan-700 transition-colors hover:bg-slate-200 dark:bg-slate-900/60 dark:text-cyan-400 dark:hover:bg-slate-900"
                  >
                    youtube.com/robots.txt
                    {copied ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3 opacity-60" />
                    )}
                  </button>{" "}
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {copied ? "copied, paste it there" : "click to copy"}
                  </span>
                </Step>

                <Step
                  n={4}
                  note="worth doing straight away. youtube refreshes its cookies on open youtube tabs, so the longer that one stays up the sooner your export goes stale."
                >
                  export the cookies, then <Em>close that tab</Em>
                </Step>

                <Step n={5}>import that file here</Step>
              </ol>
            </>
          )}

          <div className="flex items-center gap-2">
            <Button ref={importRef} onClick={handleImport} disabled={busy !== null}>
              {busy === "import"
                ? "importing…"
                : signedIn
                  ? "replace…"
                  : imported
                    ? "try again…"
                    : "import cookies…"}
            </Button>

            {imported && (
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={busy !== null}
              >
                {busy === "test" ? "testing…" : "test"}
              </Button>
            )}

            {imported && (
              <Button
                variant="ghost"
                className="ml-auto text-slate-500 dark:text-slate-400"
                onClick={handleClear}
                disabled={busy !== null}
              >
                remove
              </Button>
            )}
          </div>

          <p className="text-xs text-slate-400 dark:text-slate-500">
            {signedIn ? (
              "youtube rotates these out eventually. when it does, cliply will say so right here."
            ) : (
              <>
                {/* "these steps are yt-dlp's own" stopped being true once the
                    private window came out of step 2. based on is honest,
                    are is not */}
                based on yt-dlp&apos;s own guide.{" "}
                <button className={linkClass} onClick={openLink(YTDLP_COOKIE_GUIDE)}>
                  read theirs
                </button>
              </>
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Step({
  n,
  note,
  children
}: {
  n: number
  note?: string
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-2.5 text-slate-600 dark:text-slate-300">
      <span className="mt-0.5 w-3 shrink-0 text-xs text-slate-400 tabular-nums dark:text-slate-600">
        {n}
      </span>
      <span>
        {children}
        {/* the reason sits under the instruction rather than beside it, so
            somebody following along can skip every one of them and still end up
            with working cookies */}
        {note && (
          <span className="mt-0.5 block text-xs text-slate-400 dark:text-slate-500">
            {note}
          </span>
        )}
      </span>
    </li>
  )
}

function Em({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-medium text-slate-900 dark:text-white">{children}</span>
  )
}
