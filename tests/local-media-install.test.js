jest.mock("electron", () => ({ ipcMain: {}, app: {}, dialog: {} }))
const IPCHandlers = require("../src/main/ipc-handlers")

beforeEach(() => { jest.useFakeTimers(); global.isUpdating = false })
afterEach(() => { jest.useRealTimers(); delete global.isUpdating; jest.restoreAllMocks() })

function handlers(shutdown) {
  const instance = Object.create(IPCHandlers.prototype)
  instance.localMedia = { shutdown }
  instance.autoUpdater = { quitAndInstall: jest.fn() }
  return instance
}

test("duplicate install requests wait for one local drain and invoke the installer once", async () => {
  let done
  const drain = new Promise((resolve) => { done = resolve })
  const ipc = handlers(jest.fn(() => drain))
  const first = ipc.handleInstallUpdate()
  const second = ipc.handleInstallUpdate()
  expect(ipc.localMedia.shutdown).toHaveBeenCalledTimes(1)
  jest.runOnlyPendingTimers()
  expect(ipc.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  expect(global.isUpdating).toBe(false)
  done()
  expect(await first).toEqual({ success: true, data: { installing: true } })
  expect(await second).toEqual(await first)
  jest.runOnlyPendingTimers()
  expect(ipc.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
})

test("failed probe drain refuses installation and permits a later retry", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {})
  const ipc = handlers(jest.fn().mockRejectedValueOnce(new Error("stuck")).mockResolvedValueOnce({ closed: true }))
  expect((await ipc.handleInstallUpdate()).success).toBe(false)
  jest.runOnlyPendingTimers()
  expect(ipc.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  expect(global.isUpdating).toBe(false)
  expect((await ipc.handleInstallUpdate()).success).toBe(true)
  jest.runOnlyPendingTimers()
  expect(ipc.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
})
