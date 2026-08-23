// unit tests for the response mappers and filename templates
// the filenames must keep matching what the python services produced

const {
  sanitizeFilename,
  formatDuration,
  extractQualityTiers,
  extractAudioTracks,
  mapVideoInfo,
  mapSimpleInfo,
  hasPlayableVideo,
  buildVideoOutputTemplate,
  buildAudioOutputTemplate,
  buildSimpleOutputTemplate
} = require("../src/main/utils/ytdlp-mappers")

// 1787377768123 % 100000 === 68123
const NOW = 1787377768123

describe("sanitizeFilename", () => {
  test("keeps spaces and ordinary characters", () => {
    expect(sanitizeFilename("Big Buck Bunny 60fps 4K")).toBe(
      "Big Buck Bunny 60fps 4K"
    )
  })

  test("strips the characters the python regex stripped", () => {
    expect(sanitizeFilename('a<b>c"d|e?f*g')).toBe("abcdefg")
  })

  test("takes the basename, like os.path.basename did", () => {
    expect(sanitizeFilename("dir/sub/clip")).toBe("clip")
    expect(sanitizeFilename("dir\\sub\\clip")).toBe("clip")
  })

  test("collapses whitespace and trims trailing dots and spaces", () => {
    expect(sanitizeFilename("a    b  ")).toBe("a b")
    expect(sanitizeFilename("title...")).toBe("title")
  })

  test("caps the length at 200 characters", () => {
    expect(sanitizeFilename("x".repeat(300))).toHaveLength(200)
  })

  test("falls back to 'video' when nothing survives", () => {
    expect(sanitizeFilename("")).toBe("video")
    expect(sanitizeFilename("///")).toBe("video")
  })
})

describe("formatDuration", () => {
  test("matches the python format", () => {
    expect(formatDuration(0)).toBe("00:00")
    expect(formatDuration(635)).toBe("10:35")
    expect(formatDuration(59)).toBe("00:59")
    expect(formatDuration(3661)).toBe("01:01:01")
  })

  test("treats missing durations as zero", () => {
    expect(formatDuration(undefined)).toBe("00:00")
    expect(formatDuration(null)).toBe("00:00")
  })
})

// a real `--dump-json` capture: 53 formats from aqz-KE-bpKQ, taken with the
// 2026.08.19 binary and reduced to the fields the mapper reads
const DUMP = require("./fixtures/youtube-dump-json.json")

describe("extractQualityTiers", () => {
  const tiers = extractQualityTiers(DUMP)
  const byHeight = new Map(tiers.map((tier) => [tier.height, tier]))

  test("the ladder is the real one, one row per height, best first", () => {
    expect(tiers.map((tier) => tier.height)).toEqual([
      2160, 1440, 1080, 720, 480, 360, 240, 144
    ])
  })

  // the row carries nothing the renderer can work out for itself: the label is
  // always `${height}p`, and the codec only ever decided the container
  test("a tier is height, container, filesize and fps - nothing else", () => {
    for (const tier of tiers) {
      expect(Object.keys(tier).sort()).toEqual([
        "container",
        "filesize",
        "fps",
        "height"
      ])
    }
  })

  // sb0-sb3 report heights of 180, 90, 45 and 27 - the bogus tiers a naive
  // grouping would offer. dropping vcodec === "none" is what takes them out
  test("storyboard entries never become quality tiers", () => {
    expect(DUMP.formats.filter((f) => f.format_note === "storyboard")).toHaveLength(4)

    for (const height of [27, 45, 90, 180]) {
      expect(byHeight.has(height)).toBe(false)
    }
  })

  // h264 caps at 1080p on youtube: everything above it is av1/vp9 only
  test("container follows the codec data rather than a hardcoded threshold", () => {
    expect(byHeight.get(1080).container).toBe("mp4")
    expect(byHeight.get(720).container).toBe("mp4")
    expect(byHeight.get(144).container).toBe("mp4")
    expect(byHeight.get(1440).container).toBe("mkv")
    expect(byHeight.get(2160).container).toBe("mkv")
  })

  /**
   * both numbers are what the real 2026.08.19 binary reports for the same
   * recipe on this video - `-t mp4 -S res:720` and `-t mkv -S res:2160`, to
   * the byte. the two containers land on different audio streams, which is
   * the whole reason the audio pick takes the container as an argument.
   */
  test("filesize is the chosen video stream plus the audio that container merges", () => {
    // 298 (h264 720p60, the stream -t mp4 really picks) + 140, the aac stream
    // -t mp4's `acodec:aac` sorts to the front
    expect(byHeight.get(720).filesize).toBe(150524867 + 10271496)
    // 401 (av1 2160p60) + 251: opus outranks aac in yt-dlp's default acodec
    // order, so an mkv tier is 69 KB smaller than an aac-sized guess
    expect(byHeight.get(2160).filesize).toBe(712445280 + 10202210)
  })

  test("fps comes off the chosen stream", () => {
    expect(byHeight.get(720).fps).toBe(60)
    expect(byHeight.get(480).fps).toBe(30)
  })

  /**
   * a dubbed video is where a wrong audio pick is worth megabytes, and this
   * capture is the only fixture that shows it: on aqz-KE-bpKQ aac happens to
   * top the bitrate list, so that video agrees whatever rule is used and cannot
   * catch a regression here.
   *
   * both totals below are what the real 2026.08.19 binary reports for this
   * video: `-t mp4 -S res:1080` merges the original-language aac stream and
   * `-t mkv` the original-language opus one. the loudest stream overall - an
   * italian opus dub - is neither, and is 3.5 MB heavier than the first.
   */
  test("a dubbed video is sized against the track a download really gets", () => {
    const audio = MULTI_AUDIO.formats.filter(
      (format) => format.vcodec === "none" && format.acodec !== "none"
    )
    const original = audio.filter((format) => format.language_preference === 10)
    const bestOf = (list, codec) =>
      list
        .filter((format) => String(format.acodec).startsWith(codec))
        .reduce((a, b) => (b.abr > a.abr ? b : a))

    const aac = bestOf(original, "mp4a")
    const opus = bestOf(original, "opus")
    const loudest = audio.reduce((a, b) => (b.abr > a.abr ? b : a))

    // the premise: the loudest stream is a dub, and is neither of the two picks
    expect(loudest.language).not.toBe("en")
    expect(loudest.filesize - aac.filesize).toBeGreaterThan(3_000_000)

    // the video stream is synthetic on purpose - this capture's own h264 rows
    // carry no filesize, and the pick under test is the audio one
    const VIDEO_SIZE = 1_000_000_000

    const [mp4] = extractQualityTiers({
      formats: [
        { format_id: "v", vcodec: "avc1.640028", acodec: "none", height: 1080, filesize: VIDEO_SIZE },
        ...audio
      ]
    })
    expect(mp4.container).toBe("mp4")
    expect(mp4.filesize).toBe(VIDEO_SIZE + aac.filesize)

    const [mkv] = extractQualityTiers({
      formats: [
        { format_id: "v", vcodec: "av01.0.12M.08", acodec: "none", height: 2160, filesize: VIDEO_SIZE },
        ...audio
      ]
    })
    expect(mkv.container).toBe("mkv")
    expect(mkv.filesize).toBe(VIDEO_SIZE + opus.filesize)
    expect(mkv.filesize).toBeLessThan(mp4.filesize)
  })

  test("a source with no aac at all still sizes an mp4 tier against its audio", () => {
    const [tier] = extractQualityTiers({
      formats: [
        { format_id: "v", vcodec: "avc1.4d4020", acodec: "none", height: 720, filesize: 1000 },
        { format_id: "a", vcodec: "none", acodec: "opus", abr: 130, filesize: 100 }
      ]
    })

    expect(tier).toMatchObject({ container: "mp4", filesize: 1100 })
  })

  // "video size + 0" reads as a confident total for a download that will also
  // pull in an unknown number of audio bytes
  test("an audio stream with no size makes the whole tier size unknown", () => {
    const [tier] = extractQualityTiers({
      formats: [
        { format_id: "v", vcodec: "avc1.4d4020", acodec: "none", height: 720, filesize: 100000000 },
        { format_id: "a", vcodec: "none", acodec: "mp4a.40.2", abr: 129 }
      ]
    })

    expect(tier.filesize).toBeNull()
  })

  // no audio stream at all is different: a merge adds nothing, so the video
  // size is the whole cost and is still worth showing
  test("a source with no audio stream keeps its video-only size", () => {
    const [tier] = extractQualityTiers({
      formats: [
        { format_id: "v", vcodec: "avc1.4d4020", acodec: "none", height: 720, filesize: 5000 }
      ]
    })

    expect(tier.filesize).toBe(5000)
  })

  test("an unknown size stays null rather than becoming 0", () => {
    const tiers = extractQualityTiers({
      formats: [
        { format_id: "hls-720", vcodec: "avc1.4d4020", acodec: "none", height: 720, protocol: "m3u8_native", tbr: 4553 },
        { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize: 10271496 }
      ]
    })

    expect(tiers).toHaveLength(1)
    expect(tiers[0].filesize).toBeNull()
  })

  test("filesize_approx stands in when the exact size is missing", () => {
    const [tier] = extractQualityTiers({
      formats: [
        { format_id: "v", vcodec: "avc1.4d4020", acodec: "none", height: 720, filesize_approx: 1000 },
        { format_id: "a", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize_approx: 100 }
      ]
    })

    expect(tier.filesize).toBe(1100)
  })

  // a pre-muxed format already carries its audio - adding a stream's bytes on
  // top would overstate it
  test("a muxed format is not charged for audio twice", () => {
    const [tier] = extractQualityTiers({
      formats: [
        { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, filesize: 5000 },
        { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize: 1000 }
      ]
    })

    expect(tier.filesize).toBe(5000)
  })

  test("an audio-only source has no tiers at all", () => {
    expect(
      extractQualityTiers({
        formats: [{ format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 129 }]
      })
    ).toEqual([])
    expect(extractQualityTiers({})).toEqual([])
    expect(extractQualityTiers(null)).toEqual([])
  })

  test("video formats with no height are skipped", () => {
    expect(
      extractQualityTiers({
        formats: [{ format_id: "x", vcodec: "avc1.4d4020", acodec: "none", filesize: 10 }]
      })
    ).toEqual([])
  })

  /**
   * the whole claim of this revamp in one assertion: the menu is the video's
   * own format list, so a video that tops out at 1080p cannot offer 4K. the
   * same capture with everything above 1080p removed is exactly what youtube
   * returns for such a video.
   */
  test("a 1080p-max video is not offered 4K", () => {
    const capped = {
      formats: DUMP.formats.filter((format) => !(Number(format.height) > 1080))
    }

    const heights = extractQualityTiers(capped).map((tier) => tier.height)

    expect(heights).toEqual([1080, 720, 480, 360, 240, 144])
    expect(heights).not.toContain(2160)
    expect(heights).not.toContain(1440)
    // and the top row is a real mp4, so the default selection still plays
    // everywhere on a video with no av1 ladder above it
    expect(extractQualityTiers(capped)[0].container).toBe("mp4")
  })
})

// a real `--dump-json` capture of Af6i6ChAVTw, the 22-language MrBeast upload,
// taken with the same 2026.08.19 binary. format ids are deliberately never
// asserted on: the -N suffixes (140-2, 251-12) are assigned per response and
// shift between calls
const MULTI_AUDIO = require("./fixtures/youtube-multi-audio.json")

describe("extractAudioTracks", () => {
  const tracks = extractAudioTracks(MULTI_AUDIO)

  test("every dubbed language the video carries, once each", () => {
    expect(tracks).toHaveLength(22)

    const codes = tracks.map((track) => track.code)
    expect(new Set(codes).size).toBe(22)
    // 110 audio-only formats collapse to 22 languages
    expect(
      MULTI_AUDIO.formats.filter((format) => format.vcodec === "none")
    ).toHaveLength(110)
  })

  // the format_note reads "English original (default)" here, but that is the
  // video's own wording; language_preference is the field yt-dlp means it with
  test("the original is identified by language_preference, not by a label", () => {
    expect(tracks.filter((track) => track.is_original)).toEqual([
      { code: "en", is_original: true }
    ])
    expect(tracks[0]).toEqual({ code: "en", is_original: true })
  })

  test("the original leads, and the rest keep the extractor's order", () => {
    expect(tracks.map((track) => track.code)).toEqual([
      "en",
      "bn",
      "de",
      "hi",
      "it",
      "ja",
      "ml",
      "pl",
      "tr",
      "ko",
      "pt",
      "ta",
      "th",
      "ru",
      "fr",
      "te",
      "ar",
      "id",
      "zh-Hans",
      "zh-Hant",
      "es",
      "vi"
    ])
  })

  // this is why the format expression matches with `=` and never `^=`: a prefix
  // match would collide these two real, separate tracks into one
  test("zh-Hans and zh-Hant both survive as distinct tracks", () => {
    const codes = tracks.map((track) => track.code)

    expect(codes).toContain("zh-Hans")
    expect(codes).toContain("zh-Hant")
  })

  /**
   * the case that must not regress, because it is nearly every video: an empty
   * array means "no choice exists", the ui shows nothing new, and the download
   * args stay exactly what they are today
   */
  test("a single-language video yields no tracks at all", () => {
    // the aqz-KE-bpKQ capture: 10 audio formats, every one with language null
    expect(
      DUMP.formats.filter(
        (format) => format.vcodec === "none" && format.acodec !== "none"
      ).length
    ).toBeGreaterThan(0)
    expect(extractAudioTracks(DUMP)).toEqual([])
  })

  test("one named language is still no choice", () => {
    expect(
      extractAudioTracks({
        formats: [
          { vcodec: "none", acodec: "opus", language: "en", language_preference: 10 },
          { vcodec: "none", acodec: "mp4a.40.2", language: "en", language_preference: 10 }
        ]
      })
    ).toEqual([])
  })

  test("languages with no formats at all are no choice either", () => {
    expect(extractAudioTracks({})).toEqual([])
    expect(extractAudioTracks(null)).toEqual([])
    expect(extractAudioTracks({ formats: [] })).toEqual([])
  })

  // video formats carry a language field too on a dubbed upload; the tracks are
  // the audio-only ones, the same set the merge would pull from
  test("video formats never contribute a language", () => {
    expect(
      extractAudioTracks({
        formats: [
          { vcodec: "avc1.640028", acodec: "none", height: 1080, language: "fr" },
          { vcodec: "none", acodec: "opus", language: "en", language_preference: 10 }
        ]
      })
    ).toEqual([])
  })

  test("a language yt-dlp does not report is not a track", () => {
    expect(
      extractAudioTracks({
        formats: [
          { vcodec: "none", acodec: "opus", language: null },
          { vcodec: "none", acodec: "opus", language: "none" },
          { vcodec: "none", acodec: "opus", language: "  " },
          { vcodec: "none", acodec: "opus", language: "hi" }
        ]
      })
    ).toEqual([])
  })

  // one language has several formats (low/medium, drc and not) and the original
  // marker only has to appear on one of them
  test("the original marker on any one format marks the language", () => {
    expect(
      extractAudioTracks({
        formats: [
          { vcodec: "none", acodec: "opus", language: "en", language_preference: -1 },
          { vcodec: "none", acodec: "opus", language: "en", language_preference: 10 },
          { vcodec: "none", acodec: "opus", language: "hi", language_preference: -1 }
        ]
      })
    ).toEqual([
      { code: "en", is_original: true },
      { code: "hi", is_original: false }
    ])
  })

  // a dub-only listing has no original to hoist; the order simply stands
  test("no original at all leaves the extractor's order untouched", () => {
    expect(
      extractAudioTracks({
        formats: [
          { vcodec: "none", acodec: "opus", language: "hi" },
          { vcodec: "none", acodec: "opus", language: "ja" }
        ]
      })
    ).toEqual([
      { code: "hi", is_original: false },
      { code: "ja", is_original: false }
    ])
  })
})

describe("mapVideoInfo", () => {
  const info = {
    title: "Big Buck Bunny",
    duration: 635.4,
    thumbnail: "https://img/x.jpg",
    uploader: "Blender",
    formats: []
  }

  test("carries the metadata and the tiers, and nothing invented", () => {
    const mapped = mapVideoInfo(info)

    expect(Object.keys(mapped).sort()).toEqual([
      "audio_tracks",
      "duration",
      "duration_string",
      "quality_tiers",
      "thumbnail",
      "title",
      "uploader"
    ])
    expect(mapped.title).toBe("Big Buck Bunny")
    expect(mapped.duration).toBe(635)
    expect(mapped.duration_string).toBe("10:35")
    expect(mapped.uploader).toBe("Blender")
  })

  test("the quality menu is the real ladder", () => {
    const mapped = mapVideoInfo(DUMP)

    expect(mapped.quality_tiers.map((tier) => tier.height)).toEqual([
      2160, 1440, 1080, 720, 480, 360, 240, 144
    ])
  })

  test("an empty format list simply means no tiers", () => {
    expect(mapVideoInfo(info).quality_tiers).toEqual([])
  })

  test("the dubbed languages ride along, and are empty when there is no choice", () => {
    expect(mapVideoInfo(MULTI_AUDIO).audio_tracks).toHaveLength(22)
    expect(mapVideoInfo(MULTI_AUDIO).audio_tracks[0].code).toBe("en")
    // the single-language capture, which is nearly every video
    expect(mapVideoInfo(DUMP).audio_tracks).toEqual([])
    expect(mapVideoInfo(info).audio_tracks).toEqual([])
  })

  // shorts used to collapse to a single "Auto" row; they have real heights
  // like any other video, so nothing about them is special any more
  test("a shorts extraction gets the same real ladder", () => {
    const mapped = mapVideoInfo({
      ...info,
      formats: [
        { format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080, filesize: 500 },
        { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize: 100 }
      ]
    })

    expect(mapped.quality_tiers).toEqual([
      { height: 1080, container: "mp4", filesize: 600, fps: null }
    ])
  })

  test("fills in the python fallbacks for missing fields", () => {
    const mapped = mapVideoInfo({})

    expect(mapped.title).toBe("Unknown")
    expect(mapped.uploader).toBe("Unknown")
    expect(mapped.thumbnail).toBeNull()
    expect(mapped.duration).toBe(0)
  })
})

describe("mapSimpleInfo", () => {
  test("returns the tiktok/pinterest shape", () => {
    const mapped = mapSimpleInfo(
      { title: "Clip", duration: 12.9, thumbnail: null, uploader: "someone" },
      "tiktok_video"
    )

    expect(mapped).toEqual({
      title: "Clip",
      duration: 12,
      duration_string: "00:12",
      thumbnail: null,
      uploader: "someone"
    })
  })

  test("falls back to the channel and the given default title", () => {
    const mapped = mapSimpleInfo({ channel: "a-channel" }, "pinterest_video")

    expect(mapped.title).toBe("pinterest_video")
    expect(mapped.uploader).toBe("a-channel")
  })

  // python's order was uploader -> channel -> creator
  test("channel wins over creator when both are present", () => {
    const mapped = mapSimpleInfo(
      { channel: "a-channel", creator: "a-creator" },
      "tiktok_video"
    )

    expect(mapped.uploader).toBe("a-channel")
  })

  test("creator is the last resort", () => {
    expect(mapSimpleInfo({ creator: "a-creator" }, "tiktok_video").uploader).toBe(
      "a-creator"
    )
    expect(mapSimpleInfo({}, "tiktok_video").uploader).toBe("Unknown")
  })
})

describe("hasPlayableVideo", () => {
  test("a video format makes it playable", () => {
    expect(hasPlayableVideo({ formats: [{ vcodec: "h264" }] })).toBe(true)
  })

  test("audio-only formats are not a video", () => {
    expect(
      hasPlayableVideo({ formats: [{ vcodec: "none", acodec: "mp4a" }] })
    ).toBe(false)
  })

  // an image pin: python inspected the format list and nothing else, so
  // metadata carrying a duration must not pass as downloadable video
  test("metadata with no formats is rejected", () => {
    expect(hasPlayableVideo({ duration: 30, vcodec: "h264" })).toBe(false)
    expect(hasPlayableVideo({ formats: [], duration: 30 })).toBe(false)
  })

  test("nothing at all is not playable", () => {
    expect(hasPlayableVideo(null)).toBe(false)
    expect(hasPlayableVideo({})).toBe(false)
  })
})

describe("output templates", () => {
  // the title, the sanitising and the byte-safe truncation are yt-dlp's own now
  test("video: title, the height it really got, and the epoch", () => {
    expect(buildVideoOutputTemplate({})).toBe(
      "%(title).120B_%(height)sp_%(epoch)s.%(ext)s"
    )
  })

  test("video trimmed: the native section fields carry the bounds", () => {
    expect(
      buildVideoOutputTemplate({ timeRange: { start: 5, end: 12 } })
    ).toBe(
      "%(title).120B_%(height)sp_%(section_start)s-%(section_end)s_%(epoch)s.%(ext)s"
    )
  })

  // audio has no height to report, so the word takes its place
  test("audio: no height field", () => {
    expect(buildAudioOutputTemplate({})).toBe(
      "%(title).120B_audio_%(epoch)s.%(ext)s"
    )
  })

  test("audio trimmed carries the section bounds too", () => {
    expect(
      buildAudioOutputTemplate({ timeRange: { start: 65, end: 70 } })
    ).toBe("%(title).120B_audio_%(section_start)s-%(section_end)s_%(epoch)s.%(ext)s")
  })

  test("simple platforms carry the platform name", () => {
    expect(
      buildSimpleOutputTemplate({ title: "Clip", platform: "tiktok", now: NOW })
    ).toBe("Clip_tiktok_68123.%(ext)s")
    expect(
      buildSimpleOutputTemplate({ title: "Pin", platform: "pinterest", now: NOW })
    ).toBe("Pin_pinterest_68123.%(ext)s")
  })

  test("a percent in the title is escaped so yt-dlp keeps it literal", () => {
    const template = buildSimpleOutputTemplate({
      title: "100% real",
      platform: "tiktok",
      now: NOW
    })

    expect(template).toBe("100%% real_tiktok_68123.%(ext)s")
  })

  // tiktok / pinterest keep the hand-rolled names their python services produced
  test("simple titles are still sanitized before they reach the command line", () => {
    expect(
      buildSimpleOutputTemplate({
        title: 'bad/name"here',
        platform: "tiktok",
        now: NOW
      })
    ).toBe("namehere_tiktok_68123.%(ext)s")
  })
})
