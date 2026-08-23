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

export interface EnvironmentField {
  label: string
  value: string
}

/**
 * everything the report says about the user's machine, in one list
 *
 * the dialog renders this and the issue body tabulates it, so what the user
 * reads before they send is the same set of facts that goes out. a field
 * nobody probed reads "unknown" rather than going quiet - an omission would
 * look like we chose not to ask.
 */
export function environmentFields(
  env: ReportEnvironment | null
): EnvironmentField[] {
  const value = (v: string | boolean | null | undefined) =>
    v === null || v === undefined ? "unknown" : String(v)

  return [
    { label: "Cliply", value: value(env?.appVersion) },
    {
      label: "OS",
      value: `${value(env?.platform)} ${value(env?.osRelease)} (${value(env?.arch)})`
    },
    { label: "Electron", value: value(env?.electronVersion) },
    { label: "yt-dlp", value: value(env?.ytDlpVersion) },
    { label: "FFmpeg available", value: value(env?.ffmpegAvailable) }
  ]
}

function environmentSection(env: ReportEnvironment | null): string {
  return [
    "| Field | Value |",
    "| --- | --- |",
    ...environmentFields(env).map(
      (field) => `| ${field.label} | ${field.value} |`
    )
  ].join("\n")
}

// pick a backtick fence longer than any run inside the content, so a log line
// containing ``` can't break out of the code block and inject markdown.
function codeFence(content: string): string {
  const longestRun = (content.match(/`+/g) || []).reduce(
    (max, run) => Math.max(max, run.length),
    0
  )
  return "`".repeat(Math.max(3, longestRun + 1))
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
    const body = logLines.join("\n")
    const fence = codeFence(body)
    sections.push("### Technical details")
    sections.push(
      `<details><summary>Logs</summary>\n\n${fence}\n${body}\n${fence}\n\n</details>`
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
  let notes = input.userNotes
  let truncated = false

  const toUrl = (lines: string[], noteText: string) => {
    const params = new URLSearchParams({
      title,
      labels: LABELS,
      body: assembleBody({ ...input, userNotes: noteText }, lines)
    })
    return `${ISSUES_NEW_URL}?${params.toString()}`
  }

  let url = toUrl(logLines, notes)
  // first shed log lines, oldest first, keeping the most recent tail
  while (url.length > URL_BUDGET && logLines.length > 0) {
    logLines = logLines.slice(1)
    truncated = true
    url = toUrl(logLines, notes)
  }
  // if still over budget, trim the user's notes (the clipboard keeps the full copy)
  while (url.length > URL_BUDGET && notes.length > 0) {
    notes = notes.slice(0, Math.max(0, notes.length - 500))
    truncated = true
    url = toUrl(logLines, notes)
  }
  return { url, truncated }
}
