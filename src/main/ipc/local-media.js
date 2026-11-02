const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { MediaError } = require("../services/local-media/errors")

const CHANNELS = ["media:open", "media:get-state", "media:close"]

function registerLocalMedia({ ipcMain, service, getWindow, isDevelopment = false }) {
  const trustedUrl = isDevelopment
    ? "http://localhost:5173/"
    : pathToFileURL(path.join(__dirname, "../renderer/dist/index.html")).href
  function authorized(event) {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const url = new URL(event.senderFrame.url)
      url.hash = ""
      return url.href === trustedUrl
    } catch { return false }
  }
  for (const [channel, method] of [[CHANNELS[0], "open"], [CHANNELS[1], "getState"], [CHANNELS[2], "close"]]) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!authorized(event)) throw new MediaError("FORBIDDEN")
        if (args.some((arg) => arg !== undefined)) throw new MediaError("REQUEST_INVALID")
        const data = await service[method]()
        if (!authorized(event)) {
          await service.close()
          throw new MediaError("FORBIDDEN")
        }
        return { success: true, data }
      } catch (error) {
        const safe = error instanceof MediaError ? error : new MediaError("PROBE_FAILED")
        return { success: false, error: { code: safe.code, message: safe.message } }
      }
    })
  }
  return () => CHANNELS.forEach((channel) => ipcMain.removeHandler(channel))
}

module.exports = { registerLocalMedia }
