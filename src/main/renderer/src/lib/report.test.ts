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
    // URLSearchParams encodes spaces as "+"
    const decoded = decodeURIComponent(url.replace(/\+/g, " "))
    expect(decoded).toContain("log line 499") // keeps the tail
    expect(decoded).not.toContain("log line 0") // drops the head
  })

  it("trims oversized notes so the url stays within budget", () => {
    const { url, truncated } = buildIssueUrl({
      ...baseInput,
      context: { ...baseInput.context, details: "" },
      userNotes: "n".repeat(9000)
    })
    expect(url.length).toBeLessThanOrEqual(8000)
    expect(truncated).toBe(true)
  })
})

describe("buildIssueBody log fencing", () => {
  it("uses a fence longer than any backtick run in the logs", () => {
    const body = buildIssueBody({
      ...baseInput,
      context: {
        ...baseInput.context,
        details: "before\n```\nmalicious @mention\n```\nafter"
      }
    })
    // the wrapping fence must be at least 4 backticks so the inner ``` cannot
    // close the block early
    expect(body).toContain("````")
  })
})
