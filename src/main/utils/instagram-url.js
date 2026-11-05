// Cliply's supported content boundary; extraction and redirects belong to yt-dlp.
function normalizeInstagramUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null

  try {
    const input = value.trim()
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
      url.username || url.password || url.port ||
      !/^\/(?:(?!share\/|stories\/|explore\/)[A-Za-z0-9._]+\/)?(?:p|tv|reels?)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    ) return null

    return url.href
  } catch {
    return null
  }
}

module.exports = { normalizeInstagramUrl }
