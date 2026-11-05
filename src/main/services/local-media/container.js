const fs = require("node:fs/promises")

const MP4_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1"])
const HEADER_LIMIT = 4096

// Only the bounded EBML Header and its DocType are read, not media elements.
// RFC 8794 variable integers / RFC 9559 DocType. This is not a media detector.
function vint(buffer, offset, id = false) {
  const first = buffer[offset]
  if (!first) return null
  let length = 1, marker = 0x80
  while (!(first & marker)) { length += 1; marker >>= 1 }
  if (length > (id ? 4 : 8) || offset + length > buffer.length) return null
  let value = id ? first : first & (marker - 1)
  for (let i = 1; i < length; i++) value = value * 256 + buffer[offset + i]
  if (!Number.isSafeInteger(value) || (!id && value === 2 ** (7 * length) - 1)) return null
  return { length, value }
}
function ebmlDocType(buffer) {
  const root = vint(buffer, 0, true)
  if (root?.value !== 0x1a45dfa3) return null
  const size = vint(buffer, root.length)
  if (!size) return null
  let offset = root.length + size.length
  const end = offset + size.value
  if (end > Math.min(buffer.length, HEADER_LIMIT)) return null
  let type = null
  while (offset < end) {
    const id = vint(buffer, offset, true)
    if (!id) return null
    const length = vint(buffer, offset + id.length)
    if (!length) return null
    offset += id.length + length.length
    if (offset + length.value > end) return null
    if (id.value === 0x4282) {
      if (type !== null || length.value > 16) return null
      type = buffer.subarray(offset, offset + length.value).toString("utf8")
    }
    offset += length.value
  }
  return type
}
async function detectContainer(metadata, file) {
  if (metadata.formatNames.includes("mov")) {
    if (metadata.majorBrand === "qt") return "mov"
    if (MP4_BRANDS.has(metadata.majorBrand)) return "mp4"
    return null
  }
  if (!metadata.formatNames.includes("matroska")) return null
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (!(await handle.stat()).isFile()) return null
    const bytes = Buffer.alloc(HEADER_LIMIT)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return ebmlDocType(bytes.subarray(0, bytesRead)) === "matroska" ? "mkv" : null
  } finally { await handle.close() }
}

module.exports = { detectContainer, ebmlDocType, MP4_BRANDS, HEADER_LIMIT }
