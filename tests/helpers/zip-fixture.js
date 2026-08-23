// builds real zip archives for the archive/updater tests
// the reader under test parses actual central directory records, so faking the
// bytes is the only way to exercise it honestly - including the malformed ones

const zlib = require("zlib")

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

// unix st_mode file types, for entries that claim to be something exotic
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

function crc32(buffer) {
  // node 20.15+ ships one; the reader ignores crcs, so a zero is only a
  // problem for other tools reading the fixture
  return typeof zlib.crc32 === "function" ? zlib.crc32(buffer) >>> 0 : 0
}

/**
 * build a zip archive
 *
 * @param {Object[]} entries - {name, data, mode, statMode, method, methodOverride,
 *   madeByUnix, flags, compressedSizeOverride, uncompressedSizeOverride,
 *   localOffsetOverride, localNameLength, localExtraLength}
 * @param {Object} options - {comment, directorySize, directoryOffset,
 *   diskNumber, directoryDisk, entriesOnDisk} - overrides for malformed cases
 * @returns {Buffer} the archive
 */
function makeZip(entries, options = {}) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const isDirectory = entry.name.endsWith("/")
    const raw = isDirectory
      ? Buffer.alloc(0)
      : Buffer.from(entry.data === undefined ? "" : entry.data)
    const method = entry.method === undefined ? METHOD_DEFLATE : entry.method
    const payload =
      method === METHOD_DEFLATE && raw.length ? zlib.deflateRawSync(raw) : raw
    const madeByUnix = entry.madeByUnix === undefined ? true : entry.madeByUnix
    const permissions =
      entry.mode === undefined ? (isDirectory ? 0o755 : 0o644) : entry.mode
    // statMode lets a test claim a file type the reader must refuse
    const statMode = entry.statMode === undefined ? permissions : entry.statMode
    // an empty entry is normally stored, but a test may force any method to
    // prove the reader checks it before it takes the zero-byte shortcut
    const storedMethod =
      entry.methodOverride === undefined
        ? raw.length
          ? method
          : METHOD_STORE
        : entry.methodOverride

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags || 0, 6)
    local.writeUInt16LE(storedMethod, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    // the local header carries its own name and extra lengths, and nothing
    // forces them to agree with the central directory - which is exactly how a
    // padded local header can shift where an entry's data appears to start
    local.writeUInt16LE(pick(entry.localNameLength, name.length), 26)
    local.writeUInt16LE(entry.localExtraLength || 0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(((madeByUnix ? 3 : 0) << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags || 0, 8)
    central.writeUInt16LE(storedMethod, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(
      pick(entry.compressedSizeOverride, payload.length),
      20
    )
    central.writeUInt32LE(pick(entry.uncompressedSizeOverride, raw.length), 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((statMode << 16) >>> 0) >>> 0, 38)
    central.writeUInt32LE(pick(entry.localOffsetOverride, offset), 42)

    locals.push(local, name, payload)
    centrals.push(central, name)
    offset += local.length + name.length + payload.length
  }

  const directory = Buffer.concat(centrals)
  const comment = options.comment
    ? Buffer.from(options.comment)
    : Buffer.alloc(0)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(options.diskNumber || 0, 4)
  eocd.writeUInt16LE(options.directoryDisk || 0, 6)
  eocd.writeUInt16LE(pick(options.entriesOnDisk, entries.length), 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(pick(options.directorySize, directory.length), 12)
  eocd.writeUInt32LE(pick(options.directoryOffset, offset), 16)
  eocd.writeUInt16LE(comment.length, 20)

  return Buffer.concat([...locals, directory, eocd, comment])
}

function pick(override, fallback) {
  return override === undefined ? fallback : override
}

/**
 * a stand-in for a yt-dlp onedir release archive
 * @param {string} executableName - the platform's executable name
 * @param {string} version - what the fake engine should report
 * @returns {Buffer} the archive
 */
function makeEngineZip(executableName, version = "2026.09.01") {
  return makeZip([
    { name: "_internal/", data: "" },
    { name: "_internal/payload.bin", data: `payload for ${version}` },
    { name: executableName, data: `#!/bin/sh\necho ${version}\n`, mode: 0o755 }
  ])
}

module.exports = {
  makeZip,
  makeEngineZip,
  METHOD_STORE,
  METHOD_DEFLATE,
  S_IFREG,
  S_IFLNK,
  EOCD_SIGNATURE
}
