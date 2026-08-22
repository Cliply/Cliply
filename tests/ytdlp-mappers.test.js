// unit tests for the response mappers and filename templates
// the filenames must keep matching what the python services produced

const {
  sanitizeFilename,
  formatDuration,
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

describe("mapVideoInfo", () => {
  const info = {
    title: "Big Buck Bunny",
    duration: 635.4,
    thumbnail: "https://img/x.jpg",
    uploader: "Blender",
    formats: []
  }

  test("produces exactly the fields the python response had", () => {
    const mapped = mapVideoInfo(info, "https://www.youtube.com/watch?v=abc")

    expect(Object.keys(mapped).sort()).toEqual([
      "audio_formats",
      "duration",
      "duration_string",
      "thumbnail",
      "title",
      "uploader",
      "video_formats"
    ])
    expect(mapped.title).toBe("Big Buck Bunny")
    expect(mapped.duration).toBe(635)
    expect(mapped.duration_string).toBe("10:35")
    expect(mapped.uploader).toBe("Blender")
  })

  test("offers the full quality list for a normal video", () => {
    const mapped = mapVideoInfo(info, "https://www.youtube.com/watch?v=abc")

    expect(mapped.video_formats.map((f) => f.format_id)).toEqual([
      "auto",
      "best_quality",
      "hd_720p",
      "eco_360p"
    ])
  })

  test("collapses to the single auto option for shorts", () => {
    const mapped = mapVideoInfo(info, "https://www.youtube.com/shorts/abc")

    expect(mapped.video_formats).toHaveLength(1)
    expect(mapped.video_formats[0].format_id).toBe("shorts_auto")
  })

  test("fills in the python fallbacks for missing fields", () => {
    const mapped = mapVideoInfo({}, "https://youtu.be/abc")

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
  test("video: <title>_<quality>_<ts>", () => {
    expect(
      buildVideoOutputTemplate({
        title: "My Video",
        videoFormatId: "hd_720p",
        now: NOW
      })
    ).toBe("My Video_720p_68123.%(ext)s")
  })

  test("video trimmed: colons become dashes, like the python replace", () => {
    expect(
      buildVideoOutputTemplate({
        title: "My Video",
        videoFormatId: "eco_360p",
        timeRange: { start: 5, end: 12 },
        now: NOW
      })
    ).toBe("My Video_360p_trimmed_00-05-00-12_68123.%(ext)s")
  })

  test("audio: the _audio suffix is dropped from the quality label", () => {
    expect(
      buildAudioOutputTemplate({
        title: "Song",
        formatId: "medium_audio",
        now: NOW
      })
    ).toBe("Song_audio_medium_68123.%(ext)s")
  })

  test("audio trimmed keeps the python layout", () => {
    expect(
      buildAudioOutputTemplate({
        title: "Song",
        formatId: "auto_audio",
        timeRange: { start: 65, end: 70 },
        now: NOW
      })
    ).toBe("Song_audio_auto_trimmed_01-05-01-10_68123.%(ext)s")
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

  test("titles are sanitized before they reach the command line", () => {
    expect(
      buildVideoOutputTemplate({
        title: 'bad/name"here',
        videoFormatId: "auto",
        now: NOW
      })
    ).toBe("namehere_auto_68123.%(ext)s")
  })
})
