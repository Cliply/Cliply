// Sampling may overlap asynchronous removal of these test-owned partials.
const fs = require("node:fs")
const path = require("node:path")

function ownedPartialBytes(root, io = fs) {
  const missing = (read, fallback) => {
    try { return read() } catch (error) {
      if (error.code === "ENOENT") return fallback
      throw error
    }
  }
  let bytes = 0
  for (const name of missing(() => io.readdirSync(root), []).filter(name => name.startsWith(".cliply-export-"))) {
    const directory = path.join(root, name)
    for (const file of missing(() => io.readdirSync(directory), [])) {
      bytes += missing(() => io.statSync(path.join(directory, file)).size, 0)
    }
  }
  return bytes
}

module.exports = { ownedPartialBytes }
