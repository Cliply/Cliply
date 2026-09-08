// unit tests for the playlist half of the engine: the -I selection spec, the
// playlist download args, and the mappers that turn one --dump-single-json
// payload into rows the renderer can draw
//
// every measured claim quoted below was taken from the shipped binary
// (2026.08.19) against real youtube playlists

const { EventEmitter } = require("events")
const { PassThrough } = require("stream")
const os = require("os")
const path = require("path")

const {
  YtdlpEngine,
  ERROR_CODES,
  buildArgs,
  buildPlaylistItemsSpec,
  normalizePlaylistIndices,
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_ERROR_BUDGET,
  PLAYLIST_SLEEP_REQUESTS,
  PLAYLIST_FRAGMENTS
} = require("../src/main/services/ytdlp-engine")

const {
  mapPlaylistInfo,
  buildPlaylistOutputTemplate,
  buildPlaylistArchivePath,
  PLAYLIST_MAX_ITEMS: MAPPER_PLAYLIST_MAX_ITEMS,
  PLAYLIST_INDEX_WIDTH
} = require("../src/main/utils/ytdlp-mappers")

const PATHS = {
  ffmpegPath: "/res/binaries/ffmpeg",
  denoPath: "/res/binaries/deno/deno"
}

const PLAYLIST = {
  ...PATHS,
  url: "https://www.youtube.com/playlist?list=PLBCF2DAC6FFB574DE",
  playlistIndices: [1, 2, 3],
  outputDir: "/downloads",
  outputTemplate: buildPlaylistOutputTemplate({})
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function containsSequence(args, sequence) {
  return args.some((_, index) =>
    sequence.every((value, offset) => args[index + offset] === value)
  )
}

// a child process stand-in, the same shape the lifecycle suite drives
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.pid = 9001
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }
}

// run one playlist listing against a fake yt-dlp that prints exactly `stdout`
function listingWith(stdout) {
  let child = null

  const engine = new YtdlpEngine({
    userDataPath: path.join(os.tmpdir(), "cliply-playlist"),
    resourcesPath: path.join(os.tmpdir(), "cliply-playlist"),
    ffmpegPath: "/fake/ffmpeg",
    denoPath: "/fake/deno",
    spawnFn: () => {
      child = new FakeChild()
      return child
    }
  })

  const promise = engine.getPlaylistInfo("https://youtube.com/playlist?list=x")

  // let the constructor's gate acquisition and the stream wiring run before
  // anything is written to them
  return new Promise((resolve) => setImmediate(resolve))
    .then(() => {
      child.stdout.write(stdout)
      return new Promise((resolve) => setImmediate(resolve))
    })
    .then(() => {
      child.emit("close", 0)
      return promise
    })
}

// the widest a field can render, for the ones the template does not cap
// itself. anything with a `.NNB` cap in the template is read off the template
// instead, so tightening or widening a cap needs no edit here
const WORST_FIELD_WIDTHS = {
  // the longest playlist ids yt-dlp emits are the `OLAK5uy_...` album ones
  playlist_id: 41,
  // youtube video ids are fixed at 11 characters
  id: 11,
  // %(playlist_index)0Nd, pinned to the width of the item cap
  playlist_index: PLAYLIST_INDEX_WIDTH,
  // the tallest ceiling the quality menu offers
  height: "2160".length
}

/**
 * the longest relative path a template can render
 *
 * `.NNB` is a *byte* cap and --trim-filenames counts characters, so an ascii
 * title is the worst case and one character per byte is the right arithmetic.
 * the extension is left out because yt-dlp re-attaches it after the trim -
 * measured: at `--trim-filenames 90` the stem came out at exactly 90 with
 * `.mp4` on top of it
 */
function renderWorstCase(template) {
  const rendered = template
    .replace(".%(ext)s", "")
    .replace(/%\((\w+)\)(\.(\d+)B|0\d+d|s)/g, (whole, field, spec, byteCap) => {
      const width = byteCap ? Number(byteCap) : WORST_FIELD_WIDTHS[field]

      if (!width) {
        throw new Error(`no worst-case width known for %(${field})s`)
      }

      return "X".repeat(width)
    })

  // a field spec this does not recognise would be left in place and counted as
  // its own literal length, which would quietly understate the budget
  if (rendered.includes("%(")) {
    throw new Error(`unrendered field left in: ${rendered}`)
  }

  return rendered
}

// one flat entry, shaped the way --flat-playlist really returns them: a
// thumbnails array rather than a single thumbnail, and no playlist_index
function entry(overrides = {}) {
  return {
    id: "GvgqDSnpRQM",
    title: "Andrew Willis, Skatepark Engineer",
    duration: 90,
    url: "https://www.youtube.com/watch?v=GvgqDSnpRQM",
    live_status: "not_live",
    availability: null,
    thumbnails: [
      { url: "https://i.ytimg.com/vi/GvgqDSnpRQM/a.jpg", width: 168, height: 94 },
      { url: "https://i.ytimg.com/vi/GvgqDSnpRQM/d.jpg", width: 336, height: 188 }
    ],
    ...overrides
  }
}

function playlist(entries, overrides = {}) {
  return {
    id: "PLBCF2DAC6FFB574DE",
    title: "Google Search Stories",
    uploader: "Google Search Stories",
    channel: "Google Search Stories",
    playlist_count: entries.length,
    entries,
    ...overrides
  }
}

describe("playlist item specs", () => {
  test("compresses runs the way the -I syntax expects", () => {
    expect(buildPlaylistItemsSpec([1, 2, 4, 5, 6, 7, 8, 9])).toBe("1,2,4:9")
  })

  // yt-dlp reads `a:b` as an inclusive range, so a run of three or more is
  // worth collapsing. a pair is left alone: "4,5" is the same length as "4:5"
  // and says what it means
  test("leaves pairs and singletons alone", () => {
    expect(buildPlaylistItemsSpec([3])).toBe("3")
    expect(buildPlaylistItemsSpec([3, 4])).toBe("3,4")
    expect(buildPlaylistItemsSpec([3, 4, 5])).toBe("3:5")
    expect(buildPlaylistItemsSpec([1, 5, 9])).toBe("1,5,9")
  })

  test("sorts and de-duplicates whatever order the ticks arrived in", () => {
    expect(buildPlaylistItemsSpec([9, 1, 5, 1, 9])).toBe("1,5,9")
    expect(buildPlaylistItemsSpec([3, 2, 1])).toBe("1:3")
  })

  /**
   * an empty `-I ""` is not "download nothing" - it is the *absence* of a
   * selection, which downloads the whole playlist. so the one thing this must
   * never do is return an empty spec
   */
  test("an empty selection is an error, never an empty spec", () => {
    for (const empty of [[], null, undefined, "1,2", {}]) {
      expect(() => buildPlaylistItemsSpec(empty)).toThrow(
        /at least one selected item/
      )
    }
  })

  test("rejects anything that is not a position inside the cap", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, "2", null, {}]) {
      expect(() => buildPlaylistItemsSpec([1, bad])).toThrow()
    }

    expect(() => buildPlaylistItemsSpec([PLAYLIST_MAX_ITEMS + 1])).toThrow(
      /out of range/
    )
    expect(buildPlaylistItemsSpec([PLAYLIST_MAX_ITEMS])).toBe(
      String(PLAYLIST_MAX_ITEMS)
    )
  })

  /**
   * the spec is written straight onto the command line, so it is whitelisted
   * for the same reason TIER_CONTAINERS and AUDIO_LANGUAGE_PATTERN are:
   * nothing arriving over ipc gets to write yt-dlp option syntax
   */
  test("never emits a character outside [0-9,:]", () => {
    const wide = Array.from({ length: PLAYLIST_MAX_ITEMS }, (_, i) => i + 1)

    for (const selection of [[1], [1, 3], [1, 2, 3], [2, 3, 4, 9, 10], wide]) {
      expect(buildPlaylistItemsSpec(selection)).toMatch(/^[0-9,:]+$/)
    }
  })

  test("normalising is idempotent, so a spec built twice is the same spec", () => {
    const once = normalizePlaylistIndices([4, 2, 2, 9])

    expect(once).toEqual([2, 4, 9])
    expect(normalizePlaylistIndices(once)).toEqual(once)
  })
})

describe("playlist download args", () => {
  test("walks the playlist instead of taking one video out of it", () => {
    const args = buildArgs("playlist-combined", { ...PLAYLIST, height: 1080 })

    expect(args).toContain("--yes-playlist")
    expect(args).not.toContain("--no-playlist")
    expect(valueAfter(args, "-I")).toBe("1:3")
  })

  /**
   * ORDER IS LOAD-BEARING, exactly as it is for a single video: `-t mp4`
   * expands to an -S of its own and the last -S on the line wins
   */
  test("the preset is pushed BEFORE the -S sort, never after", () => {
    const args = buildArgs("playlist-combined", { ...PLAYLIST, height: 720 })

    expect(containsSequence(args, ["-t", "mp4", "-S", "res:720"])).toBe(true)
  })

  /**
   * mp4 at every height, unlike the per-tier container a single video gets.
   * `-t mp4` does not fall back to 1080p h264 above 1080p - it takes the vp9
   * stream and remuxes it - so one container costs nothing and buys one
   * extension for the whole folder
   */
  test("asks for mp4 at every height, and ignores a container the caller sent", () => {
    for (const height of [360, 720, 1080, 1440, 2160]) {
      const args = buildArgs("playlist-combined", {
        ...PLAYLIST,
        height,
        container: "mkv"
      })

      expect(containsSequence(args, ["-t", "mp4", "-S", `res:${height}`])).toBe(true)
      expect(args).not.toContain("mkv")
    }
  })

  test("a missing height is still a complete instruction", () => {
    const args = buildArgs("playlist-combined", { ...PLAYLIST })

    expect(containsSequence(args, ["-t", "mp4"])).toBe(true)
    expect(args).not.toContain("-S")
  })

  test("carries yt-dlp's own playlist guide flags", () => {
    const args = buildArgs("playlist-combined", { ...PLAYLIST, height: 1080 })

    expect(valueAfter(args, "--skip-playlist-after-errors")).toBe(
      String(PLAYLIST_ERROR_BUDGET)
    )
    expect(valueAfter(args, "--sleep-requests")).toBe(String(PLAYLIST_SLEEP_REQUESTS))
    expect(valueAfter(args, "-N")).toBe(String(PLAYLIST_FRAGMENTS))
  })

  /**
   * -I already bounds the run to the selection, and buildPlaylistItemsSpec
   * caps that at PLAYLIST_MAX_ITEMS, so --max-downloads protects against
   * nothing - and it is not free. measured against 2026.08.19, yt-dlp exits
   * **101** the moment the limit is reached rather than exceeded:
   * `--max-downloads 2` over two items exits 101, `--max-downloads 3` over the
   * same two exits 0. a cap that only ever fires on a run that downloaded
   * everything asked of it is a trap for whoever reads the exit code
   */
  test("does not cap a run that -I has already bounded", () => {
    const args = buildArgs("playlist-combined", { ...PLAYLIST, height: 1080 })

    expect(args).not.toContain("--max-downloads")
  })

  test("resumes through an archive when it is given one", () => {
    const withArchive = buildArgs("playlist-combined", {
      ...PLAYLIST,
      height: 1080,
      archiveFile: "/userData/playlists/PL123__1080p-mp4.txt"
    })

    expect(valueAfter(withArchive, "--download-archive")).toBe(
      "/userData/playlists/PL123__1080p-mp4.txt"
    )

    // optional the same way --cookies is: a caller with nowhere to keep the
    // file still gets a working download
    expect(buildArgs("playlist-combined", { ...PLAYLIST, height: 1080 })).not.toContain(
      "--download-archive"
    )
  })

  test("writes into the playlist folder with the progress plumbing intact", () => {
    const args = buildArgs("playlist-combined", { ...PLAYLIST, height: 1080 })

    expect(valueAfter(args, "-P")).toBe("/downloads")
    expect(valueAfter(args, "-o")).toBe(buildPlaylistOutputTemplate({}))
    expect(args).toContain("--progress")
    expect(args.filter((arg) => arg === "--print")).toHaveLength(2)
    expect(args).toContain("--no-quiet")
  })

  test.each(["playlist-combined", "playlist-audio"])(
    "%s puts -- immediately before the url",
    (operation) => {
      const args = buildArgs(operation, { ...PLAYLIST, height: 720 })

      expect(args[args.length - 2]).toBe("--")
      expect(args[args.length - 1]).toBe(PLAYLIST.url)
    }
  )

  /**
   * structural, not cosmetic. --download-sections across videos of different
   * lengths is meaningless, so the operation refuses a time range outright
   * rather than leaving it to the ui to hide the control
   */
  test.each(["playlist-combined", "playlist-audio"])(
    "%s throws rather than accepting a time range",
    (operation) => {
      expect(() =>
        buildArgs(operation, {
          ...PLAYLIST,
          height: 720,
          audioMode: "mp3",
          timeRange: { start: 5, end: 65 }
        })
      ).toThrow(/cannot be trimmed/)
    }
  )

  test.each(["playlist-combined", "playlist-audio"])(
    "%s never emits --download-sections",
    (operation) => {
      const args = buildArgs(operation, { ...PLAYLIST, height: 720, audioMode: "mp3" })

      expect(args).not.toContain("--download-sections")
      expect(args).not.toContain("--force-keyframes-at-cuts")
    }
  )

  test.each(["playlist-combined", "playlist-audio"])(
    "%s refuses to build args for an empty selection",
    (operation) => {
      expect(() =>
        buildArgs(operation, { ...PLAYLIST, playlistIndices: [], audioMode: "mp3" })
      ).toThrow(/at least one selected item/)
    }
  )
})

describe("playlist audio args", () => {
  const AUDIO = { ...PLAYLIST }

  test("mp3 and m4a ask for the presets, exactly as one video does", () => {
    expect(valueAfter(buildArgs("playlist-audio", { ...AUDIO, audioMode: "mp3" }), "-t")).toBe("mp3")
    expect(valueAfter(buildArgs("playlist-audio", { ...AUDIO, audioMode: "m4a" }), "-t")).toBe("aac")
  })

  test("original means no preset at all, just the selector", () => {
    const args = buildArgs("playlist-audio", { ...AUDIO, audioMode: "original" })

    expect(valueAfter(args, "-f")).toBe("ba/b")
    expect(args).not.toContain("-t")
  })

  test("an unrecognised mode still produces a playable file", () => {
    expect(valueAfter(buildArgs("playlist-audio", { ...AUDIO, audioMode: "flac" }), "-t")).toBe("mp3")
    expect(valueAfter(buildArgs("playlist-audio", { ...AUDIO }), "-t")).toBe("mp3")
  })

  /**
   * the dub picker cannot be offered for a playlist: the languages a video
   * carries are read out of *its* format list, and a playlist has one list per
   * video. so every item gets its original track, which is yt-dlp's own
   * default - and a language that arrives anyway changes nothing
   */
  test("never applies a dub language, however it is asked for", () => {
    for (const audioMode of ["mp3", "m4a", "original"]) {
      const withLanguage = buildArgs("playlist-audio", {
        ...AUDIO,
        audioMode,
        audioLanguage: "hi"
      })

      expect(withLanguage).toEqual(buildArgs("playlist-audio", { ...AUDIO, audioMode }))
      expect(withLanguage.join(" ")).not.toContain("language=")
    }

    const combined = buildArgs("playlist-combined", {
      ...PLAYLIST,
      height: 1080,
      audioLanguage: "hi"
    })

    expect(combined).toEqual(buildArgs("playlist-combined", { ...PLAYLIST, height: 1080 }))
    expect(combined).not.toContain("-f")
  })
})

describe("mapPlaylistInfo", () => {
  test("reports the playlist's true size next to what we actually fetched", () => {
    const mapped = mapPlaylistInfo(
      playlist([entry(), entry({ id: "b" })], { playlist_count: 11 })
    )

    expect(mapped).toMatchObject({
      playlist_id: "PLBCF2DAC6FFB574DE",
      title: "Google Search Stories",
      uploader: "Google Search Stories",
      count: 11,
      listed: 2,
      truncated: true
    })
  })

  test("a playlist fetched whole is not truncated", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => entry({ id: `v${i}` }))
    const mapped = mapPlaylistInfo(playlist(eleven, { playlist_count: 11 }))

    expect(mapped.count).toBe(11)
    expect(mapped.listed).toBe(11)
    expect(mapped.truncated).toBe(false)
  })

  /**
   * a channel feed paginates lazily and reports no playlist_count at all. that
   * null is passed on rather than papered over with the number we happened to
   * fetch: "100 of we-don't-know" and "100 of 100" are different headers
   */
  test("a channel feed reports no count, and is not called complete", () => {
    const mapped = mapPlaylistInfo(
      playlist([entry(), entry({ id: "b" })], { playlist_count: null })
    )

    expect(mapped.count).toBeNull()
    expect(mapped.truncated).toBe(false)
    expect(mapped.listed).toBe(2)
  })

  test("numbers the rows by position, which is what -I selects on", () => {
    const mapped = mapPlaylistInfo(
      playlist([entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })])
    )

    expect(mapped.entries.map((row) => row.index)).toEqual([1, 2, 3])
    expect(mapped.entries.map((row) => row.id)).toEqual(["a", "b", "c"])
  })

  test("formats durations and reads the thumbnail out of the array", () => {
    const [row] = mapPlaylistInfo(playlist([entry({ duration: 3725 })])).entries

    expect(row.duration).toBe(3725)
    expect(row.duration_string).toBe("01:02:05")
    // ordered worst first, so yt-dlp's own best pick is the last one
    expect(row.thumbnail).toBe("https://i.ytimg.com/vi/GvgqDSnpRQM/d.jpg")
  })

  test("an entry with no thumbnails at all is not an error", () => {
    const [row] = mapPlaylistInfo(playlist([entry({ thumbnails: undefined })])).entries

    expect(row.thumbnail).toBeNull()
  })

  /**
   * the exact shape a private entry arrives in, copied from a real listing:
   * playlist PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs, 19 items of which 5 are
   * private, measured against 2026.08.19.
   *
   * the `url` is the point of the fixture. yt-dlp synthesises one from the
   * video id for every entry it sees, dead or alive, so a "has no url" test
   * would never fire on a real youtube listing - and every private row would
   * render as downloadable, be ticked, error, and spend one of the five
   * --skip-playlist-after-errors failures.
   *
   * there is no `[Private video]` title to match either: the title is null.
   */
  test("marks a real private entry unavailable, url and all", () => {
    const private1 = {
      id: "mt7rGhAm2CY",
      title: null,
      duration: null,
      view_count: null,
      live_status: null,
      availability: null,
      url: "https://www.youtube.com/watch?v=mt7rGhAm2CY",
      thumbnails: [{ url: "https://i.ytimg.com/vi/mt7rGhAm2CY/d.jpg", width: 336 }]
    }

    const mapped = mapPlaylistInfo(
      playlist([
        entry({ id: "KIViy7L_lo8", title: "2016 — Year in Search", duration: 121 }),
        private1,
        { ...private1, id: "JcDTARrdoRs", title: "   " }
      ])
    )

    expect(mapped.entries.map((row) => row.unavailable)).toEqual([false, true, true])
    expect(mapped.entries[1].url).toBeUndefined()
    expect(mapped.entries[1].duration_string).toBeNull()
    expect(mapped.entries[1].index).toBe(2)
    // the row still renders - it is a gap in the list, not a missing line
    expect(mapped.entries[1].id).toBe("mt7rGhAm2CY")
    expect(mapped.entries[1].title).toBe("Unknown")
  })

  // the other half of the rule. a live stream reports no duration either, and
  // it is perfectly downloadable - what it has, and a private entry does not,
  // is a title
  test("does not call a live stream unavailable", () => {
    const [row] = mapPlaylistInfo(
      playlist([
        entry({ title: "Deep sea cam", duration: null, live_status: "is_live" })
      ])
    ).entries

    expect(row.unavailable).toBe(false)
    expect(row.duration).toBeNull()
  })

  // yt-dlp can emit a null entry; the rows after it must keep their positions
  test("survives a null entry without shifting the numbering", () => {
    const mapped = mapPlaylistInfo(playlist([entry({ id: "a" }), null, entry({ id: "c" })]))

    expect(mapped.entries.map((row) => row.index)).toEqual([1, 2, 3])
    expect(mapped.entries[1]).toMatchObject({ id: null, unavailable: true })
    expect(mapped.entries[2].id).toBe("c")
  })

  test("falls back to the channel when there is no uploader", () => {
    const mapped = mapPlaylistInfo(
      playlist([entry()], { uploader: undefined, channel: "TED" })
    )

    expect(mapped.uploader).toBe("TED")
  })

  test("a payload with nothing in it is a listing of nothing, not a crash", () => {
    for (const empty of [null, undefined, {}, { entries: null }]) {
      expect(mapPlaylistInfo(empty)).toMatchObject({
        count: null,
        listed: 0,
        truncated: false,
        entries: []
      })
    }
  })
})

describe("playlist output template", () => {
  test("both templates are the ones the design settled on", () => {
    expect(buildPlaylistOutputTemplate({ audioOnly: false })).toBe(
      "%(playlist_title).80B [%(playlist_id)s]/%(playlist_index)03d - %(title).80B [%(id)s] %(height)sp.%(ext)s"
    )
    expect(buildPlaylistOutputTemplate({ audioOnly: true })).toBe(
      "%(playlist_title).80B [%(playlist_id)s]/%(playlist_index)03d - %(title).80B [%(id)s].%(ext)s"
    )
  })

  test("video defaults over audio when nobody says which", () => {
    expect(buildPlaylistOutputTemplate()).toBe(
      buildPlaylistOutputTemplate({ audioOnly: false })
    )
  })

  /**
   * left to itself `%(playlist_index)s` pads to the digit width of the
   * *largest selected index*, which is per-run rather than per-playlist:
   * measured against 2026.08.19, `-I 1,3` gives `1`, `3` while `-I 7,11` gives
   * `07`, `11`. each run is internally consistent, so this is not about one
   * run sorting wrongly.
   *
   * it is about the folder outliving the run. download 1 and 3, come back for
   * 7 and 11, and one folder holds `1 - ...`, `3 - ...`, `07 - ...` and
   * `11 - ...` at two different widths. a width pinned to the cap is the same
   * in every run, and is derived from the constant so the two cannot drift
   */
  test("pads the item number to the width of the item cap", () => {
    expect(PLAYLIST_INDEX_WIDTH).toBe(String(PLAYLIST_MAX_ITEMS).length)

    for (const audioOnly of [true, false]) {
      expect(buildPlaylistOutputTemplate({ audioOnly })).toContain(
        `%(playlist_index)0${PLAYLIST_INDEX_WIDTH}d`
      )
      expect(buildPlaylistOutputTemplate({ audioOnly })).not.toContain(
        "%(playlist_index)s"
      )
    }
  })

  /**
   * the download archive is keyed by video id alone, so it is quality-blind. a
   * name that did not vary with the delivered height would defeat the
   * per-quality archive scoping one layer down: yt-dlp would find the file
   * already on disk and skip it, and "download this again in 4K" would quietly
   * do nothing. audio has no height to carry, exactly as AUDIO_TEMPLATE does
   * not
   */
  test("only the video name carries the height it really got", () => {
    expect(buildPlaylistOutputTemplate({ audioOnly: false })).toContain("%(height)sp")
    expect(buildPlaylistOutputTemplate({ audioOnly: true })).not.toContain("%(height)s")
  })

  test("puts each playlist in its own folder, keyed by id as well as title", () => {
    for (const audioOnly of [true, false]) {
      const [folder, name] = buildPlaylistOutputTemplate({ audioOnly }).split("/")

      expect(folder).toBe("%(playlist_title).80B [%(playlist_id)s]")
      expect(name).toContain("%(title).80B")
    }
  })

  // titles are not unique and get edited; ids never change. the id and the
  // height together already make the name unique, so no %(epoch)s is needed
  // either - unlike the single-video templates
  test("carries the id and needs no timestamp", () => {
    for (const audioOnly of [true, false]) {
      expect(buildPlaylistOutputTemplate({ audioOnly })).toContain("[%(id)s]")
      expect(buildPlaylistOutputTemplate({ audioOnly })).not.toContain("%(epoch)s")
    }
  })

  /**
   * THE test for these templates, and the reason the video title is capped at
   * .80B rather than the .120B a single video gets.
   *
   * `--trim-filenames` counts the whole *relative* path, folder included, and
   * truncates the stem from the tail - so whatever sits at the end of the name
   * is what it eats first. measured against 2026.08.19 with an artificially
   * low trim:
   *
   *     trim 90: .../003 - Mark Lesek： A New⧸Old Prosthetic [V4DDt30.mp4
   *     trim 70: .../003 - Mark Lesek： A New⧸Old.mp4
   *     trim 30: .../Google Search Stories [PLBCF2D.mp4   <- the folder is gone
   *
   * the height goes first and the id second, which is exactly the pair that
   * keeps two runs at different ceilings from writing the same filename. so
   * the worst case has to fit inside the budget with room to spare, and it is
   * computed from the template here rather than restated - widen any field
   * later and this is what says so.
   */
  test("the worst case a template can render fits inside --trim-filenames", () => {
    // the flag the templates actually ship alongside, read off a real arg list
    // rather than copied
    const budget = Number(
      valueAfter(buildArgs("playlist-combined", { ...PLAYLIST, height: 2160 }), "--trim-filenames")
    )

    for (const audioOnly of [true, false]) {
      const rendered = renderWorstCase(buildPlaylistOutputTemplate({ audioOnly }))

      expect(rendered.length).toBeLessThanOrEqual(budget)
    }

    // the numbers themselves, so a regression reads as a number and not just a
    // failed comparison: 80 title + 41 id + 80 title + 11 id + "2160p"
    expect(renderWorstCase(buildPlaylistOutputTemplate({ audioOnly: false })).length).toBe(231)
    expect(renderWorstCase(buildPlaylistOutputTemplate({ audioOnly: true })).length).toBe(225)
  })
})

describe("getPlaylistInfo", () => {
  test("parses the single object yt-dlp printed", async () => {
    const info = await listingWith(
      JSON.stringify({ id: "PL1", title: "A list", playlist_count: 2, entries: [] })
    )

    expect(info).toMatchObject({ id: "PL1", title: "A list", playlist_count: 2 })
  })

  /**
   * the line-per-entry parser this replaced swallowed a broken payload into an
   * empty array, which reaches the user as a playlist that genuinely has no
   * videos in it. a failure has to arrive as a failure - and nothing else in
   * the repo calls getPlaylistInfo yet, so this test is the only thing holding
   * that branch
   */
  test("a malformed payload is a classified failure, not an empty playlist", async () => {
    expect.assertions(4)

    try {
      await listingWith("{not json at all")
    } catch (error) {
      expect(error.code).toBe(ERROR_CODES.DOWNLOAD_FAILED)
      expect(error.message).toMatch(/playlist details/)
      expect(error.suggestion).toBeTruthy()
      // the parser's own complaint, which is what an issue report needs
      expect(error.details).toBeTruthy()
    }
  })

  test("an empty stdout fails the same way rather than returning nothing", async () => {
    await expect(listingWith("")).rejects.toMatchObject({
      code: ERROR_CODES.DOWNLOAD_FAILED
    })
  })
})

// the engine builds `-I 1:<cap>` and bounds the selection against the cap; the
// mappers pad filenames to its width. one constant, one source of truth
describe("the item cap", () => {
  test("is the same number on both sides of the module boundary", () => {
    expect(PLAYLIST_MAX_ITEMS).toBe(MAPPER_PLAYLIST_MAX_ITEMS)
    expect(PLAYLIST_MAX_ITEMS).toBe(100)
  })
})

describe("playlist archive path", () => {
  const USER_DATA = "/userData"

  /**
   * the archive is keyed by video id and nothing else, so it is quality-blind:
   * one archive.txt per playlist would make "download this again in 4K"
   * silently do nothing
   */
  test("scopes the file per playlist and per quality", () => {
    expect(
      buildPlaylistArchivePath({
        userDataPath: USER_DATA,
        playlistId: "PLBCF2DAC6FFB574DE",
        mode: "1080p-mp4"
      })
    ).toBe(path.join(USER_DATA, "playlists", "PLBCF2DAC6FFB574DE__1080p-mp4.txt"))

    expect(
      buildPlaylistArchivePath({
        userDataPath: USER_DATA,
        playlistId: "PLBCF2DAC6FFB574DE",
        mode: "mp3"
      })
    ).toBe(path.join(USER_DATA, "playlists", "PLBCF2DAC6FFB574DE__mp3.txt"))
  })

  test("two qualities of one playlist never share an archive", () => {
    const at1080 = buildPlaylistArchivePath({
      userDataPath: USER_DATA,
      playlistId: "PL1",
      mode: "1080p-mp4"
    })
    const at2160 = buildPlaylistArchivePath({
      userDataPath: USER_DATA,
      playlistId: "PL1",
      mode: "2160p-mp4"
    })

    expect(at1080).not.toBe(at2160)
  })

  // the id becomes a path component, and nothing arriving over ipc gets to
  // write `../` into a path we then open for writing
  test("strips anything that could mean something to a filesystem", () => {
    const escaped = buildPlaylistArchivePath({
      userDataPath: USER_DATA,
      playlistId: "../../etc/passwd",
      mode: "1080p/../mp4"
    })

    // dots go too, so no component can ever be `..`
    expect(escaped).toBe(path.join(USER_DATA, "playlists", "etcpasswd__1080pmp4.txt"))
    expect(escaped.startsWith(path.join(USER_DATA, "playlists"))).toBe(true)
  })

  test("an id that sanitises away still lands on a usable name", () => {
    expect(
      buildPlaylistArchivePath({ userDataPath: USER_DATA, playlistId: "///", mode: "mp3" })
    ).toBe(path.join(USER_DATA, "playlists", "playlist__mp3.txt"))
  })

  test("refuses to guess where userData is", () => {
    expect(() => buildPlaylistArchivePath({ playlistId: "PL1", mode: "mp3" })).toThrow(
      /userData path/
    )
  })

  /**
   * scoping by quality is the entire job here, so a caller that forgets it is
   * refused rather than defaulted. a default would be one shared filename that
   * two runs at different qualities both land on - which is exactly the
   * quality-blind archive the scoping exists to avoid
   */
  test("refuses to write an archive that is scoped to nothing", () => {
    for (const mode of [undefined, null, ""]) {
      expect(() =>
        buildPlaylistArchivePath({ userDataPath: USER_DATA, playlistId: "PL1", mode })
      ).toThrow(/quality it is scoped to/)
    }
  })
})
