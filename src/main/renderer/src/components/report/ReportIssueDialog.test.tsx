// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { buildIssueBody, environmentFields } from "@/lib/report"
import { useReportStore } from "@/lib/reportStore"

const DIAGNOSTICS = {
  appVersion: "0.3.3",
  electronVersion: "28.3.3",
  platform: "darwin",
  osRelease: "25.5.0",
  arch: "arm64",
  ffmpegAvailable: true,
  ytDlpVersion: "2026.08.19"
}

const getDiagnostics = vi.fn()

vi.mock("@/lib/api", () => ({
  systemApi: {
    getDiagnostics: () => getDiagnostics(),
    openExternal: vi.fn(async () => true)
  }
}))

const CONTEXT = {
  shortMessage: "Antivirus may have blocked FFmpeg.",
  details: "ffmpeg exited with code 183",
  category: "FFMPEG_AV_BLOCKED"
}

async function openDialog() {
  const { ReportIssueDialog } = await import("./ReportIssueDialog")

  useReportStore.setState({ context: CONTEXT, isOpen: true })
  render(<ReportIssueDialog />)

  // the dialog asks the main process what it is running the moment it opens
  await waitFor(() => expect(getDiagnostics).toHaveBeenCalled())
}

beforeEach(() => {
  getDiagnostics.mockResolvedValue(DIAGNOSTICS)
  useReportStore.setState({ context: null, isOpen: false })
})

afterEach(cleanup)

describe("what the report says about your machine", () => {
  test("shows the engine version the report is about to attach", async () => {
    await openDialog()

    await waitFor(() =>
      expect(screen.getByText("2026.08.19")).toBeDefined()
    )
  })

  test("shows every field the issue body carries, so nothing rides along unseen", async () => {
    await openDialog()

    const attached = environmentFields(DIAGNOSTICS)
    const body = buildIssueBody({
      context: CONTEXT,
      environment: DIAGNOSTICS,
      userNotes: "",
      includeVideoUrl: false
    })

    await waitFor(() => expect(screen.getByText("0.3.3")).toBeDefined())

    // the dialog and the issue read off one list. anything the body states
    // about the user's machine has to be on screen before they send it
    for (const field of attached) {
      expect(body).toContain(field.value)
      expect(screen.getByText(field.label)).toBeDefined()
      expect(screen.getByText(field.value)).toBeDefined()
    }
  })

  test("says unknown rather than leaving a gap when a probe came back empty", async () => {
    getDiagnostics.mockResolvedValue({
      ...DIAGNOSTICS,
      ytDlpVersion: null,
      ffmpegAvailable: null
    })
    await openDialog()

    await waitFor(() =>
      expect(screen.getAllByText("unknown").length).toBeGreaterThanOrEqual(2)
    )
  })

  test("still names the fields when the main process answered nothing at all", async () => {
    getDiagnostics.mockResolvedValue(null)
    await openDialog()

    // an empty card would read as "we attach nothing", and the body still
    // sends a full table of unknowns
    for (const field of environmentFields(null)) {
      await waitFor(() => expect(screen.getByText(field.label)).toBeDefined())
    }
  })
})
