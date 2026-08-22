import { beforeEach, describe, expect, test } from "vitest"

import type { QualityTier, VideoInfoResponse } from "@/lib/api"
import { useYouTubeStore } from "@/lib/youtubeStore"

const tier = (height: number, filesize: number): QualityTier => ({
  height,
  container: "mp4",
  filesize,
  fps: 30
})

const videoInfo = (
  quality_tiers: QualityTier[],
  audio_tracks: VideoInfoResponse["audio_tracks"] = []
): VideoInfoResponse => ({
  title: "a video",
  duration: 60,
  duration_string: "1:00",
  uploader: "someone",
  quality_tiers,
  audio_tracks
})

beforeEach(() => useYouTubeStore.getState().reset())

describe("setVideoInfo", () => {
  /**
   * both selections describe one particular video. carrying them across a
   * search is how a tier object keeps displaying the previous video's filesize,
   * and how a dub the two videos happen to share replaces the next video's
   * original without anything on screen saying so.
   */
  test("drops the previous video's tier and language", () => {
    const first = videoInfo([tier(1080, 270_000_000)], [
      { code: "en", is_original: true },
      { code: "hi", is_original: false }
    ])

    useYouTubeStore.getState().setVideoInfo(first)
    useYouTubeStore.getState().setSelectedTier(first.quality_tiers[0])
    useYouTubeStore.getState().setSelectedAudioLanguage("hi")

    useYouTubeStore.getState().setVideoInfo(videoInfo([tier(1080, 90_000_000)]))

    expect(useYouTubeStore.getState().selectedTier).toBeNull()
    expect(useYouTubeStore.getState().selectedAudioLanguage).toBeNull()
  })

  test("clearing the video clears them too", () => {
    useYouTubeStore.getState().setSelectedAudioLanguage("hi")
    useYouTubeStore.getState().setVideoInfo(null)

    expect(useYouTubeStore.getState().selectedAudioLanguage).toBeNull()
  })
})

// the audio menu is the same three modes on every video, so its default is an
// initial value rather than something an effect has to install
test("the audio mode starts on mp3", () => {
  expect(useYouTubeStore.getState().selectedAudioMode).toBe("mp3")
})
