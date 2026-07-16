# One-Click Issue Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Report" button on failed downloads that opens a prefilled GitHub issue at `github.com/Cliply/Cliply/issues/new` with error details, redacted logs, and system info.

**Architecture:** Python already produces `"<short>\n\n<technical>"` error strings (commit `1bc4c5a`). Electron main adds `details`/`category` to download error responses plus a `diagnostics:get` IPC. The renderer carries those through a `DownloadError` class into a zustand `reportStore`, and a `ReportIssueDialog` builds the issue URL via pure functions in `lib/report.ts` (unit-tested with vitest).

**Tech Stack:** FastAPI/yt-dlp (python), Electron IPC (main/preload), React 19 + zustand + Radix Dialog + sonner (renderer), vitest (new, renderer-only).

**Spec:** `docs/superpowers/specs/2026-07-15-report-issue-design.md`

## Global Constraints

- Repo issue URL: `https://github.com/Cliply/Cliply/issues/new`; labels: `bug,auto-report`.
- Full generated URL must stay under **8,000 characters** (trim log lines to fit).
- Video URL included in report **only** when the user opts in (checkbox default off).
- Never block or break the download flow — reporting is strictly additive.
- Match existing code style: no semicolons in renderer TS, double quotes, 2-space indent.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Error payload plumbing (Python + Electron main)

**Files:**
- Modify: `python/server.py` (root endpoint, ~line 142)
- Modify: `src/main/ipc-handlers.js` (`createError` ~line 68, combined-download catch ~line 410, audio-download catch ~line 547)

**Interfaces:**
- Produces: download error IPC responses now include `error.details` (full technical string) and `error.category` (e.g. `"FFMPEG_AV_BLOCKED"`). Python root `/` response includes `yt_dlp_version: string`.

- [ ] **Step 1: Add yt-dlp version to Python root endpoint**

In `python/server.py`, add near the other imports (top of file):

```python
import yt_dlp
```

In the `root()` endpoint's returned dict, after `"ffmpeg_available"`:

```python
        "yt_dlp_version": yt_dlp.version.__version__,
```

- [ ] **Step 2: Verify with the running server**

Run: `cd python && { test -x venv/bin/python && venv/bin/python server.py & }; sleep 3; curl -s http://127.0.0.1:8888/ | python3 -c "import json,sys; print(json.load(sys.stdin)['yt_dlp_version'])"; pkill -f "python server.py"`
Expected: a version string like `2026.03.17`

- [ ] **Step 3: Extend createError with extra fields**

In `src/main/ipc-handlers.js`, replace the `createError` method:

```js
  // create standardized error response
  createError(
    message,
    suggestion = "Please try again",
    code = "GENERAL_ERROR",
    extra = null
  ) {
    return {
      success: false,
      error: { message, suggestion, code, ...(extra || {}) }
    }
  }
```

- [ ] **Step 4: Pass details + category from both download handlers**

In `handleDownloadCombined`'s catch block, replace the final `return this.createError(...)`:

```js
      return this.createError(
        shortErrorMessage(error.message),
        "Please try again or check your connection",
        "DOWNLOAD_FAILED",
        {
          details: error.message,
          category: categorizeError(error.message)
        }
      )
```

Apply the identical change in `handleDownloadAudio`'s catch block (same code, ~line 547).

- [ ] **Step 5: Verify syntax and commit**

Run: `node --check src/main/ipc-handlers.js && cd python && venv/bin/python -m py_compile server.py`
Expected: no output (both pass)

```bash
git add python/server.py src/main/ipc-handlers.js
git commit -m "feat: carry error details and category to renderer, expose yt-dlp version

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: diagnostics:get IPC

**Files:**
- Modify: `src/main/utils/constants.js` (IPC_CHANNELS, ~line 147)
- Modify: `src/main/ipc-handlers.js` (imports line 3, handler registration ~line 160, new handler, validated-channels list ~line 1013)
- Modify: `src/preload/preload.js` (IPC_CHANNELS ~line 46, system section ~line 121)

**Interfaces:**
- Produces: `electronAPI.system.getDiagnostics()` → `IPCResponse<{ appVersion, electronVersion, platform, osRelease, arch, ffmpegAvailable, ytDlpVersion }>` (server-derived fields `null` when the Python server is down).

- [ ] **Step 1: Register the channel name**

`src/main/utils/constants.js`, in `IPC_CHANNELS` under `// system operations`:

```js
  SYSTEM_GET_DIAGNOSTICS: "system:get-diagnostics",
```

`src/preload/preload.js`, same addition to its local `IPC_CHANNELS` copy under `// system`.

- [ ] **Step 2: Implement the handler**

`src/main/ipc-handlers.js` — change line 3 to also import `app`:

```js
const { ipcMain, dialog, app } = require("electron")
```

Add `const os = require("os")` after the existing requires. Register in `setupHandlers` next to the other system handlers:

```js
    ipcMain.handle(
      IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS,
      this.handleGetDiagnostics.bind(this)
    )
```

Add the handler method (near `handleGetHealth`):

```js
  // collect environment info for issue reports
  async handleGetDiagnostics(_event) {
    let ffmpegAvailable = null
    let ytDlpVersion = null

    try {
      if (this.serverManager.isServerReady()) {
        const response = await this.serverManager.makeRequest("/", {
          method: "GET"
        })
        const status = await response.json()
        ffmpegAvailable = status.ffmpeg_available ?? null
        ytDlpVersion = status.yt_dlp_version ?? null
      }
    } catch (error) {
      console.warn("diagnostics: server status unavailable:", error.message)
    }

    return this.createSuccess({
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      ffmpegAvailable,
      ytDlpVersion
    })
  }
```

Add `IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS` to the validated-channels array (~line 1013, next to `SYSTEM_OPEN_EXTERNAL`).

- [ ] **Step 3: Expose in preload**

`src/preload/preload.js`, in the `system` section:

```js
    getDiagnostics: () => invoke(IPC_CHANNELS.SYSTEM_GET_DIAGNOSTICS),
```

- [ ] **Step 4: Verify and commit**

Run: `node --check src/main/ipc-handlers.js && node --check src/preload/preload.js && node --check src/main/utils/constants.js`
Expected: no output

```bash
git add src/main/utils/constants.js src/main/ipc-handlers.js src/preload/preload.js
git commit -m "feat: add diagnostics:get IPC for issue reports

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Report builder (pure functions, TDD with vitest)

**Files:**
- Modify: `src/main/renderer/package.json` (add vitest + test script)
- Create: `src/main/renderer/src/lib/report.ts`
- Test: `src/main/renderer/src/lib/report.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 4–6):

```ts
export interface ReportContext {
  shortMessage: string
  details?: string
  category?: string
  platform?: string        // "youtube" | "pinterest" | "tiktok"
  downloadType?: "video" | "audio"
  videoUrl?: string
}

export interface ReportEnvironment {
  appVersion: string | null
  electronVersion: string | null
  platform: string | null
  osRelease: string | null
  arch: string | null
  ffmpegAvailable: boolean | null
  ytDlpVersion: string | null
}

export interface ReportInput {
  context: ReportContext
  environment: ReportEnvironment | null
  userNotes: string
  includeVideoUrl: boolean
}

export const ISSUES_NEW_URL = "https://github.com/Cliply/Cliply/issues/new"
export function buildIssueTitle(context: ReportContext): string
export function buildIssueBody(input: ReportInput): string
export function buildIssueUrl(input: ReportInput): { url: string; truncated: boolean }
```

- [ ] **Step 1: Install vitest in the renderer package**

Run: `cd src/main/renderer && npm install -D vitest`
Add to `src/main/renderer/package.json` scripts: `"test": "vitest run"`

- [ ] **Step 2: Write the failing tests**

Create `src/main/renderer/src/lib/report.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  buildIssueBody,
  buildIssueTitle,
  buildIssueUrl,
  type ReportInput
} from "./report"

const baseInput: ReportInput = {
  context: {
    shortMessage: "Antivirus may have blocked FFmpeg.",
    details:
      "ffmpeg exited with code 183\n\nFFmpeg output:\nERROR: killed by signal",
    category: "FFMPEG_AV_BLOCKED",
    platform: "youtube",
    downloadType: "video",
    videoUrl: "https://youtube.com/watch?v=secret123"
  },
  environment: {
    appVersion: "0.3.1",
    electronVersion: "28.3.3",
    platform: "darwin",
    osRelease: "25.3.0",
    arch: "arm64",
    ffmpegAvailable: true,
    ytDlpVersion: "2026.03.17"
  },
  userNotes: "I clicked download and it failed",
  includeVideoUrl: false
}

describe("buildIssueTitle", () => {
  it("uses category and short message", () => {
    expect(buildIssueTitle(baseInput.context)).toBe(
      "[FFMPEG_AV_BLOCKED] Antivirus may have blocked FFmpeg."
    )
  })

  it("falls back when category is missing", () => {
    const title = buildIssueTitle({ shortMessage: "Something broke" })
    expect(title).toBe("[DOWNLOAD_FAILED] Something broke")
  })

  it("truncates long messages to 80 chars of message", () => {
    const title = buildIssueTitle({ shortMessage: "x".repeat(200) })
    expect(title.length).toBeLessThanOrEqual(100)
  })
})

describe("buildIssueBody", () => {
  it("includes notes, error, environment, and logs", () => {
    const body = buildIssueBody(baseInput)
    expect(body).toContain("I clicked download and it failed")
    expect(body).toContain("Antivirus may have blocked FFmpeg.")
    expect(body).toContain("0.3.1")
    expect(body).toContain("ffmpeg exited with code 183")
  })

  it("omits the video URL unless opted in", () => {
    expect(buildIssueBody(baseInput)).not.toContain("secret123")
    const withUrl = buildIssueBody({ ...baseInput, includeVideoUrl: true })
    expect(withUrl).toContain("https://youtube.com/watch?v=secret123")
  })

  it("handles missing details and environment", () => {
    const body = buildIssueBody({
      context: { shortMessage: "Plain failure" },
      environment: null,
      userNotes: "",
      includeVideoUrl: false
    })
    expect(body).toContain("Plain failure")
    expect(body).toContain("unknown")
  })
})

describe("buildIssueUrl", () => {
  it("builds a github new-issue url with labels", () => {
    const { url, truncated } = buildIssueUrl(baseInput)
    expect(url.startsWith("https://github.com/Cliply/Cliply/issues/new?")).toBe(
      true
    )
    expect(url).toContain("labels=bug%2Cauto-report")
    expect(truncated).toBe(false)
  })

  it("trims log lines until the url fits 8000 chars", () => {
    const bigLog = Array.from({ length: 500 }, (_, i) => `log line ${i}`).join(
      "\n"
    )
    const { url, truncated } = buildIssueUrl({
      ...baseInput,
      context: { ...baseInput.context, details: bigLog }
    })
    expect(url.length).toBeLessThanOrEqual(8000)
    expect(truncated).toBe(true)
    expect(decodeURIComponent(url)).toContain("log line 499") // keeps the tail
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src/main/renderer && npx vitest run src/lib/report.test.ts`
Expected: FAIL — cannot resolve `./report`

- [ ] **Step 4: Implement report.ts**

Create `src/main/renderer/src/lib/report.ts`:

```ts
export interface ReportContext {
  shortMessage: string
  details?: string
  category?: string
  platform?: string
  downloadType?: "video" | "audio"
  videoUrl?: string
}

export interface ReportEnvironment {
  appVersion: string | null
  electronVersion: string | null
  platform: string | null
  osRelease: string | null
  arch: string | null
  ffmpegAvailable: boolean | null
  ytDlpVersion: string | null
}

export interface ReportInput {
  context: ReportContext
  environment: ReportEnvironment | null
  userNotes: string
  includeVideoUrl: boolean
}

export const ISSUES_NEW_URL = "https://github.com/Cliply/Cliply/issues/new"
const LABELS = "bug,auto-report"
const URL_BUDGET = 8000

export function buildIssueTitle(context: ReportContext): string {
  const category = context.category || "DOWNLOAD_FAILED"
  const message = context.shortMessage.slice(0, 80)
  return `[${category}] ${message}`
}

function environmentSection(env: ReportEnvironment | null): string {
  const value = (v: string | boolean | null | undefined) =>
    v === null || v === undefined ? "unknown" : String(v)
  return [
    "| Field | Value |",
    "| --- | --- |",
    `| Cliply | ${value(env?.appVersion)} |`,
    `| OS | ${value(env?.platform)} ${value(env?.osRelease)} (${value(env?.arch)}) |`,
    `| Electron | ${value(env?.electronVersion)} |`,
    `| yt-dlp | ${value(env?.ytDlpVersion)} |`,
    `| FFmpeg available | ${value(env?.ffmpegAvailable)} |`
  ].join("\n")
}

function assembleBody(input: ReportInput, logLines: string[]): string {
  const { context, environment, userNotes, includeVideoUrl } = input
  const sections: string[] = []

  sections.push("### What happened")
  sections.push(userNotes.trim() || "_No description provided._")

  sections.push("### Error")
  sections.push(`> ${context.shortMessage}`)
  sections.push(`Category: \`${context.category || "unknown"}\``)
  if (context.platform) {
    sections.push(
      `Platform: ${context.platform} (${context.downloadType || "video"})`
    )
  }
  if (includeVideoUrl && context.videoUrl) {
    sections.push(`URL: ${context.videoUrl}`)
  }

  sections.push("### Environment")
  sections.push(environmentSection(environment))

  if (logLines.length > 0) {
    sections.push("### Technical details")
    sections.push(
      `<details><summary>Logs</summary>\n\n\`\`\`\n${logLines.join("\n")}\n\`\`\`\n\n</details>`
    )
  }

  sections.push("_Reported from the Cliply app._")
  return sections.join("\n\n")
}

export function buildIssueBody(input: ReportInput): string {
  const logLines = input.context.details
    ? input.context.details.split("\n")
    : []
  return assembleBody(input, logLines)
}

export function buildIssueUrl(input: ReportInput): {
  url: string
  truncated: boolean
} {
  const title = buildIssueTitle(input.context)
  let logLines = input.context.details
    ? input.context.details.split("\n")
    : []
  let truncated = false

  const toUrl = (lines: string[]) => {
    const params = new URLSearchParams({
      title,
      labels: LABELS,
      body: assembleBody(input, lines)
    })
    return `${ISSUES_NEW_URL}?${params.toString()}`
  }

  let url = toUrl(logLines)
  while (url.length > URL_BUDGET && logLines.length > 0) {
    logLines = logLines.slice(1) // drop oldest line, keep the tail
    truncated = true
    url = toUrl(logLines)
  }
  return { url, truncated }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/main/renderer && npx vitest run src/lib/report.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/renderer/package.json src/main/renderer/package-lock.json src/main/renderer/src/lib/report.ts src/main/renderer/src/lib/report.test.ts
git commit -m "feat: issue-report body/url builders with vitest coverage

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Propagate details through the renderer API layer

**Files:**
- Modify: `src/main/renderer/src/lib/api.ts` (`ApiError` ~line 155, `IPCResponse` global decl `system` block ~line 460, `videoApi.downloadVideo` ~line 350, `audioApi.downloadAudio` ~line 327, `pinterestApi.download` ~line 394, `tiktokApi.download` ~line 428, `systemApi`)

**Interfaces:**
- Consumes: IPC `error.details`/`error.category` (Task 1), `system.getDiagnostics` (Task 2), `ReportEnvironment` (Task 3).
- Produces: `class DownloadError extends Error { details?: string; category?: string }`; `systemApi.getDiagnostics(): Promise<ReportEnvironment | null>`.

- [ ] **Step 1: Extend ApiError and add DownloadError**

In `src/main/renderer/src/lib/api.ts`:

```ts
export interface ApiError {
  type?: string
  message: string
  suggestion?: string
  details?: string
  category?: string
}

export class DownloadError extends Error {
  details?: string
  category?: string

  constructor(message: string, error?: ApiError) {
    super(message)
    this.name = "DownloadError"
    this.details = error?.details
    this.category = error?.category
  }
}
```

- [ ] **Step 2: Throw DownloadError from the four download methods**

In each of `videoApi.downloadVideo`, `audioApi.downloadAudio`, `pinterestApi.download`, `tiktokApi.download`, replace `throw new Error(errorMessage)` with:

```ts
      throw new DownloadError(errorMessage, response.error)
```

- [ ] **Step 3: Add getDiagnostics to systemApi and the window type**

In the `declare global` `system` block:

```ts
        getDiagnostics: () => Promise<IPCResponse<ReportEnvironment>>
```

Import the type: `import type { ReportEnvironment } from "@/lib/report"`.

In `systemApi`:

```ts
  /**
   * Environment info for issue reports (null when unavailable)
   */
  async getDiagnostics(): Promise<ReportEnvironment | null> {
    try {
      const electronAPI = getElectronAPI()
      const response = await electronAPI.system.getDiagnostics()
      return response.success && response.data ? response.data : null
    } catch {
      return null
    }
  },
```

- [ ] **Step 4: Verify typecheck and commit**

Run: `cd src/main/renderer && npx tsc -b --force`
Expected: no errors

```bash
git add src/main/renderer/src/lib/api.ts
git commit -m "feat: DownloadError carries details/category; diagnostics client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: reportStore + ReportIssueDialog

**Files:**
- Create: `src/main/renderer/src/lib/reportStore.ts`
- Create: `src/main/renderer/src/components/report/ReportIssueDialog.tsx`

**Interfaces:**
- Consumes: `ReportContext`/`ReportInput`/`buildIssueUrl`/`buildIssueBody` (Task 3), `systemApi.getDiagnostics`, `systemApi.openExternal` (existing).
- Produces: `useReportStore` with `{ context, isOpen, stage(ctx), open(), close() }`; `<ReportIssueDialog />` self-contained component reading the store.

- [ ] **Step 1: Create the store**

`src/main/renderer/src/lib/reportStore.ts`:

```ts
import { create } from "zustand"
import type { ReportContext } from "@/lib/report"

interface ReportState {
  context: ReportContext | null
  isOpen: boolean
  stage: (context: ReportContext) => void
  open: () => void
  close: () => void
}

export const useReportStore = create<ReportState>((set) => ({
  context: null,
  isOpen: false,
  stage: (context) => set({ context }),
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false })
}))

// convenience for non-React call sites (toast actions)
export const reportActions = {
  stage: (context: ReportContext) => useReportStore.getState().stage(context),
  open: () => useReportStore.getState().open()
}
```

- [ ] **Step 2: Create the dialog**

`src/main/renderer/src/components/report/ReportIssueDialog.tsx`:

```tsx
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
              {environment?.platform ?? "unknown"}{" "}
              {environment?.arch ?? ""} · yt-dlp{" "}
              {environment?.ytDlpVersion ?? "unknown"}
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
```

- [ ] **Step 3: Verify typecheck and commit**

Run: `cd src/main/renderer && npx tsc -b --force`
Expected: no errors. If `ui/button` exports differently (check `components/ui/button.tsx`), adjust the import to match.

```bash
git add src/main/renderer/src/lib/reportStore.ts src/main/renderer/src/components/report/ReportIssueDialog.tsx
git commit -m "feat: report-issue dialog and store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire failure surfaces + mount dialog

**Files:**
- Modify: `src/main/renderer/src/lib/hooks/useVideoDownload.ts` (progress-failed toast ~line 99, `onError` ~line 115)
- Modify: `src/main/renderer/src/lib/hooks/useAudioDownload.ts` (same two spots)
- Modify: `src/main/renderer/src/components/video/UnifiedDownloadCard.tsx` (Pinterest catch ~line 285, TikTok catch ~line 327)
- Modify: `src/main/renderer/src/pages/HomePage.tsx` (mount dialog)

**Interfaces:**
- Consumes: `DownloadError` (Task 4), `reportActions` (Task 5), `<ReportIssueDialog />` (Task 5).

- [ ] **Step 1: Add a shared failure-toast helper in the hooks**

In `useVideoDownload.ts`, import:

```ts
import { DownloadError } from "@/lib/api"
import { reportActions } from "@/lib/reportStore"
```

Replace the `onError` handler body's toast:

```ts
    onError: (error: Error) => {
      setDownloadState((prev) => ({
        ...prev,
        status: "failed",
        error: error.message,
        message: `Failed to start download: ${error.message}`
      }))

      reportActions.stage({
        shortMessage: error.message,
        details: error instanceof DownloadError ? error.details : undefined,
        category: error instanceof DownloadError ? error.category : undefined,
        downloadType: "video"
      })
      toast.error("Failed to start video download", {
        description: error.message,
        action: { label: "Report", onClick: () => reportActions.open() }
      })
    }
```

In the progress-failed branch (`progressData.status === "failed"`):

```ts
            if (progressData.status === "failed") {
              reportActions.stage({
                shortMessage: progressData.error || "Download failed",
                downloadType: "video"
              })
              toast.error("Video download failed", {
                description: progressData.error || "Unknown error occurred",
                action: { label: "Report", onClick: () => reportActions.open() }
              })
```

Apply the same two edits in `useAudioDownload.ts` with `downloadType: "audio"`.

- [ ] **Step 2: Wire the Pinterest and TikTok catch blocks**

In `UnifiedDownloadCard.tsx`, import `DownloadError` from `@/lib/api` and `reportActions` from `@/lib/reportStore`. In `PinterestDownloadCard`'s catch block, replace the final `else` branch:

```ts
      else {
        reportActions.stage({
          shortMessage: message,
          details: error instanceof DownloadError ? error.details : undefined,
          category: error instanceof DownloadError ? error.category : undefined,
          platform: "pinterest",
          downloadType: "video",
          videoUrl: url
        })
        toast.error("Download failed", {
          description: message,
          action: { label: "Report", onClick: () => reportActions.open() }
        })
      }
```

Same for `TikTokDownloadCard` with `platform: "tiktok"`.

- [ ] **Step 3: Stage videoUrl for YouTube too**

In `useVideoDownload.ts` / `useAudioDownload.ts`, the request URL is available as `request.url` inside `mutationFn` — stash it in a ref and include it in both `reportActions.stage` calls:

```ts
  const lastUrlRef = useRef<string | undefined>(undefined)
  // inside mutationFn, first line:
  lastUrlRef.current = request.url
  // in each stage() call add:
  platform: "youtube",
  videoUrl: lastUrlRef.current
```

- [ ] **Step 4: Mount the dialog**

In `src/main/renderer/src/pages/HomePage.tsx`:

```tsx
import { ReportIssueDialog } from "@/components/report/ReportIssueDialog"
```

Render `<ReportIssueDialog />` as a sibling of the `AnimatePresence` block (wrap both in a fragment).

- [ ] **Step 5: Verify typecheck + tests, commit**

Run: `cd src/main/renderer && npx tsc -b --force && npx vitest run`
Expected: no type errors, tests pass

```bash
git add src/main/renderer/src
git commit -m "feat: report-issue button on failed downloads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Issue template + end-to-end verification

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`

- [ ] **Step 1: Create the issue template**

```yaml
name: Bug report
description: Report a problem with Cliply
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened
      description: What were you doing when it failed?
    validations:
      required: true
  - type: textarea
    id: error
    attributes:
      label: Error message
      description: Paste the error Cliply showed you
  - type: input
    id: version
    attributes:
      label: Cliply version
  - type: input
    id: os
    attributes:
      label: Operating system
  - type: textarea
    id: logs
    attributes:
      label: Technical logs
      render: text
```

- [ ] **Step 2: Manual end-to-end test**

1. Run `npm run dev`.
2. Make the download folder unwritable: `chmod 555 ~/Downloads/Cliply`
3. Download any YouTube video → failure toast appears with a **Report** action.
4. Click Report → dialog shows the short error, environment (real app/yt-dlp versions), and collapsed logs.
5. Add a note, submit → browser opens GitHub's new-issue page with everything prefilled; verify the body contains no real username (paths show `~`).
6. Restore: `chmod 755 ~/Downloads/Cliply`
7. Verify a successful download still works and shows no report UI.

- [ ] **Step 3: Commit**

```bash
git add .github/ISSUE_TEMPLATE/bug_report.yml
git commit -m "chore: add bug report issue template

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: yt-dlp version (T1), details/category (T1), diagnostics IPC (T2), pure builders + tests (T3), DownloadError (T4), dialog + store + privacy checkbox (T5), toast actions on all four failure surfaces + mount (T6), issue template + manual E2E (T7). Labels `bug`/`auto-report` must exist in the GitHub repo — create manually (repo settings), noted here since it can't be done from code.
- The `ui/button` import in Task 5 may need adjusting to the actual export shape of `components/ui/button.tsx` — verified at implementation time (Step 3 catches it via tsc).
- `progressData`-driven failures (Task 6 Step 1) have no `details` — acceptable: dialog degrades gracefully per spec.
