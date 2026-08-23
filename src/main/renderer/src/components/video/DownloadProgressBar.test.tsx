// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { DownloadProgressBar } from "./DownloadProgressBar"

afterEach(cleanup)

const bar = () => screen.getByRole("progressbar")

describe("a download reporting real progress", () => {
  test("reports its position to the label, the value and assistive tech", () => {
    render(
      <DownloadProgressBar
        state={{ status: "downloading", progress: 42.4, speed: "3.79MiB/s", eta: "01:44" }}
        label="video"
      />
    )

    expect(screen.getByText("Downloading video")).toBeDefined()
    expect(screen.getByText("42%")).toBeDefined()
    expect(bar().getAttribute("aria-valuenow")).toBe("42")
    expect(bar().getAttribute("aria-valuetext")).toBe("42%")
    expect(screen.getByText(/3\.79MiB\/s/)).toBeDefined()
    expect(screen.getByText(/ETA 01:44/)).toBeDefined()
  })

  test("the label names the bar for screen readers", () => {
    render(
      <DownloadProgressBar
        state={{ status: "downloading", progress: 10 }}
        label="audio"
      />
    )

    const labelId = bar().getAttribute("aria-labelledby")
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId!)?.textContent).toBe("Downloading audio")
  })

  test("clamps progress that arrives out of range", () => {
    render(
      <DownloadProgressBar
        state={{ status: "downloading", progress: 140 }}
        label="video"
      />
    )

    expect(bar().getAttribute("aria-valuenow")).toBe("100")
  })
})

describe("the stop control", () => {
  const stop = () => screen.getByRole("button", { name: /stop/i })

  test("stops the download it belongs to", () => {
    const onCancel = vi.fn()
    render(
      <DownloadProgressBar
        state={{ status: "downloading", progress: 30, downloadId: "abc" }}
        label="video"
        onCancel={onCancel}
      />
    )

    fireEvent.click(stop())

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test("stays inert until the engine hands back an id", () => {
    const onCancel = vi.fn()
    render(
      <DownloadProgressBar
        state={{ status: "starting", progress: 0 }}
        label="video"
        onCancel={onCancel}
      />
    )

    expect(stop().hasAttribute("disabled")).toBe(true)

    fireEvent.click(stop())

    expect(onCancel).not.toHaveBeenCalled()
  })

  test("is absent when the caller offers no way to cancel", () => {
    render(
      <DownloadProgressBar
        state={{ status: "downloading", progress: 30, downloadId: "abc" }}
        label="video"
      />
    )

    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull()
  })
})

describe("a download whose duration cannot be known", () => {
  test("a trim shows no percentage and no position", () => {
    render(
      <DownloadProgressBar
        state={{ status: "downloading", progress: 0, indeterminate: true }}
        label="video"
      />
    )

    expect(screen.getByText("Processing video")).toBeDefined()
    expect(screen.queryByText("0%")).toBeNull()
    expect(bar().getAttribute("aria-valuenow")).toBeNull()
    expect(bar().getAttribute("aria-valuetext")).toBe("Working")
    expect(
      screen.getByText("Progress isn't reported while trimming")
    ).toBeDefined()
  })

  test("a starting download is indeterminate until the engine reports", () => {
    render(
      <DownloadProgressBar
        state={{ status: "starting", progress: 0 }}
        label="audio"
      />
    )

    expect(bar().getAttribute("aria-valuenow")).toBeNull()
    expect(screen.getByText("Starting up")).toBeDefined()
  })
})
