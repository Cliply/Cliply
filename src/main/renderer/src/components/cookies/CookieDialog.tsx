import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Check, Cookie, Copy, KeyRound } from "lucide-react"
import { CookieError, cookiesApi, systemApi, type CookieStatus } from "@/lib/api"
import { useCookieStore } from "@/lib/cookieStore"
import { localizeCode, t, useLocale } from "@/lib/i18n"
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
// the chrome store localizes itself from the account; addons.mozilla.org takes
// the language in the path and would otherwise land a russian reader on english
const FIREFOX_EXTENSION = (locale: string) =>
  `https://addons.mozilla.org/${locale === "ru" ? "ru" : "en-US"}/firefox/addon/cookies-txt/`
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
  if (days <= 0) return t("cookies.importedToday")
  if (days === 1) return t("cookies.importedYesterday")

  return t("cookies.importedDaysAgo", { n: days })
}

export function CookieDialog() {
  // also the re-render when the locale flips, which every t() below needs
  const locale = useLocale((s) => s.locale)
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
  // nothing has ever been imported here, as opposed to something having been
  // imported and gone wrong. a file yt-dlp refuses outright inspects as zero
  // cookies, so it has to be excluded or a malformed jar reads as a fresh start
  const untouched = !imported && !status?.fileInfo.loadError

  const handleImport = async () => {
    setBusy("import")
    try {
      const result = await cookiesApi.importFile()
      // null is a cancelled picker, which is not an outcome worth a toast
      if (result) {
        const next = await refresh()

        if (result.hasValidCookies) {
          toast.success(t("cookies.imported"), {
            description: t("cookies.importedDesc")
          })
        } else {
          // an import that lands but is not a login used to say nothing at all,
          // which reads as the button doing nothing. main already worked out
          // which way it fell short
          toast.warning(t("cookies.notSignedIn"), {
            description: next?.problem
              ? localizeCode(next.problemCode, next.problem)
              : t("cookies.notSignedInDesc")
          })
        }
      }
    } catch (error) {
      toast.error(t("cookies.importFailed"), {
        description:
          error instanceof Error
            ? localizeCode(
                error instanceof CookieError ? error.code : null,
                error.message
              )
            : t("cookies.importFailedDesc")
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
      const note = localizeCode(result.noteCode, result.note)

      if (result.rejected) {
        toast.warning(t("cookies.turnedDown"), { description: note })
      } else {
        toast(t(result.cookiesLoaded ? "cookies.lookFine" : "cookies.notUsable"), {
          description: note
        })
      }
    } catch (error) {
      toast.error(t("cookies.testFailed"), {
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
      toast.error(t("cookies.removeFailed"), {
        description:
          error instanceof Error ? error.message : t("cookies.removeFailedDesc")
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
      toast.error(t("cookies.copyFailed"), {
        description: t("cookies.copyFailedDesc")
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
              {t("cookies.title")}
            </DialogTitle>
          </div>
          <DialogDescription className="text-slate-500 dark:text-slate-400">
            {t("cookies.description")}
          </DialogDescription>
        </DialogHeader>

        {/* before the ask, not after it: someone uneasy about handing over a
            youtube session has already decided by the time they reach a
            footnote */}
        <div className="flex gap-2.5 rounded-xl bg-cyan-50/70 p-3 text-sm dark:bg-cyan-950/20">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-600 dark:text-cyan-400" />
          <div className="space-y-1">
            <p className="text-slate-600 dark:text-slate-300">
              {t("cookies.privacy")}
            </p>
            {/* borrowed credibility. "some app wants my youtube session" is a
                reasonable thing to balk at, and the answer is that this is the
                documented way the tool underneath asks for them */}
            <p className="text-xs text-slate-400 dark:text-slate-500">
              {t("cookies.ytdlpCredit")}{" "}
              <button className={linkClass} onClick={openLink(YTDLP_COOKIE_GUIDE)}>
                {t("cookies.readGuide")}
              </button>
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {/* a fresh install has no status, and reporting one anyway just told
              somebody what they were missing before showing them how to fix it.
              the row is a heading for the steps in that case, and only turns
              back into a status once there is a file to have a status about.
              a jar yt-dlp refuses whole counts as zero cookies, so it is asked
              about separately - "here's how to import them" is the wrong thing
              to say about a file that is sitting right there, malformed */}
          <div className="flex items-center gap-2.5 border-b border-slate-200 pb-3 text-sm dark:border-slate-700/60">
            {!untouched && (
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  signedIn ? "bg-cyan-500 ring-4 ring-cyan-500/15" : "bg-amber-500"
                )}
              />
            )}
            <span className="text-slate-700 dark:text-slate-200">
              {signedIn
                ? `${t("cookies.signedIn")} · ${t("cookies.count", {
                    n: status?.fileInfo.youtubeCookieCount ?? 0
                  })}`
                : untouched
                  ? t("cookies.howTo")
                  : localizeCode(status?.problemCode, status?.problem ?? "")}
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
              {t("cookies.stillHere")}
              {status?.fileInfo.youtubeCookieCount
                ? ` (${t("cookies.count", {
                    n: status.fileInfo.youtubeCookieCount
                  })})`
                : ""}
              {t("cookies.stillHereRest")}
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
                  {t("cookies.step1")}{" "}
                  <button className={linkClass} onClick={openLink(CHROME_EXTENSION)}>
                    get cookies.txt LOCALLY
                  </button>{" "}
                  {t("cookies.step1or")}{" "}
                  <button
                    className={linkClass}
                    onClick={openLink(FIREFOX_EXTENSION(locale))}
                  >
                    cookies.txt
                  </button>{" "}
                  {t("cookies.step1firefox")}
                </Step>

                <Step n={2} note={t("cookies.step2note")}>
                  {t("cookies.step2")}
                </Step>

                <Step n={3} note={t("cookies.step3note")}>
                  {t("cookies.step3")}{" "}
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
                    {t(copied ? "cookies.copied" : "cookies.copyHint")}
                  </span>
                </Step>

                {/* "export the cookies" assumed people know what that means as
                    a gesture. it is a toolbar icon and a button, and saying so
                    is the difference between following the steps and giving up
                    on step 4 */}
                <Step n={4} note={t("cookies.step4note")}>
                  {t("cookies.step4")} <Em>{t("cookies.step4export")}</Em>
                </Step>

                {/* the trim took the point out with the words: "youtube keeps
                    refreshing cookies on open tabs" says what youtube does and
                    leaves the reader to work out why they should care. the
                    consequence is the whole reason the step exists */}
                <Step n={5} note={t("cookies.step5note")}>
                  {t("cookies.step5")}
                </Step>

                <Step n={6}>{t("cookies.step6")}</Step>
              </ol>
            </>
          )}

          <div className="flex items-center gap-2">
            <Button ref={importRef} onClick={handleImport} disabled={busy !== null}>
              {t(
                busy === "import"
                  ? "cookies.importing"
                  : signedIn
                    ? "cookies.replace"
                    : imported
                      ? "cookies.tryAgain"
                      : "cookies.import"
              )}
            </Button>

            {imported && (
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={busy !== null}
              >
                {t(busy === "test" ? "cookies.testing" : "cookies.test")}
              </Button>
            )}

            {imported && (
              <Button
                variant="ghost"
                className="ml-auto text-slate-500 dark:text-slate-400"
                onClick={handleClear}
                disabled={busy !== null}
              >
                {t("cookies.remove")}
              </Button>
            )}
          </div>

          {/* the yt-dlp credit moved up into the panel, where the doubt it
              answers actually is. saying it twice in one dialog reads as
              insisting */}
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {t(signedIn ? "cookies.footerSignedIn" : "cookies.footer")}
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
