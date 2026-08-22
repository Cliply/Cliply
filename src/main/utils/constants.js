// app constants

const path = require("path")
const os = require("os")

// app config
const APP_CONFIG = {
  // download settings
  MAX_CONCURRENT_DOWNLOADS: 4,
  DOWNLOAD_TIMEOUT: 30 * 60 * 1000, // 30 minutes

  // file paths
  DOWNLOADS_DIR: path.join(os.homedir(), "Downloads", "Cliply"),
  COOKIES_DIR: path.join(os.homedir(), ".config", "app-data-7c4f", "cookies"),
  TEMP_DIR: path.join(os.tmpdir(), "cliply"),

  // binary paths
  BINARIES: {
    FFMPEG: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
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
  SYSTEM_GET_DIAGNOSTICS: "system:get-diagnostics"
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

// error codes live in utils/error-taxonomy.js - this file used to carry a
// six-entry copy of them that nothing kept in step

module.exports = {
  APP_CONFIG,
  IPC_CHANNELS,
  SUPPORTED_PLATFORMS,
  FORMATS
}
