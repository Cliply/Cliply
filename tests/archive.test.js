// unit tests for the zip reader the onedir engine is unpacked with

const crypto = require("crypto")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  extractZip,
  sha256File,
  parseChecksums,
  safeJoin
} = require("../src/main/utils/archive")
const {
  makeZip,
  METHOD_STORE,
  S_IFREG,
  S_IFLNK,
  EOCD_SIGNATURE
} = require("./helpers/zip-fixture")

describe("extractZip", () => {
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-archive-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writeZip(entries, options = {}, name = "fixture.zip") {
    const zipPath = path.join(root, name)
    fs.writeFileSync(zipPath, makeZip(entries, options))
    return zipPath
  }

  test("unpacks deflated and stored entries into nested directories", async () => {
    const zipPath = writeZip([
      { name: "_internal/" },
      { name: "_internal/deep/payload.bin", data: "x".repeat(4096) },
      { name: "yt-dlp_macos", data: "engine", method: METHOD_STORE },
      { name: "empty.txt", data: "" }
    ])

    const result = await extractZip(zipPath, path.join(root, "out"))

    expect(result.entries).toBe(4)
    expect(fs.readFileSync(path.join(root, "out", "_internal", "deep", "payload.bin"), "utf8")).toBe(
      "x".repeat(4096)
    )
    expect(fs.readFileSync(path.join(root, "out", "yt-dlp_macos"), "utf8")).toBe("engine")
    expect(fs.readFileSync(path.join(root, "out", "empty.txt"), "utf8")).toBe("")
    expect(fs.statSync(path.join(root, "out", "_internal")).isDirectory()).toBe(true)
  })

  test("keeps the executable bit the archive recorded", async () => {
    const zipPath = writeZip([
      { name: "yt-dlp_macos", data: "engine", mode: 0o755 },
      { name: "_internal/notes.txt", data: "plain", mode: 0o644 }
    ])

    await extractZip(zipPath, path.join(root, "out"))

    if (process.platform === "win32") {
      return
    }

    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(path.join(root, "out", "yt-dlp_macos")).mode & 0o111).toBeTruthy()
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(path.join(root, "out", "_internal", "notes.txt")).mode & 0o111).toBeFalsy()
  })

  test("refuses entries that would escape the destination", async () => {
    const zipPath = writeZip([{ name: "../escaped.txt", data: "nope" }])

    await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
      /unsafe zip entry/
    )
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false)
  })

  test("refuses encrypted entries", async () => {
    const zipPath = writeZip([{ name: "secret.bin", data: "shh", flags: 0x1 }])

    await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(/encrypted/)
  })

  test("refuses compression methods it cannot read", async () => {
    const zipPath = writeZip([{ name: "odd.bin", data: "data", method: 12 }])

    await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
      /unsupported zip compression method/
    )
  })

  test("rejects a file that is not a zip at all", async () => {
    const zipPath = path.join(root, "not.zip")
    fs.writeFileSync(zipPath, "just some bytes, definitely not an archive")

    await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(/not a zip/)
  })

  // a verified checksum only proves github sent these bytes - the headers
  // inside still have to be treated as hostile
  describe("malformed archives fail closed", () => {
    test("refuses a central directory that runs past the end of the file", async () => {
      const zipPath = writeZip(
        [{ name: "yt-dlp_macos", data: "engine" }],
        { directorySize: 0xfffffff0 }
      )

      // the giveaway of the bug this guards: a multi-gigabyte Buffer.alloc
      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /bad size or offset/
      )
    })

    test("refuses a central directory offset outside the file", async () => {
      const zipPath = writeZip(
        [{ name: "yt-dlp_macos", data: "engine" }],
        { directoryOffset: 0x7fffff00 }
      )

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /bad size or offset/
      )
    })

    test("refuses a directory too small for the entries it claims", async () => {
      const zipPath = writeZip(
        [{ name: "yt-dlp_macos", data: "engine" }],
        { directorySize: 8 }
      )

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /bad size or offset/
      )
    })

    test("is not fooled by an end-of-directory signature inside the comment", async () => {
      const decoy = Buffer.alloc(48)
      decoy.writeUInt32LE(EOCD_SIGNATURE, 0)
      decoy.write("padding so the decoy is not the last thing", 4)

      const zipPath = writeZip(
        [{ name: "yt-dlp_macos", data: "engine", method: METHOD_STORE }],
        { comment: decoy }
      )

      await extractZip(zipPath, path.join(root, "out"))

      expect(fs.readFileSync(path.join(root, "out", "yt-dlp_macos"), "utf8")).toBe("engine")
    })

    test("refuses multi-disk archives", async () => {
      const zipPath = writeZip([{ name: "yt-dlp_macos", data: "engine" }], {
        diskNumber: 1
      })

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /multi-disk/
      )
    })

    test("refuses per-entry zip64 sentinels", async () => {
      const sizes = writeZip(
        [{ name: "big.bin", data: "x", compressedSizeOverride: 0xffffffff }],
        {},
        "zip64-size.zip"
      )
      const offsets = writeZip(
        [{ name: "far.bin", data: "x", localOffsetOverride: 0xffffffff }],
        {},
        "zip64-offset.zip"
      )

      await expect(extractZip(sizes, path.join(root, "out"))).rejects.toThrow(/zip64/)
      await expect(extractZip(offsets, path.join(root, "out2"))).rejects.toThrow(/zip64/)
    })

    test("refuses an entry whose data runs past the end of the archive", async () => {
      const zipPath = writeZip([
        { name: "yt-dlp_macos", data: "engine", compressedSizeOverride: 0x7ffffff0 }
      ])

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /past the end/
      )
    })

    test("refuses an unknown compression method even with no bytes to write", async () => {
      // the method check used to sit behind the empty-file shortcut
      const zipPath = writeZip([{ name: "odd.bin", data: "", methodOverride: 99 }])

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /unsupported zip compression method/
      )
    })

    test("refuses entries claiming to be symlinks or other special files", async () => {
      const zipPath = writeZip([
        { name: "libssl.dylib", data: "../../../etc/passwd", statMode: S_IFLNK | 0o777 }
      ])

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /non-regular zip entry/
      )
      expect(fs.existsSync(path.join(root, "out", "libssl.dylib"))).toBe(false)
    })

    test("refuses an entry whose local header shifts its data past the end", async () => {
      // the central directory says the data fits; the local header's extra
      // field moves where it actually starts. checking only the central
      // directory's offset let this extract as a silently empty file
      const zipPath = writeZip([
        {
          name: "yt-dlp_macos",
          data: "engine bytes that matter",
          method: METHOD_STORE,
          localExtraLength: 100
        }
      ])

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /past the end/
      )
      expect(fs.existsSync(path.join(root, "out", "yt-dlp_macos"))).toBe(false)
    })

    test("refuses an entry whose local header claims a longer name", async () => {
      const zipPath = writeZip([
        {
          name: "yt-dlp_macos",
          data: "engine bytes that matter",
          method: METHOD_STORE,
          localNameLength: 400
        }
      ])

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /past the end/
      )
    })

    test("refuses an entry that unpacks to the wrong size", async () => {
      // truncating the declared payload is the other way a short read shows up
      const zipPath = writeZip([
        {
          name: "yt-dlp_macos",
          data: "engine",
          method: METHOD_STORE,
          uncompressedSizeOverride: 4096
        }
      ])

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(
        /unpacked to \d+ bytes/
      )
    })

    test("nothing is written when an entry is refused", async () => {
      const zipPath = writeZip([
        { name: "fine.bin", data: "written before the bad one" },
        { name: "../escaped.bin", data: "nope" }
      ])

      await expect(extractZip(zipPath, path.join(root, "out"))).rejects.toThrow(/unsafe/)
      expect(fs.existsSync(path.join(root, "escaped.bin"))).toBe(false)
    })
  })

  test("drops setuid and sticky bits an archive asks for", async () => {
    const zipPath = writeZip([
      { name: "yt-dlp_macos", data: "engine", statMode: S_IFREG | 0o4755 }
    ])

    await extractZip(zipPath, path.join(root, "out"))

    if (process.platform === "win32") {
      return
    }

    const mode = fs.statSync(path.join(root, "out", "yt-dlp_macos")).mode
    // eslint-disable-next-line no-bitwise
    expect(mode & 0o7000).toBe(0)
    // eslint-disable-next-line no-bitwise
    expect(mode & 0o111).toBeTruthy()
  })

  test("stops when the signal is already aborted", async () => {
    const zipPath = writeZip([{ name: "yt-dlp_macos", data: "engine" }])
    const controller = new AbortController()
    controller.abort()

    await expect(
      extractZip(zipPath, path.join(root, "out"), { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })

    expect(fs.existsSync(path.join(root, "out", "yt-dlp_macos"))).toBe(false)
  })
})

describe("safeJoin", () => {
  test("keeps entries inside the destination", () => {
    expect(safeJoin("/tmp/out", "_internal/a.bin")).toBe(path.join("/tmp/out", "_internal", "a.bin"))
    expect(safeJoin("/tmp/out", "./a.bin")).toBe(path.join("/tmp/out", "a.bin"))
  })

  test("rejects traversal, absolute and drive-rooted names", () => {
    expect(() => safeJoin("/tmp/out", "../a.bin")).toThrow(/unsafe/)
    expect(() => safeJoin("/tmp/out", "a/../../b.bin")).toThrow(/unsafe/)
    expect(() => safeJoin("/tmp/out", "/etc/passwd")).toThrow(/unsafe/)
    expect(() => safeJoin("/tmp/out", "C:\\windows\\system32")).toThrow(/unsafe/)
    expect(() => safeJoin("/tmp/out", "")).toThrow(/unsafe/)
  })
})

describe("sha256File", () => {
  test("matches a digest taken over the same bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cliply-archive-"))
    const filePath = path.join(root, "blob.bin")
    const bytes = crypto.randomBytes(64 * 1024)

    fs.writeFileSync(filePath, bytes)

    try {
      expect(await sha256File(filePath)).toBe(
        crypto.createHash("sha256").update(bytes).digest("hex")
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("parseChecksums", () => {
  test("reads the release listing format", () => {
    const sums = parseChecksums(
      [
        "07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8  yt-dlp_macos.zip",
        "30b4c14aafab6082becff7881e41b76df46dc43ea7633479410a91e29da492bf  yt-dlp_win.zip",
        "",
        "not a checksum line"
      ].join("\n")
    )

    expect(sums.get("yt-dlp_macos.zip")).toBe(
      "07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8"
    )
    expect(sums.size).toBe(2)
  })

  test("survives an empty or missing listing", () => {
    expect(parseChecksums("").size).toBe(0)
    expect(parseChecksums(null).size).toBe(0)
  })
})
