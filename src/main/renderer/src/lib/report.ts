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
