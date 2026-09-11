// the main window: how it is built, what it loads, and what it may do.
//
// the window is the running app's, not this module's - it is created onto
// the app that is handed in and read back off it by everything below, so
// the one reference stays where the rest of the lifecycle can find it.

const { app, BrowserWindow, dialog } = require("electron")
const path = require("path")
const isDev = process.env.NODE_ENV === "development"

// the site the embed player is told it is embedded on. it has to name a real
// site that is not youtube itself - a youtube.com referer is refused as a
// self-referential embed (error 152). see giveYouTubeEmbedsAReferer()
const EMBED_REFERER = "https://cliply.space/"

/**
 * give youtube's embed player a referer to read
 *
 * the packaged app is served with loadFile(), so the renderer runs under
 * file:// - and chromium sends no Referer at all from a file:// page. the
 * embed player decides playability from that header server-side: without it
 * the response carries an errorScreen instead of a video, which is what the
 * user sees as error 153. dev never hits it because vite serves the same
 * page over http://localhost.
 *
 * scoped to the embed url so no other request the app makes gains a referer
 * it did not have before.
 */
function giveYouTubeEmbedsAReferer(cliplyApp) {
  cliplyApp.mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube.com/embed/*"] },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Referer: EMBED_REFERER
        }
      })
    }
  )
}

// create main window
function createWindow(cliplyApp) {
  // create browser window
  cliplyApp.mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: false, // for youtube iframe compatibility
      allowRunningInsecureContent: true,
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      sandbox: false,
      experimentalFeatures: false,
      enableBlinkFeatures: "",
      disableBlinkFeatures: "Auxclick"
    },
    icon: cliplyApp.getAppIcon(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default"
  })

  cliplyApp.giveYouTubeEmbedsAReferer()

  // window event handlers
  cliplyApp.mainWindow.on("closed", cliplyApp.onWindowClosed)

  cliplyApp.mainWindow.on("close", (_event) => {
    // allow close during update
    if (global.isUpdating) {
      return
    }

    // quit the app when close button is clicked (consistent behavior)
    if (!cliplyApp.isQuitting) {
      cliplyApp.isQuitting = true
      app.quit()
    }
  })

  // show window when ready
  cliplyApp.mainWindow.once("ready-to-show", () => {
    cliplyApp.mainWindow.show()

    if (isDev) {
      cliplyApp.mainWindow.webContents.openDevTools()
    }
  })

  // load the app
  cliplyApp.loadApplication()

  // set ipc handlers main window reference
  if (cliplyApp.ipcHandlers) {
    cliplyApp.ipcHandlers.setMainWindow(cliplyApp.mainWindow)
  }
}

// load application ui
function loadApplication(cliplyApp) {
  if (isDev) {
    // development: load from vite dev server
    const startUrl = "http://localhost:5173"
    cliplyApp.mainWindow.loadURL(startUrl)
  } else {
    // production: load from packaged files
    const rendererPath = path.join(
      __dirname,
      "renderer",
      "dist",
      "index.html"
    )

    try {
      cliplyApp.mainWindow.loadFile(rendererPath).catch((error) => {
        console.error(`Failed to load renderer: ${error.message}`)

        // fallback path
        const fallbackPath = path.join(
          process.resourcesPath,
          "app.asar",
          "src",
          "main",
          "renderer",
          "dist",
          "index.html"
        )

        return cliplyApp.mainWindow
          .loadFile(fallbackPath)
          .catch((fallbackError) => {
            console.error(`Fallback also failed: ${fallbackError.message}`)

            dialog.showErrorBox(
              "Application Error",
              `Failed to load the application interface.\n\nPrimary path: ${rendererPath}\nFallback path: ${fallbackPath}\n\nPlease reinstall the application.`
            )
            app.quit()
          })
      })
    } catch (error) {
      console.error(`Critical error loading application: ${error.message}`)
      dialog.showErrorBox(
        "Critical Error",
        `Cannot start application: ${error.message}`
      )
      app.quit()
    }
  }
}

// handle main window closed
function onWindowClosed(cliplyApp) {
  cliplyApp.mainWindow = null
}

// get app icon path
function getAppIcon() {
  const iconName = process.platform === "win32" ? "icon.ico" : "icon.png"
  return path.join(__dirname, "..", "..", "assets", iconName)
}

module.exports = {
  EMBED_REFERER,
  giveYouTubeEmbedsAReferer,
  createWindow,
  loadApplication,
  onWindowClosed,
  getAppIcon
}
