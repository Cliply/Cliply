/**
 * archive helpers for the yt-dlp onedir releases
 *
 * the official zips are plain store/deflate archives - no zip64, no
 * encryption, no symlinks, fewer than 200 entries - so reading them here costs
 * less than a dependency would. the archive's sha-256 is verified against the
 * release's SHA2-256SUMS before anything is unpacked, which is stronger than
 * the per-entry crcs this reader skips.
 */

const crypto = require("crypto")
const fs = require("fs")
const fsp = require("fs").promises
const path = require("path")
const zlib = require("zlib")
const { pipeline } = require("stream/promises")

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

const EOCD_MIN_SIZE = 22
// the trailing comment is a 16-bit length, so the record starts at most this
// far from the end of the file
const EOCD_MAX_SEARCH = EOCD_MIN_SIZE + 0xffff
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

// "version made by" high byte: 3 means the entry carries unix permissions
const MADE_BY_UNIX = 3

// the file-type nibble of a unix st_mode, as stored in the external attributes
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

/**
 * unpack a zip archive into a directory
 * @param {string} zipPath - archive on disk
 * @param {string} destDir - directory to unpack into (created if missing)
 * @param {Object} options - {signal} - aborts between entries
 * @returns {Promise<Object>} {entries} how many entries were written
 */
async function extractZip(zipPath, destDir, options = {}) {
  const signal = options.signal || null
  const handle = await fsp.open(zipPath, "r")

  try {
    const { size } = await handle.stat()
    const entries = await readCentralDirectory(handle)
    await fsp.mkdir(destDir, { recursive: true })

    for (const entry of entries) {
      throwIfAborted(signal)
      await extractEntry(handle, zipPath, entry, destDir, size)
    }

    return { entries: entries.length }
  } finally {
    await handle.close()
  }
}

/**
 * read every central directory record
 *
 * a verified sha-256 proves the bytes are the ones github published; it says
 * nothing about the header fields inside being sane. every size and offset is
 * therefore checked against the real file length *before* it is allocated or
 * read, so a malformed archive fails closed instead of asking for a
 * multi-gigabyte buffer.
 *
 * @param {Object} handle - open FileHandle
 * @returns {Promise<Object[]>} entry descriptors
 */
async function readCentralDirectory(handle) {
  const { size } = await handle.stat()
  const searchLength = Math.min(size, EOCD_MAX_SEARCH)

  if (searchLength < EOCD_MIN_SIZE) {
    throw new Error("not a zip archive (file is too small)")
  }

  const tail = Buffer.alloc(searchLength)
  const tailRead = await handle.read(tail, 0, searchLength, size - searchLength)

  if (tailRead.bytesRead !== searchLength) {
    throw new Error("could not read the end of the zip archive")
  }

  const eocd = findEndOfCentralDirectory(tail, size)

  const count = tail.readUInt16LE(eocd + 10)
  const directorySize = tail.readUInt32LE(eocd + 12)
  const directoryOffset = tail.readUInt32LE(eocd + 16)

  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported")
  }

  // the directory has to live inside the file, and hold at least one fixed
  // header per entry it claims
  if (
    directoryOffset + directorySize > size ||
    directorySize < count * CENTRAL_HEADER_SIZE
  ) {
    throw new Error("corrupt zip central directory (bad size or offset)")
  }

  const directory = Buffer.alloc(directorySize)
  const directoryRead = await handle.read(directory, 0, directorySize, directoryOffset)

  if (directoryRead.bytesRead !== directorySize) {
    throw new Error("could not read the zip central directory")
  }

  const entries = []
  let cursor = 0

  for (let index = 0; index < count; index++) {
    if (
      cursor + CENTRAL_HEADER_SIZE > directory.length ||
      directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("corrupt zip central directory")
    }

    const flags = directory.readUInt16LE(cursor + 8)
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)

    if (cursor + CENTRAL_HEADER_SIZE + nameLength > directory.length) {
      throw new Error("corrupt zip central directory (truncated entry name)")
    }

    const name = directory.toString(
      "utf8",
      cursor + CENTRAL_HEADER_SIZE,
      cursor + CENTRAL_HEADER_SIZE + nameLength
    )

    // bit 0 is the traditional pkware cipher; yt-dlp never ships one
    if (flags & 0x1) {
      throw new Error(`encrypted zip entry: ${name}`)
    }

    const entry = {
      name,
      versionMadeBy: directory.readUInt16LE(cursor + 4),
      method: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      externalAttributes: directory.readUInt32LE(cursor + 38),
      localOffset: directory.readUInt32LE(cursor + 42)
    }

    validateEntry(entry, size)
    entries.push(entry)

    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
  }

  return entries
}

/**
 * locate the end of central directory record
 *
 * scanning backwards for the signature is not enough on its own: the same four
 * bytes can appear inside a legitimate archive comment. a real record ends
 * exactly at the end of the file and describes a single-disk archive, which
 * pins the choice down.
 *
 * @param {Buffer} tail - the last bytes of the file
 * @param {number} size - the file's length
 * @returns {number} offset of the record within tail
 */
function findEndOfCentralDirectory(tail, size) {
  const base = size - tail.length

  for (let index = tail.length - EOCD_MIN_SIZE; index >= 0; index--) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) {
      continue
    }

    const commentLength = tail.readUInt16LE(index + 20)

    // the record plus its comment must be the last thing in the file
    if (base + index + EOCD_MIN_SIZE + commentLength !== size) {
      continue
    }

    // multi-disk archives (and the spanning markers that go with them) are not
    // something the release assets ever use
    if (
      tail.readUInt16LE(index + 4) !== 0 ||
      tail.readUInt16LE(index + 6) !== 0 ||
      tail.readUInt16LE(index + 8) !== tail.readUInt16LE(index + 10)
    ) {
      throw new Error("multi-disk zip archives are not supported")
    }

    return index
  }

  throw new Error("not a zip archive (no end of central directory)")
}

// everything an entry claims about itself, checked against the file it came in
function validateEntry(entry, size) {
  if (
    entry.compressedSize === 0xffffffff ||
    entry.uncompressedSize === 0xffffffff ||
    entry.localOffset === 0xffffffff
  ) {
    throw new Error(`zip64 entry is not supported: ${entry.name}`)
  }

  // the method is checked here rather than at write time so that a zero-byte
  // entry cannot slip past it
  if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
    throw new Error(
      `unsupported zip compression method ${entry.method} for ${entry.name}`
    )
  }

  if (entry.localOffset + LOCAL_HEADER_SIZE + entry.compressedSize > size) {
    throw new Error(`zip entry runs past the end of the archive: ${entry.name}`)
  }

  const fileType = unixFileType(entry)

  // symlinks, fifos and device nodes have no business in a yt-dlp release, and
  // materializing one is never what the caller wants
  if (fileType !== null && fileType !== S_IFREG && fileType !== S_IFDIR) {
    throw new Error(`refusing to unpack a non-regular zip entry: ${entry.name}`)
  }
}

async function extractEntry(handle, zipPath, entry, destDir, size) {
  const target = safeJoin(destDir, entry.name)

  if (entry.name.endsWith("/")) {
    await fsp.mkdir(target, { recursive: true })
    return
  }

  await fsp.mkdir(path.dirname(target), { recursive: true })

  // the compression method was validated with the rest of the header, so by
  // here it is store or deflate and nothing else
  if (entry.compressedSize === 0) {
    await fsp.writeFile(target, "")
  } else {
    const start = await readDataOffset(handle, entry, size)
    const source = fs.createReadStream(zipPath, {
      start,
      end: start + entry.compressedSize - 1
    })

    if (entry.method === METHOD_STORE) {
      await pipeline(source, fs.createWriteStream(target))
    } else {
      await pipeline(source, zlib.createInflateRaw(), fs.createWriteStream(target))
    }
  }

  // a read that fell short would otherwise land as a silently truncated file
  const written = (await fsp.stat(target)).size
  if (written !== entry.uncompressedSize) {
    throw new Error(
      `zip entry ${entry.name} unpacked to ${written} bytes, expected ${entry.uncompressedSize}`
    )
  }

  const mode = unixMode(entry)
  if (mode && process.platform !== "win32") {
    await fsp.chmod(target, mode)
  }
}

/**
 * where an entry's bytes actually begin
 *
 * the local header repeats the name and carries its *own* extra field, and
 * neither has to match the central directory - so the real data offset is only
 * known here, and the range check has to be repeated against it. checking only
 * the central directory's offset lets a padded local header push the read past
 * the end of the file, where it quietly yields nothing at all.
 *
 * @param {Object} handle - open FileHandle
 * @param {Object} entry - central directory entry
 * @param {number} size - the archive's length
 * @returns {Promise<number>} absolute offset of the entry's data
 */
async function readDataOffset(handle, entry, size) {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE)
  const { bytesRead } = await handle.read(
    header,
    0,
    LOCAL_HEADER_SIZE,
    entry.localOffset
  )

  if (bytesRead !== LOCAL_HEADER_SIZE || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt zip entry header: ${entry.name}`)
  }

  const dataOffset =
    entry.localOffset +
    LOCAL_HEADER_SIZE +
    header.readUInt16LE(26) +
    header.readUInt16LE(28)

  if (dataOffset + entry.compressedSize > size) {
    throw new Error(`zip entry runs past the end of the archive: ${entry.name}`)
  }

  return dataOffset
}

/**
 * resolve an entry name inside the destination, refusing anything that would
 * escape it (zip slip) - the archive is downloaded, so it is untrusted input
 * @param {string} destDir - unpack root
 * @param {string} name - entry name from the archive
 * @returns {string} absolute path inside destDir
 */
function safeJoin(destDir, name) {
  const normalized = String(name).replace(/\\/g, "/")
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".")

  if (
    !parts.length ||
    normalized.startsWith("/") ||
    parts.some((part) => part === "..") ||
    /^[a-zA-Z]:$/.test(parts[0])
  ) {
    throw new Error(`refusing to unpack unsafe zip entry: ${name}`)
  }

  return path.join(destDir, ...parts)
}

// the unix st_mode an entry was archived with, or null when it carries none
function unixStatMode(entry) {
  if (entry.versionMadeBy >> 8 !== MADE_BY_UNIX) {
    return null
  }

  return (entry.externalAttributes >>> 16) & 0xffff || null
}

function unixFileType(entry) {
  const mode = unixStatMode(entry)
  const type = mode === null ? 0 : mode & S_IFMT

  // plenty of archivers leave the type bits at zero; that is not a claim to
  // being anything unusual
  return type || null
}

// permission bits only: setuid/setgid/sticky are deliberately dropped, since
// nothing in a downloader engine needs them and we are writing as the user
function unixMode(entry) {
  const mode = unixStatMode(entry)
  return mode === null ? null : mode & 0o777 || null
}

/**
 * sha-256 of a file, streamed
 * @param {string} filePath - file to digest
 * @returns {Promise<string>} lowercase hex digest
 */
async function sha256File(filePath) {
  const hash = crypto.createHash("sha256")
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest("hex")
}

/**
 * parse a sha256sum-style checksum listing
 * @param {string} text - contents of SHA2-256SUMS
 * @returns {Map<string, string>} file name -> lowercase hex digest
 */
function parseChecksums(text) {
  const sums = new Map()

  for (const line of String(text == null ? "" : text).split("\n")) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(\S.*)$/i)
    if (match) {
      sums.set(match[2].trim(), match[1].toLowerCase())
    }
  }

  return sums
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const error = new Error("operation aborted")
    error.name = "AbortError"
    throw error
  }
}

module.exports = {
  extractZip,
  sha256File,
  parseChecksums,
  safeJoin,
  throwIfAborted
}
