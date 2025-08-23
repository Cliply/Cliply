// app constants

const path = require("path")
const os = require("os")

// detect dev mode
const isDevelopment = process.env.NODE_ENV === "development"

// app config
const APP_CONFIG = {
  // download settings
  MAX_CONCURRENT_DOWNLOADS: 4,
  DOWNLOAD_TIMEOUT: 30 * 60 * 1000, // 30 minutes

  // file paths
  DOWNLOADS_DIR: path.join(os.homedir(), "Downloads", "Cliply"),
  COOKIES_DIR: path.join(os.homedir(), ".config", "app-data-7c4f", "cookies"),
  TEMP_DIR: path.join(os.tmpdir(), "cliply"),

  // python server config
  PYTHON_SERVER: {
    HOST: "127.0.0.1",
    PORT: 8888,
    STARTUP_TIMEOUT: isDevelopment ? 60000 : 30000, // longer timeout in dev
    HEALTH_CHECK_INTERVAL: 5000,
    MAX_STARTUP_RETRIES: 3,
    ENDPOINTS: {
      ROOT: "/",
      VIDEO_INFO: "/api/video/info",
      DOWNLOAD_COMBINED: "/api/video/download-combined",
      DOWNLOAD_AUDIO: "/api/audio/download"
    }
  },

  // binary paths
  BINARIES: {
    FFMPEG: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  },

  // python runtime config
  PYTHON_RUNTIME: {
    // development: use system python
    DEVELOPMENT_PYTHON: process.platform === "win32" ? "python" : "python3",

    // production: embedded python path (relative to app resources)
    EMBEDDED_PYTHON_DIR: (() => {
      const platform = process.platform
      const arch = process.arch

      if (platform === "win32") {
        return arch === "x64"
          ? "python-runtime/win32-x64"
          : "python-runtime/win32-ia32"
      } else if (platform === "darwin") {
        return arch === "arm64"
          ? "python-runtime/darwin-arm64"
          : "python-runtime/darwin-x64"
      } else if (platform === "linux") {
        return "python-runtime/linux-x64"
      }

      return "python-runtime"
    })(),

    EMBEDDED_PYTHON_EXE:
      process.platform === "win32" ? "python.exe" : "bin/python3",
    SERVER_SCRIPT: "server.py",
    REQUIREMENTS_FILE: "requirements.txt",
    VENV_DIR: "venv"
  },

  // update config - all updates are treated as important
  UPDATE_CONFIG: {
    // auto-download all updates (not just security)
    AUTO_DOWNLOAD: true,

    // retry configuration
    MAX_CHECK_RETRIES: 3,
    MAX_DOWNLOAD_RETRIES: 2,

    // periodic check interval (12 hours in milliseconds)
    PERIODIC_CHECK_INTERVAL: 12 * 60 * 60 * 1000
  },

  // analytics configuration
  ANALYTICS_CONFIG: {
    // aptabase app key
    APP_KEY: "A-EU-7558244378",

    // enable analytics
    ENABLED: true,

    // events to track
    EVENTS: {
      DOWNLOAD_COMPLETED: "download_completed",
      DOWNLOAD_FAILED: "download_failed"
    }
  }
}

// ipc channel names
const IPC_CHANNELS = {
  // video operations
  VIDEO_GET_INFO: "video:get-info",
  VIDEO_DOWNLOAD_COMBINED: "video:download-combined",
  AUDIO_DOWNLOAD: "audio:download",

  // download management
  DOWNLOAD_PROGRESS: "download:progress",
  DOWNLOAD_COMPLETE: "download:complete",
  DOWNLOAD_ERROR: "download:error",
  DOWNLOAD_CANCEL: "download:cancel",
  DOWNLOAD_FOLDER_SHOW: "download:folder:show",
  DOWNLOAD_FOLDER_GET: "download:folder:get",

  // cookie management
  COOKIES_IMPORT: "cookies:import",
  COOKIES_TEST: "cookies:test",
  COOKIES_STATUS: "cookies:status",

  // auto-updater management
  UPDATE_CHECK: "update:check",
  UPDATE_DOWNLOAD: "update:download",
  UPDATE_INSTALL: "update:install",
  UPDATE_CHECKING: "update:checking",
  UPDATE_AVAILABLE: "update:available",
  UPDATE_NOT_AVAILABLE: "update:not-available",
  UPDATE_DOWNLOAD_PROGRESS: "update:download-progress",
  UPDATE_DOWNLOADED: "update:downloaded",
  UPDATE_ERROR: "update:error",

  // system operations
  SYSTEM_HEALTH: "system:health",
  SYSTEM_OPEN_EXTERNAL: "system:open-external",

  // python server events
  PYTHON_SERVER_STARTING: "python:server:starting",
  PYTHON_SERVER_READY: "python:server:ready",
  PYTHON_SERVER_ERROR: "python:server:error"
}

// supported platforms
const SUPPORTED_PLATFORMS = {
  YOUTUBE: {
    patterns: [
      /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\//
    ],
    name: "YouTube"
  },
  // future platform support
  INSTAGRAM: {
    patterns: [/^(https?:\/\/)?(www\.)?instagram\.com\/(p|reel)\//],
    name: "Instagram"
  },
  TIKTOK: {
    patterns: [/^(https?:\/\/)?(www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/],
    name: "TikTok"
  }
}

// file formats
const FORMATS = {
  VIDEO: ["mp4", "webm", "mkv", "avi", "mov"],
  AUDIO: ["mp3", "m4a", "wav", "opus", "aac", "flac"],
  SUBTITLE: ["srt", "vtt", "ass"]
}

// error types
const ERROR_TYPES = {
  // network and connectivity
  NETWORK_ERROR: "NETWORK_ERROR",
  BOT_DETECTION: "BOT_DETECTION",
  VIDEO_UNAVAILABLE: "VIDEO_UNAVAILABLE",
  INVALID_URL: "INVALID_URL",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",

  // python server errors
  PYTHON_SERVER_NOT_READY: "PYTHON_SERVER_NOT_READY",
  PYTHON_SERVER_ERROR: "PYTHON_SERVER_ERROR",
  PERMISSION_ERROR: "PERMISSION_ERROR"
}

// http client config
const HTTP_CONFIG = {
  TIMEOUT: isDevelopment ? 2400000 : 3600000, // Long videos: 40min dev, 60min prod
  RETRIES: 1, // Single attempt for long downloads
  RETRY_DELAY: 1000,
  HEADERS: {
    "Content-Type": "application/json",
    "User-Agent": "Cliply-Desktop/0.0.1"
  }
}

module.exports = {
  APP_CONFIG,
  IPC_CHANNELS,
  SUPPORTED_PLATFORMS,
  FORMATS,
  ERROR_TYPES,
  HTTP_CONFIG
}
