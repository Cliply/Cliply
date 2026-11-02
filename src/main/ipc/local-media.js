const { trustedFrame } = require("../services/local-media/preview")
const { MediaError } = require("../services/local-media/errors")

const CHANNELS = ["media:open", "media:get-state", "media:close", "media:preview", "media:release-preview",
  "media:prepare-export", "media:start-export", "media:cancel-export", "media:export-state", "media:reveal-output"]

function registerLocalMedia({ ipcMain, service, getWindow, isDevelopment = false }) {
  function authorized(event) {
    const window = getWindow()
    return window && event.sender === window.webContents && trustedFrame(window, event.senderFrame, isDevelopment)
  }
  for (const [channel, method] of [[CHANNELS[0], "open"], [CHANNELS[1], "getState"], [CHANNELS[2], "close"], [CHANNELS[3], "preview"], [CHANNELS[4], "releasePreview"],
    [CHANNELS[5], "prepare"], [CHANNELS[6], "start"], [CHANNELS[7], "cancel"], [CHANNELS[8], "exportState"], [CHANNELS[9], "reveal"]]) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!authorized(event)) throw new MediaError("FORBIDDEN")
        let data
        if (["prepare", "start", "cancel", "exportState", "reveal"].includes(method)) {
          if (method === "exportState") {
            if (args.some(arg => arg !== undefined)) throw new MediaError("REQUEST_INVALID")
            data = await service.exports.getState()
          } else {
            if (args.length !== 1 || (method !== "prepare" && (typeof args[0] !== "string" || !/^[a-f0-9-]{36}$/.test(args[0])))) throw new MediaError("REQUEST_INVALID")
            data = await service.exports[method](args[0])
          }
        } else if (method === "preview" || method === "releasePreview") {
          if (args.length !== 1 || typeof args[0] !== "string" ||
              !(method === "preview" ? /^[a-f0-9-]{36}$/ : /^[a-f0-9]{64}$/).test(args[0])) throw new MediaError("REQUEST_INVALID")
          if (method === "preview") data = await service.preview.create(args[0])
          else { service.preview.revoke(args[0]); data = { released: true } }
        } else {
          if (args.some((arg) => arg !== undefined)) throw new MediaError("REQUEST_INVALID")
          data = await service[method]()
        }
        if (!authorized(event)) {
          await service.close()
          throw new MediaError("FORBIDDEN")
        }
        return { success: true, data }
      } catch (error) {
        const safe = error instanceof MediaError ? error : new MediaError(CHANNELS.indexOf(channel) >= 5 ? "EXPORT_FAILED" : "PROBE_FAILED")
        return { success: false, error: { code: safe.code, message: safe.message } }
      }
    })
  }
  return () => CHANNELS.forEach((channel) => ipcMain.removeHandler(channel))
}

module.exports = { registerLocalMedia }
