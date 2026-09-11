// @vitest-environment jsdom
//
// the line every loaded screen prints about where files land.
//
// all four screens used to spell out `~/Downloads/Cliply`, which was a lie to
// everybody who had ever changed the folder, and the store field holding the
// real one was write-only: nothing ever read it back from main. one file for
// the three non-playlist layouts because it is one rule, asserted the same
// way on each of them - the playlist header has its own test beside it.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { DownloadPathInfo } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { usePinterestStore } from "@/lib/stores/pinterestStore"
import { useTikTokStore } from "@/lib/stores/tiktokStore"
import { useYouTubeStore } from "@/lib/stores/youtubeStore"

import { PinterestLayout } from "./pinterest/PinterestLayout"
import { TikTokLayout } from "./tiktok/TikTokLayout"
import { VideoLayout } from "./video/VideoLayout"

const mocks = vi.hoisted(() => ({
  downloadPath: null as DownloadPathInfo | null
}))

// the folder arrives over ipc; these screens only display it
vi.mock("@/lib/hooks/useDownloadPath", () => ({
  useDownloadPath: () => ({
    downloadPath: mocks.downloadPath,
    isLoading: false,
    selectFolder: vi.fn()
  })
}))

// everything below the line under test reaches into a different stack each
// time, and none of it is what this file is about. the factories are hoisted
// above every binding in this file, so each one spells its own stub out
vi.mock("@/components/video", () => ({
  FeedbackCard: () => <div />,
  UnifiedDownloadCard: () => <div />,
  VideoDetailsCard: () => <div />,
  VideoPlayerFrame: () => <div />
}))
vi.mock("@/components/video/CompactSearch", () => ({
  CompactSearch: () => <div />
}))
vi.mock("@/components/ui/mode-toggle", () => ({ ModeToggle: () => <div /> }))
vi.mock("./pinterest/PinterestDetailsCard", () => ({
  PinterestDetailsCard: () => <div />
}))
vi.mock("./pinterest/PinterestThumbnail", () => ({
  PinterestThumbnail: () => <div />
}))
vi.mock("./tiktok/TikTokDetailsCard", () => ({
  TikTokDetailsCard: () => <div />
}))
vi.mock("./tiktok/TikTokThumbnail", () => ({ TikTokThumbnail: () => <div /> }))

const media = {
  title: "A talk",
  duration: 300,
  duration_string: "5:00",
  thumbnail: null,
  uploader: "TED"
}

/** each layout, with the one thing it needs loaded before it draws anything */
const SCREENS = [
  {
    name: "youtube",
    render: () => {
      useYouTubeStore
        .getState()
        .setVideoInfo({ ...media, quality_tiers: [], audio_tracks: [] })
      render(<VideoLayout />)
    }
  },
  {
    name: "pinterest",
    render: () => {
      usePinterestStore.getState().setInfo(media)
      render(<PinterestLayout />)
    }
  },
  {
    name: "tiktok",
    render: () => {
      useTikTokStore.getState().setInfo(media)
      render(<TikTokLayout />)
    }
  }
] as const

beforeEach(() => {
  mocks.downloadPath = {
    path: "/Volumes/Media/Talks",
    exists: true,
    writable: true
  }
  useYouTubeStore.getState().reset()
  usePinterestStore.getState().reset()
  useTikTokStore.getState().reset()
})
afterEach(cleanup)

describe("where files land", () => {
  test.each(SCREENS)("the $name screen names the real folder", ({ render }) => {
    render()

    expect(screen.getByText("/Volumes/Media/Talks")).toBeDefined()
    expect(screen.getByText(new RegExp(en["layout.downloadsAt"]))).toBeDefined()
    // the default it used to print whatever the folder really was
    expect(document.body.textContent).not.toContain("~/Downloads/Cliply")
  })

  /**
   * the folder is read over ipc and the answer can be late, or never come. a
   * line naming the wrong folder is worse than no line, so there is nothing
   * to fall back to.
   */
  test.each(SCREENS)(
    "the $name screen says nothing until it knows",
    ({ render }) => {
      mocks.downloadPath = null

      render()

      expect(
        screen.queryByText(new RegExp(en["layout.downloadsAt"]))
      ).toBeNull()
      expect(document.body.textContent).not.toContain("~/Downloads/Cliply")
    }
  )

  // the youtube screen shares its line with a second sentence, which is true
  // whether or not we know the folder and must not disappear with it
  test("and youtube keeps its note about concurrent downloads either way", () => {
    SCREENS[0].render()
    expect(
      screen.getByText(new RegExp(en["layout.concurrentNote"]))
    ).toBeDefined()

    cleanup()
    mocks.downloadPath = null

    SCREENS[0].render()
    expect(screen.getByText(en["layout.concurrentNote"])).toBeDefined()
  })

  test.each(SCREENS)(
    "the $name screen says it in russian too",
    ({ render }) => {
      useLocale.getState().setLocale("ru")

      try {
        render()

        expect(screen.getByText(/загрузки сохраняются в/)).toBeDefined()
        expect(screen.getByText("/Volumes/Media/Talks")).toBeDefined()
      } finally {
        useLocale.getState().setLocale("en")
      }
    }
  )
})
