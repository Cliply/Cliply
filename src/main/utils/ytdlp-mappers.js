// maps yt-dlp --dump-json output onto the response shapes the renderer renders,
// and picks the -o templates downloads are named by
// the simple-platform half is still ported from python/platforms/*.py
//
// this file is the re-export barrel every consumer and test reads. the barrel's
// keys are the module's public surface - the three modules under ./mappers/ are
// an internal layout, and nothing outside this file requires one directly

const { extractAudioTracks, extractQualityTiers } = require("./mappers/formats")
const {
  formatDuration,
  hasPlayableVideo,
  mapPlaylistInfo,
  mapSimpleInfo,
  mapVideoInfo
} = require("./mappers/info")
const {
  buildAudioOutputTemplate,
  buildPlaylistArchivePath,
  buildPlaylistOutputTemplate,
  buildSimpleOutputTemplate,
  buildVideoOutputTemplate,
  escapeTemplateLiteral,
  sanitizeFilename,
  PLAYLIST_ARCHIVE_DIR,
  PLAYLIST_INDEX_WIDTH,
  PLAYLIST_MAX_ITEMS
} = require("./mappers/templates")

module.exports = {
  hasPlayableVideo,
  sanitizeFilename,
  formatDuration,
  escapeTemplateLiteral,
  extractQualityTiers,
  extractAudioTracks,
  mapVideoInfo,
  mapSimpleInfo,
  mapPlaylistInfo,
  buildVideoOutputTemplate,
  buildAudioOutputTemplate,
  buildPlaylistOutputTemplate,
  buildPlaylistArchivePath,
  buildSimpleOutputTemplate,
  // the engine builds `-I 1:<cap>` and bounds the selection against the same
  // number - mappers/templates.js owns it because the index padding is derived
  // from it
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_INDEX_WIDTH,
  PLAYLIST_ARCHIVE_DIR
}
