const fs = require("node:fs/promises")
const { randomBytes } = require("node:crypto")
const { Readable } = require("node:stream")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { MediaError } = require("./errors")

const SCHEME = "cliply-media"
const PROOF_HEADER = "x-cliply-preview"
const TOKEN_URL = /^cliply-media:\/\/source\/([a-f0-9]{64})$/
const PREVIEW_TTL_MS = 30 * 60 * 1000

function registerMediaScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: {
    standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true
  } }])
}

function trustedUrl(isDevelopment = process.env.NODE_ENV === "development") {
  return isDevelopment ? "http://localhost:5173/" : pathToFileURL(path.join(__dirname, "../../renderer/dist/index.html")).href
}

function trustedFrame(window, frame, isDevelopment) {
  try {
    if (!window || window.isDestroyed() || frame !== window.webContents.mainFrame || !frame) return false
    const url = new URL(frame.url)
    url.hash = ""
    return url.href === trustedUrl(isDevelopment)
  } catch { return false }
}

function secureHost(window) {
  try {
    if (!window || window.isDestroyed()) return false
    const prefs = window.webContents.getLastWebPreferences()
    return prefs.webSecurity === true && prefs.sandbox === true && prefs.contextIsolation === true &&
      prefs.nodeIntegration === false && prefs.allowRunningInsecureContent === false
  } catch { return false }
}

function byteRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false }
  if (value.length > 80) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  let start, end
  if (!match[1]) {
    const length = Number(match[2])
    if (!Number.isSafeInteger(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null
    end = Math.min(end, size - 1)
  }
  return { start, end, partial: true }
}

function mediaMime(dto) {
  const video = dto.streams.some((s) => s.type === "video" && !s.disposition.attached_pic)
  if (dto.formatNames.includes("mov")) return video ? "video/mp4" : "audio/mp4"
  if (dto.formatNames.includes("wav")) return "audio/wav"
  if (dto.formatNames.includes("mp3")) return "audio/mpeg"
  if (dto.formatNames.includes("aac")) return "audio/aac"
  if (dto.formatNames.includes("matroska")) return video ? "video/x-matroska" : "audio/x-matroska"
  return null
}

class MediaPreview {
  constructor({ getSource, validate, invalidate, now = Date.now, ttlMs = PREVIEW_TTL_MS }) {
    Object.assign(this, { getSource, validate, invalidate, now, ttlMs })
    this.grant = null
    this.revision = 0
    this.streams = new Set()
    this.proof = randomBytes(32).toString("hex")
  }

  attach(window) {
    if (!secureHost(window)) throw new MediaError("PREVIEW_HOST")
    this.window = window
    this.session = window.webContents.session
    this.session.protocol.handle(SCHEME, (request) => this.handle(request))
    const contents = window.webContents
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.revoke()
    })
    contents.on("render-process-gone", () => this.revoke())
    contents.once("destroyed", () => {
      this.revoke()
      this.session.protocol.unhandle(SCHEME)
      this.window = null
    })
  }

  // Called from the window session's single onBeforeSendHeaders listener. A
  // private main-generated proof makes handle() fail closed if that gate is
  // accidentally absent. No caller-provided version of the header is trusted.
  authorize(details) {
    const headers = Object.fromEntries(Object.entries(details.requestHeaders || {})
      .filter(([key]) => key.toLowerCase() !== PROOF_HEADER))
    if (!this.valid(details.url) || !secureHost(this.window) ||
        details.webContentsId !== this.window.webContents.id ||
        !trustedFrame(this.window, details.frame) ||
        !["media", "xhr"].includes(details.resourceType) || !["GET", "HEAD"].includes(details.method)) return { cancel: true }
    return { requestHeaders: { ...headers, [PROOF_HEADER]: this.proof } }
  }

  valid(url) {
    const token = TOKEN_URL.exec(url)?.[1]
    return Boolean(token && this.grant?.previewId === token && this.now() < this.grant.expiresAt &&
      this.getSource()?.dto.sourceId === this.grant.sourceId)
  }

  async create(sourceId) {
    if (!secureHost(this.window) || !trustedFrame(this.window, this.window.webContents.mainFrame)) throw new MediaError("PREVIEW_HOST")
    const source = this.getSource()
    if (!source || source.dto.sourceId !== sourceId) throw new MediaError("SOURCE_UNKNOWN")
    this.revoke()
    const revision = this.revision
    try { await this.validate(source) }
    catch (error) {
      if (source === this.getSource()) { this.invalidate(); this.revoke() }
      throw error
    }
    if (revision !== this.revision) throw new MediaError("CANCELLED")
    if (source !== this.getSource()) throw new MediaError("SOURCE_CHANGED")
    const mime = mediaMime(source.dto)
    if (!mime) throw new MediaError("PREVIEW_UNAVAILABLE")
    const previewId = randomBytes(32).toString("hex")
    this.grant = { previewId, sourceId, mime, expiresAt: this.now() + this.ttlMs, url: `${SCHEME}://source/${previewId}` }
    this.timer = setTimeout(() => this.revoke(), this.ttlMs)
    this.timer.unref?.()
    return { ...this.grant }
  }

  revoke(previewId) {
    if (previewId && this.grant?.previewId !== previewId) return
    this.revision += 1
    this.grant = null
    clearTimeout(this.timer)
    for (const stream of this.streams) stream.destroy()
    this.streams.clear()
  }

  async handle(request) {
    const denied = (status) => new Response(null, { status, headers: { "Cache-Control": "no-store" } })
    if (request.headers.get(PROOF_HEADER) !== this.proof || !secureHost(this.window)) return denied(403)
    if (!this.valid(request.url)) return denied(410)
    if (!["GET", "HEAD"].includes(request.method)) return denied(405)
    const source = this.getSource()
    const grant = this.grant
    let handle
    try {
      await this.validate(source)
      handle = await fs.open(source.identity.realPath, "r")
      const stat = await handle.stat({ bigint: true })
      const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
      if (!stat.isFile() || stamp !== source.identity.stamp) throw new MediaError("SOURCE_CHANGED")
      if (!this.valid(request.url) || grant !== this.grant) return denied(410)
      const size = Number(stat.size)
      if (!Number.isSafeInteger(size)) return denied(413)
      const range = byteRange(request.headers.get("range"), size)
      const headers = {
        "Content-Type": grant.mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Access-Control-Allow-Origin": process.env.NODE_ENV === "development" ? "http://localhost:5173" : "null"
      }
      if (!range) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } })
      headers["Content-Length"] = String(Math.max(0, range.end - range.start + 1))
      if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`
      const status = range.partial ? 206 : 200
      if (request.method === "HEAD" || size === 0) return new Response(null, { status, headers })
      if (this.streams.size >= 4) return denied(429)
      const stream = handle.createReadStream({ start: range.start, end: range.end, autoClose: true })
      handle = null // stream now owns the descriptor
      this.streams.add(stream)
      const abort = () => stream.destroy()
      request.signal.addEventListener("abort", abort, { once: true })
      stream.once("close", () => { this.streams.delete(stream); request.signal.removeEventListener("abort", abort) })
      if (request.signal.aborted) stream.destroy()
      return new Response(Readable.toWeb(stream), { status, headers })
    } catch {
      if (source === this.getSource()) { this.invalidate(); this.revoke() }
      return denied(410)
    } finally {
      await handle?.close()
    }
  }
}

module.exports = { MediaPreview, registerMediaScheme, trustedFrame, trustedUrl, secureHost, byteRange, mediaMime, PROOF_HEADER }
