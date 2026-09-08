import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Cookie } from "lucide-react"
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
          toast.success("Cookies imported", {
            description: "YouTube will see you as signed in from now on."
          })
        } else {
          // an import that lands but is not a login used to say nothing at all,
          // which reads as the button doing nothing. main already worked out
          // which way it fell short
          toast.warning("Imported, but not signed in", {
            description: next?.problem ?? "These cookies won't authenticate you."
          })
        }
      }
    } catch (error) {
      toast.error("Couldn't import that file", {
        description:
          error instanceof Error ? error.message : "Failed to import cookies"
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
        toast.warning("YouTube turned these cookies down", {
          description: result.note
        })
      } else {
        toast(result.cookiesLoaded ? "Cookies look fine" : "Cookies aren't usable", {
          description: result.note
        })
      }
    } catch (error) {
      toast.error("Couldn't test the cookies", {
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
      toast.error("Couldn't remove the cookies", {
        description:
          error instanceof Error
            ? error.message
            : "They're still on this machine."
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

  const cardClass =
    "rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700/60 dark:bg-slate-800/50"
  const linkClass =
    "text-cyan-600 underline underline-offset-2 hover:text-cyan-500 dark:text-cyan-400"

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="font-space-grotesk sm:max-w-lg"
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
              YouTube cookies
            </DialogTitle>
          </div>
          <DialogDescription className="text-slate-500 dark:text-slate-400">
            Only needed when YouTube stops trusting this machine. Signing in
            makes it judge the account instead of your connection.
          </DialogDescription>
        </DialogHeader>

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
                ? `Signed in · ${status?.fileInfo.youtubeCookieCount ?? 0} cookies`
                : (status?.problem ?? "Not imported")}
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
              The file you imported is still here
              {status?.fileInfo.youtubeCookieCount
                ? ` (${status.fileInfo.youtubeCookieCount} cookies)`
                : ""}
              , it just stopped working. Nothing was deleted — export a fresh
              one and import it over the top.
            </p>
          )}

          {/* the instructions are the empty state, not permanent furniture -
              once the cookies work they are noise, and the dialog is better
              for losing them */}
          {!signedIn && (
            <>
              <p className="border-l-2 border-amber-500 pl-3 text-sm text-amber-700 dark:text-amber-300">
                <span className="font-medium">Use a throwaway account.</span>{" "}
                YouTube can ban accounts used with downloaders.
              </p>

              <ol className={cn(cardClass, "space-y-2 text-sm")}>
                <Step n={1}>
                  Install{" "}
                  <button className={linkClass} onClick={openLink(CHROME_EXTENSION)}>
                    Get cookies.txt LOCALLY
                  </button>{" "}
                  (Chrome) or{" "}
                  <button className={linkClass} onClick={openLink(FIREFOX_EXTENSION)}>
                    cookies.txt
                  </button>{" "}
                  (Firefox)
                </Step>
                <Step n={2}>
                  Open a <Em>private window</Em> and sign in to YouTube
                </Step>
                <Step n={3}>
                  In that same tab, go to{" "}
                  <code className="rounded bg-slate-200/70 px-1 py-0.5 text-xs text-cyan-700 dark:bg-slate-900/60 dark:text-cyan-400">
                    youtube.com/robots.txt
                  </code>
                </Step>
                <Step n={4}>
                  Export the cookies, then <Em>close the private window</Em>
                </Step>
                <Step n={5}>Import the file below</Step>
              </ol>
            </>
          )}

          <div className="flex items-center gap-2">
            <Button ref={importRef} onClick={handleImport} disabled={busy !== null}>
              {busy === "import"
                ? "Importing…"
                : signedIn
                  ? "Replace…"
                  : imported
                    ? "Import again…"
                    : "Import cookies…"}
            </Button>

            {imported && (
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={busy !== null}
              >
                {busy === "test" ? "Testing…" : "Test"}
              </Button>
            )}

            {imported && (
              <Button
                variant="ghost"
                className="ml-auto text-slate-500 dark:text-slate-400"
                onClick={handleClear}
                disabled={busy !== null}
              >
                Remove
              </Button>
            )}
          </div>

          <p className="text-xs text-slate-400 dark:text-slate-500">
            {signedIn ? (
              "YouTube rotates these out eventually. When it does, Cliply will say so here."
            ) : (
              <>
                Closing the private window is what keeps them working — YouTube
                expires cookies from tabs left open.{" "}
                <button className={linkClass} onClick={openLink(YTDLP_COOKIE_GUIDE)}>
                  Why?
                </button>
              </>
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 text-slate-600 dark:text-slate-300">
      <span className="w-3 shrink-0 text-xs text-slate-400 tabular-nums dark:text-slate-600">
        {n}
      </span>
      <span>{children}</span>
    </li>
  )
}

function Em({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-medium text-slate-900 dark:text-white">{children}</span>
  )
}
